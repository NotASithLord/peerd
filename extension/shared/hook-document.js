// @ts-check

/** @typedef {import('../peerd-runtime/tools/hooks/compile.js').UserHookRecord} UserHookRecord */

const parseFrontmatter = (/** @type {string} */ text) => {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return { meta: {}, body: text };
  /** @type {Record<string, any>} */
  const meta = {};
  /** @type {Record<string, any> | null} */
  let rule = null;
  for (const raw of match[1].split('\n')) {
    if (!raw.trim()) continue;
    const indented = /^\s+/.test(raw);
    const keyValue = /^\s*([\w-]+):\s*(.*)$/.exec(raw);
    if (!keyValue) continue;
    const [, key, rawValue] = keyValue;
    if (key === 'rule' && rawValue.trim() === '') {
      rule = {};
      meta.rule = rule;
      continue;
    }
    const value = coerce(rawValue.trim());
    if (indented && rule) rule[key] = value;
    else meta[key] = value;
  }
  return { meta, body: match[2] };
};

const coerce = (/** @type {string} */ value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && !Number.isNaN(Number(value))) return Number(value);
  return value.replace(/^["']|["']$/g, '');
};

/** @param {string} text @returns {UserHookRecord} */
export const parseHookDocument = (text) => {
  const { meta, body: markdownBody } = parseFrontmatter(text);
  if (typeof meta.id !== 'string') {
    throw new TypeError('parseHookMarkdown: frontmatter must set at least `id` and `event`');
  }
  const codeMatch = /```(?:js|javascript)\n([\s\S]*?)```/.exec(markdownBody);
  if (!meta.rule || codeMatch) {
    throw new TypeError('parseHookMarkdown: executable JS hooks are not supported; add a declarative `rule` block');
  }
  /** @type {UserHookRecord} */
  const record = {
    id: meta.id,
    event: meta.event,
    enabled: meta.enabled !== false,
    order: typeof meta.order === 'number' ? meta.order : undefined,
    match: typeof meta.match === 'string' ? meta.match : undefined,
    doc: markdownBody.replace(/```[\s\S]*?```/g, '').trim(),
    kind: 'declarative',
  };
  record.rule = meta.rule;
  return record;
};
