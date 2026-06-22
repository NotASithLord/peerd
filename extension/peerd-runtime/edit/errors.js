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
   */
  constructor(message, blockIndex) {
    super(message);
    this.name = 'SearchNotFoundError';
    this.code = 'search_not_found';
    this.blockIndex = blockIndex;
  }
}

export class SearchAmbiguousError extends Error {
  /**
   * @param {string} message
   * @param {number} blockIndex 0-based index of the failing block
   * @param {number} count      how many times the search text matched
   */
  constructor(message, blockIndex, count) {
    super(message);
    this.name = 'SearchAmbiguousError';
    this.code = 'search_ambiguous';
    this.blockIndex = blockIndex;
    this.count = count;
  }
}
