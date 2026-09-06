// @ts-check

import browser from '/shared/browser-api.js';
import {
  VOICE_CHANNEL_PROTOCOL, VOICE_CHANNEL_RESULT, parseVoiceChannelOffer,
} from '/shared/voice-channel.js';
import { createVoiceHostRuntime } from '/peerd-runtime/voice-host.js';
import { backgroundScriptUrl } from './sender-checks.js';

const runtime = createVoiceHostRuntime({
  emit: (event) => browser.runtime.sendMessage(event),
});

/** @param {MessageEvent} event @param {(lease:any)=>boolean} ownsLease */
export const acceptVoiceChannelOffer = (event, ownsLease) => {
  const source = /** @type {{scriptURL?:unknown}|null} */ (event?.source ?? null);
  const offer = parseVoiceChannelOffer(event?.data);
  const port = event?.ports?.[0];
  if (event?.isTrusted !== true || source?.scriptURL !== backgroundScriptUrl
      || event?.ports?.length !== 1 || !port || !offer || !ownsLease(offer.lease)) {
    try { port?.close(); } catch {}
    return false;
  }
  Promise.resolve(runtime.handle(offer.command, {
    current: () => ownsLease(offer.lease),
  })).then(
    (result) => {
      try { port.postMessage({
        type: VOICE_CHANNEL_RESULT,
        protocol: VOICE_CHANNEL_PROTOCOL,
        requestId: offer.requestId,
        result,
      }); } catch {}
      try { port.close(); } catch {}
    },
    () => { try { port.close(); } catch {} },
  );
  return true;
};

export const stopVoiceHost = () => runtime.teardown();
