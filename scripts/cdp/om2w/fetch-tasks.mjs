#!/usr/bin/env bun
// scripts/cdp/om2w/fetch-tasks.mjs — download the Online-Mind2Web task set
// (HF dataset osunlp/Online-Mind2Web) at a PINNED revision.
//
// The dataset is GATED (gated:auto — log in on huggingface.co, open the dataset
// page, accept the terms; approval is automatic) and CC-BY-4.0. Because it is
// gated, the tasks are NOT committed to this repo: this importer writes them to
// scripts/cdp/om2w/data/ (gitignored) and records the revision + attribution in
// SOURCE.txt there. Pinning matters: tasks were revised repeatedly (2025-11 →
// 2026-05), and comparable numbers require naming the exact revision you ran.
//
// Usage:  HF_TOKEN=hf_... bun scripts/cdp/om2w/fetch-tasks.mjs [--revision=<sha>]

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, 'data');
const DATASET = 'osunlp/Online-Mind2Web';
// The v2-schema-era revision current at scoping time (2026-05-23). Override
// with --revision to track a newer task set deliberately, never accidentally.
const DEFAULT_REVISION = '6aa56e07c9d247fcc2b72fc3d94ad0f857f1e5d4';

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

const TOKEN = process.env.HF_TOKEN || '';
if (!TOKEN) {
  console.error('[om2w] HF_TOKEN is required (the dataset is gated).');
  console.error('  1. Log in at huggingface.co, open https://huggingface.co/datasets/osunlp/Online-Mind2Web, accept the terms (auto-approved).');
  console.error('  2. Create a READ token at https://huggingface.co/settings/tokens');
  console.error('  3. HF_TOKEN=hf_... bun scripts/cdp/om2w/fetch-tasks.mjs');
  process.exit(2);
}

const revision = String(arg('revision', DEFAULT_REVISION));
const url = `https://huggingface.co/datasets/${DATASET}/resolve/${revision}/Online_Mind2Web.json`;

const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
if (!res.ok) {
  console.error(`[om2w] download failed: HTTP ${res.status} ${res.statusText}`);
  if (res.status === 401 || res.status === 403) console.error('  → is the token valid, and did you accept the dataset terms on its HF page?');
  process.exit(1);
}
const raw = await res.json();
if (!Array.isArray(raw)) { console.error('[om2w] unexpected payload (not an array)'); process.exit(1); }

// Keep only the fields the adapter needs; validate the shape loudly.
const tasks = raw.map((t) => ({
  task_id: String(t.task_id ?? ''),
  website: String(t.website ?? ''),
  task_description: String(t.confirmed_task ?? t.task_description ?? ''),
  reference_length: Number(t.reference_length ?? 0),
  level: t.level ?? null,
}));
const bad = tasks.filter((t) => !t.task_id || !/^https?:\/\//.test(t.website) || !t.task_description);
if (bad.length) console.error(`[om2w] WARNING: ${bad.length} task(s) have missing fields — first: ${JSON.stringify(bad[0]).slice(0, 200)}`);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(resolve(OUT_DIR, 'tasks.json'), JSON.stringify({ dataset: DATASET, revision, fetchedAt: new Date().toISOString(), count: tasks.length, tasks }, null, 2));
writeFileSync(resolve(OUT_DIR, 'SOURCE.txt'), [
  `Online-Mind2Web task set — https://huggingface.co/datasets/${DATASET}`,
  `revision: ${revision}`,
  `fetched:  ${new Date().toISOString()}`,
  'license:  CC-BY-4.0 (dataset; gated on HF — do NOT commit the tasks to this repo)',
  'paper:    An Illusion of Progress? (arXiv:2504.01382)',
].join('\n'));
console.log(`[om2w] wrote ${tasks.length} tasks @ ${revision.slice(0, 8)} → ${resolve(OUT_DIR, 'tasks.json')}`);
