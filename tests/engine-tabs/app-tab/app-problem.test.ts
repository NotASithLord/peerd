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
    expect(notice?.text).toBe('This App splits its code into module files that Apps cannot load yet, so it may not work. '
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
  const text = (data: unknown) => appProblemNotice(data)?.text;

  test('a notice shows at most one time in 6 seconds, however often the App posts it', () => {
    let time = 0;
    const notices = appProblemNotices(() => time);
    const shown: string[] = [];
    for (time = 0; time < 12_000; time += 10) {
      for (const data of [problem('missing-file'), blocked('connect-src'), blocked('img-src'), problem('feature'), problem('nope')]) {
        const notice = notices.next(data);
        if (notice) shown.push(`${time} ${notice.text}`);
      }
    }
    const texts = [problem('missing-file'), blocked('connect-src'), problem('feature')].map(text);
    expect(shown).toEqual([0, 6000].flatMap((at) => texts.map((each) => `${at} ${each}`)));
  });

  test('a later sandbox block gets its notice again, also after the reason that stays', () => {
    let time = 0;
    const notices = appProblemNotices(() => time);
    expect(notices.next(blocked('img-src'))?.text).toBe(text(blocked('img-src')));
    expect(notices.next(problem('modules'))?.stays).toBe(true);
    time = 5999;
    expect(notices.next(blocked('connect-src'))).toBe(null);
    time = 9000;
    expect(notices.next(blocked('connect-src'))?.text).toBe(text(blocked('img-src')));
    expect(notices.next(problem('feature'))?.text).toContain('browser feature');
  });

  test('a notice that is still on screen is kept when its problem comes again, and Dismiss ends that', () => {
    let time = 0;
    const notices = appProblemNotices(() => time);
    const offline = text(blocked('img-src'));
    expect(notices.next(blocked('img-src'))?.text).toBe(offline);
    // The problem repeats each second. The App tab gives the text on screen and restarts the close timer.
    for (time = 1000; time <= 20_000; time += 1000) {
      expect(notices.next(blocked('connect-src'), offline)?.text).toBe(offline);
    }
    // The user closes the notice. The same text does not come back for 6 seconds.
    time = 20_500;
    expect(notices.next(blocked('img-src'), undefined)).toBe(null);
    time = 25_999;
    expect(notices.next(blocked('img-src'), null)).toBe(null);
    time = 26_000;
    expect(notices.next(blocked('img-src'))?.text).toBe(offline);
    // Another notice on screen does not keep this one. The reason that stays still shows one time.
    time = 27_000;
    expect(notices.next(blocked('img-src'), 'Only confirmed HTTP(S) links can leave an App.')).toBe(null);
    const stays = text(problem('modules'));
    expect(notices.next(problem('modules'), stays)?.stays).toBe(true);
    expect(notices.next(problem('modules'), stays)).toBe(null);
  });

  test('the reason that stays shows one time for a load', () => {
    let time = 0;
    const notices = appProblemNotices(() => time);
    expect(notices.next(problem('modules'))?.stays).toBe(true);
    for (time = 1; time < 100_000; time += 5000) expect(notices.next(problem('modules'))).toBe(null);
  });
});
