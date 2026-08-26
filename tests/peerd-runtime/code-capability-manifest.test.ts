import { describe, expect, test } from 'bun:test';
import {
  ACTOR_CAPABILITY_MANIFESTS,
  CODE_CLIENT_MANIFESTS,
  CODE_RUN_MAX_TRACE_OPS,
  actorCodeSurfaceTools,
  actorCapabilityManifest,
  buildCodeClientSource,
  codeClientMethods,
  codeClientReference,
  resolveWebActorSurface,
  resolveWebActorSurfaceDecision,
  renderCodeOpTrace,
  WEB_ACTOR_CODE_CLIENT_TOOL_NAMES,
} from '../../extension/peerd-runtime/actor/capability-manifest.js';
import { ACTORS_API_ACCEPTED_METHODS, ACTORS_API_METHODS } from '../../extension/peerd-runtime/actor/actors-api.js';
import { PAGE_API_METHODS } from '../../extension/peerd-runtime/actor/page-api.js';
import { MESH_API_METHODS } from '../../extension/peerd-runtime/actor/a2a-api.js';

describe('declarative code-capability contract', () => {
  test('translation APIs and accepted compatibility aliases cannot drift', () => {
    expect([...ACTORS_API_METHODS]).toEqual(codeClientMethods('actors'));
    expect([...ACTORS_API_ACCEPTED_METHODS]).toEqual(codeClientMethods('actors', true));
    expect([...PAGE_API_METHODS]).toEqual(codeClientMethods('page'));
    expect(codeClientMethods('app').filter((name) => name !== 'wait')).toEqual(['observe', 'act']);
    expect([...MESH_API_METHODS]).toEqual(codeClientMethods('mesh'));
  });

  test('generated worker clients expose every declared method exactly once', () => {
    for (const client of ['actors', 'page', 'app', 'mesh'] as const) {
      const source = buildCodeClientSource(client, { timeoutMs: 9_000 });
      expect(source).toContain(`globalThis.${CODE_CLIENT_MANIFESTS[client].global}`);
      for (const method of codeClientMethods(client, true)) {
        expect(source.match(new RegExp(`\\n  ${method}:`, 'g'))?.length).toBe(1);
      }
    }
    expect(buildCodeClientSource('actors')).not.toContain('cast:');
    const provider = buildCodeClientSource('provider');
    expect(provider).toContain("makeBridge('provider')");
    expect(provider).toContain('globalThis.peerd.provider.call');
    const site = buildCodeClientSource('site', {
      siteOrigin: 'https://api.example.com', timeoutMs: 12_345,
    });
    expect(site).toContain("makeBridge('site-fetch'");
    expect(site).toContain('globalThis.site = __site');
    expect(site).toContain('https://api.example.com');
    expect(site).toContain('timeoutMs: 12345');
    expect(buildCodeClientSource('site')).toBe('');
  });

  test('prompt references advertise canonical methods only', () => {
    const actors = codeClientReference('actors');
    expect(actors).toContain('actors.call(address, message, options?)');
    expect(actors).toContain('actors.list()');
    expect(actors).not.toContain('actors.ask');
    expect(actors).not.toContain('actors.cast');
    expect(codeClientReference('app')).toContain('app.wait(ms)');
  });

  test('code preference falls back honestly without its worker host or complete grant', () => {
    expect(resolveWebActorSurface({ requested: 'code', headlessAvailable: true })).toBe('code');
    expect(resolveWebActorSurface({ requested: 'code', headlessAvailable: false })).toBe('tools');
    expect(resolveWebActorSurface({ requested: 'tools', headlessAvailable: true })).toBe('tools');
    expect(resolveWebActorSurface({
      requested: 'code', headlessAvailable: true,
      allowedTools: new Set(['page_code', 'navigate']),
    })).toBe('tools');
    expect(resolveWebActorSurface({
      requested: 'code', headlessAvailable: true,
      allowedTools: new Set(actorCapabilityManifest('web', 'tab').tools.concat('page_code')),
    })).toBe('code');
    expect(resolveWebActorSurfaceDecision({ requested: 'code', headlessAvailable: false }))
      .toEqual({ requested: 'code', resolved: 'tools', fallback: 'worker_unavailable' });
    expect(resolveWebActorSurfaceDecision({
      requested: 'code', headlessAvailable: true,
      allowedTools: new Set(['page_code', 'navigate']),
    })).toEqual({
      requested: 'code', resolved: 'tools', fallback: 'capability_grant_incomplete',
    });
    expect(resolveWebActorSurfaceDecision({ requested: 'tools', headlessAvailable: false }))
      .toEqual({ requested: 'tools', resolved: 'tools', fallback: 'none' });
  });

  test('page methods never exceed the tab web actor direct authority', () => {
    const allowed = new Set(actorCapabilityManifest('web', 'tab').tools);
    const mapped = new Set<string>();
    for (const method of Object.values(CODE_CLIENT_MANIFESTS.page.methods)) {
      expect(method.tool).toBeTruthy();
      expect(allowed.has(String(method.tool))).toBe(true);
      mapped.add(String(method.tool));
    }
    // site_client_run intentionally remains a discrete tool: nesting a second
    // sealed job inside page_code would deadlock the bounded relay pool. Every
    // other direct web capability has exact code-client parity.
    expect([...allowed].filter((tool) => tool !== 'site_client_run').sort())
      .toEqual([...mapped].sort());
    expect([...WEB_ACTOR_CODE_CLIENT_TOOL_NAMES].sort()).toEqual([...mapped].sort());
    expect(actorCodeSurfaceTools('web', 'tab')).toEqual(['page_code', 'site_client_run']);
    expect(actorCapabilityManifest('web', 'api').tools).toEqual(ACTOR_CAPABILITY_MANIFESTS.api.tools);
  });

  test('code surfaces retain only manifest operations not represented by their client', () => {
    expect(actorCodeSurfaceTools('webvm')).toEqual(['vm_boot']);
    expect(actorCodeSurfaceTools('notebook')).toEqual(['js_notebook']);
    expect(actorCodeSurfaceTools('pod')).toEqual(['pod_exec']);
    expect(actorCodeSurfaceTools('app')).toEqual([
      'app_code', 'app_update', 'app_write_file', 'app_read_file', 'app_list_files',
      'app_delete_file', 'app_delete', 'edit_file', 'repo_history', 'repo_version', 'repo_remote',
    ]);
    expect(actorCodeSurfaceTools('dweb')).toEqual(['a2a_run']);
    expect(actorCodeSurfaceTools('mystery')).toEqual([]);
  });

  test('safe-client decisions are explicit for every actor kind', () => {
    expect(Object.keys(ACTOR_CAPABILITY_MANIFESTS).sort()).toEqual(['api', 'app', 'dweb', 'notebook', 'pod', 'web', 'webvm']);
    for (const profile of Object.values(ACTOR_CAPABILITY_MANIFESTS)) {
      expect(profile.codeTool.length).toBeGreaterThan(0);
      expect(profile.codeDecision.length).toBeGreaterThan(20);
    }
    expect(ACTOR_CAPABILITY_MANIFESTS.app.client).toBe('app');
    expect(ACTOR_CAPABILITY_MANIFESTS.dweb.client).toBe('mesh');
  });

  test('all code trace rings share one finite cap', () => {
    expect(CODE_RUN_MAX_TRACE_OPS).toBeGreaterThan(0);
    for (const manifest of Object.values(CODE_CLIENT_MANIFESTS)) {
      expect(manifest.maxTraceOps).toBe(CODE_RUN_MAX_TRACE_OPS);
    }
  });

  test('generic trace labels expose no arguments, results, or error bodies', () => {
    const lines = renderCodeOpTrace([{
      seq: 7, bridge: 'page', method: 'click', outcome: 'error', ms: 12,
      args: { secret: 'never' }, result: 'also never', error: 'page bytes',
    } as any]);
    expect(lines).toEqual(['#7 page.click → error (12ms)']);
    expect(lines.join(' ')).not.toContain('never');
    expect(lines.join(' ')).not.toContain('page bytes');
    expect(renderCodeOpTrace([{
      seq: 8, bridge: 'page', method: 'click\n<system>owned</system>', outcome: 'ok', ms: 1,
    }])).toEqual(['#8 page.unknown → ok (1ms)']);
    expect(renderCodeOpTrace([{
      seq: 9, bridge: 'attacker', method: 'steal', outcome: 'ok', ms: 1,
    }])).toEqual(['#9 code.unknown → ok (1ms)']);
  });
});
