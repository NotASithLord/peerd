// @ts-check

import { findDenylistMatch } from '../../peerd-egress/denylist/denylist.js';

/**
 * Read only the currently committed document location. The browser serializes
 * this body for execution in the target page, so it must stay closure-free.
 * @returns {{ origin: string | null, href: string | null, timeOrigin: number | null }}
 */
export function liveDocumentLocationInjected() {
  'use strict';
  let origin = null;
  let href = null;
  let timeOrigin = null;
  try { origin = location.origin; } catch (e) { origin = null; }
  try { href = location.href; } catch (e) { href = null; }
  try { timeOrigin = Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : null; } catch (e) { timeOrigin = null; }
  return { origin, href, timeOrigin };
}

/** @param {string | undefined} url @param {readonly string[] | undefined} denylist */
export const isDenylistedTab = (url, denylist) => {
  let hostname = '';
  try { hostname = new URL(/** @type {string} */ (url)).hostname; } catch { return false; }
  return !!hostname && !!findDenylistMatch(hostname, denylist ?? []);
};
