# Dependency update and security-release policy

Every automatically merged dependency release seasons for 30 days. Dependabot
security PRs are opened immediately, but the deliberately narrow no-human path
also verifies the replacement artifact's publication age before it can merge.
A fresh security fix remains visible and tested in an open PR while a person
decides whether the known vulnerability outweighs the fresh-artifact risk.

## Covered dependency manifests

`.github/dependabot.yml` covers both dependency manifests in this repository:

- `package.json` plus the committed `bun.lock` (`package-ecosystem: bun`),
  including development dependencies and exact-pinned release tooling.
- Every SHA-pinned `uses:` reference under `.github/workflows/`
  (`package-ecosystem: github-actions`).

Routine updates are grouped per ecosystem and held until the candidate version
is at least 30 days old. GitHub applies `cooldown` to version updates, not to
Dependabot security updates, so the trusted workflow independently checks every
security replacement's registry or GitHub release timestamp. `bunfig.toml`
also applies Bun's native 30-day filter to new local/manual resolution of both
direct and transitive packages; existing locked versions remain reproducible.

Security updates use distinct `bun-security-patches` and
`actions-security-patches` groups. Their names are security boundaries: the
trusted automation accepts no other group.

## No-human security path

`.github/workflows/dependabot-security-release.yml` accepts a PR only when all
of these are true:

1. `dependabot/fetch-metadata` authenticates the Dependabot author and every
   existing Dependabot commit (commit verification is not skipped).
2. The PR came from one of the explicit security-only groups, targets `/` on
   `main`, is same-repository, and has no maintainer edits.
3. The dependency update is semver patch-level. A security fix requiring a
   minor or major dependency change gets an immediate PR but remains
   human-reviewed.
4. Every replacement has been public for at least 30 days. Bun versions are
   checked against the exact npm registry publication timestamp and integrity
   metadata. Actions must have a stable GitHub Release at least 30 days old,
   whose tag resolves to the newly pinned full SHA and whose commit GitHub
   marks verified.
5. A Bun PR changes only `package.json` dependency versions and/or `bun.lock`.
   An Actions PR changes only full-SHA-pinned `uses:` lines in workflow YAML.
6. Candidate dependency lifecycle scripts are disabled. Socket scanning and
   deterministic generation run on a disposable runner with only a read token.
   Its patch is treated as untrusted input; candidate code never shares a
   runner with a repository-write token.
7. The workflow increments peerd's patch version, adds release notes,
   regenerates the development manifest, and, for Bun updates, rebuilds the
   checked-in CodeMirror bundle and its complete SHA-256 vendor lock.
8. A fresh privileged runner re-authenticates the original PR, rechecks the
   seasoning policy, and applies only the exact expected version, changelog,
   manifest, and CodeMirror hash changes without installing or executing the
   candidate graph. It then commits the output, pins that exact commit with a
   dedicated validation tag, and dispatches correctness/package and security
   workflows in a read-only mode. Jobs whose token can write repository state
   or upload SARIF are skipped so a candidate Action SHA never shares their
   authority. The workflow records and waits for the two exact dispatched run
   IDs, then rechecks the PR head and approves it. No auto-merge is left armed.
   Once those runs pass, it starts a trusted finalizer through
   `repository_dispatch` (the documented
   `GITHUB_TOKEN` event exception) and performs a protected squash merge with a
   matching-head constraint.
9. The already-running finalizer waits for and re-authenticates that exact
   merged PR and marker, verifies a one-patch version increment and main
   ancestry, creates the tag idempotently, and dispatches the existing signed
   release workflow at that tag with an exact merge-SHA constraint. Starting it
   before the merge removes any reliance on a token-triggered pull-request
   event after the merge.

Any ambiguity fails closed: the PR remains open for a person rather than being
merged or tagged.

The 30-day rule addresses a different trust boundary from Dependabot. GitHub's
advisory review and verified bot commits establish that the old version matches
a reviewed advisory and that Dependabot authored the PR. They do not establish
that a newly published upstream tarball or Action commit contains no unrelated
malicious behavior.

## Checked-in libraries

Every byte under `extension/vendor/` is always integrity-checked against
`extension/vendor/vendor.lock.json` in CI. CodeMirror is additionally updated
by the no-human path because its complete source dependency graph is in
`package.json`/`bun.lock`, the bundle has a deterministic Bun generator, and
the result is covered by the vendor lock.

Every other entry in `extension/vendor/vendor.lock.json` remains
integrity-pinned but is not automatically upgraded. The adjacent `SOURCE.txt`,
`VERSION`, and checksum files are the live inventory and provenance record;
duplicating that changing list here would drift. Those update recipes include
one or more of local patches, CDN or tarball hash changes, multi-package version
coupling, WASM/model assets, license/provenance review, or browser/microphone
smoke tests. Treating them as an ordinary lockfile regeneration would weaken,
not strengthen, the security posture. A library should move to the automatic
set only after receiving a deterministic generator and a dedicated behavioral
gate.

OS/package-manager inputs, browser/runtime pins, models, and remote assets that
are not expressed in `dependabot.yml` are also outside Dependabot coverage.

## Independent supply-chain signals

Socket's exact-pinned Bun scanner is configured in `bunfig.toml`. It uses the
unauthenticated public API (no Socket secret or account), scans the resolved
graph before installation, and fails non-interactive CI on warning or fatal
findings. This complements OSV by looking for malware and suspicious package
behavior rather than only known CVEs. Text `bun.lock` support is currently a
public beta. The scanner necessarily sends the already-public dependency
snapshot to Socket.

Every Actions job starts the full-SHA-pinned, seasoned StepSecurity
Harden-Runner in audit mode. It records source writes and outbound destinations,
builds a per-job baseline, and surfaces anomalous behavior. Audit mode observes
but does not block egress; move individual jobs to block mode only after their
legitimate endpoint baselines are established. On a public repository, workflow
logs and StepSecurity network insights should be treated as public operational
evidence.

The Socket GitHub App is not installed. It would add visible PR checks and
experimental GitHub Actions scanning, but also requests repository contents
write access so it can create patch PRs. That broader external grant is not
needed for the Bun scanner and remains a separate owner decision. Neither
Socket nor StepSecurity replaces seasoning, immutable pins, or the existing
tests.

## One-time repository settings

The workflow is versioned, but GitHub does not store the following controls in
the repository. Apply them only after this workflow is present on `main`:

- Keep Dependabot alerts and security updates enabled (already enabled at the
  time this policy was introduced).
- Allow GitHub Actions to create pull-request approvals.
- Keep one required approval and stale-review dismissal on `main`, but turn off
  “require review from Code Owners.” The Actions bot cannot be the repository's
  Code Owner; ordinary PRs still require one approval.
- Add `CodeQL (javascript-typescript)`, `OSV scan (resolved dependency tree)`,
  and `peerd security invariants` to the required checks alongside the existing
  full correctness/package matrix.
- On the `release` environment, restrict deployments to tags matching `v*` and
  remove the required reviewers. The release job itself rejects tags whose
  commit is not reachable from protected `main`, checks the tag/package
  version match, rebuilds and verifies all artifacts, signs them, attests
  provenance, and creates the GitHub release.

Removing the environment reviewer makes every valid `v*` release from
protected `main` automatic, not only security releases. A separate automatic
environment would be narrower, but it would require copying the three signing
secrets into that environment; GitHub does not permit workflows to read and
copy existing secret values.
