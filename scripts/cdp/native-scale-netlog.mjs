// Diagnostic-only Chrome NetLog: raw bytes never enter CI artifacts.
import { mkdtempSync, chmodSync, openSync, readSync, closeSync, fstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const NETLOG_BYTES = 8 * 1024 * 1024;
export const NETLOG_LIMITS = Object.freeze({ bytes: NETLOG_BYTES, seconds: 600, events: 2048, errors: 16 });
const EVENT_NAMES = new Set([
  'URL_REQUEST', 'HTTP_STREAM_REQUEST', 'HTTP_STREAM_JOB', 'HTTP_STREAM_JOB_WAITING', 'HTTP_STREAM_JOB_BOUND_TO_REQUEST',
  'WEBSOCKET_UPGRADE_FAILURE', 'WEBSOCKET_CLOSE_TIMEOUT',
  'URL_REQUEST_START_JOB', 'URL_REQUEST_REDIRECTED', 'URL_REQUEST_FAILED',
  'SOCKET_ALIVE', 'SOCKET_POOL', 'SOCKET_POOL_STALLED_MAX_SOCKETS', 'SOCKET_POOL_STALLED_MAX_SOCKETS_PER_GROUP',
  'SOCKET_POOL_CONNECT_JOB', 'SOCKET_POOL_BOUND_TO_CONNECT_JOB', 'SOCKET_POOL_BOUND_TO_SOCKET',
  'CONNECT_JOB', 'TRANSPORT_CONNECT_JOB_CONNECT', 'TCP_CONNECT', 'TCP_CONNECT_ATTEMPT',
  'WEBSOCKET_ALIVE', 'WEBSOCKET_TRANSPORT_CONNECT_JOB_CONNECT', 'WEBSOCKET_BASIC_HANDSHAKE_STREAM_CREATE',
  'WEBSOCKET_SEND_REQUEST_HEADERS', 'WEBSOCKET_READ_RESPONSE_HEADERS', 'WEBSOCKET_UPGRADE',
]);
const SOURCE_NAMES = new Set(['NONE', 'URL_REQUEST', 'CONNECT_JOB', 'SOCKET', 'HTTP_STREAM_JOB', 'WEBSOCKET_TRANSPORT_CONNECT_JOB']);
const PHASE_NAMES = new Set(['PHASE_NONE', 'PHASE_BEGIN', 'PHASE_END']);
const NUMERIC_PARAMS = ['net_error', 'os_error', 'elapsed', 'timeout', 'queued_transactions', 'started_transactions', 'attempts'];
const integer = value => Number.isSafeInteger(value) ? value : undefined;
const timestamp = value => {
  const number = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d{1,20}(\.\d{1,6})?$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? number : undefined;
};
const enumMap = (values, allowed) => new Map(Object.entries(values ?? {}).filter(([name, value]) => allowed.has(name) && Number.isSafeInteger(value)).map(([name, value]) => [value, name]));

export function projectNetLog(document) {
  if (!document?.constants?.logEventTypes || typeof document.constants.logEventTypes !== 'object' || Array.isArray(document.constants.logEventTypes)) return unavailable('invalid-constants');
  if (!Array.isArray(document?.events)) return unavailable('invalid-events');
  if (document.events.length > 100_000) return unavailable('event-limit');
  const events = [], errors = [];
  const types = enumMap(document?.constants?.logEventTypes, EVENT_NAMES);
  const sources = enumMap(document?.constants?.logSourceType, SOURCE_NAMES);
  const phases = enumMap(document?.constants?.logEventPhase, PHASE_NAMES);
  let considered = 0;
  for (const raw of Array.isArray(document?.events) ? document.events : []) {
    const type = types.get(raw?.type);
    if (!type) continue;
    const row = { type, phase: phases.get(raw.phase) ?? 'unknown', time: timestamp(raw.time),
      source: { id: integer(raw.source?.id), type: sources.get(raw.source?.type) ?? 'unknown' }, params: {} };
    for (const key of NUMERIC_PARAMS) if (integer(raw.params?.[key]) !== undefined) row.params[key] = raw.params[key];
    const dependency = raw.params?.source_dependency;
    if (integer(dependency?.id) !== undefined) row.params.source_dependency = { id: dependency.id, type: sources.get(dependency.type) ?? 'unknown' };
    considered++;
    events.push(row); if (events.length > NETLOG_LIMITS.events) events.shift();
    if ((row.params.net_error < 0 || row.params.os_error < 0) && errors.length < NETLOG_LIMITS.errors) errors.push(row);
  }
  return { available: true, endpointCorrelation: 'unavailable', clock: 'chrome-monotonic-ms', dropped: Math.max(0, considered - events.length), events, firstErrors: errors };
}

const unavailable = (reason = 'not-finished') => ({ available: false, reason, endpointCorrelation: 'unavailable', clock: 'chrome-monotonic-ms', events: [], firstErrors: [], dropped: 0 });

// IO is injected so bounded reads and deletion failures can be tested without
// launching Chrome. The extra byte detects growth after the initial stat.
/**
 * @param {string} path
 * @param {{openSync:(path:string, flags:string)=>number, readSync:(fd:number, buffer:Buffer, offset:number, length:number, position:null)=>number, closeSync:(fd:number)=>void, fstatSync:(fd:number)=>{size:number,isFile:()=>boolean}} [io]
 */
export function readNetlog(path, io) {
  io ??= { openSync, readSync, closeSync, fstatSync };
  let descriptor;
  try {
    descriptor = io.openSync(path, 'r');
    const stat = io.fstatSync(descriptor);
    if (!stat.isFile()) return unavailable('not-file');
    if (stat.size > NETLOG_LIMITS.bytes) return unavailable('byte-limit');
    const buffer = Buffer.alloc(NETLOG_LIMITS.bytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = io.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > NETLOG_LIMITS.bytes) return unavailable('byte-limit');
    let document;
    try { document = JSON.parse(buffer.subarray(0, length).toString('utf8')); }
    catch { return unavailable('invalid-json'); }
    return projectNetLog(document);
  } catch { return unavailable('read-failed'); }
  finally { if (descriptor !== undefined) { try { io.closeSync(descriptor); } catch { /* raw owner still removes the private directory */ } } }
}

/** @param {(value:object)=>void} [record] @param {typeof rmSync} [remove] */
export function createScaleNetLog(record = () => {}, remove = rmSync) {
  const directory = mkdtempSync(join(tmpdir(), 'peerd-native-netlog-'));
  try { chmodSync(directory, 0o700); } catch (error) { remove(directory, { recursive: true, force: true }); throw error; }
  const path = join(directory, 'netlog.json');
  let result, removed = false, removalFailures = 0;
  const publish = () => {
    const receipt = { ...(result ?? unavailable()), rawCleanup: removed ? 'complete' : 'failed', removalFailures };
    try { record(receipt); } catch { /* diagnostic consumers cannot block cleanup */ }
    return receipt;
  };
  const discard = () => {
    if (!removed) {
      try { remove(directory, { recursive: true, force: true }); removed = true; process.off('exit', onExit); }
      catch { removalFailures++; }
    }
    return publish();
  };
  const onExit = () => { discard(); };
  process.on('exit', onExit);
  return {
    args: [`--log-net-log=${path}`, '--net-log-capture-mode=HeavilyRedacted', '--net-log-max-size-mb=8', '--net-log-duration=600'],
    discard,
    finish() {
      // Memoize the bounded projection, not deletion: a transient deletion
      // failure must remain independently retriable on the next cleanup.
      result ??= readNetlog(path);
      return discard();
    },
  };
}
