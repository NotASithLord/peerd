// @ts-check
// why: candidates can race transport handler installation. Bound the handoff
// and asynchronous handler work, and retire both with the attempt owner.
const MAX_MESSAGES = 64;
const MAX_BYTES = 256 * 1024;
/** @param {(payload: any) => void} send @param {() => void} overflow */
export const createSignalingBuffer = (send, overflow) => {
  /** @type {((payload: any) => any) | null} */
  let handler = null;
  /** @type {Array<{ payload: any, size: number }>} */
  const buffer = [];
  let bytes = 0;
  let inFlight = 0;
  let closed = false;
  const close = () => {
    closed = true; handler = null;
    for (const entry of buffer) bytes -= entry.size;
    buffer.length = 0;
  };
  const fail = () => { if (!closed) { close(); overflow(); } };
  /** @param {{payload: any, size: number}} entry */
  const dispatch = (entry) => {
    inFlight++;
    let result;
    try { result = handler?.(entry.payload); }
    catch { inFlight--; bytes -= entry.size; fail(); return; }
    Promise.resolve(result).then(() => { inFlight--; bytes -= entry.size; }, () => {
      inFlight--; bytes -= entry.size; fail();
    });
  };
  return {
    close,
    /** @param {any} payload */
    route(payload) {
      if (closed) return;
      let encoded;
      try { encoded = JSON.stringify(payload); } catch { fail(); return; }
      if (typeof encoded !== 'string' || encoded.length > MAX_BYTES) { fail(); return; }
      const size = new TextEncoder().encode(encoded).byteLength;
      if (buffer.length + inFlight >= MAX_MESSAGES || bytes + size > MAX_BYTES) { fail(); return; }
      bytes += size;
      const entry = { payload, size };
      if (handler) dispatch(entry); else buffer.push(entry);
    },
    signaling: {
      /** @param {any} payload */
      send(payload) { if (!closed) send(payload); },
      /** @param {(payload: any) => any} h */
      onRemote(h) {
        if (closed) return () => {};
        handler = h;
        while (buffer.length && !closed) dispatch(/** @type {{payload:any,size:number}} */ (buffer.shift()));
        return close;
      },
    },
  };
};
