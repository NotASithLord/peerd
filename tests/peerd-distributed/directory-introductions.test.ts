import {test,expect} from 'bun:test';
import {createDirectoryIntroductions,INTRODUCTION_LIMIT,INTRODUCTION_TTL_MS} from '../../extension/peerd-distributed/transport/directory-introductions.js';
const offer=(sid='s',purpose='content')=>({from:'reader',to:'provider',via:'carrier-generation-1',sid,kind:'offer',payload:{type:'offer',purpose,sdp:'offer'}});
const answer=(sid='s')=>({from:'provider',to:'reader',via:'carrier-generation-1',sid,kind:'answer',payload:{type:'answer',sdp:'answer'}});
const ice=(sid='s')=>({...answer(sid),kind:'ice',payload:{ice:{candidate:'candidate'}}});

test('directory introductions reject routing offers and require exact peer/session/carrier correlation',()=>{
 const gate=createDirectoryIntroductions();
 expect(gate.allow(offer('routing','routing'))).toBe(false);
 expect(gate.allow(answer())).toBe(false);
 expect(gate.allow(offer())).toBe(true);
 expect(gate.allow({...answer(),from:'other'})).toBe(false);
 expect(gate.allow({...answer(),via:'carrier-generation-2'})).toBe(false);
 expect(gate.allow({...answer(),from:'reader',to:'provider'})).toBe(false);
 expect(gate.allow(answer('other-session'))).toBe(false);
 expect(gate.allow(ice())).toBe(true);
 expect(gate.allow(answer())).toBe(true);
 expect(gate.allow(answer())).toBe(false);
 expect(gate.allow({...ice(),from:'reader',to:'provider'})).toBe(true);
 expect(gate.allow({...ice(),kind:'message'})).toBe(false);
});
test('directory introduction admission and lifetime stay bounded under traffic',()=>{
 let now=0;const gate=createDirectoryIntroductions({now:()=>now});
 for(let i=0;i<INTRODUCTION_LIMIT;i++)expect(gate.allow(offer(String(i),'directory'))).toBe(true);
 expect(gate.allow(offer('overflow'))).toBe(false);
 now=INTRODUCTION_TTL_MS-1;expect(gate.allow(ice('0'))).toBe(true);
 now++;expect(gate.allow(ice('0'))).toBe(false);
 expect(gate.size()).toBe(0);
 expect(gate.allow(offer('fresh','lookup'))).toBe(true);
 gate.retire('carrier-generation-1');expect(gate.allow(answer('fresh'))).toBe(false);
 gate.close();expect(gate.allow(offer('closed'))).toBe(false);
});
test('directory introductions bound frame count and aggregate bytes without reopening duplicate offers',()=>{
 const gate=createDirectoryIntroductions();expect(gate.allow(offer())).toBe(true);
 expect(gate.allow(offer())).toBe(false);
 for(let i=0;i<127;i++)expect(gate.allow(ice())).toBe(true);
 expect(gate.allow(ice())).toBe(false);
 expect(gate.allow(offer('bytes'))).toBe(true);
 const large={...ice('bytes'),payload:{ice:{candidate:'x'.repeat(120000)}}};
 for(let i=0;i<8;i++)expect(gate.allow(large)).toBe(true);
 expect(gate.allow(large)).toBe(false);
 expect(gate.allow({...offer('oversize'),payload:{type:'offer',purpose:'content',sdp:'x'.repeat(128*1024)}})).toBe(false);
});
