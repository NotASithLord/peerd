// @ts-check
// peerd-engine/editor.js — reusable OPFS-rooted file editor.
//
// One module both the Notebook tab and (next) the App-tab edit
// mode mount. Owns:
//   - OPFS access rooted at a per-instance subdirectory
//   - file tree sidebar with directory collapse/expand
//   - a CodeMirror 6 editor with line numbers, brackets, autocomplete,
//     undo, search — language picked at construction
//   - debounced auto-save on edit
//   - a pinned entry file that can't be deleted
//   - file create / delete dialogs
//
// What this module DOESN'T own:
//   - "Run" semantics (the caller wires Cmd-Enter via the onRun hook)
//   - agent-code-mirror flows (caller calls replaceActiveWith)
//   - the surrounding chrome (toolbar, boot card, output panel)
//
// One call, returns a small API surface. Caller can teardown via
// destroy() if needed.

import {
  EditorView, EditorState, Compartment, keymap, lineNumbers,
  highlightActiveLine, drawSelection, history, historyKeymap,
  defaultKeymap, indentWithTab, searchKeymap, autocompletion,
  closeBrackets, closeBracketsKeymap, completionKeymap,
  bracketMatching, syntaxHighlighting, defaultHighlightStyle,
  indentOnInput, javascript, html, css, oneDark,
} from '/vendor/codemirror/cm.js';
import { opfsHelpers } from './opfs.js';

// ---------------------------------------------------------------------------
// Stylesheet (injected once per page on first createEditor call).
// ---------------------------------------------------------------------------

const STYLE_ID = 'peerd-editor-style';
const STYLE = `
.pe-root {
  flex: 1 1 auto;
  display: flex;
  flex-direction: row;
  overflow: hidden;
  --pe-accent: var(--accent, #34d399);
  --pe-bg: var(--bg, #0d1117);
  --pe-bg-elev: var(--bg-elev, #161b22);
  --pe-bg-editor: var(--bg-editor, #11161d);
  --pe-fg: var(--fg, #e6edf3);
  --pe-fg-muted: var(--fg-muted, #9ba3ad);
  --pe-border: var(--border, #30363d);
  --pe-fail: var(--fail, #c43030);
}
.pe-tree {
  flex: 0 0 180px;
  background: var(--pe-bg-elev);
  border-right: 1px solid var(--pe-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: none;
}
.pe-tree-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 12px;
  height: 28px;
  border-bottom: 1px solid var(--pe-border);
  font-size: 10px;
  color: var(--pe-fg-muted);
  letter-spacing: 0.04em;
  font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace);
}
.pe-tree-label { font-weight: 500; }
.pe-new {
  background: transparent;
  border: 0;
  color: var(--pe-fg-muted);
  font-size: 14px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}
.pe-new:hover { color: var(--pe-accent); }
.pe-tree-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 4px 0;
  font-size: 11px;
  font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace);
}
.pe-node {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px 2px 0;
  cursor: pointer;
  color: var(--pe-fg-muted);
  position: relative;
  white-space: nowrap;
}
.pe-node:hover { color: var(--pe-fg); background: color-mix(in srgb, var(--pe-accent) 6%, transparent); }
.pe-node.is-active { background: var(--pe-bg-editor); color: var(--pe-fg); }
.pe-node.is-active::before {
  content: ''; position: absolute; inset: 0 auto 0 0; width: 2px; background: var(--pe-accent);
}
.pe-node.is-pinned { font-weight: 500; }
.pe-node .pe-indent { display: inline-block; }
.pe-node .pe-twirl,
.pe-node .pe-icon {
  display: inline-block;
  width: 12px;
  text-align: center;
  font-size: 9px;
  flex: 0 0 12px;
  color: var(--pe-fg-muted);
}
.pe-node .pe-icon { font-size: 10px; opacity: 0.7; }
.pe-node .pe-label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; }
.pe-node .pe-close {
  visibility: hidden; background: transparent; border: 0;
  color: var(--pe-fg-muted); cursor: pointer; padding: 0 4px;
  font-size: 12px; line-height: 1;
}
.pe-node:hover .pe-close, .pe-node.is-active .pe-close { visibility: visible; }
.pe-node.is-pinned .pe-close { display: none; }
.pe-node .pe-close:hover { color: var(--pe-fail); }

.pe-editor-column { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
.pe-host {
  flex: 1 1 auto;
  position: relative;
  background: var(--pe-bg-editor);
  overflow: hidden;
}
.pe-host .cm-editor { height: 100%; font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace); font-size: 13px; background: var(--pe-bg-editor); }
.pe-host .cm-scroller { font-family: inherit; }
.pe-host .cm-content { padding: 8px 0; caret-color: var(--pe-accent); }
.pe-host .cm-gutters { background: var(--pe-bg-editor); border-right: 1px solid color-mix(in srgb, var(--pe-border) 60%, transparent); color: var(--pe-fg-muted); }
.pe-host .cm-activeLine, .pe-host .cm-activeLineGutter { background: color-mix(in srgb, var(--pe-accent) 5%, transparent); }
`;

const injectStyle = () => {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = STYLE;
  document.head.appendChild(s);
};

// ---------------------------------------------------------------------------
// Public factory.
// ---------------------------------------------------------------------------

/**
 * Mount a peerd editor into `mountEl`. Returns an API to drive it.
 *
 * @param {Object} config
 * @param {HTMLElement} config.mountEl
 * @param {string[]} config.opfsBase            -- path components from origin root, e.g. ['peerd-notebooks', 'notebook-abc']
 * @param {string}   config.pinnedFile          -- entry file, pinned at top, can't be deleted
 * @param {Set<string>} [config.hiddenFiles]    -- paths to omit from the tree
 * @param {() => void} [config.onRun]           -- Cmd-Enter / Ctrl-Enter handler
 * @param {(path: string, content: string) => void} [config.onSaved]
 * @param {string} [config.initialFile]         -- file to open first (default: pinnedFile)
 *
 * Language is auto-picked per file by extension (.html → html,
 * .css → css, anything else → javascript).
 */
export const createEditor = async (config) => {
  const {
    mountEl,
    opfsBase,
    pinnedFile,
    hiddenFiles = new Set(),
    onRun,
    onSaved,
    initialFile,
  } = config;

  injectStyle();

  // --- DOM scaffold ---
  mountEl.classList.add('pe-root');
  mountEl.innerHTML = `
    <aside class="pe-tree">
      <div class="pe-tree-header">
        <span class="pe-tree-label">files</span>
        <button class="pe-new" title="New file">+</button>
      </div>
      <div class="pe-tree-body" role="tree"></div>
    </aside>
    <div class="pe-editor-column">
      <div class="pe-host"></div>
    </div>
  `;
  // why the non-null assert: these three nodes were just written into
  // mountEl.innerHTML directly above, so the selectors always resolve.
  const treeBody = /** @type {HTMLElement} */ (mountEl.querySelector('.pe-tree-body'));
  const newBtn = /** @type {HTMLElement} */ (mountEl.querySelector('.pe-new'));
  const host = /** @type {HTMLElement} */ (mountEl.querySelector('.pe-host'));

  // --- OPFS helpers ---
  const opfs = opfsHelpers(opfsBase);
  const { read: opfsRead, write: opfsWrite, delete: opfsDelete, list: opfsList } = opfs;

  // --- CodeMirror ---
  // why the codemirror surface is untyped: the vendored cm.js is a
  // minified bundle with no .d.ts (excluded from typecheck per
  // tsconfig), so its exports resolve as `any`. We annotate our own
  // locals; the CM ViewUpdate is described structurally by what we read.
  /** @type {(() => void) | null} */
  let onChangeCb = null;
  const update = EditorView.updateListener.of(/** @param {{ docChanged: boolean }} u */ (u) => {
    if (u.docChanged && onChangeCb) onChangeCb();
  });

  // Per-file language: html/css/javascript picked from extension; the
  // Compartment lets us reconfigure when the active file changes.
  const langCompartment = new Compartment();
  /** @param {string} path */
  const langForPath = (path) => {
    const p = (path || '').toLowerCase();
    if (p.endsWith('.css')) return css();
    if (p.endsWith('.html') || p.endsWith('.htm')) return html();
    // .js/.mjs/.ts/.json/.txt and unknown extensions fall through to
    // JS — fine for JSON (a subset), and a reasonable default.
    return javascript();
  };

  const initialPath = initialFile || pinnedFile;
  const state = EditorState.create({
    extensions: [
      lineNumbers(), highlightActiveLine(), drawSelection(),
      history(), bracketMatching(), closeBrackets(), indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      autocompletion(),
      langCompartment.of(langForPath(initialPath)),
      oneDark, update,
      keymap.of([
        ...(onRun ? [{ key: 'Mod-Enter', preventDefault: true, run: () => { onRun(); return true; } }] : []),
        indentWithTab,
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...completionKeymap,
      ]),
    ],
  });
  const view = new EditorView({ state, parent: host });
  const getValue = () => view.state.doc.toString();
  /** @param {string} text */
  const setValue = (text) => view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  });

  // --- State ---
  let currentFile = initialFile || pinnedFile;
  /** @type {string[]} */
  let fileList = [pinnedFile];
  /** @type {Set<string>} */
  const collapsedDirs = new Set();
  /** @type {ReturnType<typeof setTimeout> | null} */
  let saveTimer = null;

  // --- Tree rendering ---
  /**
   * @typedef {{ name: string, path?: string, children?: Map<string, TreeNode>,
   *             dirPath?: string }} TreeNode
   */
  /**
   * @param {TreeNode} a
   * @param {TreeNode} b
   */
  const compareTreeNodes = (a, b) => {
    if (a.path === pinnedFile) return -1;
    if (b.path === pinnedFile) return 1;
    const aDir = !!a.children, bDir = !!b.children;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  };

  const renderTree = () => {
    /** @type {{ children: Map<string, TreeNode> }} */
    const root = { children: new Map() };
    for (const filePath of fileList) {
      const parts = filePath.split('/');
      /** @type {{ children: Map<string, TreeNode> }} */
      let cur = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i], isLeaf = i === parts.length - 1;
        if (isLeaf) cur.children.set(part, { name: part, path: filePath });
        else {
          if (!cur.children.has(part)) {
            cur.children.set(part, {
              name: part, children: new Map(),
              dirPath: parts.slice(0, i + 1).join('/'),
            });
          }
          // why cast: the branch above guarantees the child exists and is a
          // directory node (it has `children`); get() can't express that.
          cur = /** @type {{ children: Map<string, TreeNode> }} */ (cur.children.get(part));
        }
      }
    }
    treeBody.innerHTML = '';
    /**
     * @param {TreeNode} node
     * @param {number} depth
     */
    const append = (node, depth) => {
      if (node.children) {
        // why ?? '': a directory node always carries dirPath at runtime, but
        // the optional type forces a fallback; has('') is false either way.
        const isCollapsed = collapsedDirs.has(node.dirPath ?? '');
        if (node.dirPath !== undefined) {
          const dirPath = node.dirPath;
          const row = document.createElement('div');
          row.className = 'pe-node';
          row.title = dirPath;
          row.innerHTML =
            `<span class="pe-indent" style="width:${depth * 10}px"></span>` +
            `<span class="pe-twirl">${isCollapsed ? '▶' : '▼'}</span>` +
            `<span class="pe-icon">▸</span>` +
            `<span class="pe-label"></span>`;
          const label = row.querySelector('.pe-label');
          if (label) label.textContent = node.name;
          row.addEventListener('click', () => {
            if (isCollapsed) collapsedDirs.delete(dirPath);
            else collapsedDirs.add(dirPath);
            renderTree();
          });
          treeBody.appendChild(row);
        }
        if (!isCollapsed) {
          const entries = Array.from(node.children.values()).sort(compareTreeNodes);
          for (const child of entries) append(child, node.dirPath !== undefined ? depth + 1 : depth);
        }
        return;
      }
      // why ?? '': a leaf node always carries a path at runtime; the
      // optional type needs a fallback the leaf branch never hits.
      const nodePath = node.path ?? '';
      const row = document.createElement('div');
      row.className = 'pe-node';
      if (nodePath === currentFile) row.classList.add('is-active');
      if (nodePath === pinnedFile) row.classList.add('is-pinned');
      row.title = nodePath;
      row.innerHTML =
        `<span class="pe-indent" style="width:${depth * 10}px"></span>` +
        `<span class="pe-twirl"></span>` +
        `<span class="pe-icon">⋮</span>` +
        `<span class="pe-label"></span>`;
      const label = row.querySelector('.pe-label');
      if (label) label.textContent = node.name;
      if (nodePath !== pinnedFile) {
        const close = document.createElement('button');
        close.className = 'pe-close';
        close.textContent = '×';
        close.title = `Delete ${nodePath}`;
        close.addEventListener('click', (e) => { e.stopPropagation(); deleteFile(nodePath); });
        row.appendChild(close);
      }
      row.addEventListener('click', () => switchToFile(nodePath));
      treeBody.appendChild(row);
    };
    const rootEntries = Array.from(root.children.values()).sort(compareTreeNodes);
    for (const e of rootEntries) append(e, 0);
  };

  const refreshTree = async () => {
    try {
      const entries = await opfsList();
      const seen = new Set([pinnedFile]);
      for (const e of entries) {
        const p = e.path.replace(/^\/+/, '');
        if (!hiddenFiles.has(p)) seen.add(p);
      }
      fileList = Array.from(seen).sort((a, b) => {
        if (a === pinnedFile) return -1;
        if (b === pinnedFile) return 1;
        return a.localeCompare(b);
      });
    } catch { fileList = [pinnedFile]; }
    renderTree();
  };

  // --- Save / switch / create / delete ---
  const flushActiveSave = async () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try {
      const content = getValue();
      await opfsWrite(currentFile, content);
      onSaved?.(currentFile, content);
    } catch (e) { console.warn('[peerd-editor] flush save failed', e); }
  };

  const queueSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const content = getValue();
        await opfsWrite(currentFile, content);
        onSaved?.(currentFile, content);
      } catch (e) { console.warn('[peerd-editor] save failed', e); }
    }, 400);
  };

  /** @param {string} path */
  const switchToFile = async (path) => {
    if (path === currentFile) return;
    await flushActiveSave();
    let content = '';
    try { content = await opfsRead(path); } catch {}
    currentFile = path;
    setValue(content);
    // Reconfigure the language for the new file's extension.
    view.dispatch({ effects: langCompartment.reconfigure(langForPath(path)) });
    renderTree();
    const active = treeBody.querySelector('.pe-node.is-active');
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  const createNewFile = async () => {
    const raw = prompt('Filename (e.g. utils.js or lib/foo.js):', '');
    if (!raw) return;
    const name = raw.trim().replace(/^\/+/, '');
    if (!name) return;
    if (fileList.includes(name)) { await switchToFile(name); return; }
    try { await opfsWrite(name, ''); }
    catch (e) {
      alert(`Couldn't create ${name}: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
      return;
    }
    await refreshTree();
    await switchToFile(name);
  };

  /** @param {string} path */
  const deleteFile = async (path) => {
    if (path === pinnedFile) return;
    if (!confirm(`Delete ${path}?\n\nThis removes the file. Imports referencing it will fail until you recreate it.`)) return;
    try { await opfsDelete(path); }
    catch (e) {
      alert(`Delete failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
      return;
    }
    if (currentFile === path) {
      saveTimer = null;
      currentFile = pinnedFile;
      let content = '';
      try { content = await opfsRead(pinnedFile); } catch {}
      setValue(content);
    }
    await refreshTree();
  };

  /**
   * Programmatically replace the editor's content. Used by the
   * Notebook to mirror agent-eval code into notebook.js with a
   * backup-before-overwrite.
   *
   * @param {string} content
   * @param {{ backupTo?: string }} [opts]
   */
  const replaceActiveWith = async (content, { backupTo } = {}) => {
    const prev = getValue();
    if (backupTo && prev.trim().length > 0 && prev !== content) {
      try { await opfsWrite(backupTo, prev); }
      catch (e) { console.warn('[peerd-editor] backup-before-replace failed', e); }
    }
    setValue(content);
    await flushActiveSave();
  };

  // --- Wire UI ---
  newBtn.addEventListener('click', createNewFile);
  onChangeCb = queueSave;

  // --- Initial load ---
  await refreshTree();
  try {
    const content = await opfsRead(currentFile);
    setValue(content);
  } catch { /* file doesn't exist yet -- leave editor empty */ }

  return {
    getActiveFile: () => currentFile,
    getActiveContent: getValue,
    switchToFile,
    refreshTree,
    replaceActiveWith,
    flushSave: flushActiveSave,
    opfs,
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
};
