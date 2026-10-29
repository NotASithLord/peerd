// @ts-check
// A separately negotiated directory broker may introduce temporary carriers.
// This gate grants no membership, gossip, arbitrary relay, or routing-dial role.
export const DIRECTORY_INTRODUCTIONS = 'directory-introductions-v1';
export const INTRODUCTION_LIMIT = 8;
export const INTRODUCTION_TTL_MS = 10_000;
const FRAME_LIMIT = 128;
const BYTE_LIMIT = 1024 * 1024;
const encoder = new TextEncoder();

/** @param {{now?:()=>number}} [options] */
export const createDirectoryIntroductions = ({now=Date.now}={}) => {
  /** @type {Map<string,{from:string,to:string,via:string,expires:number,frames:number,bytes:number,answered:boolean}>} */
  const sessions = new Map();
  let closed = false;
  const sweep = () => { for (const [key, value] of sessions) if (now() >= value.expires) sessions.delete(key); };
  /** @param {string} from @param {string} to @param {string} sid */
  const keyFor = (from,to,sid) => JSON.stringify([[from,to].sort(),sid]);
  const identifier = (/** @type {unknown} */ value) => typeof value === 'string' && value.length > 0 && value.length <= 512;
  return {
    // Called only after signature and immediate-hop provenance verification.
    // via binds the session to the negotiated directory carrier, not just DID.
    /** @param {{from:string,to:string,via:string,kind:string,sid:string,payload:any}} frame */
    allow({from,to,via,kind,sid,payload}) {
      if (closed || !identifier(from) || !identifier(to) || !identifier(via) || !identifier(sid) || from === to) return false;
      sweep();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
      let bytes;
      try { bytes=encoder.encode(JSON.stringify(payload)).byteLength; } catch { return false; }
      if (bytes > 128 * 1024) return false;
      const key=keyFor(from,to,sid);
      if (kind === 'offer') {
        if (payload.type !== 'offer' || typeof payload.sdp !== 'string'
          || !['content','lookup','directory'].includes(payload.purpose)
          || sessions.has(key) || sessions.size >= INTRODUCTION_LIMIT) return false;
        sessions.set(key,{from,to,via,expires:now()+INTRODUCTION_TTL_MS,frames:1,bytes,answered:false});
        return true;
      }
      const session=sessions.get(key);
      if (!session || session.via !== via || session.frames >= FRAME_LIMIT || session.bytes+bytes > BYTE_LIMIT) return false;
      if (kind === 'answer') {
        if (session.answered || from !== session.to || to !== session.from || payload.type !== 'answer' || typeof payload.sdp !== 'string') return false;
        session.answered=true;
      } else if (kind === 'ice') {
        // Candidate details are opaque to the broker but bounded and bound to
        // the signed session. Both sides may trickle before an answer arrives.
        if (Object.keys(payload).length !== 1 || !payload.ice || typeof payload.ice !== 'object'
          || Array.isArray(payload.ice) || typeof payload.ice.candidate !== 'string') return false;
      } else return false;
      session.frames++;session.bytes+=bytes;
      return true;
    },
    /** @param {string} via */
    retire(via) { for (const [key, value] of sessions) if (value.via===via) sessions.delete(key); },
    size() { sweep();return sessions.size; },
    close() { closed=true;sessions.clear(); },
  };
};
