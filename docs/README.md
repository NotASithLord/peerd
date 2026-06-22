# docs/

Primary docs live at the **project root**, not here:
`CLAUDE.md` (read first), `ARCHITECTURE.md`, `ARCHITECTURE-CHANGES.md`,
`ROADMAP.md`, `STATUS.md`, `TODO.md`, `PACKAGING.md`, `DESIGN.md` (the
V1 design record).

This folder holds supporting material — recorded decisions and
per-feature design docs:

- **`DECISIONS.md`** — recorded design tradeoffs, with dated addenda
  when one is reopened. Read before reopening anything it covers.
- **`SUBAGENTS.md`** — depth-bounded subagent orchestration.
- **`REVIEW.md`** — the clean-context review subagent (feature 08).
- **`RALPH.md`** / **`RALPH-DEV-NOTES.md`** — the persistent
  fresh-context loop (feature 05).
- **`COMMANDS-DESIGN.md`** / **`COMMANDS-DEV-NOTES.md`** — composer
  slash commands + @-refs (feature 04).
- **`DO-GET-CHECK-DESIGN.md`** / **`DO-GET-CHECK-DEV-NOTES.md`** — the
  high-level browser-tool layer over the runner.
- **`DOM-NAVIGATION-DESIGN.md`** / **`DOM-NAVIGATION-ASSESSMENT.md`** —
  the snapshot/@e-ref DOM navigation path.
- **`CLAUDE-CODE-UPDATES-2.md`** — upstream pattern notes.
- **`hooks/`** — pre/post tool-use hooks (feature 10).
- **`skills/`** — progressive-disclosure skills (feature 07).
- **`store/`** — Chrome Web Store posture: listing copy, permission
  justifications, privacy doc, reviewer notes, open decisions.
- **`distributed/`** — dweb scope: `ROADMAP.md` (supersedes the root
  roadmap's dweb phasing) and `THREAT-MODEL.md` (dweb-scoped).
- **`specs/`** — the consolidated home for feature specs and their design
  records: forward-looking designs, landed records (kept as history), and
  the research that fed them. See `specs/README.md` for the indexed list.

Future:

- A product-wide `THREAT_MODEL.md` (the dweb-scoped one exists at
  `distributed/THREAT-MODEL.md`; the product-wide model is implicit in
  `DECISIONS.md` + the six-gate dispatcher + the audit log).
- `SECURITY.md` — disclosure process. Pre-V0.1, just file an issue.
