// @ts-check
// Fixed model and user guidance for a browser-owned sign-in step.

export const AUTH_WAITING_FOR_USER_CODE = 'auth_waiting_for_user';
export const AUTH_WAITING_FOR_USER_MESSAGE =
  'Finish signing in in the open tab. peerd is paused and cannot read or act there. When the tab returns to its site, tell peerd to continue.';
export const AUTH_BOUNDARY_STOPPED_MESSAGE =
  'This helper stopped because its browser location or sign-in authorization no longer matched its approved boundary. Review the open tab, then tell peerd what to do next.';
export const AUTH_STATE_UNAVAILABLE_MESSAGE =
  "peerd could not safely verify or save this helper's browser authority, so it stopped. Review the open tab, then tell peerd what to do next.";
