import { describe, test, expect } from 'bun:test';
import { mayMessageActor, messageProvenance, ASYNC_SUBAGENT_ACTORS } from '../../extension/peerd-runtime/subagent/delegation-lineage.js';

// The PURE trust decision for the "subagents as async actors" refactor: may a
// sender session message an actor? It replaces the sender gate's `=== active`
// identity check with a trusted-LINEAGE check. These tests pin the security
// invariants the refactor rests on — above all that an inbound (injected) turn
// cannot launder message_actor access through a subagent it spawns.

const ACTIVE = 'chat-active';

// hop helpers — nearest-first ancestry the shell would build from the store.
const hop = (sessionId: string, parentSessionId: string | null, spawnedTrusted = true) =>
  ({ sessionId, parentSessionId, spawnedTrusted });

describe('mayMessageActor — the two unchanged walls', () => {
  test('inbound turn is ALWAYS refused, even for the active chat itself', () => {
    // the inbound wall is what blocks an injected/synthetic turn AND the async
    // result-wake (which re-enters trusted:false → inbound:true) from delegating.
    expect(mayMessageActor({ inbound: true, senderSessionId: ACTIVE, activeSessionId: ACTIVE })).toBe(false);
  });

  test('a missing sender or active id fails closed', () => {
    expect(mayMessageActor({ inbound: false, senderSessionId: null, activeSessionId: ACTIVE })).toBe(false);
    expect(mayMessageActor({ inbound: false, senderSessionId: ACTIVE, activeSessionId: null })).toBe(false);
  });
});

describe('mayMessageActor — the foreground chat (today\'s only accepted sender)', () => {
  test('the active chat on a real (non-inbound) turn is admitted', () => {
    expect(mayMessageActor({ inbound: false, senderSessionId: ACTIVE, activeSessionId: ACTIVE })).toBe(true);
  });
});

describe('mayMessageActor — trusted-lineage descendants (the new capability)', () => {
  test('a subagent spawned by the active chat on a trusted turn is admitted', () => {
    const sender = 'sub-1';
    const ancestry = [hop(sender, ACTIVE, true)];
    expect(mayMessageActor({ inbound: false, senderSessionId: sender, activeSessionId: ACTIVE, ancestry })).toBe(true);
  });

  test('a grandchild reached through all-trusted spawn edges is admitted', () => {
    const ancestry = [hop('sub-2', 'sub-1', true), hop('sub-1', ACTIVE, true)];
    expect(mayMessageActor({ inbound: false, senderSessionId: 'sub-2', activeSessionId: ACTIVE, ancestry })).toBe(true);
  });
});

describe('mayMessageActor — the laundering hole is closed', () => {
  test('a subagent spawned by an INBOUND turn is refused (cannot launder access)', () => {
    // THE THREAT: an injected turn on the active chat is refused message_actor
    // directly, but calls spawn_subagent; the child runs non-inbound turns. Its
    // spawn edge is marked untrusted, so it is refused despite rooting at active.
    const ancestry = [hop('sub-inj', ACTIVE, false)];
    expect(mayMessageActor({ inbound: false, senderSessionId: 'sub-inj', activeSessionId: ACTIVE, ancestry })).toBe(false);
  });

  test('taint propagates: a trusted grandchild under an inbound-spawned parent is refused', () => {
    // sub-1 was spawned by an inbound turn (untrusted); sub-2 under it is clean on
    // its own edge but the subtree is tainted, so it is still refused.
    const ancestry = [hop('sub-2', 'sub-1', true), hop('sub-1', ACTIVE, false)];
    expect(mayMessageActor({ inbound: false, senderSessionId: 'sub-2', activeSessionId: ACTIVE, ancestry })).toBe(false);
  });
});

describe('mayMessageActor — non-descendants and malformed chains fail closed', () => {
  test('a descendant of a DIFFERENT chat (not the active one) is refused', () => {
    const ancestry = [hop('sub-x', 'chat-other', true), hop('chat-other', null, true)];
    expect(mayMessageActor({ inbound: false, senderSessionId: 'sub-x', activeSessionId: ACTIVE, ancestry })).toBe(false);
  });

  test('a non-foreground sender with no ancestry supplied is refused (fail-closed)', () => {
    expect(mayMessageActor({ inbound: false, senderSessionId: 'sub-orphan', activeSessionId: ACTIVE, ancestry: [] })).toBe(false);
    expect(mayMessageActor({ inbound: false, senderSessionId: 'sub-orphan', activeSessionId: ACTIVE })).toBe(false);
  });

  test('a cyclic chain terminates and refuses (never hangs)', () => {
    const ancestry = [hop('a', 'b', true), hop('b', 'a', true)]; // a→b→a, never reaches active
    expect(mayMessageActor({ inbound: false, senderSessionId: 'a', activeSessionId: ACTIVE, ancestry })).toBe(false);
  });
});

describe('messageProvenance — the parent reference the choke-point actor arbitrates on', () => {
  test('a top-level chat is its own root, path is just itself', () => {
    expect(messageProvenance({ senderSessionId: ACTIVE, ancestry: [] }))
      .toEqual({ senderSessionId: ACTIVE, rootSessionId: ACTIVE, lineagePath: [ACTIVE] });
  });

  test('a subagent resolves to its root chat with a root->sender path', () => {
    const ancestry = [hop('sub-1', ACTIVE, true)];
    expect(messageProvenance({ senderSessionId: 'sub-1', ancestry }))
      .toEqual({ senderSessionId: 'sub-1', rootSessionId: ACTIVE, lineagePath: [ACTIVE, 'sub-1'] });
  });

  test('a grandchild carries the full root->...->sender path', () => {
    const ancestry = [hop('sub-2', 'sub-1', true), hop('sub-1', ACTIVE, true)];
    expect(messageProvenance({ senderSessionId: 'sub-2', ancestry }))
      .toEqual({ senderSessionId: 'sub-2', rootSessionId: ACTIVE, lineagePath: [ACTIVE, 'sub-1', 'sub-2'] });
  });

  test('two subagents under one chat share a rootSessionId (so the actor can group + be fair)', () => {
    const a = messageProvenance({ senderSessionId: 'sub-a', ancestry: [hop('sub-a', ACTIVE, true)] });
    const b = messageProvenance({ senderSessionId: 'sub-b', ancestry: [hop('sub-b', ACTIVE, true)] });
    expect(a.rootSessionId).toBe(b.rootSessionId);
    expect(a.senderSessionId).not.toBe(b.senderSessionId);
  });

  test('a missing chain fails safe: the sender is treated as its own root', () => {
    expect(messageProvenance({ senderSessionId: 'sub-orphan' }))
      .toEqual({ senderSessionId: 'sub-orphan', rootSessionId: 'sub-orphan', lineagePath: ['sub-orphan'] });
  });

  test('a cyclic chain terminates (never hangs)', () => {
    const ancestry = [hop('a', 'b', true), hop('b', 'a', true)];
    const p = messageProvenance({ senderSessionId: 'a', ancestry });
    expect(p.lineagePath[p.lineagePath.length - 1]).toBe('a'); // sender is last, walk stopped
  });
});

describe('the refactor ships behind a flag, now ON', () => {
  test('ASYNC_SUBAGENT_ACTORS is on — the sender gate routes through mayMessageActor', () => {
    expect(ASYNC_SUBAGENT_ACTORS).toBe(true);
  });
});
