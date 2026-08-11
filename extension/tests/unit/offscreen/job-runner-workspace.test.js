// @ts-check
// offscreen job-runner — the DURABLE WORKSPACE mount (design 1a).
//
// A workspace run mounts ['peerd-workspace', sid] as the sealed worker's OPFS
// root and SKIPS the per-job nuke, so files persist across runs (and turns).
// Exercised against a REAL worker + real OPFS, like job-runner.test.js. Pins:
// persistence across two separate jobs, root isolation from ephemeral runs,
// the host-set usedWorkspace flag, the per-write relay cap, and that nuking
// the subtree (what session teardown does) actually empties the workspace.

import { describe, it, expect } from '../../framework.js';
import { runJob, abortJob } from '/offscreen/job-runner.js';
import { opfsHelpers } from '/peerd-engine/index.js';

const noSW = { sendToSW: async () => ({ ok: true }) };
// Unique per test run so a leftover subtree from a crashed earlier run can't
// leak state into these assertions.
const wsid = `ws-test-${Date.now().toString(36)}`;
const nukeWorkspace = () => opfsHelpers(['peerd-workspace', wsid]).nuke();

const deferred = () => {
  /** @type {(value?: unknown) => void} */
  let resolve = () => {};
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

describe('offscreen job-runner — durable workspace (workspaceSessionId)', () => {
  it('the host refuses worker and actor-lane mutation bypasses while reads remain available', async () => {
    let writes = 0;
    let deletes = 0;
    let checks = 0;
    const fake = {
      read: async () => 'existing',
      list: async () => [{ path: '/existing.txt', size: 8 }],
      write: async () => { writes += 1; },
      delete: async () => { deletes += 1; },
      nuke: async () => {},
    };
    const result = await runJob(
      {
        code: [
          "postMessage({ type: 'opfs-request', rid: 'forged-write', op: 'write', args: { path: 'forged.txt', content: 'no' } });",
          'const out = [];',
          "try { await peerd.self.writeFile('blocked.txt', 'no'); } catch (e) { out.push('write:' + e.message); }",
          "try { await peerd.self.deleteFile('existing.txt'); } catch (e) { out.push('delete:' + e.message); }",
          "out.push('read:' + await peerd.self.readFile('existing.txt'));",
          "out.push('list:' + (await peerd.self.listFiles()).length);",
          "return out.join('|');",
        ].join('\n'),
        workspaceSessionId: wsid,
        actors: true,
        ownerSessionId: wsid,
      },
      {
        sendToSW: async (type) => {
          if (type !== 'lifecycle/assert-opfs-writable') return { ok: true };
          checks += 1;
          return {
            ok: false,
            error: "store 'opfs-workspaces' is read-only. No data was changed.",
          };
        },
        opfsForRoot: /** @type {any} */ (() => fake),
      },
    );
    expect(result.error).toBe(null);
    expect(String(result.value)).toContain("write:store 'opfs-workspaces' is read-only");
    expect(String(result.value)).toContain("delete:store 'opfs-workspaces' is read-only");
    expect(String(result.value)).toContain('read:existing');
    expect(String(result.value)).toContain('list:1');
    expect(checks).toBe(3);
    expect(writes).toBe(0);
    expect(deletes).toBe(0);
  });

  it('ephemeral scratch stays writable without consulting durable workspace posture', async () => {
    let writes = 0;
    let checks = 0;
    const fake = {
      read: async () => '', list: async () => [], delete: async () => {},
      write: async () => { writes += 1; }, nuke: async () => {},
    };
    const result = await runJob(
      { code: "await peerd.self.writeFile('scratch.txt', 'ok'); return 'done';" },
      {
        sendToSW: async (type) => {
          if (type === 'lifecycle/assert-opfs-writable') checks += 1;
          return { ok: false, error: 'blocked' };
        },
        opfsForRoot: /** @type {any} */ (() => fake),
      },
    );
    expect(result.error).toBe(null);
    expect(result.value).toBe('done');
    expect(writes).toBe(1);
    expect(checks).toBe(0);
  });

  it('a second workspace run sees the first run\'s file (mount + skip-nuke)', async () => {
    await nukeWorkspace();
    const w1 = await runJob(
      { code: 'await peerd.self.writeFile("data/seed.txt", "kept"); return "wrote";', workspaceSessionId: wsid },
      noSW,
    );
    expect(w1.error).toBe(null);
    expect(w1.usedWorkspace).toBe(true);   // host-set, not inferred from ops
    const w2 = await runJob(
      { code: 'return await peerd.self.readFile("data/seed.txt");', workspaceSessionId: wsid },
      noSW,
    );
    expect(w2.error).toBe(null);
    expect(w2.value).toBe('kept');
    expect(w2.usedWorkspace).toBe(true);
  });

  it('an ephemeral run is rooted elsewhere — it cannot see workspace files, and stays unflagged', async () => {
    const r = await runJob(
      { code: 'try { return await peerd.self.readFile("data/seed.txt"); } catch (e) { return "isolated"; }' },
      noSW,
    );
    expect(r.error).toBe(null);
    expect(r.value).toBe('isolated');
    expect(r.usedWorkspace).toBeFalsy();
  });

  it('the relay refuses a workspace write over the per-file ceiling (the js_write_file cap)', async () => {
    const r = await runJob(
      {
        code: 'try { await peerd.self.writeFile("big.txt", "x".repeat(500001)); return "reached"; } catch (e) { return "refused:" + e.message; }',
        workspaceSessionId: wsid,
      },
      noSW,
    );
    expect(r.error).toBe(null);
    expect(String(r.value)).toContain('refused:');
    expect(String(r.value)).toContain('write too large');
  });

  it('the write cap is shape-allowlisted — binary payloads are measured, unknown shapes refused', async () => {
    // Blob + ArrayBuffer under the cap pass; an oversized TypedArray is sized
    // by byteLength; a WriteParams-style object ({type:'write',data}) would
    // size to 0 under a fall-through — it must be REFUSED, not waved past.
    const r = await runJob(
      {
        code: [
          'const out = [];',
          'await peerd.self.writeFile("b.bin", new Blob(["ok"])); out.push("blob-ok");',
          'await peerd.self.writeFile("a.bin", new Uint8Array(8).buffer); out.push("buf-ok");',
          'try { await peerd.self.writeFile("big.bin", new Uint8Array(500001)); out.push("typed-passed"); } catch (e) { out.push("typed:" + e.message); }',
          'try { await peerd.self.writeFile("sneak.txt", { type: "write", data: "x".repeat(600000) }); out.push("params-passed"); } catch (e) { out.push("params:" + e.message); }',
          'return out.join("|");',
        ].join('\n'),
        workspaceSessionId: wsid,
      },
      noSW,
    );
    expect(r.error).toBe(null);
    const v = String(r.value);
    expect(v).toContain('blob-ok');
    expect(v).toContain('buf-ok');
    expect(v).toContain('typed:');
    expect(v).toContain('write too large');
    expect(v).toContain('params:');
    expect(v).toContain('unsupported write payload');
  });

  it('peerd.self.deleteFile removes a workspace file', async () => {
    const r = await runJob(
      {
        code: [
          'await peerd.self.writeFile("tmp/gone.txt", "bye");',
          'await peerd.self.deleteFile("tmp/gone.txt");',
          'try { await peerd.self.readFile("tmp/gone.txt"); return "still-there"; } catch (e) { return "deleted"; }',
        ].join('\n'),
        workspaceSessionId: wsid,
      },
      noSW,
    );
    expect(r.error).toBe(null);
    expect(r.value).toBe('deleted');
  });

  it('over budget: writes are refused but delete still works — and the NEXT run passes again', async () => {
    await nukeWorkspace();      // deterministic budget math — no residue from earlier cases
    const seed = await runJob(
      { code: 'await peerd.self.writeFile("fat.txt", "x".repeat(64)); return "seeded";', workspaceSessionId: wsid },
      noSW,
    );
    expect(seed.error).toBe(null);
    // A 32-byte budget puts the 64-byte workspace over on mount
    // (workspaceBudgetBytes is the direct-caller test seam — offscreen.js
    // never forwards it).
    const over = await runJob(
      {
        code: [
          'const out = [];',
          'try { await peerd.self.writeFile("more.txt", "y"); out.push("write-passed"); } catch (e) { out.push("write:" + e.message); }',
          'await peerd.self.deleteFile("fat.txt"); out.push("deleted");',
          'return out.join("|");',
        ].join('\n'),
        workspaceSessionId: wsid, workspaceBudgetBytes: 32,
      },
      noSW,
    );
    expect(over.error).toBe(null);
    expect(over.workspaceOverBudget).toBe(true);
    expect(String(over.value)).toContain('write:');
    expect(String(over.value)).toContain('over budget');
    expect(String(over.value)).toContain('deleted');
    // The budget is recomputed each mount: after the delete the workspace is
    // back under it, so the same budget now admits writes again.
    const after = await runJob(
      { code: 'await peerd.self.writeFile("ok.txt", "z"); return "recovered";', workspaceSessionId: wsid, workspaceBudgetBytes: 32 },
      noSW,
    );
    expect(after.error).toBe(null);
    expect(after.workspaceOverBudget).toBe(false);
    expect(after.value).toBe('recovered');
  });

  it('nuking the subtree (session teardown) empties the workspace for the next run', async () => {
    await nukeWorkspace();
    const r = await runJob(
      { code: 'try { return await peerd.self.readFile("data/seed.txt"); } catch (e) { return "gone"; }', workspaceSessionId: wsid },
      noSW,
    );
    expect(r.error).toBe(null);
    expect(r.value).toBe('gone');
    // leave no residue behind the test run
    await nukeWorkspace();
  });

  it('Stop aborts and drains a pending WORKSPACE write before the run returns', async () => {
    const started = deferred();
    const maySettle = deferred();
    let signalSeen = false;
    let writeSettled = false;
    const fake = {
      list: async () => [],
      write: async (/** @type {string} */ _path, /** @type {unknown} */ _content, /** @type {{ signal: AbortSignal }} */ { signal }) => {
        signalSeen = signal instanceof AbortSignal;
        started.resolve();
        await maySettle.promise;
        writeSettled = true;
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      },
      read: async () => '', delete: async () => {}, nuke: async () => {},
    };
    const runId = `workspace-stop-${Date.now().toString(36)}`;
    const pending = runJob(
      {
        code: 'await peerd.self.writeFile("late.txt", "must-not-commit"); return "bad";',
        workspaceSessionId: wsid, runId, ownerSessionId: wsid, timeoutMs: 5000,
      },
      { ...noSW, opfsForRoot: /** @type {any} */ (() => fake) },
    );
    await started.promise;
    abortJob(runId, wsid);
    await Promise.resolve();
    expect(signalSeen).toBe(true);
    expect(writeSettled).toBe(false);
    maySettle.resolve();
    const result = await pending;
    expect(writeSettled).toBe(true);
    expect(String(result.error)).toContain('job aborted');
  });

  it('ephemeral cleanup waits for an aborted host write before nuking scratch', async () => {
    const started = deferred();
    const maySettle = deferred();
    /** @type {string[]} */
    const order = [];
    const fake = {
      write: async (/** @type {string} */ _path, /** @type {unknown} */ _content, /** @type {{ signal: AbortSignal }} */ { signal }) => {
        started.resolve();
        await maySettle.promise;
        order.push('write-settled');
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      },
      read: async () => '', list: async () => [], delete: async () => {},
      nuke: async () => { order.push('nuke'); },
    };
    const runId = `ephemeral-stop-${Date.now().toString(36)}`;
    const pending = runJob(
      {
        code: 'await peerd.self.writeFile("late.txt", "must-not-survive"); return "bad";',
        runId, ownerSessionId: 'chat-ephemeral', timeoutMs: 5000,
      },
      { ...noSW, opfsForRoot: /** @type {any} */ (() => fake) },
    );
    await started.promise;
    abortJob(runId, 'chat-ephemeral');
    await Promise.resolve();
    expect(order.length).toBe(0);
    maySettle.resolve();
    await pending;
    expect(order).toEqual(['write-settled', 'nuke']);
  });

  it('Stop during delete path resolution reaches the host commit check', async () => {
    const started = deferred();
    const mayCommit = deferred();
    let removed = false;
    let sawAbortedCommit = false;
    const fake = {
      list: async () => [], write: async () => {}, read: async () => '', nuke: async () => {},
      delete: async (/** @type {string} */ _path, /** @type {{ signal: AbortSignal }} */ { signal }) => {
        started.resolve();
        await mayCommit.promise;
        if (signal.aborted) {
          sawAbortedCommit = true;
          throw new DOMException('aborted', 'AbortError');
        }
        removed = true;
      },
    };
    const runId = `delete-stop-${Date.now().toString(36)}`;
    const pending = runJob(
      {
        code: 'await peerd.self.deleteFile("keep.txt"); return "bad";',
        workspaceSessionId: wsid, runId, ownerSessionId: wsid, timeoutMs: 5000,
      },
      { ...noSW, opfsForRoot: /** @type {any} */ (() => fake) },
    );
    await started.promise;
    abortJob(runId, wsid);
    mayCommit.resolve();
    await pending;
    expect(sawAbortedCommit).toBe(true);
    expect(removed).toBe(false);
  });
});
