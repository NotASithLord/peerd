// @ts-check
import { sha256hex } from './bundle/chunk.js';
import { canonicalize } from './bundle/canonical.js';
import { toBase64, utf8 } from './bundle/bytes.js';

export const GAME_ROOM_PREFIX = 'game.';
export const GAME_NET_LIMITS = Object.freeze({
  payloadBytes: 1024, publishRate: 2, publishBurst: 5, sendRate: 12, sendBurst: 24, recipients: 16,
});

/** @param {unknown} value */
export const gameNetProtocol = value => {
  if (!value || typeof value !== 'object' || !('v' in value) || !Object.hasOwn(value, 'v') || value.v !== 1
      || !('protocol' in value) || !Object.hasOwn(value, 'protocol') || typeof value.protocol !== 'number'
      || !Number.isInteger(value.protocol) || value.protocol < 0 || value.protocol > 65535
      || Object.keys(value).length !== 2) return null;
  return value.protocol;
};

/** @param {{publisher?:unknown,dwapp_id?:unknown,hash?:unknown}|null|undefined} release
 * @param {{publisher:string,hash:string}} tree @param {number} protocol */
export const gameWorld = async (release, tree, protocol) => {
  if (typeof release?.publisher !== 'string' || release.publisher !== tree.publisher
      || release.hash !== tree.hash || typeof release.dwapp_id !== 'string'
      || !/^[a-f0-9]{64}$/.test(release.dwapp_id)) return null;
  const world = await sha256hex(utf8(canonicalize([
    'peerd/game-world/v1', release.publisher, release.dwapp_id, protocol,
  ])));
  return { world, roomId: GAME_ROOM_PREFIX + world.slice(0, 40) };
};

/** @param {string} world @param {string} did */
export const gamePlayer = async (world, did) => {
  const digest = await crypto.subtle.digest('SHA-256', utf8(`peerd/game-player/v1${world}${did}`));
  return toBase64(new Uint8Array(digest, 0, 16)).replaceAll('+', '-').replaceAll('/', '_').slice(0, 22);
};

/** @param {unknown} data @returns {data is string} */
export const gamePayload = data => {
  if (typeof data !== 'string' || data.length > GAME_NET_LIMITS.payloadBytes
      || utf8(data).length > GAME_NET_LIMITS.payloadBytes) return false;
  try { JSON.parse(data); return true; } catch { return false; }
};

/** @param {unknown} value @returns {value is string[]} */
export const gameRecipients = value => Array.isArray(value) && value.length <= GAME_NET_LIMITS.recipients
  && value.every(id => typeof id === 'string' && /^[\w-]{22}$/.test(id));

/** @param {number} rate @param {number} burst */
export const gameRateLimit = (rate, burst) => {
  let tokens = burst, previous = 0;
  return (/** @type {number} */ now) => {
    tokens = Math.min(burst, tokens + Math.max(0, now - previous) * rate / 1000);
    previous = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
};
