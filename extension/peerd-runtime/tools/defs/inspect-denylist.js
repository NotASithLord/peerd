// @ts-check
// inspect_denylist — proves the egress policy floor.
//
// With no argument: returns counts and an example slice. With
// domain=X: tests whether that domain matches any denylist pattern. The
// §02 hook is "there's a class of sites peerd will never touch" — banks,
// health portals, password managers, identity providers. This tool lets
// the agent demonstrate that the denylist is real data with real entries,
// not aspirational copy.

import { findDenylistMatch } from '/peerd-egress/index.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const inspectDenylistTool = {
  name: 'inspect_denylist',
  primitive: 'inspect',
  description: [
    'Inspect peerd\'s origin denylist — the list of hostnames that are',
    'off-limits regardless of user request. With no',
    'argument, returns the total pattern count and a small sample of',
    'entries. With domain=X (a hostname like "chase.com"), checks whether',
    'that hostname matches any denylist pattern and returns the matching',
    'pattern. Demonstrates the always-on security floor.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description: 'Optional hostname to check, e.g. "chase.com" or "login.proton.me".',
      },
    },
  },
  sideEffect: 'read',
  origins: () => [],
  execute: async (args, ctx) => {
    const patterns = ctx.denylist ?? [];
    if (args?.domain) {
      const match = findDenylistMatch(args.domain.toLowerCase(), patterns);
      return {
        ok: true,
        content: JSON.stringify({
          domain: args.domain,
          matched: match !== null,
          matchedPattern: match,
          totalPatterns: patterns.length,
          interpretation: match
            ? `'${args.domain}' is on the denylist via pattern '${match}'. peerd will refuse any tool call that touches this origin.`
            : `'${args.domain}' is NOT on the denylist. The agent may act on it — the denylist is the only origin restriction.`,
        }, null, 2),
      };
    }
    return {
      ok: true,
      content: JSON.stringify({
        totalPatterns: patterns.length,
        examples: patterns.slice(0, 12),
        note: 'Pass domain="..." to check a specific hostname against the full list.',
      }, null, 2),
    };
  },
};
