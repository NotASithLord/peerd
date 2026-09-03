// @ts-check
// Per-operation pure artifact realm. This Worker has no browser, storage,
// network, vault, controller, or feature-lease authority and terminates after
// exactly one request.

import {
  buildAppExport,
  buildNotebookExport,
  buildVmRecipeExport,
  exportFilename,
  inspectEnvelope,
  openEnvelope,
} from '/peerd-engine/artifact.js';
import {
  ARTIFACT_CHANNEL_PROTOCOL,
  artifactChannelRequestAllowed,
  artifactChannelResultAllowed,
  collectArtifactTransferables,
  parseArtifactWorkerRun,
  serializeArtifactError,
} from '/shared/artifact-channel.js';

const OPERATIONS = Object.freeze({
  buildAppExport,
  buildNotebookExport,
  buildVmRecipeExport,
  openEnvelope,
  inspectEnvelope,
  exportFilename,
});

self.onmessage = async (event) => {
  const request = parseArtifactWorkerRun(event.data);
  if (!request || !artifactChannelRequestAllowed(request.operation, request.args)) {
    self.close();
    return;
  }
  const operation = /** @type {((...args:any[])=>unknown)|undefined} */ (
    OPERATIONS[/** @type {keyof typeof OPERATIONS} */ (request.operation)]
  );
  if (typeof operation !== 'function') {
    self.close();
    return;
  }
  try {
    const value = await operation(...request.args);
    if (!artifactChannelResultAllowed(request.operation, value)) {
      throw Object.assign(new Error('artifact codec result exceeded its fixed limit'), {
        name: 'ArtifactPayloadTooLargeError',
        code: 'artifact-result-too-large',
        outcomeKnown: true,
      });
    }
    self.postMessage({
      protocol: ARTIFACT_CHANNEL_PROTOCOL,
      channelId: request.channelId,
      ok: true,
      value,
    }, collectArtifactTransferables(value));
  } catch (cause) {
    self.postMessage({
      protocol: ARTIFACT_CHANNEL_PROTOCOL,
      channelId: request.channelId,
      ok: false,
      error: serializeArtifactError(cause),
    });
  } finally {
    self.close();
  }
};
