// @ts-check
/** @param {string} id @returns {any} */
const el = id => document.getElementById(id);
const original = el('original'), filtered = el('filtered');
const input = original.getContext('2d'), output = filtered.getContext('2d');
/** @type {{gray:(r:number,g:number,b:number)=>number,threshold:(value:number,level:number)=>number}|undefined} */
let kernels;
let imageRead = 0;
const sample = () => {
  imageRead++;
  const image = input.createImageData(256, 192);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const i = (y * image.width + x) * 4;
    image.data.set([x, Math.round(y * 255 / 191), (x + y) % 256, 255], i);
  }
  original.width = filtered.width = image.width; original.height = filtered.height = image.height;
  input.putImageData(image, 0, 0); output.clearRect(0, 0, filtered.width, filtered.height);
};
sample();
el('sample').onclick = sample;
el('level').oninput = () => { el('level-label').textContent = el('level').value; };
el('file').onchange = async (/** @type {any} */ event) => {
  const token = ++imageRead;
  const file = event.target.files[0]; if (!file) return;
  if (file.size > 8_000_000) { el('status').textContent = 'Choose an image under 8 MB.'; return; }
  try {
    const bitmap = await createImageBitmap(file);
    if (token !== imageRead) { bitmap.close(); return; }
    const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
    original.width = filtered.width = Math.max(1, Math.round(bitmap.width * scale));
    original.height = filtered.height = Math.max(1, Math.round(bitmap.height * scale));
    input.drawImage(bitmap, 0, 0, original.width, original.height); bitmap.close();
    el('status').textContent = 'Local image loaded and fitted to the preview. Choose Apply filter.';
  } catch { el('status').textContent = 'Could not decode this image.'; }
};
el('apply').onclick = () => {
  if (!kernels) return;
  const image = input.getImageData(0, 0, original.width, original.height);
  const threshold = el('mode').value === 'threshold', level = Number(el('level').value);
  for (let i = 0; i < image.data.length; i += 4) {
    const gray = kernels.gray(image.data[i], image.data[i + 1], image.data[i + 2]);
    const value = threshold ? kernels.threshold(gray, level) : gray;
    image.data[i] = image.data[i + 1] = image.data[i + 2] = value;
  }
  output.putImageData(image, 0, 0);
  el('status').textContent = `WebAssembly processed ${image.width * image.height} pixels with ${threshold ? 'threshold' : 'grayscale'}.`;
};
try {
  const bytes = /** @type {any} */ (window).peerd.assets.bytes('filter.wasm');
  kernels = /** @type {any} */ ((await WebAssembly.instantiate(bytes)).instance.exports);
  el('apply').disabled = false; el('status').textContent = 'Bundled WebAssembly ready. Choose Apply filter.';
} catch { el('status').textContent = 'This sandbox could not load the bundled WebAssembly module. Nothing was processed.'; }

export {};
