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
  EXTENSION_DIR, 'background/routes/contributor-metrics.js',
), 'utf8');
const serviceWorker = readFileSync(join(EXTENSION_DIR, 'background/service-worker.js'), 'utf8');
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
    const source = stripComments([metrics, store, feedback, routes].join('\n'));
    expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\//);
    expect(source).not.toMatch(/collector|contributions\/v[0-9]/i);
  });

  test('every issue-345 contribution consumer remains local-only', () => {
    const sources = [serviceWorker, options, messageList].map(stripComments);
    for (const source of sources) {
      const lines = source.split('\n');
      const contributionNeighborhood = lines.flatMap((line, index) =>
        /contributor/i.test(line) ? lines.slice(Math.max(0, index - 4), index + 5) : []);
      expect(contributionNeighborhood.join('\n')).not.toMatch(
        /\bfetch\s*\(|\bsafeFetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|https?:\/\//,
      );
    }
    expect(stripComments(routes)).not.toMatch(/contributor\/(?:upload|send|schedule)|alarm/i);
    expect(stripComments(serviceWorker)).not.toMatch(/CONTRIBUTOR_(?:ORIGIN|ENDPOINT)|contributionAlarm/i);
  });

  test('consent keys are absent from generated/importable settings', () => {
    const defaults = readFileSync(join(EXTENSION_DIR, 'shared/channel-config.js'), 'utf8');
    const transfer = readFileSync(join(EXTENSION_DIR, 'background/routes/system.js'), 'utf8');
    expect(defaults).not.toContain('contributorMetrics');
    expect(transfer).not.toContain('CONTRIBUTOR_CONSENT_KEY');
    expect(transfer).not.toContain('contributor_metrics.consent');
  });

  test('the direct dweb actor wake reserves before async setup and snapshots before release', () => {
    const start = serviceWorker.indexOf('const handleDwebAgentInbound');
    const end = serviceWorker.indexOf("msg?.type === 'dweb/base-room/event'", start);
    const inboundWake = serviceWorker.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(inboundWake).toContain('turnSlots.runWhenIdleClaimed(actor.actorSessionId');
    expect(inboundWake).toContain('turnSlots.runWhenIdleClaimed(active');
    expect(inboundWake).toContain('turnLease,');
    expect(inboundWake).toContain('off?.turnSnapshot?.messages ?? []');
    expect(inboundWake).not.toContain('await sessions.get(actor.actorSessionId);');
    expect(inboundWake).toContain('priorTurnsForWake = conversationRegistry.turnsFor(convId)');
    expect(inboundWake.indexOf('priorTurnsForWake = conversationRegistry.turnsFor(convId)'))
      .toBeLessThan(inboundWake.indexOf("conversationRegistry.record(convId, 'peer', deliver.message)"));
    expect(inboundWake).toContain('runDwebConversationOrdered(convId, runInboundWake)');
    expect(inboundWake).toContain('const run = ownsThread && convId');
    expect(inboundWake.slice(0, inboundWake.indexOf('const runInboundWake'))).not.toMatch(/\bawait\b/);
    expect(inboundWake).toContain('conversationRegistry.ownedBy(cid, did)');
    expect(inboundWake).toContain('sent?.ok === true');
    expect(inboundWake).not.toContain('await withDwebPublication');
    expect(inboundWake).toContain('const parentStopGeneration = turnSlots.generation(active)');
    expect(inboundWake).toContain('turnSlots.generation(active) !== parentStopGeneration');
    // Bound actors may only run in their dedicated worker. A regression to the
    // former background fallback would also re-open the snapshot race.
    expect(inboundWake).not.toContain('captureTurnSnapshot: true');
  });

  test('a claimed web actor advances its landing epoch in the serialized authority lane', () => {
    const start = serviceWorker.indexOf('runActorTurn: async ({');
    const end = serviceWorker.indexOf('reenter: ({ userText', start);
    const actorTurn = serviceWorker.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const epochAdvance = 'beginLandingTurn(actorSessionId)';
    const epochBarrier = 'await originStates.serialize(actorSessionId, () => undefined)';
    expect(actorTurn).toContain(epochAdvance);
    expect(actorTurn).toContain(epochBarrier);
    expect(actorTurn.indexOf(epochAdvance)).toBeLessThan(actorTurn.indexOf('let deliveredMessage'));
    expect(actorTurn.indexOf(epochAdvance)).toBeLessThan(actorTurn.indexOf(epochBarrier));
    expect(actorTurn).toContain(
      'feedbackContextKey: contributorFeedbackContextKey(parentSessionId, parentToolUseId)',
    );
    expect(actorTurn).not.toContain('feedbackContextKey: beforeRecord.parentSessionId');
  });
});
