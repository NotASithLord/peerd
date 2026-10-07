import { expect, test } from 'bun:test';
import { twoPeerEndpoint } from '../../extension/tests/dweb-twopeer-endpoint.js';

test('two-peer harness reconstructs only explicit loopback endpoints and dynamic ports', () => {
  expect(twoPeerEndpoint(null)).toBe('ws://localhost:8799/rendezvous');
  for (const host of ['localhost', '127.0.0.1']) {
    for (const port of [1, 80, 8799, 49152, 65535]) {
      expect(twoPeerEndpoint(`ws://${host}:${port}/rendezvous`)).toBe(`ws://${host}:${port}/rendezvous`);
    }
  }
});

test('two-peer harness rejects external destinations and malformed or ambiguous URL authority', () => {
  for (const value of [
    '', 'ws://external.example:8799/rendezvous', 'ws://localhost.evil:8799/rendezvous',
    'ws://localhost@evil.example:8799/rendezvous', 'ws://user@localhost:8799/rendezvous',
    'ws://127.1:8799/rendezvous', 'ws://2130706433:8799/rendezvous',
    'ws://[::1]:8799/rendezvous', 'wss://localhost:8799/rendezvous',
    'http://localhost:8799/rendezvous', '//localhost:8799/rendezvous',
    'ws://localhost/rendezvous', 'ws://localhost:0/rendezvous',
    'ws://localhost:65536/rendezvous', 'ws://localhost:08799/rendezvous',
    'ws://localhost:+8799/rendezvous', 'ws://localhost:1e3/rendezvous',
    'ws://localhost:8799/other', 'ws://localhost:8799/a/../rendezvous',
    'ws://localhost:8799/rendezvous?key=foreign', 'ws://localhost:8799/rendezvous#fragment',
    'ws://localhost:8799/rendezvous\n', ' ws://localhost:8799/rendezvous',
    'ws://localhost:8799\\rendezvous',
  ]) expect(() => twoPeerEndpoint(value)).toThrow();
});
