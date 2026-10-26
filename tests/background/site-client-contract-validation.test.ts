import { beforeAll, describe, expect, test } from 'bun:test';
import { useFakeIndexedDB } from '../setup.ts';
import { createSiteClientStore } from '../../extension/peerd-runtime/site-clients/store.js';
import { siteClientValidatedOperations } from '../../extension/peerd-runtime/site-clients/core.js';
import { createScriptRunRegistry } from '../../extension/background/script-runs.js';
import { siteClientRunTool } from '../../extension/peerd-runtime/tools/defs/site-client-run.js';
import { siteClientReadTool } from '../../extension/peerd-runtime/tools/defs/site-client-read.js';
import { executeSiteClientTool } from '../helpers/site-client-tool.ts';

beforeAll(async () => { await useFakeIndexedDB(); });
let sequence = 0;
const origin = 'https://api.example.test';
const operation = { name: 'lookup', readOnly: true,
  inputSchema: { type: 'object', properties: { key: { type: 'string', minLength: 1 } }, required: ['key'] },
  outputSchema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] } };
const cases = ['a', 'b'].map(key => ({ operation: 'lookup', input: { key }, expected: { key, value: key.toUpperCase() } }));
const body = `return { lookup: async (input) => (await site.fetch('/items/' + encodeURIComponent(input.key))).json };`;

const fixture = async (over: any = {}) => {
  const store = createSiteClientStore({ dbName: `site-contract-validation-${++sequence}`, now: () => 123 });
  const dossier = { origin, operations: [operation], validationCases: cases, ...over.dossier };
  const meta = await store.put({ dossier, body: over.body ?? body });
  const runs = createScriptRunRegistry();
  const fetched: string[] = [];
  const controller = new AbortController();
  let authorized = true;
  let returned: any;
  let afterExecute: ((options: any) => Promise<void>|void) | undefined;
  const context = {
    session: { sessionId: 'web-contract-actor' },
    authorizeSiteClientOrigin: async () => authorized,
    abortSignal: controller.signal, siteClients: store, scriptRuns: runs,
    jsOffscreenClient: { execHeadless: async (source: string, options: any) => {
      expect(runs.allows(options.runId, 'siteReadOnly')).toBe(true);
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      let result: any;
      try {
        const value = await new AsyncFunction('site', source)({ fetch: async (path: string) => {
          fetched.push(path);
          const key = decodeURIComponent(path.split('/').at(-1)!);
          return { status: 200, json: returned ?? { key, value: key.toUpperCase() } };
        } });
        result = { value, error: null };
      } catch { result = { error: 'sealed client failed' }; }
      await afterExecute?.(options);
      return result;
    } },
  };
  const run = (args: any) => executeSiteClientTool(siteClientRunTool, { origin, revision: meta.revision, ...args }, context);
  return { store, runs, context, meta, fetched, controller, run,
    validate: () => run({ mode: 'validate' }),
    setAuthorized: (value: boolean) => { authorized = value; },
    setOutput: (value: any) => { returned = value; },
    afterExecute: (fn: typeof afterExecute) => { afterExecute = fn; },
  };
};

const envelope = (result: any, tag: string) => {
  expect(result.ok).toBe(true);
  expect(result.content.startsWith('<untrusted_web_content ')).toBe(true);
  expect(result.content.split('\n')[1]).toBe(`<${tag}>`);
  return JSON.parse(result.content.split('\n')[2]);
};

describe('host-validated named site reads', () => {
  test('only declared cases execute, then a held-out typed input reuses the exact promoted client', async () => {
    const f = await fixture();
    const validation = envelope(await f.validate(), 'site_client_validation');
    expect(validation).toMatchObject({ origin, revision: f.meta.revision, validatedOperations: ['lookup'],
      cases: [{ index: 0, operation: 'lookup', ok: true }, { index: 1, operation: 'lookup', ok: true }] });
    expect(f.fetched).toEqual(['/items/a', '/items/b']);
    expect((await f.store.getMeta(origin))?.lastVerifiedAt).toBe(123);
    const read = envelope(await executeSiteClientTool(siteClientReadTool, { origin }, f.context), 'site_client_contract');
    expect(read).toMatchObject({ schema: 1, status: 'validated', validatedOperations: ['lookup'] });
    const result = envelope(await f.run({ operation: 'lookup', input: { key: 'c' } }), 'site_client_result');
    expect(result).toMatchObject({ origin, revision: f.meta.revision, operation: 'lookup',
      inputValidated: true, outputValidated: true, readOnly: true, result: { key: 'c', value: 'C' } });
    expect(f.fetched).toEqual(['/items/a', '/items/b', '/items/c']);
    expect(f.runs._size()).toBe(0);
  });

  test('unpromoted, mixed-code, stale-revision and invalid-input calls are refused before execution', async () => {
    const f = await fixture();
    expect(await f.run({ operation: 'lookup', input: { key: 'c' } })).toMatchObject({ ok: false, error: 'site_client_operation_not_validated' });
    expect(await f.run({ mode: 'validate', code: 'return 1' })).toMatchObject({ ok: false });
    expect(await f.run({ operation: 'lookup', input: { key: 'c' }, revision: 'stale' })).toMatchObject({ ok: false, error: 'site_client_revision_stale' });
    expect(f.fetched).toEqual([]);
    await f.validate();
    expect(await f.run({ operation: 'lookup', input: { key: 7 } })).toMatchObject({ ok: false, error: 'site_client_input_invalid' });
    expect(f.fetched).toHaveLength(2);
  });

  test('one distinct input and inherited methods cannot obtain promotion', async () => {
    const repeated = await fixture({ dossier: { validationCases: [cases[0], cases[0]] } });
    expect(await repeated.validate()).toMatchObject({ ok: false, error: expect.stringContaining('two distinct inputs') });
    expect(repeated.fetched).toEqual([]);
    const inherited = await fixture({ body: `return Object.create({ lookup: async () => ({ key:'a', value:'A' }) });` });
    expect(await inherited.validate()).toMatchObject({ ok: false, error: 'site_client_validation_failed' });
    expect(siteClientValidatedOperations(await inherited.store.getMeta(origin))).toEqual([]);
  });

  test('matching output schema alone cannot satisfy a declared expected result', async () => {
    const f = await fixture();
    f.setOutput({ key: 'a', value: 'wrong' });
    expect(await f.validate()).toMatchObject({ ok: false, error: 'site_client_validation_failed' });
    const meta = await f.store.getMeta(origin);
    expect(meta?.validation.cases).toEqual([{ index: 0, operation: 'lookup', ok: false }]);
    expect(meta?.lastVerifiedAt).toBe(0);
  });

  test('schema failure or a caught host read refusal revokes existing promotion', async () => {
    const f = await fixture();
    await f.validate();
    f.setOutput({ key: 'c', value: 7 });
    expect(await f.run({ operation: 'lookup', input: { key: 'c' } })).toMatchObject({ ok: false, error: 'site_client_output_invalid' });
    expect(siteClientValidatedOperations(await f.store.getMeta(origin))).toEqual([]);
    f.setOutput(undefined);
    await f.validate();
    f.afterExecute(options => { f.runs.failSiteRead(options.runId, 'site_client_read_method_refused'); });
    expect(await f.run({ operation: 'lookup', input: { key: 'c' } })).toMatchObject({ ok: false, error: 'site_client_read_method_refused' });
    expect(siteClientValidatedOperations(await f.store.getMeta(origin))).toEqual([]);
  });

  test('replacement during validation cannot receive the old body\'s receipts', async () => {
    const f = await fixture();
    let changed = false;
    f.afterExecute(async () => {
      if (!changed) {
        changed = true;
        await f.store.put({ dossier: { origin, operations: [operation], validationCases: cases }, body: `${body}\n// replacement` });
      }
    });
    expect(await f.validate()).toMatchObject({ ok: false, error: 'site_client_revision_stale' });
    const current = await f.store.getMeta(origin);
    expect(current?.revision).not.toBe(f.meta.revision);
    expect(siteClientValidatedOperations(current)).toEqual([]);
  });

  test.each(['stop', 'ownership'] as const)('%s during final validation bookkeeping cannot leave promotion', async change => {
    const f = await fixture();
    const recordValidation = f.store.recordValidation;
    f.context.siteClients = { ...f.store, recordValidation: async (origin, outcome) => {
      if (change === 'stop') f.controller.abort(); else f.setAuthorized(false);
      return recordValidation(origin, outcome);
    } };
    expect(await f.validate()).toMatchObject({ ok: false, performed: true, outcomeKnown: true, retryable: false });
    expect(siteClientValidatedOperations(await f.store.getMeta(origin))).toEqual([]);
  });

  test.each(['record-run', 'final-read'] as const)('Stop during %s suppresses a typed success envelope', async stage => {
    const f = await fixture();
    await f.validate();
    let reads = 0;
    f.context.siteClients = { ...f.store,
      recordRun: async (origin, outcome) => {
        if (stage === 'record-run') f.controller.abort();
        return f.store.recordRun(origin, outcome);
      },
      get: async origin => {
        if (stage === 'final-read' && ++reads === 2) f.controller.abort();
        return f.store.get(origin);
      },
    };
    const result = await f.run({ operation: 'lookup', input: { key: 'c' } });
    expect(result).toMatchObject({ ok: false, error: 'site_client_run_completed_after_stop',
      performed: true, outcomeKnown: true, retryable: false });
    expect(result.content).toBeUndefined();
  });

  test.each(['stop', 'ownership'] as const)('%s after execution suppresses output and metadata mutation', async change => {
    const f = await fixture();
    await f.validate();
    const before = await f.store.getMeta(origin);
    f.afterExecute(() => { if (change === 'stop') f.controller.abort(); else f.setAuthorized(false); });
    expect(await f.run({ operation: 'lookup', input: { key: 'c' } })).toMatchObject({
      ok: false, performed: true, outcomeKnown: true, retryable: false,
    });
    expect(await f.store.getMeta(origin)).toEqual(before);
  });
});
