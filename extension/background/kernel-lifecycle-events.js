// @ts-check
export const KERNEL_LIFECYCLE_OWNER = 'kernel-lifecycle';

/**
 * @param {Object} deps
 * @param {any} deps.browser
 * @param {{event:(key:string,raw:any,owner:string)=>any}} deps.registry
 * @param {boolean} [deps.firefox]
 * @param {boolean} [deps.selfHostedChrome]
 * @param {()=>unknown} deps.onStartup
 * @param {string} deps.alarmName
 * @param {(alarm:any)=>unknown} deps.onAlarm
 * @param {(changes:any,areaName:string)=>unknown} [deps.onSessionChanged]
 * @param {(details:any)=>unknown} [deps.onUpdateAvailable]
 */
export const attachKernelLifecycleEvents = ({
  browser, registry, firefox = false, selfHostedChrome = false,
  onStartup, alarmName, onAlarm, onSessionChanged, onUpdateAvailable,
}) => {
  if (!browser?.runtime || !browser?.alarms || typeof registry?.event !== 'function'
      || typeof onStartup !== 'function' || typeof onAlarm !== 'function'
      || typeof alarmName !== 'string' || !alarmName
      || (firefox && typeof onSessionChanged !== 'function')
      || (selfHostedChrome && typeof onUpdateAvailable !== 'function')) {
    throw new TypeError('kernel-lifecycle-events-config-invalid');
  }
  registry.event('runtime.onStartup', browser.runtime.onStartup, KERNEL_LIFECYCLE_OWNER)
    ?.addListener(onStartup);
  registry.event('alarms.onAlarm', browser.alarms.onAlarm, KERNEL_LIFECYCLE_OWNER)
    ?.addListener((/** @type {any} */ alarm) =>
      alarm?.name === alarmName ? onAlarm(alarm) : undefined);
  if (firefox) {
    registry.event(
      'storage.session.onChanged', browser.storage?.session?.onChanged, KERNEL_LIFECYCLE_OWNER,
    )?.addListener(onSessionChanged);
  }
  if (selfHostedChrome) {
    registry.event(
      'runtime.onUpdateAvailable', browser.runtime.onUpdateAvailable, KERNEL_LIFECYCLE_OWNER,
    )?.addListener(onUpdateAvailable);
  }
  return Object.freeze({ owner: KERNEL_LIFECYCLE_OWNER });
};
