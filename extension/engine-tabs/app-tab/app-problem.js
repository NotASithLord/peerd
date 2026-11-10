// @ts-check
// Plain words for why part of an App did not load or start.
// why: App code can post these messages too, so a notice shows fixed text and
// a known directive name only, never text that came from the App.

/** @typedef {{ text: string, details: string, stays?: boolean }} AppProblemNotice */

/** @type {Record<string, AppProblemNotice>} */
const PROBLEMS = {
  'missing-file': {
    text: 'This App asked for a file that it does not have, so part of it may not work. '
      + 'If it does not start, ask peerd to fix it, or import it again with all of its files.',
    details: 'The App asked for a path that is not one of its files. The load failed like a 404 Not Found.',
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
  modules: {
    text: 'This App splits its code into module files that Apps cannot load yet, so it may not work. '
      + 'Ask peerd to fix it, or get a single-file version from its maker.',
    details: 'A module import or a module Worker asked for a file by URL, and the load failed. '
      + 'App files have no URL inside the sandbox. Classic scripts and one self-contained module do load.',
    stays: true,
  },
};

const DIRECTIVES = new Set([
  'default-src', 'script-src', 'script-src-elem', 'script-src-attr', 'style-src', 'style-src-elem',
  'style-src-attr', 'img-src', 'font-src', 'media-src', 'connect-src', 'frame-src', 'worker-src',
  'child-src', 'object-src', 'manifest-src', 'form-action', 'base-uri',
]);

/**
 * @param {unknown} data - a message from the App frame
 * @returns {AppProblemNotice | null}
 */
export const appProblemNotice = (data) => {
  if (!data || typeof data !== 'object') return null;
  const { type, directive, problem } = /** @type {Record<string, unknown>} */ (data);
  if (type === 'app-policy-blocked') {
    const name = typeof directive === 'string' && DIRECTIVES.has(directive) ? directive : 'resource';
    return {
      text: 'This App tried to load something that is not one of its files. '
        + 'Apps work offline, so that part did not load.',
      details: `The App sandbox blocked the request (${name}). Put every file the App needs inside the App.`,
    };
  }
  if (type === 'app-problem' && typeof problem === 'string' && Object.hasOwn(PROBLEMS, problem)) {
    return PROBLEMS[problem];
  }
  return null;
};

// The App tab shows a notice that does not stay for this long.
const NOTICE_MS = 6000;

/**
 * The notices of one App load. A notice that stays shows one time. Each other
 * notice shows at most one time in NOTICE_MS, so a later problem still gets
 * its notice.
 * why: App code can post these messages without limit.
 * @param {() => number} [now]
 */
export const appProblemNotices = (now = Date.now) => {
  /** @type {Map<string, number>} */
  const shownAt = new Map();
  return {
    /** @param {unknown} data - a message from the App frame @returns {AppProblemNotice | null} */
    next(data) {
      const notice = appProblemNotice(data);
      const last = notice ? shownAt.get(notice.text) : undefined;
      if (!notice || (last !== undefined && (notice.stays || now() - last < NOTICE_MS))) return null;
      shownAt.set(notice.text, now());
      return notice;
    },
  };
};
