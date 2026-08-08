import { afterEach, describe, expect, test } from 'bun:test';
import { dispatchToolCall } from '../../../extension/peerd-runtime/tools/dispatcher.js';
import { siteClientWriteTool } from '../../../extension/peerd-runtime/tools/defs/site-client-write.js';
import { clearTools, registerTool } from '../../../extension/peerd-runtime/tools/registry.js';

afterEach(() => clearTools());

const context = (over: Record<string, unknown> = {}) => ({
  audit: async () => {},
  hooks: [],
  session: { sessionId: 'bound-a' },
  permission: { mode: 'act', confirmActions: true },
  exposure: 'actor',
  actorType: 'web',
  backing: 'tab',
  actorSurface: 'tools',
  denylist: [],
  canUseSiteClientOrigin: (origin: string) => origin === 'https://a.test',
  ...over,
});

const call = {
  id: 'write-a',
  name: 'site_client_write',
  args: {
    origin: 'https://a.test', summary: 'own client', endpoints: [], auth: 'none',
    deriver: 'probe', body: 'return { own: true };',
  },
};

describe('site-client dispatch confirmation ordering', () => {
  test('live-custody refusal happens before any generic or dossier prompt', async () => {
    registerTool(siteClientWriteTool);
    let prompts = 0;
    let storeEffects = 0;
    const result = await dispatchToolCall(call as any, context({
      authorizeSiteClientOrigin: async () => false,
      confirm: async () => { prompts += 1; return 'yes_once'; },
      siteClients: {
        get: async () => { storeEffects += 1; return null; },
        put: async () => { storeEffects += 1; return {}; },
      },
    }) as any);

    expect(result.ok).toBe(false);
    expect((result as any).error).toStartWith('site_client_origin_refused');
    expect(prompts).toBe(0);
    expect(storeEffects).toBe(0);
  });

  test('an owned write receives exactly the detailed tool confirmation', async () => {
    registerTool(siteClientWriteTool);
    const prompts: any[] = [];
    let puts = 0;
    const result = await dispatchToolCall(call as any, context({
      authorizeSiteClientOrigin: async (origin: string) => origin === 'https://a.test',
      confirm: async (prompt: any) => { prompts.push(prompt); return 'yes_once'; },
      siteClients: {
        get: async () => null,
        put: async ({ dossier, body }: any) => {
          puts += 1;
          return { ...dossier, sizeBytes: body.length };
        },
      },
    }) as any);

    expect(result.ok).toBe(true);
    expect(puts).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ tool: 'site_client_write', origins: ['https://a.test'] });
    expect(prompts[0].proposal.body).toBe('return { own: true };');
  });
});
