import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DESIGN-18: an API actor's accumulated memory is durable on its session, but the
// (chat,origin) routing binding is ephemeral. The "memory survives a browser restart"
// guarantee depends on resolveApiActor RECONNECTING to the durable actor (via
// sessions.findActorSession) on a binding miss BEFORE minting a fresh empty one. That
// wiring lives in service-worker.js (no bun import), so assert against the SOURCE TEXT
// like web-write-grant-scope.test.ts — reverting to mint-on-miss fails these. The leaf
// findActorSession + listApiIntegrations pieces are unit-tested separately.
const src = readFileSync(
  join(import.meta.dir, '../../extension/background/service-worker.js'),
  'utf8',
);

describe('service worker — API actor reconnects to durable memory before minting', () => {
  test('resolveApiActor reconnects via findActorSession on a binding miss', () => {
    // The reconnect lookup is keyed by the origin (instanceId) + the owner chat, scoped
    // to a web/api actor.
    expect(src).toMatch(/findActorSession\(\{\s*parentSessionId:\s*ownerChatId,\s*instanceId:\s*origin,\s*actorType:\s*'web',\s*backing:\s*'api'\s*\}\)/);
  });

  test('the reconnect re-binds the cache and PRECEDES the mintOnce fallback', () => {
    const reconnectIdx = src.indexOf('const reconnected = await sessions.findActorSession');
    const rebindIdx = src.indexOf('apiActorBindings.bind(ownerChatId, origin, reconnected)');
    const mintIdx = src.indexOf("await mintOnce(`api:${ownerChatId}:${origin}`");
    expect(reconnectIdx).toBeGreaterThan(-1);
    expect(rebindIdx).toBeGreaterThan(reconnectIdx);   // re-bind after a hit
    expect(mintIdx).toBeGreaterThan(reconnectIdx);     // mint is the LAST resort, after reconnect
  });

  test('listApiIntegrations unions formed + keyed and swallows a locked vault', () => {
    // formed (chat bindings) ∪ keyed (vault origins), and a vault read failure degrades
    // to formed-only rather than throwing.
    expect(src).toMatch(/apiActorBindings\.originsFor\(chatId\)/);
    expect(src).toMatch(/names\.map\(originFromSecretName\)/);
    expect(src).toMatch(/catch\s*\{\s*keyed = \[\];/);
  });
});
