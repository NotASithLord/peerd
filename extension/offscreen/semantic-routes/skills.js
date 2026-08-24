// @ts-check
// Demand-loaded skills management surface. The sealed host owns no skill
// storage: list, toggle, and uninstall are each one exact kernel operation
// against the kernel-owned metadata authority. Install paths are not here;
// they remain unmigrated feature code with their own parse/network review.

const routes = Object.freeze({
  'skills/list': ['semantic.skills.list', () => ({})],
  'skills/setEnabled': ['semantic.skills.set-enabled', (/** @type {any} */ message) => ({
    name: message?.name, enabled: message?.enabled,
  })],
  'skills/remove': ['semantic.skills.remove', (/** @type {any} */ message) => ({
    name: message?.name,
  })],
});

/** @param {string} route @param {any} message
 * @param {{kernelCall?:(operation:string,payload:unknown)=>Promise<any>}} options */
export const dispatchSkillsSemanticRoute = async (route, message, options) => {
  const entry = /** @type {[string,(message:any)=>unknown]|undefined} */ (
    /** @type {Record<string,any>} */ (routes)[route]
  );
  if (!entry || typeof options.kernelCall !== 'function') {
    return { ok: false, code: 'semantic-skills-route-refused', outcomeKnown: true };
  }
  const result = await options.kernelCall(entry[0], entry[1](message));
  if (result?.ok === true) return result.value;
  return {
    ok: false,
    error: result?.outcomeKnown === true
      ? 'The skills operation could not be completed.'
      : 'The skills operation outcome could not be confirmed.',
    outcomeKnown: result?.outcomeKnown === true,
    retryable: result?.outcomeKnown === true,
  };
};
