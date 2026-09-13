// @ts-check

// why: a transcript can exceed one controller frame before model-context
// trimming runs. Only this fixed session projection is paged; no operation or
// authority payload may borrow its transport. Bound both frames and total work.
export const TRANSCRIPT_CHUNK_CHARS = 256 * 1024;
export const TRANSCRIPT_PAGE_LIMIT = 4096;

export const createSessionTranscriptPages = () => {
  let sequence = 0;
  let pages = 0;
  /** @type {{cursor:number,wire:string,page:number}|null} */
  let pending = null;
  const read = (/** @type {number} */ cursor, /** @type {number} */ page) => {
    if (!pending || pending.cursor !== cursor || pending.page !== page) {
      throw new TypeError('session-transcript-cursor-invalid');
    }
    if (++pages > TRANSCRIPT_PAGE_LIMIT) {
      pending = null;
      throw new RangeError('session-transcript-budget-exhausted');
    }
    const start = page * TRANSCRIPT_CHUNK_CHARS;
    const chunk = pending.wire.slice(start, start + TRANSCRIPT_CHUNK_CHARS);
    const done = start + chunk.length >= pending.wire.length;
    if (done) pending = null;
    else pending.page += 1;
    return { cursor, page, chunk, done };
  };
  return Object.freeze({
    get pending() { return pending !== null; },
    /** @param {unknown} session @param {number} offset */
    start: (session, offset) => {
      if (pending) throw new TypeError('session-transcript-read-in-progress');
      const wire = JSON.stringify({ session, offset });
      if (pages + Math.ceil(wire.length / TRANSCRIPT_CHUNK_CHARS) > TRANSCRIPT_PAGE_LIMIT) {
        throw new RangeError('session-transcript-budget-exhausted');
      }
      pending = { cursor: ++sequence, wire, page: 0 };
      return read(sequence, 0);
    },
    read,
    close: () => { pending = null; },
  });
};
