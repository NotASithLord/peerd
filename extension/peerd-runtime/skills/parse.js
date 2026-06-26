// @ts-check
// SKILL.md parser — pure. Frontmatter + body, no IO.
//
// The Agent Skills open standard (Anthropic Skills / Linux Foundation
// "Agent Skills") ships a skill as a Markdown file named SKILL.md with a
// YAML frontmatter block delimited by `---` fences, followed by the
// instruction body:
//
//   ---
//   name: pdf-filler
//   description: Fill PDF forms from a data map. Use when the user...
//   ---
//   # PDF Filler
//   <full instructions...>
//
// PROGRESSIVE DISCLOSURE is the whole point: the `description` (and the
// rest of the frontmatter) is CHEAP and loads at startup into the system
// prompt; the `body` is EXPENSIVE and loads only when the skill is
// invoked. So the parser splits the two and the registry stores them in
// separate tiers (see registry.js + store.js).
//
// why a hand-rolled YAML reader instead of vendoring a parser: skill
// frontmatter is a flat key→scalar/list map in every real-world skill
// (Claude Code, Codex CLI, Gemini CLI all emit the same shape). A full
// YAML engine is a large untrusted-input attack surface for ~6 fields.
// We parse exactly the subset the standard uses and reject the rest, so
// a malicious manifest can't smuggle a YAML anchor bomb or a tag that
// triggers code construction. UNTRUSTED-CONTENT discipline: this runs on
// bytes fetched from a git URL / hosted manifest — keep it total and
// allocation-bounded.

export class SkillParseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SkillParseError';
  }
}

// Fields the standard defines. Unknown keys are preserved under `extra`
// (forward-compat: Claude Code adds `allowed-tools`, `license`, etc.) but
// never interpreted as behaviour by peerd — a skill cannot, e.g., set a
// key that silently widens egress.
// Keys peerd interprets into first-class meta fields. Everything else
// (metadata, author, category, Claude Code's future additions, …) is
// preserved verbatim under `extra` and NEVER interpreted as behaviour —
// a skill cannot, e.g., set a key that silently widens egress.
const KNOWN_KEYS = new Set([
  'name',
  'description',
  'version',
  'license',
  // Claude Code / Codex compatibility keys. Parsed and surfaced, but
  // peerd does NOT auto-grant any of them — they're advisory only.
  'allowed-tools',
  'allowed_tools',
]);

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

// Bound the body so one giant SKILL.md can't blow the context window or
// memory when injected. 64 KiB is ~16k tokens — generous for a skill,
// far below anything pathological.
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Parse a SKILL.md document into { frontmatter, body }.
 *
 * @param {string} text  raw SKILL.md contents
 * @returns {{ name: string, description: string, version: string|null,
 *   license: string|null, allowedTools: string[], extra: Record<string,unknown>,
 *   body: string }}
 * @throws {SkillParseError} on missing fence, missing name/description,
 *   or an oversized body.
 */
export const parseSkillMd = (text) => {
  if (typeof text !== 'string') {
    throw new SkillParseError('SKILL.md must be a string');
  }
  // Strip a UTF-8 BOM — git-served raw files often carry one.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const m = FRONTMATTER_RE.exec(src);
  if (!m) {
    throw new SkillParseError('SKILL.md is missing a YAML frontmatter block (--- … ---)');
  }
  const fm = parseFrontmatter(m[1]);
  const body = src.slice(m[0].length).trim();

  if (typeof fm.name !== 'string' || !fm.name.trim()) {
    throw new SkillParseError('SKILL.md frontmatter must include a non-empty `name`');
  }
  if (typeof fm.description !== 'string' || !fm.description.trim()) {
    throw new SkillParseError('SKILL.md frontmatter must include a non-empty `description`');
  }
  // why: byte length, not string length — multibyte content must not
  // sneak past the cap. TextEncoder is available in SW + Bun.
  const bodyBytes = new TextEncoder().encode(body).length;
  if (bodyBytes > MAX_BODY_BYTES) {
    throw new SkillParseError(
      `SKILL.md body is ${bodyBytes} bytes; the limit is ${MAX_BODY_BYTES}`,
    );
  }

  const allowed = fm['allowed-tools'] ?? fm.allowed_tools ?? [];
  /** @type {Record<string, unknown>} */
  const extra = {};
  for (const [k, v] of Object.entries(fm)) {
    if (!KNOWN_KEYS.has(k)) extra[k] = v;
  }

  return {
    name: normalizeName(fm.name),
    description: fm.description.trim(),
    version: typeof fm.version === 'string' ? fm.version.trim() : null,
    license: typeof fm.license === 'string' ? fm.license.trim() : null,
    allowedTools: Array.isArray(allowed) ? allowed.map(String) : [String(allowed)],
    extra,
    body,
  };
};

/**
 * Skill names are the invocation handle. Lowercase, hyphenated, no spaces
 * — same constraint the standard puts on the containing directory name.
 * We normalize rather than reject so a skill authored as "PDF Filler"
 * still installs as `pdf-filler`.
 *
 * @param {string} raw
 * @returns {string}
 */
export const normalizeName = (raw) =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

// --- minimal YAML frontmatter reader ------------------------------------
//
// Supports exactly: `key: scalar`, block lists (`key:` then `- item`
// lines), inline flow lists (`key: [a, b]`), and quoted scalars. Nested
// maps collapse to a single level under `metadata` if present. Anything
// it doesn't understand is kept as a raw string — never executed.

/**
 * @param {string} block  text between the --- fences
 * @returns {Record<string, unknown>}
 */
const parseFrontmatter = (block) => {
  /** @type {Record<string, unknown>} */
  const out = {};
  const lines = block.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Skip blanks and comments.
    if (!line.trim() || /^\s*#/.test(line)) { i += 1; continue; }
    // Only top-level (unindented) keys start a field. Indented lines are
    // consumed by the block-list / block-scalar branch below.
    if (/^\s/.test(line)) { i += 1; continue; }

    const colon = line.indexOf(':');
    if (colon === -1) {
      throw new SkillParseError(`malformed frontmatter line: ${truncate(line)}`);
    }
    const key = line.slice(0, colon).trim();
    let rest = line.slice(colon + 1).trim();
    rest = stripComment(rest);

    if (rest === '' ) {
      // Block list or nested map follows on indented lines.
      /** @type {string[]} */
      const items = [];
      /** @type {Record<string, string>} */
      const nested = {};
      let j = i + 1;
      while (j < lines.length && (/^\s+/.test(lines[j]) || !lines[j].trim())) {
        const il = lines[j];
        if (!il.trim()) { j += 1; continue; }
        const t = il.trim();
        if (t.startsWith('- ')) {
          items.push(unquote(stripComment(t.slice(2).trim())));
        } else {
          const c = t.indexOf(':');
          if (c !== -1) nested[t.slice(0, c).trim()] = unquote(stripComment(t.slice(c + 1).trim()));
        }
        j += 1;
      }
      out[key] = items.length ? items : nested;
      i = j;
      continue;
    }

    out[key] = parseScalarOrFlowList(rest);
    i += 1;
  }
  return out;
};

/**
 * @param {string} rest
 * @returns {string | string[]}
 */
const parseScalarOrFlowList = (rest) => {
  if (rest.startsWith('[') && rest.endsWith(']')) {
    const inner = rest.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => unquote(s.trim()));
  }
  return unquote(rest);
};

/** @param {string} s */
const unquote = (s) => {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1);
  }
  return s;
};

// Strip a trailing `# comment` only when it is not inside quotes. Cheap,
// total scanner — no regex backtracking on untrusted input.
/** @param {string} s */
const stripComment = (s) => {
  let inS = false; let inD = false;
  for (let k = 0; k < s.length; k += 1) {
    const ch = s[k];
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (ch === '#' && !inS && !inD && (k === 0 || s[k - 1] === ' ' || s[k - 1] === '\t')) {
      return s.slice(0, k).trim();
    }
  }
  return s;
};

/** @param {string} s */
const truncate = (s) => (s.length > 60 ? `${s.slice(0, 60)}…` : s);
