// scripts/cdp/fixtures/web-suite.mjs — the drift-free fixture site the
// web-actor eval suite (extension/eval/tasks.js `web-actor`) drives.
//
// why local fixtures, not live sites: the suite is an A/B measurement rig (the
// code-REPL action surface vs the tool-call surface, PR #119) run build-over-
// build. Live pages drift, rate-limit, and A/B-test their own UI — noise that
// swamps the signal we're measuring. A tiny deterministic "store" served over
// 127.0.0.1 gives a stable score. The web actor's `navigate` reaches loopback
// fine (the SSRF/private-network guard is fetch_url-only), so the actor really
// renders + drives these pages through the same path a live site would take —
// exactly what harvest (scripts/cdp/states.mjs) proves works.
//
// The server is a pure request→response function + a thin http shell (started
// by run-eval-bench.mjs on an ephemeral port; the base URL is threaded into the
// tasks via the __FIXTURE__ sentinel, so nothing hard-codes a port).

import { createServer } from 'node:http';

// ── the store's data (deterministic — the tasks assert on these exact values) ──
const PRODUCTS = [
  { id: 'mug', name: 'Coffee Mug', sku: 'PM-MUG-001', price: '12.00', stock: 7 },
  { id: 'notebook', name: 'Notebook', sku: 'PM-NBK-002', price: '8.50', stock: 23 },
  { id: 'pens', name: 'Pen Set', sku: 'PM-PEN-003', price: '15.00', stock: 4 },
];

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} · Peerdmart</title></head>
<body>
<header><a href="/">Peerdmart</a> · <a href="/products">Products</a> · <a href="/contact">Contact</a></header>
<main>${body}</main>
</body></html>`;

const homeHtml = () => page('Home', `
<h1>Peerdmart</h1>
<p>Your friendly test storefront.</p>
<ul>
  <li><a href="/products">Browse products</a></li>
  <li><a href="/contact">Contact support</a></li>
</ul>`);

const productsHtml = () => page('Products', `
<h1>Products</h1>
<ul id="product-list">
${PRODUCTS.map((p) => `  <li><a href="/products/${p.id}">${p.name}</a> — $${p.price}</li>`).join('\n')}
</ul>`);

const productHtml = (p) => page(p.name, `
<h1>${p.name}</h1>
<dl>
  <dt>SKU</dt><dd id="sku">${p.sku}</dd>
  <dt>Price</dt><dd id="price">$${p.price}</dd>
  <dt>Availability</dt><dd id="stock">In stock: ${p.stock}</dd>
</dl>
<p><a href="/products">Back to products</a></p>`);

const contactHtml = () => page('Contact', `
<h1>Contact support</h1>
<form method="POST" action="/contact">
  <label for="name">Name</label>
  <input id="name" name="name" type="text">
  <label for="email">Email</label>
  <input id="email" name="email" type="email">
  <label for="orderId">Order ID</label>
  <input id="orderId" name="orderId" type="text">
  <label for="message">Message</label>
  <textarea id="message" name="message"></textarea>
  <button type="submit">Send message</button>
</form>`);

const thanksHtml = (orderId) => page('Thanks', `
<h1>Message received</h1>
<p>Thanks — your support ticket has been created.</p>
<p>Confirmation code: <strong id="confirmation">TICKET-${orderId || 'NONE'}</strong></p>`);

const notFoundHtml = (path) => page('Not found', `
<h1>404 — not found</h1>
<p>No page at <code>${path}</code>.</p>`);

/**
 * Pure router: (method, path, body) → { status, html }. Exported so a test can
 * assert the fixture without an http listener.
 * @param {string} method @param {string} path @param {string} [body]
 */
export const route = (method, path, body = '') => {
  if (method === 'POST' && path === '/contact') {
    const orderId = new URLSearchParams(body).get('orderId') || '';
    // Normalize to the shape the task asserts on (alphanumeric, upper-cased).
    const clean = orderId.replace(/[^a-z0-9-]/gi, '').toUpperCase();
    return { status: 200, html: thanksHtml(clean) };
  }
  if (method !== 'GET') return { status: 405, html: notFoundHtml(path) };
  if (path === '/' || path === '') return { status: 200, html: homeHtml() };
  if (path === '/products') return { status: 200, html: productsHtml() };
  if (path === '/contact') return { status: 200, html: contactHtml() };
  const m = path.match(/^\/products\/([a-z0-9-]+)$/);
  if (m) {
    const p = PRODUCTS.find((x) => x.id === m[1]);
    if (p) return { status: 200, html: productHtml(p) };
  }
  return { status: 404, html: notFoundHtml(path) };
};

/**
 * Start the fixture server on an ephemeral loopback port. Returns the base URL
 * (no trailing slash) + a close(). The tasks reference __FIXTURE__/… and the
 * runner substitutes this url in.
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export const startWebFixtureServer = async () => {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const path = (req.url || '/').split('?')[0];
      const { status, html } = route(req.method || 'GET', path, Buffer.concat(chunks).toString('utf8'));
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {{ port: number }} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r(undefined))),
  };
};
