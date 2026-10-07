// @ts-check
import { formatDwappUri } from '/shared/address/dwapp-uri.js';

// Discovery admission verifies the signed card. At the presentation boundary,
// require its publisher, immutable version and legacy content URI to agree;
// never reconstruct a link from a display label, relay DID or mutable slug.
/** @param {{publisher?:unknown, version_id?:unknown, uri?:unknown}} app */
export const discoveryAddress = (app) => {
  if (typeof app.publisher !== 'string' || typeof app.version_id !== 'string'
      || app.uri !== `peerd://${app.publisher}/${app.version_id}`) return null;
  try { return formatDwappUri({ did: app.publisher, hash: app.version_id }); }
  catch { return null; }
};
