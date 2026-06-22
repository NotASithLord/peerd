// @ts-check
// offscreen job-runner — the headless sealed-Worker substrate behind js_run.
// Exercised against a REAL worker; `sendToSW` is stubbed to stand in for the
// SW's audited routes (sw/web-fetch, subagent/spawn). Pins the load-bearing
// behavior: code returns its value, console accumulates, peerd.egress.fetch
// relays through the SAME route the tab uses (with method/body), and errors
// surface.

import { describe, it, expect } from '../../framework.js';
import { runJob } from '/offscreen/job-runner.js';

describe('offscreen job-runner (real sealed worker)', () => {
  it('runs code headless and returns its value + console output', async () => {
    const calls = [];
    const r = await runJob(
      { code: 'console.log("hi"); return 6 * 7;' },
      { sendToSW: async (type, payload) => { calls.push({ type, payload }); return { ok: true }; } },
    );
    expect(r.error).toBe(null);
    expect(r.value).toBe(42);
    expect(r.consoleOutput.some((c) => c.text === 'hi')).toBe(true);
    expect(calls.length).toBe(0);  // pure compute → no fetch/subagent relays
  });

  it('relays peerd.egress.fetch through the SAME audited route (sw/web-fetch), with method/body', async () => {
    /** @type {{ url?: string, method?: string, body?: string } | null} */
    let seen = null;
    const r = await runJob(
      { code: 'const res = await peerd.egress.fetch("https://api.example/x", { method: "POST", body: "b" }); return await res.text();' },
      {
        sendToSW: async (type, payload) => {
          if (type === 'sw/web-fetch') { seen = payload; return { ok: true, status: 200, bodyB64: btoa('pong') }; }
          return { ok: false };
        },
      },
    );
    const sawFetch = /** @type {{ url?: string, method?: string, body?: string } | null} */ (seen);
    expect(sawFetch?.url).toBe('https://api.example/x');
    expect(sawFetch?.method).toBe('POST');
    expect(sawFetch?.body).toBe('b');
    expect(r.value).toBe('pong');
    expect(r.error).toBe(null);
  });

  it('surfaces a thrown error (and resolves, does not hang)', async () => {
    const r = await runJob(
      { code: 'throw new Error("boom");' },
      { sendToSW: async () => ({ ok: true }) },
    );
    expect(r.value).toBe(undefined);
    expect(String(r.error)).toContain('boom');
  });

  it('peerd:std imports resolve in a headless job', async () => {
    const r = await runJob(
      { code: 'const { mean } = await import("peerd:std"); return mean([2, 4, 6]);' },
      { sendToSW: async () => ({ ok: true }) },
    );
    expect(r.error).toBe(null);
    expect(r.value).toBe(4);
  });

  // The idiomatic form the agent writes for headless math: a STATIC top-level
  // `import { … } from 'peerd:std'` (resolved via buildEntry's builtins, same as
  // a Notebook). Pins math PARITY between js_run and js_notebook — the headless
  // worker must reach the same stdlib helpers the visible Notebook does.
  it('peerd:std STATIC imports resolve in a headless job (math parity with notebooks)', async () => {
    const r = await runJob(
      { code: 'import { mean, median, sum } from "peerd:std";\nreturn { m: mean([2, 4, 6]), md: median([5, 1, 9, 3]), s: sum([10, 20, 30]) };' },
      { sendToSW: async () => ({ ok: true }) },
    );
    expect(r.error).toBe(null);
    const v = /** @type {{ m: number, md: number, s: number }} */ (r.value);
    expect(v.m).toBe(4);
    expect(v.md).toBe(4);
    expect(v.s).toBe(60);
  });
});
