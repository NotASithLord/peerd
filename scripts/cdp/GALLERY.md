# peerd — visual gallery

**28 states · 56 screens · baselines `linux-x64`**

Every screen below is the live UI rendered through the E2E harness at a pinned
Chrome build and viewport — the exact images the visual-regression gate compares
against.

> **Generated file.** Add a state in [`states.mjs`](states.mjs), reseed the
> baselines (dispatch the workflow with `update_visual_baselines`), then
> regenerate with `bun run gallery` and commit. CI fails if this drifts from
> the committed baselines.

---

### 01 · Vault gate

`initial-screen` — First-run setup — the lock mark crowns the wordmark.

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/initial-screen.light.png" alt="Vault gate (light)" width="380"> | <img src="baselines/linux-x64/initial-screen.dark.png" alt="Vault gate (dark)" width="380"> |

### 02 · Empty chat

`idle-unlocked` — Home — path cards, voice prompt, the composer.

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/idle-unlocked.light.png" alt="Empty chat (light)" width="380"> | <img src="baselines/linux-x64/idle-unlocked.dark.png" alt="Empty chat (dark)" width="380"> |

### 03 · Completed turn

`completed-turn` — A finished exchange — operator-cyan user bubble.

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/completed-turn.light.png" alt="Completed turn (light)" width="380"> | <img src="baselines/linux-x64/completed-turn.dark.png" alt="Completed turn (dark)" width="380"> |

### 04 · Multi-turn

`multi-turn-transcript` — Bubbles carry across turns.

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/multi-turn-transcript.light.png" alt="Multi-turn (light)" width="380"> | <img src="baselines/linux-x64/multi-turn-transcript.dark.png" alt="Multi-turn (dark)" width="380"> |

### 05 · Thinking

`busy-thinking` — A turn mid-flight — the spinner + Stop.

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/busy-thinking.light.png" alt="Thinking (light)" width="380"> | <img src="baselines/linux-x64/busy-thinking.dark.png" alt="Thinking (dark)" width="380"> |

### 06 · Plan mode

`mode-plan` — The segmented Plan/Act control + mono chips.

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/mode-plan.light.png" alt="Plan mode (light)" width="380"> | <img src="baselines/linux-x64/mode-plan.dark.png" alt="Plan mode (dark)" width="380"> |

### 07 · Tool call

`tool-card-expanded` — An expanded tool-call card with its lineage body.

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/tool-card-expanded.light.png" alt="Tool call (light)" width="380"> | <img src="baselines/linux-x64/tool-card-expanded.dark.png" alt="Tool call (dark)" width="380"> |

### 08 · Goal running

`goal-running` — Goal bar, plan-todo card, tool-call cards.

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/goal-running.light.png" alt="Goal running (light)" width="380"> | <img src="baselines/linux-x64/goal-running.dark.png" alt="Goal running (dark)" width="380"> |

### 09 · Failed turn

`error-turn` — The error banner + failure-class chip.

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/error-turn.light.png" alt="Failed turn (light)" width="380"> | <img src="baselines/linux-x64/error-turn.dark.png" alt="Failed turn (dark)" width="380"> |

### 10 · Chats

`sessions-list` — The sessions list — active row highlighted.

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/sessions-list.light.png" alt="Chats (light)" width="380"> | <img src="baselines/linux-x64/sessions-list.dark.png" alt="Chats (dark)" width="380"> |

### 11 · Home (full tab)

`home-fulltab` · `full tab · 1280` — The large in-browser view — nav rail, app library.

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/home-fulltab.light.png" alt="Home (full tab) (light)" width="460"> | <img src="baselines/linux-x64/home-fulltab.dark.png" alt="Home (full tab) (dark)" width="460"> |

### 12 · Settings (full tab)

`options-fulltab` · `full tab · 1280` — The full-tab options page — providers, security, memory.

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/options-fulltab.light.png" alt="Settings (full tab) (light)" width="460"> | <img src="baselines/linux-x64/options-fulltab.dark.png" alt="Settings (full tab) (dark)" width="460"> |

### 13 · app-tab-failed

`app-tab-failed`

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/app-tab-failed.light.png" alt="app-tab-failed (light)" width="380"> | <img src="baselines/linux-x64/app-tab-failed.dark.png" alt="app-tab-failed (dark)" width="380"> |

### 14 · eval-runner

`eval-runner`

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/eval-runner.light.png" alt="eval-runner (light)" width="380"> | <img src="baselines/linux-x64/eval-runner.dark.png" alt="eval-runner (dark)" width="380"> |

### 15 · home-library-git

`home-library-git`

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/home-library-git.light.png" alt="home-library-git (light)" width="380"> | <img src="baselines/linux-x64/home-library-git.dark.png" alt="home-library-git (dark)" width="380"> |

### 16 · login-confirm

`login-confirm`

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/login-confirm.light.png" alt="login-confirm (light)" width="380"> | <img src="baselines/linux-x64/login-confirm.dark.png" alt="login-confirm (dark)" width="380"> |

### 17 · mic-permission

`mic-permission`

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/mic-permission.light.png" alt="mic-permission (light)" width="380"> | <img src="baselines/linux-x64/mic-permission.dark.png" alt="mic-permission (dark)" width="380"> |

### 18 · narrow-sidebar

`narrow-sidebar`

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/narrow-sidebar.light.png" alt="narrow-sidebar (light)" width="380"> | <img src="baselines/linux-x64/narrow-sidebar.dark.png" alt="narrow-sidebar (dark)" width="380"> |

### 19 · notebook-tab-failed

`notebook-tab-failed`

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/notebook-tab-failed.light.png" alt="notebook-tab-failed (light)" width="380"> | <img src="baselines/linux-x64/notebook-tab-failed.dark.png" alt="notebook-tab-failed (dark)" width="380"> |

### 20 · options-behavior

`options-behavior`

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/options-behavior.light.png" alt="options-behavior (light)" width="380"> | <img src="baselines/linux-x64/options-behavior.dark.png" alt="options-behavior (dark)" width="380"> |

### 21 · options-contributor-metrics

`options-contributor-metrics`

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/options-contributor-metrics.light.png" alt="options-contributor-metrics (light)" width="380"> | <img src="baselines/linux-x64/options-contributor-metrics.dark.png" alt="options-contributor-metrics (dark)" width="380"> |

### 22 · options-denylist

`options-denylist`

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/options-denylist.light.png" alt="options-denylist (light)" width="380"> | <img src="baselines/linux-x64/options-denylist.dark.png" alt="options-denylist (dark)" width="380"> |

### 23 · options-dweb-stop-failed

`options-dweb-stop-failed`

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/options-dweb-stop-failed.light.png" alt="options-dweb-stop-failed (light)" width="380"> | <img src="baselines/linux-x64/options-dweb-stop-failed.dark.png" alt="options-dweb-stop-failed (dark)" width="380"> |

### 24 · options-learned-sites

`options-learned-sites`

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/options-learned-sites.light.png" alt="options-learned-sites (light)" width="380"> | <img src="baselines/linux-x64/options-learned-sites.dark.png" alt="options-learned-sites (dark)" width="380"> |

### 25 · options-transfer

`options-transfer`

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/options-transfer.light.png" alt="options-transfer (light)" width="380"> | <img src="baselines/linux-x64/options-transfer.dark.png" alt="options-transfer (dark)" width="380"> |

### 26 · options-transfer-conflict

`options-transfer-conflict`

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/options-transfer-conflict.light.png" alt="options-transfer-conflict (light)" width="380"> | <img src="baselines/linux-x64/options-transfer-conflict.dark.png" alt="options-transfer-conflict (dark)" width="380"> |

### 27 · site-client-confirm

`site-client-confirm`

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/site-client-confirm.light.png" alt="site-client-confirm (light)" width="380"> | <img src="baselines/linux-x64/site-client-confirm.dark.png" alt="site-client-confirm (dark)" width="380"> |

### 28 · vm-tab-failed

`vm-tab-failed`

| light | dark |
| --- | --- |
| <img src="baselines/linux-x64/vm-tab-failed.light.png" alt="vm-tab-failed (light)" width="380"> | <img src="baselines/linux-x64/vm-tab-failed.dark.png" alt="vm-tab-failed (dark)" width="380"> |

---

<sub>Generated by <code>scripts/cdp/build-gallery.mjs</code> from <code>scripts/cdp/baselines/</code>.
Do not edit by hand — run <code>bun run gallery</code>.</sub>
