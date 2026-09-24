// @ts-check
// Browser-host facts shared by the cold UI projection and sealed semantics.
// Tool exposure and model copy stay in peerd-runtime/runtime-capabilities.js.

export const RUNTIME_CAPABILITY_VERSION = 1;

/** @param {string} host */
const available = (host) => Object.freeze({
  status: /** @type {const} */ ('available'),
  host,
  reasonCode: null,
  retryable: false,
  alternativeCode: null,
});

/** @param {string} alternativeCode */
const unsupported = (alternativeCode) => Object.freeze({
  status: /** @type {const} */ ('unsupported'),
  host: null,
  reasonCode: 'host_unsupported',
  retryable: false,
  alternativeCode,
});

/**
 * Resolve product facilities from immutable browser-host facts.
 * @param {{ offscreenDocument: boolean, dwebPackaged?: boolean, moonshineVoiceDocument?: boolean }} hosts
 */
export const resolveRuntimeCapabilities = ({
  offscreenDocument, dwebPackaged = false, moonshineVoiceDocument = offscreenDocument,
}) => {
  const offscreen = offscreenDocument === true;
  const voiceDocument = moonshineVoiceDocument === true;
  return Object.freeze({
    version: RUNTIME_CAPABILITY_VERSION,
    sealedJobs: offscreen
      ? available('offscreen-worker')
      : unsupported('use_visible_notebook'),
    documentReader: offscreen
      ? available('offscreen-document')
      : unsupported('attach_pdf_or_plain_text'),
    readableHtml: Object.freeze({ mode: offscreen ? 'markdown' : 'snapshot_or_raw' }),
    moonshineVoiceHost: voiceDocument
      ? available(offscreen ? 'offscreen-document' : 'background-page')
      : unsupported('type_in_composer'),
    pdfOcr: offscreen
      ? available('offscreen-document')
      : unsupported('use_page_images_or_searchable_pdf'),
    localWebGpuHost: offscreen
      ? available('offscreen-document')
      : unsupported('use_ollama'),
    dwebMesh: offscreen && dwebPackaged
      ? available('offscreen-document')
      : unsupported('use_local_apps'),
  });
};

/** @param {unknown} capability */
export const runtimeCapabilityAvailable = (capability) =>
  /** @type {{ status?: unknown }} */ (capability)?.status === 'available';
