// @ts-check
// This HTTP-served CI harness talks only to its locally spawned signaler.
// Production custom bootstrap URLs belong to the separate library API.
/** @param {string | null} value */
export const twoPeerEndpoint = (value) => {
  if (value === null) return 'ws://localhost:8799/rendezvous';
  const match = /^ws:\/\/(localhost|127\.0\.0\.1):([1-9][0-9]{0,4})\/rendezvous$/.exec(value);
  if (!match || match[0] !== value) throw new Error('two-peer harness requires a loopback rendezvous URL');
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('two-peer harness requires a valid port');
  // Reconstruct from literal authorities and a number, never a supplied URL.
  return match[1] === 'localhost'
    ? `ws://localhost:${port}/rendezvous`
    : `ws://127.0.0.1:${port}/rendezvous`;
};
