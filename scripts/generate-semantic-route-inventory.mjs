#!/usr/bin/env node
// Generate the exact legacy unified-dispatcher inventory from its TypeScript
// syntax tree plus the route factories it spreads. No service worker executes.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const CHANNELS = Object.freeze(['store', 'preview']);
const unwrap = (node) => {
  let current = node;
  while (ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
};
const propertyName = (node) => {
  const value = node?.name;
  if (ts.isStringLiteralLike(value) || ts.isIdentifier(value)) return value.text;
  return null;
};
const universalDeps = (channel) => {
  let proxy;
  const target = function universalDependency() {};
  proxy = new Proxy(target, {
    get: (_value, key) => key === 'channel' || key === 'CHANNEL' ? channel : proxy,
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
};

export const discoverLegacySemanticRoutes = async ({ sourceRoot = process.cwd() } = {}) => {
  const swPath = resolve(sourceRoot, 'extension/background/service-worker.js');
  const sourceText = await readFile(swPath, 'utf8');
  const source = ts.createSourceFile(swPath, sourceText, ts.ScriptTarget.Latest, true,
    ts.ScriptKind.JS);
  const imports = new Map();
  const values = new Map();
  const functions = new Map();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      for (const element of statement.importClause?.namedBindings?.elements ?? []) {
        const specifier = statement.moduleSpecifier.text;
        imports.set(element.name.text, specifier.startsWith('/')
          ? resolve(sourceRoot, 'extension', specifier.slice(1))
          : resolve(dirname(swPath), specifier));
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          values.set(declaration.name.text, declaration.initializer);
        }
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      functions.set(statement.name.text, statement.body);
    }
  }

  let dispatcher = null;
  const findDispatcher = (node) => {
    if (dispatcher) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'makeDispatcher'
        && node.arguments.length === 1 && ts.isObjectLiteralExpression(node.arguments[0])) {
      dispatcher = node.arguments[0];
      return;
    }
    ts.forEachChild(node, findDispatcher);
  };
  findDispatcher(source);
  if (!dispatcher) throw new Error('legacy makeDispatcher object not found');

  const resolveFactoryModule = async (modulePath, factoryName, seen = new Set()) => {
    if (seen.has(modulePath)) throw new Error(`route factory export cycle: ${factoryName}`);
    const text = await readFile(modulePath, 'utf8');
    const parsed = ts.createSourceFile(modulePath, text, ts.ScriptTarget.Latest, true,
      ts.ScriptKind.JS);
    for (const statement of parsed.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier
          || !ts.isStringLiteral(statement.moduleSpecifier)
          || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
      const exported = statement.exportClause.elements.some((element) =>
        element.name.text === factoryName);
      if (!exported) continue;
      const specifier = statement.moduleSpecifier.text;
      const next = specifier.startsWith('/')
        ? resolve(sourceRoot, 'extension', specifier.slice(1))
        : resolve(dirname(modulePath), specifier);
      return resolveFactoryModule(next, factoryName, new Set([...seen, modulePath]));
    }
    return modulePath;
  };

  const found = new Map();
  const add = (route, channel, routeSource) => {
    if (typeof route !== 'string' || !route.includes('/')) {
      throw new Error(`invalid generated route: ${String(route)}`);
    }
    const prior = found.get(route);
    if (prior && prior.source !== routeSource) {
      throw new Error(`duplicate generated route ${route}: ${prior.source} / ${routeSource}`);
    }
    const row = prior ?? { route, channels: new Set(), source: routeSource };
    row.channels.add(channel);
    found.set(route, row);
  };
  const factoryKeys = async (factoryName, channel) => {
    const importedPath = imports.get(factoryName);
    if (!importedPath) throw new Error(`route factory import unresolved: ${factoryName}`);
    const modulePath = await resolveFactoryModule(importedPath, factoryName);
    let module;
    try { module = await import(pathToFileURL(modulePath).href); }
    catch (cause) {
      throw new Error(`route factory import failed: ${factoryName} (${modulePath})`, { cause });
    }
    if (typeof module[factoryName] !== 'function') {
      throw new Error(`route factory export missing: ${factoryName}`);
    }
    const result = module[factoryName](universalDeps(channel));
    return { keys: Object.keys(result), source: modulePath.slice(sourceRoot.length + 1) };
  };
  const factoryPropertyKeys = async (factoryName, property, channel) => {
    const importedPath = imports.get(factoryName);
    if (!importedPath) throw new Error(`route factory import unresolved: ${factoryName}`);
    const modulePath = await resolveFactoryModule(importedPath, factoryName);
    const module = await import(pathToFileURL(modulePath).href);
    const result = module[factoryName](universalDeps(channel));
    return { keys: Object.keys(result?.[property] ?? {}),
      source: modulePath.slice(sourceRoot.length + 1) };
  };
  const returnedExpression = (name) => {
    const body = functions.get(name);
    if (!body) return null;
    const statement = body.statements.find(ts.isReturnStatement);
    return statement?.expression ?? null;
  };
  const walkExpression = async (raw, channel, label, seen = new Set()) => {
    const expression = unwrap(raw);
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      if (!ts.isBlock(expression.body)) {
        return walkExpression(expression.body, channel, label, seen);
      }
      const returned = expression.body.statements.find(ts.isReturnStatement)?.expression;
      if (returned) return walkExpression(returned, channel, label, seen);
      throw new Error(`route factory has no return: ${label}`);
    }
    if (ts.isObjectLiteralExpression(expression)) {
      for (const property of expression.properties) {
        if (ts.isSpreadAssignment(property)) {
          await walkExpression(property.expression, channel, `${label}:spread`, seen);
        } else {
          const route = propertyName(property);
          if (route) add(route, channel, label);
        }
      }
      return;
    }
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
      const factoryName = expression.expression.text;
      if (imports.has(factoryName)) {
        const { keys, source: routeSource } = await factoryKeys(factoryName, channel);
        for (const route of keys) add(route, channel, routeSource);
        return;
      }
      const localFactory = values.get(factoryName);
      if (localFactory && (ts.isArrowFunction(unwrap(localFactory))
          || ts.isFunctionExpression(unwrap(localFactory)))) {
        return walkExpression(localFactory, channel, factoryName, seen);
      }
      const returned = returnedExpression(factoryName);
      if (returned) return walkExpression(returned, channel, factoryName, seen);
    }
    if (ts.isIdentifier(expression)) {
      if (seen.has(expression.text)) throw new Error(`route expression cycle: ${expression.text}`);
      const next = values.get(expression.text) ?? returnedExpression(expression.text);
      if (!next) throw new Error(`route expression unresolved: ${expression.text}`);
      return walkExpression(next, channel, expression.text, new Set([...seen, expression.text]));
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      const initializer = unwrap(values.get(expression.expression.text));
      if (initializer && ts.isCallExpression(initializer)
          && ts.isIdentifier(initializer.expression) && imports.has(initializer.expression.text)) {
        const { keys, source: routeSource } = await factoryPropertyKeys(
          initializer.expression.text, expression.name.text, channel,
        );
        for (const route of keys) add(route, channel, routeSource);
        return;
      }
    }
    throw new Error(`unsupported route expression ${label}: ${expression.getText(source)}`);
  };
  for (const channel of CHANNELS) await walkExpression(dispatcher, channel, 'service-worker.js');
  return [...found.values()].map((row) => ({
    route: row.route,
    channels: CHANNELS.filter((channel) => row.channels.has(channel)),
    source: row.source,
  })).sort((left, right) => left.route.localeCompare(right.route));
};

export const renderSemanticRouteInventory = (rows) => `// @ts-check
// GENERATED FILE. Do not edit. Run:
// bun scripts/generate-semantic-route-inventory.mjs --write
export const LEGACY_SEMANTIC_ROUTE_INVENTORY = Object.freeze(${JSON.stringify(rows, null, 2)});
`;

const main = async () => {
  const sourceRootArg = process.argv.find((arg) => arg.startsWith('--source-root='));
  const sourceRoot = resolve(sourceRootArg?.slice('--source-root='.length) ?? process.cwd());
  const output = join(sourceRoot, 'extension/shared/semantic-route-inventory.generated.js');
  const rendered = renderSemanticRouteInventory(await discoverLegacySemanticRoutes({ sourceRoot }));
  if (process.argv.includes('--write')) {
    await writeFile(output, rendered);
    return;
  }
  const current = await readFile(output, 'utf8').catch(() => '');
  if (current !== rendered) {
    console.error('semantic route inventory is stale; run generator with --write');
    process.exitCode = 1;
  }
};

if (resolve(process.argv[1] ?? '') === resolve(new URL(import.meta.url).pathname)) await main();
