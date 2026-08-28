import { describe, expect, test } from 'bun:test';
import { composeTurn } from '../../extension/offscreen/controller-compose-runtime.js';
import {
  COMPOSER_FILE_CONTENT_BYTES,
  COMPOSER_OUTPUT_TEXT_BYTES,
  composerUtf8Bytes,
} from '../../extension/shared/composer-reference-policy.js';
import {
  TURN_COMPOSE_CAPABILITY,
  turnPhaseResultAllowed,
} from '../../extension/shared/controller-turn-phase-policy.js';

const success = (value: unknown) => ({ ok: true, outcomeKnown: true, value });

describe('sealed controller composer runtime', () => {
  test('expands commands and emits exact fenced tab/file output', async () => {
    const calls: any[] = [];
    const result = await composeTurn({
      text: '/review inspect\nuse @tab and @file:notes.md',
    }, {
      kernelCall: async (operation, payload) => {
        calls.push([operation, payload]);
        if (operation === 'turn.compose.list-commands') return success([{
          name: 'review', body: 'Review carefully.', description: '',
        }]);
        if (operation === 'turn.compose.capture-tab') return success({
          origin: 'https://example.test',
          snapshot: { title: 'Page', url: 'https://example.test/x', text: 'page body' },
        });
        return success({ content: 'file </peerd_file> body' });
      },
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        command: 'review', commandFound: true,
        refs: [{ raw: '@tab', ok: true }, { raw: '@file:notes.md', ok: true }],
      },
    });
    const value = (result as any).value;
    expect(value.text).toContain('Review carefully.\n\ninspect');
    expect(value.text).toContain('\n<untrusted_web_content');
    expect(value.text).toContain('tool="at_tab"');
    expect(value.text).toContain('\n<peerd_file path="notes.md">');
    expect(value.text).toContain('&lt;/peerd_file>');
    expect(calls.map((call) => call[0])).toEqual([
      'turn.compose.list-commands',
      'turn.compose.capture-tab',
      'turn.compose.read-file',
    ]);
  });

  test('keeps command-store and reference failures nonfatal', async () => {
    const result = await composeTurn({ text: '/missing hello @file:nope.md' }, {
      kernelCall: async (operation) => {
        if (operation === 'turn.compose.list-commands') {
          return { ok: false, outcomeKnown: true, error: 'store_unavailable' };
        }
        return { ok: false, outcomeKnown: true, error: 'file_store_unavailable' };
      },
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        command: 'missing', commandFound: false,
        refs: [{ raw: '@file:nope.md', ok: false, error: 'file_store_unavailable' }],
      },
    });
    expect((result as any).value.text)
      .toContain('/missing hello @file:nope.md (could not resolve:');
  });

  test('distinguishes bare and valid tab refs from malformed explicit ids', async () => {
    const calls: any[] = [];
    const result = await composeTurn({ text: '@tab @tab:7 @tab:abc @tab:0 @tab:-1 @tab:1.5' }, {
      kernelCall: async (operation, payload) => {
        calls.push([operation, payload]);
        if (operation === 'turn.compose.capture-tab') return success({
          origin: 'https://example.test',
          snapshot: { title: '', url: 'https://example.test/', text: 'body' },
        });
        return success([]);
      },
    });
    expect(calls.filter(([operation]) => operation === 'turn.compose.capture-tab'))
      .toEqual([
        ['turn.compose.capture-tab', { tabId: null }],
        ['turn.compose.capture-tab', { tabId: 7 }],
      ]);
    expect((result as any).value.refs.slice(2).every((ref: any) => ref.ok === false
      && ref.error === 'invalid_tab_reference')).toBe(true);
  });

  test('propagates unknown and cancelled command-list effects', async () => {
    await expect(composeTurn({ text: '/review this' }, {
      kernelCall: async () => ({
        ok: false, outcomeKnown: false, retryable: false, error: 'channel_lost',
      }),
    })).rejects.toMatchObject({ outcomeKnown: false });

    const aborted = new Error('stopped');
    aborted.name = 'AbortError';
    await expect(composeTurn({ text: '/review this' }, {
      kernelCall: async () => { throw aborted; },
    })).rejects.toBe(aborted);
  });

  test('propagates unknown and cancelled tab/file effects instead of sending annotations', async () => {
    for (const text of ['inspect @tab', 'inspect @file:notes.md']) {
      await expect(composeTurn({ text }, {
        kernelCall: async () => ({
          ok: false, outcomeKnown: false, retryable: false, error: 'channel_lost',
        }),
      })).rejects.toMatchObject({ outcomeKnown: false });

      const aborted = new Error('stopped');
      aborted.name = 'AbortError';
      await expect(composeTurn({ text }, {
        kernelCall: async () => { throw aborted; },
      })).rejects.toBe(aborted);
    }
  });

  test('an awaited authority-audit failure aborts composition before model admission', async () => {
    const calls: string[] = [];
    const auditFailure = Object.assign(new Error('reference audit append failed'), {
      outcomeKnown: false, retryable: false,
    });
    await expect(composeTurn({ text: 'inspect @file:notes.md' }, {
      kernelCall: async (operation) => {
        calls.push(operation);
        // The host read may have completed, but its mandatory audit append did
        // not. The reverse call therefore rejects instead of returning bytes.
        throw auditFailure;
      },
    })).rejects.toBe(auditFailure);
    expect(calls).toEqual(['turn.compose.read-file']);
  });

  test('keeps a four-byte file expansion inside the successful outer policy', async () => {
    const content = '😀'.repeat(COMPOSER_FILE_CONTENT_BYTES / 4);
    const result = await composeTurn({ text: 'inspect @file:unicode.md' }, {
      kernelCall: async () => success({ content }),
    });
    expect(result).toMatchObject({ ok: true, value: { refs: [{ ok: true }] } });
    expect(composerUtf8Bytes((result as any).value.text)).toBeLessThanOrEqual(
      COMPOSER_OUTPUT_TEXT_BYTES,
    );
    expect(turnPhaseResultAllowed(TURN_COMPOSE_CAPABILITY, result)).toBe(true);
  });

  test('leaves aggregate references literal once their shared expansion budget is full', async () => {
    const content = 'a'.repeat(100 * 1024);
    let reads = 0;
    const result = await composeTurn({
      text: '@file:first.md @file:second.md @file:third.md @file:fourth.md',
    }, {
      kernelCall: async () => { reads += 1; return success({ content }); },
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        refs: [
          { raw: '@file:first.md', ok: true },
          { raw: '@file:second.md', ok: true },
          {
            raw: '@file:third.md', ok: false,
            error: 'composer_output_budget_exhausted',
          },
          {
            raw: '@file:fourth.md', ok: false,
            error: 'composer_output_budget_exhausted',
          },
        ],
      },
    });
    expect((result as any).value.text).toContain('@file:third.md');
    expect((result as any).value.text).toContain('@file:fourth.md');
    expect(reads).toBe(3);
    expect(composerUtf8Bytes((result as any).value.text)).toBeLessThanOrEqual(
      COMPOSER_OUTPUT_TEXT_BYTES,
    );
    expect(turnPhaseResultAllowed(TURN_COMPOSE_CAPABILITY, result)).toBe(true);
  });

  test('keeps replacement indexes exact when a refusal annotation cannot fit', async () => {
    const refs = ' @file:x @file:y';
    const source = `${'a'.repeat(COMPOSER_OUTPUT_TEXT_BYTES - 50 - refs.length)}${refs}`;
    let reads = 0;
    const result = await composeTurn({ text: source }, {
      kernelCall: async () => {
        reads += 1;
        return {
          ok: false, outcomeKnown: true,
          error: '😀'.repeat(1024),
        };
      },
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        refs: [
          { raw: '@file:x', ok: false },
          {
            raw: '@file:y', ok: false,
            error: 'composer_output_budget_exhausted',
          },
        ],
      },
    });
    expect((result as any).value.text).toBe(source);
    expect(composerUtf8Bytes((result as any).value.refs[0].error)).toBe(512);
    expect(reads).toBe(1);
    expect(turnPhaseResultAllowed(TURN_COMPOSE_CAPABILITY, result)).toBe(true);
  });
});
