import assert from 'node:assert/strict';

// Churn may retire a snapshot edge before its turn. Such a non-attempt is not
// a successful conversation; every executed operation must still succeed and
// successful reciprocal conversations must connect the entire participant set.
export const validateConversations = (results, dids, {allowRetired=false}={}) => {
  const known=new Set(dids), directed=new Set();let retiredBeforeStart=0,completed=0;
  const key=(from,to)=>JSON.stringify([from,to]);
  for(const result of results){
    assert(known.has(result.from)&&known.has(result.to)&&result.from!==result.to,'Unknown conversation participant');
    if(result.skipped==='retired-before-start'){
      assert(allowRetired,'Retired snapshot exclusions require the explicit capacity lane');
      assert.equal(result.linkedBefore,false);assert.equal(result.first,null);assert.equal(result.second,null);
      retiredBeforeStart++;continue;
    }
    assert(!result.skipped,'Unknown conversation exclusion');
    assert.equal(result.linkedBefore,true,'Conversation started without a live link');
    assert.equal(result.first?.ok,true,'Conversation request failed');
    assert.equal(result.second?.ok,true,'Conversation followup failed');
    assert.equal(result.first.reply,`PONG:${result.nonce}`);
    assert.equal(result.second.reply,`PONG:${result.nonce}/followup`);
    assert(result.first.convId&&result.first.convId===result.second.convId,'Conversation identity changed');
    directed.add(key(result.from,result.to));completed++;
  }
  const neighbors=new Map(dids.map(did=>[did,[]]));
  for(const from of dids)for(const to of dids)if(directed.has(key(from,to))&&directed.has(key(to,from)))neighbors.get(from).push(to);
  const seen=new Set([dids[0]]),queue=[dids[0]];
  while(queue.length)for(const peer of neighbors.get(queue.shift())??[])if(!seen.has(peer)){seen.add(peer);queue.push(peer);}
  assert(dids.length>=2&&seen.size===dids.length,'Successful reciprocal conversations must connect every peer');
  return {completed,retiredBeforeStart,reciprocalEdges:[...neighbors.values()].reduce((sum,peers)=>sum+peers.length,0)/2};
};
