// @ts-check
// Versioned handshake shared by the actor Worker and both browser hosts.

export const ACTOR_WORKER_PROTOCOL = 5;
export const ACTOR_WORKER_STARTUP_MS = 10_000;

/** @param {any} realm */
export const validActorWorkerRealm = (realm) => realm?.dedicatedWorker === true
  && realm?.window === false
  && realm?.document === false
  && realm?.browser === false
  && realm?.chrome === false;
