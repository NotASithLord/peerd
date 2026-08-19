import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const workflow = readFileSync(
  join(import.meta.dir, '..', '..', '.github', 'workflows', 'package-and-release.yml'),
  'utf8',
);

describe('release feed publication hook', () => {
  test('dispatches the exact released tag from an isolated post-release job', () => {
    const notify = workflow.slice(workflow.indexOf('\n  notify-site:'));
    expect(notify).toContain('needs: release');
    expect(notify).toContain('environment: release-notify');
    expect(notify).not.toContain('environment: release\n');
    expect(notify).toContain('secrets.PEERD_SITE_DISPATCH_TOKEN');
    expect(notify).toContain('repos/NotASithLord/peerd-site/dispatches');
    expect(notify).toContain('-f event_type=peerd-release');
    expect(notify).toContain('-F "client_payload[tag]=$GITHUB_REF_NAME"');
    expect(notify).toContain('for attempt in 1 2 3');
    expect(notify).toContain('sleep "$delay"');
    expect(notify).toContain('dispatch failed after 3 attempts');
  });

  test('a missing hook credential is visible and retryable, never a green skip', () => {
    const notify = workflow.slice(workflow.indexOf('\n  notify-site:'));
    expect(notify).toContain('if [ -z "$GH_TOKEN" ]');
    expect(notify).toContain('exit 1');
    expect(notify).not.toContain('exit 0');
    expect(notify).not.toContain('scheduled sync remains the fallback');
  });
});
