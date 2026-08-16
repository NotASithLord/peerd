// @ts-check
// SW-side client for the toolbox write-time module check. Chrome hosts the
// resolver in the offscreen document, where the sealed script runner already
// links Acorn; this keeps the parser out of the MV3 listener-registration path.

/**
 * @param {{
 *   ensureOffscreen: () => Promise<void>,
 *   sendMessage: (message: object) => Promise<any>,
 * }} deps
 * @returns {(name: string, body: string) => Promise<void>}
 */
export const makeOffscreenToolboxParseClient = ({ ensureOffscreen, sendMessage }) => (
  async (name, body) => {
    await ensureOffscreen();
    const reply = await sendMessage({ type: 'toolbox/parse-check', name, body });
    if (!reply?.ok) throw new Error(reply?.error ?? 'toolbox module validation failed');
  }
);
