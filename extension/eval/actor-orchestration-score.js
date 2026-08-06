// @ts-check
// Paired decision policy for issue #326. The evaluator is deliberately pure:
// a live-model driver can feed it observations without changing the rule after
// seeing results, while the keyless protocol fixture keeps the matrix and data
// plumbing testable in CI.

export const ACTOR_ORCHESTRATION_SCENARIOS = Object.freeze([
  'single', 'parallel', 'chain', 'retry-partial-failure', 'filtering',
]);
export const MIN_MODEL_REPETITIONS = 5;

/** @typedef {{ scenario:string, success:boolean, turns:number, tokens:number|null, elapsedMs:number|null, innerOps:number, recovered:boolean|null, pairId?:string }} ActorEvalRow */
/** @typedef {{ provider?:string, model?:string, promptRevision?:string, repetitions?:number }} ActorEvalEvidence */

/** @param {number[]} values */
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

/** @param {ActorEvalRow[]} rows */
export const aggregateActorOrchestration = (rows) => {
  const required = new Set(ACTOR_ORCHESTRATION_SCENARIOS);
  const present = new Set(rows.map((row) => row.scenario));
  const complete = [...required].every((scenario) => present.has(scenario));
  const numeric = (/** @type {'turns'|'tokens'|'elapsedMs'|'innerOps'} */ key) =>
    rows.map((row) => row[key]).filter((value) => typeof value === 'number');
  // Recovery is a metric only for the declared partial-failure scenario.
  // Keeping the aggregation scoped as well as validating the input makes the
  // descriptive output immune to meaningless fields even for unqualified data.
  const recoveredRows = rows.filter((row) => row.scenario === 'retry-partial-failure'
    && typeof row.recovered === 'boolean');
  return Object.freeze({
    complete,
    total: rows.length,
    successes: rows.filter((row) => row.success).length,
    successRate: rows.length ? rows.filter((row) => row.success).length / rows.length : 0,
    avgTurns: average(/** @type {number[]} */ (numeric('turns'))),
    avgTokens: numeric('tokens').length ? average(/** @type {number[]} */ (numeric('tokens'))) : null,
    avgElapsedMs: numeric('elapsedMs').length ? average(/** @type {number[]} */ (numeric('elapsedMs'))) : null,
    avgInnerOps: average(/** @type {number[]} */ (numeric('innerOps'))),
    recoveryRate: recoveredRows.length
      ? recoveredRows.filter((row) => row.recovered === true).length / recoveredRows.length
      : null,
    byScenario: Object.fromEntries(ACTOR_ORCHESTRATION_SCENARIOS.map((scenario) => {
      const subset = rows.filter((row) => row.scenario === scenario);
      return [scenario, { attempts: subset.length, successRate: subset.length ? subset.filter((row) => row.success).length / subset.length : 0 }];
    })),
  });
};

/**
 * Model evidence must be paired and sufficiently replicated before it can
 * change a public contract. This does not pretend to authenticate a benchmark
 * file; it prevents an incomplete/manual row sketch (or the CI protocol
 * fixture) from being accidentally relabeled as a qualifying experiment.
 * @param {ActorEvalEvidence | undefined} evidence
 * @param {ActorEvalRow[]} messageRows
 * @param {ActorEvalRow[]} codeRows
 */
export const qualifyActorModelEvidence = (evidence, messageRows, codeRows) => {
  const repetitions = evidence?.repetitions;
  if (typeof evidence?.provider !== 'string' || !evidence.provider.trim()
    || typeof evidence?.model !== 'string' || !evidence.model.trim()
    || typeof evidence?.promptRevision !== 'string' || !evidence.promptRevision.trim()) {
    return { qualified: false, reason: 'model evidence is missing provider/model/prompt provenance' };
  }
  if (!Number.isInteger(repetitions) || /** @type {number} */ (repetitions) < MIN_MODEL_REPETITIONS) {
    return { qualified: false, reason: `model evidence needs at least ${MIN_MODEL_REPETITIONS} paired repetitions per scenario` };
  }
  const count = /** @type {number} */ (repetitions);
  const declaredScenarios = new Set(ACTOR_ORCHESTRATION_SCENARIOS);
  if ([...messageRows, ...codeRows].some((row) => !declaredScenarios.has(row.scenario))) {
    return { qualified: false, reason: 'model evidence contains an undeclared scenario' };
  }
  // why: the decision aggregates every supplied row. Exact per-scenario counts
  // alone are not sufficient: undeclared padding could otherwise poison either
  // arm's aggregate without affecting the five declared count checks.
  const expectedRows = count * ACTOR_ORCHESTRATION_SCENARIOS.length;
  if (messageRows.length !== expectedRows || codeRows.length !== expectedRows) {
    return { qualified: false, reason: 'model evidence has the wrong total row count' };
  }
  for (const scenario of ACTOR_ORCHESTRATION_SCENARIOS) {
    const message = messageRows.filter((row) => row.scenario === scenario);
    const code = codeRows.filter((row) => row.scenario === scenario);
    if (message.length !== count || code.length !== count) {
      return { qualified: false, reason: `model evidence has the wrong repetition count for ${scenario}` };
    }
    const valid = (/** @type {ActorEvalRow} */ row) =>
      typeof row.pairId === 'string' && row.pairId.length > 0
      && typeof row.success === 'boolean'
      && Number.isInteger(row.turns) && row.turns > 0
      && typeof row.tokens === 'number' && Number.isFinite(row.tokens) && row.tokens >= 0
      && typeof row.elapsedMs === 'number' && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0
      && Number.isInteger(row.innerOps) && row.innerOps >= 0
      && (scenario === 'retry-partial-failure'
        ? typeof row.recovered === 'boolean'
        : row.recovered === null);
    if (!message.every(valid) || !code.every(valid)) {
      return { qualified: false, reason: `model evidence has invalid metrics for ${scenario}` };
    }
    const messagePairs = message.map((row) => row.pairId).sort();
    const codePairs = code.map((row) => row.pairId).sort();
    if (new Set(messagePairs).size !== count || messagePairs.some((id, index) => id !== codePairs[index])) {
      return { qualified: false, reason: `model evidence is not one-to-one paired for ${scenario}` };
    }
  }
  return { qualified: true, reason: 'paired model evidence is complete' };
};

/**
 * Predeclared removal rule. A protocol smoke can prove the bridge semantics but
 * never model reliability, so it cannot authorize deleting the scalar tool.
 * @param {{ evidenceKind:'model'|'protocol-smoke', evidence?:ActorEvalEvidence, messageRows:ActorEvalRow[], codeRows:ActorEvalRow[] }} input
 */
export const decideActorMessagingContract = ({ evidenceKind, evidence, messageRows, codeRows }) => {
  const qualification = evidenceKind === 'model'
    ? qualifyActorModelEvidence(evidence, messageRows, codeRows)
    : { qualified: false, reason: 'protocol evidence cannot establish model reliability' };
  // Qualify first. The aggregate is descriptive output even for an invalid
  // experiment, but it must never be consulted before the declared row set,
  // pairing, provenance, and metrics have failed closed.
  const message = aggregateActorOrchestration(messageRows);
  const code = aggregateActorOrchestration(codeRows);
  const singleNonInferior = code.byScenario.single.successRate >= message.byScenario.single.successRate;
  const overallNonInferior = code.successRate >= message.successRate;
  const recoveryNonInferior = code.recoveryRate !== null && message.recoveryRate !== null
    ? code.recoveryRate >= message.recoveryRate
    : true;
  const composite = new Set(ACTOR_ORCHESTRATION_SCENARIOS.slice(1));
  const messageComposite = messageRows.filter((row) => composite.has(row.scenario));
  const codeComposite = codeRows.filter((row) => composite.has(row.scenario));
  const turnGain = average(messageComposite.map((row) => row.turns)) > 0
    ? 1 - (average(codeComposite.map((row) => row.turns)) / average(messageComposite.map((row) => row.turns)))
    : 0;
  const materiallyBetter = turnGain >= 0.20;
  const removable = qualification.qualified && message.complete && code.complete
    && singleNonInferior && overallNonInferior && recoveryNonInferior && materiallyBetter;
  return Object.freeze({
    decision: removable ? 'remove-message-actor' : 'retain-message-actor-scalar-shortcut',
    removable,
    reason: !qualification.qualified
      ? qualification.reason
      : !message.complete || !code.complete
        ? 'paired matrix is incomplete'
        : !singleNonInferior || !overallNonInferior || !recoveryNonInferior
          ? 'code is not reliability-noninferior'
          : !materiallyBetter
            ? 'code is not materially better on compound work'
            : 'code is reliability-noninferior and materially reduces compound turns',
    thresholds: Object.freeze({ compoundTurnReduction: 0.20, reliabilityRegression: 0 }),
    evidenceQualified: qualification.qualified,
    observed: Object.freeze({ message, code, compoundTurnReduction: turnGain }),
  });
};

// Deterministic bridge-level fixture. These rows describe host round-trips, not
// tokens or model latency, and are stamped protocol-smoke so they can NEVER be
// mistaken for evidence supporting tool removal.
export const protocolSmokeRows = () => ({
  messageRows: ACTOR_ORCHESTRATION_SCENARIOS.map((scenario) => ({
    scenario, success: true,
    turns: scenario === 'single' ? 1 : scenario === 'parallel' ? 3 : scenario === 'chain' ? 3 : scenario === 'retry-partial-failure' ? 4 : 3,
    tokens: null, elapsedMs: null,
    innerOps: scenario === 'single' ? 1 : scenario === 'retry-partial-failure' ? 4 : 3,
    recovered: scenario === 'retry-partial-failure' ? true : null,
  })),
  codeRows: ACTOR_ORCHESTRATION_SCENARIOS.map((scenario) => ({
    scenario, success: true, turns: 1, tokens: null, elapsedMs: null,
    innerOps: scenario === 'single' ? 1 : scenario === 'retry-partial-failure' ? 4 : 3,
    recovered: scenario === 'retry-partial-failure' ? true : null,
  })),
});
