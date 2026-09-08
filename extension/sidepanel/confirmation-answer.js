// @ts-check

/** @param {Record<string, any>} deps */
export const makeConfirmationAnswer = ({ send, reconcile, getState, setState, redraw }) =>
  async (/** @type {any} */ prompt, /** @type {string} */ answer) => {
    const current = getState();
    if (current.pendingConfirm?.id !== prompt.id) return;
    const restore = () => {
      const state = getState();
      if (state.pendingConfirm == null
          && (state.session?.sessionId ?? null) === (prompt.ownerSessionId ?? null)) {
        setState({ ...state, pendingConfirm: prompt });
      }
      redraw();
    };
    const reconcileReceipt = async () => {
      try {
        const reply = await reconcile();
        if (reply?.ok && reply.state) return;
      } catch {}
      restore();
    };
    setState({ ...current, pendingConfirm: null });
    redraw();
    try {
      const reply = await send({
        type: 'confirm/answer', id: prompt.id, answer,
        ownerSessionId: prompt.ownerSessionId ?? null,
        sessionId: prompt.sessionId ?? null,
        dispatchId: prompt.dispatchId ?? null,
      });
      if (reply?.ok && reply?.outcomeKnown !== false) return;
      await reconcileReceipt();
    } catch {
      await reconcileReceipt();
    }
  };
