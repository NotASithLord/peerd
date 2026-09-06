import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertGitFixtureBinding,
  assertSecretlessGitReport,
  buildGitFixtureBinding,
  GIT_FIXTURE_HOST,
  GIT_FIXTURE_REMOTE,
  redactGitFixtureCredential,
  startGitSmartHttpFixture,
  summarizeGitFixtureRequests,
} from '../../scripts/acceptance/git-smart-http-fixture.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const run = (args: string[], cwd: string, env: Record<string, string> = {}) =>
  new Promise<Buffer>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(Buffer.concat(stderr).toString('utf8')));
    });
  });

describe('secretless local Smart HTTP acceptance fixture', () => {
  test('binds the system and Apple Git version formats exactly', () => {
    const hashes = {
      certificateSha256: 'a'.repeat(64), protocolSha256: 'b'.repeat(64),
    };
    for (const gitVersion of ['git version 2.50.1', 'git version 2.50.1.windows.1', 'git version 2.50.1 (Apple Git-155)']) {
      expect(assertGitFixtureBinding(buildGitFixtureBinding({ gitVersion, ...hashes })).gitVersion)
        .toBe(gitVersion);
    }
    expect(() => assertGitFixtureBinding(buildGitFixtureBinding({
      gitVersion: 'git version 2.50.1 arbitrary', ...hashes,
    }))).toThrow(/binding is invalid/);
  });

  test('serves an authenticated push and clean clone through its loopback CONNECT proxy', async () => {
    const fixture = await startGitSmartHttpFixture();
    const root = mkdtempSync(join(tmpdir(), 'peerd-smart-http-test-'));
    roots.push(root);
    try {
      const work = join(root, 'work');
      const clone = join(root, 'clone');
      await run(['init', work], root);
      await run(['config', 'user.name', 'Peerd Acceptance'], work);
      await run(['config', 'user.email', 'acceptance@peerd.test'], work);
      writeFileSync(join(work, 'index.html'), '<!doctype html><title>fixture</title>');
      await run(['add', 'index.html'], work);
      await run(['commit', '-m', 'fixture commit'], work);
      await run(['branch', '-M', 'acceptance/cutover'], work);
      await run(['remote', 'add', 'origin', GIT_FIXTURE_REMOTE], work);
      const credential = fixture.credential();
      const gitArgs = [
        '-c', `http.proxy=${fixture.proxyServer.url}`,
        '-c', `http.extraHeader=Authorization: ${credential.authorization}`,
        '-c', 'http.sslVerify=false',
      ];
      await run([...gitArgs, 'push', 'origin', 'acceptance/cutover'], work);
      await run([
        ...gitArgs, 'clone', '--branch', 'acceptance/cutover',
        '--single-branch', GIT_FIXTURE_REMOTE, clone,
      ], root);
      expect(readFileSync(join(clone, 'index.html'), 'utf8'))
        .toBe('<!doctype html><title>fixture</title>');
      const verified = await fixture.verifyBranch('acceptance/cutover', {
        'index.html': '<!doctype html><title>fixture</title>',
      });
      expect(verified.oid).toMatch(/^[a-f0-9]{40,64}$/);
      const snapshot = fixture.snapshot();
      expect(summarizeGitFixtureRequests(snapshot.requests)).toEqual({
        receiveInfoRefs: 1,
        receivePack: 1,
        uploadInfoRefs: 1,
        uploadPack: 1,
        total: 4,
      });
      expect(snapshot.requests.every((entry: any) => entry.authenticated)).toBe(true);
      expect(JSON.stringify({ binding: fixture.binding(), snapshot }))
        .not.toContain(credential.token);
      expect(JSON.stringify({ binding: fixture.binding(), snapshot }))
        .not.toContain(credential.authorization);
      expect(fixture.binding()).toMatchObject({
        schema: 1,
        host: GIT_FIXTURE_HOST,
        remote: GIT_FIXTURE_REMOTE,
      });
    } finally {
      await fixture.close();
    }
  }, 20_000);

  test('fails closed when report evidence contains fixture credential material', async () => {
    const fixture = await startGitSmartHttpFixture();
    try {
      const credential = fixture.credential();
      expect(assertSecretlessGitReport({ ok: true }, credential)).toEqual({ ok: true });
      expect(() => assertSecretlessGitReport({ leaked: credential.token }, credential))
        .toThrow(/credential material/);
      expect(() => assertSecretlessGitReport({ leaked: credential.authorization }, credential))
        .toThrow(/credential material/);
      const redacted = redactGitFixtureCredential(
        `failure ${credential.token} ${credential.authorization}`,
        credential,
      );
      expect(redacted).not.toContain(credential.token);
      expect(redacted).not.toContain(credential.authorization);
      expect(redacted.match(/fixture-credential-redacted/g)?.length).toBe(2);
    } finally {
      await fixture.close();
    }
  });
});
