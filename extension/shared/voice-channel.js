// @ts-check
// Exact one-command channel between the authority kernel and the DOM voice host.

export const VOICE_CHANNEL_OFFER = 'peerd/voice-channel';
export const VOICE_CHANNEL_RESULT = 'voice/result';
export const VOICE_CHANNEL_PROTOCOL = 1;
export const VOICE_COMMANDS = Object.freeze([
  'voice/init', 'voice/listen', 'voice/stop', 'voice/silence', 'voice/teardown',
]);
const COMMANDS = new Set(VOICE_COMMANDS);

/** @param {unknown} value @returns {Readonly<Record<string,any>>|null} */
export const parseVoiceCommand = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const command = /** @type {Record<string,any>} */ (value);
  if (!COMMANDS.has(command.type)) return null;
  const keys = Object.keys(command).sort().join('\n');
  if (command.type === 'voice/init'
      && (keys !== 'engine\ntype\nvariant'
        || typeof command.variant !== 'string' || command.variant.length > 32
        || !['auto', 'web-speech', 'moonshine'].includes(command.engine))) return null;
  if (command.type === 'voice/listen'
      && (keys !== 'targetId\ntype'
        || typeof command.targetId !== 'string' || command.targetId.length > 256)) return null;
  if (command.type === 'voice/silence'
      && (keys !== 'ms\ntype'
        || !Number.isFinite(command.ms) || command.ms < 100 || command.ms > 30_000)) return null;
  if ((command.type === 'voice/stop' || command.type === 'voice/teardown')
      && keys !== 'type') return null;
  return Object.freeze({ ...command });
};

/**
 * @param {unknown} value
 * @returns {Readonly<{type:string,protocol:number,requestId:string,command:any,lease:any}>|null}
 */
export const parseVoiceChannelOffer = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const offer = /** @type {Record<string,any>} */ (value);
  if (Object.keys(offer).sort().join('\n') !== 'command\nlease\nprotocol\nrequestId\ntype'
      || offer.type !== VOICE_CHANNEL_OFFER
      || offer.protocol !== VOICE_CHANNEL_PROTOCOL
      || typeof offer.requestId !== 'string' || offer.requestId.length < 8
      || offer.requestId.length > 128 || !COMMANDS.has(offer.command?.type)
      || !offer.lease || typeof offer.lease !== 'object' || Array.isArray(offer.lease)
      || offer.lease.scope !== 'media-host') return null;
  const command = parseVoiceCommand(offer.command);
  if (!command) return null;
  return Object.freeze(/** @type {any} */ ({
    ...offer, command,
  }));
};
