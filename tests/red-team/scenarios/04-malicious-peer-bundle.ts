// Scenario 04: a malicious peer sends a hostile bundle over the dweb mesh.
//
// Adversary: a peer on the mesh serves a content bundle (a dwapp, data blob, or
// agent card) that is tampered, re-attributed, amplified to exhaust memory, or
// crafted to poison discovery.
//
// Defenses (peerd-distributed):
//   - Content addressing: a bundle's address is SHA-256 over the canonical
//     manifest, and the manifest commits to the ordered chunk hashes, so the
//     signature transitively covers every byte. Tamper any signed field (a chunk
//     hash, the size, the meta) and verifyManifest fails; the content address no
//     longer matches, so a tampered bundle cannot masquerade under a good address.
//   - Publisher authentication: a signed manifest binds the publisher did into
//     the signed bytes (domain-tagged, replay-resistant), so re-attributing a
//     bundle to a different did breaks the signature.
//   - Amplification/size-lie guard: assertBundleWithinLimits rejects a manifest
//     that declares more than the ceiling (including duplicate chunk refs that
//     reassemble N×) or whose size field under-reports its chunk list, BEFORE any
//     chunk is fetched.
//   - Poisoned-card containment: a peer agent-card is coerced-and-capped
//     (parsePeerCard), so a hostile card cannot blow past the name/desc/skill/byte
//     ceilings or forge a non-did:key identity.

import {
  type Scenario, type Probe, blocked, leaked, summarize,
} from '../harness.ts';
import { generateIdentity } from '../../../extension/peerd-distributed/identity/keypair.js';
import {
  buildManifest, verifyManifest, manifestHash, assertBundleWithinLimits,
  MAX_BUNDLE_BYTES,
} from '../../../extension/peerd-distributed/content/manifest.js';
import { parsePeerCard, MAX_CARD_NAME, MAX_SKILLS, MAX_CARD_BYTES } from '../../../extension/peerd-distributed/agent-card.js';
import { utf8 } from '../../../extension/shared/bundle/bytes.js';

export const scenario: Scenario = {
  id: '04-malicious-peer-bundle',
  title: 'Hostile peer bundle (tamper / re-attribute / amplify / poison)',
  adversary: 'malicious peer',
  asset: 'bundle integrity, publisher authenticity, and discovery-surface memory',
  claim: 'A tampered or re-attributed bundle fails signature verification and cannot reuse a good content address; an amplified/size-lying manifest is rejected before fetch; and a poisoned agent card is coerced within hard caps.',
  threatModelRef: 'INV-4',
  tier: 'unit',
  async run() {
    const probes: Probe[] = [];
    const payload = utf8('legit bundle content '.repeat(3000)); // spans chunks
    const publisher = await generateIdentity();
    const good = await buildManifest({ payload, entry: 'index.html', identity: publisher, now: () => 1 });

    // Control: the honest signed bundle verifies and its address commits to it.
    {
      const v = await verifyManifest(good.manifest);
      const addrCommits = (await manifestHash(good.manifest)) === good.hash;
      probes.push(v.ok && addrCommits
        ? blocked('control: an honest signed bundle', `verifyManifest ok; address commits to the manifest`)
        : leaked('control: an honest signed bundle', `ok=${v.ok} addrCommits=${addrCommits}`));
    }

    // 1) Tamper the chunk list: signature (which covers every byte) fails, and
    //    the content address changes so it can't reuse the good one.
    {
      const m = structuredClone(good.manifest) as any;
      m.chunks[0].hash = 'f'.repeat(64); // swap in an attacker chunk
      const v = await verifyManifest(m);
      const addrChanged = (await manifestHash(m)) !== good.hash;
      probes.push(v.ok === false && addrChanged
        ? blocked('swap a chunk for attacker content', `verifyManifest = false; content address changed (can't reuse the honest address)`)
        : leaked('swap a chunk for attacker content', `ok=${v.ok} addrChanged=${addrChanged}`));
    }

    // 2) Tamper a signed scalar field (size).
    {
      const m = structuredClone(good.manifest) as any;
      m.size = m.size + 1;
      const v = await verifyManifest(m);
      probes.push(v.ok === false
        ? blocked('tamper the signed size field', 'verifyManifest = false (bad_sig)')
        : leaked('tamper the signed size field', `ok=${v.ok}`));
    }

    // 3) Re-attribute the bundle to a different publisher did: signature breaks.
    {
      const other = await generateIdentity();
      const m = structuredClone(good.manifest) as any;
      m.publisher = other.did; // claim someone else's identity over the same bytes
      const v = await verifyManifest(m);
      probes.push(v.ok === false
        ? blocked('re-attribute the bundle to a different did', `verifyManifest = false (reason=${(v as any).reason})`)
        : leaked('re-attribute the bundle to a different did', `ok=${v.ok}`));
    }

    // 4) Strip the signature but keep the publisher claim: missing_sig.
    {
      const m = structuredClone(good.manifest) as any;
      delete m.sig;
      const v = await verifyManifest(m) as any;
      probes.push(v.ok === false && v.reason === 'missing_sig'
        ? blocked('claim a publisher with no signature', 'verifyManifest = false (missing_sig)')
        : leaked('claim a publisher with no signature', `ok=${v.ok} reason=${v.reason}`));
    }

    // 5) Amplification / size-lie DoS is refused before any chunk is fetched.
    {
      let ampRejected = false;
      try { assertBundleWithinLimits({ chunks: [{ size: MAX_BUNDLE_BYTES }, { size: MAX_BUNDLE_BYTES }], size: MAX_BUNDLE_BYTES * 2 } as any); }
      catch { ampRejected = true; }
      let lieRejected = false;
      try { assertBundleWithinLimits({ chunks: [{ size: 100 }, { size: 100 }], size: 5 } as any); }
      catch { lieRejected = true; }
      probes.push(ampRejected && lieRejected
        ? blocked('declare a multi-GB / size-under-reporting manifest', 'assertBundleWithinLimits throws on over-ceiling sum AND on size≠sum(chunks)')
        : leaked('declare a multi-GB / size-under-reporting manifest', `ampRejected=${ampRejected} lieRejected=${lieRejected}`));
    }

    // 6a) A moderately-hostile card is coerced within caps; forged identity dropped.
    {
      const coerced = parsePeerCard({
        name: 'A'.repeat(500),           //: clamped to MAX_CARD_NAME
        description: 'D'.repeat(5_000),  //: clamped to MAX_CARD_DESC
        skills: Array(5).fill({ id: 'x'.repeat(500), name: 'n'.repeat(500), description: 'd'.repeat(500) }), // fields: clamped to MAX_SKILL_FIELD
        did: 'not-a-did:key',            // forged / wrong-form identity
        capabilities: { ask: true },
      });
      const capped = coerced !== null
        && coerced.name.length <= MAX_CARD_NAME
        && coerced.skills.length <= MAX_SKILLS
        && !('did' in coerced)           // a non-did:key identity is dropped, never trusted
        && new TextEncoder().encode(JSON.stringify(coerced)).length <= MAX_CARD_BYTES;
      probes.push(capped
        ? blocked('oversize an agent card + forge its did', `coerced within caps (name≤${MAX_CARD_NAME}, skills≤${MAX_SKILLS}, ≤${MAX_CARD_BYTES}B); forged did dropped`)
        : leaked('oversize an agent card + forge its did', `coerced=${JSON.stringify(coerced)?.slice(0, 80)}`));
    }

    // 6b) A card that still exceeds the byte ceiling after clamping is rejected outright.
    {
      const extreme = parsePeerCard({
        name: 'A'.repeat(64),
        skills: Array(16).fill({ id: 'x'.repeat(128), name: 'n'.repeat(128), description: 'd'.repeat(128) }),
      });
      probes.push(extreme === null
        ? blocked('exhaust discovery memory with a max-fanned card', `parsePeerCard: null (over the ${MAX_CARD_BYTES}B ceiling even after clamping)`)
        : leaked('exhaust discovery memory with a max-fanned card', 'over-ceiling card accepted'));

      // A nameless card is rejected outright.
      const nameless = parsePeerCard({ description: 'no name here' });
      probes.push(nameless === null
        ? blocked('publish a nameless card to break discovery UIs', 'parsePeerCard: null')
        : leaked('publish a nameless card to break discovery UIs', 'nameless card accepted'));
    }

    return summarize(probes, ['content addressing (manifestHash)', 'verifyManifest (Ed25519 publisher signature)', 'assertBundleWithinLimits (amplification/size-lie guard)', 'parsePeerCard (coerce-and-cap)']);
  },
};
