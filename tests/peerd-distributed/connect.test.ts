import { describe, test, expect } from 'bun:test';
import { createConnector } from '../../extension/peerd-distributed/transport/connect.js';
import { createInprocTransport } from '../../extension/peerd-distributed/transport/transports/inproc.js';
import { deMdnsSdp } from '../../extension/peerd-distributed/transport/sdp.js';

describe('in-process transport', () => {
  test('links two same-realm peers through a channel pair', async () => {
    const t = createInprocTransport();
    let serverGot: any = null;
    t.listen('did:key:zServer', (ch: any) => { serverGot = ch; });
    const client = await t.connect({ did: 'did:key:zServer' });

    serverGot.setHandler((m: any) => serverGot.send({ echo: m.ping }));
    const reply = await new Promise((res) => { client.setHandler(res); client.send({ ping: 42 }); });
    expect(reply).toEqual({ echo: 42 });
  });

  test('canReach is 1 only when the peer is present in this realm', () => {
    const t = createInprocTransport();
    const stop = t.listen('did:key:zHere', () => {});
    expect(t.canReach({ did: 'did:key:zHere' })).toBe(1);
    expect(t.canReach({ did: 'did:key:zElsewhere' })).toBe(0);
    stop();
    expect(t.canReach({ did: 'did:key:zHere' })).toBe(0);
  });
});

describe('connect() transport selection', () => {
  test('picks the in-process transport when the peer is local', async () => {
    const inproc = createInprocTransport();
    inproc.listen('did:key:zLocal', (ch: any) => { ch.setHandler((m: any) => ch.send({ pong: m.n })); });

    // A stub "remote" transport that should never be reached for a local peer.
    let remoteTried = false;
    const remote = {
      name: 'fake-remote',
      canReach: () => 0.4,
      async connect() { remoteTried = true; throw new Error('should not be used'); },
    };

    const { connect } = createConnector({ transports: [inproc, remote] });
    const { transport } = await connect({ did: 'did:key:zLocal' });
    expect(transport).toBe('inproc');
    expect(remoteTried).toBe(false);
  });

  test('falls through to the next transport when the first cannot reach', async () => {
    const inproc = createInprocTransport(); // nobody listening → canReach 0
    const fallback = {
      name: 'fallback',
      canReach: () => 1,
      async connect() { return { send() {}, setHandler() {}, deliver() {} }; },
    };
    const { connect } = createConnector({ transports: [inproc, fallback] });
    const { transport } = await connect({ did: 'did:key:zNobody' });
    expect(transport).toBe('fallback');
  });

  test('throws a useful error when no transport applies', async () => {
    const inproc = createInprocTransport();
    const { connect } = createConnector({ transports: [inproc] });
    await expect(connect({ did: 'did:key:zGhost' })).rejects.toThrow(/no transport reached/);
  });
});

describe('same-machine SDP strategy', () => {
  test('deMdns rewrites the privacy mDNS hostname to loopback', () => {
    const sdp = 'a=candidate:1 1 udp 2113937151 9f3c2a10-dead-beef-1234-aabbccddeeff.local 51820 typ host';
    expect(deMdnsSdp(sdp)).toContain('127.0.0.1');
    expect(deMdnsSdp(sdp)).not.toContain('.local');
  });
});
