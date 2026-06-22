// Bun test setup.
//
// Stubs Web APIs the extension modules touch but Bun's Node-like
// runtime doesn't ship: a minimal in-memory chrome.storage.local, a
// no-op indexedDB delete, and a tiny `browser` polyfill for modules
// that import the webextension-polyfill (we only need the surface our
// tests exercise — list/get/sendMessage). Add more as tests require.

import { mock } from 'bun:test';
import { plugin } from 'bun';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Leading-slash import resolution.
//
// Extension modules use the browser's root-relative import form
// (`import { escapeAttr } from '/shared/util.js'`), which the runtime
// resolves against the extension root — the unpacked extension's
// top-level directory. Bun, however, reads a leading `/` as a
// filesystem-absolute path and can't find the module. The extension
// runs with NO build step, so we can't rewrite these specifiers at the
// source; instead we teach Bun's test resolver the same mapping the
// browser uses: `/<x>` -> `<repo>/extension/<x>`.
//
// This keeps every extension module importable from tests/ regardless
// of whether its transitive import graph touches leading-slash
// specifiers — removing the need for dependency-light duplicates kept
// in sync by hand (see tests/.../wrap-parity, prompt-wrap).
const extensionRoot = join(import.meta.dir, '..', 'extension');
plugin({
  name: 'peerd-leading-slash',
  setup(build) {
    // Intercept only specifiers that map to a real file under
    // extension/. Genuine filesystem-absolute paths (or typos) return
    // undefined and fall through to Bun's default resolver.
    build.onResolve({ filter: /^\// }, (args) => {
      const candidate = join(extensionRoot, args.path.slice(1));
      return existsSync(candidate) ? { path: candidate } : undefined;
    });
  },
});

// fake-indexeddb gives us a real in-memory IDB so app-store.ts (which
// uses standard IDB) can be tested without a browser. Pulled in
// lazily so tests that don't touch IDB don't pay the import cost.
let fakeIDB: any = null;
export const useFakeIndexedDB = async () => {
  if (!fakeIDB) {
    fakeIDB = await import('fake-indexeddb');
    globalThis.indexedDB = fakeIDB.indexedDB;
    globalThis.IDBKeyRange = fakeIDB.IDBKeyRange;
  }
};

// Simple in-memory chrome.storage.local shim. Tests that need it
// create one explicitly via `createStorageStub()`.
export const createStorageStub = () => {
  const store = new Map<string, unknown>();
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    snapshot: () => Object.fromEntries(store),
  };
};
