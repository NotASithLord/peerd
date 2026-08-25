import { describe, expect, test } from 'bun:test';
import { makeKernelGitCredentialRoutes } from '../../extension/background/kernel-credential-routes.js';
import { makeGitCredentialRoutes } from '../../extension/peerd-engine/vm-net/git-credential-routes.js';

const fixture = () => {
  const secrets = new Map<string, string>([['provider:anthropic', 'x']]);
  const audit: any[] = [];
  const vault = {
    listSecretNames: async () => [...secrets.keys()],
    getSecret: async (name: string) => secrets.get(name) ?? null,
    setSecret: async (name: string, value: string) => { secrets.set(name, value); },
    deleteSecret: async (name: string) => { secrets.delete(name); },
  };
  const native = makeKernelGitCredentialRoutes({
    vault, auditLog: { append: async (event: any) => { audit.push(event); } },
    isLockedError: (cause: any) => cause?.code === 'locked',
  });
  const legacy = makeGitCredentialRoutes({
    vault, isLockedError: (cause: any) => cause?.code === 'locked',
    audit: (event: any) => audit.push(event),
  });
  return { native, legacy, secrets, audit };
};

describe('native Git credential custody', () => {
  test('matches legacy validation and projects host names without secret values', async () => {
    for (const route of ['git-cred/set', 'git-cred/list', 'git-cred/delete'] as const) {
      const left = fixture();
      const right = fixture();
      const message = route === 'git-cred/set'
        ? { host: 'https://WWW.GitHub.com/org/repo', token: 'secret-token-123' }
        : route === 'git-cred/delete' ? { host: 'github.com' } : {};
      expect(await left.native[route](message)).toEqual(await right.legacy[route](message));
    }
    const { native, secrets } = fixture();
    await native['git-cred/set']({ host: 'github.com', token: 'secret-token-123' });
    const listed = await native['git-cred/list']();
    expect(listed).toEqual({ ok: true, hosts: ['github.com'] });
    expect(JSON.stringify(listed)).not.toContain('secret-token-123');
    expect(secrets.get('git:github.com')).toBe('secret-token-123');
  });

  test('keeps malformed writes known-safe and audit records token-free', async () => {
    const { native, audit, secrets } = fixture();
    expect(await native['git-cred/set']({ host: 'localhost', token: 'secret-token-123' }))
      .toEqual({ ok: false, error: 'bad-host' });
    expect(await native['git-cred/set']({ host: 'github.com', token: 'short' }))
      .toEqual({ ok: false, error: 'bad-token' });
    expect([...secrets.keys()]).toEqual(['provider:anthropic']);
    expect(JSON.stringify(audit)).not.toContain('secret-token-123');
  });

  for (const implementation of ['native', 'legacy'] as const) {
    test(`${implementation} treats commit-then-loss as unknown and exact replay as idempotent`, async () => {
      const secrets = new Map<string, string>([['git:github.com', 'old-token-123']]);
      const audit: any[] = [];
      let writes = 0;
      const vault = {
        listSecretNames: async () => [...secrets.keys()],
        getSecret: async (name: string) => secrets.get(name) ?? null,
        setSecret: async (name: string, value: string) => {
          writes += 1;
          secrets.set(name, value);
          if (writes === 1) throw new Error('completion lost');
        },
        deleteSecret: async (name: string) => { secrets.delete(name); },
      };
      const routes = implementation === 'native'
        ? makeKernelGitCredentialRoutes({
            vault, auditLog: { append: async (event: any) => { audit.push(event); } },
            isLockedError: () => false,
          })
        : makeGitCredentialRoutes({
            vault, isLockedError: () => false, audit: (event: any) => audit.push(event),
          });
      const exact = { host: 'github.com', token: 'replacement-token-456' };
      expect(await routes['git-cred/set'](exact)).toMatchObject({
        ok: false, code: 'git-credential-outcome-unknown',
        outcomeKnown: false, retryable: false,
      });
      expect(secrets.get('git:github.com')).toBe(exact.token);
      expect(await routes['git-cred/set'](exact)).toEqual({ ok: true, host: 'github.com' });
      expect(writes).toBe(1);
      expect(audit).toEqual([]);
    });
  }
});
