// @ts-check
// peerd-runtime/transfer/enrollment-flow.js: the "Use my existing Peerd"
// flow, as a pure state machine.
//
// The rendered gate (sidepanel) is a thin projection of this: every step,
// every user-facing sentence, and every branch (including the awkward ones
// no devices online, restore declined, transfer interrupted) is decided
// here, so the flow is exhaustively testable without a browser and the copy
// is reviewable in one place.
//
// The copy rule from the issue's §16: plain language in the primary path.
// No DID, no "HMAC rendezvous", no "device certificate", no "recovery
// capsule", those belong in diagnostics, which this module exposes
// separately (`diagnostics`) for an advanced panel.
//
// The steps, in order:
//   choose        Create new identity | Use my existing Peerd
//   ceremony      the passkey ceremony at the canonical page
//   enrolling     locating a sponsor / recovering the identity
//   authorizing-device  explicit second approval for this new device
//   looking       private discovery for the person's other devices
//   found         devices located → offer restore
//   none-online   nothing reachable; the device is still validly enrolled
//   restoring     state transferring, per-surface progress
//   secrets       the explicit credential-transfer decision
//   partial       some requested state could not be restored
//   importing-backup  the advertised offline fallback is running
//   done          this device is ready
//   failed        an honest terminal failure with a named reason
//
// Nothing here performs IO. The host feeds it events; it returns the next
// state plus the actions the host should perform.

/** @typedef {'choose'|'ceremony'|'enrolling'|'authorizing-device'|'looking'|'found'|'none-online'|'restoring'|'secrets'|'partial'|'importing-backup'|'done'|'failed'} EnrollmentStep */

// The user-facing sentence for each step. Kept as data (not scattered
// through the renderer) so copy review is one diff, and so tests assert the
// jargon ban mechanically.
export const STEP_COPY = Object.freeze({
  choose: {
    title: 'Set up Peerd',
    body: 'Start fresh, or bring the Peerd you already use.',
    primary: 'Use my existing Peerd',
    secondary: 'Create a new Peerd',
  },
  ceremony: {
    title: 'Confirm it\'s you',
    body: 'Use the passkey you set up on your other device.',
    primary: 'Continue',
  },
  enrolling: {
    title: 'Finding your Peerd',
    body: 'Contacting one of your devices privately.',
  },
  'authorizing-device': {
    title: 'Approve this device',
    body: 'Use your passkey again to allow this device to join your Peerd. This approval shares your Peerd identity with this device.',
    primary: 'Approve this device',
  },
  looking: {
    title: 'Looking for your other Peerd devices…',
    body: 'This only works while another device is open.',
  },
  found: {
    title: 'Found your other device',
    body: 'Restore your Peerd here?',
    primary: 'Restore',
    secondary: 'Not now',
  },
  'none-online': {
    title: 'No other devices are online',
    body: 'This device is set up and ready. Open Peerd on your other computer '
      + 'and come back, or restore from a backup file if you have one.',
    primary: 'Try again',
    secondary: 'Restore from a backup file',
  },
  restoring: {
    title: 'Restoring your Peerd…',
    body: 'Chats, memory, Apps, and settings.',
  },
  secrets: {
    title: 'Restore your saved keys?',
    body: 'Your provider keys can move to this device too. They stay encrypted here.',
    primary: 'Restore my keys',
    secondary: 'Skip for now',
  },
  partial: {
    title: 'Some things did not restore',
    body: 'This device is ready, but part of your Peerd could not be copied. You can retry while the other device is online.',
    primary: 'Try the restore again',
    secondary: 'Continue with what restored',
  },
  'importing-backup': {
    title: 'Restoring your backup…',
    body: 'Keep this window open while the backup is checked and restored.',
  },
  done: {
    title: 'This device is ready',
    body: 'Your Peerd is here.',
    primary: 'Start using Peerd',
  },
  failed: {
    title: 'Setup didn\'t finish',
    body: 'Nothing was changed. You can try again.',
    primary: 'Try again',
  },
});

// Surfaces named in plain language while restoring.
const SURFACE_LABELS = Object.freeze({
  sessions: 'chats',
  memory: 'memory',
  settings: 'settings',
  skills: 'skills',
  hooks: 'hooks',
  apps: 'Apps',
  workspaces: 'workspaces',
  secrets: 'saved keys',
  providerEndpoints: 'providers',
});

/** @param {string[]} surfaces */
export const describeSurfaces = (surfaces) => {
  const labels = surfaces.map((name) => SURFACE_LABELS[/** @type {keyof typeof SURFACE_LABELS} */ (name)] ?? name);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
};

/**
 * @typedef {Object} EnrollmentState
 * @property {EnrollmentStep} step
 * @property {Array<{ deviceDid: string, label: string | null }>} devices
 * @property {string | null} chosenDeviceDid
 * @property {string[]} offeredSurfaces      what the source offered (minus secrets)
 * @property {string[]} appliedSurfaces
 * @property {Record<string, string>} refusedSurfaces
 * @property {boolean} secretsOffered
 * @property {boolean | null} secretsDecision  null until the user decides
 * @property {string | null} failure           a machine reason, for diagnostics
 * @property {boolean} enrolled                is this device validly enrolled?
 * @property {boolean} authorizationComplete   did ceremony #2 approve this device?
 * @property {number} operationId              rejects stale async completions
 */

/** @returns {EnrollmentState} */
export const initialEnrollmentState = () => ({
  step: 'choose',
  devices: [],
  chosenDeviceDid: null,
  offeredSurfaces: [],
  appliedSurfaces: [],
  refusedSurfaces: {},
  secretsOffered: false,
  secretsDecision: null,
  failure: null,
  enrolled: false,
  authorizationComplete: false,
  operationId: 0,
});

const ALLOWED_STEPS = Object.freeze({
  'choose-existing': ['choose'],
  'choose-new': ['choose'],
  'ceremony-complete': ['ceremony', 'authorizing-device'],
  'ceremony-failed': ['ceremony', 'authorizing-device'],
  'authorization-required': ['enrolling'],
  enrolled: ['enrolling'],
  'enroll-failed': ['enrolling', 'authorizing-device'],
  'devices-found': ['looking'],
  'discovery-timeout': ['looking'],
  'retry-discovery': ['none-online'],
  'restore-from-backup': ['none-online'],
  'backup-import-complete': ['importing-backup'],
  'backup-import-failed': ['importing-backup'],
  'restore-declined': ['found'],
  'restore-approved': ['found'],
  'offer-received': ['restoring'],
  'surface-applied': ['restoring'],
  'transfer-complete': ['restoring'],
  'transfer-failed': ['restoring'],
  'retry-transfer': ['partial'],
  'continue-with-partial': ['partial'],
  'secrets-approved': ['secrets'],
  'secrets-declined': ['secrets'],
  restart: ['choose', 'ceremony', 'enrolling', 'authorizing-device', 'looking', 'found',
    'none-online', 'restoring', 'secrets', 'partial', 'importing-backup', 'done', 'failed'],
});

/**
 * The reducer. Returns the next state and the actions the host performs
 * pure, so the whole flow (including every refusal branch) is unit-testable.
 *
 * @param {EnrollmentState} state
 * @param {{ type: string, [k: string]: any }} event
 * @returns {{ state: EnrollmentState, actions: Array<{ type: string, [k: string]: any }> }}
 */
export const enrollmentStep = (state, event) => {
  /** @param {Partial<EnrollmentState>} patch @param {any[]} [actions] */
  const next = (patch, actions = []) => ({ state: { ...state, ...patch }, actions });

  const allowed = ALLOWED_STEPS[/** @type {keyof typeof ALLOWED_STEPS} */ (event.type)];
  if (!allowed || !allowed.includes(state.step)) {
    return next({}, [{ type: 'report-invalid-transition', step: state.step, event: event.type }]);
  }
  // Hosts echo operationId on asynchronous results. Legacy synchronous
  // callers may omit it, but a supplied stale id is always ignored.
  if (event.operationId !== undefined && event.operationId !== state.operationId) {
    return next({}, [{ type: 'report-stale-event', step: state.step, event: event.type }]);
  }

  switch (event.type) {
    // The fork itself.
    case 'choose-existing':
      return next({ step: 'ceremony', failure: null }, [{
        type: 'open-ceremony', purpose: 'find-my-devices',
      }]);
    case 'choose-new':
      return next({ step: 'choose' }, [{ type: 'create-new-identity' }]);

    // The ceremony produced (or failed to produce) an assertion.
    case 'ceremony-complete':
      if (state.step === 'ceremony') {
        return next({ step: 'enrolling' }, [{
          type: 'begin-enrollment', assertion: event.assertion,
        }]);
      }
      return next({ step: 'enrolling', authorizationComplete: true }, [{
        type: 'finish-enrollment', assertion: event.assertion,
      }]);
    case 'ceremony-failed':
      // A cancelled passkey prompt is not a hard failure, back to the fork.
      return next({
        step: event.reason === 'cancelled' ? 'choose' : 'failed',
        failure: event.reason ?? 'ceremony-failed',
      });

    case 'authorization-required':
      return next({ step: 'authorizing-device' }, [{
        type: 'open-ceremony', purpose: 'approve-this-device',
        challenge: event.challenge, device: event.device ?? null, sponsor: event.sponsor ?? null,
      }]);

    // Enrollment landed: THIS device now holds a person-signed certificate
    // for its own key. From here the device is valid even if nothing else
    // works. (It holds no person root: enrollment grants device authority,
    // never the signing seed. See the dweb module's self/enroll.js.)
    case 'enrolled':
      if (!state.authorizationComplete) {
        return next({}, [{ type: 'report-invalid-transition', step: state.step, event: 'enrolled-before-approval' }]);
      }
      return next({ step: 'looking', enrolled: true, operationId: state.operationId + 1 }, [{
        type: 'start-discovery', operationId: state.operationId + 1,
      }]);
    case 'enroll-failed':
      return next({ step: 'failed', failure: event.reason ?? 'enroll-failed' });

    // Discovery results. An empty roster is a legitimate outcome, NOT an
    // error: §12, say so clearly, keep the device enrolled, offer the
    // manual fallback, never pretend recovery succeeded.
    case 'devices-found':
      if (!event.devices?.length) return next({ step: 'none-online', devices: [] });
      return next({ step: 'found', devices: event.devices });
    case 'discovery-timeout':
      return next({ step: 'none-online', devices: [] });
    case 'retry-discovery':
      return next({ step: 'looking', operationId: state.operationId + 1 }, [{
        type: 'start-discovery', operationId: state.operationId + 1,
      }]);
    case 'restore-from-backup':
      return next({ step: 'importing-backup', operationId: state.operationId + 1 }, [{
        type: 'open-backup-import', operationId: state.operationId + 1,
      }]);
    case 'backup-import-complete':
      return next({
        step: 'done',
        appliedSurfaces: [...new Set([...state.appliedSurfaces, ...(event.applied ?? [])])],
        failure: null,
      });
    case 'backup-import-failed':
      return next({ step: 'none-online', failure: event.reason ?? 'backup-import-failed' });

    // The restore decision.
    case 'restore-declined':
      return next({ step: 'done' });
    case 'restore-approved':
      return next({
        step: 'restoring',
        chosenDeviceDid: event.deviceDid ?? state.devices[0]?.deviceDid ?? null,
        operationId: state.operationId + 1,
        offeredSurfaces: [], appliedSurfaces: [], refusedSurfaces: {},
      }, [{
        type: 'request-offer', deviceDid: event.deviceDid ?? state.devices[0]?.deviceDid,
        operationId: state.operationId + 1,
      }]);

    // Transfer progress. Secrets are held back for their own decision.
    case 'offer-received': {
      const offered = (event.surfaces ?? []).filter((/** @type {string} */ s) => s !== 'secrets');
      return next({
        step: 'restoring',
        offeredSurfaces: offered,
        secretsOffered: (event.surfaces ?? []).includes('secrets'),
      }, [{ type: 'pull-surfaces', surfaces: offered }]);
    }
    case 'surface-applied':
      if (!state.offeredSurfaces.includes(event.surface) && event.surface !== 'secrets') {
        return next({}, [{ type: 'report-invalid-transition', step: state.step, event: 'unoffered-surface' }]);
      }
      return next({ appliedSurfaces: [...new Set([...state.appliedSurfaces, event.surface])] });
    case 'transfer-complete': {
      const result = event.result;
      const reportedApplied = Array.isArray(result?.applied) ? [...new Set(result.applied)] : [];
      const applied = [...new Set([...state.appliedSurfaces, ...reportedApplied])];
      const refused = result?.refused && typeof result.refused === 'object' ? result.refused : {};
      const expected = state.secretsDecision === true ? ['secrets'] : state.offeredSurfaces;
      const complete = result?.ok === true && expected.every((surface) => reportedApplied.includes(surface));
      if (!complete) {
        return next({
          step: applied.length || result?.partial === true ? 'partial' : 'none-online',
          appliedSurfaces: applied,
          refusedSurfaces: refused,
          failure: result?.defect ?? (applied.length || result?.partial === true
            ? 'transfer-partial' : 'transfer-empty'),
        });
      }
      // Only now ask about credentials: an explicit, separate decision.
      return state.secretsOffered && state.secretsDecision === null
        ? next({ step: 'secrets', appliedSurfaces: applied })
        : next({ step: 'done', appliedSurfaces: applied, refusedSurfaces: {} });
    }
    case 'transfer-failed':
      // A failed transfer leaves an ENROLLED device: the identity is real,
      // only the state didn't arrive. Never claim otherwise.
      return next({ step: 'none-online', failure: event.reason ?? 'transfer-failed' });
    case 'retry-transfer':
      return next({
        step: 'restoring', operationId: state.operationId + 1,
        appliedSurfaces: [], refusedSurfaces: {}, failure: null,
      }, [{
        type: 'request-offer', deviceDid: state.chosenDeviceDid,
        operationId: state.operationId + 1,
      }]);
    case 'continue-with-partial':
      return state.secretsOffered && state.secretsDecision === null
        ? next({ step: 'secrets' }) : next({ step: 'done' });

    // The credential decision.
    case 'secrets-approved':
      return next({ step: 'restoring', secretsDecision: true }, [{ type: 'pull-surfaces', surfaces: ['secrets'] }]);
    case 'secrets-declined':
      return next({ step: 'done', secretsDecision: false });

    case 'restart':
      return { state: initialEnrollmentState(), actions: [] };
    default:
      return next({});
  }
};

/**
 * The advanced/diagnostics view, where the cryptographic vocabulary is
 * allowed (and only here).
 * @param {EnrollmentState} state
 * @param {{ personDid?: string, deviceDid?: string, rendezvousTopic?: string }} [detail]
 */
export const diagnostics = (state, detail = {}) => ({
  step: state.step,
  failure: state.failure,
  enrolled: state.enrolled,
  personDid: detail.personDid ?? null,
  deviceDid: detail.deviceDid ?? null,
  rendezvousTopic: detail.rendezvousTopic ?? null,
  candidates: state.devices.length,
  appliedSurfaces: state.appliedSurfaces,
});
