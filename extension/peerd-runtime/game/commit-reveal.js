// @ts-check
// peerd-runtime/game/commit-reveal.js — the fairness primitive every game
// reuses: commit to a value now, reveal it later, and nobody can lie about
// what they committed or steer a jointly-derived seed.
//
// Pure (WebCrypto only — runs in a page, a worker, the SW, or Bun): no IO,
// no state. Two uses in the match protocol:
//   1. the SEED — each player commits a random nonce, reveals after both
//      commits are in, and the match seed is a hash over BOTH nonces, so
//      neither side can pick the puzzle;
//   2. the ANSWER — commit hash(answer ‖ salt) first, reveal only after the
//      opponent has committed, so answers are simultaneous and un-copyable.
//
// why domain-prefixed hashing: a commit must never be re-usable as a seed
// input (or vice versa) — cross-protocol replay is the classic commit-scheme
// footgun, and a fixed context string per use closes it.

import { utf8, toHex } from '/shared/bundle/bytes.js';

const COMMIT_CONTEXT = 'peerd-game:commit:v1';
const SEED_CONTEXT = 'peerd-game:seed:v1';

/** @param {string} text @returns {Promise<string>} lowercase hex sha-256 */
const sha256Hex = async (text) =>
  toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(text))));

/** Random lowercase-hex string (2·bytes chars). @param {number} [bytes] */
export const randomHex = (bytes = 16) =>
  toHex(crypto.getRandomValues(new Uint8Array(bytes)));

/**
 * Commit to a value. The salt is what makes the commit hiding — a low-entropy
 * value (a small answer) is unguessable only because the salt is random.
 * @param {string} value @param {string} saltHex
 * @returns {Promise<string>} the commit (hex digest)
 */
export const makeCommit = (value, saltHex) =>
  sha256Hex(`${COMMIT_CONTEXT}\n${saltHex}\n${String(value)}`);

/**
 * Check a reveal against its commit. Timing-safe comparison is not needed —
 * both strings are public by the time this runs.
 * @param {{ commit: string, value: string, saltHex: string }} args
 */
export const verifyReveal = async ({ commit, value, saltHex }) =>
  typeof commit === 'string' && commit === await makeCommit(value, saltHex);

/**
 * Combine both players' revealed nonces into the joint match seed. Nonces are
 * SORTED before hashing so both sides derive the identical seed regardless of
 * arrival order or role; the matchId binds the seed to this one match.
 * @param {string} matchId @param {string[]} nonces
 * @returns {Promise<string>} seed (hex)
 */
export const combineSeed = (matchId, nonces) =>
  sha256Hex(`${SEED_CONTEXT}\n${String(matchId)}\n${nonces.map(String).sort().join('\n')}`);
