import { afterEach, describe, expect, test } from 'bun:test';
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makeDwebRoutes } from '../../extension/background/routes/dweb.js';
import { makeDwebSelfRoutes } from '../../extension/background/routes/dweb-self.js';
import { makeDwebRoutes as makeDisabledDwebRoutes } from '../../packaging/templates/routes-dweb.disabled.js';
import { makeDwebSelfRoutes as makeDisabledDwebSelfRoutes } from '../../packaging/templates/routes-dweb-self.disabled.js';
import {
  DWEB_ROUTES_DISABLED_TEMPLATE, DWEB_SELF_ROUTES_DISABLED_TEMPLATE,
  STORE_ACTOR_WORKER_TEMPLATE, STORE_LOADER_TEMPLATE,
  STORE_OPTIONS_APP_TEMPLATE, STORE_SEMANTIC_HOST_TEMPLATE,
} from '../../packaging/lib.ts';
import { applyDwebDisabledTemplates } from '../../packaging/package.ts';
import { minifyColdArtifactModules } from '../../packaging/minify-artifact-js.ts';
import {
  dwebDisabledTemplateFailures, storeContributorBoundaryFailures,
} from '../../packaging/verify-store-artifact.ts';

const temporaryRoots: string[] = [];
const temporaryRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'peerd-dweb-disabled-routes-'));
  temporaryRoots.push(root);
  return root;
};
afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

const write = (root: string, relativePath: string, source: string): void => {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
};

const offscreenSender = Object.freeze({ provenance: 'offscreen' });
const ordinarySender = Object.freeze({ provenance: 'ordinary' });

const makeMainDeps = (events: string[]): Record<string, any> => {
  const forbidden = new Proxy({}, {
    get: (_target, property) => { throw new Error(`disabled route touched ${String(property)}`); },
  });
  return {
    DWEB_ENABLED: false,
    kv: forbidden,
    vault: forbidden,
    auditLog: forbidden,
    browser: forbidden,
    appRegistry: forbidden,
    appClient: forbidden,
    appTabTracker: forbidden,
    appQuiescence: forbidden,
    settingsStore: forbidden,
    repositories: forbidden,
    createDwebRollbackGuard: (args: unknown) => {
      events.push(`rollback:create:${args && typeof args === 'object'}`);
      return { admit: async () => { throw new Error('rollback admit reached'); } };
    },
    isOffscreenSender: (sender: unknown) => {
      events.push(`sender:${sender === offscreenSender ? 'offscreen' : 'ordinary'}`);
      return sender === offscreenSender;
    },
    dwebPublicationGeneration: () => {
      events.push('publication:generation');
      return 7;
    },
    ensureSettingsReady: async () => { throw new Error('settings hydration reached'); },
    ensureDwebFeature: async () => { throw new Error('dweb host reached'); },
    disableDweb: async () => { throw new Error('dweb disable reached'); },
    withDwebPublication: async () => { throw new Error('publication lane reached'); },
    withAppLifecycle: async () => { throw new Error('app lifecycle reached'); },
    shareLocalApp: async () => { throw new Error('share reached'); },
  };
};

const makeSelfDeps = (events: string[]): Record<string, any> => ({
  dwebReady: async () => { events.push('dweb:ready'); return false; },
  isOffscreenSender: (sender: unknown) => {
    events.push(`sender:${sender === offscreenSender ? 'offscreen' : 'ordinary'}`);
    return sender === offscreenSender;
  },
  callBaseHost: async () => { throw new Error('base host reached'); },
  auditLog: { append: async () => { throw new Error('audit reached'); } },
  surfaceShapers: new Proxy({}, { get: () => { throw new Error('surface shaper reached'); } }),
  surfaceAppliers: new Proxy({}, { get: () => { throw new Error('surface applier reached'); } }),
});

describe('dweb-disabled route factories', () => {
  test('retain exact route keys, results, provenance ordering, and collaborator calls', async () => {
    const fullSetupEvents: string[] = [];
    const disabledSetupEvents: string[] = [];
    const full = makeDwebRoutes(makeMainDeps(fullSetupEvents));
    const disabled = makeDisabledDwebRoutes(makeMainDeps(disabledSetupEvents));
    expect(Object.keys(disabled)).toEqual(Object.keys(full));
    expect(disabledSetupEvents).toEqual(fullSetupEvents);

    for (const route of Object.keys(full)) {
      for (const sender of [ordinarySender, offscreenSender]) {
        const fullEvents: string[] = [];
        const disabledEvents: string[] = [];
        const fullRoute = makeDwebRoutes(makeMainDeps(fullEvents))[route];
        const disabledRoute = makeDisabledDwebRoutes(makeMainDeps(disabledEvents))[route];
        fullEvents.length = 0;
        disabledEvents.length = 0;
        const message = { publicationGeneration: 7 };
        const messageSender = sender as any;
        expect(await disabledRoute(message, messageSender), `${route}/${sender.provenance}`)
          .toEqual(await fullRoute(message, messageSender));
        expect(disabledEvents, `${route}/${sender.provenance} collaborators`).toEqual(fullEvents);
      }
    }

    const fullSelf = makeDwebSelfRoutes(makeSelfDeps([]));
    const disabledSelf = makeDisabledDwebSelfRoutes(makeSelfDeps([]));
    expect(Object.keys(disabledSelf)).toEqual(Object.keys(fullSelf));
    for (const route of Object.keys(fullSelf)) {
      for (const sender of [ordinarySender, offscreenSender]) {
        const fullEvents: string[] = [];
        const disabledEvents: string[] = [];
        const fullRoute = makeDwebSelfRoutes(makeSelfDeps(fullEvents))[route];
        const disabledRoute = makeDisabledDwebSelfRoutes(makeSelfDeps(disabledEvents))[route];
        expect(await disabledRoute({}, sender), `${route}/${sender.provenance}`)
          .toEqual(await fullRoute({}, sender));
        expect(disabledEvents, `${route}/${sender.provenance} collaborators`).toEqual(fullEvents);
      }
    }
  });

  test('swaps exact committed files in all and only dweb-disabled package targets', () => {
    const targets = [
      { channel: 'store', browser: 'chrome', disabled: true },
      { channel: 'store', browser: 'firefox', disabled: true },
      { channel: 'preview', browser: 'firefox', disabled: true },
      { channel: 'preview', browser: 'chrome', disabled: false },
    ] as const;
    for (const target of targets) {
      const root = temporaryRoot();
      const originals = new Map([
        ['shared/dweb-loader.js', '// authored loader\n'],
        ['background/routes/dweb.js', '// authored dweb routes\n'],
        ['background/routes/dweb-self.js', '// authored dweb self routes\n'],
      ]);
      for (const [relativePath, source] of originals) write(root, relativePath, source);

      expect(applyDwebDisabledTemplates(root, target.channel, target.browser)).toBe(target.disabled);
      const expected = target.disabled ? new Map([
        ['shared/dweb-loader.js', readFileSync(STORE_LOADER_TEMPLATE, 'utf8')],
        ['background/routes/dweb.js', readFileSync(DWEB_ROUTES_DISABLED_TEMPLATE, 'utf8')],
        ['background/routes/dweb-self.js', readFileSync(DWEB_SELF_ROUTES_DISABLED_TEMPLATE, 'utf8')],
      ]) : originals;
      for (const [relativePath, source] of expected) {
        expect(readFileSync(join(root, relativePath), 'utf8'), `${target.channel}/${target.browser}/${relativePath}`)
          .toBe(source);
      }
    }
  });

  test('artifact verifier detects changed and missing disabled templates', () => {
    const root = temporaryRoot();
    for (const [relativePath, template] of [
      ['shared/dweb-loader.js', STORE_LOADER_TEMPLATE],
      ['background/routes/dweb.js', DWEB_ROUTES_DISABLED_TEMPLATE],
      ['background/routes/dweb-self.js', DWEB_SELF_ROUTES_DISABLED_TEMPLATE],
      ['offscreen/actor-worker.js', STORE_ACTOR_WORKER_TEMPLATE],
      ['options/components/options-app.js', STORE_OPTIONS_APP_TEMPLATE],
      ['offscreen/semantic-route-host.js', STORE_SEMANTIC_HOST_TEMPLATE],
    ] as const) {
      const target = join(root, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(template, target);
    }
    expect(dwebDisabledTemplateFailures(root)).toEqual([]);
    write(root, 'offscreen/dweb-transfer-host.js', '// leaked\n');
    writeFileSync(join(root, 'background/routes/dweb.js'), '// changed\n');
    rmSync(join(root, 'background/routes/dweb-self.js'));
    expect(dwebDisabledTemplateFailures(root)).toEqual([
      'background/routes/dweb.js is NOT the committed disabled template',
      'background/routes/dweb-self.js missing from artifact',
      'offscreen/dweb-transfer-host.js present in dweb-disabled artifact',
    ]);
  });

  test('artifact verifier rejects Contributor projection code in the Store actor runtime', () => {
    const root = temporaryRoot();
    write(root, 'offscreen/actor-worker-runtime.js', 'export const startActorWorker = () => {};\n');
    expect(storeContributorBoundaryFailures(root)).toEqual([]);
    write(root, 'offscreen/actor-worker-runtime.js', 'const contributor = projectResult();\n');
    expect(storeContributorBoundaryFailures(root)).toEqual([
      'offscreen/actor-worker-runtime.js contains Contributor code',
    ]);
  });

  test('minification preserves disabled bytes exactly without exempting Preview Chrome authored routes', async () => {
    const makeGraph = (): string => {
      const root = temporaryRoot();
      write(root, 'manifest.json', JSON.stringify({
        background: { service_worker: 'background/service-worker.js', type: 'module' },
      }));
      write(root, 'background/service-worker.js', `
        import { makeDwebRoutes } from './routes/dweb.js';
        import { makeDwebSelfRoutes } from './routes/dweb-self.js';
        globalThis.routes = [makeDwebRoutes, makeDwebSelfRoutes];
      `);
      write(root, 'offscreen/offscreen.js', 'globalThis.offscreen = true;\n');
      return root;
    };

    const disabledRoot = makeGraph();
    mkdirSync(join(disabledRoot, 'background/routes'), { recursive: true });
    copyFileSync(DWEB_ROUTES_DISABLED_TEMPLATE, join(disabledRoot, 'background/routes/dweb.js'));
    copyFileSync(DWEB_SELF_ROUTES_DISABLED_TEMPLATE, join(disabledRoot, 'background/routes/dweb-self.js'));
    await minifyColdArtifactModules(disabledRoot, 'chrome', 'store');
    expect(readFileSync(join(disabledRoot, 'background/routes/dweb.js')))
      .toEqual(readFileSync(DWEB_ROUTES_DISABLED_TEMPLATE));
    expect(readFileSync(join(disabledRoot, 'background/routes/dweb-self.js')))
      .toEqual(readFileSync(DWEB_SELF_ROUTES_DISABLED_TEMPLATE));

    const previewRoot = makeGraph();
    mkdirSync(join(previewRoot, 'background/routes'), { recursive: true });
    const authored = `${readFileSync(DWEB_ROUTES_DISABLED_TEMPLATE, 'utf8')}\n// preview-only removable comment\n`;
    writeFileSync(join(previewRoot, 'background/routes/dweb.js'), authored);
    copyFileSync(DWEB_SELF_ROUTES_DISABLED_TEMPLATE, join(previewRoot, 'background/routes/dweb-self.js'));
    await minifyColdArtifactModules(previewRoot, 'chrome', 'preview');
    expect(readFileSync(join(previewRoot, 'background/routes/dweb.js'), 'utf8')).not.toBe(authored);
  });
});
