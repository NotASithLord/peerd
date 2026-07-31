import { describe, test, expect } from 'bun:test';
import { readWebCacheTool } from '../../../extension/peerd-runtime/tools/defs/read-web-cache.js';
import { siteClientReadTool } from '../../../extension/peerd-runtime/tools/defs/site-client-read.js';
import { siteClientWriteTool } from '../../../extension/peerd-runtime/tools/defs/site-client-write.js';

// Two tools that took a caller-supplied handle and consulted no gate:
//
//   read_web_cache - the spill store is one service-worker-level map keyed by an
//     opaque handle, so a key that leaked into another actor's context paged back
//     bytes that actor never fetched (possibly credentialed, from an origin its
//     own lock refuses).
//   site_client_read/_write - declared `origins: () => []`, so the denylist hook
//     had nothing to check. site_client_run already declared its origin.

const cacheCtx = (rec: any, sessionId: string | null) => ({
  webCache: { get: async () => rec },
  session: sessionId ? { sessionId } : undefined,
} as any);

const REC = { key: 'wc-1', url: 'https://bank.test/statement', format: 'raw', text: 'BALANCE 42' };

describe('read_web_cache is scoped to the actor that spilled it', () => {
  test('the owner can page its own entry', async () => {
    const res: any = await readWebCacheTool.execute({ key: 'wc-1' }, cacheCtx({ ...REC, ownerSessionId: 'actor-a' }, 'actor-a'));
    expect(res.ok).toBe(true);
    expect(res.content).toContain('BALANCE 42');
  });

  test('a DIFFERENT actor holding the key is refused', async () => {
    const res: any = await readWebCacheTool.execute({ key: 'wc-1' }, cacheCtx({ ...REC, ownerSessionId: 'actor-a' }, 'actor-b'));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not_your_cache_entry');
    // and the bytes do not ride along in the refusal
    expect(JSON.stringify(res)).not.toContain('BALANCE 42');
  });

  test('an UNSTAMPED legacy entry is still readable', async () => {
    // Entries written before the stamp exist in live profiles and age out within
    // 40 spills; refusing them would break paging mid-turn on upgrade.
    const res: any = await readWebCacheTool.execute({ key: 'wc-1' }, cacheCtx(REC, 'actor-b'));
    expect(res.ok).toBe(true);
  });
});

describe('site_client read/write declare the origin they touch', () => {
  test('read declares the normalized origin so the denylist hook can see it', () => {
    expect(siteClientReadTool.origins({ origin: 'https://bank.test/anything' }, {} as any)).toEqual(['https://bank.test']);
  });

  test('write declares it too', () => {
    expect(siteClientWriteTool.origins({ origin: 'https://bank.test' }, {} as any)).toEqual(['https://bank.test']);
  });

  test('a junk origin declares nothing rather than a bogus entry', () => {
    expect(siteClientReadTool.origins({ origin: 'not a url' }, {} as any)).toEqual([]);
    expect(siteClientWriteTool.origins({}, {} as any)).toEqual([]);
  });
});
