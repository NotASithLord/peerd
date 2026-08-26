import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import {
  clearTools,
  getTool,
  getToolDescriptor,
  listToolDescriptors,
  listTools,
  registerMetadataInventory,
  registerTool,
  resolveRegisteredToolOrigins,
  retryClassForRegisteredTool,
} from '../../../extension/peerd-runtime/tools/registry.js';
import { TOOL_METADATA_ORDER } from '../../../extension/peerd-runtime/semantic.js';
import {
  listToolPolicies,
  TOOL_POLICY_ORDER,
} from '../../../extension/peerd-runtime/tools/metadata/policy.js';

const reset = () => {
  clearTools();
  registerMetadataInventory([]);
};

afterEach(reset);

describe('metadata registry', () => {
  test('installs the inert catalog idempotently in production order', () => {
    expect(registerMetadataInventory()).toBe(TOOL_POLICY_ORDER.length);
    expect(registerMetadataInventory()).toBe(TOOL_POLICY_ORDER.length);
    expect(listToolDescriptors().map(({ name }) => name)).toEqual([...TOOL_POLICY_ORDER]);
    for (const descriptor of listToolDescriptors()) {
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect('execute' in descriptor).toBe(false);
      expect('originRule' in descriptor).toBe(false);
    }
    expect(listTools()).toEqual([]);
  });

  test('serves policy, origins, and retry classification without execution tools', () => {
    registerMetadataInventory();
    expect(getToolDescriptor('inspect')).toMatchObject({
      name: 'inspect', primitive: 'inspect', sideEffect: 'read',
    });
    expect(resolveRegisteredToolOrigins('open_tab', {
      url: 'https://example.com/path',
    }, {})).toEqual(['https://example.com']);
    expect(retryClassForRegisteredTool('inspect')).toBe('A');
    expect(retryClassForRegisteredTool('fetch_url')).toBe('B');
    expect(retryClassForRegisteredTool('sandbox_create')).toBe('F');
    expect(getTool('inspect')).toBeUndefined();
  });

  test('compact policy stays exact with the rich descriptor catalog', async () => {
    const { listToolMetadata } = await import(
      '../../../extension/peerd-runtime/semantic.js'
    );
    const fields = ['name', 'primitive', 'sideEffect', 'originRule', 'dispatch', 'retryClass', 'dweb'];
    expect(TOOL_POLICY_ORDER).toEqual(TOOL_METADATA_ORDER);
    expect(listToolPolicies()).toEqual(listToolMetadata().map((metadata) =>
      Object.fromEntries(fields.flatMap((field) => metadata[field] === undefined
        ? [] : [[field, metadata[field]]]))));
  });

  test('projects a full registration with precedence but no execute authority', async () => {
    registerMetadataInventory();
    const execute = async () => ({ ok: true as const, content: 'full' });
    const full = {
      name: 'inspect', description: 'override', primitive: 'web' as const,
      schema: { type: 'object', properties: {} }, sideEffect: 'write' as const,
      origins: () => ['https://override.example'], execute,
    };
    registerTool(full as any);

    expect(getTool('inspect')).toBe(full);
    expect(await getTool('inspect')?.execute({}, {} as any)).toEqual({ ok: true, content: 'full' });
    expect(getToolDescriptor('inspect')).toMatchObject({
      name: 'inspect', description: 'override', primitive: 'web', sideEffect: 'write',
    });
    expect(getToolDescriptor('inspect')).not.toHaveProperty('execute');
    expect(resolveRegisteredToolOrigins('inspect', {}, {})).toEqual(['https://override.example']);
    expect(listToolDescriptors().filter(({ name }) => name === 'inspect')).toHaveLength(1);

    clearTools();
    expect(getToolDescriptor('inspect')?.description).not.toBe('override');
  });

  test('keeps custom execution-only tools visible to descriptor selection', () => {
    registerMetadataInventory();
    registerTool({
      name: 'test_only', description: 'test', primitive: 'inspect',
      schema: { type: 'object', properties: {} }, sideEffect: 'read',
      origins: () => [], execute: async () => ({ ok: true, content: '' }),
    } as any);
    expect(listToolDescriptors().at(-1)?.name).toBe('test_only');
    expect(getToolDescriptor('test_only')).not.toHaveProperty('execute');
  });

  test('rejects a duplicate or invalid inventory without replacing the live one', () => {
    registerMetadataInventory();
    const before = listToolDescriptors();
    expect(() => registerMetadataInventory([
      { ...before[0], originRule: { kind: 'none' } },
      { ...before[0], originRule: { kind: 'none' } },
    ])).toThrow('duplicate tool metadata');
    expect(listToolDescriptors()).toEqual(before);
    expect(() => registerMetadataInventory({} as any)).toThrow();
    expect(listToolDescriptors()).toEqual(before);
  });
});

describe('metadata registry graph', () => {
  test('does not import tool executors or browser authority', async () => {
    const root = join(process.cwd(), 'extension');
    const result = await Bun.build({
      entrypoints: [join(root, 'peerd-runtime', 'tools', 'registry.js')],
      target: 'browser', format: 'esm', minify: true, metafile: true,
    });
    expect(result.success).toBe(true);
    const metafile = result.metafile as unknown as { inputs: Record<string, unknown> };
    expect(metafile).toBeDefined();
    const inputs = Object.keys(metafile.inputs).map((path) => relative(root, path));
    const forbidden = [
      'peerd-runtime/tools/defs/',
      'peerd-runtime/tools/web/',
      'peerd-runtime/tools/metadata/catalog.js',
      'peerd-runtime/tools/metadata/index.js',
      'peerd-runtime/clock/tools.js',
      'peerd-runtime/skills/load-skill-tool.js',
      'background/', 'peerd-engine/', 'peerd-distributed/', 'vendor/browser-polyfill',
    ];
    expect(inputs.filter((path) => forbidden.some((part) => path.includes(part)))).toEqual([]);
    const bytes = (await result.outputs[0].arrayBuffer()).byteLength;
    expect(bytes).toBeLessThanOrEqual(15_000);
    for (const input of Object.keys(metafile.inputs)) {
      const source = readFileSync(input, 'utf8');
      const parsed = ts.createSourceFile(input, source, ts.ScriptTarget.Latest, true);
      const authorityAccesses: string[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isPropertyAccessExpression(node)
            && /^(?:globalThis\.)?(?:chrome|browser)(?:\.|$)/.test(node.getText(parsed))) {
          authorityAccesses.push(node.getText(parsed));
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
      expect(authorityAccesses).toEqual([]);
    }
  });
});
