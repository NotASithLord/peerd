# Chrome Web Store listing and asset checklist

## Name

peerd

## Summary (132 chars max, also the manifest description)

> An AI assistant that automates tasks in your browser. Local-first:
> your own API key, no account, no servers, no tracking.

## Description (store listing)

Single-purpose framing: ONE product (an assistant), everything else is
a capability of it. No module-by-module enumeration, no "harness", no
"sovereign", no "peer daemon".

---

peerd is an AI assistant that lives in your browser's side panel and
does things for you, not just answers questions.

peerd is an experimental beta. Breaking changes and incomplete browser support
are expected. Review the privacy and security notes before using it with
sensitive data.

Give it a task in plain language (typed or spoken):

• "Summarize this article and pull out every cited statistic."
• "Open the top three Hacker News stories and tell me which is worth
  reading."
• "Fill in this form from the spreadsheet in my other tab."
• "Crunch this CSV and chart the monthly totals."

The assistant reads the page you're on, clicks, types, and navigates,
visibly, in your tabs. When a task needs real computation, it runs the
work in WebAssembly sandboxes that exist entirely inside your browser,
from a quick script, to compiled tools (query a SQLite file, convert a
format), to a full Linux environment. Nothing is installed on your
machine.

YOUR DATA STAYS YOURS

peerd is local-first and has no backend:

• Bring your own AI provider key, or use a configured local provider
  where supported. Keys are stored in an encrypted vault on your device,
  unlocked with a passphrase or Touch ID / Windows Hello, and are only
  ever sent to the provider you selected.
• Conversations, settings, and history live in your browser's local
  storage. No account, no sync, no analytics, no telemetry.
• A built-in Activity log shows tool outcomes, direct open-web fetches,
  and policy denials.

GUARDRAILS ON BY DEFAULT

• peerd refuses to operate on sensitive sites out of the box: banks,
  brokerages, crypto exchanges and wallets, health portals, government
  services, and password managers.
• Direct fetch, document reading, and browser automation block localhost,
  private-network, link-local, and cloud-metadata targets. Driven tabs use a
  tab-scoped browser network rule so redirects and tab-associated requests are
  blocked before the target loads. Private-network rules also cover service-worker
  fetches from public domains visited in the driven tab until custody ends.
  A normal tab on the same matching domain can temporarily lose private-network
  service-worker fetch access.
  Local AI providers use a
  separate opt-in path.
• Risky actions ask for your confirmation first.

Choose a supported local provider or supply your own provider API key. peerd is
independent software and is not affiliated with any provider.

---

## Category

Productivity → Tools (or "Workflow & Planning")

## Language

English

## Assets checklist

| Asset | Spec | Status |
|---|---|---|
| Store icon | 128×128 PNG, 96×96 art + 16px transparent padding | ✅ `extension/icons/icon128.png`, with spec-compliant padding. Padded source: `docs/store/assets/peerd-icon-128.svg`. Full-bleed master and larger renders: `docs/store/assets/peerd-icon*`. The smaller toolbar icons stay full bleed. |
| Screenshots (≥1, max 5) | 1280×800 or 640×400 | ☐ capture, see shot list below |
| Small promo tile | 440×280 PNG | ✅ `docs/store/assets/promo-440x280.png` |
| Marquee promo tile (optional) | 1400×560 PNG | ✅ `docs/store/assets/marquee-1400x560.png` |
| Privacy policy URL | published page | ☐ publish `docs/store/PRIVACY.md` at https://peerd.ai/privacy (deploys from the `peerd-site` repo) |
| Demo video for reviewer | unlisted YouTube link | ☐ record (agent task → VM boot → audit log) |

### Screenshot shot list (1280×800)

1. Side panel open next to a real article, mid-task: user asked for a
   summary, assistant's answer visible. (Hero shot.)
2. The assistant operating a page: tab group visible, automation in
   progress. (Shoot from the store build because it operates pages via
   chrome.scripting, so there is no debugger banner to stage.)
3. VM tab with the terminal: `uname -a` output after "boot a linux vm".
4. Audit log view: allowed + denied entries visible (show a denylist
   block of a bank if possible).
5. Vault/onboarding: the BYOK screen with passphrase / Touch ID unlock.

Capture at 1280×800 device pixels, light-on-dark as the UI ships. No
mockups or composited frames; store policy requires actual product UI.
