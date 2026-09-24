// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
import { fencePageReceipt, shapePageReceipt } from '../page-receipt.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const navigateTool = composeTool('navigate', {
  execute: async (_args, ctx) => {
    return shapePageReceipt(
      /** @type {any} */ (ctx).pageAuthority.navigateOwnedTab(),
      (receipt) => ({
        ok: true,
        content: fencePageReceipt({
          origin: receipt.finalUrl,
          tool: 'navigate',
          body: JSON.stringify(receipt, null, 2),
        }),
      }),
    );
  },
});
