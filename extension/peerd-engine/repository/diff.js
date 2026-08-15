// @ts-check

const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_FILE_TEXT_CHARS = 200_000;
const MAX_PATCH_CHARS = 40_000;
const MAX_RETURNED_TEXT_CHARS = 2_000_000;

/** @param {Uint8Array} bytes */
const textOf = (bytes) => {
  // UTF-8 validity alone does not identify text: NUL and other C0 controls are
  // valid Unicode but make a patch unsafe/useless to render as source.
  if (bytes.some((byte) => byte === 0 || byte < 9 || (byte > 13 && byte < 32))) return null;
  try { return decoder.decode(bytes); } catch { return null; }
};

/** @param {string} before @param {string} after @param {string} path */
const simpleUnified = (before, after, path) => {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let aEnd = a.length - 1, bEnd = b.length - 1;
  while (aEnd >= start && bEnd >= start && a[aEnd] === b[bEnd]) { aEnd -= 1; bEnd -= 1; }
  const contextStart = Math.max(0, start - 2);
  const contextEndA = Math.min(a.length - 1, aEnd + 2);
  const contextEndB = Math.min(b.length - 1, bEnd + 2);
  const lines = [`--- a/${path}`, `+++ b/${path}`, `@@ -${contextStart + 1},${contextEndA - contextStart + 1} +${contextStart + 1},${contextEndB - contextStart + 1} @@`];
  for (let i = contextStart; i < start; i++) lines.push(` ${a[i]}`);
  for (let i = start; i <= aEnd; i++) lines.push(`-${a[i]}`);
  for (let i = start; i <= bEnd; i++) lines.push(`+${b[i]}`);
  const suffix = Math.max(aEnd, bEnd) + 1;
  for (let i = suffix; i <= Math.max(contextEndA, contextEndB); i++) {
    const value = b[i] ?? a[i];
    if (value !== undefined) lines.push(` ${value}`);
  }
  return lines.join('\n');
};

/** @param {Record<string,Uint8Array>} before @param {Record<string,Uint8Array>} after */
export const diffRepositorySnapshots = (before, after) => {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  /** @type {Array<{path:string,status:'added'|'modified'|'deleted',before?:string,after?:string,binary?:boolean}>} */
  const files = [];
  /** @type {string[]} */ const patches = [];
  let patchChars = 0;
  let returnedTextChars = 0;
  let truncated = false;
  for (const path of paths) {
    const left = before[path], right = after[path];
    if (left && right && left.length === right.length && left.every((byte, index) => byte === right[index])) continue;
    const tooLarge = (left?.byteLength ?? 0) > MAX_FILE_TEXT_CHARS || (right?.byteLength ?? 0) > MAX_FILE_TEXT_CHARS;
    const beforeText = left && !tooLarge ? textOf(left) : '';
    const afterText = right && !tooLarge ? textOf(right) : '';
    const status = !left ? 'added' : !right ? 'deleted' : 'modified';
    const binary = !tooLarge && (beforeText === null || afterText === null);
    const available = Math.max(0, MAX_RETURNED_TEXT_CHARS - returnedTextChars);
    const beforeClip = typeof beforeText === 'string' ? beforeText.slice(0, available) : '';
    returnedTextChars += beforeClip.length;
    const afterAvailable = Math.max(0, MAX_RETURNED_TEXT_CHARS - returnedTextChars);
    const afterClip = typeof afterText === 'string' ? afterText.slice(0, afterAvailable) : '';
    returnedTextChars += afterClip.length;
    if (tooLarge || beforeClip.length !== (beforeText?.length ?? 0) || afterClip.length !== (afterText?.length ?? 0)) truncated = true;
    files.push({ path, status, ...(beforeText !== null && left && !tooLarge ? { before: beforeClip } : {}), ...(afterText !== null && right && !tooLarge ? { after: afterClip } : {}), ...(binary ? { binary: true } : {}), ...(tooLarge ? { truncated: true } : {}) });
    const patch = tooLarge ? `Large files differ: ${path}` : binary ? `Binary files differ: ${path}` : simpleUnified(beforeText ?? '', afterText ?? '', path);
    const remaining = Math.max(0, MAX_PATCH_CHARS - patchChars);
    if (remaining > 0) patches.push(patch.slice(0, remaining));
    patchChars += Math.min(remaining, patch.length);
    if (patch.length > remaining) truncated = true;
  }
  return { files, patch: patches.join('\n\n'), truncated };
};
