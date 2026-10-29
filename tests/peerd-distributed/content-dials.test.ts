import {expect,test} from 'bun:test';
import {createContentDials} from '../../extension/peerd-distributed/transport/content-dials.js';
const turn=()=>new Promise(resolve=>queueMicrotask(()=>resolve(undefined)));

test('one cancelled consumer does not abort a shared pending dial',async()=>{
 const gate=Promise.withResolvers<{release:()=>void}>();let signal:AbortSignal|undefined;let calls=0,holdReleased=0,leases=0;
 const owner=createContentDials({limit:1,has:()=>false,acquire:()=>{leases++;return {release(){}};},connect:async(_via,_did,s)=>{signal=s;calls++;return gate.promise;}});
 const cancel=new AbortController();
 const first=owner.open('broker','target',{signal:cancel.signal});const rejected=first.catch(error=>error);
 const second=owner.open('broker','target');await turn();
 cancel.abort();expect((await rejected).message).toContain('cancelled');expect(signal!.aborted).toBe(false);expect(calls).toBe(1);
 gate.resolve({release(){holdReleased++;}});(await second).release();
 expect(leases).toBe(1);expect(holdReleased).toBe(1);owner.stop();
});

test('last cancellation aborts IO and releases any late success',async()=>{
 const gate=Promise.withResolvers<{release:()=>void}>();let signal:AbortSignal|undefined;let releases=0;
 const owner=createContentDials({limit:1,has:()=>false,acquire:()=>{throw new Error('abandoned caller cannot acquire');},connect:async(_via,_did,s)=>{signal=s;return gate.promise;}});
 const cancel=new AbortController();const pending=owner.open('broker','target',{signal:cancel.signal});const rejected=pending.catch(error=>error);await turn();
 cancel.abort();expect((await rejected).message).toContain('cancelled');expect(signal!.aborted).toBe(true);
 gate.resolve({release(){releases++;}});await turn();await turn();await turn();
 expect(releases).toBe(1);owner.stop();
});

test('stopping fences all waiters and target admission stays bounded',async()=>{
 const gate=Promise.withResolvers<{release:()=>void}>();let releases=0;
 const owner=createContentDials({limit:1,has:()=>false,acquire:()=>({release(){}}),connect:()=>gate.promise});
 const first=owner.open('broker','one');const second=owner.open('broker','one');
 const a=first.catch(error=>error),b=second.catch(error=>error);await turn();
 await expect(owner.open('broker','two')).rejects.toThrow('capacity');
 owner.stop();for(const error of await Promise.all([a,b]))expect(error.message).toContain('cancelled');await expect(owner.open('broker','one')).rejects.toThrow('cancelled');
 gate.resolve({release(){releases++;}});await turn();await turn();await turn();expect(releases).toBe(1);
});

test('one target cannot retain an unbounded number of pending consumers',async()=>{
 const gate=Promise.withResolvers<{release:()=>void}>();
 const owner=createContentDials({limit:1,has:()=>false,acquire:()=>({release(){}}),connect:()=>gate.promise});
 const waits=Array.from({length:32},()=>owner.open('broker','one').catch(error=>error));
 await expect(owner.open('broker','one')).rejects.toThrow('waiter capacity');
 owner.stop();for(const error of await Promise.all(waits))expect(error.message).toContain('cancelled');
 gate.resolve({release(){}});
});
