// @ts-check
// Pure projection for the Actor Fabric. It renders only server-stamped lineage
// belonging to the viewed chat; missing ancestry is omitted, never invented.

/**
 * @typedef {Object} FabricNode
 * @property {string} id
 * @property {string} parentId
 * @property {'root'|'bound'|'subactor'} variant
 * @property {string} kind
 * @property {string} label
 * @property {string} name
 * @property {'working'|'finishing'|'handed-off'} status
 * @property {string} activity
 * @property {string} scope
 * @property {string} access
 * @property {string} boundaryChip
 * @property {string} boundary
 * @property {number|null} cost
 */

/** @param {unknown} value @param {number} [max] */
const compact = (value, max = 80) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** @param {any[]} messages @param {string} toolUseId */
const toolUseFor = (messages, toolUseId) => {
  for (const message of Array.isArray(messages) ? messages : []) {
    const found = Array.isArray(message?.toolUses)
      ? message.toolUses.find((/** @type {any} */ tool) => tool?.id === toolUseId)
      : null;
    if (found) return found;
  }
  return null;
};

/** @param {any[]} messages @param {unknown} grantedTools */
const latestActivity = (messages, grantedTools) => {
  const allowed = new Set(Array.isArray(grantedTools)
    ? grantedTools.filter((tool) => typeof tool === 'string') : []);
  const rows = Array.isArray(messages) ? messages : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const uses = Array.isArray(rows[index]?.toolUses) ? rows[index].toolUses : [];
    const tool = uses[uses.length - 1];
    // A model can request any string. Show it as activity only when it was in
    // the server-resolved grant advertised to that worker.
    if (typeof tool?.name === 'string' && allowed.has(tool.name)) {
      return `Requested ${tool.name.replaceAll('_', ' ')}…`;
    }
  }
  return 'Reasoning in its task context…';
};

/** @param {unknown} tools */
const exactGrants = (tools) => {
  if (!Array.isArray(tools)) return 'authority loading';
  if (tools.length === 0) return 'reasoning only';
  return tools
    .filter((tool) => typeof tool === 'string')
    .join(' · ') || 'reasoning only';
};

const CAPABILITY_LABELS = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({
  actor_create: 'spawn subactors', actor_list: 'list actors', message_actor: 'delegate',
  fetch_url: 'fetch URL', navigate: 'navigate', read_page: 'read page',
  click: 'click page', type: 'type on page', page_keys: 'send page keys',
  page_code: 'run page code', site_client_run: 'use site client',
  script: 'run local code',
}));

/** @param {unknown} tools */
const capabilitySummary = (tools) => {
  if (!Array.isArray(tools)) return 'authority loading';
  if (tools.length === 0) return 'reasoning only';
  return tools
    .filter((tool) => typeof tool === 'string')
    .map((tool) => CAPABILITY_LABELS[tool] ?? tool.replaceAll('_', ' '))
    .join(' · ') || 'reasoning only';
};

/** @param {string} kind @param {string} instanceId @param {string} grant */
const boundGrant = (kind, instanceId, grant) => {
  if (kind === 'web' && /^https?:\/\//.test(instanceId)) return `one origin · ${grant}`;
  if (kind === 'web') return `one web tab · ${grant}`;
  if (kind === 'webvm') return `one WebVM · ${grant}`;
  if (kind === 'notebook') return `one notebook · ${grant}`;
  if (kind === 'app') return `one app · ${grant}`;
  if (kind === 'dweb') return `peer mesh · ${grant}`;
  return grant;
};

/** @param {string} kind */
const kindName = (kind) => kind === 'webvm' ? 'WebVM' : kind;

/** @param {Record<string, any>} sessions @param {string} sessionId @param {string} rootSessionId */
const belongsToRoot = (sessions, sessionId, rootSessionId) => {
  let cursor = sessionId;
  const seen = new Set();
  while (cursor && !seen.has(cursor)) {
    if (cursor === rootSessionId) return true;
    seen.add(cursor);
    const session = sessions[cursor];
    if (!session) return false;
    if (session.rootSessionId) return session.rootSessionId === rootSessionId;
    cursor = session.parentSessionId;
  }
  return false;
};

/**
 * @param {{
 *   rootSession?: any,
 *   actors?: Record<string, any>,
 *   spawned?: { sessions?: Record<string, any> },
 *   asyncTasks?: Record<string, any>,
 * }} input
 * @returns {{ root: FabricNode, nodes: FabricNode[], activeActors: number }}
 */
export const buildActorFabric = ({ rootSession, actors = {}, spawned = {}, asyncTasks = {} }) => {
  const rootSessionId = String(rootSession?.sessionId ?? '');
  const rootId = `session:${rootSessionId || 'chat'}`;
  const sessions = spawned?.sessions ?? {};

  /** @type {Map<string, { parentSessionId: string, task: any }>} */
  const taskByChild = new Map();
  /** @type {Array<{ parentSessionId: string, task: any }>} */
  const visibleTasks = [];
  for (const [parentSessionId, rawTasks] of Object.entries(asyncTasks ?? {})) {
    if (!Array.isArray(rawTasks)) continue;
    if (parentSessionId !== rootSessionId
      && !belongsToRoot(sessions, parentSessionId, rootSessionId)) continue;
    for (const task of rawTasks) {
      if (!task || (task.status !== 'running' && task.status !== 'done')) continue;
      const row = { parentSessionId, task };
      visibleTasks.push(row);
      if (typeof task.childSessionId === 'string' && task.childSessionId) {
        taskByChild.set(task.childSessionId, row);
      }
    }
  }

  const liveSessionIds = new Set();
  for (const session of Object.values(sessions)) {
    if (!session?.sessionId || !belongsToRoot(sessions, session.sessionId, rootSessionId)) continue;
    if (session.running === true || taskByChild.has(session.sessionId)) {
      liveSessionIds.add(session.sessionId);
    }
  }

  // Keep a settled parent as a lineage stub while a descendant still works —
  // including the brief interval where an async child's session is allocated
  // but its first actor-start snapshot has not hydrated yet.
  const visibleSessionIds = new Set(liveSessionIds);
  const preserveAncestors = (/** @type {string|undefined} */ startId) => {
    let cursor = startId;
    const seen = new Set();
    while (cursor && cursor !== rootSessionId && !seen.has(cursor)) {
      seen.add(cursor);
      if (!sessions[cursor] || !belongsToRoot(sessions, cursor, rootSessionId)) break;
      visibleSessionIds.add(cursor);
      cursor = sessions[cursor]?.parentSessionId;
    }
  };
  for (const sessionId of liveSessionIds) {
    preserveAncestors(sessions[sessionId]?.parentSessionId);
  }
  for (const { parentSessionId } of visibleTasks) {
    preserveAncestors(parentSessionId);
  }

  /** @type {FabricNode[]} */
  const nodes = [];
  /** @type {Set<string>} */
  const nodeIds = new Set();

  for (const sessionId of visibleSessionIds) {
    const session = sessions[sessionId];
    const taskRow = taskByChild.get(sessionId);
    const live = liveSessionIds.has(sessionId);
    const id = `session:${sessionId}`;
    nodes.push({
      id,
      parentId: session.parentSessionId ? `session:${session.parentSessionId}` : rootId,
      variant: 'subactor',
      kind: 'subactor',
      label: live ? 'temporary subactor' : 'delegation parent',
      name: compact(session.task ?? taskRow?.task?.task ?? 'Temporary task'),
      status: live ? (taskRow?.task?.status === 'done' ? 'finishing' : 'working') : 'handed-off',
      activity: live
        ? latestActivity(session.messages, session.grantedTools ?? taskRow?.task?.grantedTools)
        : 'Its child is still working…',
      scope: capabilitySummary(session.grantedTools ?? taskRow?.task?.grantedTools),
      access: exactGrants(session.grantedTools ?? taskRow?.task?.grantedTools),
      boundaryChip: live ? 'separate worker' : 'lineage only',
      boundary: live
        ? 'Dedicated keyless worker. Its separate transcript persists; only a fenced reply enters the parent context.'
        : 'This settled actor remains visible only to preserve the real delegation path.',
      cost: typeof session.cost?.cost === 'number' ? session.cost.cost : null,
    });
    nodeIds.add(id);
  }

  // A running task can know its child id before the first session snapshot.
  // Render the stable session id immediately, then enrich the same node later.
  for (const { parentSessionId, task } of visibleTasks) {
    const childSessionId = typeof task.childSessionId === 'string' && task.childSessionId
      ? task.childSessionId : null;
    const id = childSessionId
      ? `session:${childSessionId}`
      : `task:${parentSessionId}:${String(task.taskId ?? 'pending')}`;
    if (nodeIds.has(id)) continue;
    nodes.push({
      id,
      parentId: parentSessionId ? `session:${parentSessionId}` : rootId,
      variant: 'subactor',
      kind: 'subactor',
      label: 'temporary subactor',
      name: compact(task.task ?? 'Temporary task'),
      status: task.status === 'done' ? 'finishing' : 'working',
      activity: task.status === 'done' ? 'Preparing its reply…' : 'Starting its separate worker…',
      scope: capabilitySummary(task.grantedTools),
      access: exactGrants(task.grantedTools),
      boundaryChip: 'separate worker',
      boundary: 'Dedicated keyless worker. Its separate transcript persists; only a fenced reply enters the parent context.',
      cost: null,
    });
    nodeIds.add(id);
  }

  for (const [toolUseId, card] of Object.entries(actors ?? {})) {
    if (!card?.streaming || !card.sessionId) continue;
    // The root stamp comes from the trusted delivery lane. Unstamped or foreign
    // cards are not safe to attach to the chat merely because an id happens to fit.
    if (card.rootSessionId !== rootSessionId) continue;
    const parentId = card.parentSessionId === rootSessionId
      ? rootId : `session:${String(card.parentSessionId ?? '')}`;
    if (parentId !== rootId && !nodeIds.has(parentId)) continue;
    const parentMessages = parentId === rootId
      ? rootSession?.messages : sessions[card.parentSessionId]?.messages;
    const toolUse = toolUseFor(parentMessages, toolUseId);
    const kind = String(card.kind ?? 'actor');
    const instanceId = String(card.instanceId ?? '');
    const integration = kind === 'web' && /^https?:\/\//.test(instanceId);
    const fallbackName = card.name ?? (integration ? instanceId : instanceId || `${kindName(kind)} actor`);
    const task = card.task ?? toolUse?.input?.message;
    /** @type {FabricNode} */
    const node = {
      id: `actor:${card.sessionId}`,
      parentId,
      variant: 'bound',
      kind,
      label: integration ? 'integration actor' : `${kindName(kind)} actor`,
      name: compact(task || fallbackName),
      status: 'working',
      activity: latestActivity(card.messages, card.grantedTools),
      scope: boundGrant(kind, instanceId, capabilitySummary(card.grantedTools)),
      access: boundGrant(kind, instanceId, exactGrants(card.grantedTools)),
      boundaryChip: 'separate worker',
      boundary: 'Dedicated keyless worker with no key or extension APIs. Its transcript stays outside the main model context; only a fenced reply enters.',
      cost: typeof card.cost?.cost === 'number' ? card.cost.cost : null,
    };
    nodes.push(node);
    nodeIds.add(node.id);
  }

  // Reachability, not mere parent-id presence, defines the visible fabric. A
  // corrupt partial chain must not inflate the headline with orphaned nodes.
  const reachable = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of nodes) {
      if (!reachable.has(node.parentId) || reachable.has(node.id)) continue;
      reachable.add(node.id);
      grew = true;
    }
  }
  const safeNodes = nodes.filter((node) => reachable.has(node.id));
  safeNodes.sort((a, b) => {
    if (a.variant !== b.variant) return a.variant === 'bound' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const activeActors = safeNodes.filter((node) => node.status !== 'handed-off').length;

  /** @type {FabricNode} */
  const root = {
    id: rootId,
    parentId: '',
    variant: 'root',
    kind: 'root',
    label: 'main agent',
    name: 'Coordinates work; actor memory stays separate.',
    status: 'working',
    activity: activeActors === 1 ? 'Coordinating one isolated actor…' : `Coordinating ${activeActors} isolated actors…`,
    scope: 'holds chat authority',
    access: 'chat authority',
    boundaryChip: 'main context',
    boundary: 'The main agent holds chat authority. Actor transcripts stay outside its model context; only fenced replies enter.',
    cost: null,
  };

  return { root, nodes: safeNodes, activeActors };
};
