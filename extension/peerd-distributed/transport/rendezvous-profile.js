// @ts-check
// Shared negotiation vocabulary, without importing the server reducer into
// browser clients. Server resource ceilings remain owned by signaling.js.
export const SPARSE_PUBLIC_PROFILE = 'sparse-public-v1';
export const PUBLIC_ROOM = 'peerd/base/1';
export const INTRODUCTION_LIMIT = 16;
export const SAMPLE_INTERVAL_MS = 10_000;
/** @param {unknown} key @param {unknown} profile */
export const sparsePublicProfile = (key, profile) =>
  key === PUBLIC_ROOM && profile === SPARSE_PUBLIC_PROFILE ? SPARSE_PUBLIC_PROFILE : null;
