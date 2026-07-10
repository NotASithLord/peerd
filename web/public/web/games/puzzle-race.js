// games/puzzle-race.js — the PUZZLE-RACE game's rules module (v2: the mining race).
//
// This file is dwapp CONTENT, not core code: it ships inside the puzzle-race
// game dwapp as `rules.js`, is content-addressed with the bundle (the hash IS
// the rules commitment both players compare before a match), and executes ONLY
// in the sealed notebook worker — on the sharer's machine and on every
// installer's (peer-authored code never touches the page; spec §7 in
// docs/specs/PEERD-GAME-ARENA.md).
//
// v2 — why "best answer by the deadline" replaced "first correct commit":
// first-to-commit needed each side's CLAIM about arrival order (honesty-
// bounded: a liar could downgrade a loss to a draw). Here the objective is
// IN the answer: find n minimizing fnv1a32(tag:n); the score is recomputed
// from the answer by any verifier, so there is nothing to lie about. Speed
// still wins — more search in the window finds a lower hash — and exact
// score ties are ~2^-32. Commit early and you searched less: self-punishing.
//
// Contract (the game-dwapp boilerplate, spec §4): a plain script — no imports,
// no exports, no host access — whose last binding is `const rules`:
//   rules.meta                     — id / name / version / description
//   rules.derive(seedHex)          — deterministic: joint seed → the puzzle
//   rules.check(seedHex, answer)   — pure verdict { correct, score } (higher
//                                    score wins; score is derived from the
//                                    answer alone — objective, verifiable)
//   rules.solve(challenge, budgetMs, resumeFrom) — a REFERENCE solver burst:
//     search for up to budgetMs, return the best found as
//     { answer, score, hash, tries }. The host loops bursts until its commit
//     deadline, keeping the best (and showing it live). resumeFrom (optional)
//     is a prior best answer string to improve on. Any competitor may bring a
//     stronger solver; the rules only judge the answer.
// derive/check must be deterministic and side-effect-free; solve may randomize.

const rules = (() => {
  // FNV-1a 32-bit — the race's work function. Chosen over WebCrypto because it
  // is synchronous, dependency-free, and identical everywhere JS runs; it only
  // needs to be an agreed, uniform-ish function, not cryptographically strong.
  const fnv1a = (str) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  };

  const RANGE = 2 ** 40;              // far beyond exhaustible in a demo window
  const MAX_SCORE = 2 ** 32;          // score = MAX_SCORE - hash → higher is better

  const derive = (seedHex) => {
    const tag = String(seedHex).slice(0, 16);
    return {
      kind: 'mine', tag, range: RANGE,
      prompt: `Mining race: find any integer n with 0 <= n < 2^40 MINIMIZING `
        + `fnv1a32("${tag}:" + n). Lowest hash at the deadline wins — search as `
        + `hard as you can. Answer with the decimal n.`,
    };
  };

  const hashOf = (ch, n) => fnv1a(`${ch.tag}:${n}`);

  const check = (seedHex, answer) => {
    const ch = derive(seedHex);
    // strict canonical decimal — Number('') is 0 and '1e3' is 1000, and a
    // non-canonical encoding must not alias a different hash input.
    const s = String(answer).trim();
    const n = /^\d+$/.test(s) ? Number(s) : NaN;
    const correct = Number.isInteger(n) && n >= 0 && n < ch.range;
    // The objective IS the score: recomputed from the answer, nothing claimed.
    return { correct, score: correct ? MAX_SCORE - hashOf(ch, n) : 0 };
  };

  const solve = (ch, budgetMs, resumeFrom) => {
    const deadline = Date.now() + Math.max(50, Number(budgetMs) || 1000);
    let best = null;
    if (resumeFrom != null) {
      const p = Number(String(resumeFrom));
      if (Number.isInteger(p) && p >= 0 && p < ch.range) best = { n: p, h: hashOf(ch, p) };
    }
    let tries = 0;
    // Random restarts + linear probes: honest players search DIFFERENT parts
    // of the space, so runs (and machines) genuinely diverge — that's the race.
    while (Date.now() < deadline) {
      let n = Math.floor(Math.random() * ch.range);
      for (let i = 0; i < 4096 && n < ch.range; i++, n++) {
        const h = hashOf(ch, n);
        tries++;
        if (!best || h < best.h) best = { n, h };
      }
    }
    return best
      ? { answer: String(best.n), score: MAX_SCORE - best.h, hash: best.h, tries }
      : null;
  };

  return {
    meta: {
      id: 'puzzle-race',
      name: 'Puzzle Race',
      version: 2,
      description: 'Two agents, one seed, a fixed window: whoever mines the lowest hash wins. Trustless — commit-reveal answers, and the score is verifiable from the answer itself.',
    },
    derive, check, solve,
  };
})();

// The last binding IS the module surface: the arena wraps this file in a
// sealed-worker run that ends `return rules.<op>(...)`.
