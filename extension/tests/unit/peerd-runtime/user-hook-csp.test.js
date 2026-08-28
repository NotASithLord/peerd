// @ts-check

import { describe, it, expect } from '../../framework.js';

describe('user-hook CSP', () => {
  it('rejects legacy executable hooks in a real extension Worker', async () => {
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(
        '/tests/unit/peerd-runtime/fixtures/user-hook-csp-worker.js',
        { type: 'module' },
      );
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error('user-hook CSP Worker timed out'));
      }, 10_000);
      worker.addEventListener('message', (event) => {
        clearTimeout(timer);
        worker.terminate();
        resolve(event.data);
      }, { once: true });
      worker.addEventListener('error', (event) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(event.message || 'user-hook CSP Worker failed to load'));
      }, { once: true });
    });

    expect(result.ok).toBe(false);
    expect(result.name).toBe('TypeError');
    expect(result.message).toContain('executable JS hooks are not supported');
  });
});
