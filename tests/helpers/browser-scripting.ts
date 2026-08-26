import { liveDocumentLocationInjected } from '../../extension/peerd-runtime/browser-authority/dom-helpers.js';
import { hasPasswordFieldInjected } from '../../extension/peerd-runtime/dom/walk-injected.js';

export const TEST_DOCUMENT_ID = 'test-public-document';
export const TEST_TIME_ORIGIN = 1_700_000_000_000;

/**
 * Return the two exact-document probe responses used by resolveTargetTab.
 * A null result means the request is the tool injection owned by the caller.
 */
export const browserProbeResult = (
  request: any,
  { url, hasPassword = false, documentId = TEST_DOCUMENT_ID }: {
    url: string;
    hasPassword?: boolean;
    documentId?: string;
  },
) => {
  const name = request?.func?.name;
  if (request?.func === liveDocumentLocationInjected || name === 'liveDocumentLocationInjected') {
    const parsed = new URL(url);
    return [{
      documentId,
      result: { origin: parsed.origin, href: parsed.href, timeOrigin: TEST_TIME_ORIGIN },
    }];
  }
  if (request?.func === hasPasswordFieldInjected || name === 'hasPasswordFieldInjected') {
    return [{
      documentId,
      result: { has: hasPassword, capped: false },
    }];
  }
  return null;
};
