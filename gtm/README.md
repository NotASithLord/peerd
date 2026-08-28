# gtm/ - graph-based go-to-market for peerd

> The Figma playbook, ported to 2026: before launch, Dylan Field scraped
> Twitter, built a network graph of the design community in Gephi, found
> the most influential nodes, and reached out to every one of them
> personally - so Figma's first few hundred users were the *best* possible
> few hundred. This directory is that playbook, runnable, for peerd.

Nothing here ships in the extension. It's a Bun-run analyst toolkit,
same posture as `packaging/` and `scripts/`.

---

## The idea, adapted

The playbook has four steps; only the data sources needed updating:

1. **Map the community.** In 2013 the design community's public graph
   lived on Twitter. In 2026, Twitter/X's API is paywalled and scraping
   it violates ToS - and peerd's communities don't live there anyway.
   The public, ToS-clean graphs that matter for a dev tool like peerd:
   - **GitHub** - the strongest endorsement graph for developer tools.
     Stars say "I care about this space"; follows say "I listen to this
     person."
   - **Bluesky** - a genuinely open follow graph (free, unauthenticated
     AppView API), and the network where the local-first / dweb crowd -
     the `peerd-distributed` audience - actually hangs out.
   - **Hacker News** - no follow graph, but topic engagement: who writes
     and who discusses "browser agent", "local-first", "BYOK" stories.
2. **Build the graph.** Every star, follow, and comment becomes a
   directed *endorsement* edge. The crawl is seeded from communities
   adjacent to peerd (see `seeds.ts` - editing that file IS the
   strategy) and - the important trick - follow edges are kept
   **in-community only**: someone with 300 followers *inside this graph*
   beats someone with 100k generic ones.
3. **Find the influential nodes.** Three lenses, because influence isn't
   one number (weights in `lib/rank.ts`):
   - **PageRank** - who the community endorses.
   - **Betweenness** - who *bridges* sub-communities. Bridges are the
     best evangelists: one post reaches audiences that don't overlap.
   - **Community detection** - so outreach *covers* every cluster
     (browser-agent people, local-first people, p2p people, local-model
     people) instead of saturating the biggest one.
4. **Reach out to every one of them.** Personally. The output is a
   worksheet (`out/outreach.md`), not a mailing list - see the etiquette
   section below.

## Why this fits peerd specifically

peerd's pitch spans four communities that barely overlap: browser
automation, BYOK/local-model privacy, local-first software, and the
dweb/p2p world. That's exactly the situation where the graph beats
intuition - the people who sit at the *intersections* (high betweenness
across those clusters) are rare, findable, and disproportionately
valuable as first users. A "browser agent influencer" list from memory
would miss all of them.

## Run it

```sh
# 1. (recommended) a GitHub token - public data only, no scopes needed
export GITHUB_TOKEN=ghp_…

# 2. crawl (each source caches to gtm/data/<source>.json; resumable per source)
bun gtm/run.ts collect                      # all three sources
bun gtm/run.ts collect --source=bluesky     # just one
bun gtm/run.ts collect --fresh              # ignore caches, recrawl

# 3. score + export
bun gtm/run.ts analyze --top=150
```

`analyze` writes to `gtm/out/` (both `data/` and `out/` are gitignored -
they contain other people's handles; keep them local):

| file | what it's for |
|---|---|
| `graph.gexf` | open in [Gephi](https://gephi.org): color by `community`, size by `pagerank`, run a layout, *look* at it |
| `nodes.csv` | the same table for a spreadsheet |
| `outreach.md` | the ranked worksheet to actually work through |

Crawl caps, retry/backoff, and rate-limit handling live in
`gtm/collect/*.ts` and `gtm/lib/http.ts` - tune caps there, not by
editing loop bodies. The pure scoring core (`gtm/lib/graph.ts`,
`gtm/lib/rank.ts`) is tested from `tests/gtm/` and rides the repo's
strict typecheck.

## Outreach etiquette (the part that makes it work)

Field's insight wasn't the scraping - it was treating the first few
hundred users as a *curated set* worth individual attention:

- **One human, one message.** Reference the thing they actually made or
  wrote (the graph tells you what that is: their repo, their post, the
  story they authored). No templates that smell like templates.
- **Give before asking.** A preview build, a "you specifically will hate
  or love this because X", an honest question about their local-first /
  agent-security take. peerd's BYOK/no-backend posture is itself the
  hook for this crowd - lead with the architecture, not adjectives.
- **Work clusters breadth-first.** `outreach.md` ends with a
  per-community coverage view; recruit a few from *every* cluster before
  going deep in one, and lean on high-betweenness people to cross-post.
- **Track it simply.** Add a `status` column to `nodes.csv` and keep it
  in a private sheet - replied / trying / passed. A few hundred rows
  doesn't need a CRM.
- **Respect the platforms and the people.** Public APIs only (this
  toolkit uses no scraping), honor rate limits, and don't publish the
  collected graph - it's other people's social data, collected for a
  one-time private analysis. Delete `data/` when the campaign is done.

## What this is not

- Not automation for *sending* anything. The toolkit stops at the
  worksheet on purpose; auto-DM'ing a ranked list is how you burn all
  four communities at once.
- Not a growth loop. It's a one-time (maybe quarterly) mapping exercise
  to pick the first few hundred users well. After that, the product and
  the dweb's own network effects have to do the work.
