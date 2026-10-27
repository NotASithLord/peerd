#!/usr/bin/env bun
// Compose image pairs for review. Copy captures that have no before image.
// --report selects captures with a change or incomplete evidence.

import { readdirSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { decodePng, encodePng } from './visual.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(`--${name}=`.length);
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
};

const BEFORE = arg('before');
const AFTER = arg('after');
const OUT = arg('out');
if (!BEFORE || !AFTER || !OUT) {
  console.error('usage: visual-compare.mjs --before <dir> --after <dir> --out <dir>');
  process.exit(2);
}

const GUTTER = 16;          // breathing room between the two renders
const RULE = 2;             // the divider line itself
const PAD = 12;             // border around the whole composite
const BG = [0x8a, 0x8a, 0x8a];   // mid gray — reads as chrome against either theme
const RULE_COLOR = [0x2a, 0x2a, 0x2a];

/** Strip the harness's `-current` suffix so both sides key on the state name. */
const key = (f) => basename(f, '.png').replace(/-current$/, '');

const index = (dir) => {
  const map = new Map();
  if (!existsSync(dir)) return map;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.png')) continue;
    if (/-diff\.png$/.test(f)) continue;           // never compose a diff mask
    map.set(key(f), join(dir, f));
  }
  return map;
};

/**
 * Paint a decoded image into an RGB canvas at (ox, oy). Alpha is ignored —
 * screenshots are opaque.
 * @param {Uint8Array} canvas @param {number} cw
 * @param {{width:number,height:number,channels:number,data:Uint8Array}} img
 * @param {number} ox @param {number} oy
 */
const blit = (canvas, cw, img, ox, oy) => {
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const si = (y * img.width + x) * img.channels;
      const di = ((y + oy) * cw + (x + ox)) * 3;
      canvas[di] = img.data[si];
      canvas[di + 1] = img.data[si + 1];
      canvas[di + 2] = img.data[si + 2];
    }
  }
};

const REPORT = arg('report');
const report = REPORT && existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : null;
const wanted = report
  ? new Set(report.rows
    .filter((/** @type {{verdict:string}} */ r) => r.verdict !== 'identical')
    .map((/** @type {{key:string}} */ r) => r.key))
  : null;

const befores = index(BEFORE);
const afters = index(AFTER);
const names = [...afters.keys()]
  .filter((n) => !wanted || wanted.has(n))
  .sort();

const onlyBefore = [...befores.keys()].filter((n) => !afters.has(n));
// why report missing after images: a partial render must remain visible.
for (const n of onlyBefore) console.error(`[compare] only in BEFORE, no pair: ${n}`);

// why clear output: a rerun must not publish a previous image.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let written = 0;
for (const screen of report?.browserScreens ?? []) try {
  decodePng(readFileSync(screen.file));
  copyFileSync(screen.file, join(OUT, basename(screen.file)));
  written += 1;
} catch (error) { console.error(`[compare] skipped ${screen.file}: ${error.message}`); }

for (const name of names) try {
  const b = decodePng(readFileSync(afters.get(name)));
  let a;
  if (befores.has(name)) try { a = decodePng(readFileSync(befores.get(name))); }
  catch (error) { console.error(`[compare] invalid before image ${name}: ${error.message}`); }
  if (!a) {
    const file = join(OUT, `${name}.after.png`);
    copyFileSync(afters.get(name), file);
    written += 1;
    console.log(`${file} - this branch only`);
    continue;
  }

  const innerH = Math.max(a.height, b.height);
  const w = PAD * 2 + a.width + GUTTER + RULE + GUTTER + b.width;
  const h = PAD * 2 + innerH;

  const canvas = new Uint8Array(w * h * 3);
  for (let p = 0; p < w * h; p += 1) {
    canvas[p * 3] = BG[0]; canvas[p * 3 + 1] = BG[1]; canvas[p * 3 + 2] = BG[2];
  }

  blit(canvas, w, a, PAD, PAD);
  const ruleX = PAD + a.width + GUTTER;
  for (let y = PAD; y < PAD + innerH; y += 1) {
    for (let x = ruleX; x < ruleX + RULE; x += 1) {
      const di = (y * w + x) * 3;
      canvas[di] = RULE_COLOR[0]; canvas[di + 1] = RULE_COLOR[1]; canvas[di + 2] = RULE_COLOR[2];
    }
  }
  blit(canvas, w, b, ruleX + RULE + GUTTER, PAD);

  const file = join(OUT, `${name}.before-after.png`);
  writeFileSync(file, encodePng(w, h, canvas));
  written += 1;
  const note = a.width === b.width && a.height === b.height ? '' : ' (capture size changed)';
  console.log(`${file}  ${a.width}x${a.height} | ${b.width}x${b.height}${note}`);
} catch (error) { console.error(`[compare] skipped ${name}: ${error.message}`); }

console.log(`\n${written} review image(s): ${OUT}`);
process.exitCode = written ? 0 : 1;
