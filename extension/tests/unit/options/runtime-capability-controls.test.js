// @ts-check

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { OcrSection } from '/options/sections/ocr.js';
import { LocalModelsSection, LOCAL_MODEL_POLL } from '/options/sections/local-models.js';

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  m.redraw.sync?.();
};
const deferred = () => {
  /** @type {(value: any) => void} */ let resolve = () => {};
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const unsupportedState = () => ({
  capabilities: {
    pdfOcr: { status: 'unsupported' },
    localWebGpuHost: { status: 'unsupported' },
  },
});

describe('options runtime capability controls', () => {
  it('does not offer an OCR download without an OCR host', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let sends = 0;
    m.mount(root, {
      view: () => m(OcrSection, {
        state: unsupportedState(),
        send: async () => { sends += 1; return { ok: true }; },
      }),
    });
    try {
      await settle();
      expect(root.textContent).toContain('PDF OCR is unavailable in this browser');
      expect(Array.from(root.querySelectorAll('button')).some((entry) =>
        entry.textContent?.includes('Download OCR'))).toBe(false);
      expect(sends).toBe(0);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('does not probe or download a local model without a WebGPU host', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let sends = 0;
    const state = unsupportedState();
    m.mount(root, {
      view: () => m(LocalModelsSection, {
        state,
        send: async () => { sends += 1; return { ok: true }; },
      }),
    });
    try {
      await settle();
      expect(root.textContent).toContain('Use Ollama for local inference');
      expect(root.textContent).toContain('Unavailable');
      expect(root.querySelectorAll('button').length).toBe(0);
      expect(sends).toBe(0);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('continues polling a download that started before the section mounted', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const previousPollMs = LOCAL_MODEL_POLL.ms;
    LOCAL_MODEL_POLL.ms = 0;
    let statusCalls = 0;
    let readyNotices = 0;
    m.mount(root, {
      view: () => m(LocalModelsSection, {
        state: { capabilities: { localWebGpuHost: { status: 'available' } } },
        send: async (/** @type {any} */ msg) => {
          if (msg.type !== 'local-model/catalog') return { ok: false };
          statusCalls += 1;
          return statusCalls === 1
            ? { ok: true, models: [{ model: 'gemma-4-e2b', loading: true, supportState: 'supported' }] }
            : { ok: true, models: [{ model: 'gemma-4-e2b', downloaded: true, supportState: 'supported' }] };
        },
        onReady: () => { readyNotices += 1; },
      }),
    });
    try {
      await settle();
      await settle();
      expect(root.textContent).toContain('Installed');
      expect(statusCalls).toBe(2);
      expect(readyNotices).toBe(1);
      m.mount(root, null);
      const callsAtUnmount = statusCalls;
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(statusCalls).toBe(callsAtUnmount);
    } finally {
      LOCAL_MODEL_POLL.ms = previousPollMs;
      m.mount(root, null);
      root.remove();
    }
  });

  it('ignores an older local-model status that resolves after a newer ready status', async () => {
    const oldStatus = deferred();
    const readyStatus = deferred();
    let calls = 0;
    const vnode = /** @type {any} */ ({
      state: {
        entries: null, downloading: {}, verdicts: {}, progress: null, error: null,
        pollTimer: null, removed: false, readyNotified: false, statusGeneration: 0,
      },
      attrs: {
        state: { capabilities: { localWebGpuHost: { status: 'available' } } },
        send: async () => (++calls === 1 ? oldStatus.promise : readyStatus.promise),
      },
    });
    const oldRequest = LocalModelsSection.refreshStatus(vnode);
    const newRequest = LocalModelsSection.refreshStatus(vnode);
    readyStatus.resolve({ ok: true, models: [{ model: 'gemma-4-e2b', downloaded: true }] });
    await newRequest;
    oldStatus.resolve({ ok: true, models: [{ model: 'gemma-4-e2b', downloaded: false }] });
    await oldRequest;
    expect(vnode.state.entries['gemma-4-e2b'].downloaded).toBe(true);
  });

  it('locks a model the vendored runtime cannot load, and never offers its download', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let initCalls = 0;
    m.mount(root, {
      view: () => m(LocalModelsSection, {
        state: { capabilities: { localWebGpuHost: { status: 'available' } } },
        send: async (/** @type {any} */ msg) => {
          if (msg.type === 'local-model/init') { initCalls += 1; return { ok: false, error: 'nope' }; }
          if (msg.type !== 'local-model/catalog') return { ok: false };
          return {
            ok: true,
            models: [
              { model: 'gemma-4-e2b', downloaded: false, supportState: 'supported' },
              { model: 'muse-glimmer-30b', downloaded: false, supportState: 'unsupported', supportReason: 'This device cannot run Muse Glimmer 30B.' },
            ],
          };
        },
      }),
    });
    try {
      await settle();
      await settle();
      const rows = [...root.querySelectorAll('.lm-model')];
      expect(rows.length).toBe(2);
      const row = (/** @type {string} */ name) => {
        const found = rows.find((el) => (el.textContent ?? '').includes(name));
        if (!found) throw new Error(`no card rendered for ${name}`);
        return found;
      };
      const locked = row('Muse Glimmer');
      expect(locked.textContent).toContain('This device cannot run Muse Glimmer 30B.');
      // A model the runtime cannot load offers no buttons at all: testing the
      // GPU for it would be theater, and Download must be unreachable.
      expect(locked.querySelectorAll('button').length).toBe(0);
      // ...while the runnable one still offers its hardware test.
      expect(row('Gemma').querySelectorAll('button').length).toBeGreaterThan(0);
      expect(initCalls).toBe(0);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });
});
