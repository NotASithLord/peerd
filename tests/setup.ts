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
import { join, sep } from 'node:path';

// The production cold-path adapter intentionally binds only to the browser's
// native WebExtension object; it must never pull the compatibility polyfill
// into a service-worker or offscreen graph. Give Bun the smallest equivalent
// identity during module evaluation. Individual tests replace or extend this
// object when they exercise an API; the default is deliberately nonfunctional
// beyond URL identity so an accidental browser call still fails visibly.
if (!(globalThis as any).browser && !(globalThis as any).chrome) {
  (globalThis as any).chrome = {
    runtime: {
      id: 'peerd-bun-test',
      getURL: (path: string) => `chrome-extension://peerd-bun-test/${path.replace(/^\/+/, '')}`,
    },
    // Some public background surfaces construct the lazy storage adapter
    // after another test has already caused browser-api.js to capture this
    // object. Expose the namespace, but no callable storage methods: an
    // accidental read or write still fails visibly.
    storage: { local: {} },
  };
}

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
// why process.cwd(), not import.meta.dir: Bun's transpiler cache can preserve
// the latter from a disposable worktree and resolve root-relative extension
// imports into a directory that no longer exists. Test commands are rooted at
// the repository, so the live working directory is the stable source of truth.
const extensionRoot = join(process.cwd(), 'extension');
plugin({
  name: 'peerd-leading-slash',
  setup(build) {
    // Intercept only specifiers that map to a real file under
    // extension/. Genuine filesystem-absolute paths (or typos) return
    // undefined and fall through to Bun's default resolver.
    build.onResolve({ filter: /^\// }, (args) => {
      // why the extension marker: Bun can cache the resolved absolute form of
      // a root-relative import from a disposable worktree. Recover only the
      // extension-local suffix, so a deleted measurement directory cannot
      // poison later test runs while unrelated absolute paths still fall
      // through untouched.
      const marker = `${sep}extension${sep}`;
      const markerAt = args.path.lastIndexOf(marker);
      const relativePath = markerAt >= 0
        ? args.path.slice(markerAt + marker.length)
        : args.path.slice(1);
      const candidate = join(extensionRoot, relativePath);
      return existsSync(candidate) ? { path: candidate } : undefined;
    });
  },
});

// fake-indexeddb gives direct-IDB owners a real in-memory database. It loads
// lazily so tests that do not touch IDB do not pay the import cost.
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
