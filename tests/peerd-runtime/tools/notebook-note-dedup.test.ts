// The NOTEBOOK_NOTE once-per-session dedup (schema-diet 6b): the first notebook
// created in a session gets the full runtime note; a second create the same
// session gets a one-line pointer instead. Exercised through the real create
// path (createNotebookSandbox) with mocked registry + tab tracker.

import { describe, test, expect, beforeEach } from 'bun:test';

// js-create's import graph touches the webextension-polyfill (via
// notebook-client), which throws unless a chrome global is present — stub it,
// then dynamic-import, exactly as the runtime provides it.
(globalThis as any).chrome = { runtime: { id: 'test' } };
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
