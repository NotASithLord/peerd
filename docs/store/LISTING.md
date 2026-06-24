# Chrome Web Store — listing copy & asset checklist

## Name

peerd

## Summary (132 chars max — also the manifest description)

> An AI assistant that automates tasks in your browser. Local-first:
> your own API key, no account, no servers, no tracking.

## Description (store listing)

Single-purpose framing: ONE product (an assistant), everything else is
a capability of it. No module-by-module enumeration, no "harness", no
"sovereign", no "peer daemon".

---

peerd is an AI assistant that lives in your browser's side panel and
does things for you, not just answers questions.

Give it a task in plain language (typed or spoken):

• "Summarize this article and pull out every cited statistic."
• "Open the top three Hacker News stories and tell me which is worth
  reading."
• "Fill in this form from the spreadsheet in my other tab."
• "Crunch this CSV and chart the monthly totals."

The assistant reads the page you're on, clicks, types, and navigates,
visibly, in your tabs. When a task needs real computation, it runs the
work in a sandboxed Linux environment that exists entirely inside your
browser tab (WebAssembly, nothing is installed on your machine).

YOUR DATA STAYS YOURS

peerd is local-first and has no backend:

• Bring your own AI provider key, or use a configured local provider
  where supported. Keys are stored in an encrypted vault on your device,
  unlocked with a passphrase or Touch ID / Windows Hello, and are only
  ever sent to the provider you selected.
• Conversations, settings, and history live in your browser's local
  storage. No account, no sync, no analytics, no telemetry.
• A built-in audit log shows every network request the assistant made,
  including the ones peerd blocked.

GUARDRAILS ON BY DEFAULT

• peerd refuses to operate on sensitive sites out of the box: banks,
  brokerages, crypto exchanges and wallets, health portals, government
  services, password managers, and identity providers.
• It blocks arbitrary localhost and local-network web access. The local
  AI-provider path is opt-in and separate from open-web browsing tools.
• Risky actions ask for your confirmation first.

You'll need an API key from your AI provider to use peerd. peerd is
independent software and is not affiliated with any AI provider.

---

## Category

Productivity → Tools (or "Workflow & Planning")

## Language

English

## Assets checklist

| Asset | Spec | Status |
|---|---|---|
| Store icon | 128×128 PNG, 96×96 art + 16px transparent padding | ✅ `extension/icons/icon128.png` — rainbow-stripe icon, spec-compliant padding. Padded source `docs/store/assets/peerd-icon-128.svg`; full-bleed master + 256/512 renders `docs/store/assets/peerd-icon*`. 16/32/48 stay full-bleed by design, since padding at toolbar sizes shrinks the art too far |
| Screenshots (≥1, max 5) | 1280×800 or 640×400 | ☐ capture — see shot list below |
| Small promo tile | 440×280 PNG | ✅ `docs/store/assets/promo-440x280.png` |
| Marquee promo tile (optional) | 1400×560 PNG | ✅ `docs/store/assets/marquee-1400x560.png` |
| Privacy policy URL | published page | ☐ deploy `the website/privacy.html` → https://peerd.ai/privacy |
| Demo video for reviewer | unlisted YouTube link | ☐ record (agent task → VM boot → audit log) |

### Screenshot shot list (1280×800)

1. Side panel open next to a real article, mid-task: user asked for a
   summary, assistant's answer visible. (Hero shot.)
2. The assistant operating a page: tab group visible, automation in
   progress, Chrome's debugger banner in frame.
3. VM tab with the terminal: `uname -a` output after "boot a linux vm".
4. Audit log view: allowed + denied entries visible (show a denylist
   block of a bank if possible).
5. Vault/onboarding: the BYOK screen with passphrase / Touch ID unlock.

Capture at 1280×800 device pixels, light-on-dark as the UI ships. No
mockups or composited frames; store policy requires actual product UI.
