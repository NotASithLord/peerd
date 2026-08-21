// @ts-check
// Toolbox write-time parser host. The SW remains the storage authority; this
// document performs only syntax/import-graph validation and reads existing
// sibling bodies through the SW's execute-only toolbox/read route.

import browser from '/shared/browser-api.js';
import { buildModule } from '/peerd-engine/offscreen.js';
import { makeToolboxParseCheck } from '/peerd-runtime/offscreen.js';
import { REMOTE_MODULE_IMPORTS_ENABLED } from '/shared/channel-config.js';

const parseCheck = makeToolboxParseCheck({
  buildModule,
  remoteModulesEnabled: REMOTE_MODULE_IMPORTS_ENABLED,
  readSibling: async (name) => {
    const reply = /** @type {{ ok?: boolean, body?: string, error?: string }} */ (
      await browser.runtime.sendMessage({ type: 'toolbox/read', name })
    );
    if (!reply?.ok || typeof reply.body !== 'string') {
      throw new Error(reply?.error ?? `unknown toolbox module '${name}'`);
    }
    return reply.body;
  },
});

/**
 * @param {any} message
 * @returns {Promise<{ok:true}|{ok:false,error:string}>}
 */
export const handleToolboxParseCheck = async (message) => {
  try {
    await parseCheck(message.name, message.body);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: /** @type {{ message?: string }} */ (error)?.message ?? String(error),
    };
  }
};
