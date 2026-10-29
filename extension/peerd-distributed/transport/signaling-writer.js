// @ts-check
// why: a room shares one bootstrap socket across all concurrent ICE attempts.
// Bound that aggregate burst, retained bytes, and ownership independently of
// per-attempt limits. Cancellation never refunds already-spent rate credit.
// Admit one description per bounded introduction before pacing ICE trickle.
export const SIGNALING_BURST = 16;
export const SIGNALING_INTERVAL_MS = 250;
export const SIGNALING_QUEUE_FRAMES = 32;
export const SIGNALING_QUEUE_BYTES = 256 * 1024;
export const SIGNALING_FRAME_BYTES = 64 * 1024;
export class SignalingWriteError extends Error {
  /** @param {string} reason */
  constructor(reason) { super(`signaling write ${reason}`); this.name = 'SignalingWriteError'; }
}
/** @param {{write:(text:string)=>void,buffered?:()=>number,now?:()=>number,timers?:any}} options */
export const createSignalingWriter = ({write,buffered=()=>0,now=Date.now,timers=globalThis}) => {
  let closed=false, bytes=0, tokens=SIGNALING_BURST, last=now();
  /** @type {any} */ let timer;
  /** @type {Array<{text:string,size:number,signal?:AbortSignal,resolve:()=>void,reject:(e:Error)=>void,cancel:()=>void}>} */ const queue=[];
  const refill=()=>{const current=now();tokens=Math.min(SIGNALING_BURST,tokens+Math.max(0,current-last)/SIGNALING_INTERVAL_MS);last=Math.max(last,current);};
  const detach=(/** @type {typeof queue[number]} */ entry)=>{bytes-=entry.size;entry.signal?.removeEventListener('abort',entry.cancel);};
  const schedule=()=>{
    if(closed||!queue.length||timer!==undefined)return;
    timer=timers.setTimeout(()=>{timer=undefined;drain();},Math.max(1,Math.ceil((1-tokens)*SIGNALING_INTERVAL_MS)));
  };
  const drain=()=>{
    refill();
    while(queue.length&&tokens>=1&&!closed){
      const entry=queue.shift();if(!entry)break;detach(entry);
      if(entry.signal?.aborted){entry.reject(new SignalingWriteError('cancelled'));continue;}
      const nativeBytes=buffered();
      if(!Number.isFinite(nativeBytes)||nativeBytes<0||nativeBytes+entry.size>SIGNALING_QUEUE_BYTES){entry.reject(new SignalingWriteError('backpressure'));continue;}
      tokens--;
      try{write(entry.text);entry.resolve();}catch{entry.reject(new SignalingWriteError('failed'));}
    }
    schedule();
  };
  return {
    /** @param {any} message @param {{signal?:AbortSignal}} [options] */
    send(message,{signal}={}){
      if(closed||signal?.aborted)return Promise.reject(new SignalingWriteError('cancelled'));
      let text;
      try{text=JSON.stringify(message);}catch{return Promise.reject(new SignalingWriteError('encoding'));}
      if(typeof text!=='string'||text.length>SIGNALING_FRAME_BYTES)return Promise.reject(new SignalingWriteError('frame capacity'));
      const size=new TextEncoder().encode(text).length;
      if(size>SIGNALING_FRAME_BYTES||queue.length>=SIGNALING_QUEUE_FRAMES||bytes+size>SIGNALING_QUEUE_BYTES)return Promise.reject(new SignalingWriteError('capacity'));
      return new Promise((resolve,reject)=>{
        const entry={text,size,signal,resolve:()=>resolve(undefined),reject,cancel:()=>{
          const index=queue.indexOf(entry);if(index<0)return;
          queue.splice(index,1);detach(entry);reject(new SignalingWriteError('cancelled'));
          if(!queue.length&&timer!==undefined){timers.clearTimeout(timer);timer=undefined;}
        }};
        bytes+=size;queue.push(entry);signal?.addEventListener('abort',entry.cancel,{once:true});drain();
      });
    },
    close(){if(closed)return;closed=true;timers.clearTimeout(timer);timer=undefined;
      for(const entry of queue.splice(0)){detach(entry);entry.reject(new SignalingWriteError('closed'));}},
    stats:()=>({queued:queue.length,bytes,closed}),
  };
};
