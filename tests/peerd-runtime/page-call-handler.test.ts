// The old generic page-call handler no longer exists. These tests pin the
// sealed controller's fixed route selection and result shaping: callers can
// provide page arguments, never a tool name or authority route.

import { describe, test, expect } from 'bun:test';
import {
  pageCallToToolCall,
  shapePageCallOutcome,
} from '../../extension/peerd-runtime/actor/page-api.js';

describe('page program sealed semantic translation', () => {
  test('each declared method selects one semantic tool without an SW route', () => {
    expect(pageCallToToolCall({ method: 'goto', args: { url: 'https://example.com' } }))
      .toEqual({ name: 'navigate', args: { url: 'https://example.com' } });
    expect(pageCallToToolCall({ method: 'click', args: { selector: 'button.send' } }))
      .toEqual({
        name: 'click', args: { selector: 'button.send', expectedCount: 1 },
      });
    expect(pageCallToToolCall({ method: 'fill', args: { target: '@e4', text: 'hello' } }))
      .toEqual({ name: 'type', args: { ref: '@e4', text: 'hello' } });
  });

  test('unknown methods and caller-selected routes fail before the boundary', () => {
    expect(() => pageCallToToolCall({ method: 'evaluate', args: {} }))
      .toThrow(/unknown page method/);
    expect(() => pageCallToToolCall({
      method: 'click',
      args: { route: 'page-program/navigate', tool: 'navigate' },
    })).toThrow(/target must be/);
    expect(pageCallToToolCall({
      method: 'fetch', args: { url: 'https://example.com' },
    })).toEqual({ name: 'fetch_url', args: { url: 'https://example.com' } });
  });
});

describe('page program result shaping', () => {
  test('success preserves bounded browser policy and only the newest image', () => {
    const browserPolicy = {
      reason: 'protected_child_navigation', outcome: 'not_run',
      child: 'left_blank', retryable: false,
    };
    expect(shapePageCallOutcome('view', {
      ok: true,
      content: JSON.stringify({ viewed: true }),
      structured: { browserPolicy },
      images: [
        { data: 'old', mediaType: 'image/png' },
        { data: 'new', mediaType: 'image/png' },
      ],
    })).toEqual({
      ok: true,
      value: { viewed: true },
      browserPolicies: [browserPolicy],
      images: [{ data: 'new', mediaType: 'image/png' }],
    });
  });

  test('terminal and failed outcomes retain honest custody metadata', () => {
    expect(shapePageCallOutcome('snapshot', {
      ok: false,
      error: 'auth_waiting_for_user',
      content: 'Finish signing in.',
      endTurn: true,
      outcomeKind: 'pre-effect-failure',
    }) as any).toEqual({
      ok: false,
      error: 'auth_waiting_for_user: Finish signing in.',
      endTurn: true,
      endTurnContent: 'Finish signing in.',
      endTurnOutcomeKind: 'pre-effect-failure',
    });
  });
});
