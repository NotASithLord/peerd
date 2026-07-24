// vm-client.web.js — web stub swapped in for /background/vm-client.js by the
// web packaging target (packaging/web-target.ts WEB_SWAPS).
//
// why: peerd-runtime/tools/defs/vm-create.js imports ONLY this title constant
// from the vm client; the rest of that file is extension chassis (tab tracker
// RPC) that never ships in the web tree. package-web.ts verifies this value
// MATCHES the real background file at build time (drift fails the build), and
// check-web-boundary.ts fails if curated code starts importing any OTHER name
// from this path.
export const VM_TAB_GROUP_TITLE = 'peerd';
