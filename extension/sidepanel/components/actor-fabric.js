// @ts-check
// Live Actor Fabric — one compact topology for isolated model contexts working
// under the current chat. The transcript remains the durable receipt; this view
// answers what is alive, what it can access, and which boundary is physical.

import m from '/vendor/mithril/mithril.js';
import { buildActorFabric } from './actor-fabric-model.js';

/** @typedef {import('./actor-fabric-model.js').FabricNode} FabricNode */

/** @param {number|null} cost */
const formatCost = (cost) => cost == null
  ? null
  : `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`;

/**
 * Keep every actor seen in one uninterrupted work batch for its final receipt.
 * @param {ReturnType<typeof buildActorFabric>|null} previous
 * @param {ReturnType<typeof buildActorFabric>} live
 */
const mergeReceipt = (previous, live) => {
  if (!previous) return live;
  const nodes = new Map(previous.nodes.map((node) => [node.id, node]));
  for (const node of live.nodes) {
    // Async actors first appear under a task placeholder, then hydrate to their
    // stable session id. Replace that placeholder in the receipt instead of
    // remembering both representations as two actors.
    if (node.id.startsWith('session:')) {
      for (const [id, prior] of nodes) {
        if (id.startsWith('task:')
          && prior.parentId === node.parentId
          && prior.variant === node.variant
          && prior.name === node.name) nodes.delete(id);
      }
    }
    nodes.set(node.id, node);
  }
  const ordered = [...nodes.values()].sort((a, b) => {
    if (a.variant !== b.variant) return a.variant === 'bound' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { ...live, nodes: ordered };
};

/**
 * @param {FabricNode} node
 * @param {{ selectedId: string, detailId: string, settled: boolean, select: (id: string) => void }} ui
 */
const renderNode = (node, ui) => m('button.actor-fabric-node', {
  class: `is-${node.variant}${ui.selectedId === node.id ? ' is-selected' : ''}${ui.settled ? ' is-settled' : ''}`,
  type: 'button',
  'data-node-id': node.id,
  'data-node-kind': node.variant,
  'aria-pressed': ui.selectedId === node.id ? 'true' : 'false',
  'aria-controls': ui.selectedId === node.id ? ui.detailId : undefined,
  'aria-label': `${node.label}, ${node.name}, ${ui.settled ? 'finished' : node.status}`,
  onclick: () => ui.select(node.id),
}, [
  m('.actor-fabric-node-head', [
    m('span.actor-fabric-live-dot', { 'aria-hidden': 'true' }),
    m('span.actor-fabric-kind', node.label),
    m('span.actor-fabric-status', ui.settled ? 'finished' : node.status),
  ]),
  m('.actor-fabric-name', node.name),
  m('.actor-fabric-node-meta', [
    m('span.actor-fabric-boundary-chip', node.boundaryChip),
    m('span.actor-fabric-scope', node.scope),
  ]),
]);

/**
 * @param {string} parentId
 * @param {Map<string, FabricNode[]>} children
 * @param {{ selectedId: string, detailId: string, settled: boolean, select: (id: string) => void }} ui
 * @param {Set<string>} ancestry
 * @returns {any}
 */
const renderChildren = (parentId, children, ui, ancestry) => {
  const rows = children.get(parentId) ?? [];
  if (rows.length === 0) return null;
  return m('ul.actor-fabric-branch', rows.map((node) => {
    if (ancestry.has(node.id)) return null;
    const next = new Set(ancestry);
    next.add(node.id);
    return m('li.actor-fabric-branch-item', { key: node.id }, [
      renderNode(node, ui),
      renderChildren(node.id, children, ui, next),
    ]);
  }));
};

/** @param {FabricNode} node @param {string} detailId @param {boolean} settled */
const renderDetail = (node, detailId, settled) => m('.actor-fabric-detail', {
  id: detailId, role: 'region', 'aria-label': `Details for ${node.label}`,
  // The detail is appended after a potentially deep tree. Bring it fully into
  // the fabric's own scrollport on first reveal; focus remains on the node.
  oncreate: (/** @type {{ dom: Element }} */ detailVnode) => {
    const body = /** @type {HTMLElement|null} */ (detailVnode.dom.closest('.actor-fabric-body'));
    if (!body) return;
    const detailRect = detailVnode.dom.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    if (detailRect.bottom > bodyRect.bottom) {
      body.scrollTop += detailRect.bottom - bodyRect.bottom + 1;
    } else if (detailRect.top < bodyRect.top) {
      body.scrollTop -= bodyRect.top - detailRect.top + 1;
    }
  },
}, [
  m('.actor-fabric-detail-head', [
    m('strong', `${node.label} · ${node.name}`),
    node.cost == null ? null : m('span.actor-fabric-cost', formatCost(node.cost)),
  ]),
  m('dl.actor-fabric-facts', [
    m('div', [m('dt', 'activity'), m('dd', settled ? 'Finished; the transcript below is the durable receipt.' : node.activity)]),
    m('div', [m('dt', 'access'), m('dd', node.access)]),
    m('div', [m('dt', 'boundary'), m('dd', node.boundary)]),
  ]),
]);

/**
 * @typedef {Object} ActorFabricState
 * @property {boolean} expanded
 * @property {boolean} hadLiveNodes
 * @property {boolean} settled
 * @property {string} rootSessionId
 * @property {string} selectedId
 * @property {string} announcement
 * @property {number} lastActiveActors
 * @property {ReturnType<typeof buildActorFabric>|null} lastFabric
 * @property {ReturnType<typeof setTimeout>|null} expiryTimer
 */

export const ActorFabric = {
  /** @param {{ state: ActorFabricState }} vnode */
  oninit(vnode) {
    vnode.state.expanded = true;
    vnode.state.hadLiveNodes = false;
    vnode.state.settled = false;
    vnode.state.rootSessionId = '';
    vnode.state.selectedId = '';
    vnode.state.announcement = '';
    vnode.state.lastActiveActors = 0;
    vnode.state.lastFabric = null;
    vnode.state.expiryTimer = null;
  },

  /** @param {{ state: ActorFabricState }} vnode */
  onremove({ state: ui }) {
    if (ui.expiryTimer) clearTimeout(ui.expiryTimer);
  },

  /**
   * @param {{ dom?: Element, state: ActorFabricState, attrs: {
   *   session?: any, actors?: Record<string, any>,
   *   spawned?: { sessions?: Record<string, any> },
   *   asyncTasks?: Record<string, any>,
   * } }} vnode
   */
  view: (vnode) => {
    const { state: ui, attrs } = vnode;
    const rootSessionId = String(attrs.session?.sessionId ?? '');
    if (ui.rootSessionId !== rootSessionId) {
      if (ui.expiryTimer) clearTimeout(ui.expiryTimer);
      ui.rootSessionId = rootSessionId;
      ui.expanded = true;
      ui.hadLiveNodes = false;
      ui.settled = false;
      ui.selectedId = '';
      ui.announcement = '';
      ui.lastActiveActors = 0;
      ui.lastFabric = null;
      ui.expiryTimer = null;
    }
    const liveFabric = buildActorFabric({
      rootSession: attrs.session,
      actors: attrs.actors,
      spawned: attrs.spawned,
      asyncTasks: attrs.asyncTasks,
    });

    if (liveFabric.activeActors > 0) {
      if (ui.expiryTimer) { clearTimeout(ui.expiryTimer); ui.expiryTimer = null; }
      const startingBatch = !ui.hadLiveNodes || ui.settled;
      if (startingBatch) {
        ui.expanded = true;
        ui.selectedId = '';
      }
      ui.hadLiveNodes = true;
      ui.settled = false;
      ui.lastFabric = startingBatch ? liveFabric : mergeReceipt(ui.lastFabric, liveFabric);
      if (ui.lastActiveActors !== liveFabric.activeActors) {
        ui.announcement = liveFabric.activeActors === 1
          ? '1 isolated actor working.' : `${liveFabric.activeActors} isolated actors working.`;
      }
      ui.lastActiveActors = liveFabric.activeActors;
    } else if (ui.lastFabric && !ui.settled) {
      // Keep a truthful completion receipt long enough to find and read. Focus
      // or hover pauses expiry so magnifier, keyboard, and pointer users decide
      // when they are done with it instead of racing a timer.
      ui.settled = true;
      ui.lastActiveActors = 0;
      ui.announcement = 'All isolated actor work finished.';
      const expire = () => {
        const active = typeof document === 'undefined' ? null : document.activeElement;
        const panel = active?.closest?.('.actor-fabric')
          ?? (typeof document === 'undefined' ? null : document.querySelector('.actor-fabric'));
        if (active?.closest?.('.actor-fabric') || panel?.matches?.(':hover')) {
          ui.expiryTimer = setTimeout(expire, 500);
          return;
        }
        ui.lastFabric = null;
        ui.hadLiveNodes = false;
        ui.settled = false;
        ui.expiryTimer = null;
        m.redraw();
      };
      ui.expiryTimer = setTimeout(expire, 8_000);
    }

    const fabric = liveFabric.activeActors > 0 ? liveFabric : ui.lastFabric;
    const announcer = m('span.actor-fabric-announcer.sr-only', {
      'aria-live': 'polite', 'aria-atomic': 'true',
    }, ui.announcement);
    if (!fabric) return announcer;

    const allNodes = [fabric.root, ...fabric.nodes];
    if (!allNodes.some((node) => node.id === ui.selectedId)) ui.selectedId = '';
    const selected = allNodes.find((node) => node.id === ui.selectedId) ?? null;
    /** @type {Map<string, FabricNode[]>} */
    const children = new Map();
    for (const node of fabric.nodes) {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
    const select = (/** @type {string} */ id) => {
      const next = ui.selectedId === id ? null : allNodes.find((node) => node.id === id);
      ui.selectedId = next?.id ?? '';
      ui.announcement = next
        ? `${next.label} details shown. Access: ${next.access}. Boundary: ${next.boundary}`
        : 'Actor details hidden.';
    };
    const bodyId = `actor-fabric-${String(attrs.session?.sessionId ?? 'chat')}`;
    const detailId = `${bodyId}-detail`;
    const nodeUi = {
      selectedId: ui.selectedId, detailId, settled: ui.settled, select,
    };

    const panel = m('section.actor-fabric', {
      class: ui.settled ? 'is-settled' : '', 'aria-label': 'Actor fabric',
    }, [
      m('button.actor-fabric-toggle', {
        type: 'button',
        'aria-expanded': ui.expanded ? 'true' : 'false',
        'aria-controls': bodyId,
        onclick: () => { ui.expanded = !ui.expanded; },
      }, [
        ui.settled ? m('span.actor-fabric-finished-mark', { 'aria-hidden': 'true' }, '✓')
          : m('span.peerd-spinner.peerd-spinner--sm', { 'aria-hidden': 'true' }),
        m('strong.actor-fabric-title', 'Actor fabric'),
        m('span.actor-fabric-working', ui.settled
          ? 'all actor work finished'
          : fabric.activeActors === 1
            ? '1 isolated actor working'
            : `${fabric.activeActors} isolated actors working`),
        m('span.spacer'),
        m('span.actor-fabric-disclosure', { 'aria-hidden': 'true' }, ui.expanded ? '▼' : '▶'),
      ]),
      ui.expanded ? m('.actor-fabric-body', { id: bodyId }, [
        renderNode(fabric.root, nodeUi),
        m('.actor-fabric-edge-legend', [
          m('span', 'task ↓'),
          m('span.actor-fabric-edge-line', { 'aria-hidden': 'true' }),
          m('span', 'fenced reply ↑'),
        ]),
        renderChildren(fabric.root.id, children, nodeUi, new Set([fabric.root.id])),
        selected ? renderDetail(selected, detailId, ui.settled) : null,
        m('.actor-fabric-legend', [
          m('span.actor-fabric-legend-bound', 'child: solid · resource-bound'),
          m('span.actor-fabric-legend-sub', 'child: dashed · temporary'),
        ]),
      ]) : null,
    ]);
    return [announcer, panel];
  },
};
