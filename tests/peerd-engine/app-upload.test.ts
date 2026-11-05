import { describe, test, expect } from 'bun:test';
import {
  MAX_UPLOAD_ZIP_BYTES, prepareAppUpload, readUploadFolder, readUploadZip, stageAppUpload,
} from '../../extension/peerd-engine/app-upload.js';
import { MAX_APP_FILES, MAX_APP_TOTAL_BYTES } from '../../extension/peerd-engine/app-assets.js';
import { readZipEntry, readZipIndex } from '../../extension/peerd-runtime/doc/zip.js';
import { makeZip } from '../peerd-runtime/doc/fixtures.ts';

const utf8 = (value: string) => new TextEncoder().encode(value);
const WASM = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const PAGE = '<!doctype html><title>Dr Turtle &amp; Mr Gamera</title><canvas></canvas><script src=game.js></script>';

const pickFile = (path: string, content: string | Uint8Array) => {
  const file = new File([typeof content === 'string' ? content : content as unknown as BlobPart], path.split('/').pop() ?? path);
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
};
const zipFile = async (members: Parameters<typeof makeZip>[0], name = 'game.zip') =>
  new File([await makeZip(members) as unknown as BlobPart], name);
const manifestOf = (prepared: { files: Record<string, Uint8Array> }) =>
  JSON.parse(new TextDecoder().decode(prepared.files['peerd.json']));
const codes = (issues: Array<{ code: string }>) => issues.map((item) => item.code);

describe('prepareAppUpload', () => {
  test('picks index.html, else the only page, and names the game from its title', () => {
    const both = prepareAppUpload({ 'index.html': utf8(PAGE), 'about.html': utf8('<p>x</p>') }, 'folder');
    expect(both.entry).toBe('index.html');
    expect(both.name).toBe('Dr Turtle & Mr Gamera');
    const only = prepareAppUpload({ 'drturtle.html': utf8('<p>no title</p>'), 'game.js': utf8('run()') }, 'drturtle');
    expect(only.entry).toBe('drturtle.html');
    expect(only.name).toBe('drturtle');
    expect(manifestOf(only)).toMatchObject({ schema: 1, kind: 'app', entry: 'drturtle.html', capabilities: [] });
  });

  test('refuses an upload with several pages and no index.html', () => {
    const prepared = prepareAppUpload({ 'a.html': utf8('a'), 'b.html': utf8('b') }, 'two');
    expect(prepared.entry).toBeNull();
    expect(codes(prepared.problems)).toEqual(['no-entry']);
    expect(prepared.problems[0].message).toContain('index.html');
  });

  test('sets kinds with inferAppFileKind and declares wasm-core only when WebAssembly is present', () => {
    const plain = prepareAppUpload({ 'index.html': utf8(PAGE), 'game.js': utf8('run()') }, 'g');
    expect(plain.wasm).toBe(false);
    expect(manifestOf(plain).runtime).toBeUndefined();
    const game = prepareAppUpload({
      'index.html': utf8(PAGE), 'game.js': utf8('run()'), 'game.bin': WASM, 'game.data': utf8('abc'),
    }, 'g');
    expect(game.wasm).toBe(true);
    expect(manifestOf(game).runtime).toEqual({ schema: 1, target: 'browser-app', requires: ['wasm-core'] });
    expect(game.fileKinds).toEqual({
      'index.html': 'text', 'game.js': 'text', 'game.bin': 'binary', 'game.data': 'binary', 'peerd.json': 'text',
    });
    expect(game.files['game.bin']).toBe(WASM);
    expect(game.problems).toEqual([]);
    expect(game.declaration).toEqual({ dweb: false, instructions: false, observeAct: false });
  });

  test("keeps a third-party peerd.json and reports what it asks for", () => {
    const own = JSON.stringify({
      schema: 1, kind: 'dwapp', entry: 'play.html', capabilities: ['dweb'],
      agent: { kind: 'bound-app', instructions: 'Play it.', runtime: ['observe', 'act'] },
    });
    const prepared = prepareAppUpload({ 'peerd.json': utf8(own), 'play.html': utf8(PAGE) }, 'g');
    expect(prepared.entry).toBe('play.html');
    expect(new TextDecoder().decode(prepared.files['peerd.json'])).toBe(own);
    expect(prepared.declaration).toEqual({ dweb: true, instructions: true, observeAct: true });
    const missing = prepareAppUpload({ 'peerd.json': utf8(JSON.stringify({ ...JSON.parse(own), entry: 'gone.html' })), 'play.html': utf8(PAGE) }, 'g');
    expect(codes(missing.problems)).toEqual(['no-entry']);
    const broken = prepareAppUpload({ 'peerd.json': utf8('{'), 'index.html': utf8(PAGE) }, 'g');
    expect(codes(broken.problems)).toEqual(['bad-manifest']);
  });

  test('refuses files in the App runtime-data namespace', () => {
    const prepared = prepareAppUpload({ 'index.html': utf8(PAGE), 'data/levels.json': utf8('{}') }, 'g');
    expect(codes(prepared.problems)).toEqual(['runtime-data-path']);
    expect(prepared.problems[0].message).toContain('data/levels.json');
    expect(prepareAppUpload({ 'index.html': utf8(PAGE), 'data/levels.bin': WASM }, 'g').problems).toEqual([]);
  });

  test('refuses more than the App file cap and the App size cap', () => {
    const many = Object.fromEntries(Array.from({ length: MAX_APP_FILES }, (_, index) => [`f${index}.txt`, utf8('x')]));
    expect(codes(prepareAppUpload({ ...many, 'index.html': utf8(PAGE) }, 'g').problems)).toEqual(['too-many-files']);
    const large = prepareAppUpload({ 'index.html': utf8(PAGE), 'big.data': new Uint8Array(MAX_APP_TOTAL_BYTES) }, 'g');
    expect(codes(large.problems)).toEqual(['too-large']);
    expect(large.problems[0].message).toContain('50.0 MB');
  });

  test('maps unsupported builds to one plain sentence each', () => {
    const prepared = prepareAppUpload({
      'index.html': utf8('<title>x</title><script src="https://cdn.example.com/a.js"></script><script src=//other.example.org/b.js></script>'),
      'game.js': utf8('var ENVIRONMENT_IS_PTHREAD = false;'),
      'Build/game.data.br': WASM,
      'Build/game.wasm.unityweb': WASM,
    }, 'g');
    expect(codes(prepared.warnings)).toEqual(['threads', 'compressed', 'remote-script']);
    expect(prepared.warnings[1].message).toContain('Build/game.data.br');
    expect(prepared.warnings[2].message).toContain('cdn.example.com, other.example.org');
  });

  test('does not call a single-thread build threaded because its glue names pthread stubs', () => {
    const prepared = prepareAppUpload({
      'index.html': utf8(PAGE),
      'game.js': utf8('function _pthread_create(){return 11} if (typeof SharedArrayBuffer !== "undefined") {}'),
    }, 'g');
    expect(prepared.warnings).toEqual([]);
  });
});

describe('readUploadFolder', () => {
  test('removes the single top folder, leaves out hidden files without reading them, and keeps exact bytes', async () => {
    let hiddenRead = false;
    const hidden = pickFile('drturtle/.git/config', 'secret');
    hidden.arrayBuffer = async () => { hiddenRead = true; return new ArrayBuffer(0); };
    const prepared = await readUploadFolder([
      pickFile('drturtle/drturtle.html', PAGE),
      pickFile('drturtle/drturtle.wasm', WASM),
      pickFile('drturtle/assets/.DS_Store', 'x'),
      pickFile('drturtle/.env', 'TOKEN=1'),
      hidden,
    ]);
    expect(hiddenRead).toBe(false);
    expect(prepared.excluded).toEqual(['drturtle/assets/.DS_Store', 'drturtle/.env', 'drturtle/.git/config']);
    expect(Object.keys(prepared.files).sort()).toEqual(['drturtle.html', 'drturtle.wasm', 'peerd.json']);
    expect([...prepared.files['drturtle.wasm']]).toEqual([...WASM]);
    expect(prepared.entry).toBe('drturtle.html');
    expect(prepared.problems).toEqual([]);
  });

  test('refuses case collisions and the file cap before reading any file', async () => {
    let reads = 0;
    const counted = (path: string) => {
      const file = pickFile(path, 'x');
      file.arrayBuffer = async () => { reads += 1; return new ArrayBuffer(1); };
      return file;
    };
    const collision = await readUploadFolder([counted('g/index.html'), counted('g/Index.html')]);
    expect(codes(collision.problems)).toEqual(['case-collision']);
    const many = await readUploadFolder(Array.from({ length: MAX_APP_FILES + 1 }, (_, index) => counted(`g/f${index}.js`)));
    expect(codes(many.problems)).toEqual(['too-many-files']);
    expect(many.fileCount).toBe(MAX_APP_FILES + 1);
    expect(reads).toBe(0);
  });

  test('refuses a folder over the size cap from the declared sizes', async () => {
    const big = pickFile('g/big.data', 'x');
    Object.defineProperty(big, 'size', { value: MAX_APP_TOTAL_BYTES + 1 });
    big.arrayBuffer = async () => { throw new Error('must not read'); };
    const prepared = await readUploadFolder([pickFile('g/index.html', PAGE), big]);
    expect(codes(prepared.problems)).toEqual(['too-large']);
  });
});

describe('readUploadZip', () => {
  test('strips the top folder, leaves out __MACOSX, and keeps exact bytes', async () => {
    const prepared = await readUploadZip(await zipFile([
      { name: 'drturtle/', content: '' , store: true },
      { name: 'drturtle/drturtle.html', content: PAGE },
      { name: 'drturtle/drturtle.wasm', content: WASM, store: true },
      { name: '__MACOSX/drturtle/._drturtle.html', content: 'junk' },
    ], 'Dr Turtle.zip'));
    expect(prepared.excluded).toEqual(['__MACOSX/drturtle/._drturtle.html']);
    expect(Object.keys(prepared.files).sort()).toEqual(['drturtle.html', 'drturtle.wasm', 'peerd.json']);
    expect([...prepared.files['drturtle.wasm']]).toEqual([...WASM]);
    expect(prepared.wasm).toBe(true);
    expect(prepared.problems).toEqual([]);
  });

  test('names a game without a title from the .zip when there is no top folder', async () => {
    const prepared = await readUploadZip(await zipFile([{ name: 'index.html', content: '<p>hi</p>' }], 'Space Run.zip'));
    expect(prepared.name).toBe('Space Run');
  });

  test('refuses duplicate names before any decode', async () => {
    const prepared = await readUploadZip(await zipFile([
      { name: 'index.html', content: PAGE }, { name: 'index.html', content: 'other' },
    ]));
    expect(codes(prepared.problems)).toEqual(['unreadable']);
    await expect(Promise.resolve().then(async () => readZipIndex(await makeZip([
      { name: 'a', content: 'x' }, { name: 'a', content: 'y' },
    ]), { strict: true }))).rejects.toThrow('duplicate archive member');
  });

  test('refuses an unsafe member name and a zip over the input cap', async () => {
    const unsafe = await readUploadZip(await zipFile([
      { name: 'index.html', content: PAGE }, { name: 'sub\\evil.js', content: 'x' },
    ]));
    expect(codes(unsafe.problems)).toEqual(['unsafe-path']);
    const huge = new File(['x'], 'huge.zip');
    Object.defineProperty(huge, 'size', { value: MAX_UPLOAD_ZIP_BYTES + 1 });
    expect(codes((await readUploadZip(huge)).problems)).toEqual(['too-large']);
  });

  test('a member whose declared size lies is stopped by the running App budget', async () => {
    const zip = await makeZip([
      { name: 'index.html', content: PAGE },
      { name: 'bomb.data', content: new Uint8Array(MAX_APP_TOTAL_BYTES) },
    ]);
    // Rewrite the second central record so the member declares one byte.
    const view = new DataView(zip.buffer);
    const second = view.getUint32(zip.length - 22 + 16, true) + 46 + 'index.html'.length;
    expect(view.getUint32(second, true)).toBe(0x02014b50);
    view.setUint32(second + 24, 1, true);
    const bomb = readZipIndex(zip).get('bomb.data')!;
    expect(bomb.size).toBe(1);
    await expect(readZipEntry(zip, bomb, 1024)).rejects.toThrow('inflates past');
    const prepared = await readUploadZip(new File([zip as unknown as BlobPart], 'bomb.zip'));
    expect(codes(prepared.problems)).toEqual(['unreadable']);
    expect(Object.keys(prepared.files)).toEqual([]);
  });

  test('a damaged .zip gets a plain sentence', async () => {
    const prepared = await readUploadZip(new File(['not a zip at all, sorry'], 'x.zip'));
    expect(codes(prepared.problems)).toEqual(['unreadable']);
    expect(prepared.problems[0].message).toBe('peerd could not open this .zip file. It may be damaged.');
  });
});

describe('stageAppUpload', () => {
  test('writes every file under the staging folder and removes it when a write fails', async () => {
    type Dir = { files: Map<string, Uint8Array>, dirs: Map<string, Dir> };
    const make = (): Dir => ({ files: new Map(), dirs: new Map() });
    const root = make();
    let failOn = '';
    const handle = (dir: Dir): unknown => ({
      getDirectoryHandle: async (name: string, opts?: { create?: boolean }) => {
        if (!dir.dirs.has(name)) {
          if (!opts?.create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
          dir.dirs.set(name, make());
        }
        return handle(dir.dirs.get(name)!);
      },
      getFileHandle: async (name: string) => ({
        createWritable: async () => ({
          write: async (bytes: Uint8Array) => {
            if (name === failOn) throw new Error('disk full');
            dir.files.set(name, bytes);
          },
          close: async () => {},
          abort: async () => {},
        }),
      }),
      removeEntry: async (name: string) => { dir.dirs.delete(name); },
    });
    const getDirectory = async () => handle(root) as FileSystemDirectoryHandle;
    const id = await stageAppUpload({ 'index.html': utf8('a'), 'assets/game.wasm': WASM }, { uploadId: 'u-1', getDirectory });
    expect(id).toBe('u-1');
    const staged = root.dirs.get('peerd-app-uploads')!.dirs.get('u-1')!;
    expect([...staged.files.keys()]).toEqual(['index.html']);
    expect(staged.dirs.get('assets')!.files.get('game.wasm')).toBe(WASM);
    failOn = 'b.js';
    await expect(stageAppUpload({ 'a.js': utf8('a'), 'b.js': utf8('b') }, { uploadId: 'u-2', getDirectory }))
      .rejects.toThrow('disk full');
    expect(root.dirs.get('peerd-app-uploads')!.dirs.has('u-2')).toBe(false);
  });
});
