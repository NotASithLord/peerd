import { expect, test } from 'bun:test';
import { discoveryAddress } from '../../extension/home/discovery-address.js';
import { encodeDidKey } from '../../extension/shared/address/did.js';
import { immutableAppRoot } from '../../extension/shared/address/immutable-app-root.js';

const publisher = encodeDidKey(new Uint8Array(32));
const version_id = 'a'.repeat(64);
const app = { publisher, version_id, uri: `peerd://${publisher}/${version_id}` };

test('verified discovery coordinates produce a publisher-qualified exact root accepted by manual inspection', () => {
  const address = discoveryAddress(app)!;
  expect(immutableAppRoot(address)).toEqual({ address, publisher, hash: version_id, uri: app.uri });
  expect(new URL(address).hostname).toBe('content');
});

test('incomplete or inconsistent discovery metadata never falls back to a mutable or unverified address', () => {
  for (const candidate of [
    {}, { ...app, publisher: undefined }, { ...app, version_id: undefined }, { ...app, uri: undefined },
    { ...app, publisher: 'did:key:zInvalid' }, { ...app, version_id: 'a'.repeat(12) },
    { ...app, uri: `peerd://${publisher}/${'b'.repeat(64)}` },
    { ...app, uri: `peerd://${version_id}` }, { ...app, uri: `${app.uri}/index.html` },
    { ...app, uri: `${app.uri}?rev=latest` }, { ...app, uri: `${app.uri}#fragment` },
    { from: publisher, version_id, uri: app.uri },
  ]) expect(discoveryAddress(candidate)).toBeNull();
  const other = encodeDidKey(new Uint8Array(32).fill(1));
  expect(discoveryAddress({ ...app, publisher: other })).toBeNull();
});
