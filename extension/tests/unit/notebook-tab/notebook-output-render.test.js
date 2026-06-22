// @ts-check
// notebook output-render — the rich return-value renderer (tables / JSON /
// text). Pure DOM construction, so it's exercised directly here (no tab boot).
// The load-bearing guarantees: row-arrays become tables, objects become JSON,
// and — crucially — HTML-looking strings render as INERT TEXT (the output pane
// is the privileged extension origin; agent strings must never become markup).

import { describe, it, expect } from '../../framework.js';
import {
  isFlatRow, isRowArray, isDescriptor, renderTable, renderChart, renderReturnValue,
} from '/notebook-tab/output-render.js';

describe('notebook output-render', () => {
  it('classifies table-able data', () => {
    expect(isFlatRow({ a: 1, b: 'x', c: null })).toBe(true);
    expect(isFlatRow({ a: { nested: 1 } })).toBe(false);  // nested object → not flat
    expect(isFlatRow([1, 2])).toBe(false);                // array is not a row
    expect(isRowArray([{ a: 1 }, { a: 2 }])).toBe(true);
    expect(isRowArray([])).toBe(false);                   // empty → no table
    expect(isRowArray([1, 2, 3])).toBe(false);            // primitives → no table
    expect(isRowArray([{ a: 1 }, 2])).toBe(false);        // mixed → no table
  });

  it('builds a header + one row per record, columns = union of keys', () => {
    const t = renderTable([{ a: 1, b: 2 }, { a: 3, c: 4 }]);
    const headers = [...t.querySelectorAll('thead th')].map((th) => th.textContent).join(',');
    expect(headers).toBe('a,b,c');
    expect(t.querySelectorAll('tbody tr').length).toBe(2);
    // second row has no 'b' → empty cell, in column order a|b|c
    const r2 = [...t.querySelectorAll('tbody tr')[1].querySelectorAll('td')].map((td) => td.textContent).join('|');
    expect(r2).toBe('3||4');
  });

  it('dispatches by value shape', () => {
    const host = document.createElement('div');
    renderReturnValue(host, [{ x: 1 }, { x: 2 }]);
    expect(!!host.querySelector('table.nb-table')).toBe(true);
    expect(/** @type {Element} */ (host.querySelector('.log-return')).textContent).toContain('2 rows');

    const host2 = document.createElement('div');
    renderReturnValue(host2, { hello: 'world' });
    expect(/** @type {Element} */ (host2.querySelector('pre.nb-json')).textContent).toContain('"hello": "world"');

    const host3 = document.createElement('div');
    renderReturnValue(host3, 42);
    expect(host3.textContent).toContain('← 42');
  });

  it('renders HTML-looking strings as inert TEXT (no markup injection)', () => {
    const host = document.createElement('div');
    renderReturnValue(host, '<img src=x onerror=alert(1)>');
    expect(host.querySelector('img')).toBe(null);
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');

    // …and the same in a table cell.
    const host2 = document.createElement('div');
    renderReturnValue(host2, [{ html: '<b>hi</b>' }]);
    expect(host2.querySelector('b')).toBe(null);
    expect(/** @type {Element} */ (host2.querySelector('td')).textContent).toBe('<b>hi</b>');
  });

  it('renders nothing for undefined', () => {
    const host = document.createElement('div');
    renderReturnValue(host, undefined);
    expect(host.childElementCount).toBe(0);
  });

  it('recognizes display descriptors and dispatches them', () => {
    expect(isDescriptor({ __peerd_display: 'table', rows: [] })).toBe(true);
    expect(isDescriptor({ a: 1 })).toBe(false);
    expect(isDescriptor([1, 2])).toBe(false);

    // a table descriptor renders the table
    const h1 = document.createElement('div');
    renderReturnValue(h1, { __peerd_display: 'table', rows: [{ a: 1 }, { a: 2 }] });
    expect(!!h1.querySelector('table.nb-table')).toBe(true);

    // an empty table descriptor renders a note, not a broken table
    const h2 = document.createElement('div');
    renderReturnValue(h2, { __peerd_display: 'table', rows: [] });
    expect(h2.querySelector('table')).toBe(null);
    expect(h2.textContent).toContain('empty table');

    // a chart descriptor renders an SVG
    const h3 = document.createElement('div');
    renderReturnValue(h3, { __peerd_display: 'chart', type: 'bar', data: [{ x: 'a', y: 1 }] });
    expect(!!h3.querySelector('svg.nb-chart-svg')).toBe(true);
  });

  it('renderChart draws the right marks per type', () => {
    const bar = renderChart({ type: 'bar', data: [{ x: 'a', y: 3 }, { x: 'b', y: 5 }] });
    expect(bar.querySelectorAll('rect.nb-series-fill').length).toBe(2);

    const line = renderChart({ type: 'line', data: [{ x: 0, y: 1 }, { x: 1, y: 4 }, { x: 2, y: 2 }] });
    expect(!!line.querySelector('polyline.nb-series-stroke')).toBe(true);

    const scatter = renderChart({ type: 'scatter', data: [1, 2, 3, 4] });
    expect(scatter.querySelectorAll('circle.nb-series-fill').length).toBe(4);

    // titles render as text; no numeric data → a note, never a broken plot
    expect(renderChart({ type: 'bar', data: [], title: 'T' }).textContent).toContain('no numeric data');
    expect(renderChart({ type: 'bar', data: [{ x: 'a', y: 'not-a-number' }] }).textContent).toContain('no numeric data');
  });

  it('chart filters bad x (NaN) instead of poisoning the axis into broken SVG', () => {
    const wrap = renderChart({ type: 'line', data: [{ x: 0, y: 1 }, { x: NaN, y: 2 }, { x: 2, y: 3 }] });
    const svg = /** @type {SVGSVGElement} */ (wrap.querySelector('svg'));
    expect(!!svg).toBe(true);
    // the NaN-x point is dropped → 2 finite points → 2 circles
    expect(svg.querySelectorAll('circle').length).toBe(2);
    // no attribute anywhere should contain the string 'NaN'
    const anyNaN = [...svg.querySelectorAll('*')].some((n) =>
      [...n.attributes].some((a) => a.value.includes('NaN')));
    expect(anyNaN).toBe(false);
  });

  it('single-value columns plot value-vs-index, not a y=x diagonal', () => {
    const wrap = renderChart({ type: 'scatter', data: [{ v: 10 }, { v: 20 }, { v: 30 }] });
    expect(wrap.querySelectorAll('circle').length).toBe(3);
    // x is the index (categorical) → an index label '0' is drawn on the axis
    const ticks = [...wrap.querySelectorAll('text.nb-tick')].map((t) => t.textContent);
    expect(ticks.includes('0')).toBe(true);
  });

  it('categorical x labels are shown on line/scatter axes (not numeric ticks)', () => {
    const wrap = renderChart({ type: 'line', data: [{ d: 'Mon', n: 1 }, { d: 'Tue', n: 5 }], x: 'd', y: 'n' });
    const labels = [...wrap.querySelectorAll('text.nb-tick')].map((t) => t.textContent);
    expect(labels.includes('Mon')).toBe(true);
    expect(labels.includes('Tue')).toBe(true);
  });

  it('chart labels are inert TEXT (no markup injection via the descriptor)', () => {
    const svg = renderChart({
      type: 'bar',
      data: [{ x: '<img src=x onerror=alert(1)>', y: 1 }],
      title: '<script>alert(2)</script>',
    });
    // the malicious x-label became an SVG <text> node's textContent, not an element
    expect(svg.querySelector('img')).toBe(null);
    expect(svg.querySelector('script')).toBe(null);
    expect(svg.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(svg.textContent).toContain('<script>alert(2)</script>');
  });
});
