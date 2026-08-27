import { describe, expect, test } from 'bun:test';
import {
  filterByRuntimeCapabilities,
  requireRuntimeCapability,
  resolveRuntimeCapabilities,
  runtimeCapabilityPromptBlock,
  runtimeCapabilityRefusal,
} from '../../extension/peerd-runtime/runtime-capabilities.js';
import { exposureGate } from '../../extension/peerd-runtime/tools/gates.js';
import { fetchUrlTool } from '../../extension/peerd-runtime/tools/defs/fetch-url.js';
import { readPageTool } from '../../extension/peerd-runtime/tools/defs/read-page.js';
import { getToolMetadata } from '../../extension/peerd-runtime/semantic.js';

const names = [
  'script', 'read_result', 'page_code', 'app_code', 'site_client_run',
  'read_doc', 'dweb_discover', 'a2a_run', 'message_actor',
];
const descriptors = names.map((name) => ({ name }));

describe('runtime host capabilities', () => {
  test('an offscreen host enables the facilities it actually supplies', () => {
    const capability = resolveRuntimeCapabilities({ offscreenDocument: true, dwebPackaged: true });
    expect(capability.version).toBe(1);
    expect(capability.sealedJobs.status).toBe('available');
    expect(capability.documentReader.status).toBe('available');
    expect(capability.moonshineVoiceHost.status).toBe('available');
    expect(capability.pdfOcr.status).toBe('available');
    expect(capability.localWebGpuHost.status).toBe('available');
    expect(capability.dwebMesh.status).toBe('available');
    expect(filterByRuntimeCapabilities(descriptors, capability).map((tool) => tool.name)).toEqual(names);
    expect(runtimeCapabilityPromptBlock(capability)).toBe('');
  });

  test('a host without offscreen support keeps actors but drops offscreen tools', () => {
    const capability = resolveRuntimeCapabilities({ offscreenDocument: false });
    const filtered = filterByRuntimeCapabilities(descriptors, capability);
    expect(filtered.map((tool) => tool.name)).toEqual([
      'read_result',
      'message_actor',
    ]);
    expect(runtimeCapabilityPromptBlock(capability)).toContain('visible Notebook actor');
  });

  test('a Firefox background document can host voice without claiming other offscreen facilities', () => {
    const capability = resolveRuntimeCapabilities({
      offscreenDocument: false,
      moonshineVoiceDocument: true,
    });
    expect(capability.moonshineVoiceHost).toMatchObject({
      status: 'available', host: 'background-page',
    });
    expect(capability.documentReader.status).toBe('unsupported');
    expect(capability.sealedJobs.status).toBe('unsupported');
  });

  test('web descriptors describe the snapshot and raw fallbacks without naming absent readers', () => {
    const capability = resolveRuntimeCapabilities({ offscreenDocument: false });
    const webDescriptors = filterByRuntimeCapabilities([
      { ...fetchUrlTool, ...getToolMetadata('fetch_url') },
      { ...readPageTool, ...getToolMetadata('read_page') },
    ], capability);
    expect(webDescriptors[0].description).toContain('sanitized raw response body');
    expect(webDescriptors[0].description).not.toContain('read_doc');
    expect(webDescriptors[0].schema.properties.raw.description).toContain('no hosted Markdown extractor');
    expect(webDescriptors[1].description).toContain('falls back to the same visible-text snapshot');
    expect(webDescriptors[1].schema.properties.mode.description).not.toContain('Markdown');
  });

  test('a forged unavailable call receives a structured no-effect refusal', () => {
    const capability = resolveRuntimeCapabilities({ offscreenDocument: false });
    expect(runtimeCapabilityRefusal('script', capability)).toEqual({
      ok: false,
      error: 'runtime_capability_unavailable',
      performed: false,
      facility: 'sealedJobs',
      reasonCode: 'host_unsupported',
      retryable: false,
      alternative: 'use_visible_notebook',
    });
    expect(runtimeCapabilityRefusal('message_actor', capability)).toBeNull();
    expect(runtimeCapabilityRefusal('dweb_discover', capability)?.facility).toBe('dwebMesh');
    const gated = exposureGate(
      { name: 'script' } as any,
      {},
      { exposure: 'main', runtimeCapabilities: capability } as any,
    );
    expect(gated.allowed).toBe(false);
    expect(gated.reason).toContain('use_visible_notebook');
  });

  test('the snapshot and entries are immutable', () => {
    const capability = resolveRuntimeCapabilities({ offscreenDocument: false });
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.isFrozen(capability.sealedJobs)).toBe(true);
  });

  test('provider boundaries can refuse stale sessions before host startup', () => {
    const capability = resolveRuntimeCapabilities({ offscreenDocument: false });
    expect(() => requireRuntimeCapability(capability.localWebGpuHost, 'localWebGpuHost'))
      .toThrow('Alternative: use ollama');
  });
});
