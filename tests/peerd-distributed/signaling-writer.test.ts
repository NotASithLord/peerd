import {test,expect} from 'bun:test';
import {createSignalingWriter,SIGNALING_BURST,SIGNALING_QUEUE_FRAMES,SIGNALING_QUEUE_BYTES} from '../../extension/peerd-distributed/transport/signaling-writer.js';
function clock(){
 let now=0,next=0;const tasks=new Map<number,{at:number,run:()=>void}>();
 return {now:()=>now,timers:{setTimeout:(run:()=>void,delay:number)=>{const id=++next;tasks.set(id,{at:now+delay,run});return id;},clearTimeout:(id:number)=>tasks.delete(id)},
 advance:(ms:number)=>{const target=now+ms;while(true){const item=[...tasks].sort((a,b)=>a[1].at-b[1].at)[0];if(!item||item[1].at>target)break;now=item[1].at;tasks.delete(item[0]);item[1].run();}now=target;},pending:()=>tasks.size};
}
test('shared signaling burst stays under bootstrap rate and preserves description/candidate ordering',async()=>{
 const c=clock(),sent:{at:number,value:number}[]=[];
 const w=createSignalingWriter({...c,write:text=>sent.push({at:c.now(),value:JSON.parse(text).n})});
 const pending=Array.from({length:40},(_,n)=>w.send({n}));
 expect(sent.length).toBe(SIGNALING_BURST);c.advance(10_000);await Promise.all(pending);
 expect(sent.map(x=>x.value)).toEqual(Array.from({length:40},(_,n)=>n));
 for(const start of sent.map(x=>x.at))expect(sent.filter(x=>x.at>=start&&x.at<start+10_000).length).toBeLessThan(120);
 w.close();expect(c.pending()).toBe(0);
});
test('cancelling one ICE owner removes its queued bytes without cancelling another owner or refunding spent credit',async()=>{
 const c=clock(),sent:number[]=[];const w=createSignalingWriter({...c,write:text=>sent.push(JSON.parse(text).n)});
 await Promise.all(Array.from({length:SIGNALING_BURST},(_,n)=>w.send({n})));
 const ac=new AbortController();const cancelled=w.send({n:100},{signal:ac.signal}).catch(e=>e.message);
 const survivor=w.send({n:101});ac.abort();expect(await cancelled).toContain('cancelled');
 expect(w.stats().queued).toBe(1);c.advance(249);expect(sent).not.toContain(101);c.advance(1);await survivor;
 expect(sent).not.toContain(100);expect(sent.at(-1)).toBe(101);expect(w.stats().bytes).toBe(0);w.close();
});
test('writer bounds UTF8 frames, retained bytes, queue length and native backpressure',async()=>{
 const c=clock();let buffered=0;const w=createSignalingWriter({...c,write:()=>{},buffered:()=>buffered});
 await expect(w.send('🙂'.repeat(20_000))).rejects.toThrow('capacity');
 await Promise.all(Array.from({length:SIGNALING_BURST},()=>w.send('x')));
 const queued=Array.from({length:SIGNALING_QUEUE_FRAMES},()=>w.send('x').catch(e=>e.message));
 await expect(w.send('overflow')).rejects.toThrow('capacity');w.close();await Promise.all(queued);expect(c.pending()).toBe(0);
 const b=createSignalingWriter({...c,write:()=>{},buffered:()=>buffered});
 await Promise.all(Array.from({length:SIGNALING_BURST},()=>b.send('x')));
 const large=Array.from({length:4},()=>b.send('x'.repeat(60_000)).catch(e=>e.message));
 await expect(b.send('x'.repeat(60_000))).rejects.toThrow('capacity');expect(b.stats().bytes).toBeLessThanOrEqual(SIGNALING_QUEUE_BYTES);
 b.close();await Promise.all(large);expect(b.stats().bytes).toBe(0);
 buffered=SIGNALING_QUEUE_BYTES;const n=createSignalingWriter({...c,write:()=>{throw new Error('must not write');},buffered:()=>buffered});
 await expect(n.send('x')).rejects.toThrow('backpressure');n.close();
});
