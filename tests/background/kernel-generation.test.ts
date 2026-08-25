import { describe, expect, test } from 'bun:test';
import {
  KERNEL_GENERATION_SESSION_KEY,
  makeKernelGenerationLifecycle,
} from '../../extension/background/kernel-cold-receipts.js';
import {
  createKernelIdentity,
  KERNEL_IDENTITY_SCHEMA,
  kernelIdentityMatches,
  kernelIdentityIsSuccessor,
  parseKernelIdentity,
} from '../../extension/shared/kernel-identity.js';

const BUILD = `0.7.0:${'a'.repeat(64)}`;

const makeSession = () => {
  const values = new Map<string, unknown>();
  return {
    values,
    sessionGet: async (key: string) => values.get(key),
    sessionSet: async (key: string, value: unknown) => { values.set(key, value); },
  };
};

const ids = (...values: string[]) => {
  const queue = [...values];
  return () => {
    const value = queue.shift();
    if (!value) throw new Error('deterministic ID fixture exhausted');
    return value;
  };
};

const lifecycle = (
  session: any,
  bootId: string,
  kernelEpoch: string,
  buildId = BUILD,
) => makeKernelGenerationLifecycle({
  session,
  identity: createKernelIdentity({ buildId, newId: ids(bootId, kernelEpoch) }),
});

describe('authority kernel generation identity', () => {
  test('parses only the exact schema/build/boot/epoch identity', () => {
    const identity = {
      schema: KERNEL_IDENTITY_SCHEMA,
      buildId: BUILD,
      bootId: 'boot-identity-a',
      kernelEpoch: 'kernel-epoch-a',
    } as const;
    expect(parseKernelIdentity(identity)).toEqual(identity);
    expect(kernelIdentityMatches(parseKernelIdentity(identity), identity)).toBe(true);
    expect(parseKernelIdentity({ ...identity, schema: 2 })).toBeNull();
    expect(parseKernelIdentity({ ...identity, buildId: 'short' })).toBeNull();
    expect(parseKernelIdentity({ ...identity, bootId: 'bad\nboot' })).toBeNull();
  });

  test('binding overwrites forged fields with the current immutable identity', async () => {
    const generation = lifecycle(makeSession(), 'boot-current-a', 'kernel-current-a');
    await generation.ready();
    const envelope = generation.bind({
      type: 'state', schema: 999, buildId: 'forged-build',
      bootId: 'forged-boot', kernelEpoch: 'forged-kernel',
    });
    expect(envelope).toEqual({ type: 'state', ...generation.identity });
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(generation.identity)).toBe(true);
  });

  test('uses the one injected identity without minting another', async () => {
    const minted: string[] = [];
    const identity = createKernelIdentity({
      buildId: BUILD,
      newId: () => {
        const value = minted.length === 0 ? 'boot-injected-aa' : 'kernel-injected-a';
        minted.push(value);
        return value;
      },
    });
    const generation = makeKernelGenerationLifecycle({
      session: makeSession(), identity,
    });
    await generation.ready();
    expect(generation.identity).toEqual(identity);
    expect(generation.bind({ ok: true })).toMatchObject(identity);
    expect(minted).toEqual(['boot-injected-aa', 'kernel-injected-a']);
    expect(kernelIdentityIsSuccessor(identity, {
      ...identity, kernelEpoch: 'independently-minted-epoch',
    })).toBe(false);
  });
});

describe('authority lifecycle reconciliation', () => {
  test('overwrites the obsolete pending-grant envelope with one canonical identity', async () => {
    const session = makeSession();
    session.values.set(KERNEL_GENERATION_SESSION_KEY, {
      schema: KERNEL_IDENTITY_SCHEMA,
      buildId: BUILD,
      bootId: 'boot-legacy-grants',
      kernelEpoch: 'kernel-legacy-grants',
      startedAt: 100,
      pendingGrantCount: 7,
    });
    const replacement = lifecycle(session, 'boot-replace-aa', 'kernel-replace-a');
    await replacement.ready();
    expect(session.values.get(KERNEL_GENERATION_SESSION_KEY)).toEqual(replacement.identity);
    expect(session.values.get(KERNEL_GENERATION_SESSION_KEY)).not.toHaveProperty('startedAt');
    expect(session.values.get(KERNEL_GENERATION_SESSION_KEY)).not.toHaveProperty('pendingGrantCount');
  });

  test('a replacement retires the predecessor through the durable claim alone', async () => {
    const session = makeSession();
    const prior = lifecycle(session, 'boot-prior-aaaa', 'kernel-prior-aa');
    await prior.ready();
    const replacement = lifecycle(session, 'boot-replace-aa', 'kernel-replace-a');
    await replacement.ready();
    expect(await prior.reconcile()).toEqual({
      ok: false,
      error: 'kernel-generation-retired',
    });
    await expect(prior.bindCurrent({ ok: true })).rejects.toThrow('kernel-generation-retired');
    expect(Object.keys(prior).sort()).toEqual([
      'bind', 'bindCurrent', 'identity', 'ready', 'reconcile',
    ]);
  });

  test('a different build has the same exact successor fence', async () => {
    const session = makeSession();
    const oldBuild = lifecycle(
      session, 'boot-build-old', 'kernel-build-old', `0.6.9:${'b'.repeat(64)}`,
    );
    await oldBuild.ready();
    const current = lifecycle(session, 'boot-build-new', 'kernel-build-new');
    await current.ready();
    await expect(oldBuild.bindCurrent({ ok: true })).rejects.toThrow('kernel-generation-retired');
  });

  test('an interleaved claimant loses before it can publish or bind', async () => {
    const values = new Map<string, unknown>();
    let releaseFirst!: () => void;
    let firstStored!: () => void;
    const firstStoredPromise = new Promise<void>((resolve) => { firstStored = resolve; });
    const releaseFirstPromise = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const session = {
      sessionGet: async (key: string) => values.get(key),
      sessionSet: async (key: string, value: any) => {
        values.set(key, value);
        if (value.bootId === 'boot-race-first') {
          firstStored();
          await releaseFirstPromise;
        }
      },
    };
    const first = lifecycle(session, 'boot-race-first', 'kernel-race-first');
    await firstStoredPromise;
    const successor = lifecycle(session, 'boot-race-second', 'kernel-race-second');
    await successor.ready();
    releaseFirst();
    await expect(first.ready()).rejects.toThrow('kernel-generation-claim-lost');
    await expect(first.reconcile()).rejects.toThrow('kernel-generation-claim-lost');
    expect(() => first.bind({ ok: true })).toThrow('kernel-generation-retired');
  });

  test('malformed compatibility fields cannot poison a new claim', async () => {
    const session = makeSession();
    session.values.set(KERNEL_GENERATION_SESSION_KEY, {
      schema: KERNEL_IDENTITY_SCHEMA,
      buildId: BUILD,
      bootId: 'boot-malformed-old',
      kernelEpoch: 'kernel-malformed-old',
      startedAt: -1,
      pendingGrantCount: 'many',
    });
    const current = lifecycle(session, 'boot-clean-new', 'kernel-clean-new');
    await current.ready();
    expect(session.values.get(KERNEL_GENERATION_SESSION_KEY)).toEqual(current.identity);
  });
});
