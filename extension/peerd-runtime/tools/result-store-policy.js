// @ts-check

// A spilled result is a paging convenience, not an archive.
export const MAX_SPILL_TEXT_CHARS = 2_000_000;

// why: the storage owner needs the same entry cap as semantic spill callers,
// without importing their text windowing and query-excerpt implementation.
export const SPILL_CACHE_MAX_ENTRIES = 40;
