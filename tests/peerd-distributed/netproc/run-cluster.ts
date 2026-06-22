#!/usr/bin/env bun
// tests/peerd-distributed/netproc/run-cluster.ts — the CI driver for the
// multi-PROCESS node test. The README/PHASE1-TESTING §A.2 way of running this
// is by hand: launch relay.ts, then a `for` loop of run-node.ts. That proves
// the node logic across independent OS processes, but it never ran in CI — so
// a refactor that breaks cross-process meshing (session handshake, gossip
// dedup, DHT dial-on-demand) slips past `bun test` (in-memory pipes) and the
// in-browser suite (no dweb live path). This driver makes that tier a gate:
// spawn the relay + N nodes, wait for every node to print its self-test
// RESULTS, and exit non-zero unless ALL pass.
//
// Usage:  bun tests/peerd-distributed/netproc/run-cluster.ts [N] [quorum]
//   N       node count           (default 5)
//   quorum  peers each must reach (default N — full mesh; run-node tests >= quorum-1)
// Exit:   0 if every node PASS, 1 otherwise.
//
// Pure Bun + node:* builtins (no npm), same toolchain as the CDP harness, so
// it drops straight into a CI step next to the in-browser job.

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2] ?? 5);
const QUORUM = Number(process.argv[3] ?? N);

// Wall-clock ceiling: run-node settles for ~10s (handshake + gossip/DHT
// rounds) and waits up to 20s for quorum, so 90s covers a slow CI runner
// spinning up N bun processes without letting a wedged node hang the job.
const OVERALL_BUDGET_MS = 90_000;

const BUN = process.execPath; // the bun that's running this driver

/** Stream a child's output to our stdout, line-prefixed, so a CI log is readable. */
const pipePrefixed = (stream: NodeJS.ReadableStream | null, prefix: string) => {
  if (!stream) return;
  let buf = '';
  stream.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) console.log(`${prefix} ${line}`);
  });
};

const main = async () => {
  // The relay binds an ephemeral port (arg 0) and prints the real one — read
  // it back so concurrent runs (or a leftover relay from a prior run) never
  // collide on a fixed port.
  const relay = spawn(BUN, [join(HERE, 'relay.ts'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const relayUrl = await new Promise<string>((res, rej) => {
    const t = setTimeout(() => rej(new Error('relay did not announce a port within 10s')), 10_000);
    let buf = '';
    relay.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/ws:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(t); res(`ws://localhost:${m[1]}`); }
    });
    relay.on('exit', (code) => { clearTimeout(t); rej(new Error(`relay exited early (code ${code})`)); });
  });
  console.log(`[cluster] relay up at ${relayUrl} — spawning ${N} nodes (quorum ${QUORUM})`);

  // nodeA, nodeB, … — stable, readable labels (run-node uses the label as its
  // gossip/direct/DHT payload, so the self-test reads cleanly in the log).
  const labels = Array.from({ length: N }, (_, i) => `node${String.fromCharCode(65 + i)}`);
  const children: ReturnType<typeof spawn>[] = [];
  const nodes = labels.map((label) => {
    const proc = spawn(BUN, [join(HERE, 'run-node.ts'), relayUrl, label, String(QUORUM)], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(proc);
    // run-node already prefixes its own lines with [label] — just indent.
    pipePrefixed(proc.stdout, '  ');
    pipePrefixed(proc.stderr, '  ');
    return new Promise<{ label: string; code: number }>((res) => {
      proc.on('exit', (code) => res({ label, code: code ?? -1 }));
    });
  });

  const timeout = new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), OVERALL_BUDGET_MS));
  const outcome = await Promise.race([Promise.all(nodes), timeout]);

  try { relay.kill('SIGKILL'); } catch { /* already gone */ }

  if (outcome === 'timeout') {
    // A wedged node won't exit on its own — reap the whole cluster so the driver
    // (and gates.sh, which runs it in-process) doesn't leave orphan bun procs.
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
    console.error(`[cluster] ✗ TIMEOUT — not every node finished within ${OVERALL_BUDGET_MS}ms`);
    process.exit(1);
  }

  // run-node exits 0 on full PASS, 2 on a failed assertion, 1 on quorum miss.
  const failed = outcome.filter((r) => r.code !== 0);
  if (failed.length) {
    console.error(`[cluster] ✗ FAIL — ${failed.length}/${N} node(s) did not pass: ` +
      failed.map((r) => `${r.label}(exit ${r.code})`).join(', '));
    process.exit(1);
  }
  console.log(`[cluster] ✅ PASS — all ${N} nodes meshed and self-tested green`);
  process.exit(0);
};

main().catch((e) => { console.error('[cluster] FATAL', e?.message ?? e); process.exit(1); });
