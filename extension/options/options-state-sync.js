// @ts-check
// One-shot Options transport with the state-refresh rules kept pure/testable.

/**
 * @param {{
 *   sendRuntime: (msg: any) => Promise<any>,
 *   sendTransfer: (msg: any) => Promise<any>,
 *   foldReply: (msg: any, reply: any) => void,
 *   fetchState: () => Promise<any>,
 * }} deps
 */
export const makeOptionsSender = ({ sendRuntime, sendTransfer, foldReply, fetchState }) =>
  async (/** @type {{ type: string } & Record<string, any>} */ msg) => {
    const reply = msg.type.startsWith('transfer/')
      ? await sendTransfer(msg)
      : await sendRuntime(msg);
    foldReply(msg, reply);
    // Imports can change many derived snapshot fields at once. The Options tab
    // has no live port, so refresh before the caller switches sections or a
    // partial import could immediately be overwritten by stale controls.
    if (msg.type === 'transfer/import' && (reply?.ok || reply?.partial)) {
      await fetchState();
    }
    return reply;
  };
