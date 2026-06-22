import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { createConnector } from '../../extension/peerd-distributed/transport/connect.js';
import { createInprocTransport } from '../../extension/peerd-distributed/transport/transports/inproc.js';
import { createSession } from '../../extension/peerd-distributed/transport/session.js';
import { buildManifest } from '../../extension/peerd-distributed/content/manifest.js';
import { createContentStore } from '../../extension/peerd-distributed/content/store.js';
import { createContentResponder, fetchBundle } from '../../extension/peerd-distributed/content/transfer.js';
import { packBundle } from '../../extension/peerd-distributed/content/bundle.js';
import { formatPeerdUri } from '../../extension/peerd-distributed/content/uri.js';
import { utf8, bytesEqual } from '../../extension/shared/bundle/bytes.js';

// The SAME transfer pipeline as transfer.e2e, but the channels now come
// from connect() over the in-process transport instead of a hand-wired
// memoryPair. Nothing above the transport changes — that's the point:
// "a peer is a peer." This is the abstraction's regression test.
describe('app transfer over connect() (in-process transport)', () => {
  test('publisher listens, consumer connects, bundle transfers + verifies', async () => {
    const pub = await generateIdentity();
    const con = await generateIdentity();

    const transport = createInprocTransport();
    let resolvePubCh: (c: any) => void;
    const pubChannelP = new Promise<any>((r) => { resolvePubCh = r; });
    transport.listen(pub.did, (ch: any) => resolvePubCh(ch));

    const { connect } = createConnector({ transports: [transport] });
    const { channel: conChannel, transport: used } = await connect({ did: pub.did });
    expect(used).toBe('inproc');
    const pubChannel = await pubChannelP;

    // Authenticated handshake over whatever channel connect() handed back.
    const [, conSide] = await Promise.all([
      createSession({ channel: pubChannel, identity: pub }),
      createSession({ channel: conChannel, identity: con }),
    ]);
    expect(conSide.remoteDid).toBe(pub.did);

    // Publish + serve + fetch, identical to the WebRTC-path test.
    const files = { 'index.html': utf8('<h1>over connect()</h1>'), 'd.json': utf8(JSON.stringify({ n: 7 })) };
    const payload = packBundle({ entry: 'index.html', files });
    const { manifest, hash, chunks } = await buildManifest({ payload, entry: 'index.html', identity: pub, now: () => 1 });
    const store = createContentStore();
    store.publish({ manifest, hash, chunks });

    const respond = createContentResponder({ store });
    pubChannel.setHandler((msg: any) => respond(msg, (out: any) => pubChannel.send(out)));

    const { payload: got } = await fetchBundle({ uri: formatPeerdUri({ did: pub.did, hash }), channel: conChannel });
    expect(bytesEqual(got, payload)).toBe(true);
  });
});
