#!/usr/bin/env bun
// run-eval-context.mjs — measure the MAIN agent's per-turn CONTEXT COST for the
// current build: the system-prompt size, the number of tools advertised, and the
// total request size shipped on EVERY turn. The companion to run-eval-bench.mjs:
// the bench scores task PERFORMANCE; this scores the per-turn context the model
// must carry to get it. Together they answer the question the actor refactor bet
// on — "did context shrink, and did task quality survive it?" — build over build.
//
// Keyless + free: the system prompt + tool schemas are assembled for REAL and
// captured off the faked model wire (no provider key, no cost, no real egress),
// so anyone can run it on any build. The numbers are provider-shaped (captured
// from the keyless Ollama request) but the system prompt + tool set are
// provider-agnostic in substance, so the build-over-build DELTA is the signal.
//
// Usage:
//   bun run eval:context                          # snapshot this build, write a record
//   bun run eval:context --baseline=<prev.json>   # diff vs a prior snapshot
//   bun run eval:context --show-tools             # also print the advertised tool names

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { launchPeerd, rpc, unlockAndReady, waitFor, log, sseText } from './e2e-harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, 'bench-results');

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};
const BASELINE = flag('baseline', false) ? String(flag('baseline', '')) : '';
const SHOW_TOOLS = !!flag('show-tools', false);

const shortSha = () => { try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'nogit'; } };

main();

async function main() {
  log('CONTEXT snapshot — keyless, no cost. Capturing the main agent\'s per-turn system prompt + tool schemas off the faked wire.');
  // Capture the FIRST /v1/chat/completions request — that is one full turn's
  // always-on context (system prompt + the advertised tools).
  let captured = null;
  const ctx = await launchPeerd({
    modelResponder: (i, req) => { if (i === 0 && !captured) captured = (req && req.postData) || ''; return { sse: sseText('ok') }; },
  });
  try {
    await unlockAndReady(ctx.page); // vault + keyless Ollama provider
    await rpc(ctx.page, { type: 'agent/send', text: 'hello' });
    await waitFor(() => !!captured, { budgetMs: 25_000 });
    if (!captured) throw new Error('no model request captured (did the turn fire?)');

    const body = JSON.parse(captured);
    const sys = (body.messages || []).find((m) => m.role === 'system')?.content || '';
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const toolNames = tools.map((t) => t.function?.name || t.name).filter(Boolean).sort();
    const metrics = {
      build: shortSha(),
      at: new Date().toISOString(),
      systemChars: sys.length,
      toolCount: tools.length,
      toolSchemaChars: JSON.stringify(tools).length,
      perTurnRequestChars: captured.length,
      approxTokensPerTurn: Math.round(captured.length / 4),
      toolNames,
    };

    mkdirSync(OUT_DIR, { recursive: true });
    const outPath = join(OUT_DIR, `context-${metrics.build}-${metrics.at.replace(/[:.]/g, '-')}.json`);
    writeFileSync(outPath, JSON.stringify(metrics, null, 2));
    log(`context record → ${outPath}`);
    printMetrics(metrics);
    if (SHOW_TOOLS) log(`tools (${toolNames.length}): ${toolNames.join(', ')}`);

    if (BASELINE) {
      if (!existsSync(BASELINE)) throw new Error(`baseline not found: ${BASELINE}`);
      printDelta(JSON.parse(readFileSync(BASELINE, 'utf8')), metrics);
    }
    ctx.close();
    process.exit(0);
  } catch (e) {
    console.error('[context]', e?.message || e);
    try { ctx.close(); } catch { /* */ }
    process.exit(1);
  }
}

function printMetrics(m) {
  log('=== MAIN-AGENT CONTEXT (per turn) ===');
  log(`tools ${m.toolCount}  ·  system ${m.systemChars} ch  ·  tool schemas ${m.toolSchemaChars} ch  ·  request ${m.perTurnRequestChars} ch (~${m.approxTokensPerTurn} tok)`);
}

function printDelta(base, cur) {
  log('=== Δ vs baseline ===');
  const d = (k) => cur[k] - (Number(base[k]) || 0);
  const s = (n) => (n >= 0 ? `+${n}` : `${n}`);
  const reqD = d('perTurnRequestChars');
  log(`tools ${s(d('toolCount'))}  ·  system ${s(d('systemChars'))} ch  ·  request ${s(reqD)} ch (~${s(Math.round(reqD / 4))} tok/turn)`);
  const baseSet = new Set(base.toolNames || []);
  const curSet = new Set(cur.toolNames || []);
  const added = (cur.toolNames || []).filter((n) => !baseSet.has(n));
  const removed = (base.toolNames || []).filter((n) => !curSet.has(n));
  if (added.length) log(`tools added: ${added.join(', ')}`);
  if (removed.length) log(`tools removed: ${removed.join(', ')}`);
  if (!added.length && !removed.length) log('tool set unchanged');
}
