import { describe, test, expect } from 'bun:test';

let mod: typeof import('../../../extension/peerd-runtime/skills/parse.js');
mod = await import('../../../extension/peerd-runtime/skills/parse.js');
const { parseSkillMd, normalizeName, SkillParseError } = mod;

describe('parseSkillMd — frontmatter + body', () => {
  test('splits frontmatter from body', () => {
    const src = [
      '---',
      'name: pdf-filler',
      'description: Fill PDF forms from a data map. Use when filling forms.',
      'version: 1.2.0',
      '---',
      '# PDF Filler',
      '',
      'Step 1. Do the thing.',
    ].join('\n');
    const r = parseSkillMd(src);
    expect(r.name).toBe('pdf-filler');
    expect(r.description).toContain('Fill PDF forms');
    expect(r.version).toBe('1.2.0');
    expect(r.body).toBe('# PDF Filler\n\nStep 1. Do the thing.');
    // The body must NOT contain frontmatter — that's the whole disclosure split.
    expect(r.body).not.toContain('description:');
  });

  test('normalizes a human name to a hyphenated handle', () => {
    const src = '---\nname: PDF Filler!!\ndescription: x y z\n---\nbody';
    expect(parseSkillMd(src).name).toBe('pdf-filler');
    expect(normalizeName('  Web Scraper Pro ')).toBe('web-scraper-pro');
  });

  test('throws on missing frontmatter fence', () => {
    expect(() => parseSkillMd('# Just markdown, no frontmatter')).toThrow(SkillParseError);
  });

  test('throws when name or description is missing', () => {
    expect(() => parseSkillMd('---\nname: x\n---\nbody')).toThrow(SkillParseError);
    expect(() => parseSkillMd('---\ndescription: x\n---\nbody')).toThrow(SkillParseError);
  });

  test('strips a UTF-8 BOM before parsing', () => {
    const src = '﻿---\nname: a\ndescription: d\n---\nbody';
    expect(parseSkillMd(src).name).toBe('a');
  });

  test('rejects an oversized body', () => {
    const big = 'x'.repeat(70 * 1024);
    const src = `---\nname: a\ndescription: d\n---\n${big}`;
    expect(() => parseSkillMd(src)).toThrow(/body is .* bytes/);
  });
});

describe('parseSkillMd — Claude Code / Codex compatibility', () => {
  test('parses a Claude-Code-format skill with allowed-tools and metadata', () => {
    // Shape emitted by Claude Code's skill authoring: quoted description,
    // a flow list of allowed tools, extra keys peerd preserves but ignores.
    const src = [
      '---',
      'name: commit-helper',
      "description: 'Write a conventional commit message. Use after staging changes.'",
      'allowed-tools: [Bash, Read, Edit]',
      'license: MIT',
      'metadata:',
      '  author: someone',
      '  category: git',
      '---',
      '## Instructions',
      'Run `git diff --staged` then write the message.',
    ].join('\n');
    const r = parseSkillMd(src);
    expect(r.name).toBe('commit-helper');
    expect(r.description).toBe('Write a conventional commit message. Use after staging changes.');
    expect(r.allowedTools).toEqual(['Bash', 'Read', 'Edit']);
    expect(r.license).toBe('MIT');
    // metadata is an unknown-to-peerd key → preserved under extra, never behaviour.
    expect(r.extra.metadata).toBeDefined();
    expect(r.body).toContain('git diff --staged');
  });

  test('parses a block-list form of allowed-tools (Gemini/Codex style)', () => {
    const src = [
      '---',
      'name: lint',
      'description: Lint the project.',
      'allowed-tools:',
      '  - Bash',
      '  - Read',
      '---',
      'body',
    ].join('\n');
    const r = parseSkillMd(src);
    expect(r.allowedTools).toEqual(['Bash', 'Read']);
  });

  test('tolerates comments and blank lines in frontmatter', () => {
    const src = [
      '---',
      '# a comment',
      'name: x  # inline comment',
      '',
      'description: hello world',
      '---',
      'body',
    ].join('\n');
    const r = parseSkillMd(src);
    expect(r.name).toBe('x');
    expect(r.description).toBe('hello world');
  });
});


describe('multi-line skill descriptions', () => {
  test.each(['>', '>-', '>+', '>2', '>2-', '>+2', '|', '|-', '|+', '|2', '|2-', '|+2'])('reads %s block text', (indicator) => {
    const description = indicator.startsWith('>') ? 'Write release notes. Use when shipping.' : 'Write release notes.\nUse when shipping.';
    const text = `---\nname: release-notes\ndescription: ${indicator}\n  Write release notes.\n  Use when shipping.\nversion: 1.2\n---\nKeep the body.`;
    expect(parseSkillMd(text)).toMatchObject({ name: 'release-notes', description, version: '1.2', body: 'Keep the body.' });
  });

  test.each([
    'description: Use version 3.\n  Keep the next line.',
    'description: "Use version 3.\n  Keep the next line."',
    "description: 'Use version 3.\n  Keep the next line.'",
    'description:\n  "Use version 3.\n  Keep the next line."',
    'description:\n  Use version 3.\n  Keep the next line.',
  ])('reads a continued scalar', (description) => {
    expect(parseSkillMd(`---\nname: continued\n${description}\n---\nBody`).description)
      .toBe('Use version 3. Keep the next line.');
  });

  test('keeps folded paragraphs, deeper indentation and nested metadata', () => {
    const text = '---\nname: paragraphs\ndescription: >\n  First.\n\n  Second.\n    Keep indentation.\n\n    Keep this paragraph.\n  Last.\n\n  Next.\n\n  Final.\nmetadata:\n  author: local\nallowed-tools:\n  -\n  - Read\n---\nBody';
    expect(parseSkillMd(text)).toMatchObject({ description: 'First.\nSecond.\n  Keep indentation.\n\n  Keep this paragraph.\nLast.\nNext.\nFinal.',
      extra: { metadata: { author: 'local' } }, allowedTools: ['', 'Read'] });
  });

  test('rejects an empty block and strips a hyphen at the name limit', () => {
    expect(() => parseSkillMd('---\nname: empty\ndescription: >-\n---\nBody')).toThrow(SkillParseError);
    expect(normalizeName(`${'a'.repeat(63)}-longer`)).toBe('a'.repeat(63));
  });
});
