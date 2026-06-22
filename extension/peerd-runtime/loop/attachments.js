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

export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

// Caps keyed by kind, in BYTES of the decoded file.
export const ATTACHMENT_CAPS = Object.freeze({
  image: 5 * 1024 * 1024,   // Anthropic image block limit
  pdf: 10 * 1024 * 1024,    // Anthropic document block limit
  text: 64 * 1024,          // inlined into the prompt — keep it cheap
});

/** A single attachment was a type peerd can't ship to the model. */
export class UnsupportedAttachmentError extends TypedError {
  /**
   * @param {string} name
   * @param {string} mediaType
   */
  constructor(name, mediaType) {
    super(`Unsupported attachment type: "${name}" (${mediaType || 'unknown type'}). `
      + 'Supported: PNG/JPEG/GIF/WebP images, PDF, and plain-text files.');
    this.attachmentName = name;
    this.mediaType = mediaType;
  }
}

/** A single attachment exceeds its kind's byte cap. */
export class AttachmentTooLargeError extends TypedError {
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

/** The message carries more attachments than the per-message cap. */
export class TooManyAttachmentsError extends TypedError {
  /** @param {number} count */
  constructor(count) {
    super(`Too many attachments: ${count} — the limit is `
      + `${MAX_ATTACHMENTS_PER_MESSAGE} per message.`);
    this.count = count;
  }
}

/**
 * Classify a candidate file by media type.
 *
 * Pure. Never throws — 'unsupported' is a value, so callers (the panel's
 * add-file path, the SW's validator) decide how loudly to fail.
 *
 * @param {{ name?: string, mediaType?: string, size?: number }} att
 * @returns {'image' | 'pdf' | 'text' | 'unsupported'}
 */
export const classifyAttachment = (att) => {
  const mt = String(att?.mediaType ?? '').toLowerCase().split(';')[0].trim();
  if (IMAGE_MEDIA_TYPES.includes(mt)) return 'image';
  if (mt === PDF_MEDIA_TYPE) return 'pdf';
  if (mt.startsWith('text/')) return 'text';
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
 * @param {{ name?: string, mediaType?: string, size?: number, data?: string }} att
 * @returns {{ name: string, mediaType: string, kind: 'image'|'pdf'|'text', size: number, data?: string }}
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
 * Metadata-only shape for persistence and every later re-send. The
 * payload is gone; name/type/kind/size stay so the UI can render the
 * chip and the model can see what WAS attached.
 *
 * @param {{ name: string, mediaType: string, kind: 'image'|'pdf'|'text', size: number, data?: string }} att
 * @returns {{ name: string, mediaType: string, kind: 'image'|'pdf'|'text', size: number, stripped: true }}
 */
export const stripAttachment = ({ name, mediaType, kind, size }) =>
  ({ name, mediaType, kind, size, stripped: true });

/**
 * @param {ReadonlyArray<{ name: string, mediaType: string, kind: 'image'|'pdf'|'text', size: number, data?: string }>} list
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
    if (att.kind === 'text') {
      // why decode here (pure) and not at render time: the inlined text
      // must persist with the message — to-anthropic never sees the
      // base64, so there's no live/stripped split to manage for text.
      const body = att.data ? decodeBase64Text(att.data) : '';
      outText += `\n\n<peerd_file name="${escAttr(att.name)}">\n${body}\n</peerd_file>`;
      const { data: _drop, ...meta } = att;
      outAttachments.push(meta);
    } else {
      outAttachments.push(att);
    }
  }
  return { text: outText, attachments: outAttachments };
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
