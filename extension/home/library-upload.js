// @ts-check
// Library "Add from files": pick a folder or a .zip, read a plain review, add
// the game with one click, then open it. The file rules live in
// /peerd-engine/app-upload.js. why loaded on demand: the zip reader and the
// rules matter only after a pick, so the Library's first paint never pays.

import m from '/vendor/mithril/mithril.js';

/** @typedef {import('../options/sections/reset-row.js').Send} Send */
/** @typedef {import('/peerd-engine/app-upload.js').PreparedUpload} PreparedUpload */
/** @typedef {{ reading: boolean, adding: boolean, prepared: PreparedUpload|null, error: string|null }} UploadState */

const loadRules = () => import('/peerd-engine/app-upload.js');

/** @returns {UploadState} */
export const createUploadState = () => ({ reading: false, adding: false, prepared: null, error: null });

/** @param {number} bytes */
const sizeLabel = (bytes) => (bytes < 1_000 ? `${bytes} B`
  : bytes < 1_000_000 ? `${(bytes / 1_000).toFixed(1)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`);

/**
 * What a game's own peerd.json asks for, in plain words.
 * @param {PreparedUpload['declaration']} declaration
 */
export const uploadAsks = (declaration) => [
  declaration?.dweb ? 'Talks to other people over the peer network.' : null,
  declaration?.instructions ? "Gives peerd's assistant its own instructions for this game." : null,
  declaration?.observeAct ? "Lets peerd's assistant see the game and press its controls." : null,
].filter((line) => line !== null);

/**
 * Read a pick into a review. Nothing is stored yet.
 * @param {UploadState} state @param {'folder'|'zip'} kind @param {File[]} picked
 */
export const reviewUpload = async (state, kind, picked) => {
  if (!picked.length || state.reading || state.adding) return;
  state.reading = true;
  state.error = null;
  state.prepared = null;
  try {
    const rules = await loadRules();
    state.prepared = kind === 'zip' ? await rules.readUploadZip(picked[0]) : await rules.readUploadFolder(picked);
  } catch {
    state.error = 'peerd could not read these files. Try again.';
  } finally {
    state.reading = false;
  }
};

/**
 * Stage the reviewed files, ask the service worker to add them, then open the
 * game. Returns the notice for the Library, or null when nothing was added.
 * @param {UploadState} state @param {Send} send
 * @returns {Promise<string|null>}
 */
export const addUpload = async (state, send) => {
  const prepared = state.prepared;
  if (!prepared || prepared.problems.length || state.adding) return null;
  state.adding = true;
  state.error = null;
  try {
    let uploadId;
    try { uploadId = await (await loadRules()).stageAppUpload(prepared.files); } catch {
      state.error = 'peerd could not save these files on this computer. Try again.';
      return null;
    }
    let reply;
    try { reply = await send({ type: 'apps/import-files', uploadId, name: prepared.name }); } catch {
      reply = { ok: false, outcomeKnown: false };
    }
    if (!reply?.ok) {
      // why a fresh pick after an unknown outcome: the game may already be in
      // the Library, and a second click must not add it twice.
      if (reply?.outcomeKnown === false) state.prepared = null;
      state.error = reply?.outcomeKnown === false
        ? 'peerd could not confirm whether the game was added. Check the Library before you try again.'
        : 'peerd could not add this game. Try again.';
      return null;
    }
    state.prepared = null;
    const opened = await send({ type: 'apps/open', appId: reply.id }).catch(() => null);
    return opened?.ok
      ? `Added ${reply.name} to your Library and opened it.`
      : `Added ${reply.name} to your Library. Open it from the Library.`;
  } finally {
    state.adding = false;
  }
};

/** @param {PreparedUpload} prepared */
const technicalDetails = (prepared) => m('details.library-upload-details', [
  m('summary', 'Technical details'),
  m('dl', [
    m('dt', 'Start page'), m('dd', prepared.entry ?? 'Not found'),
    m('dt', 'Files'), m('dd', String(prepared.fileCount)),
    m('dt', 'Size'), m('dd', sizeLabel(prepared.totalBytes)),
    m('dt', 'WebAssembly'), m('dd', prepared.wasm ? 'Yes' : 'No'),
    prepared.excluded.length ? [
      m('dt', 'Left out'), m('dd', `${prepared.excluded.length} hidden or system file${prepared.excluded.length === 1 ? '' : 's'}`),
    ] : null,
  ]),
  m('ul.library-upload-files', [
    ...Object.keys(prepared.files).sort().map((path) => m('li', [
      m('code', path), ' ', m('span.muted', sizeLabel(prepared.files[path].byteLength)),
    ])),
    ...prepared.excluded.map((path) => m('li.muted', [m('code', path), ' left out'])),
  ]),
]);

export const LibraryUpload = {
  /** @param {{ attrs: { state: UploadState, send: Send, onAdded: (notice: string) => void },
   *   state: { folder?: HTMLInputElement, zip?: HTMLInputElement } }} vnode */
  view(vnode) {
    const { state, send, onAdded } = vnode.attrs;
    const prepared = state.prepared;
    const busy = state.reading || state.adding;
    /** @param {'folder'|'zip'} kind */
    const pick = (kind) => async (/** @type {{ target: HTMLInputElement }} */ event) => {
      const files = Array.from(event.target.files ?? []);
      // why reset: picking the same folder twice must read it again.
      event.target.value = '';
      await reviewUpload(state, kind, files);
      m.redraw();
    };
    const asks = prepared ? uploadAsks(prepared.declaration) : [];
    return m('section.library-git-import.library-upload', { 'aria-label': 'Add a game from your computer' }, [
      m('strong', 'Add a game from your computer'),
      m('p.muted', 'Choose the folder or the .zip file of a game made for the web. peerd keeps its own copy in your Library.'),
      m('.library-upload-pick', [
        m('button.library-btn', { type: 'button', disabled: busy, onclick: () => vnode.state.folder?.click() }, 'Choose folder'),
        m('button.library-btn', { type: 'button', disabled: busy, onclick: () => vnode.state.zip?.click() }, 'Choose .zip file'),
        m('input.library-upload-input', {
          type: 'file', webkitdirectory: true, multiple: true, 'aria-label': 'Game folder',
          oncreate: (/** @type {{ dom: HTMLInputElement }} */ input) => { vnode.state.folder = input.dom; },
          onchange: pick('folder'),
        }),
        m('input.library-upload-input', {
          type: 'file', accept: '.zip,application/zip', 'aria-label': 'Game .zip file',
          oncreate: (/** @type {{ dom: HTMLInputElement }} */ input) => { vnode.state.zip = input.dom; },
          onchange: pick('zip'),
        }),
      ]),
      state.reading ? m('p.muted', { role: 'status' }, 'Reading the files…') : null,
      state.error ? m('p.error', { role: 'alert' }, state.error) : null,
      prepared ? m('.library-upload-review', [
        m('p.library-upload-name', m('strong', prepared.name)),
        m('p', 'Runs offline in its own tab.'),
        m('p.muted', 'These files came from your computer. peerd did not check who made them.'),
        prepared.problems.length
          ? m('ul.library-upload-problems', { role: 'alert' }, prepared.problems.map((problem) => m('li', problem.message)))
          : m('.library-upload-asks', [
            m('p', 'What it asks for:'),
            asks.length ? m('ul', asks.map((line) => m('li', line))) : m('p.muted', 'Nothing more.'),
          ]),
        prepared.warnings.length
          ? m('ul.library-upload-warnings', prepared.warnings.map((warning) => m('li', warning.message)))
          : null,
        technicalDetails(prepared),
        m('.library-upload-actions', [
          m('button.library-open', {
            type: 'button', disabled: busy || prepared.problems.length > 0,
            onclick: async () => {
              const notice = await addUpload(state, send);
              m.redraw();
              if (notice) onAdded(notice);
            },
          }, state.adding ? 'Adding…' : 'Add to Library'),
          m('button.library-btn', {
            type: 'button', disabled: busy,
            onclick: () => { state.prepared = null; state.error = null; },
          }, 'Cancel'),
        ]),
      ]) : null,
    ]);
  },
};
