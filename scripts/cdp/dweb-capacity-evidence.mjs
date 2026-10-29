import assert from 'node:assert/strict';
import {validateHosts, validateMesh, validatePaths} from './dweb-cluster-checks.mjs';
import {sparsePublicProfile} from '../../extension/peerd-distributed/transport/rendezvous-profile.js';

export const validateCapacityConfig = config => {
  assert(sparsePublicProfile(config.roomId, config.profile), 'Capacity placement requires the production sparse profile on an isolated coordinator');
  assert.equal(config.topology, 'connected', 'Capacity preflight requires sparse connected topology');
  assert.equal(config.transferSlots ?? 0, 0, 'Capacity baseline keeps temporary reserve zero');
  const budget = config.budget ?? 16;
  assert(Number.isSafeInteger(budget) && budget > 0, 'Capacity budget must be positive');
  assert(config.hosts.length > budget, 'Capacity membership must exceed degree budget');
};

// A shared-host placement must be explicit; it never qualifies the distinct-Mac
// lane or proves WAN reachability. Each identity still owns a real browser.
export const validateCapacityHosts = (hosts, options) => {
  validateHosts(hosts, {...options, local:true});
  assert(hosts.every(host => host.platform === 'darwin'), 'Capacity placement requires Macs');
  const machines = new Set(hosts.map(host => host.machine));
  assert(machines.size >= 2, 'Capacity placement needs at least two physical hosts');
  const processes = new Set();
  const profiles = new Set();
  for (const host of hosts) {
    assert(Number.isSafeInteger(host.browserPid) && host.browserPid > 0, 'Missing browser process identity');
    assert(/^[a-f0-9]{64}$/.test(host.profileFingerprint ?? ''), 'Missing isolated profile identity');
    const process = `${host.machine}:${host.browserPid}`;
    const profile = `${host.machine}:${host.profileFingerprint}`;
    assert(!processes.has(process), 'A browser process cannot represent multiple peers');
    assert(!profiles.has(profile), 'Each browser requires its own profile');
    processes.add(process);
    profiles.add(profile);
  }
  return {physicalHosts:machines.size, browserProcesses:processes.size};
};

export const capacityTopology = (hosts, states, dids, budget) => {
  assert(Number.isSafeInteger(budget) && budget > 0, 'Capacity budget must be positive');
  assert(dids.length > budget, 'Sparse capacity placement requires membership above degree budget');
  assert.equal(new Set(dids).size, dids.length, 'Logical identities must be distinct');
  assert.equal(hosts.length, dids.length, 'Each browser must have one identity');
  const adjacency = validateMesh(states, dids, {topology:'connected'});
  const indices = new Map(dids.map((did, index) => [did,index]));
  const degrees = adjacency.map(peers => peers.length);
  assert(degrees.every(degree => degree <= budget), 'Active routing degree exceeded configured budget');
  let crossHostEdges = 0;
  let sameHostEdges = 0;
  adjacency.forEach((peers,index) => peers.forEach(did => {
    const other = indices.get(did);
    if (other <= index) return;
    if (hosts[index].machine === hosts[other].machine) sameHostEdges++;
    else crossHostEdges++;
  }));
  assert(crossHostEdges > 0, 'No cross-host routing edge');
  return {physicalHosts:new Set(hosts.map(host => host.machine)).size,
    browserProcesses:hosts.length, logicalIdentities:dids.length, configuredDegree:budget,
    achievedDegrees:degrees, crossHostEdges, sameHostEdges};
};

export const capacityPathsReady = (pathSets, adjacency, hosts, dids) => {
  try {
    assert.equal(pathSets.length, hosts.length, 'Each browser needs path evidence');
    pathSets.forEach((paths,index) => {
      validatePaths(paths, adjacency[index], {local:true});
      for (const path of paths) {
        const other = dids.indexOf(path.did);
        assert(other >= 0, 'Unknown peer path');
        // Retain the physical lane's stronger address test on every cross-host
        // edge. Same-host UDP is classified separately, not counted as remote.
        if (hosts[index].machine !== hosts[other].machine) validatePaths([path], [path.did]);
      }
    });
    return true;
  } catch { return false; }
};
