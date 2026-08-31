// @ts-check

// why: dweb discovery presentation, moderation intent, install/share result
// shaping, and the bridge guide are feature semantics. The controller receives
// only named mesh actions, never the transport or app/storage registries.
import { dwebDiscoverTool } from './tools/defs/dweb-discover.js';
import { dwebShareTool } from './tools/defs/dweb-share.js';
import { dwebInstallTool } from './tools/defs/dweb-install.js';
import { dwebPeersTool } from './tools/defs/dweb-peers.js';
import { dwebBlockTool } from './tools/defs/dweb-block.js';
import { dwebDiscoveryTool } from './tools/defs/dweb-discovery.js';
import { a2aRunTool } from './tools/defs/a2a-run.js';

const tools = Object.freeze({
  dweb_discover: dwebDiscoverTool,
  dweb_share: dwebShareTool,
  dweb_install: dwebInstallTool,
  dweb_peers: dwebPeersTool,
  dweb_block: dwebBlockTool,
  dweb_discovery: dwebDiscoveryTool,
  a2a_run: a2aRunTool,
});

export const CONTROLLER_DWEB_TOOL_NAMES = Object.freeze(Object.keys(tools));

export const controllerHostsDwebTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' && Object.hasOwn(tools, name);

/**
 * @param {string} name
 * @param {unknown} args
 * @param {{sessionId?:string,dwebAvailable?:boolean}} projection
 * @param {Record<string,Function>} authority
 * @param {{signal?:AbortSignal}} [options]
 */
export const executeControllerDwebTool = async (
  name, args, projection, authority, options = {},
) => {
  const tool = tools[/** @type {keyof typeof tools} */ (name)];
  if (!tool) throw Object.assign(new Error('controller dweb tool is unavailable'), {
    code: 'controller-dweb-tool-unavailable', outcomeKnown: true,
  });
  return tool.execute(args, /** @type {any} */ ({
    abortSignal: options.signal,
    session: { sessionId: projection.sessionId },
    dwebAvailable: projection.dwebAvailable === true,
    dwebAuthority: Object.freeze({
      discoverApps: authority.discoverApps,
      publishConfirmedApp: authority.publishConfirmedApp,
      installConfirmedApp: authority.installConfirmedApp,
      readPeers: authority.readPeers,
      setPeerBlocked: authority.setPeerBlocked,
      setDiscoveryEnabled: authority.setDiscoveryEnabled,
      runMeshProgram: authority.runMeshProgram,
    }),
  }));
};
