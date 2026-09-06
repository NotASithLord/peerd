import { describe, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import { cleanupRetiredDatabases } from '../../extension/peerd-egress/storage/idb.js';

const RETIRED = ['peerd-toolbox', 'peerd-run-cache', 'peerd-checkpoints'];
const LIVE = [
  'peerd',
  'peerd-skills',
  'peerd-site-clients',
  'peerd-result-spills',
  'peerd-pdf',
  'peerd-voice',
  'peerd-vm-overlay',
  'peerd-app-bodies',
];

const seed = (factory: IDBFactory, name: string) => new Promise<void>((resolve, reject) => {
  const request = factory.open(name, 1);
  request.onupgradeneeded = () => request.result.createObjectStore('marker');
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    const transaction = db.transaction('marker', 'readwrite');
    transaction.objectStore('marker').put(`kept:${name}`, 'value');
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => { db.close(); resolve(); };
  };
});

const readMarker = (factory: IDBFactory, name: string) =>
  new Promise<string | undefined>((resolve, reject) => {
    const request = factory.open(name);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('marker', 'readonly');
      const marker = transaction.objectStore('marker').get('value');
      marker.onerror = () => reject(marker.error);
      marker.onsuccess = () => { db.close(); resolve(marker.result); };
    };
  });

describe('retired standalone database cleanup', () => {
  test('deletes only removed product stores and preserves live databases', async () => {
    const factory = new IDBFactory();
    await Promise.all([...RETIRED, ...LIVE].map((name) => seed(factory, name)));

    await cleanupRetiredDatabases(factory);

    const remaining = new Set((await factory.databases()).map(({ name }) => name));
    for (const name of RETIRED) expect(remaining.has(name), name).toBe(false);
    for (const name of LIVE) {
      expect(remaining.has(name), name).toBe(true);
      expect(await readMarker(factory, name), name).toBe(`kept:${name}`);
    }
  });

  test('is an idempotent no-op when the retired stores are already absent', async () => {
    const factory = new IDBFactory();
    await seed(factory, 'peerd');
    await expect(cleanupRetiredDatabases(factory)).resolves.toBeUndefined();
    await expect(cleanupRetiredDatabases(factory)).resolves.toBeUndefined();
    expect(await readMarker(factory, 'peerd')).toBe('kept:peerd');
  });
});
