#!/usr/bin/env bun
// Visual-regression primitives for the E2E harness — SELF-CONTAINED, no npm
// (the house posture: "no npm CDP client, no Playwright"). A minimal PNG
// decoder (node:zlib for the IDAT inflate) + a tolerant pixel diff + a baseline
// read/compare/write flow. CDP's Page.captureScreenshot emits 8-bit, colour
// type 2 (RGB) or 6 (RGBA), non-interlaced PNGs — exactly the cases handled here.
//
// Baselines live committed under scripts/cdp/baselines/. Run a visual scenario
// with UPDATE_BASELINES=1 to (re)write them; otherwise each capture is decoded
// and compared, and the scenario asserts the diff ratio stays under a small
// threshold (rendering noise — antialiasing, subpixel — is absorbed by the
// per-pixel tolerance, so only real UI changes trip it).

import { inflateSync, deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- baselines: committed per platform, GATED on one authority --------------
//
// Every platform writes its baselines to a COMMITTED dir `baselines/<platform>/`
// — they are the repo's reference screens and the source the gallery renders
// from, so a human can see every view (light + dark) straight from the repo.
//
// But only ONE platform GATES. why: macOS and Linux cannot be pixel-compared.
// ~96% of the panel's text uses the `-apple-system, system-ui, …` stack, which
// resolves to a DIFFERENT family per OS — advance widths change, paragraphs
// re-wrap. That is layout drift, not edge noise, and no tolerance admits it
// while still catching a real change. So CI (linux-x64) is the gate; a dev's mac
// run still captures + diffs its own committed set for the eye, but never fails.
export const VISUAL_AUTHORITY = 'linux-x64';
export const VISUAL_PLATFORM = process.env.VISUAL_PLATFORM || `${process.platform}-${process.arch}`;
export const IS_AUTHORITY = VISUAL_PLATFORM === VISUAL_AUTHORITY;
export const BASELINES_ROOT = join(HERE, 'baselines');
export const BASELINE_DIR = join(BASELINES_ROOT, VISUAL_PLATFORM);

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Decode a PNG buffer to raw pixels. Handles 8-bit, colour type 2 (RGB, 3ch)
 * and 6 (RGBA, 4ch), non-interlaced — the shapes CDP screenshots use. Throws on
 * anything else (loudly, so an unexpected format is never silently mis-compared).
 * @param {Buffer|Uint8Array} buf
 * @returns {{ width: number, height: number, channels: number, data: Uint8Array }}
 */
export function decodePng(buf) {
  for (let i = 0; i < 8; i += 1) {
    if (buf[i] !== PNG_SIG[i]) throw new Error('not a PNG (bad signature)');
  }
  const view = buf instanceof Buffer ? buf : Buffer.from(buf);
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < view.length) {
    const len = view.readUInt32BE(off);
    const type = view.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    if (type === 'IHDR') {
      width = view.readUInt32BE(dataStart);
      height = view.readUInt32BE(dataStart + 4);
      bitDepth = view.readUInt8(dataStart + 8);
      colorType = view.readUInt8(dataStart + 9);
      interlace = view.readUInt8(dataStart + 12);
    } else if (type === 'IDAT') {
      idat.push(view.subarray(dataStart, dataStart + len));
    } else if (type === 'IEND') {
      break;
    }
    off = dataStart + len + 4; // skip data + CRC
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth} (need 8)`);
  if (interlace !== 0) throw new Error('unsupported interlaced PNG');
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType} (need 2 or 6)`);

  const filtered = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let fpos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[fpos]; fpos += 1;
    const row = y * stride;
    const prow = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[fpos]; fpos += 1;
      const a = x >= channels ? out[row + x - channels] : 0;
      const b = y > 0 ? out[prow + x] : 0;
      const c = y > 0 && x >= channels ? out[prow + x - channels] : 0;
      let val;
      switch (filter) {
        case 0: val = raw; break;
        case 1: val = raw + a; break;
        case 2: val = raw + b; break;
        case 3: val = raw + ((a + b) >> 1); break;
        case 4: val = raw + paeth(a, b, c); break;
        default: throw new Error(`bad PNG filter ${filter} at row ${y}`);
      }
      out[row + x] = val & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/**
 * Tolerant pixel diff. A pixel counts as different when ANY channel differs by
 * more than `tolerance` (0–255). Returns the count and ratio of diff pixels.
 * @param {{width:number,height:number,channels:number,data:Uint8Array}} a
 * @param {{width:number,height:number,channels:number,data:Uint8Array}} b
 * @param {{ tolerance?: number }} [opts]
 */
export function comparePixels(a, b, { tolerance = 8 } = {}) {
  if (a.width !== b.width || a.height !== b.height) {
    return { dimsMatch: false, diffPixels: a.width * a.height, totalPixels: a.width * a.height, ratio: 1 };
  }
  // Compare on the min channel count (RGB vs RGBA tolerated — alpha from a
  // screenshot is opaque anyway).
  const ch = Math.min(a.channels, b.channels);
  const totalPixels = a.width * a.height;
  let diffPixels = 0;
  for (let p = 0; p < totalPixels; p += 1) {
    const ai = p * a.channels, bi = p * b.channels;
    let differs = false;
    for (let k = 0; k < ch; k += 1) {
      if (Math.abs(a.data[ai + k] - b.data[bi + k]) > tolerance) { differs = true; break; }
    }
    if (differs) diffPixels += 1;
  }
  return { dimsMatch: true, diffPixels, totalPixels, ratio: totalPixels ? diffPixels / totalPixels : 0 };
}

// why this is 0.0005 and not the 2% it used to be: on a pinned platform +
// pinned Chrome the capture is BYTE-IDENTICAL run to run (measured: two
// independent launches, 0.0000% at tolerance 0 on every state). The noise floor
// is zero, so nearly any movement is signal.
//
// 2% was theatre, and this is measured, not asserted: at the old 756x413 capture
// it silently accepted a brand-new toolbar button (0.066%), a new `debug` chip
// plus a global uppercase→lowercase label change (0.267%), and eight releases of
// version-string drift. A whole-UI corner-radius change (6px→10px) scores
// 0.03-0.28% — every one of those passed. Roughly 7.5x headroom on the worst
// real change the suite had ever seen.
//
// UNVERIFIED: the Linux runner's own noise floor. If the CI job proves flaky on
// an unchanged tree, raise this — but measure the floor first and put the number
// in the commit message, rather than nudging it until green.
export const DEFAULT_THRESHOLD = 0.0005;

/**
 * Compare a freshly-captured PNG against a committed baseline, or (re)write the
 * baseline. Returns a verdict the scenario turns into a named check.
 * @param {string} name  baseline key (file is baselines/<name>.png)
 * @param {Buffer} pngBuffer  the captured screenshot
 * @param {{ update?: boolean, threshold?: number, tolerance?: number }} [opts]
 * @returns {{ name:string, wrote:boolean, missing:boolean, dimsMatch:boolean, ratio:number, pass:boolean, rawPass:boolean, gated:boolean, threshold:number }}
 */
export function compareToBaseline(name, pngBuffer, { update = false, threshold = DEFAULT_THRESHOLD, tolerance = 8 } = {}) {
  const file = join(BASELINE_DIR, `${name}.png`);
  const exists = existsSync(file);
  if (update || !exists) {
    mkdirSync(BASELINE_DIR, { recursive: true });
    writeFileSync(file, pngBuffer);
    return { name, wrote: true, missing: !exists, dimsMatch: true, ratio: 0, pass: true, rawPass: true, gated: IS_AUTHORITY, threshold };
  }
  const base = decodePng(readFileSync(file));
  const shot = decodePng(pngBuffer);
  const { dimsMatch, ratio } = comparePixels(base, shot, { tolerance });
  const rawPass = dimsMatch && ratio <= threshold;
  return {
    name, wrote: false, missing: false, dimsMatch, ratio, threshold,
    rawPass, gated: IS_AUTHORITY,
    // Off-authority never fails the run — the ratio is still reported and the
    // diff image is still written, so a human/agent can look at what moved.
    pass: IS_AUTHORITY ? rawPass : true,
  };
}

export const UPDATE_BASELINES = process.env.UPDATE_BASELINES === '1';

// ---- minimal PNG encoder (for diff-highlight images) ------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};

/**
 * Encode raw RGB (8-bit, width*height*3) to a PNG buffer (colour type 2, filter
 * 0). The inverse of decodePng for the RGB case — used to write diff images.
 * @param {number} width @param {number} height @param {Uint8Array} rgb
 * @returns {Buffer}
 */
export function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // bit depth 8, colour type 2 (RGB)
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type None
    raw.set(rgb.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Write a diff-highlight PNG: changed pixels painted solid red, everything else
 * a dimmed grayscale of the current capture (so the layout is visible and the
 * changes pop). Readable by an agent to SEE what moved.
 * @param {object} base  decoded baseline
 * @param {object} cur   decoded current
 * @param {string} path
 * @param {{ tolerance?: number }} [opts]
 */
export function writeDiffImage(base, cur, path, { tolerance = 8 } = {}) {
  const w = Math.min(base.width, cur.width);
  const h = Math.min(base.height, cur.height);
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const bi = (y * base.width + x) * base.channels;
      const ci = (y * cur.width + x) * cur.channels;
      let diff = false;
      for (let k = 0; k < 3; k += 1) {
        if (Math.abs(base.data[bi + k] - cur.data[ci + k]) > tolerance) { diff = true; break; }
      }
      const oi = (y * w + x) * 3;
      if (diff) { out[oi] = 255; out[oi + 1] = 0; out[oi + 2] = 0; }
      else { const g = (cur.data[ci] * 0.35 + 165) & 0xff; out[oi] = g; out[oi + 1] = g; out[oi + 2] = g; }
    }
  }
  writeFileSync(path, encodePng(w, h, out));
}
