// The guest execution timeout cannot bound renderer output painting or a lost
// CDP reply. Keep the same budget on the host, including measurement reads.
export const NOTEBOOK_PROBE_TIMEOUT_MS = 120_000;

export const withNotebookProbeDeadline = async (operation, timeoutMs = NOTEBOOK_PROBE_TIMEOUT_MS) => {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Notebook probe exceeded its ${timeoutMs}ms host deadline`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  // why fence both sides: a reply arriving after timeout must not start another
  // measurement against the tab that the state is already closing.
  const step = async (read) => {
    controller.signal.throwIfAborted();
    const value = await read();
    controller.signal.throwIfAborted();
    return value;
  };
  try { return await Promise.race([operation(step), expired]); }
  finally { clearTimeout(timer); }
};
