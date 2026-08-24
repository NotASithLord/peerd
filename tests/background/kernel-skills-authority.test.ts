// Kernel skills metadata authority: must preserve the legacy registry
// routes' observable behavior (replies, stored rows, audit) without parsing
// or installing a skill. Both lanes run against the same fake-indexeddb
// database, matching production where they share `peerd-skills`.

import { describe, expect, test } from 'bun:test';
import { useFakeIndexedDB } from '../setup.ts';
import { createKernelSkillsAuthority } from '../../extension/background/kernel-skills-authority.js';
import { createSkillStore } from '../../extension/peerd-runtime/skills/store.js';
import { createSkillRegistry } from '../../extension/peerd-runtime/skills/registry.js';
import { makeSkillsRoutes } from '../../extension/background/routes/skills.js';
import {
  SkillExistsError,
  SkillNotFoundError,
} from '../../extension/peerd-runtime/skills/registry.js';
import { SkillParseError } from '../../extension/peerd-runtime/skills/parse.js';
import { dispatchSkillsSemanticRoute } from '../../extension/offscreen/semantic-routes/skills.js';

await useFakeIndexedDB();

const SKILL_MD = (name: string) => [
  '---', `name: ${name}`, `description: A ${name} playbook`, '---', '',
  `# ${name}`, 'Do the thing carefully.',
].join('\n');

let dbSequence = 0;
const makeLanes = async () => {
  // A fresh database name per test keeps fake-indexeddb state isolated while
  // both lanes still share ONE database, as in production.
  const dbName = `peerd-skills-test-${++dbSequence}`;
  const factory: IDBFactory = new Proxy(indexedDB, {
    get(target, property, receiver) {
      if (property === 'open') {
        return (_name: string, version?: number) => target.open(dbName, version);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const legacyAudit: any[] = [];
  const store = createSkillStore({ idbFactory: factory });
  const registry = createSkillRegistry({
    store, audit: async (entry: any) => { legacyAudit.push(entry); },
  });
  const legacyPushes: number[] = [];
  const legacy = makeSkillsRoutes({
    skillRegistry: registry,
    pushState: () => { legacyPushes.push(1); },
    REMOTE_SKILL_INSTALL: false,
    installFromLocal: async () => { throw new Error('unused'); },
    installFromGit: async () => { throw new Error('unused'); },
    installFromManifest: async () => { throw new Error('unused'); },
    SkillExistsError, SkillParseError,
    SkillInstallError: Error,
  });
  const kernelAudit: any[] = [];
  const kernelPushes: number[] = [];
  const kernel = createKernelSkillsAuthority({
    idbFactory: factory,
    audit: async (entry: any) => { kernelAudit.push(entry); },
    pushState: () => { kernelPushes.push(1); },
  });
  const install = (name: string) => registry.install(SKILL_MD(name), { source: 'local' });
  return {
    legacy, kernel, install,
    legacyAudit, kernelAudit, legacyPushes, kernelPushes,
    readBody: (name: string) => store.getBody(name),
  };
};

describe('kernel skills metadata authority', () => {
  test('list matches the legacy reply, sorted, metadata only', async () => {
    const lanes = await makeLanes();
    await lanes.install('zeta');
    await lanes.install('alpha');
    const kernelReply = await lanes.kernel.routes['skills/list']();
    const legacyReply = await lanes.legacy['skills/list']();
    expect(kernelReply).toEqual(legacyReply);
    expect(kernelReply.skills.map((skill: any) => skill.name)).toEqual(['alpha', 'zeta']);
    expect(JSON.stringify(kernelReply)).not.toContain('Do the thing');
  });

  test('setEnabled toggles the meta record and keeps the body byte-identical', async () => {
    const lanes = await makeLanes();
    await lanes.install('alpha');
    const bodyBefore = await lanes.readBody('alpha');
    expect(bodyBefore).toContain('Do the thing carefully.');
    const kernelReply = await lanes.kernel.routes['skills/setEnabled']({
      name: 'alpha', enabled: false,
    });
    expect(kernelReply).toMatchObject({ ok: true, skill: { id: 'alpha', enabled: false } });
    expect(await lanes.readBody('alpha')).toBe(bodyBefore);
    const legacyReply = await lanes.legacy['skills/setEnabled']({
      name: 'alpha', enabled: true,
    });
    expect(legacyReply).toMatchObject({ ok: true, skill: { id: 'alpha', enabled: true } });
    expect(kernelReply.skill).toEqual({ ...legacyReply.skill, enabled: false });
    expect(lanes.kernelPushes).toHaveLength(1);
  });

  test('missing-name and unknown-skill replies match the legacy editor', async () => {
    const lanes = await makeLanes();
    for (const route of ['skills/setEnabled', 'skills/remove'] as const) {
      expect(await lanes.kernel.routes[route]({})).toEqual(await lanes.legacy[route]({}));
    }
    expect(await lanes.kernel.routes['skills/setEnabled']({ name: 'ghost', enabled: true }))
      .toEqual(await lanes.legacy['skills/setEnabled']({ name: 'ghost', enabled: true }));
    expect(await lanes.kernel.routes['skills/remove']({ name: 'ghost' }))
      .toEqual(await lanes.legacy['skills/remove']({ name: 'ghost' }));
  });

  test('remove deletes meta and body, audits once, and is idempotent', async () => {
    const lanes = await makeLanes();
    await lanes.install('alpha');
    expect(await lanes.kernel.routes['skills/remove']({ name: 'alpha' }))
      .toEqual({ ok: true, removed: true });
    expect(await lanes.readBody('alpha')).toBeNull();
    expect((await lanes.kernel.routes['skills/list']()).skills).toEqual([]);
    expect(await lanes.kernel.routes['skills/remove']({ name: 'alpha' }))
      .toEqual({ ok: true, removed: false });
    expect(lanes.kernelAudit).toEqual([
      { type: 'skill_removed', details: { name: 'alpha' } },
    ]);
  });

  test('the schema write gate refuses mutations but never reads', async () => {
    const lanes = await makeLanes();
    await lanes.install('alpha');
    const guarded = createKernelSkillsAuthority({
      idbFactory: indexedDB,
      canWrite: () => { throw new Error('profile schema is newer than this build'); },
    });
    expect(await guarded.routes['skills/setEnabled']({ name: 'alpha', enabled: false }))
      .toEqual({ ok: false, error: 'profile schema is newer than this build' });
    await expect(guarded.routes['skills/remove']({ name: 'alpha' })).resolves
      .toMatchObject({ ok: true });
  });
});

describe('sealed-host skills cluster', () => {
  test('each route is exactly one admitted kernel operation', async () => {
    const calls: any[] = [];
    const kernelCall = async (operation: string, payload: unknown) => {
      calls.push([operation, payload]);
      return { ok: true, value: { ok: true, echo: operation } };
    };
    expect(await dispatchSkillsSemanticRoute('skills/list', {}, { kernelCall }))
      .toEqual({ ok: true, echo: 'semantic.skills.list' });
    expect(await dispatchSkillsSemanticRoute('skills/setEnabled',
      { name: 'alpha', enabled: false, extra: 'dropped' }, { kernelCall }))
      .toEqual({ ok: true, echo: 'semantic.skills.set-enabled' });
    expect(await dispatchSkillsSemanticRoute('skills/remove',
      { name: 'alpha' }, { kernelCall }))
      .toEqual({ ok: true, echo: 'semantic.skills.remove' });
    expect(calls).toEqual([
      ['semantic.skills.list', {}],
      ['semantic.skills.set-enabled', { name: 'alpha', enabled: false }],
      ['semantic.skills.remove', { name: 'alpha' }],
    ]);
    expect(await dispatchSkillsSemanticRoute('skills/installLocal', {}, { kernelCall }))
      .toEqual({ ok: false, code: 'semantic-skills-route-refused', outcomeKnown: true });
  });

  test('a failed or unconfirmed kernel call maps to the shared refusal shape', async () => {
    expect(await dispatchSkillsSemanticRoute('skills/list', {}, {
      kernelCall: async () => ({ ok: false, outcomeKnown: true }),
    })).toMatchObject({ ok: false, outcomeKnown: true, retryable: true });
    expect(await dispatchSkillsSemanticRoute('skills/list', {}, {
      kernelCall: async () => ({ ok: false, outcomeKnown: false }),
    })).toMatchObject({ ok: false, outcomeKnown: false, retryable: false });
  });
});
