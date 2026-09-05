// Shared static ES-module graph helpers for packaging.
//
// es-module-lexer is already part of the development toolchain. Using it here
// avoids regex parsing, which becomes especially fragile after release staging
// compacts a module onto one line. Dynamic import() is intentionally excluded
// from this static-link helper. Callers must separately account for or forbid
// host-specific dynamic edges; Chrome MV3 service-worker packaging does not
// treat import() as a cold-graph boundary.

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { init, parse } from 'es-module-lexer';

export const pathIsInside = (root: string, candidate: string): boolean => {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

/** Resolve a local browser module specifier and reject every other static edge. */
export const resolveStaticSpecifier = (
  specifier: string,
  fromFile: string,
  root: string,
): string => {
  const clean = specifier.split(/[?#]/, 1)[0];
  if (clean.startsWith('/') && !clean.startsWith('//')) return resolve(root, `.${clean}`);
  if (clean.startsWith('./') || clean.startsWith('../')) return resolve(dirname(fromFile), clean);
  throw new Error(
    `unsupported static import specifier: ${specifier} from ${relative(root, fromFile)}`,
  );
};

/** Parse only statically linked import/export-from specifiers. */
export const staticImportSpecifiers = async (
  source: string,
  filename = '<module>',
): Promise<string[]> => {
  await init;
  return parse(source, filename)[0]
    .filter((imported) => imported.d === -1 && typeof imported.n === 'string')
    .map((imported) => imported.n as string);
};

export const moduleImportSpecifiers = async (
  source: string,
  filename = '<module>',
): Promise<Array<Readonly<{ kind: 'static' | 'dynamic'; specifier: string }>>> => {
  await init;
  return parse(source, filename)[0]
    .filter((imported) => typeof imported.n === 'string')
    .map((imported) => Object.freeze({
      kind: imported.d === -1 ? 'static' as const : 'dynamic' as const,
      specifier: imported.n as string,
    }));
};

export const exportedNames = async (
  source: string,
  filename = '<module>',
): Promise<string[]> => {
  await init;
  return parse(source, filename)[1].map((exported) => exported.n);
};

/**
 * Collect every local module linked before an entry can evaluate. Missing or
 * root-escaping links fail here because an optimized artifact must never be
 * created from an incomplete cold graph.
 */
export const collectStaticModuleGraph = async (
  root: string,
  entry: string,
  { allowExternalSpecifiers = false }: { allowExternalSpecifiers?: boolean } = {},
): Promise<Set<string>> => {
  const absoluteRoot = resolve(root);
  const realRoot = realpathSync(absoluteRoot);
  const first = resolve(entry);
  const graph = new Set<string>();
  const queue = [first];

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (graph.has(file)) continue;
    if (!pathIsInside(absoluteRoot, file)) {
      throw new Error(`static module graph escapes artifact root: ${relative(absoluteRoot, file)}`);
    }
    if (!existsSync(file)) {
      throw new Error(`static module missing from artifact: ${relative(absoluteRoot, file)}`);
    }
    const relativeInput = relative(absoluteRoot, file);
    const inputStat = lstatSync(file);
    if (inputStat.isSymbolicLink()) {
      throw new Error(`static module graph input is symlinked: ${relativeInput}`);
    }
    if (!inputStat.isFile()) {
      throw new Error(`static module graph input is not a regular file: ${relativeInput}`);
    }
    const realFile = realpathSync(file);
    if (!pathIsInside(realRoot, realFile)) {
      throw new Error(`static module graph input escapes real artifact root: ${relativeInput}`);
    }
    // why: a symlinked parent can redirect reads and writes even when the final
    // directory entry is a regular file and its lexical path stays in staging.
    if (realFile !== resolve(realRoot, relativeInput)) {
      throw new Error(`static module graph input traverses a symlink: ${relativeInput}`);
    }
    graph.add(file);

    if (!['.js', '.mjs'].includes(extname(file))) continue;
    const source = readFileSync(file, 'utf8');
    for (const specifier of await staticImportSpecifiers(source, relative(absoluteRoot, file))) {
      let target: string;
      try {
        target = resolveStaticSpecifier(specifier, file, absoluteRoot);
      } catch (error) {
        // why: acceptance harnesses bind their repository-local scripts while
        // Node/Bun builtins and locked packages remain external. Browser and
        // artifact graphs keep the strict default and reject every such edge.
        if (allowExternalSpecifiers) continue;
        throw error;
      }
      if (!pathIsInside(absoluteRoot, target)) {
        throw new Error(
          `static import escapes artifact root: ${specifier} from ${relative(absoluteRoot, file)}`,
        );
      }
      queue.push(target);
    }
  }

  return graph;
};
