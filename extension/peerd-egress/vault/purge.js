// @ts-check
// Kernel-owned rollback for a failed passkey-first initialization. This module
// deliberately has no edge to vault crypto or key state.

const VAULT_KEY = 'vault.v1';
const VAULT_STORE = 'vault';

/**
 * @param {{
 *   kv: {delete:(key:string)=>Promise<void>},
 *   idb?: {del:(store:string,key:IDBValidKey)=>Promise<void>},
 * }} deps
 */
export const purgeVaultBlob = async ({ kv, idb }) => {
  await kv.delete(VAULT_KEY).catch(() => {});
  if (idb) await idb.del(VAULT_STORE, VAULT_KEY).catch(() => {});
};
