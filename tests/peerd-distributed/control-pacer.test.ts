import {test,expect} from 'bun:test';
import {createControlPacer,CONTROL_BURST,CONTROL_WAITERS} from '../../extension/peerd-distributed/transport/control-pacer.js';
function clock(){
 let now=0,next=0;const tasks=new Map<number,{at:number,run:()=>void}>();
 return {now:()=>now,timers:{setTimeout:(run:()=>void,delay:number)=>{const id=++next;tasks.set(id,{at:now+delay,run});return id;},clearTimeout:(id:number)=>tasks.delete(id)},
 advance:(ms:number)=>{const target=now+ms;while(true){const item=[...tasks].sort((a,b)=>a[1].at-b[1].at)[0];if(!item||item[1].at>target)break;now=item[1].at;tasks.delete(item[0]);item[1].run();}now=target;},pending:()=>tasks.size};
}
test('control pacing stays below receiver windows without dropping queued frames',async()=>{
 const c=clock(),p=createControlPacer(c);let sent=0;
 await Promise.all(Array.from({length:CONTROL_BURST},()=>p.take().then(()=>sent++)));expect(sent).toBe(8);
 const queued=Array.from({length:CONTROL_WAITERS},()=>p.take().then(()=>sent++));
 c.advance(249);await Promise.resolve();expect(sent).toBe(8);
 c.advance(1);await Promise.resolve();expect(sent).toBe(9);
 c.advance(7750);await Promise.all(queued);expect(sent).toBe(40);expect(p.stats().queued).toBe(0);
 c.advance(2000);await Promise.all(Array.from({length:8},()=>p.take().then(()=>sent++)));expect(sent).toBe(48);
 p.close();expect(c.pending()).toBe(0);
});
test('pacing bounds waiters and cancellation preserves other senders',async()=>{
 const c=clock(),p=createControlPacer(c);await Promise.all(Array.from({length:8},()=>p.take()));
 const ac=new AbortController();const cancelled=p.take({signal:ac.signal});const caught=cancelled.catch(e=>e.message);
 const pending=Array.from({length:31},()=>p.take());await expect(p.take()).rejects.toThrow('capacity');
 ac.abort();expect(await caught).toContain('cancelled');expect(p.stats().queued).toBe(31);
 c.advance(7750);await Promise.all(pending);p.close();expect(c.pending()).toBe(0);
});
test('retiring a carrier rejects every queued control send and clears its timer',async()=>{
 const c=clock(),p=createControlPacer(c);await Promise.all(Array.from({length:8},()=>p.take()));
 const pending=Array.from({length:5},()=>p.take().catch(e=>e.message));p.close();p.close();
 expect((await Promise.all(pending)).every(e=>e==='control pacing closed')).toBe(true);
 expect(c.pending()).toBe(0);await expect(p.take()).rejects.toThrow('cancelled');
});
