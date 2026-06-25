// SLIM SHIM (web prototype). The real peerd-engine/index.js is a barrel that
// re-exports the whole engine (registries, app-compose, vm-net, …), much of
// which is extension-coupled. The Notebook substrate only needs the pure
// module resolver, so this prototype shim re-exports just that. Replaced by
// the real `web` packaging target later.
export { buildEntry, buildModule, resolveRelativePath, stripExports } from './module-resolver.js';
