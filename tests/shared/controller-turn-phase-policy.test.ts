import { describe, expect, test } from 'bun:test';
import {
  TURN_COMPOSE_CAPABILITY,
  TURN_PHASE_CAPABILITIES,
  createTurnPhaseQuota,
  turnPhaseAuthorityFor,
  turnPhasePayloadAllowed,
  turnPhaseResultAllowed,
} from '../../extension/shared/controller-turn-phase-policy.js';
import {
  COMPOSER_FILE_CONTENT_BYTES,
  COMPOSER_INPUT_TEXT_BYTES,
  COMPOSER_OUTPUT_TEXT_BYTES,
} from '../../extension/shared/composer-reference-policy.js';

const success = (value: unknown) => ({ ok: true, outcomeKnown: true, value });

describe('closed controller turn phase policy', () => {
  test('publishes one named capability and refuses unknown or malformed payloads', () => {
    expect(TURN_PHASE_CAPABILITIES).toEqual([TURN_COMPOSE_CAPABILITY]);
    expect(turnPhasePayloadAllowed(TURN_COMPOSE_CAPABILITY, { text: 'hello' })).toBe(true);
    expect(turnPhaseAuthorityFor(TURN_COMPOSE_CAPABILITY, { text: 'hello' }))
      .toMatchObject({ target: 'turn-compose', replayClass: 'A' });
    for (const value of [{}, { text: '' }, { text: 'x', extra: true }]) {
      expect(turnPhasePayloadAllowed(TURN_COMPOSE_CAPABILITY, value)).toBe(false);
    }
    expect(turnPhaseAuthorityFor('turn.unknown', { text: 'hello' })).toBeNull();
  });

  test('applies input and output limits to UTF-8 bytes, not UTF-16 characters', () => {
    for (const text of [
      'a'.repeat(COMPOSER_INPUT_TEXT_BYTES),
      '😀'.repeat(COMPOSER_INPUT_TEXT_BYTES / 4),
    ]) expect(turnPhasePayloadAllowed(TURN_COMPOSE_CAPABILITY, { text })).toBe(true);
    for (const text of [
      'a'.repeat(COMPOSER_INPUT_TEXT_BYTES + 1),
      '😀'.repeat(COMPOSER_INPUT_TEXT_BYTES / 4 + 1),
    ]) expect(turnPhasePayloadAllowed(TURN_COMPOSE_CAPABILITY, { text })).toBe(false);

    for (const text of [
      'a'.repeat(COMPOSER_OUTPUT_TEXT_BYTES),
      '😀'.repeat(COMPOSER_OUTPUT_TEXT_BYTES / 4),
    ]) expect(turnPhaseResultAllowed(TURN_COMPOSE_CAPABILITY, success({
      text, command: null, commandFound: false, refs: [],
    }))).toBe(true);
    for (const text of [
      'a'.repeat(COMPOSER_OUTPUT_TEXT_BYTES + 1),
      '😀'.repeat(COMPOSER_OUTPUT_TEXT_BYTES / 4 + 1),
    ]) expect(turnPhaseResultAllowed(TURN_COMPOSE_CAPABILITY, success({
      text, command: null, commandFound: false, refs: [],
    }))).toBe(false);
  });

  test('admits only the three exact effect schemas', () => {
    const quota = createTurnPhaseQuota(TURN_COMPOSE_CAPABILITY, { text: 'hello' });
    expect(quota.admit('turn.compose.list-commands', {})).toMatchObject({ ok: true });
    expect(quota.admit('turn.compose.capture-tab', { tabId: null })).toMatchObject({ ok: true });
    expect(quota.admit('turn.compose.capture-tab', { tabId: 7 })).toMatchObject({ ok: true });
    expect(quota.admit('turn.compose.read-file', { path: 'notes.md' })).toMatchObject({ ok: true });
    for (const [operation, payload] of [
      ['turn.compose.tab-get', { tabId: 7 }],
      ['turn.compose.capture-tab', { tabId: '7' }],
      ['turn.compose.capture-tab', { tabId: null, documentIds: ['forged'] }],
      ['turn.compose.read-file', { path: 'notes.md', sessionId: 'forged' }],
      ['turn.compose.unknown', {}],
    ] as const) expect(quota.admit(operation, payload)).toMatchObject({ ok: false });
  });

  test('shares one aggregate reference budget across tab and file reads', () => {
    const quota = createTurnPhaseQuota(TURN_COMPOSE_CAPABILITY, { text: 'hello' });
    for (let index = 0; index < 32; index += 1) {
      expect(quota.admit('turn.compose.capture-tab', { tabId: index + 1 }))
        .toMatchObject({ ok: true });
      expect(quota.admit('turn.compose.read-file', { path: `file-${index}.md` }))
        .toMatchObject({ ok: true });
    }
    expect(quota.admit('turn.compose.capture-tab', { tabId: 99 }))
      .toMatchObject({ ok: false, code: 'kernel-operation-budget-exhausted' });
    expect(quota.admit('turn.compose.read-file', { path: 'extra.md' }))
      .toMatchObject({ ok: false, code: 'kernel-operation-budget-exhausted' });
  });

  test('rejects malformed effect and outer results instead of trusting bounded objects', () => {
    const quota = createTurnPhaseQuota(TURN_COMPOSE_CAPABILITY, { text: 'hello' });
    expect(quota.observe('turn.compose.list-commands', {}, success([{
      name: 'review', body: 'Review it', description: '',
    }]))).toMatchObject({ ok: true });
    expect(quota.observe('turn.compose.capture-tab', { tabId: null }, success({
      origin: 'https://example.test',
      snapshot: { title: 'Page', url: 'https://example.test/', text: 'body' },
    }))).toMatchObject({ ok: true });
    expect(quota.observe('turn.compose.read-file', { path: 'notes.md' }, success({
      content: 'body',
    }))).toMatchObject({ ok: true });
    for (const malformed of [{}, undefined, success({}), success([{ name: 'x' }])]) {
      expect(quota.observe('turn.compose.list-commands', {}, malformed))
        .toMatchObject({
          ok: false, code: 'kernel-operation-result-invalid', outcomeKnown: false,
        });
    }

    const valid = success({
      text: 'hello', command: null, commandFound: false, refs: [],
    });
    expect(turnPhaseResultAllowed(TURN_COMPOSE_CAPABILITY, valid)).toBe(true);
    expect(turnPhaseResultAllowed(TURN_COMPOSE_CAPABILITY, success({ text: 'hello' })))
      .toBe(false);
    expect(turnPhaseResultAllowed(TURN_COMPOSE_CAPABILITY, {})).toBe(false);
  });

  test('keeps a file reference result inside the reverse-effect byte envelope', () => {
    for (const content of [
      'a'.repeat(COMPOSER_FILE_CONTENT_BYTES),
      '😀'.repeat(COMPOSER_FILE_CONTENT_BYTES / 4),
    ]) {
      const quota = createTurnPhaseQuota(TURN_COMPOSE_CAPABILITY, { text: '@file:notes.md' });
      expect(quota.observe('turn.compose.read-file', { path: 'notes.md' }, success({ content })))
        .toMatchObject({ ok: true });
    }
    const quota = createTurnPhaseQuota(TURN_COMPOSE_CAPABILITY, { text: '@file:notes.md' });
    expect(quota.observe('turn.compose.read-file', { path: 'notes.md' }, success({
      content: `${'😀'.repeat(COMPOSER_FILE_CONTENT_BYTES / 4)}😀`,
    }))).toMatchObject({
      ok: false, code: 'kernel-operation-result-invalid', outcomeKnown: false,
    });
  });
});
