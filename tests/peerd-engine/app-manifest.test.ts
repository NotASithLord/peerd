import { describe, test, expect } from 'bun:test';
import { buildAppManifest, parseAppManifest } from '../../extension/peerd-engine/app-manifest.js';

describe('peerd.json App contract', () => {
  test('round-trips an ordinary App and a dweb-capable dwapp', () => {
    expect(parseAppManifest(JSON.stringify(buildAppManifest({ entry: 'src/index.html' })))).toEqual({
      schema: 1, kind: 'app', entry: 'src/index.html', agent: { kind: 'bound-app' }, capabilities: [],
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
});
