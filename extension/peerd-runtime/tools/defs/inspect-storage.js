// @ts-check
// inspect_storage — proves encryption-at-rest.
//
// Reads peerd's persistent key-value storage. The point: API keys and
// vault material appear as base64-encoded encrypted blobs, not
// plaintext. The agent's narration of this tool's output is the §02
// "your keys never leave the vault unencrypted" claim, demonstrated.

/** @type {import('/shared/tool-types.js').Tool} */
export const inspectStorageTool = {
  name: 'inspect_storage',
  primitive: 'inspect',
  description: [
    'Read peerd\'s persistent key-value storage (chrome.storage.local).',
    'Vault data (wrappedDK, salt, secret blobs) appears as base64-encoded',
    'encrypted bytes — that is proof encryption-at-rest is in effect.',
    'Pass prefix="vault" or prefix="secret:" to focus on a specific area;',
    'omit it to see everything.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      prefix: {
        type: 'string',
        description: 'Optional key prefix filter, e.g. "vault" or "secret:".',
      },
    },
  },
  sideEffect: 'read',
  origins: () => [],
  execute: async (args, ctx) => {
    // why: ctx.kv is typed as the opaque `Object` contract slot; narrow it
    // to the one method this tool exercises (the egress KV `list`).
    const kv = /** @type {{ list: (prefix?: string) => Promise<Record<string, unknown>> }} */ (ctx.kv);
    const all = await kv.list(args?.prefix);
    /** @type {Record<string, unknown>} */
    const display = {};
    for (const [k, v] of Object.entries(all)) {
      display[k] = truncateForDisplay(v);
    }
    return {
      ok: true,
      content: JSON.stringify(display, null, 2),
    };
  },
};

/**
 * Render a value for human reading. Very long base64 strings (the
 * wrapped DK, encrypted secret blobs) are truncated head/tail so the
 * encrypted nature is visible without flooding the chat with hundreds
 * of opaque characters.
 */
/**
 * @param {unknown} v
 * @returns {unknown}
 */
const truncateForDisplay = (v) => {
  if (typeof v === 'string' && v.length > 80) {
    return `${v.slice(0, 32)}…${v.slice(-16)} (${v.length} chars, base64)`;
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, vv] of Object.entries(v)) out[k] = truncateForDisplay(vv);
    return out;
  }
  return v;
};
