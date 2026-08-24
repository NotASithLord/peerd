// Require every modern extension JavaScript file to opt into TypeScript checking.
// The shared scanner excludes the small reviewed ES5-injected set. A ratio is
// deletion-safe: removing checked code cannot make this gate fail, while one new
// unchecked file or one removed directive always does.

import { computeCoverage } from './tscheck-coverage.ts';

const { count, total } = computeCoverage();
const pct = total === 0 ? '0.0' : ((count / total) * 100).toFixed(1);

if (total === 0 || count !== total) {
  console.error(
    `TYPECHECK COVERAGE REGRESSED — ${count}/${total} extension files carry `
    + '// @ts-check. Every non-exempt extension JavaScript file must opt in.',
  );
  process.exit(1);
}

console.log(`typecheck coverage OK: ${count}/${total} extension files (${pct}%) carry // @ts-check`);
