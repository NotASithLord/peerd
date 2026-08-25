import { describe, test, expect } from 'bun:test';
import {
  normalizeGitRemote, gitRemoteOwnsRequest, smartHttpAuthHeader,
  createGitHttpClient,
} from '../../extension/peerd-engine/repository/remote.js';
import { createRepositoryService } from '../../extension/peerd-engine/repository/repository-service.js';

describe('browser Git remote boundary', () => {
  test('canonicalizes HTTPS repository URLs and rejects embedded authority', () => {
    expect(normalizeGitRemote('https://GitHub.com/owner/repo').url)
      .toBe('https://github.com/owner/repo.git');
    for (const url of [
      'http://github.com/o/r',
      'https://token@github.com/o/r',
      'https://localhost/o/r',
      'https://127.0.0.1/o/r',
      'https://github.com/one',
      'https://github.com/o/r?token=x',
      'https://github.com:444/o/r',
    ]) expect(() => normalizeGitRemote(url)).toThrow();
  });

  test('owns only the exact Smart HTTP endpoints under the bound repository', () => {
    const remote = normalizeGitRemote('https://github.com/o/r');
    expect(gitRemoteOwnsRequest(remote, 'https://github.com/o/r.git/info/refs?service=git-upload-pack')).toBe(true);
    expect(gitRemoteOwnsRequest(remote, 'https://github.com/o/r.git/git-receive-pack')).toBe(true);
    expect(gitRemoteOwnsRequest(remote, 'https://github.com/o/r2.git/info/refs')).toBe(false);
    expect(gitRemoteOwnsRequest(remote, 'https://evil.example/o/r.git/info/refs')).toBe(false);
    expect(gitRemoteOwnsRequest(remote, 'https://github.com/o/r.git/objects/secret')).toBe(false);
  });

  test('strips caller credentials and injects the host token only after binding', async () => {
    const remote = normalizeGitRemote('https://github.com/o/r');
    let seen: any = null;
    const http = createGitHttpClient({
      remote,
      getSecret: async (name) => name === 'git:github.com' ? 'fine-grained-token' : null,
      webFetch: async (url, init) => {
        seen = { url, init };
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } });
      },
    });
    const response = await http.request({
      url: 'https://github.com/o/r.git/git-upload-pack', method: 'POST',
      headers: { Authorization: 'Bearer attacker', Cookie: 'sid=attacker', Accept: 'x' },
      body: [new Uint8Array([9])],
    });
    expect(seen.init.credentials).toBe('omit');
    expect(seen.init.redirect).toBe('manual');
    expect(seen.init.headers.Cookie).toBeUndefined();
    expect(seen.init.headers.Authorization).toBe(smartHttpAuthHeader('github.com', 'fine-grained-token'));
    const chunks = [];
    for await (const chunk of response.body) chunks.push(...chunk);
    expect(chunks).toEqual([1, 2, 3]);
    await expect(http.request({ url: 'https://evil.example/o/r.git/info/refs' })).rejects.toThrow('escaped');
  });

  test('fetches the checked-out branch instead of an unrelated remote default', async () => {
    let options: any = null;
    const git = {
      resolveRef: async ({ ref }: any) => ref === 'HEAD' ? 'head-oid' : 'fetched-oid',
      getConfig: async () => 'https://github.com/o/r.git',
      currentBranch: async () => 'acceptance/cutover',
      fetch: async (value: any) => {
        options = value;
        throw Object.assign(new Error('Could not find HEAD.'), {
          code: 'NotFoundError', data: { what: 'HEAD' },
        });
      },
    };
    const repositories = createRepositoryService({
      loadGit: async () => git,
      fs: {} as any,
      webFetch: async () => new Response(),
    });
    expect(await repositories.fetch({ kind: 'app', id: 'app-1' })).toMatchObject({
      fetchHead: 'fetched-oid', fetchHeadDescription: null,
    });
    expect(options.ref).toBe('acceptance/cutover');
    expect(options.singleBranch).toBe(true);
  });

  test('does not convert a missing requested branch into a successful fetch', async () => {
    const git = {
      resolveRef: async () => 'head-oid',
      getConfig: async () => 'https://github.com/o/r.git',
      currentBranch: async () => 'missing',
      fetch: async () => {
        throw Object.assign(new Error('Could not find missing.'), {
          code: 'NotFoundError', data: { what: 'missing' },
        });
      },
    };
    const repositories = createRepositoryService({
      loadGit: async () => git,
      fs: {} as any,
      webFetch: async () => new Response(),
    });
    await expect(repositories.fetch({ kind: 'app', id: 'app-1' }))
      .rejects.toMatchObject({ code: 'NotFoundError', data: { what: 'missing' } });
  });

});
