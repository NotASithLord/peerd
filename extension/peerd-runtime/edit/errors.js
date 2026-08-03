// @ts-check
// Edit-subsystem error subclasses.
//
// why: peerd convention is named error subclasses, not bare Error with a
// message string. The applier distinguishes three failure modes the
// agent must react to differently — a malformed block (the model wrote
// bad syntax), a search miss (the file moved out from under it), and an
// ambiguous match (the search text isn't a unique anchor). Each maps to
// a different repair: rewrite the block, re-read the file, or widen the
// search context. Naming them lets the tool layer surface a stable
// `error` code instead of a brittle substring check.

export class EditParseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'EditParseError';
    this.code = 'edit_parse_error';
  }
}

export class SearchNotFoundError extends Error {
  /**
   * @param {string} message
   * @param {number} blockIndex 0-based index of the failing block
   * @param {{ whitespace?: boolean, line?: number | null }} [opts]
   */
  constructor(message, blockIndex, opts = {}) {
    super(message);
    this.name = 'SearchNotFoundError';
    this.code = 'search_not_found';
    this.blockIndex = blockIndex;
    // why: a whitespace/indent-only mismatch is the single most common real
    // cause of a miss. Flag it (and the line it matched at) so the tool layer
    // can surface a precise diagnosis instead of the misleading "the file may
    // have changed" — still a hard error, never a fuzzy apply.
    this.whitespace = opts.whitespace ?? false;
    /** @type {number | null} */
    this.line = opts.line ?? null;
  }
}

/**
 * One occurrence of an ambiguous SEARCH: where it is and a peek at the context.
 * @typedef {{ line: number, preview: string }} MatchLocation
 */

export class SearchAmbiguousError extends Error {
  /**
   * @param {string} message
   * @param {number} blockIndex 0-based index of the failing block
   * @param {number} count      how many times the search text matched
   * @param {MatchLocation[]} [locations] where the matches are (capped)
   */
  constructor(message, blockIndex, count, locations = []) {
    super(message);
    this.name = 'SearchAmbiguousError';
    this.code = 'search_ambiguous';
    this.blockIndex = blockIndex;
    this.count = count;
    // why: reporting WHERE the matches are lets the agent widen the anchor
    // without re-reading the whole file to hunt for them (3c).
    this.locations = locations;
  }
}
