#!/usr/bin/env bun
// Paired actor-orchestration decision scorer. With no file it runs the
// deterministic protocol matrix. A real model experiment supplies one evidence
// bundle containing provenance plus both paired arms; the pure policy validates
// its replication/metrics before it may change the contract.
//
//   bun run eval:actors
//   bun run eval:actors --evidence=/tmp/actor-ab.json

import { readFileSync } from 'node:fs';
import {
  decideActorMessagingContract, protocolSmokeRows,
} from '../../extension/eval/actor-orchestration-score.js';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.replace(/^--/, '').split('=');
  return [key, value.join('=')];
}));
const paired = args.evidence
  ? { evidenceKind: 'model', ...JSON.parse(readFileSync(args.evidence, 'utf8')) }
  : { evidenceKind: 'protocol-smoke', ...protocolSmokeRows() };

const decision = decideActorMessagingContract(paired);
process.stdout.write(`${JSON.stringify({ evidenceKind: paired.evidenceKind, ...decision }, null, 2)}\n`);
