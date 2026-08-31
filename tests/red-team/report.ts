// Red-team report generator (`bun run red-team:report`).
//
// Runs the scenario catalog against the real defense code and writes the result
// matrix to docs/security/RED-TEAM-RESULTS.md, the re-runnable evidence that backs
// the threat model. These are runnable probes for the core invariants, not a
// complete adversarial audit. Prints complete, partial/platform-residual, and
// failed coverage distinctly; exits non-zero only when a scoped probe leaked.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG } from './index.ts';
import { runScenario, formatMarkdown, formatConsole } from './harness.ts';

const ran = await Promise.all(CATALOG.map(runScenario));

const note = '_Generated from the current checkout by the command above._';

const md = formatMarkdown(ran, note);
const out = join(import.meta.dir, '..', '..', 'docs', 'security', 'RED-TEAM-RESULTS.md');
writeFileSync(out, `${md}\n`);

console.log(formatConsole(ran));
console.log(`\nwrote ${out}`);

const anyLeaked = ran.some((r) => !r.result.held);
if (anyLeaked) {
  console.error('\n✗ a scenario LEAKED, a defense regressed. See the matrix above.');
  process.exit(1);
}
