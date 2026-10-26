import { expect, test } from 'bun:test';
import { createDiscovery, DISCOVERY } from '../../extension/peerd-distributed/apps/discovery.js';
import { createLibrary } from '../../extension/peerd-distributed/apps/library.js';
import { buildMeta, metaDwappId } from '../../extension/peerd-distributed/apps/meta.js';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { buildEnvelope, signEnvelope, verifyEnvelope } from '../../extension/peerd-distributed/transport/envelope.js';
import { createOutgoingWriter, createOutgoingGovernor } from '../../extension/peerd-distributed/transport/outgoing.js';

// Exercise the actual transport byte gate with real signed cards and carriers.
// A successful count-only mock cannot prove a catalog fits negotiated SCTP.
test.each([256, 4096, 65536])('catalog repair respects a %i-byte connection without skipping cards', async (frameLimit) => {
  const identity = await generateIdentity();
  let time = 0; let serial = 0; let receive: any;
  const sent: any[] = [];
  const dc = Object.assign(new EventTarget(), { readyState: 'open', bufferedAmount: 0,
    bufferedAmountLowThreshold: 0, send: (encoded: string) => { sent.push(JSON.parse(encoded)); } });
  const writer = createOutgoingWriter({ dc: dc as any, governor: createOutgoingGovernor(), maxMessageSize: () => frameLimit });
  const library = createLibrary({ now: () => time });
  const mesh = {
    peers: () => [{ did: 'subscriber', channel: writer }],
    onEnvelope: (callback: any) => { receive = callback; return () => {}; },
    onPeer: () => () => {}, onPeerGone: () => () => {},
    sign: (ch: number, typ: number, body: any) => signEnvelope(buildEnvelope({ ch, typ, body,
      from: identity.did, id: String(++serial), ts: time }), identity),
    send: async (_did: string, env: any) => { await writer.send(env); return true; },
  };
  const discovery = createDiscovery({ mesh, identity, library, now: () => time });
  try {
    for (let i = 0; i < 96; i++) await discovery.announce(await buildMeta({ slug: `card-${i}`,
      name: `App ${i}`, description: '界'.repeat(200), seq: 1,
      head: { version_id: 'v1', content_addr: 'peerd://publisher/hash', size: 10,
        includes_wasm: true, changelog: 'x'.repeat(1200) } }, identity));
    let after = ''; const received: string[] = [];
    for (let page = 0; page < 96; page++) {
      time += 60_001;
      const before = sent.length;
      await receive({ via: 'subscriber', env: { from: 'subscriber', ch: DISCOVERY.CH, typ: DISCOVERY.SUB,
        body: { catalog: 1, id: String(page), after, limit: 60 } } });
      if (frameLimit === 256) {
        // Even one signed card cannot fit: retain the catalog without sending
        // an oversized frame or acknowledging a cursor beyond missing data.
        expect(sent).toHaveLength(0);
        expect(library.size()).toBe(96);
        return;
      }
      expect(sent.length).toBe(before + 1);
      const response = sent.at(-1);
      expect(await verifyEnvelope(response)).toBe(true);
      expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThanOrEqual(frameLimit);
      expect(response.body.page.after).toBe(after);
      const ids = await Promise.all(response.body.items.map(metaDwappId));
      received.push(...ids);
      if (response.body.page.next === null) break;
      expect(response.body.page.next).toBe(ids.at(-1));
      after = response.body.page.next;
    }
    expect(received).toHaveLength(96);
    expect(new Set(received).size).toBe(96);
    expect(received).toEqual(library.rows().map(row => row.dwapp_id).sort());
  } finally { discovery.close(); writer.close(); }
});
