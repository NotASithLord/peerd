// Rebuild peerd's narrow Mithril distribution from an exact upstream release.
// This is a vendor-time tool only; it never ships in the extension.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VERSION = '2.3.8';
const UPSTREAM_URL = `https://unpkg.com/mithril@${VERSION}/mithril.js`;
const UPSTREAM_SHA256 = '6c080d9a4b6289e32534bc2a0bab94cc864c5206f106bae4f8de96f4900b9960';
const REQUEST_BLOCK_SHA256 = 'dc5fea435b2724f268b67f9d8794b0e22c4f9c80464711badf0dd0248cb55c78';
const OUTPUT_PATH = fileURLToPath(
  new URL('../extension/vendor/mithril/mithril.js', import.meta.url),
);

const UMD_HEADER = ';(function() {\n"use strict"\n';
const UMD_FOOTER = 'if (typeof module !== "undefined") module["exports"] = m\n'
  + 'else window.m = m\n}());';
const REQUEST_START = 'var _25 = function($window, oncompletion) {\n';
const REQUEST_END = 'var request = _25(typeof window !== "undefined" ? window : null, mountRedraw.redraw)\n';
const REQUEST_EXPORT = 'm.request = request.request\n';
const OUTPUT_HEADER = `// Mithril ${VERSION} - peerd ESM vendor build. See SOURCE.txt for provenance.\n`
  + '// Original UMD wrapper/export and the m.request XHR subsystem are stripped;\n'
  + '// every remaining upstream body byte is preserved.\n';

class MithrilVendorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MithrilVendorError';
  }
}

const sha256 = (source: string): string =>
  createHash('sha256').update(source).digest('hex');

const uniqueIndex = (source: string, needle: string, label: string): number => {
  const index = source.indexOf(needle);
  if (index < 0 || source.lastIndexOf(needle) !== index) {
    throw new MithrilVendorError(`${label} must occur exactly once`);
  }
  return index;
};

export const tailorMithril = (upstream: string): string => {
  const upstreamHash = sha256(upstream);
  if (upstreamHash !== UPSTREAM_SHA256) {
    throw new MithrilVendorError(
      `upstream SHA-256 mismatch: expected ${UPSTREAM_SHA256}, received ${upstreamHash}`,
    );
  }
  if (!upstream.startsWith(UMD_HEADER) || !upstream.endsWith(UMD_FOOTER)) {
    throw new MithrilVendorError('upstream UMD wrapper mismatch');
  }

  let body = upstream.slice(UMD_HEADER.length, -UMD_FOOTER.length);
  const requestStart = uniqueIndex(body, REQUEST_START, 'request start');
  const requestEndStart = uniqueIndex(body, REQUEST_END, 'request end');
  const requestEnd = requestEndStart + REQUEST_END.length;
  if (requestEnd <= requestStart) {
    throw new MithrilVendorError('request anchors are out of order');
  }
  const requestBlock = body.slice(requestStart, requestEnd);
  if (sha256(requestBlock) !== REQUEST_BLOCK_SHA256) {
    throw new MithrilVendorError('request block SHA-256 mismatch');
  }
  body = body.slice(0, requestStart) + body.slice(requestEnd);

  const requestExport = uniqueIndex(body, REQUEST_EXPORT, 'request export');
  body = body.slice(0, requestExport) + body.slice(requestExport + REQUEST_EXPORT.length);
  if (/XMLHttpRequest|\bm\.request\b/.test(body)) {
    throw new MithrilVendorError('request implementation survived tailoring');
  }

  return `${OUTPUT_HEADER}${body}export default m;\n`;
};

const fetchUpstream = async (): Promise<string> => {
  const response = await fetch(UPSTREAM_URL);
  if (!response.ok) {
    throw new MithrilVendorError(`upstream fetch failed: HTTP ${response.status}`);
  }
  return response.text();
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check' && arg !== '--write')) {
    throw new MithrilVendorError('usage: bun packaging/vendor-mithril.ts [--check|--write]');
  }
  if (args.includes('--check') && args.includes('--write')) {
    throw new MithrilVendorError('choose either --check or --write');
  }

  const generated = tailorMithril(await fetchUpstream());
  if (args.includes('--write')) {
    writeFileSync(OUTPUT_PATH, generated);
    console.log(`wrote ${OUTPUT_PATH} (${generated.length} bytes, SHA-256 ${sha256(generated)})`);
    return;
  }
  const current = readFileSync(OUTPUT_PATH, 'utf8');
  if (current !== generated) {
    throw new MithrilVendorError(
      'vendored Mithril drifted; run `bun packaging/vendor-mithril.ts --write`',
    );
  }
  console.log(`Mithril vendor check OK (${generated.length} bytes, SHA-256 ${sha256(generated)})`);
};

if (import.meta.main) await main();
