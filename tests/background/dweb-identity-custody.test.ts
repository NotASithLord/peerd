import { describe, expect, test } from 'bun:test';
import {
  identityChangeBlockedByApps, makeDwebIdentityCustody,
} from '../../extension/background/dweb-identity-custody.js';

const makeFixture = (overrides: any = {}) => {
  let stored: string | null = overrides.stored ?? null;
  let writes = 0;
  const audits: any[] = [];
  const custody = makeDwebIdentityCustody({
    enabled: true,
    active: () => true,
    vault: {
      isLocked: () => false,
      getSecret: async () => stored,
      setSecret: async (_name: string, value: string) => { stored = value; writes++; },
      ...overrides.vault,
    },
    auditLog: {
      append: async (entry: any) => { audits.push(entry); },
      ...overrides.auditLog,
    },
    identitySecretName: 'distributed/identity/v1',
    withIdentityMutation: async (operation: () => Promise<any>) => operation(),
    canChangeIdentity: async () => true,
    ...overrides.deps,
  });
  return { custody, audits, get stored() { return stored; }, get writes() { return writes; } };
};

describe('dweb identity custody', () => {
  test('recognizes current and legacy local publisher bindings only', () => {
    expect(identityChangeBlockedByApps([{ shared: true }])).toBe(true);
    expect(identityChangeBlockedByApps([{
      shared: false, dweb: { local: true, publisher: 'did:key:zLegacy' },
    }])).toBe(true);
    expect(identityChangeBlockedByApps([{
      shared: false, dweb: { local: true, publisher: null },
    }])).toBe(false);
    expect(identityChangeBlockedByApps([{
      shared: false, dweb: { local: false, publisher: 'did:key:zPeer' },
    }])).toBe(false);
  });

  test('reads and first-mints the root inside the custody handler', async () => {
    const fixture = makeFixture();
    expect(await fixture.custody.handle('get')).toEqual({ ok: true, value: null });
    expect(await fixture.custody.handle('set', { value: 'root' })).toEqual({ ok: true });
    expect(fixture.stored).toBe('root');
    expect(fixture.audits).toEqual([{ type: 'dweb_identity_issued', details: {} }]);
  });

  test('fails closed when disabled, locked, or given a non-string root', async () => {
    const disabled = makeFixture({ deps: { enabled: false } });
    expect(await disabled.custody.handle('get')).toEqual({ ok: false, error: 'dweb-disabled' });
    const locked = makeFixture({ vault: { isLocked: () => true } });
    expect(await locked.custody.handle('get')).toEqual({ ok: false, error: 'vault-locked' });
    const fixture = makeFixture();
    expect(await fixture.custody.handle('set', { value: 3 })).toEqual({ ok: false, error: 'value-required' });
  });

  test('rechecks inside the mutation lane and never overwrites a recovered root', async () => {
    const fixture = makeFixture({ stored: 'recovered-root' });
    expect(await fixture.custody.handle('set', { value: 'stale-mint' }))
      .toEqual({ ok: false, error: 'identity-already-exists' });
    expect(fixture.writes).toBe(0);
  });

  test('blocks first mint while a local shared app still depends on the missing root', async () => {
    const fixture = makeFixture({
      deps: { canChangeIdentity: async () => false },
    });
    expect(await fixture.custody.handle('set', { value: 'replacement-root' }))
      .toEqual({ ok: false, error: 'identity-in-use' });
    expect(fixture.writes).toBe(0);
  });

  test('does not report a durable mint as failed when audit append fails', async () => {
    const fixture = makeFixture({
      auditLog: { append: async () => { throw new Error('audit unavailable'); } },
    });
    expect(await fixture.custody.handle('set', { value: 'root' })).toEqual({ ok: true });
    expect(fixture.stored).toBe('root');
  });
});
