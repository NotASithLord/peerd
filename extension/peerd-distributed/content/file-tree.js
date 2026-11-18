// @ts-check
// why: bounded signed segments let large files use the existing content wire.
import { buildManifest, manifestHash, verifyManifest, assertBundleWithinLimits } from './manifest.js';
import { CHUNK_SIZE, chunkBytes, sha256hex } from './chunk.js';
import { swarmFetch } from './swarm.js';
import { formatPeerdUri, parsePeerdUri } from './uri.js';
import { utf8 } from '/shared/bundle/bytes.js';

export const FILE_TREE_FORMAT = 'file-tree-v1';
export const FILE_TREE_SEGMENT_BYTES = 16 * 1024 * 1024;
export const FILE_TREE_MAX_BYTES = 16_000_000_000;
const MAX_FILES = 4096, MAX_SEGMENTS = 8192, MAX_INDEX_BYTES = 2_000_000, MAX_RECORD_BYTES = 16_000_000;
const HASH = /^[a-f0-9]{64}$/;
/** @typedef {{hash:string,offset:number,size:number}} Segment */
/** @typedef {{path:string,size:number,segments:Segment[]}} TreeFile */
/** @typedef {{v:1,entry:string,files:TreeFile[]}} FileTreeIndex */
/** @typedef {{v?:number,type?:string,mime?:string,entry?:string,size:number,publisher?:string,sig?:string,
 * chunks:Array<{hash:string,size:number}>,meta?:{format?:string,runtime?:unknown}}} ContentManifest */
/** @typedef {{manifest:ContentManifest,payload:Uint8Array,providers:string[],verifiedContributors:string[]}} TransferResult */
/** @typedef {{signal?:AbortSignal,timeoutMs?:number,providers?:string[],acceptManifest?:(manifest:ContentManifest)=>void|Promise<void>,onProgress?:(progress:unknown)=>void}} SegmentFetchOptions */
/** @typedef {{phase:string,done:number,total:number,path?:string,segment?:unknown}} TreeProgress */
/** @typedef {{manifest:ContentManifest,path:string,offset:number}} StoredSegment */
/** @typedef {{v:1,storageKey:string,manifest:ContentManifest,index:FileTreeIndex,segments:StoredSegment[]}} TreeRecord */

/** @param {unknown} value */
const pathValid = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  && value === value.normalize('NFC') && !/[\\\x00-\x1f\x7f]/.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..');
/** @param {unknown} value @param {string[]} keys @returns {value is Record<string,unknown>} */
const exact = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
/** @param {Array<{path:string,size:number}>} files @param {string} entry */
const validateFiles = (files, entry) => {
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw new Error('file tree file count invalid');
  const names = new Set(); let previous = '', total = 0;
  for (const file of files) {
    if (!file || !pathValid(file.path) || file.path <= previous || !Number.isSafeInteger(file.size)
      || file.size < 0 || file.size > 4_000_000_000) throw new Error('file tree path or size invalid');
    previous = file.path;
    const name = file.path.toLowerCase();
    if (names.has(name)) throw new Error('file tree path alias');
    names.add(name); total += file.size;
    if (total > FILE_TREE_MAX_BYTES) throw new Error('file tree byte quota exceeded');
  }
  for (const name of names) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) {
      if (names.has(parts.join('/'))) throw new Error('file tree file and directory conflict');
      parts.pop();
    }
  }
  if (!pathValid(entry) || !files.some(file => file.path === entry)) throw new Error('file tree entry missing');
  return total;
};

/** @param {unknown} index @returns {FileTreeIndex} */
export const validateFileTreeIndex = index => {
  if (!exact(index, ['v', 'entry', 'files']) || index.v !== 1 || typeof index.entry !== 'string'
    || !Array.isArray(index.files)) throw new Error('file tree version invalid');
  validateFiles(/** @type {TreeFile[]} */ (index.files), index.entry);
  const sizes = new Map(); let count = 0;
  for (const file of /** @type {unknown[]} */ (index.files)) {
    if (!exact(file, ['path', 'size', 'segments']) || typeof file.size !== 'number' || !Array.isArray(file.segments)) throw new Error('file tree file invalid');
    let offset = 0;
    for (const segment of /** @type {unknown[]} */ (file.segments)) {
      if (!exact(segment, ['hash', 'offset', 'size']) || typeof segment.hash !== 'string' || !HASH.test(segment.hash)
        || segment.offset !== offset || typeof segment.size !== 'number' || !Number.isSafeInteger(segment.size) || segment.size <= 0
        || segment.size !== Math.min(FILE_TREE_SEGMENT_BYTES, file.size - offset)
        || (sizes.has(segment.hash) && sizes.get(segment.hash) !== segment.size)) throw new Error('file tree segment invalid');
      sizes.set(segment.hash, segment.size); offset += segment.size;
      if (++count > MAX_SEGMENTS) throw new Error('file tree segment quota exceeded');
    }
    if (offset !== file.size) throw new Error('file tree file coverage invalid');
  }
  if (utf8(JSON.stringify(index)).length > MAX_INDEX_BYTES) throw new Error('file tree index too large');
  return /** @type {FileTreeIndex} */ (index);
};

/** @param {FileSystemDirectoryHandle} directory @param {string} path @param {boolean} create */
const fileHandle = async (directory, path, create) => {
  if (!pathValid(path)) throw new Error('file tree disk path invalid');
  const parts = path.split('/'), leaf = /** @type {string} */ (parts.pop());
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
  return directory.getFileHandle(leaf, { create });
};
/** @param {FileSystemFileHandle} file @param {FileSystemWriteChunkType} bytes @param {AbortSignal} [signal] */
const write = async (file, bytes, signal) => {
  signal?.throwIfAborted();
  const writer = await file.createWritable();
  try { await writer.write(bytes); signal?.throwIfAborted(); await writer.close(); }
  catch (error) { try { await writer.abort(); } catch { /* preserve the write failure */ } throw error; }
};
/** @param {ContentManifest} manifest @param {string} hash @param {string|undefined} publisher @param {number} size */
const verifyStoredManifest = async (manifest, hash, publisher, size) => {
  assertBundleWithinLimits(manifest);
  if (manifest.v !== 1 || manifest.size !== size || manifest.publisher !== publisher
    || await manifestHash(manifest) !== hash || !(await verifyManifest(manifest)).ok) throw new Error('file tree manifest invalid');
  assertCanonicalChunks(manifest);
};
/** @param {ContentManifest} manifest */
const assertCanonicalChunks = manifest => {
  if (manifest.chunks.length !== Math.ceil(manifest.size / CHUNK_SIZE)
    || manifest.chunks.some((/** @type {{size:number}} */ chunk, /** @type {number} */ i) => chunk.size !== Math.min(CHUNK_SIZE, manifest.size - i * CHUNK_SIZE))) {
    throw new Error('file tree chunk layout invalid');
  }
};

/** @param {{directory:FileSystemDirectoryHandle,hash:string,acceptRoot?:(manifest:ContentManifest)=>void|Promise<void>,isAllowed?:()=>boolean}} options */
const readTreeRecord = async ({ directory, hash, acceptRoot = () => {}, isAllowed = () => true }) => {
  if (!isAllowed()) throw new Error('file tree host unavailable');
  if (!HASH.test(hash)) throw new Error('file tree hash invalid');
  const recordFile = await (await directory.getFileHandle(`${hash}.json`)).getFile();
  if (recordFile.size > MAX_RECORD_BYTES) throw new Error('file tree record too large');
  const record = /** @type {TreeRecord} */ (JSON.parse(await recordFile.text()));
  if (!record || record.v !== 1 || !/^[a-f0-9-]{36}$/.test(record.storageKey)) throw new Error('file tree record invalid');
  validateFileTreeIndex(record.index);
  const bytes = utf8(JSON.stringify(record.index));
  await verifyStoredManifest(record.manifest, hash, record.manifest?.publisher, bytes.length);
  if (typeof record.manifest.publisher !== 'string' || record.manifest.meta?.format !== FILE_TREE_FORMAT
    || record.manifest.type !== 'app' || record.manifest.entry !== record.index.entry
    || record.manifest.mime !== 'application/peerd-file-tree+json') throw new Error('file tree root invalid');
  const bucket = await directory.getDirectoryHandle(record.storageKey);
  const storedIndex = await (await bucket.getFileHandle('index.bin')).getFile();
  if (storedIndex.size !== bytes.length) throw new Error('file tree disk index size invalid');
  const storedBytes = new Uint8Array(await storedIndex.arrayBuffer());
  const chunks = chunkBytes(bytes);
  const storedChunks = chunkBytes(storedBytes);
  for (const [i, chunk] of chunks.entries()) if (await sha256hex(chunk) !== record.manifest.chunks[i]?.hash
    || await sha256hex(storedChunks[i]) !== record.manifest.chunks[i]?.hash) throw new Error('file tree index commitment invalid');
  const wanted = new Map(record.index.files.flatMap(item => item.segments.map(segment => [segment.hash, segment.size])));
  if (!Array.isArray(record.segments) || record.segments.length !== wanted.size) throw new Error('file tree segment records invalid');
  const seen = new Set();
  for (const item of record.segments) {
    const childHash = await manifestHash(item.manifest), size = wanted.get(childHash);
    if (seen.has(childHash) || size === undefined || !record.index.files.some(file => file.path === item.path
      && file.segments.some(segment => segment.hash === childHash && segment.offset === item.offset))) throw new Error('file tree segment record not committed');
    await verifyStoredManifest(item.manifest, childHash, record.manifest.publisher, size);
    if (item.manifest.type !== 'data') throw new Error('file tree segment type invalid');
    seen.add(childHash);
  }
  await acceptRoot(record.manifest);
  if (!isAllowed()) throw new Error('file tree host unavailable');
  return record;
};

/** @param {{directory:FileSystemDirectoryHandle,record:TreeRecord,isAllowed:()=>boolean}} options */
const exposeTreeRecord = async ({ directory, record, isAllowed }) => {
  const output = await (await directory.getDirectoryHandle(record.storageKey)).getDirectoryHandle('files');
  const manifests = new Map(await Promise.all(record.segments.map(async item =>
    /** @type {[string,ContentManifest]} */ ([await manifestHash(item.manifest), item.manifest]))));
  const live = () => { if (!isAllowed()) throw new Error('file tree host unavailable'); };
  /** @param {string} path @param {number} offset @param {number} length @param {{signal?:AbortSignal}} [options] */
  const read = async (path, offset, length, { signal } = {}) => {
    live(); signal?.throwIfAborted();
    const entry = record.index.files.find(item => item.path === path);
    if (!entry || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
      || length > FILE_TREE_SEGMENT_BYTES || offset + length > entry.size) throw new Error('file tree read range invalid');
    const file = await (await fileHandle(output, path, false)).getFile();
    if (file.size !== entry.size) throw new Error('file tree disk file size changed');
    const result = new Uint8Array(length); let copied = 0;
    for (const segment of entry.segments) {
      if (segment.offset >= offset + length || segment.offset + segment.size <= offset) continue;
      const manifest = /** @type {ContentManifest} */ (manifests.get(segment.hash));
      for (const [i, chunk] of manifest.chunks.entries()) {
        const start = segment.offset + i * CHUNK_SIZE, end = start + chunk.size;
        const from = Math.max(start, offset), to = Math.min(end, offset + length);
        if (from >= to) continue;
        live(); signal?.throwIfAborted();
        const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
        if (bytes.length !== chunk.size || await sha256hex(bytes) !== chunk.hash) throw new Error('file tree disk chunk changed');
        live(); signal?.throwIfAborted();
        result.set(bytes.subarray(from - start, to - start), from - offset); copied += to - from;
      }
    }
    if (copied !== length) throw new Error('file tree read coverage invalid');
    live(); signal?.throwIfAborted(); return result;
  };
  const hash = await manifestHash(record.manifest); live();
  return { uri: formatPeerdUri({ did: record.manifest.publisher, hash }), hash, manifest: structuredClone(record.manifest),
    index: structuredClone(record.index), storageKey: record.storageKey, directory: output, read };
};

/** @param {{directory:FileSystemDirectoryHandle,hash:string,acceptRoot?:(manifest:ContentManifest)=>void|Promise<void>,isAllowed?:()=>boolean}} options */
export const loadFileTreeRecord = async ({ directory, hash, acceptRoot, isAllowed = () => true }) =>
  exposeTreeRecord({ directory, record: await readTreeRecord({ directory, hash, acceptRoot, isAllowed }), isAllowed });

/**
 * The caller owns this private OPFS directory. Game saves use another directory.
 * The trusted host supplies identity. Public results never include the identity.
 * @param {{directory:FileSystemDirectoryHandle,identity:{did:string,sign:(bytes:Uint8Array)=>Promise<Uint8Array>},
 * content:ReturnType<typeof import('./store.js').createContentStore>,now?:()=>number,isAllowed?:()=>boolean,
 * acceptRoot?:(manifest:ContentManifest)=>void|Promise<void>}} options
 */
export const createFileTreeContent = ({ directory, identity, content, now = Date.now, isAllowed = () => true, acceptRoot = () => {} }) => {
  /** @type {Map<string,Set<string>>} */ const announced = new Map();
  /** @type {Map<string,number>} */ const references = new Map();
  let generation = 0, publication = Promise.resolve();
  const allowed = () => { if (!isAllowed()) throw new Error('file tree host unavailable'); };
  /** @param {TreeRecord} record */
  const publicRecord = record => exposeTreeRecord({ directory, record, isAllowed });
  /** @param {string} hash */
  const readRecord = hash => readTreeRecord({ directory, hash, acceptRoot, isAllowed });
  /** @param {TreeRecord} record @param {AbortSignal} [signal] */
  const commit = (record, signal) => {
    const task = publication.then(async () => {
      signal?.throwIfAborted(); allowed();
      const hash = await manifestHash(record.manifest);
      const stored = await directory.getFileHandle(`${hash}.json`).catch(error => {
        if (error instanceof DOMException && error.name === 'NotFoundError') return null;
        throw error;
      });
      if (stored) {
        const existing = await readRecord(hash);
        signal?.throwIfAborted(); allowed();
        await directory.removeEntry(record.storageKey, { recursive: true });
        return publicRecord(existing);
      }
      signal?.throwIfAborted(); allowed();
      const bytes = utf8(JSON.stringify(record));
      if (bytes.length > MAX_RECORD_BYTES) throw new Error('file tree record too large');
      await write(await directory.getFileHandle(`${hash}.json`, { create: true }), bytes, signal);
      return publicRecord(record);
    });
    publication = task.then(() => {}, () => {}); return task;
  };
  /** @param {{files:Array<{path:string,file:Blob}>,entry:string,runtime?:unknown,signal?:AbortSignal,onProgress?:(progress:TreeProgress)=>void}} options */
  const stage = async ({ files, entry, runtime, signal, onProgress }) => {
    allowed(); signal?.throwIfAborted();
    const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const total = validateFiles(sorted.map(item => ({ path: item.path, size: item.file.size })), entry);
    const storageKey = crypto.randomUUID(), bucket = await directory.getDirectoryHandle(storageKey, { create: true });
    /** @type {FileTreeIndex} */ const index = { v: 1, entry, files: [] };
    /** @type {StoredSegment[]} */ const segments = [];
    const held = new Set(), created = now(); let done = 0;
    try {
      const output = await bucket.getDirectoryHandle('files', { create: true });
      for (const input of sorted) {
        signal?.throwIfAborted(); allowed();
        /** @type {TreeFile} */ const item = { path: input.path, size: input.file.size, segments: [] };
        const writer = await (await fileHandle(output, input.path, true)).createWritable();
        try {
          for (let offset = 0; offset < item.size; offset += FILE_TREE_SEGMENT_BYTES) {
            signal?.throwIfAborted(); allowed();
            const bytes = new Uint8Array(await input.file.slice(offset, offset + FILE_TREE_SEGMENT_BYTES).arrayBuffer());
            const built = await buildManifest({ payload: bytes, type: 'data', mime: 'application/octet-stream', identity, now: () => created });
            assertBundleWithinLimits(built.manifest);
            await writer.write(bytes); signal?.throwIfAborted();
            item.segments.push({ hash: built.hash, offset, size: bytes.length });
            if (!held.has(built.hash)) { held.add(built.hash); segments.push({ manifest: built.manifest, path: item.path, offset }); }
            done += bytes.length; onProgress?.({ phase: 'staging', done, total });
          }
          await writer.close();
        } catch (error) { try { await writer.abort(); } catch { /* preserve the import failure */ } throw error; }
        index.files.push(item);
      }
      validateFileTreeIndex(index);
      const payload = utf8(JSON.stringify(index));
      const built = await buildManifest({ payload, type: 'app', mime: 'application/peerd-file-tree+json', entry, identity, now: () => created,
        meta: { format: FILE_TREE_FORMAT, ...(runtime === undefined ? {} : { runtime }) } });
      assertBundleWithinLimits(built.manifest); await acceptRoot(built.manifest);
      await write(await bucket.getFileHandle('index.bin', { create: true }), payload, signal);
      return await commit({ v: 1, storageKey, manifest: built.manifest, index, segments }, signal);
    } catch (error) { await directory.removeEntry(storageKey, { recursive: true }).catch(() => {}); throw error; }
  };
  /** @param {{uri:string,providers?:string[],channelFor?:Parameters<typeof import('./swarm.js').swarmFetch>[0]['channelFor'],
   * fetchSegment?:(uri:string,options:SegmentFetchOptions)=>Promise<TransferResult>,signal?:AbortSignal,onProgress?:(progress:TreeProgress)=>void,
   * isAllowed?:(did:string)=>boolean,timeoutMs?:number}} options */
  const fetch = async ({ uri, providers = [], channelFor = () => null, fetchSegment, signal, onProgress, isAllowed: peerAllowed, timeoutMs }) => {
    allowed(); signal?.throwIfAborted();
    const address = parsePeerdUri(uri);
    const common = { providers, channelFor, signal, timeoutMs, isAllowed: peerAllowed };
    /** @param {string} addressUri @param {SegmentFetchOptions} options */
    const retrieve = fetchSegment ?? ((addressUri, options) => swarmFetch({ ...common, ...options, uri: addressUri }));
    const root = await retrieve(uri, { signal, timeoutMs, acceptManifest: async (/** @type {ContentManifest} */ manifest) => {
      if (!address.did || manifest.publisher !== address.did || manifest.v !== 1 || manifest.type !== 'app'
        || manifest.meta?.format !== FILE_TREE_FORMAT || manifest.size > MAX_INDEX_BYTES) throw new Error('file tree root invalid');
      assertCanonicalChunks(manifest);
      await acceptRoot(manifest); allowed();
    } });
    const index = validateFileTreeIndex(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(root.payload)));
    if (root.manifest.entry !== index.entry || root.manifest.mime !== 'application/peerd-file-tree+json') throw new Error('file tree entry commitment invalid');
    const storageKey = crypto.randomUUID(), bucket = await directory.getDirectoryHandle(storageKey, { create: true });
    /** @type {TreeRecord} */ const record = { v: 1, storageKey, manifest: root.manifest, index, segments: [] };
    const held = new Set(); let done = 0;
    const total = index.files.reduce((sum, file) => sum + file.size, 0);
    try {
      const output = await bucket.getDirectoryHandle('files', { create: true });
      for (const file of index.files) {
        signal?.throwIfAborted(); allowed();
        const writer = await (await fileHandle(output, file.path, true)).createWritable();
        try {
          for (const segment of file.segments) {
            signal?.throwIfAborted(); allowed();
            const result = await retrieve(formatPeerdUri({ did: root.manifest.publisher, hash: segment.hash }), { signal, timeoutMs, providers: root.providers,
              acceptManifest: (/** @type {ContentManifest} */ manifest) => {
                if (manifest.v !== 1 || manifest.type !== 'data' || manifest.size !== segment.size) throw new Error('file tree segment declaration invalid');
                assertCanonicalChunks(manifest);
              }, onProgress: (/** @type {unknown} */ progress) => onProgress?.({ phase: 'bytes', path: file.path, done, total, segment: progress }) });
            // why: the swarm allocates ArrayBuffer-backed verified output.
            signal?.throwIfAborted(); allowed(); await writer.write(/** @type {Uint8Array<ArrayBuffer>} */ (result.payload));
            if (!held.has(segment.hash)) { held.add(segment.hash); record.segments.push({ manifest: result.manifest, path: file.path, offset: segment.offset }); }
            done += segment.size; onProgress?.({ phase: 'bytes', path: file.path, done, total });
          }
          await writer.close();
        } catch (error) { try { await writer.abort(); } catch { /* preserve the retrieval failure */ } throw error; }
      }
      await write(await bucket.getFileHandle('index.bin', { create: true }), /** @type {Uint8Array<ArrayBuffer>} */ (root.payload), signal);
      return await commit(record, signal);
    } catch (error) { await directory.removeEntry(storageKey, { recursive: true }).catch(() => {}); throw error; }
  };
  /** @param {string} hash */
  const activate = async (/** @type {string} */ hash, /** @type {number} */ current) => {
    allowed(); if (announced.has(hash)) return publicRecord(await readRecord(hash));
    const record = await readRecord(hash), bucket = await directory.getDirectoryHandle(record.storageKey);
    const output = await bucket.getDirectoryHandle('files'), members = new Set();
    const items = [...record.segments, { manifest: record.manifest, path: '', offset: 0 }];
    for (const item of items) {
      const manifest = item.manifest, member = await manifestHash(manifest);
      const handle = item.path ? await fileHandle(output, item.path, false) : await bucket.getFileHandle('index.bin');
      const locations = new Map(manifest.chunks.map((/** @type {{hash:string,size:number}} */ chunk, /** @type {number} */ i) => [chunk.hash, { offset: item.offset + i * CHUNK_SIZE, size: chunk.size }]));
      content.register({ manifest, hash: member, readChunk: async chunkHash => {
        allowed(); const location = /** @type {{offset:number,size:number}} */ (locations.get(chunkHash));
        const file = await handle.getFile();
        const bytes = new Uint8Array(await file.slice(location.offset, location.offset + location.size).arrayBuffer());
        allowed();
        if (bytes.length !== location.size || await sha256hex(bytes) !== chunkHash) throw new Error('file tree disk chunk changed');
        allowed(); return bytes;
      } });
      members.add(member);
    }
    allowed(); if (generation !== current) throw new Error('file tree publication cancelled');
    for (const member of members) { references.set(member, (references.get(member) ?? 0) + 1); content.announce(member); }
    announced.set(hash, members);
    return publicRecord(record);
  };
  /** @param {string} hash */
  const announce = hash => {
    const current = generation;
    const task = publication.then(() => activate(hash, current));
    publication = task.then(() => {}, () => {}); return task;
  };
  /** @param {string} hash */
  const unannounce = hash => {
    generation++;
    const members = announced.get(hash); if (!members) return false;
    announced.delete(hash);
    for (const member of members) {
      const count = (references.get(member) ?? 1) - 1;
      if (count) references.set(member, count);
      else { references.delete(member); content.unannounce(member); }
    }
    return true;
  };
  return Object.freeze({ stage, fetch, announce, unannounce, load: async (/** @type {string} */ hash) => publicRecord(await readRecord(hash)) });
};
