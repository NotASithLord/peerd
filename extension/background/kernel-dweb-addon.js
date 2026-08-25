// @ts-check

import { createKernelDwebCustodyRuntime } from './kernel-dweb-custody-runtime.js';

const root = /** @type {any} */ (globalThis);
const id = Symbol.for('peerd.kernel.dweb-addon.v1');
if (root[id]) throw new Error('kernel-dweb-addon-owner-conflict');
root[id] = Object.freeze({ createKernelDwebCustodyRuntime });
