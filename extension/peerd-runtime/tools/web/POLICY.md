# Web tool policy

> Authoritative. Tool authors writing web tools (V1 wrappers, V1.x
> additions, V1.4 skills) reference this file directly. Also captured
> in `DESIGN.md §9.5`; this is the in-tree mirror so plugin authors
> reading the source find it without leaving the codebase.

Peerd has two ways to read or interact with a web resource: `safeFetch`
(a vetted background HTTP call) and a real browser tab. They serve
different purposes and have different costs.

## Use safeFetch when

- Target is a known JSON API (REST, GraphQL, RSS, JSON-LD)
- Target is server-rendered HTML where response contains content
- Only metadata is needed (OG tags, title, headers, status)
- High-volume parallel fetches required
- Task is read-only and user's session adds no value

## Use a tab when

- Target is a SPA (response is shell HTML)
- User's authenticated session is required
- Anti-bot protection blocks raw fetches
- Action required, not just read
- Personalization is the point
- Visual context matters (screenshot, computed styles)
- Content is lazy-loaded

## Two tab variants, in order of cost

1. **Offscreen document** (`chrome.offscreen`) — headless page, no tab strip.
   Used for non-navigation parsing / the headless worker.
2. **Active tab** — focus moves to it. The default for `open_tab` and new
   VM/Notebook/App tabs: a tab peerd opens for the user to SEE takes focus
   (DECISIONS #20, 2026-06-14). Acting on an existing tab never re-focuses.

> Historical note: the original V1 wrappers (`web_search`, `read_article`,
> `call_api`, `submit_form`) and the `safeFetch`-vs-tab ESCALATION heuristic
> (`policy.js` `shouldEscalate`) have been REMOVED. The web actor (`kind:'web'`)
> is the single entry point for web work now: it READS via `fetch_url`
> (denylist-gated, sessionless / same-origin-scoped) or its drive-a-tab DOM
> tools, SEARCHES by navigating to a search engine and reading the results, and
> submits FORMS via those DOM tools. The actor PICKS fetch-vs-render itself —
> there is no longer a heuristic that auto-escalates a fetch to a tab.

## The remaining wrapper

Only one web wrapper survives in `WEB_TOOLS`. Everything else moved to the
web actor (`fetch_url` + the DOM toolset).

| Tool          | Default        | Escalates? | sideEffect       |
|---------------|----------------|------------|------------------|
| `capture`     | active tab     | never      | read             |

## V1 visibility default

In V1, all tabs opened by web tools are VISIBLE (the active tab in the
user's tab strip). This is the trust-building default — the user sees
every browsing action. Users who want silent background work flip
`settings.backgroundTabsEnabled`; when on, the prompt gains the
"three tab variants" paragraph above so the model knows the option
exists. When off (default), that paragraph is omitted to save tokens.
