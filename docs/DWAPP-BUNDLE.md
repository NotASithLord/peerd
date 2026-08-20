# Dwapp bundle transport

Dwapps have two deliberately separate representations:

1. The installed App is a canonical decoded file tree in OPFS. Text remains
   readable source and binary assets remain their original bytes. Browser Git
   reads and versions only this tree.
2. The peer-to-peer representation is a deterministic compressed envelope over
   that tree. Content chunks and seeding operate on the stored compressed bytes;
   they never recompress an installed copy while serving it.

The code is the protocol authority: the file container lives in
[`shared/bundle/bundle.js`](../extension/shared/bundle/bundle.js), the transport
descriptor and bounded codec live in
[`shared/bundle/transport.js`](../extension/shared/bundle/transport.js), and the
signed outer manifest lives in
[`peerd-distributed/content/manifest.js`](../extension/peerd-distributed/content/manifest.js).

## Version 2 descriptor

A version 2 content manifest adds a signed `bundle` member:

```json
{
  "v": 2,
  "size": 1234,
  "bundle": {
    "version": 2,
    "encoding": "gzip",
    "codec": "pako@1.0.11:gzip:l6:w15:m8:s0:i262144:mtime0:os255",
    "compressedSize": 1234,
    "uncompressedSize": 5678,
    "compressedHash": "<sha256>",
    "uncompressedHash": "<sha256>",
    "files": [
      { "path": "game.js", "size": 100, "hash": "<sha256>", "kind": "text" },
      { "path": "audio/voice.ogg", "size": 200, "hash": "<sha256>", "kind": "binary" }
    ]
  },
  "chunks": []
}
```

The descriptor is part of the canonical manifest hash and publisher signature.
Paths are lexically ordered. Compression uses the audited, vendored codec in
[`vendor/pako`](../extension/vendor/pako) with a protocol-pinned version and
option set. The canonical container enters it in one write with a fixed gzip
header. The wire result therefore does not inherit the host browser's native
DEFLATE implementation, so re-publishing the same tree recreates the same
stored payload and chunk identities across hosts and upgrades. Changing the
codec identity is an explicit transport protocol change, not a dependency bump.

Reception follows a fixed order:

1. Bound and authenticate the manifest.
2. Fetch each stored chunk and verify its declared length and hash.
3. Reassemble and verify the complete compressed size and hash.
4. Incrementally inflate through fixed-size output buffers with the signed
   output size and host maximum as simultaneous ceilings. Small claims use an
   output buffer only one byte larger than the claim, while larger valid files
   use a fixed bounded buffer. Surplus output therefore aborts during codec
   production rather than after an attacker-controlled result is allocated.
5. Verify the uncompressed container hash, decode the file map under per-file
   and aggregate limits, then verify every decoded file commitment.
6. Only those decoded bytes enter OPFS and the App repository.

This order makes a signed compression bomb a rejected transport, not an App
workspace mutation. A seeder retains the exact verified compressed chunks and
serves them directly.

## Assets and compatibility

Texture, audio, model, font, and other byte files should be separate App files,
not base64 strings embedded in JavaScript. Installed binary files are delivered
to the opaque App realm through the frozen `window.peerd.assets` API. Its
`has`, `list`, `bytes`, and `url` methods reveal only assets packaged in that
App; they expose no OPFS handle, extension API, or network primitive.

Legacy version 1 manifests and their uncompressed canonical file containers
remain readable. New dweb App publication emits version 2. The installed OPFS
shape is identical for both versions, so clone, status, commit, checkout, and
version replacement continue to operate on decoded canonical files.
