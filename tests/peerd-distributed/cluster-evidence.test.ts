import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceFingerprint, gitMetadata } from '../../scripts/cdp/dweb-cluster-source.mjs';
import { sshArguments } from '../../scripts/cdp/dweb-cluster-ssh.mjs';
import { validateHosts, validatePaths } from '../../scripts/cdp/dweb-cluster-checks.mjs';
import { settleResponse } from '../../scripts/cdp/dweb-cluster-rpc.mjs';

const hosts = () => [1, 2].map(number => ({ machine: String(number).repeat(64), source: 'a'.repeat(64),
  platform: 'darwin', browser: 'Chrome/test', runtime: 'test-runtime' }));
const expected = { expectedSource: 'a'.repeat(64), expectedRuntime: 'test-runtime' };
const path = () => ({ did: 'peer', state: 'succeeded', bytesSent: 100, bytesReceived: 100,
  local: { address: '169.254.1.1', protocol: 'udp', type: 'host' },
  remote: { address: '169.254.1.2', protocol: 'udp', type: 'host' } });

describe('physical cluster evidence cannot silently pass a local rehearsal', () => {
  test('accepts identical source on distinct Macs with an actual UDP pair', () => {
    expect(() => validateHosts(hosts(), expected)).not.toThrow();
    expect(() => validatePaths([path()], ['peer'])).not.toThrow();
  });
  test('rejects duplicate machines even when their labels differ', () => {
    const values = hosts();
    values[1].machine = values[0].machine;
    expect(() => validateHosts(values, expected)).toThrow('different physical machines');
    expect(() => validateHosts(values, { ...expected, local: true })).not.toThrow();
  });
  test('rejects mixed source, missing identity and mixed browser versions', () => {
    for (const field of ['source', 'machine', 'browser'] as const) {
      const values = hosts();
      values[1][field] = '';
      expect(() => validateHosts(values, expected)).toThrow();
    }
    const values = hosts();
    values[1].source = 'b'.repeat(64);
    expect(() => validateHosts(values, expected)).toThrow('identical source');
    values[1] = { ...values[0], machine: '2'.repeat(64), browser: 'Chrome/other' };
    expect(() => validateHosts(values, expected)).toThrow('same browser');
  });
  test('rejects non-Mac hosts unless explicitly rehearsing', () => {
    const values = hosts();
    values[0].platform = 'linux';
    expect(() => validateHosts(values, expected)).toThrow('macOS');
    expect(() => validateHosts(values, { ...expected, local: true })).not.toThrow();
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


describe('cluster run provenance and SSH ownership', () => {
  test('identical stale source cannot certify the coordinator revision', () => {
    const values = hosts().map(host => ({ ...host, source: 'b'.repeat(64) }));
    expect(() => validateHosts(values, expected)).toThrow('coordinator source');
    expect(() => validateHosts(hosts())).toThrow('expected source');
    expect(() => validateHosts(hosts(), { ...expected, expectedRuntime: 'different' })).toThrow('Bun runtime');
  });
  test('fingerprints actual paths and bytes independent of directory creation order', () => {
    const root = mkdtempSync(join(tmpdir(), 'cluster-evidence-'));
    try {
      const stages = ['one', 'two'].map(name => join(root, name));
      for (const [index, stage] of stages.entries()) {
        mkdirSync(join(stage, 'extension'), { recursive: true });
        mkdirSync(join(stage, 'scripts/cdp'), { recursive: true });
        for (const name of index ? ['z.js', 'a.js'] : ['a.js', 'z.js']) writeFileSync(join(stage, 'extension', name), name);
        for (const name of ['dweb-cluster-node.mjs', 'dweb-cluster-page.js', 'dweb-cluster-rpc.mjs', 'dweb-cluster-source.mjs']) writeFileSync(join(stage, 'scripts/cdp', name), name);
      }
      const first = stages[0]!;
      const second = stages[1]!;
      const digest = sourceFingerprint(first);
      expect(sourceFingerprint(second)).toBe(digest);
      writeFileSync(join(second, 'extension/a.js'), 'changed');
      expect(sourceFingerprint(second)).not.toBe(digest);
      writeFileSync(join(second, 'extension/a.js'), 'a.js');
      writeFileSync(join(second, 'scripts/cdp/dweb-cluster-page.js'), 'changed fixture');
      expect(sourceFingerprint(second)).not.toBe(digest);
      expect(gitMetadata(first)).toEqual({ revision: null, dirty: null });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('dedicated SSH retains jump-host authentication without borrowing a control socket', () => {
    const args = sshArguments(['-J', 'jump-alias', '-i', '/private/key']);
    expect(args).toContain('jump-alias');
    expect(args).toContain('ControlMaster=no');
    expect(args).toContain('ControlPersist=no');
    expect(args.slice(-2)).toEqual(['-S', 'none']);
    for (const options of [['-S', '/private/socket'], ['-S/private/socket'], ['-O', 'cancel'], ['-M'], ['-o', 'ControlPath=/private/socket'], ['-oControlMaster=yes']]) {
      expect(() => sshArguments(options)).toThrow('dedicated connection');
    }
  });
});

describe('cluster CDP response dispatch', () => {
  test('rejects malformed, unknown and method-shaped IDs without consuming a request', () => {
    let calls = 0;
    const pending = new Map([[1, { settle: () => { calls++; } }]]);
    for (const message of [null, [], {}, { id: '1' }, { id: 0 }, { id: -1 },
      { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { id: 'constructor' },
      { id: '__proto__' }, { id: 2 }]) expect(settleResponse(pending, message)).toBe(false);
    expect(calls).toBe(0);
    expect(pending.size).toBe(1);
  });
  test('settles only the correlated request once, removing it before callback execution', () => {
    const seen: unknown[] = [];
    const pending = new Map<number, { settle: (message: unknown) => void }>();
    pending.set(1, { settle(message) { expect(pending.has(1)).toBe(false); seen.push(message); } });
    pending.set(2, { settle: () => { throw new Error('Wrong request'); } });
    const reply = { id: 1, result: { value: 'ok' } };
    expect(settleResponse(pending, reply)).toBe(true);
    expect(settleResponse(pending, reply)).toBe(false);
    expect(seen).toEqual([reply]);
    expect(pending.has(2)).toBe(true);
  });
});
