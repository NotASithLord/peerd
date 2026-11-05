// @ts-check
// Plain words for why part of an App did not load or start.
// why: App code can post these messages too, so a notice shows fixed text and
// a cleaned directive name only, never text that came from the App.

/** @typedef {{ text: string, details: string }} AppProblemNotice */

/** @type {Record<string, AppProblemNotice>} */
const PROBLEMS = {
  'missing-file': {
    text: 'This App asked for a file that it does not have, so part of it may not work. '
      + 'If it does not start, import it again with all of its files.',
    details: 'A request for an App file got 404 Not Found.',
  },
  feature: {
    text: 'This App tried to use a browser feature that Apps do not allow, such as saving in the browser. '
      + 'Part of it may not work.',
    details: 'The browser refused the request with a SecurityError. Apps run without a web origin of their own, '
      + 'so browser storage, cookies and shared workers are not available.',
  },
  threads: {
    text: 'This App needs threads, a browser feature that Apps do not have yet. '
      + 'Ask its maker for a version without threads.',
    details: 'SharedArrayBuffer is not available, because the App is not cross-origin isolated.',
  },
};

/**
 * @param {unknown} data - a message from the App frame
 * @returns {AppProblemNotice | null}
 */
export const appProblemNotice = (data) => {
  if (!data || typeof data !== 'object') return null;
  const { type, directive, problem } = /** @type {Record<string, unknown>} */ (data);
  if (type === 'app-policy-blocked') {
    const name = typeof directive === 'string' ? directive.replace(/[^a-z-]/gi, '').slice(0, 40) : '';
    return {
      text: 'This App tried to load something that is not one of its files. '
        + 'Apps work offline, so that part did not load.',
      details: `The App sandbox blocked the request (${name || 'resource'}). Put every file the App needs inside the App.`,
    };
  }
  if (type === 'app-problem' && typeof problem === 'string' && Object.hasOwn(PROBLEMS, problem)) {
    return PROBLEMS[problem];
  }
  return null;
};
