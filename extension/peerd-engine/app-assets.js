// @ts-check
// App files keep an explicit text/binary kind in catalog metadata. Filename
// suffixes are only a safety hint for known byte formats and MIME selection.

export const BINARY_ASSET_EXTENSIONS = new Set([
  'wasm',
  'bin', 'dat', 'data', 'glb', 'gltfbin', 'ktx', 'ktx2',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
  'sqlite', 'sqlite3', 'db',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico',
  'mp3', 'ogg', 'oga', 'opus', 'wav', 'flac', 'm4a', 'aac',
  'mp4', 'webm', 'mov', 'm4v',
  'ttf', 'otf', 'woff', 'woff2',
]);
export const MAX_MODEL_APP_FILE_BYTES = 500_000;

/** @typedef {'text' | 'binary'} AppFileKind */

/**
 * Return true for a filename that unambiguously names a byte-oriented format.
 * Unknown suffixes are not classified here. Stored kind and byte inspection
 * decide those without risking a text decode.
 *
 * @param {string} path
 */
export const isBinaryAssetPath = (path) => {
  const dot = String(path).lastIndexOf('.');
  if (dot < 0) return false;
  return BINARY_ASSET_EXTENSIONS.has(String(path).slice(dot + 1).toLowerCase());
};

/**
 * A byte sequence is editable text only when UTF-8 decoding is lossless and it
 * contains no binary control characters. The control check catches short file
 * signatures that happen to be valid UTF-8, such as an empty archive header.
 *
 * @param {Uint8Array} bytes
 */
export const isLosslessUtf8Text = (bytes) => {
  let decoded;
  try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return false; }
  for (const char of decoded) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d)
        || code === 0x7f) return false;
  }
  const encoded = new TextEncoder().encode(decoded);
  if (encoded.byteLength !== bytes.byteLength) return false;
  return encoded.every((byte, index) => byte === bytes[index]);
};

/**
 * Infer kind for legacy or imported bytes that carry no trusted provenance.
 * Known binary suffixes stay binary even when their payload is ASCII.
 *
 * @param {string} path
 * @param {Uint8Array} bytes
 * @returns {AppFileKind}
 */
export const inferAppFileKind = (path, bytes) => (
  !isBinaryAssetPath(path) && isLosslessUtf8Text(bytes) ? 'text' : 'binary'
);

/**
 * Resolve a stored file at the read boundary. A binary declaration is final;
 * a text declaration is still checked against the bytes so catalog drift can
 * never feed lossy content into the editor.
 *
 * @param {string} path
 * @param {Uint8Array} bytes
 * @param {unknown} declaredKind
 */
export const isBinaryAppFile = (path, bytes, declaredKind) => {
  if (isBinaryAssetPath(path) || declaredKind === 'binary') return true;
  return !isLosslessUtf8Text(bytes);
};

/**
 * Shape one App file for text-only checkpoint and review storage. Binary bytes
 * become a stable, collision-resistant marker so add, change, and delete events
 * remain visible without decoding or exposing their content.
 *
 * @param {string} path
 * @param {Uint8Array} bytes
 * @param {unknown} declaredKind
 */
export const appFileCheckpointContent = async (path, bytes, declaredKind) => {
  if (!isBinaryAppFile(path, bytes, declaredKind)) return new TextDecoder().decode(bytes);
  const stableBytes = new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', stableBytes));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  // why the escaped NUL prefix: editable text classification rejects NUL, so
  // user text cannot collide with this review-only marker.
  return `\u0000peerd-binary:${bytes.byteLength}:${hash}`;
};
