// why: OSV exceptions are opt-in and must carry an explicit scoped graph and
// expiry guard. With all prior waivers retired, any newly added IgnoredVulns
// entry fails closed until a dedicated scope guard is reviewed alongside it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkExceptionScope(root) {
  const config = readFileSync(join(root, 'osv-scanner.toml'), 'utf8');
  const activeLines = config
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
  if (activeLines.some((line) => /^\[\[IgnoredVulns\]\]$|^id\s*=/.test(line))) {
    throw new Error('Unreviewed OSV exception in osv-scanner.toml; add a scoped guard and expiry check');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkExceptionScope(fileURLToPath(new URL('../', import.meta.url)));
  console.log('OSV exception scope OK');
}
