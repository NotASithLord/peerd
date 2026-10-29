import {describe, expect, test} from 'bun:test';
import {validateCapacityHosts, capacityTopology, capacityPathsReady} from '../../scripts/cdp/dweb-capacity-evidence.mjs';
import {validateHosts} from '../../scripts/cdp/dweb-cluster-checks.mjs';

const source = 'a'.repeat(64);
const options = {expectedSource:source, expectedRuntime:'test'};
const hosts = [0,1,2].map(index => ({machine:(index === 2 ? 'c' : 'b').repeat(64),
  source, runtime:'test', browser:'test-browser', platform:'darwin', browserPid:index+10,
  profileFingerprint:String(index).repeat(64)}));
const dids = ['a','b','c'];
const states = dids.map((did,index) => ({did,peers: dids.filter((_,other) => other !== index)
  .map(did => ({did,linked:true}))}));
const adjacency = dids.map(did => dids.filter(other => other !== did));
const path = (did:string, local:string, remote:string) => ({did,state:'succeeded',bytesSent:1,bytesReceived:1,
  local:{address:local,protocol:'udp',type:'host'},remote:{address:remote,protocol:'udp',type:'host'}});
const paths = [
  [path('b','192.0.2.1','192.0.2.1'),path('c','192.0.2.1','192.0.2.2')],
  [path('a','192.0.2.1','192.0.2.1'),path('c','192.0.2.1','192.0.2.2')],
  [path('a','192.0.2.2','192.0.2.1'),path('b','192.0.2.2','192.0.2.1')],
];

describe('explicit shared-host capacity evidence', () => {
  test('separates hardware from browser count without relaxing the physical lane', () => {
    expect(validateCapacityHosts(hosts, options)).toEqual({physicalHosts:2,browserProcesses:3});
    expect(() => validateHosts(hosts, options)).toThrow('different physical machines');
  });
  test('rejects reused processes, reused profiles, one host and stale source', () => {
    for (const replacement of [
      {...hosts[1],browserPid:hosts[0].browserPid},
      {...hosts[1],profileFingerprint:hosts[0].profileFingerprint},
      {...hosts[1],source:'d'.repeat(64)},
      {...hosts[1],browserPid:0},
    ]) expect(() => validateCapacityHosts([hosts[0],replacement,hosts[2]],options)).toThrow();
    expect(() => validateCapacityHosts(hosts.map(host => ({...host,machine:hosts[0].machine})),options)).toThrow('two physical hosts');
  });
  test('reports achieved degrees and edge placement rather than configured claims', () => {
    expect(capacityTopology(hosts,states,dids,2)).toEqual({physicalHosts:2,browserProcesses:3,
      logicalIdentities:3,configuredDegree:2,achievedDegrees:[2,2,2],crossHostEdges:2,sameHostEdges:1});
    expect(() => capacityTopology(hosts,states,dids,1)).toThrow('exceeded');
    expect(() => capacityTopology(hosts,states,dids,3)).toThrow('membership above');
    expect(() => capacityTopology(hosts,[states[0],states[1],{did:'c',peers:[]}],dids,2)).toThrow();
  });
  test('classifies same-host UDP separately and retains cross-host path requirements', () => {
    expect(capacityPathsReady(paths,adjacency,hosts,dids)).toBe(true);
    const invalid = structuredClone(paths);
    invalid[0]![1]!.remote.address = '192.0.2.1';
    expect(capacityPathsReady(invalid,adjacency,hosts,dids)).toBe(false);
    invalid[0]![1]!.remote.address = '127.0.0.1';
    expect(capacityPathsReady(invalid,adjacency,hosts,dids)).toBe(false);
    expect(capacityPathsReady(paths.slice(1),adjacency,hosts,dids)).toBe(false);
  });
});
