import { describe, test, expect } from 'bun:test';
import {
  summarizeCandidates,
  DirectPathUnavailableError,
} from '../../extension/peerd-distributed/transport/ice.js';

const SDP = [
  'v=0',
  'o=- 1 1 IN IP4 127.0.0.1',
  'a=candidate:1 1 udp 2122260223 192.168.1.7 54321 typ host generation 0',
  'a=candidate:2 1 udp 2122262783 2601:db8:4002:aa10::42 54322 typ host generation 0',
  'a=candidate:3 1 udp 2122194687 a1b2c3d4-e5f6-aaaa-bbbb-ccccdddd0001.local 54323 typ host generation 0',
  'a=candidate:4 1 udp 1685987071 203.0.113.9 54321 typ srflx raddr 0.0.0.0 rport 0 generation 0',
  'a=candidate:5 1 tcp 1518280447 192.168.1.7 9 typ host tcptype active generation 0',
].join('\r\n');

describe('ICE diagnostics (the pure half)', () => {
  test('summarizes candidate types and families from SDP', () => {
    expect(summarizeCandidates(SDP)).toEqual({
      host4: 2, // udp + tcp host on 192.168.1.7
      host6: 1, // 2601:db8:… is a GLOBAL (routable) IPv6
      host6ll: 0, // no fe80:: link-local in this fixture
      srflx: 1,
      prflx: 0,
      relay: 0,
      mdns: 1,
    });
  });

  test('empty / absent SDP summarizes to zeroes', () => {
    expect(summarizeCandidates('')).toEqual({ host4: 0, host6: 0, host6ll: 0, srflx: 0, prflx: 0, relay: 0, mdns: 0 });
    expect(summarizeCandidates(undefined as any).srflx).toBe(0);
  });

  test('the failure error names the cause and carries both summaries', () => {
    const err = new DirectPathUnavailableError({
      local: summarizeCandidates(SDP),
      remote: summarizeCandidates(''),
    });
    expect(err.name).toBe('DirectPathUnavailableError');
    expect(err.message).toContain('no TURN relay');
    expect(err.message).toContain('host6:1');
    expect(err.local!.srflx).toBe(1);
  });
});
