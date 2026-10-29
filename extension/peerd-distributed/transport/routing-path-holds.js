// @ts-check
import { buildEnvelope, envelopeBytes, signEnvelope, verifyEnvelope } from './envelope.js';
import { canonicalize } from '/shared/bundle/canonical.js';
import { utf8 } from '/shared/bundle/bytes.js';
import { sha256hex } from '/shared/bundle/chunk.js';

// This owns local edges for a signed path request. It does not authorize a
// rotation: the coordinator must collect every hop and bind both removal plans.
export const ROUTING_PATH_HOLD = 8;
export const ROUTING_PATH_RECEIPT = 9;
const MAX_RECEIPT_LEASE_MS = 10_000;
export const MAX_ROUTING_PATH_NODES = 16;
export const MAX_ROUTING_PATH_REQUESTS = 4;
const CLOCK_WINDOW_MS = 30_000;
const REPLAY_MS = 70_000;
const REQUEST_WINDOW_MS = 10_000;
const REQUEST_BURST = 8;
const REPLAY_LIMIT = 128;
export const ROUTING_PATH_COOLDOWN_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const did = (/** @type {unknown} */ value) => typeof value === 'string' && /^did:key:z[1-9A-HJ-NP-Za-km-z]{40,64}$/.test(value);
const exact = (/** @type {any} */ value, /** @type {string[]} */ keys) => value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
const edgeKey = (/** @type {string[]} */ edge) => JSON.stringify([...edge].sort());

/** @param {any} env @param {string} roomId @param {number} time */
export const validRoutingPathRequest = (env,roomId,time) => {
  if (!exact(env,['v','ch','typ','from','body','id','ts','sig']) || env.v!==1 || env.ch!==0
    || env.typ!==ROUTING_PATH_HOLD || !did(env.from) || typeof env.id!=='string' || !UUID.test(env.id)
    || typeof env.sig!=='string' || env.sig.length>128 || !Number.isSafeInteger(env.ts)
    || Math.abs(time-env.ts)>CLOCK_WINDOW_MS || envelopeBytes(env)>8_192) return false;
  const body=env.body;
  if (!exact(body,['room','candidate','cuts','path']) || body.room!==roomId
    || !Array.isArray(body.candidate) || body.candidate.length!==2 || !body.candidate.every(did)
    || body.candidate[0]===body.candidate[1] || !Array.isArray(body.cuts) || body.cuts.length<1 || body.cuts.length>2
    || !Array.isArray(body.path) || body.path.length<3 || body.path.length>MAX_ROUTING_PATH_NODES
    || !body.path.every(did) || new Set(body.path).size!==body.path.length || body.path[0]!==env.from) return false;
  const owners=new Set();
  const cuts=new Set();
  for (const edge of body.cuts) {
    if (!Array.isArray(edge) || edge.length!==2 || !edge.every(did) || edge[0]===edge[1]) return false;
    const endpoints=edge.filter((/** @type {string} */ peer)=>body.candidate.includes(peer));
    if (endpoints.length!==1 || owners.has(endpoints[0])) return false;
    owners.add(endpoints[0]);cuts.add(edgeKey(edge));
  }
  // A path must replace one of the removed edges, excluding *all* cuts. Two
  // individually safe cycle cuts can otherwise disconnect the same graph.
  if (!cuts.has(edgeKey([body.path[0],body.path.at(-1)]))) return false;
  for (let i=1;i<body.path.length;i++) if (cuts.has(edgeKey([body.path[i-1],body.path[i]]))) return false;
  return true;
};

export class RoutingPathHoldError extends Error {
  constructor(){super('routing path hold unavailable');this.name='RoutingPathHoldError';}
}

/** @typedef {{release:()=>void,signal:AbortSignal,expiresAt:number}} EdgeHold */
/**
 * One owner per room lifetime; recreating this gate per request would erase
 * aggregate verification limits, replay history and edge cooldown ownership.
 * @param {{identity:{did:string,sign:(bytes:Uint8Array)=>Promise<Uint8Array>},roomId:string,holdRoutingLink:(did:string,options?:{signal?:AbortSignal})=>EdgeHold,
 * now?:()=>number}} options
 */
export const createRoutingPathHolds = ({identity,roomId,holdRoutingLink,now=Date.now}) => {
  const selfDid=identity.did;
  /** @type {Map<string,number>} */const seen=new Map();
  /** @typedef {{expiresAt:number,retryAfter:number,owners:number}} Cohort */
  /** @type {Map<string,Cohort>} */const cohorts=new Map();
  /** @type {Set<()=>void>} */const active=new Set();
  let closed=false,verifying=false,windowStart=now(),requests=0;
  const unavailable=()=>new RoutingPathHoldError();
  return Object.freeze({
    // The caller supplies the authenticated incoming carrier's retirement
    // signal, never a DID from the wire. Replacing that carrier while crypto is
    // pending must not transfer its authority to a new link with the same DID.
    /** @param {any} request @param {{did:string,signal:AbortSignal}|null} previousCarrier @param {{signal?:AbortSignal}} [options] */
    async acquire(request,previousCarrier,{signal}={}) {
      const previousDid=previousCarrier?.did??null,carrierSignal=previousCarrier?.signal;
      const time=now();
      if(closed || signal?.aborted || carrierSignal?.aborted || verifying || active.size>=MAX_ROUTING_PATH_REQUESTS
        || !validRoutingPathRequest(request,roomId,time)) throw unavailable();
      // Own decoded bytes before async crypto; callers cannot change the plan
      // between signature verification and local edge acquisition.
      const env=structuredClone(request),path=env.body.path;
      const index=path.indexOf(selfDid);
      if(index<0 || (index===0 ? previousDid!==null : !carrierSignal || previousDid!==path[index-1])) throw unavailable();
      for(const [key,expires] of seen) if(time>=expires) seen.delete(key);
      const key=JSON.stringify([env.from,env.id]);
      if(seen.has(key) || seen.size>=REPLAY_LIMIT) throw unavailable();
      if(time-windowStart>=REQUEST_WINDOW_MS){windowStart=time;requests=0;}
      if(requests>=REQUEST_BURST) throw unavailable();
      requests++;verifying=true;
      let valid=false;
      try{valid=await verifyEnvelope(env);}finally{verifying=false;}
      if(!valid || closed || signal?.aborted || carrierSignal?.aborted || !validRoutingPathRequest(env,roomId,now())) throw unavailable();
      // Failed acquisition also consumes the nonce: retries cannot renew part
      // of a path after another hop has already committed or retired its hold.
      seen.set(key,now()+REPLAY_MS);
      const neighbors=/** @type {string[]} */ ([path[index-1],path[index+1]].filter(Boolean));
      for(const [peer,cohort] of cohorts) if(!cohort.owners && now()>=cohort.retryAfter) cohorts.delete(peer);
      // Shared owners may use an existing deadline, never create a new one
      // after its last owner retires. A quiet interval prevents repeated fresh
      // nonces from continuously pinning the same edge.
      for(const peer of neighbors){
        const cohort=cohorts.get(peer);
        if(cohort && (!cohort.owners || now()>=cohort.expiresAt)) throw unavailable();
      }
      if(cohorts.size+neighbors.filter(peer=>!cohorts.has(peer)).length>REPLAY_LIMIT) throw unavailable();
      /** @type {EdgeHold[]} */const holds=[];
      /** @type {Cohort[]} */const ownedCohorts=[];
      const lifetime=new AbortController();let live=true;
      const release=()=>{
        if(!live)return;live=false;active.delete(release);
        signal?.removeEventListener('abort',release);
        carrierSignal?.removeEventListener('abort',release);
        for(const cohort of ownedCohorts)cohort.owners--;
        for(const hold of holds){hold.signal.removeEventListener('abort',release);hold.release();}
        lifetime.abort();
      };
      try{
        for(const peer of neighbors){
          const hold=holdRoutingLink(peer,{signal});
          if(!live){hold.release();throw unavailable();}
          holds.push(hold);
          const cohort=cohorts.get(peer)??{expiresAt:hold.expiresAt,retryAfter:now()+ROUTING_PATH_COOLDOWN_MS,owners:0};
          cohort.expiresAt=Math.min(cohort.expiresAt,hold.expiresAt);cohort.owners++;
          cohorts.set(peer,cohort);ownedCohorts.push(cohort);
          hold.signal.addEventListener('abort',release,{once:true});
          if(!live || hold.signal.aborted || now()>=hold.expiresAt) throw unavailable();
        }
        if(signal?.aborted || carrierSignal?.aborted || closed) throw unavailable();
        active.add(release);signal?.addEventListener('abort',release,{once:true});
        carrierSignal?.addEventListener('abort',release,{once:true});
        const expiresAt=Math.min(...holds.map(hold=>hold.expiresAt));
        const requestHash=await sha256hex(utf8(canonicalize(env)));
        const validForMs=Math.floor(Math.min(MAX_RECEIPT_LEASE_MS,expiresAt-now()));
        if(!live || validForMs<=0) throw unavailable();
        const receipt=await signEnvelope(buildEnvelope({ch:0,typ:ROUTING_PATH_RECEIPT,from:selfDid,
          id:crypto.randomUUID(),ts:now(),body:{room:roomId,requestHash,index,validForMs}}),identity);
        if(!live || now()>=expiresAt) throw unavailable();
        return Object.freeze({release,signal:lifetime.signal,expiresAt,index,receipt});
      }catch(error){release();throw error;}
    },
    close(){closed=true;for(const release of [...active])release();seen.clear();cohorts.clear();},
  });
};

// Receipt durations are measured from the coordinator's *request start*, not
// receipt arrival or remote wall time. This is conservative under arbitrary
// transit/signing delay and prevents clock skew from extending a remote lease.
// This verifies past attestations only. The wire coordinator must also retain
// cancellation ownership and bind the witness to the live admission session.
/** @param {any} request @param {any[]} receipts
 * @param {{roomId:string,startedAt:number,now?:()=>number,signal?:AbortSignal}} options */
export const verifyRoutingPathReceipts = async (request,receipts,{roomId,startedAt,now=Date.now,signal}) => {
  const time=now();
  if(signal?.aborted || !Number.isSafeInteger(startedAt) || startedAt>time || time-startedAt>=MAX_RECEIPT_LEASE_MS
    || !validRoutingPathRequest(request,roomId,time) || !Array.isArray(receipts) || receipts.length!==request.body.path.length) return null;
  // Check each bounded shape before cloning or requesting signature work.
  for(const [index,receipt] of receipts.entries()){
    if(!exact(receipt,['v','ch','typ','from','body','id','ts','sig']) || receipt.v!==1 || receipt.ch!==0
      || receipt.typ!==ROUTING_PATH_RECEIPT || receipt.from!==request.body.path[index] || typeof receipt.id!=='string' || !UUID.test(receipt.id)
      || typeof receipt.sig!=='string' || receipt.sig.length>128 || !Number.isSafeInteger(receipt.ts)
      || Math.abs(time-receipt.ts)>CLOCK_WINDOW_MS || envelopeBytes(receipt)>1_024
      || !exact(receipt.body,['room','requestHash','index','validForMs']) || receipt.body.room!==roomId
      || receipt.body.index!==index || typeof receipt.body.requestHash!=='string' || !/^[0-9a-f]{64}$/.test(receipt.body.requestHash)
      || !Number.isSafeInteger(receipt.body.validForMs) || receipt.body.validForMs<=0 || receipt.body.validForMs>MAX_RECEIPT_LEASE_MS) return null;
  }
  const ownedRequest=structuredClone(request),ownedReceipts=structuredClone(receipts);
  const requestHash=await sha256hex(utf8(canonicalize(ownedRequest)));
  const validUntil=startedAt+Math.min(...ownedReceipts.map(receipt=>receipt.body.validForMs));
  if(signal?.aborted || now()>=validUntil || !await verifyEnvelope(ownedRequest)) return null;
  for(const receipt of ownedReceipts){
    if(signal?.aborted || now()>=validUntil || receipt.body.requestHash!==requestHash || !await verifyEnvelope(receipt)) return null;
  }
  if(signal?.aborted || now()>=validUntil) return null;
  return Object.freeze({requestHash,validUntil});
};
