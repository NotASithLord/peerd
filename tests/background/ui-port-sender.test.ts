import { describe, expect, test } from 'bun:test';
import { isAuthorizedUiPortSender } from '../../extension/background/ui-port-sender.js';

describe('UI port sender mapping', () => {
  const predicates = {
    sidepanel: (sender: unknown) => sender === 'panel',
    home: (sender: unknown) => sender === 'home',
    evaluation: (sender: unknown) => sender === 'eval',
  };

  test('each state-bearing name accepts only its owning page predicate', () => {
    expect(isAuthorizedUiPortSender('sidepanel', 'panel', predicates)).toBe(true);
    expect(isAuthorizedUiPortSender('sidepanel', 'home', predicates)).toBe(false);
    expect(isAuthorizedUiPortSender('home', 'home', predicates)).toBe(true);
    expect(isAuthorizedUiPortSender('home', 'panel', predicates)).toBe(false);
    expect(isAuthorizedUiPortSender('eval', 'eval', predicates)).toBe(true);
    expect(isAuthorizedUiPortSender('eval', 'home', predicates)).toBe(false);
  });

  test('unknown port names fail closed', () => {
    expect(isAuthorizedUiPortSender('engine-forged', 'panel', predicates)).toBe(false);
  });
});
