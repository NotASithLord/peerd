// tests/peerd-distributed/netproc/relay.ts — a WebSocket message switchboard
// for the multi-PROCESS node test. The in-process sim wires nodes with memory
// pipes; separate OS processes need a real transport. This relay is NOT the
// production data path — it's a dumb switchboard that forwards a frame to its
// target did, standing in for rendezvous + transport so each node process can
// form REAL authenticated mesh links to the others and run its real logic.
//   bun tests/peerd-distributed/netproc/relay.ts [port]

type WsData = { did?: string; label?: string };
const PORT = Number(process.argv[2] ?? 8810);
const conns = new Map<string, any>(); // did -> ws

const roster = () => [...conns.values()].map((ws) => ({ did: ws.data.did, label: ws.data.label }));
const sendRoster = () => {
  const msg = JSON.stringify({ t: 'roster', peers: roster() });
  for (const ws of conns.values()) ws.send(msg);
};

const server = Bun.serve<WsData>({
  port: PORT,
  fetch(req, server) {
    return server.upgrade(req, { data: {} }) ? undefined : new Response('peerd netproc relay');
  },
  websocket: {
    message(ws, raw) {
      let m: any;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.t === 'hello') {
        ws.data.did = m.did; ws.data.label = m.label;
        conns.set(m.did, ws);
        console.log(`+ ${m.label} (${conns.size} online)`);
        sendRoster();
      } else if (m.t === 'msg') {
        const to = conns.get(m.to);
        if (to) to.send(JSON.stringify({ t: 'msg', from: ws.data.did, payload: m.payload }));
      }
    },
    close(ws) {
      if (ws.data?.did && conns.get(ws.data.did) === ws) {
        conns.delete(ws.data.did);
        console.log(`- ${ws.data.label} (${conns.size} online)`);
        sendRoster();
      }
    },
  },
});
// why server.port (not PORT): callers may pass 0 to get an ephemeral port —
// the cluster driver does, so parallel CI jobs never collide on a fixed port.
console.log(`relay listening on ws://localhost:${server.port}`);
