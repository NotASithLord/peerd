import { describe, expect, test } from 'bun:test';
import {
  podJobState,
  podJobStatusMessage,
  createPodJobOperationTracker,
} from '../../../extension/engine-tabs/pod-tab/job-state.js';

describe('Pod job outcome UX', () => {
  test('keeps intentional cancellation distinct from command failure', () => {
    expect(podJobState({ cancelled: true, exitCode: 130 })).toBe('cancelled');
    expect(podJobState({ exitCode: 0 })).toBe('completed');
    expect(podJobState({ exitCode: 124 })).toBe('failed');
  });

  test('announces only a concise outcome, never raw terminal output', () => {
    const message = podJobStatusMessage({
      id: 'job-1', state: 'failed', exitCode: 2,
      stdout: 'large raw stdout that should not be spoken', stderr: 'failure details',
    });
    expect(message).toBe('Pod job job-1 failed with exit 2. Output is available in the terminal.');
    expect(message).not.toContain('large raw stdout');
    expect(podJobStatusMessage({
      id: 'job-2', state: 'cancelled', exitCode: 130, stdout: '', stderr: '',
    })).toBe('Pod job job-2 cancelled.');
  });

  test('raw terminal transcript is browsable but not a live region', async () => {
    const html = await Bun.file('./extension/engine-tabs/pod-tab/index.html').text();
    const output = html.match(/<div id="terminal-output"[^>]*>/)?.[0] ?? '';
    expect(output).toContain('role="region"');
    expect(output).not.toContain('aria-live');
    expect(output).not.toContain('role="log"');
    expect(html).toContain('id="pod-job-status"');
    expect(html).toContain('aria-atomic="true"');
  });

  test('cancellation waits for an admitted mutation and refuses queued work', async () => {
    const tracker = createPodJobOperationTracker();
    let finishWrite!: () => void;
    let mutationFinished = false;
    const admitted = tracker.track(async () => {
      await new Promise<void>((resolve) => { finishWrite = resolve; });
      mutationFinished = true;
    });
    let drained = false;
    const drain = tracker.closeAndDrain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(() => tracker.track(async () => {})).toThrow();
    finishWrite();
    await admitted;
    await drain;
    expect(mutationFinished).toBe(true);
    expect(drained).toBe(true);
  });
});
