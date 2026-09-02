// Browser-realm-independent production acceptance probes. The Ollama fixture
// is a real loopback HTTP server rather than CDP Fetch interception on one
// target: after the thin-kernel cutover, model fetch belongs to the semantic
// controller realm, and a service-worker-only interceptor would false-green by
// never observing that boundary.

import { createServer } from 'node:http';
import { evalIn, rpc, sseText, waitFor } from './e2e-harness.mjs';

export const ACCEPTANCE_MODEL = 'qwen3:8b';
export const ACCEPTANCE_REPLY = 'production-controller-first-message-ok';
export const ACCEPTANCE_OLLAMA_HOST = 'http://127.0.0.1:11434';

export const readActiveFeatureLease = async (page, scope) => {
  const reply = await rpc(page, { type: 'bootstrap/ready' }, { timeoutMs: 10_000 });
  const snapshot = reply?.featureLeases;
  const lease = snapshot?.leases?.[scope];
  if (reply?.ok !== true || snapshot?.schema !== 1
      || typeof snapshot.buildId !== 'string'
      || typeof snapshot.bootId !== 'string'
      || typeof snapshot.kernelEpoch !== 'string'
      || lease?.status !== 'active'
      || typeof lease.hostEpoch !== 'string'
      || typeof lease.leaseId !== 'string'
      || !Number.isSafeInteger(lease.generation)) {
    throw new Error(`exact active ${scope} lease missing: ${JSON.stringify(snapshot)}`);
  }
  return { snapshot, lease };
};

const listen = (server, port, host) => new Promise((resolve, reject) => {
  const onError = (error) => { server.off('listening', onListening); reject(error); };
  const onListening = () => { server.off('error', onError); resolve(); };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, host);
});

const close = (server) => new Promise((resolve) => server.close(() => resolve()));

export const startOllamaAcceptanceFixture = async ({
  host = '127.0.0.1', port = 11434, replyText = ACCEPTANCE_REPLY,
  completionDelayMs = 250, completionResponse = null,
} = {}) => {
  const requests = [];
  const completionProofs = [];
  const server = createServer((request, response) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > 1_000_000) request.destroy(new Error('acceptance request too large'));
      else chunks.push(chunk);
    });
    request.on('end', async () => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`);
      requests.push({ method: request.method ?? '', path: url.pathname, bytes });
      const headers = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'cache-control': 'no-store',
      };
      if (request.method === 'OPTIONS') {
        response.writeHead(204, headers);
        response.end();
      } else if (request.method === 'GET' && url.pathname === '/api/tags') {
        response.writeHead(200, { ...headers, 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: [{ name: ACCEPTANCE_MODEL, size: 1 }] }));
      } else if (request.method === 'POST' && url.pathname === '/api/show') {
        response.writeHead(200, { ...headers, 'content-type': 'application/json' });
        response.end(JSON.stringify({ model_info: { 'qwen3.context_length': 32_768 } }));
      } else if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const completionCall = requests.filter((entry) =>
          entry.method === 'POST' && entry.path === '/v1/chat/completions').length;
        let requestBody = null;
        try { requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        let completion;
        try {
          // Async responders let physical-fault lanes hold an exact in-flight
          // response until the browser target has actually been retired.
          completion = typeof completionResponse === 'function'
            ? await completionResponse({ completionCall, requestBody }) : sseText(replyText);
        } catch {
          completion = {
            status: 422,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'acceptance-completion-rejected' }),
          };
        }
        const spec = typeof completion === 'string' ? { body: completion } : completion;
        if (spec?.proof && typeof spec.proof === 'object') {
          const safeProof = Object.fromEntries(Object.entries(spec.proof).filter(([, value]) =>
            typeof value === 'boolean'
            || Number.isSafeInteger(value)
            || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))));
          completionProofs.push(Object.freeze(safeProof));
        }
        setTimeout(() => {
          response.writeHead(spec?.status ?? 200, {
            ...headers,
            'content-type': spec?.contentType ?? 'text/event-stream',
          });
          response.end(spec?.body ?? '');
        }, completionDelayMs);
      } else {
        response.writeHead(404, { ...headers, 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'acceptance-fixture-route-not-found' }));
      }
    });
  });
  try {
    await listen(server, port, host);
  } catch (cause) {
    server.close();
    throw new Error(
      `secretless acceptance fixture could not bind ${host}:${port}; `
      + `stop any local Ollama process before running this lane: ${cause}`,
    );
  }
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  return Object.freeze({
    origin: `http://${host}:${boundPort}`,
    completionDelayMs,
    requests,
    completionCalls: () => requests.filter((entry) =>
      entry.method === 'POST' && entry.path === '/v1/chat/completions').length,
    completionProofs: () => completionProofs.map((proof) => ({ ...proof })),
    close: () => close(server),
  });
};

export const completeOnboardingAndSelectFixture = async (page, origin) => {
  const onboarding = await rpc(page, {
    type: 'onboarding/complete', peerName: 'peerd', facts: null,
  });
  if (onboarding?.ok !== true) {
    throw new Error(`onboarding/complete failed: ${JSON.stringify(onboarding)}`);
  }
  const settings = await rpc(page, {
    type: 'settings/update',
    patch: { providerName: 'ollama', providerModel: ACCEPTANCE_MODEL, ollamaHost: origin },
  });
  if (settings?.ok !== true) {
    throw new Error(`semantic settings/update failed: ${JSON.stringify(settings)}`);
  }
  return { onboarding, settings };
};

export const sendAndObserveFirstControllerMessage = async (
  page,
  fixture,
  {
    text = 'production cutover acceptance ping',
    replyText = ACCEPTANCE_REPLY,
    expectedCompletionCalls = 1,
  } = {},
) => {
  const sent = await rpc(page, { type: 'agent/send', text });
  if (sent?.ok !== true) throw new Error(`agent/send failed: ${JSON.stringify(sent)}`);
  const rendered = await waitFor(() => {
    if (fixture.completionCalls() !== expectedCompletionCalls) return null;
    return evalIn(page, `(() => {
    const user = [...document.querySelectorAll('.message-user')]
      .some((node) => (node.textContent || '').includes(${JSON.stringify(text)}));
    const assistant = [...document.querySelectorAll('.message-assistant .bubble')]
      .some((node) => (node.textContent || '').trim() === ${JSON.stringify(replyText)});
    const busy = !!document.querySelector('.message-assistant.streaming, form.input-bar button.stop');
    return user && assistant && !busy ? { user, assistant, busy } : null;
  })()`);
  }, { budgetMs: 30_000, pollMs: 25 });
  if (!rendered || fixture.completionCalls() !== expectedCompletionCalls) {
    throw new Error(`first controller message did not complete exactly once: ${JSON.stringify({
      rendered, completionCalls: fixture.completionCalls(), requests: fixture.requests,
    })}`);
  }
  return { sent, rendered, completionCalls: fixture.completionCalls() };
};

// Runs inside an installed extension page. Exporting the installed tree back
// through the production route proves the import did not merely create an App
// record: exact text and binary OPFS bytes must survive the bundle boundary.
export const browserVerifyAcceptanceAppPayload = async (appId) => {
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  if (!extensionApi?.runtime?.sendMessage) {
    return { ok: false, phase: 'runtime-api', detail: 'WebExtension runtime API unavailable' };
  }
  const exported = await extensionApi.runtime.sendMessage({
    type: 'export/artifact', kind: 'app', id: appId,
  });
  if (exported?.ok !== true || !exported.envelope) {
    return { ok: false, phase: 'export', exported };
  }
  const { openEnvelope } = await import('/peerd-engine/index.js');
  const opened = await openEnvelope(exported.envelope);
  const expected = {
    'index.html': '<!doctype html><title>Cutover App</title><main>ready</main>',
    'src/main.js': 'document.querySelector("main").dataset.ready = "true";',
  };
  const decoder = new TextDecoder();
  const textOk = Object.entries(expected).every(([path, value]) =>
    opened.files?.[path] instanceof Uint8Array
      && decoder.decode(opened.files[path]) === value);
  const expectedBinary = [0, 1, 2, 127, 128, 255];
  const actualBinary = opened.files?.['assets/raw.bin'];
  const binaryOk = actualBinary instanceof Uint8Array
    && actualBinary.length === expectedBinary.length
    && expectedBinary.every((value, index) => actualBinary[index] === value);
  return {
    ok: textOk && binaryOk,
    phase: textOk && binaryOk ? 'complete' : 'payload-mismatch',
    textOk,
    binaryOk,
    fileCount: Object.keys(opened.files ?? {}).length,
  };
};

// Runs inside an installed extension page. It crosses App export/import,
// binary OPFS persistence, the authenticated lazy repository host,
// isomorphic-git branch creation, and history before cleaning up the fixture.
export const browserAppGitProbe = async (retain = false, verifyPayload = null) => {
  const { buildAppExport } = await import('/peerd-engine/index.js');
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  if (!extensionApi?.runtime?.sendMessage) {
    return { ok: false, phase: 'runtime-api', detail: 'WebExtension runtime API unavailable' };
  }
  const envelope = await buildAppExport({
    record: {
      name: 'Production Cutover App Git Probe', entryFile: 'index.html', tags: ['acceptance'],
    },
    files: {
      'index.html': '<!doctype html><title>Cutover App</title><main>ready</main>',
      'src/main.js': 'document.querySelector("main").dataset.ready = "true";',
      'assets/raw.bin': new Uint8Array([0, 1, 2, 127, 128, 255]),
    },
  });
  const imported = await extensionApi.runtime.sendMessage({ type: 'import/apply', envelope });
  if (!imported?.ok || imported.kind !== 'app') {
    return { ok: false, phase: 'import', imported };
  }
  const appId = imported.id;
  try {
    const payload = typeof verifyPayload === 'function'
      ? await verifyPayload(appId)
      : { ok: false, phase: 'payload-verifier-unavailable' };
    const status = await extensionApi.runtime.sendMessage({ type: 'apps/repository/status', appId });
    const branch = await extensionApi.runtime.sendMessage({
      type: 'apps/repository/branch', appId, name: 'acceptance/cutover', checkout: true,
    });
    const history = await extensionApi.runtime.sendMessage({
      type: 'apps/repository/history', appId, depth: 5,
    });
    const ok = payload.ok === true
      && status?.ok === true && typeof status.status?.oid === 'string'
      && status.status.oid.length > 0 && branch?.ok === true
      && history?.ok === true && history.commits?.length >= 1;
    return {
      ok, phase: ok ? 'complete' : payload.ok ? 'repository' : payload.phase,
      appId, payload, status, branch, history,
    };
  } finally {
    if (!retain) await extensionApi.runtime.sendMessage({ type: 'apps/delete', appId }).catch(() => {});
  }
};

export const runPackagedAppGitProbe = async (page, { retain = false } = {}) => {
  const result = await evalIn(
    page,
    `(async () => {
      const verifyPayload = ${browserVerifyAcceptanceAppPayload.toString()};
      const probe = ${browserAppGitProbe.toString()};
      return probe(${JSON.stringify(retain)}, verifyPayload);
    })()`,
    true,
  );
  if (result?.ok !== true) {
    throw new Error(`packaged App/isomorphic-git probe failed: ${JSON.stringify(result)}`);
  }
  return result;
};

export const verifyPackagedAcceptanceAppPayload = async (page, appId) => {
  const result = await evalIn(page,
    `(${browserVerifyAcceptanceAppPayload.toString()})(${JSON.stringify(appId)})`, true);
  if (result?.ok !== true) {
    throw new Error(`installed acceptance App payload mismatch: ${JSON.stringify(result)}`);
  }
  return result;
};

export const verifyRetainedAppGitProbe = async (page, appId, { cleanup = true } = {}) => {
  const result = await evalIn(page, `(async () => {
    const appId = ${JSON.stringify(appId)};
    const verifyPayload = ${browserVerifyAcceptanceAppPayload.toString()};
    try {
      const payload = await verifyPayload(appId);
      const status = await chrome.runtime.sendMessage({ type: 'apps/repository/status', appId });
      const history = await chrome.runtime.sendMessage({
        type: 'apps/repository/history', appId, depth: 5,
      });
      return {
        ok: payload.ok === true
          && status?.ok === true && typeof status.status?.oid === 'string'
          && status.status.oid.length > 0 && history?.ok === true
          && history.commits?.length >= 1,
        payload, status, history,
      };
    } finally {
      if (${JSON.stringify(cleanup)}) {
        await chrome.runtime.sendMessage({ type: 'apps/delete', appId }).catch(() => {});
      }
    }
  })()`, true);
  if (result?.ok !== true) {
    throw new Error(`App/isomorphic-git state did not survive recycle: ${JSON.stringify(result)}`);
  }
  return result;
};

export const REMOTE_GIT_PROOF_PATH = 'acceptance/remote-proof.txt';
export const REMOTE_GIT_PROOF_TEXT = 'peerd installed smart-http round-trip\n';

// Runs in the installed extension page. The credential is write-only: the
// result deliberately contains booleans, hosts, branch/OIDs, and payload
// verdicts only. It never returns config.token or a raw network response.
export const browserRemoteAppGitProbe = async (appId, config, verifyPayload = null) => {
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  if (!extensionApi?.runtime?.sendMessage) {
    return { ok: false, phase: 'runtime-api', detail: 'WebExtension runtime API unavailable' };
  }
  if (typeof appId !== 'string' || !config || typeof config !== 'object'
      || typeof config.host !== 'string' || typeof config.remote !== 'string'
      || typeof config.token !== 'string' || typeof config.branch !== 'string'
      || typeof config.proofPath !== 'string' || typeof config.proofText !== 'string') {
    return { ok: false, phase: 'input' };
  }
  const send = (message) => extensionApi.runtime.sendMessage(message);
  let cloneId = null;
  try {
    const credential = await send({ type: 'git-cred/set', host: config.host, token: config.token });
    const credentialList = await send({ type: 'git-cred/list' });
    if (credential?.ok !== true || credential.host !== config.host
        || credentialList?.ok !== true
        || !Array.isArray(credentialList.hosts)
        || credentialList.hosts.filter((host) => host === config.host).length !== 1) {
      return { ok: false, phase: 'credential', credentialStored: credential?.ok === true };
    }
    const linked = await send({ type: 'apps/repository/link', appId, url: config.remote });
    if (linked?.ok !== true || linked.remote?.host !== config.host
        || linked.remote?.url !== config.remote) {
      return { ok: false, phase: 'link', credentialStored: true };
    }
    const wrote = await send({
      type: 'app/editor/write', appId, path: config.proofPath, content: config.proofText,
    });
    const committed = await send({
      type: 'apps/repository/commit', appId, message: 'installed Smart HTTP acceptance proof',
    });
    const pushed = await send({
      type: 'apps/repository/push', appId, branch: config.branch,
    });
    const fetched = await send({ type: 'apps/repository/fetch', appId });
    if (wrote?.ok !== true || committed?.ok !== true
        || typeof committed.result?.oid !== 'string' || committed.result.oid.length < 7
        || pushed?.ok !== true || pushed.result?.ok !== true
        || pushed.result?.branch !== config.branch
        || fetched?.ok !== true || fetched.result?.remote?.host !== config.host) {
      return {
        ok: false,
        phase: 'push-fetch',
        credentialStored: true,
        linked: linked?.ok === true,
        wrote: wrote?.ok === true,
        committed: committed?.ok === true,
        pushed: pushed?.ok === true,
        fetched: fetched?.ok === true,
      };
    }
    const cloned = await send({
      type: 'apps/import-git',
      url: config.remote,
      ref: config.branch,
      depth: 20,
      name: 'Installed Smart HTTP Clone',
    });
    cloneId = cloned?.record?.id ?? null;
    if (cloned?.ok !== true || typeof cloneId !== 'string') {
      return { ok: false, phase: 'clone', credentialStored: true };
    }
    const payload = typeof verifyPayload === 'function'
      ? await verifyPayload(cloneId)
      : { ok: false, phase: 'payload-verifier-unavailable' };
    const proof = await send({ type: 'app/editor/read', appId: cloneId, path: config.proofPath });
    const cloneStatus = await send({ type: 'apps/repository/status', appId: cloneId });
    const cloneHistory = await send({
      type: 'apps/repository/history', appId: cloneId, depth: 10,
    });
    const proofOk = proof?.ok === true && proof.content === config.proofText;
    const ok = payload?.ok === true && proofOk
      && cloneStatus?.ok === true && cloneStatus.remote?.host === config.host
      && typeof cloneStatus.status?.oid === 'string'
      && cloneStatus.status.oid === committed.result.oid
      && cloneHistory?.ok === true
      && Array.isArray(cloneHistory.commits)
      && cloneHistory.commits.some((entry) => entry?.oid === committed.result.oid);
    return {
      ok,
      phase: ok ? 'complete' : 'clone-verify',
      credentialStored: true,
      host: config.host,
      remoteLinked: true,
      branch: config.branch,
      committedOid: committed.result.oid,
      pushed: true,
      fetched: true,
      cleanClone: {
        ok,
        payload: {
          ok: payload?.ok === true,
          textOk: payload?.textOk === true,
          binaryOk: payload?.binaryOk === true,
          fileCount: payload?.fileCount ?? 0,
        },
        proofOk,
        oid: cloneStatus?.status?.oid ?? null,
        historyContainsCommit: cloneHistory?.commits?.some(
          (entry) => entry?.oid === committed.result.oid,
        ) === true,
      },
    };
  } catch {
    return { ok: false, phase: 'exception', detail: 'remote-git-operation-failed' };
  } finally {
    if (cloneId) await send({ type: 'apps/delete', appId: cloneId }).catch(() => {});
  }
};

export const browserVerifyRemoteAppGitAfterRecycle = async (appId, config) => {
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  if (!extensionApi?.runtime?.sendMessage) return { ok: false, phase: 'runtime-api' };
  const send = (message) => extensionApi.runtime.sendMessage(message);
  try {
    const fetched = await send({ type: 'apps/repository/fetch', appId });
    const status = await send({ type: 'apps/repository/status', appId });
    const history = await send({ type: 'apps/repository/history', appId, depth: 10 });
    const credentialList = await send({ type: 'git-cred/list' });
    const continuityOk = fetched?.ok === true && fetched.result?.remote?.host === config.host
      && status?.ok === true && status.remote?.host === config.host
      && status.status?.oid === config.committedOid
      && history?.ok === true && Array.isArray(history.commits)
      && history.commits.some((entry) => entry?.oid === config.committedOid)
      && credentialList?.ok === true
      && credentialList.hosts?.filter((host) => host === config.host).length === 1;
    const appRemoved = await send({ type: 'apps/delete', appId });
    const credentialRemoved = await send({ type: 'git-cred/delete', host: config.host });
    const afterList = await send({ type: 'git-cred/list' });
    const cleanupOk = appRemoved?.ok === true && credentialRemoved?.ok === true
      && afterList?.ok === true && !afterList.hosts?.includes(config.host);
    const ok = continuityOk && cleanupOk;
    return {
      ok,
      phase: ok ? 'complete' : 'recycle-verify',
      host: config.host,
      fetched: fetched?.ok === true,
      oid: status?.status?.oid ?? null,
      historyContainsCommit: history?.commits?.some(
        (entry) => entry?.oid === config.committedOid,
      ) === true,
      credentialRetained: credentialList?.hosts?.includes(config.host) === true,
      cleanup: {
        appRemoved: appRemoved?.ok === true,
        credentialRemoved: credentialRemoved?.ok === true,
        credentialAbsent: afterList?.ok === true && !afterList.hosts?.includes(config.host),
      },
    };
  } catch {
    await send({ type: 'apps/delete', appId }).catch(() => {});
    await send({ type: 'git-cred/delete', host: config.host }).catch(() => {});
    return { ok: false, phase: 'exception', detail: 'remote-git-recycle-verification-failed' };
  }
};

export const runPackagedRemoteAppGitProbe = async (page, appId, config) => {
  const result = await evalIn(page, `(async () => {
    const verifyPayload = ${browserVerifyAcceptanceAppPayload.toString()};
    const probe = ${browserRemoteAppGitProbe.toString()};
    return probe(${JSON.stringify(appId)}, ${JSON.stringify(config)}, verifyPayload);
  })()`, true);
  if (result?.ok !== true) {
    throw new Error(`packaged remote App/isomorphic-git probe failed: ${JSON.stringify(result)}`);
  }
  return result;
};

export const verifyPackagedRemoteAppGitAfterRecycle = async (page, appId, config) => {
  const result = await evalIn(page,
    `(${browserVerifyRemoteAppGitAfterRecycle.toString()})(${JSON.stringify(appId)}, ${JSON.stringify(config)})`,
    true);
  if (result?.ok !== true) {
    throw new Error(`remote App/isomorphic-git state did not survive recycle: ${JSON.stringify(result)}`);
  }
  return result;
};

export const kernelIdentityFromReply = (reply) => {
  const kernel = reply?.state?.kernel;
  const bootId = reply?.bootId ?? kernel?.bootId;
  const kernelEpoch = reply?.kernelEpoch ?? kernel?.kernelEpoch;
  return typeof bootId === 'string' && typeof kernelEpoch === 'string'
    ? { bootId, kernelEpoch }
    : null;
};
