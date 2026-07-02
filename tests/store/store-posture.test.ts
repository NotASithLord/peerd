// Store-readiness posture guards. These lock in the Chrome Web Store
// review decisions (docs/store/OPEN-DECISIONS.md) so a later refactor
// can't silently regress them.
//
// IMPORTANT: assertions run against the STORE-CHANNEL generator output
// (packaging/gen-manifest.ts generateManifest), NOT extension/manifest.json —
// the checked-in manifest is the DEV channel, which legitimately keeps
// the test-runner WAR and a broad dev CSP. The store artifact is what
// review sees; that's the posture we pin.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateManifest } from '../../packaging/gen-manifest.ts';
import { EXTENSION_DIR } from '../../packaging/lib.ts';

const manifest = generateManifest({ channel: 'store', browser: 'chrome', version: '0.0.0' });
const preview = generateManifest({ channel: 'preview', browser: 'chrome', version: '0.0.0' });
const firefox = generateManifest({ channel: 'store', browser: 'firefox', version: '0.0.0' });

describe('store manifest posture', () => {
  test('store package ships WITHOUT debugger — initial CWS approval is not gated on CDP', () => {
    // 2026-06-13 directive: the store Chrome package is scripting-first. The
    // `debugger` permission is the single highest-risk review item, so it's
    // held out of initial submission (gen-manifest.ts STORE_STRIPPED_
    // PERMISSIONS) and re-added to a store update AFTER first approval. The
    // chrome.scripting / DOM-walk path is the default automation surface
    // there — same posture as Firefox. (Re-add = delete 'debugger' from that
    // list; this assertion then flips back to toContain, deliberately.)
    expect(manifest.permissions).not.toContain('debugger');
    expect(manifest.optional_permissions ?? []).not.toContain('debugger');
  });

  test('preview package keeps debugger REQUIRED — CDP is its default automation path', () => {
    // Where CDP ships, `debugger` is a REQUIRED install-time permission:
    // Chrome forbids it as optional ("Permission 'debugger' cannot be listed
    // as optional. This permission will be omitted."). preview + dev are the
    // channels that ship it; the user-facing off switch is the
    // advancedAutomationEnabled SETTING.
    expect(preview.permissions).toContain('debugger');
    expect(preview.optional_permissions ?? []).not.toContain('debugger');
  });

  test('no development artifacts exposed to the web', () => {
    // The test-runner WAR is dev-channel-only; nothing should be web-
    // accessible at all in the shipped manifest.
    expect(manifest.web_accessible_resources).toBeUndefined();
  });

  test('only V1-exercised host permissions are declared', () => {
    // Unused provider hosts (OpenAI/Ollama) and optional cookies/downloads
    // were dropped; <all_urls> is the only host permission.
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
  });

  test('ships the full store icon set', () => {
    for (const size of ['16', '32', '48', '128']) {
      expect(manifest.icons?.[size]).toBeTruthy();
    }
    expect(manifest.action?.default_icon?.['128']).toBeTruthy();
  });

  test('connect-src is narrowed (no blanket wss:)', () => {
    const csp = manifest.content_security_policy?.extension_pages ?? '';
    expect(csp).toContain('wss://disks.webvm.io');
    // A bare `wss:` wildcard would let extension pages connect to any
    // websocket host — exactly the flag we narrowed away.
    expect(csp).not.toMatch(/\bwss:(?!\/\/)/);
  });

  test('preview narrows connect-src too (pinned hosts only)', () => {
    const csp = preview.content_security_policy?.extension_pages ?? '';
    expect(csp).toContain('wss://disks.webvm.io');
    expect(csp).toContain('wss://bootstrap.peerd.ai');
    expect(csp).not.toMatch(/\bwss:(?!\/\/)/);
  });

  test('connect-src admits Ollama on the standard port, host-wildcard but PORT-SCOPED (issue #104)', () => {
    // The native Ollama adapter ships in the box and now supports a REMOTE
    // daemon (issue #104, e.g. a LAN box at http://192.168.1.4:11434). MV3 CSP
    // can't be set dynamically, so the host can't be pinned at build time — the
    // connect-src is a HOST wildcard on the standard Ollama port: http://*:11434.
    // The real gate stays the exact-origin EGRESS allowlist (the SW adds only the
    // user's configured host); this CSP entry is the browser-level permission.
    // The invariant pinned here: the wildcard is PORT-SCOPED (only :11434) — no
    // blanket http: and no plain-http on any other port (an HTTPS-fronted remote
    // host rides the existing `https:`).
    for (const mf of [manifest, preview]) {
      const csp = mf.content_security_policy?.extension_pages ?? '';
      expect(csp).toContain('http://*:11434');
      // Every plain-http source must be on :11434 — nothing wider slipped in.
      const httpSources = csp.match(/http:\/\/\S+/g) ?? [];
      expect(httpSources.length).toBeGreaterThan(0);
      for (const src of httpSources) expect(src).toMatch(/:11434$/);
      // No scheme-only `http:` (which would admit any http host on any port).
      expect(csp).not.toMatch(/\bhttp:(?!\/\/)/);
    }
  });

  test('firefox manifest carries no Chrome-only debugger permission', () => {
    expect(firefox.permissions ?? []).not.toContain('debugger');
    expect(firefox.optional_permissions ?? []).not.toContain('debugger');
  });

  test('firefox manifest strips Chromium-only COEP/COOP keys (AMO-clean)', () => {
    // Firefox doesn't honor these as manifest keys; left in, they're dead
    // weight an AMO validator can flag. Chrome keeps them (cross-origin
    // isolation for CheerpX) — assert that's still true.
    expect(firefox.cross_origin_embedder_policy).toBeUndefined();
    expect(firefox.cross_origin_opener_policy).toBeUndefined();
    expect(manifest.cross_origin_embedder_policy).toBeDefined();
    expect(manifest.cross_origin_opener_policy).toBeDefined();
  });
});

describe('store feature flags', () => {
  test('remote skill install is off for V1', async () => {
    const flags = await import('../../extension/shared/flags.js');
    expect(flags.REMOTE_SKILL_INSTALL).toBe(false);
  });
  // DESIGN-17: the actor model is UNCONDITIONAL — the source flags were removed
  // (the branch was the flag; it landed wholesale). flags.js carries no actor
  // flag to assert; the model is exercised by exposure/actor-messaging/actor-
  // prompt tests. NOTE: the web-actor page path still needs live CDP verification
  // before store ship. Pin that no actor flag lingers so a re-introduction is a
  // conscious, test-visible decision.
  test('no actor feature flags linger (model is unconditional)', async () => {
    const flags = await import('../../extension/shared/flags.js');
    expect('ACTOR_TAB_AGENTS' in flags).toBe(false);
    expect('WEB_ACTOR' in flags).toBe(false);
  });
});

describe('store prompt posture — no dweb/dwapp in the store system prompt', () => {
  // The store-rendered system prompt must carry ZERO dweb/dwapp content. Three
  // layers already enforce it: DWEB_ENABLED=false collapses {{DWEB_BLOCK}} to ''
  // (system-prompt.js), the dweb fragment asset is pruned (package.ts PRUNE_STORE),
  // and the dweb tool descriptions are filtered from the agent (filterByDwebEnabled).
  // The one remaining way a leak could happen: hardcoded dweb prose in the
  // always-shipped BASE template. This guard forbids it — strip the gated
  // placeholder, and nothing dweb/dwapp may remain.
  const baseTemplate = readFileSync(join(EXTENSION_DIR, 'peerd-provider', 'system-prompt.txt'), 'utf8');

  test('the base template references the dweb ONLY through the gated {{DWEB_BLOCK}} placeholder', () => {
    const withoutGatedBlock = baseTemplate.replace(/\{\{DWEB_BLOCK\}\}/g, '');
    expect(/dweb|dwapp/i.test(withoutGatedBlock)).toBe(false);
  });

  test('the gated block IS present (so the dweb content is injected, not inlined)', () => {
    // If the placeholder ever disappears, dweb content would either be lost on
    // preview or inlined into the base (which the guard above would then catch).
    expect(baseTemplate).toContain('{{DWEB_BLOCK}}');
  });

  test('package.ts prunes the dweb prompt fragment from store artifacts', () => {
    const pkg = readFileSync(join(EXTENSION_DIR, '..', 'packaging', 'package.ts'), 'utf8');
    expect(pkg).toContain('peerd-provider/system-prompt-dweb.txt');
  });
});
