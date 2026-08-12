// The upstream browser bundle treats Buffer as a peer dependency. This module
// exists for evaluation order: static ESM dependencies run left-to-right, so
// the global is installed before the UMD bundle below executes in an MV3
// service worker (where runtime import() is forbidden).
import { Buffer } from './buffer-polyfill.js';

if (!globalThis.Buffer) globalThis.Buffer = Buffer;
