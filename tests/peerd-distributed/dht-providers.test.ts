import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { createDhtNode } from '../../extension/peerd-distributed/dht/node.js';
import { createDhtStore } from '../../extension/peerd-distributed/dht/store.js';
import { createProviderStore } from '../../extension/peerd-distributed/dht/provider-store.js';
import { nodeIdOf } from '../../extension/peerd-distributed/dht/distance.js';
import { signProvider } from '../../extension/peerd-distributed/dht/records.js';

const KEY = 'ab'.repeat(32); // a 64-hex content key

const makeNetwork = async (n: number, now = () => Date.now()) => {
  const network = new Map<string, any>();
  const nodes: any[] = [];
  for (let i = 0; i < n; i++) {
    const identity = await generateIdentity();
    const selfId = await nodeIdOf(identity.did);
    const rpc = async (contact: any, msg: any) => {
      const target = network.get(contact.did);
      if (!target) throw new Error('unreachable');
      return target.node.handle(identity.did, msg);
    };
    const node = createDhtNode({ identity, selfId, store: createDhtStore({ now }), providers: createProviderStore({ now }), rpc, now });
    const entry = { identity, node, selfId };
    network.set(identity.did, entry);
    nodes.push(entry);
  }
  return { nodes };
};
const seedFull = async (nodes: any[]) => { for (const a of nodes) for (const b of nodes) if (a !== b) await a.node.learn(b.identity.did); };
const seedStar = async (nodes: any[]) => { for (const b of nodes.slice(1)) { await nodes[0].node.learn(b.identity.did); await b.node.learn(nodes[0].identity.did); } };
const provide = async (n: any, key = KEY) => n.node.announceProvider(key, await signProvider({ key, ts: Date.now() }, n.identity));

describe('dht/provider-store', () => {
  test('verifies the self-signature, lists live providers, refuses a forgery', async () => {
    const a = await generateIdentity();
    const store = createProviderStore();
    expect((await store.add(await signProvider({ key: KEY, ts: 1 }, a))).ok).toBe(true);
    expect(store.list(KEY)).toEqual([a.did]);
    const forged = { ...(await signProvider({ key: KEY, ts: 2 }, a)), provider: 'did:key:zSomeoneElse' };
    expect((await store.add(forged)).ok).toBe(false);
  });

  test('entries expire after the TTL', async () => {
    let t = 1000;
    const a = await generateIdentity();
    const store = createProviderStore({ now: () => t, ttl: 100 });
    await store.add(await signProvider({ key: KEY, ts: t }, a));
    expect(store.list(KEY)).toHaveLength(1);
    t += 200;
    expect(store.list(KEY)).toHaveLength(0);
  });
});

describe('dht node — provider sets', () => {
  test('announceProvider then findProviders resolves across a full mesh', async () => {
    const { nodes } = await makeNetwork(8);
    await seedFull(nodes);
    const { stored } = await provide(nodes[0]);
    expect(stored).toBeGreaterThan(0); // ADD_PROVIDER landed on remote k-closest nodes
    expect(await nodes[5].node.findProviders(KEY)).toContain(nodes[0].identity.did);
  });

  test('multiple providers under one key all surface', async () => {
    const { nodes } = await makeNetwork(8);
    await seedFull(nodes);
    await provide(nodes[0]); await provide(nodes[1]); await provide(nodes[2]);
    const found = await nodes[6].node.findProviders(KEY);
    for (const i of [0, 1, 2]) expect(found).toContain(nodes[i].identity.did);
  });

  test('multi-hop: a provider announced through one bootstrap is findable by another', async () => {
    const { nodes } = await makeNetwork(12);
    await seedStar(nodes);          // node5, node9 each know ONLY node0
    await provide(nodes[5]);
    expect(await nodes[9].node.findProviders(KEY)).toContain(nodes[5].identity.did);
  });
});

test('parallel provider referrals cannot race past the contact cap', async () => {
  const identity = await generateIdentity();
  const brokers = await Promise.all(Array.from({ length: 3 }, () => generateIdentity()));
  const referred = await Promise.all(Array.from({ length: 192 }, () => generateIdentity()));
  const node = createDhtNode({
    identity, selfId: await nodeIdOf(identity.did), store: createDhtStore(),
    rpc: async (contact) => ({ providers: referred.slice(brokers.findIndex((peer) => peer.did === contact.did) * 64).map((peer) => peer.did) }),
  });
  for (const broker of brokers) await node.learn(broker.did);
  const contacts = await node.findProviderContacts(KEY);
  expect(contacts).toHaveLength(64);
  expect(contacts.every((contact) => brokers.some((broker) => broker.did === contact.hints.broker))).toBe(true);
});


test('provider lookup reports RPC and malformed-reply uncertainty without losing valid referrals', async () => {
  const identity = await generateIdentity();
  const broker = await generateIdentity();
  const provider = await generateIdentity();
  let mode = 'failure';
  let failures = 0;
  const node = createDhtNode({
    identity, selfId: await nodeIdOf(identity.did), store: createDhtStore(),
    rpc: async () => {
      if (mode === 'failure') throw new Error('unreachable');
      if (mode === 'malformed') return { t: 'ERR' };
      return { t: 'PROVIDERS', providers: mode === 'provider' ? [provider.did] : [], nodes: [] };
    },
  });
  for (const next of ['failure', 'malformed', 'empty', 'provider']) {
    mode = next;
    failures = 0;
    await node.learn(broker.did);
    const result = await node.findProviderContacts(KEY, { onQueryFailure: () => { failures++; } });
    expect(failures).toBe(next === 'failure' || next === 'malformed' ? 1 : 0);
    expect(result.map(contact => contact.did)).toEqual(next === 'provider' ? [provider.did] : []);
  }
});

test('provider lookup follows a healthy referral while another query is stalled',async()=>{
 const [identity,slow,fast,next,provider]=await Promise.all(Array.from({length:5},()=>generateIdentity()));
 let release!:()=>void,followed!:()=>void,active=0,maximum=0;
 const gate=new Promise<void>(resolve=>release=resolve),advanced=new Promise<void>(resolve=>followed=resolve);
 const node=createDhtNode({identity,selfId:await nodeIdOf(identity.did),store:createDhtStore(),alpha:2,
  rpc:async contact=>{
   active++;maximum=Math.max(maximum,active);
   try{
    if(contact.did===slow.did){await gate;return {t:'PROVIDERS',providers:[],nodes:[]};}
    if(contact.did===fast.did)return {t:'PROVIDERS',providers:[],nodes:[{did:next.did}]};
    followed();return {t:'PROVIDERS',providers:[provider.did],nodes:[]};
   }finally{active--;}
  }});
 await node.learn(slow.did);await node.learn(fast.did);
 const result=node.findProviderContacts(KEY);let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const reached=await Promise.race([advanced.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),300);})]);
  expect(reached).toBe(true);expect(maximum).toBe(2);
 }finally{clearTimeout(timer);release();await result;}
 expect((await result).map(contact=>contact.did)).toContain(provider.did);
});

test('progressive provider lookup retains query and concurrency bounds',async()=>{
 const peers=await Promise.all(Array.from({length:70},()=>generateIdentity()));
 let active=0,maximum=0;const queried:string[]=[];
 const node=createDhtNode({identity:peers[0],selfId:await nodeIdOf(peers[0].did),store:createDhtStore(),alpha:3,k:64,
  rpc:async contact=>{
   queried.push(contact.did);active++;maximum=Math.max(maximum,active);
   await Promise.resolve();active--;
   return {t:'PROVIDERS',providers:[],nodes:peers.slice(1).map(peer=>({did:peer.did}))};
  }});
 await node.learn(peers[1].did);await node.learn(peers[2].did);
 expect(await node.findProviderContacts(KEY)).toEqual([]);
 expect(queried).toHaveLength(64);expect(new Set(queried).size).toBe(64);expect(maximum).toBeLessThanOrEqual(3);
});

test('provider lookup cancellation stops new work and ignores late referrals',async()=>{
 const [identity,first,second,provider]=await Promise.all(Array.from({length:4},()=>generateIdentity()));
 const controller=new AbortController();let calls=0;
 const node=createDhtNode({identity,selfId:await nodeIdOf(identity.did),store:createDhtStore(),alpha:2,
  rpc:async()=>{calls++;controller.abort();return {t:'PROVIDERS',providers:[provider.did],nodes:[{did:provider.did}]};}});
 await node.learn(first.did);await node.learn(second.did);
 expect(await node.findProviderContacts(KEY,{signal:controller.signal})).toEqual([]);expect(calls).toBe(1);
});
