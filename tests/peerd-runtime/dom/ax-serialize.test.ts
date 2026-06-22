import { describe, test, expect } from 'bun:test';
import { serializeAxTree } from '../../../extension/peerd-runtime/dom/ax-serialize.js';

// A small CDP-shaped a11y tree: a Gmail-ish compose form. WebArea (root,
// not emitted) → form "Compose" → [heading, Subject textbox, Body textbox
// with value, disabled Send button].
const composeTree = {
  nodes: [
    { nodeId: '1', role: { value: 'WebArea' }, name: { value: 'Gmail' }, childIds: ['2'] },
    { nodeId: '2', parentId: '1', role: { value: 'form' }, name: { value: 'Compose' }, childIds: ['3', '4', '5', '6'] },
    { nodeId: '3', parentId: '2', role: { value: 'heading' }, name: { value: 'New Message' }, properties: [{ name: 'level', value: { value: 2 } }], childIds: [] },
    { nodeId: '4', parentId: '2', role: { value: 'textbox' }, name: { value: 'Subject' }, value: { value: '' }, backendDOMNodeId: 44, childIds: [] },
    { nodeId: '5', parentId: '2', role: { value: 'textbox' }, name: { value: 'Body' }, value: { value: 'hi there' }, backendDOMNodeId: 55, childIds: [] },
    { nodeId: '6', parentId: '2', role: { value: 'button' }, name: { value: 'Send' }, properties: [{ name: 'disabled', value: { value: true } }], backendDOMNodeId: 66, childIds: [] },
  ],
};

describe('serializeAxTree', () => {
  test('assigns @e refs only to interactable nodes, in document order', () => {
    const { refs, refCount } = serializeAxTree(composeTree);
    expect(refCount).toBe(3);
    expect(refs.map((r) => r.ref)).toEqual(['@e1', '@e2', '@e3']);
    expect(refs[0]).toMatchObject({ ref: '@e1', role: 'textbox', name: 'Subject', backendDOMNodeId: 44 });
    expect(refs[2]).toMatchObject({ ref: '@e3', role: 'button', name: 'Send', backendDOMNodeId: 66 });
  });

  test('renders state: empty value, filled value, disabled', () => {
    const { text } = serializeAxTree(composeTree);
    expect(text).toContain('@e1 textbox "Subject" [value=""]');
    expect(text).toContain('@e2 textbox "Body" [value="hi there"]');
    expect(text).toContain('@e3 button "Send" [disabled]');
  });

  test('shows context roles (heading) WITHOUT a ref', () => {
    const { text } = serializeAxTree(composeTree);
    expect(text).toContain('heading "New Message" (h2)');
    // the heading line carries no @e ref
    const headingLine = text.split('\n').find((l) => l.includes('New Message'))!;
    expect(headingLine).not.toContain('@e');
  });

  test('skips ignored + generic wrapper nodes but keeps their children', () => {
    const tree = {
      nodes: [
        { nodeId: '1', role: { value: 'WebArea' }, childIds: ['2'] },
        { nodeId: '2', parentId: '1', role: { value: 'generic' }, childIds: ['3'] },     // skipped
        { nodeId: '3', parentId: '2', ignored: true, role: { value: 'button' }, name: { value: 'Hidden' }, childIds: ['4'] }, // ignored
        { nodeId: '4', parentId: '3', role: { value: 'button' }, name: { value: 'Real' }, backendDOMNodeId: 9, childIds: [] },
      ],
    };
    const { refs, text } = serializeAxTree(tree);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ ref: '@e1', name: 'Real' });
    expect(text).not.toContain('Hidden');
  });

  test('respects the char budget and flags truncation', () => {
    const { truncated, text } = serializeAxTree(composeTree, { budget: 30 });
    expect(truncated).toBe(true);
    expect(text).toContain('truncated');
  });

  test('handles an empty tree without throwing', () => {
    const r = serializeAxTree({ nodes: [] });
    expect(r.refs).toEqual([]);
    expect(r.text).toBe('');
  });

  // Grounded in a REAL page: httpbin.org/forms/post, whose live a11y tree
  // (read via Claude-in-Chrome) is textbox×5, radio×3, checkbox×4,
  // button×1 — every role in our INTERACTABLE set. This asserts the
  // serializer covers a real multi-input form, not just the toy fixture.
  test('real-world form (httpbin pizza order): refs all interactables', () => {
    const mk = (id: string, role: string, name: string, backend: number, props: any[] = []) =>
      ({ nodeId: id, parentId: 'F', role: { value: role }, name: { value: name }, properties: props, backendDOMNodeId: backend, childIds: [] });
    const nodes = [
      { nodeId: 'R', role: { value: 'WebArea' }, childIds: ['F'] },
      { nodeId: 'F', parentId: 'R', role: { value: 'form' }, name: { value: 'Pizza order' }, childIds: ['c','t','e','s1','s2','s3','t1','t2','t3','t4','tm','co','b'] },
      mk('c', 'textbox', 'Customer name', 10),
      mk('t', 'textbox', 'Telephone', 11),
      mk('e', 'textbox', 'E-mail address', 12),
      mk('s1', 'radio', 'small', 13, [{ name: 'checked', value: { value: 'false' } }]),
      mk('s2', 'radio', 'medium', 14, [{ name: 'checked', value: { value: 'true' } }]),
      mk('s3', 'radio', 'large', 15, [{ name: 'checked', value: { value: 'false' } }]),
      mk('t1', 'checkbox', 'bacon', 16, [{ name: 'checked', value: { value: 'true' } }]),
      mk('t2', 'checkbox', 'cheese', 17, [{ name: 'checked', value: { value: 'false' } }]),
      mk('t3', 'checkbox', 'onion', 18, [{ name: 'checked', value: { value: 'false' } }]),
      mk('t4', 'checkbox', 'mushroom', 19, [{ name: 'checked', value: { value: 'false' } }]),
      mk('tm', 'textbox', 'Preferred delivery time', 20),
      mk('co', 'textbox', 'Delivery instructions', 21),
      mk('b', 'button', 'Submit order', 22),
    ];
    const { refs, refCount, text } = serializeAxTree({ nodes });
    expect(refCount).toBe(13); // 5 textbox + 3 radio + 4 checkbox + 1 button
    expect(refs.filter((r) => r.role === 'radio')).toHaveLength(3);
    expect(refs.filter((r) => r.role === 'checkbox')).toHaveLength(4);
    expect(text).toContain('radio "medium" [checked]');
    expect(text).toContain('checkbox "bacon" [checked]');
    expect(text).toContain('checkbox "cheese" [unchecked]');
    expect(text.split('\n').find((l) => l.includes('Submit order'))).toContain('button "Submit order"');
  });
});

// DOM-walk pseudo-snapshot nodes (walk-injected.js) reuse the CDP node
// shape but identify elements by walkId — the serializer must carry it
// through to the ref table so click/type can resolve walk refs.
describe('serializeAxTree — walkId passthrough', () => {
  test('refs carry walkId when present, null when not', () => {
    const nodes = [
      { nodeId: 'w0', role: { value: 'RootWebArea' }, childIds: ['w1', 'x'] },
      { nodeId: 'w1', parentId: 'w0', role: { value: 'button' }, name: { value: 'Send' }, properties: [], backendDOMNodeId: null, walkId: 42, childIds: [] },
      { nodeId: 'x', parentId: 'w0', role: { value: 'button' }, name: { value: 'CDP' }, properties: [], backendDOMNodeId: 7, childIds: [] },
    ];
    const { refs } = serializeAxTree({ nodes });
    expect(refs[0]).toMatchObject({ ref: '@e1', walkId: 42, backendDOMNodeId: null });
    expect(refs[1]).toMatchObject({ ref: '@e2', walkId: null, backendDOMNodeId: 7 });
  });
});
