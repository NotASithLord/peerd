// The "Use my existing Peerd" flow as a state machine: the happy path, and
// every awkward branch the issue names: no devices online (§12), restore
// declined, transfer interrupted, and the separate credential decision (§9).
// Also the §16 copy rule, enforced mechanically: no cryptographic jargon in
// any primary-path sentence.

import { describe, test, expect } from 'bun:test';
import {
  initialEnrollmentState, enrollmentStep, describeSurfaces, diagnostics, STEP_COPY,
} from '../../extension/peerd-runtime/transfer/enrollment-flow.js';

// Drive a list of events through the reducer, collecting actions.
const run = (events: Array<{ type: string; [k: string]: any }>, from = initialEnrollmentState()) => {
  let state = from;
  const actions: any[] = [];
  for (const event of events) {
    const result = enrollmentStep(state, event);
    state = result.state;
    actions.push(...result.actions);
  }
  return { state, actions };
};

const completeEnrollment = (firstAssertion: any = {}) => [
  { type: 'choose-existing' },
  { type: 'ceremony-complete', assertion: firstAssertion },
  {
    type: 'authorization-required', challenge: 'sponsor-challenge',
    sponsor: 'Desktop', device: 'This device',
  },
  { type: 'ceremony-complete', assertion: { credentialId: 'approved' } },
  { type: 'enrolled' },
];

describe('the happy path', () => {
  test('choose existing → ceremony → enrolled → found → restore → done', () => {
    const { state, actions } = run([
      ...completeEnrollment({ credentialId: 'c' }),
      { type: 'devices-found', devices: [{ deviceDid: 'did:key:zDesktop', label: 'Desktop' }] },
      { type: 'restore-approved' },
      { type: 'offer-received', surfaces: ['sessions', 'memory', 'settings', 'apps', 'workspaces'] },
      { type: 'surface-applied', surface: 'sessions' },
      { type: 'surface-applied', surface: 'memory' },
      { type: 'transfer-complete', result: {
        ok: true, applied: ['sessions', 'memory', 'settings', 'apps', 'workspaces'], refused: {},
      } },
    ]);
    expect(state.step).toBe('done');
    expect(state.enrolled).toBe(true);
    expect(state.chosenDeviceDid).toBe('did:key:zDesktop');
    expect(actions.map((a) => a.type)).toEqual([
      'open-ceremony', 'begin-enrollment', 'open-ceremony', 'finish-enrollment',
      'start-discovery', 'request-offer', 'pull-surfaces',
    ]);
  });

  test('the user never types a DID, peer id, address, or pairing code', () => {
    // Structural: no event in the happy path carries user-entered identity.
    const { actions } = run([
      ...completeEnrollment(),
      { type: 'devices-found', devices: [{ deviceDid: 'did:key:zDesktop', label: 'Desktop' }] },
      { type: 'restore-approved' },
    ]);
    // The device the host contacts came from DISCOVERY, not from the user.
    const request = actions.find((a) => a.type === 'request-offer');
    expect(request.deviceDid).toBe('did:key:zDesktop');
  });
});

describe('§12 offline-source behavior', () => {
  test('no devices online: says so, KEEPS the device enrolled, offers the file fallback', () => {
    const { state } = run([
      ...completeEnrollment(),
      { type: 'devices-found', devices: [] },
    ]);
    expect(state.step).toBe('none-online');
    expect(state.enrolled).toBe(true); // the enrollment stands
    expect(STEP_COPY['none-online'].body).toContain('set up and ready');
    expect(STEP_COPY['none-online'].secondary).toBe('Restore from a backup file');
    // It must NOT claim any state was recovered.
    expect(state.appliedSurfaces).toEqual([]);
  });

  test('a discovery timeout lands in the same honest state, and retry re-searches', () => {
    const first = run([
      ...completeEnrollment(), { type: 'discovery-timeout' },
    ]);
    expect(first.state.step).toBe('none-online');
    const retry = run([{ type: 'retry-discovery' }], first.state);
    expect(retry.state.step).toBe('looking');
    expect(retry.actions).toEqual([{ type: 'start-discovery', operationId: 2 }]);
  });

  test('an interrupted transfer never claims success: the device stays enrolled', () => {
    const { state } = run([
      ...completeEnrollment(),
      { type: 'devices-found', devices: [{ deviceDid: 'd', label: 'Desktop' }] },
      { type: 'restore-approved' },
      { type: 'offer-received', surfaces: ['sessions'] },
      { type: 'transfer-failed', reason: 'link-lost' },
    ]);
    expect(state.step).toBe('none-online');
    expect(state.step).not.toBe('done');
    expect(state.enrolled).toBe(true);
    expect(state.failure).toBe('link-lost');
  });

  test('the backup button opens import and models its completion', () => {
    const offline = run([...completeEnrollment(), { type: 'discovery-timeout' }]);
    const importing = run([{ type: 'restore-from-backup' }], offline.state);
    expect(importing.state.step).toBe('importing-backup');
    expect(importing.actions).toEqual([{ type: 'open-backup-import', operationId: 2 }]);
    const done = run([{
      type: 'backup-import-complete', operationId: 2, applied: ['sessions', 'settings'],
    }], importing.state);
    expect(done.state).toMatchObject({ step: 'done', enrolled: true });
    expect(done.state.appliedSurfaces).toEqual(['sessions', 'settings']);
  });
});

describe('§9 credential transfer is a separate, explicit decision', () => {
  test('secrets are held back from the bulk pull and asked about after', () => {
    const { state, actions } = run([
      ...completeEnrollment(),
      { type: 'devices-found', devices: [{ deviceDid: 'd', label: 'Desktop' }] },
      { type: 'restore-approved' },
      { type: 'offer-received', surfaces: ['sessions', 'memory', 'secrets'] },
    ]);
    // The bulk pull excludes secrets…
    const pull = actions.find((a) => a.type === 'pull-surfaces');
    expect(pull.surfaces).toEqual(['sessions', 'memory']);
    expect(state.secretsOffered).toBe(true);
    // …and completing the bulk transfer routes to the explicit question.
    const asked = run([{ type: 'transfer-complete', result: {
      ok: true, applied: ['sessions', 'memory'], refused: {},
    } }], state);
    expect(asked.state.step).toBe('secrets');
  });

  test('declining keys still finishes setup; approving pulls only the keys', () => {
    const base = run([
      ...completeEnrollment(),
      { type: 'devices-found', devices: [{ deviceDid: 'd', label: 'Desktop' }] },
      { type: 'restore-approved' },
      { type: 'offer-received', surfaces: ['sessions', 'secrets'] },
      { type: 'transfer-complete', result: { ok: true, applied: ['sessions'], refused: {} } },
    ]);
    const declined = run([{ type: 'secrets-declined' }], base.state);
    expect(declined.state.step).toBe('done');
    expect(declined.state.secretsDecision).toBe(false);
    expect(declined.actions).toEqual([]); // nothing pulled

    const approved = run([{ type: 'secrets-approved' }], base.state);
    expect(approved.state.secretsDecision).toBe(true);
    expect(approved.actions).toEqual([{ type: 'pull-surfaces', surfaces: ['secrets'] }]);
  });

  test('when no secrets are offered the flow finishes without asking', () => {
    const { state } = run([
      ...completeEnrollment(),
      { type: 'devices-found', devices: [{ deviceDid: 'd', label: 'Desktop' }] },
      { type: 'restore-approved' },
      { type: 'offer-received', surfaces: ['sessions'] },
      { type: 'transfer-complete', result: { ok: true, applied: ['sessions'], refused: {} } },
    ]);
    expect(state.step).toBe('done');
  });
});

describe('refusals and declines', () => {
  test('a cancelled passkey prompt returns to the fork, not a failure screen', () => {
    const { state } = run([
      { type: 'choose-existing' }, { type: 'ceremony-failed', reason: 'cancelled' },
    ]);
    expect(state.step).toBe('choose');
  });

  test('a real ceremony/enrollment failure is terminal and named', () => {
    expect(run([{ type: 'choose-existing' }, { type: 'ceremony-failed', reason: 'origin-not-allowed' }]).state)
      .toMatchObject({ step: 'failed', failure: 'origin-not-allowed' });
    expect(run([
      { type: 'choose-existing' }, { type: 'ceremony-complete', assertion: {} },
      { type: 'enroll-failed', reason: 'credential-not-bound' },
    ]).state).toMatchObject({ step: 'failed', failure: 'credential-not-bound', enrolled: false });
  });

  test('declining the restore leaves a ready, enrolled device', () => {
    const { state } = run([
      ...completeEnrollment(),
      { type: 'devices-found', devices: [{ deviceDid: 'd', label: 'Desktop' }] },
      { type: 'restore-declined' },
    ]);
    expect(state.step).toBe('done');
    expect(state.enrolled).toBe(true);
    expect(state.appliedSurfaces).toEqual([]);
  });

  test('cannot claim enrollment before the second, device-authorizing ceremony', () => {
    const result = run([
      { type: 'choose-existing' },
      { type: 'ceremony-complete', assertion: {} },
      { type: 'enrolled' },
    ]);
    expect(result.state).toMatchObject({ step: 'enrolling', enrolled: false });
    expect(result.actions.at(-1)).toMatchObject({ type: 'report-invalid-transition' });
  });

  test('a stale discovery completion cannot rewind an active restore', () => {
    const active = run([
      ...completeEnrollment(),
      { type: 'devices-found', devices: [{ deviceDid: 'd', label: 'Desktop' }] },
      { type: 'restore-approved' },
    ]);
    const stale = run([{ type: 'discovery-timeout', operationId: 1 }], active.state);
    expect(stale.state.step).toBe('restoring');
    expect(stale.actions).toEqual([{
      type: 'report-invalid-transition', step: 'restoring', event: 'discovery-timeout',
    }]);
  });

  test('zero restored surfaces is failure; a mixed result is explicit partial success', () => {
    const restoring = run([
      ...completeEnrollment(),
      { type: 'devices-found', devices: [{ deviceDid: 'd', label: 'Desktop' }] },
      { type: 'restore-approved' },
      { type: 'offer-received', surfaces: ['sessions', 'settings'] },
    ]);
    const empty = run([{ type: 'transfer-complete', result: {
      ok: true, applied: [], refused: { sessions: 'unavailable', settings: 'unavailable' },
    } }], restoring.state);
    expect(empty.state).toMatchObject({ step: 'none-online', failure: 'transfer-empty' });

    const partial = run([{ type: 'transfer-complete', result: {
      ok: false, partial: true, applied: ['sessions'], refused: { settings: 'unavailable' },
    } }], restoring.state);
    expect(partial.state).toMatchObject({
      step: 'partial', appliedSurfaces: ['sessions'],
      refusedSurfaces: { settings: 'unavailable' },
    });
  });

  test('item-level durable effects cannot be presented as an empty restore', () => {
    const before = run([
      ...completeEnrollment(),
      { type: 'devices-found', devices: [{ deviceDid: 'd' }] },
      { type: 'restore-approved' },
      { type: 'offer-received', surfaces: ['sessions'] },
    ]).state;
    const { state } = run([{ type: 'transfer-complete', result: {
      ok: false, partial: true, applied: [],
      failed: [{ surface: 'sessions', defect: 'apply-failed', partial: { written: 1 } }],
      partialEffects: { sessions: { written: 1 } }, refused: {},
    } }], before);
    expect(state.step).toBe('partial');
    expect(state.failure).toBe('transfer-partial');
  });
});

describe('§16 copy', () => {
  test('no cryptographic jargon anywhere in the primary path', () => {
    const banned = [/\bDID\b/, /did:key/i, /HMAC/i, /rendezvous/i, /certificate/i,
      /capsule/i, /Ed25519/i, /passkey binding/i, /device key/i, /nonce/i, /topic/i];
    for (const [step, copy] of Object.entries(STEP_COPY)) {
      const text = Object.values(copy).join(' ');
      for (const pattern of banned) {
        expect(pattern.test(text), `${step} copy must avoid ${pattern}`).toBe(false);
      }
    }
  });

  test('the copy matches the issue\'s suggested language', () => {
    expect(STEP_COPY.choose.primary).toBe('Use my existing Peerd');
    expect(STEP_COPY.looking.title).toBe('Looking for your other Peerd devices…');
    expect(STEP_COPY.found.body).toBe('Restore your Peerd here?');
    expect(STEP_COPY.done.title).toBe('This device is ready');
    expect(STEP_COPY.restoring.body).toContain('Chats, memory, Apps, and settings');
    expect(STEP_COPY.restoring.body).not.toContain('workspaces');
  });

  test('surfaces are described in plain language', () => {
    expect(describeSurfaces(['sessions'])).toBe('chats');
    expect(describeSurfaces(['sessions', 'memory'])).toBe('chats and memory');
    expect(describeSurfaces(['sessions', 'apps', 'workspaces'])).toBe('chats, Apps and workspaces');
    expect(describeSurfaces([])).toBe('');
  });

  test('the jargon lives in diagnostics, where it belongs', () => {
    const { state } = run([
      ...completeEnrollment(),
    ]);
    const detail = diagnostics(state, { personDid: 'did:key:zPerson', deviceDid: 'did:key:zDevice', rendezvousTopic: 'ab12' });
    expect(detail.personDid).toBe('did:key:zPerson');
    expect(detail.deviceDid).toBe('did:key:zDevice');
    expect(detail.rendezvousTopic).toBe('ab12');
    expect(detail.enrolled).toBe(true);
  });
});
