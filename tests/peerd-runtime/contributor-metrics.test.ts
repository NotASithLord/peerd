import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  CONTRIBUTOR_LOCAL_KEY,
  ContributorReadOnlyError, makeContributorStore,
} from '../../extension/peerd-runtime/observability/contributor-store.js';
import {
  CONTRIBUTOR_ACTION_KINDS, CONTRIBUTOR_BROWSERS, CONTRIBUTOR_CHANNELS,
  CONTRIBUTOR_DURATION_BUCKETS, CONTRIBUTOR_FAILURES, CONTRIBUTOR_FALLBACKS,
  CONTRIBUTOR_DISCLOSURE_VERSION, CONTRIBUTOR_FEATURES,
  CONTRIBUTOR_KNOWN_MODEL_FAMILIES, CONTRIBUTOR_LOCAL_VERSION,
  CONTRIBUTOR_MAX_ACTIONS_PER_SETTLEMENT, CONTRIBUTOR_MAX_COUNTER,
  CONTRIBUTOR_MAX_LOCAL_DEDUPE, CONTRIBUTOR_MAX_ROWS,
  CONTRIBUTOR_OUTCOMES, CONTRIBUTOR_PROVIDERS, CONTRIBUTOR_SURFACES,
  CONTRIBUTOR_SCHEMA_VERSION, CONTRIBUTOR_TOKEN_BUCKETS,
  ContributorSchemaError, adjustContributorFeedback, contributorCohortKey,
  contributorActionForTool, contributorTurnResult,
  emptyContributorLocalState, normalizeContributorCohort,
  normalizeContributorModelFamily, normalizeContributorProvider,
  recordContributorWebAction, recordContributorWebTurn,
  serializeContributorEnvelope,
} from '../../extension/peerd-runtime/observability/contributor-metrics.js';
import {
  DEFAULT_CONTEXT_WINDOWS, OPENAI_POPULAR, OPENROUTER_POPULAR, listProviders,
} from '../../extension/peerd-provider/index.js';
import { CODE_CLIENT_MANIFESTS } from '../../extension/peerd-runtime/actor/capability-manifest.js';

const cohort = (overrides: Record<string, unknown> = {}) => ({
  feature: 'web_actor_surface',
  requested: 'code',
  resolved: 'code',
  fallback: 'none',
  browser: 'chrome',
  extensionVersion: '0.8.7',
  channel: 'preview',
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  ...overrides,
});

const turn = (overrides: Record<string, unknown> = {}) => ({
  ...cohort(),
  outcome: 'completed',
  failure: 'none',
  durationMs: 2_000,
  tokens: 1_500,
  ...overrides,
});

const opaqueToken = (kind: string, generation: string, value: string) =>
  `${kind}:${createHash('sha256').update(`${kind}\0${generation}\0${value}`).digest('hex')}`;

const settlement = (generation: string, operationKey: string, overrides: {
  turn?: Record<string, unknown>, actions?: Record<string, unknown>[], feedbackContextKey?: string | null,
} = {}) => ({
  consentGeneration: generation,
  operationToken: opaqueToken('operation', generation, operationKey),
  feedbackContextToken: overrides.feedbackContextKey == null ? null
    : opaqueToken('context', generation, overrides.feedbackContextKey),
  turn: overrides.turn ?? turn(),
  actions: overrides.actions ?? [],
});

const makeKv = (initial: Record<string, unknown> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    delete: async (key: string) => { values.delete(key); },
    peek: (key: string) => values.get(key),
  };
};

describe('Contributor Metrics closed schema', () => {
  test('serializes a canonical v1 row deterministically', () => {
    let state = emptyContributorLocalState();
    state = recordContributorWebTurn(state, turn());
    state = recordContributorWebAction(state, { ...cohort(), action: 'page_code' });
    const first = serializeContributorEnvelope(state);
    const second = serializeContributorEnvelope(structuredClone(state));
    expect(first.bytes).toBe(second.bytes);
    expect(first.envelope.rows).toHaveLength(1);
    expect(first.envelope.rows[0]).toMatchObject({
      requested: 'code', resolved: 'code', completed: 1, actorTurns: 1,
      pageCodeRuns: 1, pageActionCalls: 0, modelFamily: 'claude-haiku',
    });
    expect(Object.keys(first.envelope)).toEqual(['schemaVersion', 'rows']);
  });

  test('accepts every reviewed v1 enum value', () => {
    const cohortDimensions = [
      ['feature', CONTRIBUTOR_FEATURES],
      ['requested', CONTRIBUTOR_SURFACES],
      ['resolved', CONTRIBUTOR_SURFACES],
      ['fallback', CONTRIBUTOR_FALLBACKS],
      ['browser', CONTRIBUTOR_BROWSERS],
      ['channel', CONTRIBUTOR_CHANNELS],
      ['provider', CONTRIBUTOR_PROVIDERS],
      ['model', [...Object.keys(CONTRIBUTOR_KNOWN_MODEL_FAMILIES), 'opaque-custom-model']],
    ] as const;
    for (const [field, values] of cohortDimensions) {
      for (const value of values) {
        const state = recordContributorWebTurn(emptyContributorLocalState(), turn({ [field]: value }));
        expect(() => serializeContributorEnvelope(state)).not.toThrow();
      }
    }
    for (const outcome of CONTRIBUTOR_OUTCOMES) {
      const state = recordContributorWebTurn(emptyContributorLocalState(), turn({
        outcome, failure: outcome === 'error' ? 'internal' : 'none',
      }));
      expect(() => serializeContributorEnvelope(state)).not.toThrow();
    }
    for (const failure of CONTRIBUTOR_FAILURES.filter((value) => value !== 'none')) {
      const state = recordContributorWebTurn(emptyContributorLocalState(), turn({ outcome: 'error', failure }));
      expect(() => serializeContributorEnvelope(state)).not.toThrow();
    }
    for (const action of CONTRIBUTOR_ACTION_KINDS) {
      const state = recordContributorWebAction(
        recordContributorWebTurn(emptyContributorLocalState(), turn()),
        { ...cohort(), action },
      );
      expect(() => serializeContributorEnvelope(state)).not.toThrow();
    }
  });

  test('the runtime action classifier is closed and manifest-symmetric', () => {
    expect(contributorActionForTool('page_code')).toBe('page_code');
    for (const method of Object.values(CODE_CLIENT_MANIFESTS.page.methods)) {
      expect(contributorActionForTool(method.tool)).toBe('page_action');
    }
    for (const excluded of ['site_client_run', 'message_actor', 'snapshot-private', '', null]) {
      expect(contributorActionForTool(excluded)).toBeNull();
    }
  });

  test('operational completion excludes truncation, exhaustion, interruption, and stops', () => {
    expect(contributorTurnResult({
      assistantMessages: [{ stopReason: 'end_turn' }], stopped: false,
    })).toEqual({ outcome: 'completed', failure: 'none' });
    expect(contributorTurnResult({
      assistantMessages: [{ stopReason: 'max_tokens' }], stopped: false,
    })).toEqual({ outcome: 'error', failure: 'limits' });
    expect(contributorTurnResult({
      assistantMessages: [{ stopReason: 'max_steps' }], stopped: false,
    })).toEqual({ outcome: 'error', failure: 'limits' });
    expect(contributorTurnResult({
      assistantMessages: [{ stopReason: 'incomplete' }], stopped: false,
    })).toEqual({ outcome: 'error', failure: 'provider' });
    expect(contributorTurnResult({
      assistantMessages: [{ stopReason: 'aborted' }], stopped: true,
    })).toEqual({ outcome: 'cancelled', failure: 'none' });
    expect(contributorTurnResult({
      assistantMessages: [{ stopReason: 'end_turn', error: 'the actor turn failed: boom' }],
      stopped: true, result: 'ignored',
    })).toEqual({ outcome: 'error', failure: 'agent' });
  });

  test('normalizes unknown provider/model strings to one literal', () => {
    expect(normalizeContributorProvider('https://private.example')).toBe('custom');
    expect(normalizeContributorModelFamily('gpt-5-private.example/secret')).toBe('custom');
    expect(normalizeContributorModelFamily('claude-haiku-4-5')).toBe('claude-haiku');
    expect(normalizeContributorModelFamily('claude-haiku')).toBe('claude-haiku');
  });

  test('every shipped static/catalog model has a reviewed family', () => {
    const known = new Set([
      ...Object.keys(DEFAULT_CONTEXT_WINDOWS), ...OPENAI_POPULAR, ...OPENROUTER_POPULAR,
    ]);
    for (const model of known) {
      expect(normalizeContributorModelFamily(model)).not.toBe('custom');
    }
    for (const provider of listProviders().map((entry) => entry.name)) {
      expect(normalizeContributorProvider(provider)).not.toBe('custom');
    }
  });

  test('arbitrary strings cannot survive into serialized bytes', () => {
    const needles = [
      'https://private.example/path?q=secret',
      'private.example', '#checkout-button', 'ignore previous instructions',
      'raw provider error: token=sk-secret', 'session-019123', 'search terms here',
    ];
    for (let index = 0; index < 250; index += 1) needles.push(`opaque-${index}-${'x'.repeat(index % 37)}`);
    for (const needle of needles) {
      const state = recordContributorWebTurn(emptyContributorLocalState(), turn({
        provider: needle,
        model: needle,
      }));
      const bytes = serializeContributorEnvelope(state).bytes;
      expect(bytes).not.toContain(needle);
      expect(bytes).toContain('"provider":"custom"');
      expect(bytes).toContain('"modelFamily":"custom"');
    }
  });

  test('unknown keys and enum values fail closed', () => {
    expect(() => recordContributorWebTurn(emptyContributorLocalState(), turn({ requested: 'magic' })))
      .toThrow(ContributorSchemaError);
    expect(() => recordContributorWebTurn(emptyContributorLocalState(), turn({
      url: 'https://private.example',
    }))).toThrow('unknown or missing key');
    expect(() => recordContributorWebAction(emptyContributorLocalState(), {
      ...cohort(), action: 'page_code', selector: '#private',
    })).toThrow('unknown or missing key');
    const state = recordContributorWebTurn(emptyContributorLocalState(), turn());
    const key = Object.keys(state.rows)[0];
    const smuggled = structuredClone(state) as any;
    smuggled.rows[key].url = 'https://private.example';
    expect(() => serializeContributorEnvelope(smuggled)).toThrow('unknown or missing key');
    const topLevel = { ...state, arbitrary: 'secret' } as any;
    expect(() => serializeContributorEnvelope(topLevel)).toThrow('unknown or missing key');
  });

  test('negative/non-finite/over-cap counters and malformed versions fail closed', () => {
    const state = recordContributorWebTurn(emptyContributorLocalState(), turn());
    const key = Object.keys(state.rows)[0];
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, CONTRIBUTOR_MAX_COUNTER + 1]) {
      const copy = structuredClone(state) as any;
      copy.rows[key].actorTurns = bad;
      expect(() => serializeContributorEnvelope(copy)).toThrow(ContributorSchemaError);
    }
    expect(() => serializeContributorEnvelope({ ...state, version: CONTRIBUTOR_LOCAL_VERSION + 1 }))
      .toThrow('unsupported local contributor version');
  });

  test('noncanonical row indexes and impossible feedback totals fail closed', () => {
    const state = recordContributorWebTurn(emptyContributorLocalState(), turn()) as any;
    const key = Object.keys(state.rows)[0];
    const noncanonical = structuredClone(state);
    noncanonical.rows.not_the_cohort = noncanonical.rows[key];
    delete noncanonical.rows[key];
    expect(() => serializeContributorEnvelope(noncanonical)).toThrow('noncanonical or duplicated');

    const impossible = structuredClone(state);
    impossible.rows[key].worked = 2;
    expect(() => serializeContributorEnvelope(impossible)).toThrow('feedback total exceeds');

    const impossibleActions = structuredClone(state);
    impossibleActions.rows[key].pageActionCalls = CONTRIBUTOR_MAX_ACTIONS_PER_SETTLEMENT + 1;
    expect(() => serializeContributorEnvelope(impossibleActions)).toThrow('action counters exceed');
  });

  test('histograms use named boundaries and totals are pinned to actor turns', () => {
    let state = emptyContributorLocalState();
    state = recordContributorWebTurn(state, turn({ durationMs: 999, tokens: 0 }));
    state = recordContributorWebTurn(state, turn({ durationMs: 1_000, tokens: 999 }));
    state = recordContributorWebTurn(state, turn({ durationMs: 60_000, tokens: 64_000 }));
    const row = serializeContributorEnvelope(state).envelope.rows[0];
    expect(Object.keys(row.duration)).toEqual([...CONTRIBUTOR_DURATION_BUCKETS]);
    expect(Object.keys(row.tokens)).toEqual([...CONTRIBUTOR_TOKEN_BUCKETS]);
    expect(row.duration.under_1s).toBe(1);
    expect(row.duration['1s_to_5s']).toBe(1);
    expect(row.duration['60s_or_more']).toBe(1);
    expect(row.tokens.none).toBe(1);
    expect(row.tokens['1_to_1k']).toBe(1);
    expect(row.tokens['64k_or_more']).toBe(1);
    const corrupt = structuredClone(state) as any;
    corrupt.rows[Object.keys(corrupt.rows)[0]].duration.under_1s += 1;
    expect(() => serializeContributorEnvelope(corrupt)).toThrow('histogram total');

    const shiftedFailure = structuredClone(state) as any;
    const shiftedRow = shiftedFailure.rows[Object.keys(shiftedFailure.rows)[0]];
    shiftedRow.failures.none -= 1;
    shiftedRow.failures.internal += 1;
    expect(() => serializeContributorEnvelope(shiftedFailure)).toThrow('failure histogram does not match');
  });

  test('row caps reject widening rather than dropping a cohort silently', () => {
    const state = emptyContributorLocalState() as any;
    for (let index = 0; index < CONTRIBUTOR_MAX_ROWS; index += 1) {
      state.rows[`row-${index}`] = { sentinel: true };
    }
    expect(() => recordContributorWebTurn(state, turn())).toThrow('row cap exceeded');
  });

  test('binary feedback is idempotent and changing it adjusts the same cohort', () => {
    let state = recordContributorWebTurn(emptyContributorLocalState(), turn());
    const key = contributorCohortKey(normalizeContributorCohort(cohort()));
    state = adjustContributorFeedback(state, { cohortKey: key, verdict: 'worked' });
    const same = adjustContributorFeedback(state, { cohortKey: key, verdict: 'worked', previous: 'worked' });
    expect(same).toBe(state);
    state = adjustContributorFeedback(state, { cohortKey: key, verdict: 'didnt_work', previous: 'worked' });
    const row = serializeContributorEnvelope(state).envelope.rows[0];
    expect(row.worked).toBe(0);
    expect(row.didntWork).toBe(1);
  });
});

describe('Contributor Metrics local lifecycle', () => {
  test('fresh/default recorder is inert and creates no aggregate state', async () => {
    const kv = makeKv();
    const store = makeContributorStore({ kv, makeGeneration: () => 'generation-1' });
    expect(await store.arm()).toEqual({ enabled: false, generation: null });
    expect(await store.recordWebSettlement(settlement('generation-1', 'turn-1'))).toBe(false);
    expect(kv.peek(CONTRIBUTOR_LOCAL_KEY)).toBeUndefined();
    expect(await store.status()).toMatchObject({ enabled: false, bytes: null, rowCount: 0 });
  });

  test('enable is explicit and atomic; disable revokes and clears every local byte', async () => {
    const kv = makeKv();
    const store = makeContributorStore({ kv, makeGeneration: () => 'generation-1' });
    await store.enable();
    expect(Object.keys(kv.peek(CONTRIBUTOR_LOCAL_KEY) as object).sort())
      .toEqual(['aggregate', 'consent', 'version']);
    const arm = await store.arm();
    expect(arm).toEqual({ enabled: true, generation: 'generation-1' });
    await store.recordWebSettlement(settlement('generation-1', 'turn-1', {
      feedbackContextKey: 'chat-1:tool-1',
    }));
    await store.recordFeedback({
      selectionKey: 'chat-1:user-1', verdict: 'worked',
      candidateContextKeys: ['chat-1:tool-1'],
    });
    expect((await store.status()).bytes).toContain('"worked":1');
    const localBytes = JSON.stringify(kv.peek(CONTRIBUTOR_LOCAL_KEY));
    expect(localBytes).not.toContain('chat-1');
    expect(localBytes).not.toContain('tool-1');
    expect(localBytes).toContain('operation:');
    expect(localBytes).toContain('context:');
    expect(localBytes).toContain('selection:');
    await store.disableAndClear();
    expect(kv.peek(CONTRIBUTOR_LOCAL_KEY)).toBeUndefined();
    expect(await store.status()).toMatchObject({ enabled: false, bytes: null });
  });

  test('serialized concurrent mutations cannot lose counts', async () => {
    const store = makeContributorStore({ kv: makeKv(), makeGeneration: () => 'generation-1' });
    await store.enable();
    await Promise.all(Array.from({ length: 80 }, (_, index) => store.recordWebSettlement(
      settlement('generation-1', `op-${index}`, {
        actions: [{ ...cohort(), action: 'page_action' }],
      }),
    )));
    const status = await store.status();
    expect(JSON.parse(status.bytes as string).rows[0]).toMatchObject({
      actorTurns: 80, pageActionCalls: 80,
    });
  });

  test('one settlement is all-or-once and replay/feedback replay do not double-count', async () => {
    const store = makeContributorStore({ kv: makeKv(), makeGeneration: () => 'generation-1' });
    await store.enable();
    const observation = settlement('generation-1', 'turn-1', {
      feedbackContextKey: 'chat:tool',
      actions: [
        { ...cohort(), action: 'page_code' },
        { ...cohort(), action: 'page_action' },
      ],
    });
    expect(await store.recordWebSettlement(observation)).toBe(true);
    expect(await store.recordWebSettlement(observation)).toBe(false);
    const input = { selectionKey: 'chat:user', verdict: 'worked', candidateContextKeys: ['chat:tool'] };
    expect((await store.recordFeedback(input)).recorded).toBe(true);
    expect((await store.recordFeedback(input)).recorded).toBe(false);
    const rows = JSON.parse((await store.status()).bytes as string).rows;
    expect(rows[0]).toMatchObject({ actorTurns: 1, pageCodeRuns: 1, pageActionCalls: 1, worked: 1 });
  });

  test('a malformed action rejects the whole settlement without a partial write', async () => {
    const kv = makeKv();
    const store = makeContributorStore({ kv, makeGeneration: () => 'generation-1' });
    await store.enable();
    await expect(store.recordWebSettlement(settlement('generation-1', 'turn-invalid', {
      actions: [
        { ...cohort(), action: 'page_action' },
        { ...cohort(), action: 'page_action', selector: '#must-not-survive' },
      ],
    }))).rejects.toThrow('unknown or missing key');
    expect(await store.status()).toMatchObject({ enabled: true, rowCount: 0 });
    expect((kv.peek(CONTRIBUTOR_LOCAL_KEY) as any).aggregate.dedupe).toEqual([]);
  });

  test('a new service-worker store resumes consent/aggregate and rejects replay', async () => {
    const kv = makeKv();
    const firstWorker = makeContributorStore({ kv, makeGeneration: () => 'generation-1' });
    await firstWorker.enable();
    const observation = settlement('generation-1', 'mailbox-correlation-1');
    expect(await firstWorker.recordWebSettlement(observation)).toBe(true);

    const restartedWorker = makeContributorStore({ kv, makeGeneration: () => 'generation-2' });
    expect(await restartedWorker.status()).toMatchObject({ enabled: true, rowCount: 1 });
    expect(await restartedWorker.recordWebSettlement(observation)).toBe(false);
    expect(JSON.parse((await restartedWorker.status()).bytes as string).rows[0].actorTurns).toBe(1);
    await restartedWorker.disableAndClear();

    const afterRevokeRestart = makeContributorStore({ kv });
    expect(await afterRevokeRestart.status()).toMatchObject({ enabled: false, bytes: null });
    expect(kv.peek(CONTRIBUTOR_LOCAL_KEY)).toBeUndefined();
    await afterRevokeRestart.enable();
    expect(await afterRevokeRestart.status()).toMatchObject({ enabled: true, rowCount: 0 });
  });

  test('changing feedback stays pinned to the originally selected cohort', async () => {
    const store = makeContributorStore({ kv: makeKv(), makeGeneration: () => 'generation-1' });
    await store.enable();
    await store.recordWebSettlement(settlement('generation-1', 'turn-code', {
      feedbackContextKey: 'chat:tool', turn: turn({ resolved: 'code' }),
    }));
    await store.recordFeedback({
      selectionKey: 'chat:user', verdict: 'worked', candidateContextKeys: ['chat:tool'],
    });
    await store.recordWebSettlement(settlement('generation-1', 'turn-tools', {
      feedbackContextKey: 'chat:tool', turn: turn({ resolved: 'tools' }),
    }));
    await store.recordFeedback({
      selectionKey: 'chat:user', verdict: 'didnt_work', candidateContextKeys: ['chat:tool'],
    });
    const rows = JSON.parse((await store.status()).bytes as string).rows;
    expect(rows.find((row: any) => row.resolved === 'code')).toMatchObject({ worked: 0, didntWork: 1 });
    expect(rows.find((row: any) => row.resolved === 'tools')).toMatchObject({ worked: 0, didntWork: 0 });
  });

  test('local dedupe is bounded and never appears in exact preview bytes', async () => {
    const kv = makeKv();
    const store = makeContributorStore({ kv, makeGeneration: () => 'generation-1' });
    await store.enable();
    for (let index = 0; index < CONTRIBUTOR_MAX_LOCAL_DEDUPE + 20; index += 1) {
      await store.recordWebSettlement(settlement('generation-1', `secret-id-${index}`, {
        actions: [{ ...cohort(), action: 'page_action' }],
      }));
    }
    const status = await store.status();
    expect(status.bytes).not.toContain('secret-id');
    expect(JSON.stringify(kv.peek(CONTRIBUTOR_LOCAL_KEY))).not.toContain('secret-id');
    expect((kv.peek(CONTRIBUTOR_LOCAL_KEY) as any).aggregate.dedupe).toHaveLength(CONTRIBUTOR_MAX_LOCAL_DEDUPE);
  });

  test('consent is armed at turn start and stale generations cannot settle', async () => {
    const kv = makeKv();
    let sequence = 0;
    const store = makeContributorStore({ kv, makeGeneration: () => `generation-${++sequence}` });
    const disabledArm = await store.arm();
    await store.enable();
    expect(await store.recordWebSettlement(settlement(String(disabledArm.generation), 'pre-consent'))).toBe(false);

    const firstArm = await store.arm();
    await store.disableAndClear();
    await store.enable();
    expect(await store.recordWebSettlement(settlement(String(firstArm.generation), 'stale-generation'))).toBe(false);
    const currentArm = await store.arm();
    expect(await store.recordWebSettlement(settlement(String(currentArm.generation), 'current-generation'))).toBe(true);
  });

  test('schema or disclosure changes require a fresh consent and clear stale rows', async () => {
    const kv = makeKv();
    const store = makeContributorStore({ kv, makeGeneration: () => 'generation-new' });
    await store.enable();
    const old = structuredClone(kv.peek(CONTRIBUTOR_LOCAL_KEY) as any);
    old.consent.schemaVersion = CONTRIBUTOR_SCHEMA_VERSION - 1;
    old.consent.disclosureVersion = CONTRIBUTOR_DISCLOSURE_VERSION - 1;
    await kv.set(CONTRIBUTOR_LOCAL_KEY, old);
    expect(await store.status()).toMatchObject({
      enabled: false, diagnostic: 'contributor-reconsent-required', bytes: null,
    });
    await store.enable();
    expect(await store.status()).toMatchObject({ enabled: true, rowCount: 0, diagnostic: null });
  });

  test('failed atomic revoke is reported and cannot acknowledge a partial clear', async () => {
    const base = makeKv();
    const kv = {
      ...base,
      delete: async (_key: string) => { throw new Error('storage unavailable'); },
    };
    const store = makeContributorStore({ kv, makeGeneration: () => 'generation-1' });
    await store.enable();
    await store.recordWebSettlement(settlement('generation-1', 'turn-1'));
    await expect(store.disableAndClear()).rejects.toThrow('storage unavailable');
    expect(await store.status()).toMatchObject({ enabled: true, rowCount: 1 });
  });

  test('a newer stored version remains read-only with a deterministic diagnostic', async () => {
    const kv = makeKv({
      [CONTRIBUTOR_LOCAL_KEY]: { version: CONTRIBUTOR_LOCAL_VERSION + 1, opaque: 'preserve-me' },
    });
    const store = makeContributorStore({ kv });
    expect(await store.status()).toMatchObject({ diagnostic: 'contributor-state-newer-read-only' });
    await expect(store.recordWebSettlement(settlement('generation-1', 'turn-1')))
      .rejects.toBeInstanceOf(ContributorReadOnlyError);
    expect(kv.peek(CONTRIBUTOR_LOCAL_KEY)).toEqual({
      version: CONTRIBUTOR_LOCAL_VERSION + 1, opaque: 'preserve-me',
    });
  });
});
