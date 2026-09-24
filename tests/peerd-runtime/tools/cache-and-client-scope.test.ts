import { describe, test, expect } from 'bun:test';
import { readResultTool } from '../../../extension/peerd-runtime/tools/defs/read-result.js';
import { siteClientReadTool } from '../../../extension/peerd-runtime/tools/defs/site-client-read.js';
import { siteClientWriteTool } from '../../../extension/peerd-runtime/tools/defs/site-client-write.js';
import { siteClientRunTool } from '../../../extension/peerd-runtime/tools/defs/site-client-run.js';

// Two tools that took a caller-supplied handle and consulted no gate:
//
//   read_result - the spill store is one service-worker-level map keyed by an
//     opaque handle, so a key that leaked into another actor's context paged back
//     bytes that actor never fetched (possibly credentialed, from an origin its
//     own lock refuses).
//   site_client_read/_write - declared `origins: () => []`, so the denylist hook
//     had nothing to check. site_client_run already declared its origin.

const cacheCtx = (rec: any, sessionId: string | null) => ({
  resourceAuthority: {
    readResult: async () => rec?.ownerSessionId === sessionId
      ? { ok: true, record: rec }
      : { ok: false, error: 'not_your_result' },
  },
} as any);

const REC = {
  key: 'result:opaque-1',
  ownerSessionId: 'actor-a',
  producer: 'fetch_url',
  fenced: true,
  originLabel: 'https://bank.test',
  url: 'https://bank.test/statement',
  format: 'raw',
  text: 'BALANCE 42',
};

describe('read_result is scoped to the actor that spilled it', () => {
  test('the owner can page its own entry', async () => {
    const res: any = await readResultTool.execute({ key: REC.key }, cacheCtx(REC, 'actor-a'));
    expect(res.ok).toBe(true);
    expect(res.content).toContain('BALANCE 42');
  });

  test('a DIFFERENT actor holding the key is refused', async () => {
    const res: any = await readResultTool.execute({ key: REC.key }, cacheCtx(REC, 'actor-b'));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not_your_result');
    // and the bytes do not ride along in the refusal
    expect(JSON.stringify(res)).not.toContain('BALANCE 42');
  });

  test('an unstamped entry fails closed', async () => {
    const { ownerSessionId: _ownerSessionId, ...unstamped } = REC;
    const res: any = await readResultTool.execute({ key: REC.key }, cacheCtx(unstamped, 'actor-a'));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not_your_result');
  });
});

describe('site_client read/write declare the origin they touch', () => {
  test('read declares the normalized origin so the denylist hook can see it', () => {
    expect(siteClientReadTool.origins({ origin: 'https://bank.test/anything' }, {} as any)).toEqual(['https://bank.test']);
  });

  test('write declares it too', () => {
    expect(siteClientWriteTool.origins({ origin: 'https://bank.test' }, {} as any)).toEqual(['https://bank.test']);
  });

  test('run stays on the same normalized declaration contract', () => {
    expect(siteClientRunTool.origins({ origin: 'HTTPS://BANK.TEST:443/path' }, {} as any)).toEqual(['https://bank.test']);
  });

  test('a junk origin declares nothing rather than a bogus entry', () => {
    expect(siteClientReadTool.origins({ origin: 'not a url' }, {} as any)).toEqual([]);
    expect(siteClientWriteTool.origins({}, {} as any)).toEqual([]);
    expect(siteClientRunTool.origins({ origin: 'not a url' }, {} as any)).toEqual([]);
  });
});
