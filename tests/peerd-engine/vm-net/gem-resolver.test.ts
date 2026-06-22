import { describe, test, expect } from 'bun:test';
import {
  parseSpec, selectGem, runtimeDeps, resolveTree,
} from '../../../extension/peerd-engine/vm-net/gem-resolver.js';

describe('parseSpec', () => {
  test('plain and version-pinned', () => {
    expect(parseSpec('rails')).toEqual({ name: 'rails', version: null });
    expect(parseSpec('sinatra:3.1.0')).toEqual({ name: 'sinatra', version: '3.1.0' });
  });
});

describe('selectGem', () => {
  test('pure-ruby gem → download url + filename', () => {
    expect(selectGem({ name: 'rake', version: '13.1.0', platform: 'ruby' })).toEqual({
      version: '13.1.0',
      url: 'https://rubygems.org/downloads/rake-13.1.0.gem',
      filename: 'rake-13.1.0.gem',
    });
  });
  test('absent platform defaults to ruby', () => {
    expect(selectGem({ name: 'rake', version: '1.0.0' })?.filename).toBe('rake-1.0.0.gem');
  });
  test('native platform → null', () => {
    expect(selectGem({ name: 'nokogiri', version: '1.16.0', platform: 'x86_64-linux' })).toBeNull();
  });
});

describe('runtimeDeps', () => {
  test('keeps runtime, drops development, dedups', () => {
    const json = { dependencies: {
      runtime: [{ name: 'rack' }, { name: 'tilt' }, { name: 'rack' }],
      development: [{ name: 'rspec' }],
    } };
    expect(runtimeDeps(json)).toEqual(['rack', 'tilt']);
  });
  test('empty when no deps', () => {
    expect(runtimeDeps({})).toEqual([]);
  });
});

describe('resolveTree', () => {
  const reg: Record<string, any> = {
    sinatra: { name: 'sinatra', version: '3.1.0', platform: 'ruby',
      dependencies: { runtime: [{ name: 'rack' }, { name: 'tilt' }], development: [{ name: 'rspec' }] } },
    rack: { name: 'rack', version: '3.0.8', platform: 'ruby', dependencies: { runtime: [] } },
    tilt: { name: 'tilt', version: '2.3.0', platform: 'ruby', dependencies: { runtime: [{ name: 'rack' }] } },
    nokogiri: { name: 'nokogiri', version: '1.16.0', platform: 'x86_64-linux', dependencies: { runtime: [] } },
  };
  const getGem = async (n: string) => reg[n];

  test('resolves a pure-ruby transitive tree, deduped', async () => {
    const plan = await resolveTree(['sinatra'], getGem);
    expect(plan.map((g) => g.name).sort()).toEqual(['rack', 'sinatra', 'tilt']);
    expect(plan.find((g) => g.name === 'sinatra')?.url).toBe('https://rubygems.org/downloads/sinatra-3.1.0.gem');
  });

  test('fails loudly on a native gem', async () => {
    await expect(resolveTree(['nokogiri'], getGem)).rejects.toThrow(/native \(x86_64-linux\) gem/);
  });

  test('throws on a missing gem', async () => {
    await expect(resolveTree(['ghost'], getGem)).rejects.toThrow(/not found/);
  });
});
