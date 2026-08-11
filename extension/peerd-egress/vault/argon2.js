// @ts-check
// Argon2id derivation — the vault-facing public-module seam over the shared
// vendored primitive. Policy/descriptor validation remains in vault/kdf.js.
//
// The vault core never imports the vendor. The service worker injects this function as the vault's
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

export { deriveArgon2id } from '/shared/argon2id.js';
