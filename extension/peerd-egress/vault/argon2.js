// @ts-check
// Argon2id derivation — the thin imperative wrapper over the vendored
// hash-wasm bundle (extension/vendor/argon2/, SHA-pinned by
// scripts/vendor-argon2.sh).
//
// This is the ONLY file that imports the vendor; the vault core never
// does. The service worker injects this function as the vault's
// `argon2` dep (functional core / imperative shell), which keeps
// vault.js Bun-testable with a deterministic fake and keeps the
// WASM-instantiation surface in one auditable place, beside keys.js.
//
// why the SW can run this at all: hash-wasm's per-algo bundle embeds
// the WASM binary in the JS (no .wasm fetch), runs lanes sequentially
// (no SharedArrayBuffer — peerd pins parallelism=1 anyway), and the
// manifest CSP already carries `wasm-unsafe-eval` for CheerpX/Moonshine.
// Instantiation happens lazily on the first call, not at import — SW
// boot pays only the ~29 KB parse.

import { argon2id, VENDORED } from '/vendor/argon2/argon2.js';

/**
 * Derive 32 bytes of KEK material from a passphrase under Argon2id.
 * Matches the vault's injected-`argon2` dep contract; the caller
 * (vault.js) imports the result as an AES-KW key via importRawKEK and
 * zeroes the returned buffer.
 *
 * @param {Object} args               the wrap's KDF descriptor, decoded
 * @param {string} args.passphrase
 * @param {Uint8Array} args.salt
 * @param {number} args.memKiB
 * @param {number} args.iters
 * @param {number} args.parallelism   always 1 in peerd (single-lane)
 * @returns {Promise<Uint8Array>}     exactly 32 bytes
 */
export const deriveArgon2id = ({ passphrase, salt, memKiB, iters, parallelism }) => {
  // why: VENDORED is the appended sentinel — a truncated or
  // wrongly-rebuilt vendor file fails here loudly instead of at the
  // first unlock with a confusing TypeError.
  if (VENDORED !== true) throw new Error('argon2: vendored bundle sentinel missing');
  return argon2id({
    password: passphrase,
    salt,
    parallelism,
    iterations: iters,
    memorySize: memKiB,
    hashLength: 32,          // 256-bit KEK material (AES-KW key)
    outputType: 'binary',
  });
};
