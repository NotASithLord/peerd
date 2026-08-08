// The id.peerd.ai ceremony handoff (docs/design/portable-identity/ 04):
// request mint → page-side seal → extension-side open, with the
// challenge/tamper/replay refusals that make the fragment transport
// safe, the PRF-wrapper integration (the response unlocks a record),
// and the byte-equality lock on the page's protocol copy.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createHandoffRequest, buildCeremonyUrl, parseCeremonyRequest,
  sealHandoffResponse, buildReturnUrl, extractSealedResponse, openHandoffResponse,
  IDENTITY_RP_ORIGIN, IDENTITY_RP_ID,
} from '../../extension/peerd-distributed/identity/handoff.js';
import { buildIdentityRecord, openIdentityRecord } from '../../extension/peerd-distributed/identity/recovery-record.js';
import { mintKeypairMaterial } from '../../extension/peerd-distributed/identity/keypair.js';

const roundTrip = async (flow: 'register' | 'get') => {
  const { request, privateKey, challenge } = await createHandoffRequest({ flow });
  // The page parses the request back off the URL the extension opened.
  const url = buildCeremonyUrl(IDENTITY_RP_ORIGIN, request);
  const parsed = parseCeremonyRequest(new URL(url).hash);
  if (!parsed) throw new Error('expected a parsed request');
  // The page runs the ceremony (faked PRF result) and seals it.
  const prfOutput = crypto.getRandomValues(new Uint8Array(32));
  const sealed = await sealHandoffResponse({
    request: parsed, prfOutput, credentialId: 'Y3JlZA==', transports: ['internal'],
  });
  // The extension pulls it off the watched tab URL and opens it.
  const returned = extractSealedResponse(buildReturnUrl(IDENTITY_RP_ORIGIN, sealed));
  if (!returned) throw new Error('expected a sealed response on the return url');
  const opened = await openHandoffResponse({ sealedResponse: returned, privateKey, challenge });
  return { prfOutput, opened, parsed, privateKey, challenge };
};

describe('ceremony handoff', () => {
  test('register flow round-trips the PRF output end to end', async () => {
    const { prfOutput, opened } = await roundTrip('register');
    expect(Buffer.from(opened.prfOutput).equals(Buffer.from(prfOutput))).toBe(true);
    expect(opened.credentialId).toBe('Y3JlZA==');
    expect(opened.transports).toEqual(['internal']);
  });

  test('the RP anchors are the decided constants', () => {
    expect(IDENTITY_RP_ID).toBe('peerd.ai');
    expect(new URL(IDENTITY_RP_ORIGIN).hostname.endsWith(IDENTITY_RP_ID)).toBe(true);
  });

  test('a response sealed for one request cannot answer another (challenge binding)', async () => {
    const a = await createHandoffRequest({ flow: 'get' });
    const b = await createHandoffRequest({ flow: 'get' });
    const sealed = await sealHandoffResponse({
      request: parseCeremonyRequest(new URL(buildCeremonyUrl(IDENTITY_RP_ORIGIN, a.request)).hash),
      prfOutput: new Uint8Array(32).fill(1),
    });
    // Wrong ephemeral key + wrong challenge → authentication fails outright.
    await expect(openHandoffResponse({
      sealedResponse: sealed, privateKey: b.privateKey, challenge: b.challenge,
    })).rejects.toMatchObject({ code: 'open-failed' });
  });

  test('a tampered ciphertext is refused', async () => {
    const { privateKey, challenge, parsed } = await roundTrip('get');
    const sealed = await sealHandoffResponse({ request: parsed, prfOutput: new Uint8Array(32).fill(9) });
    const envelope = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0))));
    envelope.ct = `${envelope.ct.slice(0, -4)}AAAA`;
    const tampered = btoa(JSON.stringify(envelope));
    await expect(openHandoffResponse({ sealedResponse: tampered, privateKey, challenge }))
      .rejects.toMatchObject({ code: 'open-failed' });
  });

  test('oversized or malformed fragments are refused before crypto', async () => {
    expect(() => parseCeremonyRequest(`#req=${'A'.repeat(10_000)}`)).toThrow();
    expect(parseCeremonyRequest('#nonsense')).toBeNull();
    expect(extractSealedResponse('not a url')).toBeNull();
    expect(extractSealedResponse(`${IDENTITY_RP_ORIGIN}/#req=abc`)).toBeNull();
  });

  test('the ceremony PRF output opens a passkey-wrapped record (the recovery path)', async () => {
    const material = await mintKeypairMaterial();
    const { prfOutput } = await roundTrip('register');
    const record = await buildIdentityRecord({
      material,
      wrappers: [
        { kind: 'passphrase', passphrase: 'paper-backup' },
        { kind: 'passkey-prf', prfOutput, credentialId: 'Y3JlZA==', transports: ['internal'] },
      ],
    });
    const viaPasskey = await openIdentityRecord(record, { prfOutput });
    expect(viaPasskey.did).toBe(material.did);
    // …and a wrong passphrase still opens nothing on the same record.
    await expect(openIdentityRecord(record, { passphrase: 'guess' })).rejects.toThrow();
  });
});

describe('the page copy is the module, byte for byte', () => {
  test('web-identity/handoff.js === extension/peerd-distributed/identity/handoff.js', () => {
    const root = join(import.meta.dir, '..', '..');
    const module_ = readFileSync(join(root, 'extension/peerd-distributed/identity/handoff.js'), 'utf8');
    const copy = readFileSync(join(root, 'web-identity/handoff.js'), 'utf8');
    expect(copy).toBe(module_);
  });
});
