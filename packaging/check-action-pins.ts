// Every third-party GitHub Action runs at a full commit SHA.
//
//   bun run check:actions
//
// why a gate and not just a convention: a major tag (`@v5`) is a mutable ref
// the action's publisher controls. If it moves, arbitrary code runs in a job
// that has this repo's checkout, and in the release workflow, its signing
// secrets. The workflows already document the rule and Dependabot already
// keeps the pinned SHAs current; this makes the rule fail closed instead of
// depending on a reviewer noticing a `@v5` in a diff.
//
// Local composite actions (./.github/actions/...) are exempt: a relative path
// is this repo's own reviewed code, with no upstream ref anyone could move.
//
// When this fails: resolve the tag to its commit with
//   git ls-remote https://github.com/<owner>/<repo> 'refs/tags/<tag>^{}'
// (fall back to the bare tag ref when there is no ^{} line), then pin it and
// leave the human-readable version in a trailing comment, which is the format
// Dependabot reads and updates.

import { readWorkflows } from './gen-supply-chain-badges.ts';
import { scanActionPins } from './supply-chain.ts';

const check = () => {
  const scan = scanActionPins(readWorkflows());
  if (scan.uses.length < 1) {
    console.error('\ncheck:actions FAILED: no action references found. Did the workflow layout move?');
    process.exit(1);
  }
  if (scan.unpinned.length > 0) {
    console.error('\ncheck:actions FAILED: these actions are not pinned to a full commit SHA:');
    for (const use of scan.unpinned) {
      console.error(`  ${use.file}:${use.line}  ${use.uses}`);
    }
    console.error('\nPin each to its 40-character commit SHA, keeping the version in a trailing comment.');
    process.exit(1);
  }
  console.log(
    `action pins OK (${scan.actions.length} third-party actions across `
    + `${scan.uses.length} uses, all at a full commit SHA)`,
  );
};

if (import.meta.main) check();
