import {test,expect} from 'bun:test';
import {validateConversations} from '../../scripts/cdp/dweb-conversation-evidence.mjs';
const ok=(from:string,to:string)=>({from,to,nonce:'n',linkedBefore:true,
 first:{ok:true,reply:'PONG:n',convId:'c'},second:{ok:true,reply:'PONG:n/followup',convId:'c'}});
const connected=[ok('a','b'),ok('b','a'),ok('b','c'),ok('c','b')];
test('retired snapshot edges are explicit non-attempts; reciprocal successes still connect every participant',()=>{
 expect(validateConversations([...connected,{from:'a',to:'c',linkedBefore:false,skipped:'retired-before-start',first:null,second:null}],['a','b','c'],{allowRetired:true}))
 .toEqual({completed:4,retiredBeforeStart:1,reciprocalEdges:2});
});
test('failed sends, forged exclusions, one-way coverage and disconnected groups cannot pass',()=>{
 for(const bad of [
  {...ok('a','c'),first:{ok:false,error:'no link'}},
  {...ok('a','c'),skipped:'retired-before-start',linkedBefore:false},
  {from:'a',to:'c',skipped:'retired-before-start',linkedBefore:true,first:null,second:null},
  {...ok('a','c'),second:{ok:true,reply:'PONG:n/followup',convId:'wrong'}},
 ])expect(()=>validateConversations([...connected,bad],['a','b','c'],{allowRetired:true})).toThrow();
 expect(()=>validateConversations(connected.slice(0,3),['a','b','c'])).toThrow();
 expect(()=>validateConversations([ok('a','b'),ok('b','a'),ok('c','d'),ok('d','c')],['a','b','c','d'])).toThrow();
 expect(()=>validateConversations([],['a','b'])).toThrow();
});

test('ordinary physical and rehearsal lanes cannot exclude retired conversation edges',()=>{
 const retired={from:'a',to:'c',linkedBefore:false,skipped:'retired-before-start',first:null,second:null};
 expect(()=>validateConversations([...connected,retired],['a','b','c'])).toThrow('explicit capacity lane');
});
