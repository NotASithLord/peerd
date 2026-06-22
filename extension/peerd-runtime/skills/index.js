// @ts-check
// peerd-runtime/skills — progressive-disclosure Agent Skills (SKILL.md).
//
// Public surface, re-exported through /peerd-runtime/index.js. Everything
// here is functional-core/imperative-shell: parser + registry are pure
// over their inputs; IO (storage, webFetch) is injected.
//
// The five pieces:
//   parse.js     SKILL.md → { frontmatter, body }   (pure)
//   store.js     two-tier IDB adapter (meta vs body) — repointable at
//                feature 01's workspace store
//   registry.js  description-at-startup / body-on-invocation contract +
//                system-prompt block rendering
//   install.js   local / git-URL / static-manifest sources (egress-gated)
//   load-skill-tool.js  the model-facing tool that injects a body on demand

export { parseSkillMd, normalizeName, SkillParseError } from './parse.js';
export { createSkillStore } from './store.js';
export {
  createSkillRegistry,
  SkillExistsError,
  SkillNotFoundError,
} from './registry.js';
export {
  installFromLocal,
  installFromGit,
  installFromManifest,
  resolveGitRawUrl,
  SkillInstallError,
} from './install.js';
export { loadSkillTool } from './load-skill-tool.js';
