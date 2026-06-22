// @ts-check
// Generic Server-Sent Events parser.
//
// Operates on a ReadableStream<Uint8Array> (i.e. `response.body`) and
// yields `{ event, data }` records as they arrive. `event` is the SSE
// event name (or 'message' if the upstream omitted it); `data` is the
// raw string contents of the data: line(s) concatenated with '\n'.
//
// Why we don't reach for a library: the SSE wire format is small enough
// that a careful 60-line parser beats taking on a dependency, and the
// MV3 CSP plus our vendor-everything policy make a fetched library
// awkward. The parser handles:
//   - Multi-line `data:` fields (concatenated with '\n', per spec).
//   - Comment lines starting with `:`.
//   - CRLF and LF line endings.
//   - Mid-chunk record boundaries (a blank line splits records).
//   - UTF-8 multi-byte characters straddling chunk boundaries
//     (TextDecoder with stream:true handles this).
//
// We do NOT handle:
//   - Reconnect with Last-Event-ID — Anthropic streaming is one-shot.
//   - `retry:` field — same reason.
//   - `id:` field — we don't use it. Lines are parsed but ignored.
//
// On stream end the parser flushes any in-flight record (some servers
// don't emit a trailing blank line).

/**
 * @typedef {Object} SseEvent
 * @property {string} event    SSE event name; defaults to 'message'
 * @property {string} data     raw data field, lines joined with '\n'
 */

/**
 * Consume an SSE stream and yield records. Caller is responsible for
 * ensuring `stream` is a ReadableStream of Uint8Array (the shape
 * Response.body returns under fetch).
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {AsyncGenerator<SseEvent>}
 */
export async function* parseSSE(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  /** @type {string | null} */
  let currentEvent = null;
  /** @type {string[]} */
  let dataLines = [];

  const flush = () => {
    if (currentEvent === null && dataLines.length === 0) return null;
    const out = {
      event: currentEvent ?? 'message',
      data: dataLines.join('\n'),
    };
    currentEvent = null;
    dataLines = [];
    return out;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        // Decode any trailing bytes then flush any in-flight record.
        buffer += decoder.decode();
        if (buffer.length > 0) {
          const rec = processLine(buffer);
          if (rec) yield rec;
          buffer = '';
        }
        const tail = flush();
        if (tail) yield tail;
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      // Walk lines. We accept both CRLF and LF, but split on LF and
      // strip any trailing CR — simpler than tracking both.
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        const rec = processLine(line);
        if (rec) yield rec;
      }
    }
  } finally {
    reader.releaseLock?.();
  }

  /**
   * Process a single line. A blank line completes the current record;
   * a non-blank line updates the in-flight event/data. Returns the
   * completed record on a blank line, or null otherwise.
   * @param {string} line
   * @returns {SseEvent | null}
   */
  function processLine(line) {
    if (line === '') return flush();
    if (line.startsWith(':')) return null;  // SSE comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // SSE spec: a single leading space after the colon is stripped.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event': currentEvent = value; break;
      case 'data':  dataLines.push(value); break;
      case 'id':    /* not used */ break;
      case 'retry': /* not used */ break;
      default:      /* unknown field — spec says ignore */ break;
    }
    return null;
  }
}
