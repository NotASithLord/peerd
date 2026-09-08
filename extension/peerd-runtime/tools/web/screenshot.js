// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
import { originOfUrl } from '../../tool-origin-policy.js';
import { shapePageReceipt } from '../page-receipt.js';

/** @param {string} dataUrl */
const estimateBase64Bytes = (dataUrl) => {
  const idx = dataUrl.indexOf(',');
  if (idx < 0) return 0;
  return Math.floor((dataUrl.slice(idx + 1).length * 3) / 4);
};

/** @type {import('/shared/tool-types.js').Tool} */
export const captureTool = composeTool('capture', {
  execute: async (_args, ctx) => {
    return shapePageReceipt(
      /** @type {any} */ (ctx).pageAuthority.captureForegroundPixels(),
      (receipt) => ({
      ok: true,
      content: JSON.stringify({
        format: receipt.format,
        dataUrl: receipt.dataUrl,
        bytes: estimateBase64Bytes(receipt.dataUrl),
        origin: originOfUrl(receipt.url) || null,
      }, null, 2),
      }),
    );
  },
});
