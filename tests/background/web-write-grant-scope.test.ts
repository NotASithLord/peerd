import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The session grant ("approve for this session") must be scoped to the ORIGIN
// the prompt named — not the bare tool key — so one approval on host A does NOT
// silently authorize the same tool on every other host for the rest of the
// session. R5 generalized the original web-write host scoping to EVERY tool
// whose prompt carries origins, through the pure confirmGrantKey
// (background/confirm-grant-key.js, bun-tested directly). confirmAction lives
// in service-worker.js (no bun import), so assert against the SOURCE TEXT that
// the generalized key is what the grant cache uses. Reverting to a tool-only
// grant key fails these.
const src = readFileSync(
  join(import.meta.dir, '../../extension/background/service-worker.js'),
  'utf8',
);
const grantPolicySrc = readFileSync(
  join(import.meta.dir, '../../extension/background/confirm-session-grants.js'),
  'utf8',
);

describe('service worker — session grants are origin-scoped', () => {
  test('the grant key comes from the origin-folding confirmGrantKey', () => {
    expect(src).toContain('answerWithSessionConfirmGrant({');
    expect(src).toMatch(/from '\.\/confirm-session-grants\.js'/);
    expect(grantPolicySrc).toMatch(/from '\.\/confirm-grant-key\.js'/);
  });
  test('both the grant check and the grant record use grantKey, not prompt.tool', () => {
    expect(grantPolicySrc).toContain('cachedSessionConfirmAnswer({');
    expect(grantPolicySrc).toContain('rememberSessionConfirmAnswer({');
    expect(grantPolicySrc).toContain('.has(confirmGrantKey(prompt))');
    expect(grantPolicySrc).toContain('.add(confirmGrantKey(prompt))');
  });
});
