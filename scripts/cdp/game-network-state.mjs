// A large game gets internet access only when the user turns it on in the
// Library. This state proves each browser behaviour that the design depends on:
// the page policy, the request pass-through in the game host, and the close of
// an open game on each change.
// Run with: bun run e2e:verify --only=game-network
// Run it again with --enforce-web-security to prove the CORS preflight path.
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createHash } from 'node:crypto';
import {
  GIT_FIXTURE_HOST, GIT_FIXTURE_TLS_CERT, GIT_FIXTURE_TLS_KEY,
} from '../acceptance/git-smart-http-fixture.mjs';
import {
  SITE_CLIENT_FIXTURE_TLS_PORT, attach, evalIn, openExtPage, rpc, waitFor,
} from './e2e-harness.mjs';

// why: the harness maps this public-looking name to the local TLS fixture port
// and trusts the fixture certificate. No request leaves the machine.
const PUBLIC = `https://${GIT_FIXTURE_HOST}`;
const LOOPBACK = `https://127.0.0.1:${SITE_CLIENT_FIXTURE_TLS_PORT}`;
// The harness maps this name to 127.0.0.1 for each port.
const PLAIN_HOST = 'acme.peerd.test';
// why: the default harness turns web security off, so a fetch has no Origin header and no preflight.
const ENFORCED = process.argv.includes('--enforce-web-security');

/** Accept a WebSocket handshake with no library, then leave the socket open. */
const acceptSocket = (request, socket) => {
  const accept = createHash('sha1')
    .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('error', () => {});
};

// The page and the worker share these two helpers.
const HELPERS = `
const socket = (url) => new Promise((resolve) => {
  let ws;
  try { ws = new WebSocket(url); } catch (error) { resolve(error.name); return; }
  const timer = setTimeout(() => resolve('timeout'), 8000);
  ws.onopen = () => { clearTimeout(timer); ws.close(); resolve('open'); };
  ws.onerror = () => { clearTimeout(timer); resolve('error'); };
});
const get = (url, init) => fetch(url, init).then((reply) => reply.status, (error) => error.name);
`;

const workerSource = () => `${HELPERS}
(async () => {
  postMessage({
    fetch: await get(${JSON.stringify(`${PUBLIC}/ping?from=worker`)}),
    loopback: await get(${JSON.stringify(`${LOOPBACK}/ping?from=worker-loopback`)}),
    wss: await socket(${JSON.stringify(`wss://${GIT_FIXTURE_HOST}/ws?from=worker`)}),
  });
})();`;

const probeSource = (plainPort) => `${HELPERS}
// Two connections in one realm. A host candidate shows that WebRTC can gather addresses.
const rtc = async (RTCPeerConnection = globalThis.RTCPeerConnection) => {
  let a, b;
  try { a = new RTCPeerConnection(); b = new RTCPeerConnection(); } catch (error) { return { made: error.name }; }
  let candidates = 0;
  a.onicecandidate = (event) => { if (event.candidate) { candidates += 1; b.addIceCandidate(event.candidate).catch(() => {}); } };
  b.onicecandidate = (event) => { if (event.candidate) a.addIceCandidate(event.candidate).catch(() => {}); };
  const channel = a.createDataChannel('probe');
  const opened = new Promise((resolve) => {
    channel.onopen = () => resolve(true);
    setTimeout(() => resolve(false), 5000);
  });
  try {
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
  } catch (error) { return { made: 'ok', error: error.name, candidates }; }
  const connected = await opened;
  a.close(); b.close();
  return { made: 'ok', candidates, connected };
};
// A shared worker is not in the debugger session of the tab, so the host cannot check its requests.
const shared = () => new Promise((resolve) => {
  if (typeof SharedWorker === 'undefined') { resolve('absent'); return; }
  const source = 'const get = ' + get + '; onconnect = async (event) => event.ports[0].postMessage(await get(' + JSON.stringify(${JSON.stringify(`${LOOPBACK}/ping?from=shared-loopback`)}) + '));';
  setTimeout(() => resolve('timeout'), 8000);
  try {
    const worker = new SharedWorker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    worker.port.onmessage = (event) => resolve(event.data);
    worker.onerror = () => resolve('error');
  } catch (error) { resolve(error.name); }
});
(async () => {
  const blocked = [];
  addEventListener('securitypolicyviolation', (event) => blocked.push(event.violatedDirective + ' ' + event.blockedURI));
  const report = {};
  try {
    report.wss = await socket(${JSON.stringify(`wss://${GIT_FIXTURE_HOST}/ws?from=page`)});
    report.fetch = await get(${JSON.stringify(`${PUBLIC}/ping?from=page`)});
    report.xhr = await new Promise((resolve) => {
      const request = new XMLHttpRequest();
      request.open('GET', ${JSON.stringify(`${PUBLIC}/ping?from=xhr`)});
      request.onload = () => resolve(request.status);
      request.onerror = () => resolve('error');
      request.send();
    });
    report.header = await get(${JSON.stringify(`${PUBLIC}/ping?from=header`)}, { headers: { 'x-probe': '1' } });
    report.ws = await socket(${JSON.stringify(`ws://${PLAIN_HOST}:${plainPort}/ws`)});
    report.http = await get(${JSON.stringify(`http://127.0.0.1:${plainPort}/ping?from=http`)});
    report.loopback = await get(${JSON.stringify(`${LOOPBACK}/ping?from=loopback`)});
    report.redirect = await get(${JSON.stringify(`${PUBLIC}/redirect`)});
    report.image = await new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve('load');
      image.onerror = () => resolve('error');
      image.src = ${JSON.stringify(`${PUBLIC}/ping?from=image`)};
    });
    report.worker = await new Promise((resolve) => {
      const worker = new Worker('worker.js');
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = () => resolve('error');
    });
    report.rtc = await rtc();
    report.shared = await shared();
    report.sharedFrames = [];
    // A nested frame is a new realm. It must not give WebRTC or SharedWorker back.
    report.frames = await Promise.all([{}, { srcdoc: '<p>frame</p>' }, { src: 'about:blank' }].map(async (attributes) => {
      const frame = Object.assign(document.createElement('iframe'), attributes);
      await new Promise((resolve) => { frame.onload = resolve; document.body.append(frame); setTimeout(resolve, 1000); });
      const made = frame.contentWindow?.RTCPeerConnection ? (await rtc(frame.contentWindow.RTCPeerConnection)).connected : 'absent';
      report.sharedFrames.push(typeof frame.contentWindow?.SharedWorker);
      frame.remove();
      return made;
    }));
  } catch (error) {
    report.error = String(error);
  }
  report.blocked = blocked.sort();
  document.title = JSON.stringify(report);
  // Last, because a navigation ends this page. The server holds /wait until the test has read the title.
  if (report.fetch === 200) {
    await get(${JSON.stringify(`${PUBLIC}/wait`)});
    location.href = ${JSON.stringify(`${PUBLIC}/nav`)};
  }
})();`;

export const GAME_NETWORK_STATE = {
  name: 'game-network', kind: 'functional', phase: 'post-unlock',
  responder: null,
  async run(ctx, rec) {
    /** @type {string[]} */
    const hits = [];
    let connections = 0;
    let release = () => {};
    const waiting = new Promise((resolve) => { release = resolve; });
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'x-probe' };
    const note = (kind, request) => hits.push(`${kind} ${request.headers.host}${request.url} origin=${request.headers.origin ?? ''}`);
    const tls = createHttpsServer({ key: GIT_FIXTURE_TLS_KEY, cert: GIT_FIXTURE_TLS_CERT }, async (request, response) => {
      note(request.method, request);
      const path = new URL(request.url ?? '/', PUBLIC).pathname;
      if (request.method === 'OPTIONS') { response.writeHead(204, cors); response.end(); return; }
      if (path === '/redirect') {
        response.writeHead(302, { ...cors, location: `${LOOPBACK}/ping?from=redirect` });
        response.end();
        return;
      }
      if (path === '/wait') await waiting;
      response.writeHead(200, { ...cors, 'content-type': 'text/plain' });
      response.end('pong');
    });
    tls.on('upgrade', (request, socket) => { note('UPGRADE', request); acceptSocket(request, socket); });
    tls.on('connection', () => { connections += 1; });
    const plain = createHttpServer((request, response) => { note('PLAIN', request); response.writeHead(204); response.end(); });
    plain.on('upgrade', (request, socket) => { note('PLAIN-UPGRADE', request); acceptSocket(request, socket); });
    plain.on('connection', () => { connections += 1; });
    await new Promise((resolve, reject) => { tls.once('error', reject); tls.listen(SITE_CLIENT_FIXTURE_TLS_PORT, '127.0.0.1', resolve); });
    await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));
    const plainPort = /** @type {{ port: number }} */ (plain.address()).port;

    const targets = () => fetch(`http://127.0.0.1:${ctx.port}/json/list`).then((reply) => reply.json());
    const home = await openExtPage(ctx, 'home/home.html');
    let appId = null;
    let priorDweb;
    try {
      await waitFor(() => evalIn(home, `document.readyState === 'complete'`).catch(() => false),
        { budgetMs: 15_000, pollMs: 100 });
      // why: a large game is stored through the peer network host, so that host must run.
      const state = await rpc(home, { type: 'state/get' });
      priorDweb = state?.state?.settings?.dwebEnabled === true;
      if (!priorDweb) await rpc(home, { type: 'settings/update', patch: { dwebEnabled: true } });

      const files = {
        'index.html': '<!doctype html><html><head><title>starting</title></head><body><script src="probe.js"></script></body></html>',
        'probe.js': probeSource(plainPort),
        'worker.js': workerSource(),
      };
      // The same two steps as the Library upload: stage the files, then ask for the import.
      let refusal = null;
      const added = await waitFor(async () => {
        const reply = await evalIn(home, `(async () => {
          const { prepareFileTreeFolder, stageFileTreeFolder } = await import('/peerd-engine/app-file-tree-upload.js');
          const files = ${JSON.stringify(files)};
          const prepared = await prepareFileTreeFolder(Object.entries(files).map(([name, text]) => new File([text], name)));
          const uploadId = await stageFileTreeFolder(prepared);
          return chrome.runtime.sendMessage({ type: 'apps/import-files', uploadId, name: 'Network probe', format: 'file-tree-v1' });
        })()`, true).catch((error) => ({ ok: false, error: String(error) }));
        if (reply?.ok) return reply;
        refusal = reply;
        return null;
      }, { budgetMs: 90_000, pollMs: 2000 });
      rec.check('the fixture game was added as a file tree', added?.ok === true && typeof added.id === 'string',
        JSON.stringify(added ?? refusal));
      if (!added?.ok) throw new Error('the fixture game was not added');
      appId = added.id;
      const origin = `https://${appId}.localhost`;
      const listed = async () => (await rpc(home, { type: 'apps/list' }))?.apps?.find((app) => app.id === appId);
      const record = await listed();
      rec.check('a new game has a file tree and no internet access', !!record?.fileTree && record.networkAllowed === undefined,
        JSON.stringify(record));

      const gameTabs = async () => (await targets()).filter((target) => target.type === 'page'
        && (target.url?.startsWith(`${origin}/`) || target.url?.includes(`/engine-tabs/game-tab/index.html#${appId}/`)));
      /** Open the game, read its report from the tab title, and read the host status line. */
      const play = async () => {
        const opened = await rpc(home, { type: 'apps/open', appId });
        if (!opened?.ok) return { opened };
        const game = await waitFor(async () => (await targets()).find((target) => target.type === 'page'
          && target.url?.startsWith(`${origin}/`) && target.title?.startsWith('{')), { budgetMs: 60_000, pollMs: 200 });
        const host = (await targets()).find((target) => target.url?.includes(`/engine-tabs/game-tab/index.html#${appId}/`));
        let status = null;
        if (host) {
          const page = await attach(host.webSocketDebuggerUrl);
          try { status = await evalIn(page, `document.getElementById('status')?.textContent`); } finally { page.close(); }
        }
        let report = null;
        // why: the target list gives the title with HTML entities.
        const title = game?.title?.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<')
          .replaceAll('&gt;', '>').replaceAll('&amp;', '&');
        try { report = title ? JSON.parse(title) : null; } catch { /* the check prints the title */ }
        return { opened, report, status, title: game?.title ?? null, url: game?.url ?? null,
          tabs: (await gameTabs()).map((target) => target.url) };
      };
      const closedBy = async (allowed) => {
        const reply = await rpc(home, { type: 'apps/network', appId, allowed });
        const gone = await waitFor(async () => (await gameTabs()).length === 0, { budgetMs: 10_000, pollMs: 100 });
        return { reply, gone: gone === true, left: (await gameTabs()).map((target) => target.url) };
      };
      const audit = async (type) => (await rpc(home, { type: 'audit/list' }))?.entries
        ?.filter((entry) => entry.type === type && entry.details?.kind === 'app-network' && entry.details?.id === appId) ?? [];
      const sawPublic = (from) => hits.some((hit) => hit.includes(`${GIT_FIXTURE_HOST}/`) && hit.includes(`from=${from}`));
      const closedReport = (report) => !!report && report.wss !== 'open' && report.fetch !== 200 && report.xhr !== 200
        && report.header !== 200 && report.ws !== 'open' && report.http !== 204 && report.loopback !== 200
        && report.redirect !== 200 && report.image === 'error'
        && report.worker?.fetch !== 200 && report.worker?.loopback !== 200 && report.worker?.wss !== 'open';

      const noShared = (report) => report?.shared === 'absent' && report.sharedFrames?.length === 3
        && report.sharedFrames.every((type) => type === 'undefined');

      // 1. Off, the default.
      const off = await play();
      rec.check('off: the game opens and reports', off.opened?.ok === true && !!off.report && !off.report.error,
        JSON.stringify(off));
      rec.check('off: WebSocket, fetch and XHR fail in the page and in a worker', closedReport(off.report),
        JSON.stringify(off.report));
      rec.check('off: the page policy names connect-src for the wss and the https request',
        off.report?.blocked?.some((line) => line.startsWith('connect-src wss://'))
          && off.report.blocked.some((line) => line.startsWith('connect-src https://')),
        JSON.stringify(off.report?.blocked));
      rec.check('off: the page cannot make a WebRTC connection, also not through a nested frame',
        off.report?.rtc?.made === 'TypeError' && off.report.frames?.length === 3
          && off.report.frames.every((made) => made === 'absent'),
        JSON.stringify({ rtc: off.report?.rtc, frames: off.report?.frames }));
      rec.check('off: the page has no SharedWorker, also not through a nested frame', noShared(off.report),
        JSON.stringify({ shared: off.report?.shared, frames: off.report?.sharedFrames }));
      rec.check('off: no request and no connection reached a server', hits.length === 0 && connections === 0,
        JSON.stringify({ hits, connections }));
      rec.check('off: the game host page states the setting', off.status?.endsWith('Internet access: off.') === true,
        JSON.stringify(off.status));

      // 2. Only Home can turn it on, and the change closes the open game.
      const refused = await rpc(ctx.page, { type: 'apps/network', appId, allowed: true });
      rec.check('the side panel cannot turn internet access on',
        refused?.ok !== true && (await listed())?.networkAllowed !== true && (await gameTabs()).length === 2,
        JSON.stringify({ refused, tabs: (await gameTabs()).length }));
      const on = await closedBy(true);
      rec.check('Home turns internet access on', on.reply?.ok === true && on.reply.app?.networkAllowed === true
        && on.reply.closed === true, JSON.stringify(on.reply));
      rec.check('the change closes the game host tab and the game tab', on.gone, JSON.stringify(on.left));
      const granted = await audit('permission_granted');
      rec.check('the audit log has one permission_granted entry for this game',
        granted.length === 1 && granted[0].details.name === 'Network probe', JSON.stringify(granted));

      // 3. On: a public https and wss host works.
      const live = await play();
      rec.check('on: the game opens and reports', live.opened?.ok === true && !!live.report && !live.report.error,
        JSON.stringify(live));
      rec.check('on: wss opens, and fetch and XHR get 200 from a public host',
        live.report?.wss === 'open' && live.report.fetch === 200 && live.report.xhr === 200,
        JSON.stringify(live.report));
      rec.check('on: the server saw the handshake and the fetch with the game origin',
        hits.some((hit) => hit.startsWith(`UPGRADE ${GIT_FIXTURE_HOST}/ws?from=page`) && hit.endsWith(`origin=${origin}`))
          && hits.some((hit) => hit.startsWith(`GET ${GIT_FIXTURE_HOST}/ping?from=page`) && hit.endsWith(`origin=${ENFORCED ? origin : ''}`)),
        JSON.stringify(hits));
      rec.check(ENFORCED ? 'on: a fetch with a custom header works, and its CORS preflight reached the server'
        : 'on: a fetch with a custom header works',
        live.report?.header === 200 && hits.some((hit) => hit.startsWith(`GET ${GIT_FIXTURE_HOST}/ping?from=header`))
          && (!ENFORCED || hits.some((hit) => hit.startsWith(`OPTIONS ${GIT_FIXTURE_HOST}/ping?from=header`))),
        JSON.stringify({ header: live.report?.header, hits: hits.filter((hit) => hit.includes('from=header')) }));
      rec.check('on: a worker reaches the public host with fetch and wss',
        live.report?.worker?.fetch === 200 && live.report.worker.wss === 'open' && sawPublic('worker'),
        JSON.stringify(live.report?.worker));
      rec.check('on: new RTCPeerConnection() works, gathers an address, and a data channel opens',
        live.report?.rtc?.made === 'ok' && live.report.rtc.candidates > 0 && live.report.rtc.connected === true,
        JSON.stringify(live.report?.rtc));
      rec.check('on: the game host page states the setting', live.status?.endsWith('Internet access: on.') === true,
        JSON.stringify(live.status));

      // 4. On: each other path stays closed.
      rec.check('on: ws: and http: stay closed, and the plain server saw nothing',
        live.report?.ws !== 'open' && live.report?.http !== 204 && !hits.some((hit) => hit.startsWith('PLAIN')),
        JSON.stringify({ ws: live.report?.ws, http: live.report?.http, hits: hits.filter((hit) => hit.startsWith('PLAIN')) }));
      rec.check('on: an https request to a loopback address does not leave, from the page or from a worker',
        live.report?.loopback !== 200 && live.report?.worker?.loopback !== 200
          && !hits.some((hit) => hit.includes('from=loopback') || hit.includes('from=worker-loopback')),
        JSON.stringify({ page: live.report?.loopback, worker: live.report?.worker?.loopback }));
      rec.check('on: the page has no SharedWorker, also not through a nested frame, and the server saw no request from one',
        noShared(live.report) && !hits.some((hit) => hit.includes('from=shared-loopback')),
        JSON.stringify({ shared: live.report?.shared, frames: live.report?.sharedFrames, hits: hits.filter((hit) => hit.includes('from=shared')) }));
      rec.check('on: a redirect from a public host to a loopback address stops at the second hop',
        hits.some((hit) => hit.startsWith(`GET ${GIT_FIXTURE_HOST}/redirect`)) && !hits.some((hit) => hit.includes('from=redirect'))
          && live.report?.redirect !== 200,
        JSON.stringify({ redirect: live.report?.redirect, hits: hits.filter((hit) => hit.includes('redirect')) }));
      rec.check('on: an image from a public host does not load', live.report?.image === 'error' && !sawPublic('image'),
        JSON.stringify(live.report?.image));
      release();
      const navigated = await waitFor(async () => (await targets()).find((target) => target.type === 'page'
        && target.url === `${PUBLIC}/nav`), { budgetMs: 15_000, pollMs: 100 });
      rec.check('on: a navigation of the game tab to a public site gets a local answer, and the server sees nothing',
        !!navigated && hits.some((hit) => hit.startsWith(`GET ${GIT_FIXTURE_HOST}/wait`)) && !hits.some((hit) => hit.includes('/nav')),
        JSON.stringify({ url: navigated?.url ?? null, hits: hits.filter((hit) => hit.includes('/nav')) }));

      // 5. Off again: the game closes, and the next open equals the first one.
      const seen = hits.length;
      const offAgain = await closedBy(false);
      rec.check('Home turns internet access off with one message, and the game closes',
        offAgain.reply?.ok === true && offAgain.reply.app?.networkAllowed === false && offAgain.reply.closed === true && offAgain.gone,
        JSON.stringify(offAgain));
      rec.check('the audit log has one permission_revoked entry for this game',
        (await audit('permission_revoked')).length === 1, JSON.stringify(await audit('permission_revoked')));
      const again = await play();
      rec.check('off again: the report equals the first report', JSON.stringify(again.report) === JSON.stringify(off.report),
        JSON.stringify({ first: off.report, again: again.report }));
      rec.check('off again: no new request reached a server', hits.length === seen, JSON.stringify(hits.slice(seen)));
    } finally {
      release();
      if (appId) {
        const deleted = await rpc(home, { type: 'apps/delete', appId }).catch(() => null);
        rec.check('fixture game removed', deleted?.ok === true, JSON.stringify(deleted));
      }
      if (priorDweb === false) await rpc(home, { type: 'settings/update', patch: { dwebEnabled: false } }).catch(() => {});
      home.close();
      tls.closeAllConnections?.();
      plain.closeAllConnections?.();
      await new Promise((resolve) => tls.close(resolve));
      await new Promise((resolve) => plain.close(resolve));
    }
  },
};
