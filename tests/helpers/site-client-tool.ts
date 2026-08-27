import { createSiteClientToolAuthority } from '../../extension/background/site-client-tool-authority.js';

export const executeSiteClientTool = (
  tool: any, args: any, authorityContext: any,
) => tool.execute(args, {
  siteClientAuthority: createSiteClientToolAuthority({
    call: { name: tool.name, args },
    ctx: authorityContext,
    signal: authorityContext?.abortSignal,
  }),
});
