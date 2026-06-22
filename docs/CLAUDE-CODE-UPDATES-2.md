# Claude Code — change directive (round 2)

Two new V1 subsystems land in `peerd-runtime/`. Both are documented in
the design + architecture docs; this file is the pasteable summary and
the implementation order.

## What's new

### 1. Temporal grounding — `peerd-runtime/clock/`

Spartan per-turn temporal block injected into prompts. Default cost
~15 tokens. Conditional expansion (idle, events) only when notable.
Hard cap at 50 tokens.

**Files to create:**

```
peerd-runtime/clock/
├── now.js         # primitives: now(), since(checkpoint), formatDelta(ms)
├── events.js      # background event recorder + notable-event classifier
├── context.js     # buildTemporalBlock({ events, lastTurnAt, now }) → string
└── tools.js       # registered tools: now, time_since, wait_until
```

**Format (default — ~15 tokens):**

```
<time>2026-06-05T14:34:21Z · t+47s</time>
```

**Format (with idle marker — when user idle >30s during gap):**

```
<time>2026-06-05T14:34:21Z · t+22m · idle 18m</time>
```

**Format (with events — when notable events occurred between turns):**

```
<time>2026-06-05T14:34:21Z · t+5m · tab→github.com, sleep 3m</time>
```

**Notable events (include in block):**
- Active-tab navigation
- System sleep/wake (>1min)
- Network online/offline transition
- Session pause/resume
- Extension reload (SW restart)

**Filtered events (do not include):**
- Pointer movement, scroll, key presses
- Inactive-tab loads
- Ordinary network requests
- Idle <30s

**Event buffer:**
- Lives in `events.js`, runs in service worker
- Rolling buffer: last 24h, capped at 1000 entries
- Persists across SW restarts via `chrome.storage.session`
- Classified on arrival (notable vs filtered)

**Integration point:**

`peerd-runtime/loop/system-prompt.js` calls
`buildTemporalBlock({ events, lastTurnAt, now })` and inserts the
returned string immediately before the latest user message.

**Tools registered:**

```js
// peerd-runtime/clock/tools.js
export const clockTools = [
  {
    name: 'now',
    description: 'Get current ISO timestamp + timezone + day-of-week. Optional checkpoint label for later time_since() calls.',
    inputSchema: { type: 'object', properties: { checkpoint: { type: 'string' } } },
    execute: ({ checkpoint }) => { /* ... */ }
  },
  {
    name: 'time_since',
    description: 'Time elapsed since a named checkpoint set via now().',
    inputSchema: { type: 'object', properties: { checkpoint: { type: 'string', required: true } } },
    execute: ({ checkpoint }) => { /* ... */ }
  },
  {
    name: 'wait_until',
    description: 'Block agent for a duration ("47s", "5m") or until an absolute ISO timestamp. Paranoid trust mode requires confirmation for waits >60s.',
    inputSchema: { type: 'object', properties: { when: { type: 'string', required: true } } },
    execute: ({ when }) => { /* ... */ }
  }
];
```

V1.1+ adds `wait_for_event(type, timeout)` for event-driven waits.

---

### 2. Web tool policy — `peerd-runtime/tools/web/`

Explicit policy for choosing between `safeFetch` (background HTTP) and
a tab (offscreen/inactive/active) when reaching a web resource.

**Files to create:**

```
peerd-runtime/tools/web/
├── POLICY.md         # in-tree policy doc — see below
├── primitives.js     # safeFetch, open_tab, offscreen_render
├── search.js         # web_search        → always tab
├── read.js           # read_article      → safeFetch with tab fallback
├── api.js            # call_api          → always safeFetch
├── form.js           # submit_form       → always tab
└── screenshot.js     # capture           → always tab
```

**POLICY.md content (verbatim):**

```markdown
# Web tool policy

Peerd has two ways to read or interact with a web resource: `safeFetch`
(a vetted background HTTP call) and a real browser tab. They serve
different purposes and have different costs.

## Use safeFetch when

- Target is a known JSON API (REST, GraphQL, RSS, JSON-LD)
- Target is server-rendered HTML where response contains content
- Only metadata is needed (OG tags, title, headers, status)
- High-volume parallel fetches required
- Task is read-only and user's session adds no value
- Paranoid trust mode is active

## Use a tab when

- Target is a SPA (response is shell HTML)
- User's authenticated session is required
- Anti-bot protection blocks raw fetches
- Action required, not just read
- Personalization is the point
- Visual context matters (screenshot, computed styles)
- Content is lazy-loaded

## Three tab variants, in order of cost

1. **Offscreen document** (`chrome.offscreen`) — headless page, no tab strip.
   Default for non-navigation parsing.
2. **Inactive tab** (`chrome.tabs.create({ active: false })`) — real tab,
   loads JS, no focus steal. Default for tab work the user doesn't watch.
3. **Active tab** — focus moves to it. Use only when user needs to see,
   or when focus is required to trigger content.

## Escalation default

Try `safeFetch` first. If response is SPA shell, 403/challenge, or
`expects` schema fails → escalate to inactive tab. Per-tool overrides
exist (`web_search` always tab; `fetch_json` always safeFetch).

## Trust mode interaction

- Open: dispatcher picks the most efficient path
- Scoped: respects per-tool defaults; prompts for non-allowlisted tab opens
- Paranoid: prefers safeFetch; tab opens require explicit confirmation
```

**Wrapper tool stubs:**

```js
// peerd-runtime/tools/web/read.js
export const readArticle = {
  name: 'read_article',
  description: 'Read an article or doc page. Tries safeFetch first; escalates to tab if SPA shell or anti-bot detected.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', required: true },
      expects: { type: 'object', description: 'Optional schema to validate the parsed result against.' }
    }
  },
  async execute({ url, expects }, ctx) {
    const fetched = await ctx.safeFetch(url);
    if (looksLikeSpaShell(fetched) || matchesAntiBotTemplate(fetched) ||
        (expects && !validateSchema(fetched, expects))) {
      return ctx.openInactiveTab(url).then(tab => tab.readArticle());
    }
    return parseArticle(fetched);
  }
};
```

Similar stubs for `search.js`, `api.js`, `form.js`, `screenshot.js`.

**Helpers in `primitives.js`:**

```js
export const safeFetch = (url, opts) => { /* existing safeFetch from peerd-egress */ };
export const openTab = (url, { active = false } = {}) => { /* ... */ };
export const offscreenRender = (html_or_url) => { /* uses chrome.offscreen */ };
```

---

## Implementation order

1. **`clock/now.js`** (1h) — pure primitives, no Chrome API dependencies.
   Trivial to test.
2. **`clock/events.js`** (3-4h) — wires up `chrome.idle`,
   `chrome.tabs.onActivated`, `chrome.windows.onFocusChanged`,
   `chrome.runtime.onStartup`. Classifies events. Maintains buffer.
3. **`clock/context.js`** (1h) — pure formatter. Easy unit tests.
4. **`clock/tools.js`** (1h) — three tool definitions.
5. **Wire `clock/context.js` into `loop/system-prompt.js`** (30min).
6. **`tools/web/primitives.js`** (1h) — wraps existing safeFetch +
   adds openTab + offscreenRender.
7. **`tools/web/POLICY.md`** (paste from above).
8. **`tools/web/read.js`, `api.js`, `search.js`** (3-4h) — wrappers
   with the escalation default.
9. **`tools/web/form.js`, `screenshot.js`** (2h) — tab-only wrappers.
10. **Register all new tools in `tools/registry.js`** (30min).

Total: ~14 hours of work, single session.

## Tests

For clock:
- `formatDelta(0)` → `0s`, `formatDelta(47000)` → `47s`,
  `formatDelta(22*60*1000)` → `22m`, `formatDelta(3700000)` → `1h2m`
- `buildTemporalBlock` with no events and 47s gap → `<time>… · t+47s</time>`
- `buildTemporalBlock` with idle of 18min → includes `idle 18m`
- `buildTemporalBlock` over 50-token cap → truncates events with `… +N more`
- Notable event classifier: `tab.onActivated` for active tab → notable;
  inactive tab load → filtered

For web tools:
- `readArticle` on JSON API URL → uses safeFetch path, returns parsed JSON
- `readArticle` on SPA shell → escalates to inactive tab
- `readArticle` with `expects` schema that fails → escalates
- Trust mode Paranoid + readArticle → prefers safeFetch even when SPA

## What is NOT changing

- The five-module brand mapping
- The trust-mode model (Open/Scoped/Paranoid)
- The persona model (Read/Act — V1.1)
- The dispatcher gate stack
- The vault / WebAuthn unlock
- The WebVM integration

Both additions slot cleanly into existing structures. No reorganization
of other code required.
