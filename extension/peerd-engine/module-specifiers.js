// @ts-check
// Shared protocol constants for engine module resolvers. Keep these separate
// from module-resolver.js so code that only shapes a specifier does not link
// Acorn and the complete transform pipeline.

export const TOOLBOX_SPECIFIER_PREFIX = 'peerd:toolbox/';
