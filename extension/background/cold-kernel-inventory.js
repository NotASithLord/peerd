// @ts-check
// Pure inventory for browser events that can wake the legacy service worker.
// This module deliberately imports nothing: it is safe in a cold entry graph.

/** @typedef {'kernel-immediate'|'kernel-authority'|'durable-hint'|'transient-host'} ColdPlacement */
/**
 * @typedef {Object} ColdEventInventory
 * @property {string} key
 * @property {ColdPlacement} placement
 * @property {number} legacySites
 * @property {boolean} [common]
 * @property {boolean} [firefox]
 * @property {boolean} [selfHostedChrome]
 */

/**
 * One kernel listener replaces the legacy file's duplicate listeners for each
 * event. `kernel-authority` means delaying or replaying the event would lose a
 * browser gesture or reopen an authority race; a production kernel must supply
 * the synchronous handler before registering it. `durable-hint` payloads are
 * sanitized and at-least-once. Runtime messages and ports are never persisted.
 */
/** @type {ReadonlyArray<Readonly<ColdEventInventory>>} */
export const LEGACY_COLD_EVENTS = Object.freeze([
  Object.freeze({ key: 'runtime.onMessage', placement: 'transient-host', common: true, legacySites: 6 }),
  Object.freeze({ key: 'runtime.onConnect', placement: 'transient-host', common: true, legacySites: 1 }),
  Object.freeze({ key: 'runtime.onStartup', placement: 'durable-hint', common: true, legacySites: 1 }),
  // New native-kernel owner: a fresh install writes only the nonsecret false
  // vault posture marker; updates with no marker reconcile through authority.
  Object.freeze({ key: 'runtime.onInstalled', placement: 'kernel-immediate', common: true, legacySites: 0 }),
  // Two code sites manage one live preview listener across settings hydration.
  Object.freeze({ key: 'runtime.onUpdateAvailable', placement: 'kernel-authority', selfHostedChrome: true, legacySites: 2 }),
  Object.freeze({ key: 'alarms.onAlarm', placement: 'durable-hint', common: true, legacySites: 1 }),
  // Firefox event pages use session-storage activity as the direct Worker
  // lifetime signal. Chrome's controller lives behind an offscreen lease and
  // never registers this listener.
  Object.freeze({ key: 'storage.session.onChanged', placement: 'durable-hint', firefox: true, legacySites: 1 }),
  Object.freeze({ key: 'tabs.onCreated', placement: 'kernel-authority', common: true, legacySites: 1 }),
  Object.freeze({ key: 'tabs.onUpdated', placement: 'kernel-authority', common: true, legacySites: 6 }),
  Object.freeze({ key: 'tabs.onRemoved', placement: 'kernel-authority', common: true, legacySites: 8 }),
  Object.freeze({ key: 'tabs.onActivated', placement: 'durable-hint', common: true, legacySites: 2 }),
  Object.freeze({ key: 'windows.onFocusChanged', placement: 'durable-hint', common: true, legacySites: 1 }),
  Object.freeze({ key: 'webNavigation.onCreatedNavigationTarget', placement: 'kernel-authority', common: true, legacySites: 1 }),
  Object.freeze({ key: 'webRequest.onBeforeRequest', placement: 'kernel-authority', firefox: true, legacySites: 1 }),
  Object.freeze({ key: 'action.onClicked', placement: 'kernel-immediate', common: true, legacySites: 1 }),
  Object.freeze({ key: 'commands.onCommand', placement: 'kernel-immediate', common: true, legacySites: 1 }),
]);

// Message classes are evidence for the central listener. The wildcard is the
// unified dispatcher: adding a route does not require adding another listener.
export const LEGACY_MESSAGE_CLASSES = Object.freeze([
  Object.freeze({ match: 'bootstrap/ready', handling: 'kernel-immediate', persisted: false }),
  Object.freeze({ match: 'local-model/{delta,done,progress}', handling: 'transient-host', persisted: false }),
  Object.freeze({ match: '{voice,vm}/{stream-event}', handling: 'transient-host', persisted: false }),
  Object.freeze({ match: '{vm,js,app,pod}/tab-lifecycle', handling: 'transient-host', persisted: false }),
  Object.freeze({ match: 'dweb/base-room/event', handling: 'transient-host', persisted: false }),
  Object.freeze({ match: '*', handling: 'transient-host-rpc', persisted: false }),
]);

/**
 * @typedef {Object} ColdPortInventory
 * @property {string} name
 * @property {'disconnect'|'hold-bounded'} cold
 * @property {string} [reason]
 * @property {boolean} [common]
 * @property {boolean} [chrome]
 * @property {boolean} [firefox]
 * @property {boolean} [dweb]
 */
/** @type {ReadonlyArray<Readonly<ColdPortInventory>>} */
export const LEGACY_PORT_CLASSES = Object.freeze([
  // Chrome transfers a private MessageChannel to the exact Options
  // WindowClient. Only Firefox uses the runtime.Port fallback.
  Object.freeze({
    name: 'private-transfer', cold: 'disconnect', firefox: true,
    reason: 'secret-bearing channel cannot queue',
  }),
  Object.freeze({ name: 'sidepanel', cold: 'hold-bounded', common: true }),
  Object.freeze({ name: 'home', cold: 'hold-bounded', common: true }),
  Object.freeze({ name: 'eval', cold: 'hold-bounded', common: true }),
  // The offscreen lease supervisor exists only on Chrome. Firefox owns its
  // sealed feature Worker directly in the event page.
  Object.freeze({ name: 'feature-lease-keepalive', cold: 'hold-bounded', chrome: true }),
  // Dweb is packaged only in Preview Chrome. Store and Firefox artifacts
  // replace its routes and never create this custody channel.
  Object.freeze({ name: 'dweb-custody', cold: 'hold-bounded', dweb: true }),
]);

/** @param {{ firefox?: boolean, selfHostedChrome?: boolean }} [target] */
export const coldEventKeysFor = ({
  firefox = false,
  selfHostedChrome = false,
} = {}) => LEGACY_COLD_EVENTS
  .filter((entry) => entry.common || (firefox && entry.firefox)
    || (selfHostedChrome && entry.selfHostedChrome))
  .map((entry) => entry.key);

/** @param {{ firefox?: boolean, dweb?: boolean }} [target] */
export const coldPortNamesFor = ({ firefox = false, dweb = false } = {}) =>
  LEGACY_PORT_CLASSES
    .filter((entry) => entry.common || (firefox && entry.firefox)
      || (!firefox && entry.chrome) || (!firefox && dweb && entry.dweb))
    .map((entry) => entry.name);
