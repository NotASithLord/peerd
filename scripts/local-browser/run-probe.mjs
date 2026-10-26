#!/usr/bin/env node
// One real policy decision over a synthetic snapshot. This is an integration
// probe, with no browser execution, text-helper calls, or model provisioning.
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parseSnapshot, buildDecisionRequest, selectDecision } from './decision-core.mjs';
import { makeLocalClients } from './model-bridge.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/local-browser/run-probe.mjs [--decision-origin=http://127.0.0.1:8000] [--model=decider-4b]\n'
    + 'Requires an already running local decision server. Prints one JSON report to stdout.\n'
    + 'No services are started and no model weights are downloaded.');
  process.exit(0);
}
const options = {};
for (const arg of args) {
  const match = /^--(decision-origin|model)=(.+)$/.exec(arg);
  if (!match || options[match[1]] !== undefined) {
    throw new Error('Use unique --decision-origin=value and --model=value options; see --help.');
  }
  options[match[1]] = match[2];
}

const decisionOrigin = options['decision-origin'] ?? 'http://127.0.0.1:8000';
const clients = makeLocalClients({ decisionOrigin });
const observation = parseSnapshot('pseudo-a11y snapshot (DOM-walk fallback: no CDP here; top frame only): 2 interactable refs\n'
  + 'heading "Local catalog"\n@e1 textbox "Search catalog"\n@e2 button "Find items"');
const { request, choices } = buildDecisionRequest({
  goal: 'Search the catalog for copper, then open the Copper widget product.',
  observation,
  model: options.model ?? 'decider-4b',
});
const expectedChoice = 'type_e1';
const report = {
  schemaVersion: 1,
  evidenceClass: 'real-model-single-decision',
  startedAt: new Date().toISOString(),
  clientEnvironment: { platform: process.platform, architecture: process.arch, node: process.version },
  decisionOrigin,
  syntheticObservation: true,
  browserExecution: false,
  helperInference: false,
  request,
  requestSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
  expectedChoice,
};
const started = performance.now();
try {
  report.response = await clients.decide(request);
  report.httpElapsedMs = Math.round((performance.now() - started) * 1000) / 1000;
  report.selectedAction = selectDecision(report.response, choices);
  report.actualChoice = report.response.answers.action.choice;
  report.ok = report.actualChoice === expectedChoice;
} catch (error) {
  report.httpElapsedMs = Math.round((performance.now() - started) * 1000) / 1000;
  report.ok = false;
  report.error = { type: error.name, message: 'The local decision request or response validation failed.' };
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
