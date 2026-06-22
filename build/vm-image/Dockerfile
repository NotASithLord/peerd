# peerd pre-baked WebVM image — the "warm" dev rootfs.
#
# Consumed by scripts/build-vm-image.sh (Dockerfile -> OCI -> mkfs.ext2 -d),
# per docs/engine/VM-IMAGE.md §2/§5. The point: bake the toolchain + the bytes
# that the in-VM network bridge would otherwise fetch on every boot, so a fresh
# VM can `git clone` / `npm install` / `pip install` against the (HTTP-only,
# denylist-gated) bridge instead of apt-getting a compiler under emulation.
#
# HARD CONSTRAINTS (VM-IMAGE.md §3):
#   - 32-bit x86 ONLY (CheerpX emulates i386) — note the --platform below.
#   - ext2 image, 2 GB max. Keep the install lean; per-VM writes land in the
#     IDB overlay, not here.
#   - No raw sockets at RUNTIME (that's why we pre-install rather than rely on
#     live apt). Build-time apt runs on the BUILD host, which has real network.
#
# why bullseye: the stock image CheerpX streams today is buster-era and
# known-good; bullseye is the conservative next step. bookworm i386 also exists
# and buys newer toolchains — try it only after a bullseye image boots clean.
FROM --platform=linux/i386 docker.io/i386/debian:bullseye

# why pandas/numpy from apt, not pip: PyPI dropped 32-bit Linux wheels for them
# long ago, so `pip install pandas` on i386 is a source build (hours under
# emulation, likely OOM). Debian still ships python3-pandas/numpy for i386.
# pip stays for PURE-PYTHON packages (what peerd's pip shim resolves).
#
# nodejs + npm: so peerd's `npm install` shim has an interpreter to run the
# offline tail (the resolver + downloads happen host-side; node/npm here just
# execute and extract). git/curl/unzip back the clone + fetch wrappers.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      python3 python3-pip python3-venv \
      python3-pandas python3-numpy python3-requests \
      nodejs npm \
      ruby ruby-rubygems \
      git curl unzip xz-utils \
      jq ripgrep less vim-tiny \
      build-essential \
  && rm -rf /var/lib/apt/lists/* \
  && apt-get clean

# A predictable, writable home for the agent's work (per-VM writes persist in
# the IDB overlay on top of this).
WORKDIR /root
ENV HOME=/root \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_INPUT=1

# Sanity: these must resolve at runtime for the network shims' offline tails.
# (Build-time check only — does not run in the VM.)
RUN python3 --version && pip3 --version && node --version && git --version
