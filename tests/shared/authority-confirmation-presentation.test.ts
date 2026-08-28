import { describe, expect, test } from 'bun:test';
import {
  AUTHORITY_CONFIRMATION_OPERATIONS,
  authorityEffectConfirmationPresentation,
} from '../../extension/shared/authority-confirmation-presentation.js';
import { CONTROLLER_DOMAIN_OPERATIONS } from '../../extension/shared/controller-kernel-quota.js';

const target = `turn.vm.write-text-file:vm-1:${'a'.repeat(64)}`;

describe('exact authority confirmation presentation', () => {
  test('covers every non-read operation that can reach authority preparation', () => {
    const expected = Object.entries(CONTROLLER_DOMAIN_OPERATIONS)
      .filter(([operation, policy]) => operation !== 'turn.goal.complete' && policy.riskClass !== 'read')
      .map(([operation]) => operation).sort();
    expect([...AUTHORITY_CONFIRMATION_OPERATIONS].sort()).toEqual(expected);
  });

  test.each([
    ['turn.vm.write-text-file', { vmId: 'vm-1', path: '/work/result.txt', content: 'secret' }, ['vmId: vm-1', 'path: /work/result.txt', 'content: 6 bytes; contents hidden']],
    ['turn.actor.message', { to: 'reviewer', message: 'check the result', awaitReply: true }, ['to: reviewer', 'message: check the result']],
    ['turn.app.act', { appId: 'app-1', action: 'save', params: { draft: true } }, ['appId: app-1', 'action: save', 'params:']],
    ['turn.schedule.cancel-routine', { id: 'routine-7' }, ['id: routine-7']],
    ['turn.execution.run-script', { code: 'workspace.write("secret")', workspace: true }, ['code: 25 bytes; contents hidden', 'workspace: true']],
  ] as const)('shows final bounded details for %s', (operation, args, fragments) => {
    const presentation = authorityEffectConfirmationPresentation(operation, args, target);
    expect(presentation).not.toBeNull();
    for (const fragment of fragments) expect(presentation?.summary).toContain(fragment);
    expect(presentation?.summary).not.toContain('workspace.write');
  });

  test('projects nested final page args and safe URL identity', () => {
    const presentation = authorityEffectConfirmationPresentation(
      'turn.page.navigate',
      { args: { url: 'https://user:secret@example.com/path?token=hidden' } },
      `turn.page.navigate:tab-1:${'b'.repeat(64)}`,
    );
    expect(presentation).toMatchObject({ origins: ['https://example.com'] });
    expect(presentation?.summary).toContain('url: https://example.com/path (query fields: token)');
    expect(presentation?.summary).not.toContain('secret');
    expect(presentation?.summary).not.toContain('hidden');
  });

  test('fails closed for an unknown mutating operation', () => {
    expect(authorityEffectConfirmationPresentation(
      'turn.future.write', { path: '/tmp/x' }, target,
    )).toBeNull();
  });
});
