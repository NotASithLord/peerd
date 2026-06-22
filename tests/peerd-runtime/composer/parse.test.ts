import { describe, test, expect } from 'bun:test';
import {
  parseComposer, parseCommandName, parseCommandArgs, parseRefs, activeTrigger,
} from '../../../extension/peerd-runtime/composer/parse.js';

describe('parseCommandName', () => {
  test('recognises a leading slash command', () => {
    expect(parseCommandName('/review')).toBe('review');
    expect(parseCommandName('/run-tests now')).toBe('run-tests');
    expect(parseCommandName('   /deploy')).toBe('deploy');
  });
  test('rejects non-command leading slashes', () => {
    expect(parseCommandName('//')).toBeNull();
    expect(parseCommandName('/ foo')).toBeNull();
    expect(parseCommandName('hello /review')).toBeNull(); // not at start
  });
  test('a pasted path is not a command (lookahead requires a token boundary)', () => {
    // `/path/to/file` has no whitespace/end right after `path`, so the
    // (?=\s|$) lookahead fails — it is treated as literal text, not a
    // command. This keeps the user from accidentally invoking `/path`.
    expect(parseCommandName('/path/to/file')).toBeNull();
  });
});

describe('parseCommandArgs', () => {
  test('captures free text after the command on the first line', () => {
    expect(parseCommandArgs('/review the auth flow')).toBe('the auth flow');
    expect(parseCommandArgs('/review')).toBe('');
    expect(parseCommandArgs('/review  spaced  ')).toBe('spaced');
  });
  test('only the first line is the arg', () => {
    expect(parseCommandArgs('/summarize this\nand more')).toBe('this');
  });
});

describe('parseRefs — @tab and @file', () => {
  test('bare @tab → active tab reference', () => {
    const refs = parseRefs('summarize @tab please');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: 'tab', arg: '', raw: '@tab' });
  });
  test('@tab:123 → specific tab id', () => {
    const refs = parseRefs('compare @tab:42 and @tab:7');
    expect(refs.map((r) => r.arg)).toEqual(['42', '7']);
    expect(refs.every((r) => r.kind === 'tab')).toBe(true);
  });
  test('@file:path/to.md → file reference', () => {
    const refs = parseRefs('see @file:notes/todo.md');
    expect(refs[0]).toMatchObject({ kind: 'file', arg: 'notes/todo.md' });
  });
  test('strips a trailing sentence period from a file path', () => {
    const refs = parseRefs('open @file:readme.md.');
    expect(refs[0].arg).toBe('readme.md');
    expect(refs[0].raw).toBe('@file:readme.md');
  });
  test('an email address is NOT a reference (word-boundary anchor)', () => {
    expect(parseRefs('mail me at ariel@tab.com')).toHaveLength(0);
    expect(parseRefs('user@file.io')).toHaveLength(0);
  });
  test('offsets point at the exact source span', () => {
    const src = 'x @tab y';
    const [r] = parseRefs(src);
    expect(src.slice(r.start, r.end)).toBe('@tab');
  });
});

describe('parseComposer — combined', () => {
  test('a command with an embedded reference', () => {
    const p = parseComposer('/summarize @tab');
    expect(p.command).toBe('summarize');
    expect(p.refs).toHaveLength(1);
    expect(p.refs[0].kind).toBe('tab');
  });
});

describe('activeTrigger — live palette triggering', () => {
  test('opens on a slash at message start', () => {
    const t = activeTrigger('/rev', 4);
    expect(t).toMatchObject({ type: 'command', query: 'rev' });
  });
  test('does not open for a slash mid-message', () => {
    expect(activeTrigger('hi /rev', 7)).toBeNull();
  });
  test('opens a bare @ as a ref trigger with no kind yet', () => {
    const t = activeTrigger('do @', 4);
    expect(t).toMatchObject({ type: 'ref', kind: undefined, query: '' });
  });
  test('@ta → ref trigger, query "ta", no kind committed', () => {
    const t = activeTrigger('@ta', 3);
    expect(t).toMatchObject({ type: 'ref', query: 'ta' });
  });
  test('@file: → ref trigger kind=file, empty query', () => {
    const t = activeTrigger('@file:', 6);
    expect(t).toMatchObject({ type: 'ref', kind: 'file', query: '' });
  });
  test('@file:no → ref trigger kind=file, query "no"', () => {
    const t = activeTrigger('@file:no', 8);
    expect(t).toMatchObject({ type: 'ref', kind: 'file', query: 'no' });
  });
  test('closes once whitespace follows the token', () => {
    expect(activeTrigger('@tab done', 9)).toBeNull();
  });
  test('from/to bracket the trigger span', () => {
    const t = activeTrigger('go @ta', 6)!;
    expect(t.from).toBe(3);
    expect(t.to).toBe(6);
  });
});
