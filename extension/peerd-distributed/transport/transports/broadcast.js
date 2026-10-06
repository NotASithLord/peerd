// @ts-check
// A BroadcastChannel bus cannot bind a signer to its immediate carrier: any
// same-origin participant can relay or inject its sid/to/from routing fields.
// Session v2 therefore refuses this transport until it has an authenticated
// channel construction. Keep the selector rung explicit so callers fall
// through to WebRTC instead of winning an unusable, unauthenticated channel.

/** @param {{busName?:string,BroadcastChannel?:typeof BroadcastChannel}} [_opts] */
export const createBroadcastTransport = (_opts = {}) => ({
  name: 'broadcast',
  /** @param {string} _did @param {(channel:any)=>void} _onInbound */
  listen: (_did, _onInbound) => () => {},
  /** @param {any} _peer */
  canReach: (_peer) => 0,
  /** @param {any} _peer @param {any} [_connectOptions] */
  async connect(_peer, _connectOptions) {
    throw new Error('broadcast: authenticated session binding unavailable; use WebRTC');
  },
});
