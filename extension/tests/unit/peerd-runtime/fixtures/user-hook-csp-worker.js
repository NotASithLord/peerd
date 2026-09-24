// @ts-check

import { compileUserHook } from '/peerd-runtime/tools/hooks/compile.js';

try {
  const hook = compileUserHook(/** @type {any} */ ({
    id: 'csp-probe',
    event: 'pre-tool-use',
    kind: 'js',
    trusted: true,
    body: "return { action: 'allow' };",
  }));
  const decision = await hook.run({
    event: 'pre-tool-use',
    toolName: 'now',
    args: { value: 1 },
    ctx: /** @type {any} */ ({}),
  });
  postMessage({ ok: true, decision });
} catch (error) {
  postMessage({
    ok: false,
    name: /** @type {{ name?: string }} */ (error)?.name ?? '',
    message: /** @type {{ message?: string }} */ (error)?.message ?? String(error),
  });
}
