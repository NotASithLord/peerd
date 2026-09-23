import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const box = (name: string, payload = Buffer.alloc(0)) => {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(8 + payload.length);
  return Buffer.concat([size, Buffer.from(name), payload]);
};

describe('build-tool dependency fixes', () => {
  test.each(['import', 'require'])('rejects zero-sized image boxes through %s', (loader) => {
    const inputs = [
      ['ICNS', Buffer.from('69636e73000000106963303700000000', 'hex')],
      ['HEIF', Buffer.concat([box('ftyp', Buffer.from('heic')), Buffer.from('0000000066726565', 'hex')])],
      ['JXL', Buffer.concat([box('JXL ', Buffer.from([13, 10, 135, 10])), box('ftyp', Buffer.from('jxl ')), Buffer.from('000000006a786c70', 'hex')])],
    ] as const;
    // why: A parser regression must fail without stopping the test runner.
    for (const [type, input] of inputs) {
      execFileSync(process.execPath, ['--eval', `
        const { imageSize } = ${loader === 'import' ? 'await import' : 'require'}('image-size');
        require('node:assert/strict').throws(
          () => imageSize(Buffer.from('${input.toString('hex')}', 'hex')), /Invalid ${type}/);
      `], { timeout: 2000 });
    }
  });

  test('still reads an extension icon', () => {
    const { imageSize } = require('image-size');
    expect(imageSize(readFileSync('extension/icons/icon128.png'))).toMatchObject({ width: 128, height: 128, type: 'png' });
  });

  test('counts empty YAML merge sources against the work limit', () => {
    const { load } = require('js-yaml');
    expect(() => load('source: &source [{}, {}]\ntarget: { <<: *source }', { maxTotalMergeKeys: 1 }))
      .toThrow('maxTotalMergeKeys');
  });

  test('reads stored ZIP data without allocating the declared size', () => {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    zip.addFile('a', Buffer.from('hello'));
    zip.getEntry('a').header.method = 0;
    const data = zip.toBuffer();
    data.writeUInt32LE(1_000_000, data.indexOf(Buffer.from('504b0102', 'hex')) + 24);
    expect(new AdmZip(data).getEntry('a').getData().toString()).toBe('hello');
  });

  test.each(['file', 'directory'])('refuses extraction through a destination %s symlink', (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'peerd-zip-'));
    try {
      const target = join(root, 'target');
      mkdirSync(target);
      writeFileSync(join(root, 'victim'), 'original');
      symlinkSync(kind === 'file' ? join(root, 'victim') : root, join(target, 'link'));
      const zip = new (require('adm-zip'))();
      zip.addFile(kind === 'file' ? 'link' : 'link/victim', Buffer.from('changed'));
      expect(() => zip.extractAllTo(target, true)).toThrow();
      expect(readFileSync(join(root, 'victim'), 'utf8')).toBe('original');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
