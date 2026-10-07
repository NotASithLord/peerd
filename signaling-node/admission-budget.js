// @ts-check
// Bun process-local admission only. These counters are NOT durable across a
// Worker wake and must not be presented as Cloudflare/account-wide protection.
export const BOOTSTRAP_LIMITS = Object.freeze({
  windowMs: 10_000, rooms: 128, sockets: 2048,
  roomJoins: 128, processJoins: 256,
  roomMessages: 1024, processMessages: 4096,
  roomIngressBytes: 8 * 1024 * 1024, processIngressBytes: 32 * 1024 * 1024,
  roomEgressFrames: 4096, processEgressFrames: 16384,
  roomEgressBytes: 16 * 1024 * 1024, processEgressBytes: 64 * 1024 * 1024,
  roomControlFrames: 128, processControlFrames: 512,
  roomControlBytes: 128 * 1024, processControlBytes: 512 * 1024,
});
const encoder = new TextEncoder();
// Explicit new Bun API restriction: bounded nonempty UTF-8 keys, without C0/DEL.
// Public/legacy room names remain byte-for-byte unchanged; never normalize keys.
/** @param {unknown} key */
export const validRoomKey = key => typeof key === 'string' && key.length > 0
  && key.length <= 256 && !/[\x00-\x1f\x7f]/.test(key) && encoder.encode(key).byteLength <= 256;
const counters = () => ({ joins: 0, messages: 0, ingressBytes: 0, egressFrames: 0, egressBytes: 0 });
/** @param {{ now?: ()=>number, limits?: { [K in keyof typeof BOOTSTRAP_LIMITS]?: number } }} [options] */
export const createAdmissionBudget = ({ now = Date.now, limits = {} } = {}) => {
  const cap = { ...BOOTSTRAP_LIMITS, ...limits };
  if (Object.keys(limits).some(key => !Object.hasOwn(BOOTSTRAP_LIMITS, key))
      || Object.values(cap).some(n => !Number.isSafeInteger(n) || n < 1)
      || cap.roomControlFrames >= cap.roomEgressFrames || cap.processControlFrames >= cap.processEgressFrames
      || cap.roomControlBytes >= cap.roomEgressBytes || cap.processControlBytes >= cap.processEgressBytes) {
    throw new Error('invalid bootstrap budget');
  }
  let clock = 0, epoch = -1, live = 0;
  let total = counters();
  /** @type {Map<string, { live: number, used: ReturnType<typeof counters> }>} */
  const rooms = new Map();
  const refresh = () => {
    const time = now();
    if (!Number.isFinite(time) || time < 0) throw new Error('invalid bootstrap clock');
    clock = Math.max(clock, time); // backward wall-clock jumps cannot mint credit
    const next = Math.floor(clock / cap.windowMs);
    if (next !== epoch) {
      epoch = next; total = counters();
      for (const [key, room] of rooms) {
        if (!room.live) rooms.delete(key);
        else room.used = counters();
      }
    }
  };
  return {
    // Charge attempts before the shell does any roster reaping/allocation.
    // Inactive room entries retain spent credit until the window expires.
    /** @param {string} key */
    join(key) {
      refresh();
      if (!validRoomKey(key) || total.joins >= cap.processJoins) return false;
      total.joins++;
      let room = rooms.get(key);
      if (!room) {
        if (rooms.size >= cap.rooms) return false;
        room = { live: 0, used: counters() }; rooms.set(key, room);
      }
      if (room.used.joins >= cap.roomJoins) return false;
      room.used.joins++; return true;
    },
    /** @param {string} key @returns {(()=>void)|null} */
    reserveSocket(key) {
      const room = rooms.get(key);
      if (!room || live >= cap.sockets) return null;
      room.live++; live++;
      let released = false;
      return () => { if (!released) { released = true; room.live--; live--; } };
    },
    /** @param {string} key @param {number} bytes */
    ingress(key, bytes) {
      refresh();
      const room = rooms.get(key);
      if (!room || !Number.isSafeInteger(bytes) || bytes < 0
          || room.used.messages >= cap.roomMessages || total.messages >= cap.processMessages
          || bytes > cap.roomIngressBytes - room.used.ingressBytes
          || bytes > cap.processIngressBytes - total.ingressBytes) return false;
      room.used.messages++; total.messages++;
      room.used.ingressBytes += bytes; total.ingressBytes += bytes;
      return true;
    },
    // Reserve an entire encoded action batch before commit/dispatch. A failed
    // send never refunds credit. Control can spend the reserved final allowance.
    /** @param {string} key @param {number} frames @param {number} bytes @param {boolean} [control] */
    egress(key, frames, bytes, control = false) {
      refresh();
      const room = rooms.get(key);
      if (!room || ![frames, bytes].every(n => Number.isSafeInteger(n) && n >= 0)) return false;
      if (frames === 0 && bytes === 0) return true;
      if (frames > cap.roomEgressFrames - (control ? 0 : cap.roomControlFrames) - room.used.egressFrames
          || frames > cap.processEgressFrames - (control ? 0 : cap.processControlFrames) - total.egressFrames
          || bytes > cap.roomEgressBytes - (control ? 0 : cap.roomControlBytes) - room.used.egressBytes
          || bytes > cap.processEgressBytes - (control ? 0 : cap.processControlBytes) - total.egressBytes) return false;
      room.used.egressFrames += frames; total.egressFrames += frames;
      room.used.egressBytes += bytes; total.egressBytes += bytes;
      return true;
    },
    retryAfter: () => { refresh(); return Math.max(1, Math.ceil(((epoch + 1) * cap.windowMs - clock) / 1000)); },
    stats: () => ({ live, rooms: rooms.size, ...total }),
  };
};
