// Auto-memory pure core: the extraction-trigger decision matrix, the
// transcript digest, the frugal extraction prompt, output parsing, and
// the user-doc append.

import { describe, test, expect } from 'bun:test';
import {
  shouldExtract, substantiveStats, transcriptDigest,
  buildExtractionTask, parseExtractionNotes, dedupeAgainstDoc,
  appendNoteToUserDoc,
  AUTO_MEMORY_MIN_USER_TURNS, AUTO_MEMORY_MIN_NEW_USER_TURNS,
  MAX_NOTES_PER_EXTRACTION, NOTE_MAX_CHARS,
} from '../../../extension/peerd-runtime/memory/auto-memory.js';

const userMsg = (text: string, i = 0) => ({ role: 'user', content: text, id: `u${i}`, when: i });
const asstMsg = (text: string, i = 0) => ({ role: 'assistant', content: text, id: `a${i}`, when: i });
const toolResultMsg = (i = 0) => ({
  role: 'user', content: '', id: `tr${i}`, when: i,
  toolResults: [{ tool_use_id: `t${i}`, content: 'r' }],
});

// A session with n substantive user turns (long enough to clear the
// chars floor) interleaved with assistant replies.
const chatSession = (n: number, extra: any = {}) => ({
  sessionId: 's1',
  kind: 'chat',
  messages: Array.from({ length: n }, (_, i) => [
    userMsg(`please help with my ongoing project, step ${i}, with plenty of words`, i * 2),
    asstMsg(`done with step ${i}, here is a reasonably long answer for you`, i * 2 + 1),
  ]).flat(),
  ...extra,
});

describe('substantiveStats', () => {
  test('counts typed user turns and assistant replies, skips tool results and synthetic', () => {
    const stats = substantiveStats([
      userMsg('hello there'),
      toolResultMsg(1),
      { ...userMsg('a trim summary', 2), synthetic: true },
      asstMsg('hi!', 3),
      { role: 'assistant', content: '', id: 'a4', when: 4 },   // empty → not substantive
      userMsg('   ', 5),                                        // whitespace → not substantive
    ] as any);
    expect(stats.userTurns).toBe(1);
    expect(stats.assistantReplies).toBe(1);
    expect(stats.chars).toBe('hello there'.length + 'hi!'.length);
  });
});

describe('shouldExtract', () => {
  test('fires for a substantive chat with no watermark', () => {
    const d = shouldExtract({ session: chatSession(AUTO_MEMORY_MIN_USER_TURNS) });
    expect(d.extract).toBe(true);
    expect(d.stats!.userTurns).toBe(AUTO_MEMORY_MIN_USER_TURNS);
  });

  test('decision matrix: missing / subagent / thin sessions are skipped', () => {
    expect(shouldExtract({ session: null }).reason).toBe('no-session');
    expect(shouldExtract({ session: chatSession(9, { kind: 'subagent' }) }).reason).toBe('not-a-chat');
    expect(shouldExtract({ session: chatSession(AUTO_MEMORY_MIN_USER_TURNS - 1) }).reason).toBe('too-few-turns');
    // Enough turns but trivial content.
    const thin = {
      kind: 'chat',
      messages: Array.from({ length: AUTO_MEMORY_MIN_USER_TURNS }, (_, i) => userMsg('hi', i)),
    };
    expect(shouldExtract({ session: thin }).reason).toBe('too-little-content');
  });

  test('watermark: a repeat trigger without new substance is skipped', () => {
    const n = AUTO_MEMORY_MIN_USER_TURNS + 1;
    const session = chatSession(n, { autoMemory: { at: 1, userTurns: n } });
    expect(shouldExtract({ session }).reason).toBe('no-new-substance');
    // … but enough NEW turns past the watermark re-qualifies.
    const grown = chatSession(n + AUTO_MEMORY_MIN_NEW_USER_TURNS, { autoMemory: { at: 1, userTurns: n } });
    expect(shouldExtract({ session: grown }).extract).toBe(true);
  });
});

describe('transcriptDigest', () => {
  test('keeps user/assistant text, drops tool results and synthetic entries', () => {
    const digest = transcriptDigest([
      userMsg('book me a flight'),
      toolResultMsg(1),
      { ...userMsg('old summary', 2), synthetic: true },
      asstMsg('booked it', 3),
    ] as any);
    expect(digest).toBe('User: book me a flight\nAssistant: booked it');
  });

  test('elides the middle when over budget', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => userMsg(`turn ${i} ${'z'.repeat(150)}`, i));
    const digest = transcriptDigest(msgs as any, { maxChars: 2000 });
    expect(digest).toContain('[... elided ...]');
    expect(digest).toContain('turn 0');
    expect(digest).toContain('turn 99');
  });
});

describe('buildExtractionTask', () => {
  test('demands frugality, shows the current doc, demands JSON', () => {
    const task = buildExtractionTask({ digest: 'User: hi', userDocBody: '- Name: Ariel' });
    expect(task).toContain('extremely frugal');
    expect(task).toContain('{"notes": []}');
    expect(task).toContain('- Name: Ariel');
    expect(task).toContain('User: hi');
    expect(task).toContain(String(MAX_NOTES_PER_EXTRACTION));
  });

  test('an empty user doc renders as (none)', () => {
    expect(buildExtractionTask({ digest: 'x' })).toContain('(none)');
  });
});

describe('parseExtractionNotes', () => {
  test('strict JSON path, with fences and prose tolerated', () => {
    expect(parseExtractionNotes('{"notes":["works at Hydra Host"]}'))
      .toEqual(['works at Hydra Host']);
    expect(parseExtractionNotes('Here you go:\n```json\n{"notes":["a","b"]}\n```'))
      .toEqual(['a', 'b']);
    expect(parseExtractionNotes('{"notes":[]}')).toEqual([]);
  });

  test('bullet fallback when the model ignored the JSON format', () => {
    expect(parseExtractionNotes('- prefers dark mode\n- builds a CRX extension'))
      .toEqual(['prefers dark mode', 'builds a CRX extension']);
  });

  test('caps count and length, dedupes case-insensitively, never throws', () => {
    const notes = parseExtractionNotes(JSON.stringify({
      notes: ['A', 'a', 'B'.repeat(NOTE_MAX_CHARS * 2), 'c', 'd', 'e'],
    }));
    expect(notes.length).toBe(MAX_NOTES_PER_EXTRACTION);
    expect(notes[1].length).toBe(NOTE_MAX_CHARS);
    expect(parseExtractionNotes('')).toEqual([]);
    expect(parseExtractionNotes('{broken json')).toEqual([]);
    expect(parseExtractionNotes('no structure at all')).toEqual([]);
  });
});

describe('dedupeAgainstDoc', () => {
  test('drops notes the doc already contains (collapsed, case-insensitive)', () => {
    const doc = '# User memory\n\n- Works at  HYDRA host\n- Prefers tabs';
    expect(dedupeAgainstDoc(['works at Hydra Host', 'lives in Miami'], doc))
      .toEqual(['lives in Miami']);
  });

  test('empty doc keeps everything', () => {
    expect(dedupeAgainstDoc(['a'], '')).toEqual(['a']);
  });
});

describe('appendNoteToUserDoc', () => {
  test('fresh doc gets the shared title + a Notes section', () => {
    expect(appendNoteToUserDoc('', 'works at Hydra Host'))
      .toBe('# User memory\n\n## Notes\n- works at Hydra Host\n');
  });

  test('existing doc without a Notes section gains one at the end', () => {
    const out = appendNoteToUserDoc('# User memory\n\n## About the user\n- Name: Ariel', 'prefers dark mode');
    expect(out).toBe('# User memory\n\n## About the user\n- Name: Ariel\n\n## Notes\n- prefers dark mode\n');
  });

  test('appends INSIDE an existing Notes section, before later sections', () => {
    const prior = '# User memory\n\n## Notes\n- first note\n\n## Projects\n- peerd';
    const out = appendNoteToUserDoc(prior, 'second note');
    expect(out).toBe('# User memory\n\n## Notes\n- first note\n- second note\n\n## Projects\n- peerd\n');
  });

  test('repeated approvals keep a single growing list', () => {
    let body = appendNoteToUserDoc('', 'one');
    body = appendNoteToUserDoc(body, 'two');
    expect(body).toBe('# User memory\n\n## Notes\n- one\n- two\n');
  });

  test('an empty note is a no-op', () => {
    expect(appendNoteToUserDoc('keep me', '   ')).toBe('keep me');
  });
});
