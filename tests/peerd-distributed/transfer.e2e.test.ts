import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { createSession } from '../../extension/peerd-distributed/transport/session.js';
import { memoryPair } from '../../extension/peerd-distributed/transport/channel.js';
import { buildManifest } from '../../extension/peerd-distributed/content/manifest.js';
import { createContentStore } from '../../extension/peerd-distributed/content/store.js';
import { createContentResponder, fetchBundle } from '../../extension/peerd-distributed/content/transfer.js';
import { packBundle, unpackBundleText } from '../../extension/peerd-distributed/content/bundle.js';
import { formatPeerdUri } from '../../extension/peerd-distributed/content/uri.js';
import { utf8, toBase64, fromBase64, bytesEqual } from '../../extension/shared/bundle/bytes.js';

// A multi-file app, large enough to span several 256KB chunks.
const APP_FILES = {
  'index.html': '<link rel="stylesheet" href="./style.css"><h1 id="t">peerd</h1><script src="./app.js"></script>',
  'style.css': 'h1{color:rebeccapurple}' + '/*pad*/'.repeat(60000),
  'app.js': 'document.getElementById("t").textContent="delivered peer-to-peer";',
};

const buildSample = () => {
  const files: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(APP_FILES)) files[k] = utf8(v);
  return packBundle({ entry: 'index.html', files });
};

// Drive both peers' HELLO handshakes, then the publisher's responder loop.
const wirePublisher = (channel: any, store: any) => {
  const respond = createContentResponder({ store });
  channel.setHandler((msg: any) => respond(msg, (out: any) => channel.send(out)));
};

describe('end-to-end app transfer over a channel pair', () => {
  test('two peers handshake, then transfer + verify a signed bundle', async () => {
    const [chPub, chCon] = memoryPair();
    const pub = await generateIdentity();
    const con = await generateIdentity();

    // Mutual authenticated handshake.
    const [pubSide, conSide] = await Promise.all([
      createSession({ channel: chPub, identity: pub }),
      createSession({ channel: chCon, identity: con }),
    ]);
    expect(pubSide.remoteDid).toBe(con.did);
    expect(conSide.remoteDid).toBe(pub.did);

    // Publisher authors, signs, announces the app.
    const payload = buildSample();
    const { manifest, hash, chunks } = await buildManifest({
      payload,
      type: 'app',
      entry: 'index.html',
      identity: pub,
      now: () => 1_700_000_000_000,
    });
    expect(manifest.chunks.length).toBeGreaterThan(1);
    const store = createContentStore();
    store.publish({ manifest, hash, chunks });
    const uri = formatPeerdUri({ did: pub.did, hash });

    wirePublisher(chPub, store);

    // Consumer fetches + verifies.
    const progress: string[] = [];
    const { payload: got } = await fetchBundle({
      uri,
      channel: chCon,
      onProgress: (p: any) => progress.push(p.phase),
    });

    expect(bytesEqual(got, payload)).toBe(true);
    const { entry, files } = unpackBundleText(got);
    expect(entry).toBe('index.html');
    expect(files['app.js']).toContain('delivered peer-to-peer');
    expect(progress).toContain('manifest');
    expect(progress).toContain('chunk');
  });

  test('rejects a bundle whose chunk bytes were tampered in flight', async () => {
    const [chPub, chCon] = memoryPair();
    const pub = await generateIdentity();
    const con = await generateIdentity();
    await Promise.all([
      createSession({ channel: chPub, identity: pub }),
      createSession({ channel: chCon, identity: con }),
    ]);

    const payload = buildSample();
    const { manifest, hash, chunks } = await buildManifest({ payload, entry: 'index.html', identity: pub, now: () => 1 });
    const store = createContentStore();
    store.publish({ manifest, hash, chunks });

    // Malicious responder: flips one byte in every CHUNK it serves.
    const respond = createContentResponder({ store });
    chPub.setHandler((msg: any) =>
      respond(msg, (out: any) => {
        if (out.t === 'CHUNK') {
          const b = fromBase64(out.bytes);
          b[0] ^= 0xff;
          out = { ...out, bytes: toBase64(b) };
        }
        chPub.send(out);
      }),
    );

    await expect(
      fetchBundle({ uri: formatPeerdUri({ did: pub.did, hash }), channel: chCon }),
    ).rejects.toThrow(/chunk hash mismatch/);
  });

  test('rejects content the publisher never announced', async () => {
    const [chPub, chCon] = memoryPair();
    const pub = await generateIdentity();
    const con = await generateIdentity();
    await Promise.all([
      createSession({ channel: chPub, identity: pub }),
      createSession({ channel: chCon, identity: con }),
    ]);

    const store = createContentStore(); // empty — nothing announced
    wirePublisher(chPub, store);

    const fakeHash = 'b'.repeat(64);
    await expect(
      fetchBundle({ uri: formatPeerdUri({ did: pub.did, hash: fakeHash }), channel: chCon, timeoutMs: 2000 }),
    ).rejects.toThrow(/does not hold/);
  });
});
