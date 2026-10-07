// @ts-check
// Metadata-only diagnostics; never retain native payloads or signed envelopes.
const TYPES = new Set(['MANIFEST_REQ', 'MANIFEST', 'NOMANIFEST', 'CHUNK_REQ', 'CHUNK', 'NOCHUNK']);
const HASH = /^[0-9a-f]{64}$/;
const DID = /^did:key:z[1-9A-HJ-NP-Za-km-z]{46,60}$/;
/** @param {() => number} [now] */
export function contentEvidence(now = Date.now) {
  /** @type {any[]} */ const events = [];
  let dropped = 0, phase = 'idle';
  /** @type {string|null} */ let failure = null;
  /** @param {any} event */
  const add = event => { if (events.length < 64) events.push({ at: now(), ...event }); else dropped++; };
  return {
    /** @param {string} value @param {any} [progress] */
    phase(value, progress) {
      phase = value;
      add({ phase: value, ...(progress ? { progress: {
        phase: progress.phase === 'manifest' ? 'manifest' : progress.phase === 'chunk' ? 'chunk' : 'unknown',
        done: Number.isSafeInteger(progress.done) ? progress.done : undefined,
        total: Number.isSafeInteger(progress.total) ? progress.total : undefined,
        providers: Number.isSafeInteger(progress.providers) ? progress.providers : undefined,
      } } : {}) });
    },
    /** @param {unknown} data @param {'send'|'receive'} direction @param {number} channel @param {string} readyState @param {number} bufferedAmount */
    frame(data, direction, channel, readyState, bufferedAmount) {
      // Fixture content is tiny. Larger frames are not parsed or copied.
      if (typeof data !== 'string' || data.length > 32768) return null;
      try {
        const frame = JSON.parse(data);
        if (frame?.__t === 'HELLO' && direction === 'receive' && typeof frame.env?.from === 'string' && DID.test(frame.env.from)) {
          return frame.env.from; // Claimed identity only: this observer does not verify signatures.
        }
        if (TYPES.has(frame?.t) && typeof frame.hash === 'string' && HASH.test(frame.hash)) {
          add({ direction, channel, type: frame.t, hash: frame.hash,
            bytes: new TextEncoder().encode(data).byteLength, readyState, bufferedAmount });
        }
      } catch { /* Observation cannot reject native delivery. */ }
      return null;
    },
    /** @param {unknown} error */
    failed(error) {
      // Do not serialize exception messages: they may contain untrusted bytes.
      failure = error instanceof Error && ['Error', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError'].includes(error.name) ? error.name : 'unknown';
      phase = 'failed'; add({ phase, errorName: failure });
    },
    snapshot: () => ({ phase, failure, dropped, events: events.map(event => ({ ...event })) }),
  };
}
