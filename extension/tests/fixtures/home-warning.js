// @ts-check
// Real-component fixture for the narrow committed-warning E2E state.

import m from '/vendor/mithril/mithril.js';
import { LibrarySection } from '/home/library-section.js';
import { DiscoverSection } from '/home/discover-section.js';

/** @param {string} id @param {string} dwappId @param {string} name @param {number} version */
const installedApp = (id, dwappId, name, version) => ({
  id,
  name,
  tags: ['notes'],
  entryFile: 'index.html',
  favorite: false,
  source: 'dweb',
  thumbnail: null,
  updatedAt: Date.now(),
  dweb: {
    dwapp_id: dwappId,
    version_id: `version-${version}`,
    seq: version,
    uri: `peerd://peer/${dwappId}/version-${version}`,
    slug: dwappId,
  },
});

/** @param {string} dwappId @param {string} name */
const announcedApp = (dwappId, name) => ({
  dwapp_id: dwappId,
  version_id: 'version-2',
  seq: 2,
  uri: `peerd://peer/${dwappId}/version-2`,
  name,
  slug: dwappId,
  publisher: 'did:key:zPeerPublisher',
});

const libraryId = 'library-warning-app';
const libraryDwappId = 'library-warning';
const discoverId = 'discover-warning-app';
const discoverDwappId = 'discover-warning';
let libraryVersion = 1;
let discoverVersion = 1;

/** @param {ReturnType<typeof installedApp>} app */
const committedWarning = (app) => ({
  ok: true,
  app,
  warning: 'audit-write-failed',
  warnings: ['audit-write-failed', 'previous-version-cleanup-pending'],
  cleanupPending: true,
});

/** @param {{ type: string } & Record<string, unknown>} message */
const librarySend = async (message) => {
  if (message.type === 'apps/list') {
    return { ok: true, apps: [installedApp(libraryId, libraryDwappId, 'Library Notes', libraryVersion)] };
  }
  if (message.type === 'dweb/base/updates') {
    return {
      ok: true,
      updates: libraryVersion === 1
        ? { [libraryId]: announcedApp(libraryDwappId, 'Library Notes') }
        : {},
    };
  }
  if (message.type === 'dweb/base/update-app') {
    libraryVersion = 2;
    return committedWarning(installedApp(libraryId, libraryDwappId, 'Library Notes', libraryVersion));
  }
  return { ok: true };
};

/** @param {{ type: string } & Record<string, unknown>} message */
const discoverSend = async (message) => {
  if (message.type === 'apps/list') {
    return { ok: true, apps: [installedApp(discoverId, discoverDwappId, 'Discover Notes', discoverVersion)] };
  }
  if (message.type === 'dweb/base/status') return { ok: true, did: 'did:key:zFixtureUser' };
  if (message.type === 'dweb/base/heard') {
    return { ok: true, apps: [announcedApp(discoverDwappId, 'Discover Notes')] };
  }
  if (message.type === 'dweb/base/update-app') {
    discoverVersion = 2;
    return committedWarning(installedApp(discoverId, discoverDwappId, 'Discover Notes', discoverVersion));
  }
  return { ok: true };
};

const Fixture = {
  view: () => m('div.warning-fixture', [
    m('section', { 'aria-labelledby': 'library-warning-heading' }, [
      m('h1#library-warning-heading', 'Library'),
      m(LibrarySection, { send: librarySend, dweb: true }),
    ]),
    m('section', { 'aria-labelledby': 'discover-warning-heading' }, [
      m('h1#discover-warning-heading', 'Discover'),
      m(DiscoverSection, { send: discoverSend }),
    ]),
  ]),
};

m.mount(document.getElementById('app'), Fixture);
