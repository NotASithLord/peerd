// @ts-check
// why: an interrupted mirror can recover only from a complete, journaled image.
// Unknown or torn images must not replace the last preserved user draft.
/** @param {string|null} saved @param {string} current */
export const recoverMirrorState = (saved, current) => {
  if (saved === null) return null;
  const marker = JSON.parse(saved);
  if (!marker || typeof marker !== 'object') throw new DOMException('aborted', 'AbortError');
  if (!marker.pending && typeof marker.code === 'string') return marker;
  if (marker.pending === true && typeof marker.code === 'string'
      && typeof marker.originalCode === 'string'
      && (marker.previousCode === null || typeof marker.previousCode === 'string')) {
    if (current === marker.code) return { code: marker.code };
    if (current === marker.originalCode) return marker.previousCode === null ? null : { code: marker.previousCode };
  }
  throw new DOMException('aborted', 'AbortError');
};
