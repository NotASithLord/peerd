import {expect, test} from 'bun:test';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {createRoomMesh, CTRL} from '../../extension/peerd-distributed/transport/mesh.js';
import {createBufferedChannel, memoryPair} from '../../extension/peerd-distributed/transport/channel.js';
import {createSession} from '../../extension/peerd-distributed/transport/session.js';
import {CONTENT_ONLY} from '../../extension/peerd-distributed/transport/capabilities.js';
import {createChannelClient} from '../../extension/peerd-distributed/content/transfer.js';

const channel = () => createBufferedChannel({send() {}});
test('temporary content capacity stays inside aggregate cap and cannot replace routing authority', async () => {
  const mesh = createRoomMesh({roomId:'r',identity:await generateIdentity(),budget:3,transferSlots:1});
  try {
    expect(mesh.addLink(channel(),'r1')).toBe(true);
    expect(mesh.addLink(channel(),'r2')).toBe(true);
    expect(mesh.addLink(channel(),'r3')).toBe(false);
    expect(mesh.addLink(channel(),'legacy',{}, {purpose:'content'})).toBe(false);
    expect(mesh.addLink(channel(),'content',{caps:[CONTENT_ONLY]}, {purpose:'content'})).toBe(true);
    expect(mesh.addLink(channel(),'extra',{caps:[CONTENT_ONLY]}, {purpose:'content'})).toBe(false);
    expect(mesh.addLink(channel(),'content')).toBe(false);
    expect(mesh.hasLink('content')).toBe(false);
    expect(mesh.hasContentLink('content')).toBe(true);
    expect(mesh.peers().map(p=>p.did)).toEqual(['r1','r2']);
    expect(mesh.stats().totalDegree).toBe(3);
    mesh.removeLink('content');
    expect(mesh.addLink(channel(),'replacement',{caps:[CONTENT_ONLY]}, {purpose:'content'})).toBe(true);
  } finally {mesh.close();}
});

test('authenticated content carriers serve content but never route envelopes or advertise neighbors', async () => {
  const ids=await Promise.all([generateIdentity(),generateIdentity()]);
  const pair=memoryPair();
  const sessions=await Promise.all(ids.map((identity,i)=>createSession({identity,channel:pair[i],caps:[CONTENT_ONLY]})));
  const meshes=ids.map(identity=>createRoomMesh({identity,roomId:'r',budget:3,transferSlots:1}));
  const joined: unknown[]=[]; const envelopes: unknown[]=[];
  meshes[0].onPeer(e=>joined.push(e)); meshes[0].onEnvelope(e=>envelopes.push(e));
  try {
    for(let i=0;i<2;i++) expect(meshes[i].addLink(pair[i],sessions[i].remoteDid,{caps:sessions[i].remoteCaps},{purpose:'content'})).toBe(true);
    expect(joined).toHaveLength(0);
    meshes[1].serveContent({getManifest:()=>null});
    const content=meshes[0].contentChannel(ids[1].did)!;
    const client=createChannelClient(content,500);
    try {expect(await client.manifest('a'.repeat(64))).toEqual({t:'NOMANIFEST',hash:'a'.repeat(64)});} finally {client.close();}
    const env=await meshes[0].sign(0,CTRL.ROSTER_REQ,{room:'r'});
    expect(await meshes[0].send(ids[1].did,env)).toBe(false);
    await expect(meshes[0].requestRoster(ids[1].did)).rejects.toThrow('no link');
    await expect(content.send(env)).rejects.toThrow('content link scope');
    await meshes[0].broadcast(env);
    expect(meshes[0].stats().broadcasts.destinations).toBe(0);
    // Bypass the local API as a hostile remote would; receiver closes before
    // routing or expensive signature work can grant any additional authority.
    await pair[1].send(await meshes[1].sign(4,0,{value:'not-content'}));
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(pair[0].isClosed()).toBe(true);
    expect(envelopes).toHaveLength(0);
  } finally {for(const mesh of meshes)mesh.close();}
});
