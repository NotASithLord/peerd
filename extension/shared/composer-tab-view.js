// @ts-check
// Small browser-neutral composer tab projection used by the cold kernel. It is
// deliberately limited to tabs so the cold kernel cannot pull command, file,
// or transcript renderers into first wake.

/** @param {unknown} value */
const rows = (value) => Array.isArray(value) ? value : [];
/** @param {unknown} value */
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? /** @type {Record<string, any>} */ (value) : {};

/**
 * @param {unknown} value
 * @param {{originOfTabUrl:(url:string)=>string,matchesDenylist:(host:string,patterns:string[])=>boolean,patterns:()=>string[]}} policy
 */
export const projectComposerTabRows = (value, policy) => rows(value).map((candidate) => {
  const tab = record(candidate);
  const url = tab.url ?? '';
  const origin = policy.originOfTabUrl(url);
  let blocked = false;
  try {
    const host = url ? new URL(url).hostname : '';
    blocked = !!host && policy.matchesDenylist(host, policy.patterns());
  } catch { blocked = false; }
  const unsupported = /^(chrome|about|devtools|chrome-extension|edge|moz-extension):/.test(url);
  return {
    id: tab.id, title: tab.title, origin, active: tab.active,
    blocked: blocked || unsupported,
  };
});

/** @param {unknown} value */
export const renderComposerTabs = (value) => ({
  ok: true,
  tabs: rows(value).map((candidate) => {
    const tab = record(candidate);
    return {
      id: tab.id,
      title: (tab.title ?? '').slice(0, 80),
      origin: tab.origin,
      active: !!tab.active,
      blocked: !!tab.blocked,
    };
  }),
});
