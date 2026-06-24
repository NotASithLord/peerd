import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The web-write session grant ("approve for this session" on a non-GET egress
// prompt) must be scoped to the HOST the prompt named — not the bare 'web:write'
// tool key — so one approval for host A does NOT silently authorize body-carrying
// egress to every other host for the rest of the session. confirmAction lives in
// service-worker.js (no bun import), so assert against the SOURCE TEXT, like
// offscreen-gate.test.ts. Reverting to a tool-only grant key fails these.
const src = readFileSync(
  join(import.meta.dir, '../../extension/background/service-worker.js'),
  'utf8',
);

describe('service worker — web-write session grant is host-scoped', () => {
  test('the web-write grant key folds in the prompt origin', () => {
    expect(src).toMatch(/grantKey\s*=\s*prompt\.tool\s*===\s*WEB_WRITE_CONFIRM_KEY[\s\S]{0,140}?prompt\.origins\b/);
  });
  test('both the grant check and the grant record use grantKey, not prompt.tool', () => {
    expect(src).toMatch(/sessionConfirmGrants\.get\(sid\)\?\.has\(grantKey\)/);
    expect(src).toMatch(/\.add\(grantKey\)/);
  });
});
