// @ts-check
// A minimal ZIP reader — the container every modern office format is built on.
//
// why hand-rolled and not vendored: the only thing hard about ZIP is DEFLATE,
// and the platform ships that as `DecompressionStream('deflate-raw')`. What is
// left is parsing a well-specified directory structure — ~150 lines with no
// dependency, no build step, and no third-party bytes to audit. Vendoring a
// zip library to avoid this would trade an auditable 150 lines for tens of
// thousands.
//
// Read from the CENTRAL DIRECTORY, never by scanning local headers: a local
// header may carry zeroed sizes with the real values in a trailing data
// descriptor (streamed archives do this routinely), so local-header scanning
// silently truncates entries. The central directory is authoritative.
//
// Pure apart from DecompressionStream (a platform primitive available in the
// SW, workers, the offscreen doc, and Bun) — so this is bun-testable.

import { ZipError } from './errors.js';

const SIG_EOCD = 0x06054b50;         // End Of Central Directory
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

// Ceiling on a SINGLE inflated member. Generous against real documents — the
// body part of a 500-page Word file is a few MB of XML — and the backstop
// against a decompression bomb (see readZipEntry).
export const MAX_ENTRY_BYTES = 128 * 1024 * 1024;

/** @typedef {{ name: string, compression: number, compressedSize: number, size: number, offset: number }} ZipEntry */

/**
 * Find the End Of Central Directory record. It sits at the very end of the
 * file unless a ZIP comment follows it, so scan backwards over the maximum
 * comment length (64k) rather than assuming the last 22 bytes.
 * @param {DataView} view
 */
const findEocd = (view) => {
  const min = Math.max(0, view.byteLength - 0xffff - 22);
  for (let i = view.byteLength - 22; i >= min; i -= 1) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  throw new ZipError('not a ZIP archive (no end-of-central-directory record)');
};

/**
 * Locate the central directory, transparently handling ZIP64. The classic
 * EOCD stores 32-bit offsets; an archive over 4GB (or with >65535 members)
 * writes 0xffffffff there and puts the real values in a ZIP64 record. We are
 * unlikely to meet one in a .docx, but a wrong answer here reads as a corrupt
 * archive rather than as "too big", so it is worth the dozen lines.
 * @param {DataView} view
 * @param {number} eocd
 */
const centralDirectoryAt = (view, eocd) => {
  let count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (offset !== 0xffffffff && count !== 0xffff) return { count, offset };

  // ZIP64: a locator sits immediately before the EOCD and points at the
  // ZIP64 EOCD, which holds the widened values.
  const locator = eocd - 20;
  if (locator < 0 || view.getUint32(locator, true) !== SIG_EOCD64_LOCATOR) {
    throw new ZipError('ZIP64 archive with no ZIP64 locator');
  }
  const z64 = Number(view.getBigUint64(locator + 8, true));
  if (view.getUint32(z64, true) !== SIG_EOCD64) throw new ZipError('malformed ZIP64 end-of-central-directory');
  count = Number(view.getBigUint64(z64 + 32, true));
  offset = Number(view.getBigUint64(z64 + 48, true));
  return { count, offset };
};

/**
 * Read a ZIP's central directory into an entry index. Nothing is decompressed
 * here — that is per-entry and lazy, because a .docx carries dozens of parts
 * (fonts, images, theme XML) of which a text conversion reads two or three.
 *
 * @param {Uint8Array} bytes
 * @returns {Map<string, ZipEntry>}
 */
export const readZipIndex = (bytes) => {
  if (!bytes || bytes.length < 22) throw new ZipError('file too small to be a ZIP archive');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { count, offset } = centralDirectoryAt(view, findEocd(view));

  /** @type {Map<string, ZipEntry>} */
  const entries = new Map();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let p = offset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== SIG_CENTRAL) {
      // A truncated or lied-about directory: keep what we already indexed
      // rather than failing the whole read. A .docx missing its last font
      // part still converts perfectly.
      break;
    }
    const flags = view.getUint16(p + 8, true);
    const compression = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // Bit 0 = encrypted. Refuse loudly: a password-protected document is a
    // "you need the password" answer, not a parse failure.
    if (flags & 0x1) throw new ZipError(`encrypted archive member: ${name}`);
    entries.set(name, { name, compression, compressedSize, size, offset: localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.size) throw new ZipError('ZIP archive contains no readable entries');
  return entries;
};

/**
 * Decompress one member. Only STORE (0) and DEFLATE (8) are supported —
 * together they cover every OOXML/ODF/EPUB writer in practice; the exotic
 * methods (bzip2, LZMA, zstd) are refused by name so the failure is legible.
 *
 * @param {Uint8Array} bytes   the whole archive
 * @param {ZipEntry} entry
 * @returns {Promise<Uint8Array>}
 */
export const readZipEntry = async (bytes, entry) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== SIG_LOCAL) {
    throw new ZipError(`bad local header for ${entry.name}`);
  }
  // The local header's own name/extra lengths are the authority for where the
  // data starts — they legitimately differ from the central directory's.
  const nameLen = view.getUint16(entry.offset + 26, true);
  const extraLen = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLen + extraLen;
  const raw = bytes.subarray(start, start + entry.compressedSize);

  if (entry.compression === 0) return raw;
  if (entry.compression !== 8) {
    throw new ZipError(`unsupported compression method ${entry.compression} for ${entry.name}`);
  }
  // DECOMPRESSION BOMB guard, and it is not theoretical: DEFLATE reaches ~1000:1
  // on repetitive input, so a 1MB member inside an innocuous-looking .docx can
  // inflate to a gigabyte and take the offscreen document (and the extension's
  // renderer process) with it. The header's declared size is checked FIRST —
  // free, and it catches the honest case — but a bomb can lie there, so the
  // stream is also read incrementally and aborted the moment it exceeds the cap.
  // why not trust the fetch-side MAX_BYTES: that bounds the COMPRESSED input,
  // which is exactly what a bomb keeps small.
  if (entry.size > MAX_ENTRY_BYTES) {
    throw new ZipError(`archive member ${entry.name} declares ${entry.size} bytes (limit ${MAX_ENTRY_BYTES})`);
  }
  // 'deflate-raw' — a ZIP member is a bare DEFLATE stream with no zlib header.
  // why the cast: TS types BlobPart's view as ArrayBuffer-backed, while a
  // Uint8Array is ArrayBufferLike-backed (it could, in principle, be over a
  // SharedArrayBuffer). Ours never is — it came from a fetch or a File.
  const stream = new Blob([/** @type {BlobPart} */ (/** @type {unknown} */ (raw))])
    .stream().pipeThrough(new DecompressionStream('deflate-raw'));

  const reader = stream.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      // why a manual read loop rather than `new Response(stream).arrayBuffer()`:
      // that buffers the WHOLE output before we could measure it, which is the
      // bomb. Reading chunk by chunk lets us stop at the cap. (A counting loop
      // is the sanctioned shape here — early exit, per eslint.config.js.)
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_ENTRY_BYTES) {
        throw new ZipError(`archive member ${entry.name} inflates past the ${MAX_ENTRY_BYTES}-byte limit`);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof ZipError) throw e;
    throw new ZipError(`could not inflate ${entry.name}: ${(/** @type {{ message?: string }} */ (e))?.message ?? e}`);
  } finally {
    // Release the lock so the underlying stream can be collected even when we
    // bailed out mid-inflate.
    try { reader.releaseLock(); } catch { /* already released */ }
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
};

/**
 * Read a member as UTF-8 text by name. Returns null when the member is absent
 * — callers routinely probe for optional parts (styles, numbering, metadata)
 * and "not there" is normal, not exceptional.
 *
 * @param {Uint8Array} bytes
 * @param {Map<string, ZipEntry>} index
 * @param {string} name
 * @returns {Promise<string | null>}
 */
export const readZipText = async (bytes, index, name) => {
  const entry = index.get(name);
  if (!entry) return null;
  const out = await readZipEntry(bytes, entry);
  return new TextDecoder('utf-8', { fatal: false }).decode(out);
};
