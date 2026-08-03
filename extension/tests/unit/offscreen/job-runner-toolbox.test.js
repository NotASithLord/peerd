// @ts-check
// design js-superpower/06 — toolbox resolution in the REAL headless substrate.
// Exercised against a real sealed worker; `sendToSW` stands in for the SW's
// toolbox/read + toolbox/record routes. Pins the load-bearing lane behavior:
// a script-lane job (toolbox:true) writes → imports → runs a stored module and
// reports rot bookkeeping; every other lane (page_code caps profile, a2a,
// site-client) is refused resolution EVEN IF the flag is forged onto the job.

import { describe, it, expect } from '../../framework.js';
import { runJob } from '/offscreen/job-runner.js';

const TABLES_BODY = 'export const double = (n) => n * 2;';

/** @param {Record<string, string>} modules @param {{ type: string, payload: any }[]} calls */
const stubSW = (modules, calls) => async (/** @type {string} */ type, /** @type {any} */ payload) => {
  calls.push({ type, payload });
  if (type === 'toolbox/read') {
    const body = modules[payload?.name];
    if (body === undefined) return { ok: false, error: `unknown toolbox module '${payload?.name}'` };
    return { ok: true, body };
  }
  return { ok: true };
};

describe('offscreen job-runner — toolbox lane (design 06)', () => {
  it('a script-lane job imports a toolbox module and records ok:true for it', async () => {
    /** @type {{ type: string, payload: any }[]} */
    const calls = [];
    const r = await runJob(
      {
        code: "import { double } from 'peerd:toolbox/tables';\nreturn double(21);",
        toolbox: true,
      },
      { sendToSW: stubSW({ tables: TABLES_BODY }, calls) },
    );
    expect(r.error).toBe(null);
    expect(r.value).toBe(42);
    expect(calls.some((c) => c.type === 'toolbox/read' && c.payload.name === 'tables')).toBe(true);
    const rec = calls.find((c) => c.type === 'toolbox/record');
    expect(rec?.payload.ok).toBe(true);
    expect(rec?.payload.names).toEqual(['tables']);
  });

  it('a failing run records ok:false against the modules it imported (rot signal)', async () => {
    /** @type {{ type: string, payload: any }[]} */
    const calls = [];
    const r = await runJob(
      {
        code: "import { double } from 'peerd:toolbox/tables';\nthrow new Error('boom ' + double(1));",
        toolbox: true,
      },
      { sendToSW: stubSW({ tables: TABLES_BODY }, calls) },
    );
    expect(String(r.error)).toContain('boom');
    const rec = calls.find((c) => c.type === 'toolbox/record');
    expect(rec?.payload.ok).toBe(false);
    expect(rec?.payload.names).toEqual(['tables']);
  });

  it('a page_code-profiled job (no toolbox flag) is refused resolution — toolbox/read never fires', async () => {
    /** @type {{ type: string, payload: any }[]} */
    const calls = [];
    const r = await runJob(
      {
        code: "import { double } from 'peerd:toolbox/tables';\nreturn double(1);",
        caps: { page: true, egress: false, subagent: false, opfs: false },
        ownerSessionId: 'web-actor-1',
      },
      { sendToSW: stubSW({ tables: TABLES_BODY }, calls) },
    );
    expect(String(r.error)).toContain('toolbox modules are not available in this run');
    expect(calls.some((c) => c.type === 'toolbox/read')).toBe(false);
  });

  it('an a2a run is refused resolution EVEN WITH a forged toolbox flag', async () => {
    /** @type {{ type: string, payload: any }[]} */
    const calls = [];
    const r = await runJob(
      {
        code: "import { double } from 'peerd:toolbox/tables';\nreturn double(1);",
        toolbox: true, a2a: true, ownerSessionId: 'dweb',
      },
      { sendToSW: stubSW({ tables: TABLES_BODY }, calls) },
    );
    expect(String(r.error)).toContain('toolbox modules are not available in this run');
    expect(calls.some((c) => c.type === 'toolbox/read')).toBe(false);
  });

  it('a site-client run is refused resolution EVEN WITH a forged toolbox flag', async () => {
    /** @type {{ type: string, payload: any }[]} */
    const calls = [];
    const r = await runJob(
      {
        code: "import { double } from 'peerd:toolbox/tables';\nreturn double(1);",
        toolbox: true, siteFetch: 'https://api.example.com', ownerSessionId: 'web-actor-1',
      },
      { sendToSW: stubSW({ tables: TABLES_BODY }, calls) },
    );
    expect(String(r.error)).toContain('toolbox modules are not available in this run');
    expect(calls.some((c) => c.type === 'toolbox/read')).toBe(false);
  });

  it('a deleted (unknown) module fails resolution with the SW route error', async () => {
    /** @type {{ type: string, payload: any }[]} */
    const calls = [];
    const r = await runJob(
      {
        code: "import { x } from 'peerd:toolbox/ghost';\nreturn x;",
        toolbox: true,
      },
      { sendToSW: stubSW({}, calls) },
    );
    expect(String(r.error)).toContain('ghost');
    // nothing resolved → nothing to record
    expect(calls.some((c) => c.type === 'toolbox/record')).toBe(false);
  });

  it('a toolbox module can import peerd:std (nested builtin resolution)', async () => {
    /** @type {{ type: string, payload: any }[]} */
    const calls = [];
    const r = await runJob(
      {
        code: "import { avg } from 'peerd:toolbox/stats';\nreturn avg([2, 4, 6]);",
        toolbox: true,
      },
      { sendToSW: stubSW({ stats: "import { mean } from 'peerd:std';\nexport const avg = (xs) => mean(xs);" }, calls) },
    );
    expect(r.error).toBe(null);
    expect(r.value).toBe(4);
  });
});
