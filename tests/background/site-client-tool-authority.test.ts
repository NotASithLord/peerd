import { describe, expect, test } from 'bun:test';
import { createSiteClientToolAuthority } from '../../extension/background/site-client-tool-authority.js';

describe('exact site-client capture authority', () => {
  test('a missing stored client is a known pre-dispatch refusal with guidance', async () => {
    const origin = 'https://example.com';
    const authority = createSiteClientToolAuthority({
      binding: { operation: 'turn.site-client.run', args: {
        origin, code: 'return client.read()', timeoutMs: 1_000,
      } },
      ctx: {
        session: { sessionId: 'actor-web-1' },
        authorizeSiteClientOrigin: async () => true,
        siteClients: { get: async () => null },
        jsOffscreenClient: { execHeadless: async () => ({}) },
        scriptRuns: { mintRunId: () => 'unused', register: () => {}, release: () => {} },
      },
    });
    await expect(authority.runStoredClient(
      origin, 'return client.read()', 1_000,
    )).resolves.toMatchObject({
      ok: false, error: expect.stringContaining('derive one first'),
      performed: false, outcomeKnown: true,
      outcomeKind: 'pre-effect-failure', retryable: true,
    });
  });

  test('Stop after a stored client returns cannot erase its completed write custody', async () => {
    let authorizationReads = 0;
    let authorizeAfterRun!: () => void;
    let releaseAuthorization!: () => void;
    const authorizationStarted = new Promise<void>((resolve) => { authorizeAfterRun = resolve; });
    const authorizationGate = new Promise<void>((resolve) => { releaseAuthorization = resolve; });
    const controller = new AbortController();
    const ctx: any = {
      session: { sessionId: 'actor-web-1' },
      authorizeSiteClientOrigin: async () => {
        authorizationReads += 1;
        // Two reads load and rebind the stored record. The third is the
        // post-execution authorization whose Stop race is under test.
        if (authorizationReads === 3) {
          authorizeAfterRun();
          await authorizationGate;
        }
        return true;
      },
      siteClients: {
        get: async () => ({ body: 'return { fetch: async () => ({ ok: true }) };' }),
        recordRun: async () => {},
      },
      jsOffscreenClient: {
        execHeadless: async () => ({ value: { remoteWriteCompleted: true } }),
        abortHeadless: async () => {},
      },
      scriptRuns: {
        mintRunId: () => 'site-run-1', register: () => {}, release: () => {},
      },
    };
    const authority = createSiteClientToolAuthority({
      binding: { operation: 'turn.site-client.run', args: {
        origin: 'https://example.com', code: 'return client.fetch()', timeoutMs: 1_000,
      } },
      ctx, signal: controller.signal,
    });
    const pending = authority.runStoredClient(
      'https://example.com', 'return client.fetch()', 1_000,
    );
    await authorizationStarted;
    controller.abort();
    releaseAuthorization();
    await expect(pending).resolves.toMatchObject({
      ok: false, performed: true, executionDispatched: true,
      outcomeKnown: true, outcomeKind: 'effect-completed', retryable: false,
    });
  });

  test('authorization loss after recording a completed run cannot erase write custody', async () => {
    let authorizationReads = 0;
    let runRecorded!: () => void;
    let releaseAuthorization!: () => void;
    const recorded = new Promise<void>((resolve) => { runRecorded = resolve; });
    const authorizationGate = new Promise<void>((resolve) => { releaseAuthorization = resolve; });
    let authorized = true;
    const ctx: any = {
      session: { sessionId: 'actor-web-1' },
      authorizeSiteClientOrigin: async () => {
        authorizationReads += 1;
        if (authorizationReads === 4) await authorizationGate;
        return authorized;
      },
      siteClients: {
        get: async () => ({ body: 'return { fetch: async () => ({ ok: true }) };' }),
        recordRun: async () => { runRecorded(); },
      },
      jsOffscreenClient: {
        execHeadless: async () => ({ value: { remoteWriteCompleted: true } }),
        abortHeadless: async () => {},
      },
      scriptRuns: {
        mintRunId: () => 'site-run-2', register: () => {}, release: () => {},
      },
    };
    const authority = createSiteClientToolAuthority({
      binding: { operation: 'turn.site-client.run', args: {
        origin: 'https://example.com', code: 'return client.fetch()', timeoutMs: 1_000,
      } },
      ctx,
    });
    const pending = authority.runStoredClient(
      'https://example.com', 'return client.fetch()', 1_000,
    );
    await recorded;
    authorized = false;
    releaseAuthorization();
    await expect(pending).resolves.toMatchObject({
      ok: false, performed: true, executionDispatched: true,
      outcomeKnown: true, outcomeKind: 'effect-completed', retryable: false,
    });
  });

  test.each(['authorization-lost', 'record-run-revokes'] as const)(
    'post-dispatch host loss outranks later %s custody checks',
    async (race) => {
      let authorizationReads = 0;
      let authorized = true;
      let recordRuns = 0;
      const ctx: any = {
        session: { sessionId: 'actor-web-1' },
        authorizeSiteClientOrigin: async () => {
          authorizationReads += 1;
          return authorized;
        },
        siteClients: {
          get: async () => ({ body: 'return { fetch: async () => ({ ok: true }) };' }),
          recordRun: async () => {
            recordRuns += 1;
            if (race === 'record-run-revokes') authorized = false;
          },
        },
        jsOffscreenClient: {
          execHeadless: async () => {
            if (race === 'authorization-lost') authorized = false;
            throw Object.assign(new Error('sealed host disappeared'), {
              executionDispatched: true,
              outcomeKnown: false,
              outcomeKind: 'transport-lost',
            });
          },
        },
        scriptRuns: {
          mintRunId: () => 'site-run-lost', register: () => {}, release: () => {},
        },
      };
      const authority = createSiteClientToolAuthority({
        binding: { operation: 'turn.site-client.run', args: {
          origin: 'https://example.com', code: 'return client.fetch()', timeoutMs: 1_000,
        } },
        ctx,
      });
      await expect(authority.runStoredClient(
        'https://example.com', 'return client.fetch()', 1_000,
      )).rejects.toMatchObject({
        performed: true, executionDispatched: true,
        outcomeKnown: false, outcomeKind: 'transport-lost', retryable: false,
      });
      // Only the two admission reads may run. Neither a later revocation nor
      // bookkeeping failure may rewrite already-dispatched custody as refusal.
      expect(authorizationReads).toBe(2);
      expect(recordRuns).toBe(0);
    },
  );

  test.each(['start', 'stop'] as const)(
    'Stop while resolving the owned tab prevents capture %s',
    async (action) => {
      let releaseTab!: () => void;
      let tabStarted!: () => void;
      const tabGate = new Promise<void>((resolve) => { releaseTab = resolve; });
      const started = new Promise<void>((resolve) => { tabStarted = resolve; });
      const controller = new AbortController();
      let starts = 0;
      let stops = 0;
      const ctx: any = {
        actorType: 'web', activeTab: { id: 7 }, denylist: [],
        tabs: {
          get: async () => {
            tabStarted();
            await tabGate;
            return { id: 7, url: 'https://example.com/', peerdDocumentId: 'doc-1' };
          },
        },
        scripting: { executeScript: async () => [{ documentId: 'doc-1', result: {
          href: 'https://example.com/', origin: 'https://example.com',
          documentId: 'doc-1', timeOrigin: 1,
        } }] },
        siteCapture: {
          start: async () => { starts += 1; return { tap: 'tap-1' }; },
          stop: async () => { stops += 1; return { entries: [] }; },
        },
      };
      const authority = createSiteClientToolAuthority({
        binding: {
          operation: `turn.site-client.capture-${action}`,
          args: {},
        },
        ctx, signal: controller.signal,
      });
      const pending = action === 'start'
        ? authority.startOwnedCapture() : authority.stopOwnedCapture();
      await started;
      controller.abort();
      releaseTab();
      await expect(pending).rejects.toMatchObject({
        outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
      });
      expect({ starts, stops }).toEqual({ starts: 0, stops: 0 });
    },
  );

  test.each([false, true])(
    'Stop after capture start %s cleanup failure preserves honest custody',
    async (cleanupFails) => {
      let startEntered!: () => void;
      let releaseStart!: () => void;
      const entered = new Promise<void>((resolve) => { startEntered = resolve; });
      const gate = new Promise<void>((resolve) => { releaseStart = resolve; });
      const controller = new AbortController();
      let active = false;
      const ctx: any = {
        actorType: 'web', activeTab: { id: 7 }, denylist: [],
        tabs: { get: async () => ({
          id: 7, url: 'https://example.com/', peerdDocumentId: 'doc-1',
        }) },
        scripting: { executeScript: async () => [{ documentId: 'doc-1', result: {
          href: 'https://example.com/', origin: 'https://example.com',
          documentId: 'doc-1', timeOrigin: 1,
        } }] },
        siteCapture: {
          start: async () => {
            startEntered();
            await gate;
            active = true;
            return { tap: 'tap-1' };
          },
          stop: async () => ({ entries: [] }),
          cancel: async () => {
            if (cleanupFails) throw new Error('debugger detach lost');
            active = false;
          },
        },
      };
      const authority = createSiteClientToolAuthority({
        binding: { operation: 'turn.site-client.capture-start', args: {} },
        ctx, signal: controller.signal,
      });
      const pending = authority.startOwnedCapture();
      await entered;
      controller.abort();
      releaseStart();
      if (cleanupFails) {
        await expect(pending).rejects.toMatchObject({
          performed: true, outcomeKnown: false, retryable: false,
        });
        expect(active).toBe(true);
      } else {
        await expect(pending).rejects.toMatchObject({
          outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
        });
        expect(active).toBe(false);
      }
    },
  );
});
