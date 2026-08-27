// The old generic page-call handler no longer exists. These tests pin the
// sealed controller's fixed route selection and result shaping: callers can
// provide page arguments, never a tool name or authority route.

import { describe, test, expect } from 'bun:test';
import {
  pageCallToRelay,
  shapePageCallOutcome,
} from '../../extension/peerd-runtime/actor/page-api.js';

describe('page program exact routes', () => {
  test('each semantic method selects a fixed authority route', () => {
    expect(pageCallToRelay({ method: 'goto', args: { url: 'https://example.com' } }))
      .toEqual({
        route: 'page-program/navigate',
        args: { url: 'https://example.com' },
      });
    expect(pageCallToRelay({ method: 'click', args: { selector: 'button.send' } }))
      .toEqual({
        route: 'page-program/click',
        args: { selector: 'button.send', expectedCount: 1 },
      });
    expect(pageCallToRelay({ method: 'fill', args: { target: '@e4', text: 'hello' } }))
      .toEqual({
        route: 'page-program/fill',
        args: { ref: '@e4', text: 'hello' },
      });
  });

  test('unknown methods and caller-selected routes fail before the boundary', () => {
    expect(() => pageCallToRelay({ method: 'evaluate', args: {} }))
      .toThrow(/unknown page method/);
    expect(() => pageCallToRelay({
      method: 'click',
      args: { route: 'page-program/navigate', tool: 'navigate' },
    })).toThrow(/target must be/);
    expect(() => pageCallToRelay({
      method: 'fetch', args: { url: 'https://example.com' },
    })).toThrow(/no fixed authority route/);
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
