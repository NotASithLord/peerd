<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!-- Copyright (C) 2026 Pooya Parsa <pooya@pi0.io> -->

# Third-party software

What unkernel's build outputs carry that is not unkernel's own, under which
license, and the notices those licenses ask to travel with it. The outputs
are the npm package [`unkernel`](https://www.npmjs.com/package/unkernel),
the GitHub release's assets and the page. unkernel's own code is
GPL-2.0-or-later ([LICENSE](LICENSE)), its SDK and page MIT
([LICENSE-MIT](LICENSE-MIT)); the source of everything below, and how it is
built, is at <https://github.com/pithings/unkernel>.

## The kernel bundle (`unkernel.wasm`)

- **Linux** 7.3, GPL-2.0 ([LICENSE](LICENSE) has the text). The source is
  the stable tag from kernel.org plus [kernel/patches/linux](kernel/patches/linux),
  whose `arch/wasm` grew from [linux-wasm](https://github.com/joelseverin/linux-wasm)
  by Joel Severin.
- **BusyBox** 1.37.0, GPL-2.0: Alpine Linux's `busybox-static` package
  (pinned in [guest/base/pins.sh](guest/base/pins.sh)), in the base
  initramfs. Its source is at <https://busybox.net> and in Alpine's
  [aports](https://gitlab.alpinelinux.org/alpine/aports/-/tree/master/main/busybox).

## The guest GL renderer (`virgl.mjs`, `virgl.wasm`)

[virglrenderer](https://gitlab.freedesktop.org/virgl/virglrenderer) 1.3.0
with [gl/patches/virglrenderer](gl/patches/virglrenderer), compiled to wasm
by [Emscripten](https://emscripten.org/) 6.0.13 with unkernel's glue
([gl/wasm](gl/wasm), GPL-2.0-or-later). The module as a whole is
distributed under GPL-2.0-or-later; the parts below keep their own licenses.

- **virglrenderer**, MIT, much of it derived from
  [Mesa](https://mesa3d.org/): Copyright Red Hat, Inc., VMware, Inc.,
  Collabora Ltd., Intel Corporation, Google LLC and the other virglrenderer
  and Mesa authors.
- **Emscripten**'s runtime (the JavaScript glue and its WebGL bindings),
  MIT: Copyright (c) 2010-2014 Emscripten authors.
- **musl** (Emscripten's libc), MIT: Copyright © 2005-2020 Rich Felker,
  et al.
- **compiler-rt** (Emscripten's runtime library), Apache-2.0 WITH
  LLVM-exception: Copyright the LLVM Project contributors.

Each MIT part above is under this notice:

```
Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```

virglrenderer's scatter/gather routines (`src/vrend/iov.c`) are under this one:

```
Copyright (C) 2002 Michael Ringgaard. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
3. Neither the name of the project nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED.  IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
SUCH DAMAGE.
```

## The guest Vulkan translator (`kwvk-naga.wasm`)

unkernel's SPIR-V to WGSL translator ([vk/naga](vk/naga),
GPL-2.0-or-later) compiled to wasm with the Rust crates locked in
[vk/naga/Cargo.lock](vk/naga/Cargo.lock), which keep their own licenses;
where a crate offers a choice, it is used under MIT.

- **naga** (the gfx-rs/wgpu shader translator), MIT OR Apache-2.0:
  Copyright (c) The gfx-rs developers.
- Its dependencies in the wasm (`cargo tree --target
  wasm32-unknown-unknown -e normal`), MIT OR Apache-2.0 unless noted:
  arrayvec, bit-set, bit-vec, bitflags, cfg-if, equivalent, fixedbitset,
  half, hashbrown, indexmap, log, num-traits, once_cell, petgraph,
  rustc-hash, thiserror, unicode-width; zerocopy, BSD-2-Clause OR
  Apache-2.0 OR MIT; libm, MIT; foldhash, Zlib; spirv (Copyright (c) The
  Khronos Group Inc. and the gfx-rs developers) and codespan-reporting,
  Apache-2.0 only (its text: <https://www.apache.org/licenses/LICENSE-2.0>).
  The proc-macro crates (proc-macro2, quote, syn, thiserror-impl,
  zerocopy-derive, unicode-ident) run only at build time.

The guest's Vulkan ICD (`libvulkan_kw.so`, in the kernel bundle's base) is
unkernel's own ([vk/icd](vk/icd), GPL-2.0-or-later), built against the
Khronos Vulkan headers (Apache-2.0 OR MIT). It speaks wland's
`wland_external_buffer_manager_v1` from an interface description written
out by hand after wland's `protocol/wland-external-buffer-v1.xml`
(MPL-2.0; [wland](https://github.com/pithings/wland)).

## The distro images

Alpine Linux and Debian images hold those distributions' packages, which
keep their own licenses (Debian's in `/usr/share/doc/*/copyright`). The
files unkernel adds are listed, with their license, in
`/usr/share/licenses/unkernel` in the guest. The Debian image also carries
`/usr/lib/kw/wlandr`, the relay of [wland](https://github.com/pithings/wland)
(MPL-2.0 AND MIT, source in that repository).

## The page

The page's build serves this file at `/licenses.md`, followed by every
package its JavaScript and CSS bundle, with the package's license text:
among them [wland](https://github.com/pithings/wland) (MPL-2.0 AND MIT;
source in that repository and its npm package),
[wterm](https://wterm.dev/) (Apache-2.0), React (MIT) and the Geist fonts
(SIL Open Font License 1.1).
