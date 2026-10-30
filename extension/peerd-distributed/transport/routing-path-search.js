// @ts-check
import { decodeDidKey } from '../identity/did.js';
import { MAX_ROUTING_PATH_NODES } from './routing-path-holds.js';

export const MAX_ROUTING_PATH_QUERIES=16;
export const MAX_ROUTING_PATH_FRONTIER=64;
export const MAX_ROUTING_PATH_NEIGHBORS=32;
const SEARCH_DEADLINE_MS=4_000;
const MAX_ACTIVE_SEARCHES=2;
const did=(/** @type {unknown} */ value)=>{
  if(typeof value!=='string' || value.length>128)return false;
  try{decodeDidKey(value);return true;}catch{return false;}
};
const edgeKey=(/** @type {string[]} */ edge)=>JSON.stringify([...edge].sort());
export class RoutingPathSearchError extends Error {
  constructor(){super('routing path search unavailable');this.name='RoutingPathSearchError';}
}
/**
 * One owner per room. readNeighbors must query the endpoint over the supplied
 * existing routing path and verify that endpoint's response. It cannot dial
 * new routing peers. A result is only a hint: signed path holds must still
 * revalidate every edge before any replacement can be authorized.
 * @param {{selfDid:string,readNeighbors:(path:readonly string[],signal:AbortSignal)=>Promise<unknown>,
 * now?:()=>number,timers?:any}} options
 */
export const createRoutingPathSearch=({selfDid,readNeighbors,now=Date.now,timers=globalThis})=>{
  /** @type {Set<()=>void>} */const active=new Set();
  let closed=false;
  /** @param {string} target @param {Set<string>} excluded @param {AbortSignal} [signal] */
  const search=async(target,excluded,signal)=>{
      if(closed || signal?.aborted || active.size>=MAX_ACTIVE_SEARCHES || !did(selfDid) || !did(target) || target===selfDid)throw new RoutingPathSearchError();
      const lifetime=new AbortController(),deadline=now()+SEARCH_DEADLINE_MS;
      const cancel=()=>{
        active.delete(cancel);timers.clearTimeout(timer);signal?.removeEventListener('abort',cancel);lifetime.abort();
      };
      const check=()=>{if(closed || lifetime.signal.aborted || now()>=deadline){cancel();throw new RoutingPathSearchError();}};
      active.add(cancel);signal?.addEventListener('abort',cancel,{once:true});const timer=timers.setTimeout(cancel,SEARCH_DEADLINE_MS);
      /** @type {string[][]} */const frontier=[[selfDid]];
      const seen=new Set([selfDid]);let queries=0;
      try{
        while(frontier.length && queries<MAX_ROUTING_PATH_QUERIES){
          check();const path=/** @type {string[]} */ (frontier.shift());
          if(path.length>=MAX_ROUTING_PATH_NODES)continue;
          queries++;
          /** @type {unknown} */let neighbors;
          let detach=()=>{};
          const aborted=new Promise((_,reject)=>{
            const fail=()=>reject(new RoutingPathSearchError());
            detach=()=>lifetime.signal.removeEventListener('abort',fail);
            lifetime.signal.addEventListener('abort',fail,{once:true});
            if(lifetime.signal.aborted)fail();
          });
          try{neighbors=await Promise.race([readNeighbors(Object.freeze([...path]),lifetime.signal),aborted]);}
          catch{check();continue;}
          finally{detach();}
          check();
          if(!Array.isArray(neighbors) || neighbors.length>MAX_ROUTING_PATH_NEIGHBORS || !neighbors.every(did))continue;
          for(const peer of neighbors){
            if(excluded.has(edgeKey([path.at(-1),peer])) || seen.has(peer))continue;
            const next=[...path,peer];
            if(peer===target)return Object.freeze(next);
            // Bound retained identities as well as queued work. Clearing old
            // frontier entries must not reset the search's total memory cap.
            if(seen.size>=MAX_ROUTING_PATH_FRONTIER)continue;
            seen.add(peer);frontier.push(next);
          }
        }
        return null;
      }finally{cancel();}
  };
  return Object.freeze({
    /** @param {{target:string,cuts:string[][],signal?:AbortSignal}} options */
    async find({target,cuts,signal}){
      // why: locating an existing route must never relax the separate proof
      // required to replace an edge. Empty cuts remain invalid for this API.
      if(!Array.isArray(cuts) || cuts.length<1 || cuts.length>2
        || !cuts.every(edge=>Array.isArray(edge)&&edge.length===2&&edge.every(did)&&edge[0]!==edge[1]))throw new RoutingPathSearchError();
      const excluded=new Set(cuts.map(edgeKey));
      if(excluded.size!==cuts.length || !excluded.has(edgeKey([selfDid,target])))throw new RoutingPathSearchError();
      return search(target,excluded,signal);
    },
    /** Locate only a hint over existing carriers, with no replacement authority.
     * @param {{target:string,signal?:AbortSignal}} options */
    async routeTo({target,signal}){
      // why: a saturated intermediary can supply its authenticated roster over
      // the current path without opening a new direct connection to the reader.
      // Both entry points share the same active-search and traversal budgets.
      return search(target,new Set(),signal);
    },
    close(){closed=true;for(const cancel of [...active])cancel();},
  });
};
