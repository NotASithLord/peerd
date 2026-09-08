// The red-team CI gate.
//
// Every scoped probe in the catalog must HOLD. A scenario with a known platform
// residual stays green only when it declares partial coverage and names the
// residual instead of claiming a global block.
//
// The report artifact (docs/security/RED-TEAM-RESULTS.md) is produced separately
// by `bun run red-team:report`, which reuses this same catalog.

import { describe, test, expect } from 'bun:test';
import { CATALOG } from './index.ts';
import { runScenario } from './harness.ts';

describe('peerd red-team suite', () => {
  for (const s of CATALOG) {
    describe(`${s.id}, ${s.title}`, () => {
      test(`scoped probes hold: ${s.claim}`, async () => {
        const ran = await runScenario(s);
        // Surface every leaked probe by name so a failure points at the exact vector.
        const leaks = ran.result.probes.filter((p) => !p.blocked).map((p) => `${p.vector} :: ${p.evidence}`);
        expect(leaks).toEqual([]);
        expect(ran.result.probes.length).toBeGreaterThan(0);
        expect(ran.result.held).toBe(true);
      });
    });
  }

  test('the catalog covers every scenario, in order', () => {
    expect(CATALOG.map((s) => s.id)).toEqual([
      '01-api-key-exfiltration',
      '02-cross-origin-fetch',
      '03-secret-summarization',
      '04-malicious-peer-bundle',
      '05-mcp-tool-poisoning',
      '06-sandbox-escape',
      '07-ssrf-private-network',
      '08-prompt-injection-benchmark',
      '09-page-content-injection',
      '10-origin-retasking',
      '11-login-orchestration',
      '12-contributor-metrics',
      '13-site-client-custody',
      '14-confirmation-lifecycle-custody',
    ]);
  });

  test('every scenario references a threat-model invariant', () => {
    for (const s of CATALOG) expect(s.threatModelRef).toMatch(/^INV-\d+$/);
  });

  test('partial scenarios name their platform residuals', async () => {
    const ran = await Promise.all(CATALOG.map(runScenario));
    const partial = ran.filter((entry) => entry.result.coverage === 'partial');
    expect(partial.map((entry) => entry.id)).toEqual(['07-ssrf-private-network']);
    expect(partial[0]?.result.held).toBe(true);
    expect(partial[0]?.result.residuals?.length).toBeGreaterThan(0);
  });
});
