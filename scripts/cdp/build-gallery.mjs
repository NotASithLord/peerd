#!/usr/bin/env bun
// Build the visual gallery — a MARKDOWN page showing every visual state in light
// AND dark, straight from the committed baselines. It doubles as the
// human-facing index of what the visual-regression gate covers.
//
//   bun scripts/cdp/build-gallery.mjs [--platform <name>]
//
// Reads scripts/cdp/baselines/<platform>/<state>.<theme>.png (default platform:
// the CI authority if present, else this machine's).
//
// why MARKDOWN and not the self-contained HTML page this used to emit: GitHub
// serves a committed .html file as SOURCE TEXT, so the one place people actually
// read the repo was the one place the gallery could not be seen — it needed
// raw.githack or a local checkout. Markdown renders natively in the repo browser
// AND from a PR comment link, which is what makes the CI link worth posting.
//
// The cost of the swap, stated plainly: images are now RELATIVE PATHS rather than
// embedded data URIs, so the file only resolves inside the repo. That is the
// right trade when the audience is someone reading github.com, but it does mean
// the gallery is no longer one portable artifact you can hand to somebody.
//
// Regenerate + commit whenever the baselines are reseeded. CI enforces that with
// a drift gate (`bun run gallery` + `git diff --exit-code`), so this file can
// never quietly disagree with the images the gate actually compares against.

import { readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VISUAL_AUTHORITY, VISUAL_PLATFORM, BASELINES_ROOT } from './visual.mjs';
import { STATES } from './states.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'GALLERY.md');

const platformArg = (process.argv.find((a) => a.startsWith('--platform=')) || '').split('=')[1];
// Prefer the explicit arg, then the committed authority set (what CI gates on),
// then this machine's — so a regenerate on any platform still produces a page.
const candidates = [platformArg, VISUAL_AUTHORITY, VISUAL_PLATFORM].filter(Boolean);
const platform = candidates.find((p) => existsSync(join(BASELINES_ROOT, p)));
if (!platform) {
  console.error(`no baselines found under ${BASELINES_ROOT}/{${candidates.join(',')}}. Seed them first: bun run test:e2e:visual`);
  process.exit(1);
}
const dir = join(BASELINES_ROOT, platform);

// A curated order so the gallery reads as a tour of the app (gate → home → a
// turn → richer states) rather than alphabetical.
const ORDER = [
  'initial-screen', 'idle-unlocked', 'completed-turn', 'multi-turn-transcript',
  'busy-thinking', 'mode-plan', 'tool-card-expanded', 'goal-running',
  'error-turn', 'sessions-list', 'onboarding-provider',
  'home-fulltab', 'home-library-git', 'options-fulltab',
];
const LABELS = {
  'initial-screen': ['Vault gate', 'First-run setup — the lock mark crowns the wordmark.'],
  'idle-unlocked': ['Empty chat', 'Home — path cards, voice prompt, the composer.'],
  'completed-turn': ['Completed turn', 'A finished exchange — operator-cyan user bubble.'],
  'multi-turn-transcript': ['Multi-turn', 'Bubbles carry across turns.'],
  'busy-thinking': ['Thinking', 'A turn mid-flight — the spinner + Stop.'],
  'mode-plan': ['Plan mode', 'The segmented Plan/Act control + mono chips.'],
  'tool-card-expanded': ['Tool call', 'An expanded tool-call card with its lineage body.'],
  'goal-running': ['Goal running', 'Goal bar, plan-todo card, tool-call cards.'],
  'error-turn': ['Failed turn', 'The error banner + failure-class chip.'],
  'sessions-list': ['Chats', 'The sessions list — active row highlighted.'],
  'onboarding-provider': ['Provider onboarding', 'First-run provider choice and encrypted-key setup.'],
  'home-fulltab': ['Home (full tab)', 'The large in-browser view — nav rail, app library.'],
  'home-library-git': ['App history and Git', 'App history and remote controls in the Library.'],
  'options-fulltab': ['Settings (full tab)', 'The full-tab options page — providers, security, memory.'],
};
// States captured at the wide (full-tab) viewport rather than the 400px panel.
const WIDE = new Set(['home-fulltab', 'home-library-git', 'options-fulltab']);

// The state registry and committed baseline inventory are one contract. Enforce
// it here because this command already runs in CI: an orphan baseline otherwise
// appears in the gallery while its state silently stops running.
const baselineFiles = readdirSync(dir).filter((file) => file.endsWith('.png'));
const baselineThemes = new Map();
for (const file of baselineFiles) {
  const match = /^(.+)\.(light|dark)\.png$/.exec(file);
  if (!match) {
    console.error(`unexpected baseline filename: ${file}`);
    process.exit(1);
  }
  if (!baselineThemes.has(match[1])) baselineThemes.set(match[1], new Set());
  baselineThemes.get(match[1]).add(match[2]);
}
const visualStateNames = STATES.filter((state) => state.kind === 'visual').map((state) => state.name);
const visualStateSet = new Set(visualStateNames);
const duplicateStates = visualStateNames.filter((name, index) => visualStateNames.indexOf(name) !== index);
const missingBaselines = visualStateNames.filter((name) =>
  !baselineThemes.get(name)?.has('light') || !baselineThemes.get(name)?.has('dark'));
const orphanBaselines = [...baselineThemes.keys()].filter((name) => !visualStateSet.has(name));
if (duplicateStates.length || missingBaselines.length || orphanBaselines.length) {
  if (duplicateStates.length) console.error(`duplicate visual states: ${[...new Set(duplicateStates)].join(', ')}`);
  if (missingBaselines.length) console.error(`visual states missing light/dark baselines: ${missingBaselines.join(', ')}`);
  if (orphanBaselines.length) console.error(`baselines without visual states: ${orphanBaselines.join(', ')}`);
  process.exit(1);
}

const present = new Set(baselineThemes.keys());
// why .sort() on the tail: ORDER is the curated tour, but anything NOT in it kept
// readdirSync order — which is the filesystem's, not a defined one. A macOS dev
// and the Linux CI authority enumerate the same directory differently, so the
// committed gallery drifted against a regeneration whose content was otherwise
// identical, and the drift gate failed on state ordering alone. Sorting makes the
// tail deterministic everywhere. (Adding a state to ORDER still places it
// deliberately; this only decides where the un-curated ones land.)
const states = [...ORDER.filter((s) => present.has(s)), ...[...present].filter((s) => !ORDER.includes(s)).sort()];

/** Path as written into the Markdown — relative to GALLERY.md, so it resolves in the repo browser. */
const shotPath = (state, theme) => {
  const rel = `baselines/${platform}/${state}.${theme}.png`;
  return existsSync(join(dir, `${state}.${theme}.png`)) ? rel : null;
};

// why an HTML <img> rather than `![alt](src)`: GitHub honours the width
// attribute, and the panel captures are 400×900 — at natural size they dominate
// the page and light/dark can't sit side by side. Markdown image syntax has no
// width control, and GitHub renders inline HTML inside tables fine.
const section = (state, i) => {
  const [name, blurb] = LABELS[state] || [state, ''];
  const wide = WIDE.has(state);
  const width = wide ? 460 : 380;
  const img = (theme) => {
    const src = shotPath(state, theme);
    return src ? `<img src="${src}" alt="${name} (${theme})" width="${width}">` : `_no ${theme} capture_`;
  };
  return [
    `### ${String(i + 1).padStart(2, '0')} · ${name}`,
    '',
    `\`${state}\`${wide ? ' · `full tab · 1280`' : ''}${blurb ? ` — ${blurb}` : ''}`,
    '',
    '| light | dark |',
    '| --- | --- |',
    `| ${img('light')} | ${img('dark')} |`,
    '',
  ].join('\n');
};

const md = [
  '# peerd — visual gallery',
  '',
  `**${states.length} states · ${states.length * 2} screens · baselines \`${platform}\`**`,
  '',
  'Every screen below is the live UI rendered through the E2E harness at a pinned',
  'Chrome build and viewport — the exact images the visual-regression gate compares',
  'against.',
  '',
  '> **Generated file.** Add a state in [`states.mjs`](states.mjs), reseed the',
  '> baselines (dispatch the workflow with `update_visual_baselines`), then',
  '> regenerate with `bun run gallery` and commit. CI fails if this drifts from',
  '> the committed baselines.',
  '',
  '---',
  '',
  ...states.map(section),
  '---',
  '',
  '<sub>Generated by <code>scripts/cdp/build-gallery.mjs</code> from <code>scripts/cdp/baselines/</code>.',
  'Do not edit by hand — run <code>bun run gallery</code>.</sub>',
  '',
].join('\n');

writeFileSync(OUT, md);
console.log(`wrote ${OUT} — ${states.length} states × 2 themes from baselines/${platform} (${(md.length / 1024).toFixed(1)} KB)`);
