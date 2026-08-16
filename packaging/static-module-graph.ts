// Shared static ES-module graph helpers for packaging.
//
// es-module-lexer is already part of the development toolchain. Using it here
// avoids regex parsing, which becomes especially fragile after release staging
// compacts a module onto one line. Dynamic import() is intentionally excluded:
// it is a lazy boundary and does not participate in cold module registration.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { init, parse } from 'es-module-lexer';

export const pathIsInside = (root: string, candidate: string): boolean => {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

/** Resolve a browser module specifier. Bare/URL-like specifiers return null. */
export const resolveStaticSpecifier = (
  specifier: string,
  fromFile: string,
  root: string,
): string | null => {
  const clean = specifier.split(/[?#]/, 1)[0];
  if (clean.startsWith('/')) return resolve(root, `.${clean}`);
  if (clean.startsWith('.')) return resolve(dirname(fromFile), clean);
  return null;
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

/**
 * Collect every local module linked before an entry can evaluate. Missing or
 * root-escaping links fail here because an optimized artifact must never be
 * created from an incomplete cold graph.
 */
export const collectStaticModuleGraph = async (
  root: string,
  entry: string,
): Promise<Set<string>> => {
  const absoluteRoot = resolve(root);
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
    graph.add(file);

    if (!['.js', '.mjs'].includes(extname(file))) continue;
    const source = readFileSync(file, 'utf8');
    for (const specifier of await staticImportSpecifiers(source, relative(absoluteRoot, file))) {
      const target = resolveStaticSpecifier(specifier, file, absoluteRoot);
      if (target === null) continue;
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
