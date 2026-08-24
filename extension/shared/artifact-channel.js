// @ts-check
// Fixed, browser-neutral contract for the demand-only artifact codec realm.
// Both sides independently enforce these rails before allocating codec work.

import { structuredClonePayloadBytes } from './structured-clone-size.js';
import {
  admitArtifactChannelOffer,
  ARTIFACT_CHANNEL_OFFER,
  ARTIFACT_CHANNEL_OPERATIONS,
  ARTIFACT_CHANNEL_PROTOCOL,
  artifactChannelOperationAllowed,
  parseArtifactChannelOffer,
} from './artifact-offer.js';
export {
  admitArtifactChannelOffer,
  ARTIFACT_CHANNEL_OFFER,
  ARTIFACT_CHANNEL_OPERATIONS,
  ARTIFACT_CHANNEL_PROTOCOL,
  artifactChannelOperationAllowed,
  parseArtifactChannelOffer,
};

export const ARTIFACT_CHANNEL_CANCEL = 'peerd/artifact-cancel';
export const ARTIFACT_WORKER_RUN = 'peerd/artifact-worker-run';
const MIB = 1024 * 1024;
const SMALL = 256 * 1024;

// The artifact format already has an exact 64 MiB decoded / 96 MiB file rail.
// Clone accounting uses a wide node bound so a valid many-file artifact is not
// rejected merely because it is structurally rich while remaining byte-safe.
export const ARTIFACT_CHANNEL_MAX_BYTES = 96 * MIB;
export const ARTIFACT_CHANNEL_CLONE_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 250_000,
});

/** @param {number} requestBytes @param {number} resultBytes @param {number} timeoutMs */
const policy = (requestBytes, resultBytes, timeoutMs) => Object.freeze({
  requestBytes, resultBytes, timeoutMs,
});
export const ARTIFACT_OPERATION_POLICIES = Object.freeze({
  buildAppExport: policy(ARTIFACT_CHANNEL_MAX_BYTES, ARTIFACT_CHANNEL_MAX_BYTES, 120_000),
  buildNotebookExport: policy(ARTIFACT_CHANNEL_MAX_BYTES, ARTIFACT_CHANNEL_MAX_BYTES, 120_000),
  buildVmRecipeExport: policy(SMALL, SMALL, 30_000),
  openEnvelope: policy(ARTIFACT_CHANNEL_MAX_BYTES, ARTIFACT_CHANNEL_MAX_BYTES, 120_000),
  inspectEnvelope: policy(ARTIFACT_CHANNEL_MAX_BYTES, SMALL, 120_000),
  exportFilename: policy(16 * 1024, 16 * 1024, 10_000),
});

/** @param {unknown} value */
export const artifactChannelPayloadBytes = (value) => structuredClonePayloadBytes(
  value,
  ARTIFACT_CHANNEL_CLONE_LIMITS,
);

/** @param {unknown} operation */
export const artifactOperationPolicy = (operation) => artifactChannelOperationAllowed(operation)
  ? ARTIFACT_OPERATION_POLICIES[/** @type {keyof typeof ARTIFACT_OPERATION_POLICIES} */ (operation)]
  : null;

/** @param {unknown} operation @param {unknown} args */
export const artifactChannelRequestAllowed = (operation, args) => {
  const operationPolicy = artifactOperationPolicy(operation);
  if (!operationPolicy) return false;
  const bytes = artifactChannelPayloadBytes(args);
  return Number.isFinite(bytes) && bytes <= operationPolicy.requestBytes;
};

/** @param {unknown} operation @param {unknown} value */
export const artifactChannelResultAllowed = (operation, value) => {
  const operationPolicy = artifactOperationPolicy(operation);
  if (!operationPolicy) return false;
  const bytes = artifactChannelPayloadBytes(value);
  return Number.isFinite(bytes) && bytes <= operationPolicy.resultBytes;
};

const OPERATION_KEYS = 'args\nchannelId\noperation\nprotocol\ntype';

/** @param {unknown} value @param {string} expectedType */
const parseOperationMessage = (value, expectedType) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = /** @type {Record<string, unknown>} */ (value);
  if (Object.keys(message).sort().join('\n') !== OPERATION_KEYS
      || message.type !== expectedType
      || message.protocol !== ARTIFACT_CHANNEL_PROTOCOL
      || typeof message.channelId !== 'string'
      || message.channelId.length < 8 || message.channelId.length > 256
      || /[\u0000-\u001f\u007f]/.test(message.channelId)
      || typeof message.operation !== 'string'
      || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(message.operation)
      || !Array.isArray(message.args) || message.args.length > 8) return null;
  const bytes = artifactChannelPayloadBytes(message.args);
  if (!Number.isFinite(bytes) || bytes > ARTIFACT_CHANNEL_MAX_BYTES) return null;
  return Object.freeze({
    type: expectedType,
    protocol: ARTIFACT_CHANNEL_PROTOCOL,
    channelId: message.channelId,
    operation: message.operation,
    args: message.args,
  });
};

/** @param {unknown} value */
export const parseArtifactWorkerRun = (value) =>
  parseOperationMessage(value, ARTIFACT_WORKER_RUN);

/** @param {unknown} value @param {string} channelId */
export const isArtifactChannelCancel = (value, channelId) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = /** @type {Record<string, unknown>} */ (value);
  return Object.keys(message).sort().join('\n') === 'channelId\nprotocol\ntype'
    && message.type === ARTIFACT_CHANNEL_CANCEL
    && message.protocol === ARTIFACT_CHANNEL_PROTOCOL
    && message.channelId === channelId;
};

/** @param {unknown} value @param {Transferable[]} [out] @param {Set<ArrayBuffer>} [seen] */
export const collectArtifactTransferables = (value, out = [], seen = new Set()) => {
  if (!value || typeof value !== 'object') return out;
  const candidate = value instanceof ArrayBuffer
    ? value
    : ArrayBuffer.isView(value) ? value.buffer : null;
  const buffer = candidate instanceof ArrayBuffer ? candidate : null;
  if (buffer) {
    if (!seen.has(buffer)) { seen.add(buffer); out.push(buffer); }
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectArtifactTransferables(entry, out, seen);
    return out;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return out;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) collectArtifactTransferables(descriptor.value, out, seen);
  }
  return out;
};
