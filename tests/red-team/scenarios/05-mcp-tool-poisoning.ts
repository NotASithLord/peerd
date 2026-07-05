// Scenario 05 — "malicious MCP server attempts tool poisoning", mapped onto
// peerd's real surface.
//
// IMPORTANT: peerd ships NO MCP client (verified: no modelcontextprotocol / mcp
// client anywhere in extension/ outside a coincidental substring in vendored
// moonshine.js). So the literal "malicious MCP server" is not a live attack
// surface. The ANALOGOUS threat — an untrusted external party injecting tool
// metadata or instructions that make the agent act on the attacker's behalf —
// lands on peerd's agent-to-agent (A2A) + inbound-mesh surface: a peer's agent
// reaches ours over the mesh, and a hostile agent-card / message is the "poisoned
// tool description" equivalent.
//
// Defenses:
//   - The sender gate (mayMessageActor): an INBOUND (untrusted, peer-originated)
//     turn can NEVER make the agent delegate — the inbound wall is absolute, and a
//     subagent spawned by an injected/inbound turn is tainted so it can't launder
//     delegation. Forged, severed, foreign-rooted, or cyclic lineages fail closed.
//   - The A2A translation core (meshCallToOp): a poisoned method name (__proto__,
//     eval) or malformed args (bad did:key, empty message, absurd timeout) throws
//     MeshApiError — the worker cannot smuggle an arbitrary op through the bridge.
//   - Signing ops (ask/send/publishCard) are flagged (meshMethodSigns) so they
//     require per-target user consent; reads do not sign as the user.
//   - A failed peer op surfaces as an error (shapeMeshResult), never a silent success.

import {
  type Scenario, type Probe, blocked, leaked, summarize,
} from '../harness.ts';
import { mayMessageActor, buildAncestry } from '../../../extension/peerd-runtime/subagent/delegation-lineage.js';
import { meshCallToOp, meshMethodSigns, shapeMeshResult } from '../../../extension/peerd-runtime/subagent/a2a-api.js';

export const scenario: Scenario = {
  id: '05-mcp-tool-poisoning',
  title: 'Tool poisoning via untrusted peer/agent (MCP analog)',
  adversary: 'malicious peer / a "poisoned" external agent',
  asset: 'the orchestrator’s delegation authority + the user’s signing identity',
  claim: 'An untrusted inbound message can never make the agent delegate, a tainted/forged/cyclic lineage fails closed, and a poisoned mesh op or malformed arg is rejected — so external tool metadata cannot hijack the agent.',
  threatModelRef: 'INV-5',
  tier: 'unit',
  mcpMapping: 'peerd has no MCP client; the untrusted-tool-metadata threat maps to the A2A/inbound-mesh surface (agent-cards + peer messages). The sender gate + mesh-op validation are the analogs of MCP tool-description sanitization.',
  async run() {
    const probes: Probe[] = [];

    // 1) The inbound wall: an untrusted peer message cannot cause delegation.
    {
      const canDelegate = mayMessageActor({
        inbound: true, senderSessionId: 'peer-msg', activeSessionId: 'chat-active',
        ancestry: [{ sessionId: 'peer-msg', parentSessionId: null, spawnedTrusted: true }],
      } as any);
      probes.push(canDelegate === false
        ? blocked('inbound peer message asks the agent to delegate/act', 'mayMessageActor = false (inbound wall is absolute)')
        : leaked('inbound peer message asks the agent to delegate/act', 'inbound turn was allowed to delegate'));
    }

    // 2) Laundering: a subagent spawned by an injected turn is tainted.
    {
      const canDelegate = mayMessageActor({
        inbound: false, senderSessionId: 'sub-inj', activeSessionId: 'chat-active',
        ancestry: [{ sessionId: 'sub-inj', parentSessionId: 'chat-active', spawnedTrusted: false }],
      } as any);
      probes.push(canDelegate === false
        ? blocked('injected-spawn subagent tries to launder delegation', 'mayMessageActor = false (one untrusted hop taints the subtree)')
        : leaked('injected-spawn subagent tries to launder delegation', 'tainted lineage was allowed'));
    }

    // 3) Forged / severed lineage fails closed (chain never reaches the active root).
    {
      // getRecord returns null for the parent → chain severed before the root.
      const ancestry = await buildAncestry({
        sessionId: 'forged', maxHops: 32,
        getRecord: async (id: string) => (id === 'forged' ? { parentSessionId: 'ghost', spawnedTrusted: true } : null),
      } as any);
      const canDelegate = mayMessageActor({ inbound: false, senderSessionId: 'forged', activeSessionId: 'chat-active', ancestry } as any);
      probes.push(canDelegate === false
        ? blocked('forge a parent chain to a non-existent trusted root', 'severed lineage → mayMessageActor = false')
        : leaked('forge a parent chain to a non-existent trusted root', 'forged chain admitted'));
    }

    // 4) Foreign root: a lineage rooted at a different chat is not a descendant.
    {
      const canDelegate = mayMessageActor({
        inbound: false, senderSessionId: 'other', activeSessionId: 'chat-active',
        ancestry: [{ sessionId: 'other', parentSessionId: 'chat-OTHER', spawnedTrusted: true }],
      } as any);
      probes.push(canDelegate === false
        ? blocked('lineage rooted at a DIFFERENT chat claims the active one', 'foreign-root → mayMessageActor = false')
        : leaked('lineage rooted at a DIFFERENT chat claims the active one', 'foreign root admitted'));
    }

    // 5) Cyclic chain must terminate and refuse (no hang).
    {
      const ancestry = await buildAncestry({
        sessionId: 'a', maxHops: 32,
        getRecord: async (id: string) => (id === 'a'
          ? { parentSessionId: 'b', spawnedTrusted: true }
          : { parentSessionId: 'a', spawnedTrusted: true }),
      } as any);
      const canDelegate = mayMessageActor({ inbound: false, senderSessionId: 'a', activeSessionId: 'chat-active', ancestry } as any);
      probes.push(canDelegate === false
        ? blocked('cyclic lineage chain (attempt to hang/confuse the walk)', `walk bounded (${ancestry.length} hops), mayMessageActor = false`)
        : leaked('cyclic lineage chain (attempt to hang/confuse the walk)', 'cyclic chain admitted'));
    }

    // 6) Missing identity fails closed.
    {
      const canDelegate = mayMessageActor({ inbound: false, senderSessionId: null, activeSessionId: 'chat-active' } as any);
      probes.push(canDelegate === false
        ? blocked('deliver a message with no sender identity', 'null senderSessionId → mayMessageActor = false')
        : leaked('deliver a message with no sender identity', 'anonymous sender admitted'));
    }

    // 7) Poisoned mesh op: a hostile method name is rejected.
    for (const method of ['__proto__', 'eval', 'constructor', 'unknownOp']) {
      let threw = false;
      try { meshCallToOp({ method, args: {} } as any); } catch { threw = true; }
      probes.push(threw
        ? blocked(`smuggle mesh op "${method}" through the a2a bridge`, 'meshCallToOp threw MeshApiError (method not in the vocabulary)')
        : leaked(`smuggle mesh op "${method}" through the a2a bridge`, 'hostile method accepted'));
    }

    // 8) Malformed A2A args fail closed.
    {
      const bads: { label: string; call: any }[] = [
        { label: 'card lookup with a bogus did:key', call: { method: 'card', args: { did: 'not-a-did' } } },
        { label: 'ask a peer with an empty message', call: { method: 'ask', args: { did: 'did:key:zBob', message: '' } } },
      ];
      for (const b of bads) {
        let threw = false;
        try { meshCallToOp(b.call); } catch { threw = true; }
        probes.push(threw
          ? blocked(b.label, 'meshCallToOp threw MeshApiError (arg validation)')
          : leaked(b.label, 'malformed args accepted'));
      }
    }

    // 9) Signing split: signing ops are flagged (→ need consent); reads are not.
    {
      const signsCorrect = meshMethodSigns('ask') && meshMethodSigns('send') && meshMethodSigns('publishCard')
        && !meshMethodSigns('peers') && !meshMethodSigns('inbox') && !meshMethodSigns('bogus');
      probes.push(signsCorrect
        ? blocked('sign-as-the-user without flagging (silent consent bypass)', 'ask/send/publishCard flagged signing; peers/inbox/unknown are not')
        : leaked('sign-as-the-user without flagging (silent consent bypass)', 'signing classification wrong'));
    }

    // 10) A failed peer op surfaces as an error, never a silent success.
    {
      let surfaced = false;
      try { shapeMeshResult('ask', { ok: false, error: 'peer refused' } as any); }
      catch { surfaced = true; }
      probes.push(surfaced
        ? blocked('a rejected peer op is dressed up as a success', 'shapeMeshResult threw on a failed op result')
        : leaked('a rejected peer op is dressed up as a success', 'failed op silently returned'));
    }

    return summarize(probes, ['sender gate (mayMessageActor inbound wall + lineage taint)', 'buildAncestry (severed/foreign/cyclic fail-closed)', 'meshCallToOp (op + arg validation)', 'meshMethodSigns (signing consent split)', 'shapeMeshResult (fail-closed)']);
  },
};
