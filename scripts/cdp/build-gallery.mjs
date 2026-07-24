#!/usr/bin/env bun
// Build the visual gallery — a self-contained HTML page showing every visual
// state in light AND dark, straight from the committed baselines. Open it from
// the repo to SEE the whole side-panel surface; it doubles as the human-facing
// index of what the visual-regression gate covers.
//
//   bun scripts/cdp/build-gallery.mjs [--platform <name>]
//
// Reads scripts/cdp/baselines/<platform>/<state>.<theme>.png (default platform:
// the CI authority if present, else this machine's). Images are embedded as
// data URIs so the single committed gallery.html needs no server and no loose
// asset paths. Regenerate + commit whenever the baselines are reseeded.

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VISUAL_AUTHORITY, VISUAL_PLATFORM, BASELINES_ROOT } from './visual.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'gallery.html');

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

// Group <state>.<theme>.png → { state: { light, dark } }, in a curated order so
// the gallery reads as a tour of the app (gate → home → a turn → richer states)
// rather than alphabetical.
const ORDER = [
  'initial-screen', 'idle-unlocked', 'completed-turn', 'multi-turn-transcript',
  'busy-thinking', 'mode-plan', 'tool-card-expanded', 'goal-running',
  'error-turn', 'sessions-list',
  'home-fulltab', 'options-fulltab',
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
  'home-fulltab': ['Home (full tab)', 'The large in-browser view — nav rail, app library.'],
  'options-fulltab': ['Settings (full tab)', 'The full-tab options page — providers, security, memory.'],
};
// States captured at the wide (full-tab) viewport rather than the 400px panel.
const WIDE = new Set(['home-fulltab', 'options-fulltab']);

const uri = (state, theme) => {
  const f = join(dir, `${state}.${theme}.png`);
  return existsSync(f) ? `data:image/png;base64,${readFileSync(f).toString('base64')}` : null;
};

const present = new Set(readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.(light|dark)\.png$/, '')));
const states = [...ORDER.filter((s) => present.has(s)), ...[...present].filter((s) => !ORDER.includes(s))];

const card = (state, i) => {
  const [name, blurb] = LABELS[state] || [state, ''];
  const wide = WIDE.has(state);
  const shot = (theme) => {
    const src = uri(state, theme);
    return src
      ? `<figure class="shot shot--${theme}"><figcaption>${theme}</figcaption><img src="${src}" alt="${name} (${theme})" loading="lazy"></figure>`
      : `<div class="shot shot--missing">no ${theme} capture</div>`;
  };
  return `
    <section class="state${wide ? ' state--wide' : ''}">
      <header class="state-head">
        <span class="num">${String(i + 1).padStart(2, '0')}</span>
        <span class="state-name">${name}</span>
        <code class="state-id">${state}</code>
        ${wide ? '<span class="tag-wide">full tab · 1280</span>' : ''}
        <span class="state-blurb">${blurb}</span>
      </header>
      <div class="pair${wide ? ' pair--wide' : ''}">${shot('light')}${shot('dark')}</div>
    </section>`;
};

const html = `<title>peerd — visual gallery</title>
<style>
  :root {
    --p:#00B7EB; --er:#EF4444; --am:#F59E0B; --gr:#22C55E; --mg:#D946EF;
    --page:#e9eaec; --card:#ffffff; --ink:#191b1c; --muted:#63696b; --line:#dcdee0;
    --accent:#0089ac; --tagbg:rgba(0,0,0,.055);
    --mono:ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;
    --sans:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root { --page:#0B0D0E; --card:#15181A; --ink:#E8E6E1; --muted:#8d9295; --line:#282c2e; --accent:#00B7EB; --tagbg:rgba(255,255,255,.06); }
  }
  :root[data-theme="light"] { --page:#e9eaec; --card:#ffffff; --ink:#191b1c; --muted:#63696b; --line:#dcdee0; --accent:#0089ac; --tagbg:rgba(0,0,0,.055); }
  :root[data-theme="dark"] { --page:#0B0D0E; --card:#15181A; --ink:#E8E6E1; --muted:#8d9295; --line:#282c2e; --accent:#00B7EB; --tagbg:rgba(255,255,255,.06); }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--page); color:var(--ink); font-family:var(--sans); line-height:1.5; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:1000px; margin:0 auto; padding:40px 28px 80px; }
  .wordmark { display:flex; align-items:center; margin-bottom:14px; }
  .wordmark b { display:inline-flex; align-items:center; justify-content:center; width:30px; height:34px; color:#FAFAFA; font:700 20px var(--mono); border-radius:3px; margin-right:3px; }
  .wordmark b:nth-child(1){ background:var(--p); border-radius:5px 3px 3px 5px; }
  .wordmark b:nth-child(2){ background:var(--er); } .wordmark b:nth-child(3){ background:var(--am); }
  .wordmark b:nth-child(4){ background:var(--gr); } .wordmark b:nth-child(5){ background:var(--mg); border-radius:3px 5px 5px 3px; margin-right:0; }
  .eyebrow { font-family:var(--mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--accent); }
  h1 { margin:6px 0 0; font-size:22px; font-weight:600; letter-spacing:-.01em; }
  .meta { margin-top:12px; font-family:var(--mono); font-size:12px; color:var(--muted); display:flex; gap:16px; flex-wrap:wrap; }
  .meta b { color:var(--ink); font-weight:500; }
  .states { display:flex; flex-direction:column; gap:38px; margin-top:34px; }
  .state-head { display:grid; grid-template-columns:auto auto 1fr; align-items:baseline; gap:10px; margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid var(--line); }
  .num { font-family:var(--mono); font-size:14px; font-weight:700; color:var(--muted); }
  .state-name { font-size:16px; font-weight:600; }
  .state-id { font-family:var(--mono); font-size:11px; color:var(--muted); background:var(--tagbg); padding:2px 6px; border-radius:4px; }
  .state-blurb { grid-column:1 / -1; font-size:12.5px; color:var(--muted); }
  .tag-wide { font-family:var(--mono); font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:var(--accent); border:1px solid color-mix(in srgb, var(--accent) 40%, var(--line)); border-radius:4px; padding:2px 6px; }
  .pair { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  /* Full-tab captures are 1280 wide — stack them so each reads at full width. */
  .pair--wide { grid-template-columns:1fr; gap:22px; }
  .shot { margin:0; display:flex; flex-direction:column; gap:6px; }
  .shot figcaption { font-family:var(--mono); font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); }
  .shot img { display:block; width:100%; height:auto; border:1px solid var(--line); border-radius:10px; }
  .shot--light img { background:#fff; } .shot--dark img { background:#0B0D0E; }
  .shot--missing { display:grid; place-items:center; min-height:200px; border:1px dashed var(--line); border-radius:10px; font-family:var(--mono); font-size:12px; color:var(--muted); }
  footer { margin-top:48px; padding-top:20px; border-top:1px solid var(--line); font-family:var(--mono); font-size:11.5px; color:var(--muted); }
  @media (max-width:640px) { .pair { grid-template-columns:1fr; } }
</style>
<div class="wrap">
  <header>
    <div class="wordmark" aria-label="peerd"><b>p</b><b>e</b><b>e</b><b>r</b><b>d</b></div>
    <span class="eyebrow">visual gallery</span>
    <h1>Side panel — every view, light &amp; dark</h1>
    <div class="meta">
      <span><b>${states.length}</b> states · <b>${states.length * 2}</b> screens</span>
      <span>baselines · <b>${platform}</b></span>
      <span>generated from <code>scripts/cdp/baselines/</code> — the visual-test reference set</span>
    </div>
  </header>
  <div class="states">
${states.map(card).join('')}
  </div>
  <footer>
    Each screen is the live side panel rendered through the E2E harness at a pinned Chrome build
    and viewport — the exact images the visual-regression gate compares against. Add a state in
    scripts/cdp/states.mjs, reseed, then regenerate: bun scripts/cdp/build-gallery.mjs.
  </footer>
</div>`;

writeFileSync(OUT, html);
console.log(`wrote ${OUT} — ${states.length} states × 2 themes from baselines/${platform} (${(html.length / 1024).toFixed(0)} KB)`);
