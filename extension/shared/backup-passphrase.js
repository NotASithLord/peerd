// @ts-check
// One memory-hard policy for every new passphrase-protected backup section.
//
// why shared: the generic credential box ships in every channel while the peer
// identity wrapper ships only in preview. If either chooses a cheaper KDF, a
// backup containing both gives an attacker that cheaper passphrase oracle.

import { deriveArgon2id } from './argon2id.js';

export const BACKUP_ARGON2ID_PARAMS = Object.freeze({
  name: 'Argon2id',
  memKiB: 64 * 1024,
  iters: 3,
  parallelism: 1,
});
export const BACKUP_ARGON2ID_SALT_BYTES = 16;

/**
 * @param {string} passphrase
 * @param {Uint8Array} salt
 * @returns {Promise<Uint8Array>}
 */
export const deriveBackupPassphraseBytes = async (passphrase, salt) => {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new TypeError('backup passphrase required');
  }
  if (!(salt instanceof Uint8Array) || salt.byteLength !== BACKUP_ARGON2ID_SALT_BYTES) {
    throw new TypeError(`backup salt must be ${BACKUP_ARGON2ID_SALT_BYTES} bytes`);
  }
  return deriveArgon2id({
    passphrase,
    salt,
    memKiB: BACKUP_ARGON2ID_PARAMS.memKiB,
    iters: BACKUP_ARGON2ID_PARAMS.iters,
    parallelism: BACKUP_ARGON2ID_PARAMS.parallelism,
  });
};
