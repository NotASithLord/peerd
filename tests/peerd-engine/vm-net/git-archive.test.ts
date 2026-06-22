import { describe, test, expect } from 'bun:test';
import {
  parseRepoUrl,
  archiveCandidates,
  defaultBranchProbe,
} from '../../../extension/peerd-engine/vm-net/git-archive.js';

describe('parseRepoUrl', () => {
  test('parses github with .git suffix', () => {
    const p = parseRepoUrl('https://github.com/NotASithLord/peerd.git');
    expect(p).toMatchObject({ host: 'github.com', kind: 'github', owner: 'NotASithLord', repo: 'peerd', path: 'NotASithLord/peerd' });
  });

  test('parses gitlab subgroups, keeping the full namespace in path', () => {
    const p = parseRepoUrl('https://gitlab.com/group/subgroup/proj');
    expect(p).toMatchObject({ kind: 'gitlab', owner: 'group', repo: 'proj', path: 'group/subgroup/proj' });
  });

  test('unknown host falls back to kind=unknown', () => {
    expect(parseRepoUrl('https://git.example.org/a/b')?.kind).toBe('unknown');
  });

  test('rejects non-https and single-segment paths', () => {
    expect(parseRepoUrl('git@github.com:a/b.git')).toBeNull();
    expect(parseRepoUrl('https://github.com/justone')).toBeNull();
  });
});

describe('archiveCandidates', () => {
  test('github: explicit ref → one /archive/<ref>.zip', () => {
    const p = parseRepoUrl('https://github.com/a/b')!;
    const c = archiveCandidates(p, 'v1.2.3');
    expect(c).toHaveLength(1);
    expect(c[0].url).toBe('https://github.com/a/b/archive/v1.2.3.zip');
  });

  test('no ref → tries main then master', () => {
    const p = parseRepoUrl('https://github.com/a/b')!;
    const c = archiveCandidates(p);
    expect(c.map((x) => x.url)).toEqual([
      'https://github.com/a/b/archive/main.zip',
      'https://github.com/a/b/archive/master.zip',
    ]);
  });

  test('gitlab archive URL embeds repo-ref name', () => {
    const p = parseRepoUrl('https://gitlab.com/g/s/proj')!;
    expect(archiveCandidates(p, 'main')[0].url)
      .toBe('https://gitlab.com/g/s/proj/-/archive/main/proj-main.zip');
  });

  test('unknown host tries github-style then gitlab-style per ref', () => {
    const p = parseRepoUrl('https://git.example.org/a/b')!;
    const c = archiveCandidates(p, 'main');
    expect(c).toHaveLength(2);
    expect(c[0].note).toContain('github-style');
    expect(c[0].url).toBe('https://git.example.org/a/b/archive/main.zip');
    expect(c[1].note).toContain('gitlab-style');
    expect(c[1].url).toBe('https://git.example.org/a/b/-/archive/main/b-main.zip');
  });

  test('encodes refs with slashes (feature branches)', () => {
    const p = parseRepoUrl('https://github.com/a/b')!;
    expect(archiveCandidates(p, 'feature/x')[0].url)
      .toBe('https://github.com/a/b/archive/feature%2Fx.zip');
  });
});

describe('defaultBranchProbe', () => {
  test('github → api.github.com repo endpoint', () => {
    const p = parseRepoUrl('https://github.com/a/b')!;
    expect(defaultBranchProbe(p)).toEqual({ url: 'https://api.github.com/repos/a/b', jsonPath: ['default_branch'] });
  });

  test('gitlab url-encodes the project path', () => {
    const p = parseRepoUrl('https://gitlab.com/g/s/proj')!;
    expect(defaultBranchProbe(p)?.url).toBe('https://gitlab.com/api/v4/projects/g%2Fs%2Fproj');
  });

  test('unknown host has no probe', () => {
    expect(defaultBranchProbe(parseRepoUrl('https://git.example.org/a/b')!)).toBeNull();
  });
});

