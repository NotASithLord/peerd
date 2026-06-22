// @ts-check
// dweb_guide — the dwapp BRIDGE reference, loaded on demand (progressive disclosure).
//
// The multiplayer/bridge how-to is bulky, and most sessions never build a shared
// dwapp — so it does NOT live in the system prompt. The short dweb block tells the
// agent to call this tool FIRST when building a multiplayer/shared App; the full
// client + ops + events + game pattern arrives only then. Read-only, no IO, no
// confirm — it just returns reference text. dweb-only.

// why a const string, not a fetched asset: it's the tool's payload, versioned with
// the tool; keeping it inline means no extra fetch + no store-pruning surprises.
const BRIDGE_GUIDE = `dwapp bridge — build a MULTIPLAYER / shared App.

STEP 0 — CREATE THE APP AS A DWAPP, or there is no bridge:
  app_create({ name, files, dwapp: true })     // dwapp:true is REQUIRED
The dwapp:true flag is what makes the app-tab attach the bridge. WITHOUT it the
app is an ordinary sandboxed app, window.parent never answers hello(), and you'll
get "no dweb bridge — open this inside peerd" no matter how correct your client
code is. (Grow it with app_write_file afterward; the dwapp marking persists.)

DON'T SELF-NAVIGATE with location.* or history — it reloads the opaque sandbox
frame, loses all app state, and drops the bridge ("app frame navigated
unexpectedly"). Switch screens (lobby → game) by showing/hiding DOM. Forms,
buttons, links, and meta-refresh are handled for you — they won't navigate the
frame, so write them naturally (a <form> with a submit handler is fine).

An App you build talks to the network through the dwapp bridge: it posts a request
to window.parent and listens for replies + events. Drop this minimal client INLINE
into the app's HTML — in a <script> tag in the page, NOT a separate bridge.js the
game imports. why: the sandbox has no file server, so cross-file ES module
import/export between your files does not resolve (the app would silently never
start — "Connecting…" forever). Keep all the JS in inline/classic <script> tags
(they share one global scope) or one self-contained <script type=module>. Note the
exact message keys — peerd:'dweb' out, peerd:'dweb:result' / peerd:'dweb:event' in;
NOT type:'dweb':

  let seq = 0; const pend = new Map(); const subs = new Map();
  const call = (op, args = {}) => new Promise((res, rej) => {
    const id = ++seq; pend.set(id, { res, rej });
    parent.postMessage({ peerd: 'dweb', id, op, args }, '*');
  });
  const on = (ev, cb) => subs.set(ev, [...(subs.get(ev) || []), cb]);
  addEventListener('message', (e) => { const m = e.data; if (!m) return;
    if (m.peerd === 'dweb:result') { const p = pend.get(m.id); if (p) { pend.delete(m.id); m.ok ? p.res(m.value) : p.rej(new Error(m.error)); } }
    else if (m.peerd === 'dweb:event') (subs.get(m.event) || []).forEach((cb) => cb(m.data)); });

Ops (all via call): hello() -> {available, did, joined}. join({roomId, name}) ->
the shared space (pick a roomId, e.g. the game name). leave(). publish({topic,
data, retain}) -> broadcast to everyone in the room on a topic (retain:true keeps
it for late joiners). subscribe({topic}). history({topic}) -> past retained
messages. dm-send({to, data}) -> a private 1:1 message to one peer's did.
presence() -> who is here. announce({meta:{name}}) -> set your display name.

Events (via on): 'message' {topic, from, data, ts, id} someone published; 'direct'
{from, data} a dm to you; 'presence-join' {did, meta}; 'presence-leave' {did}.

Pattern for a 2+ player game: on load call hello() then join({roomId:'<game>',
name}); subscribe({topic:'move'}); on 'message' for 'move' apply the opponent's
move (data says who + what); on your own move publish({topic:'move', data});
presence-join/leave shows who is playing. The commons app in the Library is the
full worked reference. \`from\` on every event is the signed sender did, set by the
platform, so a peer cannot spoof another; \`data\` is opaque bytes, put whatever you
need in it.

Build the app first — app_create({ ..., dwapp: true }) + app_write_file — wired to
the bridge, test it, then dweb_share it so friends can install and play.`;

// why: 'dweb' is the network primitive — outside the base Primitive union (the
// dweb module + its tools are pruned on the store build). ctx.dweb is an
// SW-injected slot absent from the base ToolContext; narrowed inside execute.
/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').ToolResult | { ok: false, error: string, content?: string }} DwebToolResult */
/** @typedef {Omit<Tool, 'primitive' | 'execute'> & { primitive: 'dweb', execute: (args: any, ctx: ToolContext) => Promise<DwebToolResult> }} DwebTool */

/** @type {DwebTool} */
export const dwebGuideTool = {
  name: 'dweb_guide',
  primitive: 'dweb',
  dweb: true,
  description: [
    'Get the dwapp BRIDGE reference for building a multiplayer / shared App (game,',
    'whiteboard, chat): the postMessage client, the join/publish/subscribe/dm/',
    'presence ops, and the events. Call this FIRST when building a shared dwapp —',
    'it is loaded on demand to keep it out of context until needed. Read-only.',
  ].join(' '),
  schema: { type: 'object', properties: {} },
  sideEffect: 'read',
  origins: () => [],

  execute: async (_args, ctx) => {
    // why: narrow the SW-injected ctx.dweb slot — only its presence is checked.
    const dweb = /** @type {{ dweb?: unknown }} */ (ctx).dweb;
    if (!dweb) return { ok: false, error: 'dweb_unavailable', content: 'The dweb is not enabled in this build.' };
    return { ok: true, content: BRIDGE_GUIDE };
  },
};
