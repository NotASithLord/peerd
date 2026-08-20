// @ts-check

const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*\0).+$/;
const APP_AGENT_RUNTIME_METHODS = Object.freeze(new Set(['observe', 'act']));
const MAX_AGENT_NAME = 80;
const MAX_AGENT_INSTRUCTIONS = 12_000;

/** Build the checked-in declaration shared by local creation and Git import. */
/** @param {{entry:string,dwapp?:boolean}} fields */
export const buildAppManifest = ({ entry, dwapp = false }) => ({
  schema: 1,
  kind: dwapp ? 'dwapp' : 'app',
  entry,
  agent: { kind: 'bound-app', profile: 'developer', surface: 'code' },
  capabilities: dwapp ? ['dweb'] : [],
});

/** @param {string} text */
export const parseAppManifest = (text) => {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('peerd.json is not valid JSON'); }
  if (!value || typeof value !== 'object' || value.schema !== 1) throw new Error('peerd.json schema must be 1');
  if (value.kind !== 'app' && value.kind !== 'dwapp') throw new Error('peerd.json kind must be app or dwapp');
  if (typeof value.entry !== 'string' || value.entry.length > 512 || !SAFE_PATH.test(value.entry)) {
    throw new Error('peerd.json entry is unsafe');
  }
  if (value.agent?.kind !== 'bound-app') throw new Error('peerd.json agent.kind must be bound-app');
  if (value.agent.profile !== undefined && value.agent.profile !== 'developer') {
    throw new Error('peerd.json agent.profile must be developer');
  }
  if (value.agent.surface !== undefined && value.agent.surface !== 'code') {
    throw new Error('peerd.json agent.surface must be code');
  }
  const agentName = value.agent.name;
  if (agentName !== undefined
      && (typeof agentName !== 'string' || !agentName.trim() || agentName.length > MAX_AGENT_NAME
        || /[\r\n\0]/.test(agentName))) {
    throw new Error(`peerd.json agent.name must be 1..${MAX_AGENT_NAME} characters`);
  }
  const instructions = value.agent.instructions;
  if (instructions !== undefined
      && (typeof instructions !== 'string' || !instructions.trim()
        || instructions.length > MAX_AGENT_INSTRUCTIONS || instructions.includes('\0'))) {
    throw new Error(`peerd.json agent.instructions must be 1..${MAX_AGENT_INSTRUCTIONS} safe characters`);
  }
  if (value.agent.tools !== undefined) {
    throw new Error('peerd.json agent.tools is unsupported; declare agent.runtime methods and the host-owned developer profile');
  }
  const requestedRuntime = value.agent.runtime ?? [];
  if (!Array.isArray(requestedRuntime) || requestedRuntime.length > 8
      || requestedRuntime.some((method) => typeof method !== 'string' || !APP_AGENT_RUNTIME_METHODS.has(method))) {
    throw new Error('peerd.json agent.runtime requests an unknown App runtime method');
  }
  const runtime = /** @type {string[]} */ ([...new Set(requestedRuntime)]);
  if (runtime.length !== 0 && runtime.length !== APP_AGENT_RUNTIME_METHODS.size) {
    throw new Error('peerd.json agent.runtime must declare observe and act together');
  }
  if (!Array.isArray(value.capabilities)
      || value.capabilities.length > 16
      || value.capabilities.some((/** @type {unknown} */ capability) => typeof capability !== 'string' || capability.length > 64)) {
    throw new Error('peerd.json capabilities are invalid');
  }
  const capabilities = /** @type {string[]} */ ([...new Set(value.capabilities)]);
  if (capabilities.some((/** @type {string} */ capability) => capability !== 'dweb')) throw new Error('peerd.json requests an unknown capability');
  if (value.kind === 'dwapp' && !capabilities.includes('dweb')) throw new Error('a dwapp manifest must declare dweb');
  const agent = Object.freeze({
    kind: 'bound-app',
    profile: 'developer',
    surface: 'code',
    ...(agentName ? { name: agentName.trim() } : {}),
    ...(instructions ? { instructions: instructions.trim() } : {}),
    ...(runtime.length > 0 ? { runtime: Object.freeze(runtime) } : {}),
  });
  return Object.freeze({
    schema: 1,
    kind: value.kind,
    entry: value.entry,
    agent,
    capabilities: Object.freeze(capabilities),
  });
};
