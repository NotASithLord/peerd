// Debugger pool — owns chrome.debugger attach/detach lifecycle and
// console-event routing for the page_exec tool.
//
// Why a pool instead of attach-per-call:
//   - Each attach/detach is a separate "DevTools is debugging this tab"
//     banner flicker — looks awful and slows the loop.
//   - CDP setup costs (Runtime.enable, listener wire-up) are ~50ms
//     per attach; amortized over N evals it's negligible.
//   - Concurrent evals on the same tab share the same protocol channel,
//     so we need centralized event routing anyway.
//
// Lifecycle:
//   - attach(tabId): idempotent; first call attaches + enables Runtime
//   - evaluate(tabId, expression, opts): runs Runtime.evaluate, drains
//     buffered console events fired during the call, returns
//     { ok, returnValue, consoleOutput, error?, stack? }
//   - tab close → automatic detach via chrome.tabs.onRemoved
//   - chrome.debugger.onDetach → invalidate state (user clicked "Cancel"
//     on the banner, another extension attached, etc.)
//
// Why allowUnsafeEvalBlockedByCSP=true:
//   - Trusted-Types pages (`require-trusted-types-for 'script'`) reject
//     injected script elements, so chrome.scripting-based automation
//     cannot run there at all. CDP's Runtime.evaluate accepts this
//     option as the sanctioned evaluation path for user-privileged
//     tooling: page CSP governs what the *page* may inject; CDP
//     evaluation is the user's own channel — the same one DevTools
//     uses — for user-directed automation.
//   - That's the difference between page_eval (fails on Gmail) and
//     page_exec (works on Gmail). Same code, different channel.

import browser from '/vendor/browser-polyfill.js';

const PROTOCOL_VERSION = '1.3';

export const createDebuggerPool = () => {
  /** @type {Set<number>} tabIds we've successfully attached to */
  const attached = new Set();
  /** @type {Map<number, string[]>} per-tab console-event buffer */
  const consoleBufs = new Map();

  // why: `chrome.debugger` may not exist in this build at all. It's a
  // CHANNEL-GATED permission — required (install-time) in the preview/dev
  // manifests where CDP is the default, but stripped from the store Chrome
  // build (initial submission, until re-added post-approval) and from every
  // Firefox package (see packaging/gen-manifest.ts STORE_STRIPPED_PERMISSIONS /
  // CHROME_ONLY_PERMISSIONS, docs/store/OPEN-DECISIONS.md §1). NOT an
  // optional/runtime-granted permission — Chrome forbids `debugger` under
  // optional_permissions. Where the namespace is absent, touching
  // `browser.debugger.onEvent` at construction would throw and take down the
  // whole service worker at module-eval time. We therefore register the
  // global debugger listeners LAZILY, the first time we actually attach — by
  // which point the namespace necessarily exists (attach itself needs it).
  // Idempotent; the flag makes re-attach cheap.
  let globalListenersBound = false;
  const ensureGlobalListeners = () => {
    if (globalListenersBound) return;
    globalListenersBound = true;

    // Global event router. chrome.debugger.onEvent fires for ALL attached
    // tabs; we dispatch by source.tabId to the right buffer.
    browser.debugger.onEvent.addListener((source, method, params) => {
      if (method !== 'Runtime.consoleAPICalled') return;
      const buf = consoleBufs.get(source.tabId);
      if (!buf) return;
      const level = params.type ?? 'log';
      const text = (params.args ?? []).map(formatRemoteObject).join(' ');
      buf.push(level === 'log' ? text : `[${level}] ${text}`);
    });

    // User-initiated detach (banner "Cancel" button, other extension
    // attached, target crashed). Reset our state so the next call
    // re-attaches cleanly instead of throwing "not attached".
    browser.debugger.onDetach.addListener((source, reason) => {
      console.log('[debugger-pool] detach', source.tabId, reason);
      attached.delete(source.tabId);
      consoleBufs.delete(source.tabId);
    });
  };

  // Tab close → drop our state (the debugger session is gone anyway).
  // Uses only the `tabs` API (always available), so it's safe to bind at
  // construction regardless of the debugger permission.
  browser.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
    consoleBufs.delete(tabId);
  });

  const attach = async (tabId) => {
    // why per-tab: the `debugger` permission Chrome granted is GLOBAL (an
    // API permission can't be origin-scoped), but we only ever attach to a
    // tab a CDP tool is actually driving — so the banner + debugging touch
    // just that tab, never idle ones. If a store reviewer ever challenges
    // the global grant, this is the hook point for a per-origin allowlist
    // (gate on the tab's origin before attaching). Deferred — see
    // docs/store/OPEN-DECISIONS.md §1. The denylist already refuses
    // sensitive origins upstream of here.
    ensureGlobalListeners();
    if (attached.has(tabId)) return;
    console.log('[debugger-pool] attaching to tab', tabId);
    try {
      await browser.debugger.attach({ tabId }, PROTOCOL_VERSION);
    } catch (e) {
      // Common race: SW restored mid-flight, browser thinks we're
      // still attached. Forcing detach + retry is cheap.
      if (/already attached/i.test(e?.message ?? '')) {
        try { await browser.debugger.detach({ tabId }); } catch { /* ignore */ }
        await browser.debugger.attach({ tabId }, PROTOCOL_VERSION);
      } else {
        console.error('[debugger-pool] attach failed', e);
        throw e;
      }
    }
    await browser.debugger.sendCommand({ tabId }, 'Runtime.enable');
    attached.add(tabId);
    console.log('[debugger-pool] attached + Runtime enabled on', tabId);
  };

  const detach = async (tabId) => {
    if (!attached.has(tabId)) return;
    try { await browser.debugger.detach({ tabId }); }
    catch (e) { console.warn('[debugger-pool] detach threw', e); }
    attached.delete(tabId);
    consoleBufs.delete(tabId);
  };

  const evaluate = async (tabId, expression, opts = {}) => {
    await attach(tabId);
    // Reset console buffer just before the call so we capture only
    // this evaluate's output. Concurrent evals on the same tab would
    // cross-pollinate; the agent loop is single-threaded per session
    // so that's fine in practice.
    consoleBufs.set(tabId, []);
    // why: wrap in an async IIFE so the agent's expression behaves like
    // a function body — top-level `await`, `return`, `let`/`const` all
    // work. Without this:
    //   - `return r.status` → SyntaxError ("Illegal return statement")
    //   - `await fetch(...)` → SyntaxError ("await is only valid in
    //     async functions")
    // and the agent has to manually construct an IIFE every call. We
    // do it once, so the agent writes naturally:
    //
    //     const r = await fetch(url, {credentials: 'include'});
    //     return r.status;
    //
    // The trailing newline before the closing brace defends against the
    // user's last line being a line-comment that would otherwise eat
    // our `})()`.
    const wrapped = `(async () => {\n${expression}\n})()`;
    let result;
    try {
      result = await browser.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: wrapped,
        // The IIFE returns a Promise; awaitPromise unwraps it so we
        // get the actual return value (or thrown rejection) back.
        awaitPromise: true,
        returnByValue: true,
        // Trusted-Types pages (`require-trusted-types-for 'script'`,
        // e.g. Gmail / Notion / Slack) reject injected script, so
        // evaluation uses CDP's sanctioned opt-in for user-privileged
        // tooling — the same channel DevTools uses.
        allowUnsafeEvalBlockedByCSP: true,
        // Treat the eval as a user gesture so gesture-gated APIs
        // (focus, clipboard, fullscreen) work from the script.
        userGesture: true,
        ...opts,
      });
    } finally {
      // Always drain the buffer, even on throw, so the next call starts
      // clean. Subsequent attempts shouldn't see stale output.
      const captured = consoleBufs.get(tabId) ?? [];
      consoleBufs.delete(tabId);
      result = result ? { ...result, _capturedConsole: captured.join('\n') } : { _capturedConsole: captured.join('\n') };
    }
    return result;
  };

  /**
   * Dispatch a sequence of keyboard events through CDP Input.dispatchKeyEvent.
   * Produces events with isTrusted=true so hostile SPAs (Gmail, Slack,
   * Linear) accept them as real user input.
   *
   * @param {number} tabId
   * @param {Array<{key: string, code?: string, modifiers?: number, text?: string}>} events
   *   Each entry is one "key press" (we emit keyDown + keyUp per entry).
   *   The CDP modifiers field is a bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
   */
  const dispatchKeys = async (tabId, events) => {
    await attach(tabId);
    // why: Gmail and friends listen on focusable elements for keyboard
    // shortcuts. The active element needs to be document.body (or some
    // non-input element) for shortcuts like `*+u` to register; if the
    // search box has focus, the keys go to the input instead. The
    // caller is expected to manage focus, but we ensure the page is
    // focused first via the focus() RPC.
    try {
      await browser.debugger.sendCommand({ tabId }, 'Page.bringToFront');
    } catch { /* not critical */ }
    for (const ev of events) {
      const base = {
        key: ev.key,
        code: ev.code ?? defaultCode(ev.key),
        modifiers: ev.modifiers ?? 0,
        windowsVirtualKeyCode: ev.windowsVirtualKeyCode ?? defaultVk(ev.key),
        nativeVirtualKeyCode: ev.nativeVirtualKeyCode ?? defaultVk(ev.key),
      };
      // For printable characters we also need a "char" event so input
      // elements receive the typed value. CDP's "rawKeyDown" + "char"
      // is the closest analog to a real keystroke for inputs; for
      // shortcuts that don't target inputs, "keyDown" alone is enough.
      const isChar = ev.text && ev.text.length === 1 && (ev.modifiers ?? 0) === 0;
      await browser.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        ...base,
        type: isChar ? 'rawKeyDown' : 'keyDown',
        ...(ev.text ? { text: ev.text } : {}),
        ...(ev.text ? { unmodifiedText: ev.text } : {}),
      });
      if (isChar) {
        await browser.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
          ...base, type: 'char', text: ev.text, unmodifiedText: ev.text,
        });
      }
      await browser.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        ...base, type: 'keyUp',
      });
    }
  };

  // --- DOM navigation: a11y snapshot + ref-resolved click/type ----------

  // Action-result attribution (Phase 2). Shared page-side snippets spliced
  // into the click/type callFunctionOn bodies: set up a MutationObserver
  // BEFORE the action (OBS_SETUP), then await a bounded window and collect
  // a compact, SEMANTIC summary of what changed (OBS_COLLECT → __m). var/
  // ES5 style because the body is serialized into the page. Validated on
  // real DOM via Claude-in-Chrome before shipping.
  const OBS_SETUP = `
    var __add = new Set(), __rem = new Set(), __att = new Set();
    var __desc = function (n) {
      var t = n.tagName ? n.tagName.toLowerCase() : '';
      var role = n.getAttribute && n.getAttribute('role');
      var label = (n.getAttribute && (n.getAttribute('aria-label') || n.getAttribute('placeholder')))
        || ((n.innerText || '').trim().slice(0, 40));
      return (role || t) + (label ? ' "' + label + '"' : '');
    };
    var __obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'childList') {
          m.addedNodes.forEach(function (n) { if (n.nodeType === 1) __add.add(__desc(n)); });
          m.removedNodes.forEach(function (n) { if (n.nodeType === 1) __rem.add(__desc(n)); });
        } else if (m.type === 'attributes') {
          __att.add(__desc(m.target) + ' @' + m.attributeName);
        }
      }
    });
    __obs.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['aria-expanded','aria-checked','aria-disabled','disabled','value','class','hidden','aria-hidden','aria-selected'] });`;
  const OBS_COLLECT = `
    await new Promise(function (r) { setTimeout(r, 400); });
    __obs.disconnect();
    var __m = { added: Array.from(__add).slice(0, 8), removed: Array.from(__rem).slice(0, 8),
      attr: Array.from(__att).slice(0, 8),
      counts: { added: __add.size, removed: __rem.size, attr: __att.size } };`;

  // Fetch the full accessibility tree (CDP semantic subset: role, name,
  // state, backendDOMNodeId per node). The pure serializer in
  // peerd-runtime/dom/ax-serialize.js turns this into the model's snapshot.
  const getAxTree = async (tabId) => {
    await attach(tabId);
    // Accessibility must be enabled before getFullAXTree; idempotent.
    await browser.debugger.sendCommand({ tabId }, 'Accessibility.enable').catch(() => {});
    const res = await browser.debugger.sendCommand({ tabId }, 'Accessibility.getFullAXTree', {});
    return res?.nodes ?? [];
  };

  // Click a node by its backendDOMNodeId (from a ref, never a selector).
  // CDP resolves the exact node → no ambiguity, no "selector not found".
  // Synthetic el.click(); a real-event upgrade (DOM.getBoxModel +
  // Input.dispatchMouseEvent) is a follow-up for isTrusted-gating sites.
  // Reports the action's DOM effect via OBS_SETUP/COLLECT (Phase 2).
  const clickBackendNode = async (tabId, backendDOMNodeId) => {
    await attach(tabId);
    await browser.debugger.sendCommand({ tabId }, 'DOM.enable').catch(() => {});
    const resolved = await browser.debugger.sendCommand(
      { tabId }, 'DOM.resolveNode', { backendNodeId: backendDOMNodeId },
    );
    const objectId = resolved?.object?.objectId;
    if (!objectId) return { ok: false, error: 'node_unresolvable' };
    try {
      const out = await browser.debugger.sendCommand({ tabId }, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `async function () {
          this.scrollIntoView({ block: 'center', inline: 'center' });
          var tag = this.tagName ? this.tagName.toLowerCase() : '';
          var text = ((this.innerText || this.value || '') + '').trim().slice(0, 80);
          ${OBS_SETUP}
          if (typeof this.click === 'function') { this.click(); }
          else { this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
          ${OBS_COLLECT}
          return { tag: tag, text: text, mutations: __m };
        }`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      const v = out?.result?.value ?? {};
      return { ok: true, tag: v.tag ?? '', text: v.text ?? '', mutations: v.mutations ?? null };
    } catch (e) {
      // The click likely navigated the page (execution context destroyed
      // mid-observe). That IS the result — distinguish from a real failure.
      const msg = e?.message ?? String(e);
      if (/context was destroyed|inspected target navigated|target closed|no longer exists|cannot find context/i.test(msg)) {
        return { ok: true, navigated: true, mutations: null };
      }
      return { ok: false, error: `click_failed: ${msg}` };
    }
  };

  // Set the value of an input/textarea/contenteditable identified by its
  // backendDOMNodeId (from a ref). Uses the native value setter so React's
  // value tracking sees the change, then fires input/change (+ optional
  // Enter / requestSubmit). Args are passed via CDP `arguments`, never
  // string-interpolated — no injection surface.
  const setValueBackendNode = async (tabId, backendDOMNodeId, text, submit) => {
    await attach(tabId);
    await browser.debugger.sendCommand({ tabId }, 'DOM.enable').catch(() => {});
    const resolved = await browser.debugger.sendCommand(
      { tabId }, 'DOM.resolveNode', { backendNodeId: backendDOMNodeId },
    );
    const objectId = resolved?.object?.objectId;
    if (!objectId) return { ok: false, error: 'node_unresolvable' };
    try {
      const out = await browser.debugger.sendCommand({ tabId }, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `async function (text, submit) {
          this.scrollIntoView({ block: 'center' });
          if (typeof this.focus === 'function') this.focus();
          var tag = this.tagName ? this.tagName.toLowerCase() : '';
          ${OBS_SETUP}
          if (tag === 'input' || tag === 'textarea') {
            var proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            var d = Object.getOwnPropertyDescriptor(proto, 'value');
            if (d && d.set) { d.set.call(this, text); } else { this.value = text; }
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (tag === 'select') {
            // Native <select>: the model passes the option's visible LABEL
            // (that's all the a11y tree exposes); resolve it to the option's
            // value attribute (often different — label "Two" -> value "2") and
            // set THAT, else the browser silently ignores the assignment.
            var want = (text + '').trim();
            var opts = Array.prototype.slice.call(this.options || []);
            var match = null, i;
            for (i = 0; i < opts.length; i++) { if (((opts[i].label || opts[i].text || '') + '').trim() === want) { match = opts[i]; break; } }
            if (!match) { for (i = 0; i < opts.length; i++) { if (opts[i].value === want) { match = opts[i]; break; } } }
            if (!match) { for (i = 0; i < opts.length; i++) { if (((opts[i].text || '') + '').trim().toLowerCase() === want.toLowerCase()) { match = opts[i]; break; } } }
            if (!match) {
              __obs.disconnect();
              var avail = opts.map(function (o) { return ((o.text || '') + '').trim(); }).filter(Boolean).slice(0, 25);
              return { ok: false, error: 'no_option_matching: "' + want + '" — available: ' + avail.join(' | ') };
            }
            var sd = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
            if (sd && sd.set) { sd.set.call(this, match.value); } else { this.value = match.value; }
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (this.isContentEditable) {
            this.innerText = text;
            this.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            __obs.disconnect();
            return { ok: false, error: 'not_typable: ' + tag };
          }
          if (submit) {
            var mk = function (k) { return new KeyboardEvent(k, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }); };
            this.dispatchEvent(mk('keydown')); this.dispatchEvent(mk('keypress')); this.dispatchEvent(mk('keyup'));
            if (this.form && typeof this.form.requestSubmit === 'function') { try { this.form.requestSubmit(); } catch (e) {} }
          }
          ${OBS_COLLECT}
          return { ok: true, tag: tag, mutations: __m };
        }`,
        arguments: [{ value: String(text ?? '') }, { value: !!submit }],
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      const v = out?.result?.value ?? {};
      if (v.ok === false) return { ok: false, error: v.error ?? 'type_failed' };
      return { ok: true, tag: v.tag ?? '', mutations: v.mutations ?? null };
    } catch (e) {
      const msg = e?.message ?? String(e);
      if (/context was destroyed|inspected target navigated|target closed|no longer exists|cannot find context/i.test(msg)) {
        return { ok: true, navigated: true, mutations: null };
      }
      return { ok: false, error: `type_failed: ${msg}` };
    }
  };

  // Read the framework component state behind a node (by backendDOMNodeId,
  // from a ref). Runs in the page's MAIN world via CDP, where the React
  // fiber / Vue component handles live. Returns { framework, component,
  // props, state } or { framework: null }. Validated live on react.dev.
  const readFrameworkState = async (tabId, backendDOMNodeId) => {
    await attach(tabId);
    await browser.debugger.sendCommand({ tabId }, 'DOM.enable').catch(() => {});
    const resolved = await browser.debugger.sendCommand(
      { tabId }, 'DOM.resolveNode', { backendNodeId: backendDOMNodeId },
    );
    const objectId = resolved?.object?.objectId;
    if (!objectId) return { ok: false, error: 'node_unresolvable' };
    const out = await browser.debugger.sendCommand({ tabId }, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: FRAMEWORK_STATE_FN,
      returnByValue: true,
    });
    return { ok: true, ...(out?.result?.value ?? { framework: null }) };
  };

  return {
    attach, detach, evaluate, dispatchKeys, getAxTree, clickBackendNode, setValueBackendNode,
    readFrameworkState,
    isAttached: (tabId) => attached.has(tabId),
  };
};

// Page-side framework introspection (React fiber / Vue component → props +
// state). ES5, serialized into the page. Walks up the React fiber to the
// nearest function/class COMPONENT (host elements give props only);
// extracts useState values from the hooks linked list. Vue 3 via
// __vueParentComponent, Vue 2 via __vue__. safe() caps depth/breadth and
// stringifies functions so the result is always returnByValue-able.
//
// SYNC NOTE: peerd-runtime/dom/framework-state.js (readFrameworkStateInjected)
// is the no-CDP twin of this function — the same fiber/Vue walk reached via
// chrome.scripting world:'MAIN' (selector-resolved) instead of CDP
// callFunctionOn (this-bound). The two can't share source (scripting can't
// serialize an import; CDP needs a string), so any fix to the walk below must
// be mirrored there.
const FRAMEWORK_STATE_FN = `function () {
  var el = this;
  function safe(v, d) {
    d = d || 0;
    if (v == null) return v;
    var t = typeof v;
    if (t === 'function') return '<fn>';
    if (t !== 'object') return t === 'string' ? v.slice(0, 80) : v;
    if (d > 2) return '<…>';
    if (Array.isArray(v)) return '[' + v.length + (v.length ? ' items' : '') + ']';
    var o = {}, n = 0;
    for (var k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      if (/^(_owner|_store|ref|key|__|\\$\\$typeof)/.test(k)) continue;
      if (n++ >= 12) { o['…'] = 1; break; }
      try { o[k] = safe(v[k], d + 1); } catch (e) { o[k] = '<err>'; }
    }
    return o;
  }
  var rk = Object.keys(el).find(function (k) {
    return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0;
  });
  if (rk) {
    var fiber = el[rk], hostProps = null;
    for (var i = 0; i < 40 && fiber; i++) {
      var type = fiber.type;
      if (typeof type === 'function') {
        var isClass = type.prototype && type.prototype.isReactComponent;
        var state;
        if (isClass) {
          state = safe(fiber.memoizedState);
        } else {
          state = []; var h = fiber.memoizedState;
          for (var j = 0; j < 24 && h; j++) {
            var ms = h.memoizedState;
            // skip effect/ref/context hook nodes — keep useState-ish values
            if (ms !== undefined && typeof ms !== 'function' && !(ms && (ms.tag !== undefined || ms.create !== undefined))) {
              state.push(safe(ms));
            }
            h = h.next;
          }
        }
        return { framework: 'react', component: type.displayName || type.name || '(anonymous)', props: safe(fiber.memoizedProps), state: state };
      }
      if (typeof type === 'string' && !hostProps) hostProps = safe(fiber.memoizedProps);
      fiber = fiber.return;
    }
    return { framework: 'react', component: null, props: hostProps, note: 'no component fiber above this node' };
  }
  if (el.__vueParentComponent) {
    var c = el.__vueParentComponent;
    return { framework: 'vue3', component: (c.type && (c.type.name || c.type.__name)) || null, props: safe(c.props), state: safe(c.setupState || c.data) };
  }
  if (el.__vue__) {
    var v = el.__vue__;
    return { framework: 'vue2', component: (v.$options && v.$options.name) || null, props: safe(v.$props), state: safe(v.$data) };
  }
  return { framework: null, note: 'no React/Vue markers on this element' };
}`;

// Best-effort key → CDP `code` mapping. Covers the common cases (letters,
// digits, common special keys). For anything exotic the caller can pass
// `code` explicitly.
const defaultCode = (key) => {
  if (!key) return '';
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  const SPECIAL = {
    'Enter': 'Enter', 'Tab': 'Tab', 'Escape': 'Escape', 'Backspace': 'Backspace',
    ' ': 'Space', 'Space': 'Space',
    'ArrowUp': 'ArrowUp', 'ArrowDown': 'ArrowDown',
    'ArrowLeft': 'ArrowLeft', 'ArrowRight': 'ArrowRight',
    'Shift': 'ShiftLeft', 'Control': 'ControlLeft', 'Alt': 'AltLeft', 'Meta': 'MetaLeft',
    '*': 'Digit8', '+': 'Equal', '-': 'Minus', '/': 'Slash',
    '.': 'Period', ',': 'Comma', ';': 'Semicolon', "'": 'Quote',
  };
  return SPECIAL[key] ?? '';
};

// Best-effort key → Windows virtual key code. Some sites still gate on
// keyCode (legacy). Cover ASCII letters + digits + common specials.
const defaultVk = (key) => {
  if (!key) return 0;
  if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
  const VK = {
    'Enter': 13, 'Tab': 9, 'Escape': 27, 'Backspace': 8, ' ': 32, 'Space': 32,
    'ArrowUp': 38, 'ArrowDown': 40, 'ArrowLeft': 37, 'ArrowRight': 39,
    'Shift': 16, 'Control': 17, 'Alt': 18, 'Meta': 91,
  };
  return VK[key] ?? 0;
};

// CDP RemoteObject → user-readable string.
const formatRemoteObject = (obj) => {
  if (!obj) return 'undefined';
  if (obj.type === 'undefined') return 'undefined';
  if (obj.type === 'object' && obj.subtype === 'null') return 'null';
  if (obj.value !== undefined) {
    if (typeof obj.value === 'string') return obj.value;
    try { return JSON.stringify(obj.value); }
    catch { return String(obj.value); }
  }
  if (obj.description) return obj.description;
  return obj.type;
};
