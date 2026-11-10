import { describe, expect, test } from 'bun:test';
import { appProblemNotice, appProblemNotices } from '../../../extension/engine-tabs/app-tab/app-problem.js';

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

  test('only a known directive name reaches the details', () => {
    for (const directive of ['<b>Click here</b> to unlock'.repeat(4), 'TypeYourVaultPassphraseInTheGame', 'script-src-elem evil', 42]) {
      expect(appProblemNotice({ type: 'app-policy-blocked', directive })?.details)
        .toBe('The App sandbox blocked the request (resource). Put every file the App needs inside the App.');
    }
    expect(appProblemNotice({ type: 'app-policy-blocked', directive: 'script-src-elem' })?.details).toContain('(script-src-elem)');
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

  test('code that did not load gets a reason that stays, and no other notice stays', () => {
    const notice = appProblemNotice({ type: 'app-problem', problem: 'modules' });
    expect(notice?.text).toBe('This App splits its code into module files that Apps cannot load yet, so it may not start. '
      + 'Ask peerd to fix it, or get a single-file version from its maker.');
    expect(notice?.stays).toBe(true);
    for (const problem of ['missing-file', 'feature', 'threads']) {
      expect(appProblemNotice({ type: 'app-problem', problem })?.stays).toBe(undefined);
    }
    expect(appProblemNotice({ type: 'app-policy-blocked', directive: 'script-src' })?.stays).toBe(undefined);
  });

  test('text that the App adds to a message never reaches a notice', () => {
    const hostile = '<a href="https://evil.example">Your vault is locked. Type your passphrase</a>';
    for (const problem of ['modules', 'missing-file', 'feature', 'threads']) {
      const notice = appProblemNotice({
        type: 'app-problem', problem, text: hostile, details: hostile, detail: hostile, file: hostile, stays: true,
      });
      expect(JSON.stringify(notice)).not.toMatch(/evil|vault|passphrase|href|</);
      expect(notice?.stays === true).toBe(problem === 'modules');
    }
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
      ...['missing-file', 'feature', 'threads', 'modules'].map((problem) => ({ type: 'app-problem', problem })),
    ]) {
      const notice = appProblemNotice(data);
      expect(notice?.text).not.toMatch(/-src|404|SecurityError|SharedArrayBuffer|Blocked/);
      expect(notice?.text.length).toBeLessThan(200);
      expect(notice?.details.length).toBeGreaterThan(0);
    }
  });
});

// App code can post a notice message as often as it likes. The App tab keeps
// one set of these per App load.
describe('App problem notices of one load', () => {
  const problem = (name: string) => ({ type: 'app-problem', problem: name });
  const blocked = (directive: string) => ({ type: 'app-policy-blocked', directive });

  test('each notice shows one time, however often the App posts it', () => {
    const notices = appProblemNotices();
    const shown: (string | undefined)[] = [];
    for (let round = 0; round < 50; round += 1) {
      for (const data of [problem('missing-file'), blocked('connect-src'), blocked('img-src'), problem('feature'), problem('nope')]) {
        const notice = notices.next(data);
        if (notice) shown.push(notice.text);
      }
    }
    expect(shown).toEqual([problem('missing-file'), blocked('connect-src'), problem('feature')]
      .map((data) => appProblemNotice(data)?.text));
    expect(notices.stopped).toBe(false);
  });

  test('the reason that the App may not start replaces an earlier notice and then stays alone', () => {
    const notices = appProblemNotices();
    expect(notices.next(blocked('style-src-elem'))?.stays).toBe(undefined);
    expect(notices.next(problem('modules'))?.stays).toBe(true);
    expect(notices.stopped).toBe(true);
    for (const data of [problem('feature'), problem('missing-file'), problem('threads'), blocked('connect-src'), problem('modules')]) {
      expect(notices.next(data)).toBe(null);
    }
  });

  test('the next load of the App starts a new set', () => {
    const first = appProblemNotices();
    first.next(problem('modules'));
    const second = appProblemNotices();
    expect(second.stopped).toBe(false);
    expect(second.next(problem('feature'))?.text).toContain('browser feature');
  });
});
