// @ts-check
// Fixed model and user prose for adaptive per-origin pacing (#234).
//
// why a constants module rather than composing at the call site: what the model
// reads at the ceiling has to be peerd-authored, identical every time, and free
// of anything a site controls. Composing a sentence next to a Response is how a
// server's chosen number ends up in front of the model. Same shape and same
// reason as actor/auth-wait.js.
//
// A canonical origin IS allowed here: it is peerd-authored output from
// normalizeApiOrigin, not page-controlled text, and the user cannot act on
// "some site asked peerd to slow down". The server's requested delay is NOT
// allowed: a site that can put "wait 24 hours" in front of the model has a
// steering lever it did not have before. That number lives in the audit log and
// in the settings list, both of which are peerd's own surfaces.

export const PACED_CEILING_CODE = 'origin_pacing_ceiling';
export const PACED_STATE_UNAVAILABLE_CODE = 'origin_pacing_unavailable';

/**
 * The terminal handoff. Ends the turn; the model does not get to retry it or
 * delegate around it.
 *
 * @param {string} origin  a canonical origin from normalizeApiOrigin
 */
export const pacedCeilingMessage = (origin) =>
  `peerd stopped acting on ${origin} because that site asked for a longer pause `
  + 'than peerd will wait during a turn. Nothing further was sent. Come back to '
  + 'this later, or tell peerd what to do instead.';

/**
 * Pacing state could not be read, so peerd cannot prove an action is inside the
 * limits a site asked for. Browser writes fail closed on this; reads continue.
 */
export const PACED_STATE_UNAVAILABLE_MESSAGE =
  'peerd could not read its record of the pause a site asked for, so it stopped '
  + 'rather than risk acting inside that pause. Nothing was sent. Try again, or '
  + 'tell peerd what to do next.';
