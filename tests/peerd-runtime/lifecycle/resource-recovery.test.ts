// Engine-resource recovery (§9) — the four per-resource decision cores: what
// a fresh generation may adopt from a surviving tab, how a notebook cell is
// labelled, what a recreated WebVM must verify, and what an App rebuild
// refuses to restore.

import { describe, test, expect } from 'bun:test';
import {
  revalidateDrivenTab, notebookCellState, vmRecoveryPlan, appSandboxRebuild,
  NOTEBOOK_CELL_STATES,
} from '../../../extension/peerd-runtime/lifecycle/resource-recovery.js';
import { mintGeneration } from '../../../extension/peerd-runtime/lifecycle/generation.js';
import { OPERATION_STATES } from '../../../extension/peerd-runtime/lifecycle/operation-state.js';

const generation = mintGeneration({ seq: 3, id: 'gen-3-old', mintedAt: 0 },
  { nonce: 'fresh-nonce', now: 1_000 });

const ownership = (overrides: Record<string, unknown> = {}) => ({
  tabId: 42,
  sessionId: 'sess-1',
  generationId: generation.id,
  ...overrides,
});

describe('§9.4 revalidateDrivenTab — refusal paths', () => {
  test('a vanished tab releases the ownership', () => {
    const v = revalidateDrivenTab({
      ownership: ownership(), liveTab: null, generation,
    });
    expect(v).toMatchObject({ adopt: false, disposition: 'release' });
    expect(v.reason).toContain('gone or identity changed');
  });

  test('a tab id that no longer matches releases (ids are reused after a close)', () => {
    const v = revalidateDrivenTab({
      ownership: ownership(),
      liveTab: { id: 43, url: 'https://example.com/x' },
      generation,
    });
    expect(v.disposition).toBe('release');
  });

  test('a missing ownership record releases rather than adopting an unowned tab', () => {
    const v = revalidateDrivenTab({
      ownership: undefined as any,
      liveTab: { id: 42, url: 'https://example.com/' },
      generation,
    });
    expect(v).toMatchObject({ adopt: false, disposition: 'release' });
  });

  test('an unparseable live URL releases — an unnameable page cannot be policy-checked', () => {
    for (const url of ['', 'not a url', 'about:blank', undefined as any]) {
      const v = revalidateDrivenTab({
        ownership: ownership(), liveTab: { id: 42, url }, generation,
      });
      expect(v.disposition).toBe('release');
    }
  });

  test('a bound actor whose page navigated off its origin releases', () => {
    const v = revalidateDrivenTab({
      ownership: ownership({ boundOrigin: 'https://github.com' }),
      liveTab: { id: 42, url: 'https://evil.example/pwn' },
      generation,
    });
    expect(v.adopt).toBe(false);
    expect(v.reason).toContain('navigated away');
  });

  test('an unparseable boundOrigin fails closed to release', () => {
    const v = revalidateDrivenTab({
      ownership: ownership({ boundOrigin: 'garbage' }),
      liveTab: { id: 42, url: 'https://github.com/x' },
      generation,
    });
    expect(v.disposition).toBe('release');
  });

  test('a bound actor still on its own origin adopts (port/case normalized)', () => {
    const v = revalidateDrivenTab({
      ownership: ownership({ boundOrigin: 'HTTPS://GitHub.com:443' }),
      liveTab: { id: 42, url: 'https://github.com/peerd/pulls' },
      generation,
    });
    expect(v).toMatchObject({ adopt: true, disposition: 'adopt' });
  });

  test('a sensitive live origin refuses the ACTOR, not the tab', () => {
    const v = revalidateDrivenTab({
      ownership: ownership(),
      liveTab: { id: 42, url: 'https://mail.example.com/inbox' },
      generation,
      isSensitiveOrigin: (origin) => origin === 'https://mail.example.com',
    });
    expect(v).toMatchObject({ adopt: false, disposition: 'refuse-actor' });
    expect(v.reason).toContain('sensitive origin');
  });

  test('sensitivity outranks the grant: a re-derived grant cannot buy a signed-in page', () => {
    const v = revalidateDrivenTab({
      ownership: ownership({ generationId: 'gen-3-old' }),
      liveTab: { id: 42, url: 'https://mail.example.com/inbox' },
      generation,
      isSensitiveOrigin: () => true,
      allowedByGrant: true,
    });
    expect(v.disposition).toBe('refuse-actor');
  });
});

describe('§9.4 revalidateDrivenTab — generation and the grant', () => {
  test('current-generation ownership adopts with no grant argument at all', () => {
    const v = revalidateDrivenTab({
      ownership: ownership(),
      liveTab: { id: 42, url: 'https://example.com/x' },
      generation,
    });
    expect(v).toMatchObject({ adopt: true, disposition: 'adopt' });
  });

  test('prior-generation ownership re-adopts ONLY with a re-derived grant', () => {
    const v = revalidateDrivenTab({
      ownership: ownership({ generationId: 'gen-3-old' }),
      liveTab: { id: 42, url: 'https://example.com/x' },
      generation,
      allowedByGrant: true,
    });
    expect(v).toMatchObject({ adopt: true, disposition: 'adopt' });
    expect(v.reason).toContain('re-derived grant');
  });

  test('fail closed: absent, false, and truthy-but-not-true all release', () => {
    for (const allowedByGrant of [undefined, false, 'yes' as any, 1 as any]) {
      const v = revalidateDrivenTab({
        ownership: ownership({ generationId: 'gen-3-old' }),
        liveTab: { id: 42, url: 'https://example.com/x' },
        generation,
        allowedByGrant,
      });
      expect(v.adopt).toBe(false);
      expect(v.disposition).toBe('release');
    }
  });

  test('an ownership record with NO generation stamp is a prior generation', () => {
    const unstamped = revalidateDrivenTab({
      ownership: ownership({ generationId: undefined }),
      liveTab: { id: 42, url: 'https://example.com/x' },
      generation,
    });
    expect(unstamped.disposition).toBe('release');
    expect(revalidateDrivenTab({
      ownership: ownership({ generationId: undefined }),
      liveTab: { id: 42, url: 'https://example.com/x' },
      generation,
      allowedByGrant: true,
    }).adopt).toBe(true);
  });

  test('no usable current generation releases even with a grant', () => {
    const v = revalidateDrivenTab({
      ownership: ownership(),
      liveTab: { id: 42, url: 'https://example.com/x' },
      generation: undefined as any,
    });
    expect(v.disposition).toBe('release');
  });
});

describe('§9.2 notebookCellState', () => {
  test('all four labels', () => {
    expect(notebookCellState({ cell: { source: 'x = 1' }, currentGeneration: 4 }))
      .toBe(NOTEBOOK_CELL_STATES.PERSISTED_SOURCE);
    expect(notebookCellState({
      cell: { source: 'x', output: '1', completedGeneration: 4 }, currentGeneration: 4,
    })).toBe(NOTEBOOK_CELL_STATES.COMPLETED_RESULT);
    expect(notebookCellState({ cell: { source: 'x', running: true }, currentGeneration: 4 }))
      .toBe(NOTEBOOK_CELL_STATES.INTERRUPTED);
    expect(notebookCellState({
      cell: { source: 'x', output: '1', completedGeneration: 3 }, currentGeneration: 4,
    })).toBe(NOTEBOOK_CELL_STATES.STALE_OUTPUT);
  });

  test('running outranks a stored output — the heap died mid-run', () => {
    expect(notebookCellState({
      cell: { running: true, output: 'old', completedGeneration: 4 },
      currentGeneration: 4,
    })).toBe('interrupted');
  });

  test('an output with a missing generation is stale, never completed', () => {
    expect(notebookCellState({ cell: { output: '1' }, currentGeneration: 4 }))
      .toBe('stale-output');
    expect(notebookCellState({
      cell: { output: '1', completedGeneration: '4' as any }, currentGeneration: 4,
    })).toBe('stale-output');
    expect(notebookCellState({
      cell: { output: '1', completedGeneration: 4 }, currentGeneration: NaN,
    })).toBe('stale-output');
  });

  test('an empty-string output is a real result, not unrun source', () => {
    expect(notebookCellState({
      cell: { output: '', completedGeneration: 2 }, currentGeneration: 2,
    })).toBe('completed-result');
    expect(notebookCellState({ cell: { output: null }, currentGeneration: 2 }))
      .toBe('persisted-source');
  });

  test('garbage falls to persisted-source — the only claim needing no evidence', () => {
    for (const input of [{}, { cell: null }, { cell: 'nope' }, null, undefined] as any[]) {
      expect(notebookCellState(input)).toBe('persisted-source');
    }
  });
});

describe('§9.1 vmRecoveryPlan', () => {
  const plan = vmRecoveryPlan({
    vmRecord: { instanceId: 'vm-1', filesystemPersisted: true },
    interruptedCommands: [
      { commandId: 'c-read', retryClass: 'A' },
      { commandId: 'c-opaque', dispatched: true },           // unclassified
      { commandId: 'c-cancelled', retryClass: 'A', dispatched: true, cancelRequested: true },
    ],
  });

  test('a persisted filesystem is VERIFIED, not trusted — it may be partly committed', () => {
    expect(plan.verifyFilesystem).toBe(true);
    expect(vmRecoveryPlan({ vmRecord: { instanceId: 'vm-2' } }).verifyFilesystem).toBe(false);
  });

  test('process state, imports and credentials always land the same way', () => {
    for (const p of [plan, vmRecoveryPlan({}), vmRecoveryPlan(undefined as any)]) {
      expect(p.processStateLost).toBe(true);
      expect(p.revalidateImports).toBe(true);
      expect(p.credentialsResident).toBe(false);
    }
  });

  test('a Class A command lands interrupted and may auto-retry', () => {
    const [readCommand] = plan.commands;
    expect(readCommand.commandId).toBe('c-read');
    expect(readCommand.verdict.state).toBe(OPERATION_STATES.INTERRUPTED);
    expect(readCommand.verdict.autoRetry).toBe(true);
  });

  test('an unclassified dispatched command fails closed to outcome_unknown', () => {
    const opaque = plan.commands[1];
    expect(opaque.verdict.state).toBe(OPERATION_STATES.OUTCOME_UNKNOWN);
    expect(opaque.verdict.autoRetry).toBe(false);
    expect(opaque.verdict.verificationRequired).toBe(true);
  });

  test('an explicit cancel dominates recovery', () => {
    expect(plan.commands[2].verdict.state).toBe(OPERATION_STATES.CANCELLED);
    expect(plan.commands[2].verdict.autoRetry).toBe(false);
  });

  test('garbage commands are skipped, not crashed on', () => {
    const p = vmRecoveryPlan({
      vmRecord: { instanceId: 'vm-3' },
      interruptedCommands: [null, {}, { commandId: 7 }, { commandId: 'ok' }] as any,
    });
    expect(p.commands.map((c) => c.commandId)).toEqual(['ok']);
  });
});

describe('§9.3 appSandboxRebuild', () => {
  test('restores the app\'s own files and nothing else', () => {
    const rebuild = appSandboxRebuild({
      appRecord: {
        appId: 'app-7',
        files: [
          'index.html',
          'peerd-apps/app-7/main.js',
          'peerd-apps/app-9/secrets.js',   // another app's namespace
          '../../etc/passwd',              // traversal
          '/absolute/path.js',
          '',
          42,
        ] as any,
      },
      tier: 'network-full',
    });
    expect(rebuild.restoredFiles).toEqual(['index.html', 'peerd-apps/app-7/main.js']);
  });

  test('an unnamed app or garbage record restores nothing', () => {
    expect(appSandboxRebuild({ appRecord: { files: ['a.js'] } }).restoredFiles).toEqual([]);
    expect(appSandboxRebuild({} as any).restoredFiles).toEqual([]);
    expect(appSandboxRebuild(undefined as any).restoredFiles).toEqual([]);
  });

  test('the network tier is RE-DERIVED — a recorded tier never carries over', () => {
    expect(appSandboxRebuild({
      appRecord: { appId: 'app-7' }, tier: 'network-full',
    }).networkTier).toBe('re-derive');
  });

  test('popups, downloads and in-flight actions are never restored or replayed', () => {
    const rebuild = appSandboxRebuild({ appRecord: { appId: 'app-7', files: [] } });
    expect(rebuild.popups).toBe('not-restored');
    expect(rebuild.downloads).toBe('not-restored');
    expect(rebuild.inFlightActions).toBe('not-replayed');
    expect(rebuild.blobUrls).toBe('regenerate');
  });
});
