import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const providerRoot = new URL('../../extension/peerd-provider/', import.meta.url);
const semanticFiles = [
  'adapters/anthropic.js',
  'adapters/glm.js',
  'adapters/local-webgpu.js',
  'adapters/ollama.js',
  'adapters/openai.js',
  'adapters/openrouter.js',
  'registry.js',
];

describe('controller provider boundary', () => {
  test('adapters and registry contain no authority-bearing request data', async () => {
    const source = (await Promise.all(semanticFiles.map((file) =>
      readFile(new URL(file, providerRoot), 'utf8')))).join('\n');
    for (const forbidden of [
      'getSecret',
      'safeFetch',
      'vaultSecretName',
      'ollamaHost',
      'provider-authority-policy',
      'authorization',
      'x-api-key',
      'http://',
      'https://',
    ]) expect(source).not.toContain(forbidden);
  });

  test('the sealed-controller surface exports semantic execution policy', async () => {
    const controller = await import('../../extension/peerd-provider/controller.js');
    for (const name of [
      'callModel',
      'listProviders',
      'listProviderModels',
      'providerModelContextWindow',
      'planFailoverChain',
      'shouldFailover',
      'contextWindowFor',
      'costOf',
    ]) expect(typeof (controller as any)[name]).toBe('function');
  });
});
