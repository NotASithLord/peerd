import { describe, expect, test } from 'bun:test';
import { createDwebToolAuthority } from '../../extension/background/dweb-tool-authority.js';

describe('exact dweb authority', () => {
  test('pins publication arguments and confirms before mesh mutation', async () => {
    const events: string[] = [];
    const authority = createDwebToolAuthority({
      call: { name: 'dweb_share', args: { appId: 'app-1' } },
      ctx: {
        permission: { confirmActions: false },
        confirm: async () => { events.push('confirm'); return 'yes_once'; },
        dweb: {
          share: async (appId: string) => {
            events.push(`share:${appId}`);
            return { ok: true, uri: 'peerd://app-1' };
          },
        },
      },
    });
    await expect(authority.publishConfirmedApp('app-2'))
      .rejects.toThrow('dweb authority mismatch');
    expect(await authority.publishConfirmedApp('app-1'))
      .toEqual({ ok: true, uri: 'peerd://app-1' });
    expect(events).toEqual(['confirm', 'share:app-1']);
  });

  test('decline is known before publication and never reaches the mesh', async () => {
    let shared = false;
    const authority = createDwebToolAuthority({
      call: { name: 'dweb_share', args: { appId: 'app-1' } },
      ctx: {
        permission: { confirmActions: false },
        confirm: async () => 'no',
        dweb: { share: async () => { shared = true; return { ok: true }; } },
      },
    });
    expect(await authority.publishConfirmedApp('app-1'))
      .toEqual({ ok: false, error: 'declined', declined: true });
    expect(shared).toBe(false);
  });
});
