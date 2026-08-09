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
.pe-new, .pe-delete {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  min-height: 24px;
  background: transparent;
  border: 0;
  color: var(--pe-fg-muted);
  font-size: 10px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}
.pe-new:hover, .pe-delete:hover:not(:disabled) { color: var(--pe-accent); }
.pe-delete:disabled { opacity: 0.35; cursor: default; }
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
.pe-node:focus-visible { outline: 1px solid var(--pe-fg-muted); outline-offset: -1px; color: var(--pe-fg); }
.pe-node.is-active { background: var(--pe-bg-editor); color: var(--pe-fg); }
.pe-node.is-active::before {
  content: ''; position: absolute; inset: 0 auto 0 0; width: 2px; background: var(--pe-accent);
}
.pe-node.is-pinned { font-weight: 500; }
.pe-node.is-readonly { opacity: 0.78; }
.pe-node.is-readonly .pe-icon { opacity: 1; }
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
 * @param {(path: string, error: unknown) => void} [config.onSaveError]
 * @param {(dirty: boolean, path: string) => void} [config.onDirtyChange]
 * @param {(path: string, content: string) => Promise<void>} [config.writeFile]
 * @param {(path: string) => Promise<void>} [config.deleteFile]
 * @param {() => void | Promise<void>} [config.beforeOpfsMutation]
 * @param {(action: 'create' | 'delete', path: string, error: unknown) => void} [config.onMutationError]
 * @param {string} [config.initialFile]         -- file to open first (default: pinnedFile)
 * @param {(path: string) => boolean} [config.isReadOnlyFile]
 * @param {(path: string) => void} [config.onReadOnlyFile]
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
    onSaveError,
    onDirtyChange,
    writeFile,
    deleteFile: deleteFileOverride,
    beforeOpfsMutation,
    onMutationError,
    initialFile,
    isReadOnlyFile = () => false,
    onReadOnlyFile,
  } = config;

  injectStyle();

  // --- DOM scaffold ---
  mountEl.classList.add('pe-root');
  mountEl.innerHTML = `
    <aside class="pe-tree">
      <div class="pe-tree-header">
        <span class="pe-tree-label">files</span>
        <span>
          <button class="pe-delete" title="Delete focused file" aria-label="Delete focused file" disabled>Delete</button>
          <button class="pe-new" title="New file" aria-label="New file">New</button>
        </span>
      </div>
      <div class="pe-tree-body" role="tree" aria-label="Files"></div>
    </aside>
    <div class="pe-editor-column">
      <div class="pe-host"></div>
    </div>
  `;
  // why the non-null assert: these three nodes were just written into
  // mountEl.innerHTML directly above, so the selectors always resolve.
  const treeBody = /** @type {HTMLElement} */ (mountEl.querySelector('.pe-tree-body'));
  const newBtn = /** @type {HTMLElement} */ (mountEl.querySelector('.pe-new'));
  const deleteBtn = /** @type {HTMLButtonElement} */ (mountEl.querySelector('.pe-delete'));
  const host = /** @type {HTMLElement} */ (mountEl.querySelector('.pe-host'));

  // --- OPFS helpers ---
  const opfs = opfsHelpers(opfsBase, { beforeMutation: beforeOpfsMutation });
  const { read: opfsRead, write: opfsWrite, delete: opfsDelete, list: opfsList } = opfs;
  const persistFile = writeFile ?? opfsWrite;
  const removeFile = deleteFileOverride ?? opfsDelete;

  // --- CodeMirror ---
  // why the codemirror surface is untyped: the vendored cm.js is a
  // minified bundle with no .d.ts (excluded from typecheck per
  // tsconfig), so its exports resolve as `any`. We annotate our own
  // locals; the CM ViewUpdate is described structurally by what we read.
  /** @type {(() => void) | null} */
  let onChangeCb = null;
  let applyingProgrammaticValue = false;
  const update = EditorView.updateListener.of(/** @param {{ docChanged: boolean }} u */ (u) => {
    if (u.docChanged && !applyingProgrammaticValue && onChangeCb) onChangeCb();
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
  const setValue = (text) => {
    applyingProgrammaticValue = true;
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    } finally { applyingProgrammaticValue = false; }
  };

  // --- State ---
  let currentFile = initialFile || pinnedFile;
  /** @type {string[]} */
  let fileList = [pinnedFile];
  /** @type {Set<string>} */
  const collapsedDirs = new Set();
  /** @type {ReturnType<typeof setTimeout> | null} */
  let saveTimer = null;
  let dirty = false;
  let editRevision = 0;
  /** @type {Promise<void> | null} */
  let activeSave = null;
  let deletingActiveFile = false;
  let focusedTreeKey = `file:${currentFile}`;
  let restoreTreeFocus = false;
  /** @param {boolean} value */
  const setDirty = (value) => {
    if (dirty === value) return;
    dirty = value;
    onDirtyChange?.(dirty, currentFile);
  };

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
    const activeRow = document.activeElement instanceof Element
      ? document.activeElement.closest('.pe-node')
      : null;
    const hadTreeFocus = restoreTreeFocus || treeBody.contains(document.activeElement);
    restoreTreeFocus = false;
    if (activeRow instanceof HTMLElement && activeRow.dataset.key) {
      focusedTreeKey = activeRow.dataset.key;
    }

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
          cur = /** @type {{ children: Map<string, TreeNode> }} */ (cur.children.get(part));
        }
      }
    }

    treeBody.innerHTML = '';
    /** @type {HTMLElement[]} */
    const visibleRows = [];
    /** @type {Map<string, HTMLElement>} */
    const rowsByKey = new Map();

    /** @param {HTMLElement} row */
    const updateDeleteTarget = (row) => {
      const path = row.dataset.kind === 'file' ? row.dataset.path : '';
      const canDelete = !!path && path !== pinnedFile;
      deleteBtn.disabled = !canDelete;
      const label = canDelete ? `Delete ${path}` : 'Delete focused file';
      deleteBtn.title = label;
      deleteBtn.setAttribute('aria-label', label);
    };

    /** @param {HTMLElement} row */
    const focusRow = (row) => {
      for (const item of visibleRows) item.tabIndex = item === row ? 0 : -1;
      focusedTreeKey = row.dataset.key ?? focusedTreeKey;
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      updateDeleteTarget(row);
    };

    /** @param {KeyboardEvent} event */
    const handleTreeKey = (event) => {
      const row = /** @type {HTMLElement} */ (event.currentTarget);
      const index = visibleRows.indexOf(row);
      let target = null;
      if (event.key === 'ArrowUp') target = visibleRows[index - 1] ?? row;
      else if (event.key === 'ArrowDown') target = visibleRows[index + 1] ?? row;
      else if (event.key === 'Home') target = visibleRows[0] ?? row;
      else if (event.key === 'End') target = visibleRows.at(-1) ?? row;
      else if (event.key === 'ArrowRight' && row.dataset.kind === 'dir') {
        if (row.getAttribute('aria-expanded') === 'false') row.click();
        else {
          const next = visibleRows[index + 1];
          if (next && Number(next.getAttribute('aria-level')) > Number(row.getAttribute('aria-level'))) target = next;
        }
      } else if (event.key === 'ArrowLeft') {
        if (row.dataset.kind === 'dir' && row.getAttribute('aria-expanded') === 'true') row.click();
        else target = rowsByKey.get(row.dataset.parentKey ?? '') ?? row;
      } else if (event.key === 'Enter' || event.key === ' ') row.click();
      else if (event.key === 'Delete' && row.dataset.kind === 'file' && row.dataset.path !== pinnedFile) {
        deleteFile(row.dataset.path ?? '');
      } else return;
      event.preventDefault();
      if (target) focusRow(target);
    };

    /**
     * @param {TreeNode} node
     * @param {number} depth
     * @param {number} position
     * @param {number} setSize
     * @param {string} parentKey
     */
    const append = (node, depth, position, setSize, parentKey) => {
      const isDirectory = !!node.children;
      const path = isDirectory ? (node.dirPath ?? '') : (node.path ?? '');
      const key = `${isDirectory ? 'dir' : 'file'}:${path}`;
      const row = document.createElement('div');
      row.className = 'pe-node';
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(depth + 1));
      row.setAttribute('aria-posinset', String(position + 1));
      row.setAttribute('aria-setsize', String(setSize));
      row.dataset.key = key;
      row.dataset.kind = isDirectory ? 'dir' : 'file';
      row.dataset.path = path;
      row.dataset.parentKey = parentKey;
      row.tabIndex = -1;

      if (isDirectory) {
        const isCollapsed = collapsedDirs.has(path);
        row.title = path;
        row.setAttribute('aria-expanded', String(!isCollapsed));
        row.innerHTML =
          `<span aria-hidden="true" class="pe-indent" style="width:${depth * 10}px"></span>` +
          `<span aria-hidden="true" class="pe-twirl">${isCollapsed ? '▶' : '▼'}</span>` +
          '<span aria-hidden="true" class="pe-icon">▸</span>' +
          '<span class="pe-label"></span>';
        row.addEventListener('click', () => {
          focusedTreeKey = key;
          if (isCollapsed) collapsedDirs.delete(path);
          else collapsedDirs.add(path);
          renderTree();
        });
      } else {
        if (path === currentFile) row.classList.add('is-active');
        if (path === pinnedFile) row.classList.add('is-pinned');
        row.setAttribute('aria-selected', String(path === currentFile));
        const readOnly = isReadOnlyFile(path);
        if (readOnly) row.classList.add('is-readonly');
        row.title = readOnly ? `${path}, binary asset, read-only` : path;
        row.setAttribute('aria-label', readOnly ? `${path}, binary asset, read-only` : path);
        row.innerHTML =
          `<span aria-hidden="true" class="pe-indent" style="width:${depth * 10}px"></span>` +
          '<span aria-hidden="true" class="pe-twirl"></span>' +
          `<span aria-hidden="true" class="pe-icon">${readOnly ? '◆' : '⋮'}</span>` +
          '<span class="pe-label"></span>';
        row.addEventListener('click', () => {
          focusedTreeKey = key;
          switchToFile(path);
        });
      }
      const label = row.querySelector('.pe-label');
      if (label) label.textContent = node.name;
      row.addEventListener('focus', () => {
        focusedTreeKey = key;
        updateDeleteTarget(row);
      });
      row.addEventListener('keydown', handleTreeKey);
      treeBody.appendChild(row);
      visibleRows.push(row);
      rowsByKey.set(key, row);

      if (node.children && !collapsedDirs.has(path)) {
        const children = Array.from(node.children.values()).sort(compareTreeNodes);
        for (const [index, child] of children.entries()) {
          append(child, depth + 1, index, children.length, key);
        }
      }
    };

    const rootEntries = Array.from(root.children.values()).sort(compareTreeNodes);
    for (const [index, entry] of rootEntries.entries()) {
      append(entry, 0, index, rootEntries.length, '');
    }
    const preferred = rowsByKey.get(focusedTreeKey)
      ?? rowsByKey.get(`file:${currentFile}`)
      ?? visibleRows[0];
    if (preferred) {
      preferred.tabIndex = 0;
      focusedTreeKey = preferred.dataset.key ?? focusedTreeKey;
      updateDeleteTarget(preferred);
      if (hadTreeFocus) focusRow(preferred);
    } else deleteBtn.disabled = true;
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
    while (dirty && !deletingActiveFile && !isReadOnlyFile(currentFile)) {
      if (activeSave) {
        await activeSave;
        continue;
      }
      const path = currentFile;
      const content = getValue();
      const revision = editRevision;
      const attempt = (async () => {
        try {
          await persistFile(path, content);
          if (currentFile === path && editRevision === revision && getValue() === content) setDirty(false);
          onSaved?.(path, content);
        } catch (error) {
          console.warn('[peerd-editor] flush save failed', error);
          // A confirmed delete intentionally discards this buffer. If its
          // already-running save loses the race, the delete result is the only
          // status that remains relevant to the user.
          if (!deletingActiveFile) onSaveError?.(path, error);
          throw error;
        }
      })();
      activeSave = attempt;
      try { await attempt; }
      // why unconditional: no competing flush can replace activeSave while it
      // is non-null; every concurrent caller waits for this same attempt.
      finally { activeSave = null; }
    }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  };

  const queueSave = () => {
    if (isReadOnlyFile(currentFile)) return;
    setDirty(true);
    editRevision += 1;
    if (deletingActiveFile) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try { await flushActiveSave(); }
      catch { /* flushActiveSave reports the failure and keeps the buffer dirty. */ }
    }, 400);
  };

  /** @param {string} path */
  const switchToFile = async (path) => {
    if (path === currentFile) return;
    if (isReadOnlyFile(path)) {
      onReadOnlyFile?.(path);
      return;
    }
    try { await flushActiveSave(); }
    catch { return; }
    let content = '';
    try { content = await opfsRead(path); } catch {}
    currentFile = path;
    setValue(content);
    setDirty(false);
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
    if (isReadOnlyFile(name)) {
      onReadOnlyFile?.(name);
      return;
    }
    if (fileList.includes(name)) { await switchToFile(name); return; }
    try { await persistFile(name, ''); }
    catch (e) {
      if (onMutationError) onMutationError('create', name, e);
      else alert(`Couldn't create ${name}: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
      return;
    }
    await refreshTree();
    await switchToFile(name);
  };

  /** @param {string} path */
  const deleteFile = async (path) => {
    if (path === pinnedFile) return;
    if (!confirm(`Delete ${path}?\n\nThis removes the file. Imports referencing it will fail until you recreate it.`)) return;
    const visible = Array.from(treeBody.querySelectorAll('.pe-node'));
    const deletedIndex = visible.findIndex((row) => /** @type {HTMLElement} */ (row).dataset.path === path);
    const fallback = visible[deletedIndex + 1] ?? visible[deletedIndex - 1]
      ?? treeBody.querySelector(`[data-key="file:${CSS.escape(pinnedFile)}"]`);
    const shouldRestoreTreeFocus = treeBody.contains(document.activeElement) || document.activeElement === deleteBtn;
    const deletedActiveFile = currentFile === path;
    const hadUnsavedChanges = deletedActiveFile && dirty;
    if (deletedActiveFile) {
      deletingActiveFile = true;
      setDirty(false);
      editRevision += 1;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      try { await activeSave; }
      catch { /* the confirmed delete still runs after a failed earlier save */ }
    }
    try { await removeFile(path); }
    catch (e) {
      if (deletedActiveFile) {
        deletingActiveFile = false;
        if (hadUnsavedChanges || dirty) {
          setDirty(false);
          queueSave();
        }
      } else if (hadUnsavedChanges) {
        setDirty(false);
        queueSave();
      }
      restoreTreeFocus = false;
      if (onMutationError) onMutationError('delete', path, e);
      else alert(`Delete failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
      return;
    }
    if (deletedActiveFile) {
      currentFile = pinnedFile;
      let content = '';
      try { content = await opfsRead(pinnedFile); } catch {}
      setValue(content);
      setDirty(false);
      deletingActiveFile = false;
    }
    if (fallback instanceof HTMLElement && fallback.dataset.key) focusedTreeKey = fallback.dataset.key;
    restoreTreeFocus = shouldRestoreTreeFocus;
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
      try { await persistFile(backupTo, prev); }
      catch (e) { console.warn('[peerd-editor] backup-before-replace failed', e); }
    }
    setValue(content);
    setDirty(true);
    editRevision += 1;
    await flushActiveSave();
  };

  // --- Wire UI ---
  newBtn.addEventListener('click', createNewFile);
  deleteBtn.addEventListener('click', () => {
    if (!focusedTreeKey.startsWith('file:')) return;
    const path = focusedTreeKey.slice('file:'.length);
    if (path !== pinnedFile) deleteFile(path);
  });
  onChangeCb = queueSave;

  // --- Initial load ---
  await refreshTree();
  try {
    const content = await opfsRead(currentFile);
    setValue(content);
    setDirty(false);
  } catch { /* file doesn't exist yet -- leave editor empty */ }

  return {
    getActiveFile: () => currentFile,
    getActiveContent: getValue,
    hasUnsavedChanges: () => dirty,
    switchToFile,
    refreshTree,
    replaceActiveWith,
    flushSave: flushActiveSave,
    opfs,
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
};
