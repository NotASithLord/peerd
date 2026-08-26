import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
  getToolMetadata,
  listToolMetadata,
  resolveToolOrigins,
  TOOL_METADATA_ORDER,
} from '../../../extension/peerd-runtime/semantic.js';
import { composeTool } from '../../../extension/peerd-runtime/tools/metadata/index.js';
import { getToolPolicy } from '../../../extension/peerd-runtime/tools/metadata/policy.js';
import { projectToolAuthority } from '../../../extension/peerd-runtime/tools/metadata/descriptor.js';
import {
  normalizeSiteOrigin,
  originOfUrl,
} from '../../../extension/peerd-runtime/tools/metadata/origins.js';
import {
  clearTools, listTools, registerTool,
} from '../../../extension/peerd-runtime/tools/registry.js';
import { CONTROLLER_TOOL_IMPLEMENTATIONS } from '../../../extension/peerd-runtime/controller-tools.js';
import { CONTROLLER_ACTOR_TOOL_NAMES } from '../../../extension/peerd-runtime/controller-actor-tools.js';
import { CONTROLLER_POD_TOOL_NAMES } from '../../../extension/peerd-runtime/controller-pod-tools.js';

const { BUILTIN_TOOLS } = await import(
  '../../../extension/peerd-runtime/tools/defs/index.js'
);
const { CLOCK_TOOLS } = await import('../../../extension/peerd-runtime/clock/tools.js');
const { WEB_TOOLS } = await import('../../../extension/peerd-runtime/tools/web/index.js');
const { loadSkillTool } = await import(
  '../../../extension/peerd-runtime/skills/load-skill-tool.js'
);

const ALL_TOOLS = [...BUILTIN_TOOLS, ...CLOCK_TOOLS, ...WEB_TOOLS, loadSkillTool];
const EXECUTION_TOOL_NAMES = new Set(ALL_TOOLS.map((tool) => tool.name));
const CONTROLLER_ONLY_TOOL_NAMES = new Set(
  [
    ...Object.keys(CONTROLLER_TOOL_IMPLEMENTATIONS),
    ...CONTROLLER_ACTOR_TOOL_NAMES,
    ...CONTROLLER_POD_TOOL_NAMES,
  ]
    .filter((name) => !EXECUTION_TOOL_NAMES.has(name)),
);
const METADATA_KEYS = new Set([
  'name', 'primitive', 'description', 'schema', 'sideEffect',
  'dispatch', 'retryClass', 'dweb', 'originRule',
]);
const ORIGIN_RULES = new Set([
  'none', 'active-tab', 'url-field', 'active-plus-url',
  'url-or-active', 'site-origin-field', 'https-command',
]);

const deeplyFrozen = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return true;
  return Object.isFrozen(value)
    && Object.values(value).every((nested) => deeplyFrozen(nested));
};

const sourceFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory()
    ? sourceFiles(join(dir, entry.name))
    : entry.name.endsWith('.js') ? [join(dir, entry.name)] : []);

describe('tool metadata authority', () => {
  test('covers the exact production registry in production order', () => {
    expect(TOOL_METADATA_ORDER.filter((name) => !CONTROLLER_ONLY_TOOL_NAMES.has(name)))
      .toEqual(ALL_TOOLS.map((tool) => tool.name));
    expect(new Set([...EXECUTION_TOOL_NAMES, ...CONTROLLER_ONLY_TOOL_NAMES]))
      .toEqual(new Set(TOOL_METADATA_ORDER));
    expect(new Set(TOOL_METADATA_ORDER).size).toBe(TOOL_METADATA_ORDER.length);
    expect(listToolMetadata().map((metadata) => metadata.name)).toEqual([...TOOL_METADATA_ORDER]);
  });

  test('is inert, serializable, deeply frozen, and schema-shaped', () => {
    expect(Object.isFrozen(TOOL_METADATA_ORDER)).toBe(true);
    for (const metadata of listToolMetadata()) {
      expect(deeplyFrozen(metadata)).toBe(true);
      expect(JSON.parse(JSON.stringify(metadata))).toEqual(metadata);
      expect(Object.keys(metadata).every((key) => METADATA_KEYS.has(key))).toBe(true);
      expect(metadata.name).toBeString();
      expect(metadata.primitive).toBeString();
      expect(metadata.description).toBeString();
      expect(metadata.schema).toBeObject();
      expect(metadata.sideEffect).toBeString();
      expect(ORIGIN_RULES.has(metadata.originRule?.kind)).toBe(true);
    }
  });

  test('execution tools compose only compact authority policy and origins', () => {
    for (const tool of ALL_TOOLS) {
      const policy = getToolPolicy(tool.name);
      const { originRule, ...descriptor } = policy;
      const actual = Object.fromEntries(Object.entries(tool).filter(
        ([key]) => key !== 'origins' && key !== 'execute',
      ));
      expect(actual).toEqual(descriptor);
      expect(tool.origins({ url: 'https://example.com/a' }, {
        activeTab: { origin: 'https://active.example' },
      } as any)).toEqual(resolveToolOrigins(policy.originRule, {
        url: 'https://example.com/a',
      }, { activeTab: { origin: 'https://active.example' } }));
    }
  });

  test('registry accepts only the composed inventory without changing order', () => {
    const previous = listTools();
    try {
      clearTools();
      for (const tool of ALL_TOOLS) registerTool(tool as any);
      expect(listTools().map((tool) => tool.name))
        .toEqual(TOOL_METADATA_ORDER.filter((name) => !CONTROLLER_ONLY_TOOL_NAMES.has(name)));
    } finally {
      clearTools();
      for (const tool of previous) registerTool(tool);
    }
  });

  test('composition refuses unknown metadata and missing execution', () => {
    expect(() => composeTool('missing-tool', { execute: async () => ({}) })).toThrow();
    expect(() => composeTool(TOOL_METADATA_ORDER[0], {})).toThrow();
  });

  test('authority projection is compact and rehydrates without widening', async () => {
    const { hydrateToolDescriptors } = await import(
      '../../../extension/peerd-runtime/semantic.js'
    );
    const projection = projectToolAuthority(ALL_TOOLS[0] as any);
    expect(Object.keys(projection)).not.toContain('description');
    expect(Object.keys(projection)).not.toContain('schema');
    expect(hydrateToolDescriptors([projection])[0]).toMatchObject({
      name: ALL_TOOLS[0].name,
      description: getToolMetadata(ALL_TOOLS[0].name).description,
      schema: getToolMetadata(ALL_TOOLS[0].name).schema,
    });
    expect(() => hydrateToolDescriptors([{ ...projection, sideEffect: 'write' }]))
      .toThrow('tool authority mismatch');
  });
});

describe('tool origin rules', () => {
  test('preserves every finite projection shape', () => {
    const active = { activeTab: { origin: 'https://active.example' } };
    expect(resolveToolOrigins({ kind: 'none' }, {}, active)).toEqual([]);
    expect(resolveToolOrigins({ kind: 'active-tab' }, {}, active))
      .toEqual(['https://active.example']);
    expect(resolveToolOrigins({ kind: 'url-field', field: 'url', mode: 'display' }, {
      url: 'about:config',
    }, {})).toEqual(['about://config']);
    expect(resolveToolOrigins({ kind: 'url-field', field: 'url', mode: 'standard' }, {
      url: 'https://EXAMPLE.com:443/path',
    }, {})).toEqual(['https://example.com']);
    expect(resolveToolOrigins({ kind: 'active-plus-url', field: 'url', mode: 'display' }, {
      url: 'https://next.example/path',
    }, active)).toEqual(['https://active.example', 'https://next.example']);
    expect(resolveToolOrigins({ kind: 'url-or-active', field: 'url', mode: 'display' }, {}, active))
      .toEqual(['https://active.example']);
    expect(resolveToolOrigins({ kind: 'site-origin-field', field: 'origin' }, {
      origin: 'API.Example.com/path',
    }, {})).toEqual(['https://api.example.com']);
    expect(resolveToolOrigins({ kind: 'https-command', field: 'command' }, {
      command: 'curl https://one.example/a && curl https://one.example/b && curl https://two.example/c',
    }, {})).toEqual(['https://one.example', 'https://two.example']);
    expect(() => resolveToolOrigins({ kind: 'ambient' }, {}, {})).toThrow();
  });

  test('keeps public-origin normalization and browser labels exact', () => {
    expect(normalizeSiteOrigin('Example.COM')).toBe('https://example.com');
    expect(normalizeSiteOrigin('http://api.example.com:80/path')).toBe('http://api.example.com');
    expect(normalizeSiteOrigin('localhost')).toBeNull();
    expect(normalizeSiteOrigin('https://127.0.0.1')).toBeNull();
    expect(originOfUrl('chrome://settings/privacy')).toBe('chrome://settings');
    expect(originOfUrl('about:config')).toBe('about://config');
    expect(originOfUrl('https://Example.com:443/a')).toBe('https://example.com');
  });
});

describe('tool metadata anti-drift', () => {
  test('execution modules contain only composeTool(name, { execute }) definitions', () => {
    const extension = join(process.cwd(), 'extension', 'peerd-runtime');
    const files = [
      ...sourceFiles(join(extension, 'tools', 'defs')),
      ...sourceFiles(join(extension, 'tools', 'web')),
      join(extension, 'clock', 'tools.js'),
      join(extension, 'skills', 'load-skill-tool.js'),
    ];
    const composed: string[] = [];
    const rawDefinitions: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)
            && ts.isIdentifier(node.expression) && node.expression.text === 'composeTool') {
          const [name, implementation] = node.arguments;
          expect(ts.isStringLiteral(name)).toBe(true);
          expect(ts.isObjectLiteralExpression(implementation)).toBe(true);
          if (ts.isStringLiteral(name) && ts.isObjectLiteralExpression(implementation)) {
            composed.push(name.text);
            expect(implementation.properties.map((property) => property.name?.getText(parsed)))
              .toEqual(['execute']);
          }
        }
        if (ts.isObjectLiteralExpression(node)) {
          const keys = new Set(node.properties.map((property) => property.name?.getText(parsed)));
          if (keys.has('name') && keys.has('execute')) rawDefinitions.push(file);
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }
    expect(rawDefinitions).toEqual([]);
    expect(new Set(composed).size).toBe(composed.length);
    // Actor definitions remain real controller-owned implementations and must
    // stay covered here even though the SW registry no longer imports them.
    expect(new Set([...composed, ...Object.keys(CONTROLLER_TOOL_IMPLEMENTATIONS)]))
      .toEqual(new Set(TOOL_METADATA_ORDER));
  });
});
