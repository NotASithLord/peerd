// @ts-check

import { createVoiceHostRuntime } from '/peerd-runtime/voice-host.js';

/** @param {(event:any)=>any} emit */
export const createKernelFirefoxVoiceHost = (emit) => createVoiceHostRuntime({ emit });
