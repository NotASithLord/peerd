import { describe, expect, test } from 'bun:test';
import {
  makeUiStatePort,
  recoverColdPortState,
} from '../../extension/shared/cold-port-recovery.js';
import {
  KERNEL_STATE_DEFERRED_FIELDS,
  KERNEL_STATE_PROVENANCE,
  KERNEL_STATE_SCHEMA,
} from '../../extension/shared/kernel-state-contract.js';

const projected = (generation: number, authorityEpoch = 'kernel-epoch-0001') => ({
  hydrated: true,
  vault: { initialized: true, locked: true, unlockedAt: 0, prfEnrolled: false,
    hasRecovery: false, lockReason: null },
  settings: { vaultAutoLockMs: 60_000 },
  session: { sessionId: null, messages: [], permission: { mode: 'plan', confirmActions: true } },
  providers: { current: 'anthropic', model: 'claude-sonnet-4-6', hasKey: false },
  composer: { provider: 'anthropic', model: 'claude-sonnet-4-6', keyless: false,
    credentialReady: false, localReady: false, canSend: false, reason: 'vault-locked' },
  capabilities: { actorExecution: { status: 'available', host: 'offscreen-document-worker',
    reason: null, retryable: false } },
  actors: {},
  actorProjectionEpoch: null,
  actorProjectionRevision: 0,
  spawned: { byToolUse: {}, sessions: {} },
  asyncTasks: {},
  projection: { schema: KERNEL_STATE_SCHEMA, provenance: KERNEL_STATE_PROVENANCE,
    authorityEpoch, generation, settings: 'hydrated', actorIsolation: 'base',
    semanticController: 'required', deferredFields: [...KERNEL_STATE_DEFERRED_FIELDS], failures: [] },
});

const fakePort = () => {
  const messages: Array<(message:any)=>void> = [];
  const disconnects: Array<()=>void> = [];
  return {
    onMessage: { addListener: (fn: (message:any)=>void) => messages.push(fn) },
    onDisconnect: { addListener: (fn: ()=>void) => disconnects.push(fn) },
    disconnect: () => { for (const fn of disconnects) fn(); },
    emit: (message:any) => { for (const fn of messages) fn(message); },
  };
};

describe('cold UI Port recovery', () => {
  test('retries an orphaned pre-listener request and adopts the successor state', async () => {
    const calls: string[] = [];
    let bootstrapAttempts = 0;
    let adopted: unknown = null;
    const browser = { runtime: { sendMessage: async ({ type }: {type:string}) => {
      calls.push(type);
      if (type === 'bootstrap/ready' && bootstrapAttempts++ === 0) {
        return new Promise(() => {});
      }
      if (type === 'bootstrap/ready') return { ok: true };
      return { ok: true, state: { hydrated: true, generation: 2 } };
    } } };
    await expect(recoverColdPortState({
      browser,
      isCurrent: () => true,
      isHydrated: () => adopted !== null,
      adoptState: (state) => { adopted = state; },
      requestTimeoutMs: 3,
      retryMinMs: 1,
      retryMaxMs: 2,
    })).resolves.toBe(true);
    expect(calls).toEqual(['bootstrap/ready', 'bootstrap/ready', 'state/get']);
    expect(adopted).toEqual({ hydrated: true, generation: 2 });
  });

  test('continues bounded startup probes after two dropped messages', async () => {
    const calls: string[] = [];
    let attempts = 0;
    let adopted: unknown = null;
    const browser = { runtime: { sendMessage: async ({ type }: {type:string}) => {
      calls.push(type);
      attempts += 1;
      if (attempts <= 2) return new Promise(() => {});
      if (type === 'bootstrap/ready') return { ok: true };
      return { ok: true, state: { hydrated: true, generation: 3 } };
    } } };
    await expect(recoverColdPortState({
      browser,
      isCurrent: () => true,
      isHydrated: () => adopted !== null,
      adoptState: (state) => { adopted = state; },
      requestTimeoutMs: 2,
      overallTimeoutMs: 20,
      maxAttempts: 4,
    })).resolves.toBe(true);
    expect(calls).toEqual([
      'bootstrap/ready', 'bootstrap/ready', 'bootstrap/ready', 'state/get',
    ]);
    expect(adopted).toEqual({ hydrated: true, generation: 3 });
  });

  test('rich state Port validates and orders deferred snapshots before delivery', async () => {
    const ports: ReturnType<typeof fakePort>[] = [];
    const delivered: any[] = [];
    const runtime = makeUiStatePort({
      browser: { runtime: {
        connect: () => { const port = fakePort(); ports.push(port); return port; },
        sendMessage: async () => null,
      } },
      name: 'home',
      isHydrated: () => delivered.length > 0,
      onMessage: (message) => { delivered.push(message); },
      onDisconnect: () => {},
      onStatusChange: () => {},
      recover: async () => false,
    });
    runtime.start();
    const deferred = () => {
      let resolve!: (value:any)=>void;
      const promise = new Promise<any>((done) => { resolve = done; });
      return { promise, resolve };
    };
    const deliver = async (pending: Promise<any>) => {
      ports[0].emit({ type: 'state', state: await pending });
    };
    const a = deferred();
    const b = deferred();
    const pendingA = deliver(a.promise);
    const pendingB = deliver(b.promise);
    b.resolve(projected(2));
    await pendingB;
    a.resolve(projected(1));
    await pendingA;
    const future = projected(3);
    future.projection.schema = KERNEL_STATE_SCHEMA + 1;
    ports[0].emit({ type: 'state', state: future });
    ports[0].emit({ type: 'state', state: projected(3, 'kernel-epoch-unbound') });
    expect(delivered.map((message) => message.state.projection.generation)).toEqual([2]);
  });

  test('rich state Port rolls authority once on reconnect and fences late A', async () => {
    const ports: ReturnType<typeof fakePort>[] = [];
    const reconnects: Array<()=>void> = [];
    const delivered: string[] = [];
    let disconnects = 0;
    const runtime = makeUiStatePort({
      browser: { runtime: {
        connect: () => { const port = fakePort(); ports.push(port); return port; },
        sendMessage: async () => null,
      } },
      name: 'sidepanel',
      isHydrated: () => delivered.length > 0,
      onMessage: (message) => { delivered.push(message.state.projection.authorityEpoch); },
      onDisconnect: () => { disconnects += 1; },
      onStatusChange: () => {},
      recover: () => new Promise(() => {}),
      setTimeoutFn: ((fn: () => void) => {
        reconnects.push(fn);
        return 0 as any;
      }) as typeof setTimeout,
    });
    runtime.start();
    const a = ports[0];
    a.emit({ type: 'state', state: projected(4) });
    let resolveLate!: (value:any)=>void;
    const lateRead = runtime.reconcile(() => new Promise((resolve) => { resolveLate = resolve; }));
    a.disconnect();
    a.emit({ type: 'state', state: projected(5) });
    reconnects.shift()?.();
    const b = ports[1];
    b.emit({ type: 'state', state: projected(1, 'kernel-epoch-0002') });
    a.emit({ type: 'state', state: projected(99) });
    b.emit({ type: 'state', state: projected(2, 'kernel-epoch-0002') });
    resolveLate({ ok: true, state: projected(100) });
    await lateRead;
    expect(disconnects).toBe(1);
    expect(delivered).toEqual([
      'kernel-epoch-0001', 'kernel-epoch-0002', 'kernel-epoch-0002',
    ]);
  });

  test('a current reconcile may roll authority without waiting for a stale Port to close', async () => {
    const port = fakePort();
    const delivered: string[] = [];
    const runtime = makeUiStatePort({
      browser: { runtime: { connect: () => port, sendMessage: async () => null } },
      name: 'home',
      isHydrated: () => delivered.length > 0,
      onMessage: (message) => { delivered.push(message.state.projection.authorityEpoch); },
      onDisconnect: () => {},
      onStatusChange: () => {},
      recover: () => new Promise(() => {}),
    });
    runtime.start();
    port.emit({ type: 'state', state: projected(4) });
    await runtime.reconcile(async () => ({
      ok: true, state: projected(1, 'kernel-epoch-0002'),
    }));
    port.emit({ type: 'state', state: projected(99) });
    port.emit({ type: 'state', state: projected(2, 'kernel-epoch-0002') });
    expect(delivered).toEqual([
      'kernel-epoch-0001', 'kernel-epoch-0002', 'kernel-epoch-0002',
    ]);
  });

  test('rich state Port exposes one explicit retry after bounded recovery fails', async () => {
    const ports: ReturnType<typeof fakePort>[] = [];
    let redraws = 0;
    const runtime = makeUiStatePort({
      browser: { runtime: {
        connect: () => { const port = fakePort(); ports.push(port); return port; },
        sendMessage: async () => null,
      } },
      name: 'home',
      isHydrated: () => false,
      onMessage: () => {},
      onDisconnect: () => {},
      onStatusChange: () => { redraws += 1; },
      recover: async () => false,
    });
    runtime.start();
    await Bun.sleep(0);
    expect(runtime.failed).toBe(true);
    runtime.retry();
    expect(runtime.failed).toBe(false);
    expect(ports).toHaveLength(2);
    expect(redraws).toBe(1);
  });

  test('successful orphan recovery adopts once, replaces the Port, and fences the orphan', async () => {
    const ports: ReturnType<typeof fakePort>[] = [];
    const generations: number[] = [];
    let recoveryCalls = 0;
    const runtime = makeUiStatePort({
      browser: { runtime: {
        connect: () => { const port = fakePort(); ports.push(port); return port; },
        sendMessage: async () => null,
      } },
      name: 'home',
      isHydrated: () => generations.length > 0,
      onMessage: (message) => { generations.push(message.state.projection.generation); },
      onDisconnect: () => { throw new Error('intentional orphan replacement is not a loss'); },
      onStatusChange: () => {},
      recover: async ({ adoptState }) => recoveryCalls++ === 0
        ? adoptState(projected(1)) !== false : false,
    });
    runtime.start();
    await Bun.sleep(0);
    expect(ports).toHaveLength(2);
    expect(generations).toEqual([1]);
    expect(runtime.failed).toBe(false);
    ports[0].emit({ type: 'state', state: projected(99) });
    ports[1].emit({ type: 'state', state: projected(2) });
    expect(generations).toEqual([1, 2]);
  });

  test('caps hung startup requests and returns a bounded visible-failure signal', async () => {
    let calls = 0;
    await expect(recoverColdPortState({
      browser: { runtime: { sendMessage: async () => {
        calls += 1;
        return new Promise(() => {});
      } } },
      isCurrent: () => true,
      isHydrated: () => false,
      adoptState: () => {},
      requestTimeoutMs: 2,
      overallTimeoutMs: 8,
      maxAttempts: 2,
      retryMinMs: 1,
      retryMaxMs: 1,
    })).resolves.toBe(false);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(2);
  });

  test('a timely Port push stops recovery without overwriting newer state', async () => {
    let hydrated = false;
    let adopted = false;
    const browser = { runtime: { sendMessage: async () => {
      hydrated = true;
      return { ok: true, state: { stale: true } };
    } } };
    await expect(recoverColdPortState({
      browser,
      isCurrent: () => true,
      isHydrated: () => hydrated,
      adoptState: () => { adopted = true; },
      requestTimeoutMs: 10,
      retryMinMs: 1,
      retryMaxMs: 1,
    })).resolves.toBe(false);
    expect(adopted).toBe(false);
  });
});
