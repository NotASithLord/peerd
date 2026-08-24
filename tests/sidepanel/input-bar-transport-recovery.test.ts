import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';

describe('composer transport recovery', () => {
  test('worker loss restores the human draft without advertising a Class-E replay', () => {
    const source = readFileSync(
      join(EXTENSION_DIR, 'sidepanel/components/input-bar.js'), 'utf8',
    );
    expect(source).toContain('Check this chat before sending the restored draft again.');
    expect(source).toContain('Check this chat before sending it again; your goal remains in the composer.');
    expect(source).toContain("reply?.outcomeKnown === false");
    expect(source).not.toContain('service stopped responding. Your draft was restored; try again.');
    expect(source).not.toContain('service stopped responding. Your goal is still here; try again.');
    expect(source).toContain('operationId = `send.${Date.now().toString(36)}.${crypto.randomUUID()}`');
    expect(source).toContain('hadAttachments: !!attachments');
    expect(source).toContain("'Check delivery'");
    expect(source).toContain("'I checked; allow a new message'");
    expect(source).toContain('clear only the local');
    expect(source).toContain('saveUnconfirmed(sid, null)');
    expect(source).toContain('operationId: pending.operationId');
    expect(source).toContain("type: 'agent/send', checkOnly: true");
    expect(source).not.toContain("text: pending.text, goal: pending.goal");
    expect(source).toContain('attached files will never be resent by this check');
    expect(source).toContain('Never persist attachment bytes');
    expect(source).toContain('sessionId: sid ?? null');
    expect(source).toContain('!!ui.unconfirmedSend');
    expect(source).toContain("role: unavailableCopy || ui.sendError ? 'alert' : 'status'");
  });
});
