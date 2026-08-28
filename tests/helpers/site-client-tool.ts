import { createSiteClientToolAuthority } from '../../extension/background/site-client-tool-authority.js';

export const executeSiteClientTool = (
  tool: any, args: any, authorityContext: any,
) => {
  const shared = {};
  const authorityFor = (operation: string, bindingArgs: any) =>
    createSiteClientToolAuthority({
      binding: { operation, args: bindingArgs }, ctx: authorityContext,
      signal: authorityContext?.abortSignal, shared,
    });
  return tool.execute(args, {
    siteClientAuthority: {
      readStoredClient: (origin: string) => authorityFor(
        'turn.site-client.read', { origin },
      ).readStoredClient(origin),
      runStoredClient: (origin: string, code: string, timeoutMs: number) => authorityFor(
        'turn.site-client.run', args,
      ).runStoredClient(origin, code, timeoutMs),
      commitConfirmedClient: (origin: string) => authorityFor(
        'turn.site-client.commit', args,
      ).commitConfirmedClient(origin),
      startOwnedCapture: () => authorityFor(
        'turn.site-client.capture-start', args,
      ).startOwnedCapture(),
      stopOwnedCapture: () => authorityFor(
        'turn.site-client.capture-stop', args,
      ).stopOwnedCapture(),
    },
  });
};
