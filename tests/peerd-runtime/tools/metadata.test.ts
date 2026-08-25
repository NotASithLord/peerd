import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
  composeTool,
  getToolMetadata,
  listToolMetadata,
  resolveToolOrigins,
  TOOL_METADATA_ORDER,
} from '../../../extension/peerd-runtime/tools/metadata/index.js';
import {
  normalizeSiteOrigin,
  originOfUrl,
} from '../../../extension/peerd-runtime/tools/metadata/origins.js';
import {
  clearTools, listTools, registerTool,
} from '../../../extension/peerd-runtime/tools/registry.js';

const { BUILTIN_TOOLS } = await import(
  '../../../extension/peerd-runtime/tools/defs/index.js'
);
const { CLOCK_TOOLS } = await import('../../../extension/peerd-runtime/clock/tools.js');
const { WEB_TOOLS } = await import('../../../extension/peerd-runtime/tools/web/index.js');
const { loadSkillTool } = await import(
  '../../../extension/peerd-runtime/skills/load-skill-tool.js'
);

const ALL_TOOLS = [...BUILTIN_TOOLS, ...CLOCK_TOOLS, ...WEB_TOOLS, loadSkillTool];
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
    expect(TOOL_METADATA_ORDER).toEqual(ALL_TOOLS.map((tool) => tool.name));
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

  test('full tools compose their descriptor and origins from the same record', () => {
    for (const tool of ALL_TOOLS) {
      const metadata = getToolMetadata(tool.name);
      const { originRule, ...descriptor } = metadata;
      const actual = Object.fromEntries(Object.entries(tool).filter(
        ([key]) => key !== 'origins' && key !== 'execute',
      ));
      expect(actual).toEqual(descriptor);
      expect(tool.origins({ url: 'https://example.com/a' }, {
        activeTab: { origin: 'https://active.example' },
      } as any)).toEqual(resolveToolOrigins(originRule, {
        url: 'https://example.com/a',
      }, { activeTab: { origin: 'https://active.example' } }));
    }
  });

  test('registry accepts only the composed inventory without changing order', () => {
    const previous = listTools();
    try {
      clearTools();
      for (const tool of ALL_TOOLS) registerTool(tool as any);
      expect(listTools().map((tool) => tool.name)).toEqual([...TOOL_METADATA_ORDER]);
    } finally {
      clearTools();
      for (const tool of previous) registerTool(tool);
    }
  });

  test('composition refuses unknown metadata and missing execution', () => {
    expect(() => composeTool('missing-tool', { execute: async () => ({}) })).toThrow();
    expect(() => composeTool(TOOL_METADATA_ORDER[0], {})).toThrow();
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
    expect(composed).toHaveLength(TOOL_METADATA_ORDER.length);
    expect(new Set(composed)).toEqual(new Set(TOOL_METADATA_ORDER));
  });
});
