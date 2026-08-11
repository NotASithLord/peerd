// @ts-check
// Shared exact-document scripting replies for the in-browser tool tests.

export const TEST_DOCUMENT_ID = 'test-public-document';
export const TEST_TIME_ORIGIN = 1_700_000_000_000;

/**
 * Return resolveTargetTab's two browser-issued probe responses. Null means the
 * request belongs to the tool under test and its fixture should answer it.
 *
 * @param {any} request
 * @param {{ url: string, hasPassword?: boolean, documentId?: string, timeOrigin?: number }} options
 */
export const browserProbeResult = (request, {
  url,
  hasPassword = false,
  documentId = TEST_DOCUMENT_ID,
  timeOrigin = TEST_TIME_ORIGIN,
}) => {
  const name = request?.func?.name;
  if (name === 'liveDocumentLocationInjected') {
    const parsed = new URL(url);
    return [{
      documentId,
      result: { origin: parsed.origin, href: parsed.href, timeOrigin },
    }];
  }
  if (name === 'hasPasswordFieldInjected') {
    return [{
      documentId,
      result: { has: hasPassword, capped: false },
    }];
  }
  return null;
};
