import { describe, test, expect } from 'bun:test';
import {
  signalingStep,
  initialSignalingState,
  ROOM_CAP,
  WEBSITE_CAP,
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
