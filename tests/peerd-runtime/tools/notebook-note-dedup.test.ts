// The NOTEBOOK_NOTE once-per-session dedup (schema-diet 6b): the first notebook
// created in a session gets the full runtime note; a second create the same
// session gets a one-line pointer instead. Exercised through the real create
// path (createNotebookSandbox) with mocked registry + tab tracker.

import { describe, test, expect, beforeEach } from 'bun:test';

// The shared test bootstrap provides the browser identity required by the
// js-create import graph. Keep that single identity for the whole Bun worker.
const { createNotebookSandbox } = await import('../../../extension/peerd-runtime/tools/defs/js-create.js');
const { _resetOncePerSession } = await import('../../../extension/peerd-runtime/tools/defs/once-per-session.js');

beforeEach(() => { _resetOncePerSession(); });

const ctxFor = (sessionId: string | null) => ({
  session: sessionId ? { sessionId } : undefined,
  jsRegistry: {
    create: async () => ({ id: 'nb-1', name: 'Notebook' }),
    setDefaultForSession: async () => {},
  },
  jsTabTracker: { ensureTab: async () => {}, getTabId: () => 1 },
}) as any;

describe('NOTEBOOK_NOTE dedup', () => {
  test('first create in a session gets the full note, the second a pointer', async () => {
    const first = await createNotebookSandbox({}, ctxFor('s1'));
    expect(first.ok).toBe(true);
    expect((first as any).content).toContain('<notebook>');

    const second = await createNotebookSandbox({}, ctxFor('s1'));
    expect(second.ok).toBe(true);
    expect((second as any).content).not.toContain('<notebook>');
    expect((second as any).content).toContain('shown earlier this session');
  });

  test('re-arms per session id', async () => {
    await createNotebookSandbox({}, ctxFor('s1'));
    const other = await createNotebookSandbox({}, ctxFor('s2'));
    expect((other as any).content).toContain('<notebook>'); // different session → full note again
  });
});
