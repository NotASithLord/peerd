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
    assert(path.bytesSent > 0 && path.bytesReceived > 0, 'ICE transport must carry bidirectional traffic');
    for (const candidate of [path.local, path.remote]) {
      assert(candidate?.address && candidate.protocol === 'udp' && candidate.type === 'host', 'Expected direct host UDP candidate');
      assert(!/^(127\.|::1$|0\.0\.0\.0$|localhost$)/i.test(candidate.address), 'Loopback cannot prove cross-host traffic');
    }
    if (!local) assert.notEqual(path.local.address, path.remote.address, 'Peer addresses must differ');
  }
};
