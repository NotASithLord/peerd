import assert from 'node:assert/strict';

export const validateHosts = (hosts, { local = false, expectedSource = '', expectedRuntime = '' } = {}) => {
  assert(hosts.length >= 2, 'At least two hosts required');
  assert(hosts.every(host => /^[a-f0-9]{64}$/.test(host.machine)), 'Missing machine fingerprint');
  assert(hosts.every(host => /^[a-f0-9]{64}$/.test(host.source)), 'Missing source fingerprint');
  assert.equal(new Set(hosts.map(host => host.source)).size, 1, 'Hosts must run identical source bytes');
  assert(/^[a-f0-9]{64}$/.test(expectedSource ?? ''), 'Missing expected source fingerprint');
  assert(hosts.every(host => host.source === expectedSource), 'Hosts must match coordinator source bytes');
  assert(typeof expectedRuntime === 'string' && expectedRuntime.length > 0, 'Missing expected Bun runtime');
  assert(hosts.every(host => host.runtime === expectedRuntime), 'Hosts must use coordinator Bun runtime');
  assert(hosts.every(host => host.browser), 'Missing browser version');
  assert.equal(new Set(hosts.map(host => host.browser)).size, 1, 'Hosts must run the same browser version');
  if (!local) {
    assert(hosts.every(host => host.platform === 'darwin'), 'Physical Mac lane requires macOS');
    assert.equal(new Set(hosts.map(host => host.machine)).size, hosts.length, 'Hosts must be different physical machines');
  }
};

export const validatePaths = (paths, expectedDids, { local = false } = {}) => {
  assert.deepEqual(paths.map(path => path.did).sort(), [...expectedDids].sort(), 'Every expected peer needs ICE evidence');
  for (const path of paths) {
    assert.equal(path.state, 'succeeded', 'ICE pair must succeed');
    assert(path.bytesSent > 0 && path.bytesReceived > 0, 'ICE must carry bidirectional traffic');
    assert(path.local?.address && path.local.protocol === 'udp' && path.local.type === 'host', 'Expected local host UDP candidate');
    assert(path.remote?.protocol === 'udp' && ['host', 'prflx'].includes(path.remote.type), 'Expected direct remote UDP candidate');
    assert(!/^(127\.|::1$|0\.0\.0\.0$|localhost$)/i.test(path.local.address), 'Loopback cannot prove cross-host traffic');
    if (path.remote.address) {
      assert(!/^(127\.|::1$|0\.0\.0\.0$|localhost$)/i.test(path.remote.address), 'Loopback cannot prove cross-host traffic');
      if (!local) assert.notEqual(path.local.address, path.remote.address, 'Peer addresses must differ');
    } else assert.equal(path.remote.type, 'prflx', 'Only a peer-reflexive candidate may redact its address');
  }
};

export const pathsReady = (pathSets, expectedDidsByHost, options = {}) => {
  try {
    pathSets.forEach((paths, index) => validatePaths(paths, expectedDidsByHost[index], options));
    return true;
  } catch { return false; }
};

export const validateMesh = (states, dids, { topology = 'all-pairs' } = {}) => {
  assert.equal(states.length, dids.length, 'Every host needs a mesh report');
  assert(['all-pairs', 'connected'].includes(topology), 'Unsupported topology');
  const known = new Set(dids);
  const adjacency = states.map((state, index) => {
    assert.equal(state.did, dids[index], 'Mesh report identity changed');
    const peers = state.peers.filter(peer => peer.linked).map(peer => peer.did);
    assert.equal(new Set(peers).size, peers.length, 'Duplicate linked peer');
    assert(peers.every(did => known.has(did) && did !== dids[index]), 'Unknown linked peer');
    return peers;
  });
  adjacency.forEach((peers, index) => peers.forEach(did => {
    const other = dids.indexOf(did);
    assert(adjacency[other].includes(dids[index]), 'Mesh links must be symmetric');
  }));
  if (topology === 'all-pairs') {
    adjacency.forEach((peers, index) => assert.deepEqual(peers.sort(), dids.filter((_, peer) => peer !== index).sort(), 'Full mesh incomplete'));
  } else {
    const seen = new Set([dids[0]]);
    const queue = [dids[0]];
    while (queue.length) for (const peer of adjacency[dids.indexOf(queue.shift())]) {
      if (!seen.has(peer)) { seen.add(peer); queue.push(peer); }
    }
    assert.equal(seen.size, dids.length, 'Mesh graph is disconnected');
  }
  return adjacency;
};
