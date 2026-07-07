#!/usr/bin/env bun
// scripts/cdp/om2w/score.mjs — WebJudge scoring for an exported OM2W run.
//
// Takes a run dir of schema-v2 trajectories (produced by run-om2w.mjs) and runs
// the UPSTREAM Online-Mind2Web scorer (WebJudge, o4-mini) over it, then prints a
// pass rate + per-task breakdown. We do NOT reimplement the judge — we shell out
// to the authors' own src/run.py so the number is the one the leaderboard would
// compute (their reported WebJudge/o4-mini human-agreement is ~85.7%).
//
// The scorer is a small Python program; this helper provisions it locally with
// no global side effects: it clones the repo on demand (gitignored vendor-repo/)
// and builds a throwaway venv (gitignored .venv/) from the repo's 3-package
// requirements. Only the judge's model calls cost money (OpenAI, o4-mini) —
// clone, venv, and parsing are all local + free.
//
// Usage (no OpenAI account needed — route via any OpenAI-compatible gateway):
//   # leaderboard-official o4-mini via OpenRouter (make an sk-or-… key):
//   bun scripts/cdp/om2w/score.mjs --run=6aa56e07 \
//     --base-url=https://openrouter.ai/api/v1 --model=openai/o4-mini --api-key=sk-or-...
//   # independent open VLM via the HF router (uses your HF token):
//   bun scripts/cdp/om2w/score.mjs --run=6aa56e07 \
//     --base-url=https://router.huggingface.co/v1 --model=Qwen/Qwen2.5-VL-72B-Instruct --api-key=hf_...
//   # direct OpenAI, if you have a key:
//   OPENAI_API_KEY=sk-... bun scripts/cdp/om2w/score.mjs --run=6aa56e07
// Flags: --run (out subdir; default the dataset revision, matching run-om2w),
//   --model (default o4-mini), --base-url (OpenAI-compatible gateway; else
//   $OPENAI_BASE_URL), --workers (default 4), --threshold (default 3),
//   --mode (default WebJudge_Online_Mind2Web_eval — the official metric),
//   --api-key (else $OPENAI_API_KEY; holds the gateway's key when --base-url is set).

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = resolve(__dirname, 'out');
const DATA = resolve(__dirname, 'data', 'tasks.json');
const REPO = resolve(__dirname, 'vendor-repo');   // upstream scorer, cloned on demand
const VENV = resolve(__dirname, '.venv');
const REPO_URL = 'https://github.com/OSU-NLP-Group/Online-Mind2Web';
// Pinned so the score is reproducible AND the source patch below targets stable
// anchors. Bump deliberately (and re-verify the patch) when adopting upstream fixes.
const PIN = 'f0d805ee0e9e0b3ea70911e45e5264b72968f3dc';

const argv = process.argv.slice(2);
const flag = (n, d) => { const h = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`)); if (!h) return d; const i = h.indexOf('='); return i === -1 ? true : h.slice(i + 1); };
const log = (m) => console.log(`[om2w-score] ${m}`);
const fail = (m) => { console.error(`[om2w-score] ${m}`); process.exit(1); };
const run = (cmd, argsv) => spawnSync(cmd, argsv, { stdio: 'inherit' });

const MODE = String(flag('mode', 'WebJudge_Online_Mind2Web_eval'));
const MODEL = String(flag('model', 'o4-mini'));
const THRESHOLD = Number(flag('threshold', 3));
const WORKERS = Number(flag('workers', 4));
// Resolve the judge key from the flag or a couple of env names. why: a stale
// PLACEHOLDER (e.g. OPENAI_API_KEY=your_api_key_here from a sourced .env) must
// NOT silently shadow a real key set under another name — so skip placeholder-
// looking values, prefer an explicit --api-key, and remember which source won so
// the run can report it (and flag a shadowing placeholder clearly).
const KEY_SOURCES = [
  ['--api-key', flag('api-key', false) ? String(flag('api-key', '')) : ''],
  ['OPENAI_API_KEY', process.env.OPENAI_API_KEY || ''],
  ['OPENROUTER_API_KEY', process.env.OPENROUTER_API_KEY || ''],
  ['PEERD_OPEN_AI_KEY', process.env.PEERD_OPEN_AI_KEY || ''],
];
const looksPlaceholder = (k) => !k || k.length < 20 || /your[_-]?api|key[_-]?here|placeholder|replace[_-]?me|example|xxxx|^</i.test(k);
const KEY_CHOSEN = KEY_SOURCES.find(([, v]) => v && !looksPlaceholder(v)) || null;
const KEY_SHADOW = KEY_SOURCES.find(([, v]) => v && looksPlaceholder(v)) || null; // set-but-placeholder
const KEY = KEY_CHOSEN ? KEY_CHOSEN[1] : '';
// Route the judge through any OpenAI-compatible gateway (the openai-python SDK
// reads OPENAI_BASE_URL). Lets you run the mandated o4-mini via OpenRouter, or
// an open VLM via the HF router, without a direct OpenAI account.
const BASE_URL = flag('base-url', false) ? String(flag('base-url', '')) : (process.env.OPENAI_BASE_URL || '');

const defaultRun = existsSync(DATA) ? String(JSON.parse(readFileSync(DATA, 'utf8')).revision || '').slice(0, 8) : '';
const RUN = String(flag('run', defaultRun));
const TRAJ = join(OUT_ROOT, RUN);
const RESULT_DIR = `${TRAJ}_result`;

main();

function main() {
  if (!RUN) fail('no --run given and no dataset to default from — pass --run=<out subdir>');
  if (!existsSync(TRAJ)) fail(`no exported run at ${TRAJ} — run run-om2w.mjs first (or check --run)`);
  const tasks = readdirSync(TRAJ, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(TRAJ, d.name, 'result.json')))
    .map((d) => d.name);
  if (!tasks.length) fail(`${TRAJ} has no <task>/result.json trajectories to score`);
  if (!KEY) {
    if (KEY_SHADOW) fail(`${KEY_SHADOW[0]} is set to a PLACEHOLDER ("${KEY_SHADOW[1].slice(0, 12)}…") — it can't authenticate. Set it (or --api-key / OPENAI_API_KEY) to your REAL key, and unset the placeholder so it stops shadowing.`);
    fail('no judge key — set OPENAI_API_KEY / --api-key (an OpenRouter sk-or-… or an HF token both work with --base-url)');
  }
  log(`judge key from ${KEY_CHOSEN[0]}${KEY_SHADOW ? ` (ignored placeholder in ${KEY_SHADOW[0]})` : ''}`);

  const py = ensureScorer();

  const workers = Math.max(1, Math.min(WORKERS, tasks.length));   // never more workers than tasks
  const via = BASE_URL ? ` via ${BASE_URL}` : '';
  log(`scoring ${tasks.length} trajector${tasks.length === 1 ? 'y' : 'ies'} in ${RUN} — ${MODE} (${MODEL}${via}, threshold ${THRESHOLD}, ${workers} worker${workers === 1 ? '' : 's'}) → ${RESULT_DIR}`);
  // stdio inherited so the scorer's OWN authoritative "success rate" line is
  // visible live; the summary below is a per-task convenience on top of it.
  const env = { ...process.env, OPENAI_API_KEY: KEY };
  if (BASE_URL) env.OPENAI_BASE_URL = BASE_URL;   // the openai-python SDK routes here
  const r = spawnSync(py, [
    'src/run.py',
    '--mode', MODE,
    '--model', MODEL,
    '--trajectories_dir', TRAJ,
    '--api_key', KEY,
    '--output_path', RESULT_DIR,
    '--num_worker', String(workers),
    '--score_threshold', String(THRESHOLD),
  ], { cwd: REPO, stdio: 'inherit', env });
  if (r.status !== 0) fail(`scorer exited ${r.status ?? '(signal ' + r.signal + ')'}`);

  summarize(tasks.length);
}

// Clone (pinned) + patch the upstream scorer, then build its venv; return the
// venv python. Idempotent — reuses an existing clone/venv.
function ensureScorer() {
  if (!existsSync(join(REPO, 'src', 'run.py'))) {
    // Sparse + blobless keeps this tiny: the repo commits ~GBs of example
    // screenshots under data/ that the scorer does NOT need to judge OUR
    // trajectories, so we check out only src/ + script/ (+ root files). No
    // --depth, so the pinned sha is checkout-able from local history.
    log(`cloning the upstream scorer (sparse src/+script/, pinned ${PIN.slice(0, 8)}) → ${REPO}`);
    if (run('git', ['clone', '--filter=blob:none', '--sparse', REPO_URL, REPO]).status !== 0) {
      fail(`could not clone ${REPO_URL} — clone it manually into ${REPO} and re-run`);
    }
    run('git', ['-C', REPO, 'sparse-checkout', 'set', 'src', 'script']);
    run('git', ['-C', REPO, 'checkout', '--quiet', PIN]);
    if (!existsSync(join(REPO, 'src', 'run.py'))) fail(`sparse checkout of src/ failed in ${REPO} — remove it and re-run`);
  }
  patchRunPy();
  patchUtilsPy();
  patchBackoffPatience();
  return ensureVenv();
}

// The scorer builds one OpenaiEngine in the parent and passes it as a
// multiprocessing.Process arg. On macOS / Python 3.12+ the default start method
// is 'spawn', which PICKLES process args — and the OpenAI client holds an
// unpicklable _thread.RLock, so scoring crashes before the first task. Upstream
// was written for Linux (fork, no pickling). Fix it the correct, spawn-safe way:
// build the model INSIDE each worker instead of pickling it across. Also guard
// chunk_size (len // workers is 0 when workers > tasks → range step 0 raises).
// Idempotent via the marker; anchors are stable because the clone is PINNED.
function patchRunPy() {
  const p = join(REPO, 'src', 'run.py');
  let src = readFileSync(p, 'utf8');
  if (src.includes('# peerd-patched')) return;
  const edits = [
    ['def process_subset(task_subset, args, final_predicted_labels, lock, model):\n\n    auto_eval(args, task_subset, final_predicted_labels, lock, model)',
      'def process_subset(task_subset, args, final_predicted_labels, lock):\n\n    model = OpenaiEngine(model=args.model, api_key=args.api_key)\n    auto_eval(args, task_subset, final_predicted_labels, lock, model)'],
    ['    #Load model\n    model = OpenaiEngine(\n        model=args.model,\n        api_key=args.api_key\n    )\n',
      '    # peerd-patch: model is built per-worker in process_subset (spawn-safe)\n'],
    ['args=(subset, args, final_predicted_labels, lock, model))',
      'args=(subset, args, final_predicted_labels, lock))'],
    ['chunk_size = len(task_dirs) // num_workers',
      'chunk_size = max(1, len(task_dirs) // num_workers)'],
  ];
  for (const [from, to] of edits) {
    if (!src.includes(from)) fail(`could not patch run.py — anchor missing near "${from.slice(0, 48)}…". Upstream at ${PIN.slice(0, 8)} changed? Remove ${REPO} and re-run.`);
    src = src.replace(from, to);
  }
  writeFileSync(p, `# peerd-patched: per-worker model build (spawn-safe) + chunk_size guard.\n${src}`);
  log('patched run.py (per-worker model build; spawn-safe)');
}

// Reasoning-model safety in OpenaiEngine.generate. The scorer hardcodes
// max_tokens=512 + temperature=0. For an o-series judge (o1/o3/o4-* — including
// o4-mini via OpenRouter, model id "openai/o4-mini"): (a) that 512 budget is
// SHARED with hidden reasoning tokens and routinely exhausts, returning EMPTY
// content that extract_predication scores as FAILURE — silently deflating the
// number; (b) direct OpenAI rejects max_tokens (wants max_completion_tokens) and
// temperature!=1 outright. Fix: for o-series, send max_completion_tokens with a
// high cap and OMIT temperature. Non-reasoning judges (Qwen-VL, GPT-4o, …) are
// untouched, so this is safe on every route. Idempotent via the file marker.
function patchUtilsPy() {
  const p = join(REPO, 'src', 'utils.py');
  let src = readFileSync(p, 'utf8');
  if (src.includes('# peerd-patched')) return;
  const from = '        response = self.client.chat.completions.create(\n'
    + '            model=model if model else self.model,\n'
    + '            messages=messages,\n'
    + '            max_tokens=max_new_tokens,\n'
    + '            temperature=temperature,\n'
    + '            **kwargs,\n'
    + '        )';
  const to = '        # peerd-patch: o-series reasoning judges (o1/o3/o4-*) share the token\n'
    + '        # budget with hidden reasoning + reject max_tokens/temperature — a 512 cap\n'
    + '        # returns empty content scored as failure. Send max_completion_tokens (high)\n'
    + '        # and drop temperature for them; leave other judges unchanged.\n'
    + '        _base = (model or self.model or "").split("/")[-1]\n'
    + '        _reasoning = _base.startswith(("o1", "o3", "o4"))\n'
    + '        _params = dict(model=model if model else self.model, messages=messages, **kwargs)\n'
    + '        if _reasoning:\n'
    + '            _params["max_completion_tokens"] = max(max_new_tokens, 8192)\n'
    + '        else:\n'
    + '            _params["max_tokens"] = max_new_tokens\n'
    + '            _params["temperature"] = temperature\n'
    + '        response = self.client.chat.completions.create(**_params)';
  if (!src.includes(from)) fail(`could not patch utils.py — generate() anchor missing. Upstream at ${PIN.slice(0, 8)} changed? Remove ${REPO} and re-run.`);
  writeFileSync(p, `# peerd-patched: o-series judge uses max_completion_tokens + no temperature.\n${src.replace(from, to)}`);
  log('patched utils.py (o-series judge: max_completion_tokens, no temperature)');
}

// Screenshot-heavy trajectories (a code-arm task averages ~17 shots, each a
// judge_image call) saturate the org's tokens-per-minute limit; upstream's
// backoff gives up after 3 tries in a few seconds and the WORKER DIES, leaving
// a third of the run unscored. TPM windows clear in ≲60s — waiting is always
// correct — so raise the patience: many tries under a hard 10-minute ceiling.
// Separate marker so it also applies to a clone the older patch already touched.
function patchBackoffPatience() {
  const p = join(REPO, 'src', 'utils.py');
  let src = readFileSync(p, 'utf8');
  // v2: also GIVE UP instantly on insufficient_quota — that's the account out
  // of credit, not a rate window; retrying it for 600s is pure spin. (The v1
  // marker gets upgraded in place.)
  if (src.includes('# peerd-patched-backoff-v2')) return;
  if (src.includes('# peerd-patched-backoff')) {
    src = src.replace('# peerd-patched-backoff:', '# peerd-patched-backoff-v2:')
      .replace('        max_tries=12, max_time=600,', "        max_tries=12, max_time=600,\n        giveup=lambda e: 'insufficient_quota' in str(e),");
    writeFileSync(p, src);
    log('patched utils.py (backoff v2: give up instantly on insufficient_quota)');
    return;
  }
  const from = '        max_tries=3,';
  if (!src.includes(from)) fail(`could not patch utils.py backoff — max_tries anchor missing. Upstream at ${PIN.slice(0, 8)} changed? Remove ${REPO} and re-run.`);
  writeFileSync(p, `# peerd-patched-backoff-v2: ride out TPM windows; give up on insufficient_quota.\n${src.replace(from, "        max_tries=12, max_time=600,\n        giveup=lambda e: 'insufficient_quota' in str(e),")}`);
  log('patched utils.py (backoff: TPM waited out, insufficient_quota gives up instantly)');
}

function ensureVenv() {
  const py = join(VENV, 'bin', 'python');
  if (!existsSync(py)) {
    log(`creating scorer venv → ${VENV}`);
    if (run('python3', ['-m', 'venv', VENV]).status !== 0 || !existsSync(py)) fail('python3 -m venv failed — is python3 installed?');
    log('installing scorer deps (backoff, openai, Pillow)');
    if (run(py, ['-m', 'pip', 'install', '-q', '-r', join(REPO, 'requirements.txt')]).status !== 0) fail('pip install of the scorer requirements failed');
  }
  return py;
}

// Best-effort per-task breakdown on top of the scorer's own printed rate. The
// scorer writes newline-delimited JSON; each line is one task's verdict. Field
// names vary by scorer version, so detect the verdict/id defensively and fall
// back to the printed rate if the shape is unrecognized.
function summarize(total) {
  const fname = `${MODE}_${MODEL}_score_threshold_${THRESHOLD}_auto_eval_results.json`;
  const fpath = join(RESULT_DIR, fname);
  if (!existsSync(fpath)) { log(`(scorer printed the success rate above; ${fname} not found for a per-task table)`); return; }

  const rows = [];
  for (const ln of readFileSync(fpath, 'utf8').split('\n')) {
    const s = ln.trim(); if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch { /* skip non-JSON */ }
  }
  const verdictOf = (r) => {
    for (const k of ['predicted_label', 'label', 'success', 'is_success', 'pred', 'score']) {
      if (k in r && r[k] != null) return Number(r[k]) ? 1 : 0;
    }
    return null;
  };
  const idOf = (r) => r.task_id ?? r.id ?? r.task ?? '?';

  let scored = 0; let pass = 0; const fails = [];
  for (const r of rows) {
    const v = verdictOf(r);
    if (v === null) continue;
    scored++; if (v) pass++; else fails.push(idOf(r));
  }
  if (!scored) { log(`(could not read per-task verdicts from ${fname}; trust the scorer's printed rate above)`); return; }

  const pct = ((pass / scored) * 100).toFixed(1);
  log(`\n  success rate: ${pass}/${scored} = ${pct}%${scored < total ? `  (${total - scored} of ${total} trajectories had no verdict line)` : ''}`);
  if (fails.length) {
    log(`  failed (${fails.length}): ${fails.slice(0, 20).join(', ')}${fails.length > 20 ? ` …+${fails.length - 20} more` : ''}`);
  }
  log(`  full per-task judge output: ${fpath}`);
}
