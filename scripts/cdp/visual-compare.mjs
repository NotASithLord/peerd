#!/usr/bin/env bun
// Compose before/after review images from two directories of captures.
//
// why this exists: the `visual` CI job answers "did the UI move?" with a ratio
// and a diff-highlight. That is the right answer for a REGRESSION. It is the
// wrong answer for an intentional redesign, where the reviewer's question is
// "show me the old one next to the new one" — and a red-pixel mask of a screen
// where everything changed is just a red rectangle.
//
// Produces, per state, a single side-by-side PNG that drops straight into a PR
// body. Same hand-rolled codec as visual.mjs — no npm, no ImageMagick.
//
//   bun scripts/cdp/visual-compare.mjs --before <dir> --after <dir> --out <dir>
//
// Inputs match on the shared basename, tolerating the harness's `-current`
// suffix, so you can point it straight at two artifacts/ runs.

import { readdirSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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

const befores = index(BEFORE);
const afters = index(AFTER);
const names = [...befores.keys()].filter((n) => afters.has(n)).sort();

const onlyBefore = [...befores.keys()].filter((n) => !afters.has(n));
const onlyAfter = [...afters.keys()].filter((n) => !befores.has(n));
// why report these rather than skip silently: a state that exists on only one
// side is exactly the interesting case (a screen was added or removed), and a
// composite that quietly omits it reads as "nothing changed there".
for (const n of onlyBefore) console.error(`[compare] only in BEFORE, no pair: ${n}`);
for (const n of onlyAfter) console.error(`[compare] only in AFTER, no pair: ${n}`);

if (!names.length) {
  console.error('[compare] no paired states — nothing to compose');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

for (const name of names) {
  const a = decodePng(readFileSync(/** @type {string} */(befores.get(name))));
  const b = decodePng(readFileSync(/** @type {string} */(afters.get(name))));

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
  const note = a.width === b.width && a.height === b.height ? '' : ' (capture size changed)';
  console.log(`${file}  ${a.width}x${a.height} | ${b.width}x${b.height}${note}`);
}

console.log(`\n${names.length} comparison image(s) → ${OUT}`);
console.log('Left = before, right = after.');
