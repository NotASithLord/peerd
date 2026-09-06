// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
import { originOfUrl } from '../../tool-origin-policy.js';
import { diffSnapshots } from '../../dom/snapshot-diff.js';
import {
  fencePageReceipt, shapePageReceipt,
} from '../page-receipt.js';

/** @param {'cdp'|'dom-walk'|'none'} source */
const describeSource = (source) => source === 'dom-walk'
  ? 'pseudo-a11y snapshot (DOM-walk fallback: no CDP here; top frame only)'
  : 'a11y snapshot';

/** @type {import('/shared/tool-types.js').Tool} */
export const snapshotTool = composeTool('snapshot', {
  execute: async (_args, ctx) => {
    return shapePageReceipt(
      /** @type {any} */ (ctx).pageAuthority.captureOwnedAccessibilityTree(),
      (receipt) => {
        const cappedNote = receipt.capped
          ? ' (node cap hit: page larger than the DOM-walk limit; focus a smaller region/tab to see the rest)'
          : '';
        let body;
        if (receipt.diff) {
          const { text } = diffSnapshots(receipt.prevRefs ?? [], receipt.refs ?? []);
          body = `${describeSource(receipt.source)} diff since last snapshot: ${receipt.refCount} refs now`
            + `${receipt.truncated ? ' (truncated)' : ''}${cappedNote}\n${text}`;
        } else {
          body = `${describeSource(receipt.source)}: ${receipt.refCount} interactable refs`
            + `${receipt.truncated ? ' (truncated; raise budget or focus a region)' : ''}${cappedNote}\n${receipt.text}`;
        }
        return {
          ok: true,
          content: fencePageReceipt({
            origin: originOfUrl(receipt.url), tool: 'snapshot', body,
          }),
        };
      },
    );
  },
});
