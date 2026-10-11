// @ts-check
// Turn a DHT contact into a direct room link through the linked peer that
// supplied it. Both production and physical acceptance use this exact adapter.

import { dlog } from '../log.js';

/** @typedef {Awaited<ReturnType<typeof import('./rooms.js').joinRoom>>} Room */
/** @param {Room} room */
export const makeDhtDialer = (room) => /** @param {{ did: string, hints?: { broker?: string } }} contact */ async (contact, { signal } = /** @type {{signal?: AbortSignal}} */ ({})) => {
  if (room.mesh.hasLink(contact.did)) return true;
  const broker = contact?.hints?.broker;
  if (!broker || !room.mesh.hasLink(broker)) return false;
  try { await room.dialVia(broker, contact.did, { signal }); }
  catch (error) {
    dlog('dht', `relay-dial of ${contact.did.slice(-8)} via ${broker.slice(-8)} failed: ${/** @type {{ message?: string }} */ (error)?.message ?? String(error)}`);
    return false;
  }
  return room.mesh.hasLink(contact.did);
};
