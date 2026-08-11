import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(
  import.meta.dir,
  '../../extension/background/debugger-pool.js',
), 'utf8');

const clickBody = source.slice(
  source.indexOf('const clickBackendNode ='),
  source.indexOf('const setValueBackendNode ='),
);
const typeBody = source.slice(
  source.indexOf('const setValueBackendNode ='),
  source.indexOf('const readFrameworkState ='),
);

describe('CDP native form submission guard', () => {
  test('both action bodies resolve nodes in an extension-owned isolated world', () => {
    const helper = source.slice(
      source.indexOf('const isolatedActionContext ='),
      source.indexOf('const readFromExpectedDocument ='),
    );
    expect(helper).toContain("'Page.createIsolatedWorld'");
    expect(helper).toContain("worldName: 'peerd-browser-action'");
    expect(helper).toContain('runtimeDocumentMatches(tabId, contextId, expectedDocument)');
    expect(clickBody).toContain('isolatedActionContext(tabId, bound, expectedDocument)');
    expect(clickBody).toContain('executionContextId: actionContextId');
    expect(typeBody).toContain('isolatedActionContext(tabId, bound, expectedDocument)');
    expect(typeBody).toContain('executionContextId: actionContextId');
  });

  test('click resolves form and submitter overrides before activation', () => {
    expect(clickBody).toContain("this.closest('button,input')");
    expect(clickBody).toContain("this.closest('label')");
    expect(clickBody).toContain('activationLabel.control');
    expect(clickBody).toContain("getAttribute.call(submitter, 'formaction')");
    expect(clickBody).toContain("getAttribute.call(form, 'action')");
    expect(clickBody).toContain("method !== 'dialog'");
    expect(clickBody).toContain("error: 'cross_origin_form_submission_blocked'");
    expect(clickBody.indexOf('cross_origin_form_submission_blocked'))
      .toBeLessThan(clickBody.indexOf('${OBS_SETUP}'));
    expect(clickBody).toContain("outcomeKind: 'pre-effect-failure'");
  });

  test('type checks the live form before setting the value or firing events', () => {
    expect(typeBody).toContain('var targetForm = submit ? this.form : null;');
    expect(typeBody).toContain("targetFormMethod || 'get'");
    expect(typeBody).toContain("Element.prototype.getAttribute.call(targetForm, 'action')");
    expect(typeBody).toContain("error: 'cross_origin_form_submission_blocked'");
    expect(typeBody.indexOf('cross_origin_form_submission_blocked'))
      .toBeLessThan(typeBody.indexOf("if (typeof this.focus === 'function')"));
    expect(typeBody).toContain("outcomeKind: 'pre-effect-failure'");
  });
});
