// The red-team harness — the shared shape every attack scenario reports in,
// plus the runner + report formatter that turn a catalog of scenarios into an
// empirical, machine-checkable result matrix.
//
// why this exists: peerd's security claims (SECURITY.md, docs/security/THREAT-MODEL.md)
// are architectural — "a keyless web actor has no tool to exfiltrate the key",
// "the egress allowlist fails closed on redirects", "a tampered peer bundle
// fails content-address verification". A claim nobody can run is a slogan. Each
// scenario here casts one adversary from the threat model as executable code
// that drives the REAL defense function with hostile input and records whether
// the defense held. The same catalog feeds two consumers:
//   - red-team.test.ts  → a CI gate (every scenario must block)
//   - report.ts         → docs/security/RED-TEAM-RESULTS.md (the demo artifact)
// Define once, prove once, publish once.

/** One individual hostile probe inside a scenario (a scenario bundles many). */
export interface Probe {
  /** The specific attack vector, phrased from the adversary's point of view. */
  vector: string;
  /** True when the defense stopped this probe. A scenario passes iff ALL probes blocked. */
  blocked: boolean;
  /** Concrete observed proof — the error thrown, the value refused, the call that never happened. */
  evidence: string;
}

export type ScenarioTier =
  /** Runs live in this bun harness against imported pure defense functions. */
  | 'unit'
  /** Needs a real Worker/iframe realm; verified by the in-browser CDP suite, referenced here. */
  | 'in-browser';

export interface Scenario {
  /** Stable id, e.g. '01-api-key-exfiltration'. Doubles as the report row key. */
  id: string;
  /** Human title of the attack. */
  title: string;
  /** The adversary from the threat model, e.g. 'malicious webpage'. */
  adversary: string;
  /** The asset under attack, e.g. 'model-provider API key'. */
  asset: string;
  /** The one-line security invariant this scenario proves empirically. */
  claim: string;
  /** Anchor into docs/security/THREAT-MODEL.md, e.g. 'INV-1'. */
  threatModelRef: string;
  /** Which surface actually runs the probes. */
  tier: ScenarioTier;
  /**
   * For the 'malicious MCP server' adversary: peerd ships no MCP client, so the
   * named vector maps onto peerd's real untrusted-tool-metadata surface. This
   * records that mapping so the report is honest about what is (and isn't) tested.
   */
  mcpMapping?: string;
  /**
   * Execute the scenario's probes and report. For 'in-browser' scenarios that a
   * bun process cannot run (real Worker/iframe realms), `run` returns a pointer
   * result describing where the empirical verification lives instead.
   */
  run(): Promise<ScenarioResult>;
}

export interface ScenarioResult {
  /** True iff every probe was blocked (or, for in-browser tiers, verified elsewhere). */
  held: boolean;
  /** The defense mechanism(s) that did the blocking, named for the report. */
  defenses: string[];
  /** Every probe attempted. */
  probes: Probe[];
  /**
   * For in-browser scenarios: where the real-realm assertions live and run,
   * so the report can cite an empirical source instead of executing it here.
   */
  verifiedBy?: string;
}

/** Sugar for a blocked probe. */
export const blocked = (vector: string, evidence: string): Probe => ({ vector, blocked: true, evidence });
/** Sugar for a probe that got through — a defense failure the CI gate will catch. */
export const leaked = (vector: string, evidence: string): Probe => ({ vector, blocked: false, evidence });

/** A scenario holds iff it recorded at least one probe and every probe was blocked. */
export const summarize = (probes: Probe[], defenses: string[]): ScenarioResult => ({
  held: probes.length > 0 && probes.every((p) => p.blocked),
  defenses,
  probes,
});

/** Run one scenario and attach its id/metadata for the report row. */
export interface RanScenario extends Scenario {
  result: ScenarioResult;
}

export const runScenario = async (s: Scenario): Promise<RanScenario> => ({
  ...s,
  result: await s.run(),
});

// ---- report formatting -------------------------------------------------------

const PASS = '✅';
const FAIL = '❌';
const REF = '🔬'; // verified in the in-browser tier

const statusCell = (r: RanScenario): string => {
  if (r.tier === 'in-browser') return r.result.held ? `${REF} verified` : `${FAIL} FAILED`;
  return r.result.held ? `${PASS} blocked` : `${FAIL} LEAKED`;
};

/** Render the full result matrix as Markdown for docs/security/RED-TEAM-RESULTS.md. */
export const formatMarkdown = (ran: RanScenario[], generatedNote: string): string => {
  const total = ran.length;
  const held = ran.filter((r) => r.result.held).length;
  const probeCount = ran.reduce((n, r) => n + r.result.probes.length, 0);
  const probesBlocked = ran.reduce((n, r) => n + r.result.probes.filter((p) => p.blocked).length, 0);

  const lines: string[] = [];
  lines.push('# peerd red-team results');
  lines.push('');
  lines.push('> **Generated file — do not hand-edit.** Produced by');
  lines.push('> `bun run tests/red-team/report.ts` (`bun run red-team:report`). It runs the');
  lines.push('> scenario catalog in `tests/red-team/` against the real defense code and');
  lines.push('> records what held. Re-run it to refresh. Each row maps to an adversary in');
  lines.push('> [`docs/security/THREAT-MODEL.md`](./THREAT-MODEL.md) and to a CI-gated test');
  lines.push('> (`tests/red-team/red-team.test.ts`, plus the in-browser suite for realm escapes).');
  lines.push('');
  lines.push(generatedNote);
  lines.push('');
  lines.push(`**${held}/${total} scenarios held · ${probesBlocked}/${probeCount} individual hostile probes blocked.**`);
  lines.push('');
  lines.push('| # | Attack | Adversary | Asset | Invariant | Result |');
  lines.push('|---|--------|-----------|-------|-----------|--------|');
  for (const r of ran) {
    lines.push(`| ${r.id.split('-')[0]} | ${r.title} | ${r.adversary} | ${r.asset} | [${r.threatModelRef}](./THREAT-MODEL.md#${r.threatModelRef.toLowerCase()}) | ${statusCell(r)} |`);
  }
  lines.push('');

  for (const r of ran) {
    lines.push(`## ${r.id}: ${r.title}`);
    lines.push('');
    lines.push(`- **Adversary:** ${r.adversary}`);
    lines.push(`- **Asset:** ${r.asset}`);
    lines.push(`- **Claim proven:** ${r.claim}`);
    lines.push(`- **Threat-model invariant:** ${r.threatModelRef}`);
    lines.push(`- **Defenses exercised:** ${r.result.defenses.join(', ')}`);
    if (r.mcpMapping) lines.push(`- **MCP mapping:** ${r.mcpMapping}`);
    if (r.result.verifiedBy) lines.push(`- **Empirically verified by:** \`${r.result.verifiedBy}\``);
    lines.push('');
    lines.push('| Probe (adversary action) | Result | Evidence |');
    lines.push('|--------------------------|--------|----------|');
    for (const p of r.result.probes) {
      lines.push(`| ${p.vector} | ${p.blocked ? `${PASS} blocked` : `${FAIL} LEAKED`} | ${p.evidence} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
};

/** A compact console summary for the report CLI and CI logs. */
export const formatConsole = (ran: RanScenario[]): string => {
  const rows = ran.map((r) => {
    const p = r.result.probes;
    const b = p.filter((x) => x.blocked).length;
    return `  ${r.result.held ? PASS : FAIL} ${r.id}  (${b}/${p.length} probes blocked)  ${r.title}`;
  });
  const held = ran.filter((r) => r.result.held).length;
  return [`peerd red-team — ${held}/${ran.length} scenarios held`, ...rows].join('\n');
};
