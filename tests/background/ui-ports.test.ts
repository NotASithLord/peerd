import { describe, test, expect } from 'bun:test';
import { makeUiPorts } from '../../extension/background/ui-ports.js';

// DESIGN-12: the SW fans session state + confirm prompts out to EVERY open UI
// surface (side panel + home), not one singleton. These pin the registry's
// contract — the part the multi-port refactor depends on.

const mockPort = (name?: string) => {
  const sent: unknown[] = [];
  return { name, sent, postMessage: (m: unknown) => { sent.push(m); } };
};

describe('makeUiPorts', () => {
  test('broadcasts to every connected port', () => {
    const ui = makeUiPorts();
    const a = mockPort('sidepanel');
    const b = mockPort('home');
    ui.add(a); ui.add(b);
    expect(ui.size).toBe(2);

    ui.broadcast({ type: 'state', n: 1 });
    expect(a.sent).toEqual([{ type: 'state', n: 1 }]);
    expect(b.sent).toEqual([{ type: 'state', n: 1 }]);
  });

  test('removed ports stop receiving; size tracks', () => {
    const ui = makeUiPorts();
    const a = mockPort(); const b = mockPort();
    ui.add(a); ui.add(b);
    ui.remove(a);
    expect(ui.size).toBe(1);
    expect(ui.has(a)).toBe(false);

    ui.broadcast({ x: 1 });
    expect(a.sent).toHaveLength(0);   // gone — no delivery
    expect(b.sent).toEqual([{ x: 1 }]);
  });

  test('a throwing port does not stop delivery to the others (fault isolation)', () => {
    const ui = makeUiPorts();
    const dead = { name: 'sidepanel', postMessage: () => { throw new Error('port closed'); } };
    const live = mockPort('home');
    ui.add(dead); ui.add(live);

    expect(() => ui.broadcast({ type: 'turn/delta' })).not.toThrow();
    expect(live.sent).toEqual([{ type: 'turn/delta' }]);  // still got it
  });

  test('empty registry: broadcast is a no-op, size 0 (confirm hang-protection reads this)', () => {
    const ui = makeUiPorts();
    expect(ui.size).toBe(0);
    expect(() => ui.broadcast({ any: true })).not.toThrow();
  });

  test('hasNamed reflects whether a surface of that name is connected', () => {
    const ui = makeUiPorts();
    const home = mockPort('home');
    const panel = mockPort('sidepanel');
    ui.add(home);
    expect(ui.hasNamed('sidepanel')).toBe(false);   // home alone → no panel
    ui.add(panel);
    expect(ui.hasNamed('sidepanel')).toBe(true);     // panel open
    expect(ui.hasNamed('home')).toBe(true);
    ui.remove(panel);
    expect(ui.hasNamed('sidepanel')).toBe(false);    // panel closed → home learns
  });

  test('adding the same port twice is idempotent (Set semantics)', () => {
    const ui = makeUiPorts();
    const a = mockPort();
    ui.add(a); ui.add(a);
    expect(ui.size).toBe(1);
    ui.broadcast({ y: 2 });
    expect(a.sent).toEqual([{ y: 2 }]);  // delivered once, not twice
  });
});
