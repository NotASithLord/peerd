// games/puzzle-race.js — the PUZZLE-RACE game's rules module.
//
// This file is dwapp CONTENT, not core code: it ships inside the puzzle-race
// game dwapp as `rules.js`, is content-addressed with the bundle (the hash IS
// the rules commitment both players compare before a match), and executes ONLY
// in the sealed notebook worker — on the sharer's machine and on every
// installer's (peer-authored code never touches the page; spec §7 in
// docs/specs/PEERD-GAME-ARENA.md).
//
// Contract (the game-dwapp boilerplate, spec §4): a plain script — no imports,
// no exports, no host access — whose last binding is `const rules`:
//   rules.meta                     — id / name / version / description
//   rules.derive(seedHex)          — deterministic: joint seed → the puzzle
//   rules.check(seedHex, answer)   — pure verdict { correct, score }
//   rules.solve(challenge)         — a REFERENCE solver (content too: any
//                                    competitor may ignore it and bring a
//                                    better one; the demo's auto-player uses it)
// derive/check must be deterministic and side-effect-free — the match reducer
// treats them as math, and the log verifier re-runs them to audit a result.
// solve MAY randomize (a random search start is what makes two honest players
// finish at different times).
//
// Puzzles are CONTENT INSIDE this one dwapp — new puzzle kinds are an edit to
// this file (a new content hash = a new game version), never a new dwapp.

const rules = (() => {
  // Deterministic PRNG (mulberry32) seeded from the joint hex seed — both
  // players must derive the byte-identical puzzle from the same seed.
  const seedInt = (seedHex, i) => (parseInt(String(seedHex).slice(i * 8, i * 8 + 8) || '0', 16) >>> 0);
  const mulberry32 = (a) => () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // FNV-1a 32-bit — the race's work function. Chosen over WebCrypto because it
  // is synchronous, dependency-free, and identical everywhere JS runs; it only
  // needs to be an agreed, uniform-ish function, not cryptographically strong.
  const fnv1a = (str) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  };

  // pow-weighted: the search race has real variance (geometric), so it produces
  // visible winners; the chain is a pure-compute check both can nail instantly.
  const KINDS = ['pow', 'pow', 'chain'];
  const MOD = 1000000007;

  const derive = (seedHex) => {
    const rand = mulberry32(seedInt(seedHex, 0) ^ seedInt(seedHex, 4));
    const kind = KINDS[Math.floor(rand() * KINDS.length)];
    const tag = String(seedHex).slice(0, 16);
    if (kind === 'pow') {
      // expected tries = difficulty; the 32× cap in solve bounds the tail.
      const difficulty = 1 << (19 + Math.floor(rand() * 3)); // 2^19..2^21
      const range = difficulty * 64;
      return {
        kind, tag, difficulty, range,
        prompt: `Search race: find ANY integer n with 0 <= n < ${range} such that `
          + `fnv1a32("${tag}:" + n) % ${difficulty} === 0. Answer with the decimal n.`,
      };
    }
    const length = 16 + Math.floor(rand() * 17);
    const ops = [];
    for (let i = 0; i < length; i++) {
      const t = Math.floor(rand() * 3);
      const v = 1 + Math.floor(rand() * 999983);
      ops.push([t === 0 ? 'add' : t === 1 ? 'mul' : 'xor', v]);
    }
    const start = 1 + Math.floor(rand() * 999999);
    return {
      kind: 'chain', tag, start, mod: MOD, ops,
      prompt: `Compute race: start with x = ${start}; apply in order `
        + `${ops.map(([op, v]) => `${op} ${v}`).join(', ')} — where add is (x+v) mod ${MOD}, `
        + `mul is (x*v) mod ${MOD}, xor is (x^v) (then mod ${MOD}). Answer with the final x.`,
    };
  };

  // why BigInt for mul only: every value stays < 2^30 (mod 1e9+7), so add and
  // xor are exact in doubles, but a product can pass 2^53.
  const chainResult = (ch) => {
    let x = ch.start;
    for (const [op, v] of ch.ops) {
      if (op === 'add') x = (x + v) % ch.mod;
      else if (op === 'mul') x = Number((BigInt(x) * BigInt(v)) % BigInt(ch.mod));
      else x = ((x ^ v) >>> 0) % ch.mod;
    }
    return x;
  };

  const powOk = (ch, n) => Number.isInteger(n) && n >= 0 && n < ch.range
    && fnv1a(`${ch.tag}:${n}`) % ch.difficulty === 0;

  const check = (seedHex, answer) => {
    const ch = derive(seedHex);
    const n = Number(String(answer).trim());
    const correct = ch.kind === 'pow' ? powOk(ch, n) : (Number.isInteger(n) && n === chainResult(ch));
    return { correct, score: correct ? 1 : 0 };
  };

  const solve = (ch) => {
    if (ch.kind === 'chain') return String(chainResult(ch));
    // Random-start linear probe: honest players search DIFFERENT parts of the
    // space, so finish times (and answers) genuinely differ — that's the race.
    const start = Math.floor(Math.random() * ch.range);
    const cap = ch.difficulty * 32; // bound the unlucky tail; unsolved = timeout
    for (let i = 0; i < cap; i++) {
      const n = (start + i) % ch.range;
      if (fnv1a(`${ch.tag}:${n}`) % ch.difficulty === 0) return String(n);
    }
    return null;
  };

  return {
    meta: {
      id: 'puzzle-race',
      name: 'Puzzle Race',
      version: 1,
      description: 'Two agents, one seed-derived puzzle, first correct commit wins. Trustless: commit-reveal answers, pure re-checkable verdicts.',
    },
    derive, check, solve,
  };
})();

// The last binding IS the module surface: the arena wraps this file in a
// sealed-worker run that ends `return rules.<op>(...)`.
