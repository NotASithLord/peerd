import { describe, test, expect } from 'bun:test';
import { buildAppManifest, parseAppManifest } from '../../extension/peerd-engine/app-manifest.js';

describe('peerd.json App contract', () => {
  test('round-trips an ordinary App and a dweb-capable dwapp', () => {
    expect(parseAppManifest(JSON.stringify(buildAppManifest({ entry: 'src/index.html' })))).toEqual({
      schema: 1, kind: 'app', entry: 'src/index.html',
      agent: { kind: 'bound-app', profile: 'developer', surface: 'code' }, capabilities: [],
    });
    expect(parseAppManifest(JSON.stringify(buildAppManifest({ entry: 'index.html', dwapp: true })))).toMatchObject({
      kind: 'dwapp', capabilities: ['dweb'],
    });
  });

  test('rejects traversal, ambient agents, and unknown capabilities', () => {
    const base = buildAppManifest({ entry: 'index.html' });
    expect(() => parseAppManifest(JSON.stringify({ ...base, entry: '../secret' }))).toThrow('entry is unsafe');
    expect(() => parseAppManifest(JSON.stringify({ ...base, agent: { kind: 'remote' } }))).toThrow('agent.kind');
    expect(() => parseAppManifest(JSON.stringify({ ...base, capabilities: ['network'] }))).toThrow('unknown capability');
    expect(() => parseAppManifest(JSON.stringify({ ...base, kind: 'dwapp' }))).toThrow('must declare dweb');
  });

  test('carries a bounded app-specific actor loop and runtime tools', () => {
    const manifest = parseAppManifest(JSON.stringify({
      ...buildAppManifest({ entry: 'index.html', dwapp: true }),
      agent: {
        kind: 'bound-app',
        name: 'Charon game developer',
        instructions: 'Play, observe, edit, and repeat.',
        profile: 'developer',
        surface: 'code',
        runtime: ['observe', 'act', 'observe'],
      },
    }));
    expect(manifest.agent).toEqual({
      kind: 'bound-app',
      profile: 'developer',
      surface: 'code',
      name: 'Charon game developer',
      instructions: 'Play, observe, edit, and repeat.',
      runtime: ['observe', 'act'],
    });
  });

  test('rejects unbounded or unknown app-agent authority', () => {
    const base = buildAppManifest({ entry: 'index.html' });
    expect(() => parseAppManifest(JSON.stringify({
      ...base, agent: { kind: 'bound-app', profile: 'developer', surface: 'code', runtime: ['fetch'] },
    }))).toThrow('unknown App runtime method');
    expect(() => parseAppManifest(JSON.stringify({
      ...base, agent: { kind: 'bound-app', tools: ['app_code'] },
    }))).toThrow('agent.tools is unsupported');
    expect(() => parseAppManifest(JSON.stringify({
      ...base, agent: { kind: 'bound-app', instructions: 'x'.repeat(12_001) },
    }))).toThrow('agent.instructions');
  });
});
