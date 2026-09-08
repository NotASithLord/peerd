// @ts-check
// Browser-neutral identity of one authority-kernel generation. This is the
// only module allowed to mint bootId/kernelEpoch as a pair; every downstream
// adapter receives and validates the resulting immutable value.

export const KERNEL_IDENTITY_SCHEMA = 1;

/** @typedef {{schema:1,buildId:string,bootId:string,kernelEpoch:string}} KernelIdentity */

/** @param {unknown} value @param {number} [max] */
const safeId = (value, max = 256) => typeof value === 'string'
  && value.length >= 8 && value.length <= max
  && !/[\u0000-\u001f\u007f]/.test(value);

/** @param {unknown} value */
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} value @returns {Readonly<KernelIdentity>|null} */
export const parseKernelIdentity = (value) => {
  if (!record(value)) return null;
  const input = /** @type {Record<string, unknown>} */ (value);
  if (Object.keys(input).length !== 4
      || input.schema !== KERNEL_IDENTITY_SCHEMA
      || !safeId(input.buildId)
      || !safeId(input.bootId, 128)
      || !safeId(input.kernelEpoch, 128)
      || input.bootId === input.kernelEpoch) return null;
  return Object.freeze({
    schema: KERNEL_IDENTITY_SCHEMA,
    buildId: /** @type {string} */ (input.buildId),
    bootId: /** @type {string} */ (input.bootId),
    kernelEpoch: /** @type {string} */ (input.kernelEpoch),
  });
};

/**
 * Read the four identity fields from a larger authenticated envelope. The
 * identity parser itself remains exact; callers cannot smuggle extra identity
 * state into the canonical value.
 * @param {unknown} value
 * @returns {Readonly<KernelIdentity>|null}
 */
export const kernelIdentityFromEnvelope = (value) => {
  if (!record(value)) return null;
  const input = /** @type {Record<string, unknown>} */ (value);
  return parseKernelIdentity({
    schema: input.schema,
    buildId: input.buildId,
    bootId: input.bootId,
    kernelEpoch: input.kernelEpoch,
  });
};

/** @param {unknown} expected @param {unknown} value */
export const kernelIdentityMatches = (expected, value) => {
  const left = kernelIdentityFromEnvelope(expected);
  const right = kernelIdentityFromEnvelope(value);
  return !!left && !!right
    && left.schema === right.schema
    && left.buildId === right.buildId
    && left.bootId === right.bootId
    && left.kernelEpoch === right.kernelEpoch;
};

/**
 * Adoption is permitted only from another boot of the exact same packaged
 * build. Reusing either generation token is a stale/independently-minted
 * identity, never a successor.
 * @param {unknown} prior
 * @param {unknown} next
 */
export const kernelIdentityIsSuccessor = (prior, next) => {
  const left = kernelIdentityFromEnvelope(prior);
  const right = kernelIdentityFromEnvelope(next);
  return !!left && !!right
    && left.buildId === right.buildId
    && left.bootId !== right.bootId
    && left.kernelEpoch !== right.kernelEpoch;
};

/**
 * @param {Object} deps
 * @param {string} deps.buildId
 * @param {() => string} [deps.newId]
 * @returns {Readonly<KernelIdentity>}
 */
export const createKernelIdentity = ({
  buildId,
  newId = () => crypto.randomUUID(),
}) => {
  const identity = parseKernelIdentity({
    schema: KERNEL_IDENTITY_SCHEMA,
    buildId,
    bootId: newId(),
    kernelEpoch: newId(),
  });
  if (!identity) throw new TypeError('kernel-identity-invalid');
  return identity;
};

/**
 * Forged identity fields on an envelope are overwritten, never merged.
 * @template {Record<string, unknown>} T
 * @param {unknown} identity
 * @param {T} payload
 * @returns {Readonly<T & KernelIdentity>}
 */
export const bindKernelIdentity = (identity, payload) => {
  const parsed = parseKernelIdentity(identity);
  if (!parsed) throw new TypeError('kernel-identity-invalid');
  const { schema: _schema, buildId: _buildId, bootId: _bootId,
    kernelEpoch: _kernelEpoch, ...rest } = payload;
  return /** @type {Readonly<T & KernelIdentity>} */ (
    Object.freeze({ ...rest, ...parsed })
  );
};
