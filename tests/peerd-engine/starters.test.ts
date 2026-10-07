import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { packagedStarter, starterKeys, loadPackagedStarter } from '../../extension/shared/starter-catalog.js';
import { starterEnvelope } from '../../scripts/build-starter-envelopes.mjs';
import { starterWasm } from '../../scripts/build-starter-wasm.mjs';
import { openEnvelope } from '../../extension/peerd-engine/export.js';
import { parseCSV, summarize } from '../../extension/peerd-engine/starters/csv-lab/app.js';

test('starter URL inputs cannot select an arbitrary packaged or external resource', async () => {
  let reads = 0;
  const read = (async () => { reads++; throw new Error('unexpected fetch'); }) as unknown as typeof fetch;
  for (const key of [null, {}, '__proto__', 'constructor', '../csv-lab', 'csv-lab?url=https://evil.test', '/peerd-engine/starters/csv-lab.peerd', 'https://evil.test', ['csv-lab']]) {
    expect(packagedStarter(key)).toBeNull();
    await expect(loadPackagedStarter(key, read)).rejects.toThrow('Unknown packaged starter');
  }
  expect(reads).toBe(0);
  for (const key of starterKeys) {
    const urls: string[] = [];
    await loadPackagedStarter(key, (async url => { urls.push(String(url)); return Response.json({}); }) as typeof fetch);
    expect(urls).toEqual([packagedStarter(key)!.path]);
  }
});

test('packaged starter envelopes reproduce source bytes and retain unsigned local provenance', async () => {
  for (const key of starterKeys) {
    const stored = JSON.parse(await readFile(`extension/peerd-engine/starters/${key}.peerd`, 'utf8'));
    expect(stored).toEqual(await starterEnvelope(key));
    const opened = await openEnvelope(stored);
    expect(opened.kind).toBe('app');
    expect(opened.meta.publisher).toBeUndefined();
    expect(opened.meta.signature).toBeUndefined();
    expect(opened.entry).toBe('index.html');
    expect(new TextDecoder().decode(opened.files['app.js'])).toBe(await readFile(`extension/peerd-engine/starters/${key}/app.js`, 'utf8'));
    if (key === 'wasm-image') {
      expect(opened.fileKinds['filter.wasm']).toBe('binary');
      expect(opened.files['filter.wasm']).toEqual(starterWasm);
      expect(new Uint8Array(await readFile('extension/peerd-engine/starters/wasm-image/filter.wasm'))).toEqual(starterWasm);
    }
  }
});

test('bundled WASM executes actual luminance and threshold kernels without imports', async () => {
  const module = await WebAssembly.compile(starterWasm);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const exports = (await WebAssembly.instantiate(module)).exports as {gray:(r:number,g:number,b:number)=>number,threshold:(gray:number,level:number)=>number};
  for (const [r,g,b] of [[0,0,0], [255,255,255], [255,0,0], [0,255,0], [0,0,255], [12,94,233]]) {
    const gray = exports.gray(r,g,b);
    expect(gray).toBe((77*r+150*g+29*b) >>> 8);
    expect(exports.threshold(gray, gray)).toBe(255);
    expect(exports.threshold(gray, gray+1)).toBe(0);
  }
});

test('CSV tool handles quoted delimiters/newlines, reports missing numeric data and bounds rendering input', () => {
  const parsed = parseCSV('name,value\r\n"a,b",2\r\n"two\nlines",4\r\n"a""b",\r\n');
  expect(parsed.rows).toEqual([['a,b','2'], ['two\nlines','4'], ['a"b','']]);
  expect(summarize(['2','4','','no','Infinity'])).toMatchObject({count:2,missing:3,min:2,max:4,mean:3,median:3});
  expect(summarize(['1e308','1e308']).mean).toBe(1e308);
  for (const input of ['a,b\n1', 'a\n"unterminated', 'a\na"b', 'a\n"x"tail', ','.repeat(129)]) expect(() => parseCSV(input)).toThrow();
});
