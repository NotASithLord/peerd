// @ts-check
// Authenticated, channel-bound HELLO exchange. Protocol 2 intentionally rejects
// legacy peers: a recorded signature is not fresh proof of the carrier's key.

import { buildEnvelope, signEnvelope, verifyEnvelope } from './envelope.js';

export const ADMISSION_READY = 'admission-ready-v3';

const newId = () => crypto.randomUUID();
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
/** @typedef {{kind:string,localFingerprint:string,remoteFingerprint:string,streamId:number}} SessionBinding */
/** @param {any} value @param {string[]} keys */
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
/** @param {any} value */
const validBinding = (value) => exactKeys(value, ['kind', 'localFingerprint', 'remoteFingerprint', 'streamId'])
  && ['webrtc-dtls-sha256', 'trusted-local'].includes(value.kind)
  && typeof value.localFingerprint === 'string' && HASH.test(value.localFingerprint)
  && typeof value.remoteFingerprint === 'string' && HASH.test(value.remoteFingerprint)
  && Number.isInteger(value.streamId) && value.streamId >= 0 && value.streamId < 65535;
/** @param {any} env @param {number} typ */
const validEnvelope = (env, typ) => exactKeys(env, ['v', 'ch', 'typ', 'from', 'body', 'id', 'ts', 'sig'])
  && env.v === 1 && env.ch === 0 && env.typ === typ
  && typeof env.from === 'string' && env.from.length <= 128
  && typeof env.sig === 'string' && env.sig.length <= 128
  && typeof env.id === 'string' && NONCE.test(env.id) && Number.isSafeInteger(env.ts);

/**
 * @param {{
 *   channel: { send:(msg:any, options?: import('./outgoing.js').SendOptions)=>void | Promise<void>, setHandler:(h:any)=>void, deliver:(msg:any)=>void,
 *     onClose?:(cb:()=>void)=>(()=>void), close?:()=>void, isClosed?:()=>boolean, getSessionBinding?:()=>(SessionBinding|null) },
 *   identity: {did:string,sign:(bytes:Uint8Array)=>Promise<Uint8Array>},
 *   prepareAdmission?:(did:string,caps:readonly string[])=>void|{victim:string|null,signal?:AbortSignal,release?:()=>void}|Promise<void|{victim:string|null,signal?:AbortSignal,release?:()=>void}>,
 *   commitAdmission?:(plan:{remoteDid:string,localVictim:string|null,remoteVictim:string|null,signal:AbortSignal})=>Promise<{digest:string,signal:AbortSignal,release?:()=>void}|null>,
 *   caps?:string[], now?:()=>number, timeoutMs?:number, signal?:AbortSignal, timers?:any,
 * }} opts
 * @returns {Promise<{remoteDid:string,remoteCaps:readonly string[]}>}
 */
export const createSession = ({ channel, identity, caps = ['content'], now = Date.now,
  timeoutMs = 10_000, signal, timers = globalThis, prepareAdmission, commitAdmission,
}) => new Promise((resolve, reject) => {
  let settled = false;
  let preparing=false, readySent=false, readyReceived=false, verifyingReady=false;
  let localVictim=/** @type {string|null} */(null);
  let committing=false,commitSent=false,commitReceived=false,verifyingCommit=false;
  /** @type {any} */let localReady=null;
  /** @type {any} */let remoteCommit=null;
  const work=new AbortController();
  /** @type {any} */let remoteReady=null;
  let helloStarted = false;
  let helloSent = false;
  let proofStarted = false;
  let proofSent = false;
  let proofReceived = false;
  let verifyingProof = false;
  /** @type {any} */ let remoteHello = null;
  /** @type {any} */ let remoteProof = null;
  /** @type {SessionBinding} */ let binding;
  const helloId = newId();
  let offClose = () => {};
  let releaseAdmissionObserver = () => {};
  let releaseWitnessObserver = () => {};
  /** @type {any[]} */ const stashed = [];
  let stashedBytes = 0;
  /** @param {Error|null} error */
  const finish = (error) => {
    if (settled) return;
    settled = true;
    timers.clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    offClose();
    releaseAdmissionObserver();
    releaseWitnessObserver();
    channel.setHandler(null);
    if (error) {
      work.abort();
      // Fixed flags retain no frames/keys; sent means JS completion, never native delivery.
      try { Object.assign(error, { helloProgress: Object.freeze({
        helloSent, helloReceived: !!remoteHello, proofSent, proofReceived,
        verifyingHello: helloStarted && !remoteHello, verifyingProof: verifyingProof && !proofReceived,
        stashedFrames: stashed.length, stashedBytes: Math.min(stashedBytes, 1_048_577),
      }) }); } catch { /* a frozen producer error must retain its original outcome */ }
      stashed.length = 0;
      try { channel.close?.(); } catch { /* already closed */ }
      reject(error);
    } else {
      for (const msg of stashed) channel.deliver(msg);
      stashed.length = 0;
      resolve({ remoteDid: remoteHello.from, remoteCaps: Object.freeze([...remoteHello.body.caps]) });
    }
  };
  const complete = () => {
    if(settled||!helloSent||!proofSent||!proofReceived)return;
    const negotiated=caps.includes(ADMISSION_READY)&&remoteHello.body.caps.includes(ADMISSION_READY);
    if(!negotiated){if(remoteReady||remoteCommit)finish(new Error('unnegotiated admission readiness'));else finish(null);return;}
    if(readySent&&readyReceived){
      if(commitSent&&commitReceived){finish(null);return;}
      if(!committing){
        committing=true;
        Promise.resolve().then(()=>{
          if(settled)return null;
          return commitAdmission?.({remoteDid:remoteHello.from,localVictim,remoteVictim:remoteReady.body.victim,signal:work.signal})??null;
        }).then(async(witness)=>{
          if(settled){witness?.release?.();return;}
          if(localVictim && (!witness || !HASH.test(witness.digest))){finish(new Error('rotation requires a live path witness'));return;}
          if(witness){
            const retired=()=>finish(new Error('peer admission witness retired'));
            releaseWitnessObserver=()=>witness.signal.removeEventListener('abort',retired);
            witness.signal.addEventListener('abort',retired,{once:true});
            if(witness.signal.aborted){retired();return;}
          }
          const env=await signEnvelope(buildEnvelope({ch:0,typ:3,from:identity.did,
            body:{ready:localReady.id,peerReady:remoteReady.id,digest:localVictim?witness?.digest:null},id:newId(),ts:now()}),identity);
          if(settled)return;
          await channel.send({__t:'ADMISSION_COMMIT',env},{signal:work.signal,priority:'control'});
          if(settled)return;commitSent=true;complete();
        }).catch(error=>finish(error instanceof Error?error:new Error(String(error))));
      }
      if(remoteCommit&&!verifyingCommit){
        verifyingCommit=true;
        const env=remoteCommit,b=env.body;
        if(env.from!==remoteHello.from || b.ready!==remoteReady.id || b.peerReady!==localReady.id
          || (remoteReady.body.victim===null ? b.digest!==null : typeof b.digest!=='string'||!HASH.test(b.digest))){
          finish(new Error('admission commit does not match this plan'));return;
        }
        verifyEnvelope(env).then(valid=>{
          if(settled)return;
          if(!valid){finish(new Error('invalid admission commit signature'));return;}
          commitReceived=true;complete();
        }).catch(error=>finish(error instanceof Error?error:new Error(String(error))));
      }
      return;
    }
    if(!preparing){
      preparing=true;
      Promise.resolve().then(()=>{if(!settled)return prepareAdmission?.(remoteHello.from,Object.freeze([...remoteHello.body.caps]));}).then(async(plan)=>{
        if(settled){plan?.release?.();return;}
        // Signing/sending readiness is asynchronous. A local reservation may
        // expire or be cancelled during either await; its old authorization
        // must never finish a new carrier after that ownership has ended.
        if(plan?.signal){
          const admissionSignal=plan.signal;
          const retired=()=>finish(new Error('peer admission reservation retired'));
          releaseAdmissionObserver=()=>admissionSignal.removeEventListener('abort',retired);
          admissionSignal.addEventListener('abort',retired,{once:true});
          if(admissionSignal.aborted){retired();return;}
        }
        localVictim=plan?.victim??null;
        if(localVictim!==null && (typeof localVictim!=='string'||!localVictim.length||localVictim.length>128
          ||localVictim===identity.did||localVictim===remoteHello.from)){finish(new Error('invalid local admission victim'));return;}
        const env=await signEnvelope(buildEnvelope({ch:0,typ:2,from:identity.did,
          body:{proto:2,to:remoteHello.from,hello:helloId,challenge:remoteHello.id,binding:{...binding},victim:localVictim},id:newId(),ts:now()}),identity);
        if(settled)return;
        localReady=env;
        await channel.send({__t:'ADMISSION_READY',env},{signal,priority:'control'});
        if(settled)return;readySent=true;complete();
      }).catch(error=>finish(error instanceof Error?error:new Error(String(error))));
    }
    if(remoteReady&&!verifyingReady){
      verifyingReady=true;
      const env=remoteReady,b=env.body;
      if(env.from!==remoteHello.from||b.to!==identity.did||b.hello!==remoteHello.id||b.challenge!==helloId
        ||b.binding.kind!==binding.kind||b.binding.streamId!==binding.streamId
        ||b.binding.localFingerprint!==binding.remoteFingerprint||b.binding.remoteFingerprint!==binding.localFingerprint){finish(new Error('admission readiness does not match this channel'));return;}
      verifyEnvelope(env).then(valid=>{if(settled)return;if(!valid){finish(new Error('invalid admission readiness signature'));return;}readyReceived=true;complete();})
        .catch(error=>finish(error instanceof Error?error:new Error(String(error))));
    }
  };
  const abort = () => finish(new Error('peer HELLO cancelled'));
  const timer = timers.setTimeout(() => finish(new Error('peer HELLO timed out')), timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) { abort(); return; }
  if (channel.isClosed?.()) { finish(new Error('peer closed during HELLO')); return; }
  // why: this binding is supplied by the local transport, never by a peer frame.
  // DTLS fingerprints plus stream ID stop proof forwarding across attacker pipes.
  try {
    const local = channel.getSessionBinding?.();
    if (!validBinding(local)) throw new Error('peer HELLO requires an authenticated transport binding');
    binding = { .../** @type {SessionBinding} */ (local) };
  } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); return; }

  const verifyProof = async () => {
    if (settled || !remoteHello || !remoteProof || verifyingProof) return;
    verifyingProof = true;
    const env = remoteProof;
    const b = env.body;
    if (env.from !== remoteHello.from || b.to !== identity.did
        || b.hello !== remoteHello.id || b.challenge !== helloId
        || b.binding.kind !== binding.kind || b.binding.streamId !== binding.streamId
        || b.binding.localFingerprint !== binding.remoteFingerprint
        || b.binding.remoteFingerprint !== binding.localFingerprint) {
      finish(new Error('peer HELLO proof does not match this channel')); return;
    }
    if (!(await verifyEnvelope(env))) { if (!settled) finish(new Error('peer HELLO proof signature invalid')); return; }
    if (settled) return;
    proofReceived = true;
    complete();
  };
  const sendProof = async () => {
    if (settled || !remoteHello || !helloSent || proofStarted) return;
    proofStarted = true;
    const env = await signEnvelope(buildEnvelope({ ch: 0, typ: 1, from: identity.did,
      body: { proto: 2, to: remoteHello.from, hello: helloId, challenge: remoteHello.id, binding: { ...binding } },
      id: newId(), ts: now(),
    }), identity);
    if (settled) return;
    await channel.send({ __t: 'HELLO_PROOF', env }, { signal, priority: 'control' });
    if (settled) return;
    proofSent = true;
    complete();
  };
  /** @param {unknown} error */
  const fail = (error) => finish(error instanceof Error ? error : new Error(String(error)));
  /** @param {any} msg */
  const receive = async (msg) => {
    if (settled) return;
    if (msg?.__t === 'HELLO') {
      if (helloStarted) return;
      helloStarted = true;
      const env = msg.env;
      if (env?.body?.proto !== 2) { finish(new Error('unsupported peer protocol: upgrade required (protocol 2)')); return; }
      if (!validEnvelope(env, 0) || !exactKeys(env.body, ['proto', 'caps'])
          || !Array.isArray(env.body.caps) || env.body.caps.length > 32
          || !env.body.caps.every((/** @type {any} */ cap) => typeof cap === 'string' && cap.length <= 64)) {
        finish(new Error('invalid peer HELLO envelope')); return;
      }
      if (env.id === helloId) { finish(new Error('peer HELLO reflected local challenge')); return; }
      // why: local/in-process transports can share object references. Verify
      // and retain an owned snapshot so later mutation cannot change identity.
      const owned = { ...env, body: { ...env.body, caps: [...env.body.caps] } };
      if (!(await verifyEnvelope(owned))) { if (!settled) finish(new Error('peer HELLO signature invalid')); return; }
      if (settled) return;
      remoteHello = owned;
      await Promise.all([sendProof(), verifyProof()]);
      return;
    }
    if(msg?.__t==='ADMISSION_COMMIT'){
      if(remoteCommit)return;
      const env=msg.env;
      if(!caps.includes(ADMISSION_READY)||!validEnvelope(env,3)||!exactKeys(env.body,['ready','peerReady','digest'])
        ||typeof env.body.ready!=='string'||!NONCE.test(env.body.ready)
        ||typeof env.body.peerReady!=='string'||!NONCE.test(env.body.peerReady)
        ||!(env.body.digest===null||(typeof env.body.digest==='string'&&HASH.test(env.body.digest)))){
        finish(new Error('invalid admission commit'));return;
      }
      remoteCommit={...env,body:{...env.body}};complete();return;
    }
    if(msg?.__t==='ADMISSION_READY'){
      if(remoteReady)return;
      const env=msg.env;
      if(!validEnvelope(env,2)||!exactKeys(env.body,['proto','to','hello','challenge','binding','victim'])
        ||env.body.proto!==2||!(env.body.victim===null||(typeof env.body.victim==='string'&&env.body.victim.length>0&&env.body.victim.length<=128&&env.body.victim!==identity.did&&env.body.victim!==env.from))||typeof env.body.to!=='string'||env.body.to.length>128
        ||typeof env.body.hello!=='string'||!NONCE.test(env.body.hello)
        ||typeof env.body.challenge!=='string'||!NONCE.test(env.body.challenge)||!validBinding(env.body.binding)){
        finish(new Error('invalid admission readiness'));return;
      }
      remoteReady={...env,body:{...env.body,binding:{...env.body.binding}}};complete();return;
    }
    if (msg?.__t === 'HELLO_PROOF') {
      if (remoteProof) return;
      const env = msg.env;
      if (!validEnvelope(env, 1) || !exactKeys(env.body, ['proto', 'to', 'hello', 'challenge', 'binding'])
          || env.body.proto !== 2 || typeof env.body.to !== 'string' || env.body.to.length > 128
          || typeof env.body.hello !== 'string' || !NONCE.test(env.body.hello)
          || typeof env.body.challenge !== 'string' || !NONCE.test(env.body.challenge)
          || !validBinding(env.body.binding)) {
        finish(new Error('invalid peer HELLO proof')); return;
      }
      remoteProof = { ...env, body: { ...env.body, binding: { ...env.body.binding } } };
      await verifyProof();
      return;
    }
    // why: eager authenticated peers may start traffic while our crypto finishes,
    // but an unauthenticated sender cannot retain unlimited frames or bytes.
    if (stashed.length >= 16) { finish(new Error('peer HELLO backlog exceeded')); return; }
    const encoded = JSON.stringify(msg);
    stashedBytes += typeof encoded === 'string' ? new TextEncoder().encode(encoded).length : 0;
    if (stashedBytes > 1_048_576) { finish(new Error('peer HELLO backlog exceeded')); return; }
    stashed.push(msg);
  };
  channel.setHandler((/** @type {any} */ msg) => { receive(msg).catch(fail); });
  offClose = channel.onClose?.(() => finish(new Error('peer closed during HELLO'))) ?? offClose;
  if (settled) { offClose(); return; }
  signEnvelope(buildEnvelope({ ch: 0, typ: 0, from: identity.did,
    body: { proto: 2, caps }, id: helloId, ts: now(),
  }), identity).then(async (hello) => {
    if (settled) return;
    await channel.send({ __t: 'HELLO', env: hello }, { signal, priority: 'control' });
    if (settled) return;
    helloSent = true;
    await sendProof();
  }).catch(fail);
});
