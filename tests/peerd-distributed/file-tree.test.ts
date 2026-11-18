import { describe, expect, test } from 'bun:test';
import { FILE_TREE_FORMAT, FILE_TREE_SEGMENT_BYTES, validateFileTreeIndex } from '../../extension/peerd-distributed/content/file-tree.js';
import { buildManifest } from '../../extension/peerd-distributed/content/manifest.js';
import { createContentStore } from '../../extension/peerd-distributed/content/store.js';
import { createContentResponder } from '../../extension/peerd-distributed/content/transfer.js';
import { createRoutedContentReader } from '../../extension/peerd-distributed/content/routed.js';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { fromBase64 } from '../../extension/shared/bundle/bytes.js';

// why: use an actual source file for disk reads and content signatures.
const source = Bun.file(new URL('../../extension/shared/bundle/chunk.js', import.meta.url));
const bytes = new Uint8Array(await source.arrayBuffer());
const built = await buildManifest({ payload: bytes, type: 'data', identity: await generateIdentity() });
const index = () => ({ v: 1, entry: 'game/chunk.js', files: [{ path: 'game/chunk.js', size: bytes.length,
  segments: [{ hash: built.hash, offset: 0, size: bytes.length }] }] });

describe('versioned file tree commitments', () => {
  test('accepts a real file commitment and defines empty files without segments', () => {
    const value = index();
    value.files.unshift({ path: 'empty', size: 0, segments: [] });
    expect(validateFileTreeIndex(value).files).toBe(value.files);
    expect(FILE_TREE_FORMAT).toBe('file-tree-v1');
    expect(FILE_TREE_SEGMENT_BYTES).toBeLessThan(50_000_000);
  });

  test.each(['../outside', '/absolute', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'a\0b', 'e\u0301'])('rejects path alias %j before disk IO', path => {
    const value = index(); value.entry = path; value.files[0]!.path = path;
    expect(() => validateFileTreeIndex(value)).toThrow();
  });

  test('rejects case aliases, file-directory conflicts, unsorted paths and missing entry', () => {
    for (const paths of [['GAME', 'game'], ['game', 'game/chunk.js'], ['z', 'a']]) {
      const value = index(); value.entry = paths[0]!;
      value.files = paths.map(path => ({ ...value.files[0]!, path }));
      expect(() => validateFileTreeIndex(value)).toThrow();
    }
    const value = index(); value.entry = 'missing';
    expect(() => validateFileTreeIndex(value)).toThrow();
  });

  test('rejects gaps, overlap, incomplete coverage, wrong hashes and unsupported versions', () => {
    for (const change of [
      (value: ReturnType<typeof index>) => { value.files[0]!.segments[0]!.offset = 1; },
      (value: ReturnType<typeof index>) => { value.files[0]!.segments.push({ ...value.files[0]!.segments[0]! }); },
      (value: ReturnType<typeof index>) => { value.files[0]!.segments = []; },
      (value: ReturnType<typeof index>) => { value.files[0]!.segments[0]!.hash = 'invalid'; },
      (value: ReturnType<typeof index>) => { value.v = 2; },
      (value: ReturnType<typeof index>) => { value.files[0]!.size = Number.MAX_SAFE_INTEGER; },
    ]) {
      const value = index(); change(value);
      expect(() => validateFileTreeIndex(value)).toThrow();
    }
    expect(() => validateFileTreeIndex({ ...index(), recursive: index() })).toThrow();
  });

  test('refuses excessive file counts before a transfer starts', () => {
    const value = index(); value.entry = '0000';
    value.files = Array.from({ length: 4097 }, (_, i) => ({ path: String(i).padStart(4, '0'), size: 0, segments: [] }));
    expect(() => validateFileTreeIndex(value)).toThrow('file count');
  });
});

describe('announce-gated asynchronous disk reads', () => {
  const diskSource = () => {
    const store = createContentStore();
    store.register({ manifest: built.manifest, hash: built.hash,
      readChunk: async () => new Uint8Array(await source.arrayBuffer()) });
    return store;
  };
  test('registration does not publish disk bytes', async () => {
    const store = diskSource(), hash = built.manifest.chunks[0]!.hash;
    expect(store.getManifest(built.hash)).toBeNull();
    expect(await store.readChunk(hash)).toBeNull();
    store.announce(built.hash);
    expect(await store.readChunk(hash)).toEqual(bytes);
    store.unannounce(built.hash);
    expect(await store.readChunk(hash)).toBeNull();
  });

  test('revocation refuses a disk read that was already pending', async () => {
    const store = createContentStore();
    let resume!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    store.register({ manifest: built.manifest, hash: built.hash, readChunk: async () => {
      await waiting; return new Uint8Array(await source.arrayBuffer());
    } });
    store.announce(built.hash);
    const reading = store.readChunk(built.manifest.chunks[0]!.hash);
    store.unannounce(built.hash); resume();
    expect(await reading).toBeNull();
  });

  test('the real direct responder awaits disk IO and keeps chunk framing', async () => {
    const store = diskSource(); store.announce(built.hash);
    const messages: import('../../extension/peerd-distributed/content/transfer.js').ContentMsg[] = [];
    await createContentResponder({ store })({ t: 'CHUNK_REQ', hash: built.manifest.chunks[0]!.hash, requestId: 'disk-read' }, message => { messages.push(message); });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.requestId).toBe('disk-read');
    expect(fromBase64(messages[0]!.bytes!)).toEqual(bytes);
  });

  test('the real routed reader awaits disk IO and retains revocation', async () => {
    const store = diskSource(); store.announce(built.hash);
    const read = createRoutedContentReader({ store }), controller = new AbortController();
    try {
      expect(await read({ kind: 'chunk', hash: built.manifest.chunks[0]!.hash }, controller.signal)).toEqual(bytes);
    } finally { controller.abort(); }
    store.unannounce(built.hash);
    const absent = new AbortController();
    try { expect(await read({ kind: 'chunk', hash: built.manifest.chunks[0]!.hash }, absent.signal)).toBeNull(); }
    finally { absent.abort(); }
  });
});
