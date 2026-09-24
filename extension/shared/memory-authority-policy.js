// @ts-check
export const MAX_DOC_CHARS = 24_000;
export const MEMORY_SUGGESTIONS_KEY = 'memory_suggestions.v1';
export const MEMORY_SUGGESTION_MAX_CHARS = 240;

/** @param {unknown} value */
export const normalizeWorkspace = (value) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    return url.host ? `${url.protocol}//${url.host.toLowerCase()}` : trimmed;
  } catch { return trimmed; }
};

/** @param {unknown} value */
export const normalizeSubpath = (value) => typeof value === 'string'
  ? value.trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/') : '';

/** @param {unknown} body */
export const normalizeBody = (body) => {
  if (typeof body !== 'string') throw new TypeError('memory body must be a string');
  const normalized = body.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  if (normalized.length > MAX_DOC_CHARS) {
    throw new RangeError(`memory body too large: ${normalized.length} > ${MAX_DOC_CHARS} chars`);
  }
  return normalized.trim() === '' ? '' : normalized;
};

/** @param {any} scope */
export const normalizeMemoryScope = (scope) => {
  const kind = scope?.kind;
  if (kind === 'user') {
    return { id: 'user', kind: 'user', workspace: '', subpath: '' };
  }
  if (kind !== 'project' && kind !== 'subtree') throw new TypeError('memory-scope-invalid');
  const workspace = normalizeWorkspace(scope.workspace);
  if (!workspace) throw new TypeError('memory-scope-workspace-required');
  if (kind === 'project') {
    return { id: `project:${workspace}`, kind: 'project', workspace, subpath: '' };
  }
  const subpath = normalizeSubpath(scope.subpath);
  if (!subpath) throw new TypeError('memory-scope-subpath-required');
  return {
    id: `subtree:${workspace}:${subpath}`, kind: 'subtree', workspace, subpath,
  };
};

/** @param {any} scope */
export const scopeId = (scope) => normalizeMemoryScope(scope).id;

/** @param {unknown} value */
export const validMemorySuggestion = (value) => {
  const item = /** @type {any} */ (value);
  return !!(item && typeof item === 'object' && typeof item.id === 'string'
    && item.id && typeof item.text === 'string' && item.text.trim());
};

/** @param {string} priorBody @param {unknown} note */
export const appendMemorySuggestion = (priorBody, note) => {
  const clean = typeof note === 'string'
    ? note.replace(/\s+/g, ' ').replace(/^[-•*]\s*/, '').trim()
      .slice(0, MEMORY_SUGGESTION_MAX_CHARS) : '';
  if (!clean) return typeof priorBody === 'string' ? priorBody : '';
  const bullet = `- ${clean}`;
  const prior = typeof priorBody === 'string' ? priorBody.trim() : '';
  if (!prior) return `# User memory\n\n## Notes\n${bullet}\n`;
  const lines = prior.split('\n');
  const heading = lines.findIndex((line) => /^##\s+Notes\s*$/.test(line));
  if (heading < 0) return `${prior}\n\n## Notes\n${bullet}\n`;
  let insertAt = lines.findIndex((line, index) => index > heading && /^#{1,6}\s/.test(line));
  if (insertAt < 0) insertAt = lines.length;
  while (insertAt > heading + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1;
  if (!lines.slice(heading + 1, insertAt).includes(bullet)) lines.splice(insertAt, 0, bullet);
  return `${lines.join('\n')}\n`;
};
