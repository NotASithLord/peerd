import { describe, test, expect } from 'bun:test';
import { scriptTool } from '../../../extension/peerd-runtime/tools/defs/script.js';
import { jsNotebookTool } from '../../../extension/peerd-runtime/tools/defs/js-notebook.js';
import {
  REMOTE_MODULE_IMPORTS_UNAVAILABLE_CODE,
  REMOTE_MODULE_IMPORTS_UNAVAILABLE_MESSAGE,
  UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE,
  UNSUPPORTED_NATIVE_MODULE_IMPORT_MESSAGE,
} from '../../../extension/peerd-engine/errors.js';

const policyError = `${REMOTE_MODULE_IMPORTS_UNAVAILABLE_CODE}: ${REMOTE_MODULE_IMPORTS_UNAVAILABLE_MESSAGE}`;
const unsupportedFormError = `${UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE}: ${UNSUPPORTED_NATIVE_MODULE_IMPORT_MESSAGE}`;

const policyResult = {
  durationMs: 0,
  error: 'host detail and stack that must not cross the tool boundary',
  errorCode: REMOTE_MODULE_IMPORTS_UNAVAILABLE_CODE,
  consoleOutput: [],
};

describe('remote module package policy reaches the model as a tool failure', () => {
  test('script does not present the host policy refusal as a successful code result', async () => {
    const result = await scriptTool.execute({ code: "import('https://example.test/mod.js')" }, {
      session: { sessionId: 'session-1', kind: 'chat' },
      jsOffscreenClient: { execHeadless: async () => policyResult },
    } as any);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(policyError);
      expect(result.error).toContain('peerd:std');
      expect(result.error).toContain('peerd:toolbox/<name>');
      expect(result.error).not.toContain('host detail');
    }
  });

  test('Notebook keeps code exceptions in-band but returns package policy as a failure', async () => {
    const result = await jsNotebookTool.execute({ code: "import('https://example.test/mod.js')" }, {
      session: { sessionId: 'session-1', kind: 'chat' },
      jsClient: { eval: async () => policyResult },
    } as any);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(policyError);
  });

  test.each([
    ['script', scriptTool],
    ['Notebook', jsNotebookTool],
  ])('%s tells the model how to repair a computed local import', async (_name, tool) => {
    const result = await tool.execute({ code: "const path = './local.js'; await import(path)" }, {
      session: { sessionId: 'session-1', kind: 'chat' },
      jsOffscreenClient: { execHeadless: async () => ({
        ...policyResult,
        errorCode: UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE,
      }) },
      jsClient: { eval: async () => ({
        ...policyResult,
        errorCode: UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE,
      }) },
    } as any);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(unsupportedFormError);
      expect(result.error).toContain('literal static local import');
      expect(result.error).not.toContain('peerd.self.import(path)');
      expect(result.error).not.toContain('host detail');
    }
  });
});
