// @ts-check
// The host binds the verified index and origin. Request data cannot select them.

const MAX_RESPONSE_BYTES = 50_000_000;
const MIME = Object.freeze({
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json', wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8', svg: 'image/svg+xml', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', ogg: 'audio/ogg',
  opus: 'audio/opus', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
});
/** @typedef {{prefix:string,targetPrefix:string,blockSize?:number,query:{offset?:string,length?:string,block?:string,count?:string,size?:string,modified?:string}}} AppHttpRoute */
/** @typedef {{entry:string,files:Array<{path:string,size:number}>,httpRoutes?:unknown}} AppHttpIndex */
/** @typedef {{status:number,path:string|null,offset:number,length:number,head:boolean,headers:Array<{name:string,value:string}>}} AppHttpResponse */

/** @param {string} path */
const pathValid = path => path.length > 0 && path.length <= 512 && path === path.normalize('NFC')
  && !/[\\\x00-\x1f\x7f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');

/** Validate data-only routes from the signed App descriptor, never game messages. @param {unknown} value @returns {AppHttpRoute[]} */
export const validateAppHttpRoutes = value => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error('App HTTP routes invalid');
  /** @type {AppHttpRoute[]} */ const routes = [];
  for (const input of value) {
    const route = /** @type {AppHttpRoute} */ (input);
    if (!route || typeof route !== 'object' || Array.isArray(route)
      || Object.keys(route).some(key => !['prefix', 'targetPrefix', 'blockSize', 'query'].includes(key))
      || typeof route.prefix !== 'string' || !route.prefix.endsWith('/') || !pathValid(route.prefix.slice(0, -1))
      || typeof route.targetPrefix !== 'string' || (route.targetPrefix !== ''
        && (!route.targetPrefix.endsWith('/') || !pathValid(route.targetPrefix.slice(0, -1))))
      || !route.query || typeof route.query !== 'object' || Array.isArray(route.query)) throw new Error('App HTTP route invalid');
    const keys = Object.keys(route.query), aliases = Object.values(route.query);
    if (keys.some(key => !['offset', 'length', 'block', 'count', 'size', 'modified'].includes(key))
      || aliases.some(alias => typeof alias !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/i.test(alias))
      || new Set(aliases).size !== aliases.length
      || !!route.query.offset !== !!route.query.length || !!route.query.block !== !!route.query.count
      || (!route.query.offset && !route.query.block)
      || (route.query.block ? !Number.isSafeInteger(route.blockSize) || /** @type {number} */ (route.blockSize) <= 0
        || /** @type {number} */ (route.blockSize) > MAX_RESPONSE_BYTES : route.blockSize !== undefined)
      || routes.some(other => route.prefix.startsWith(other.prefix) || other.prefix.startsWith(route.prefix))) throw new Error('App HTTP route aliases invalid');
    routes.push({ ...route, query: { ...route.query } });
  }
  return routes;
};

/**
 * Resolve only a file in the host-bound index. The caller must skip disk reads for HEAD.
 * @param {{url:string,origin:string,index:AppHttpIndex,method?:string,range?:string|null,maxResponseBytes?:number}} request
 * @returns {AppHttpResponse}
 */
export const parseAppRequest = ({ url, origin, index, method = 'GET', range = null, maxResponseBytes = MAX_RESPONSE_BYTES }) => {
  const head = method === 'HEAD';
  /** @param {number} status @param {Record<string,string>} [extra] @returns {AppHttpResponse} */
  const refusal = (status, extra = {}) => ({ status, path: null, offset: 0, length: 0, head,
    headers: Object.entries({ 'Content-Length': '0', 'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', ...extra })
      .map(([name, value]) => ({ name, value })) });
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > MAX_RESPONSE_BYTES
    || typeof url !== 'string' || url.length > 16_384 || /[\\\x00-\x20\x7f]/.test(url)) return refusal(400);
  /** @type {URL} */ let parsed;
  /** @type {AppHttpRoute[]} */ let routes;
  /** @type {string} */ let path;
  try {
    parsed = new URL(url);
    if (new URL(origin).origin !== origin || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) return refusal(400);
    if (parsed.origin !== origin) return refusal(403);
    // why: URL parsing removes dot segments before pathname is exposed.
    const raw = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+([^?#]*)/i.exec(url)?.[1] || '/';
    if (/%(?:2f|5c)/i.test(raw)) return refusal(400);
    path = raw === '/' ? index.entry : decodeURIComponent(raw.slice(1));
    if (!pathValid(path)) return refusal(400);
    routes = validateAppHttpRoutes(index.httpRoutes);
  } catch { return refusal(400); }
  if (method !== 'GET' && !head) return refusal(405, { Allow: 'GET, HEAD' });
  const route = routes.find(item => path.startsWith(item.prefix));
  if (route) path = route.targetPrefix + path.slice(route.prefix.length);
  if (!pathValid(path) || !Array.isArray(index.files)) return refusal(400);
  const file = index.files.find(item => item.path === path);
  if (!file) return refusal(404);
  if (!Number.isSafeInteger(file.size) || file.size < 0) return refusal(400);
  const unsatisfied = () => refusal(416, { 'Content-Range': `bytes */${file.size}`, 'Accept-Ranges': 'bytes' });
  let offset = 0, length = file.size, status = 200;
  if (route) {
    const query = parsed.searchParams;
    /** @param {string|undefined} alias */
    const number = alias => {
      if (!alias || !query.has(alias)) return null;
      const text = query.get(alias);
      if (query.getAll(alias).length !== 1 || !/^\d+$/.test(text ?? '')) throw new Error('App read query invalid');
      const value = Number(text);
      if (!Number.isSafeInteger(value)) throw new Error('App read query too large');
      return value;
    };
    try {
      const start = number(route.query.offset), bytes = number(route.query.length);
      const block = number(route.query.block), count = number(route.query.count), size = number(route.query.size);
      if (size !== null && size !== file.size) return refusal(409);
      if ((start === null) !== (bytes === null) || (block === null) !== (count === null)
        || (start === null) === (block === null) || (!head && range !== null)) return refusal(400);
      offset = start ?? /** @type {number} */ (block) * /** @type {number} */ (route.blockSize);
      length = bytes ?? /** @type {number} */ (count) * /** @type {number} */ (route.blockSize);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length <= 0) return refusal(400);
      if (offset >= file.size) return unsatisfied();
      length = Math.min(length, file.size - offset); status = 206;
    } catch { return refusal(400); }
  } else if (!head && range !== null && file.size !== 0) {
    if (typeof range !== 'string' || range.length > 256 || /[\r\n\0]/.test(range)) return unsatisfied();
    const text = range.trim(), match = /^bytes=(\d*)-(\d*)$/i.exec(text);
    // Unknown range units do not change the selected representation.
    if (!match && !/^(?!bytes=)[!#$%&'*+.^_`|~a-z0-9-]+=/i.test(text)) return unsatisfied();
    if (match) {
      if (!match[1] && !match[2]) return unsatisfied();
      const size = BigInt(file.size), first = BigInt(match[1] || '0'), last = BigInt(match[2] || '0');
      if (match[1]) {
        if (first >= size || (match[2] && last < first)) return unsatisfied();
        offset = Number(first); length = Number((match[2] && last < size ? last : size - 1n) - first + 1n);
      } else {
        if (last === 0n) return unsatisfied();
        length = Number(last < size ? last : size); offset = file.size - length;
      }
      status = 206;
    }
  }
  if (!head && length > maxResponseBytes) return refusal(413);
  const suffix = path.split('.').pop()?.toLowerCase() ?? '';
  const headers = refusal(200).headers.filter(header => header.name !== 'Content-Length');
  headers.push({ name: 'Content-Length', value: String(length) }, { name: 'Accept-Ranges', value: 'bytes' },
    { name: 'Content-Type', value: Object.hasOwn(MIME, suffix) ? MIME[/** @type {keyof typeof MIME} */ (suffix)] : 'application/octet-stream' });
  if (status === 206) headers.push({ name: 'Content-Range', value: `bytes ${offset}-${offset + length - 1}/${file.size}` });
  return { status, path, offset, length, head, headers };
};
