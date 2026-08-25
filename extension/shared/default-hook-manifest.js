// @ts-check

export const DEFAULT_HOOK_MANIFEST = Object.freeze([
  Object.freeze({
    id: 'egress-allowlist',
    event: 'pre-tool-use',
    enabled: true,
    order: 10,
    match: '*',
    description: 'Blocks network tools whose target origin is off the provider '
      + 'allowlist — the always-on egress floor. Built-in code, registered at '
      + 'boot; cannot be disabled or removed.',
  }),
  Object.freeze({
    id: 'egress-tripwire',
    event: 'pre-tool-use',
    enabled: true,
    order: 20,
    match: '*',
    description: 'Blocks a page-driving tool — or a web helper\'s own fetch — from '
      + 'sending an off-origin URL that carries a high-entropy encoded payload in its '
      + 'userinfo, host, or path, or a fetch header/body carrying that shape. Does NOT scan the '
      + 'query string, where legitimate login tokens live. Best-effort tripwire, not a '
      + 'guarantee. Built-in code, registered at boot; cannot be disabled or removed.',
  }),
]);
