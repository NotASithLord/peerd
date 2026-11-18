// @ts-check
// why: large folder imports must keep File bytes out of extension messages.
import { APP_UPLOAD_OPFS_ROOT } from './app-assets.js';

export const MAX_FILE_TREE_FILES = 4096;
export const MAX_FILE_TREE_BYTES = 16_000_000_000;
const MAX_FILES = MAX_FILE_TREE_FILES;
const MAX_BYTES = MAX_FILE_TREE_BYTES;
/** @param {string} code @param {string} message */
const uploadError = (code, message) => Object.assign(new Error(message), { code });
const safePath = (/** @type {string} */ path) => path.length > 0 && path.length <= 512
  && path === path.normalize('NFC') && !/[\\\x00-\x1f\x7f]/.test(path)
  && path.split('/').every(part => part && part !== '.' && part !== '..');

/** @param {File[]} picked */
export const prepareFileTreeFolder = async (picked) => {
  const kept = picked.filter(file => !(file.webkitRelativePath || file.name).split('/').some(part => part.startsWith('.')));
  const paths = kept.map(file => file.webkitRelativePath || file.name);
  const top = new Set(paths.map(path => path.split('/')[0]));
  const strip = top.size === 1 && paths.every(path => path.includes('/'));
  const sources = kept.map((file, i) => ({ file, path: strip ? paths[i].slice(paths[i].indexOf('/') + 1) : paths[i] }));
  const names = new Set();
  let totalBytes = 0;
  for (const { path, file } of sources) {
    if (!safePath(path)) throw uploadError('unsafe-path', 'This game has an unsafe file path.');
    if (names.has(path.toLowerCase())) throw uploadError('case-collision', 'This game has repeated file paths.');
    names.add(path.toLowerCase()); totalBytes += file.size;
  }
  if (!sources.length) throw uploadError('empty', 'No game files were found.');
  if (sources.length > MAX_FILES) throw uploadError('too-many-files', 'This game exceeds the file limit.');
  if (totalBytes > MAX_BYTES) throw uploadError('too-large', 'This game exceeds the storage limit.');
  for (const name of names) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) {
      if (names.has(parts.join('/'))) throw new Error('A game file conflicts with a folder.');
      parts.pop();
    }
  }
  const entry = sources.find(source => source.path === 'index.html')
    ?? sources.find(source => /\.html?$/i.test(source.path));
  if (!entry || entry.file.size > 1_000_000) throw new Error('This game needs an HTML start page smaller than 1 MB.');
  const html = await entry.file.text();
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    format: /** @type {const} */ ('file-tree-v1'), name: title || (strip ? [...top][0] : 'Web game'), entry: entry.path,
    sources, files: {}, fileCount: sources.length, totalBytes,
    fileDetails: sources.map(({ path, file }) => ({ path, size: file.size })),
    fileKinds: {}, wasm: sources.some(source => /\.wasm$/i.test(source.path)), declaration: null,
    excluded: picked.filter(file => !kept.includes(file)).map(file => file.webkitRelativePath || file.name),
    problems: [], warnings: [],
  };
};

/** @param {FileSystemDirectoryHandle} root @param {string} path @param {boolean} create */
const fileAt = async (root, path, create) => {
  if (!safePath(path)) throw new Error('Invalid game file path.');
  const parts = path.split('/'); const name = /** @type {string} */ (parts.pop());
  for (const part of parts) root = await root.getDirectoryHandle(part, { create });
  return root.getFileHandle(name, { create });
};

/** @param {import('./app-upload.js').PreparedUpload} prepared */
export const stageFileTreeFolder = async (prepared) => {
  if (prepared.format !== 'file-tree-v1' || !prepared.sources || !prepared.fileDetails || !prepared.entry) throw new Error('Game folder review is incomplete.');
  const uploadId = crypto.randomUUID();
  const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle(APP_UPLOAD_OPFS_ROOT, { create: true });
  const root = await parent.getDirectoryHandle(uploadId, { create: true });
  try {
    const files = await root.getDirectoryHandle('files', { create: true });
    for (const source of prepared.sources) {
      const writable = await (await fileAt(files, source.path, true)).createWritable();
      await source.file.stream().pipeTo(writable);
    }
    const receipt = await (await root.getFileHandle('receipt.json', { create: true })).createWritable();
    await receipt.write(JSON.stringify({ v: 1, format: prepared.format, entry: prepared.entry,
      files: prepared.fileDetails, totalBytes: prepared.totalBytes }));
    await receipt.close();
    return uploadId;
  } catch (error) {
    await parent.removeEntry(uploadId, { recursive: true }).catch(() => {});
    throw error;
  }
};

/** @param {string} uploadId */
export const readFileTreeUpload = async (uploadId) => {
  if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw new Error('Invalid game upload.');
  const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle(APP_UPLOAD_OPFS_ROOT);
  const root = await parent.getDirectoryHandle(uploadId);
  const receiptFile = await (await root.getFileHandle('receipt.json')).getFile();
  if (receiptFile.size > 2_000_000) throw new Error('Game upload receipt is too large.');
  const receipt = JSON.parse(await receiptFile.text());
  if (receipt.v !== 1 || receipt.format !== 'file-tree-v1' || !Array.isArray(receipt.files)
    || receipt.files.length < 1 || receipt.files.length > MAX_FILES || !safePath(receipt.entry)) throw new Error('Invalid game upload receipt.');
  const directory = await root.getDirectoryHandle('files');
  const files = []; let total = 0;
  for (const item of receipt.files) {
    const file = await (await fileAt(directory, item.path, false)).getFile();
    if (!Number.isSafeInteger(item.size) || file.size !== item.size) throw new Error('A game upload file changed.');
    total += file.size;
    if (total > MAX_BYTES) throw new Error('Game upload exceeds the storage limit.');
    files.push({ path: item.path, file });
  }
  if (total !== receipt.totalBytes) throw new Error('Game upload size does not match its receipt.');
  return { files, entry: receipt.entry };
};
