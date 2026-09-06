// @ts-check

export class SkillParseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SkillParseError';
  }
}

const KNOWN_KEYS = new Set([
  'name', 'description', 'version', 'license', 'allowed-tools', 'allowed_tools',
]);
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;
const MAX_BODY_BYTES = 64 * 1024;

/** @param {string} raw */
export const normalizeName = (raw) => raw
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 64);

const unquote = (/** @type {string} */ value) => value.length >= 2
  && ((value[0] === '"' && value.at(-1) === '"')
    || (value[0] === "'" && value.at(-1) === "'"))
  ? value.slice(1, -1) : value;

const stripComment = (/** @type {string} */ value) => {
  let single = false;
  let double = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'" && !double) single = !single;
    else if (character === '"' && !single) double = !double;
    else if (character === '#' && !single && !double
        && (index === 0 || value[index - 1] === ' ' || value[index - 1] === '\t')) {
      return value.slice(0, index).trim();
    }
  }
  return value;
};

const scalar = (/** @type {string} */ value) => {
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    return inner ? inner.split(',').map((item) => unquote(item.trim())) : [];
  }
  return unquote(value);
};

const parseFrontmatter = (/** @type {string} */ block) => {
  /** @type {Record<string, unknown>} */
  const output = {};
  const lines = block.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) { index += 1; continue; }
    if (/^\s/.test(line)) { index += 1; continue; }
    const colon = line.indexOf(':');
    if (colon === -1) {
      const display = line.length > 60 ? `${line.slice(0, 60)}…` : line;
      throw new SkillParseError(`malformed frontmatter line: ${display}`);
    }
    const key = line.slice(0, colon).trim();
    const rest = stripComment(line.slice(colon + 1).trim());
    if (rest !== '') {
      output[key] = scalar(rest);
      index += 1;
      continue;
    }
    /** @type {string[]} */
    const items = [];
    /** @type {Record<string, string>} */
    const nested = {};
    let next = index + 1;
    while (next < lines.length && (/^\s+/.test(lines[next]) || !lines[next].trim())) {
      const nestedLine = lines[next].trim();
      if (nestedLine.startsWith('- ')) {
        items.push(unquote(stripComment(nestedLine.slice(2).trim())));
      } else if (nestedLine) {
        const nestedColon = nestedLine.indexOf(':');
        if (nestedColon !== -1) {
          nested[nestedLine.slice(0, nestedColon).trim()] = unquote(
            stripComment(nestedLine.slice(nestedColon + 1).trim()),
          );
        }
      }
      next += 1;
    }
    output[key] = items.length ? items : nested;
    index = next;
  }
  return output;
};

/** @param {string} text */
export const parseSkillDocument = (text) => {
  if (typeof text !== 'string') throw new SkillParseError('SKILL.md must be a string');
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const match = FRONTMATTER_RE.exec(source);
  if (!match) {
    throw new SkillParseError('SKILL.md is missing a YAML frontmatter block (--- … ---)');
  }
  const frontmatter = parseFrontmatter(match[1]);
  const body = source.slice(match[0].length).trim();
  if (typeof frontmatter.name !== 'string' || !frontmatter.name.trim()) {
    throw new SkillParseError('SKILL.md frontmatter must include a non-empty `name`');
  }
  if (typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) {
    throw new SkillParseError('SKILL.md frontmatter must include a non-empty `description`');
  }
  const bodyBytes = new TextEncoder().encode(body).length;
  if (bodyBytes > MAX_BODY_BYTES) {
    throw new SkillParseError(`SKILL.md body is ${bodyBytes} bytes; the limit is ${MAX_BODY_BYTES}`);
  }
  const allowed = frontmatter['allowed-tools'] ?? frontmatter.allowed_tools ?? [];
  /** @type {Record<string, unknown>} */
  const extra = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!KNOWN_KEYS.has(key)) extra[key] = value;
  }
  return {
    name: normalizeName(frontmatter.name),
    description: frontmatter.description.trim(),
    version: typeof frontmatter.version === 'string' ? frontmatter.version.trim() : null,
    license: typeof frontmatter.license === 'string' ? frontmatter.license.trim() : null,
    allowedTools: Array.isArray(allowed) ? allowed.map(String) : [String(allowed)],
    extra,
    body,
  };
};

/** @param {unknown} value */
export const validSkillProjection = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const skill = /** @type {Record<string,any>} */ (value);
  return typeof skill.name === 'string'
    && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(skill.name)
    && typeof skill.description === 'string' && skill.description.length > 0
    && skill.description.length <= 4096
    && (skill.version === null || (typeof skill.version === 'string' && skill.version.length <= 256))
    && (skill.license === null || (typeof skill.license === 'string' && skill.license.length <= 1024))
    && Array.isArray(skill.allowedTools) && skill.allowedTools.length <= 256
    && skill.allowedTools.every((tool) => typeof tool === 'string' && tool.length <= 256)
    && typeof skill.body === 'string'
    && new TextEncoder().encode(skill.body).length <= MAX_BODY_BYTES;
};
