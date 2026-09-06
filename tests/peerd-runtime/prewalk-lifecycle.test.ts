// Prewalk lifecycle through the REAL controller (makePrewalkController) over
// the REAL session store — the seam the pure policy tests (prewalk.test.ts)
// can't reach. This drives the actual arm/reconcile/maybeSwap/restore the SW
// wires, with fakes only for the run-liveness signal (goalRunner) and
// settings — so the bugs the adversarial review found are pinned against the
// code that ships, not a re-implementation:
//   - re-arm with the setting OFF must still clear a prior run's executor
//     state (the HIGH stale-cleanup-below-the-gate bug);
//   - restore is a no-op while a run is active (the supersede clobber race);
//   - reconcile consults the durable mirror (isPersisted), so a not-yet-
//     resumed / vault-lock-paused run is never restored mid-run;
//   - the swap gate keys on isActive + the REAL registry sideEffect.
// Plus the store's setPrewalk contract (set / clear-absent / atomic restore).

import { describe, test, expect } from 'bun:test';
import { createSessionStore } from '../../extension/peerd-runtime/sessions/store.js';
import { makePrewalkController } from '../../extension/peerd-runtime/loop/prewalk-controller.js';
import { armPrewalk } from '../../extension/peerd-runtime/loop/prewalk.js';
import type { Session } from '../../extension/peerd-runtime/sessions/types.js';

const makeIdb = () => {
  const stores = new Map<string, Map<string, any>>();
  const tbl = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  return {
    get: async (store: string, key: string) => tbl(store).get(key),
    put: async (store: string, val: any) => { tbl(store).set(val.id ?? val.sessionId, val); },
    getAll: async (store: string) => [...tbl(store).values()],
  };
};
const makeStore = () => {
  let i = 0;
  return createSessionStore({ idb: makeIdb(), now: () => 1000, makeId: () => `id-${++i}` });
};

// The REAL registry sideEffect classes the SW reads via getTool.
const TOOLS: Record<string, { sideEffect: string }> = {
  message_actor: { sideEffect: 'write' },
  edit_file: { sideEffect: 'write' },
  todo_init: { sideEffect: 'read' },
  read_page: { sideEffect: 'read' },
};

// A controllable rig: real store + controller, fake run-liveness + settings.
const rig = (opts: { prewalkEnabled?: boolean; enginePrewalkEnabled?: boolean; executor?: string } = {}) => {
  const store = makeStore();
  const active = new Set<string>();
  const persisted = new Set<string>();
  const settings = { prewalkEnabled: opts.prewalkEnabled ?? true, enginePrewalkEnabled: opts.enginePrewalkEnabled ?? true, prewalkExecutorModel: opts.executor ?? 'claude-haiku-4-5' };
  const audits: any[] = [];
  const notes: any[][] = [];
  let clock = 1;
  const controller = makePrewalkController({
    sessions: store,
    goalRunner: {
      isActive: (sid: string) => active.has(sid),
      isPersisted: async (sid: string) => active.has(sid) || persisted.has(sid),
    },
    settings: { get: () => settings },
    resolveProvider: async () => ({
      name: 'anthropic', defaultRunnerModel: 'claude-haiku-4-5',
    }),
    getTool: (name: string) => TOOLS[name],
    appendAudit: (e: any) => { audits.push(e); },
    postChatNote: (...args: any[]) => { notes.push(args); },
    now: () => clock++,
  });
  return { store, controller, active, persisted, settings, audits, notes };
};

const newChat = (store: ReturnType<typeof makeStore>) =>
  store.create({ provider: 'anthropic', model: 'claude-opus-4-8' });

describe('session store — setPrewalk', () => {
  test('sets, clears with the key ABSENT, and restores the model atomically', async () => {
    const store = makeStore();
    const s = await newChat(store);
    const state = armPrewalk(s, { provider: 'anthropic', model: 'claude-haiku-4-5' }, 1)!;
    const armed: Session = await store.setPrewalk(s.sessionId, state);
    expect(armed.prewalk!.phase).toBe('planning');

    const cleared = await store.setPrewalk(s.sessionId, null, { provider: 'anthropic', model: 'claude-opus-4-8' });
    expect('prewalk' in cleared).toBe(false);
    expect(cleared.model).toBe('claude-opus-4-8');
    expect('prewalk' in (await store.get(s.sessionId))!).toBe(false);
  });

  test('clearing preserves every other field (todos, messages)', async () => {
    const store = makeStore();
    const s = await newChat(store);
    await store.appendMessage(s.sessionId, { role: 'user', content: 'hi', id: 'm1', when: 1 });
    await store.update(s.sessionId, { todos: [{ id: 1, text: 'a', status: 'pending' }] });
    await store.setPrewalk(s.sessionId, armPrewalk(s, { provider: 'anthropic', model: 'm-2' }, 1)!);
    const cleared = await store.setPrewalk(s.sessionId, null, { provider: 'anthropic', model: 'claude-opus-4-8' });
    expect(cleared.messages.length).toBe(1);
    expect((cleared as any).todos).toHaveLength(1);
  });
});

describe('prewalk controller — the full lifecycle', () => {
  test('arm → commit plan → mutating call swaps phase → reconcile swaps model → restore', async () => {
    const { store, controller, active, notes } = rig();
    const s = await newChat(store);
    active.add(s.sessionId);

    // 1. ARM (startGoalRun). Planner model unchanged; phase planning.
    await controller.armForRun(s.sessionId);
    let rec = await store.get(s.sessionId);
    expect(rec!.prewalk!.phase).toBe('planning');
    expect(rec!.model).toBe('claude-opus-4-8');

    // 2. Plan committed; a READ tool must NOT swap.
    await store.update(s.sessionId, { todos: [{ id: 1, text: 'do it', status: 'pending' }] });
    await controller.maybeSwap({ sessionId: s.sessionId, name: 'read_page', ok: true });
    expect((await store.get(s.sessionId))!.prewalk!.phase).toBe('planning');

    // 3. First successful WRITE → phase executing (model still planner).
    await controller.maybeSwap({ sessionId: s.sessionId, name: 'message_actor', ok: true });
    rec = await store.get(s.sessionId);
    expect(rec!.prewalk!.phase).toBe('executing');
    expect(rec!.model).toBe('claude-opus-4-8');

    // 4. Next turn boundary: reconcile applies the model swap + returns it.
    const swapped = await controller.reconcile(rec);
    expect(swapped.model).toBe('claude-haiku-4-5');
    expect((await store.get(s.sessionId))!.model).toBe('claude-haiku-4-5');
    expect(notes).toEqual([[
      'Prewalk: plan landed; continuing on claude-haiku-4-5.', null, s.sessionId,
    ]]);

    // 5. Run end: restore planner + clear (run no longer active).
    active.delete(s.sessionId);
    await controller.restoreForRun(s.sessionId);
    const done = await store.get(s.sessionId);
    expect(done!.model).toBe('claude-opus-4-8');
    expect('prewalk' in done!).toBe(false);
  });

  test('a FAILED mutating call does not swap (not evidence the plan works)', async () => {
    const { store, controller, active } = rig();
    const s = await newChat(store);
    active.add(s.sessionId);
    await controller.armForRun(s.sessionId);
    await store.update(s.sessionId, { todos: [{ id: 1, text: 'x', status: 'pending' }] });
    await controller.maybeSwap({ sessionId: s.sessionId, name: 'edit_file', ok: false });
    expect((await store.get(s.sessionId))!.prewalk!.phase).toBe('planning');
  });

  test('swap gate keys on isActive — an inactive session never swaps', async () => {
    const { store, controller } = rig(); // active set empty
    const s = await newChat(store);
    // Arm requires a session; arm off-active still writes state (arm doesn't
    // gate on active), but the SWAP must not fire when the run isn't live.
    await store.setPrewalk(s.sessionId, armPrewalk(s, { provider: 'anthropic', model: 'claude-haiku-4-5' }, 1)!);
    await store.update(s.sessionId, { todos: [{ id: 1, text: 'x', status: 'pending' }] });
    await controller.maybeSwap({ sessionId: s.sessionId, name: 'message_actor', ok: true });
    expect((await store.get(s.sessionId))!.prewalk!.phase).toBe('planning'); // not swapped
  });
});

describe('prewalk controller — the review findings', () => {
  // correctness-F1 (HIGH): re-arm with the setting OFF must still clear a
  // prior run's stranded executor state (the old code returned before cleanup).
  test('re-arm with prewalk DISABLED clears stranded executor state + restores planner', async () => {
    const { store, controller, active, settings } = rig();
    const s = await newChat(store);
    // Simulate a prior run left the session on the executor, executing phase.
    await store.setPrewalk(s.sessionId, { phase: 'executing', plannerProvider: 'anthropic', plannerModel: 'claude-opus-4-8', executorProvider: 'anthropic', executorModel: 'claude-haiku-4-5', armedAt: 1, swappedAt: 2 }, { provider: 'anthropic', model: 'claude-haiku-4-5' });

    settings.prewalkEnabled = false;   // user turned it off
    active.add(s.sessionId);           // a NEW run starts on this session
    await controller.armForRun(s.sessionId);

    const rec = await store.get(s.sessionId);
    expect('prewalk' in rec!).toBe(false);          // stale state cleared…
    expect(rec!.model).toBe('claude-opus-4-8');      // …and model restored to planner (NOT left on haiku)
  });

  // concurrency-F1: the run-end restore must be a no-op while a (superseding)
  // run is active, so it can't clobber that run's fresh arm.
  test('restore is a no-op while a run is active (supersede clobber guard)', async () => {
    const { store, controller, active } = rig();
    const s = await newChat(store);
    active.add(s.sessionId);
    await controller.armForRun(s.sessionId);         // run B's arm
    await controller.restoreForRun(s.sessionId);     // run A's late restore
    expect((await store.get(s.sessionId))!.prewalk?.phase).toBe('planning'); // arm survived
  });

  // correctness-F2 / concurrency-F3: reconcile must consult the durable mirror
  // — a not-yet-resumed / paused run (isActive false but isPersisted true) is
  // NOT dead and must not be restored to the planner mid-run.
  test('reconcile does NOT restore a persisted-but-not-active run', async () => {
    const { store, controller, persisted } = rig();
    const s = await newChat(store);
    // Session mid-run on the executor; run not in the live map but in the mirror.
    await store.setPrewalk(s.sessionId, { phase: 'executing', plannerProvider: 'anthropic', plannerModel: 'claude-opus-4-8', executorProvider: 'anthropic', executorModel: 'claude-haiku-4-5', armedAt: 1, swappedAt: 2 }, { provider: 'anthropic', model: 'claude-haiku-4-5' });
    persisted.add(s.sessionId);        // durable mirror still lists it

    const rec = await store.get(s.sessionId);
    const out = await controller.reconcile(rec);
    expect('prewalk' in out).toBe(true);            // preserved, not restored
    expect(out.model).toBe('claude-haiku-4-5');      // stays on the executor
  });

  test('reconcile DOES restore a truly-dead run (neither active nor persisted)', async () => {
    const { store, controller } = rig();
    const s = await newChat(store);
    await store.setPrewalk(s.sessionId, { phase: 'executing', plannerProvider: 'anthropic', plannerModel: 'claude-opus-4-8', executorProvider: 'anthropic', executorModel: 'claude-haiku-4-5', armedAt: 1, swappedAt: 2 }, { provider: 'anthropic', model: 'claude-haiku-4-5' });
    const out = await controller.reconcile((await store.get(s.sessionId))!);
    expect('prewalk' in out).toBe(false);
    expect(out.model).toBe('claude-opus-4-8');       // restored
  });

  test('arm no-ops cleanly: setting off + no stale, and executor == session model', async () => {
    const { store, controller, active, settings } = rig();
    const off = await newChat(store);
    settings.prewalkEnabled = false;
    active.add(off.sessionId);
    await controller.armForRun(off.sessionId);
    expect('prewalk' in (await store.get(off.sessionId))!).toBe(false); // nothing armed, nothing stranded

    // Executor resolves to the SAME model as the chat → armPrewalk returns null.
    settings.prewalkEnabled = true;
    const same = await store.create({ provider: 'anthropic', model: 'claude-haiku-4-5' });
    active.add(same.sessionId);
    await controller.armForRun(same.sessionId);
    expect('prewalk' in (await store.get(same.sessionId))!).toBe(false);
  });
});

describe('prewalk controller — engine actors', () => {
  // A VM/Notebook/App actor session, minted on the frontier (owner-chat) model.
  const newEngineActor = (store: ReturnType<typeof makeStore>, actorType = 'webvm') =>
    store.create({ provider: 'anthropic', model: 'claude-opus-4-8', kind: 'actor', actorType: actorType as any, instanceId: 'vm-1' });
  // Append one assistant turn (the "first turn happened" signal reconcile reads).
  const addAssistantTurn = async (store: ReturnType<typeof makeStore>, sid: string, i: number) =>
    store.appendMessage(sid, { role: 'assistant', content: 'ran a command', id: `a${i}`, when: i } as any);

  test('arm on mint, first turn stays on frontier, second turn swaps to executor, then lives there', async () => {
    const { store, controller } = rig();
    const a = await newEngineActor(store);

    // ARM (mintActor). Planning phase; model unchanged (frontier).
    await controller.armEngineActor(a.sessionId);
    let rec: any = await store.get(a.sessionId);
    expect(rec.prewalk.phase).toBe('planning');
    expect(rec.model).toBe('claude-opus-4-8');

    // FIRST turn (no prior assistant) → reconcile keeps the frontier model.
    rec = await controller.reconcileEngineActor(rec);
    expect(rec.model).toBe('claude-opus-4-8');
    expect(rec.prewalk.phase).toBe('planning');

    // The first turn produces an assistant message.
    await addAssistantTurn(store, a.sessionId, 1);

    // SECOND turn → reconcile swaps to the executor + marks executing, one write.
    rec = await controller.reconcileEngineActor((await store.get(a.sessionId))!);
    expect(rec.model).toBe('claude-haiku-4-5');
    expect(rec.prewalk.phase).toBe('executing');

    // THIRD turn → already on the executor, no-op (and never restores).
    await addAssistantTurn(store, a.sessionId, 2);
    rec = await controller.reconcileEngineActor((await store.get(a.sessionId))!);
    expect(rec.model).toBe('claude-haiku-4-5');
    expect('prewalk' in rec).toBe(true);   // NO restore — the actor lives on the executor
  });

  test('armEngineActor no-ops: setting off, non-engine actor kind, and executor == model', async () => {
    const { store, controller, settings } = rig();

    settings.enginePrewalkEnabled = false;
    const off = await newEngineActor(store);
    await controller.armEngineActor(off.sessionId);
    expect('prewalk' in (await store.get(off.sessionId))!).toBe(false);

    settings.enginePrewalkEnabled = true;
    // A WEB actor is already cheap — not an engine kind, must not arm.
    const web = await store.create({ provider: 'anthropic', model: 'claude-opus-4-8', kind: 'actor', actorType: 'web' as any });
    await controller.armEngineActor(web.sessionId);
    expect('prewalk' in (await store.get(web.sessionId))!).toBe(false);

    // Engine actor already on the cheap model → no distinct executor, no arm.
    const cheap = await store.create({ provider: 'anthropic', model: 'claude-haiku-4-5', kind: 'actor', actorType: 'notebook' as any, instanceId: 'nb-1' });
    await controller.armEngineActor(cheap.sessionId);
    expect('prewalk' in (await store.get(cheap.sessionId))!).toBe(false);
  });

  test('armEngineActor is idempotent — a second call leaves the state alone', async () => {
    const { store, controller } = rig();
    const a = await newEngineActor(store, 'app');
    await controller.armEngineActor(a.sessionId);
    const first = (await store.get(a.sessionId))!.prewalk;
    await controller.armEngineActor(a.sessionId);
    expect((await store.get(a.sessionId))!.prewalk).toEqual(first);
  });
});
