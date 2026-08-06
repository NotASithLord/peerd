# Recovery record and manual transfer

Status: implemented for preview backup files.

The recovery record contains an advertised did, an encrypted capsule, credential
wrappers, and version metadata. It can be carried as ciphertext, but it is still
sensitive: anyone who steals it can guess the backup passphrase offline against
a permanent signing root. Use a long, unique passphrase and protect the file as
carefully as an account recovery code. Its did and wrapper metadata are not
private.

On export, the existing peerd backup passphrase creates the identity wrapper.
Every new passphrase-protected section uses the same fixed Argon2id policy, so
the credentials section cannot become a cheaper password oracle for the
permanent identity. Older PBKDF2 credential boxes remain import-only for
backup compatibility. New files use the current export version so older builds
reject them clearly instead of misreporting a correct password as wrong.
Raw identity and device-key vault entries are excluded before any generic-secret
decryption or payload shaping. If an existing identity cannot be protected, the
whole export fails instead of silently producing an incomplete backup.

On import, password decryption and the identity decision happen before any
write. The record is accepted only when the recovered seed/public-key pair
proves itself and derives the advertised did. A record for the same did must
still authenticate. A different did stops the import and asks the user to keep
the local identity or explicitly replace it. Adoption is then the final import
commit, after every ordinary settings/data write has succeeded.

Replacement is refused while locally authored apps are shared because their
publisher and content identifiers are derived from the current did. Unshare
them first; this release does not pretend to migrate identity-bound app state.

Chrome hosts record crypto in the existing offscreen dweb page. Raw identity
material and the passphrase travel only over dedicated ports accepted from the
exact options page and exact offscreen document, never over extension-wide
broadcast messaging. A static test keeps the service worker as the only shipped
runtime connection receiver because Chrome ports can otherwise have multiple
receivers.
Firefox, which has no offscreen API, loads the preview dweb client in its
background context. Both paths use the same crypto core and serialized vault
mutation lane.

The record is not persisted as a second local identity store. It is constructed
for export and consumed during import; the existing vault secret remains the
single local source of truth.
