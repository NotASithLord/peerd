// Scenario 12: local Contributor Metrics cannot become telemetry by surprise.
//
// The adversary is any non-human extension surface or caller-controlled value
// trying to create state without consent, forge consent or feedback, smuggle
// content into the closed aggregate, or find a network edge in the local-only
// implementation. Each probe drives the real store, route, schema, or source
// boundary that enforces the claim.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Probe, type Scenario, blocked, leaked, summarize,
} from '../harness.ts';
import { EXTENSION_DIR } from '../../../packaging/lib.ts';
import {
  createPreviewContributorRoutes,
} from '../../../extension/background/kernel-preview-addon.js';
import {
  ContributorSchemaError, emptyContributorLocalState,
  recordContributorWebTurn, serializeContributorEnvelope,
} from '../../../extension/peerd-runtime/observability/contributor-metrics.js';
import {
  CONTRIBUTOR_LOCAL_KEY, makeContributorStore,
} from '../../../extension/peerd-runtime/observability/contributor-store.js';

const turn = {
  feature: 'web_actor_surface', requested: 'code', resolved: 'tools',
  fallback: 'worker_unavailable', browser: 'firefox', extensionVersion: '0.6.0',
  channel: 'preview', provider: 'attacker-provider', model: 'https://evil.example/secret',
  outcome: 'completed', failure: 'none', durationMs: 12, tokens: 40,
};

const stripComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

export const scenario: Scenario = {
  id: '12-contributor-metrics',
  title: 'Contributor Metrics consent, schema, and no-egress boundary',
  adversary: 'model, actor, page, sandbox, or malformed local caller',
  asset: 'user consent and private browser or conversation content',
  claim: 'Contributor Metrics remains inert before consent, only the exact human surfaces can change consent or submit binary feedback, arbitrary strings cannot enter the closed aggregate, and the local implementation has no network path.',
  threatModelRef: 'INV-16',
  tier: 'unit',
  async run() {
    const probes: Probe[] = [];
    const records = new Map<string, any>();
    let writes = 0;
    const store = makeContributorStore({
      kv: {
        get: async (key: string) => records.get(key),
        set: async (key: string, value: any) => { writes += 1; records.set(key, value); },
        delete: async (key: string) => { writes += 1; records.delete(key); },
      },
      makeGeneration: () => 'consent-generation',
      tokenizeLocalKey: async (kind: string) => `${kind}:${'a'.repeat(64)}`,
    });

    const armed = await store.arm();
    const settled = await store.recordWebSettlement({
      consentGeneration: 'forged-generation', operationToken: `operation:${'a'.repeat(64)}`,
      feedbackContextToken: null, turn, actions: [],
    });
    const feedback = await store.recordFeedback({
      selectionKey: 'forged-selection', verdict: 'worked', candidateContextKeys: ['forged-context'],
    });
    const inert = armed.enabled === false && settled === false
      && feedback.recorded === false && writes === 0 && !records.has(CONTRIBUTOR_LOCAL_KEY);
    probes.push(inert
      ? blocked('record outcomes and feedback before consent', 'store stayed unarmed and performed no persistence write')
      : leaked('record outcomes and feedback before consent', `armed=${armed.enabled} settled=${settled} writes=${writes}`));

    let routeMutations = 0;
    const optionsSender = Object.freeze({ surface: 'options' });
    const chatSender = Object.freeze({ surface: 'sidepanel' });
    const hostileSender = Object.freeze({ surface: 'engine' });
    const owner = createPreviewContributorRoutes({
      kv: {
        get: async () => { routeMutations += 1; return null; },
        set: async () => { routeMutations += 1; },
        delete: async () => { routeMutations += 1; },
        list: async () => { routeMutations += 1; return {}; },
      },
      optionsUi: (sender: unknown) => sender === optionsSender,
      sidepanelUi: (sender: unknown) => sender === chatSender,
      homeUi: () => false,
      validateFeedback: async () => { routeMutations += 1; return { ok: false }; },
      offscreenUrl: 'chrome-extension://id/offscreen/offscreen.html',
      featureHost: { runtime: { runWithLease: async () => {
        routeMutations += 1; return { ok: false };
      } } },
      scheduleDrain: () => {},
    });
    const consentReply = await owner.routes['contributor/enable']({
      type: 'contributor/enable',
    }, hostileSender);
    probes.push(consentReply.ok === false && routeMutations === 0
      ? blocked('forge consent from an actor or extension page', 'exact Options sender required; mutation function never ran')
      : leaked('forge consent from an actor or extension page', `ok=${consentReply.ok} mutations=${routeMutations}`));

    const feedbackReply = await owner.routes['contributor/feedback']({
      type: 'contributor/feedback', sessionId: 'chat', messageId: 'answer', verdict: 'worked',
    }, hostileSender);
    probes.push(feedbackReply.ok === false && routeMutations === 0
      ? blocked('forge task feedback outside the exact chat surfaces', 'exact side-panel or Home sender required; mutation function never ran')
      : leaked('forge task feedback outside the exact chat surfaces', `ok=${feedbackReply.ok} mutations=${routeMutations}`));

    let smugglingRejected = false;
    try {
      recordContributorWebTurn(emptyContributorLocalState(), {
        ...turn, url: 'https://evil.example/private?prompt=secret',
      });
    } catch (error) {
      smugglingRejected = error instanceof ContributorSchemaError;
    }
    probes.push(smugglingRejected
      ? blocked('smuggle a URL through an extra observation field', 'exact-key validation raised ContributorSchemaError')
      : leaked('smuggle a URL through an extra observation field', 'unknown field was accepted'));

    const normalized = recordContributorWebTurn(emptyContributorLocalState(), turn);
    const bytes = serializeContributorEnvelope(normalized).bytes;
    const contentAbsent = !bytes.includes('evil.example') && !bytes.includes('attacker-provider')
      && bytes.includes('"provider":"custom"') && bytes.includes('"modelFamily":"custom"');
    probes.push(contentAbsent
      ? blocked('encode content in provider or model names', 'unknown values collapsed to the closed custom enum')
      : leaked('encode content in provider or model names', bytes));

    const localSources = [
      'peerd-runtime/observability/contributor-metrics.js',
      'peerd-runtime/observability/contributor-store.js',
      'peerd-runtime/observability/contributor-feedback.js',
      'background/kernel-contributor-feedback-guard.js',
      'background/kernel-contributor-owner.js',
      'offscreen/semantic-routes/contributor.js',
      'shared/contributor-channel.js',
    ].map((path) => stripComments(readFileSync(join(EXTENSION_DIR, path), 'utf8'))).join('\n');
    const hasNetwork = /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|https?:\/\//.test(localSources);
    probes.push(!hasNetwork
      ? blocked('turn the local accumulator into an upload path', 'local core, store, feedback, and routes contain no network primitive or origin')
      : leaked('turn the local accumulator into an upload path', 'network primitive or origin found'));

    return summarize(probes, [
      'consent-generation store gate', 'exact human sender gates', 'closed exact-key schema',
      'catalog-only provider/model normalization', 'source-level no-egress invariant',
    ]);
  },
};
