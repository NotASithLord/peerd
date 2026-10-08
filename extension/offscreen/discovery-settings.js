// @ts-check
// why: notifications carry no setting value. Re-read current authority and
// fence earlier replies so delayed messages cannot restore a superseded choice.
/** @param {{read:()=>Promise<any>,apply:(enabled:boolean)=>void}} deps */
export const createDiscoverySettings = ({ read, apply }) => {
  let generation = 0;
  let enabled = false;
  const invalidate = () => { generation++; enabled = false; apply(false); };
  return {
    enabled: () => enabled,
    invalidate,
    async refresh() {
      invalidate();
      const attempt = generation;
      let result;
      try { result = await read(); } catch { /* unavailable settings stay paused */ }
      if (attempt !== generation) return { ok: false, error: 'discovery-refresh-superseded' };
      enabled = result?.ok === true && result.discoveryEnabled === true;
      apply(enabled);
      return result?.ok === true ? { ok: true, enabled } : { ok: false, error: 'discovery-settings-unavailable' };
    },
  };
};
