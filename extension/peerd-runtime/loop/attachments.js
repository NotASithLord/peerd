// @ts-check
// File attachments — the pure core.
//
// The user attaches files to a chat message; the model sees them THAT
// turn. Three kinds, three transports:
//
//   image (png/jpeg/gif/webp) → Anthropic `image` content block
//   pdf                       → Anthropic `document` content block
//   text/*                    → NOT a block — inlined into the message
//                               text as <peerd_file name="…"> (the
//                               composer @file precedent), so the
//                               payload persists with the transcript.
//   office / e-book           → CONVERTED to Markdown (peerd-runtime/doc)
//                               and inlined on the text transport. The
//                               model has no native block for a .docx, so
//                               the choice is convert or refuse.
//
// Everything else is refused — fail closed, never silently dropped.
//
// Caps are enforced HERE (client-side), not discovered at the API:
// image ≤ 5MB, PDF ≤ 10MB, text ≤ 64KB, ≤ 5 attachments per message.
// Sizes are measured from the base64 payload when present (the claimed
// `size` can lie; the bytes can't), falling back to the claimed size
// for data-less records.
//
// Send-once-then-strip (the redact.js precedent): image/pdf bytes ride
// the model call only on the turn they're sent. The PERSISTED message —
// and therefore every later re-send — carries the metadata-only shape
// {name, mediaType, kind, size, stripped:true}. stripAttachments below
// is that transform; the agent loop applies it before persistence and
// splices the live list back in for the current turn only.

import { TypedError } from '/shared/errors.js';

// why Object.freeze: these are wire-contract constants (Anthropic's
// documented media types + peerd's enforced caps); a mutation anywhere
// would silently change what the validator admits.
export const IMAGE_MEDIA_TYPES = Object.freeze([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);

export const PDF_MEDIA_TYPE = 'application/pdf';

// Office / e-book documents. These have no model-native transport — Anthropic
// takes images and PDFs, nothing else — so they are CONVERTED to Markdown
// (peerd-runtime/doc) and inlined as text, exactly like a .txt.
//
// The extension list carries the LEGACY binaries (.doc/.xls/.ppt/.xlsb) on
// purpose even though nothing can convert them: classifying them here means
// the user gets the converter's specific "this is a Word 97-2003 file, here is
// what to do instead" rather than a flat "unsupported type". A precise refusal
// is worth more than an early one.
//
// peerd-runtime/doc/sniff.js is the authority on what actually converts; this
// table only decides what to ATTEMPT. Drift fails safe — a wrong guess becomes
// a clear conversion error, never a crash.
export const DOC_MEDIA_TYPES = Object.freeze([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/epub+zip',
  'application/rtf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
]);

export const DOC_EXTENSIONS = Object.freeze([
  'docx', 'docm', 'dotx', 'xlsx', 'xlsm', 'xltx', 'pptx', 'pptm', 'potx', 'ppsx',
  'odt', 'ott', 'ods', 'ots', 'odp', 'otp', 'epub', 'rtf',
  'doc', 'xls', 'ppt', 'xlsb',
]);

export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

// Caps keyed by kind, in BYTES of the decoded file.
export const ATTACHMENT_CAPS = Object.freeze({
  image: 5 * 1024 * 1024,   // Anthropic image block limit
  pdf: 10 * 1024 * 1024,    // Anthropic document block limit
  text: 64 * 1024,          // inlined into the prompt — keep it cheap
  // A document's SOURCE may be large while its text is small — most of a .docx
  // is usually embedded media the conversion discards — so the real limit is
  // DOC_TEXT_MAX_CHARS on the OUTPUT, which is what costs context.
  //
  // The input cap is nonetheless the PDF one rather than something generous,
  // because of the transport: an attachment is base64 (≈1.37×) and crosses two
  // message hops — panel → service worker, then service worker → offscreen for
  // the conversion. 10MB is already a ~14MB string copied twice, and real
  // office files sit far below it.
  doc: 10 * 1024 * 1024,
});

// Cap on the Markdown a converted document contributes to the prompt. It rides
// EVERY later turn (inlined text persists with the transcript, unlike image and
// PDF bytes which are stripped after one turn), so this is a recurring cost and
// is capped tighter than it would be for a one-shot read.
export const DOC_TEXT_MAX_CHARS = 40_000;

/** A single attachment was a type peerd can't ship to the model. */
export class UnsupportedAttachmentError extends TypedError {
  static errorName = 'UnsupportedAttachmentError';

  /**
   * @param {string} name
   * @param {string} mediaType
   */
  constructor(name, mediaType) {
    super(`Unsupported attachment type: "${name}" (${mediaType || 'unknown type'}). `
      + 'Supported: PNG/JPEG/GIF/WebP images, PDF, Word/Excel/PowerPoint/OpenDocument, '
      + 'RTF, EPUB, and plain-text files.');
    this.attachmentName = name;
    this.mediaType = mediaType;
  }
}

/** A single attachment exceeds its kind's byte cap. */
export class AttachmentTooLargeError extends TypedError {
  static errorName = 'AttachmentTooLargeError';

  /**
   * @param {string} name
   * @param {string} kind
   * @param {number} size
   * @param {number} cap
   */
  constructor(name, kind, size, cap) {
    super(`Attachment too large: "${name}" is ${formatBytes(size)} — `
      + `the ${kind} limit is ${formatBytes(cap)}.`);
    this.attachmentName = name;
    this.kind = kind;
    this.size = size;
    this.cap = cap;
  }
}

/** A document attachment could not be converted to text. */
export class AttachmentConversionError extends TypedError {
  static errorName = 'AttachmentConversionError';

  /**
   * @param {string} name
   * @param {string} reason
   */
  constructor(name, reason) {
    super(`Could not read "${name}": ${reason}`);
    this.attachmentName = name;
    this.reason = reason;
  }
}

/** The message carries more attachments than the per-message cap. */
export class TooManyAttachmentsError extends TypedError {
  static errorName = 'TooManyAttachmentsError';

  /** @param {number} count */
  constructor(count) {
    super(`Too many attachments: ${count} — the limit is `
      + `${MAX_ATTACHMENTS_PER_MESSAGE} per message.`);
    this.count = count;
  }
}

/**
 * Classify a candidate file by media type, falling back to its extension.
 *
 * why the extension fallback, for documents only: the browser's File.type is
 * routinely EMPTY for office files (it depends on an OS media-type registry
 * that often has no entry for .docx), so media-type-only classification
 * refuses the common case. Images and PDFs don't need it — those types are
 * universally registered — and a blanket extension fallback would let a
 * mislabeled file through as something it isn't.
 *
 * Order matters: text/* is checked BEFORE the extension fallback, so a
 * text/csv file stays 'text' and is inlined verbatim rather than being
 * re-rendered as a Markdown table.
 *
 * Pure. Never throws — 'unsupported' is a value, so callers (the panel's
 * add-file path, the SW's validator) decide how loudly to fail.
 *
 * @param {{ name?: string, mediaType?: string, size?: number }} att
 * @returns {'image' | 'pdf' | 'text' | 'doc' | 'unsupported'}
 */
export const classifyAttachment = (att) => {
  const mt = String(att?.mediaType ?? '').toLowerCase().split(';')[0].trim();
  if (IMAGE_MEDIA_TYPES.includes(mt)) return 'image';
  if (mt === PDF_MEDIA_TYPE) return 'pdf';
  if (DOC_MEDIA_TYPES.includes(mt)) return 'doc';
  if (mt.startsWith('text/')) return 'text';
  const name = String(att?.name ?? '');
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (ext && DOC_EXTENSIONS.includes(ext)) return 'doc';
  return 'unsupported';
};

// base64 → decoded byte count (every 4 chars decode to 3 bytes, minus
// padding). Used so the cap is enforced against what would actually
// ship, not against a caller-claimed size.
/** @param {string} data */
const base64Bytes = (data) => {
  const s = String(data);
  const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - padding);
};

/**
 * Effective byte size of an attachment: decoded base64 length when the
 * payload is present, the claimed size otherwise.
 *
 * @param {{ size?: number, data?: string }} att
 * @returns {number}
 */
export const attachmentBytes = (att) => {
  if (typeof att?.data === 'string' && att.data.length > 0) return base64Bytes(att.data);
  const size = att?.size;
  return typeof size === 'number' && Number.isFinite(size) ? Math.max(0, Math.floor(size)) : 0;
};

/**
 * Validate ONE attachment and build the internal record.
 *
 * Throws UnsupportedAttachmentError / AttachmentTooLargeError. Returns
 * the normalized internal shape (kind resolved, size measured).
 *
 * @param {{ name?: string, mediaType?: string, size?: number, data?: string, text?: string }} att
 * @returns {{ name: string, mediaType: string, kind: 'image'|'pdf'|'text'|'doc', size: number, data?: string, text?: string }}
 */
export const validateAttachment = (att) => {
  const name = String(att?.name ?? '') || 'file';
  const mediaType = String(att?.mediaType ?? '').toLowerCase().split(';')[0].trim();
  const kind = classifyAttachment(att);
  if (kind === 'unsupported') throw new UnsupportedAttachmentError(name, mediaType);
  const size = attachmentBytes(att);
  if (size > ATTACHMENT_CAPS[kind]) {
    throw new AttachmentTooLargeError(name, kind, size, ATTACHMENT_CAPS[kind]);
  }
  return {
    name,
    mediaType,
    kind,
    size,
    ...(typeof att?.data === 'string' && att.data.length > 0 ? { data: att.data } : {}),
    // Carried through so validation stays IDEMPOTENT: prepareUserAttachments
    // re-validates, and by then a converted document holds its Markdown here
    // instead of base64. Rebuilding the record field-by-field without this
    // silently drops the converted text and inlines an empty file.
    ...(typeof (/** @type {{ text?: string }} */ (att).text) === 'string'
      ? { text: /** @type {{ text?: string }} */ (att).text } : {}),
  };
};

/**
 * Validate a whole per-message batch. Throws on the first violation —
 * the send fails closed as a unit (a partial attach the user didn't ask
 * for would be a lie).
 *
 * @param {ReadonlyArray<{ name?: string, mediaType?: string, size?: number, data?: string }>} list
 * @returns {Array<ReturnType<typeof validateAttachment>>}
 */
export const validateAttachments = (list) => {
  const arr = Array.isArray(list) ? list : [];
  if (arr.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new TooManyAttachmentsError(arr.length);
  return arr.map(validateAttachment);
};

/**
 * Convert the 'doc' attachments in a validated batch into inlinable text.
 *
 * The ONE impure step in this file, and the IO is injected rather than
 * imported (the house rule) — the caller passes a converter, which in the
 * service worker is the offscreen document client. That keeps the parsers out
 * of this module entirely: the side panel imports classifyAttachment from
 * here, and must not drag seven format walkers along with it.
 *
 * Each converted record trades its base64 `data` for a `text` field. Nothing
 * downstream sees document bytes: the Markdown is what gets inlined, persisted
 * and re-sent, and the original file is dropped after this step.
 *
 * FAIL CLOSED, per attachment, with the converter's own message — "this is a
 * Word 97-2003 binary, ask for a .docx or convert it in a WebVM" is the whole
 * value of attempting a legacy file, and a generic error would throw it away.
 *
 * @param {Object} args
 * @param {Array<{ name: string, mediaType: string, kind: string, size: number, data?: string }>} args.attachments
 * @param {(att: { name: string, mediaType: string, data?: string }) => Promise<string>} args.convert
 * @returns {Promise<Array<{ name: string, mediaType: string, kind: string, size: number, data?: string, text?: string }>>}
 */
export const convertDocAttachments = async ({ attachments, convert }) => {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.some((att) => att.kind === 'doc')) return list;
  if (typeof convert !== 'function') {
    throw new AttachmentConversionError(
      list.find((att) => att.kind === 'doc')?.name ?? 'file',
      'document conversion is not available in this browser build',
    );
  }
  const out = [];
  for (const att of list) {
    if (att.kind !== 'doc') { out.push(att); continue; }
    let text;
    try {
      text = await convert({ name: att.name, mediaType: att.mediaType, data: att.data });
    } catch (e) {
      throw new AttachmentConversionError(att.name, /** @type {{ message?: string }} */ (e)?.message ?? String(e));
    }
    const { data: _drop, ...meta } = att;
    out.push({ ...meta, text: String(text ?? '') });
  }
  return out;
};

/**
 * Metadata-only shape for persistence and every later re-send. The
 * payload is gone; name/type/kind/size stay so the UI can render the
 * chip and the model can see what WAS attached.
 *
 * @param {{ name: string, mediaType: string, kind: 'image'|'pdf'|'text'|'doc', size: number, data?: string }} att
 * @returns {{ name: string, mediaType: string, kind: 'image'|'pdf'|'text'|'doc', size: number, stripped: true }}
 */
export const stripAttachment = ({ name, mediaType, kind, size }) =>
  ({ name, mediaType, kind, size, stripped: true });

/**
 * @param {ReadonlyArray<{ name: string, mediaType: string, kind: 'image'|'pdf'|'text'|'doc', size: number, data?: string }>} list
 * @returns {Array<ReturnType<typeof stripAttachment>>}
 */
export const stripAttachments = (list) => (Array.isArray(list) ? list.map(stripAttachment) : []);

// Attribute-escape for the <peerd_file name="…"> wrapper — same rule as
// the composer's @file resolver (resolvers.js escAttr): the filename is
// user-controlled and must not be able to break out of the attribute.
/** @param {string} s */
const escAttr = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Decode a base64 text payload as UTF-8.
 *
 * @param {string} data   base64
 * @returns {string}
 */
const decodeBase64Text = (data) => {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

/**
 * Validate a send's attachments and shape them for the turn:
 *
 *   - text/* payloads are decoded and APPENDED to the message text as
 *     <peerd_file name="…"> blocks (the @file precedent: text persists
 *     with the transcript — it's already capped at 64KB). Their records
 *     keep metadata only; the data never rides the attachment.
 *   - image/pdf records keep their base64 — the loop ships the bytes
 *     this turn and persists the stripped shape.
 *
 * Throws the typed errors above; the SW returns them verbatim so the
 * composer can put the draft back.
 *
 * @param {{ text: string, attachments: ReadonlyArray<{ name?: string, mediaType?: string, size?: number, data?: string }> }} args
 * @returns {{ text: string, attachments: Array<{ name: string, mediaType: string, kind: string, size: number, data?: string }> }}
 */
export const prepareUserAttachments = ({ text, attachments }) => {
  const validated = validateAttachments(attachments);
  let outText = typeof text === 'string' ? text : '';
  const outAttachments = [];
  for (const att of validated) {
    if (att.kind === 'text' || att.kind === 'doc') {
      // why decode here (pure) and not at render time: the inlined text
      // must persist with the message — to-anthropic never sees the
      // base64, so there's no live/stripped split to manage for text.
      //
      // A 'doc' arrives already converted (convertDocAttachments ran before
      // this, upstream) and carries `text` instead of `data`. It rides the
      // SAME transport because a converted document IS text — which also
      // means it persists with the transcript, so the model can still see
      // the spreadsheet three turns later. The chip keeps kind:'doc', so
      // the UI still says "report.docx" rather than calling it a text file.
      const body = att.kind === 'doc'
        ? String(att.text ?? '')
        : (att.data ? decodeBase64Text(att.data) : '');
      outText += `\n\n<peerd_file name="${escAttr(att.name)}">\n${body}\n</peerd_file>`;
      const { data: _drop, text: _dropText, ...meta } = att;
      outAttachments.push(meta);
    } else {
      outAttachments.push(att);
    }
  }
  return { text: outText, attachments: outAttachments };
};

/**
 * The send path's ONE attachment entry point: validate, convert documents,
 * then inline. Async only because conversion is.
 *
 * why this wrapper exists rather than three calls at the call site: the ORDER
 * is a correctness property, not a convenience. Validation must run BEFORE
 * conversion (otherwise a 200MB file is parsed and only then rejected for
 * being over cap), and conversion must run before inlining (the pure step has
 * no way to produce text from a .docx). Encoding that here means the service
 * worker route cannot get it wrong, and the sequence is testable on its own.
 *
 * @param {{
 *   text: string,
 *   attachments: ReadonlyArray<{ name?: string, mediaType?: string, size?: number, data?: string }>,
 *   convert?: (att: { name: string, mediaType: string, data?: string }) => Promise<string>,
 * }} args
 * @returns {Promise<{
 *   text: string,
 *   attachments: Array<{ name: string, mediaType: string, kind: string, size: number, data?: string }>,
 * }>}
 */
export const prepareUserAttachmentsWithDocs = async ({ text, attachments, convert }) => {
  const validated = validateAttachments(/** @type {any} */ (attachments));
  const converted = await convertDocAttachments({
    attachments: validated,
    convert: /** @type {any} */ (convert),
  });
  return prepareUserAttachments({ text, attachments: /** @type {any} */ (converted) });
};

/**
 * Human-readable byte size for error messages and UI chips.
 *
 * @param {number} bytes
 * @returns {string}
 */
export const formatBytes = (bytes) => {
  const n = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};
