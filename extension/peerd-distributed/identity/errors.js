// @ts-check
// Typed failures for the portable-identity boundary. Callers may collapse
// credential and integrity failures into one user-facing refusal, while tests
// and internal logs retain a stable machine-readable category.

class PortableIdentityError extends Error {
  /** @param {string} message @param {string} code @param {{ cause?: unknown }} [options] */
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class IdentityCapsuleError extends PortableIdentityError {}
export class IdentityCredentialError extends PortableIdentityError {}
export class IdentityRecordError extends PortableIdentityError {}
