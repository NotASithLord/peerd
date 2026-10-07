import { describe, expect, test } from 'bun:test';
import { validateHosts, validatePaths } from '../../scripts/cdp/dweb-cluster-checks.mjs';

const hosts = () => [1, 2].map(number => ({ machine: String(number).repeat(64), source: 'a'.repeat(64),
  platform: 'darwin', browser: 'Chrome/test' }));
const path = () => ({ did: 'peer', state: 'succeeded', bytesSent: 100, bytesReceived: 100,
  local: { address: '169.254.1.1', protocol: 'udp', type: 'host' },
  remote: { address: '169.254.1.2', protocol: 'udp', type: 'host' } });

describe('physical cluster evidence cannot silently pass a local rehearsal', () => {
  test('accepts identical source on distinct Macs with an actual UDP pair', () => {
    expect(() => validateHosts(hosts())).not.toThrow();
    expect(() => validatePaths([path()], ['peer'])).not.toThrow();
  });
  test('rejects duplicate machines even when their labels differ', () => {
    const values = hosts();
    values[1].machine = values[0].machine;
    expect(() => validateHosts(values)).toThrow('different physical machines');
    expect(() => validateHosts(values, { local: true })).not.toThrow();
  });
  test('rejects mixed source, missing identity and mixed browser versions', () => {
    for (const field of ['source', 'machine', 'browser'] as const) {
      const values = hosts();
      values[1][field] = '';
      expect(() => validateHosts(values)).toThrow();
    }
    const values = hosts();
    values[1].source = 'b'.repeat(64);
    expect(() => validateHosts(values)).toThrow('identical source');
    values[1] = { ...values[0], machine: '2'.repeat(64), browser: 'Chrome/other' };
    expect(() => validateHosts(values)).toThrow('same browser');
  });
  test('rejects non-Mac hosts unless explicitly rehearsing', () => {
    const values = hosts();
    values[0].platform = 'linux';
    expect(() => validateHosts(values)).toThrow('macOS');
    expect(() => validateHosts(values, { local: true })).not.toThrow();
  });
  test('requires every expected peer exactly once', () => {
    expect(() => validatePaths([], ['peer'])).toThrow();
    expect(() => validatePaths([path(), path()], ['peer'])).toThrow();
    expect(() => validatePaths([path()], ['stranger'])).toThrow();
  });
  test('refuses unknown, relay, loopback and idle paths', () => {
    const invalid = [
      { ...path(), state: 'in-progress' },
      { ...path(), bytesReceived: 0 },
      { ...path(), local: { ...path().local, type: 'relay' } },
      { ...path(), remote: { ...path().remote, address: '127.0.0.1' } },
      { ...path(), remote: { ...path().remote, address: '::1' } },
      { ...path(), remote: { ...path().remote, address: '' } },
      { ...path(), remote: path().local },
    ];
    for (const value of invalid) expect(() => validatePaths([value], ['peer'])).toThrow();
  });
});
