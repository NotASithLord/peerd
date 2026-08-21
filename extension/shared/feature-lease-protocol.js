// @ts-check
// Tiny browser-neutral wire contract shared by the authority kernel and the
// offscreen host. Keep host implementation out of the cold service-worker
// graph; this file must remain constants only.

export const FEATURE_LEASE_HOST_PROTOCOL = 1;
export const FEATURE_LEASE_KEEPALIVE_PORT = 'feature-lease-keepalive';
export const OFFSCREEN_FEATURE_LEASE_SCOPES = Object.freeze([
  'controller', 'dweb', 'dom-host', 'media-host', 'model-host', 'vault-authority',
]);
