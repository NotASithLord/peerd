// @ts-check
// inspect_provider_config — proves BYOK without leaking the key.
//
// Reports current provider name, model id, and whether a key is stored,
// but never the key value itself. The §02 hook is "you bring your own
// key — peerd holds it encrypted, decrypts it in-memory only at request
// time" — this tool lets the agent narrate that contract from inside
// the conversation: "I know I'm running on claude-sonnet-4-6 via
// Anthropic. I know a key is stored. I don't see the key value here,
// and I literally cannot — it's encrypted in the vault until egress."

/** @type {import('/shared/tool-types.js').Tool} */
export const inspectProviderConfigTool = {
  name: 'inspect_provider_config',
  primitive: 'inspect',
  description: [
    'Report the current model provider configuration. Returns provider',
    'name, model id, and whether an API key is stored — but never the',
    'key itself. Demonstrates BYOK: peerd knows the model identity but',
    'the key remains encrypted in the vault.',
  ].join(' '),
  schema: { type: 'object', properties: {} },
  sideEffect: 'read',
  origins: () => [],
  execute: async (_args, ctx) => {
    const provider = ctx.provider ?? { name: 'unknown', model: 'unknown', hasKey: false };
    const vault = ctx.vault ?? { isLocked: true };
    return {
      ok: true,
      content: JSON.stringify({
        provider: provider.name,
        model: provider.model,
        hasKey: provider.hasKey,
        vaultLocked: vault.isLocked,
        contract: [
          'The API key is encrypted in the vault under a passphrase-derived',
          'KEK (PBKDF2-SHA256 600k iter → AES-KW). It is decrypted into SW',
          'memory only when a request is about to fire; the plaintext never',
          'lands in chrome.storage and never leaves the service worker.',
          'This tool intentionally cannot retrieve the key value — it would',
          'be a bug in the contract if it could.',
        ].join(' '),
      }, null, 2),
    };
  },
};
