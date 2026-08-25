import { describe, expect, test } from 'bun:test';
import { createKernelDwebAgentOwner } from '../../extension/background/kernel-dweb-agent-owner.js';
import { createConversationRegistry } from '../../extension/peerd-runtime/actor/conversation-registry.js';

const waitFor = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 50 && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(check()).toBe(true);
};

const setup = (over: Record<string, any> = {}) => {
  const audits: any[] = [];
  const sent: any[] = [];
  const actorTurns: any[] = [];
  const parentTurns: any[] = [];
  const replies: any[] = [];
  const releases: string[] = [];
  const conversations = createConversationRegistry({ newConvId: () => 'local-conversation' });
  const generations = new Map<string, number>();
  const offscreen = {};
  const deps = {
    active: () => true,
    isLocked: () => false,
    appendAudit: async (event: any) => { audits.push(event); },
    meshDispatch: {
      handleInbound: (_did: string, data: any) => ({
        consumed: false,
        deliver: data?.deliver ?? null,
      }),
      reply: async (...args: any[]) => { replies.push(args); return { ok: true }; },
    },
    conversations,
    approvedDids: new Set(['did:peer']),
    persistApproved: async () => {},
    isolationReady: async () => {},
    isolationAvailable: () => true,
    runWhenRecoveryReady: async (_key: string, operation: () => any) => operation(),
    resolveActor: async () => ({ actorSessionId: 'dweb-actor' }),
    sessions: { get: async () => ({ messages: [] }) },
    runActorTurn: async (request: any) => {
      actorTurns.push(request);
      return { result: 'peer reply', turnSnapshot: { messages: [] } };
    },
    turnSlots: {
      runWhenIdleClaimed: (sessionId: string, operation: (lease: any) => any) =>
        operation({ release: () => { releases.push(sessionId); } }),
      generation: (sessionId: string) => generations.get(sessionId) ?? 0,
    },
    currentSessionId: async () => 'active-chat',
    runAgentTurn: async (request: any) => { parentTurns.push(request); },
    wrapUntrusted: ({ origin, tool, body }: any) => `<${origin}:${tool}>${body}</${tool}>`,
    finalAssistantText: () => '',
    confirmReply: async () => true,
    withPublication: async (operation: (current: () => boolean) => any) => operation(() => true),
    ensureFeature: async () => {},
    sendMessage: async (message: any) => { sent.push(message); return { ok: true }; },
    isOffscreenSender: (sender: any) => sender === offscreen,
    ...over,
  };
  return {
    owner: createKernelDwebAgentOwner(deps), deps, offscreen,
    audits, sent, actorTurns, parentTurns, replies, releases, conversations,
  };
};

describe('kernel dweb agent owner', () => {
  test('owns exact inbound provenance and replies only from the isolated inbound turn', async () => {
    const state = setup();
    expect(state.owner.onMessage({
      type: 'dweb/base-room/event', roomId: 'peerd-agent', event: 'direct',
      data: {
        from: 'did:peer',
        data: { deliver: { kind: 'ask', convId: 'conversation-1', reqId: 'request-1', message: 'hello' } },
      },
    }, {})).toBe(false);
    expect(state.actorTurns).toHaveLength(0);

    state.owner.onMessage({
      type: 'dweb/base-room/event', roomId: 'peerd-agent', event: 'direct',
      data: {
        from: 'did:peer',
        data: { deliver: { kind: 'ask', convId: 'conversation-1', reqId: 'request-1', message: 'hello' } },
      },
    }, state.offscreen);
    await waitFor(() => state.replies.length === 1);

    expect(state.actorTurns[0]).toMatchObject({
      actorSessionId: 'dweb-actor', instanceId: 'dweb', kind: 'dweb', inbound: true,
    });
    expect(state.actorTurns[0].message).toContain('<did:peer:mesh_inbound>');
    expect(state.replies[0]).toEqual([
      'did:peer', 'request-1', 'peer reply', 'conversation-1',
    ]);
    expect(state.conversations.turnsFor('conversation-1').map((turn) => turn.role))
      .toEqual(['peer', 'self']);
    expect(state.parentTurns).toHaveLength(0);
  });

  test('revocation wins after reply consent and closes the conversation', async () => {
    let releaseConsent!: (value: boolean) => void;
    const consent = new Promise<boolean>((resolve) => { releaseConsent = resolve; });
    let consentStarted = false;
    let persisted = 0;
    const state = setup({
      confirmReply: async () => { consentStarted = true; return consent; },
      persistApproved: async () => { persisted += 1; },
    });
    state.owner.handleInbound({
      from: 'did:peer',
      data: { deliver: { kind: 'ask', convId: 'conversation-2', reqId: 'request-2', message: 'hello' } },
    });
    await waitFor(() => consentStarted);
    await state.owner.revokePeer('did:peer');
    releaseConsent(true);
    await waitFor(() => state.releases.length > 0);

    expect(state.replies).toHaveLength(0);
    expect(state.conversations.ownedBy('conversation-2', 'did:peer')).toBe(false);
    expect(persisted).toBe(1);
  });

  test('trickles notable unthreaded activity without stealing a live turn', async () => {
    const state = setup();
    state.owner.handleInbound({ from: 'did:peer', data: 'notice' });
    await waitFor(() => state.parentTurns.length === 1);

    expect(state.parentTurns[0]).toMatchObject({
      sessionId: 'active-chat', synthetic: true, trusted: false,
      actorReply: { kind: 'dweb', instanceId: 'dweb', failed: false },
    });
    expect(state.parentTurns[0].userText).toContain('<dweb:message_actor>peer reply');
  });

  test('rate caps before actor work and keeps inbox membership idempotent', async () => {
    const state = setup({ rateCap: { allow: () => false } });
    state.owner.handleInbound({ from: 'did:flood', data: 'x' });
    await waitFor(() => state.audits.some((event) => event.type === 'dweb_agent_rate_capped'));
    expect(state.actorTurns).toHaveLength(0);

    await state.owner.syncRoom();
    await state.owner.syncRoom();
    expect(state.sent.filter((message) => message.op === 'join')).toHaveLength(1);
    state.deps.active = () => false;
    await state.owner.syncRoom();
    expect(state.sent.filter((message) => message.op === 'leave')).toHaveLength(1);
    state.owner.roomStopped();
    expect(state.owner.roomJoined()).toBe(false);
  });

  test('rejects incomplete assembly', () => {
    expect(() => createKernelDwebAgentOwner({})).toThrow(
      'kernel-dweb-agent-config-invalid',
    );
  });
});
