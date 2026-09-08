// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
import {
  fencePageReceipt, shapePageReceipt,
} from '../page-receipt.js';

/** @param {any} snap */
const formatBody = (snap) => {
  const lines = [
    `Selector: ${snap.selector}`,
    `URL: ${snap.url}`,
    `Total matches: ${snap.totalMatches}${snap.truncated ? ' (truncated)' : ''}`,
    snap.includeHidden ? 'Mode: including hidden elements' : 'Mode: visible only',
    '',
  ];
  if (!Array.isArray(snap.matches) || snap.matches.length === 0) {
    lines.push('(no matches)');
    return lines.join('\n');
  }
  snap.matches.forEach((/** @type {any} */ m, /** @type {number} */ i) => {
    lines.push(`[${i}] <${m.tag}>${m.visible ? '' : ' (hidden)'}`);
    if (m.label) lines.push(`    label: ${m.label}`);
    if (m.role) lines.push(`    role: ${m.role}`);
    if (m.href) lines.push(`    href: ${m.href}`);
    if (m.type) lines.push(`    type: ${m.type}`);
    if (m.name) lines.push(`    name: ${m.name}`);
    if (m.testid) lines.push(`    data-testid: ${m.testid}`);
    if (m.value) lines.push(`    value: ${m.value}`);
    lines.push(`    bbox: ${m.bbox}`);
    lines.push(`    selector: ${m.selector}`);
  });
  return lines.join('\n');
};

/** @type {import('/shared/tool-types.js').Tool} */
export const queryDomTool = composeTool('query_dom', {
  execute: async (_args, ctx) => {
    return shapePageReceipt(
      /** @type {any} */ (ctx).pageAuthority.queryOwnedDom(),
      (receipt) => ({
      ok: true,
      content: fencePageReceipt({
        origin: receipt.origin, tool: 'query_dom', body: formatBody(receipt),
      }),
      }),
    );
  },
});
