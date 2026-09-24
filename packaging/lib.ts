// Shared helpers for the build scripts (packaging/*.ts, run with Bun).
//
// These scripts are PACKAGING TOOLING — they run in Bun on a dev machine or
// CI, never inside the extension. The extension source stays vanilla JS with
// no development build step. Release packaging generates policy files, prunes
// the tree, compacts authored cold-path modules in staging, and zips it. The
// authoritative flow lives in packaging/package.ts and packaging/preflight.ts.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const EXTENSION_DIR = join(REPO_ROOT, 'extension');
export const MANIFESTS_DIR = join(REPO_ROOT, 'manifests');
export const ARTIFACTS_DIR = join(REPO_ROOT, 'artifacts');

export const CHANNELS = ['store', 'preview'] as const;
export const BROWSERS = ['chrome', 'firefox'] as const;
export type Channel = (typeof CHANNELS)[number];
export type Browser = (typeof BROWSERS)[number];

// Channel-config FLAVORS: the two artifact channels plus 'web' (the staged
// library tree built by packaging/package-web.ts). Deliberately separate from
// CHANNELS so the extension artifact matrix (channel × browser) never loops
// over web — the web target is a staged tree, not a zip, and has no
// browser/signing axis.
export const CONFIG_CHANNELS = ['store', 'preview', 'web'] as const;
export type ConfigChannel = (typeof CONFIG_CHANNELS)[number];

// Committed swap templates (house discipline: swapped files are wholesale
// committed-file replacements, never text transforms). Hoisted here so the
// extension and web pipelines cannot drift on which file is "the" template.
export const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'templates');
export const STORE_LOADER_TEMPLATE = join(TEMPLATES_DIR, 'dweb-loader.store.js');
export const DWEB_ROUTES_DISABLED_TEMPLATE = join(TEMPLATES_DIR, 'routes-dweb.disabled.js');
export const DWEB_SELF_ROUTES_DISABLED_TEMPLATE = join(TEMPLATES_DIR, 'routes-dweb-self.disabled.js');
export const DEBUGGER_UNAVAILABLE_TEMPLATE = join(TEMPLATES_DIR, 'debugger-pool.unavailable.js');
export const STORE_ACTOR_WORKER_TEMPLATE = join(TEMPLATES_DIR, 'actor-worker.store.js');
export const STORE_OPTIONS_APP_TEMPLATE = join(TEMPLATES_DIR, 'options-app.store.js');
export const STORE_SEMANTIC_HOST_TEMPLATE = join(TEMPLATES_DIR, 'semantic-route-host.store.js');

/** The version single source of truth is package.json. Never hand-edit
 *  versions in manifests — they are generated. */
export const readVersion = (): string => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    throw new Error(`package.json version "${pkg.version}" is not plain semver (X.Y.Z)`);
  }
  return pkg.version;
};

export const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));

/**
 * Deep-merge for manifest patch documents. Deliberately simple semantics
 * (anti-recommendation in the spec: no clever patch DSL):
 *   - plain objects merge recursively
 *   - arrays and scalars REPLACE the base value wholesale
 * If a channel needs a key the other doesn't, the key lives only in that
 * channel's patch — there is no delete operator.
 */
export const deepMerge = (base: any, patch: any): any => {
  if (
    base !== null && patch !== null
    && typeof base === 'object' && typeof patch === 'object'
    && !Array.isArray(base) && !Array.isArray(patch)
  ) {
    const out: Record<string, any> = { ...base };
    for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base[k], v);
    return out;
  }
  return patch === undefined ? base : patch;
};

/** Parse --key=value args into a map; flags without '=' become true. */
export const parseArgs = (argv: string[]): Record<string, string | boolean> => {
  const out: Record<string, string | boolean> = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
};

export const fileExists = (path: string): boolean => existsSync(path);
