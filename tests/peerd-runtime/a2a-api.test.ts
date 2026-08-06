// The pure mesh translation core — the page-api.js twin for agent-to-agent.
// Maps a `mesh.<method>(args)` call to a gated mesh op + shapes the reply,
// browserless. Pins: the method table, arg validation (fail-closed), the
// call/cast signing split, and result shaping (a failed op rejects like a throw).

import { describe, test, expect } from 'bun:test';
import {
  meshCallToOp, shapeMeshResult, meshMethodSigns,
  MESH_API_METHODS, MESH_SIGNING_METHODS, MeshApiError,
} from '../../extension/peerd-runtime/actor/a2a-api.js';

const DID = 'did:key:z6MkexampleAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('meshCallToOp — mapping + validation', () => {
  test('the method surface is exactly the client vocabulary', () => {
    expect([...MESH_API_METHODS].sort()).toEqual(['call', 'card', 'cast', 'converse', 'inbox', 'peers', 'publishCard', 'say'].sort());
  });

  test('peers/inbox take no args', () => {
    expect(meshCallToOp({ method: 'peers' })).toEqual({ op: 'peers', args: {}, signs: false });
    expect(meshCallToOp({ method: 'inbox' })).toEqual({ op: 'inbox', args: {}, signs: false });
  });

  test('card validates the did:key', () => {
    expect(meshCallToOp({ method: 'card', args: { did: DID } })).toEqual({ op: 'card', args: { did: DID }, signs: false });
    expect(() => meshCallToOp({ method: 'card', args: { did: 'nope' } })).toThrow(MeshApiError);
  });

  test('call validates did + message, clamps timeout, and is a SIGNING op', () => {
    const out = meshCallToOp({ method: 'call', args: { did: DID, message: 'free Tuesday?', timeoutMs: 999_999 } });
    expect(out.op).toBe('ask');
    expect(out.signs).toBe(true);
    expect(out.args).toEqual({ did: DID, message: 'free Tuesday?', timeoutMs: 120_000 });   // clamped
    expect(() => meshCallToOp({ method: 'call', args: { did: DID, message: '' } })).toThrow(MeshApiError);
    expect(() => meshCallToOp({ method: 'call', args: { did: 'x', message: 'hi' } })).toThrow(MeshApiError);
  });

  test('cast is signing; publishCard requires a named card object', () => {
    expect(meshMethodSigns('cast')).toBe(true);
    expect(meshMethodSigns('peers')).toBe(false);
    expect(() => meshCallToOp({ method: 'publishCard', args: { card: {} } })).toThrow(MeshApiError);
    expect(meshCallToOp({ method: 'publishCard', args: { card: { name: 'Ada' } } }).signs).toBe(true);
  });

  test('the canonical signing set uses call/cast vocabulary', () => {
    expect([...MESH_SIGNING_METHODS].sort()).toEqual(['call', 'cast', 'converse', 'publishCard', 'say'].sort());
  });

  test('an unknown method throws', () => {
    expect(() => meshCallToOp({ method: 'sudo' })).toThrow(MeshApiError);
  });
});

describe('shapeMeshResult — reply shaping', () => {
  test('call shapes { from, reply } and rejects timeout; ask alias preserves 0.x shape', () => {
    expect(shapeMeshResult('call', { ok: true, from: DID, reply: 'yes' })).toEqual({ from: DID, reply: 'yes' });
    expect(() => shapeMeshResult('call', { ok: true, from: null, reply: null, timedOut: true })).toThrow(/timed out/);
    expect(shapeMeshResult('ask', { ok: true, from: null, reply: null, timedOut: true })).toEqual({ from: null, reply: null, timedOut: true });
  });

  test('a failed op REJECTS like a throw (so await mesh.call() throws)', () => {
    expect(() => shapeMeshResult('call', { ok: false, error: 'no direct link to did' })).toThrow(MeshApiError);
    expect(() => shapeMeshResult('cast', { ok: false })).toThrow(MeshApiError);
  });

  test('peers reads the named roster; card reads the named card (null when absent)', () => {
    expect(shapeMeshResult('peers', { ok: true, peers: [] })).toEqual([]);
    expect(shapeMeshResult('peers', { ok: true, peers: [{ did: DID, name: 'Ada' }] })).toEqual([{ did: DID, name: 'Ada' }]);
    expect(shapeMeshResult('card', { ok: true, card: null })).toBe(null);
    expect(shapeMeshResult('card', { ok: true, card: { name: 'Ada' } })).toEqual({ name: 'Ada' });
    expect(shapeMeshResult('inbox', { ok: true, messages: [{ from: DID, message: 'hi', ts: 1 }] })).toEqual([{ from: DID, message: 'hi', ts: 1 }]);
  });
});

describe('converse / say — standing-conversation verbs', () => {
  test('converse validates did + message and is a signing op', () => {
    const out = meshCallToOp({ method: 'converse', args: { did: DID, message: 'collab?' } });
    expect(out).toEqual({ op: 'converse', args: { did: DID, message: 'collab?' }, signs: true });
    expect(() => meshCallToOp({ method: 'converse', args: { did: 'x', message: 'hi' } })).toThrow(MeshApiError);
    expect(() => meshCallToOp({ method: 'converse', args: { did: DID, message: '' } })).toThrow(MeshApiError);
  });
  test('say validates convId + message and is a signing op', () => {
    const out = meshCallToOp({ method: 'say', args: { convId: 'CV1', message: 'next?' } });
    expect(out).toEqual({ op: 'say', args: { convId: 'CV1', message: 'next?' }, signs: true });
    expect(() => meshCallToOp({ method: 'say', args: { convId: '', message: 'hi' } })).toThrow(MeshApiError);
  });
})
