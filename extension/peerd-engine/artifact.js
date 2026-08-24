// @ts-check
// Pure artifact-codec public surface. Keep this separate from offscreen.js so
// the demand-loaded codec does not link repository, OPFS, or module-resolution
// helpers that are irrelevant to envelope inspection and export.

export {
  buildAppExport,
  buildNotebookExport,
  buildVmRecipeExport,
  exportFilename,
  inspectEnvelope,
  openEnvelope,
} from './export.js';
