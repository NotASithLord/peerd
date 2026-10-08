import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// why: compare actual staged bytes to the coordinator, independently of Git.
// Lexical path ordering is stable across host locales; paths and lengths
// delimit every file so different tree layouts cannot alias one hash input.
export const sourceFingerprint = root => {
  const hash = createHash('sha256');
  const add = path => {
    const bytes = readFileSync(join(root, path));
    hash.update(`${path}\0${bytes.length}\0`);
    hash.update(bytes);
  };
  const visit = directory => {
    const entries = readdirSync(join(root, directory), { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) add(path);
      else throw new Error('Source fingerprint requires regular files and directories');
    }
  };
  visit('extension');
  for (const name of ['dweb-cluster-node.mjs', 'dweb-cluster-page.js', 'dweb-cluster-rpc.mjs', 'dweb-cluster-source.mjs']) add(`scripts/cdp/${name}`);
  return hash.digest('hex');
};

export const gitMetadata = root => {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try { return { revision: git(['rev-parse', 'HEAD']), dirty: !!git(['status', '--porcelain']) }; }
  catch { return { revision: null, dirty: null }; }
};
