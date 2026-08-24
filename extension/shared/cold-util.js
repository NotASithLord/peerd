// @ts-check
// Pure helpers used by the authority kernel. Keep this leaf dependency-free;
// the broad UI/runtime utility surface must stay outside the cold graph.

/** @param {Uint8Array} bytes @returns {string} */
export const bytesToBase64 = (bytes) => {
  let str = '';
  const chunk = 32_768;
  for (let i = 0; i < bytes.length; i += chunk) {
    str += String.fromCharCode.apply(null,
      /** @type {number[]} */ (/** @type {unknown} */ (bytes.subarray(i, i + chunk))));
  }
  return btoa(str);
};

/** @param {string} value @returns {Uint8Array} */
export const base64ToBytes = (value) => {
  const str = atob(value);
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) out[i] = str.charCodeAt(i);
  return out;
};

/** Serialize operations without letting one rejection poison the lane. */
export const makeSerialLane = () => {
  let tail = Promise.resolve();
  return /** @template T @param {() => Promise<T>|T} operation @returns {Promise<T>} */ (
    operation,
  ) => {
    const run = tail.then(operation);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
};

/** @param {number} n */
const randomBytesDefault = (n) => crypto.getRandomValues(new Uint8Array(n));

/**
 * @param {() => number} [now]
 * @param {(n:number)=>Uint8Array} [randomBytes]
 */
export const uuidv7 = (now = Date.now, randomBytes = randomBytesDefault) => {
  const t = BigInt(now());
  const bytes = new Uint8Array(16);
  bytes.set(randomBytes(10), 6);
  bytes[0] = Number((t >> 40n) & 0xffn);
  bytes[1] = Number((t >> 32n) & 0xffn);
  bytes[2] = Number((t >> 24n) & 0xffn);
  bytes[3] = Number((t >> 16n) & 0xffn);
  bytes[4] = Number((t >> 8n) & 0xffn);
  bytes[5] = Number(t & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
