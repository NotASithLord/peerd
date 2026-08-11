// pod-client.web.js — web stub swapped in for /background/pod-client.js by the
// web packaging target (packaging/web-target.ts WEB_SWAPS).
//
// why: peerd-runtime/tools/defs/pod-create.js imports only this title constant
// from the Pod client; the rest is extension tab/RPC chassis. The web packager
// verifies this value against the real source and rejects any additional import.
export const POD_TAB_GROUP_TITLE = 'peerd';
