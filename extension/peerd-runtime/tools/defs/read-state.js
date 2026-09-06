// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
import { originOfUrl } from '../../tool-origin-policy.js';
import {
  fencePageReceipt, shapePageReceipt,
} from '../page-receipt.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const readStateTool = composeTool('read_state', {
  execute: async (_args, ctx) => {
    return shapePageReceipt(
      /** @type {any} */ (ctx).pageAuthority.readOwnedFrameworkState(),
      (receipt) => ({
      ok: true,
      content: fencePageReceipt({
        origin: originOfUrl(receipt.url),
        tool: 'read_state',
        body: JSON.stringify(receipt.payload, null, 2),
      }),
      }),
    );
  },
});
