// @ts-check
// Sealed semantic-controller public surface. Keep pure planning here so the
// controller never imports engine authority, registries, or execution hosts.

export { normalizeGitRemote } from './repository/remote.js';
