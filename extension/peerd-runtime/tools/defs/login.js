// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
import { shapePageReceipt } from '../page-receipt.js';

/** @param {any} receipt */
const loginGuidance = (receipt) => {
  if (receipt.kind === 'manual-passkey') {
    return 'Finish signing in in the open tab. Click the passkey or security-key button and '
      + 'complete the prompt on your device. peerd never sees your credential. When you are done, '
      + 'tell peerd to continue.';
  }
  if (receipt.kind === 'manual-sso') {
    const guidance = receipt.verified && receipt.idpOrigin
      ? `Click the ${receipt.provider} sign-in button. peerd cannot read or act on ${receipt.idpOrigin}. `
        + `When this tab returns to ${receipt.origin}, tell peerd to continue. `
      : `Click the sign-in button only if you trust this page. peerd could not verify that it leads to ${receipt.provider}, so peerd cannot follow the destination. When you are done, tell peerd to continue. `;
    return `Finish signing in in the open tab. ${guidance}peerd never sees your credential.`;
  }
  if (receipt.kind === 'auto-sso') {
    return `Finish signing in in the open tab. peerd is paused and cannot read or act on ${receipt.idpOrigin}. `
      + `When this tab returns to ${receipt.origin}, tell peerd to continue. peerd never sees your credential.`;
  }
  return null;
};

/** @type {import('/shared/tool-types.js').Tool} */
export const loginTool = composeTool('login', {
  execute: async (_args, ctx) => {
    return shapePageReceipt(
      /** @type {any} */ (ctx).pageAuthority.performConfirmedOwnedLogin(),
      (receipt) => {
        const content = loginGuidance(receipt);
        return content
          ? { ok: true, endTurn: true, content }
          : { ok: false, error: 'login_authority_receipt_invalid' };
      },
    );
  },
});
