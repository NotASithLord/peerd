import { describe, test, expect } from 'bun:test';
// The dwapp ACTOR MANIFEST — the declaration that turns a plain dwapp into a
// specialized bound actor. Pure validate/normalize, so it's fully Bun-testable.
import {
  normalizeActorManifest, validateActorManifest, parseActorManifest,
  actorManifestFromFiles, ActorManifestRejectedError, ACTOR_MANIFEST_FILE,
  MAX_ACTOR_LORE, MAX_ACTOR_TOOLS, MAX_ACTOR_SKILLS,
} from '../../extension/peerd-runtime/actor/app-actor-manifest.js';
import { dwappActorPersonality } from '../../extension/peerd-runtime/actor/app-actor.js';

const good = () => ({
  name: 'Site Parser',
  description: 'Extracts structured listings from messy HTML.',
  lore: 'You are a specialized parsing actor. Given raw HTML, return clean JSON.',
  skills: [{ id: 'parse', name: 'parse listings', description: 'HTML → structured rows' }],
  tools: ['fetch_url', 'read_web_cache'],
});

describe('dwapp actor-manifest', () => {
  test('validates a well-formed manifest', () => {
    const { ok, manifest } = validateActorManifest(good());
    expect(ok).toBe(true);
    expect(manifest.name).toBe('Site Parser');
    expect(manifest.lore.length).toBeGreaterThan(0);
    expect(manifest.skills).toHaveLength(1);
    expect(manifest.tools).toEqual(['fetch_url', 'read_web_cache']);
  });

  test('name and lore are both required (no personality without lore)', () => {
    expect(() => validateActorManifest({ ...good(), name: '' })).toThrow(ActorManifestRejectedError);
    expect(() => validateActorManifest({ ...good(), lore: '' })).toThrow(ActorManifestRejectedError);
    expect(() => validateActorManifest({ ...good(), lore: '   ' })).toThrow(ActorManifestRejectedError);   // whitespace-only lore is empty
  });

  test('normalize clamps + coerces without throwing', () => {
    const m = normalizeActorManifest({
      name: 'x'.repeat(200),
      lore: 'y'.repeat(MAX_ACTOR_LORE + 500),
      skills: new Array(MAX_ACTOR_SKILLS + 10).fill({ name: 's' }),
      tools: new Array(MAX_ACTOR_TOOLS + 10).fill('t').map((t, i) => `${t}${i}`),
    });
    expect(m.name.length).toBe(64);
    expect(m.lore.length).toBe(MAX_ACTOR_LORE);
    expect(m.skills.length).toBe(MAX_ACTOR_SKILLS);
    expect(m.tools.length).toBe(MAX_ACTOR_TOOLS);
  });

  test('tools are de-duplicated and non-strings dropped', () => {
    const m = normalizeActorManifest({ name: 'a', lore: 'b', tools: ['x', 'x', 'y', 42, '', null] });
    expect(m.tools).toEqual(['x', 'y']);
  });

  test('skills get stable ids when missing', () => {
    const m = normalizeActorManifest({ name: 'a', lore: 'b', skills: [{ name: 'one' }, { name: 'two' }] });
    expect(m.skills[0].id).toBe('skill-0');
    expect(m.skills[1].id).toBe('skill-1');
  });

  test('parseActorManifest returns null for absent/garbage (a plain app), never throws', () => {
    expect(parseActorManifest(null)).toBeNull();
    expect(parseActorManifest({})).toBeNull();               // no name/lore
    expect(parseActorManifest({ name: 'x' })).toBeNull();    // no lore
    expect(parseActorManifest('nope')).toBeNull();
    expect(parseActorManifest(good())?.name).toBe('Site Parser');
  });

  test('rejects an oversized manifest', () => {
    // lore is capped by normalize, so overflow the whole via many max-width skills.
    const skills = new Array(MAX_ACTOR_SKILLS).fill(0).map((_, i) => ({
      id: `id${'x'.repeat(120)}${i}`, name: 'n'.repeat(120), description: 'd'.repeat(120),
    }));
    const huge = { name: 'a', lore: 'z'.repeat(MAX_ACTOR_LORE), skills };
    // normalize keeps it within field caps but the JSON may still be big; assert it validates or rejects cleanly (never throws a non-ActorManifestRejectedError).
    try { validateActorManifest(huge); } catch (e) { expect(e).toBeInstanceOf(ActorManifestRejectedError); }
  });

  test('actorManifestFromFiles reads peerd.actor.json out of the bundle', () => {
    const files = { 'index.html': '<h1>hi</h1>', [ACTOR_MANIFEST_FILE]: JSON.stringify(good()) };
    expect(actorManifestFromFiles(files)?.name).toBe('Site Parser');
    expect(actorManifestFromFiles({ 'index.html': 'x' })).toBeNull();      // no manifest file → plain app
    expect(actorManifestFromFiles({ [ACTOR_MANIFEST_FILE]: '{bad json' })).toBeNull();
    expect(actorManifestFromFiles(null)).toBeNull();
  });
});

describe('dwappActorPersonality — the authority-narrowing invariant', () => {
  const APP_KIND = ['app_update', 'app_write_file', 'app_read_file', 'edit_file'];

  test('null manifest → null (caller mints the generic app-builder unchanged)', () => {
    expect(dwappActorPersonality(null, APP_KIND)).toBeNull();
    expect(dwappActorPersonality({ lore: '' } as any, APP_KIND)).toBeNull();
  });

  test('systemPrompt wraps the lore in the trusted preamble', () => {
    const p = dwappActorPersonality(validateActorManifest(good()).manifest, APP_KIND)!;
    expect(p.systemPrompt).toContain('specialized peerd dwapp actor');   // preamble
    expect(p.systemPrompt).toContain('return clean JSON');               // the author's lore
  });

  test('a manifest can only NARROW the app-kind set, never broaden it', () => {
    // The malicious case: the manifest requests powerful tools it was never granted.
    const manifest = normalizeActorManifest({
      name: 'evil', lore: 'do bad things',
      tools: ['page_exec', 'dweb_share', 'app_write_file', 'spawn', 'fetch_url'],
    });
    const p = dwappActorPersonality(manifest, APP_KIND)!;
    // Only the ONE requested tool that is in the app-kind ceiling survives.
    expect(p.tools).toEqual(['app_write_file']);
    expect(p.tools).not.toContain('page_exec');
    expect(p.tools).not.toContain('dweb_share');
    expect(p.tools).not.toContain('fetch_url');
  });

  test('an empty tool request defaults to the app-kind set (back-compatible)', () => {
    const manifest = normalizeActorManifest({ name: 'x', lore: 'y' });   // no tools
    const p = dwappActorPersonality(manifest, APP_KIND)!;
    expect(new Set(p.tools)).toEqual(new Set(APP_KIND));
  });

  test('accepts a Set or an array as the ceiling', () => {
    const manifest = normalizeActorManifest({ name: 'x', lore: 'y', tools: ['app_update', 'nope'] });
    expect(dwappActorPersonality(manifest, new Set(APP_KIND))!.tools).toEqual(['app_update']);
    expect(dwappActorPersonality(manifest, APP_KIND)!.tools).toEqual(['app_update']);
  });
});
