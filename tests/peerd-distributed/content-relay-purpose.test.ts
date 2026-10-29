import {expect,test} from 'bun:test';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {memoryPair,createBufferedChannel} from '../../extension/peerd-distributed/transport/channel.js';
import {joinRoom} from '../../extension/peerd-distributed/transport/rooms.js';
import {createAdmissionGovernor} from '../../extension/peerd-distributed/transport/admission.js';
import {createChannelClient} from '../../extension/peerd-distributed/content/transfer.js';

test('signed relay purpose and HELLO admit a content carrier while routing slots are full', async()=>{
 const identities=await Promise.all([generateIdentity(),generateIdentity(),generateIdentity()]);
 const pending=new Map<string,ReturnType<typeof memoryPair>[number]>();
 let next=0; const channels:ReturnType<typeof memoryPair>[number][]=[];
 const transport={
  async connect(_peer:any,{signaling}:any){const pair=memoryPair();channels.push(...pair);const id=String(++next);pending.set(id,pair[1]);await signaling.send({type:'offer',sdp:id});return pair[0];},
  async accept({offer}:any){const channel=pending.get(offer.sdp);pending.delete(offer.sdp);return {channel};}
 };
 const admission=createAdmissionGovernor();
 const rooms=await Promise.all(identities.map(identity=>joinRoom({identity,roomId:'r',url:null,transport,admission,budget:3,transferSlots:1})));
 try {
  for(const i of [0,1]) {const pair=memoryPair();channels.push(...pair);rooms[i].mesh.addLink(pair[0],identities[2].did);rooms[2].mesh.addLink(pair[1],identities[i].did);rooms[i].mesh.addLink(createBufferedChannel({send(){}}),'routing-filler');}
  rooms[1].mesh.serveContent({getManifest:()=>null});
  const leases=await Promise.all([rooms[0].acquireContentVia(identities[2].did,identities[1].did),rooms[0].acquireContentVia(identities[2].did,identities[1].did)]);
  // A sender's completion precedes the remote continuation. Await actual
  // authenticated admission, not a guessed sleep or a fake response.
  for(let i=0;i<100&&!rooms[1].mesh.hasContentLink(identities[0].did);i++) await new Promise(r=>setTimeout(r,1));
  for(const i of [0,1]) {expect(rooms[i].mesh.stats().totalDegree).toBe(3);expect(rooms[i].mesh.stats().peerDegree).toBe(2);expect(rooms[i].mesh.hasLink(identities[1-i].did)).toBe(false);}
  await rooms[0].dialVia(identities[2].did,identities[1].did,{purpose:'content'});
  expect(next).toBe(1); // reuse the established carrier without replacing owners
  const client=createChannelClient(rooms[0].mesh.contentChannel(identities[1].did)!,500);
  try{expect((await client.manifest('a'.repeat(64))).t).toBe('NOMANIFEST');}finally{client.close();}
  expect(admission.stats().active).toBe(0);
  leases[0].release();expect(rooms[0].mesh.hasContentLink(identities[1].did)).toBe(true);
  leases[1].release();expect(rooms[0].mesh.hasContentLink(identities[1].did)).toBe(false);
 } finally {rooms.forEach(r=>r.leave());channels.forEach(c=>c.close());}
});
