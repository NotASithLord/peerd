// @ts-check
// Durable room accounting. Unlike Bun's process counters, this record is owned
// by the Durable Object storage and must never be deleted on socket departure.
import { BOOTSTRAP_LIMITS } from './admission-budget.js';

export const ROOM_BUDGET_KEY = 'bootstrap-room-budget-v1';
const fields = ['joins', 'messages', 'ingressBytes', 'egressFrames', 'egressBytes'];
const recordFields = ['version', 'windowMs', 'clock', 'epoch', 'used'];
/** @param {any} value @param {string[]} names */
const exactRecord = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const empty = () => ({ joins: 0, messages: 0, ingressBytes: 0, egressFrames: 0, egressBytes: 0 });

/** @param {any} storage @param {{now?:()=>number, limits?:Record<string,number>}} [options] */
export const createDurableRoomBudget = (storage, { now = Date.now, limits = {} } = {}) => {
  const cap = { ...BOOTSTRAP_LIMITS, ...limits };
  if (Object.keys(limits).some(key => !Object.hasOwn(BOOTSTRAP_LIMITS, key))
      || Object.values(cap).some(value => !Number.isSafeInteger(value) || value < 1)
      || cap.roomControlFrames >= cap.roomEgressFrames || cap.roomControlBytes >= cap.roomEgressBytes) {
    throw new Error('invalid room budget');
  }
  const maxima = [cap.roomJoins, cap.roomMessages, cap.roomIngressBytes, cap.roomEgressFrames, cap.roomEgressBytes];
  /** @param {'join'|'ingress'|'egress'} kind @param {number} bytes @param {number} frames @param {boolean} control */
  const debit = async (kind, bytes, frames, control) => {
    if (![bytes, frames].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('invalid room debit');
    // Default input/output gates are essential. Do not opt into allowConcurrency
    // or allowUnconfirmed: no parse, membership commit or frame may precede this
    // durable debit. https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
    return storage.transaction(async (/** @type {any} */ tx) => {
      const saved = await tx.get(ROOM_BUDGET_KEY);
      const time = now();
      if (!Number.isSafeInteger(time) || time < 0) throw new Error('invalid room clock');
      // Validate before any epoch reset. Schema/window changes or lower caps
      // need an explicit migration, never silent deletion of spent credit.
      if (saved !== undefined && (!exactRecord(saved, recordFields) || saved.version !== 1 || saved.windowMs !== cap.windowMs
          || !Number.isSafeInteger(saved.clock) || saved.clock < 0
          || saved.epoch !== Math.floor(saved.clock / cap.windowMs)
          || !exactRecord(saved.used, fields) || fields.some((field, index) => !Number.isSafeInteger(saved.used[field])
            || saved.used[field] < 0 || saved.used[field] > maxima[index]))) {
        throw new Error('invalid persisted room budget');
      }
      const clock = Math.max(time, saved?.clock ?? 0), epoch = Math.floor(clock / cap.windowMs);
      const used = empty();
      if (saved?.epoch === epoch) {
        used.joins = saved.used.joins;
        used.messages = saved.used.messages;
        used.ingressBytes = saved.used.ingressBytes;
        used.egressFrames = saved.used.egressFrames;
        used.egressBytes = saved.used.egressBytes;
      }
      if (kind === 'join') {
        if (used.joins >= cap.roomJoins) return false;
        used.joins++;
      } else if (kind === 'ingress') {
        if (used.messages >= cap.roomMessages || bytes > cap.roomIngressBytes - used.ingressBytes) return false;
        used.messages++; used.ingressBytes += bytes;
      } else {
        if (frames || bytes) {
          if (frames > cap.roomEgressFrames - (control ? 0 : cap.roomControlFrames) - used.egressFrames
              || bytes > cap.roomEgressBytes - (control ? 0 : cap.roomControlBytes) - used.egressBytes) return false;
          used.egressFrames += frames; used.egressBytes += bytes;
        }
      }
      await tx.put(ROOM_BUDGET_KEY, { version: 1, windowMs: cap.windowMs, clock, epoch, used });
      return true;
    });
  };
  return {
    join: () => debit('join', 0, 0, true),
    /** @param {number} bytes */
    ingress: bytes => debit('ingress', bytes, 0, false),
    /** @param {number} frames @param {number} bytes @param {boolean} [control] */
    egress: (frames, bytes, control = false) => debit('egress', bytes, frames, control),
  };
};
