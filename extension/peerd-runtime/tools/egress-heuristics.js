// @ts-check
// egress-heuristics — best-effort detection of the DOM-data→URL
// exfiltration shape in TAB-TOOL arguments. A TRIPWIRE, not a proof.
//
// WHY THIS EXISTS (#243). The egress-allowlist PreToolUse hook
// (tools/hooks/defaults/egress-allowlist.js) governs the agent's OWN
// outbound fetches, but EXEMPTS every primitive:'tab' tool — those act on
// the user's logged-in browser, which is peerd's whole thesis. That
// exemption is a gap: a prompt-injected turn can smuggle scraped page data
// OUT through a tab tool by navigating (or typing) to a URL that carries the
// data — `attacker.com/?data=<scraped>`, `attacker.com/<scraped>`,
// `attacker.com/#<scraped>`, `https://<scraped>@attacker.com/` (userinfo,
// sent as an Authorization: Basic header), or `https://<scraped>.attacker.com/`
// (DNS-label exfil — the host leaks to the attacker's authoritative DNS +
// TLS SNI + Host header). The URL is off-origin and the tab stack never
// looked at it. This module is the ARGS-half tripwire for that shape.
//
// WHAT IT IS / IS NOT — read this before trusting it. It is a PURE function
// producing allow | block from (name, args, currentOrigin). It is a
// BEST-EFFORT TRIPWIRE layered UNDER the real containment, NOT a guarantee.
// Be precise about what that containment actually is on the shipped build,
// because an earlier draft of this comment cited two defenses that do not
// cover this vector and one that ships OFF:
//   - the offscreen HEAP FENCE is the real one, and it is unconditional: a
//     hijacked actor reasons in a worker holding no vault DK, no chrome.*, and
//     no engine clients, so what it can exfiltrate is bounded by what the page
//     already showed it;
//   - #242 forces a CONFIRM on an authenticated write inside a UGC zone. It is
//     NOT a read-only downscale (that design was considered and rejected —
//     see actor/ugc-registry.js), and it deliberately EXEMPTS navigation, so
//     it does not cover residual 1 below;
//   - #241 constrains the actor's REPLY to the orchestrator, not the tool-arg
//     surface, and ships default-OFF on both channels. Do not count it here.
// This heuristic is a cheap extra veto that catches the OBVIOUS shape early —
// it narrows the attack, it does not close it. Because it is
// not the floor, it is deliberately CONSERVATIVE — it ALLOWS on any
// uncertainty and only BLOCKS a clear payload — since a false block breaks
// the legitimate "read a page, then follow a link on it" flow that is the
// whole point of a browser agent.
//
// DETECTION MODEL — a single DOMINANT high-entropy run over the off-origin
// http(s) destination's three LOW-FALSE-POSITIVE slots: USERINFO, HOSTNAME,
// and PATH. Split each into runs of the URL-SAFE alphabet `A-Za-z0-9_-` (so
// `+`, `/`, `.`, `=`, `&`, space … are run boundaries), keep runs whose local
// entropy clears the bar, and BLOCK when the LONGEST such run reaches
// MIN_BLOB_LENGTH. A scraped-DOM payload dumped into one of these slots is one
// long contiguous token — a shape that has essentially NO legitimate
// population in userinfo or hostname, and only rare ones in a path.
//
// WHY ONLY THESE THREE SLOTS — the query and fragment are DELIBERATELY NOT
// scanned. That is the load-bearing decision, learned the hard way: the query
// and fragment are where legitimate long high-entropy tokens LIVE, and they
// are INDISTINGUISHABLE from an exfil blob by length or entropy —
//   • an OIDC `id_token` (a base64url JWT, often 300–800 chars) returned in
//     the fragment by the implicit/hybrid flow;
//   • a SAML `SAMLRequest` (DEFLATE + standard base64), 200–800 chars;
//   • base64url SPA continuation / pagination tokens on every infinite scroll;
//   • presigned-URL signatures (a GCS V4 `X-Goog-Signature` is 512 hex chars).
// Scanning the query/fragment would FALSE-BLOCK federated login and ordinary
// SPA navigation — a prime-directive violation for a browser agent (this
// module errs toward allow; a false block breaks the user's browsing, a false
// negative is backstopped by #241/#242). Userinfo and hostname carry no such
// legitimate blobs, and a path is normally `/`-segmented into short pieces, so
// those three slots flag the exfil shape without breaking real flows.
//
// WHAT SPARES A PATH: the `/` boundaries, the 100-char length bar, AND — since
// the prose rule landed — the SHAPE of the run. This paragraph used to say the
// opposite ("NOT readability ... real slugs cluster at 70-95 chars and pass"),
// and both halves were wrong: Guardian and TechCrunch permalinks routinely
// exceed 100 characters in one hyphen-joined run, so a user asking peerd to
// read the news got "likely DOM-data exfiltration". Readability now DOES exempt
// a run, decided by separator density rather than by entropy — see
// looksLikeProse for why entropy cannot make that call and what the measured
// error rates are. A large-multihash IPFS subdomain CID collapsing past 100 in
// the host remains an accepted-cost false block.
//
// WHY URL-SAFE alphabet, and why the HOSTNAME is dot-collapsed:
//   - base64url + hex are the URL-SAFE encodings a WORKING URL exfil uses
//     (they survive transit intact). `+`/`/` are run BOUNDARIES because they
//     are URL/form-structural — which lets a deep READABLE path split per `/`
//     segment (no false block). A STANDARD base64 (`btoa`, `+/`) blob thus
//     self-fragments and is a REAL residual: measured against this module, a
//     150-char standard-base64 blob of RANDOM BYTES in the PATH blocks only
//     ~11% of the time (the tail where 100+ consecutive chars happen to avoid
//     both symbols), versus ~100% for base64url. An earlier version of this
//     comment called it "moot ... it would only matter in the query/fragment,
//     which we do not scan anyway" — which is wrong, because the path IS scanned
//     (payloadSlots below) and the path is where a URL exfil actually goes.
//     STATE THE POPULATION, because these rates are not properties of the
//     encoding alone: the same standard-base64 blob blocks 80–100% of the time
//     when it encodes TEXT rather than random bytes (text spends fewer
//     characters on `+`/`/`), and the ~11% figure is the pessimistic end. The
//     same sensitivity ran the other way for hex and USED to be a hole — this
//     comment claimed "~100% for base64url and hex", which held only for random
//     bytes; hex of scraped TEXT measured 0–13% because its entropy falls under
//     the gate. That is why HEX_RUN now skips the entropy check entirely.
//     Named properly because the obvious fix — dropping `+`/`/` from RUN_SPLIT
//     — would re-break the long-readable-path false block that the prose rule
//     in looksLikeProse and the article-slug tests exist to prevent.
//   - the hostname is scanned with its DOTS REMOVED (labels concatenated) so a
//     payload chunked across DNS labels (`<h1>.<h2>.<h3>.attacker.com`, each
//     ≤63 by protocol) re-fuses into one run instead of evading on the dots. A
//     normal hostname collapses to a short / low-entropy string, never tripped.
//
// WHY DOMINANT-RUN AND NOT SUMMED VOLUME. Measuring only the LONGEST run (not
// the sum) is what keeps a path that legitimately carries several independent
// high-entropy segments from being blocked for their combined length; only a
// single dumped blob trips it. (Summing was an earlier revision; it and query-
// scanning both false-blocked OAuth/OIDC-family flows, which is why neither
// survives.)
//
// KNOWN RESIDUALS — do NOT read this as complete coverage:
//   1. THE QUERY AND FRAGMENT. `attacker.com/?d=<blob>` / `#<blob>` is NOT
//      caught — see WHY ONLY THESE THREE SLOTS. This is the largest residual,
//      a deliberate trade to never false-block a login/navigation. NOTHING
//      else covers it: #242 exempts navigation by design, so an off-origin
//      `navigate` with the payload in the query is the arc's one uncontained
//      path. It is not a regression (it predates this module) but it IS the
//      canonical exfil GET, and closing it — most likely by narrowing #242's
//      navigation exemption to same-origin hops while on a UGC page — is the
//      next piece of work, not a solved problem.
//   2. FRAGMENTATION. A payload split across separators so no single run
//      reaches MIN_BLOB_LENGTH (`.`-separated path/label runs, standard-base64
//      `+/` self-fragmentation, fine sub-entropy runs) evades.
//   3. LOW-ENTROPY or SMALL payloads. Data whose OWN entropy is under the gate
//      (a repeated segment, a short natural-language leak) or a single
//      high-entropy token under MIN_BLOB_LENGTH slips through — entropy
//      detection cannot see data that does not look random. HEX is the one
//      encoding carved out of this (HEX_RUN), because hex of ordinary text
//      lands under the gate while being a perfectly working exfil; every other
//      under-gate encoding remains uncaught.
// None of these residuals is CONTAINED elsewhere — the heap fence bounds what
// a hijacked actor knows, and nothing downstream inspects the URL again. Treat
// them as accepted exposure, not as covered. A rare legitimate LONG single run
// that DOES trip the wire — a ≥100-char single PATH segment (an email
// click-tracking wrapper, a magic-link, a path-embedded JWT, OR a genuinely
// long readable slug/title), or a large-multihash IPFS subdomain CID that
// collapses past 100 chars in the HOST — is the accepted cost of catching the
// contiguous-blob shape; #242 is the real containment.
//
// SCOPE. Tab-tool ARGS only. It does NOT cover the page-emitted
// `<img src="attacker.com/?d=…">` beacon vector: that data leaves via the
// page's own network stack, not a tab-tool arg, so no arg-inspection can see
// it. Beacons need a declarativeNetRequest layer — a separate follow-up.

/** @typedef {{ action: 'allow' } | { action: 'block', reason: string }} EgressVerdict */

/**
 * The description of a tab-tool call to inspect. Args are the raw,
 * model-supplied tool arguments; currentOrigin is the origin of the tab the
 * call would act on (absent before any page has loaded).
 * @typedef {Object} TabToolCall
 * @property {string} [name]
 * @property {Record<string, unknown> | null | undefined} [args]
 * @property {string | null | undefined} [currentOrigin]
 */

// Arg fields that can carry a destination URL across the tab tools. `url`
// is navigate's destination; `text`/`value` are what `type` sets (an exfil
// vector only when the typed value itself parses as an absolute URL, e.g.
// pasted into an address-bar-like field). Non-URL values (ordinary search
// strings) simply fail the URL parse below and are ignored.
const URL_ARG_FIELDS = ['url', 'text', 'value', 'href'];

// Only http(s) destinations can carry a working cross-origin GET exfil.
// data:/blob:/javascript: are navigate-rejected anyway (navigate.js) and
// carry no host to exfiltrate TO — skip them.
const HTTP_SCHEMES = new Set(['http:', 'https:']);

// why: 100 chars in ONE surviving high-entropy run. A scraped-DOM payload
// worth moving is far larger and lands as one contiguous token; ordinary
// off-origin values (a search term, a page/share id, a single content hash,
// an OAuth code_challenge/state, a git SHA, an IPFS CID) each stay well under
// this in any single run. The bar is set high on purpose so ordinary links
// pass untouched — this is a tripwire beneath #241/#242, not the sole gate,
// so it errs hard toward allow.
const MIN_BLOB_LENGTH = 100;

// why: a run must clear this per-character entropy to count. URL-safe encoded
// data is high-entropy (base64url ~5–6 bits, random hex ~3.9); low-variety
// strings — a zero-padded id, an 'aaaa…' padding block, a pure-digit timestamp
// (log2 10 ≈ 3.32), a short natural word — fall below 3.5 and are DROPPED
// before they can count as a payload run. Note the SIDE EFFECT that this
// replaces a hard length floor: entropy over a short run is mechanically low
// (a distinct-char run of length N caps at log2 N, so ~≤11 chars can't clear
// 3.5), so short benign runs self-exclude.
const MIN_RUN_ENTROPY_BITS = 3.5;

// A run that is nothing but hex digits. why it has its own rule: the entropy
// figure quoted above ("random hex ~3.9") is measured on RANDOM BYTES, and the
// payload this module exists to catch is scraped DOM data — TEXT. Printable
// ASCII lives in 0x20–0x7e, so the high nibble of every byte is almost always
// 2–7 and hex-of-text collapses to ~3.2–3.4 bits, UNDER the gate. Measured
// block rates before this rule: 100% for hex of random bytes, 13% for hex of
// realistic scraped records, 0% for hex of English prose — while base64url
// stayed at 100% throughout. So the one encoding the header singled out as
// covered was the cheapest way past it, and the tests missed it because their
// hex fixtures are hand-written random hex rather than hex of anything.
//
// Hex therefore skips the entropy gate and is judged on length alone. That is
// safe because hex is the one encoded form with NO separators, so it cannot be
// confused with a prose slug (looksLikeProse rejects it for the same reason):
// nothing a person writes is a hundred unbroken hex digits. Measured across
// 3,579 URLs harvested from live news, docs, shopping and code-hosting sites,
// this newly blocks ZERO of them. The accepted residual is a ≥100-char hex
// value that is genuinely load-bearing in a path — a SHA-512 digest is 128 —
// which is the same accepted-cost class as the large-multihash IPFS CID named
// in the header.
//
// Measured on the LONGEST HEX SUBSTRING of a run rather than on the whole run
// being hex. why: the hostname slot is scanned DOT-COLLAPSED, so a DNS-label
// exfil fuses the payload with the attacker's own labels — `<hex>attackertest`
// — and a whole-run test would stop matching exactly where the evasion this
// module was built to close actually lives. A substring bar costs nothing on
// ordinary input: reaching 100 consecutive characters drawn only from
// `[0-9a-f]` with no separator does not happen in prose (every common word
// carries a letter outside that alphabet), and short hex-alphabet words like
// `faced` or `decade` are orders of magnitude below the bar.
const NON_HEX_SPLIT = /[^0-9a-fA-F]+/;

// The share of a run's characters that must be `-`/`_` for it to read as WORDS
// rather than payload. Prose slugs measure ~9–16%; base64url spends 2 of its 64
// symbols on them (~3%); hex and base32 have none. Set below the prose floor so
// an unusually long-worded headline still reads as prose. See looksLikeProse.
const MIN_PROSE_SEPARATOR_RATIO = 0.075;

// The run alphabet — base64url + hex. `+`/`/`/`.`/`=`/`&`/space are run
// BOUNDARIES (see "WHY URL-SAFE-ONLY" in the header). A maximal span of these
// chars is one run; anything else splits it.
const RUN_SPLIT = /[^A-Za-z0-9_-]+/;

/**
 * Shannon entropy of a string in bits per character. High for encoded
 * arbitrary data, low for repetitive or narrow-alphabet strings.
 * @param {string} str
 * @returns {number}
 */
const shannonEntropyBits = (str) => {
  if (!str) return 0;
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const ch of str) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / str.length;
    bits -= p * Math.log2(p);
  }
  return bits;
};

/**
 * Percent-decode, never throwing. why: a malformed `%` sequence must degrade
 * to the raw string, never crash the inspector.
 * @param {string} str
 * @returns {string}
 */
const safeDecode = (str) => {
  try { return decodeURIComponent(str); } catch { return str; }
};

/**
 * The three LOW-FALSE-POSITIVE payload-bearing slots of a URL, decoded into the
 * canonical form the run scanner reads. why each (and why NOT query/fragment —
 * see the header's "WHY ONLY THESE THREE SLOTS"):
 *  - userinfo (username/password): `https://<blob>@host/` ships the blob as an
 *    Authorization: Basic header to the attacker host. No legit blob lives here.
 *  - hostname with DOTS REMOVED: re-fuses a payload chunked across DNS labels
 *    so `<h1>.<h2>.<h3>.attacker.com` is one run, not per-label sub-100 runs.
 *    A normal hostname collapses to a short/low-entropy string.
 *  - path (plain percent-decode; `+` is literal in a path). `/` splits it into
 *    segments, so only a lone ≥100-char high-entropy segment trips it — readable
 *    or opaque; readability does not exempt a run, its length does.
 * @param {URL} url
 * @returns {string[]}
 */
const payloadSlots = (url) => [
  safeDecode(url.username),
  safeDecode(url.password),
  url.hostname.replace(/\./g, ''),
  safeDecode(url.pathname),
];

/**
 * A run that clears the entropy gate but is an ARTICLE SLUG, not a payload.
 *
 * WHY THIS EXISTS. `-` and `_` are inside the run alphabet (base64url needs
 * them), so a hyphen-joined headline is ONE run — and a long enough one clears
 * every other test. Measured against the shipped module, these all blocked:
 *
 *   /world/2026/jul/12/scientists-say-the-newly-discovered-species-of-deep-sea-…
 *   /2026/07/12/openai-and-anthropic-announce-a-joint-safety-framework-for-…
 *
 * A user asking peerd to read a news article got "likely DOM-data
 * exfiltration". That is the failure that gets a security feature turned off:
 * it fires on the most ordinary thing a browser agent does.
 *
 * THE DISCRIMINATOR, and why it is not entropy. Prose and encoded data overlap
 * on entropy once a slug carries ids or dates (a real LinkedIn slug measures
 * 4.63 bits; random base32 bottoms out at 4.61), so no threshold separates
 * them. What does separate them is SHAPE: prose is words joined by separators,
 * so `-`/`_` make up ~9–16% of its characters, while base64url spends only
 * 2 of its 64 symbols on them (~3%) and hex and base32 have none at all.
 *
 * So a run is prose when it is BOTH word-shaped (separator-dense) and not
 * extreme-entropy. Both halves are needed: separator density alone
 * false-negatives on a slug of unusually long words, and entropy alone
 * false-positives on a slug full of numeric ids.
 *
 * Measured on the corpus in the tests: 0 false positives across realistic
 * slugs (news, docs, product titles, social permalinks), 0.02% of random
 * base64url missed, 0% of base32 and hex missed.
 *
 * @param {string} run
 * @returns {boolean}
 */
const looksLikeProse = (run) => {
  // Hex is the one encoded form with NO separators and LOW entropy, so it would
  // otherwise slip through the density test below. Nothing written by a person
  // is a hundred unbroken hex digits. (Same reasoning lets a long hex substring
  // skip the entropy gate in largestExfilRun — see NON_HEX_SPLIT.)
  if (/^[0-9a-f]+$/i.test(run)) return false;
  const separators = (run.match(/[-_]/g) ?? []).length;
  return (separators / run.length) >= MIN_PROSE_SEPARATOR_RATIO;
};

/**
 * Length of the longest unbroken `[0-9a-f]` span inside a run.
 *
 * A SPAN, not the whole run, because the hostname slot is dot-collapsed: a
 * DNS-label exfil arrives as `<payload-hex>` fused to the attacker's own labels
 * (`…attackertest`), which is not pure hex. See NON_HEX_SPLIT for why a
 * substring bar is safe on ordinary input.
 *
 * @param {string} run
 * @returns {number}
 */
const longestHexSpan = (run) => {
  let longest = 0;
  for (const span of run.split(NON_HEX_SPLIT)) {
    if (span.length > longest) longest = span.length;
  }
  return longest;
};

/**
 * Length of the LONGEST run (across the slots) whose local entropy clears
 * MIN_RUN_ENTROPY_BITS. MAX not SUM — a URL carrying several independent
 * high-entropy values (an OAuth PKCE authorize URL) is not blocked for their
 * combined length; only a single dumped blob trips it. See "WHY DOMINANT-RUN".
 * @param {string[]} slots
 * @returns {number}
 */
const largestExfilRun = (slots) => {
  let longest = 0;
  for (const slot of slots) {
    for (const run of slot.split(RUN_SPLIT)) {
      // why `run.length <= longest` first: a run that cannot raise the max is
      // irrelevant, so skip the entropy math for it (never changes the verdict).
      if (!run || run.length <= longest) continue;
      // HEX FIRST, on length alone. Hex of ordinary TEXT sits UNDER the entropy
      // gate while being a perfectly working exfil, so the gate below would drop
      // exactly the payload this module exists to catch. See NON_HEX_SPLIT.
      const hexLength = longestHexSpan(run);
      if (hexLength >= MIN_BLOB_LENGTH) { longest = Math.max(longest, hexLength); continue; }
      if (shannonEntropyBits(run) < MIN_RUN_ENTROPY_BITS) continue;
      if (looksLikeProse(run)) continue;
      longest = run.length;
    }
  }
  return longest;
};

/**
 * Parse an origin, returning null if unparseable. why: a missing/garbled
 * currentOrigin must not throw — it degrades to "treat as off-origin and
 * inspect", never a crash.
 * @param {string} value
 * @returns {string | null}
 */
const safeOrigin = (value) => {
  try { return new URL(value).origin; } catch { return null; }
};

/**
 * Collect the URL-bearing arg values from a tab-tool call.
 * @param {Record<string, unknown> | null | undefined} args
 * @returns {string[]}
 */
const collectCandidateUrls = (args) => {
  if (!args || typeof args !== 'object') return [];
  /** @type {string[]} */
  const out = [];
  for (const field of URL_ARG_FIELDS) {
    const value = /** @type {Record<string, unknown>} */ (args)[field];
    if (typeof value === 'string' && value.trim()) out.push(value.trim());
  }
  return out;
};

/**
 * Inspect a tab-tool call for the DOM-data→URL exfiltration shape.
 *
 * Returns `{ action: 'block', reason }` when the call would navigate/type an
 * OFF-origin http(s) URL whose userinfo, hostname, or path carries a single
 * URL-safe-encoded high-entropy run of ≥ MIN_BLOB_LENGTH characters — a
 * contiguous dumped blob. Everything else is `{ action: 'allow' }`, including
 * same-origin targets, plain off-origin links (incl. deep readable paths), a
 * blob in the QUERY or FRAGMENT (the largest documented residual — those slots
 * are not scanned; see the header), non-URL typed text, empty/short args, a
 * lone sub-threshold token, fragmented / low-entropy payloads, and any call
 * made before a page has loaded.
 *
 * NEVER THROWS — a pure inspector on a hot path. Any non-object `call`
 * (including `null`) degrades to allow, matching every other odd-input path.
 *
 * The `reason` is CONTENT-FREE by construction — it never interpolates the
 * URL, the blob, or any other attacker-controlled bytes. why: reasons are
 * audited and read back UN-fenced; echoing attacker bytes into an audit log
 * that a human or the agent later re-reads would reopen the injection channel
 * this gate exists to close. It also does NOT claim to catch the residuals —
 * see KNOWN RESIDUALS in the header.
 *
 * @param {TabToolCall | null} [call]
 * @returns {EgressVerdict}
 */
export const inspectTabToolCall = (call) => {
  // why: the default param only covers `undefined`; a caller that represents
  // an absent record as `null` must not crash the destructure. Any non-object
  // is "nothing to inspect" → allow.
  const safeCall = (call && typeof call === 'object') ? call : {};
  const { args, currentOrigin } = safeCall;
  const candidates = collectCandidateUrls(args);
  if (!candidates.length) return { action: 'allow' };

  // NO CURRENT ORIGIN MEANS "we don't know where this actor has been", NOT
  // "it has been nowhere".
  //
  // An earlier version returned allow here, on the stated reasoning that "exfil
  // presupposes a page already read, which always leaves a currentOrigin
  // behind". That is false in this codebase, and adversarial review demonstrated
  // it: the chat's web actor is minted with ZERO tabs and reads pages with
  // `fetch_url`, which needs no tab — so `ctx.activeTab` is undefined, the hook
  // passes null, and every exfil-shaped navigate was waved through in exactly
  // the state where the actor HAD just scraped a page. It also made the
  // fetch_url widening in the hook inert for the case it was written for.
  //
  // Falling through instead costs nothing: with no origin to compare against,
  // `here` is null and every target reads as off-origin, which is the same
  // treatment an unparseable origin already got two lines below. A block still
  // requires a clear payload shape, so an ordinary first navigation is
  // unaffected.
  const here = currentOrigin ? safeOrigin(currentOrigin) : null;

  for (const raw of candidates) {
    let url;
    try { url = new URL(raw); }
    catch { continue; } // unparseable / relative → not a working exfil vector
    if (!HTTP_SCHEMES.has(url.protocol)) continue;
    // Same-origin is trivially allowed: sending data back to the site the
    // agent is already on is not cross-origin exfiltration. (If currentOrigin
    // was unparseable, `here` is null and we treat every target as off-origin
    // — inspect it; we still only block on a clear payload.)
    if (here && url.origin === here) continue;
    if (largestExfilRun(payloadSlots(url)) >= MIN_BLOB_LENGTH) {
      return {
        action: 'block',
        // why: content-free — see the doc comment above. Names the SHAPE,
        // never the bytes, and claims only "likely", not a guarantee.
        reason: 'egress-heuristics: off-origin tab navigation carrying a high-entropy '
          + 'encoded payload in the URL userinfo/host/path — the likely '
          + 'DOM-data exfiltration shape',
      };
    }
  }
  return { action: 'allow' };
};
