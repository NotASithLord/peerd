import { describe, test, expect } from 'bun:test';
import { diffSnapshots } from '../../../extension/peerd-runtime/dom/snapshot-diff.js';

// Refs reallocate every snapshot, so the diff keys on the stable
// backendDOMNodeId, not the @e ref string.
const prev = [
  { ref: '@e1', backendDOMNodeId: 1, role: 'textbox', name: 'Subject', desc: 'textbox "Subject" [value=""]' },
  { ref: '@e2', backendDOMNodeId: 2, role: 'button', name: 'Send', desc: 'button "Send" [disabled]' },
  { ref: '@e3', backendDOMNodeId: 3, role: 'button', name: 'Cancel', desc: 'button "Cancel"' },
];
const next = [
  { ref: '@e1', backendDOMNodeId: 1, role: 'textbox', name: 'Subject', desc: 'textbox "Subject" [value="hi"]' }, // changed
  { ref: '@e2', backendDOMNodeId: 2, role: 'button', name: 'Send', desc: 'button "Send"' },                       // changed (enabled)
  { ref: '@e3', backendDOMNodeId: 4, role: 'button', name: 'Attach', desc: 'button "Attach"' },                   // added (new node 4)
  // node 3 (Cancel) is gone → removed
];

describe('diffSnapshots', () => {
  test('classifies added / removed / changed by node identity', () => {
    const d = diffSnapshots(prev, next);
    expect(d.added.map((r) => r.name)).toEqual(['Attach']);
    expect(d.removed.map((r) => r.name)).toEqual(['Cancel']);
    expect(d.changed.map((c) => c.after.name).sort()).toEqual(['Send', 'Subject']);
    expect(d.unchanged).toBe(0);
  });

  test('renders a compact +/~/- diff with the NEW refs', () => {
    const { text } = diffSnapshots(prev, next);
    expect(text).toContain('+ @e3 button "Attach"');
    expect(text).toContain('- button "Cancel"');
    expect(text).toContain('~ @e1 textbox "Subject": textbox "Subject" [value=""] → textbox "Subject" [value="hi"]');
  });

  test('no change → explicit "no change" line, nothing classified', () => {
    const d = diffSnapshots(prev, prev);
    expect(d.text).toBe('no change since last snapshot');
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
    expect(d.unchanged).toBe(3);
  });

  test('empty prev → everything is added', () => {
    const d = diffSnapshots([], next);
    expect(d.added).toHaveLength(3);
    expect(d.removed).toHaveLength(0);
  });
});

// DOM-walk pseudo-snapshots (Firefox / advanced automation off) have no
// backendDOMNodeId — identity is the walkId the injected walk keeps stable
// per element within one document.
describe('diffSnapshots — walkId identity', () => {
  const wPrev = [
    { ref: '@e1', backendDOMNodeId: null, walkId: 10, role: 'button', name: 'Send', desc: 'button "Send" [disabled]' },
    { ref: '@e2', backendDOMNodeId: null, walkId: 11, role: 'button', name: 'Cancel', desc: 'button "Cancel"' },
  ];
  const wNext = [
    { ref: '@e1', backendDOMNodeId: null, walkId: 10, role: 'button', name: 'Send', desc: 'button "Send"' }, // enabled
    { ref: '@e2', backendDOMNodeId: null, walkId: 12, role: 'link', name: 'Help', desc: 'link "Help"' },     // new
  ];

  test('keys on walkId when backendDOMNodeId is absent', () => {
    const d = diffSnapshots(wPrev, wNext);
    expect(d.changed.map((c) => c.after.name)).toEqual(['Send']);
    expect(d.added.map((r) => r.name)).toEqual(['Help']);
    expect(d.removed.map((r) => r.name)).toEqual(['Cancel']);
  });

  test('CDP ids and walk ids never alias (b/w namespaces)', () => {
    // Same numeric value, different id space → treated as different nodes.
    const cdp = [{ ref: '@e1', backendDOMNodeId: 10, role: 'button', name: 'Send', desc: 'button "Send"' }];
    const walk = [{ ref: '@e1', backendDOMNodeId: null, walkId: 10, role: 'button', name: 'Send', desc: 'button "Send"' }];
    const d = diffSnapshots(cdp, walk);
    expect(d.added).toHaveLength(1);
    expect(d.removed).toHaveLength(1);
    expect(d.unchanged).toBe(0);
  });
});
