// why: container-only CI may lack sandbox support, but native release acceptance
// must never silently retry without the browser process sandbox.
export const sandboxLaunchArgs = (required = process.env.PEERD_REQUIRE_SANDBOX) => {
  if (required !== undefined && required !== '1') {
    throw new Error('PEERD_REQUIRE_SANDBOX must be unset or exactly 1');
  }
  if (required === '1') {
    console.log('[sandbox] required; no sandbox-disabling launch flags or fallback');
    return [];
  }
  return ['--no-sandbox'];
};
