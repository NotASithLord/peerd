import {createHash} from 'node:crypto';
import {isIP} from 'node:net';

// Normalize native interface and ICE spellings without recording extra raw IPs.
export const candidateAddressHash = address => {
  if(typeof address !== 'string') return null;
  const value=address.split('%')[0].toLowerCase();
  const family=isIP(value);
  if(!family)return null;
  const normalized=family===6?new URL(`http://[${value}]/`).hostname:value;
  return createHash('sha256').update(normalized).digest('hex');
};
export const interfaceProof = (address, interfaces, machine, collectedAt) => {
  const hash=candidateAddressHash(address);
  if(!hash || !Object.values(interfaces).flat().some(entry=>entry&&!entry.internal&&candidateAddressHash(entry.address)===hash))return null;
  return {machine,addressHash:hash,collectedAt};
};
