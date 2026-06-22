// Channel-config generator — flattens packaging/default-settings.mjs for one
// channel and emits extension/shared/channel-config.js (or the staged copy
// inside a packaged artifact). This is the §3/§11 injection mechanism: the
// channel flag and the channel's defaults become literal constants in
// the shipped tree; the store artifact's copy has DWEB_ENABLED =
// false and NO dweb keys at all.
//
// The CHECKED-IN extension/shared/channel-config.js is the dev default
// (preview channel) so the load-unpacked dev loop needs no build step.
// CI verifies the checked-in copy is in sync (`bun run gen:dev` +
// git diff --exit-code).
//
// CLI:
//   bun packaging/gen-channel-config.ts --channel=preview [--out=path]
//   (no --out → writes extension/shared/channel-config.js)

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { EXTENSION_DIR, parseArgs, type Channel } from './lib.ts';
import { defaults } from './default-settings.mjs';

const DEV_OUT = join(EXTENSION_DIR, 'shared', 'channel-config.js');

export const flattenDefaults = (channel: Channel): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, perChannel] of Object.entries(defaults)) {
    const channels = Object.keys(perChannel);
    for (const c of channels) {
      if (c !== 'store' && c !== 'preview') {
        throw new Error(`default-settings: key "${key}" has unknown channel "${c}"`);
      }
    }
    if (channel in perChannel) out[key] = (perChannel as any)[channel];
  }
  return out;
};

export const genChannelConfigSource = (channel: Channel): string => {
  const flat = flattenDefaults(channel);
  const entries = Object.entries(flat)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`)
    .join('\n');
  // why the directive: this file is checked into the typed extension tree,
  // so emit // @ts-check to keep it under the typecheck ratchet — and emit
  // it FROM the generator so `bun run gen:dev` stays drift-clean (a
  // hand-added directive would be stripped on regeneration; see CI).
  return `// @ts-check
// GENERATED FILE — do not edit. Source of truth: packaging/default-settings.mjs
// (regenerate with \`bun run gen:dev\`; the packaging script regenerates the
// staged copy per channel). The checked-in copy is the DEV default —
// preview channel — so "load unpacked → refresh" needs no build step.
//
// why this exists: the store/preview split is decided at PACKAGE TIME. The
// store artifact's copy of this file has DWEB_ENABLED = false and
// contains no dweb keys; the dweb module itself is absent
// from that artifact's tree. Core code gates dweb UI/calls on
// DWEB_ENABLED and reads defaults from CHANNEL_DEFAULTS — never from
// a runtime "which channel am I" probe, and never exposed to the agent or
// to skills (spec §11: settings are the only abstraction).

export const CHANNEL = ${JSON.stringify(channel)};
export const DWEB_ENABLED = ${JSON.stringify(channel === 'preview')};

export const CHANNEL_DEFAULTS = Object.freeze(${'{'}
${entries}
${'}'});
`;
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  const channel = String(args.channel ?? 'preview') as Channel;
  if (channel !== 'store' && channel !== 'preview') throw new Error(`bad --channel=${channel}`);
  const out = args.out ? String(args.out) : DEV_OUT;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, genChannelConfigSource(channel));
  console.log(`wrote ${out} (channel=${channel})`);
};

if (import.meta.main) main();
