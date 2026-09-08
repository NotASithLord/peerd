// @ts-check
// Instance-wide Actor Space. Unlike the compact chat fabric, this full-screen
// monitor intentionally spans every active root session in this peerd instance.
// Its input is the SW-owned projection, never actor-authored claims.

import m from '/vendor/mithril/mithril.js';
import { buildActorFabric } from '/sidepanel/components/actor-fabric-model.js';

/** @typedef {import('/sidepanel/components/actor-fabric-model.js').FabricNode} FabricNode */

const REFRESH_MS = 1_200;

/** @param {string} value */
const inspectorId = (value) => `actor-space-inspector-${value.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

/** @param {string|null|undefined} value */
const displayModel = (value) => {
  const model = String(value ?? '').trim();
  if (!model) return 'model pending';
  const slash = model.lastIndexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
};

/** @param {FabricNode} node */
const nodeStatus = (node) => node.status === 'handed-off' ? 'lineage' : node.status;

/** @param {FabricNode} node @param {string} selectedId @param {(node: FabricNode) => void} select */
const actorNode = (node, selectedId, select) => m('button.actor-space-node', {
  type: 'button',
  class: `is-${node.variant}${selectedId === node.id ? ' is-selected' : ''}`,
  'data-actor-id': node.id,
  'data-actor-kind': node.variant,
  'aria-pressed': selectedId === node.id ? 'true' : 'false',
  'aria-expanded': selectedId === node.id ? 'true' : 'false',
  'aria-controls': selectedId === node.id ? inspectorId(node.id) : undefined,
  'aria-label': `${node.label}: ${node.name}; ${nodeStatus(node)}`,
  onclick: () => select(node),
}, [
  m('span.peerd-spinner.actor-space-node-orb', { 'aria-hidden': 'true' }),
  m('span.actor-space-node-copy', [
    m('span.actor-space-node-topline', [
      m('span.actor-space-node-kind', node.label),
      m('span.actor-space-node-status', nodeStatus(node)),
    ]),
    m('strong.actor-space-node-task', node.name),
    m('span.actor-space-node-activity', node.activity),
    m('span.actor-space-node-boundary', `${node.boundaryChip} · ${node.scope}`),
  ]),
]);

/**
 * @param {string} parentId
 * @param {Map<string, FabricNode[]>} children
 * @param {string} selectedId
 * @param {(node: FabricNode) => void} select
 * @param {Set<string>} ancestry
 * @returns {any}
 */
const actorBranches = (parentId, children, selectedId, select, ancestry) => {
  const rows = children.get(parentId) ?? [];
  if (rows.length === 0) return null;
  return m('ul.actor-space-branches', rows.map((node) => {
    if (ancestry.has(node.id)) return null;
    const next = new Set(ancestry);
    next.add(node.id);
    return m('li.actor-space-branch', { key: node.id }, [
      actorNode(node, selectedId, select),
      actorBranches(node.id, children, selectedId, select, next),
    ]);
  }));
};

/** @param {FabricNode} node @param {() => void} close */
const inspector = (node, close) => m('aside.actor-space-inspector', {
  id: inspectorId(node.id),
  role: 'region',
  'data-inspector-for': node.id,
  'aria-label': `Inspector for ${node.label}`,
}, [
  m('.actor-space-inspector-head', [
    m('span.actor-space-inspector-kicker', 'Boundary inspector'),
    m('button.actor-space-inspector-close', {
      type: 'button', 'aria-label': 'Close actor inspector', onclick: close,
    }, '×'),
  ]),
  m('h3', node.name),
  m('p.actor-space-inspector-kind', `${node.label} · ${nodeStatus(node)}`),
  m('dl.actor-space-inspector-facts', [
    m('div', [m('dt', 'Now'), m('dd', node.activity)]),
    m('div', [m('dt', 'Access'), m('dd', node.access)]),
    m('div', [m('dt', 'Isolation'), m('dd', node.boundary)]),
  ]),
]);

/**
 * @param {any} root
 * @param {string} selectedId
 * @param {(node: FabricNode) => void} select
 * @param {(sessionId: string) => void|Promise<void>} onOpenSession
 * @param {string|null|undefined} currentSessionId
 * @param {boolean} chatOwnedBySidePanel
 */
const orchestratorRoom = (
  root, selectedId, select, onOpenSession, currentSessionId, chatOwnedBySidePanel,
) => {
  const fabric = buildActorFabric({
    rootSession: root.session,
    actors: root.topology?.actors,
    spawned: root.topology?.spawned,
    asyncTasks: root.topology?.asyncTasks,
  });
  const rootNode = {
    ...fabric.root,
    name: 'Main context',
    activity: root.activity,
  };
  /** @type {Map<string, FabricNode[]>} */
  const children = new Map();
  for (const node of fabric.nodes) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  const selected = [rootNode, ...fabric.nodes].find((node) => node.id === selectedId) ?? null;
  const label = root.busy ? 'orchestrating' : 'actors active';
  const current = root.session.sessionId === currentSessionId;
  const destination = chatOwnedBySidePanel
    ? (current ? 'Current in side panel' : 'Show in side panel')
    : 'Open here';
  return m('article.actor-space-room', {
    key: root.session.sessionId,
    'data-root-session': root.session.sessionId,
  }, [
    m('header.actor-space-room-head', [
      m('.actor-space-room-identity', [
        m('span.peerd-spinner.actor-space-room-orb', { 'aria-hidden': 'true' }),
        m('div', [
          m('span.actor-space-room-kicker', 'Orchestrator'),
          m('h2', root.session?.title?.trim() || 'Untitled chat'),
        ]),
      ]),
      m('.actor-space-room-actions', [
        m('span.actor-space-room-state', label),
        m('button.actor-space-open-chat', {
          type: 'button',
          disabled: chatOwnedBySidePanel && current,
          onclick: () => onOpenSession(root.session.sessionId),
        }, destination),
      ]),
    ]),
    m('.actor-space-room-meta', [
      m('span', displayModel(root.session?.model)),
      m('span', fabric.activeActors === 1 ? '1 isolated actor' : `${fabric.activeActors} isolated actors`),
      m('span', 'one main context'),
    ]),
    m('p.actor-space-room-now', [m('span', 'Now'), root.activity]),
    m('.actor-space-tree', [
      m('.actor-space-root-wrap', actorNode(
        /** @type {FabricNode} */ (rootNode), selectedId, select,
      )),
      fabric.nodes.length
        ? actorBranches(rootNode.id, children, selectedId, select, new Set([rootNode.id]))
        : m('.actor-space-awaiting', 'No isolated worker has been delegated yet.'),
    ]),
    selected ? inspector(selected, () => select(selected)) : null,
  ]);
};

/**
 * @typedef {Object} ActorSpaceState
 * @property {any|null} overview
 * @property {string} error
 * @property {boolean} loading
 * @property {boolean} inFlight
 * @property {boolean} active
 * @property {string} selectedId
 * @property {string} announcement
 * @property {HTMLElement|null} root
 * @property {ReturnType<typeof setInterval>|null} timer
 * @property {(() => void)|null} onVisibility
 * @property {(manual?: boolean) => Promise<void>} load
 */

/** @param {any} overview */
const visibleNodeIds = (overview) => {
  const ids = new Set();
  for (const root of Array.isArray(overview?.roots) ? overview.roots : []) {
    const fabric = buildActorFabric({
      rootSession: root.session,
      actors: root.topology?.actors,
      spawned: root.topology?.spawned,
      asyncTasks: root.topology?.asyncTasks,
    });
    ids.add(fabric.root.id);
    for (const node of fabric.nodes) ids.add(node.id);
  }
  return ids;
};

/** @param {any} overview */
const overviewCounts = (overview) => {
  const roots = /** @type {any[]} */ (Array.isArray(overview?.roots) ? overview.roots : []);
  const actors = roots.reduce((/** @type {number} */ sum, /** @type {any} */ root) => sum + buildActorFabric({
    rootSession: root.session,
    actors: root.topology?.actors,
    spawned: root.topology?.spawned,
    asyncTasks: root.topology?.asyncTasks,
  }).activeActors, 0);
  return { roots: roots.length, actors };
};

export const ActorsSection = {
  /** @param {{ state: ActorSpaceState, attrs: {
   *   send: (msg: any) => Promise<any>,
   *   onActiveActorCount?: (count: number) => void,
   * } }} vnode */
  oninit(vnode) {
    const ui = vnode.state;
    ui.overview = null;
    ui.error = '';
    ui.loading = true;
    ui.inFlight = false;
    ui.active = true;
    ui.selectedId = '';
    ui.announcement = '';
    ui.root = null;
    ui.timer = null;
    ui.onVisibility = null;
    ui.load = async (manual = false) => {
      if (ui.inFlight) {
        if (manual) {
          ui.announcement = 'Actor activity is already refreshing.';
          m.redraw();
        }
        return;
      }
      ui.inFlight = true;
      const initial = !ui.overview;
      if (manual || initial) ui.loading = true;
      if (manual) ui.announcement = 'Refreshing actor activity.';
      if (manual) m.redraw();
      let moveFocus = false;
      try {
        const result = await vnode.attrs.send({ type: 'actors/overview' });
        if (!result?.ok) throw new Error(result?.error ?? 'overview unavailable');
        if (!ui.active) return;
        const nextIds = visibleNodeIds(result);
        const focused = document.activeElement;
        const focusedActor = focused instanceof Element
          ? focused.closest('.actor-space-node')?.getAttribute('data-actor-id') : null;
        const focusedInspector = focused instanceof Element
          ? focused.closest('.actor-space-inspector') : null;
        if ((focusedActor && !nextIds.has(focusedActor))
          || (focusedInspector && ui.selectedId && !nextIds.has(ui.selectedId))) {
          moveFocus = true;
          ui.announcement = 'Actor finished; focus moved to the monitor controls.';
        }
        if (ui.selectedId && !nextIds.has(ui.selectedId)) ui.selectedId = '';
        ui.overview = result;
        vnode.attrs.onActiveActorCount?.(overviewCounts(result).actors);
        ui.error = '';
        if (manual && !moveFocus) {
          const counts = overviewCounts(result);
          ui.announcement = `Actor activity refreshed. ${counts.roots} orchestrators and ${counts.actors} isolated actors active.`;
        }
      } catch (error) {
        if (!ui.active) return;
        ui.error = error instanceof Error ? error.message : String(error);
        if (manual) ui.announcement = 'Actor activity refresh failed.';
      } finally {
        ui.inFlight = false;
        ui.loading = false;
        if (!ui.active) return;
        // why: Actor Space can remain mounted in a background Home tab, where
        // Chrome may indefinitely defer Mithril's frame-scheduled redraw.
        m.redraw.sync();
        if (moveFocus) requestAnimationFrame(() => {
          const refresh = ui.root?.querySelector('.actor-space-refresh');
          if (refresh instanceof HTMLElement) refresh.focus();
        });
      }
    };
    void ui.load();
  },

  /** @param {{ state: ActorSpaceState, dom: Element }} vnode */
  oncreate({ state: ui, dom }) {
    ui.root = /** @type {HTMLElement} */ (dom);
    ui.timer = setInterval(() => { if (!document.hidden) void ui.load(); }, REFRESH_MS);
    ui.onVisibility = () => { if (!document.hidden) void ui.load(); };
    document.addEventListener('visibilitychange', ui.onVisibility);
  },

  /** @param {{ state: ActorSpaceState }} vnode */
  onremove({ state: ui }) {
    ui.active = false;
    if (ui.timer) clearInterval(ui.timer);
    if (ui.onVisibility) document.removeEventListener('visibilitychange', ui.onVisibility);
  },

  /**
   * @param {{ state: ActorSpaceState, attrs: {
   *   send: (msg: any) => Promise<any>,
   *   onActiveActorCount?: (count: number) => void,
   *   onOpenSession: (sessionId: string) => void|Promise<void>,
   *   currentSessionId?: string|null,
   *   chatOwnedBySidePanel?: boolean,
   * } }} vnode
   */
  view({ state: ui, attrs }) {
    const roots = /** @type {any[]} */ (Array.isArray(ui.overview?.roots) ? ui.overview.roots : []);
    const rooms = roots.map((/** @type {any} */ root) => ({
      root,
      fabric: buildActorFabric({
        rootSession: root.session,
        actors: root.topology?.actors,
        spawned: root.topology?.spawned,
        asyncTasks: root.topology?.asyncTasks,
      }),
    })).sort((a, b) => b.fabric.activeActors - a.fabric.activeActors
      || Number(b.root.busy) - Number(a.root.busy)
      || String(a.root.session?.title ?? a.root.session?.sessionId)
        .localeCompare(String(b.root.session?.title ?? b.root.session?.sessionId)));
    const fabrics = rooms.map((room) => room.fabric);
    const actorCount = fabrics.reduce((/** @type {number} */ sum, fabric) => sum + fabric.activeActors, 0);
    const boundCount = fabrics.reduce((/** @type {number} */ sum, fabric) => sum
      + fabric.nodes.filter((node) => node.variant === 'bound').length, 0);
    const select = (/** @type {FabricNode} */ node) => {
      const opening = ui.selectedId !== node.id;
      ui.selectedId = opening ? node.id : '';
      ui.announcement = opening
        ? `${node.label} details shown.` : `${node.label} details hidden.`;
      if (!opening) requestAnimationFrame(() => {
        const actor = [...(ui.root?.querySelectorAll('.actor-space-node') ?? [])]
          .find((element) => element.getAttribute('data-actor-id') === node.id);
        if (actor instanceof HTMLElement) actor.focus();
      });
    };

    return m('section.actor-space', { 'aria-labelledby': 'actor-space-title' }, [
      m('header.actor-space-hero', [
        m('.actor-space-hero-copy', [
          m('span.actor-space-eyebrow', 'Live instance map'),
          m('h1#actor-space-title', 'Actors'),
          m('p', 'Every active orchestrator and isolated worker in this peerd instance, across every chat.'),
        ]),
        m('.actor-space-summary', { 'aria-label': 'Actor totals' }, [
          m('.actor-space-stat', [m('strong', String(roots.length)),
            m('span', roots.length === 1 ? 'orchestrator' : 'orchestrators')]),
          m('.actor-space-stat', [m('strong', String(actorCount)), m('span', 'isolated actors')]),
          m('.actor-space-stat', [m('strong', String(boundCount)), m('span', 'resource-bound')]),
        ]),
      ]),
      m('.actor-space-trust-line', [
        m('span.peerd-spinner.peerd-spinner--sm', { 'aria-hidden': 'true' }),
        m('span', 'Live from peerd runtime · worker boundaries are physical, access is server-resolved'),
        m('button.actor-space-refresh', {
          type: 'button', disabled: ui.loading, onclick: () => void ui.load(true),
        }, ui.loading ? 'Refreshing…' : 'Refresh'),
      ]),
      m('p.sr-only', { 'aria-live': 'polite', 'aria-atomic': 'true' },
        ui.announcement),
      ui.error ? m('.actor-space-error', { role: 'alert' }, `Could not refresh actors: ${ui.error}`) : null,
      ui.loading && !ui.overview
        ? m('.actor-space-loading', [m('span.peerd-spinner', { 'aria-hidden': 'true' }), 'Mapping actors…'])
        : roots.length === 0
          ? m('.actor-space-empty', [
              m('span.peerd-spinner.actor-space-empty-orb', { 'aria-hidden': 'true' }),
              m('h2', 'The instance is quiet'),
              m('p', 'When any chat starts reasoning or delegates work, its orchestrator and actors will appear here.'),
            ])
          : m('.actor-space-rooms', rooms.map(({ root }) => orchestratorRoom(
              root, ui.selectedId, select, attrs.onOpenSession,
              attrs.currentSessionId, attrs.chatOwnedBySidePanel === true,
            ))),
      m('footer.actor-space-legend', [
        m('span.actor-space-legend-root', 'orchestrator · main context'),
        m('span.actor-space-legend-bound', 'solid · resource-bound actor'),
        m('span.actor-space-legend-sub', 'dashed · temporary subactor'),
        m('span', 'fenced replies travel back up'),
      ]),
    ]);
  },
};
