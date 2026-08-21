import { beforeAll, describe, expect, test } from 'bun:test';
import {
  createKernelCommandReader,
} from '../../extension/background/kernel-command-reader.js';
import { makeKernelComposerRoutes } from '../../extension/background/kernel-composer-routes.js';
import { disarmText as richDisarmText } from '../../extension/peerd-runtime/dom/cdr.js';
import { disarmText as leafDisarmText } from '../../extension/shared/disarm-text.js';
import { useFakeIndexedDB } from '../setup.ts';

beforeAll(async () => { await useFakeIndexedDB(); });

const seedSkills = async (dbName: string, rows: any[]) => new Promise<void>((resolve, reject) => {
  const request = indexedDB.open(dbName, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('meta', { keyPath: 'id' });
    request.result.createObjectStore('bodies', { keyPath: 'id' });
  };
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    const transaction = db.transaction('meta', 'readwrite');
    for (const row of rows) transaction.objectStore('meta').put(row);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => reject(transaction.error);
  };
});

describe('native kernel command metadata reader', () => {
  test('small cold scrubber remains byte-identical to the rich CDR text pass', () => {
    for (const value of [
      undefined, '', 'plain text', 'zero\u200Bwidth', '\u202Eevil',
      '👩🏻\u200D💻', 'a\u200Db', 'می\u200Cروم', 'a\u200Cb',
      '❤\uFE0F', 'x\uFE0F', 'tag\u{E0065}\u{E007F}', 'a\u0000b\n',
    ]) expect(leafDisarmText(value)).toBe(richDisarmText(value));
  });

  test('construction performs no storage work and list never reads command or skill bodies', async () => {
    const calls: string[] = [];
    const reader = createKernelCommandReader({
      kv: {
        list: async (prefix: string) => {
          calls.push(`kv:${prefix}`);
          return {
            'peerd.commands.local': {
              name: 'local', body: 'secret local body', description: 'local command',
            },
          };
        },
      },
      idbFactory: {
        open: () => { calls.push('idb:open'); throw new Error('skills unavailable'); },
      } as any,
    });
    expect(calls).toEqual([]);
    await expect(reader.list()).resolves.toEqual([
      { name: 'local', description: 'local command' },
    ]);
    expect(calls).toEqual(['kv:peerd.commands.', 'idb:open']);
  });

  test('merges enabled skill metadata after local commands with exact shadowing and sorting', async () => {
    const dbName = `kernel-commands-${crypto.randomUUID()}`;
    await seedSkills(dbName, [
      { id: 'zeta', name: 'zeta', description: '  skill\ncommand  ', enabled: true },
      { id: 'shadow', name: 'shadow', description: 'skill loses', enabled: true },
      { id: 'off', name: 'off', description: 'disabled', enabled: false },
      { id: 'hidden', name: 'hidden', description: 'safe\u202Etxt', enabled: true },
    ]);
    const reader = createKernelCommandReader({
      skillsDbName: dbName,
      kv: { list: async () => ({
        one: { name: 'shadow', body: 'not returned', description: 'local wins' },
        two: { name: 'alpha', body: 'not returned' },
      }) },
    });
    await expect(reader.list()).resolves.toEqual([
      { name: 'alpha', description: '' },
      { name: 'hidden', description: 'safetxt' },
      { name: 'shadow', description: 'local wins' },
      { name: 'zeta', description: 'skill command' },
    ]);
    const routes = makeKernelComposerRoutes({
      browser: { tabs: { query: async () => [] } },
      kv: { list: async () => ({}) },
      idb: { get: async () => null },
      sessionCache: { sessionGet: async () => null },
      vault: { isLocked: () => false },
      denylist: {
        ready: async () => ({ ok: true }), blocks: () => false, patterns: () => [],
        snapshot: async () => ({ ok: true, patterns: [] }),
      },
      commands: reader,
      appFiles: { list: async () => [] },
    });
    await expect(routes['commands/list']()).resolves.toEqual({
      ok: true,
      commands: [
        { name: 'alpha', description: '' },
        { name: 'hidden', description: 'safetxt' },
        { name: 'shadow', description: 'local wins' },
        { name: 'zeta', description: 'skill command' },
      ],
    });
  });

  test('one failed source does not blank the other source', async () => {
    const dbName = `kernel-commands-${crypto.randomUUID()}`;
    await seedSkills(dbName, [
      { id: 'skill', name: 'skill', description: 'available', enabled: true },
    ]);
    const reader = createKernelCommandReader({
      skillsDbName: dbName,
      kv: { list: async () => { throw new Error('local store unavailable'); } },
    });
    await expect(reader.list()).resolves.toEqual([
      { name: 'skill', description: 'available' },
    ]);
  });
});
