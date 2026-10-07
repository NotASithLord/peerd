// Dependency-free binary encoding of the adjacent documented WAT kernels.
// Explicit sections/instructions make the tiny reference module reproducible.
import { writeFile } from 'node:fs/promises';
const section = (id, bytes) => [id, bytes.length, ...bytes];
const gray = [0, 0x20,0, 0x41,0xcd,0, 0x6c, 0x20,1, 0x41,0x96,1, 0x6c, 0x6a, 0x20,2, 0x41,29, 0x6c, 0x6a, 0x41,8, 0x76, 0x0b];
const threshold = [0, 0x41,0xff,1, 0x41,0, 0x20,0, 0x20,1, 0x4f, 0x1b, 0x0b];
export const starterWasm = new Uint8Array([
  0,97,115,109,1,0,0,0,
  ...section(1,[2,0x60,3,0x7f,0x7f,0x7f,1,0x7f,0x60,2,0x7f,0x7f,1,0x7f]),
  ...section(3,[2,0,1]),
  ...section(7,[2,4,...new TextEncoder().encode('gray'),0,0,9,...new TextEncoder().encode('threshold'),0,1]),
  ...section(10,[2,gray.length,...gray,threshold.length,...threshold]),
]);
if (import.meta.main) await writeFile(new URL('../extension/peerd-engine/starters/wasm-image/filter.wasm', import.meta.url), starterWasm);
