import { describe, expect, test } from 'bun:test';
import { assertRemoteModulePolicy } from '../../extension/peerd-engine/module-import-policy.js';
import {
  moduleImportPolicyMessage,
  MODULE_SYNTAX_ERROR_CODE,
  REMOTE_MODULE_IMPORTS_UNAVAILABLE_CODE,
  UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE,
} from '../../extension/peerd-engine/errors.js';

const expectPolicyRefusal = (
  source: string,
  code = REMOTE_MODULE_IMPORTS_UNAVAILABLE_CODE,
  remoteModulesEnabled = false,
) => {
  try {
    assertRemoteModulePolicy(source, remoteModulesEnabled);
    throw new Error('expected package policy refusal');
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
  }
};

describe('remote module syntax policy', () => {
  test.each([
    "import/* split */'https://cdn.test/mod.js';",
    "import 'https:\\x2f\\x2fcdn.test/mod.js';",
    "export { value } from/* split */'HTTPS://cdn.test/mod.js';",
    "import ' https://cdn.test/leading-space.js';",
    "import 'https:/cdn.test/one-slash.js';",
    "import 'https:\\\\cdn.test/backslash.js';",
  ])('Store and web reject an external native-loader specifier: %s', (source) => {
    expectPolicyRefusal(source);
  });

  test.each([
    "const url = 'https://cdn.test/mod.js'; await import(url);",
    "{ import(url)\n{} }",
    "let n = 1; const url = 'https://cdn.test/x.js'; n++ / import(url) / 2;",
    "let n = 1; const url = 'https://cdn.test/x.js'; n-- / import(url) / 2;",
    "await import('https:' + '//cdn.test/mod.js');",
    "const result = `${await import(url)}`;",
    "const path = './local.js'; await import(path);",
    "await import(`./local.js`);",
    "await import('./local.js', { with: { type: 'json' } });",
    "await import('./local.js');",
    "await import('../local.js');",
    "await import('local.js');",
    "await import('peerd:std');",
    "await import('https://cdn.test/mod.js');",
    "import/* comment */('ht\\ttps://cdn.test/stripped-tab.js');",
    "import('data:text/javascript,export default 1');",
    "import('/peerd-runtime/loop.js');",
    "import { helper } from 'peerd:host/helper';",
  ])('unsupported native import forms get the repair-specific refusal: %s', (source) => {
    expectPolicyRefusal(source, UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE);
  });

  test.each([
    "import { table } from 'peerd:std';",
    "import { value } from './local.js';",
  ])('supported literal static local import remains available: %s', (source) => {
    expect(() => assertRemoteModulePolicy(
      source, false, { allowReturnOutsideFunction: true },
    )).not.toThrow();
  });

  test('ordinary import-named syntax, strings, comments, and regexes are inert', () => {
    const source = `
      const object = { import(value) { return value; }, import: 2 };
      class Example { static async import(value) { return value; } *import(value) { yield value; } }
      object.import('https://cdn.test/not-a-module.js');
      const text = "import('https://cdn.test/not-a-module.js')";
      const pattern = /import\\('https:\\/\\/cdn\\.test/;
      if (text) /export .* from "https:\\/\\//.test(text);
      // import('https://cdn.test/not-a-module.js')
      /* export { value } from 'https://cdn.test/not-a-module.js' */
      return { object, text, pattern };
    `;
    expect(() => assertRemoteModulePolicy(
      source, false, { allowReturnOutsideFunction: true },
    )).not.toThrow();
  });

  test('current worker JavaScript syntax remains accepted by the parser gate', () => {
    const source = `
      class Box { #value = 1; static { this.ready = true; } read = () => this.#value; }
      const result = new Box().read?.() ?? 0;
      return { result, ready: Box.ready };
    `;
    const entryOptions = { allowReturnOutsideFunction: true };
    expect(() => assertRemoteModulePolicy(source, false, entryOptions)).not.toThrow();
    expect(() => assertRemoteModulePolicy(source, true, entryOptions)).not.toThrow();
  });

  test('Preview leaves supported static remote literals to the audited resolver path', () => {
    expect(() => assertRemoteModulePolicy("import 'https:\\x2f\\x2fcdn.test/mod.js'", true))
      .not.toThrow();
  });

  test.each([
    'await import(url)',
    "await import('./local.js')",
    "await import('https://cdn.test/mod.js')",
    "await import('./local.js', { with: { type: 'json' } })",
    "import source from './local.js' with { type: 'json' };",
    "await import('data:text/javascript,export default 1')",
    "import '/peerd-runtime/loop.js';",
  ])('Preview also refuses native syntax the resolver cannot audit: %s', (source) => {
    expectPolicyRefusal(source, UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE, true);
  });

  test.each(['toString', 'constructor', '__proto__'])('policy lookup ignores inherited key: %s', (code) => {
    expect(moduleImportPolicyMessage(code)).toBe(null);
  });

  test('invalid JavaScript is identified as syntax, not import resolution', () => {
    try {
      assertRemoteModulePolicy('const = 1', false);
      throw new Error('expected syntax failure');
    } catch (error) {
      expect((error as { code?: string }).code).toBe(MODULE_SYNTAX_ERROR_CODE);
      expect(String(error)).toContain('JavaScript syntax error');
    }
  });

  test('module parsing refuses a top-level return while entry parsing permits it', () => {
    expectPolicyRefusal('return 1;', MODULE_SYNTAX_ERROR_CODE);
    expect(() => assertRemoteModulePolicy(
      'return 1;', false, { allowReturnOutsideFunction: true },
    )).not.toThrow();
  });
});
