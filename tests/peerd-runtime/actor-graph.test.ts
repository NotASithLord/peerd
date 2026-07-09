import { describe, test, expect } from 'bun:test';
// The ACTOR GRAPH model — the pure source-of-truth assembler for the actor
// visualization (local actors + mesh peers as one radial graph).
import { buildActorGraph, actorKindColor } from '../../extension/peerd-runtime/actor/actor-graph.js';

describe('buildActorGraph', () => {
  test('always centers on the orchestrator (self) node', () => {
    const g = buildActorGraph({ selfLabel: 'main chat' });
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0]).toMatchObject({ id: 'self', kind: 'orchestrator', label: 'main chat', current: true });
  });

  test('maps actor_list rows to nodes with per-kind colors + the dwapp-actor flag', () => {
    const g = buildActorGraph({
      actors: [
        { type: 'notebook', handle: 'nb-1', name: 'analysis', live: true, current: true, detail: '' },
        { type: 'app', handle: 'app-7', name: 'Site Parser', live: false, detail: 'actor · parses HTML' },
        { type: 'app', handle: 'app-9', name: 'scratch', detail: 'todo, ui' },
      ],
    });
    const by = (id: string) => g.nodes.find((n) => n.id === id)!;
    expect(by('nb-1')).toMatchObject({ kind: 'notebook', color: 'green', live: true, isActor: false });
    expect(by('app-7')).toMatchObject({ kind: 'app', color: 'magenta', isActor: true });   // detail begins "actor"
    expect(by('app-9').isActor).toBe(false);                                                // plain app
  });

  test('a plain app merely TAGGED "actor" is not a false-positive dwapp actor', () => {
    const g = buildActorGraph({
      actors: [
        // detail is a comma-joined tag list; the middot marker "actor ·" can't occur.
        { type: 'app', handle: 'app-1', name: 'tagged', detail: 'actor, tooling' },
        // the real dwapp-actor marker (middot).
        { type: 'app', handle: 'app-2', name: 'Parser', detail: 'actor · parses HTML' },
      ],
    });
    expect(g.nodes.find((n) => n.id === 'app-1')!.isActor).toBe(false);
    expect(g.nodes.find((n) => n.id === 'app-2')!.isActor).toBe(true);
  });

  test('an explicit isActor flag wins over the detail sniff', () => {
    const g = buildActorGraph({
      actors: [{ type: 'app', handle: 'app-1', name: 'x', detail: 'anything', isActor: true }],
    });
    expect(g.nodes.find((n) => n.id === 'app-1')!.isActor).toBe(true);
  });

  test('mesh peers are REMOTE nodes bridged onto the same graph', () => {
    const g = buildActorGraph({ peers: [{ did: 'did:key:zABC123456', label: 'peer-alpha' }] });
    const peer = g.nodes.find((n) => n.kind === 'peer')!;
    expect(peer).toMatchObject({ remote: true, isActor: true, label: 'peer-alpha', color: 'magenta' });
  });

  test('edges connect real nodes; a dangling edge (dead actor) is dropped', () => {
    const g = buildActorGraph({
      actors: [{ type: 'app', handle: 'app-7', name: 'Parser', detail: 'actor' }],
      edges: [
        { to: 'app-7', live: true },          // implicit from = self
        { from: 'app-7', to: 'ghost-99' },    // dangling — dropped
      ],
    });
    expect(g.edges).toEqual([{ from: 'self', to: 'app-7', live: true }]);
  });

  test('duplicate edges collapse (live wins); self-loops dropped', () => {
    const g = buildActorGraph({
      actors: [{ type: 'notebook', handle: 'nb-1', name: 'x', detail: '' }],
      edges: [
        { from: 'self', to: 'nb-1', live: false },
        { from: 'self', to: 'nb-1', live: true },   // same edge, live → collapses to one live edge
        { from: 'self', to: 'self' },               // self-loop dropped
      ],
    });
    expect(g.edges).toEqual([{ from: 'self', to: 'nb-1', live: true }]);
  });

  test('duplicate actor handles are de-duplicated (first wins), self id never overwritten', () => {
    const g = buildActorGraph({
      actors: [
        { type: 'app', handle: 'app-1', name: 'first', detail: '' },
        { type: 'app', handle: 'app-1', name: 'second', detail: '' },
        { type: 'web', handle: 'self', name: 'imposter', detail: '' },   // cannot shadow the orchestrator
      ],
    });
    expect(g.nodes.filter((n) => n.id === 'app-1')).toHaveLength(1);
    expect(g.nodes.find((n) => n.id === 'app-1')!.label).toBe('first');
    expect(g.nodes.find((n) => n.id === 'self')!.kind).toBe('orchestrator');
  });

  test('actorKindColor falls back to the monochrome accent for an unknown kind', () => {
    expect(actorKindColor('web')).toBe('cyan');
    expect(actorKindColor('dweb')).toBe('magenta');
    expect(actorKindColor('mystery')).toBe('paper');
  });
});
