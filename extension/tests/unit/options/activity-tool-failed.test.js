// @ts-check
// Options → Activity: host-stamped semantic verdicts flow through the real
// hash-chained audit log into the human-readable severity view. The semantic
// heap never authors the authority claim this UI displays.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { semanticCallAuditEntry } from '/background/semantic-call-audit.js';
import { createAuditLog, idb } from '/peerd-egress/index.js';
import { ActivityView, activityEventMeta } from '/options/sections/activity.js';

/** @param {(msg: any) => Promise<any>} send */
const mount = (send) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(ActivityView, { send }) });
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => m.redraw.sync?.() ?? m.redraw());

/** @param {Partial<any>} [over] */
const receipt = (over = {}) => ({
  callId: 'call-1', effectId: 'call-1:1', operation: 'turn.vm.read',
  outcome: 'observed', outcomeKnown: true, performed: false, retryable: true,
  ...over,
});

/** @param {string} callId @param {any} result */
const auditEntry = (callId, result) => semanticCallAuditEntry({
  sessionId: 's1', callId, label: 'fixture_tool', result,
});

describe('options.activity: host-derived semantic verdicts', () => {
  it('uses warning severity for known blocks/refusals and danger only for unknown custody', () => {
    const cases = [
      [{ type: 'tool_blocked', details: {} }, 'warn', 'tool blocked'],
      [{
        type: 'authority_effect',
        details: { outcome: 'not-performed', outcomeKnown: true, refused: true },
      }, 'warn', 'authority effect refused'],
      [{
        type: 'authority_effect_failed',
        details: { outcome: 'not-performed', outcomeKnown: true, refused: true },
      }, 'warn', 'authority effect refused'],
      [{
        type: 'authority_effect_failed',
        details: { outcome: 'observed', outcomeKnown: true, refused: false },
      }, 'warn', 'authority effect failed'],
      [{
        type: 'authority_effect',
        details: { outcome: 'performed', outcomeKnown: true, performed: true },
      }, 'ok', 'authority effect performed'],
      [{
        type: 'authority_effect_failed',
        details: { outcome: 'unknown', outcomeKnown: false },
      }, 'danger', 'authority effect unverified'],
    ];
    for (const [entry, level, label] of cases) {
      expect(activityEventMeta(/** @type {any} */ (entry))).toEqual({ level, label });
    }
  });

  it('renders receipt-owned authority severity from the real audit log', async () => {
    await idb.clear('audit_log');
    await idb.clear('audit_meta');
    const log = createAuditLog({ idb });

    await log.append(auditEntry('semantic-only', { is_error: false }));
    await log.append(auditEntry('known-read-failure', {
      is_error: true, authorityReceipts: [receipt()],
    }));
    await log.append(auditEntry('refused-write', {
      is_error: true,
      authorityReceipts: [receipt({ refused: true, code: 'declined', outcome: 'not-performed' })],
    }));
    await log.append(auditEntry('performed-write', {
      is_error: false,
      authorityReceipts: [receipt({ performed: true, retryable: false, outcome: 'performed' })],
    }));
    await log.append(auditEntry('known-no-op', {
      is_error: false, authorityReceipts: [receipt()],
    }));
    await log.append(auditEntry('unknown-write', {
      is_error: true,
      authorityReceipts: [receipt({ outcomeKnown: false, retryable: false, outcome: 'unknown' })],
    }));

    const entries = await log.list();
    expect(entries.length).toBe(6);
    // UUIDv7 preserves millisecond order, but entries created inside the same
    // millisecond retain random suffixes and may enumerate in either order.
    const semanticOnly = entries.find((entry) => entry.details?.callId === 'semantic-only');
    expect(semanticOnly?.type).toBe('semantic_report');
    expect(semanticOnly?.details.outcome).toBe('semantic-success');

    const { root, unmount } = mount(async (msg) => (msg.type === 'audit/list'
      ? { ok: true, entries, total: entries.length }
      : { ok: true }));
    try {
      await settle();
      const text = root.textContent ?? '';
      expect(text).toContain('semantic call completed');
      expect(text).toContain('semantic call failed');
      expect(text).toContain('host effect performed');
      expect(text).toContain('semantic call completed; no host effect');
      expect(text).toContain('semantic call outcome unverified');
      expect(text.includes('tool ran')).toBe(false);
      expect(root.querySelectorAll('.log-info').length >= 2).toBe(true);
      expect(root.querySelectorAll('.log-warn').length >= 2).toBe(true);
      expect(root.querySelectorAll('.log-ok').length).toBe(1);
      expect(root.querySelectorAll('.log-danger').length).toBe(1);
    } finally { unmount(); }
  });

  it('explains a browser policy stop without showing its target address', async () => {
    const entries = [{
      id: 'policy-1', when: 1, type: 'tool_failed',
      details: {
        tool: 'open_tab', primitive: 'tab', error: 'browser_private_network_blocked',
        browserPolicy: {
          reason: 'private_network', stage: 'committed_origin',
          outcome: 'page_loaded_not_automated', retryable: false, neutralized: true,
        },
      },
    }];
    const { root, unmount } = mount(async (msg) => (msg.type === 'audit/list'
      ? { ok: true, entries, total: entries.length }
      : { ok: true }));
    try {
      await settle();
      const text = root.textContent ?? '';
      expect(text).toContain('private network blocked');
      expect(text).toContain('stopped after navigation');
      expect(text).toContain('page loaded, not automated');
      expect(text).toContain('tab reset');
      expect(text).toContain('do not retry');
      expect(text.includes('127.0.0.1')).toBe(false);
    } finally { unmount(); }
  });

  it('explains a sensitive-site redirect and failed reset', async () => {
    const entries = [{
      id: 'policy-sensitive', when: 1, type: 'tool_failed',
      details: {
        tool: 'navigate', primitive: 'tab', error: 'browser_sensitive_site_blocked',
        browserPolicy: {
          reason: 'sensitive_site', stage: 'committed_origin',
          outcome: 'page_loaded_not_automated', retryable: false, neutralized: false,
        },
      },
    }];
    const { root, unmount } = mount(async (msg) => (msg.type === 'audit/list'
      ? { ok: true, entries, total: entries.length }
      : { ok: true }));
    try {
      await settle();
      const text = root.textContent ?? '';
      expect(text).toContain('sensitive site blocked');
      expect(text).toContain('stopped after navigation');
      expect(text).toContain('page loaded, not automated');
      expect(text).toContain('tab reset not confirmed');
      expect(text).toContain('do not retry');
      expect(text.includes('accounts.example')).toBe(false);
    } finally { unmount(); }
  });

  it('shows when child control and its network guard were not confirmed', async () => {
    const entries = [{
      id: 'child-uncontained', when: 1, type: 'browser_child_navigation_failed',
      details: {
        browserPolicy: {
          reason: 'child_guard_failed', outcome: 'unverified',
          child: 'uncontained', guarded: false,
        },
      },
    }];
    const { root, unmount } = mount(async (msg) => (msg.type === 'audit/list'
      ? { ok: true, entries, total: entries.length }
      : { ok: true }));
    try {
      await settle();
      const text = root.textContent ?? '';
      expect(text).toContain('child navigation control failed');
      expect(text).toContain('child control not confirmed');
      expect(text).toContain('network guard not confirmed');
      expect(text).toContain('outcome not verified');
    } finally { unmount(); }
  });
});
