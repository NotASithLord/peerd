import { describe, expect, test } from 'bun:test';
import { assertDirectControllerPhysicalReport } from '../../scripts/firefox/direct-controller-physical.mjs';

const workerResult = (generation: string) => ({
  ok: true,
  phase: 'settled',
  outcomeKnown: true,
  capability: 'probe.read',
  payload: { value: 7 },
  authority: { ownerId: 'root:firefox-physical', replayClass: 'E' },
  generation,
  realm: {
    browser: 'undefined',
    chrome: 'undefined',
    document: 'undefined',
    window: 'undefined',
    fetchAttempt: { blocked: true },
    workerAttempt: { blocked: true },
    indexedDbAttempt: { blocked: true },
    postMessageAttempt: { blocked: true },
    fetchSealed: true,
    workerSealed: true,
    indexedDbSealed: true,
    postMessageSealed: true,
    navigatorStorage: 'undefined',
    navigatorServiceWorker: 'undefined',
    navigatorLocks: 'undefined',
  },
});

const report = () => ({
  first: {
    protocol: 2, bootId: 'boot-a', epoch: 'epoch-a', result: workerResult('worker-a'),
  },
  afterWorkerIdle: {
    protocol: 2, bootId: 'boot-a', epoch: 'epoch-a', result: workerResult('worker-b'),
  },
  retirement: {
    protocol: 2,
    bootId: 'boot-a',
    retiredEpoch: 'epoch-a',
    replacementEpoch: 'epoch-b',
    retiredRefusal: {
      ok: false,
      code: 'controller-channel-closed',
      phase: 'startup',
      outcomeKnown: true,
    },
    result: workerResult('worker-c'),
  },
  afterEventPageIdle: {
    protocol: 2,
    bootId: 'boot-b',
    epoch: 'epoch-c',
    result: workerResult('worker-d'),
  },
});

describe('packaged Firefox protocol-v2 physical result gate', () => {
  test('requires sealing, Worker replacement, event-page discard and retired-epoch refusal', () => {
    expect(assertDirectControllerPhysicalReport(report())).toBeTruthy();
  });

  test('fails closed if a sealed fact or lifecycle boundary is missing', () => {
    const unsealed = report();
    unsealed.first.result.realm.fetchSealed = false;
    expect(() => assertDirectControllerPhysicalReport(unsealed)).toThrow('sealed protocol-v2 Worker');

    const workerReused = report();
    workerReused.afterWorkerIdle.result.generation = workerReused.first.result.generation;
    expect(() => assertDirectControllerPhysicalReport(workerReused)).toThrow('not replaced');

    const pageReused = report();
    pageReused.afterEventPageIdle.bootId = pageReused.retirement.bootId;
    expect(() => assertDirectControllerPhysicalReport(pageReused)).toThrow('not discarded');

    const retiredAccepted = report();
    retiredAccepted.retirement.retiredRefusal = {
      ok: true,
      code: 'accepted',
      phase: 'settled',
      outcomeKnown: true,
    };
    expect(() => assertDirectControllerPhysicalReport(retiredAccepted))
      .toThrow('retired epoch accepted');

    const oldProtocol = report();
    oldProtocol.afterEventPageIdle.protocol = 1;
    expect(() => assertDirectControllerPhysicalReport(oldProtocol)).toThrow('protocol v2');
  });
});
