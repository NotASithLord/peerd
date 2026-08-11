# Peerd Pod implementation plan

Status: implemented and verified on `feature/peerd-pod`.

## Findings from the existing execution stack

1. Notebook instances are durable registry records hosted in visible tabs. The
   shared tab tracker re-adopts surviving tabs after a service-worker restart;
   every evaluation is a fresh sealed Worker and durable state lives in a
   per-instance OPFS root.
2. Script uses the same `buildWorkerSource()` in the offscreen document. Its
   optional named workspace already proves that a fresh sealed Worker can use a
   durable, host-mounted OPFS root without receiving storage authority.
3. `opfsHelpers()` is the single rooted filesystem boundary used by Notebook,
   App, Script workspaces, Git, and artifact code. It already supports text and
   binary files, recursive listing, and subtree destruction.
4. `peerd:wasi` is WASI Preview 1 command execution inside the sealed Worker,
   backed by `browser_wasi_shim` and a fresh in-memory inode tree.
5. WASI receives only descriptors created by the wrapper. It has no network or
   OPFS imports, and the host Worker timeout bounds CPU. Its current result
   returns the post-run file tree but cannot report deletions relative to an
   existing workspace.
6. Browser Git is a trusted engine resource built on isomorphic-git and one
   OPFS filesystem adapter. It already implements init/status/commit/history,
   branch/checkout, clone/fetch/push, quotas, credentials, audit, and serialized
   mutation. Repository paths currently recognize only App and Notebook.
7. Worker HTTP is structurally brokered: the realm seal replaces `fetch`,
   blocks other network constructors and same-origin storage APIs, and the host
   relays requests to `sw/web-fetch`, which applies SSRF/denylist/audit policy.
8. Worker capability profiles are enforced both in the generated Worker realm
   and at the host relay. Engine actors are additionally keyless offscreen
   heaps with a positive per-kind tool allow-list and instance-id pinning.
9. Engine actors are lazily minted from instance registry records. The actor
   session is bound in both directions, receives only its kind's tools, and is
   re-minted if its session is lost.
10. The lifecycle layer durably tracks dispatched operations and live engine
    hosts. A lost tab is reported as lost process state while catalog/workspace
    bytes remain. Arbitrary execution tools are retry class E, so an ambiguous
    worker loss is reported and never blindly replayed.

## Smallest architecture

Pod will be a fourth tab-hosted engine kind, not a second runtime stack:

```text
Pod registry + shared tab tracker
              |
              v
        trusted Pod tab host
        /        |        \
 rooted OPFS  Git service  sw/web-fetch
        \        |        /
         fresh sealed job Worker
          shell / JS / WASI
```

- Add a thin Pod registry, tracker, and client using the existing factories.
- Add one focused shell core with parsing, expansion, pipelines, redirection,
  built-ins, command results, and injected IO. It does not emulate POSIX.
- Run each foreground/background command in a fresh sealed Worker. The tab owns
  the job table and terminates that Worker for cancel/timeout. `cwd` and the
  environment are explicit session values returned by a completed foreground
  job; all durable state is OPFS.
- Extend rooted OPFS with the directory/stat/copy/move operations shell
  built-ins need and expose only those operations through a Pod-id-pinned relay.
- Keep `runWasi()` unchanged. Add pure snapshot reconciliation to `peerd:wasi`;
  a Pod job reads workspace bytes through its host capability, runs the module
  against the existing in-memory descriptor tree, then applies explicit
  writes/deletes through the same bridge. A command sees the shared workspace,
  while WASM still sees only an in-memory filesystem capability.
- Map the `git` shell command to the existing repository service in the service
  worker. Add `pod` to repository path kinds; do not load isomorphic-git in the
  untrusted Worker.
- Map `curl` to the sealed realm's bridged `fetch`. Raw sockets, WebSockets,
  remote JS imports, extension APIs, IDB, Cache Storage, and vault access remain
  absent. The Pod page adds `connect-src 'none'` as a backstop.
- Add Pod-scoped tools (`pod_exec`, read/write/status/destroy) and include Pod in
  `sandbox_create`, `actor_list`, actor pinning, tuned prompt lore, liveness
  recovery, and the execution-spectrum copy.
- Reuse the Notebook editor component in the Pod tab for file inspection while
  keeping the terminal UI small.

## Intentional limits

No Node/npm layer, native Linux binaries, PTY, signals, sockets, package manager,
or shell-compliance project. Browser Git retains its current limits. Concurrent
jobs share OPFS with ordinary last-writer-wins file semantics; Git mutations stay
serialized by the repository service. Worker loss preserves persistent bytes but
loses cwd/environment/live jobs, and ambiguous side effects are not replayed.

## Verification order

1. Pure tests: parser, expansion, pipelines/redirection, exit/status shaping,
   path confinement, WASI snapshot reconciliation, job-state transitions.
2. Repository and exposure tests: Pod path mapping, Git commands, actor
   allow-list and instance pinning, retry class E.
3. Browser tests: OPFS persistence/isolation, sealed-network negatives,
   controlled fetch, real WASI workspace writes/deletes, cancellation/timeout,
   concurrent jobs, tab loss/reopen.
4. Run the full Bun/type/lint suites, the in-browser harness in Chromium, the
   packaged Firefox Pod smoke, then the visual E2E loop and inspect every
   changed screenshot.
5. Record cold create, warm command start, built-in latency, WASI latency, and
   persistent reopen from the real extension surfaces.

## Integration finding: Firefox dynamic JavaScript

The base architecture stayed cross-browser for shell, OPFS, WASI, Git, jobs,
egress, and persistence. Current Firefox MV3 does not permit a dynamic blob
Worker from an extension page, so the Notebook-derived JavaScript module Worker
cannot launch there. The implementation fails that command explicitly while
leaving the rest of the Pod live. A manifest-sandbox/`unsafe-eval` fallback was
considered and rejected: it would create a second dynamic-code boundary and
cross-frame capability bridge merely to work around platform policy. That is
outside the small composition architecture this plan selected.
