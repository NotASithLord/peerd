// The context inspector's capture ring: shaping (clips + binary strip,
// never throws), the per-session cap, idle-session eviction, and the
// copy-on-read contract. Pure factory — no browser.

import { describe, test, expect } from 'bun:test';
import {
  createContextSnapshots, shapeModelCall,
  SNAPSHOTS_PER_SESSION, SNAPSHOT_CONTENT_CHARS, SNAPSHOT_MAX_MESSAGES,
} from '../../extension/background/context-snapshots.js';

describe('shapeModelCall — bounded and binary-free', () => {
  test('clips long content, keeps structure, strips base64 with a visible sentinel', () => {
    const shaped = shapeModelCall({
      provider: 'anthropic', model: 'claude-x',
      system: 's'.repeat(10_000),
      tools: [{ name: 'script', input_schema: {} }, { name: 'message_actor' }],
      messages: [
        { role: 'user', content: 'x'.repeat(5000), attachments: [{ name: 'shot.png', mediaType: 'image/png', size: 12345, data: 'AAAA'.repeat(90_000) }] },
        { role: 'assistant', content: 'ok', toolUses: [{ name: 'script', input: { code: 'y'.repeat(3000) } }] },
        { role: 'user', content: '', toolResults: [{ tool_use_id: 't1', is_error: false, content: 'z'.repeat(9000), images: ['<big>'] }] },
      ],
    });
    expect(shaped.system.length).toBeLessThanOrEqual(6000);
    expect(shaped.systemChars).toBe(10_000);                       // the true size is preserved as metadata
    expect(shaped.tools).toEqual(['script', 'message_actor']);
    expect(shaped.messages[0].content.length).toBeLessThanOrEqual(SNAPSHOT_CONTENT_CHARS);
    expect(shaped.messages[0].attachments![0].data).toContain('stripped');
    expect(JSON.stringify(shaped)).not.toContain('AAAAAAAA');      // no base64 survives
    expect(shaped.messages[2].toolResults![0].images).toContain('stripped');
  });

  test('caps message count and reports what was dropped', () => {
    const many = Array.from({ length: SNAPSHOT_MAX_MESSAGES + 15 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    const shaped = shapeModelCall({ messages: many });
    expect(shaped.messages.length).toBe(SNAPSHOT_MAX_MESSAGES);
    expect(shaped.droppedMessages).toBe(15);
    expect(shaped.messages[0].content).toBe('m15');                // the OLDEST are what's dropped
  });

  test('EVERY worker-controllable field is bounded (a compromised heap cannot bloat the ring)', () => {
    const shaped = shapeModelCall({
      provider: 'p'.repeat(10_000), model: 'm'.repeat(10_000),
      reasoning: { blob: 'r'.repeat(100_000) },
      tools: Array.from({ length: 500 }, (_, i) => ({ name: `t${i}`.repeat(1000) })),
      messages: [{
        role: 'x'.repeat(500), content: '',
        toolUses: Array.from({ length: 500 }, () => ({ name: 'n'.repeat(9000), input: {} })),
        toolResults: Array.from({ length: 500 }, () => ({ tool_use_id: 'i'.repeat(9000), content: '' })),
        attachments: Array.from({ length: 500 }, () => ({ name: 'a'.repeat(9000), mediaType: 'z'.repeat(9000), size: 1 })),
      }],
    });
    expect(shaped.provider.length).toBeLessThanOrEqual(200);
    expect(shaped.model.length).toBeLessThanOrEqual(200);
    expect((shaped.reasoning as string).length).toBeLessThanOrEqual(400);
    expect(shaped.tools.length).toBe(50);
    expect(shaped.tools[0].length).toBeLessThanOrEqual(120);
    const msg = shaped.messages[0];
    expect(msg.role.length).toBeLessThanOrEqual(40);
    expect(msg.toolUses!.length).toBe(50);
    expect(msg.toolUses![0].name.length).toBeLessThanOrEqual(120);
    expect(msg.toolResults!.length).toBe(50);
    expect(msg.toolResults![0].tool_use_id.length).toBeLessThanOrEqual(120);
    expect(msg.attachments!.length).toBe(20);
    expect(msg.attachments![0].name.length).toBeLessThanOrEqual(200);
    // the whole snapshot stays small even under a hostile payload
    expect(JSON.stringify(shaped).length).toBeLessThan(120_000);
  });

  test('degenerate shapes never throw', () => {
    expect(() => shapeModelCall(undefined as any)).not.toThrow();
    expect(shapeModelCall({ messages: 'not-an-array' as any }).messages).toEqual([]);
    expect(shapeModelCall({ system: { odd: true } as any }).systemChars).toBe(0);
  });
});

describe('createContextSnapshots — the ring', () => {
  test('caps per session at the limit, oldest out first', () => {
    let t = 0;
    const ring = createContextSnapshots({ now: () => ++t });
    for (let i = 0; i < SNAPSHOTS_PER_SESSION + 3; i++) {
      ring.record({ sessionId: 's1', label: 'main', provider: 'p', model: 'm', messages: [{ role: 'user', content: `call ${i}` }] });
    }
    const snaps = ring.snapshotsFor('s1');
    expect(snaps.length).toBe(SNAPSHOTS_PER_SESSION);
    expect(snaps[0].messages[0].content).toBe('call 3');           // 0..2 evicted
    expect(snaps.at(-1)!.messages[0].content).toBe(`call ${SNAPSHOTS_PER_SESSION + 2}`);
  });

  test('evicts the oldest-touched session when the session cap is hit', () => {
    let t = 0;
    const ring = createContextSnapshots({ maxSessions: 2, now: () => ++t });
    ring.record({ sessionId: 'old', messages: [] });
    ring.record({ sessionId: 'mid', messages: [] });
    ring.record({ sessionId: 'new', messages: [] });
    expect(ring._size()).toBe(2);
    expect(ring.snapshotsFor('old')).toEqual([]);
    expect(ring.snapshotsFor('new').length).toBe(1);
  });

  test('snapshotsForMany merges sessions in capture order; reads are copies', () => {
    let t = 0;
    const ring = createContextSnapshots({ now: () => ++t });
    ring.record({ sessionId: 'root', label: 'main', messages: [] });
    ring.record({ sessionId: 'child', label: 'actor:web', messages: [] });
    ring.record({ sessionId: 'root', label: 'main', messages: [] });
    const merged = ring.snapshotsForMany(['root', 'child']);
    expect(merged.map((s) => s.label)).toEqual(['main', 'actor:web', 'main']);
    merged[0].label = 'tampered';
    expect(ring.snapshotsFor('root')[0].label).toBe('main');       // the store is untouched
  });

  test('recording without a sessionId is a silent no-op (capture is best-effort)', () => {
    const ring = createContextSnapshots();
    expect(() => ring.record({} as any)).not.toThrow();
    expect(ring._size()).toBe(0);
  });

  test('limits() reports the caps the bundle provenance needs', () => {
    expect(createContextSnapshots({ capPerSession: 7 }).limits().snapshotsPerSession).toBe(7);
  });
});
