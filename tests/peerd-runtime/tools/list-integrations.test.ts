// DESIGN-18 P2 — list_integrations is the discovery surface for API actors (the
// list_tabs analog): the orchestrator sees which origins it can address, which it has
// already worked this chat (formed), and which carry a stored key (keyed).

import { describe, test, expect } from 'bun:test';
import { listIntegrationsTool } from '../../../extension/peerd-runtime/tools/defs/list-integrations.js';

describe('list_integrations', () => {
  test('returns the SW-computed integrations (formed ∪ keyed)', async () => {
    const integrations = [
      { origin: 'https://api.github.com', keyed: true, formed: true },
      { origin: 'https://api.publicdata.org', keyed: false, formed: true },
      { origin: 'https://api.stripe.com', keyed: true, formed: false },
    ];
    const r = await listIntegrationsTool.execute({}, { listApiIntegrations: async () => integrations } as any);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    const out = JSON.parse(r.content!);
    expect(out.count).toBe(3);
    expect(out.integrations).toEqual(integrations);
  });

  test('fails SOFT (empty) when the capability is unwired (tests / non-SW dispatch)', async () => {
    const r = await listIntegrationsTool.execute({}, {} as any);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(JSON.parse(r.content!)).toEqual({ count: 0, integrations: [] });
  });

  test('surfaces a thrown capability error as an actionable failure', async () => {
    const r = await listIntegrationsTool.execute({}, { listApiIntegrations: async () => { throw new Error('boom'); } } as any);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.error).toContain('boom');
  });

  test('is a read tool with no declared origins (pure enumeration)', () => {
    expect(listIntegrationsTool.sideEffect).toBe('read');
    expect(listIntegrationsTool.origins?.({}, {} as any)).toEqual([]);
  });
});
