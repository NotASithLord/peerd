// @ts-check

import { expandComposerCommand, parseComposerRefs } from './composer-parser.js';

const KIB = 1024;

export const COMPOSER_REFERENCE_LIMIT = 64;
export const COMPOSER_COMMAND_LIMIT = 512;
export const COMPOSER_COMMAND_RESULT_BYTES = 128 * KIB;
export const COMPOSER_COMMAND_NAME_BYTES = 128;
export const COMPOSER_COMMAND_BODY_BYTES = 64 * KIB;
export const COMPOSER_COMMAND_DESCRIPTION_BYTES = 4 * KIB;
export const COMPOSER_INPUT_TEXT_BYTES = 128 * KIB;
export const COMPOSER_INPUT_OUTER_BYTES = 256 * KIB;
export const COMPOSER_OUTPUT_TEXT_BYTES = 256 * KIB;
export const COMPOSER_OUTPUT_OUTER_BYTES = 512 * KIB;
export const COMPOSER_EFFECT_BYTES = 128 * KIB;
export const COMPOSER_EFFECT_ERROR_BYTES = 4 * KIB;
export const COMPOSER_RESULT_CODE_BYTES = 256;
export const COMPOSER_REFERENCE_PATH_BYTES = 4 * KIB;
export const COMPOSER_REFERENCE_RAW_BYTES = 4 * KIB;
export const COMPOSER_REFERENCE_ERROR_BYTES = 512;
export const COMPOSER_FILE_CONTENT_BYTES = 120 * KIB;
export const COMPOSER_TAB_METADATA_BYTES = 4 * KIB;
export const COMPOSER_TAB_TEXT_BYTES = 16 * KIB;

const encoder = new TextEncoder();

/** @param {string} value */
export const composerUtf8Bytes = (value) => encoder.encode(value).byteLength;

/** @param {unknown} value @param {number} maxBytes */
export const composerUtf8Fits = (value, maxBytes) => typeof value === 'string'
  && composerUtf8Bytes(value) <= maxBytes;

/** @param {unknown} value @param {number} maxBytes */
export const truncateComposerUtf8 = (value, maxBytes) => {
  const text = String(value ?? '');
  if (composerUtf8Bytes(text) <= maxBytes) return text;
  const chunks = [];
  let used = 0;
  for (const character of text) {
    const bytes = composerUtf8Bytes(character);
    if (used + bytes > maxBytes) break;
    chunks.push(character);
    used += bytes;
  }
  return chunks.join('');
};

/**
 * @param {string} text
 * @param {readonly {name:string,body:string}[]} commands
 */
export const composerReferenceRequests = (text, commands) => {
  const working = expandComposerCommand(text, commands).text;
  /** @type {Array<{operation:'turn.compose.capture-tab'|'turn.compose.read-file',payload:{tabId:number|null}|{path:string}}>} */
  const requests = [];
  for (const ref of parseComposerRefs(working)) {
    if (requests.length >= COMPOSER_REFERENCE_LIMIT) break;
    if (ref.kind === 'tab') {
      if (ref.arg === '') {
        requests.push({ operation: 'turn.compose.capture-tab', payload: { tabId: null } });
      } else if (/^(?:[1-9]\d*)$/.test(ref.arg) && Number.isSafeInteger(Number(ref.arg))) {
        requests.push({ operation: 'turn.compose.capture-tab', payload: { tabId: Number(ref.arg) } });
      }
    } else if (ref.arg && composerUtf8Fits(ref.arg, COMPOSER_REFERENCE_PATH_BYTES)) {
      requests.push({ operation: 'turn.compose.read-file', payload: { path: ref.arg } });
    }
  }
  return Object.freeze(requests.map((request) => Object.freeze({
    operation: request.operation, payload: Object.freeze({ ...request.payload }),
  })));
};

/** @param {string} operation @param {Record<string,unknown>} payload */
export const composerReferenceRequestKey = (operation, payload) => operation === 'turn.compose.capture-tab'
  ? `tab:${payload.tabId === null ? 'active' : String(payload.tabId)}`
  : operation === 'turn.compose.read-file' ? `file:${String(payload.path)}` : '';
