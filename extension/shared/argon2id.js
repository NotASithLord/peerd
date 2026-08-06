// @ts-check
// Shared Argon2id execution primitive over the vendored hash-wasm bundle.
// Vault and portable-identity policy each validate and record their own KDF
// descriptors; this file only performs a caller-approved derivation.

import { argon2id, VENDORED } from '/vendor/argon2/argon2.js';

/**
 * @param {Object} args
 * @param {string} args.passphrase
 * @param {Uint8Array} args.salt
 * @param {number} args.memKiB
 * @param {number} args.iters
 * @param {number} args.parallelism
 * @returns {Promise<Uint8Array>}
 */
export const deriveArgon2id = ({ passphrase, salt, memKiB, iters, parallelism }) => {
  if (VENDORED !== true) throw new Error('argon2: vendored bundle sentinel missing');
  return argon2id({
    password: passphrase,
    salt,
    parallelism,
    iterations: iters,
    memorySize: memKiB,
    hashLength: 32,
    outputType: 'binary',
  });
};
