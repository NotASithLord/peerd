// @ts-check
// Constants shared by the two ends of the targeted actor MessageChannel.

export const ACTOR_CHANNEL_PROTOCOL = 1;
export const ACTOR_CHANNEL_OFFER = 'peerd/actor-channel';
export const ACTOR_LOOP_EVENT_BYTES = 64 * 1024;

const MODEL_ROUTES = Object.freeze([
  'actor/model-open-inference', 'actor/model-read-inference-chunk',
  'actor/model-cancel-inference', 'actor/model-read-context',
  'actor/model-open-local', 'actor/model-read-local', 'actor/model-cancel-local',
]);
const CONTROL_ROUTES = Object.freeze(['actor/call-complete']);
const LOOP_ROUTES = Object.freeze(['actor/loop-event']);
const EFFECT_ROUTES = Object.freeze([
  'actor/spawn-sync', 'actor/spawn-async', 'actor/tasks-read',
  'actor/task-cancel', 'actor/message-deliver',
  'pod/resolve', 'pod/read-remote', 'pod/confirm-git', 'pod/exec', 'pod/status',
  'pod/cancel', 'pod/read-file', 'pod/write-file',
  'repository/read-pod', 'repository/destroy-pod', 'repository/read-status',
  'repository/read-history', 'repository/read-remote', 'repository/read-diff',
  'repository/confirm-restore', 'repository/checkpoint', 'repository/branch',
  'repository/checkout', 'repository/restore', 'repository/confirm-remote',
  'repository/link', 'repository/fetch', 'repository/push',
  'vm/read', 'vm/list', 'vm/set-default', 'vm/run', 'vm/import-file',
  'vm/write-text-file', 'vm/destroy',
  'notebook/read', 'notebook/list', 'notebook/set-default', 'notebook/run',
  'notebook/write-file', 'notebook/read-file', 'notebook/destroy',
  'app/update', 'app/open', 'app/search', 'app/read', 'app/delete',
  'app/write-file', 'app/read-file', 'app/list-files', 'app/delete-file',
  'app/observe', 'app/act', 'app/run-code',
  'memory/read-scope', 'memory/read-subtree', 'memory/write',
  'todo/read', 'todo/replace',
  'page/open-tab', 'page/read', 'page/snapshot', 'page/read-state',
  'page/watch-changes', 'page/query-dom', 'page/navigate', 'page/fill',
  'page/click', 'page/login', 'page/run-program', 'page/capture-foreground',
  'page/capture-owned',
  'resource/confirm-web-write', 'resource/request-web-text',
  'resource/extract-markdown', 'resource/extract-document',
  'resource/spill-result', 'resource/read-result',
  'site-client/read', 'site-client/run', 'site-client/commit',
  'site-client/capture-start', 'site-client/capture-stop',
  'execution/create-webvm', 'execution/create-notebook', 'execution/create-pod',
  'execution/create-app', 'execution/run-script', 'execution/spill-script',
  'editing/read-target', 'editing/write-target',
  'introspection/actor-roster', 'introspection/provider-posture',
  'introspection/storage-snapshot', 'introspection/automatable-tabs',
  'introspection/denylist-patterns', 'introspection/audit-entries',
  'introspection/installed-skill',
  'schedule/read-routines', 'schedule/arm-confirmed-routine',
  'schedule/cancel-routine',
  'dweb/discover-apps', 'dweb/publish-confirmed-app',
  'dweb/install-confirmed-app', 'dweb/read-peers', 'dweb/set-peer-blocked',
  'dweb/set-discovery-enabled', 'dweb/run-mesh-program',
]);

export const ACTOR_RELAY_ROUTES = Object.freeze([
  ...MODEL_ROUTES, ...CONTROL_ROUTES, ...LOOP_ROUTES, ...EFFECT_ROUTES,
]);

const MODEL_ROUTE_SET = new Set(MODEL_ROUTES);
const CONTROL_ROUTE_SET = new Set(CONTROL_ROUTES);
const LOOP_ROUTE_SET = new Set(LOOP_ROUTES);
const EFFECT_ROUTE_SET = new Set(EFFECT_ROUTES);

// why: relayType crosses out of the compromised semantic Worker. Exact
// equality against this finite transport vocabulary prevents an invented
// actor/model-* selector from acquiring the model stream's large budget or
// reaching an arbitrary host route.
export const actorRelayRouteClass = (/** @type {unknown} */ route) =>
  typeof route !== 'string' ? null
    : MODEL_ROUTE_SET.has(route) ? 'model'
      : CONTROL_ROUTE_SET.has(route) ? 'control'
        : LOOP_ROUTE_SET.has(route) ? 'loop'
          : EFFECT_ROUTE_SET.has(route) ? 'effect' : null;

/**
 * A nested program owner restarts its local request sequence for each outer
 * execution. Include the exact parent effect identity so two page_code/app_code
 * calls in one actor turn cannot alias the same semantic call ledger entry.
 * @param {string} runId
 * @param {string} parentExecutionId
 * @param {string} requestId
 */
export const nestedActorProgramCallId = (runId, parentExecutionId, requestId) => {
  if (!runId || !parentExecutionId || !requestId) {
    throw new TypeError('nested actor program call identity is invalid');
  }
  return `${runId}:nested:${parentExecutionId.length}:${parentExecutionId}:${requestId}`;
};
