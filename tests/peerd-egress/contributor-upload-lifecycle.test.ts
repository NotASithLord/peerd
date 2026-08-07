import { describe, expect, test } from 'bun:test';
import {
  CONTRIBUTION_MAX_CLOCK_SKEW_MS, CONTRIBUTION_MAX_RETRY_ATTEMPTS, CONTRIBUTION_RETRY_BASE_MS,
  CONTRIBUTION_RETRY_MAX_MS, CONTRIBUTION_SEALED_RETENTION_MS,
  CONTRIBUTION_UPLOAD_STATE_KEY, CONTRIBUTION_UPLOAD_STATE_VERSION,
  ContributionUploadReadOnlyError, contributionRetryDelayMs,
  makeContributionUploadLifecycle,
} from '../../extension/peerd-egress/contributor-upload/lifecycle.js';
import {
  emptyContributorLocalState, recordContributorWebTurn,
  serializeContributorEnvelope, validateContributorEnvelopeBytes,
} from '../../extension/peerd-runtime/observability/contributor-metrics.js';

const ids = [
  '018f47a2-9a6d-4d23-8c10-7d86e9b15a22',
  'd44b7f88-4a4b-4f4d-bd77-79de6604820d',
];

const turn = () => ({
  feature: 'web_actor_surface', requested: 'code', resolved: 'code', fallback: 'none',
  browser: 'chrome', extensionVersion: '0.8.7', channel: 'preview',
  provider: 'anthropic', model: 'claude-haiku-4-5',
  outcome: 'completed', failure: 'none', durationMs: 2_000, tokens: 1_500,
});

const canonical = (turns = 1) => {
  let state = emptyContributorLocalState();
  for (let index = 0; index < turns; index += 1) {
    state = recordContributorWebTurn(state, turn());
  }
  return serializeContributorEnvelope(state).bytes;
};

const makeKv = (initial: Record<string, unknown> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    get: async (key: string) => structuredClone(values.get(key)),
    set: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    delete: async (key: string) => { values.delete(key); },
    peek: (key: string) => values.get(key),
  };
};

describe('sealed contribution lifecycle', () => {
  test('seals canonical bytes once with a random-v4 batch token and freezes the result', async () => {
    const kv = makeKv();
    const lifecycle = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => 1_000,
    });
    const sealed = await lifecycle.seal(canonical());
    expect(sealed).toMatchObject({ sealed: true, rowCount: 1 });
    if (!sealed.sealed) throw new Error('test setup failed to seal');
    expect(JSON.parse(sealed.bytes)).toMatchObject({ schemaVersion: 1, batchId: ids[0] });
    expect(await lifecycle.status()).toMatchObject({
      sealed: true, bytes: sealed.bytes, attempts: 0, nextAttemptAt: 1_000,
    });
    expect(await lifecycle.seal(canonical(2))).toEqual({
      sealed: false, reason: 'contribution-backlog-full',
    });
  });

  test('retries byte-identically and acceptance retires only the sealed snapshot', async () => {
    const kv = makeKv();
    let at = 5_000;
    const scheduled: number[] = [];
    const lifecycle = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => at, jitter: () => 0.5,
      scheduleRetry: async (when) => { scheduled.push(when); },
    });
    const firstSnapshot = canonical(1);
    const laterPendingSnapshot = canonical(2);
    const sealed = await lifecycle.seal(firstSnapshot);
    if (!sealed.sealed) throw new Error('test setup failed to seal');
    const sentBodies: string[] = [];
    const reject = async ({ body }: { body: string }) => {
      sentBodies.push(body);
      return { accepted: false, status: 503 };
    };
    expect((await lifecycle.send(reject)).accepted).toBe(false);
    const retryAt = (await lifecycle.status()).nextAttemptAt as number;
    expect(retryAt).toBe(5_000 + CONTRIBUTION_RETRY_BASE_MS);
    at = retryAt;
    expect((await lifecycle.send(reject)).accepted).toBe(false);
    expect(sentBodies).toEqual([sealed.bytes, sealed.bytes]);

    at = (await lifecycle.status()).nextAttemptAt as number;
    expect(await lifecycle.send(async ({ body }) => {
      sentBodies.push(body);
      return { accepted: true, status: 202 };
    })).toEqual({ sent: true, accepted: true, reason: null });
    expect(sentBodies.at(-1)).toBe(sealed.bytes);
    expect((await lifecycle.status()).sealed).toBe(false);
    expect(JSON.parse(laterPendingSnapshot).rows[0].actorTurns).toBe(2);
    // Every admitted request arms its crash-safety retry before network IO;
    // the final accepted request then cancels that alarm.
    expect(scheduled).toHaveLength(3);
  });

  test('manual and alarm admission share one in-flight operation', async () => {
    const kv = makeKv();
    let cancellations = 0;
    const lifecycle = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => 10,
      cancelSchedule: async () => { cancellations += 1; },
    });
    await lifecycle.seal(canonical());
    let calls = 0;
    let release!: (value: { accepted: boolean, status: number }) => void;
    const gate = new Promise<{ accepted: boolean, status: number }>((resolve) => { release = resolve; });
    const sendBatch = async () => { calls += 1; return gate; };
    const manual = lifecycle.send(sendBatch, { force: true });
    const alarm = lifecycle.send(sendBatch);
    expect(manual).toBe(alarm);
    await Promise.resolve();
    release({ accepted: true, status: 202 });
    expect(await manual).toMatchObject({ accepted: true });
    expect(calls).toBe(1);
    expect(cancellations).toBe(2);
  });

  test('a fresh lifecycle resumes the same sealed bytes after worker restart', async () => {
    const kv = makeKv();
    const deps = {
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => 100,
    };
    const beforeRestart = makeContributionUploadLifecycle(deps);
    const sealed = await beforeRestart.seal(canonical());
    if (!sealed.sealed) throw new Error('test setup failed to seal');
    const afterRestart = makeContributionUploadLifecycle(deps);
    let resumedBody = '';
    await afterRestart.send(async ({ body }) => {
      resumedBody = body;
      return { accepted: true, status: 202 };
    });
    expect(resumedBody).toBe(sealed.bytes);
  });

  test('revocation aborts live IO, cancels scheduling, and prevents late settlement resurrection', async () => {
    const kv = makeKv();
    let cancelled = 0;
    const lifecycle = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => 100,
      cancelSchedule: async () => { cancelled += 1; },
    });
    await lifecycle.seal(canonical());
    let admitted!: () => void;
    const started = new Promise<void>((resolve) => { admitted = resolve; });
    const pending = lifecycle.send(async ({ signal }) => {
      admitted();
      return await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    await started;
    expect(await lifecycle.revoke()).toMatchObject({ sealed: false });
    expect(await pending).toMatchObject({ accepted: false, reason: 'contribution-revoked' });
    expect(cancelled).toBe(1);
    expect(kv.peek(CONTRIBUTION_UPLOAD_STATE_KEY)).toBeUndefined();
  });

  test('a failed alarm cancellation cannot prevent revocation from clearing state', async () => {
    const kv = makeKv();
    const lifecycle = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => 100,
      cancelSchedule: async () => { throw new Error('alarms unavailable'); },
    });
    await lifecycle.seal(canonical());
    expect(await lifecycle.revoke()).toMatchObject({
      sealed: false, diagnostic: 'contribution-schedule-cancel-failed',
    });
    expect(kv.peek(CONTRIBUTION_UPLOAD_STATE_KEY)).toBeUndefined();
  });

  test('a failed durable clear rejects revocation and remains sealed after worker restart', async () => {
    const backingKv = makeKv();
    let cancellations = 0;
    const failingKv = {
      ...backingKv,
      delete: async () => { throw new Error('storage unavailable'); },
    };
    const beforeRestart = makeContributionUploadLifecycle({
      kv: failingKv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => 100,
      cancelSchedule: async () => { cancellations += 1; },
    });
    await beforeRestart.seal(canonical());

    await expect(beforeRestart.revoke()).rejects.toMatchObject({
      name: 'ContributionUploadStateError', code: 'contribution-revoke-clear-failed',
    });
    expect(cancellations).toBe(1);

    const afterRestart = makeContributionUploadLifecycle({
      kv: failingKv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[1], now: () => 100,
    });
    expect(await afterRestart.status()).toMatchObject({
      sealed: true, bytes: expect.any(String), rowCount: 1,
    });
  });

  test('manual send refuses network IO when its existing alarm cannot be cancelled', async () => {
    const kv = makeKv();
    let sends = 0;
    const lifecycle = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => 100,
      cancelSchedule: async () => { throw new Error('alarms unavailable'); },
    });
    await lifecycle.seal(canonical());
    expect(await lifecycle.send(async () => {
      sends += 1;
      return { accepted: true, status: 202 };
    }, { force: true })).toEqual({
      sent: false, accepted: false, reason: 'contribution-alarm-cancel-failed',
    });
    expect(sends).toBe(0);
  });

  test('accepted settlement clears state even if alarm cancellation reports failure', async () => {
    const kv = makeKv();
    const lifecycle = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => 100,
      cancelSchedule: async () => { throw new Error('alarms unavailable'); },
    });
    await lifecycle.seal(canonical());
    expect(await lifecycle.send(async () => ({ accepted: true, status: 202 }))).toEqual({
      sent: true, accepted: true, reason: null,
      diagnostic: 'contribution-alarm-cancel-failed',
    });
    expect(kv.peek(CONTRIBUTION_UPLOAD_STATE_KEY)).toBeUndefined();
  });

  test('schedule failure leaves no persisted scheduled retry and performs no network IO', async () => {
    const kv = makeKv();
    let sends = 0;
    let cancels = 0;
    const lifecycle = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => 100,
      scheduleRetry: async () => { throw new Error('alarm write failed'); },
      cancelSchedule: async () => { cancels += 1; },
    });
    await lifecycle.seal(canonical());
    expect(await lifecycle.send(async () => {
      sends += 1;
      return { accepted: true, status: 202 };
    })).toEqual({ sent: false, accepted: false, reason: 'contribution-schedule-failed' });
    expect(sends).toBe(0);
    expect(cancels).toBe(1);
    expect(await lifecycle.status()).toMatchObject({
      sealed: true, nextAttemptAt: null, diagnostic: 'contribution-retry-unscheduled',
    });
  });

  test('revocation epoch wins while alarm scheduling is suspended, before network IO', async () => {
    const kv = makeKv();
    let started!: () => void;
    let release!: () => void;
    const scheduling = new Promise<void>((resolve) => { release = resolve; });
    const scheduleStarted = new Promise<void>((resolve) => { started = resolve; });
    let sends = 0;
    const lifecycle = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => 100,
      scheduleRetry: async () => { started(); await scheduling; },
    });
    await lifecycle.seal(canonical());
    const pending = lifecycle.send(async () => {
      sends += 1;
      return { accepted: true, status: 202 };
    });
    await scheduleStarted;
    const revoked = lifecycle.revoke();
    release();
    expect(await pending).toMatchObject({ sent: false, reason: 'contribution-revoked' });
    expect(await revoked).toMatchObject({ sealed: false });
    expect(sends).toBe(0);
    expect(kv.peek(CONTRIBUTION_UPLOAD_STATE_KEY)).toBeUndefined();
  });

  test('the disabled latch rejects inverse-order seal/send while revoke is still cancelling', async () => {
    const kv = makeKv();
    let releaseCancel!: () => void;
    const delayedCancel = new Promise<void>((resolve) => { releaseCancel = resolve; });
    let schedules = 0;
    let sends = 0;
    const lifecycle = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => 100,
      scheduleRetry: async () => { schedules += 1; },
      cancelSchedule: async () => { await delayedCancel; },
    });
    await lifecycle.seal(canonical());
    const revoking = lifecycle.revoke();
    expect(await lifecycle.send(async () => {
      sends += 1;
      return { accepted: true, status: 202 };
    })).toEqual({ sent: false, accepted: false, reason: 'contribution-revoked' });
    expect(await lifecycle.seal(canonical(2))).toEqual({
      sealed: false, reason: 'contribution-revoked',
    });
    expect(schedules).toBe(0);
    expect(sends).toBe(0);
    releaseCancel();
    await revoking;
    expect(kv.peek(CONTRIBUTION_UPLOAD_STATE_KEY)).toBeUndefined();
  });

  test('durable revocation precedes delayed alarm cancellation across a worker restart', async () => {
    const kv = makeKv();
    let cancelStarted!: () => void;
    let releaseCancel!: () => void;
    const observedCancel = new Promise<void>((resolve) => { cancelStarted = resolve; });
    const delayedCancel = new Promise<void>((resolve) => { releaseCancel = resolve; });
    let schedules = 0;
    let sends = 0;
    const beforeRestart = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => 100,
      scheduleRetry: async () => { schedules += 1; },
      cancelSchedule: async () => { cancelStarted(); await delayedCancel; },
    });
    await beforeRestart.seal(canonical());

    const revoking = beforeRestart.revoke();
    await observedCancel;
    expect(kv.peek(CONTRIBUTION_UPLOAD_STATE_KEY)).toBeUndefined();

    const afterRestart = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[1], now: () => 100,
      scheduleRetry: async () => { schedules += 1; },
    });
    expect(await afterRestart.send(async () => {
      sends += 1;
      return { accepted: true, status: 202 };
    })).toEqual({
      sent: false, accepted: false, reason: 'contribution-no-sealed-batch',
    });
    expect(schedules).toBe(0);
    expect(sends).toBe(0);

    releaseCancel();
    expect(await revoking).toMatchObject({ sealed: false });
  });

  test('attempt admission is durable before IO and a restarted lifecycle resumes without resetting it', async () => {
    const kv = makeKv();
    let scheduleStarted!: () => void;
    let releaseSchedule!: () => void;
    const blockedSchedule = new Promise<void>((resolve) => { releaseSchedule = resolve; });
    const observedSchedule = new Promise<void>((resolve) => { scheduleStarted = resolve; });
    const first = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => 100, jitter: () => 0.5,
      scheduleRetry: async () => { scheduleStarted(); await blockedSchedule; },
    });
    const sealed = await first.seal(canonical());
    if (!sealed.sealed) throw new Error('test setup failed to seal');
    let firstNetworkCalls = 0;
    const abandoned = first.send(async () => {
      firstNetworkCalls += 1;
      return { accepted: true, status: 202 };
    });
    await observedSchedule;
    const admitted = kv.peek(CONTRIBUTION_UPLOAD_STATE_KEY) as any;
    expect(admitted.sealed.attempts).toBe(1);
    expect(admitted.sealed.admittedAt).toBe(100);
    expect(admitted.sealed.dispatchStage).toBe('admitted');
    expect(admitted.sealed.nextAttemptAt).toBeNull();

    let resumedBody = '';
    const restarted = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[1], now: () => 100, jitter: () => 0.5,
    });
    expect(await restarted.send(async ({ body }) => {
      resumedBody = body;
      return { accepted: true, status: 202 };
    })).toMatchObject({ accepted: true });
    expect(resumedBody).toBe(sealed.bytes);
    expect(firstNetworkCalls).toBe(0);
    releaseSchedule();
    expect(await abandoned).toMatchObject({ accepted: false });
  });

  test('a dispatched final attempt cannot replay across repeated worker restarts', async () => {
    const kv = makeKv();
    const lifecycle = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => 100, jitter: () => 0.5,
    });
    await lifecycle.seal(canonical());
    for (let attempt = 1; attempt < CONTRIBUTION_MAX_RETRY_ATTEMPTS; attempt += 1) {
      await lifecycle.send(async () => { throw new Error('offline'); }, { force: true });
    }
    let releaseFinal!: (result: { accepted: boolean, status: number }) => void;
    let finalStarted!: () => void;
    const finalGate = new Promise<{ accepted: boolean, status: number }>((resolve) => {
      releaseFinal = resolve;
    });
    const observedFinal = new Promise<void>((resolve) => { finalStarted = resolve; });
    let finalNetworkCalls = 0;
    const final = lifecycle.send(async () => {
      finalNetworkCalls += 1;
      finalStarted();
      return finalGate;
    }, { force: true });
    await observedFinal;
    const dispatched = kv.peek(CONTRIBUTION_UPLOAD_STATE_KEY) as any;
    expect(dispatched.sealed.attempts).toBe(CONTRIBUTION_MAX_RETRY_ATTEMPTS);
    expect(dispatched.sealed.dispatchStage).toBe('dispatched');

    let restartedSchedules = 0;
    let restartedNetworkCalls = 0;
    for (let restart = 0; restart < 3; restart += 1) {
      const restarted = makeContributionUploadLifecycle({
        kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
        makeBatchId: () => ids[1], now: () => 100,
        scheduleRetry: async () => { restartedSchedules += 1; },
      });
      expect(await restarted.send(async () => {
        restartedNetworkCalls += 1;
        return { accepted: true, status: 202 };
      }, { force: true })).toEqual({
        sent: false, accepted: false, reason: 'contribution-retry-exhausted',
      });
    }
    expect(finalNetworkCalls).toBe(1);
    expect(restartedNetworkCalls).toBe(0);
    expect(restartedSchedules).toBe(0);
    releaseFinal({ accepted: false, status: 503 });
    await final;

    const afterSettlement = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[1], now: () => 100,
    });
    expect(await afterSettlement.send(async () => {
      restartedNetworkCalls += 1;
      return { accepted: true, status: 202 };
    }, { force: true })).toEqual({
      sent: false, accepted: false, reason: 'contribution-retry-exhausted',
    });
    expect(restartedNetworkCalls).toBe(0);
  });

  test('every durable load revalidates the full closed row schema', async () => {
    const kv = makeKv();
    const lifecycle = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => 100,
    });
    await lifecycle.seal(canonical());
    const stored = structuredClone(kv.peek(CONTRIBUTION_UPLOAD_STATE_KEY)) as any;
    stored.sealed.bytes = JSON.stringify({
      schemaVersion: 1,
      batchId: ids[0],
      rows: [{ url: 'https://secret.invalid/private', prompt: 'raw content' }],
    });
    stored.sealed.rowCount = 1;
    await kv.set(CONTRIBUTION_UPLOAD_STATE_KEY, stored);
    expect(await lifecycle.status()).toMatchObject({
      sealed: false, diagnostic: 'contribution-upload-state-invalid',
    });
    let sends = 0;
    await expect(lifecycle.send(async () => {
      sends += 1;
      return { accepted: true, status: 202 };
    })).rejects.toMatchObject({ code: 'contribution-upload-state-invalid' });
    expect(sends).toBe(0);
  });

  test('a malformed accepted result cannot retire the sealed batch', async () => {
    const kv = makeKv();
    const lifecycle = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => 100,
    });
    await lifecycle.seal(canonical());
    expect(await lifecycle.send(async () => ({ accepted: true, status: 200 }))).toMatchObject({
      accepted: false, reason: 'contribution-send-failed',
    });
    expect((await lifecycle.status()).sealed).toBe(true);
  });

  test('backoff, retry count, and retained backlog are bounded by named constants', async () => {
    expect(contributionRetryDelayMs(1, 0.5)).toBe(CONTRIBUTION_RETRY_BASE_MS);
    expect(contributionRetryDelayMs(1_000, 1)).toBe(CONTRIBUTION_RETRY_MAX_MS);
    const kv = makeKv();
    let at = 1_000;
    const lifecycle = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => at, jitter: () => 0.5,
    });
    await lifecycle.seal(canonical());
    for (let attempt = 0; attempt < CONTRIBUTION_MAX_RETRY_ATTEMPTS; attempt += 1) {
      await lifecycle.send(async () => { throw new Error('offline'); }, { force: true });
      const state = await lifecycle.status();
      if (state.nextAttemptAt !== null) at = state.nextAttemptAt;
    }
    expect(await lifecycle.status()).toMatchObject({
      sealed: true, attempts: CONTRIBUTION_MAX_RETRY_ATTEMPTS,
      nextAttemptAt: null, diagnostic: 'contribution-retry-exhausted',
    });
    expect(await lifecycle.send(async () => ({ accepted: true, status: 202 }))).toEqual({
      sent: false, accepted: false, reason: 'contribution-retry-exhausted',
    });
    expect(await lifecycle.send(
      async () => ({ accepted: true, status: 202 }), { force: true },
    )).toEqual({ sent: false, accepted: false, reason: 'contribution-retry-exhausted' });
  });

  test('retention expiry clears the only sealed slot', async () => {
    const kv = makeKv();
    let at = 0;
    let cancellations = 0;
    const lifecycle = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => at,
      cancelSchedule: async () => { cancellations += 1; },
    });
    await lifecycle.seal(canonical());
    at = CONTRIBUTION_SEALED_RETENTION_MS;
    expect(await lifecycle.status()).toMatchObject({
      sealed: false, diagnostic: 'contribution-sealed-batch-expired',
    });
    expect(kv.peek(CONTRIBUTION_UPLOAD_STATE_KEY)).toBeUndefined();
    expect(cancellations).toBe(1);
  });

  test('retention is below the collector dedupe horizon and force cannot bypass expiry', async () => {
    expect(CONTRIBUTION_SEALED_RETENTION_MS).toBeLessThanOrEqual(5 * 24 * 60 * 60 * 1_000);
    const kv = makeKv();
    let at = 0;
    let sends = 0;
    const lifecycle = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => at,
    });
    await lifecycle.seal(canonical());
    at = CONTRIBUTION_SEALED_RETENTION_MS;
    expect(await lifecycle.send(async () => {
      sends += 1;
      return { accepted: true, status: 202 };
    }, { force: true })).toEqual({
      sent: false, accepted: false, reason: 'contribution-sealed-batch-expired',
    });
    expect(sends).toBe(0);
  });

  test('rejects far-future sealed and retry timestamps', async () => {
    const seedKv = makeKv();
    const seed = makeContributionUploadLifecycle({
      kv: seedKv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[0], now: () => 100,
    });
    await seed.seal(canonical());
    const valid = structuredClone(seedKv.peek(CONTRIBUTION_UPLOAD_STATE_KEY)) as any;
    for (const mutateFuture of [
      (state: any) => {
        state.sealed.sealedAt = 100 + CONTRIBUTION_MAX_CLOCK_SKEW_MS + 1;
        state.sealed.nextAttemptAt = state.sealed.sealedAt;
      },
      (state: any) => {
        state.sealed.nextAttemptAt = 100 + CONTRIBUTION_RETRY_MAX_MS
          + CONTRIBUTION_MAX_CLOCK_SKEW_MS + 1;
      },
    ]) {
      const stored = structuredClone(valid);
      mutateFuture(stored);
      const kv = makeKv({ [CONTRIBUTION_UPLOAD_STATE_KEY]: stored });
      const lifecycle = makeContributionUploadLifecycle({
        kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
        makeBatchId: () => ids[1], now: () => 100,
      });
      expect(await lifecycle.status()).toMatchObject({
        sealed: false, diagnostic: 'contribution-upload-state-invalid',
      });
    }
  });

  test('newer state is diagnostic/read-only while explicit revoke can still erase it', async () => {
    const kv = makeKv({
      [CONTRIBUTION_UPLOAD_STATE_KEY]: {
        version: CONTRIBUTION_UPLOAD_STATE_VERSION + 1,
        sealed: { opaqueFutureState: true },
      },
    });
    const lifecycle = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => ids[1], now: () => 1,
    });
    expect(await lifecycle.status()).toMatchObject({
      sealed: false, diagnostic: 'contribution-upload-state-newer-read-only',
    });
    await expect(lifecycle.seal(canonical())).rejects.toBeInstanceOf(ContributionUploadReadOnlyError);
    await lifecycle.revoke();
    expect(kv.peek(CONTRIBUTION_UPLOAD_STATE_KEY)).toBeUndefined();
  });

  test('rejects noncanonical bytes and non-v4 batch identifiers before persistence', async () => {
    const kv = makeKv();
    const lifecycle = makeContributionUploadLifecycle({
      kv, validateCanonicalBytes: validateContributorEnvelopeBytes,
      makeBatchId: () => 'stable-install-id', now: () => 1,
    });
    await expect(lifecycle.seal(` ${canonical()}`)).rejects.toThrow();
    await expect(lifecycle.seal(canonical())).rejects.toMatchObject({
      code: 'contribution-batch-id-invalid',
    });
    expect(kv.peek(CONTRIBUTION_UPLOAD_STATE_KEY)).toBeUndefined();
  });
});
