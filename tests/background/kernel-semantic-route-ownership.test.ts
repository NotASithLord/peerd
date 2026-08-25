import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KERNEL_DWEB_ROUTE_NAMES,
  KERNEL_EXECUTABLE_SEMANTIC_ROUTE_NAMES,
  KERNEL_TRANSFER_ROUTE_NAMES,
} from '../../extension/shared/kernel-feature-route-inventory.js';
import { SEMANTIC_ROUTE_INVENTORY } from '../../extension/shared/semantic-route-inventory.js';

const source = readFileSync(join(import.meta.dir, '../../extension/background/vault-kernel.js'), 'utf8');

const namedRoutes = (name: string) => {
  const match = source.match(new RegExp(
    `const ${name} = (?:Object\\.freeze\\()?\\[([\\s\\S]*?)\\]\\)?;`,
  ));
  if (!match) throw new Error(`missing route owner: ${name}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
};

const ADMINISTRATIVE_ROUTES = Object.freeze([
  'hooks/list', 'hooks/save', 'hooks/remove', 'hooks/toggle',
  'memory/init', 'skills/installGit', 'skills/installLocal', 'skills/installManifest',
]);
const CONTRIBUTOR_ROUTES = Object.freeze([
  'contributor/disable', 'contributor/enable', 'contributor/feedback', 'contributor/status',
]);

const directOwnerToken = (route: string, sourceName: string) => {
  if (sourceName === 'extension/background/routes/engine.js') {
    if (route.startsWith('app/editor')) return 'makeKernelAppEditorRoutes';
    if (route === 'apps/import-git' || route.startsWith('apps/repository/')) {
      return 'makeKernelRepositoryReadRoutes';
    }
    if (route === 'lifecycle/assert-opfs-writable') return 'makeKernelOpfsPostureRoute';
    if (route === 'vm/get-meta') return 'makeKernelVmMetaRoute';
    return null;
  }
  if (sourceName === 'extension/background/routes/system-read.js') return 'makeSystemReadRoutes';
  if (sourceName === 'extension/background/routes/denylist.js') return 'makeKernelDenylistRoutes';
  if (sourceName === 'extension/background/routes/learned-origins.js') return 'makeKernelLearnedOriginRoutes';
  if (sourceName === 'extension/background/routes/settings.js') return 'makeKernelSettingsRoutes';
  if (sourceName === 'extension/background/routes/vault.js') return 'makeVaultKernelRoutes';
  if (sourceName === 'extension/peerd-engine/vm-net/git-credential-routes.js') {
    return 'makeKernelGitCredentialRoutes';
  }
  if (sourceName === 'extension/peerd-egress/fetch/origin-credential-routes.js') {
    return 'makeKernelOriginCredentialRoutes';
  }
  if (sourceName === 'siteClientRoutes') return 'createKernelSiteClientRoutes';
  if (sourceName === 'extension/background/routes/session-mutations.js') {
    return 'makeKernelSessionRoutes';
  }
  if (sourceName === 'extension/background/routes/memory.js') return "'onboarding/complete'";
  if (sourceName === 'extension/background/vault-kernel.js') {
    return route === 'confirm/answer' ? '...confirmation.routes' : "'repository/kernel-fetch'";
  }
  if (sourceName === 'extension/background/routes/system.js') {
    return route === 'audit/voice-fetch' ? 'makeKernelVoiceAuditRoute' : "'sidepanel/close'";
  }
  if (sourceName === 'extension/background/routes/sessions.js') {
    return route.startsWith('session/') ? 'makeKernelSessionRoutes' : 'makeKernelComposerRoutes';
  }
  return null;
};

test('the physical kernel owners cover the route inventory once', () => {
  const ownedGroups = [
    KERNEL_EXECUTABLE_SEMANTIC_ROUTE_NAMES,
    KERNEL_DWEB_ROUTE_NAMES,
    KERNEL_TRANSFER_ROUTE_NAMES,
    namedRoutes('semanticOwnerRoutes'),
    ['provider/setKey'],
    ADMINISTRATIVE_ROUTES,
    CONTRIBUTOR_ROUTES,
    ['private-transfer/open'],
    ['debug/originLock'],
  ];
  const owned = ownedGroups.flat();
  expect(new Set(owned).size).toBe(owned.length);
  const all = new Set(SEMANTIC_ROUTE_INVENTORY.map((row) => row.route));
  for (const route of owned) expect(all.has(route), route).toBe(true);

  const directlyOwned = SEMANTIC_ROUTE_INVENTORY.filter((row) => !owned.includes(row.route));
  for (const row of directlyOwned) {
    const token = directOwnerToken(row.route, row.source);
    expect(token, row.route).not.toBeNull();
    expect(source.includes(token ?? ''), `${row.route} -> ${token}`).toBe(true);
  }
  expect(owned.length + directlyOwned.length).toBe(SEMANTIC_ROUTE_INVENTORY.length);
  expect(source).toContain("names: ['debug/originLock']");
  expect(source).toContain("'debug/originLock': relays.debugOriginLock");
  expect(source).toContain('targetAddon?.contributor(');
  expect(source).toContain('...executableOwner.routes');
});
