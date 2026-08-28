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

const KERNEL_TURN_LIFECYCLE_EXPORTS = Object.freeze([
  'DEFAULT_MAX_OUTPUT_TOKENS', 'DOC_TEXT_MAX_CHARS', 'GOAL_MAX_ITERATIONS',
  'PERMISSION_MODES',
  'buildMintInjection', 'confirmActionsFromRecord', 'createSkillRegistry',
  'createSuggestionStore', 'describeLandingStop', 'digestCapture',
  'drainFetchTapInjected', 'fenceApiActorSummary', 'fenceWebActorSummary',
  'finalActorTurnReply', 'finalAssistantText', 'formatDocBody',
  'installFetchTapInjected', 'landingStopCard', 'limitExceeded', 'makeAutoMemory',
  'makeCheapCall', 'makeGoalRunner', 'makeScheduler', 'makeSpawnActor',
  'makeTrimEnricher', 'meshCallToOp', 'normalizeApiOrigin',
  'normalizeConfirmActions', 'normalizeMode', 'normalizeTally', 'originPhrase',
  'parseSiteHandle', 'prepareUserAttachmentsWithDocs', 'resolveSiteUrl',
  'safeWebActorSummaryOrigin', 'shapeMeshResult', 'siteHandleFor', 'wrapUntrusted',
]);

const KERNEL_TURN_LIFECYCLE_TARGETS = Object.freeze([
  './actor/a2a-api.js', './actor/cheap-call.js', './actor/origin-lock-report.js',
  './actor/spawn.js', './actor/web-actor.js', './cost/accumulator.js',
  './doc/format.js', './dom/fetch-tap-injected.js', './loop/attachments.js',
  './loop/goal-runner.js', './loop/scheduler.js', './loop/summary-enrichment.js',
  './memory/auto-memory-orchestrator.js', './memory/suggestions.js',
  './permissions/policy.js', './site-clients/core.js', './site-clients/digest.js',
  './skills/registry.js', './tools/prompt-wrap.js',
]);

const exactReExports = (source: string) => [...source.matchAll(
  /export\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"];/g,
)].map((match) => ({
  target: match[2],
  names: match[1].split(',').map((name) => name.trim().split(/\s+as\s+/).at(-1))
    .filter((name): name is string => Boolean(name)),
}));

describe('kernel turn ownership boundaries', () => {
  it('keeps the retired mutable tool protocol absent from production source', () => {
    for (const path of [
      'peerd-runtime/tools/registry.js',
      'peerd-runtime/tools/metadata-registry.js',
      'peerd-runtime/tools/metadata/policy.js',
    ]) expect(existsSync(join(EXTENSION_ROOT, path)), path).toBe(false);

    const source = [...new Bun.Glob('**/*.js').scanSync({ cwd: EXTENSION_ROOT })]
      .filter((path) => !path.startsWith('tests/'))
      .map((path) => readFileSync(join(EXTENSION_ROOT, path), 'utf8'))
      .join('\n');
    for (const retired of [
      'registerTool', 'makeRelayedToolDispatch',
      'turn.tool.prepare', 'turn.tool.settle', 'turn.tool.dispatch',
      'page_eval', 'page_exec', 'page_keys', 'wait_until', 'dweb_guide',
      'read_web_cache', 'read_run_cache', 'toolbox',
    ]) expect(source, retired).not.toContain(retired);
  });

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
      'peerd-runtime/loop/turn-authority-driver.js',
      'peerd-runtime/loop/goal-runner.js',
      'peerd-runtime/todo/core.js',
    ]) expect(modules.has(module), `authority runtime imports ${module}`).toBe(false);
    expect(existsSync(join(EXTENSION_ROOT, 'peerd-runtime/kernel-turn.js'))).toBe(false);
    expect(existsSync(join(EXTENSION_ROOT, 'peerd-runtime/loop/turn-driver.js'))).toBe(false);
  });

  it('links the fixed turn shell through authority and deletes the semantic aggregate', async () => {
    const authorityModules = await modulesFor('background/kernel-turn-authority-adapter.js');
    expect(authorityModules.has('peerd-runtime/loop/turn-authority-driver.js')).toBe(true);
    expect(authorityModules.has('peerd-runtime/kernel-turn-lifecycle.js')).toBe(true);
    expect(authorityModules.has('peerd-runtime/controller-turn-semantics.js')).toBe(false);
    expect(existsSync(join(
      EXTENSION_ROOT, 'peerd-runtime/controller-turn-semantics.js',
    ))).toBe(false);
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

  it('wires the actor host through one exact dependency vocabulary', () => {
    const client = readFileSync(
      join(EXTENSION_ROOT, 'background/offscreen-actor-client.js'), 'utf8',
    );
    expect(client).toContain('ensureHost, sendMessage, runOnChannel, providerEgress');
    expect(client).toContain('isRelaySender,');
    expect(client).not.toContain('ensureOffscreen');
    expect(client).not.toContain('isOffscreenSender');
    expect(client).not.toContain('ensureHost ??');
    expect(client).not.toContain('isRelaySender ??');

    const adapter = readFileSync(
      join(EXTENSION_ROOT, 'background/kernel-turn-authority-adapter.js'), 'utf8',
    );
    expect(adapter.match(/makeActorClient\(\{/g)).toHaveLength(1);
    expect(adapter).toContain('ensureHost: async () => {');
    expect(adapter).toContain('isRelaySender: deps.firefox');
  });

  it('admits every exact controller domain handler through the fixed channel ledger', () => {
    const bridge = readFileSync(
      join(EXTENSION_ROOT, 'background/controller-turn-bridge.js'), 'utf8',
    );
    const quota = readFileSync(
      join(EXTENSION_ROOT, 'shared/controller-kernel-quota.js'), 'utf8',
    );
    const domainHandlers = [...bridge.matchAll(
      /case '(turn\.(?:memory|todo|resource|site-client|execution|editing|introspection|schedule|dweb)\.[^']+)':/g,
    )].map((match) => match[1]);
    expect(domainHandlers.length).toBeGreaterThan(0);
    for (const operation of domainHandlers) {
      expect(quota, `${operation} is missing from the fixed authority ledger`)
        .toContain(`'${operation}': { authorityClass:`);
    }
    for (const operation of [
      'turn.model.open-local', 'turn.model.read-local', 'turn.model.cancel-local',
    ]) expect(quota).toContain(`'${operation}':`);
  });

  it('freezes the exact kernel turn lifecycle entry point', () => {
    const lifecycle = readFileSync(
      join(EXTENSION_ROOT, 'peerd-runtime/kernel-turn-lifecycle.js'), 'utf8',
    );
    const exports = exactReExports(lifecycle);
    expect(exports.flatMap(({ names }) => names).sort())
      .toEqual([...KERNEL_TURN_LIFECYCLE_EXPORTS].sort());
    expect(exports.map(({ target }) => target).sort())
      .toEqual([...KERNEL_TURN_LIFECYCLE_TARGETS].sort());
    expect([...lifecycle.matchAll(/\bexport\b/g)]).toHaveLength(exports.length);
    expect(lifecycle).not.toContain('import(');

    const adapter = readFileSync(
      join(EXTENSION_ROOT, 'background/kernel-turn-authority-adapter.js'), 'utf8',
    );
    expect(adapter.split("from '/peerd-runtime/kernel-turn-lifecycle.js';"))
      .toHaveLength(2);
    expect(adapter).not.toContain('/peerd-runtime/controller-turn-semantics.js');
  });

  it('keeps the dynamically imported actor semantic roots outside host authority graphs', async () => {
    const forbiddenPrefixes = [
      'background/',
      'peerd-egress/vault/',
      'peerd-egress/storage/',
      'peerd-egress/credentials/',
      'peerd-egress/dpop/',
    ];
    const forbiddenModules = new Set([
      'shared/browser-api.js',
      'peerd-provider/background.js',
      'peerd-engine/background.js',
    ]);
    for (const entry of [
      'offscreen/actor-worker-runtime.js',
      'peerd-runtime/controller-contributor.js',
    ]) {
      const modules = await modulesFor(entry);
      expect(modules.size, `${entry} must exercise its real static graph`).toBeGreaterThan(1);
      expect([...modules].filter((module) => forbiddenModules.has(module)
        || forbiddenPrefixes.some((prefix) => module.startsWith(prefix))), entry).toEqual([]);
    }
  });

  it('keeps the authority adapter transitively free of growing semantic runtimes', async () => {
    const modules = await modulesFor('background/kernel-turn-authority-adapter.js');
    const forbiddenPrefixes = [
      'peerd-provider/',
      'peerd-runtime/tools/defs/',
    ];
    const forbiddenModules = new Set([
      'peerd-runtime/controller-turn-semantics.js',
      'peerd-runtime/controller-contributor.js',
      'peerd-runtime/controller-tool-ownership.js',
      'peerd-runtime/controller-tool-projection.js',
      'peerd-runtime/controller-turn.js',
      'peerd-runtime/tools/hooks/registry.js',
      'peerd-runtime/tools/metadata/authority.js',
      'peerd-runtime/tools/metadata/catalog.js',
      'peerd-runtime/tools/metadata/index.js',
      'peerd-runtime/tools/metadata-registry.js',
      'peerd-runtime/tools/registry.js',
    ]);

    expect([...modules].filter((module) =>
      forbiddenModules.has(module)
        || forbiddenPrefixes.some((prefix) => module.startsWith(prefix))
        || /^peerd-runtime\/controller-(?:.*-)?tools\.js$/.test(module))).toEqual([]);
  });

  it('keeps tool inventory and exposure projection in the sealed controller', async () => {
    const authorityModules = await modulesFor('background/kernel-turn-live-factories.js');
    for (const module of [
      'peerd-runtime/controller-tool-projection.js',
      'peerd-runtime/tools/metadata/authority.js',
      'peerd-runtime/tools/metadata/catalog.js',
    ]) expect(authorityModules.has(module), `authority graph imports ${module}`).toBe(false);

    const controllerModules = await modulesFor('offscreen/controller-turn-runtime.js');
    for (const module of [
      'peerd-runtime/controller-tool-projection.js',
      'peerd-runtime/tools/metadata/authority.js',
      'peerd-runtime/tools/metadata/catalog.js',
    ]) expect(controllerModules.has(module), `controller graph omits ${module}`).toBe(true);

    const driver = readFileSync(
      join(EXTENSION_ROOT, 'peerd-runtime/loop/turn-authority-driver.js'), 'utf8',
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
      join(EXTENSION_ROOT, 'peerd-runtime/loop/turn-authority-driver.js'), 'utf8',
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

    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker-runtime.js']) {
      const modules = await modulesFor(entry);
      expect(modules.has('peerd-runtime/controller-actor-tools.js')).toBe(true);
      for (const module of actorSemanticModules) expect(modules.has(module)).toBe(true);
    }
  });

  it('keeps actor prompt, projection, and result shaping out of the orchestrator authority driver', async () => {
    const modules = await modulesFor('peerd-runtime/loop/turn-authority-driver.js');
    for (const module of [
      'peerd-runtime/actor/capability-manifest.js',
      'peerd-runtime/tools/exposure.js',
    ]) expect(modules.has(module), `orchestrator driver imports ${module}`).toBe(false);
    const source = readFileSync(
      join(EXTENSION_ROOT, 'peerd-runtime/loop/turn-authority-driver.js'), 'utf8',
    );
    for (const semanticPath of [
      "surface: 'actor'", 'turn/actor-start', 'turn/actor-state',
      'turn/actor-cost', 'turn/actor-error', 'turn/actor-done',
    ]) expect(source).not.toContain(semanticPath);
    expect(source).toContain('actor_background_turn_refused');
  });

  it('keeps model-facing turn corrections in the sealed prompt renderer', () => {
    const driver = readFileSync(
      join(EXTENSION_ROOT, 'peerd-runtime/loop/turn-authority-driver.js'), 'utf8',
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

    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker-runtime.js']) {
      const modules = await modulesFor(entry);
      for (const module of podSemanticModules) expect(modules.has(module)).toBe(true);
    }
  });

  it('renders volatile temporal and foreground context only in the sealed controller', async () => {
    const authorityModules = await modulesFor('background/kernel-turn-live-factories.js');
    for (const module of [
      'peerd-runtime/clock/context.js',
      'peerd-runtime/loop/system-prompt.js',
    ]) expect(authorityModules.has(module), `authority graph imports ${module}`).toBe(false);

    const controllerModules = await modulesFor('offscreen/controller-turn-runtime.js');
    for (const module of [
      'peerd-runtime/clock/context.js',
      'peerd-runtime/loop/system-prompt.js',
    ]) expect(controllerModules.has(module), `controller graph omits ${module}`).toBe(true);

    const driver = readFileSync(
      join(EXTENSION_ROOT, 'peerd-runtime/loop/turn-authority-driver.js'), 'utf8',
    );
    expect(driver).not.toContain('buildTemporalBlock');
    expect(driver).not.toContain('buildTemporalContext');
    expect(driver).not.toContain('<active_tab>');
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

    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker-runtime.js']) {
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

    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker-runtime.js']) {
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
    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker-runtime.js']) {
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
    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker-runtime.js']) {
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
    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker-runtime.js']) {
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
    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker-runtime.js']) {
      const modules = await modulesFor(entry);
      for (const module of pageSemanticModules) expect(modules.has(module)).toBe(true);
    }
  });

  it('hosts document, web and result semantics only in controller graphs', async () => {
    const resourceSemanticModules = new Set([
      'peerd-runtime/controller-resource-tools.js',
      'peerd-runtime/tools/defs/read-doc.js',
      'peerd-runtime/tools/defs/fetch-url.js',
      'peerd-runtime/tools/defs/read-result.js',
    ]);
    for (const entry of [
      'background/kernel-turn-authority-adapter.js',
      'background/controller-turn-bridge.js',
      'background/offscreen-actor-client.js',
    ]) {
      const modules = await modulesFor(entry);
      expect([...modules].filter((module) => resourceSemanticModules.has(module))).toEqual([]);
    }
    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker-runtime.js']) {
      const modules = await modulesFor(entry);
      for (const module of resourceSemanticModules) expect(modules.has(module)).toBe(true);
    }
  });

  it('hosts site-client definitions and result shaping only in controller graphs', async () => {
    const semanticModules = new Set([
      'peerd-runtime/controller-site-client-tools.js',
      'peerd-runtime/tools/defs/site-client-run.js',
      'peerd-runtime/tools/defs/site-client-read.js',
      'peerd-runtime/tools/defs/site-client-write.js',
      'peerd-runtime/tools/defs/site-capture.js',
    ]);
    for (const entry of [
      'background/kernel-turn-authority-adapter.js',
      'background/controller-turn-bridge.js',
      'background/offscreen-actor-client.js',
    ]) {
      const modules = await modulesFor(entry);
      expect([...modules].filter((module) => semanticModules.has(module))).toEqual([]);
    }
    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker-runtime.js']) {
      const modules = await modulesFor(entry);
      for (const module of semanticModules) expect(modules.has(module)).toBe(true);
    }
  });

  it('hosts introspection and skill semantics only in controller graphs', async () => {
    const semanticModules = new Set([
      'peerd-runtime/controller-introspection-tools.js',
      'peerd-runtime/tools/defs/actor-list.js',
      'peerd-runtime/tools/defs/inspect.js',
      'peerd-runtime/skills/load-skill-tool.js',
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
    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker-runtime.js']) {
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
    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker-runtime.js']) {
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
    for (const entry of ['offscreen/controller-turn-runtime.js', 'offscreen/actor-worker-runtime.js']) {
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

  it('composes one direct authority adapter path without generic dispatch or fallback', async () => {
    const source = readFileSync(
      join(EXTENSION_ROOT, 'background/kernel-turn-live-factories.js'),
      'utf8',
    );
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)]
      .map((match) => match[1]);
    expect(imports).toEqual(['./kernel-turn-authority-adapter.js']);
    expect(source.match(/createKernelTurnAuthorityAdapter\(deps\)/g)).toHaveLength(1);
    expect(source).not.toContain('createControllerTurnSemantics');
    expect(source).not.toContain('semanticOwners');
    expect(source).not.toContain('import(');
    expect(source).not.toMatch(/\b(?:dispatch|fallback|legacy)\b/i);
    expect(source).not.toMatch(/\b(operation|action)\s*,\s*payload\b/);
    const modules = await modulesFor('background/kernel-turn-live-factories.js');
    expect(modules.has('background/kernel-turn-authority-adapter.js')).toBe(true);
    expect(modules.has('peerd-runtime/controller-turn-semantics.js')).toBe(false);
  });
});
