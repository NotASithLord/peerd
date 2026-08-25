// @ts-check

import { isoSecondsZ } from './now.js';

export const executeNow = (/** @type {number} */ ms = Date.now()) => {
  const date = new Date(ms);
  return {
    ok: true,
    content: JSON.stringify({
      iso: isoSecondsZ(ms),
      unixMs: ms,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      dayOfWeek: date.toLocaleString('en-US', { weekday: 'long' }),
    }, null, 2),
  };
};
