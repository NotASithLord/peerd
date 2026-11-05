import { describe, expect, test } from 'bun:test';
import { appProblemNotice } from '../../../extension/engine-tabs/app-tab/app-problem.js';

// The App frame reports why part of an App did not load. App code can post the
// same messages, so the notice must stay plain, fixed text.
describe('App problem notice', () => {
  test('a sandbox block reads as plain words and keeps the directive in the details', () => {
    const notice = appProblemNotice({ type: 'app-policy-blocked', directive: 'connect-src' });
    expect(notice?.text).toBe('This App tried to load something that is not one of its files. '
      + 'Apps work offline, so that part did not load.');
    expect(notice?.text).not.toContain('connect-src');
    expect(notice?.details).toContain('(connect-src)');
  });

  test('a directive from the App is cleaned before it reaches the details', () => {
    const notice = appProblemNotice({ type: 'app-policy-blocked', directive: '<b>Click here</b> to unlock'.repeat(4) });
    expect(notice?.details).not.toContain('<');
    expect(notice?.details).not.toContain(' to ');
    expect(appProblemNotice({ type: 'app-policy-blocked', directive: 42 })?.details).toContain('(resource)');
  });

  test('a missing file, a refused feature, and missing threads each get their own plain cause', () => {
    expect(appProblemNotice({ type: 'app-problem', problem: 'missing-file' })?.text)
      .toContain('asked for a file that it does not have');
    expect(appProblemNotice({ type: 'app-problem', problem: 'feature' })?.text)
      .toContain('such as saving in the browser');
    expect(appProblemNotice({ type: 'app-problem', problem: 'threads' })?.text)
      .toContain('This App needs threads');
    expect(appProblemNotice({ type: 'app-problem', problem: 'threads' })?.details).toContain('SharedArrayBuffer');
  });

  test('an unknown problem or message shows nothing', () => {
    for (const data of [
      null, 'app-problem', { type: 'app-problem', problem: 'toString' },
      { type: 'app-problem', problem: '__proto__' }, { type: 'app-problem', problem: 'Your vault is open' },
      { type: 'app-link', href: 'https://example.com' },
    ]) expect(appProblemNotice(data)).toBe(null);
  });

  test('every notice keeps technical words out of its main text', () => {
    for (const data of [
      { type: 'app-policy-blocked', directive: 'script-src' },
      ...['missing-file', 'feature', 'threads'].map((problem) => ({ type: 'app-problem', problem })),
    ]) {
      const notice = appProblemNotice(data);
      expect(notice?.text).not.toMatch(/-src|404|SecurityError|SharedArrayBuffer|Blocked/);
      expect(notice?.text.length).toBeLessThan(200);
      expect(notice?.details.length).toBeGreaterThan(0);
    }
  });
});
