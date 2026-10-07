// @ts-check
// Card hints belong to the exact publication result, never caller-supplied
// runtime claims. Compensation retains the previous signed head verbatim.
/** @param {{hash:string,uri:string,size:number,includesWasm?:boolean}} published
 * @param {any} [release] */
export const publishedAppHead = (published, release) => ({
  version_id: published.hash, content_addr: published.uri, size: published.size,
  ...(typeof published.includesWasm === 'boolean' ? {includes_wasm:published.includesWasm} : {}),
  ...(release?.previousVersionId ? {previous_version_id:release.previousVersionId} : {}),
  ...(release?.gitCommitOid ? {git_commit_oid:release.gitCommitOid} : {}),
  ...(release?.changelog ? {changelog:release.changelog} : {}),
});
