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

## Three tab variants, in order of cost

1. **Offscreen document** (`chrome.offscreen`) — headless page, no tab strip.
   Default for non-navigation parsing.
2. **Inactive tab** (`chrome.tabs.create({ active: false })`) — real tab,
   loads JS, no focus steal. Used for TRANSIENT scrapes (read_article /
   web_search escalation) that open, read, and close.
3. **Active tab** — focus moves to it. The default for `open_tab` and new
   VM/Notebook/App tabs: a tab peerd opens for the user to SEE takes focus
   (DECISIONS #20, 2026-06-14). Acting on an existing tab never re-focuses.

## Escalation default

Try `safeFetch` first. If response is SPA shell, 403/challenge, or
`expects` schema fails → escalate to inactive tab. Per-tool overrides
exist (`web_search` always tab; `call_api` always safeFetch).

## V1 wrapper tools

The five wrappers below cover the common cases. Each encodes the right
choice; the agent should reach for these first and only drop down to
the raw primitives (`safeFetch` via `call_api`, `open_tab` for
arbitrary tab work) when none of the wrappers fit.

| Tool          | Default        | Escalates? | sideEffect       |
|---------------|----------------|------------|------------------|
| `web_search`  | visible tab    | never      | read             |
| `read_article`| safeFetch      | tab        | read             |
| `call_api`    | safeFetch      | never      | read             |
| `submit_form` | active tab     | never      | mutate_external  |
| `capture`     | active tab     | never      | read             |

## V1 visibility default

In V1, all tabs opened by web tools are VISIBLE (the active tab in the
user's tab strip). This is the trust-building default — the user sees
every browsing action. Users who want silent background work flip
`settings.backgroundTabsEnabled`; when on, the prompt gains the
"three tab variants" paragraph above so the model knows the option
exists. When off (default), that paragraph is omitted to save tokens.
