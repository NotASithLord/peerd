// @ts-check
// why: a bundle's consent identity includes executable interpretation, not
// just file bytes. Runtime JSON state is deliberately outside that identity.
export const APP_DATA_PATH_RE = /^data\/[a-z0-9][a-z0-9._-]{0,63}\.json$/i;
/** @param {unknown} value */
const releaseKindRows = (value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.entries(value).filter(([path]) => !APP_DATA_PATH_RE.test(path))
    .map(([path, kind]) => `${path}\0${kind}`).sort()
  : null;
/** @param {any} record */
export const appReleaseDescriptorMatches = (record) => {
  const expected = releaseKindRows(record?.dweb?.release_file_kinds);
  const current = releaseKindRows(record?.fileKinds ?? {});
  return typeof record?.dweb?.release_entry_file === 'string'
    && record.entryFile === record.dweb.release_entry_file
    && expected !== null && current !== null
    && expected.length === current.length
    && expected.every((row, index) => row === current[index]);
};
