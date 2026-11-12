import { describe, test, expect } from 'bun:test';
import {
  decidePodOperation, podExpectedTimeout, POD_OPERATIONS,
} from '../../extension/background/pod-tool-authority.js';

// The Pod admission policy shared by the controller bridge and the actor relay.
// The remote-Git consent chain is: resolve → read remote → confirm once →
// exec with that one grant, which the exec consumes.

const calls: any[] = [];
const podClient = {
  resolveId: async (opts: any) => { calls.push(['resolveId', opts]); return 'pod-1'; },
  exec: async (command: string, opts: any) => { calls.push(['exec', command, opts]); return { jobId: 'j' }; },
  status: async (opts: any) => { calls.push(['status', opts]); return {}; },
  cancel: async (jobId: string, opts: any) => { calls.push(['cancel', jobId, opts]); return {}; },
  readFile: async (path: string, opts: any) => { calls.push(['readFile', path, opts]); return 'x'; },
  writeFile: async (path: string, content: string, opts: any) => { calls.push(['writeFile', path, content, opts]); return 'pod-1'; },
};
const ctxFor = (extra: Record<string, unknown> = {}) => ({
  session: { sessionId: 's1' }, podClient,
  repositories: { getRemote: async () => ({ url: 'https://example.com/repo.git' }) },
  confirm: async () => true,
  ...extra,
});
const decide = (operation: string, message: any, args: any, domainState: any = {}, ctx: any = ctxFor()) =>
  decidePodOperation(operation, { message, args, domainState, ctx });
const isPlan = (decision: any): decision is { admit: () => void, effect: (d: any) => any, settle: (v: unknown, live: () => boolean) => void, whenUnavailable: string, outcome: string | null } =>
  !('refusal' in decision);
const run = async (decision: any, signal?: AbortSignal) => {
  if (!isPlan(decision)) throw new Error(`refused: ${(decision as any).refusal}`);
  decision.admit();
  const effect = decision.effect({ signal });
  if (!effect) return { unavailable: decision.whenUnavailable };
  const value = await effect();
  return { value };
};

describe('Pod policy: resolve', () => {
  test('an unbound caller must name exactly the admitted Pod (or none)', async () => {
    expect(decide('resolve', { podId: 'pod-1' }, { podId: 'pod-1' })).not.toHaveProperty('refusal');
    expect(decide('resolve', {}, {})).not.toHaveProperty('refusal');
    expect(decide('resolve', { podId: 'pod-2' }, { podId: 'pod-1' })).toEqual({ refusal: 'mismatch' });
  });

  test('a bound Pod actor resolves only its own Pod, even when it names none', async () => {
    const ctx = ctxFor({ actorType: 'pod', actorInstanceId: 'pod-own' });
    expect(decide('resolve', { podId: 'pod-other' }, { podId: 'pod-other' }, {}, ctx))
      .toEqual({ refusal: 'mismatch' });
    calls.length = 0;
    await run(decide('resolve', {}, {}, {}, ctx));
    expect(calls).toEqual([['resolveId', { sessionId: 's1', podId: 'pod-own' }]]);
  });

  test('an actor of another kind is not pinned by the Pod rules', () => {
    const ctx = ctxFor({ actorType: 'notebook', actorInstanceId: 'nb-1' });
    expect(decide('resolve', { podId: 'pod-1' }, { podId: 'pod-1' }, {}, ctx)).not.toHaveProperty('refusal');
  });

  test('success records the Pod and the admitted command for the later steps', () => {
    const state: any = {};
    const decision: any = decide('resolve', { podId: 'pod-1', command: 'git push' }, { podId: 'pod-1' }, state);
    decision.settle('pod-1', () => true);
    expect(state).toEqual({ podId: 'pod-1', command: 'git push' });
    const other: any = {};
    decide('resolve', {}, {}, other);
    (decide('resolve', {}, {}, other) as any).settle(undefined, () => true);
    expect(other).toEqual({});
  });

  test('no client means unavailable, not an effect', async () => {
    expect(await run(decide('resolve', {}, {}, {}, ctxFor({ podClient: undefined }))))
      .toEqual({ unavailable: 'unavailable' });
  });
});

describe('Pod policy: Git consent chain', () => {
  const resolved = (command: string) => ({ podId: 'pod-1', command });

  test('read-remote is only for a resolved Pod running one URL-less remote command', () => {
    expect(decide('read-remote', { podId: 'pod-1' }, {}, resolved('git push')))
      .not.toHaveProperty('refusal');
    expect(decide('read-remote', { podId: 'pod-2' }, {}, resolved('git push')))
      .toEqual({ refusal: 'mismatch' });
    expect(decide('read-remote', { podId: 'pod-1' }, {}, resolved('ls')))
      .toEqual({ refusal: 'mismatch' });
    expect(decide('read-remote', { podId: 'pod-1' }, {}, resolved('git clone https://example.com/r.git')))
      .toEqual({ refusal: 'mismatch' });
    expect(decide('read-remote', { podId: 'pod-1' }, {}, {})).toEqual({ refusal: 'mismatch' });
  });

  test('read-remote records the remote; a missing repository surface reads as none', async () => {
    const state: any = resolved('git push');
    const decision: any = decide('read-remote', { podId: 'pod-1' }, {}, state);
    const { value } = await run(decision);
    decision.settle(value, () => true);
    expect(state.remote).toEqual({ url: 'https://example.com/repo.git' });
    const bare = await run(decide('read-remote', { podId: 'pod-1' }, {}, resolved('git push'), ctxFor({ repositories: undefined })));
    expect(bare).toEqual({ value: null });
  });

  test('confirm names the exact remote origin and the operation the command performs', async () => {
    const prompts: any[] = [];
    const ctx = ctxFor({ confirm: async (prompt: any, signal: unknown) => { prompts.push([prompt, signal]); return 'yes_once'; } });
    const state: any = { ...resolved('git push'), remote: { url: 'https://example.com/repo.git' } };
    const signal = new AbortController().signal;
    const decision: any = decide('confirm-git', { op: 'push' }, {}, state, ctx);
    expect(decision.outcome).toBe('confirmation');
    const { value } = await run(decision, signal);
    expect(prompts).toEqual([[{
      tool: 'pod_exec', kind: 'git_push', sideEffect: 'mutate_external',
      origins: ['https://example.com'],
      summary: 'Allow this one Pod job to push code and commit history to https://example.com/repo.git?',
    }, signal]]);
    decision.settle(value, () => true);
    expect(state.remoteGitGrant).toEqual({ op: 'push', url: 'https://example.com/repo.git' });
  });

  test('confirm refuses a mismatched op, an ambiguous command, or no known target', () => {
    const remote = { url: 'https://example.com/repo.git' };
    expect(decide('confirm-git', { op: 'fetch' }, {}, { ...resolved('git push'), remote }))
      .toEqual({ refusal: 'mismatch' });
    expect(decide('confirm-git', { op: 'push' }, {}, { ...resolved('git push && git push'), remote }))
      .toEqual({ refusal: 'mismatch' });
    expect(decide('confirm-git', { op: 'push' }, {}, resolved('git push')))
      .toEqual({ refusal: 'mismatch' });
    expect(decide('confirm-git', { op: 'push' }, {}, { command: 'git push', remote }))
      .toEqual({ refusal: 'mismatch' });
  });

  test('a remote that is not a URL is refused as invalid', () => {
    expect(decide('confirm-git', { op: 'push' }, {}, { ...resolved('git push'), remote: { url: 'not a url' } }))
      .toEqual({ refusal: 'invalid-remote' });
  });

  test('no confirmation surface declines rather than granting', async () => {
    const state: any = { ...resolved('git push'), remote: { url: 'https://example.com/repo.git' } };
    expect(await run(decide('confirm-git', { op: 'push' }, {}, state, ctxFor({ confirm: undefined }))))
      .toEqual({ unavailable: 'decline' });
    expect(state.remoteGitGrant).toBeUndefined();
  });

  test('only an approval, while the run is live, leaves a grant', () => {
    const base = () => ({ ...resolved('git push'), remote: { url: 'https://example.com/repo.git' } });
    for (const answer of [false, 'no', 'deny', undefined, null, 'yes']) {
      const state: any = base();
      (decide('confirm-git', { op: 'push' }, {}, state) as any).settle(answer, () => true);
      expect(state.remoteGitGrant).toBeUndefined();
    }
    for (const answer of [true, 'yes_once', 'yes_session']) {
      const live: any = base();
      (decide('confirm-git', { op: 'push' }, {}, live) as any).settle(answer, () => true);
      expect(live.remoteGitGrant).toEqual({ op: 'push', url: 'https://example.com/repo.git' });
      const stopped: any = base();
      (decide('confirm-git', { op: 'push' }, {}, stopped) as any).settle(answer, () => false);
      expect(stopped.remoteGitGrant).toBeUndefined();
    }
  });
});

describe('Pod policy: exec', () => {
  const grant = { op: 'push', url: 'https://example.com/repo.git' };
  const message = (overrides: Record<string, unknown> = {}) => ({
    command: 'git push', podId: 'pod-1', timeoutMs: 30_000, background: false,
    remoteGitGrant: grant, ...overrides,
  });

  test('every effect parameter must equal what the admitted command implies', () => {
    const state = () => ({ podId: 'pod-1', remoteGitGrant: grant });
    const args = { command: 'git push' };
    expect(decide('exec', message(), args, state())).not.toHaveProperty('refusal');
    for (const tampered of [
      { command: 'git push --force' }, { podId: 'pod-2' }, { timeoutMs: 300_000 },
      { background: true }, { remoteGitGrant: null },
      { remoteGitGrant: { op: 'push', url: 'https://attacker.example/repo.git' } },
    ]) {
      expect(decide('exec', message(tampered), args, state())).toEqual({ refusal: 'mismatch' });
    }
  });

  test('the grant is consumed at admission, so one consent covers exactly one job', async () => {
    const state: any = { podId: 'pod-1', remoteGitGrant: grant };
    calls.length = 0;
    await run(decide('exec', message(), { command: 'git push' }, state));
    expect(state.remoteGitGrant).toBeNull();
    expect(calls[0][2].remoteGitGrant).toEqual(grant);
    // A second exec in the same call no longer matches the consumed grant.
    expect(decide('exec', message(), { command: 'git push' }, state)).toEqual({ refusal: 'mismatch' });
  });

  test('the grant is consumed even when the client is unavailable', async () => {
    const state: any = { podId: 'pod-1', remoteGitGrant: grant };
    expect(await run(decide('exec', message(), { command: 'git push' }, state, ctxFor({ podClient: {} }))))
      .toEqual({ unavailable: 'unavailable' });
    expect(state.remoteGitGrant).toBeNull();
  });

  test('exec must run the command this call resolved with, so a consent cannot be reused for another command', () => {
    const state = { podId: 'pod-1', command: 'git fetch', remoteGitGrant: { op: 'fetch', url: grant.url } };
    expect(decide('exec', message({ command: 'git push', remoteGitGrant: { op: 'fetch', url: grant.url } }),
      { command: 'git push' }, state)).toEqual({ refusal: 'mismatch' });
    expect(decide('exec', message({ command: 'git fetch', remoteGitGrant: { op: 'fetch', url: grant.url } }),
      { command: 'git fetch' }, { ...state })).not.toHaveProperty('refusal');
    // A call that resolved without a command (a file write, say) is not tied to one.
    expect(decide('exec', message({ command: 'ls', remoteGitGrant: null }), { command: 'ls' }, { podId: 'pod-1' }))
      .not.toHaveProperty('refusal');
  });

  test('unparsable command text in the consent chain is refused, never thrown', () => {
    const state = { podId: 'pod-1', command: 'echo "x', remote: { url: 'https://example.com/r.git' } };
    expect(decide('read-remote', { podId: 'pod-1' }, {}, state)).toEqual({ refusal: 'invalid-command' });
    expect(decide('confirm-git', { op: 'push' }, {}, state)).toEqual({ refusal: 'invalid-command' });
  });

  test('a command with more than one remote operation is refused outright', () => {
    expect(decide('exec', message({ command: 'git push && git push', remoteGitGrant: null }),
      { command: 'git push && git push' }, { podId: 'pod-1', remoteGitGrant: grant }))
      .toEqual({ refusal: 'mismatch' });
  });

  test('no resolved Pod, no exec', () => {
    expect(decide('exec', message({ remoteGitGrant: null, command: 'ls' }), { command: 'ls' }, {}))
      .toEqual({ refusal: 'mismatch' });
  });

  test('a local command carries no grant even if one is pending', async () => {
    const state: any = { podId: 'pod-1', remoteGitGrant: grant };
    const decision = decide('exec', message({ command: 'ls', remoteGitGrant: null }), { command: 'ls' }, state);
    expect(decision).not.toHaveProperty('refusal');
    await run(decision);
    expect(state.remoteGitGrant).toEqual(grant);
  });

  test('timeout and background are recomputed from the admitted args', async () => {
    expect(podExpectedTimeout(undefined)).toBe(30_000);
    expect(podExpectedTimeout(0)).toBe(30_000);
    expect(podExpectedTimeout(-5)).toBe(1);
    expect(podExpectedTimeout(10_000_000)).toBe(300_000);
    const state = { podId: 'pod-1' };
    expect(decide('exec', message({ command: 'sleep 1 &', remoteGitGrant: null, background: false }),
      { command: 'sleep 1 &' }, state)).toEqual({ refusal: 'mismatch' });
    expect(decide('exec', message({ command: 'sleep 1 &', remoteGitGrant: null, background: true }),
      { command: 'sleep 1 &' }, state)).not.toHaveProperty('refusal');
  });

  test('Stop reaches a foreground job but never a background one', async () => {
    const signal = new AbortController().signal;
    calls.length = 0;
    await run(decide('exec', message({ command: 'ls', remoteGitGrant: null }), { command: 'ls' }, { podId: 'pod-1' }), signal);
    await run(decide('exec', message({ command: 'sleep 1 &', remoteGitGrant: null, background: true }),
      { command: 'sleep 1 &' }, { podId: 'pod-1' }), signal);
    expect(calls[0][2].signal).toBe(signal);
    expect(calls[1][2].signal).toBeUndefined();
  });

  test('an unparsable admitted command is refused as invalid', () => {
    expect(decide('exec', message({ command: '"unterminated', remoteGitGrant: null }),
      { command: '"unterminated' }, { podId: 'pod-1' })).toEqual({ refusal: 'invalid-command' });
  });
});

describe('Pod policy: status, cancel, read and write', () => {
  const bound = ctxFor({ actorType: 'pod', actorInstanceId: 'pod-own' });
  const cases: Array<[string, any]> = [
    ['status', { podId: 'pod-own', jobId: 'j', stream: 'stdout', offset: 0, limit: 10 }],
    ['cancel', { podId: 'pod-own', jobId: 'j' }],
    ['read-file', { podId: 'pod-own', path: 'a.txt' }],
    ['write-file', { podId: 'pod-own', path: 'a.txt', content: 'x' }],
  ];

  for (const [operation, admitted] of cases) {
    test(`${operation}: values must equal the admitted call`, () => {
      expect(decide(operation, admitted, admitted)).not.toHaveProperty('refusal');
      for (const key of Object.keys(admitted)) {
        const tampered = { ...admitted, [key]: typeof admitted[key] === 'number' ? 99 : 'other' };
        expect(decide(operation, tampered, admitted)).toEqual({ refusal: 'mismatch' });
      }
    });

    test(`${operation}: a bound Pod actor cannot reach another Pod`, () => {
      expect(decide(operation, admitted, admitted, {}, bound)).not.toHaveProperty('refusal');
      const elsewhere = { ...admitted, podId: 'pod-other' };
      expect(decide(operation, elsewhere, elsewhere, {}, bound)).toEqual({ refusal: 'mismatch' });
    });

    test(`${operation}: no client capability means unavailable`, async () => {
      expect(await run(decide(operation, admitted, admitted, {}, ctxFor({ podClient: {} }))))
        .toEqual({ unavailable: 'unavailable' });
    });
  }

  test('each effect goes to the session and the admitted Pod', async () => {
    calls.length = 0;
    for (const [operation, admitted] of cases) await run(decide(operation, admitted, admitted));
    expect(calls).toEqual([
      ['status', { sessionId: 's1', podId: 'pod-own', jobId: 'j', stream: 'stdout', offset: 0, limit: 10 }],
      ['cancel', 'j', { sessionId: 's1', podId: 'pod-own' }],
      ['readFile', 'a.txt', { sessionId: 's1', podId: 'pod-own' }],
      ['writeFile', 'a.txt', 'x', { sessionId: 's1', podId: 'pod-own' }],
    ]);
  });

  test('a cancel without a job id or a write without text content is refused', () => {
    expect(decide('cancel', { podId: 'p', jobId: 7 }, { podId: 'p', jobId: 7 })).toEqual({ refusal: 'mismatch' });
    expect(decide('write-file', { podId: 'p', path: 'a', content: 7 }, { podId: 'p', path: 'a', content: 7 }))
      .toEqual({ refusal: 'mismatch' });
  });

  test('effect outcomes are classified for the host receipts', () => {
    const outcome = (operation: string, admitted: any) => (decide(operation, admitted, admitted) as any).outcome;
    expect(outcome('cancel', cases[1][1])).toBe('podCancel');
    expect(outcome('write-file', cases[3][1])).toBe('podMutation');
    expect(outcome('status', cases[0][1])).toBeNull();
    expect(outcome('read-file', cases[2][1])).toBeNull();
  });
});

describe('Pod policy: shape', () => {
  test('an unknown operation is refused', () => {
    expect(decide('destroy', {}, {})).toEqual({ refusal: 'mismatch' });
  });

  test('both hosts route every Pod operation through this policy', async () => {
    const bridge = await Bun.file('./extension/background/controller-turn-bridge.js').text();
    const actor = await Bun.file('./extension/background/offscreen-actor-client.js').text();
    for (const operation of POD_OPERATIONS) {
      expect(bridge).toContain(`case 'turn.pod.${operation}':\n          return runPodOperation(run, value, operation, '${operation}'`);
      expect(actor).toContain(`) => runPodRoute('${operation}', msg, sender, boundGrant,`);
    }
    // The policy is not re-implemented inline on either side.
    for (const source of [bridge, actor]) {
      expect(source).not.toContain('podGitRemoteIntents(');
      expect(source).not.toContain('parsePodShell(');
    }
  });
});
