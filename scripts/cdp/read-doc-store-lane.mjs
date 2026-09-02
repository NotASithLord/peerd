#!/usr/bin/env bun
// Physical Store-Chrome document lane. The model is faked only at its HTTP
// wire; controller tool execution, authority, offscreen fetch/PDF extraction,
// result spill, and session-owned paging are the packaged production path.

import { createServer } from 'node:https';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACTS_DIR, REPO_ROOT, readVersion } from '../../packaging/lib.ts';
import { packageArtifact } from '../../packaging/package.ts';
import { makeDocx } from '../../tests/peerd-runtime/doc/fixtures.ts';
import {
  GIT_FIXTURE_HOST, GIT_FIXTURE_TLS_CERT, GIT_FIXTURE_TLS_KEY,
} from '../acceptance/git-smart-http-fixture.mjs';
import { PRODUCTION_BACKGROUND_ENTRY } from './passkey-signup-lane.mjs';
import { readActiveFeatureLease } from './product-acceptance-probes.mjs';
import {
  SITE_CLIENT_FIXTURE_TLS_PORT, attach, evalIn, launchPeerd, rpc, resetSession,
  sseText, sseToolCall, unlockAndReady, waitFor,
} from './e2e-harness.mjs';

const REPORT_PATH = join(ARTIFACTS_DIR, 'e2e', 'read-doc-store-evidence.json');
const FIXTURE_URL = `https://${GIT_FIXTURE_HOST}/long.pdf`;
const DOCX_FIXTURE_URL = `https://${GIT_FIXTURE_HOST}/report.docx`;
const HEAD_SENTINEL = 'READ_DOC_HEAD_SENTINEL_ALPHA_4107';
const LATER_SENTINEL = 'READ_DOC_LATER_PAGE_SENTINEL_OMEGA_9253';
const PRIMARY_PROMPT = 'Read the complete local PDF and report its later-page sentinel.';
const PRIMARY_REPLY = 'store read_doc lane complete';
const DOCX_PROMPT = 'Read the local Word report and summarize its findings and table.';
const DOCX_REPLY = 'store DOCX read_doc lane complete';
const SECONDARY_PROMPT = 'Try to page the prior document result from this new chat.';
const SECONDARY_REPLY = 'cross-session read_result refusal observed';
const REQUIRED_OPERATIONS = Object.freeze([
  'turn.resource.extract-document',
  'turn.resource.spill-result',
  'turn.resource.read-result',
]);

const assert = (condition, message) => {
  if (!condition) throw new Error(`read_doc Store lane: ${message}`);
};

const escapePdfText = (text) => text.replaceAll('\\', '\\\\')
  .replaceAll('(', '\\(').replaceAll(')', '\\)');

const makePdf = () => {
  const pages = Array.from({ length: 12 }, (_, pageIndex) => {
    const lines = [`Physical read_doc fixture page ${pageIndex + 1} of 12.`];
    if (pageIndex === 0) lines.push(HEAD_SENTINEL);
    if (pageIndex === 6) lines.push(LATER_SENTINEL);
    for (let row = 0; row < 44; row += 1) {
      lines.push([
        `page-${pageIndex + 1}-row-${String(row + 1).padStart(2, '0')}`,
        'deterministic born digital text for packaged document extraction',
        'abcdefghijklmnopqrstuvwxyz 0123456789',
      ].join(' '));
    }
    return lines;
  });
  const pageIds = pages.map((_, index) => 4 + index * 2);
  /** @type {Map<number,string>} */
  const objects = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`],
    [3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
  ]);
  pages.forEach((lines, index) => {
    const pageId = pageIds[index];
    const contentId = pageId + 1;
    const stream = [
      'BT', '/F1 9 Tf', '40 760 Td', '14 TL',
      ...lines.flatMap((line) => [`(${escapePdfText(line)}) Tj`, 'T*']),
      'ET', '',
    ].join('\n');
    objects.set(pageId, [
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]',
      '   /Resources << /Font << /F1 3 0 R >> >>',
      `   /Contents ${contentId} 0 R >>`,
    ].join('\n'));
    objects.set(contentId, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  });

  const chunks = [Buffer.from('%PDF-1.7\n% physical-store-read-doc\n')];
  const offsets = [0];
  let length = chunks[0].byteLength;
  for (let id = 1; id <= objects.size; id += 1) {
    offsets[id] = length;
    const chunk = Buffer.from(`${id} 0 obj\n${objects.get(id)}\nendobj\n`);
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const xrefOffset = length;
  const xref = [
    `xref\n0 ${objects.size + 1}`,
    '0000000000 65535 f ',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    `trailer\n<< /Size ${objects.size + 1} /Root 1 0 R >>`,
    `startxref\n${xrefOffset}\n%%EOF\n`,
  ].join('\n');
  chunks.push(Buffer.from(xref));
  return Buffer.concat(chunks);
};

const toolResultsIn = (postData) => {
  try {
    const body = JSON.parse(postData);
    const results = [];
    for (const message of body.messages ?? []) {
      if (message?.role === 'tool') {
        results.push(typeof message.content === 'string'
          ? message.content : JSON.stringify(message.content));
      }
      if (Array.isArray(message?.content)) {
        for (const block of message.content) {
          if (block?.type === 'tool_result') results.push(
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          );
        }
      }
    }
    return results;
  } catch { return []; }
};

const spillKeyIn = (text) => text.match(
  /read_result with \{\s*"key":\s*"([^"]+)"/,
)?.[1] ?? null;

const firstPageOffsetIn = (text) => Number(text.match(/e\.g\. offset (\d+)/)?.[1]);

const nextPageOffsetIn = (text) => Number(text.match(
  /next:\s*\{\s*"key":\s*"[^"]+",\s*"offset":\s*(\d+)/,
)?.[1]);

const makeResponder = () => {
  let releaseFirstActor;
  const firstActorRelease = new Promise((resolve) => { releaseFirstActor = resolve; });
  const state = {
    phase: 'primary',
    primaryDelegated: false,
    secondaryDelegated: false,
    docxDelegated: false,
    primaryActorCalls: 0,
    secondaryActorCalls: 0,
    spillKey: null,
    initialOffset: null,
    primaryDone: false,
    secondaryRefused: false,
    docxActorCalls: 0,
    docxDone: false,
    actorBodies: [],
    toolResults: [],
    readResultPages: 0,
    firstActorReached: false,
    failure: null,
  };

  const responder = async (_callIndex, request) => {
    const body = request?.postData ?? '';
    const actor = body.includes('<actor_agent>');
    const results = toolResultsIn(body);
    if (actor) {
      state.actorBodies.push(body);
      state.toolResults.push(...results);
      if (state.phase === 'primary') {
        state.primaryActorCalls += 1;
        const latest = results.at(-1) ?? '';
        if (results.length === 0) {
          state.firstActorReached = true;
          await firstActorRelease;
          return { sse: sseToolCall('read_doc', {
            url: FIXTURE_URL, engine: 'pdfjs', maxChars: 800,
          }) };
        }
        if (!state.spillKey) {
          if (!latest.includes(HEAD_SENTINEL)) {
            state.failure = `read_doc result omitted the extracted head sentinel: ${latest.slice(0, 4000)}`;
            return { sse: sseText('actor document lane failed') };
          }
          state.spillKey = spillKeyIn(latest);
          state.initialOffset = firstPageOffsetIn(latest);
          if (typeof state.spillKey !== 'string' || !Number.isFinite(state.initialOffset)) {
            state.failure = `read_doc result omitted paging custody: ${latest.slice(-2000)}`;
            return { sse: sseText('actor document lane failed') };
          }
          return { sse: sseToolCall('read_result', {
            key: state.spillKey, offset: state.initialOffset, limit: 16_000,
          }) };
        }
        state.readResultPages += 1;
        if (latest.includes(LATER_SENTINEL)) {
          state.primaryDone = true;
          return { sse: sseText(`actor found ${LATER_SENTINEL}`) };
        }
        const nextOffset = nextPageOffsetIn(latest);
        if (!Number.isFinite(nextOffset) || state.readResultPages >= 8) {
          state.failure = `read_result ended before the later sentinel: ${latest.slice(-3000)}`;
          return { sse: sseText('actor document lane failed') };
        }
        return { sse: sseToolCall('read_result', {
          key: state.spillKey, offset: nextOffset, limit: 16_000,
        }) };
      }

      if (state.phase === 'docx') {
        state.docxActorCalls += 1;
        if (state.docxActorCalls === 1) {
          return { sse: sseToolCall('read_doc', {
            url: DOCX_FIXTURE_URL, maxChars: 4_000,
          }) };
        }
        const latest = results.at(-1) ?? '';
        state.docxDone = latest.includes('Quarterly Report')
          && latest.includes('Findings')
          && latest.includes('Revenue')
          && latest.includes('EMEA | North');
        if (!state.docxDone) {
          state.failure = `DOCX conversion omitted expected structure: ${latest.slice(0, 4000)}`;
          return { sse: sseText('actor DOCX lane failed') };
        }
        return { sse: sseText('actor read the complete Word report') };
      }

      state.secondaryActorCalls += 1;
      const latest = results.at(-1) ?? '';
      if (results.length === 0) {
        return { sse: sseToolCall('read_result', {
          key: state.spillKey, offset: state.initialOffset, limit: 1000,
        }) };
      }
      state.secondaryRefused = latest.includes('not_your_result');
      assert(state.secondaryRefused, 'new session could read the prior session spill');
      return { sse: sseText('actor observed not_your_result') };
    }

    const actorReply = body.includes('you messaged has replied');
    if (state.phase === 'primary') {
      if (actorReply) return { sse: sseText(PRIMARY_REPLY) };
      if (!state.primaryDelegated) {
        state.primaryDelegated = true;
        return { sse: sseToolCall('message_actor', {
          to: 'web', message: `Read ${FIXTURE_URL} with read_doc and page until ${LATER_SENTINEL}.`,
        }) };
      }
      return { sse: sseText('document work delegated') };
    }
    if (state.phase === 'docx') {
      if (state.docxDelegated && body.includes('actor read the complete Word report')) {
        return { sse: sseText(DOCX_REPLY) };
      }
      if (!state.docxDelegated) {
        state.docxDelegated = true;
        return { sse: sseToolCall('message_actor', {
          to: 'web', message: `Read and summarize the Word report at ${DOCX_FIXTURE_URL}.`,
        }) };
      }
      return { sse: sseText('Word report work delegated') };
    }
    if (actorReply) return { sse: sseText(SECONDARY_REPLY) };
    if (!state.secondaryDelegated) {
      state.secondaryDelegated = true;
      return { sse: sseToolCall('message_actor', {
        to: 'web', message: 'Try the supplied read_result key once and report the refusal.',
      }) };
    }
    return { sse: sseText('ownership check delegated') };
  };

  return {
    responder, state,
    releaseFirstActor: () => releaseFirstActor(),
  };
};

const sendTurn = async (page, text) => {
  const result = await rpc(page, { type: 'agent/send', text });
  assert(result?.ok === true, `agent/send failed: ${JSON.stringify(result)}`);
};

const terminalState = (page, prompt, reply) => evalIn(page, `(() => {
  const user = [...document.querySelectorAll('.message-user')]
    .some((node) => (node.textContent || '').includes(${JSON.stringify(prompt)}));
  const assistant = [...document.querySelectorAll('.message-assistant .bubble')]
    .some((node) => (node.textContent || '').trim() === ${JSON.stringify(reply)});
  const busy = !!document.querySelector('.message-assistant.streaming, form.input-bar button.stop');
  return user && assistant && !busy;
})()`);

const sessionId = async (page) => {
  const result = await rpc(page, { type: 'session/list' });
  const id = result?.sessions?.[0]?.sessionId;
  return result?.ok === true && typeof id === 'string' ? id : null;
};

const audits = async (page) => {
  const result = await rpc(page, { type: 'audit/list', limit: 1000 });
  assert(result?.ok === true && Array.isArray(result.entries), 'audit/list failed');
  return result.entries;
};

const controllerLease = async (page) => {
  const { lease } = await readActiveFeatureLease(page, 'controller');
  return {
    hostEpoch: lease.hostEpoch, leaseId: lease.leaseId,
    generation: lease.generation, kernelEpoch: lease.kernelEpoch,
  };
};

const attachOffscreenNetwork = async (port) => {
  const target = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    return targets.find((candidate) => candidate?.url?.split('#', 1)[0]
      .endsWith('/offscreen/offscreen.html')
      && typeof candidate.webSocketDebuggerUrl === 'string') ?? null;
  }, { budgetMs: 10_000, pollMs: 25 });
  assert(target, 'physical offscreen controller/document host target was not observable');
  const requests = [];
  const connection = await attach(target.webSocketDebuggerUrl, (method, params) => {
    if (method === 'Network.requestWillBeSent') requests.push(params?.request?.url ?? '');
  });
  await connection.send('Network.enable');
  await connection.send('Runtime.enable');
  return { connection, contextUrl: target.url, requests };
};

const runOne = async (treePath, iteration) => {
  const scripted = makeResponder();
  let ctx;
  let offscreen;
  try {
    ctx = await launchPeerd({
      extensionDir: treePath,
      expectedBackgroundEntry: PRODUCTION_BACKGROUND_ENTRY,
      modelResponder: scripted.responder,
    });
    await unlockAndReady(ctx.page);
    await sendTurn(ctx.page, PRIMARY_PROMPT);
    const firstSessionId = await waitFor(() => sessionId(ctx.page), {
      budgetMs: 5_000, pollMs: 25,
    });
    assert(firstSessionId, 'first turn did not create its owner session');
    assert(await waitFor(() => scripted.state.firstActorReached, {
      budgetMs: 30_000, pollMs: 25,
    }), 'delegated Web actor never reached the fake model wire');

    const lease = await controllerLease(ctx.page);
    offscreen = await attachOffscreenNetwork(ctx.port);
    scripted.releaseFirstActor();

    const primaryTerminal = await waitFor(
      () => terminalState(ctx.page, PRIMARY_PROMPT, PRIMARY_REPLY),
      { budgetMs: 60_000, pollMs: 50 },
    );
    assert(primaryTerminal && scripted.state.primaryDone,
      `physical document extraction/paging did not settle: ${scripted.state.failure ?? JSON.stringify({
        actorCalls: scripted.state.primaryActorCalls,
        spillKey: scripted.state.spillKey,
        pages: scripted.state.readResultPages,
        lastResult: scripted.state.toolResults.at(-1)?.slice(0, 4000) ?? null,
      })}`);
    assert(scripted.state.readResultPages > 0, 'later sentinel did not require read_result');
    const lazyRequests = offscreen.requests.filter((url) => url.startsWith('chrome-extension://'));
    assert(lazyRequests.some((url) => url.endsWith('/offscreen/doc-extract.js')),
      `doc extractor did not load lazily in the packaged host: ${JSON.stringify(lazyRequests)}`);
    assert(lazyRequests.some((url) => url.endsWith('/offscreen/pdf-extract.js')),
      `PDF extractor did not load lazily in the packaged host: ${JSON.stringify(lazyRequests)}`);

    const allPrimaryAudits = await audits(ctx.page);
    const primaryAudits = allPrimaryAudits.filter(
      (entry) => entry.type === 'authority_effect'
        && REQUIRED_OPERATIONS.includes(entry.details?.operation),
    );
    const operations = [...new Set(primaryAudits.map((entry) => entry.details.operation))];
    assert(REQUIRED_OPERATIONS.every((operation) => operations.includes(operation)),
      `exact resource authority operations missing: ${JSON.stringify(operations)}`);
    assert(primaryAudits.every((entry) => entry.details?.outcomeKnown === true),
      'resource authority produced an unknown outcome');
    const ownerSessionIds = [...new Set(primaryAudits.map((entry) => entry.sessionId))];
    assert(ownerSessionIds.length === 1 && typeof ownerSessionIds[0] === 'string',
      `resource authority effects did not share one actor session: ${JSON.stringify(ownerSessionIds)}`);
    const isolatedActor = allPrimaryAudits.find((entry) => entry.type === 'actor_ran_isolated'
      && entry.details?.workerType === 'dedicated'
      && entry.details?.realmVerified === true);
    assert(isolatedActor, 'document tools did not originate from a verified sealed actor realm');

    scripted.state.phase = 'docx';
    await sendTurn(ctx.page, DOCX_PROMPT);
    const docxTerminal = await waitFor(
      () => terminalState(ctx.page, DOCX_PROMPT, DOCX_REPLY),
      { budgetMs: 45_000, pollMs: 50 },
    );
    assert(docxTerminal && scripted.state.docxDone,
      `physical DOCX conversion did not settle: ${scripted.state.failure ?? 'unknown failure'}`);

    await resetSession(ctx);
    scripted.state.phase = 'secondary';
    await sendTurn(ctx.page, SECONDARY_PROMPT);
    const secondSessionId = await waitFor(async () => {
      const current = await sessionId(ctx.page);
      return current && current !== firstSessionId ? current : null;
    }, { budgetMs: 5_000, pollMs: 25 });
    assert(secondSessionId, 'session reset did not mint a distinct owner session');
    const secondaryTerminal = await waitFor(
      () => terminalState(ctx.page, SECONDARY_PROMPT, SECONDARY_REPLY),
      { budgetMs: 45_000, pollMs: 50 },
    );
    assert(secondaryTerminal && scripted.state.secondaryRefused,
      'cross-session read_result was not visibly refused');
    assert(scripted.state.actorBodies.length >= 2
      && scripted.state.actorBodies.every((body) => body.includes('<actor_agent>')),
    'tool calls did not originate from the sealed actor model surface');
    assert(scripted.state.actorBodies.every((body) => /kind:\s*bound;\s*type:\s*web/.test(body)),
      'read_doc/read_result were not exposed through a bound Web actor');

    return {
      iteration,
      backgroundEntry: ctx.sw.entry,
      firstSessionId,
      secondSessionId,
      actorAuthoritySessionId: ownerSessionIds[0],
      spillKeyObserved: typeof scripted.state.spillKey === 'string',
      readResultPages: scripted.state.readResultPages,
      laterSentinelObserved: scripted.state.primaryDone,
      docxStructureObserved: scripted.state.docxDone,
      crossSessionRefused: scripted.state.secondaryRefused,
      exactOperations: operations.sort(),
      sealedActor: {
        workerType: isolatedActor.details.workerType,
        realmVerified: isolatedActor.details.realmVerified,
      },
      controllerLease: lease,
      offscreenContextUrl: offscreen.contextUrl,
      packagedLazyRequests: lazyRequests.filter((url) => /(?:doc|pdf)-extract\.js$/.test(url)),
      modelCalls: ctx.modelCallCount(),
    };
  } finally {
    try { offscreen?.connection.close(); } catch { /* target already retired */ }
    if (ctx) await ctx.close();
  }
};

const listen = (server) => new Promise((resolve, reject) => server
  .once('error', reject)
  .listen(SITE_CLIENT_FIXTURE_TLS_PORT, '127.0.0.1', resolve));

const closeServer = (server) => new Promise((resolve) => server.close(resolve));

export async function runReadDocStoreLane({ runs = 1 } = {}) {
  assert(Number.isInteger(runs) && runs > 0 && runs <= 5, 'runs must be an integer from 1 to 5');
  const pdf = makePdf();
  const docx = Buffer.from(await makeDocx());
  const fixtureRequests = { pdf: 0, docx: 0 };
  const server = createServer({
    key: GIT_FIXTURE_TLS_KEY,
    cert: GIT_FIXTURE_TLS_CERT,
  }, (request, response) => {
    if (request.url !== '/long.pdf' && request.url !== '/report.docx') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    const isPdf = request.url === '/long.pdf';
    fixtureRequests[isPdf ? 'pdf' : 'docx'] += 1;
    const body = isPdf ? pdf : docx;
    response.writeHead(200, {
      'content-type': isPdf
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'content-length': body.byteLength,
      'cache-control': 'no-store',
      connection: 'close',
    });
    response.end(body);
  });
  await listen(server);
  try {
    const version = readVersion();
    const artifactPath = await packageArtifact({
      channel: 'store', browser: 'chrome', version, sign: false, verify: true,
      sourceRoot: REPO_ROOT, artifactRoot: ARTIFACTS_DIR,
    });
    const treePath = join(ARTIFACTS_DIR, 'staging', 'store-chrome');
    const manifest = JSON.parse(readFileSync(join(treePath, 'manifest.json'), 'utf8'));
    assert(manifest?.background?.service_worker === PRODUCTION_BACKGROUND_ENTRY,
      'package did not use the production Store-Chrome background entry');
    for (const path of [
      'offscreen/doc-extract.js', 'offscreen/pdf-extract.js',
      'peerd-runtime/controller-resource-tools.js',
    ]) assert(statSync(join(treePath, path)).isFile(), `packaged lazy input missing: ${path}`);

    const iterations = [];
    for (let iteration = 1; iteration <= runs; iteration += 1) {
      iterations.push(await runOne(treePath, iteration));
    }
    assert(fixtureRequests.pdf === runs && fixtureRequests.docx === runs,
      `fixture expected ${runs} fetches per format, observed ${JSON.stringify(fixtureRequests)}`);
    const report = {
      ok: true,
      channel: 'store',
      browser: 'chrome',
      version,
      artifactBytes: statSync(artifactPath).size,
      fixture: {
        pdf: { url: FIXTURE_URL, bytes: pdf.byteLength, requests: fixtureRequests.pdf },
        docx: {
          url: DOCX_FIXTURE_URL, bytes: docx.byteLength, requests: fixtureRequests.docx,
        },
      },
      iterations,
    };
    mkdirSync(join(ARTIFACTS_DIR, 'e2e'), { recursive: true });
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    await closeServer(server);
  }
}

if (import.meta.main) {
  const rawRuns = process.argv.find((argument) => argument.startsWith('--runs='))?.split('=')[1];
  const runs = rawRuns === undefined ? 1 : Number(rawRuns);
  await runReadDocStoreLane({ runs });
}
