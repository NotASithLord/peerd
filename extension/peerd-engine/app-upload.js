// @ts-check
// Turn a folder or a .zip from the user's computer into App files, and stage
// them for the Library's add route. Every rule runs before the add, so the
// review can explain a refusal in one plain sentence. The rules are pure; the
// readers touch only File bytes, DecompressionStream and the staging folder.

import { readZipEntry, readZipIndex } from '/peerd-runtime/doc/zip.js';
import { APP_DATA_PATH_RE } from '/shared/app-dweb-identity.js';
import { bundleDeclaration } from '/shared/app-declaration.js';
import { appRuntimeFromFiles } from '/shared/app-runtime.js';
import {
  APP_UPLOAD_OPFS_ROOT, inferAppFileKind, MAX_APP_FILES, MAX_APP_TOTAL_BYTES,
} from './app-assets.js';
import { buildAppManifest, parseAppManifest } from './app-manifest.js';
import { opfsHelpers } from './opfs.js';

/** @typedef {{ code: string, message: string }} UploadIssue */
/**
 * @typedef {object} PreparedUpload
 * @property {string} name
 * @property {string|null} entry
 * @property {Record<string, Uint8Array>} files
 * @property {Record<string, 'text'|'binary'>} fileKinds
 * @property {number} fileCount
 * @property {number} totalBytes
 * @property {boolean} wasm
 * @property {{dweb:boolean,instructions:boolean,observeAct:boolean}|null} declaration
 * @property {string[]} excluded paths left out of the App
 * @property {UploadIssue[]} problems each one stops the add
 * @property {UploadIssue[]} warnings each one says the game may not start
 */
/** @typedef {{ path: string, size: number, read: (limit: number) => Promise<Uint8Array> }} UploadSource */

const MAX_PATH_CHARS = 512;
// why twice the App cap: left-out folders such as .git/ can make an archive
// larger than the game, but a bigger file would only exhaust this page.
export const MAX_UPLOAD_ZIP_BYTES = 2 * MAX_APP_TOTAL_BYTES;
const WASM_RUNTIME = Object.freeze({ schema: 1, target: 'browser-app', requires: ['wasm-core'] });
const THREAD_MARKERS = /ENVIRONMENT_IS_PTHREAD|\bPThread\.|new SharedArrayBuffer\b/;
const REMOTE_SCRIPT = /<script\b[^>]*?\bsrc\s*=\s*["']?(?:https?:)?\/\/([^\s"'/>]+)/gi;
const ENTITIES = /** @type {Record<string, string>} */ ({
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
});

/** @param {number} bytes */
const megabytes = (bytes) => `${(bytes / 1_000_000).toFixed(1)} MB`;
/** @param {string} code @param {string} message @returns {UploadIssue} */
const issue = (code, message) => ({ code, message });
/** @param {Uint8Array} bytes */
const text = (bytes) => new TextDecoder().decode(bytes);

/**
 * A result that stops the add before any file is kept.
 * @param {string} name @param {UploadIssue} problem
 * @param {{ fileCount?: number, totalBytes?: number, excluded?: string[] }} [facts]
 * @returns {PreparedUpload}
 */
const refusal = (name, problem, { fileCount = 0, totalBytes = 0, excluded = [] } = {}) => ({
  name, entry: null, files: Object.create(null), fileKinds: Object.create(null),
  fileCount, totalBytes, wasm: false, declaration: null, excluded, problems: [problem], warnings: [],
});

/** @param {string} path */
const isLeftOut = (path) => {
  const parts = path.split('/');
  return parts[0] === '__MACOSX' || parts.some((part) => part.startsWith('.'));
};

/** @param {string} path */
const isUnsafePath = (path) => path.length > MAX_PATH_CHARS || path.startsWith('/')
  || /[\\\0]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..');

/** @param {string} path */
const isHtml = (path) => /\.html?$/i.test(path);

/** @param {Uint8Array} bytes */
const isWasm = (bytes) => bytes.length >= 4
  && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;

/** @param {string} html */
const titleOf = (html) => {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return '';
  return match[1].replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, ' ').trim().slice(0, 80);
};

/** @param {string[]} paths @param {Record<string, 'text'|'binary'>} kinds */
const pickEntry = (paths, kinds) => {
  const pages = paths.filter((path) => isHtml(path) && kinds[path] === 'text');
  if (pages.includes('index.html')) return { entry: 'index.html', pages };
  return { entry: pages.length === 1 ? pages[0] : null, pages };
};

/**
 * Find what an unchanged web export needs that an App cannot give it. These
 * are warnings: the game is still added, and the review says it may not start.
 * @param {Record<string, Uint8Array>} files @param {Record<string, 'text'|'binary'>} kinds
 * @returns {UploadIssue[]}
 */
const buildWarnings = (files, kinds) => {
  const paths = Object.keys(files);
  const scripts = paths.filter((path) => kinds[path] === 'text' && /\.(?:m?js|html?)$/i.test(path));
  /** @type {UploadIssue[]} */
  const warnings = [];
  if (scripts.some((path) => THREAD_MARKERS.test(text(files[path])))) {
    warnings.push(issue('threads', 'This game needs several threads at once. Games in peerd run on one thread, so it will probably not start.'));
  }
  const compressed = paths.find((path) => /\.(?:br|unityweb)$/i.test(path));
  if (compressed) {
    warnings.push(issue('compressed', `This game uses a compressed file (${compressed}) that peerd cannot unpack while it runs, so it will probably not start. Export the game again with compression turned off.`));
  }
  const hosts = new Set();
  for (const path of scripts.filter(isHtml)) {
    for (const match of text(files[path]).matchAll(REMOTE_SCRIPT)) hosts.add(match[1].toLowerCase());
  }
  if (hosts.size) {
    warnings.push(issue('remote-script', `This game loads code from the internet (${[...hosts].sort().join(', ')}). Games in peerd run offline, so that part will not load.`));
  }
  return warnings;
};

/**
 * Turn files whose paths are already final into the App files an add creates.
 * A game without its own peerd.json gets one, with a WebAssembly runtime
 * declaration only when a file starts with the WebAssembly magic bytes.
 * @param {Record<string, Uint8Array>} input
 * @param {string} fallbackName the folder or .zip name
 * @returns {PreparedUpload}
 */
export const prepareAppUpload = (input, fallbackName) => {
  /** @type {Record<string, Uint8Array>} */
  const files = Object.assign(Object.create(null), input);
  /** @type {UploadIssue[]} */
  const problems = [];
  const wasm = Object.values(files).some(isWasm);
  /** @type {Record<string, 'text'|'binary'>} */
  const fileKinds = Object.create(null);
  for (const [path, bytes] of Object.entries(files)) fileKinds[path] = inferAppFileKind(path, bytes);
  const paths = Object.keys(files);

  const dataPath = paths.find((path) => APP_DATA_PATH_RE.test(path));
  if (dataPath) {
    problems.push(issue('runtime-data-path', `This game has a file at ${dataPath}. peerd keeps each game's saved data there, so it cannot add this game.`));
  }

  /** @type {string|null} */
  let entry = null;
  if (Object.hasOwn(files, 'peerd.json')) {
    try {
      if (fileKinds['peerd.json'] === 'text') {
        entry = parseAppManifest(text(files['peerd.json'])).entry;
        appRuntimeFromFiles(files);
      }
    } catch { entry = null; }
    if (!entry) problems.push(issue('bad-manifest', "This game's peerd.json file is not valid, so peerd cannot add it."));
    if (entry && (!Object.hasOwn(files, entry) || fileKinds[entry] !== 'text')) {
      problems.push(issue('no-entry', `This game's peerd.json names a start page (${entry}) that is not in the files.`));
      entry = null;
    }
  } else {
    const picked = pickEntry(paths, fileKinds);
    entry = picked.entry;
    if (!entry) {
      problems.push(issue('no-entry', picked.pages.length
        ? 'This game has several web pages, and none is called index.html. Rename the page that starts the game to index.html, then try again.'
        : 'peerd could not find a web page that starts this game. A web game has an index.html file.'));
    } else {
      const manifest = buildAppManifest({ entry, ...(wasm ? { runtime: { ...WASM_RUNTIME, requires: [...WASM_RUNTIME.requires] } } : {}) });
      files['peerd.json'] = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
      fileKinds['peerd.json'] = 'text';
    }
  }

  const fileCount = Object.keys(files).length;
  const totalBytes = Object.values(files).reduce((total, bytes) => total + bytes.byteLength, 0);
  if (fileCount > MAX_APP_FILES) {
    problems.push(issue('too-many-files', `This game has ${fileCount} files. peerd can keep up to ${MAX_APP_FILES} files in one game.`));
  }
  if (totalBytes > MAX_APP_TOTAL_BYTES) {
    problems.push(issue('too-large', `This game is ${megabytes(totalBytes)}. peerd can keep up to ${megabytes(MAX_APP_TOTAL_BYTES)} in one game.`));
  }
  const name = (entry && titleOf(text(files[entry]))) || fallbackName.trim().slice(0, 80) || 'Game';
  return {
    name,
    entry,
    files,
    fileKinds,
    fileCount,
    totalBytes,
    wasm,
    declaration: entry && !problems.length ? bundleDeclaration(files, entry) : null,
    excluded: [],
    problems,
    warnings: buildWarnings(files, fileKinds),
  };
};

/**
 * Apply the path rules, then read each kept file inside one byte budget.
 * @param {UploadSource[]} sources @param {string} fallbackName
 * @returns {Promise<PreparedUpload>}
 */
const collectUpload = async (sources, fallbackName) => {
  const excluded = sources.filter((source) => isLeftOut(source.path)).map((source) => source.path);
  let kept = sources.filter((source) => !isLeftOut(source.path));
  let name = fallbackName;
  const tops = new Set(kept.map((source) => source.path.split('/')[0]));
  if (tops.size === 1 && kept.every((source) => source.path.includes('/'))) {
    const [top] = tops;
    name = top;
    kept = kept.map((source) => ({ ...source, path: source.path.slice(top.length + 1) }));
  }
  const declaredBytes = kept.reduce((total, source) => total + source.size, 0);
  /** @param {UploadIssue} problem */
  const refuse = (problem) => refusal(name, problem, {
    fileCount: kept.length, totalBytes: declaredBytes, excluded,
  });
  if (!kept.length) return refuse(issue('empty', 'peerd found no game files here.'));
  const unsafe = kept.find((source) => isUnsafePath(source.path));
  if (unsafe) return refuse(issue('unsafe-path', `A file in this game has a name peerd cannot use: ${unsafe.path}`));
  /** @type {Map<string, string>} */
  const folded = new Map();
  for (const { path } of kept) {
    const other = folded.get(path.toLowerCase());
    if (other) {
      return refuse(issue('case-collision', `Two files in this game have the same name with different capital letters: ${other} and ${path}.`));
    }
    folded.set(path.toLowerCase(), path);
  }
  if (kept.length > MAX_APP_FILES) {
    return refuse(issue('too-many-files', `This game has ${kept.length} files. peerd can keep up to ${MAX_APP_FILES} files in one game.`));
  }
  if (declaredBytes > MAX_APP_TOTAL_BYTES) {
    return refuse(issue('too-large', `This game is ${megabytes(declaredBytes)}. peerd can keep up to ${megabytes(MAX_APP_TOTAL_BYTES)} in one game.`));
  }
  /** @type {Record<string, Uint8Array>} */
  const files = Object.create(null);
  let remaining = MAX_APP_TOTAL_BYTES;
  const unreadable = issue('unreadable', 'peerd could not read these files. If this is a .zip file, it may be damaged.');
  for (const source of kept) {
    let bytes;
    try { bytes = await source.read(remaining); } catch { return refuse(unreadable); }
    // why: a File or a lying zip member may still return more than it declared.
    if (bytes.byteLength > remaining) return refuse(unreadable);
    remaining -= bytes.byteLength;
    files[source.path] = bytes;
  }
  return { ...prepareAppUpload(files, name), excluded };
};

/**
 * Read a folder picked with webkitdirectory. Left-out files are never read.
 * @param {ArrayLike<File>} picked
 * @returns {Promise<PreparedUpload>}
 */
export const readUploadFolder = (picked) => {
  const list = Array.from(picked);
  return collectUpload(list.map((file) => ({
    path: file.webkitRelativePath || file.name,
    size: file.size,
    read: async () => new Uint8Array(await file.arrayBuffer()),
  })), list[0]?.webkitRelativePath.split('/')[0] || 'Game');
};

/**
 * Read a .zip. The central directory is checked for repeats, the file cap and
 * the declared size before any member is inflated; each inflate then gets the
 * remaining budget, because the declared sizes can lie.
 * @param {File} file
 * @returns {Promise<PreparedUpload>}
 */
export const readUploadZip = async (file) => {
  const fallbackName = file.name.replace(/\.zip$/i, '');
  if (file.size > MAX_UPLOAD_ZIP_BYTES) {
    return refusal(fallbackName, issue('too-large', `This .zip file is ${megabytes(file.size)}. peerd can open .zip files up to ${megabytes(MAX_UPLOAD_ZIP_BYTES)}.`));
  }
  let archive;
  let index;
  try {
    archive = new Uint8Array(await file.arrayBuffer());
    index = readZipIndex(archive, { strict: true });
  } catch {
    return refusal(fallbackName, issue('unreadable', 'peerd could not open this .zip file. It may be damaged.'));
  }
  const bytes = archive;
  const members = [...index.values()].filter((member) => !member.name.endsWith('/'));
  return collectUpload(members.map((member) => ({
    path: member.name,
    size: member.size,
    read: (limit) => readZipEntry(bytes, member, limit),
  })), fallbackName);
};

/**
 * Write prepared files into a fresh staging folder. The add route reads them
 * from there and removes the folder, so one small message adds any game up to
 * the App cap.
 * @param {Record<string, Uint8Array>} files
 * @param {{ uploadId?: string, getDirectory?: () => Promise<FileSystemDirectoryHandle> }} [options]
 * @returns {Promise<string>} the upload id
 */
export const stageAppUpload = async (files, { uploadId = crypto.randomUUID(), getDirectory } = {}) => {
  const staged = opfsHelpers([APP_UPLOAD_OPFS_ROOT, uploadId], getDirectory ? { getDirectory } : {});
  try {
    // why the cast: these bytes come from a File or an inflate, never shared memory.
    for (const [path, bytes] of Object.entries(files)) {
      await staged.write(path, /** @type {Uint8Array<ArrayBuffer>} */ (bytes));
    }
  } catch (error) {
    await staged.nuke().catch(() => {});
    throw error;
  }
  return uploadId;
};
