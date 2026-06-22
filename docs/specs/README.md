# docs/specs/

> The home for **forward-looking feature specs** — designs for things
> not yet built (or only partly built). Distinct from the rest of
> `docs/`, which mostly records features that already shipped.

A spec lands here when a feature has a clear enough shape to write down
but hasn't been built. When it ships, the spec stays as the design
record (optionally cross-linked from `docs/README.md` and `ROADMAP.md`)
— specs are not deleted on landing, they become history.

House shape for a spec (loose, not enforced):

- A `>` blockquote header: one-line what-it-is, the date, and lineage
  (what it supersedes / sits beside).
- **Summary** — the thesis in a paragraph. What we're building and the
  one idea that makes it simple.
- **Non-goals / scope** — say what this is *not*, early. Specs rot when
  scope creeps silently.
- **Model**, **UX**, **state**, **security** — as the feature needs.
- **Open questions** — the decisions deliberately deferred.

## Index

- **`PHONE-REMOTE-CONTROL.md`** — driving the browser agent from a
  phone, as a remote view + command inlet over a direct sealed
  channel. The phone is a remote `uiPort`, not a peer; the desktop is
  the single authoritative writer.
