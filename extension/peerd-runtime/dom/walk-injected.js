// peerd-runtime/dom — DOM-walk pseudo-snapshot (Firefox parity).
//
// Firefox has no chrome.debugger, so CDP Accessibility.getFullAXTree (the
// snapshot tool's observation channel) is unavailable there — and on Chrome
// it goes away when the user turns advanced automation off. This module is
// the recoverable half of that gap: a chrome.scripting-injected DOM walk
// that synthesizes a PSEUDO-a11y tree in the exact node shape
// serializeAxTree consumes (role/name/value/properties/childIds), so the
// snapshot contract — and everything downstream of it (ref registry,
// snapshot diff, runner pre-seeding) — works unchanged on the fallback.
//
// Element identity without backendDOMNodeId: the walk assigns each emitted
// element a STABLE numeric walkId via a WeakMap kept in the injected
// (isolated) world — the same world every executeScript call from this
// extension shares per document. Ids survive re-walks of the same document
// (so snapshot diff works) and die naturally with the document on
// navigation. A side Map (walkId → element) lets the click/type injected
// functions resolve a walk ref back to the live node later.
//
// HONEST LIMITS (also surfaced in the snapshot tool's result metadata):
//   - top frame only — CDP's tree spans same-process iframes, this doesn't;
//   - an approximation of the accessible name/role computation, not the
//     real AX tree the browser builds;
//   - Trusted-Types JS execution and trusted (isTrusted) input remain
//     CDP-only — this module deliberately does NOT fake them.
//
// Every function here is serialized by chrome.scripting.executeScript and
// re-evaluated in the page's classic-script world: each must be fully
// self-contained ('use strict', no closed-over imports) — see CLAUDE.md.

/**
 * Walk the page's DOM and synthesize a pseudo-a11y tree.
 *
 * Runs INSIDE the page (isolated world). Returns
 * `{ ok: true, nodes, refElementCount }` where `nodes` is a flat array in
 * the CDP getFullAXTree shape consumed by serializeAxTree — each node:
 * `{ nodeId, parentId?, childIds, role: {value}, name: {value},
 *    value?: {value}, properties: [{name, value:{value}}],
 *    backendDOMNodeId: null, walkId }`.
 */
export function domWalkInjected() {
  'use strict';
  // Hard bounds so a pathological page can't wedge the injected call.
  var MAX_VISITED = 30000;
  var MAX_EMITTED = 4000;

  // Stable per-element ids, persisted across walks of this document via
  // globals in the extension's isolated world (rebuilt per document —
  // navigation gives a fresh world, which is exactly the ref lifetime we
  // want). __peerdWalkEls is REBUILT each walk so it never holds strong
  // references to elements that left the DOM more than one walk ago.
  var idOf = globalThis.__peerdWalkIdOf;
  if (!idOf || typeof idOf.get !== 'function') {
    idOf = new WeakMap();
    globalThis.__peerdWalkIdOf = idOf;
    globalThis.__peerdWalkNextId = 1;
  }
  var els = new Map();
  globalThis.__peerdWalkEls = els;
  var takeId = function (el) {
    var id = idOf.get(el);
    if (id == null) {
      id = globalThis.__peerdWalkNextId++;
      idOf.set(el, id);
    }
    els.set(id, el);
    return id;
  };

  var INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button',
    file: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider',
    number: 'spinbutton', search: 'searchbox',
  };
  var TAG_ROLES = {
    button: 'button', summary: 'button', option: 'option', textarea: 'textbox',
    nav: 'navigation', main: 'main', form: 'form', dialog: 'dialog',
    article: 'article', ul: 'list', ol: 'list', menu: 'list', table: 'table',
    search: 'search', header: 'banner', footer: 'contentinfo',
  };
  var roleOf = function (el, tag) {
    var explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (explicit) return explicit.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'select') return (el.multiple || el.size > 1) ? 'listbox' : 'combobox';
    if (tag === 'input') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'hidden') return '';
      return INPUT_ROLES[t] || 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (TAG_ROLES[tag]) return TAG_ROLES[tag];
    // Only the ROOT of a contenteditable region is the text field.
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) {
      return 'textbox';
    }
    return '';
  };

  var collapse = function (s, n) {
    return (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  };
  var nameOf = function (el, tag) {
    var v = el.getAttribute('aria-label');
    if (v && v.trim()) return collapse(v, 120);
    var ids = el.getAttribute('aria-labelledby');
    if (ids) {
      var parts = [];
      ids.trim().split(/\s+/).forEach(function (id) {
        var ref = document.getElementById(id);
        if (ref) parts.push(collapse(ref.textContent, 80));
      });
      if (parts.length) return parts.join(' ').slice(0, 120);
    }
    if (el.labels && el.labels.length) {
      return collapse(el.labels[0].textContent, 120);
    }
    if (tag === 'input') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      if ((t === 'button' || t === 'submit' || t === 'reset') && el.value) return collapse(el.value, 120);
      if (t === 'image' && el.alt) return collapse(el.alt, 120);
    }
    var ph = el.getAttribute('placeholder');
    if (ph && ph.trim()) return collapse(ph, 120);
    // innerText (rendered text) beats textContent for buttons/links — it
    // skips display:none helpers; fall back to textContent for elements
    // that don't render (e.g. <option> in a closed select).
    var text = collapse(el.innerText != null ? el.innerText : el.textContent, 120);
    if (text) return text;
    var title = el.getAttribute('title');
    if (title && title.trim()) return collapse(title, 120);
    return '';
  };

  var valueOf = function (el, tag) {
    if (tag === 'input') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio' || t === 'button' || t === 'submit'
          || t === 'reset' || t === 'image' || t === 'file') return undefined;
      // Never leak secrets into the model's context — the real AX tree
      // masks passwords too.
      if (t === 'password') return el.value ? '•••' : '';
      return el.value != null ? String(el.value) : '';
    }
    if (tag === 'textarea') return el.value != null ? String(el.value) : '';
    if (tag === 'select') {
      var opt = el.selectedOptions && el.selectedOptions[0];
      return opt ? collapse(opt.label || opt.text, 80) : '';
    }
    if (el.isContentEditable) return collapse(el.innerText, 80);
    return undefined;
  };

  var propsOf = function (el, tag, role) {
    var out = [];
    var push = function (name, value) { out.push({ name: name, value: { value: value } }); };
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') push('disabled', true);
    if (el.required === true || el.getAttribute('aria-required') === 'true') push('required', true);
    var inv = el.getAttribute('aria-invalid');
    if (inv && inv !== 'false') push('invalid', inv);
    if (role === 'checkbox' || role === 'radio' || role === 'switch'
        || role === 'menuitemcheckbox' || role === 'menuitemradio') {
      if (tag === 'input') push('checked', el.indeterminate ? 'mixed' : el.checked === true);
      else {
        var ac = el.getAttribute('aria-checked');
        push('checked', ac === 'mixed' ? 'mixed' : ac === 'true');
      }
    }
    var exp = el.getAttribute('aria-expanded');
    if (exp === 'true' || exp === 'false') push('expanded', exp === 'true');
    else if (tag === 'summary' && el.parentElement && el.parentElement.tagName === 'DETAILS') {
      push('expanded', el.parentElement.open === true);
    }
    if (tag === 'option') { if (el.selected === true) push('selected', true); }
    else if (el.getAttribute('aria-selected') === 'true') push('selected', true);
    if (document.activeElement === el) push('focused', true);
    if (role === 'heading') {
      var lvl = el.getAttribute('aria-level') || (tag.charAt(0) === 'h' ? tag.slice(1) : '');
      if (lvl) push('level', Number(lvl));
    }
    return out;
  };

  var isHidden = function (el, tag) {
    if (el.hidden === true) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    // <option>/<optgroup> in a closed <select> have no boxes but ARE part
    // of the accessible tree (and the type tool matches their labels).
    if (tag === 'option' || tag === 'optgroup') return false;
    if (typeof el.checkVisibility === 'function') return !el.checkVisibility();
    return el.getClientRects().length === 0;
  };

  var rootNode = {
    nodeId: 'w0',
    childIds: [],
    ignored: false,
    role: { value: 'RootWebArea' },
    name: { value: collapse(document.title, 80) },
    properties: [],
    backendDOMNodeId: null,
  };
  var nodes = [rootNode];
  var byId = { w0: rootNode };
  var emitted = 1;
  var visited = 0;
  var capped = false;

  // DFS with an explicit stack (mirrors ax-serialize) so deep pages can't
  // blow the call stack. Each frame: element + the nodeId of its nearest
  // EMITTED ancestor — non-semantic wrappers don't create nodes, their
  // children just parent through to the wrapper's own parent.
  var stack = [];
  var pushChildren = function (el, parentNodeId) {
    var kids = [];
    if (el.shadowRoot) {
      // Open shadow DOM is part of what the user sees; closed roots are
      // invisible to extensions and CDP alike.
      kids = kids.concat(Array.prototype.slice.call(el.shadowRoot.children));
    }
    kids = kids.concat(Array.prototype.slice.call(el.children));
    for (var i = kids.length - 1; i >= 0; i--) {
      stack.push({ el: kids[i], parentNodeId: parentNodeId });
    }
  };
  if (document.body) pushChildren(document.body, 'w0');

  while (stack.length) {
    if (visited++ > MAX_VISITED || emitted >= MAX_EMITTED) { capped = true; break; }
    var frame = stack.pop();
    var el = frame.el;
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (!tag || tag === 'script' || tag === 'style' || tag === 'template'
        || tag === 'noscript' || tag === 'svg') continue;
    if (isHidden(el, tag)) continue;

    var role = roleOf(el, tag);
    var parentNodeId = frame.parentNodeId;
    if (role) {
      var walkId = takeId(el);
      var nodeId = 'w' + walkId;
      var node = {
        nodeId: nodeId,
        parentId: parentNodeId,
        childIds: [],
        ignored: false,
        role: { value: role },
        name: { value: nameOf(el, tag) },
        properties: propsOf(el, tag, role),
        backendDOMNodeId: null,
        walkId: walkId,
      };
      var val = valueOf(el, tag);
      if (val !== undefined) node.value = { value: val };
      nodes.push(node);
      byId[nodeId] = node;
      emitted++;
      if (byId[parentNodeId]) byId[parentNodeId].childIds.push(nodeId);
      parentNodeId = nodeId;
    }
    pushChildren(el, parentNodeId);
  }

  return { ok: true, nodes: nodes, refElementCount: els.size, capped: capped };
}
