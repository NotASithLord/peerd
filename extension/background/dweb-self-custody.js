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
// under the export-excluded prefix (peerd-distributed/identity/device-key.js).

// The exact secret names the self-device stack owns. Growing this list is a
// deliberate act: each entry is a value the offscreen document may read.
export const SELF_CUSTODY_SECRET_NAMES = Object.freeze([
  'distributed/device-key/v1',
  'distributed/self-discovery/v1',
  'distributed/self-records/v1',
]);

// Roster + certificate JSON for a person with many devices, with room to
// spare. A bound at all, so a corrupted host cannot grow the vault without
// limit through this path.
const MAX_SELF_SECRET_BYTES = 256 * 1024;

/**
 * @param {Object} deps
 * @param {boolean} deps.enabled
 * @param {() => boolean} deps.active
 * @param {{ isLocked: () => boolean, getSecret: (name: string) => Promise<string | null>,
 *   setSecret: (name: string, value: string) => Promise<void> }} deps.vault
 * @param {string} deps.identitySecretName  refused outright (see the header)
 */
export const makeDwebSelfCustody = ({ enabled, active, vault, identitySecretName }) => {
  const available = () => enabled && active();

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
    try {
      await vault.setSecret(args.name, args.value);
      return { ok: true };
    } catch (cause) {
      return { ok: false, error: /** @type {{ message?: string }} */ (cause)?.message ?? String(cause) };
    }
  };

  return { handle };
};
