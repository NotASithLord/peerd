// @ts-check
// Versioned handshake shared by the actor Worker and both browser hosts.

export const ACTOR_WORKER_PROTOCOL = 8;
export const ACTOR_WORKER_STARTUP_MS = 10_000;

export const ACTOR_REALM_FACT_KEYS = Object.freeze([
  'window', 'document', 'browser', 'chrome', 'fetch', 'xhr', 'webSocket',
  'eventSource', 'webTransport', 'rtc', 'worker', 'sharedWorker',
  'broadcastChannel', 'indexedDB', 'caches', 'opfsRoot', 'serviceWorker',
  'locks', 'sendBeacon', 'importScripts',
]);

/** @param {any} realm */
export const validActorWorkerRealm = (realm) => realm?.dedicatedWorker === true
  && ACTOR_REALM_FACT_KEYS.every((key) => realm?.[key] === false)
  && Object.keys(realm).length === ACTOR_REALM_FACT_KEYS.length + 1;
