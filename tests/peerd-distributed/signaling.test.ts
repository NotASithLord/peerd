import { describe, test, expect } from 'bun:test';
import {
  signalingStep,
  initialSignalingState,
  ROOM_CAP,
  WEBSITE_CAP, PUBLIC_ROOM, SPARSE_PUBLIC_PROFILE, PUBLIC_MEMBERSHIP_CAP, INTRODUCTION_LIMIT, SAMPLE_INTERVAL_MS,
} from '../../extension/peerd-distributed/transport/signaling.js';

// Drive the pure reducer the way a shell would: thread state through, read
// the emitted actions. No sockets — this is the whole point of the pure
// core. The exact same reducer runs in the Bun host and the CF Worker.
const run = (events: any[]) => {
  // why typed via the reducer: the initializer's literal pins rooms to {}.
  let state: ReturnType<typeof signalingStep>['state'] = initialSignalingState();
  const log: any[] = [];
  for (const ev of events) {
    const r = signalingStep(state, ev);
    state = r.state;
    log.push(...r.actions);
  }
  return { state, log };
};

describe('signaling reducer (rooms)', () => {
  test('joiner gets the roster; existing members hear the join', () => {
    const { log } = run([
      { t: 'join', connId: 'a', key: 'room1' },
      { t: 'join', connId: 'b', key: 'room1' },
      { t: 'join', connId: 'c', key: 'room1' },
    ]);
    expect(log).toContainEqual({ t: 'send', connId: 'a', msg: { t: 'room', self: 'a', members: [] } });
    expect(log).toContainEqual({ t: 'send', connId: 'b', msg: { t: 'room', self: 'b', members: ['a'] } });
    expect(log).toContainEqual({ t: 'send', connId: 'c', msg: { t: 'room', self: 'c', members: ['a', 'b'] } });
    expect(log).toContainEqual({ t: 'send', connId: 'a', msg: { t: 'joined', member: 'b' } });
    expect(log).toContainEqual({ t: 'send', connId: 'a', msg: { t: 'joined', member: 'c' } });
    expect(log).toContainEqual({ t: 'send', connId: 'b', msg: { t: 'joined', member: 'c' } });
  });

  test('targeted relay reaches ONLY the named member, with from attached', () => {
    const sdp = { type: 'offer', sdp: 'v=0...' };
    const { log } = run([
      { t: 'join', connId: 'a', key: 'r' },
      { t: 'join', connId: 'b', key: 'r' },
      { t: 'join', connId: 'c', key: 'r' },
      { t: 'signal', connId: 'c', to: 'a', payload: sdp },
    ]);
    expect(log).toContainEqual({ t: 'send', connId: 'a', msg: { t: 'signal', from: 'c', payload: sdp } });
    expect(log.filter((e) => e.connId === 'b' && e.t === 'send' && e.msg.t === 'signal')).toHaveLength(0);
  });

  test('relay is room-scoped: cross-room, self, and unknown targets are dropped', () => {
    const { log } = run([
      { t: 'join', connId: 'a', key: 'x' },
      { t: 'join', connId: 'b', key: 'y' },
      { t: 'signal', connId: 'a', to: 'b', payload: { p: 1 } }, // b is in another room
      { t: 'signal', connId: 'a', to: 'a', payload: { p: 2 } }, // self
      { t: 'signal', connId: 'a', to: 'zz', payload: { p: 3 } }, // no such member
      { t: 'signal', connId: 'a', payload: { p: 4 } }, // no target at all
    ]);
    expect(log.filter((e) => e.t === 'send' && e.msg.t === 'signal')).toHaveLength(0);
  });

  test('a joiner past ROOM_CAP is rejected and closed', () => {
    const joins = Array.from({ length: ROOM_CAP + 1 }, (_, i) => ({
      t: 'join', connId: `c${i}`, key: 'r',
    }));
    const r = run(joins);
    const over = `c${ROOM_CAP}`;
    expect(r.log).toContainEqual({ t: 'send', connId: over, msg: { t: 'full' } });
    expect(r.log).toContainEqual({ t: 'close', connId: over });
    expect(r.state.rooms.r).toHaveLength(ROOM_CAP); // the late joiner never entered
  });

  test('leave notifies the remaining members and frees the room when empty', () => {
    const r = run([
      { t: 'join', connId: 'a', key: 'r' },
      { t: 'join', connId: 'b', key: 'r' },
      { t: 'join', connId: 'c', key: 'r' },
      { t: 'leave', connId: 'a' },
    ]);
    expect(r.log).toContainEqual({ t: 'send', connId: 'b', msg: { t: 'left', member: 'a' } });
    expect(r.log).toContainEqual({ t: 'send', connId: 'c', msg: { t: 'left', member: 'a' } });
    expect(r.state.rooms.r).toEqual(['b', 'c']);

    const r2 = signalingStep(r.state, { t: 'leave', connId: 'b' });
    const r3 = signalingStep(r2.state, { t: 'leave', connId: 'c' });
    expect(r3.state.rooms.r).toBeUndefined(); // room freed
  });

  test('rejoin after the slot was freed works (full → leave → join)', () => {
    const joins = Array.from({ length: ROOM_CAP }, (_, i) => ({
      t: 'join', connId: `c${i}`, key: 'r',
    }));
    const r = run([...joins, { t: 'leave', connId: 'c0' }, { t: 'join', connId: 'late', key: 'r' }]);
    expect(r.state.rooms.r).toContain('late');
    expect(r.log).toContainEqual({
      t: 'send', connId: 'late',
      msg: { t: 'room', self: 'late', members: r.state.rooms.r.filter((c: string) => c !== 'late') },
    });
  });

  test('join is idempotent per connection', () => {
    const r = run([
      { t: 'join', connId: 'a', key: 'r' },
      { t: 'join', connId: 'a', key: 'r' },
    ]);
    expect(r.state.rooms.r).toEqual(['a']);
  });

  test('payload is never inspected — arbitrary shapes pass through intact', () => {
    const weird = { nested: { a: [1, 2, { b: 'z' }] }, n: 42 };
    const { log } = run([
      { t: 'join', connId: 'a', key: 'r' },
      { t: 'join', connId: 'b', key: 'r' },
      { t: 'signal', connId: 'b', to: 'a', payload: weird },
    ]);
    expect(log).toContainEqual({ t: 'send', connId: 'a', msg: { t: 'signal', from: 'b', payload: weird } });
  });

  test('rooms are independent (no cross-talk between keys)', () => {
    const { log } = run([
      { t: 'join', connId: 'a', key: 'x' },
      { t: 'join', connId: 'b', key: 'y' },
    ]);
    // Neither hears about the other's join.
    expect(log.filter((e) => e.t === 'send' && e.msg.t === 'joined')).toHaveLength(0);
  });

  test('unknown message types (e.g. the client keepalive ping) are a harmless no-op', () => {
    // The signaling-client sends { t:'ping' } every 25s to keep the WS warm.
    // The node must IGNORE it (no response, no state change) so the keepalive
    // needs no node redeploy — the default case carries that contract.
    const joined = run([{ t: 'join', connId: 'a', key: 'r' }]);
    const r = signalingStep(joined.state, { t: 'ping', connId: 'a' } as any);
    expect(r.actions).toEqual([]);                  // no reply, no close
    expect(r.state).toEqual(joined.state);          // roster untouched
  });
});

describe('per-kind caps (real extensions vs website observers)', () => {
  const joinsOf = (kind: string, n: number, key = 'r') =>
    Array.from({ length: n }, (_, i) => ({ t: 'join', connId: `${kind[0]}${i}`, key, kind }));

  test('website observers have their own pool, capped at WEBSITE_CAP', () => {
    const r = run(joinsOf('website', WEBSITE_CAP + 1));
    const over = `w${WEBSITE_CAP}`;
    expect(r.log).toContainEqual({ t: 'send', connId: over, msg: { t: 'full' } });
    expect(r.log).toContainEqual({ t: 'close', connId: over });
    expect(r.state.rooms.r).toHaveLength(WEBSITE_CAP); // the over-cap observer never entered
  });

  test('pools are independent: a full website pool never blocks extensions', () => {
    // Fill website to its cap, then extensions still get all ROOM_CAP slots.
    const r = run([...joinsOf('website', WEBSITE_CAP), ...joinsOf('extension', ROOM_CAP)]);
    expect(r.state.rooms.r).toHaveLength(WEBSITE_CAP + ROOM_CAP); // both pools full, nobody rejected
    // each pool now rejects its OWN over-cap joiner, independently
    const wExtra = signalingStep(r.state, { t: 'join', connId: 'w-extra', key: 'r', kind: 'website' });
    expect(wExtra.actions as any[]).toContainEqual({ t: 'send', connId: 'w-extra', msg: { t: 'full' } });
    const eExtra = signalingStep(r.state, { t: 'join', connId: 'e-extra', key: 'r', kind: 'extension' });
    expect(eExtra.actions as any[]).toContainEqual({ t: 'send', connId: 'e-extra', msg: { t: 'full' } });
  });

  test('an extension joins fine when the website pool is full', () => {
    const filledWeb = run(joinsOf('website', WEBSITE_CAP));
    const r = signalingStep(filledWeb.state, { t: 'join', connId: 'ext1', key: 'r', kind: 'extension' });
    expect(r.actions as any[]).toContainEqual({ t: 'send', connId: 'ext1', msg: { t: 'room', self: 'ext1', members: filledWeb.state.rooms.r } });
    expect(r.actions.find((a: any) => a.connId === 'ext1' && a.msg?.t === 'full')).toBeUndefined();
  });

  test('a join with no kind counts as an extension (back-compat), and a website still gets in past a full extension pool', () => {
    const joins = Array.from({ length: ROOM_CAP + 1 }, (_, i) => ({ t: 'join', connId: `c${i}`, key: 'r' }));
    const r = run(joins);
    expect(r.log).toContainEqual({ t: 'send', connId: `c${ROOM_CAP}`, msg: { t: 'full' } }); // 17th extension rejected
    const w = signalingStep(r.state, { t: 'join', connId: 'w', key: 'r', kind: 'website' });
    expect(w.actions.find((a: any) => a.connId === 'w' && a.msg?.t === 'full')).toBeUndefined(); // website unaffected
    expect(w.state.rooms.r).toContain('w');
  });

  test('leaving frees a slot for that kind', () => {
    const filled = run(joinsOf('website', WEBSITE_CAP));
    const afterLeave = signalingStep(filled.state, { t: 'leave', connId: 'w0' });
    const r = signalingStep(afterLeave.state, { t: 'join', connId: 'w-new', key: 'r', kind: 'website' });
    expect(r.state.rooms.r).toContain('w-new');
    expect(r.actions.find((a: any) => a.connId === 'w-new' && a.msg?.t === 'full')).toBeUndefined();
  });
});


describe('negotiated sparse public membership', () => {
  const join = (connId: string, key = PUBLIC_ROOM, profile: string | undefined = SPARSE_PUBLIC_PROFILE, kind = 'extension') =>
    ({ t: 'join', connId, key, profile, kind });
  const messages = (actions: ReturnType<typeof signalingStep>['actions']) => actions.flatMap(a => a.t === 'send' ? [a.msg] : []);

  test('production reducer admits a large membership with bounded introduction work and a hard combined ceiling', () => {
    let state = initialSignalingState();
    for (let index = 0; index < PUBLIC_MEMBERSHIP_CAP - ROOM_CAP - WEBSITE_CAP; index++) {
      const result = signalingStep(state, join(`s${index}`), { now: 100, random: () => 0.5 });
      state = result.state;
      expect(result.actions.length).toBeLessThanOrEqual(INTRODUCTION_LIMIT + 1);
      const reply = messages(result.actions)[0];
      expect(reply).toMatchObject({ t: 'room', profile: SPARSE_PUBLIC_PROFILE,
        sampleLimit: INTRODUCTION_LIMIT, sampleIntervalMs: SAMPLE_INTERVAL_MS });
      expect(reply.members.length).toBeLessThanOrEqual(INTRODUCTION_LIMIT);
      expect(new Set(reply.members).size).toBe(reply.members.length);
      expect(reply.members).not.toContain(`s${index}`);
    }
    expect(messages(signalingStep(state, join('s-over')).actions)).toEqual([{ t: 'full' }]);
    // Reserve the existing pools: sparse occupants cannot consume their slots.
    for (const [kind, count] of [['extension', ROOM_CAP], ['website', WEBSITE_CAP]] as const) {
      for (let index = 0; index < count; index++) {
        const result = signalingStep(state, join(`${kind}${index}`, PUBLIC_ROOM, 'legacy', kind));
        state = result.state;
        expect(messages(result.actions)[0].members.length).toBeLessThanOrEqual(INTRODUCTION_LIMIT);
        expect(messages(result.actions)[0].profile).toBeUndefined();
      }
    }
    expect(state.rooms[PUBLIC_ROOM]).toHaveLength(PUBLIC_MEMBERSHIP_CAP);
    expect(messages(signalingStep(state, join('extra')).actions)).toEqual([{ t: 'full' }]);
    const left = signalingStep(state, { t: 'leave', connId: 's0' });
    expect(left.actions).toEqual([]);
    expect(left.state.sparse?.s0).toBeUndefined();
  });

  test('sampling is correlated, excludes self, stays bounded, and cannot bypass its lease or enrollment', () => {
    const state = run(Array.from({ length: 40 }, (_, i) => join(`s${i}`))).state;
    const sample = (requestId: unknown, now: number, current = state, connId = 's0') =>
      signalingStep(current, { t: 'sample', connId, requestId }, { now, random: () => 0 });
    for (const requestId of [null, {}, [], 4, '', 'x'.repeat(65), 'bad space', '__bad!']) {
      expect(sample(requestId, SAMPLE_INTERVAL_MS).actions).toEqual([]);
    }
    expect(sample('early', SAMPLE_INTERVAL_MS - 1).actions).toEqual([]);
    const result = sample('request_1', SAMPLE_INTERVAL_MS);
    const reply = messages(result.actions)[0];
    expect(result.actions).toHaveLength(1);
    expect(reply).toMatchObject({ t: 'sample', requestId: 'request_1' });
    expect(reply.members).toHaveLength(INTRODUCTION_LIMIT);
    expect(reply.members).not.toContain('s0');
    expect(reply.members).toContain('s39'); // injected entropy can introduce later arrivals
    expect(sample('again', SAMPLE_INTERVAL_MS, result.state).actions).toEqual([]);
    expect(sample('later', 2 * SAMPLE_INTERVAL_MS, result.state).actions).toHaveLength(1);
    expect(sample('not-enrolled', 2 * SAMPLE_INTERVAL_MS, state, 'unknown').actions).toEqual([]);
    expect(state.sparse?.s0).toBe(0); // reducer did not mutate the input
  });

  test('private/self and unnegotiated public rooms retain complete legacy semantics', () => {
    for (const key of ['private-code', 'self-device-code', PUBLIC_ROOM]) {
      const events = Array.from({ length: ROOM_CAP }, (_, i) => join(`l${i}`, key, key === PUBLIC_ROOM ? 'future-profile' : SPARSE_PUBLIC_PROFILE));
      const { state, log } = run(events);
      expect(state.sparse).toBeUndefined();
      expect(log.filter(a => a.msg?.t === 'room').at(-1).msg.members).toHaveLength(ROOM_CAP - 1);
      expect(messages(signalingStep(state, join('over', key, 'unknown')).actions)).toEqual([{ t: 'full' }]);
      expect(signalingStep(state, { t: 'sample', connId: 'l0', requestId: 'x' }, { now: SAMPLE_INTERVAL_MS }).actions).toEqual([]);
      expect(signalingStep(state, { t: 'leave', connId: 'l0' }).actions).toHaveLength(ROOM_CAP - 1);
    }
  });

  test('last sparse departure stays bounded and restores only the small legacy roster', () => {
    let state = run([{ t: 'join', connId: 'legacy', key: PUBLIC_ROOM }, join('sparse')]).state;
    const result = signalingStep(state, { t: 'leave', connId: 'sparse' });
    expect(result.actions).toEqual([]);
    state = result.state;
    expect(state.sparse).toBeUndefined();
    const next = signalingStep(state, { t: 'join', connId: 'legacy2', key: PUBLIC_ROOM });
    expect(messages(next.actions)).toEqual([{ t: 'room', self: 'legacy2', members: ['legacy'] }, { t: 'joined', member: 'legacy2' }]);
    const cross = run([join('s'), { t: 'join', connId: 'l', key: PUBLIC_ROOM }, { t: 'join', connId: 'private', key: 'private' }]).state;
    const payload = { arbitrary: 'opaque' };
    expect(messages(signalingStep(cross, { t: 'signal', connId: 's', to: 'l', payload }).actions)).toEqual([{ t: 'signal', from: 's', payload }]);
    expect(signalingStep(cross, { t: 'signal', connId: 's', to: 'private', payload }).actions).toEqual([]);
  });
});
