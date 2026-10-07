import { expect, test } from 'bun:test';
import { connected, scaleOptions } from '../../scripts/cdp/run-dweb-scale.mjs';

test('scale arguments expose only explicit fixed sizes and paced/stress modes', () => {
  expect(scaleOptions([])).toEqual({ peers: 16, mode: 'paced' });
  expect(scaleOptions(['--peers=64', '--mode=stress'])).toEqual({ peers: 64, mode: 'stress' });
  for (const flag of ['--peers=17', '--degree=64', '--timeout=900000', '--url=wss://other', '--mode=retry']) {
    expect(() => scaleOptions([flag])).toThrow('unsupported scale option');
  }
});
test('connectivity requires reciprocal paths and unique participating identities', () => {
  const a = { did: 'a', peers: ['b'] }, b = { did: 'b', peers: ['a', 'c'] }, c = { did: 'c', peers: ['b'] };
  expect(connected([a, b, c])).toBe(true);
  expect(connected([a, b, { ...c, peers: [] }])).toBe(false);
  expect(connected([a, b, a])).toBe(false);
  expect(connected([])).toBe(false);
});
