import { describe, expect, test } from 'bun:test';
import {
  TOOL_EXECUTION_PROTOCOL,
  compileToolEffectManifest,
  createToolEffectQuota,
  parseToolExecutionRequest,
  toolExecutionResultAllowed,
} from '../../extension/shared/tool-execution-protocol.js';
import {
  structuredClonePayloadBytes, structuredClonePayloadFits,
} from '../../extension/shared/structured-clone-size.js';

const digest = 'a'.repeat(64);
const manifest = () => compileToolEffectManifest({
  protocol: TOOL_EXECUTION_PROTOCOL,
  digest,
  tools: {
    remember: {
      projectionKeys: ['sessionId'],
      effects: [{
        method: 'writeMemory', operation: 'memory.write', maxCalls: 1,
        riskClass: 'commit',
        requestSchema: {
          type: 'object', properties: {
            fact: { type: 'string', maxLength: 64 },
            metadata: {
              type: 'object', properties: { source: { type: 'string', maxLength: 16 } },
              required: ['source'],
            },
            tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
          }, required: ['fact'],
        },
        resultSchema: {
          type: 'object', properties: { stored: { type: 'boolean' } }, required: ['stored'],
        },
        requestBytes: 256, resultBytes: 256,
      }],
      argumentBytes: 256, projectionBytes: 256, resultBytes: 1_024, pendingEffects: 1,
    },
  },
});
const request = (over: Record<string, unknown> = {}) => ({
  protocol: TOOL_EXECUTION_PROTOCOL,
  executionId: 'execution-1',
  runId: 'run-1',
  callId: 'tool-use-1',
  sessionId: 'session-1',
  turnGeneration: 3,
  attempt: 0,
  toolName: 'remember',
  authorityClass: 'remember',
  argsDigest: 'b'.repeat(64),
  manifestDigest: digest,
  args: { fact: 'one' },
  projection: { sessionId: 'session-1' },
  ...over,
});

describe('tool execution protocol', () => {
  test('charges sparse array length and rejects shared-memory views', () => {
    const sparse: unknown[] = [];
    sparse.length = 1_000_000_000;
    expect(structuredClonePayloadBytes({ content: sparse })).toBeGreaterThan(900_000_000);
    expect(structuredClonePayloadFits({ content: sparse }, 16 * 1024 * 1024)).toBe(false);

    const shared = new SharedArrayBuffer(16);
    expect(structuredClonePayloadBytes(new Uint8Array(shared))).toBe(Infinity);
    expect(structuredClonePayloadBytes(new DataView(shared))).toBe(Infinity);

    const owned = new ArrayBuffer(16);
    expect(structuredClonePayloadBytes(new Uint8Array(owned))).toBe(16);
    expect(structuredClonePayloadBytes(new DataView(owned))).toBe(16);
  });

  test('compiles a frozen exact effect vocabulary', () => {
    const compiled = manifest();
    expect(Object.isFrozen(compiled.tools.remember.effects[0])).toBe(true);
    expect(compiled.tools.remember.effects[0]).toEqual({
      method: 'writeMemory', operation: 'memory.write', maxCalls: 1,
      riskClass: 'commit',
      requestSchema: {
        type: 'object', properties: {
          fact: { type: 'string', maxLength: 64 },
          metadata: {
            type: 'object', properties: { source: { type: 'string', maxLength: 16 } },
            required: ['source'],
          },
          tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
        }, required: ['fact'],
      },
      resultSchema: {
        type: 'object', properties: { stored: { type: 'boolean' } }, required: ['stored'],
      },
      requestBytes: 256, resultBytes: 256,
    });
    expect(compiled.tools.remember.projectionKeys).toEqual(['sessionId']);
    expect(() => compileToolEffectManifest({
      protocol: TOOL_EXECUTION_PROTOCOL,
      digest,
      tools: { remember: { projectionKeys: [], effects: [
        {
          method: 'writeMemory', operation: 'memory.write', riskClass: 'commit',
          requestSchema: { type: 'object', properties: {}, required: [] },
          resultSchema: { type: 'object', properties: {}, required: [] },
        },
        {
          method: 'writeMemory', operation: 'memory.delete', riskClass: 'commit',
          requestSchema: { type: 'object', properties: {}, required: [] },
          resultSchema: { type: 'object', properties: {}, required: [] },
        },
      ] } },
    })).toThrow('tool-effect-manifest-effect-invalid:remember');
    expect(() => compileToolEffectManifest({
      protocol: TOOL_EXECUTION_PROTOCOL,
      digest,
      tools: { remember: {
        projectionKeys: [], effects: [{
          method: 'call', operation: 'memory.write', riskClass: 'commit',
          requestSchema: { type: 'object', properties: {}, required: [] },
          resultSchema: { type: 'object', properties: {}, required: [] },
        }],
      } },
    })).toThrow('tool-effect-manifest-effect-invalid:remember');
  });

  test('binds requests to the tool and manifest digests', () => {
    const compiled = manifest();
    expect(parseToolExecutionRequest(request(), compiled)).toMatchObject({
      executionId: 'execution-1', runId: 'run-1', callId: 'tool-use-1',
      sessionId: 'session-1', turnGeneration: 3, attempt: 0,
      toolName: 'remember', authorityClass: 'remember', argsDigest: 'b'.repeat(64),
    });
    expect(parseToolExecutionRequest(request({ manifestDigest: 'c'.repeat(64) }), compiled))
      .toBeNull();
    expect(parseToolExecutionRequest(request({ extra: true }), compiled)).toBeNull();
    expect(parseToolExecutionRequest(request({
      projection: { sessionId: 'session-1', vaultKey: 'secret' },
    }), compiled)).toBeNull();
    expect(parseToolExecutionRequest(request({ args: { fact: () => 'ambient' } }), compiled))
      .toBeNull();
  });

  test('accounts exact operations, bytes, and call counts', () => {
    const quota = createToolEffectQuota(manifest().tools.remember);
    expect(quota.admit('memory.delete', {})).toMatchObject({ ok: false, code: 'tool-effect-denied' });
    expect(quota.admit('memory.write', { fact: 'one', hidden: true }))
      .toMatchObject({ ok: false, code: 'tool-effect-request-invalid' });
    expect(quota.admit('memory.write', { fact: 'one', metadata: { source: 1 } }))
      .toMatchObject({ ok: false, code: 'tool-effect-request-invalid' });
    expect(quota.admit('memory.write', { fact: 'one', metadata: new Date() }))
      .toMatchObject({ ok: false, code: 'tool-effect-request-invalid' });
    const sparseTags: string[] = [];
    sparseTags.length = 1;
    expect(quota.admit('memory.write', { fact: 'one', tags: sparseTags }))
      .toMatchObject({ ok: false, code: 'tool-effect-request-invalid' });
    const decoratedTags: any = ['one'];
    decoratedTags.hidden = true;
    expect(quota.admit('memory.write', { fact: 'one', tags: decoratedTags }))
      .toMatchObject({ ok: false, code: 'tool-effect-request-invalid' });
    expect(quota.admit('memory.write', { fact: 'one' })).toMatchObject({ ok: true });
    expect(quota.observe('memory.write', {
      ok: true, outcomeKnown: true, value: { stored: true, hidden: true },
    })).toMatchObject({ ok: false, code: 'tool-effect-result-invalid' });
    const second = createToolEffectQuota(manifest().tools.remember);
    expect(second.admit('memory.write', { fact: 'one' })).toMatchObject({ ok: true });
    expect(second.observe('memory.write', {
      ok: true, outcomeKnown: true, value: { stored: true },
    }))
      .toMatchObject({ ok: true });
    expect(quota.admit('memory.write', { fact: 'two' }))
      .toMatchObject({ ok: false, code: 'tool-effect-budget-exhausted' });
  });

  test('requires a bounded custody envelope', () => {
    const valid = {
      protocol: TOOL_EXECUTION_PROTOCOL,
      executionId: 'execution-1', argsDigest: 'b'.repeat(64),
      ok: true, outcomeKnown: true, effectEntered: false, value: { ok: true },
    };
    expect(toolExecutionResultAllowed(valid, 1_024)).toBe(true);
    expect(toolExecutionResultAllowed({ ...valid, effectEntered: 'yes' }, 1_024)).toBe(false);
    expect(toolExecutionResultAllowed({ ...valid, hidden: true }, 1_024)).toBe(false);
    expect(toolExecutionResultAllowed({
      ...valid, ok: false, code: 'lost', outcomeKnown: false,
      retryable: true, value: undefined,
    }, 1_024)).toBe(false);
  });
});
