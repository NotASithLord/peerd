// The red-team harness: the shared shape every attack scenario reports in, plus
// the runner and report formatter that turn a catalog of scenarios into a
// machine-checkable result matrix.
//
// why this exists: the security claims in SECURITY.md and
// docs/security/THREAT-MODEL.md are architectural. For example, a keyless web
// actor has no tool to exfiltrate the key, the egress allowlist fails closed on
// redirects, and a tampered peer bundle fails content-address verification. Each
// scenario here casts one adversary from the threat model as code that drives the
// real defense function with hostile input and records whether the defense held.
// The same catalog feeds two consumers:
//   red-team.test.ts: a CI gate. Every scoped probe must block; a scenario with
//                     a documented platform residual is reported as partial.
//   report.ts: writes docs/security/RED-TEAM-RESULTS.md.

/** One individual hostile probe inside a scenario. A scenario bundles many. */
export interface Probe {
  /** The specific attack vector, phrased from the adversary's point of view. */
  vector: string;
  /** True when the defense stopped this scoped probe. */
  blocked: boolean;
  /** The observed result: the error thrown, the value refused, or the call that never happened. */
  evidence: string;
}

export type ScenarioTier =
  /** Runs in this Bun harness against imported pure defense functions. */
  | 'unit'
  /** Needs a real Worker or iframe realm. Verified by the in-browser CDP suite, referenced here. */
  | 'in-browser';

export interface Scenario {
  /** Stable id, for example '01-api-key-exfiltration'. Also the report row key. */
  id: string;
  /** Human title of the attack. */
  title: string;
  /** The adversary from the threat model, for example 'malicious webpage'. */
  adversary: string;
  /** The asset under attack, for example 'model-provider API key'. */
  asset: string;
  /** The one-line security invariant this scenario checks. */
  claim: string;
  /** Anchor into docs/security/THREAT-MODEL.md, for example 'INV-1'. */
  threatModelRef: string;
  /** Which surface runs the probes. */
  tier: ScenarioTier;
  /**
   * For the malicious-MCP-server adversary: peerd ships no MCP client, so the
   * named vector maps onto peerd's real untrusted-tool-metadata surface. This
   * records that mapping so the report is clear about what is and is not tested.
   */
  mcpMapping?: string;
  /**
   * Run the scenario's probes and report. For an in-browser scenario that a Bun
   * process cannot run (a real Worker or iframe realm), run() returns a result
   * describing where the verification lives instead.
   */
  run(): Promise<ScenarioResult>;
}

export interface ScenarioResult {
  /** True only if every probe was blocked, or, for an in-browser tier, verified elsewhere. */
  held: boolean;
  /** Partial means the scoped probes held but a named platform residual remains. */
  coverage?: 'complete' | 'partial';
  /** Concrete limits that prevent a partial scenario from being reported globally blocked. */
  residuals?: string[];
  /** The defense mechanisms that did the blocking, named for the report. */
  defenses: string[];
  /** Every probe attempted. */
  probes: Probe[];
  /** For an in-browser scenario, where the real-realm assertions live and run. */
  verifiedBy?: string;
}

/** Record a blocked probe. */
export const blocked = (vector: string, evidence: string): Probe => ({ vector, blocked: true, evidence });
/** Record a probe that got through. This is a defense failure the CI gate will catch. */
export const leaked = (vector: string, evidence: string): Probe => ({ vector, blocked: false, evidence });

/** A scenario's stated probe scope holds only when it is non-empty and entirely blocked. */
export const summarize = (probes: Probe[], defenses: string[]): ScenarioResult => ({
  held: probes.length > 0 && probes.every((p) => p.blocked),
  coverage: 'complete',
  defenses,
  probes,
});

/** A scenario plus its run result, for the report row. */
export interface RanScenario extends Scenario {
  result: ScenarioResult;
}

export const runScenario = async (s: Scenario): Promise<RanScenario> => ({
  ...s,
  result: await s.run(),
});

// ---- report formatting -------------------------------------------------------

const statusCell = (r: RanScenario): string => {
  if (r.result.held && r.result.coverage === 'partial') return 'partial: platform residual';
  if (r.tier === 'in-browser') return r.result.held ? 'verified' : 'FAILED';
  return r.result.held ? 'blocked' : 'LEAKED';
};

/** Render the full result matrix as Markdown for docs/security/RED-TEAM-RESULTS.md. */
export const formatMarkdown = (ran: RanScenario[], generatedNote: string): string => {
  const total = ran.length;
  const partial = ran.filter((r) => r.result.held && r.result.coverage === 'partial').length;
  const held = ran.filter((r) => r.result.held && r.result.coverage !== 'partial').length;
  const probeCount = ran.reduce((n, r) => n + r.result.probes.length, 0);
  const probesBlocked = ran.reduce((n, r) => n + r.result.probes.filter((p) => p.blocked).length, 0);

  const lines: string[] = [];
  lines.push('# peerd red-team results');
  lines.push('');
  lines.push('> Generated file. Do not hand-edit. Produced by');
  lines.push('> `bun run tests/red-team/report.ts` (`bun run red-team:report`). It runs the');
  lines.push('> scenario catalog in `tests/red-team/` against the real defense code and');
  lines.push('> records what held. Re-run it to refresh. Each row maps to an adversary in');
  lines.push('> [`docs/security/THREAT-MODEL.md`](./THREAT-MODEL.md) and to a CI-gated test');
  lines.push('> (`tests/red-team/red-team.test.ts`, plus the in-browser suite for realm escapes).');
  lines.push('');
  lines.push(generatedNote);
  lines.push('');
  lines.push(`${held} of ${total} scenarios fully held; ${partial} partial with a named platform residual. ${probesBlocked} of ${probeCount} individual scoped hostile probes blocked.`);
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
    lines.push(`- Adversary: ${r.adversary}`);
    lines.push(`- Asset: ${r.asset}`);
    lines.push(`- Claim checked: ${r.claim}`);
    lines.push(`- Threat-model invariant: ${r.threatModelRef}`);
    lines.push(`- Coverage: ${r.result.coverage === 'partial' ? 'partial: platform residual' : 'complete for the stated probes'}`);
    if (r.result.residuals?.length) lines.push(`- Platform residuals: ${r.result.residuals.join('; ')}`);
    lines.push(`- Defenses exercised: ${r.result.defenses.join(', ')}`);
    if (r.mcpMapping) lines.push(`- MCP mapping: ${r.mcpMapping}`);
    if (r.result.verifiedBy) lines.push(`- Verified in the browser by: \`${r.result.verifiedBy}\``);
    lines.push('');
    lines.push('| Probe (adversary action) | Result | Evidence |');
    lines.push('|--------------------------|--------|----------|');
    for (const p of r.result.probes) {
      lines.push(`| ${p.vector} | ${p.blocked ? 'blocked' : 'LEAKED'} | ${p.evidence} |`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
};

/** A compact console summary for the report CLI and CI logs. */
export const formatConsole = (ran: RanScenario[]): string => {
  const rows = ran.map((r) => {
    const p = r.result.probes;
    const b = p.filter((x) => x.blocked).length;
    const status = !r.result.held ? 'FAIL'
      : r.result.coverage === 'partial' ? 'PARTIAL' : 'PASS';
    return `  ${status} ${r.id}  (${b}/${p.length} scoped probes blocked)  ${r.title}`;
  });
  const partial = ran.filter((r) => r.result.held && r.result.coverage === 'partial').length;
  const held = ran.filter((r) => r.result.held && r.result.coverage !== 'partial').length;
  return [`peerd red-team: ${held} fully held, ${partial} partial, ${ran.length - held - partial} failed`, ...rows].join('\n');
};
