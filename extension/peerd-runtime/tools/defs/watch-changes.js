// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
import { summarizeMutations } from '../../dom/action-result.js';
import {
  fencePageReceipt, shapePageReceipt,
} from '../page-receipt.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const watchChangesTool = composeTool('watch_changes', {
  execute: async (_args, ctx) => {
    return shapePageReceipt(
      /** @type {any} */ (ctx).pageAuthority.drainOwnedDomChanges(),
      (receipt) => {
        const body = receipt.started
          ? 'watching started: baseline set. Call watch_changes again to see what changed since now.'
          : `changes since last look: ${summarizeMutations(receipt.changes) ?? 'no DOM change detected'}`;
        return {
      ok: true,
      content: fencePageReceipt({ origin: receipt.origin, tool: 'watch_changes', body }),
        };
      },
    );
  },
});
