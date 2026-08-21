// @ts-check
// Controller-independent composer browser projections. Full tab URLs are
// consumed only by the authority policy and never leave this module.

import {
  projectComposerTabRows,
  renderComposerTabs,
} from '../shared/composer-tab-view.js';
import { createKernelAppFileReader } from './kernel-app-file-reader.js';
import { createKernelCommandReader } from './kernel-command-reader.js';
import { kernelTabOrigin } from './kernel-denylist-policy.js';

// Public constructor for this exact composer-policy family. Keeping the entry
// on one reviewed edge prevents each small cold adapter from consuming another
// top-level import while its own native module remains independently measured.
export { createKernelDenylistPolicy } from './kernel-denylist-policy.js';

/**
 * @param {Object} deps
 * @param {any} deps.browser
 * @param {{list:(prefix:string)=>Promise<Record<string,any>>}} deps.kv
 * @param {{get:(store:string,key:string)=>Promise<any>}} deps.idb
 * @param {{sessionGet:(key:string)=>Promise<any>}} deps.sessionCache
 * @param {{isLocked:()=>boolean}} deps.vault
 * @param {{ready:()=>Promise<{ok:boolean}>,blocks:(hostname:string)=>boolean,patterns:()=>string[],snapshot:()=>Promise<any>}} deps.denylist
 * @param {{list:()=>Promise<Array<{name:string,description:string}>>}} [deps.commands]
 * @param {{list:()=>Promise<string[]>}} [deps.appFiles]
 */
export const makeKernelComposerRoutes = ({
  browser, kv, idb, sessionCache, vault, denylist,
  commands = createKernelCommandReader({ kv }),
  appFiles = createKernelAppFileReader({ idb, sessionCache }),
}) => {
  return Object.freeze({
    'denylist/list': async () => denylist.snapshot(),
    'commands/list': async () => ({ ok: true, commands: await commands.list() }),
    'composer/files': async () => {
      if (vault.isLocked()) return { ok: true, files: [] };
      try { return { ok: true, files: await appFiles.list() }; }
      catch { return { ok: true, files: [] }; }
    },
    'composer/tabs': async () => {
      await denylist.ready();
      let tabs = [];
      try { tabs = await browser.tabs.query({}); } catch { tabs = []; }
      return renderComposerTabs(projectComposerTabRows(tabs, {
        originOfTabUrl: kernelTabOrigin,
        matchesDenylist: (host) => denylist.blocks(host),
        patterns: denylist.patterns,
      }));
    },
  });
};
