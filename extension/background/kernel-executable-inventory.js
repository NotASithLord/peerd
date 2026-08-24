// @ts-check

export const KERNEL_EXECUTABLE_ROUTE_NAMES = Object.freeze([
  'pod/cancel-io', 'pod/get-meta', 'pod/git', 'pod/web-fetch',
  'sw/web-fetch', 'sw/web-fetch-abort',
  'export/artifact', 'import/inspect', 'import/apply',
  'apps/delete', 'app/actor-chat', 'app/call',
  'a2a/call', 'actors/call', 'page/call', 'script/model-call',
  'script-run/abort', 'site-fetch/call',
]);

export const KERNEL_RELAY_ROUTE_NAMES = Object.freeze([
  'a2a/call', 'actors/call', 'page/call', 'script/model-call',
  'script-run/abort', 'site-fetch/call',
]);

export const KERNEL_TRANSFER_ROUTE_NAMES = Object.freeze([
  'transfer/export', 'transfer/inspectImport', 'transfer/import',
]);

export const KERNEL_DWEB_ROUTE_NAMES = Object.freeze([
  'dweb/app-install', 'dweb/app-record-served', 'dweb/app-snapshot', 'dweb/app-update',
  'dweb/audit', 'dweb/base/announce', 'dweb/base/find', 'dweb/base/heard',
  'dweb/base/install', 'dweb/base/room', 'dweb/base/share-app', 'dweb/base/start',
  'dweb/base/status', 'dweb/base/stop', 'dweb/base/update-app', 'dweb/base/updates',
  'dweb/distributed/info', 'dweb/ensure-seed-app', 'dweb/meta-admit',
  'dweb/open-commons', 'dweb/self-apply-surface', 'dweb/self-prepare-offer',
  'dweb/self-read-surface', 'dweb/self-restore', 'dweb/self-status',
]);
