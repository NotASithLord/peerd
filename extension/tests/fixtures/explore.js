// @ts-check
// Controlled catalog, real Explore component. No transport or installation.
import m from '/vendor/mithril/mithril.js';
import { encodeDidKey } from '/shared/address/did.js';
import { DiscoverSection } from '/home/discover-section.js';
const empty = new URLSearchParams(location.search).get('empty') === '1';
const apps = [
  {name:'Orbit lab',description:'Explore a small physics simulation with a bundled WebAssembly module.',includes_wasm:true},
  {name:'Field notes',description:'A browser notebook for observations and sketches.',includes_wasm:false},
  {name:'Pixel garden',description:'An older shared App without a WebAssembly declaration.'},
].map((app,i)=>{
  const publisher=encodeDidKey(new Uint8Array(32).fill(i+1)), version_id=String(i+1).repeat(64);
  return {...app,dwapp_id:`fixture-${i}`,publisher,version_id,size:1024 * (i+1),uri:`peerd://${publisher}/${version_id}`};
});
/** @param {{type:string}} message */
const send = async message => {
  if (message.type === 'dweb/base/heard') return {ok:true,apps:empty ? [] : apps};
  if (message.type === 'apps/list') return {ok:true,apps:[{id:'local-orbit',dweb:{uri:apps[0].uri}}]};
  if (message.type === 'dweb/base/status') return {ok:true,did:null};
  throw new Error('Visual fixture has no mutation authority');
};
m.mount(document.getElementById('app'),{view:()=>m(DiscoverSection,{send,initialSeed:42})});
