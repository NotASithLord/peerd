// Manifest generator — produces the final manifest.json for a
// (channel, browser) pair from manifests/base.json + the channel's
// patch document. See PACKAGING.md §"Manifest variants".
//
// Channels:
//   store    → "peerd"          (Chrome Web Store / AMO; no dweb)
//   preview  → "peerd preview"  (GitHub Releases; dweb enabled,
//                                update_url + locked extension ID)
//   dev      → "peerd (dev)"    (the checked-in extension/manifest.json
//                                for the load-unpacked dev loop; includes
//                                the in-browser test runner)
//
// The version is injected from package.json — never hand-edit it in a
// manifest. The Chrome preview `key` (which locks the extension ID so
// installs survive across releases) is read from
// manifests/preview-chrome-key.pub — that file holds the PUBLIC key and
// is committed; the private key.pem is gitignored and lives offline +
// in CI secrets.
//
// CLI:
//   bun packaging/gen-manifest.ts --channel=preview --browser=chrome [--out=path]
//   bun run gen:dev           # regenerates extension/manifest.json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  MANIFESTS_DIR, EXTENSION_DIR,
  readJson, readVersion, deepMerge, parseArgs, fileExists,
} from './lib.ts';

type GenChannel = 'store' | 'preview' | 'dev';
type GenBrowser = 'chrome' | 'firefox';

const PREVIEW_PUBKEY_FILE = join(MANIFESTS_DIR, 'preview-chrome-key.pub');

// Keys Chrome doesn't know (would log warnings on load) get stripped from
// chromium manifests; keys Chrome owns get stripped from Firefox ones.
const FIREFOX_ONLY_KEYS = ['browser_specific_settings', 'sidebar_action'];
const CHROME_ONLY_KEYS = ['update_url', 'key', 'side_panel', 'sandbox'];

// Permissions Firefox doesn't implement. Stripping them keeps AMO
// validation clean; Firefox runtime parity is its own workstream — the
// packaging system's job is only to emit a structurally valid manifest.
const CHROME_ONLY_PERMISSIONS = ['sidePanel', 'offscreen', 'debugger', 'tabGroups'];

// Permissions held OUT of the store channel for initial submission. why:
// `debugger` (the CDP path) is the single highest-risk Chrome Web Store
// review item — reviewers treat it as reserved for dev-tools extensions
// (docs/store/OPEN-DECISIONS.md). So the initial store package ships WITHOUT
// it and the chrome.scripting / DOM-walk path is the default automation
// surface there (exactly the Firefox posture); preview + dev keep it as the
// default. CDP is re-added to a store UPDATE after the first approval — a
// one-line flip: delete 'debugger' from this list. Keeping it in base.json
// (not moving it into patches) means base stays the single list of every
// permission peerd can use, and deepMerge — which REPLACES arrays wholesale
// (packaging/lib.ts), so a patch cannot subtract — never has to re-enumerate.
// Exported so verify-store-artifact.ts can assert the shipped zip honors it.
export const STORE_STRIPPED_PERMISSIONS = ['debugger'];

const applyBrowserTransform = (manifest: any, browser: GenBrowser): any => {
  const out = { ...manifest };
  if (browser === 'chrome') {
    for (const k of FIREFOX_ONLY_KEYS) delete out[k];
  } else {
    for (const k of CHROME_ONLY_KEYS) delete out[k];
    out.permissions = (out.permissions ?? []).filter(
      (p: string) => !CHROME_ONLY_PERMISSIONS.includes(p),
    );
    // Defensive: also strip these from optional_permissions if a future
    // patch ever adds the key. NOTE: peerd does NOT use optional_permissions
    // for `debugger` — Chrome forbids it ("Permission 'debugger' cannot be
    // listed as optional. This permission will be omitted."), so `debugger`
    // is a REQUIRED install-time permission in the channels that ship it
    // (preview/dev), stripped per-channel from store (STORE_STRIPPED_
    // PERMISSIONS) and per-browser from Firefox (here). This branch is a
    // no-op today; it exists only so the Firefox transform stays correct if
    // optional_permissions is introduced later.
    if (out.optional_permissions) {
      out.optional_permissions = out.optional_permissions.filter(
        (p: string) => !CHROME_ONLY_PERMISSIONS.includes(p),
      );
      if (out.optional_permissions.length === 0) delete out.optional_permissions;
    }
    // Firefox MV3 has no background.service_worker — it runs an event
    // page from background.scripts instead. Same entry module.
    if (out.background?.service_worker) {
      out.background = {
        scripts: [out.background.service_worker],
        type: out.background.type ?? 'module',
      };
    }
    // The side panel becomes a Firefox sidebar; same HTML entry.
    if (manifest.side_panel?.default_path) {
      out.sidebar_action = {
        default_panel: manifest.side_panel.default_path,
        default_title: out.name,
      };
    }
    // AMO requires a data-collection declaration for all new Firefox
    // submissions (web-ext MISSING_DATA_COLLECTION_PERMISSIONS). peerd's
    // honest answer is "none": no backend, no telemetry, no account —
    // the agent talks only to the user's own model API. Centralized here
    // (not per channel patch) because it's true of every channel by
    // construction.
    if (out.browser_specific_settings?.gecko
        && !out.browser_specific_settings.gecko.data_collection_permissions) {
      out.browser_specific_settings = {
        ...out.browser_specific_settings,
        gecko: {
          ...out.browser_specific_settings.gecko,
          data_collection_permissions: { required: ['none'] },
        },
      };
    }
  }
  return out;
};

// Emit keys in a stable, conventional order so generated manifests diff
// cleanly. Unlisted keys keep their merge order after the listed ones.
const KEY_ORDER = [
  'manifest_version', 'name', 'version', 'description', 'update_url', 'key',
  'browser_specific_settings', 'side_panel', 'sidebar_action', 'options_ui',
  'background',
  'permissions', 'optional_permissions', 'host_permissions',
  'content_security_policy', 'sandbox',
  'cross_origin_embedder_policy', 'cross_origin_opener_policy',
  'action', 'commands', 'web_accessible_resources',
];
const orderKeys = (manifest: Record<string, any>): Record<string, any> => {
  const out: Record<string, any> = {};
  for (const k of KEY_ORDER) if (k in manifest) out[k] = manifest[k];
  for (const k of Object.keys(manifest)) if (!(k in out)) out[k] = manifest[k];
  return out;
};

export const generateManifest = (
  { channel, browser, version }: { channel: GenChannel; browser: GenBrowser; version: string },
): Record<string, any> => {
  const base = readJson(join(MANIFESTS_DIR, 'base.json'));
  const patch = readJson(join(MANIFESTS_DIR, `${channel}.patch.json`));
  let manifest = deepMerge(base, patch);
  manifest.version = version;
  manifest = applyBrowserTransform(manifest, browser);

  // Channel strip: hold `debugger` out of the store package for initial
  // submission (see STORE_STRIPPED_PERMISSIONS). Applied after the browser
  // transform so store/firefox — already debugger-free — is unaffected, and
  // store/chrome loses it here. preview/dev keep it. Runtime is fail-safe:
  // with the permission absent, globalThis.chrome.debugger is undefined, so
  // advancedAutomationOn() is false and the runner uses the DOM-walk path.
  if (channel === 'store' && Array.isArray(manifest.permissions)) {
    manifest.permissions = manifest.permissions.filter(
      (p: string) => !STORE_STRIPPED_PERMISSIONS.includes(p),
    );
  }

  if (channel === 'preview' && browser === 'chrome') {
    if (fileExists(PREVIEW_PUBKEY_FILE)) {
      manifest.key = readFileSync(PREVIEW_PUBKEY_FILE, 'utf8').trim();
    } else {
      // Packaging still succeeds (useful before the key exists / on a fresh
      // clone) but the artifact won't keep a stable extension ID — say so.
      console.warn(
        `WARN gen-manifest: ${PREVIEW_PUBKEY_FILE} not found — preview chrome `
        + 'manifest has no "key"; the unpacked extension ID will not be stable.',
      );
    }
  }

  return orderKeys(manifest);
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  const channel = String(args.channel ?? 'dev') as GenChannel;
  const browser = String(args.browser ?? 'chrome') as GenBrowser;
  if (!['store', 'preview', 'dev'].includes(channel)) throw new Error(`bad --channel=${channel}`);
  if (!['chrome', 'firefox'].includes(browser)) throw new Error(`bad --browser=${browser}`);

  const manifest = generateManifest({ channel, browser, version: readVersion() });
  const json = JSON.stringify(manifest, null, 2) + '\n';

  // The checked-in dev manifest (extension/manifest.json, the load-unpacked
  // dev loop) is CHROME — that's the only browser anyone load-unpacks from
  // extension/. Auto-target it ONLY for dev/chrome; `--channel=dev
  // --browser=firefox` without an explicit --out must NOT clobber it with the
  // Firefox transform (background.scripts + sidebar_action, which Chrome then
  // rejects). It goes to stdout instead, same as store/preview.
  const out = args.out
    ? String(args.out)
    : (channel === 'dev' && browser === 'chrome') ? join(EXTENSION_DIR, 'manifest.json') : null;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json);
    console.log(`wrote ${out} (${channel}/${browser} v${manifest.version})`);
  } else {
    process.stdout.write(json);
  }
};

if (import.meta.main) main();
