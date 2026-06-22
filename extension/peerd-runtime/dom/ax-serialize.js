// @ts-check
// peerd-runtime/dom — accessibility-tree serializer (DOM nav, Phase 1).
//
// Pure transform: CDP `Accessibility.getFullAXTree` output → a compact,
// ref-annotated text snapshot the model reasons over, plus the ref table
// the harness uses to resolve an action back to a real DOM node.
//
// This is the keystone of the a11y-tree-+-refs paradigm shift (see
// docs/DOM-NAVIGATION-ASSESSMENT.md). The model NEVER authors a CSS
// selector — it picks `@e<n>` refs from this output; the ref registry maps
// each ref to a `backendDOMNodeId` for CDP dispatch. That kills the entire
// "model generated a selector that doesn't exist" failure class.
//
// PURE (values in, values out), so it is fully unit-testable without a
// browser — the half of the DOM layer we CAN verify headlessly. The CDP
// fetch + click live in the imperative shell (background/debugger-pool.js).

// Roles that earn an actionable ref (the model can click/type/focus them).
const INTERACTABLE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
  'checkbox', 'radio', 'switch', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'slider', 'spinbutton', 'textarea', 'treeitem',
  'gridcell',
]);

// Roles shown for STRUCTURE/context (no ref — not directly actionable, but
// they orient the model: which form, which dialog, which heading).
const CONTEXT = new Set([
  'heading', 'navigation', 'main', 'banner', 'contentinfo', 'form', 'search',
  'dialog', 'alertdialog', 'region', 'article', 'list', 'table', 'tablist',
  'menu', 'menubar', 'toolbar', 'tabpanel', 'status', 'alert',
]);

// Never emit a line for these — pure wrappers / noise.
const SKIP = new Set([
  'generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak',
  'StaticText', 'image', 'separator', 'paragraph', 'LayoutTable',
  'LayoutTableRow', 'LayoutTableCell', 'ScrollArea', 'group',
]);

/**
 * A node from CDP `Accessibility.getFullAXTree` (or the DOM-walk
 * pseudo-tree, which mirrors this shape). The CDP payload is dynamic JSON,
 * so fields are all optional; only the subset the serializer reads is typed.
 *
 * @typedef {Object} AxNode
 * @property {string} [nodeId]
 * @property {string} [parentId]
 * @property {string[]} [childIds]
 * @property {boolean} [ignored]
 * @property {number | null} [backendDOMNodeId]
 * @property {number | null} [walkId]
 * @property {{ value?: string }} [role]
 * @property {{ value?: string }} [name]
 * @property {{ value?: unknown }} [value]
 * @property {Array<{ name?: string, value?: { value?: unknown } }>} [properties]
 */

/** @param {AxNode} node @returns {Record<string, unknown>} */
const propMap = (node) => {
  /** @type {Record<string, unknown>} */
  const m = {};
  for (const p of node.properties ?? []) {
    if (p && p.name) m[p.name] = p.value ? p.value.value : undefined;
  }
  return m;
};

/** @param {unknown} s @param {number} n */
const truncate = (s, n) => {
  const str = String(s ?? '');
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
};

// Bracketed state suffix for an interactable node: value, disabled,
// checked, expanded, etc. — the state the model needs to decide its next
// action ("is Send enabled yet?", "is this checkbox already checked?").
/**
 * @param {string} role
 * @param {Record<string, unknown>} props
 * @param {unknown} valueText
 */
const stateSuffix = (role, props, valueText) => {
  const bits = [];
  const isField = role === 'textbox' || role === 'searchbox'
    || role === 'combobox' || role === 'textarea' || role === 'spinbutton';
  if (valueText !== undefined && valueText !== '') bits.push(`value="${truncate(valueText, 40)}"`);
  else if (isField) bits.push('value=""');
  if (props.disabled === true) bits.push('disabled');
  if (props.required === true) bits.push('required');
  if (props.invalid !== undefined && props.invalid !== 'false' && props.invalid !== false) bits.push('invalid');
  if (props.checked !== undefined && props.checked !== 'false' && props.checked !== false) {
    bits.push(props.checked === 'mixed' ? 'mixed' : 'checked');
  } else if ((role === 'checkbox' || role === 'radio' || role === 'switch') && (props.checked === 'false' || props.checked === false)) {
    bits.push('unchecked');
  }
  if (props.expanded === true) bits.push('expanded');
  else if (props.expanded === false) bits.push('collapsed');
  if (props.selected === true) bits.push('selected');
  if (props.focused === true) bits.push('focused');
  return bits.length ? ` [${bits.join(' ')}]` : '';
};

/**
 * Serialize a CDP a11y tree into ref-annotated text + the ref table.
 *
 * @param {{nodes: AxNode[]}|AxNode[]} input  getFullAXTree result, or its .nodes
 * @param {{ budget?: number }} [opts]  char budget for the text (default 8000)
 * @returns {{
 *   text: string,
 *   refs: Array<{ ref: string, backendDOMNodeId: number|null, role: string, name: string }>,
 *   truncated: boolean,
 *   nodeCount: number,
 *   refCount: number,
 * }}
 */
export const serializeAxTree = (input, { budget = 8000 } = {}) => {
  const nodes = Array.isArray(input) ? input : (input?.nodes ?? []);
  /** @type {Map<string, AxNode>} */
  const byId = new Map();
  for (const n of nodes) if (n && n.nodeId) byId.set(n.nodeId, n);
  // Root: the node nothing else parents. Fall back to the first node.
  const root = nodes.find((n) => n && !n.parentId) ?? nodes[0];

  /** @type {string[]} */
  const lines = [];
  /** @type {Array<{ ref: string, backendDOMNodeId: number|null, walkId: number|null, role: string, name: string, desc: string }>} */
  const refs = [];
  let seq = 0;
  let chars = 0;
  let truncated = false;

  /** @param {string} line */
  const pushLine = (line) => {
    if (chars + line.length + 1 > budget) { truncated = true; return false; }
    lines.push(line);
    chars += line.length + 1;
    return true;
  };

  // Iterative DFS with an explicit stack so a pathological tree can't blow
  // the JS call stack. `vdepth` is the VISIBLE depth (only emitted nodes
  // add indentation), so generic wrappers don't balloon the indent.
  /** @type {Array<{ node: AxNode | undefined, vdepth: number }>} */
  const stack = [{ node: root, vdepth: 0 }];
  /** @type {Set<string>} */
  const visited = new Set();
  while (stack.length && !truncated) {
    // why: the `stack.length` guard above means pop() is non-empty here.
    const { node, vdepth } = /** @type {{ node: AxNode | undefined, vdepth: number }} */ (stack.pop());
    if (!node || !node.nodeId || visited.has(node.nodeId)) continue;
    visited.add(node.nodeId);

    let emitted = false;
    const role = node.role?.value;
    const name = (node.name?.value ?? '').trim();
    if (node.ignored !== true && role && !SKIP.has(role)) {
      const props = propMap(node);
      const indent = '  '.repeat(Math.min(vdepth, 12));
      if (INTERACTABLE.has(role)) {
        seq += 1;
        const ref = `@e${seq}`;
        // desc = the node's rendered descriptor WITHOUT indent/ref, so two
        // snapshots can be diffed by backendDOMNodeId (refs reallocate).
        const desc = `${role}${name ? ` "${truncate(name, 80)}"` : ''}${stateSuffix(role, props, node.value?.value)}`;
        if (pushLine(`${indent}${ref} ${desc}`)) {
          refs.push({
            ref,
            backendDOMNodeId: node.backendDOMNodeId ?? null,
            // walkId: the DOM-walk pseudo-snapshot's element identity
            // (walk-injected.js). null on CDP-sourced trees; click/type
            // resolve it via scripting where there's no backendDOMNodeId.
            walkId: node.walkId ?? null,
            role, name, desc,
          });
          emitted = true;
        } else {
          seq -= 1; // rolled back: the line didn't fit
        }
      } else if (CONTEXT.has(role) && (name || role === 'heading')) {
        const lvl = role === 'heading' && props.level ? ` (h${props.level})` : '';
        if (pushLine(`${indent}${role}${name ? ` "${truncate(name, 80)}"` : ''}${lvl}`)) {
          emitted = true;
        }
      }
    }

    // Push children in reverse so DFS visits them in document order.
    const kids = node.childIds ?? [];
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push({ node: byId.get(kids[i]), vdepth: emitted ? vdepth + 1 : vdepth });
    }
  }

  if (truncated) {
    lines.push(`… [snapshot truncated at ${budget} chars — focus a smaller region or tab]`);
  }

  return {
    text: lines.join('\n'),
    refs,
    truncated,
    nodeCount: nodes.length,
    refCount: refs.length,
  };
};
