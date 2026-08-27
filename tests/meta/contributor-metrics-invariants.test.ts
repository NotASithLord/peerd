// Contributor Metrics must remain a closed local schema, not grow into a
// generic analytics SDK or acquire egress accidentally while issue #345 is the
// merged state.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';

const metrics = readFileSync(join(
  EXTENSION_DIR, 'peerd-runtime/observability/contributor-metrics.js',
), 'utf8');
const store = readFileSync(join(
  EXTENSION_DIR, 'peerd-runtime/observability/contributor-store.js',
), 'utf8');
const feedback = readFileSync(join(
  EXTENSION_DIR, 'peerd-runtime/observability/contributor-feedback.js',
), 'utf8');
const routes = readFileSync(join(
  EXTENSION_DIR, 'offscreen/semantic-routes/contributor.js',
), 'utf8');
const guard = readFileSync(join(
  EXTENSION_DIR, 'background/kernel-contributor-feedback-guard.js',
), 'utf8');
const owner = readFileSync(join(
  EXTENSION_DIR, 'background/kernel-contributor-owner.js',
), 'utf8');
const channel = readFileSync(join(
  EXTENSION_DIR, 'shared/contributor-channel.js',
), 'utf8');
const authorityAdapter = readFileSync(join(
  EXTENSION_DIR, 'background/kernel-turn-authority-adapter.js',
), 'utf8');
const options = readFileSync(join(EXTENSION_DIR, 'options/sections/contributor-metrics.js'), 'utf8');
const messageList = readFileSync(join(EXTENSION_DIR, 'sidepanel/components/message-list.js'), 'utf8');

const stripComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

describe('Contributor Metrics source invariants', () => {
  test('exports only named, typed folds, never a generic event/property API', () => {
    const exportedFunctions = [...metrics.matchAll(/export const ([A-Za-z0-9_]+)\s*=\s*\(/g)]
      .map((match) => match[1]);
    expect(exportedFunctions).not.toContain('track');
    expect(exportedFunctions).not.toContain('recordEvent');
    expect(exportedFunctions).not.toContain('capture');
    expect(stripComments(metrics)).not.toMatch(/\beventName\b|\bproperties\b/);
  });

  test('the local core/store/routes contain no network primitive or origin', () => {
    const source = stripComments([
      metrics, store, feedback, routes, guard, owner, channel,
    ].join('\n'));
    expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\//);
    expect(source).not.toMatch(/collector|contributions\/v[0-9]/i);
  });

  test('the authority hashes identifiers before storage and never logs raw failure causes', () => {
    expect(stripComments(owner)).not.toMatch(/console\./);
    expect(owner.indexOf("opaqueContributorToken(\n      'operation'")).toBeLessThan(
      owner.indexOf('await set(`${CONTRIBUTOR_PENDING_RECEIPT_PREFIX}'),
    );
    expect(authorityAdapter).toContain("console.warn('[contributor] local settlement skipped');");
    expect(authorityAdapter).not.toContain(
      "console.warn('[contributor] local settlement skipped', cause)",
    );
  });

  test('every issue-345 contribution consumer remains local-only', () => {
    const sources = [options, messageList].map(stripComments);
    for (const source of sources) {
      const lines = source.split('\n');
      const contributionNeighborhood = lines.flatMap((line, index) =>
        /contributor/i.test(line) ? lines.slice(Math.max(0, index - 4), index + 5) : []);
      expect(contributionNeighborhood.join('\n')).not.toMatch(
        /\bfetch\s*\(|\bsafeFetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|https?:\/\//,
      );
    }
    expect(stripComments(routes)).not.toMatch(/contributor\/(?:upload|send|schedule)|alarm/i);
  });

  test('consent keys are absent from generated/importable settings', () => {
    const defaults = readFileSync(join(EXTENSION_DIR, 'shared/channel-config.js'), 'utf8');
    const transfer = readFileSync(join(EXTENSION_DIR, 'background/routes/system.js'), 'utf8');
    expect(defaults).not.toContain('contributorMetrics');
    expect(transfer).not.toContain('CONTRIBUTOR_CONSENT_KEY');
    expect(transfer).not.toContain('contributor_metrics.consent');
  });

});
