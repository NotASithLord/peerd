// @ts-check
// Pure fail-closed provenance predicates for privileged extension RPC/Ports.
// Exact ownership rationale and the sender matrix live in
// docs/THIN-KERNEL-ARCHITECTURE.md; keep executable rules and JSDoc here small
// because this module is on the native cold path.

/**
 * Is this onMessage sender a trusted first-party extension context?
 *
 * Requires the exact runtime id and injected packaged origin. The trailing
 * slash from runtime.getURL('') makes the prefix Chrome/Firefox-safe.
 * @param {{ id?: string, url?: string, tab?: unknown } | null | undefined} sender
 * @param {{ runtimeId?: string, extensionOrigin?: string }} [trust]
 * @returns {boolean}
 */
export const isFirstPartySender = (sender, { runtimeId, extensionOrigin } = {}) => {
  if (!sender || typeof sender !== 'object') return false;
  if (!runtimeId || sender.id !== runtimeId) return false;
  if (typeof extensionOrigin !== 'string' || extensionOrigin.length === 0) return false;
  if (typeof sender.url !== 'string') return false;
  return sender.url.startsWith(extensionOrigin);
};

/**
 * Is this sender specifically the OFFSCREEN DOCUMENT?
 *
 * Exact URL, no tab; first-party alone is too broad for capability relays.
 * @param {{ id?: string, url?: string, tab?: unknown } | null | undefined} sender
 * @param {{ runtimeId?: string, extensionOrigin?: string, offscreenUrl?: string }} [trust]
 * @returns {boolean}
 */
export const isOffscreenSender = (sender, { runtimeId, extensionOrigin, offscreenUrl } = {}) => {
  if (!isFirstPartySender(sender, { runtimeId, extensionOrigin })) return false;
  if (typeof offscreenUrl !== 'string' || offscreenUrl.length === 0) return false;
  if (sender && typeof sender === 'object' && 'tab' in sender) return false;
  return sender?.url === offscreenUrl;
};

/**
 * Is this sender specifically the browser-owned BACKGROUND HOST?
 *
 * Chrome accepts the exact worker script without tab/document provenance;
 * Firefox accepts its exact generated background document without a tab.
 * @param {{ id?: string, url?: string, tab?: unknown, documentId?: string } | null | undefined} sender
 * @param {{ runtimeId?: string, extensionOrigin?: string, serviceWorkerUrl?: string, backgroundPageUrl?: string }} [trust]
 */
export const isServiceWorkerSender = (sender, {
  runtimeId, extensionOrigin, serviceWorkerUrl, backgroundPageUrl,
} = {}) => {
  if (!isFirstPartySender(sender, { runtimeId, extensionOrigin })) return false;
  if (typeof serviceWorkerUrl !== 'string' || serviceWorkerUrl.length === 0) return false;
  if (typeof backgroundPageUrl !== 'string' || backgroundPageUrl.length === 0) return false;
  if (sender && typeof sender === 'object' && 'tab' in sender) return false;
  if (sender?.url === backgroundPageUrl) return true;
  return sender?.url === serviceWorkerUrl
    && !(sender && typeof sender === 'object' && 'documentId' in sender);
};

/**
 * Is this sender the full-tab options page that owns backup and restore?
 * Hash routes are part of the trusted page URL. Queries and sibling paths are
 * not, and open_in_tab means legitimate callers carry tab provenance.
 * @param {{ id?: string, url?: string, tab?: { id?: number } } | null | undefined} sender
 * @param {{ runtimeId?: string, extensionOrigin?: string, optionsUrl?: string }} [trust]
 */
export const isOptionsSender = (sender, { runtimeId, extensionOrigin, optionsUrl } = {}) => {
  if (!isFirstPartySender(sender, { runtimeId, extensionOrigin })) return false;
  if (typeof optionsUrl !== 'string' || optionsUrl.length === 0) return false;
  if (typeof sender?.tab?.id !== 'number') return false;
  const url = /** @type {string} */ (sender.url);
  const hashAt = url.indexOf('#');
  const documentUrl = hashAt === -1 ? url : url.slice(0, hashAt);
  return !documentUrl.includes('?') && documentUrl === optionsUrl;
};

/**
 * Exact browser-owned sidepanel/sidebar document for human actions.
 * @param {{ id?: string, url?: string, tab?: unknown } | null | undefined} sender
 * @param {{ runtimeId?: string, extensionOrigin?: string, sidepanelUrl?: string }} [trust]
 */
export const isSidepanelSender = (sender, { runtimeId, extensionOrigin, sidepanelUrl } = {}) => {
  if (!isFirstPartySender(sender, { runtimeId, extensionOrigin })) return false;
  if (typeof sidepanelUrl !== 'string' || sidepanelUrl.length === 0) return false;
  if (sender && typeof sender === 'object' && 'tab' in sender) return false;
  return sender?.url === sidepanelUrl;
};

/**
 * Is this sender the side-panel document that may subscribe to live UI state?
 *
 * Sidepanel Port: hash and browser-owned tab provenance are allowed; query and
 * sibling paths are not.
 * @param {{ id?: string, url?: string, tab?: unknown } | null | undefined} sender
 * @param {{ runtimeId?: string, extensionOrigin?: string, sidepanelUrl?: string }} [trust]
 */
export const isSidepanelPortSender = (sender, {
  runtimeId, extensionOrigin, sidepanelUrl,
} = {}) => {
  if (!isFirstPartySender(sender, { runtimeId, extensionOrigin })) return false;
  if (typeof sidepanelUrl !== 'string' || sidepanelUrl.length === 0) return false;
  const url = /** @type {string} */ (sender?.url);
  const hashAt = url.indexOf('#');
  const documentUrl = hashAt === -1 ? url : url.slice(0, hashAt);
  return !documentUrl.includes('?') && documentUrl === sidepanelUrl;
};

/**
 * Exact tab-hosted Home SPA; hash deep links are allowed, queries are not.
 * @param {{ id?: string, url?: string, tab?: { id?: number } } | null | undefined} sender
 * @param {{ runtimeId?: string, extensionOrigin?: string, homeUrl?: string }} [trust]
 */
export const isHomeSender = (sender, { runtimeId, extensionOrigin, homeUrl } = {}) => {
  if (!isFirstPartySender(sender, { runtimeId, extensionOrigin })) return false;
  if (typeof homeUrl !== 'string' || homeUrl.length === 0) return false;
  if (typeof sender?.tab?.id !== 'number') return false;
  const url = /** @type {string} */ (sender.url);
  const hashAt = url.indexOf('#');
  const documentUrl = hashAt === -1 ? url : url.slice(0, hashAt);
  return !documentUrl.includes('?') && documentUrl === homeUrl;
};

/**
 * Exact tab-hosted Home or evaluation runner allowed to open an eval stream.
 * @param {{ id?: string, url?: string, tab?: { id?: number } } | null | undefined} sender
 * @param {{ runtimeId?: string, extensionOrigin?: string, homeUrl?: string, evalRunnerUrl?: string }} [trust]
 */
export const isEvalSender = (sender, {
  runtimeId, extensionOrigin, homeUrl, evalRunnerUrl,
} = {}) => {
  if (!isFirstPartySender(sender, { runtimeId, extensionOrigin })) return false;
  if (typeof homeUrl !== 'string' || homeUrl.length === 0) return false;
  if (typeof evalRunnerUrl !== 'string' || evalRunnerUrl.length === 0) return false;
  if (typeof sender?.tab?.id !== 'number') return false;
  const url = /** @type {string} */ (sender.url);
  const hashAt = url.indexOf('#');
  const documentUrl = hashAt === -1 ? url : url.slice(0, hashAt);
  return !documentUrl.includes('?')
    && (documentUrl === homeUrl || documentUrl === evalRunnerUrl);
};
