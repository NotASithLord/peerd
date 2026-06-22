// Interrupted-turn detection — the read side of auto-resume
// (peerd-runtime/loop/resume-detect.js).

import { describe, test, expect } from 'bun:test';
import { detectInterruptedTurn, RESUME_NUDGE } from '../../../extension/peerd-runtime/loop/resume-detect.js';

const session = (messages: any[]) => ({ sessionId: 's', createdAt: 0, provider: 'anthropic', model: 'm', messages } as any);

describe('detectInterruptedTurn — resumable (infrastructure cut the turn off)', () => {
  test('assistant still streaming (SW died mid-stream)', () => {
    const v = detectInterruptedTurn(session([
      { role: 'user', content: 'hi', id: 'u1' },
      { role: 'assistant', content: 'partial', id: 'a1', streaming: true },
    ]));
    expect(v).toEqual({ resumable: true, reason: 'stream-interrupted', markerId: 'a1' });
  });

  test('assistant stopReason incomplete (stream closed early)', () => {
    const v = detectInterruptedTurn(session([
      { role: 'assistant', content: 'x', id: 'a1', stopReason: 'incomplete', error: 'stream ended early' },
    ]));
    expect(v).toEqual({ resumable: true, reason: 'incomplete', markerId: 'a1' });
  });

  test('an incomplete turn carries an error too — still resumable via the stream-drop marker', () => {
    const v = detectInterruptedTurn(session([
      { role: 'assistant', content: 'x', id: 'a1', stopReason: 'incomplete', error: 'stream ended early' },
    ]));
    expect(v).toEqual({ resumable: true, reason: 'incomplete', markerId: 'a1' });
  });

  test('assistant ended at tool_use with pending tools (dispatch never finished)', () => {
    const v = detectInterruptedTurn(session([
      { role: 'assistant', content: '', id: 'a1', stopReason: 'tool_use', toolUses: [{ id: 't1', name: 'x', input: {} }] },
    ]));
    expect(v).toEqual({ resumable: true, reason: 'tools-pending', markerId: 'a1' });
  });

  test('tool results persisted but the follow-up model call never started', () => {
    const v = detectInterruptedTurn(session([
      { role: 'assistant', content: '', id: 'a1', stopReason: 'tool_use', toolUses: [{ id: 't1', name: 'x', input: {} }] },
      { role: 'user', content: '', id: 'u2', toolResults: [{ tool_use_id: 't1', content: 'ok' }] },
    ]));
    expect(v).toEqual({ resumable: true, reason: 'model-call-pending', markerId: 'u2' });
  });
});

describe('detectInterruptedTurn — NOT resumable', () => {
  test('user pressed Stop (aborted) — never fight the user', () => {
    const v = detectInterruptedTurn(session([
      { role: 'assistant', content: 'partial', id: 'a1', stopReason: 'aborted' },
    ]));
    expect(v).toEqual({ resumable: false });
  });

  test('aborted wins even if the message is also flagged streaming', () => {
    const v = detectInterruptedTurn(session([
      { role: 'assistant', content: 'partial', id: 'a1', stopReason: 'aborted', streaming: true },
    ]));
    expect(v).toEqual({ resumable: false });
  });

  test('a bare error with no stream-drop marker is NOT resumed (likely a permanent 400)', () => {
    expect(detectInterruptedTurn(session([
      { role: 'assistant', content: '', id: 'a1', error: 'provider HTTP 400: messages: context too long' },
    ]))).toEqual({ resumable: false });
  });

  test('a normally-completed turn', () => {
    expect(detectInterruptedTurn(session([
      { role: 'assistant', content: 'done', id: 'a1', stopReason: 'end_turn' },
    ]))).toEqual({ resumable: false });
  });

  test('a clean max_steps stop (user continues manually)', () => {
    expect(detectInterruptedTurn(session([
      { role: 'assistant', content: 'done', id: 'a1', stopReason: 'max_steps' },
    ]))).toEqual({ resumable: false });
  });

  test('a bare trailing user message is too ambiguous to auto-drive', () => {
    expect(detectInterruptedTurn(session([
      { role: 'user', content: 'do a thing', id: 'u1' },
    ]))).toEqual({ resumable: false });
  });

  test('empty / missing session', () => {
    expect(detectInterruptedTurn(session([]))).toEqual({ resumable: false });
    expect(detectInterruptedTurn(null)).toEqual({ resumable: false });
    expect(detectInterruptedTurn(undefined)).toEqual({ resumable: false });
  });
});

test('RESUME_NUDGE frames a continuation, not a fresh instruction', () => {
  expect(RESUME_NUDGE).toMatch(/continue/i);
  expect(RESUME_NUDGE).toMatch(/not restart|do not restart/i);
});
