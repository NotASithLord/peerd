import { expect, test } from 'bun:test';
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createScaleNetLog, NETLOG_BYTES, projectNetLog, readNetlog } from '../../scripts/cdp/native-scale-netlog.mjs';

const fixture = (events: object[]) => ({ constants: { logEventTypes: { TCP_CONNECT: 1, WEBSOCKET_ALIVE: 2, SECRET_URL: 3 },
  logSourceType: { SOCKET: 1 }, logEventPhase: { PHASE_BEGIN: 1 } }, events });
const event = (id: number) => ({ type: 1, phase: 1, time: String(id), source: { id, type: 1 }, params: { net_error: -7 } });
const rawPath = (owner: ReturnType<typeof createScaleNetLog>) => owner.args[0]!.slice('--log-net-log='.length);

test('NetLog projection keeps only fixed enums and numeric diagnostics', () => {
  const output = projectNetLog(fixture([{ ...event(1), params: { net_error: -7, os_error: -2, elapsed: 12, timeout: 200,
    url: 'secret', headers: ['cookie: private'], source_dependency: { id: 4, type: 1, secret: 'hidden' } } },
  { ...event(2), type: 3 }, { ...event(3), time: 'secret', source: { id: 'private', type: 'secret' }, params: { net_error: 'private', attempts: Infinity } }]));
  expect(output.available).toBe(true);
  expect(output.endpointCorrelation).toBe('unavailable');
  expect(output.clock).toBe('chrome-monotonic-ms');
  expect(output.events).toHaveLength(2);
  expect(output.events[0]).toEqual({ type: 'TCP_CONNECT', phase: 'PHASE_BEGIN', time: 1, source: { id: 1, type: 'SOCKET' },
    params: { net_error: -7, os_error: -2, elapsed: 12, timeout: 200, source_dependency: { id: 4, type: 'SOCKET' } } });
  expect(JSON.stringify(output)).not.toMatch(/secret|private|hidden|cookie|headers/);
  expect(output.firstErrors).toHaveLength(1);
});
test('NetLog retains the last event window and first failures independently', () => {
  const output = projectNetLog(fixture(Array.from({ length: 2100 }, (_, index) => event(index))));
  expect(output.events).toHaveLength(2048);
  expect(output.events[0]?.source.id).toBe(52);
  expect(output.events.at(-1)?.source.id).toBe(2099);
  expect(output.dropped).toBe(52);
  expect(output.firstErrors).toHaveLength(16);
  expect(output.firstErrors[0]?.source.id).toBe(0);
  expect(output.firstErrors.at(-1)?.source.id).toBe(15);
});
test('NetLog rejects malformed and excessive event collections', () => {
  expect(projectNetLog(null).available).toBe(false);
  expect(projectNetLog({ events: [] })).toMatchObject({ available: false, reason: 'invalid-constants' });
  expect(projectNetLog(fixture([{ ...event(1), time: '99999999999999999999' }])).events[0]?.time).toBeUndefined();
  expect(projectNetLog({ events: {} }).available).toBe(false);
  expect(projectNetLog(fixture(Array(100001).fill({}))).available).toBe(false);
});
test('private raw file is projected once and removed before reporting', () => {
  const recorded: object[] = [];
  const owner = createScaleNetLog(value => recorded.push(value));
  const path = rawPath(owner);
  expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  expect(owner.args.slice(1)).toEqual(['--net-log-capture-mode=HeavilyRedacted', '--net-log-max-size-mb=8', '--net-log-duration=600']);
  writeFileSync(path, JSON.stringify(fixture([event(1)])));
  const first = owner.finish();
  expect(first.available).toBe(true);
  expect(first.rawCleanup).toBe('complete');
  expect(existsSync(dirname(path))).toBe(false);
  expect(owner.finish()).toEqual(first);
  expect(recorded).toHaveLength(2);
});
test('raw removal retries independently of memoized projection and failed consumers', () => {
  let attempts = 0;
  const owner = createScaleNetLog(() => { throw new Error('consumer'); }, (path, options) => {
    attempts++; if (attempts === 1) throw new Error('temporary'); rmSync(path, options);
  });
  const path = rawPath(owner);
  try {
    writeFileSync(path, JSON.stringify(fixture([event(1)])));
    const first = owner.finish();
    expect(first.available).toBe(true); expect(first.rawCleanup).toBe('failed'); expect(first.removalFailures).toBe(1);
    writeFileSync(path, 'not valid JSON');
    const retried = owner.discard();
    expect(retried.available).toBe(true); expect(retried.rawCleanup).toBe('complete');
    expect(retried.removalFailures).toBe(1); expect(attempts).toBe(2);
    expect(existsSync(dirname(path))).toBe(false);
    owner.discard(); expect(attempts).toBe(2);
  } finally { rmSync(dirname(path), { recursive: true, force: true }); }
});
test('bounded reader checks initial stat and detects a growing raw file with one extra byte', () => {
  let reads = 0, closes = 0, requested = 0;
  const io = { openSync: () => 8, fstatSync: () => ({ size: NETLOG_BYTES + 1, isFile: () => true }),
    readSync: (_fd: number, buffer: Buffer, offset: number, length: number) => { reads++; requested += length; buffer.fill(32, offset, offset + length); return length; },
    closeSync: () => { closes++; } };
  expect(readNetlog('unused', io).available).toBe(false);
  expect(reads).toBe(0); expect(closes).toBe(1);
  io.fstatSync = () => ({ size: 0, isFile: () => false });
  expect(readNetlog('unused', io)).toMatchObject({ reason: 'not-file' }); expect(reads).toBe(0);
  io.fstatSync = () => ({ size: 0, isFile: () => true });
  expect(readNetlog('unused', io).available).toBe(false);
  expect(reads).toBe(1); expect(requested).toBe(NETLOG_BYTES + 1); expect(closes).toBe(3);
});
test('incomplete or absent raw output stays unavailable and is still deleted', () => {
  const owner = createScaleNetLog();
  const path = rawPath(owner);
  writeFileSync(path, '{"events":[');
  expect(owner.finish().available).toBe(false);
  expect(existsSync(dirname(path))).toBe(false);
  const absent = createScaleNetLog();
  expect(absent.finish().available).toBe(false);
  expect(existsSync(dirname(rawPath(absent)))).toBe(false);
});
