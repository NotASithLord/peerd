// resolveRunnerModel — the web actor model resolution.
// Pure; first match wins: pin → local WebGPU → provider default → inherit.

import { describe, expect, test } from 'bun:test';
import { resolveRunnerModel } from '../../extension/peerd-provider/runner-model.js';

const anthropic = { defaultRunnerModel: 'claude-haiku-4-5', defaultModel: 'claude-sonnet-4-6' };
const openrouter = { defaultRunnerModel: 'anthropic/claude-haiku-4.5', defaultModel: 'openai/gpt-4o-mini' };

describe('resolveRunnerModel', () => {
  test('blank setting → the active provider fast default (Haiku on Anthropic)', () => {
    expect(resolveRunnerModel({ settings: { runnerModel: '' }, provider: anthropic }))
      .toBe('claude-haiku-4-5');
  });

  test('blank setting on OpenRouter → Haiku via OpenRouter', () => {
    expect(resolveRunnerModel({ settings: {}, provider: openrouter }))
      .toBe('anthropic/claude-haiku-4.5');
  });

  test('explicit user pin wins over the provider default', () => {
    expect(resolveRunnerModel({ settings: { runnerModel: 'claude-opus-4-8' }, provider: anthropic }))
      .toBe('claude-opus-4-8');
  });

  test('pin is trimmed; whitespace-only is treated as no pin', () => {
    expect(resolveRunnerModel({ settings: { runnerModel: '  claude-haiku-4-5  ' }, provider: anthropic }))
      .toBe('claude-haiku-4-5');
    expect(resolveRunnerModel({ settings: { runnerModel: '   ' }, provider: anthropic }))
      .toBe('claude-haiku-4-5'); // falls through to provider default
  });

  test('local WebGPU runner, when available, beats the provider default', () => {
    expect(resolveRunnerModel({
      settings: {},
      provider: anthropic,
      localRunner: { available: true, model: 'gemma-local' },
    })).toBe('gemma-local');
  });

  test('local runner is ignored until available (download in flight / unsupported)', () => {
    expect(resolveRunnerModel({
      settings: {},
      provider: anthropic,
      localRunner: { available: false, model: 'gemma-local' },
    })).toBe('claude-haiku-4-5');
  });

  test('an explicit pin still wins over an available local runner', () => {
    expect(resolveRunnerModel({
      settings: { runnerModel: 'claude-opus-4-8' },
      provider: anthropic,
      localRunner: { available: true, model: 'gemma-local' },
    })).toBe('claude-opus-4-8');
  });

  test('provider without a runner default falls back to its chat default', () => {
    expect(resolveRunnerModel({ settings: {}, provider: { defaultModel: 'qwen3:8b' } }))
      .toBe('qwen3:8b');
  });

  test('no provider and no pin → inherit ("")', () => {
    expect(resolveRunnerModel({ settings: {} })).toBe('');
    expect(resolveRunnerModel({})).toBe('');
  });
});
