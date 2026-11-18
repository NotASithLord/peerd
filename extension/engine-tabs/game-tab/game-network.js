// @ts-check
// why: the network rules for a game are pure, so tests can pin each string and each refusal.
import { isPrivateOrLocalHost } from '/shared/private-network.js';

// why: a top-level navigation or a subresource must never leave the browser.
const NETWORK_RESOURCE_TYPES = new Set(['XHR', 'Fetch', 'EventSource', 'Preflight']);

/**
 * Return the Content-Security-Policy for a game page.
 * Off: no network. On: public https: and wss: hosts, and WebRTC.
 * Chromium does not apply the webrtc directive to this page, so gameStartScript closes WebRTC.
 *
 * @param {boolean} networkAllowed
 * @returns {string}
 */
export const gameCsp = networkAllowed => {
  const connect = networkAllowed === true ? "connect-src 'self' https: wss:" : "connect-src 'self'";
  const webrtc = networkAllowed === true ? "webrtc 'allow'" : "webrtc 'block'";
  return `sandbox allow-scripts allow-same-origin allow-pointer-lock; default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; ${connect}; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; ${webrtc}`;
};

// why: the host cannot check the requests of a shared worker, so no game gets one.
const SEALED_ALWAYS = ['SharedWorker'];
const SEALED_WHEN_OFF = ['RTCPeerConnection', 'webkitRTCPeerConnection'];

/**
 * Return the script that the host runs in each new document of the game tab before game code.
 * The script removes SharedWorker. Off: the script also removes WebRTC.
 *
 * @param {boolean} networkAllowed
 * @returns {string}
 */
export const gameStartScript = networkAllowed => {
  const names = networkAllowed === true ? SEALED_ALWAYS : [...SEALED_ALWAYS, ...SEALED_WHEN_OFF];
  // why: the property cannot change again, so game code cannot put the constructor back.
  return `for (const name of ${JSON.stringify(names)}) Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });`;
};

/**
 * Return true when the host lets a paused request continue to the network.
 * Every other request gets a local answer from the game files.
 *
 * @param {{url:string,resourceType:string,origin:string,networkAllowed:boolean}} request
 * @returns {boolean}
 */
export const passesToNetwork = ({ url, resourceType, origin, networkAllowed }) => {
  if (networkAllowed !== true || !NETWORK_RESOURCE_TYPES.has(resourceType)) return false;
  let target;
  try { target = new URL(url); } catch { return false; }
  if (target.protocol !== 'https:' || target.username || target.password) return false;
  if (target.origin === origin) return false;
  return !isPrivateOrLocalHost(target.hostname);
};
