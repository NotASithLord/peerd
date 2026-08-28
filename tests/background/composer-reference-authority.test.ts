import { describe, expect, test } from 'bun:test';
import {
  composerReferenceAuditEntry,
  createComposerReferenceAuthority,
} from '../../extension/background/composer-reference-authority.js';
import {
  AppBinaryFileError,
  AppDefaultMissingError,
  AppFileContentError,
} from '../../extension/background/app-client.js';
import {
  COMPOSER_FILE_CONTENT_BYTES,
  composerUtf8Bytes,
} from '../../extension/shared/composer-reference-policy.js';
import { browserProbeResult, TEST_DOCUMENT_ID } from '../helpers/browser-scripting.ts';

const context = (over: any = {}) => {
  let activeId = 3;
  const calls: any[] = [];
  const reads: any[] = [];
  const tabCalls: any[] = [];
  const urlFor = (id: number) => over.urls?.[id] ?? `https://tab-${id}.example/path`;
  const ctx: any = {
    activeTab: over.withoutActive ? null : { id: activeId, url: urlFor(activeId) },
    denylist: over.denylist ?? [],
    tabs: {
      get: async (id: number) => {
        tabCalls.push(['get', id]);
        return { id, url: urlFor(id), title: `Tab ${id}` };
      },
      query: async () => {
        tabCalls.push(['query']);
        return [{ id: activeId, url: urlFor(activeId), title: `Tab ${activeId}` }];
      },
    },
    scripting: {
      executeScript: async (request: any) => {
        calls.push(request);
        const id = request.target.tabId;
        const liveUrl = over.liveUrl ?? urlFor(id);
        const probe = browserProbeResult(request, { url: liveUrl });
        if (probe) return probe;
        return [{
          documentId: TEST_DOCUMENT_ID,
          result: {
            title: `Captured ${id}`,
            url: over.snapshotUrl ?? liveUrl,
            text: `body-${id}`,
          },
        }];
      },
    },
    appClient: {
      readFile: async (request: any) => {
        reads.push(request);
        if (over.readError) throw over.readError;
        return over.readContent ?? `FILE:${request.path}`;
      },
    },
    session: { sessionId: 'session-a' },
  };
  return {
    ctx, calls, reads, tabCalls,
    switchActive: (id: number) => { activeId = id; ctx.activeTab = { id, url: urlFor(id) }; },
  };
};

describe('composer reference host authority', () => {
  const captureRequest = (tabId: number | null) => [{
    operation: 'turn.compose.capture-tab', payload: { tabId },
  }];

  test('pins the admitted active tab and uses browser-issued document identity', async () => {
    const fixture = context();
    const authority = createComposerReferenceAuthority();
    const pinned = await authority.pinContext(fixture.ctx, captureRequest(null));
    fixture.switchActive(9);
    const result = await authority.captureTab(null, pinned);
    expect(result).toMatchObject({
      ok: true,
      value: { origin: 'https://tab-3.example', snapshot: { text: 'body-3' } },
    });
    expect(fixture.calls.some((call) => call.target?.tabId === 9)).toBe(false);
    const capture = fixture.calls.find((call) => call.func?.name === 'captureComposerTabInjected');
    expect(capture.target).toEqual({ tabId: 3, documentIds: [TEST_DOCUMENT_ID] });
  });

  test('supports an explicit tab but refuses denylisted, private, and redirected targets', async () => {
    const authority = createComposerReferenceAuthority();
    const explicit = context();
    await expect(authority.captureTab(
      8, await authority.pinContext(explicit.ctx, captureRequest(8)),
    ))
      .resolves.toMatchObject({ ok: true, value: { snapshot: { text: 'body-8' } } });

    const denied = context({
      urls: { 3: 'https://secure.bank.test/' }, denylist: ['bank.test', '*.bank.test'],
    });
    await expect(authority.captureTab(
      null, await authority.pinContext(denied.ctx, captureRequest(null)),
    ))
      .resolves.toMatchObject({ ok: false });
    expect(denied.calls).toHaveLength(0);

    const privateTarget = context({ urls: { 3: 'http://127.0.0.1/private' } });
    const privateResult = await authority.captureTab(
      null, await authority.pinContext(privateTarget.ctx, captureRequest(null)),
    );
    expect(privateResult).toMatchObject({ ok: false });
    expect(JSON.stringify(privateResult)).not.toContain('/private');

    const redirected = context({ snapshotUrl: 'https://other.example/landed' });
    await expect(authority.captureTab(
      null, await authority.pinContext(redirected.ctx, captureRequest(null)),
    ))
      .resolves.toMatchObject({ ok: false, error: 'tab_blocked: target_changed' });
  });

  test('derives and pins the session for file reads', async () => {
    const fixture = context();
    const authority = createComposerReferenceAuthority();
    const pinned = await authority.pinContext(fixture.ctx);
    fixture.ctx.session.sessionId = 'session-b';
    await expect(authority.readFile('notes.md', pinned))
      .resolves.toMatchObject({ ok: true, value: { content: 'FILE:notes.md' } });
    expect(fixture.reads).toEqual([{ path: 'notes.md', sessionId: 'session-a' }]);
  });

  test('returns byte-bounded text for ASCII and four-byte files', async () => {
    const authority = createComposerReferenceAuthority();
    for (const readContent of [
      'a'.repeat(COMPOSER_FILE_CONTENT_BYTES + 1),
      '😀'.repeat(COMPOSER_FILE_CONTENT_BYTES / 4 + 1),
    ]) {
      const fixture = context({ readContent });
      const result = await authority.readFile(
        'large.txt', await authority.pinContext(fixture.ctx),
      );
      expect(result).toMatchObject({ ok: true, outcomeKnown: true });
      expect(composerUtf8Bytes((result as any).value.content))
        .toBe(COMPOSER_FILE_CONTENT_BYTES);
    }
  });

  test('does no eager browser work and probes only an emitted explicit target', async () => {
    const fixture = context();
    const authority = createComposerReferenceAuthority();
    const pinned = await authority.pinContext(fixture.ctx, [{
      operation: 'turn.compose.read-file', payload: { path: 'notes.md' },
    }]);
    expect(fixture.tabCalls).toEqual([]);
    await authority.readFile('notes.md', pinned);
    expect(fixture.tabCalls).toEqual([]);

    const explicit = await authority.pinContext(fixture.ctx, captureRequest(17));
    expect(fixture.tabCalls).toEqual([]);
    await authority.captureTab(17, explicit);
    expect(fixture.tabCalls.every((call) => call[0] !== 'query')).toBe(true);
    expect(fixture.tabCalls.filter((call) => call[0] === 'get')
      .every((call) => call[1] === 17)).toBe(true);
  });

  test('maps only typed local file refusals to scrubbed known results', async () => {
    const authority = createComposerReferenceAuthority();
    const failures: Array<[Error, string]> = [
      [new DOMException('private missing path', 'NotFoundError'), 'file_not_found'],
      [new AppFileContentError('unsafe private path'), 'file_reference_invalid'],
      [new AppBinaryFileError('private.bin'), 'file_reference_not_text'],
      [new AppDefaultMissingError(), 'file_app_unavailable'],
    ];
    for (const [readError, error] of failures) {
      const fixture = context({ readError });
      const result = await authority.readFile(
        'private-name.md', await authority.pinContext(fixture.ctx),
      );
      expect(result).toEqual({ ok: false, outcomeKnown: true, error });
      expect(JSON.stringify(result)).not.toContain('private');
    }
  });

  test('preserves unknown, cancelled, and untyped post-dispatch read custody', async () => {
    const authority = createComposerReferenceAuthority();
    for (const readError of [
      Object.assign(new Error('transport lost'), { outcomeKnown: false }),
      new DOMException('stopped', 'AbortError'),
      new Error('untyped host failure'),
      Object.assign(new Error('untyped post-dispatch failure'), { outcomeKnown: true }),
    ]) {
      const fixture = context({ readError });
      const result = await authority.readFile(
        'notes.md', await authority.pinContext(fixture.ctx),
      );
      expect(result).toMatchObject({ ok: false, outcomeKnown: false, retryable: false });
    }

    const namedButUnknown = context({
      readError: Object.assign(new DOMException('transport lost', 'NotFoundError'), {
        outcomeKnown: false,
      }),
    });
    await expect(authority.readFile(
      'missing.md', await authority.pinContext(namedButUnknown.ctx),
    )).resolves.toMatchObject({ ok: false, outcomeKnown: false, retryable: false });
  });

  test('stops before host IO and attributes authoritative reads to the session', async () => {
    const fixture = context();
    const controller = new AbortController();
    controller.abort(new DOMException('stopped', 'AbortError'));
    fixture.ctx.signal = controller.signal;
    const authority = createComposerReferenceAuthority();
    const pinned = await authority.pinContext(fixture.ctx);
    await expect(authority.readFile('notes.md', pinned))
      .resolves.toMatchObject({ ok: false, outcomeKnown: false, retryable: false });
    await expect(authority.captureTab(3, pinned))
      .resolves.toMatchObject({ ok: false, outcomeKnown: false, retryable: false });
    expect(fixture.reads).toEqual([]);
    expect(fixture.tabCalls).toEqual([]);
    expect(fixture.calls).toEqual([]);

    const entry = composerReferenceAuditEntry({
      operation: 'turn.compose.read-file', payload: { path: 'notes.md' },
      context: { session: { sessionId: 'session-a' } },
      result: { ok: true, outcomeKnown: true, value: { content: 'body' } },
      allowed: true,
    });
    expect(entry).toMatchObject({
      type: 'composer_reference_authority', sessionId: 'session-a',
      details: { sessionId: 'session-a', path: 'notes.md', allowed: true, ok: true },
    });
  });
});
