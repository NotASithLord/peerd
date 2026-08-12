// @ts-check
// §4e - the confirm settle fold. A prompt that ends without this surface's
// click must leave a transcript line; the surface that answered must NOT
// line its own click; and a snapshot replay must never double-report or
// reorder what a live broadcast already recorded.

import { describe, it, expect } from '../../framework.js';
import { INITIAL_STATE, reduceChat } from '/sidepanel/chat-reducer.js';

/** @param {object} [extra] */
const withPrompt = (extra = {}) => reduceChat(
  /** @type {any} */ ({ ...INITIAL_STATE, session: { ...INITIAL_STATE.session, sessionId: 'chat-1' } }),
  /** @type {any} */ ({ type: 'confirm/request', prompt: { id: 'p1', tool: 'click', ...extra } }),
);

/** @param {any} state @param {any} msg */
const fold = (state, msg) => reduceChat(state, msg);

describe('sidepanel.chat-reducer confirm settles (§4e)', () => {
  it('a timeout settle dismisses the modal and records the fixed line', () => {
    const s = fold(withPrompt(), {
      type: 'confirm/resolved', id: 'p1',
      outcome: { answer: 'no', cause: 'timeout', via: null, sessionId: 'chat-1' },
    });
    expect(s.pendingConfirm).toBe(null);
    expect(s.confirmEvents.length).toBe(1);
    expect(s.confirmEvents[0].text).toBe('Not approved - no answer in two minutes.');
    expect(s.confirmEvents[0].sessionId).toBe('chat-1');
  });

  it('a Stop settle and an abort settle share the you-stopped line', () => {
    for (const cause of ['stop', 'abort']) {
      const s = fold(withPrompt(), {
        type: 'confirm/resolved', id: 'p1',
        outcome: { answer: 'no', cause, via: null, sessionId: 'chat-1' },
      });
      expect(s.confirmEvents[0].text).toBe('Not approved - you stopped the turn.');
    }
  });

  it('an answer from the OTHER surface says which way it went and where from', () => {
    const s = fold(withPrompt(), {
      type: 'confirm/resolved', id: 'p1', confirmSurface: 'sidepanel',
      outcome: { answer: 'yes_once', cause: 'answer', via: 'home', sessionId: 'chat-1' },
    });
    expect(s.pendingConfirm).toBe(null);
    expect(s.confirmEvents[0].text).toBe('Approved once, from the home tab.');
  });

  it('the answering surface never lines its own click', () => {
    const s = fold(withPrompt(), {
      type: 'confirm/resolved', id: 'p1', confirmSurface: 'home',
      outcome: { answer: 'yes_once', cause: 'answer', via: 'home', sessionId: 'chat-1' },
    });
    expect(s.pendingConfirm).toBe(null);
    expect(s.confirmEvents.length).toBe(0);
  });

  it('a settle for an UNDISPLAYED prompt still records its line', () => {
    // Two prompts pending SW-side; this surface displays p2 when p1 times out.
    const displayingP2 = fold(withPrompt(), /** @type {any} */ ({
      type: 'confirm/request', prompt: { id: 'p2', tool: 'click' },
    }));
    const s = fold(displayingP2, {
      type: 'confirm/resolved', id: 'p1',
      outcome: { answer: 'no', cause: 'timeout', via: null, sessionId: 'chat-1' },
    });
    expect(s.pendingConfirm?.id).toBe('p2');   // p2 stays up
    expect(s.confirmEvents[0].text).toBe('Not approved - no answer in two minutes.');
  });

  it('snapshot notes fold in, dedupe by id, and keep time order', () => {
    const live = fold(withPrompt(), {
      type: 'confirm/resolved', id: 'p1',
      outcome: { answer: 'no', cause: 'timeout', via: null, sessionId: 'chat-1' },
    });
    const s = fold(live, {
      type: 'state',
      state: {
        session: { sessionId: 'chat-1', messages: [] },
        confirmSettleNotes: [
          // p1 again (already recorded live - must not duplicate) plus an
          // OLDER unreachable settle that must sort BEFORE the live line.
          { id: 'p1', answer: 'no', cause: 'timeout', via: null, at: Date.now() + 1 },
          { id: 'p0', answer: 'no', cause: 'unreachable', via: null, at: 1 },
        ],
      },
    });
    expect(s.confirmEvents.length).toBe(2);
    expect(s.confirmEvents[0].id).toBe('p0');  // time-ordered, not append-ordered
    expect(s.confirmEvents[0].text).toBe('Not approved - peerd wasn’t open to ask.');
    expect(s.confirmEvents[1].id).toBe('p1');
  });
});
