// @ts-check
// #234 - the pacing-wait fold. A wait is per-session lifecycle state, so what
// has to hold is that it paints only the chat it belongs to, and that it clears
// on every message meaning the wait is over. A stale wait bar in a settled chat
// would tell the user peerd is idle on purpose when it is not.

import { describe, it, expect } from '../../framework.js';
import { INITIAL_STATE, reduceChat } from '/sidepanel/chat-reducer.js';

const CHAT = 'chat-1';

/** @param {object} [over] */
const base = (over = {}) => /** @type {any} */ ({
  ...INITIAL_STATE,
  session: { ...INITIAL_STATE.session, sessionId: CHAT },
  ...over,
});

/** @param {object} [over] */
const waiting = (over = {}) => reduceChat(base(), /** @type {any} */ ({
  type: 'turn/pacing-wait',
  sessionId: CHAT,
  origin: 'https://acme.test',
  untilMs: 1_700_000_005_000,
  reason: 'server-deadline',
  ...over,
}));

describe('sidepanel.chat-reducer pacing waits (#234)', () => {
  it('records the origin and the deadline the panel ticks from', () => {
    const s = waiting();
    expect(s.pacing).toEqual({
      origin: 'https://acme.test', untilMs: 1_700_000_005_000, reason: 'server-deadline',
    });
  });

  it('a wait in ANOTHER chat does not paint the chat being read', () => {
    const s = reduceChat(base(), /** @type {any} */ ({
      type: 'turn/pacing-wait', sessionId: 'chat-2',
      origin: 'https://acme.test', untilMs: 1, reason: 'server-deadline',
    }));
    expect(s.pacing).toBe(null);
  });

  it('a message with no origin is ignored rather than painting an anonymous bar', () => {
    const s = reduceChat(base(), /** @type {any} */ ({
      type: 'turn/pacing-wait', sessionId: CHAT, untilMs: 1,
    }));
    expect(s.pacing).toBe(null);
  });

  it('a non-numeric deadline degrades to zero instead of NaN in the countdown', () => {
    const s = waiting({ untilMs: 'soon' });
    expect(s.pacing?.untilMs).toBe(0);
  });

  it('a token arriving means the wait is over', () => {
    const s = reduceChat(waiting(), /** @type {any} */ ({
      type: 'turn/delta', sessionId: CHAT, text: 'hi',
    }));
    expect(s.pacing).toBe(null);
  });

  it('streaming, stop, and error all clear it', () => {
    for (const msg of [
      { type: 'turn/streaming', sessionId: CHAT, streaming: true },
      { type: 'turn/stop', sessionId: CHAT },
      { type: 'turn/error', sessionId: CHAT, error: 'boom' },
    ]) {
      expect(reduceChat(waiting(), /** @type {any} */ (msg)).pacing).toBe(null);
    }
  });

  it('a full snapshot never carries a previous chat\'s wait into the switched-to one', () => {
    const s = reduceChat(waiting(), /** @type {any} */ ({
      type: 'state', state: { session: { sessionId: 'chat-2' } },
    }));
    expect(s.pacing).toBe(null);
  });
});
