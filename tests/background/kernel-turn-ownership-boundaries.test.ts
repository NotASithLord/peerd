import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';

const REPO_ROOT = join(import.meta.dir, '../..');
const EXTENSION_ROOT = join(REPO_ROOT, 'extension');

const modulesFor = async (entry: string) => new Set(
  [...await collectStaticModuleGraph(EXTENSION_ROOT, join(EXTENSION_ROOT, entry))]
    .map((file) => relative(EXTENSION_ROOT, file).replaceAll('\\', '/')),
);

describe('kernel turn ownership boundaries', () => {
  it('keeps semantic aggregate barrels out of the service-worker graph', async () => {
    const modules = await modulesFor('background/vault-kernel.js');
    for (const module of [
      'peerd-runtime/authority.js',
      'peerd-runtime/background.js',
      'peerd-runtime/kernel.js',
      'peerd-runtime/kernel-turn.js',
    ]) expect(modules.has(module), `service worker imports ${module}`).toBe(false);
  });

  it('keeps the authority turn runtime independent from semantic turn implementations', async () => {
    const modules = await modulesFor('background/kernel-turn-runtime.js');
    for (const module of [
      'peerd-runtime/kernel-turn.js',
      'peerd-runtime/loop/turn-driver.js',
      'peerd-runtime/loop/goal-runner.js',
      'peerd-runtime/todo/core.js',
    ]) expect(modules.has(module), `authority runtime imports ${module}`).toBe(false);
    expect(existsSync(join(EXTENSION_ROOT, 'peerd-runtime/kernel-turn.js'))).toBe(false);
  });

  it('uses exact transfer custody leaves without a growing aggregate entry', async () => {
    const modules = await modulesFor('background/vault-kernel.js');
    expect(modules.has('peerd-runtime/kernel-transfer.js')).toBe(false);
    expect(existsSync(join(EXTENSION_ROOT, 'peerd-runtime/kernel-transfer.js'))).toBe(false);
    for (const entry of [
      'background/kernel-executable-transfer-live.js',
      'background/kernel-dweb-route-runtime.js',
    ]) {
      expect(readFileSync(join(EXTENSION_ROOT, entry), 'utf8'))
        .not.toContain('/peerd-runtime/kernel-transfer.js');
    }
  });

  it('shares exact domain authority bindings across orchestrator and actor relays', () => {
    const sources = [
      'background/controller-turn-bridge.js',
      'background/offscreen-actor-client.js',
    ].map((entry) => readFileSync(join(EXTENSION_ROOT, entry), 'utf8'));
    for (const domain of [
      'Repository', 'Vm', 'Notebook', 'App', 'Persistence',
      'Page', 'Introspection', 'Schedule', 'Dweb',
    ]) {
      for (const source of sources) {
        expect(source).toContain(`bind${domain}ToolAuthority`);
        expect(source).not.toContain(`create${domain}ToolAuthority`);
      }
    }
  });

  it('keeps the semantic owner free of authority and host dependencies', async () => {
    const modules = await modulesFor('peerd-runtime/controller-turn-semantics.js');
    const forbiddenPrefixes = [
      'background/',
      'peerd-egress/vault/',
      'peerd-egress/storage/',
      'peerd-egress/credentials/',
      'peerd-egress/dpop/',
      'peerd-egress/fetch/origin-credentials.js',
    ];
    const forbiddenModules = new Set([
      'shared/browser-api.js',
      'peerd-provider/background.js',
      'peerd-engine/background.js',
      'peerd-runtime/composer/command-store.js',
      'peerd-runtime/site-clients/store.js',
      'peerd-runtime/skills/store.js',
      'peerd-runtime/toolbox/store.js',
      'peerd-runtime/tools/run-cache.js',
    ]);

    expect([...modules].filter((module) =>
      forbiddenModules.has(module)
        || forbiddenPrefixes.some((prefix) => module.startsWith(prefix)))).toEqual([]);
  });

  it('keeps the authority adapter free of feature catalogs and semantic owners', async () => {
    const modules = await modulesFor('background/kernel-turn-authority-adapter.js');
    const forbiddenPrefixes = [
      'peerd-provider/',
      'peerd-runtime/tools/defs/',
      'peerd-runtime/tools/metadata/',
    ];
    const forbiddenModules = new Set([
      'peerd-engine/app-manifest.js',
      'peerd-runtime/controller-turn-semantics.js',
      'peerd-runtime/controller-actor-tools.js',
      'peerd-runtime/controller-pod-tools.js',
      'peerd-runtime/controller-repository-tools.js',
      'peerd-runtime/controller-vm-tools.js',
      'peerd-runtime/controller-notebook-tools.js',
      'peerd-runtime/controller-app-tools.js',
      'peerd-runtime/controller-tools.js',
      'peerd-runtime/semantic.js',
      'peerd-runtime/site-clients/digest.js',
      'peerd-runtime/tools/registry.js',
    ]);

    expect([...modules].filter((module) =>
      forbiddenModules.has(module)
        || forbiddenPrefixes.some((prefix) => module.startsWith(prefix)))).toEqual([]);
  });

  it('keeps tool inventory and exposure projection in the sealed controller', async () => {
    const authorityModules = await modulesFor('background/kernel-turn-live-factories.js');
    for (const module of [
      'peerd-runtime/controller-tool-projection.js',
      'peerd-runtime/tools/metadata-registry.js',
      'peerd-runtime/tools/metadata/catalog.js',
    ]) expect(authorityModules.has(module), `authority graph imports ${module}`).toBe(false);

    const controllerModules = await modulesFor('offscreen/controller-turn-runtime.js');
    for (const module of [
      'peerd-runtime/controller-tool-projection.js',
      'peerd-runtime/tools/metadata/policy.js',
      'peerd-runtime/tools/metadata/catalog.js',
    ]) expect(controllerModules.has(module), `controller graph omits ${module}`).toBe(true);

    const driver = readFileSync(
      join(EXTENSION_ROOT, 'peerd-runtime/loop/turn-driver.js'), 'utf8',
    );
    expect(driver).toContain('controller tool projection unavailable');
    for (const fallback of [
      'mainAgentDescriptors(listToolDescriptors())',
      'actorDescriptors(listToolDescriptors()',
      '.map(projectToolAuthority)',
    ]) expect(driver).not.toContain(fallback);
  });

  it('keeps provider selection, pricing, and model inventory out of the live turn authority graph', async () => {
    const authorityModules = await modulesFor('background/kernel-turn-live-factories.js');
    for (const module of [
      'peerd-provider/metadata.js',
      'peerd-provider/pricing.js',
      'peerd-provider/registry.js',
      'peerd-provider/semantic-metadata.js',
      'peerd-provider/errors.js',
    ]) expect(authorityModules.has(module), `authority graph imports ${module}`).toBe(false);

    const controllerModules = await modulesFor('offscreen/controller-turn-runtime.js');
    for (const module of [
      'peerd-provider/metadata.js',
      'peerd-provider/pricing.js',
      'peerd-provider/registry.js',
    ]) expect(controllerModules.has(module), `controller graph omits ${module}`).toBe(true);

    const driver = readFileSync(
      join(EXTENSION_ROOT, 'peerd-runtime/loop/turn-driver.js'), 'utf8',
    );
    expect(driver).not.toContain('REASONING_BUDGET_TOKENS');
    expect(driver).not.toContain('REASONING_EFFORT_LEVELS');
  });

  it('hosts actor tool semantics only in controller and isolated-worker graphs', async () => {
    const actorSemanticModules = new Set([
      'peerd-runtime/controller-actor-tools.js',
      'peerd-runtime/tools/defs/actor-create.js',
      'peerd-runtime/tools/defs/actor-tasks.js',
      'peerd-runtime/tools/defs/actor-cancel.js',
      'peerd-runtime/tools/defs/message-actor.js',
    ]);
    const authorityEntries = [
      'background/kernel-turn-authority-adapter.js',
      'background/controller-turn-bridge.js',
      'background/offscreen-actor-client.js',
    ];
    for (const entry of authorityEntries) {
      const modules = await modulesFor(entry);
      expect([...modules].filter((module) => actorSemanticModules.has(module))).toEqual([]);
    }

    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker.js']) {
      const modules = await modulesFor(entry);
      expect(modules.has('peerd-runtime/controller-actor-tools.js')).toBe(true);
      for (const module of actorSemanticModules) expect(modules.has(module)).toBe(true);
    }
  });

  it('keeps actor prompt, projection, and result shaping out of the orchestrator authority driver', async () => {
    const modules = await modulesFor('peerd-runtime/loop/turn-driver.js');
    for (const module of [
      'peerd-runtime/actor/capability-manifest.js',
      'peerd-runtime/tools/exposure.js',
    ]) expect(modules.has(module), `orchestrator driver imports ${module}`).toBe(false);
    const source = readFileSync(
      join(EXTENSION_ROOT, 'peerd-runtime/loop/turn-driver.js'), 'utf8',
    );
    for (const semanticPath of [
      "surface: 'actor'", 'turn/actor-start', 'turn/actor-state',
      'turn/actor-cost', 'turn/actor-error', 'turn/actor-done',
    ]) expect(source).not.toContain(semanticPath);
    expect(source).toContain('actor_background_turn_refused');
  });

  it('keeps model-facing turn corrections in the sealed prompt renderer', () => {
    const driver = readFileSync(
      join(EXTENSION_ROOT, 'peerd-runtime/loop/turn-driver.js'), 'utf8',
    );
    const renderer = readFileSync(
      join(EXTENSION_ROOT, 'peerd-runtime/loop/system-prompt.js'), 'utf8',
    );
    for (const semanticOwner of [
      'PREWALK_NUDGE', 'actorIsolationPromptBlock', 'runtimeCapabilityPromptBlock',
    ]) {
      expect(driver).not.toContain(semanticOwner);
      expect(renderer).toContain(semanticOwner);
    }
    expect(driver).toContain('actorIsolation: actorIsolationForModelStep');
    expect(driver).toContain('runtimeCapabilities');
  });

  it('hosts Pod command/file semantics only in controller and isolated-worker graphs', async () => {
    const podSemanticModules = new Set([
      'peerd-runtime/controller-pod-tools.js',
      'peerd-runtime/tools/defs/pod-exec.js',
      'peerd-runtime/tools/defs/pod-status.js',
      'peerd-runtime/tools/defs/pod-cancel.js',
      'peerd-runtime/tools/defs/pod-read.js',
      'peerd-runtime/tools/defs/pod-write.js',
    ]);
    const authorityEntries = [
      'background/kernel-turn-authority-adapter.js',
      'background/controller-turn-bridge.js',
      'background/offscreen-actor-client.js',
    ];
    for (const entry of authorityEntries) {
      const modules = await modulesFor(entry);
      expect([...modules].filter((module) => podSemanticModules.has(module))).toEqual([]);
    }

    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker.js']) {
      const modules = await modulesFor(entry);
      for (const module of podSemanticModules) expect(modules.has(module)).toBe(true);
    }
  });

  it('hosts repository semantics only in controller and isolated-worker graphs', async () => {
    const repositorySemanticModules = new Set([
      'peerd-runtime/controller-repository-tools.js',
      'peerd-runtime/tools/defs/pod-destroy.js',
      'peerd-runtime/tools/defs/app-history.js',
      'peerd-runtime/tools/defs/app-version.js',
      'peerd-runtime/tools/defs/app-remote.js',
    ]);
    const authorityEntries = [
      'background/kernel-turn-authority-adapter.js',
      'background/controller-turn-bridge.js',
      'background/offscreen-actor-client.js',
    ];
    for (const entry of authorityEntries) {
      const modules = await modulesFor(entry);
      expect([...modules].filter((module) => repositorySemanticModules.has(module))).toEqual([]);
    }

    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker.js']) {
      const modules = await modulesFor(entry);
      for (const module of repositorySemanticModules) expect(modules.has(module)).toBe(true);
    }
  });

  it('hosts WebVM semantics only in controller and isolated-worker graphs', async () => {
    const vmSemanticModules = new Set([
      'peerd-runtime/controller-vm-tools.js',
      'peerd-runtime/tools/defs/vm-boot.js',
      'peerd-runtime/tools/defs/vm-import.js',
      'peerd-runtime/tools/defs/vm-write-file.js',
      'peerd-runtime/tools/defs/vm-delete.js',
    ]);
    const authorityEntries = [
      'background/kernel-turn-authority-adapter.js',
      'background/controller-turn-bridge.js',
      'background/offscreen-actor-client.js',
    ];
    for (const entry of authorityEntries) {
      const modules = await modulesFor(entry);
      expect([...modules].filter((module) => vmSemanticModules.has(module))).toEqual([]);
    }

    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker.js']) {
      const modules = await modulesFor(entry);
      for (const module of vmSemanticModules) expect(modules.has(module)).toBe(true);
    }
  });

  it('hosts Notebook semantics only in controller and isolated-worker graphs', async () => {
    const notebookSemanticModules = new Set([
      'peerd-runtime/controller-notebook-tools.js',
      'peerd-runtime/tools/defs/js-notebook.js',
      'peerd-runtime/tools/defs/js-write-file.js',
      'peerd-runtime/tools/defs/js-read-file.js',
      'peerd-runtime/tools/defs/js-delete.js',
    ]);
    const authorityEntries = [
      'background/kernel-turn-authority-adapter.js',
      'background/controller-turn-bridge.js',
      'background/offscreen-actor-client.js',
    ];
    for (const entry of authorityEntries) {
      const modules = await modulesFor(entry);
      expect([...modules].filter((module) => notebookSemanticModules.has(module))).toEqual([]);
    }
    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker.js']) {
      const modules = await modulesFor(entry);
      for (const module of notebookSemanticModules) expect(modules.has(module)).toBe(true);
    }
  });

  it('hosts App semantics only in controller and isolated-worker graphs', async () => {
    const appSemanticModules = new Set([
      'peerd-runtime/controller-app-tools.js',
      'peerd-runtime/tools/defs/app-update.js',
      'peerd-runtime/tools/defs/app-open.js',
      'peerd-runtime/tools/defs/app-search.js',
      'peerd-runtime/tools/defs/app-delete.js',
      'peerd-runtime/tools/defs/app-write-file.js',
      'peerd-runtime/tools/defs/app-read-file.js',
      'peerd-runtime/tools/defs/app-list-files.js',
      'peerd-runtime/tools/defs/app-delete-file.js',
      'peerd-runtime/tools/defs/app-observe.js',
      'peerd-runtime/tools/defs/app-act.js',
      'peerd-runtime/tools/defs/app-code.js',
    ]);
    const authorityEntries = [
      'background/kernel-turn-authority-adapter.js',
      'background/controller-turn-bridge.js',
      'background/offscreen-actor-client.js',
    ];
    for (const entry of authorityEntries) {
      const modules = await modulesFor(entry);
      expect([...modules].filter((module) => appSemanticModules.has(module))).toEqual([]);
    }
    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker.js']) {
      const modules = await modulesFor(entry);
      for (const module of appSemanticModules) expect(modules.has(module)).toBe(true);
    }
  });

  it('hosts memory and todo semantics only in controller and isolated-worker graphs', async () => {
    const persistenceSemanticModules = new Set([
      'peerd-runtime/controller-persistence-tools.js',
      'peerd-runtime/tools/defs/read-memory.js',
      'peerd-runtime/tools/defs/remember.js',
      'peerd-runtime/tools/defs/todo.js',
      'peerd-runtime/todo/core.js',
    ]);
    for (const entry of [
      'background/vault-kernel.js',
      'background/kernel-turn-live-factories.js',
      'background/controller-turn-bridge.js',
      'background/offscreen-actor-client.js',
    ]) {
      const modules = await modulesFor(entry);
      expect([...modules].filter((module) => persistenceSemanticModules.has(module))).toEqual([]);
    }
    const legacyOwner = await modulesFor('background/kernel-turn-live-factories.js');
    for (const module of [
      'peerd-runtime/controller-persistence-tools.js',
      'peerd-runtime/tools/defs/read-memory.js',
      'peerd-runtime/tools/defs/remember.js',
      'peerd-runtime/tools/defs/todo.js',
    ]) expect(legacyOwner.has(module), `legacy owner imports ${module}`).toBe(false);
    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker.js']) {
      const modules = await modulesFor(entry);
      for (const module of persistenceSemanticModules) expect(modules.has(module)).toBe(true);
    }
  });

  it('hosts page definitions only in controller and isolated-worker graphs', async () => {
    const pageSemanticModules = new Set([
      'peerd-runtime/controller-page-tools.js',
      'peerd-runtime/tools/defs/open-tab.js',
      'peerd-runtime/tools/defs/read-page.js',
      'peerd-runtime/tools/defs/snapshot.js',
      'peerd-runtime/tools/defs/read-state.js',
      'peerd-runtime/tools/defs/watch-changes.js',
      'peerd-runtime/tools/defs/query-dom.js',
      'peerd-runtime/tools/defs/page-eval.js',
      'peerd-runtime/tools/defs/page-exec.js',
      'peerd-runtime/tools/defs/page-keys.js',
      'peerd-runtime/tools/defs/navigate.js',
      'peerd-runtime/tools/defs/type.js',
      'peerd-runtime/tools/defs/click.js',
      'peerd-runtime/tools/defs/login.js',
      'peerd-runtime/tools/defs/page-code.js',
      'peerd-runtime/tools/web/screenshot.js',
      'peerd-runtime/tools/web/view.js',
    ]);
    for (const entry of [
      'background/kernel-turn-authority-adapter.js',
      'background/controller-turn-bridge.js',
      'background/offscreen-actor-client.js',
    ]) {
      const modules = await modulesFor(entry);
      expect([...modules].filter((module) => pageSemanticModules.has(module))).toEqual([]);
    }
    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker.js']) {
      const modules = await modulesFor(entry);
      for (const module of pageSemanticModules) expect(modules.has(module)).toBe(true);
    }
  });

  it('hosts introspection, skill, and wait semantics only in controller graphs', async () => {
    const semanticModules = new Set([
      'peerd-runtime/controller-introspection-tools.js',
      'peerd-runtime/tools/defs/actor-list.js',
      'peerd-runtime/tools/defs/inspect.js',
      'peerd-runtime/skills/load-skill-tool.js',
      'peerd-runtime/clock/tools.js',
      'peerd-runtime/clock/wait-execute.js',
    ]);
    for (const entry of [
      'background/vault-kernel.js',
      'background/kernel-turn-live-factories.js',
      'background/controller-turn-bridge.js',
      'background/offscreen-actor-client.js',
    ]) {
      const modules = await modulesFor(entry);
      expect([...modules].filter((module) => semanticModules.has(module))).toEqual([]);
    }
    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker.js']) {
      const modules = await modulesFor(entry);
      for (const module of semanticModules) expect(modules.has(module)).toBe(true);
    }
  });

  it('keeps scheduling tool semantics out of authority graphs', async () => {
    const semanticModules = new Set([
      'peerd-runtime/controller-schedule-tools.js',
      'peerd-runtime/tools/defs/schedule-create.js',
      'peerd-runtime/tools/defs/schedule-list.js',
      'peerd-runtime/tools/defs/schedule-cancel.js',
    ]);
    for (const entry of [
      'background/vault-kernel.js',
      'background/kernel-turn-live-factories.js',
      'background/controller-turn-bridge.js',
      'background/offscreen-actor-client.js',
    ]) {
      const modules = await modulesFor(entry);
      expect([...modules].filter((module) => semanticModules.has(module))).toEqual([]);
    }
    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker.js']) {
      const modules = await modulesFor(entry);
      for (const module of semanticModules) expect(modules.has(module)).toBe(true);
    }
  });

  it('keeps dweb catalog semantics out of authority graphs', async () => {
    const semanticModules = new Set([
      'peerd-runtime/controller-dweb-tools.js',
      'peerd-runtime/tools/defs/dweb-discover.js',
      'peerd-runtime/tools/defs/dweb-share.js',
      'peerd-runtime/tools/defs/dweb-install.js',
      'peerd-runtime/tools/defs/dweb-peers.js',
      'peerd-runtime/tools/defs/dweb-block.js',
      'peerd-runtime/tools/defs/dweb-discovery.js',
      'peerd-runtime/tools/defs/dweb-guide.js',
    ]);
    for (const entry of [
      'background/vault-kernel.js',
      'background/kernel-turn-live-factories.js',
      'background/controller-turn-bridge.js',
      'background/offscreen-actor-client.js',
    ]) {
      const modules = await modulesFor(entry);
      expect([...modules].filter((module) => semanticModules.has(module))).toEqual([]);
    }
    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker.js']) {
      const modules = await modulesFor(entry);
      for (const module of semanticModules) expect(modules.has(module)).toBe(true);
    }
  });

  it('keeps controller-local semantics out of authority graphs and has no generic effect lane', async () => {
    const semanticModules = new Set([
      'peerd-runtime/controller-local-tools.js',
      'peerd-runtime/clock/execute.js',
    ]);
    for (const entry of [
      'background/vault-kernel.js',
      'background/kernel-turn-live-factories.js',
      'background/controller-turn-bridge.js',
    ]) {
      const modules = await modulesFor(entry);
      expect([...modules].filter((module) => semanticModules.has(module))).toEqual([]);
    }
    const controllerModules = await modulesFor('offscreen/controller-turn-runtime.js');
    for (const module of semanticModules) expect(controllerModules.has(module)).toBe(true);

    const authoritySource = readFileSync(
      join(EXTENSION_ROOT, 'background/controller-turn-bridge.js'), 'utf8',
    );
    const controllerSource = readFileSync(
      join(EXTENSION_ROOT, 'offscreen/controller-turn-runtime.js'), 'utf8',
    );
    expect(authoritySource).toContain("case 'turn.goal.complete'");
    expect(controllerSource).toContain("rpc('turn.goal.complete'");
    for (const source of [authoritySource, controllerSource]) {
      expect(source).not.toContain('turn.tool.effect');
      expect(source).not.toContain('handleToolEffect');
    }
    for (const removed of [
      'peerd-runtime/controller-tools.js',
      'offscreen/controller-tool-runtime.js',
      'offscreen/tool-execution-host.js',
    ]) expect(existsSync(join(EXTENSION_ROOT, removed))).toBe(false);
  });

  it('composes one synchronous owner path without a protocol or dynamic fallback', () => {
    const source = readFileSync(
      join(EXTENSION_ROOT, 'background/kernel-turn-live-factories.js'),
      'utf8',
    );
    expect(source).toContain('createControllerTurnSemantics()');
    expect(source).toContain('createKernelTurnAuthorityAdapter(deps,');
    expect(source).not.toContain('import(');
    expect(source).not.toMatch(/\b(operation|action)\s*,\s*payload\b/);
  });
});
