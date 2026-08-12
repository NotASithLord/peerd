// @ts-check
// Vault-backed custody for the SELF-DEVICE secrets: the per-install device
// key, the shared discovery secret, and the cached certificate/roster.
//
// why a second custody handler rather than widening the identity one: the
// identity handler exists to move ONE value, the permanent person seed,
// under mutation serialization and a "never overwrite a recovered root"
// rule. The self-device secrets have the opposite shape: several named
// values, read and written routinely by the offscreen host on every start.
// Sharing a handler would mean a name parameter on the path that carries
// the root, and the first bug in that parameter is a root disclosure.
//
// So this handler serves a CLOSED allowlist and refuses the identity name
// explicitly, even though it is not on the list. That check is redundant by
// construction and kept anyway: it is the assertion that survives someone
// later adding a name to the list without thinking about which key it is.
//
// It rides the same sender-verified offscreen custody Port as the identity
// handler. The device key in particular must never travel any other way,
// and it never leaves this install at all: `distributed/device-key/` is
// under the export-excluded prefix the dweb module's device-key custody
// defines (NON_EXPORTABLE_SECRET_PREFIXES).

// The exact secret names the self-device stack owns. Growing this list is a
// deliberate act: each entry is a value the offscreen document may read.
export const SELF_CUSTODY_SECRET_NAMES = Object.freeze([
  'distributed/device-key/v1',
  'distributed/self-discovery/v1',
  'distributed/self-records/v1',
]);
const SELF_DISCOVERY_SECRET_NAME = 'distributed/self-discovery/v1';
const SELF_RECORDS_SECRET_NAME = 'distributed/self-records/v1';

/**
 * Root-mint fence for an enrollment that may have stopped between its two
 * vault writes. Either durable half means this install already belongs to
 * (or is completing membership in) an existing person.
 * @param {{ getSecret: (name: string) => Promise<string | null> }} vault
 */
export const hasEnrolledSelfCustody = async (vault) => Boolean(
  await vault.getSecret(SELF_RECORDS_SECRET_NAME)
  || await vault.getSecret(SELF_DISCOVERY_SECRET_NAME)
);

// Roster + certificate JSON for a person with many devices, with room to
// spare. A bound at all, so a corrupted host cannot grow the vault without
// limit through this path.
const MAX_SELF_SECRET_BYTES = 256 * 1024;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Store-safe did:key derivation used only to keep root/self custody coherent. */
const personDidFromRootMaterial = (stored) => {
  const material = JSON.parse(stored);
  const binary = atob(material.pub);
  if (binary.length !== 32) throw new Error('bad identity public key');
  const bytes = Uint8Array.from([0xed, 0x01, ...Array.from(binary, (char) => char.charCodeAt(0))]);
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  /** @type {number[]} */
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  return `did:key:z${'1'.repeat(zeros)}${digits.reverse().map((digit) => BASE58_ALPHABET[digit]).join('')}`;
};

/**
 * @param {Object} deps
 * @param {boolean} deps.enabled
 * @param {() => boolean} deps.active
 * @param {{ isLocked: () => boolean, getSecret: (name: string) => Promise<string | null>,
 *   setSecret: (name: string, value: string) => Promise<void> }} deps.vault
 * @param {string} deps.identitySecretName  refused outright (see the header)
 * @param {<T>(operation: () => Promise<T>) => Promise<T>} [deps.withCustodyMutation]
 */
export const makeDwebSelfCustody = ({
  enabled, active, vault, identitySecretName,
  withCustodyMutation = (operation) => operation(),
}) => {
  const available = () => enabled && active();
  let recordsWriteTail = Promise.resolve();

  /** @param {unknown} name */
  const allowed = (name) => typeof name === 'string'
    && name !== identitySecretName
    && SELF_CUSTODY_SECRET_NAMES.includes(name);

  /** @param {'self-get'|'self-set'} operation @param {any} [args] */
  const handle = async (operation, args = {}) => {
    if (!available()) return { ok: false, error: 'dweb-disabled' };
    if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
    if (!allowed(args?.name)) return { ok: false, error: 'secret-not-allowed' };

    if (operation === 'self-get') {
      try {
        return { ok: true, value: await vault.getSecret(args.name) };
      } catch (cause) {
        return { ok: false, error: /** @type {{ message?: string }} */ (cause)?.message ?? String(cause) };
      }
    }
    if (operation !== 'self-set') return { ok: false, error: 'unknown-secret-operation' };
    if (typeof args?.value !== 'string') return { ok: false, error: 'value-required' };
    if (args.value.length > MAX_SELF_SECRET_BYTES) return { ok: false, error: 'value-too-large' };
    const persist = async () => {
      if (args.name === SELF_RECORDS_SECRET_NAME) {
        let candidate;
        let previous;
        try {
          candidate = JSON.parse(args.value);
          const stored = await vault.getSecret(SELF_RECORDS_SECRET_NAME);
          previous = stored ? JSON.parse(stored) : null;
        } catch {
          return { ok: false, error: 'self-records-malformed' };
        }
        const nextRoster = candidate?.roster;
        const heldRoster = previous?.roster;
        if (!Number.isSafeInteger(nextRoster?.seq) || typeof nextRoster?.personDid !== 'string'
            || typeof nextRoster?.sig !== 'string') {
          return { ok: false, error: 'self-records-malformed' };
        }
        if (heldRoster) {
          if (nextRoster.personDid !== heldRoster.personDid || nextRoster.seq < heldRoster.seq) {
            return { ok: false, error: 'roster-rollback' };
          }
          if (nextRoster.seq === heldRoster.seq && nextRoster.sig !== heldRoster.sig) {
            return { ok: false, error: 'roster-equivocation' };
          }
        }
        const rootMaterial = await vault.getSecret(identitySecretName);
        if (rootMaterial) {
          let rootDid;
          try { rootDid = personDidFromRootMaterial(rootMaterial); }
          catch { return { ok: false, error: 'identity-material-malformed' }; }
          if (rootDid !== nextRoster.personDid) return { ok: false, error: 'identity-self-mismatch' };
        }
      }
      await vault.setSecret(args.name, args.value);
      return { ok: true };
    };
    try {
      if (args.name !== SELF_RECORDS_SECRET_NAME) return await persist();
      const operation = recordsWriteTail.then(() => withCustodyMutation(persist));
      recordsWriteTail = operation.then(() => undefined, () => undefined);
      return await operation;
    } catch (cause) {
      return { ok: false, error: /** @type {{ message?: string }} */ (cause)?.message ?? String(cause) };
    }
  };

  return { handle };
};
