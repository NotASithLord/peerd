// @ts-check
// notebook-tab/output-render.js — rich rendering of a run's output into the
// output pane (the run's RETURN value, and any peerd.self.display(value) calls).
//
// A Notebook reads as a notebook when DATA renders as data: an array of flat
// objects becomes a table, a chart descriptor becomes an SVG plot, an
// object/array becomes a readable JSON block, a primitive is a one-line value.
// Output is a pure function of the value alone, so runs stay reproducible
// (DECISIONS #24).
//
// peerd:std helpers (notebook-std.js) run in the worker (no DOM), so they return
// display DESCRIPTORS — { __peerd_display: 'table' | 'chart', … } — and THIS
// module (which has `document`) turns them into DOM. That split is also the
// security boundary: every node here is built with createElement(NS) +
// textContent, NEVER innerHTML, and every color/coordinate is computed here or
// comes from CSS — never from an agent-supplied string. The output pane is the
// privileged extension origin, so agent strings must never become live markup;
// arbitrary HTML/SVG is the App's sandboxed-iframe job, not the Notebook's.

const TABLE_MAX_ROWS = 500;
const CHART_MAX_POINTS = 300;
const SVGNS = 'http://www.w3.org/2000/svg';

/** @param {unknown} v */
const formatValue = (v) => {
  try { return JSON.stringify(v); }
  catch { return String(v); }
};

/** @param {number} n */
const seq = (n) => Array.from({ length: n }, (_, i) => i);

/** @param {string} tag @param {string | null} [text] */
const cellEl = (tag, text) => {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  return el;
};

/** @param {string} name @param {Record<string, string | number>} [attrs] */
const svgEl = (name, attrs = {}) => {
  const el = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

/** @param {number} x @param {number} y @param {string} text @param {Record<string, string | number>} [attrs] */
const svgText = (x, y, text, attrs = {}) => {
  const t = svgEl('text', { x, y, ...attrs });
  t.textContent = text;  // textContent — an SVG <text> never executes its content
  return t;
};

// ── classifiers ───────────────────────────────────────────────────────────

// A "flat row" — a plain object whose values are all primitives (so table-able).
/** @param {unknown} r @returns {r is Record<string, unknown>} */
export const isFlatRow = (r) =>
  !!r && typeof r === 'object' && !Array.isArray(r)
  && Object.values(r).every((v) => v == null || typeof v !== 'object');

/** @param {unknown} v @returns {v is Record<string, unknown>[]} */
export const isRowArray = (v) => Array.isArray(v) && v.length > 0 && v.every(isFlatRow);

/** @param {unknown} v @returns {v is Record<string, any>} */
export const isDescriptor = (v) =>
  !!v && typeof v === 'object' && !Array.isArray(v) && typeof (/** @type {any} */ (v).__peerd_display) === 'string';

// ── tables ────────────────────────────────────────────────────────────────

// Build an HTML table from an array of flat rows; columns = union of keys.
/** @param {Record<string, unknown>[]} rows */
export const renderTable = (rows) => {
  const shown = rows.slice(0, TABLE_MAX_ROWS);
  const cols = [...new Set(shown.flatMap((r) => Object.keys(r)))];
  const table = document.createElement('table');
  table.className = 'nb-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const c of cols) htr.appendChild(cellEl('th', c));
  thead.appendChild(htr);
  const tbody = document.createElement('tbody');
  for (const row of shown) {
    const tr = document.createElement('tr');
    for (const c of cols) {
      const v = row[c];
      tr.appendChild(cellEl('td', v == null ? '' : typeof v === 'string' ? v : formatValue(v)));
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  return table;
};

// ── charts (SVG, built here from the descriptor's numeric data) ─────────────

/** @param {number} v */
const fmtNum = (v) => {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.001 || a >= 100000)) return v.toExponential(1);
  return String(Math.round(v * 1000) / 1000);
};

/**
 * @typedef {{ x: number, y: number, label: string }} ChartPoint
 * @typedef {{ type?: string, data?: unknown, x?: string|null, y?: string|null, title?: unknown }} ChartDescriptor
 */

// Normalize a chart descriptor's `data` into { points: [{ x, y, label }],
// categorical }. `categorical` means x is index-positioned (a non-numeric/
// label axis), so the renderer labels by category instead of numeric ticks.
//   numbers → y vs index;  [x,y] pairs → as given;  row objects → x/y keys.
/** @param {ChartDescriptor} d @returns {{ points: ChartPoint[], categorical: boolean }} */
const toPoints = (d) => {
  const data = Array.isArray(d.data) ? d.data : [];
  if (!data.length) return { points: [], categorical: false };
  const first = data[0];
  if (typeof first === 'number') {
    return { points: data.map((v, i) => ({ x: i, y: Number(v), label: String(i) })), categorical: false };
  }
  if (Array.isArray(first)) {
    const numericX = data.every((p) => typeof p[0] === 'number');
    return {
      points: data.map((p, i) => ({ x: numericX ? p[0] : i, y: Number(p[1]), label: String(p[0]) })),
      categorical: !numericX,
    };
  }
  const keys = first && typeof first === 'object' ? Object.keys(first) : [];
  // A single-value column plots value-vs-INDEX (not value-vs-itself), so leave
  // xKey null when there's no second column and no explicit x.
  const xKey = d.x ?? (keys.length > 1 ? keys[0] : null);
  const yKey = d.y ?? (keys.length > 1 ? keys[1] : keys[0]);
  const numericX = xKey != null && data.every((row) => typeof row?.[xKey] === 'number');
  return {
    points: data.map((row, i) => ({
      x: numericX && xKey != null ? row[xKey] : i,
      y: Number(row?.[yKey]),
      label: xKey != null ? String(row?.[xKey]) : String(i),
    })),
    categorical: !numericX,
  };
};

/** @param {ChartDescriptor} d */
export const renderChart = (d) => {
  const W = 480, H = 280, L = 48, R = 14, TOP = 16, BOT = 40;
  const pw = W - L - R, ph = H - TOP - BOT;
  const type = typeof d.type === 'string' && ['bar', 'line', 'scatter'].includes(d.type) ? d.type : 'bar';
  const { points: rawPoints, categorical } = toPoints(d);
  // Filter BOTH coords: typeof NaN === 'number', so a NaN in an x position would
  // otherwise survive and poison the axis scale into NaN (broken SVG).
  const points = rawPoints.filter((p) => Number.isFinite(p.y) && Number.isFinite(p.x)).slice(0, CHART_MAX_POINTS);

  const wrap = document.createElement('div');
  wrap.className = 'nb-chart';
  if (d.title) {
    const title = cellEl('div', String(d.title));
    title.className = 'nb-chart-title';
    wrap.appendChild(title);
  }
  if (!points.length) {
    const note = cellEl('div', '(chart: no numeric data)');
    note.className = 'nb-table-note';
    wrap.appendChild(note);
    return wrap;
  }

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`, class: `nb-chart-svg nb-chart-${type}`,
    preserveAspectRatio: 'xMidYMid meet', role: 'img',
  });

  const ys = points.map((p) => p.y);
  let yMax = Math.max(...ys, 0);
  let yMin = Math.min(...ys, 0);
  if (yMin === yMax) { yMax += 1; yMin -= 1; }
  /** @param {number} v */
  const yToPx = (v) => TOP + ph - ((v - yMin) / (yMax - yMin)) * ph;

  const TICKS = 4;
  for (const i of seq(TICKS + 1)) {
    const v = yMin + (i / TICKS) * (yMax - yMin);
    const py = yToPx(v);
    svg.appendChild(svgEl('line', { x1: L, y1: py, x2: L + pw, y2: py, class: 'nb-grid' }));
    svg.appendChild(svgText(L - 6, py + 3, fmtNum(v), { class: 'nb-tick', 'text-anchor': 'end' }));
  }
  svg.appendChild(svgEl('line', { x1: L, y1: TOP, x2: L, y2: TOP + ph, class: 'nb-axis' }));
  svg.appendChild(svgEl('line', { x1: L, y1: yToPx(0), x2: L + pw, y2: yToPx(0), class: 'nb-axis' }));

  if (type === 'bar') {
    const n = points.length;
    const band = pw / n;
    const bw = Math.max(1, band * 0.7);
    const labelStep = Math.ceil(n / 12);
    points.forEach((p, i) => {
      const x = L + band * i + (band - bw) / 2;
      const y0 = yToPx(0);
      const y1 = yToPx(p.y);
      svg.appendChild(svgEl('rect', {
        x, y: Math.min(y0, y1), width: bw, height: Math.abs(y1 - y0), class: 'nb-series-fill',
      }));
      if (i % labelStep === 0) {
        svg.appendChild(svgText(L + band * i + band / 2, TOP + ph + 14, p.label, { class: 'nb-tick', 'text-anchor': 'middle' }));
      }
    });
  } else {
    const xs = points.map((p) => p.x);
    let xMin = Math.min(...xs);
    let xMax = Math.max(...xs);
    if (!(xMin < xMax)) { xMin -= 1; xMax += 1; }  // equal (or any NaN survivor) → pad
    /** @param {number} v */
    const xToPx = (v) => L + ((v - xMin) / (xMax - xMin)) * pw;
    if (type === 'line') {
      const path = points.slice().sort((a, b) => a.x - b.x).map((p) => `${xToPx(p.x)},${yToPx(p.y)}`).join(' ');
      svg.appendChild(svgEl('polyline', { points: path, class: 'nb-series-stroke', fill: 'none' }));
    }
    for (const p of points) {
      svg.appendChild(svgEl('circle', { cx: xToPx(p.x), cy: yToPx(p.y), r: type === 'scatter' ? 3 : 2, class: 'nb-series-fill' }));
    }
    if (categorical) {
      // index-positioned x → label by category (like bars), not numeric ticks.
      const labelStep = Math.ceil(points.length / 12);
      points.forEach((p, i) => {
        if (i % labelStep === 0) {
          svg.appendChild(svgText(xToPx(p.x), TOP + ph + 14, p.label, { class: 'nb-tick', 'text-anchor': 'middle' }));
        }
      });
    } else {
      for (const i of seq(TICKS + 1)) {
        const v = xMin + (i / TICKS) * (xMax - xMin);
        svg.appendChild(svgText(xToPx(v), TOP + ph + 14, fmtNum(v), { class: 'nb-tick', 'text-anchor': 'middle' }));
      }
    }
  }

  wrap.appendChild(svg);
  return wrap;
};

// ── descriptor + top-level dispatch ─────────────────────────────────────────

/** @param {HTMLElement} outputEl @param {Record<string, any>} d */
const renderDescriptor = (outputEl, d) => {
  if (d.__peerd_display === 'table') {
    const rows = Array.isArray(d.rows) ? d.rows : [];
    if (!rows.length) {
      const note = cellEl('div', '(empty table)');
      note.className = 'nb-table-note';
      outputEl.appendChild(note);
      return;
    }
    const caption = cellEl('div', `← ${rows.length} row${rows.length === 1 ? '' : 's'}`);
    caption.className = 'log-line log-return';
    outputEl.append(caption, renderTable(rows));
  } else if (d.__peerd_display === 'chart') {
    outputEl.appendChild(renderChart(d));
  } else {
    const pre = cellEl('pre', `← ${JSON.stringify(d, null, 2)}`);
    pre.className = 'nb-json';
    outputEl.appendChild(pre);
  }
};

/**
 * Render a value into `outputEl` (appends; does not clear). A display descriptor
 * → table/chart; a row-array → table; an object/array → a JSON block; a
 * primitive → one line. `undefined` renders nothing.
 *
 * @param {HTMLElement} outputEl
 * @param {unknown} value
 */
export const renderReturnValue = (outputEl, value) => {
  if (value === undefined) return;
  if (isDescriptor(value)) { renderDescriptor(outputEl, value); return; }
  if (isRowArray(value)) {
    const caption = cellEl('div', `← ${value.length} row${value.length === 1 ? '' : 's'}`);
    caption.className = 'log-line log-return';
    outputEl.append(caption, renderTable(value));
    if (value.length > TABLE_MAX_ROWS) {
      const note = cellEl('div', `…${value.length - TABLE_MAX_ROWS} more rows not shown`);
      note.className = 'nb-table-note';
      outputEl.appendChild(note);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    const pre = cellEl('pre', `← ${JSON.stringify(value, null, 2)}`);
    pre.className = 'nb-json';
    outputEl.appendChild(pre);
    return;
  }
  const line = cellEl('span', `← ${formatValue(value)}\n`);
  line.className = 'log-line log-return';
  outputEl.appendChild(line);
};
