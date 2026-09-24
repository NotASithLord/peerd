import { describe, expect, test } from 'bun:test';
import { normalizeComposerCommands } from '../../extension/background/composer-command-authority.js';
import {
  COMPOSER_COMMAND_LIMIT,
  COMPOSER_COMMAND_RESULT_BYTES,
  composerReferenceRequests,
} from '../../extension/shared/composer-reference-policy.js';
import { controllerPayloadBytes } from '../../extension/shared/structured-clone-size.js';

describe('composer command host authority', () => {
  test('freezes one bounded inventory for both expansion and reference grants', () => {
    const local = Array.from({ length: COMPOSER_COMMAND_LIMIT + 1 }, (_, index) => ({
      name: `command-${String(index).padStart(3, '0')}`,
      body: index === COMPOSER_COMMAND_LIMIT ? 'inspect @file hidden.md' : `body ${index}`,
      description: '',
    }));
    const normalized = normalizeComposerCommands(local, [{
      name: 'skill-command', body: 'skill body', description: 'from a skill',
    }]);
    expect(normalized).toHaveLength(COMPOSER_COMMAND_LIMIT);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(normalized.every(Object.isFrozen)).toBe(true);
    expect(normalized.some((command) => command.name === 'command-512')).toBe(false);
    expect(composerReferenceRequests('/command-512', normalized)).toEqual([]);
    expect(controllerPayloadBytes({ ok: true, outcomeKnown: true, value: normalized }, {
      maxDepth: 24, maxNodes: 50_000,
    })).toBeLessThanOrEqual(COMPOSER_COMMAND_RESULT_BYTES);
  });

  test('rejects corrupted and oversized rows before they can grant a reference', () => {
    const commands = normalizeComposerCommands([
      { name: 'valid', body: 'read @file:allowed.md', description: '' },
      { name: 'bad-body', body: 42, description: '' },
      { name: 'bad name', body: 'read @file hidden.md', description: '' },
      { name: 'oversized', body: `read @file hidden.md ${'x'.repeat(64 * 1024)}`, description: '' },
      { name: 'bad-description', body: 'read @file hidden.md', description: 7 },
    ], []);
    expect(commands.map((command) => command.name)).toEqual(['valid']);
    expect(composerReferenceRequests('/valid', commands))
      .toEqual([{ operation: 'turn.compose.read-file', payload: { path: 'allowed.md' } }]);
    for (const name of ['bad-body', 'bad name', 'oversized', 'bad-description']) {
      expect(composerReferenceRequests(`/${name}`, commands)).toEqual([]);
    }
  });

  test('grants references only from the explicitly selected command body', () => {
    const commands = normalizeComposerCommands([
      { name: 'chosen', body: 'use @file:chosen.md', description: '' },
      { name: 'other', body: 'use @tab:44 @file:hidden.md', description: '' },
    ], []);
    expect(composerReferenceRequests('/chosen', commands)).toEqual([{
      operation: 'turn.compose.read-file', payload: { path: 'chosen.md' },
    }]);
  });
});
