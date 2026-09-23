// Shared static ES-module graph helpers for packaging.
//
// es-module-lexer is already part of the development toolchain. Using it here
// avoids regex parsing, which becomes especially fragile after release staging
// compacts a module onto one line. Dynamic import() is intentionally excluded
// from this static-link helper. Callers must separately account for or forbid
// host-specific dynamic edges; Chrome MV3 service-worker packaging does not
// treat import() as a cold-graph boundary.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';

export type StaticImportReader = (source: string, filename: string) => string[] | Promise<string[]>;

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
  // why: the privileged security-release validator supplies Bun's built-in
  // scanner and must never resolve or execute dependency packages.
  const { init, parse } = await import('es-module-lexer');
  await init;
  return parse(source, filename)[0]
    .filter((imported) => imported.d === -1 && typeof imported.n === 'string')
    .map((imported) => imported.n as string);
};

export const moduleImportSpecifiers = async (
  source: string,
  filename = '<module>',
): Promise<Array<Readonly<{ kind: 'static' | 'dynamic'; specifier: string }>>> => {
  const { init, parse } = await import('es-module-lexer');
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
  const { init, parse } = await import('es-module-lexer');
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
  {
    allowExternalSpecifiers = false,
    readStaticImports = staticImportSpecifiers,
  }: { allowExternalSpecifiers?: boolean; readStaticImports?: StaticImportReader } = {},
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
    const relativeInput = relative(absoluteRoot, file);
    let descriptor: number;
    try {
      descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new Error(`static module missing from artifact: ${relativeInput}`);
      if (code === 'ELOOP') throw new Error(`static module graph input is symlinked: ${relativeInput}`);
      throw error;
    }
    let source: string | undefined;
    try {
      const openedStat = fstatSync(descriptor);
      if (!openedStat.isFile()) {
        throw new Error(`static module graph input is not a regular file: ${relativeInput}`);
      }
      const realFile = realpathSync(file);
      if (!pathIsInside(realRoot, realFile)) {
        throw new Error(`static module graph input escapes real artifact root: ${relativeInput}`);
      }
      // why: parent symlinks are forbidden too. Verify that the opened inode is
      // still the checked path, then read that descriptor so later replacement
      // cannot redirect the graph reader outside the artifact.
      const inputStat = lstatSync(file);
      if (inputStat.isSymbolicLink() || realFile !== resolve(realRoot, relativeInput)) {
        throw new Error(`static module graph input traverses a symlink: ${relativeInput}`);
      }
      if (openedStat.dev !== inputStat.dev || openedStat.ino !== inputStat.ino) {
        throw new Error(`static module graph input changed during validation: ${relativeInput}`);
      }
      if (['.js', '.mjs'].includes(extname(file))) source = readFileSync(descriptor, 'utf8');
    } finally {
      closeSync(descriptor);
    }
    graph.add(file);

    if (source === undefined) continue;
    for (const specifier of await readStaticImports(source, relative(absoluteRoot, file))) {
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
