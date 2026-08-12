// @ts-check

const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*\0).+$/;

/** Build the checked-in declaration shared by local creation and Git import. */
/** @param {{entry:string,dwapp?:boolean}} fields */
export const buildAppManifest = ({ entry, dwapp = false }) => ({
  schema: 1,
  kind: dwapp ? 'dwapp' : 'app',
  entry,
  agent: { kind: 'bound-app' },
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
  if (!Array.isArray(value.capabilities)
      || value.capabilities.length > 16
      || value.capabilities.some((/** @type {unknown} */ capability) => typeof capability !== 'string' || capability.length > 64)) {
    throw new Error('peerd.json capabilities are invalid');
  }
  const capabilities = /** @type {string[]} */ ([...new Set(value.capabilities)]);
  if (capabilities.some((/** @type {string} */ capability) => capability !== 'dweb')) throw new Error('peerd.json requests an unknown capability');
  if (value.kind === 'dwapp' && !capabilities.includes('dweb')) throw new Error('a dwapp manifest must declare dweb');
  return Object.freeze({ schema: 1, kind: value.kind, entry: value.entry, agent: Object.freeze({ kind: 'bound-app' }), capabilities: Object.freeze(capabilities) });
};
