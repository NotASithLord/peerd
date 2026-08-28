import { describe, expect, test } from 'bun:test';
import { authorityEffectResourceKey } from '../../extension/background/authority-effect-resource.js';

describe('authority effect resource identity', () => {
  test.each([
    ['app', 'app-1', 'turn.app.write-file', { appId: 'forged' }, 'instance:app:app-1'],
    ['app', 'app-1', 'turn.repository.checkout', { name: 'main' }, 'instance:app:app-1'],
    ['app', 'app-1', 'turn.editing.write-target', { kind: 'notebook', targetId: 'forged' }, 'instance:app:app-1'],
    ['notebook', 'nb-1', 'turn.notebook.write-file', { notebookId: 'forged' }, 'instance:notebook:nb-1'],
    ['notebook', 'nb-1', 'turn.repository.restore', { to: 'HEAD' }, 'instance:notebook:nb-1'],
    ['notebook', 'nb-1', 'turn.editing.write-target', { kind: 'app', targetId: 'forged' }, 'instance:notebook:nb-1'],
  ] as const)(
    '%s actor maps %s to its authoritative instance lane',
    (actorType, actorInstanceId, operation, args, expected) => {
      expect(authorityEffectResourceKey(operation, args, {
        actorType, actorInstanceId, session: { sessionId: 'session-1' },
      })).toBe(expected);
    },
  );

  test('unbound editing and repository operations share an explicit target lane', () => {
    const ctx = { session: { sessionId: 'session-1' } };
    expect(authorityEffectResourceKey(
      'turn.editing.write-target', { kind: 'app', targetId: 'app-2' }, ctx,
    )).toBe('instance:app:app-2');
    expect(authorityEffectResourceKey(
      'turn.repository.checkout', { kind: 'app', targetId: 'app-2' }, ctx,
    )).toBe('instance:app:app-2');
  });

  test('a Web actor keeps one page lane across first-tab adoption', () => {
    const before = authorityEffectResourceKey('turn.page.navigate', {
      url: 'https://example.com/',
    }, {
      actorType: 'web', actorInstanceId: 'web-actor-1', activeTab: null,
      authorityPageResourceKey: 'page:actor:session-1',
      session: { sessionId: 'session-1' },
    });
    const after = authorityEffectResourceKey('turn.page.click', {
      selector: '#continue', tabId: 7,
    }, {
      actorType: 'web', actorInstanceId: 'web-actor-1',
      activeTab: { id: 7, url: 'https://example.com/' },
      authorityPageResourceKey: 'page:actor:session-1',
      session: { sessionId: 'session-1' },
    });
    expect(before).toBe('page:actor:session-1');
    expect(after).toBe(before);
  });

  test('established tab actors share only their host-owned tab lane', () => {
    const first = {
      actorType: 'web', actorInstanceId: 'web',
      actorBacking: 'tab',
      authorityPageResourceKey: 'page:tab:7',
      activeTab: { id: 7 }, session: { sessionId: 'actor-a' },
    };
    const sameTabSibling = {
      actorType: 'web', actorInstanceId: 'web',
      actorBacking: 'tab',
      authorityPageResourceKey: 'page:tab:7',
      activeTab: { id: 7 }, session: { sessionId: 'actor-b' },
    };
    const otherTab = {
      actorType: 'web', actorInstanceId: 'web',
      actorBacking: 'tab',
      authorityPageResourceKey: 'page:tab:8',
      activeTab: { id: 8 }, session: { sessionId: 'actor-c' },
    };
    expect(authorityEffectResourceKey('turn.page.click', {}, first)).toBe('page:tab:7');
    expect(authorityEffectResourceKey('turn.page.fill', {}, sameTabSibling)).toBe('page:tab:7');
    expect(authorityEffectResourceKey('turn.page.click', {}, otherTab)).toBe('page:tab:8');
    expect(authorityEffectResourceKey(
      'turn.site-client.capture-start', {}, first,
    )).toBe('page:tab:7');
    expect(authorityEffectResourceKey(
      'turn.site-client.run', { origin: 'https://api.example.test' }, first,
    )).toBe('page:tab:7');
    expect(authorityEffectResourceKey(
      'turn.site-client.run', { origin: 'https://api.example.test' }, {
        ...first, actorBacking: 'api', authorityPageResourceKey: undefined,
        activeTab: null, actorInstanceId: 'https://api.example.test',
      },
    )).toBe('siteclient:https://api.example.test');
  });
});
