// @ts-check

const API_HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

/** @param {unknown} value */
export const normalizeSiteOrigin = (value) => {
  let input = String(value ?? '').trim();
  if (!input) return null;
  if (!/^https?:\/\//i.test(input)) input = `https://${input}`;
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol)
        || !API_HOSTNAME_RE.test(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
};

/** @param {unknown} value */
export const originOfUrl = (value) => {
  if (!value) return '';
  try {
    const url = new URL(String(value));
    if (['chrome:', 'about:', 'devtools:'].includes(url.protocol)) {
      return `${url.protocol}//${url.host || url.pathname.split('/')[0] || ''}`;
    }
    return `${url.protocol}//${url.host}`;
  } catch { return ''; }
};

/** @param {unknown} value */
const standardOrigin = (value) => {
  try { return new URL(String(value)).origin; }
  catch { return ''; }
};

/** @param {any} rule @param {any} args @param {any} ctx */
export const resolveToolOrigins = (rule, args, ctx) => {
  if (!rule || rule.kind === 'none') return [];
  const active = typeof ctx?.activeTab?.origin === 'string' ? ctx.activeTab.origin : '';
  const fromField = () => {
    if (rule.when && args?.[rule.when.field] !== rule.when.equals) return '';
    const value = args?.[rule.field];
    return rule.mode === 'standard' ? standardOrigin(value) : originOfUrl(value);
  };
  if (rule.kind === 'active-tab') return active ? [active] : [];
  if (rule.kind === 'url-field') {
    const origin = fromField();
    return origin ? [origin] : [];
  }
  if (rule.kind === 'active-plus-url') {
    const target = fromField();
    return [...new Set([active, target].filter(Boolean))];
  }
  if (rule.kind === 'url-or-active') {
    const target = args?.[rule.field] ? fromField() : active;
    return target ? [target] : [];
  }
  if (rule.kind === 'site-origin-field') {
    const origin = normalizeSiteOrigin(args?.[rule.field]);
    return origin ? [origin] : [];
  }
  if (rule.kind === 'https-command') {
    const matches = String(args?.[rule.field] ?? '').match(/https:\/\/[^\s'"<>|]+/g) ?? [];
    return [...new Set(matches.map(standardOrigin).filter(Boolean))];
  }
  throw new TypeError(`unknown tool origin rule: ${String(rule.kind)}`);
};

/**
 * Resolve either an in-process execution descriptor or its clone-safe
 * controller projection. The authority host needs the same finite origin
 * policy without importing model-facing tool metadata.
 * @param {{origins?:(args:any,ctx:any)=>string[],originRule?:any}} tool
 * @param {any} args
 * @param {any} ctx
 */
export const resolveDeclaredToolOrigins = (tool, args, ctx) =>
  typeof tool?.origins === 'function'
    ? tool.origins(args, ctx) ?? []
    : resolveToolOrigins(tool?.originRule, args, ctx);
