// @ts-check
// Pure CSV parsing is shared with tests; rendered values always use textContent.
/** @param {string} text */
export function parseCSV(text) {
  if (text.length > 1_000_000) throw new Error('Choose a CSV under one million characters.');
  /** @type {string[][]} */ const rows = [];
  /** @type {string[]} */ let row = [];
  let cell = '', quoted = false, ended = false;
  const field = () => { if (row.length >= 128) throw new Error('Choose a table with at most 128 columns.'); row.push(cell); cell = ''; ended = false; };
  const line = () => { field(); if (row.some(value => value.trim())) { if (rows.length > 10000) throw new Error('Choose a table with at most 10000 data rows.'); rows.push(row); } row = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; ended = true; }
      else cell += char;
    } else if (char === '"' && !cell && !ended) quoted = true;
    else if (char === ',') field();
    else if (char === '\n' || char === '\r') { if (char === '\r' && text[i + 1] === '\n') i++; line(); }
    else { if (char === '"') throw new Error('Quotes must surround the entire field.'); if (ended) throw new Error('Unexpected text after a quoted field.'); cell += char; }
  }
  if (quoted) throw new Error('A quoted field is missing its closing quote.');
  line();
  if (!rows.length) throw new Error('Add a header and at least one data row.');
  const headers = /** @type {string[]} */ (rows.shift());
  if (!rows.length || rows.some(values => values.length !== headers.length)) throw new Error('Each data row must have the same number of columns as the header.');
  return { headers, rows };
}
/** @param {string[]} values */
export function summarize(values) {
  const numeric = values.filter(value => value.trim() !== '').map(Number).filter(Number.isFinite);
  const sorted = [...numeric].sort((a, b) => a - b), n = sorted.length;
  return { numeric, count: n, missing: values.length - n,
    min: n ? sorted[0] : null, max: n ? sorted[n - 1] : null,
    mean: n ? numeric.reduce((a, b) => a + b / n, 0) : null,
    median: n ? sorted[Math.floor((n - 1) / 2)] / 2 + sorted[Math.floor(n / 2)] / 2 : null };
}
if (typeof document !== 'undefined') {
  /** @param {string} id @returns {any} */
  const el = id => document.getElementById(id);
  /** @type {ReturnType<typeof parseCSV>|null} */ let parsed = null;
  let fileRead = 0;
  const draw = () => {
    if (!parsed) return;
    const summary = summarize(parsed.rows.map(row => row[Number(el('column').value)]));
    el('stats').textContent = `Numeric: ${summary.count}; missing/non-numeric: ${summary.missing}; minimum: ${summary.min ?? 'not available'}; maximum: ${summary.max ?? 'not available'}; mean: ${summary.mean ?? 'not available'}; median: ${summary.median ?? 'not available'}`;
    const canvas = el('chart'), ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = matchMedia('(prefers-color-scheme: dark)').matches ? '#ddd' : '#222';
    const values = summary.numeric.slice(0, 100), max = Math.max(1, ...values.map(Math.abs));
    values.forEach((value, i) => ctx.fillRect(i * canvas.width / values.length, 120, Math.max(1, canvas.width / values.length - 2), -value / max * 110));
    canvas.setAttribute('aria-label', `Bar chart of the first ${values.length} numeric values. Values below zero extend below the center.`);
  };
  el('analyze').onclick = () => {
    try {
      parsed = parseCSV(el('csv').value); el('result').hidden = false;
      el('column').replaceChildren(...parsed.headers.map((header, i) => { const option = document.createElement('option'); option.value = String(i); option.textContent = header || `Column ${i + 1}`; return option; }));
      const data = parsed;
      el('column').selectedIndex = Math.max(0, data.headers.findIndex((_, index) => data.rows.some(row => row[index].trim() !== '' && Number.isFinite(Number(row[index])))));
      const table = el('table'); table.replaceChildren();
      [parsed.headers, ...parsed.rows.slice(0, 50)].forEach((row, index) => { const tr = document.createElement('tr'); row.forEach(value => { const cell = document.createElement(index ? 'td' : 'th'); cell.textContent = value; tr.append(cell); }); table.append(tr); });
      el('status').textContent = `${parsed.rows.length} rows; ${parsed.headers.length} columns. Preview shows the first ${Math.min(50, parsed.rows.length)} rows. Chart shows up to 100 numeric values.`; draw();
    } catch (error) { el('result').hidden = true; el('status').textContent = /** @type {Error} */ (error).message; }
  };
  el('column').onchange = draw;
  el('csv').oninput = () => { fileRead++; };
  el('file').onchange = async (/** @type {any} */ event) => { const token = ++fileRead; const file = event.target.files[0]; if (!file) return; if (file.size > 1_000_000) { el('status').textContent = 'Choose a CSV under one million bytes.'; return; } const text = await file.text(); if (token !== fileRead) return; el('csv').value = text; el('status').textContent = 'File loaded. Choose Analyze table.'; };
}
