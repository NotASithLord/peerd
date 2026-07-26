// The red-team scenario catalog, the single ordered list every consumer reads.
//
// Add a scenario by writing scenarios/NN-name.ts (exporting `scenario`) and
// importing it here. `red-team.test.ts` gates it in CI; `report.ts` publishes it.

import type { Scenario } from './harness.ts';

import { scenario as s01 } from './scenarios/01-api-key-exfiltration.ts';
import { scenario as s02 } from './scenarios/02-cross-origin-fetch.ts';
import { scenario as s03 } from './scenarios/03-secret-summarization.ts';
import { scenario as s04 } from './scenarios/04-malicious-peer-bundle.ts';
import { scenario as s05 } from './scenarios/05-mcp-tool-poisoning.ts';
import { scenario as s06 } from './scenarios/06-sandbox-escape.ts';
import { scenario as s07 } from './scenarios/07-ssrf-private-network.ts';
import { scenario as s08 } from './scenarios/08-prompt-injection-benchmark.ts';
import { scenario as s09 } from './scenarios/09-page-content-injection.ts';

// Ordered to mirror the threat model's adversary walk and the task brief.
export const CATALOG: readonly Scenario[] = [s01, s02, s03, s04, s05, s06, s07, s08, s09];
