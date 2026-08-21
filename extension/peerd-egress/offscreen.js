// @ts-check
// Offscreen-only egress surface. Keep the sealed vault worker out of the
// browser-backed background barrel and its unrelated network/storage owners.
export { createVault } from './vault/vault.js';
