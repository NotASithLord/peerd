// @ts-check
// User and model reports for engine resources the live liveness sweep found
// without a surviving host tab. This is the pure half of the production path:
// the service worker reads registries, audits each loss, then parks one grouped
// report per owning chat.

const KIND_LABELS = Object.freeze({
  vm: 'Linux VM',
  notebook: 'Notebook',
  app: 'App',
});

const MAX_VISIBLE_RESOURCES = 3;
const MAX_REPORTED_RESOURCES = 20;
const MAX_NAME_LENGTH = 80;

/**
 * @typedef {Object} LostEngineResource
 * @property {'vm' | 'notebook' | 'app'} kind
 * @property {string} id
 * @property {string} ownerSessionId
 * @property {unknown} [name]
 */

/**
 * @typedef {Object} ResourceLossNotice
 * @property {string} sessionId
 * @property {string} user
 * @property {string} agent
 * @property {{ operation: string, recoveryState: 'interrupted',
 *   resourceLost: true,
 *   resources: ReadonlyArray<{ kind: string, id: string }>,
 *   omittedCount?: number }} recoveryRecord
 */

/** @param {unknown} value @param {string} fallback */
const cleanName = (value, fallback) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!text) return fallback;
  return text.length <= MAX_NAME_LENGTH
    ? text
    : `${text.slice(0, MAX_NAME_LENGTH - 3)}...`;
};

/** @param {LostEngineResource} resource */
const resourceLabel = (resource) =>
  `${KIND_LABELS[resource.kind]} ${JSON.stringify(cleanName(resource.name, resource.id))}`;

/** @param {LostEngineResource} resource */
const resourceIdLabel = (resource) =>
  `${KIND_LABELS[resource.kind]} ${JSON.stringify(resource.id)}`;

/**
 * Group resource loss by owning chat. One interruption can remove several
 * engine tabs, so one passive notice is more useful than a banner per tab.
 * Resource names are normalized and bounded for the human notice. The model
 * report uses generated engine IDs, never names. Tool arguments and resource
 * contents never enter either shape.
 *
 * @param {unknown} input
 * @returns {ReadonlyArray<ResourceLossNotice>}
 */
export const groupResourceLossNotices = (input) => {
  if (!Array.isArray(input)) return Object.freeze([]);
  /** @type {Map<string, LostEngineResource[]>} */
  const bySession = new Map();
  for (const candidate of input) {
    if (!candidate || typeof candidate !== 'object') continue;
    const resource = /** @type {Partial<LostEngineResource>} */ (candidate);
    if (typeof resource.kind !== 'string' || !Object.hasOwn(KIND_LABELS, resource.kind)
        || typeof resource.id !== 'string' || !/^[a-z0-9-]{1,128}$/.test(resource.id)
        || typeof resource.ownerSessionId !== 'string' || !resource.ownerSessionId) continue;
    const list = bySession.get(resource.ownerSessionId) ?? [];
    list.push(/** @type {LostEngineResource} */ (resource));
    bySession.set(resource.ownerSessionId, list);
  }

  return Object.freeze([...bySession].map(([sessionId, resources]) => {
    const visible = resources.slice(0, MAX_VISIBLE_RESOURCES).map(resourceLabel);
    const hiddenCount = resources.length - visible.length;
    const list = hiddenCount > 0
      ? `${visible.join(', ')}, and ${hiddenCount} more`
      : visible.join(', ');
    const subject = resources.length === 1
      ? `${list} is no longer running.`
      : `${resources.length} environments are no longer running: ${list}.`;
    const reported = resources.slice(0, MAX_REPORTED_RESOURCES);
    const omittedCount = resources.length - reported.length;
    const agentList = reported.map(resourceIdLabel).join(', ');
    const agentSubject = resources.length === 1
      ? `1 engine resource lost its host: ${agentList}`
      : `${resources.length} engine resources lost their hosts: ${agentList}`;
    return Object.freeze({
      sessionId,
      user: `${subject} Stored files and resource details remain. Running processes and other in-memory state were lost.`,
      agent: `${agentSubject}${omittedCount ? `, and ${omittedCount} more` : ''}. Stored files and resource details remain. Running processes and other in-memory state were lost. Do not claim the runtime resumed.`,
      recoveryRecord: Object.freeze({
        operation: resources.length === 1
          ? `${resources[0].kind}:${resources[0].id}`
          : 'engine_resources',
        recoveryState: /** @type {const} */ ('interrupted'),
        resourceLost: /** @type {const} */ (true),
        resources: Object.freeze(reported.map(({ kind, id }) => Object.freeze({ kind, id }))),
        ...(omittedCount ? { omittedCount } : {}),
      }),
    });
  }));
};
