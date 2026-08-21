import { describe, expect, test } from 'bun:test';
import {
  KERNEL_GENERATION_SCHEMA,
  KERNEL_GENERATION_SESSION_KEY,
  kernelGenerationMatches,
  makeKernelGenerationLifecycle,
  parseKernelGenerationIdentity,
} from '../../extension/background/kernel-generation.js';
import {
  createKernelIdentity,
  kernelIdentityIsSuccessor,
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

describe('authority kernel generation identity', () => {
  test('parses only the exact schema/build/boot/epoch identity', () => {
    const identity = {
      schema: KERNEL_GENERATION_SCHEMA,
      buildId: BUILD,
      bootId: 'boot-identity-a',
      kernelEpoch: 'kernel-epoch-a',
    } as const;
    expect(parseKernelGenerationIdentity(identity)).toEqual(identity);
    expect(kernelGenerationMatches(parseKernelGenerationIdentity(identity), identity)).toBe(true);
    expect(parseKernelGenerationIdentity({ ...identity, schema: 2 })).toBeNull();
    expect(parseKernelGenerationIdentity({ ...identity, buildId: 'short' })).toBeNull();
    expect(parseKernelGenerationIdentity({ ...identity, bootId: 'bad\nboot' })).toBeNull();
  });

  test('binding overwrites forged fields with the current immutable identity', async () => {
    const generation = makeKernelGenerationLifecycle({
      session: makeSession(),
      build: BUILD,
      newId: ids('boot-current-a', 'kernel-current-a'),
      now: () => 123,
    });
    await generation.ready();
    const envelope = generation.bind({
      type: 'state', schema: 999, buildId: 'forged-build',
      bootId: 'forged-boot', kernelEpoch: 'forged-kernel',
    });
    expect(envelope).toEqual({ type: 'state', ...generation.identity });
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(generation.identity)).toBe(true);
  });

  test('an injected identity is the only minted identity', async () => {
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
      newId: () => { throw new Error('identity must not be reminted'); },
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

describe.each(['Chrome service worker', 'Firefox event page'])(
  'authority lifecycle reconciliation: %s',
  () => {
    test('reports and clears legacy pending grants during replacement', async () => {
      const session = makeSession();
      session.values.set(KERNEL_GENERATION_SESSION_KEY, {
        schema: KERNEL_GENERATION_SCHEMA,
        buildId: BUILD,
        bootId: 'boot-legacy-grants',
        kernelEpoch: 'kernel-legacy-grants',
        startedAt: 100,
        pendingGrantCount: 7,
      });
      const replacement = makeKernelGenerationLifecycle({
        session,
        build: BUILD,
        newId: ids('boot-replace-aa', 'kernel-replace-a'),
        now: () => 200,
      });
      expect(await replacement.ready()).toEqual({
        replaced: true,
        priorBuildMatched: true,
        invalidatedPendingGrantCount: 7,
      });
      expect(session.values.get(KERNEL_GENERATION_SESSION_KEY)).toMatchObject({
        ...replacement.identity,
        startedAt: 200,
        pendingGrantCount: 0,
      });
    });

    test('a replacement retires the old generation without a local grant registry', async () => {
      const session = makeSession();
      const prior = makeKernelGenerationLifecycle({
        session,
        build: BUILD,
        newId: ids('boot-prior-aaaa', 'kernel-prior-aa'),
        now: () => 100,
      });
      await prior.ready();
      const replacement = makeKernelGenerationLifecycle({
        session,
        build: BUILD,
        newId: ids('boot-replace-aa', 'kernel-replace-a'),
        now: () => 200,
      });
      expect(await replacement.ready()).toEqual({
        replaced: true,
        priorBuildMatched: true,
        invalidatedPendingGrantCount: 0,
      });
      expect(await prior.reconcile()).toEqual({
        ok: false,
        error: 'kernel-generation-retired',
        invalidatedPendingGrantCount: 0,
      });
      expect(prior.retired()).toBe(true);
      expect(prior.bindCurrent({ ok: true })).rejects.toThrow('kernel-generation-retired');
      expect(Object.keys(prior).sort()).toEqual([
        'bind', 'bindCurrent', 'identity', 'ready', 'reconcile', 'reconciliation', 'retired',
      ]);
    });

    test('a different build is replaced but never treated as compatible', async () => {
      const session = makeSession();
      const oldBuild = makeKernelGenerationLifecycle({
        session,
        build: `0.6.9:${'b'.repeat(64)}`,
        newId: ids('boot-build-old', 'kernel-build-old'),
      });
      await oldBuild.ready();
      const current = makeKernelGenerationLifecycle({
        session,
        build: BUILD,
        newId: ids('boot-build-new', 'kernel-build-new'),
      });
      expect(await current.ready()).toEqual({
        replaced: true,
        priorBuildMatched: false,
        invalidatedPendingGrantCount: 0,
      });
      expect(oldBuild.bindCurrent({ ok: true })).rejects.toThrow('kernel-generation-retired');
    });
  },
);
