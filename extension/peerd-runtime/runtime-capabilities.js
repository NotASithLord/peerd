// @ts-check
// Runtime capabilities give one browser-neutral description of facilities the
// privileged host can actually provide.

/** @typedef {'available'|'unsupported'|'temporarily_unavailable'} RuntimeCapabilityStatus */
/**
 * @typedef {object} RuntimeCapability
 * @property {RuntimeCapabilityStatus} status
 * @property {string|null} host
 * @property {string|null} reasonCode
 * @property {boolean} retryable
 * @property {string|null} alternativeCode
 */

export const RUNTIME_CAPABILITY_VERSION = 1;

export class RuntimeCapabilityUnavailableError extends Error {
  /** @param {string} facility @param {string} alternative */
  constructor(facility, alternative) {
    super(`Runtime facility ${facility} is unavailable. Alternative: ${alternative.replaceAll('_', ' ')}.`);
    this.name = 'RuntimeCapabilityUnavailableError';
    this.code = 'runtime_capability_unavailable';
    this.facility = facility;
    this.alternative = alternative;
  }
}

/** @param {RuntimeCapability|null|undefined} capability @param {string} facility */
export const requireRuntimeCapability = (capability, facility) => {
  if (runtimeCapabilityAvailable(capability)) return;
  throw new RuntimeCapabilityUnavailableError(
    facility,
    capability?.alternativeCode ?? 'use another supported facility',
  );
};

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
 * Resolve facilities from host facts. Consumers must ask about the product
 * facility, never infer support from a browser name or a stored preference.
 *
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

/** @typedef {'sealedJobs'|'documentReader'|'dwebMesh'} ToolRuntimeFacility */
/** @type {Readonly<Record<string, ToolRuntimeFacility>>} */
const TOOL_CAPABILITIES = Object.freeze({
  script: 'sealedJobs',
  page_code: 'sealedJobs',
  app_code: 'sealedJobs',
  site_client_run: 'sealedJobs',
  a2a_run: 'dwebMesh',
  read_doc: 'documentReader',
});

/** @param {unknown} capability */
export const runtimeCapabilityAvailable = (capability) =>
  /** @type {{ status?: unknown }} */ (capability)?.status === 'available';

/**
 * @param {string} toolName
 * @param {ReturnType<typeof resolveRuntimeCapabilities>|null|undefined} capabilities
 */
export const runtimeCapabilityForTool = (toolName, capabilities) => {
  const facility = toolName.startsWith('dweb_') ? 'dwebMesh' : TOOL_CAPABILITIES[toolName];
  if (!facility || !capabilities) return null;
  return { facility, capability: capabilities[facility] };
};

/**
 * Keep model-facing web tool contracts aligned with the live host. The base
 * descriptors describe the richer host; this adapter removes promises that a
 * host without document conversion cannot keep.
 * @template {{ name: string, description?: string, schema?: any }} T
 * @param {T} tool
 * @param {ReturnType<typeof resolveRuntimeCapabilities>|null|undefined} capabilities
 * @returns {T}
 */
const adaptDescriptorToRuntime = (tool, capabilities) => {
  if (!capabilities) return tool;
  if (tool.name === 'fetch_url') {
    const markdownAvailable = capabilities.readableHtml?.mode === 'markdown';
    const documentAvailable = runtimeCapabilityAvailable(capabilities.documentReader);
    let description = String(tool.description ?? '');
    if (!markdownAvailable) {
      description = description.replace(
        'HTML is extracted to clean markdown by default (raw:true for the full HTML).',
        'HTML returns a sanitized raw response body in this runtime; raw:true keeps the raw response path.',
      );
    }
    if (!documentAvailable) {
      const readerGuidance = 'Document files come back as binary and no document reader is available in this runtime. Ask for page images or a plain-text export.';
      description = description.replace(
        /A DOCUMENT FILE .*read_doc opens them\./,
        readerGuidance,
      );
    }
    if (markdownAvailable && documentAvailable) return tool;
    return /** @type {T} */ ({
      ...tool,
      description,
      schema: {
        ...tool.schema,
        properties: {
          ...tool.schema?.properties,
          raw: {
            ...tool.schema?.properties?.raw,
            description: markdownAvailable
              ? tool.schema?.properties?.raw?.description
              : 'Keep the sanitized raw HTML response. This runtime has no hosted Markdown extractor.',
          },
        },
      },
    });
  }
  if (tool.name === 'read_page' && capabilities.readableHtml?.mode !== 'markdown') {
    return /** @type {T} */ ({
      ...tool,
      description: [
        'Read the DOM of a tab. Returns title, URL, visible body text, and interactable',
        'elements with selectors for click and type. In this runtime, mode:content',
        'falls back to the same visible-text snapshot and does not return Markdown.',
        'Use the default snapshot when you need to operate the page.',
      ].join(' '),
      schema: {
        ...tool.schema,
        properties: {
          ...tool.schema?.properties,
          mode: {
            ...tool.schema?.properties?.mode,
            description: 'snapshot (default): visible text and interactables. content currently falls back to the same snapshot in this runtime.',
          },
          query: {
            ...tool.schema?.properties?.query,
            description: 'Used only when a hosted readable-content extractor is available. It has no effect on this runtime\'s snapshot fallback.',
          },
        },
      },
    });
  }
  return tool;
};

/**
 * Model guidance only. Dispatch must independently refuse an unavailable
 * facility because a model can forge an omitted tool name.
 * @template {{ name: string }} T
 * @param {ReadonlyArray<T>} descriptors
 * @param {ReturnType<typeof resolveRuntimeCapabilities>|null|undefined} capabilities
 * @returns {T[]}
 */
export const filterByRuntimeCapabilities = (descriptors, capabilities) =>
  descriptors
    .filter((tool) => {
      const required = runtimeCapabilityForTool(tool.name, capabilities);
      return !required || runtimeCapabilityAvailable(required.capability);
    })
    .map((tool) => adaptDescriptorToRuntime(tool, capabilities));

/**
 * @param {string} toolName
 * @param {ReturnType<typeof resolveRuntimeCapabilities>|null|undefined} capabilities
 */
export const runtimeCapabilityRefusal = (toolName, capabilities) => {
  const required = runtimeCapabilityForTool(toolName, capabilities);
  if (!required || runtimeCapabilityAvailable(required.capability)) return null;
  return Object.freeze({
    ok: false,
    error: 'runtime_capability_unavailable',
    performed: false,
    facility: required.facility,
    reasonCode: required.capability.reasonCode,
    retryable: required.capability.retryable,
    alternative: required.capability.alternativeCode,
  });
};

/**
 * Compact correction for the main prompt, whose static routing guide also
 * serves Chrome. Actor prompts derive their lore from effective descriptors.
 * @param {ReturnType<typeof resolveRuntimeCapabilities>|null|undefined} capabilities
 */
export const runtimeCapabilityPromptBlock = (capabilities) => {
  if (!capabilities || runtimeCapabilityAvailable(capabilities.sealedJobs)) return '';
  return `<runtime_capabilities version="${capabilities.version}">
Headless script execution is unavailable in this browser. Ignore static guidance about the script tool or fan-out in code. Use message_actor for delegation and a visible Notebook actor for JavaScript compute.
PDF and office-document readers may also be omitted. Use only the live tool descriptors; ask for a PDF, page images, or plain-text export when the advertised tools cannot read a file.
</runtime_capabilities>`;
};
