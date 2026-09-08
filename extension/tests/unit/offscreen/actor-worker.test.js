// @ts-check
// Real packaged realm proof for the isolated actor Worker.

import { describe, it, expect } from '../../framework.js';
import {
  ACTOR_REALM_FACT_KEYS,
  ACTOR_WORKER_PROTOCOL,
} from '/offscreen/actor-worker-protocol.js';

const waitFor = (/** @type {Worker} */ worker, /** @type {string} */ type) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`actor Worker did not send ${type}`)), 10_000);
    const listener = (/** @type {MessageEvent} */ event) => {
      if (event.data?.type === 'error') {
        clearTimeout(timer);
        worker.removeEventListener('message', listener);
        reject(new Error(String(event.data.error)));
      } else if (event.data?.type === type) {
        clearTimeout(timer);
        worker.removeEventListener('message', listener);
        resolve(event.data);
      }
    };
    worker.addEventListener('message', listener);
  });

describe('sealed actor Worker (real browser realm)', () => {
  it('removes prototype-recoverable ambient egress before semantic modules load', async () => {
    const worker = new Worker('/offscreen/actor-worker.js', {
      type: 'module', name: 'peerd-actor-seal-test',
    });
    try {
      const ready = /** @type {any} */ (await waitFor(worker, 'ready'));
      expect(ready.protocol).toBe(ACTOR_WORKER_PROTOCOL);
      expect(Object.keys(ready.realm).sort()).toEqual([
        'dedicatedWorker', ...ACTOR_REALM_FACT_KEYS,
      ].sort());
      for (const key of ACTOR_REALM_FACT_KEYS) expect(ready.realm[key]).toBe(false);

      const response = waitFor(worker, 'probe-response');
      worker.postMessage({
        type: 'probe', protocol: ACTOR_WORKER_PROTOCOL,
        rid: 'actor-seal-probe', canaryName: '__actor_host_only_canary__',
      });
      const probed = /** @type {any} */ (await response);
      expect(probed.canaryAbsent).toBe(true);
      expect(probed.prototypeFetchBlocked).toBe(true);
      expect(probed.prototypeStorageBlocked).toBe(true);
      for (const key of ACTOR_REALM_FACT_KEYS) expect(probed.realm[key]).toBe(false);
    } finally {
      worker.terminate();
    }
  });
});
