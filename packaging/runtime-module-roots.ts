// Fixed runtime ES-module edges that the browser starts outside the static
// import graph. Packaging and build identity deliberately keep independent
// allowlists; this parser makes either list fail closed when code adds a new
// literal import() or module Worker root.

import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import {
  collectStaticModuleGraph, moduleImportSpecifiers, pathIsInside, resolveStaticSpecifier,
} from './static-module-graph.ts';

export type FixedRuntimeModuleEdge = Readonly<{
  kind: 'dynamic-import' | 'module-worker';
  specifier: string;
  rootRelative: boolean;
}>;

const literalText = (node: ts.Node | undefined): string | null =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text : null;

const isModuleWorkerOptions = (node: ts.Node | undefined): boolean =>
  !!node && ts.isObjectLiteralExpression(node) && node.properties.some((property) =>
    ts.isPropertyAssignment(property)
    && (property.name.getText() === 'type' || literalText(property.name) === 'type')
    && literalText(property.initializer) === 'module');

const workerSpecifier = (
  node: ts.Expression,
): Readonly<{ specifier: string; rootRelative: boolean }> | null => {
  const direct = literalText(node);
  if (direct !== null) return { specifier: direct, rootRelative: direct.startsWith('/') };
  if (ts.isNewExpression(node) && node.expression.getText() === 'URL') {
    const specifier = literalText(node.arguments?.[0]);
    if (specifier !== null && node.arguments?.[1]?.getText() === 'import.meta.url') {
      return { specifier, rootRelative: specifier.startsWith('/') };
    }
  }
  if (ts.isCallExpression(node) && /(?:^|\.)runtime\.getURL$/.test(node.expression.getText())) {
    const specifier = literalText(node.arguments[0]);
    if (specifier !== null) return { specifier, rootRelative: true };
  }
  return null;
};

export const fixedRuntimeModuleEdges = async (
  source: string,
  filename = '<module>',
): Promise<readonly FixedRuntimeModuleEdge[]> => {
  const edges: FixedRuntimeModuleEdge[] = (await moduleImportSpecifiers(source, filename))
    .filter((edge) => edge.kind === 'dynamic')
    .map((edge) => Object.freeze({
      kind: 'dynamic-import' as const,
      specifier: edge.specifier,
      rootRelative: edge.specifier.startsWith('/'),
    }));
  const sourceFile = ts.createSourceFile(
    filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS,
  );
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && node.expression.getText(sourceFile) === 'Worker'
        && isModuleWorkerOptions(node.arguments?.[1])) {
      const parsed = node.arguments?.[0] && workerSpecifier(node.arguments[0]);
      if (parsed) edges.push(Object.freeze({ kind: 'module-worker', ...parsed }));
    }
    if (ts.isPropertyAssignment(node)
        && (node.name.getText(sourceFile) === 'workerUrl' || literalText(node.name) === 'workerUrl')) {
      const parsed = workerSpecifier(node.initializer);
      if (parsed) edges.push(Object.freeze({ kind: 'module-worker', ...parsed }));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return Object.freeze(edges);
};

export const resolveFixedRuntimeModuleEdge = (
  edge: FixedRuntimeModuleEdge,
  fromFile: string,
  root: string,
): string => {
  const absoluteRoot = resolve(root);
  const target = edge.rootRelative
    ? resolve(absoluteRoot, edge.specifier.replace(/^\/+/, ''))
    : edge.kind === 'module-worker'
      ? resolve(dirname(fromFile), edge.specifier)
      : resolveStaticSpecifier(edge.specifier, fromFile, absoluteRoot);
  if (!pathIsInside(absoluteRoot, target)) {
    throw new Error(
      `runtime module edge escapes artifact root: ${edge.specifier} from ${relative(absoluteRoot, fromFile)}`,
    );
  }
  return target;
};

export const relativeRuntimeModuleTarget = (
  edge: FixedRuntimeModuleEdge,
  fromFile: string,
  root: string,
): string => relative(resolve(root), resolveFixedRuntimeModuleEdge(edge, fromFile, root))
  .split('\\').join('/');

const authoredModuleFiles = (root: string): string[] => {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === 'vendor' || name === 'tests') continue;
      const absolute = resolve(directory, name);
      const entry = statSync(absolute);
      if (entry.isDirectory()) visit(absolute);
      else if (/\.m?js$/.test(name)) files.push(absolute);
    }
  };
  visit(resolve(root));
  return files.sort();
};

export type RuntimeModuleInventoryIssue = Readonly<{
  from: string;
  kind: FixedRuntimeModuleEdge['kind'];
  target: string;
}>;

export const uninventoriedRuntimeModuleEdges = async (
  root: string,
  inventory: readonly string[],
  intentionallyUnavailable: readonly string[] = [],
): Promise<readonly RuntimeModuleInventoryIssue[]> => {
  const absoluteRoot = resolve(root);
  const selected = new Set(inventory);
  const unavailable = new Set(intentionallyUnavailable);
  const issues: RuntimeModuleInventoryIssue[] = [];
  for (const file of authoredModuleFiles(absoluteRoot)) {
    const from = relative(absoluteRoot, file).split('\\').join('/');
    for (const edge of await fixedRuntimeModuleEdges(readFileSync(file, 'utf8'), from)) {
      const target = relativeRuntimeModuleTarget(edge, file, absoluteRoot);
      if (!selected.has(target) && !unavailable.has(target)) {
        issues.push(Object.freeze({ from, kind: edge.kind, target }));
      }
    }
  }
  return Object.freeze(issues.sort((a, b) =>
    `${a.from}\0${a.target}`.localeCompare(`${b.from}\0${b.target}`)));
};

export const assertPackagedRuntimeModuleRoots = async (
  root: string,
  inventory: readonly string[],
  intentionallyUnavailable: readonly string[] = [],
): Promise<void> => {
  const issues = await uninventoriedRuntimeModuleEdges(
    root, inventory, intentionallyUnavailable,
  );
  if (issues.length > 0) {
    const first = issues[0];
    throw new Error(
      `unseeded ${first.kind}: ${first.target} from ${first.from}`,
    );
  }
  for (const entry of inventory) {
    await collectStaticModuleGraph(resolve(root), resolve(root, entry));
  }
};
