// @ts-check

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { OcrSection } from '/options/sections/ocr.js';
import { LocalModelsSection } from '/options/sections/local-models.js';

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  m.redraw.sync?.();
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
});
