// @ts-check
// Pure policy for manifest-defined App actors. The service worker owns IO;
// this module keeps the authority identity and tab-claim checks testable.

/**
 * Serialize only the parsed manifest contract. parseAppManifest already drops
 * unknown fields, and this explicit shape keeps digest identity stable if the
 * parser's object construction order changes.
 * @param {any} contract
 */
export const canonicalAppActorManifest = (contract) => JSON.stringify({
  schema: contract.schema,
  kind: contract.kind,
  entry: contract.entry,
  agent: {
    kind: contract.agent.kind,
    profile: contract.agent.profile,
    surface: contract.agent.surface,
    ...(contract.agent.name ? { name: contract.agent.name } : {}),
    ...(contract.agent.instructions ? { instructions: contract.agent.instructions } : {}),
    ...(Array.isArray(contract.agent.runtime) && contract.agent.runtime.length
      ? { runtime: [...contract.agent.runtime].sort() }
      : {}),
  },
  capabilities: [...contract.capabilities].sort(),
});

/**
 * @param {any} record
 * @returns {{source:'local'|'unsigned-import'|'dweb',publisher:string}}
 */
export const appPublisherProvenance = (record) => {
  const publisher = typeof record?.dweb?.publisher === 'string'
    ? record.dweb.publisher.trim()
    : '';
  if (publisher) return { source: record?.source === 'dweb' ? 'dweb' : 'local', publisher };
  if (record?.source === 'imported') return { source: 'unsigned-import', publisher: 'unsigned import' };
  return { source: 'local', publisher: 'local user' };
};

/**
 * The role is descriptive package provenance, never a /system instruction.
 * @param {{contract:any, record:any, manifestDigest:string}} input
 * @returns {{source:'local'|'unsigned-import'|'dweb',publisher:string,manifestDigest:string,name?:string,instructions?:string}}
 */
export const makeAppRole = ({ contract, record, manifestDigest }) => {
  const provenance = appPublisherProvenance(record);
  return {
    source: provenance.source,
    publisher: provenance.publisher,
    manifestDigest,
    ...(contract.agent.name ? { name: contract.agent.name } : {}),
    ...(contract.agent.instructions ? { instructions: contract.agent.instructions } : {}),
  };
};

/**
 * Derive the host-owned App developer tool manifest from declarative runtime
 * methods, then intersect the caller's authority bound. app_code is useful
 * only when its full observe/act feedback loop exists.
 * @param {{contract:any,hostTools:string[],ownerAllowed:Set<string>|null}} input
 */
export const manifestAppActorTools = ({ contract, hostTools, ownerAllowed }) => {
  const methods = new Set(contract?.agent?.runtime ?? []);
  return hostTools.filter((name) => {
    const declared = name === 'app_observe' ? methods.has('observe')
      : name === 'app_act' ? methods.has('act')
      : name === 'app_code' ? methods.has('observe') && methods.has('act')
      : true;
    return declared && (!ownerAllowed || ownerAllowed.has(name));
  });
};

/**
 * Canonical owner-side authority inherited by an App actor. This fingerprint
 * makes a /tools or Plan/Act change a new actor generation even when the
 * package manifest itself did not change.
 * @param {{allow:string[],permissionMode:string,confirmActions:boolean}} input
 */
export const canonicalAppOwnerAuthority = ({ allow, permissionMode, confirmActions }) => JSON.stringify({
  allow: [...new Set(allow)].sort(),
  permissionMode,
  confirmActions: confirmActions === true,
});

/**
 * A durable actor may be reconnected only when every authority coordinate
 * still matches. A manifest edit intentionally creates a new actor generation.
 * @param {any} session
 * @param {{ownerChatId:string, appId:string, manifestDigest:string,ownerAuthorityDigest:string,publisherSource:string,publisher:string}} expected
 */
export const appActorSessionMatches = (session, expected) => Boolean(
  session
  && session.kind === 'actor'
  && session.actorType === 'app'
  && session.parentSessionId === expected.ownerChatId
  && session.instanceId === expected.appId
  && session.appManifestDigest === expected.manifestDigest
  && typeof expected.ownerAuthorityDigest === 'string'
  && session.appOwnerAuthorityDigest === expected.ownerAuthorityDigest
  && session.actorSurface === 'code'
  && session.appRole?.source === expected.publisherSource
  && session.appRole?.publisher === expected.publisher
  && !session.archivedAt,
);

/**
 * Validate an App host's claimed identity before it enters the tracker. The
 * caller supplies the URL-derived id and existing tracker owner so this stays
 * independent of browser globals.
 * @param {{claimedAppId:unknown, urlAppId:string|null, senderTabId:unknown, liveTabId:number|null}} claim
 * @returns {{ok:true, appId:string, tabId:number}|{ok:false,error:string}}
 */
export const validateAppTabClaim = ({ claimedAppId, urlAppId, senderTabId, liveTabId }) => {
  if (typeof claimedAppId !== 'string' || !claimedAppId || !Number.isInteger(senderTabId)) {
    return { ok: false, error: 'app-tab-claim-invalid' };
  }
  if (urlAppId !== claimedAppId) return { ok: false, error: 'app-tab-url-mismatch' };
  if (liveTabId != null && liveTabId !== senderTabId) return { ok: false, error: 'app-already-open' };
  return { ok: true, appId: claimedAppId, tabId: /** @type {number} */ (senderTabId) };
};

/**
 * The launch URL is the trusted shell's immutable owner claim. A runtime
 * message may repeat it, never substitute another chat. Legacy/local records
 * without a URL owner fall back only to their durable registry owner.
 * @param {{claimedOwner:unknown,urlOwner:string|null,recordOwner:string|null|undefined}} input
 */
export const resolveAppTabOwnerClaim = ({ claimedOwner, urlOwner, recordOwner }) => {
  const repeated = typeof claimedOwner === 'string' && claimedOwner ? claimedOwner : null;
  if (urlOwner) {
    return repeated === urlOwner
      ? { ok: true, ownerSessionId: urlOwner }
      : { ok: false, error: 'app-tab-owner-mismatch' };
  }
  if (repeated) return { ok: false, error: 'app-tab-owner-not-in-url' };
  return typeof recordOwner === 'string' && recordOwner
    ? { ok: true, ownerSessionId: recordOwner }
    : { ok: false, error: 'app-tab-owner-required' };
};
