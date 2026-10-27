// @ts-check

export const KERNEL_ADMINISTRATIVE_ROUTE_NAMES = Object.freeze([
  'hooks/list', 'hooks/save', 'hooks/remove', 'hooks/toggle',
  'memory/init', 'skills/installLocal',
]);

export const KERNEL_DEMAND_SUPPORT_ROUTE_NAMES = Object.freeze([
  'app/editor/read', 'app/editor/list', 'app/editor/write', 'app/editor/delete',
  'app/editor-write', 'app/editor-delete',
  'lifecycle/assert-opfs-writable', 'vm/get-meta',
  'site-client/list', 'site-client/delete', 'audit/voice-fetch',
  'denylist/list', 'commands/list', 'composer/files', 'composer/tabs',
  'settings/update', 'settings/reset',
  'paced/list', 'paced/forget', 'paced/clear', 'debug/pacing',
  'learned/list', 'learned/forget', 'learned/clear',
]);

export const KERNEL_SESSION_SUPPORT_ROUTE_NAMES = Object.freeze([
  'session/list', 'session/get', 'session/contextSnapshots', 'session/setModel',
  'permission/set',
]);

export const KERNEL_CREDENTIAL_ROUTE_NAMES = Object.freeze(
  'git-cred/list git-cred/set git-cred/delete origin-cred/list origin-cred/set origin-cred/delete'.split(' '),
);

export const KERNEL_REPOSITORY_ROUTE_NAMES = Object.freeze(
  'apps/repository/status apps/repository/history apps/repository/diff apps/repository/commit apps/repository/restore apps/repository/branch apps/repository/checkout apps/repository/link apps/repository/fetch apps/repository/push apps/import-git'.split(' '),
);

export const KERNEL_SEMANTIC_OWNER_ROUTE_NAMES = Object.freeze([
  ...'actor-isolation/retry actor/spawn agent/send agent/stop actors/count actors/overview app/get-meta apps/favorite apps/list apps/open apps/rename contacts/forget contacts/list contacts/set memory/delete memory/deleteAll memory/export memory/suggestions memory/suggestions/approve memory/suggestions/dismiss memory/write provider/status skills/list skills/remove skills/setEnabled provider/test models/options openrouter/models local-model/catalog local-model/init local-model/probe local-model/status'.split(' '),
  ...KERNEL_REPOSITORY_ROUTE_NAMES,
  ...'session/archive session/debugBundle session/reset session/switch'.split(' '),
]);

export const KERNEL_POD_ROUTE_NAMES = Object.freeze(
  'pod/cancel-io pod/get-meta pod/git pod/web-fetch'.split(' '),
);

export const KERNEL_WEB_FETCH_ROUTE_NAMES = Object.freeze(
  'sw/web-fetch sw/web-fetch-abort'.split(' '),
);

export const KERNEL_ARTIFACT_READ_ROUTE_NAMES = Object.freeze(
  'export/artifact import/inspect'.split(' '),
);

export const KERNEL_RELAY_ROUTE_NAMES = Object.freeze([
  ...'a2a/call actors/list actors/call script/model-call script-run/abort site-fetch/call'.split(' '),
]);

export const KERNEL_EXECUTABLE_SEMANTIC_ROUTE_NAMES = Object.freeze([
  ...KERNEL_POD_ROUTE_NAMES,
  ...KERNEL_WEB_FETCH_ROUTE_NAMES,
  ...KERNEL_ARTIFACT_READ_ROUTE_NAMES,
  ...'import/apply apps/delete app/actor-chat'.split(' '),
  ...KERNEL_RELAY_ROUTE_NAMES,
]);

export const KERNEL_ENGINE_ATTACH_ROUTE_NAMES = Object.freeze(
  'vm/tab-ready vm/tab-failed js/tab-ready pod/tab-adopt app/tab-ready app/actor-retry'.split(' '),
);

export const KERNEL_EXECUTABLE_ROUTE_NAMES = Object.freeze([
  ...KERNEL_ENGINE_ATTACH_ROUTE_NAMES,
  ...KERNEL_EXECUTABLE_SEMANTIC_ROUTE_NAMES,
]);

export const KERNEL_TRANSFER_ROUTE_NAMES = Object.freeze(
  'transfer/export transfer/inspectImport transfer/import'.split(' '),
);

export const KERNEL_DWEB_ROUTE_NAMES = Object.freeze(
  'app-authority-generations app-install app-local-changes app-record-served app-snapshot app-update audit base/announce base/find base/heard base/install base/inspect-address base/install-address base/install-status base/cancel-install base/room base/share-app base/start base/status base/stop base/update-app base/updates blocked-peers distributed/info ensure-seed-app peer-block peer-policy peer-unblock meta-admit open-commons self-apply-surface self-prepare-offer self-read-surface self-restore self-status'.split(' ').map((name) => `dweb/${name}`),
);



export const KERNEL_LOCAL_ROUTE_NAMES = Object.freeze(
  'provider/test models/options models/state-projection openrouter/models local-model/catalog local-model/init local-model/probe local-model/status'.split(' '),
);
