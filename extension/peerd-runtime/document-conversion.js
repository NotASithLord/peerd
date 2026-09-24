// @ts-check
// Pure structured-document surface for the disposable offscreen converter.
// Keeping it narrow prevents that Worker from loading unrelated actor, tool,
// voice, and PDF graphs through the broader offscreen host surface.

export { convertToDocument } from './doc/convert.js';
export {
  DocParseError, UnsupportedDocFormatError, LegacyDocFormatError, ZipError,
} from './doc/errors.js';
