// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
import { summarizeMutations } from '../../dom/action-result.js';
import { fencePageReceipt, shapePageReceipt } from '../page-receipt.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const typeTool = composeTool('type', {
  execute: async (_args, ctx) => {
    return shapePageReceipt(
      /** @type {any} */ (ctx).pageAuthority.fillOwnedTarget(),
      (receipt) => {
        const { channel, mutations, navigated, ...visible } = receipt;
        return {
          ok: true,
          content: fencePageReceipt({
            origin: receipt.origin,
            tool: 'type',
            body: JSON.stringify({
              ...visible,
              ...(navigated ? { navigated: true } : {}),
              ...(channel === 'cdp-ref'
                ? { result: navigated ? 'page navigated' : summarizeMutations(mutations) }
                : {}),
            }, null, 2),
          }),
        };
      },
    );
  },
});
