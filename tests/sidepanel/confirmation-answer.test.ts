import { describe, expect, test } from 'bun:test';
import { makeConfirmationAnswer } from '../../extension/sidepanel/confirmation-answer.js';

const prompt = {
  id: 'confirm-1', ownerSessionId: 'chat-1', sessionId: 'actor-1', dispatchId: 'tool-1',
};

const harness = ({ send, reconcile }: { send: (message: any) => Promise<any>, reconcile?: () => Promise<any> }) => {
  let state: any = { session: { sessionId: 'chat-1' }, pendingConfirm: prompt };
  let redraws = 0;
  const answer = makeConfirmationAnswer({
    send,
    reconcile: reconcile ?? (async () => ({ ok: true, state })),
    getState: () => state,
    setState: (next: any) => { state = next; },
    redraw: () => { redraws += 1; },
  });
  return {
    answer,
    setState: (next: any) => { state = next; },
    get state() { return state; },
    get redraws() { return redraws; },
  };
};

describe('confirmation answer custody', () => {
  test('clears a confirmed answer and sends it once', async () => {
    const sent: any[] = [];
    const h = harness({ send: async (message) => { sent.push(message); return { ok: true }; } });
    await h.answer(prompt, 'yes_once');
    expect(sent).toEqual([{
      type: 'confirm/answer', id: 'confirm-1', answer: 'yes_once',
      ownerSessionId: 'chat-1', sessionId: 'actor-1', dispatchId: 'tool-1',
    }]);
    expect(h.state.pendingConfirm).toBeNull();
  });

  test('reconciles a known refusal without replaying', async () => {
    let sends = 0;
    const h = harness({ send: async () => { sends += 1; return { ok: false }; } });
    await h.answer(prompt, 'no');
    expect(sends).toBe(1);
    expect(h.state.pendingConfirm).toBeNull();
  });

  test('reconciles a lost receipt without replaying', async () => {
    let sends = 0;
    let state: any = { pendingConfirm: null };
    const h = harness({
      send: async () => {
        sends += 1;
        throw Object.assign(new Error('lost'), { outcomeKnown: false });
      },
      reconcile: async () => ({ ok: true, state }),
    });
    await h.answer(prompt, 'yes_once');
    expect(sends).toBe(1);
    expect(h.state.pendingConfirm).toBeNull();
  });

  test('restores when neither answer nor authority can be confirmed', async () => {
    const h = harness({
      send: async () => { throw Object.assign(new Error('lost'), { outcomeKnown: false }); },
      reconcile: async () => { throw new Error('offline'); },
    });
    await h.answer(prompt, 'yes_once');
    expect(h.state.pendingConfirm).toBe(prompt);
  });

  test('does not overwrite a newer prompt during recovery', async () => {
    const next = { ...prompt, id: 'confirm-2' };
    const h = harness({
      send: async () => ({ ok: false }),
      reconcile: async () => ({ ok: false }),
    });
    const pending = h.answer(prompt, 'yes_once');
    h.setState({ session: { sessionId: 'chat-1' }, pendingConfirm: next });
    await pending;
    expect(h.state.pendingConfirm).toBe(next);
  });

  test('does not restore an old prompt after a session switch', async () => {
    const h = harness({
      send: async () => ({ ok: false }),
      reconcile: async () => { throw new Error('offline'); },
    });
    const pending = h.answer(prompt, 'yes_once');
    h.setState({ session: { sessionId: 'chat-2' }, pendingConfirm: null });
    await pending;
    expect(h.state.pendingConfirm).toBeNull();
  });
});
