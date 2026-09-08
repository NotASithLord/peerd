// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
import { fencePageReceipt, shapePageReceipt } from '../page-receipt.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const openTabTool = composeTool('open_tab', {
  execute: async (_args, ctx) => {
    return shapePageReceipt(
      /** @type {any} */ (ctx).pageAuthority.openProtectedBackgroundTab(),
      (receipt) => ({
      ok: true,
      content: fencePageReceipt({
        origin: receipt.url,
        tool: 'open_tab',
        body: JSON.stringify({
          tabId: receipt.tabId,
          url: receipt.url,
          networkGuard: {
            scope: 'tab_and_visited_origin_workers',
            lifetime: 'until_tab_closed',
            blocks: ['private_network', 'sensitive_site_denylist'],
            workerScope: 'private_network_fetch',
            chromeWorkerWebSocket: 'not_covered_by_dnr',
          },
        }, null, 2),
      }),
      }),
    );
  },
});
