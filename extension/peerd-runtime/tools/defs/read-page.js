// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
import { originOfUrl } from '../../tool-origin-policy.js';
import {
  excerptFooter, excerptRelevant, pagingFooter, windowText,
} from '../web/spill.js';
import {
  fencePageReceipt, shapePageReceipt,
} from '../page-receipt.js';

const CONTENT_BODY_CHARS = 16_000;

/** @param {any} snap */
const formatPageBody = (snap) => {
  const lines = [
    `Title: ${snap.title}`,
    `URL: ${snap.url}`,
    '',
    '[TEXT]',
    snap.text || '(empty)',
    '',
    '[INTERACTABLES]',
  ];
  if (!Array.isArray(snap.interactables) || snap.interactables.length === 0) {
    lines.push('(none detected)');
  } else {
    for (const el of snap.interactables) {
      const parts = [el.kind];
      if (el.label) parts.push(`label="${el.label}"`);
      if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
      if (el.value) parts.push(`value="${el.value}"`);
      if (el.href) parts.push(`href="${el.href}"`);
      parts.push(`selector=${el.selector}`);
      lines.push(`- ${parts.join(' ')}`);
    }
  }
  return lines.join('\n');
};

/** @type {import('/shared/tool-types.js').Tool} */
export const readPageTool = composeTool('read_page', {
  execute: async (args, ctx) => {
    const authority = /** @type {any} */ (ctx).pageAuthority;
    return shapePageReceipt(authority.readOwnedPage(), async (receipt) => {
      const origin = originOfUrl(receipt.url);
      if (receipt.kind !== 'content') return {
        ok: true,
        content: fencePageReceipt({
          origin, tool: 'read_page', body: formatPageBody(receipt.snapshot ?? {}),
        }),
      };
      const markdown = typeof receipt.markdown === 'string' ? receipt.markdown : '';
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      const excerpt = query ? excerptRelevant(markdown, query, CONTENT_BODY_CHARS) : null;
      const win = windowText(markdown, CONTENT_BODY_CHARS);
      let text = excerpt ? excerpt.excerpt : win.window;
      const truncated = excerpt ? excerpt.excerpted : win.windowed;
      let footer = null;
      if (truncated && authority.spillPageResult) {
        try {
          const key = await authority.spillPageResult({
            url: receipt.url, format: 'markdown', text: markdown,
            producer: 'read_page', fenced: true, originLabel: origin,
          });
          if (key) {
            footer = excerpt
              ? excerptFooter({
                key, total: excerpt.total, passagesShown: excerpt.passagesShown,
                passagesTotal: excerpt.passagesTotal, query,
              })
              : pagingFooter({
                key, total: win.total, headChars: win.headChars, tailChars: win.tailChars,
              });
          }
        } catch { /* the bounded semantic window still returns */ }
      } else if (truncated) {
        text = markdown.slice(0, CONTENT_BODY_CHARS);
      }
      const fenced = fencePageReceipt({
        origin,
        tool: 'read_page',
        body: JSON.stringify({
          mode: 'content', url: receipt.url,
          ...(receipt.title ? { title: receipt.title } : {}),
          format: 'markdown', truncated, body: text,
          ...(receipt.htmlTruncated ? { htmlTruncated: true } : {}),
        }, null, 2),
      });
      return { ok: true, content: footer ? `${fenced}\n${footer}` : fenced };
    });
  },
});
