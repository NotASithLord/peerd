// @ts-check
// App-local durable data adapter.
//
// The sandbox sees semantic JSON operations. The trusted App parent resolves
// those operations to its own pinned OPFS root and reuses the existing,
// repository-coordinated editor mutation routes. Keeping this adapter beside
// the App tab means adding an App-native API does not add controllers to the
// MV3 service worker's cold graph.

export const MAX_APP_DATA_BYTES = 1_000_000;

/** @param {unknown} key */
const dataPath = (key) => typeof key === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(key)
  ? `data/${key}.json`
  : null;

/** @param {unknown} value */
const byteLength = (value) => new TextEncoder().encode(String(value)).byteLength;

/**
 * @param {{
 *   appId:string,
 *   opfs:{read:(path:string)=>Promise<string>,list:()=>Promise<Array<{path:string}>>},
 *   send:(message:Record<string,unknown>)=>Promise<any>,
 * }} deps
 */
export const createAppDataClient = ({ appId, opfs, send }) => ({
  /** @param {'get'|'set'|'delete'|'list'} op @param {unknown} [key] @param {unknown} [json] */
  async request(op, key, json) {
    const path = op === 'list' ? null : dataPath(key);
    if (op !== 'list' && !path) return { ok: false, error: 'invalid App data key' };
    try {
      if (op === 'get') {
        let text;
        try { text = await opfs.read(/** @type {string} */ (path)); }
        catch (error) {
          if ((/** @type {{name?:string}} */ (error))?.name === 'NotFoundError') {
            return { ok: true, value: null };
          }
          throw error;
        }
        if (byteLength(text) > MAX_APP_DATA_BYTES) return { ok: false, error: 'App data value is too large' };
        return { ok: true, value: JSON.parse(text) };
      }
      if (op === 'list') {
        const keys = (await opfs.list())
          .map((file) => file.path.replace(/^\/+/, '').match(/^data\/([a-z0-9][a-z0-9._-]{0,63})\.json$/i)?.[1])
          .filter((/** @type {string|undefined} */ item) => typeof item === 'string')
          .sort();
        return { ok: true, value: keys };
      }
      if (op === 'set') {
        if (typeof json !== 'string' || byteLength(json) > MAX_APP_DATA_BYTES) {
          return { ok: false, error: 'App data value is too large' };
        }
        JSON.parse(json);
        const reply = await send({
          type: 'app/editor-write', appId, path, content: json, runtimeData: true,
        });
        return reply?.ok ? { ok: true, value: true } : { ok: false, error: reply?.error ?? 'App data write failed' };
      }
      if (op === 'delete') {
        // Delete is idempotent at the semantic API. Avoid sending a mutation
        // for a key which is already absent; a concurrent removal is accepted
        // by the worker route below as well.
        const exists = (await opfs.list()).some((file) => file.path.replace(/^\/+/, '') === path);
        if (!exists) return { ok: true, value: true };
        const reply = await send({ type: 'app/editor-delete', appId, path, runtimeData: true });
        return reply?.ok ? { ok: true, value: true } : { ok: false, error: reply?.error ?? 'App data delete failed' };
      }
      return { ok: false, error: 'unsupported App data operation' };
    } catch (error) {
      return { ok: false, error: /** @type {{message?:string}} */ (error)?.message ?? String(error) };
    }
  },
});
