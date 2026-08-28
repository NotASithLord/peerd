// @ts-check

import { SEMANTIC_ROUTE_INVENTORY } from './semantic-route-inventory.js';
import {
  compileSemanticRouteClassification,
  semanticDispatchCutoverReport,
} from './semantic-dispatch-contract.js';

const KERNEL_SOURCES = new Set([
  'extension/background/routes/system-read.js',
  'extension/background/routes/denylist.js',
  'extension/background/routes/learned-origins.js',
  'extension/background/routes/vault.js',
  'extension/peerd-egress/fetch/origin-credential-routes.js',
  'extension/peerd-engine/vm-net/git-credential-routes.js',
]);

const KERNEL_ROUTE_OVERRIDES = new Set([
  'actor-isolation/retry',
  'actor/spawn',
  'agent/send',
  'agent/stop',
  'audit/voice-fetch',
  'a2a/call',
  'actors/call',
  'actors/list',
  'app/actor-chat',
  'apps/delete',
  'confirm/answer',
  'contacts/list',
  'contributor/feedback',
  'debug/originLock',
  'apps/import-git',
  'apps/list',
  'lifecycle/assert-opfs-writable',
  'app/editor-delete',
  'app/editor-write',
  'app/editor/delete',
  'app/editor/list',
  'app/editor/read',
  'app/editor/write',
  'apps/repository/diff',
  'apps/repository/fetch',
  'apps/repository/branch',
  'apps/repository/checkout',
  'apps/repository/commit',
  'apps/repository/history',
  'apps/repository/link',
  'apps/repository/push',
  'apps/repository/restore',
  'apps/repository/status',
  'commands/list',
  'composer/files',
  'composer/tabs',
  'private-transfer/open',
  'export/artifact',
  'import/apply',
  'import/inspect',
  'hooks/list',
  'hooks/remove',
  'hooks/save',
  'hooks/toggle',
  'models/options',
  'local-model/catalog',
  'local-model/init',
  'local-model/probe',
  'local-model/status',
  'memory/export',
  'memory/init',
  'openrouter/models',
  'onboarding/complete',
  'permission/set',
  'provider/setKey',
  'provider/test',
  'repository/kernel-fetch',
  'pod/cancel-io',
  'pod/get-meta',
  'pod/git',
  'pod/web-fetch',
  'git-cred/list',
  'git-cred/set',
  'git-cred/delete',
  'session/list',
  'session/archive',
  'session/debugBundle',
  'session/reset',
  'session/switch',
  'session/setModel',
  'session/contextSnapshots',
  'session/get',
  'settings/reset',
  'settings/update',
  'skills/list',
  'skills/installGit',
  'skills/installLocal',
  'skills/installManifest',
  'skills/remove',
  'skills/setEnabled',
  'script-run/abort',
  'script/model-call',
  'sidepanel/close',
  'site-client/delete',
  'site-client/list',
  'sw/web-fetch',
  'sw/web-fetch-abort',
  'site-fetch/call',
  'transfer/export',
  'transfer/import',
  'transfer/inspectImport',
  'vm/get-meta',
]);

// why: browser custody remains kernel-owned when semantic state is mirrored by the host.
export const SEMANTIC_ROUTE_CLASSIFICATIONS = Object.freeze(
  SEMANTIC_ROUTE_INVENTORY.map((row) => Object.freeze({
    ...row,
    placement: /** @type {'kernel'|'split'} */ (
      KERNEL_SOURCES.has(row.source) || KERNEL_ROUTE_OVERRIDES.has(row.route)
        || row.route.startsWith('page-program/')
        || row.route.startsWith('dweb/')
        ? 'kernel' : 'split'
    ),
    state: /** @type {const} */ ('migrated'),
  })),
);

export const SEMANTIC_ROUTE_CLASSIFICATION = compileSemanticRouteClassification(
  SEMANTIC_ROUTE_CLASSIFICATIONS,
);

export const SEMANTIC_ROUTE_CUTOVER = semanticDispatchCutoverReport(
  SEMANTIC_ROUTE_CLASSIFICATION,
  SEMANTIC_ROUTE_INVENTORY,
);
