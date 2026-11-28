// @ts-check
// vm-tab - a discrete WebVM hosted in its own browser tab.
//
// Architecture:
//   - The tab IS the VM. unkernel (Linux 7.x on WebAssembly) + bash + xterm
//     all live in this page.
//   - PTY bytes never leave the tab (xterm is right here).
//   - Agent commands arrive via chrome.runtime.onMessage from the SW;
//     we run them through the persistent bash via the marker protocol
//     and reply with { exitCode, stdout, stderr, durationMs }.
//   - HTTP marker (peerd-fetch) calls back to the SW via runtime
//     sendMessage to use the same peerd-egress denylist + audit as
//     the web tools. Direct guest networking (`net`) is deliberately OFF.
//
// The VM's identity (vmId, name, disk overlay key) is read from the
// registry via the SW (vm/get-meta -> idbKV('vms')) on boot, keyed by the
// `#<vmId>` fragment in the URL. No URL params for cleanliness.

import browser from '/shared/browser-api.js';
import {
  VMBootFailedError, VMNotReadyError,
  IMAGE_PIN_HEAD_BYTES,
  IMAGE_PIN_STORAGE_KEY,
  parseContentRangeTotal,
  evaluateImagePin,
  // WebVM HTTP-native networking (pure cores; this file injects the IO)
  findNextMarker,
  partialMarkerHoldIndex,
  parseMarkerLine,
  encodeResponseMeta,
  stubsBash,
  runControlOp,
  bannerText,
  peerdNetBash,
  aptShimsBash,
  friendlyFetchError,
} from '/peerd-engine/index.js';
import { base64ToBytes } from '/shared/util.js';
import { mountPullInPeerd } from '/shared/pull-in-peerd.js';
import { stripChunk } from '/engine-tabs/vm-tab/marker-strip.js';
import { ERRFILE_PREFIX, buildWrappedCommand, parseRunCapture } from '/engine-tabs/vm-tab/run-capture.js';
import { holdDiskLock } from '/engine-tabs/vm-tab/disk-lock.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Pinned Debian 13.7 aarch64 erofs image for unkernel v0.2.0-261127-3b71fa5.
// Served over HTTPS with Range + CORS + CORP from peerd's immutable R2 edge;
// read lazily block-by-block with strict ETag/size validation (HttpBase).
const STOCK_DEBIAN_IMAGE_HTTP = 'https://updates.peerd.ai/unkernel/v0.2.0-261127-3b71fa5/debian.erofs';
const UNKERNEL_WASM_GZ_PATH = 'vendor/unkernel/unkernel.wasm.gz';
const DATA_DISK_VERSION = 'v1';
// The per-URL TOFU fingerprint store key lives in peerd-engine/image-pin.js
// (imported above) - the SW's artifact export/import routes read the same key
// to carry the pin inside vm-recipe envelopes (DESIGN-10). Pins stay global,
// not per-VM: a published image URL must never change bytes for ANY consumer.
// A legitimate new image ships under a new URL and pins fresh automatically.

/** @type {Record<string, any>} the tab owns these known-present elements */
const DOM = {
  bootCard: document.getElementById('vm-boot'),
  bootStage: document.getElementById('boot-stage'),
  bootDetail: document.getElementById('boot-detail'),
  bootLog:  document.getElementById('boot-log'),
  terminal: document.getElementById('vm-terminal'),
  exportBtn: document.getElementById('export-btn'),
};

// ---------------------------------------------------------------------------
// Boot card status updates + broadcast to side panel
// ---------------------------------------------------------------------------

/** @type {string | null} */ let vmId = null;
let vmName = '';
let diskOverlayKey = '';
// Verbose VM diagnostics (Settings → Behavior `devMode`); set from vm/get-meta.
// Surfaces the one-time wrapper install/verify output at boot — it does NOT
// trace the shell (no `set -x`), so your own commands stay clean either way.
let vmDevMode = false;
/** @type {string[]} */
const bootLogLines = [];

// why: no header bar to update -- status now lives in the tab title
// ("peerd · <name>" while booting; "peerd · <name>" steady once ready).
// Failed VMs surface in the boot card's is-failed styling, which the
// caller toggles via DOM.bootCard.classList.
const setStatus = (/** @type {string} */ text, /** @type {string} */ kind = '') => {
  if (!vmName) return;
  if (kind === 'failed') {
    document.title = `peerd · ${vmName} — ${text}`;
    DOM.bootCard.classList.add('is-failed');
  } else if (kind === 'ready') {
    document.title = `peerd · ${vmName}`;
    DOM.bootCard.classList.remove('is-failed');
  } else {
    document.title = `peerd · ${vmName} — ${text}`;
  }
};

/** @param {string} stage @param {string} [detail] */
const setStage = (stage, detail) => {
  DOM.bootStage.textContent = stage;
  if (typeof detail === 'string') DOM.bootDetail.textContent = detail;
};

const appendBootLog = (/** @type {string} */ level, /** @type {string} */ message) => {
  const time = new Date().toTimeString().slice(0, 8);
  const line = `${time} ${level === 'error' ? '✕ ' : level === 'warn' ? '⚠ ' : ''}${message}`;
  bootLogLines.push(line);
  while (bootLogLines.length > 200) bootLogLines.shift();
  DOM.bootLog.textContent = bootLogLines.join('\n');
  DOM.bootLog.scrollTop = DOM.bootLog.scrollHeight;
};

const trace = (/** @type {string} */ level, /** @type {string} */ message) => {
  appendBootLog(level, message);
  // (Boot events used to broadcast to a side-panel chip. That chip is
  // gone -- VM lifecycle is the tab strip + agent tools now. Logs
  // stay in the in-tab boot card via appendBootLog.)
};

// ---------------------------------------------------------------------------
// Lookup VM record from registry
// ---------------------------------------------------------------------------

const loadVmRecord = async () => {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) throw new Error('missing vmId in URL hash');
  // why the SW round-trip (not a direct chrome.storage.local read): the
  // VM catalog moved to IndexedDB (idbKV('vms')); the SW owns the
  // registry and answers vm/get-meta, mirroring app-tab's app/get-meta.
  const reply = /** @type {any} */ (await browser.runtime.sendMessage({ type: 'vm/get-meta', vmId: hash }));
  if (!reply?.ok) throw new Error(reply?.error ?? `vm not found in registry: ${hash}`);
  // Developer mode (Settings → Behavior): verbose VM diagnostics. Read once at
  // boot; gates the VISIBLE install/verify output below (no `set -x` — the
  // persistent shell is never traced; the boot LOG carries the diagnostics).
  vmDevMode = !!reply.devMode;
  return reply.record;
};

// ---------------------------------------------------------------------------
// unkernel module loader
// ---------------------------------------------------------------------------

/** @type {Promise<any> | null} */ let unkernelModulePromise = null;
const loadUnkernel = () => {
  if (!unkernelModulePromise) {
    unkernelModulePromise = import('/vendor/unkernel/web.mjs').catch((e) => {
      unkernelModulePromise = null;
      throw e;
    });
  }
  return unkernelModulePromise;
};

// ---------------------------------------------------------------------------
// Bash wrappers (peerd-fetch + curl/wget/git/npm/pip/gem as bash functions,
// staged via MemoryFs mounted at /peerd-data then `source`d).
// ---------------------------------------------------------------------------

const WRAPPERS_BASH = `
# Disable history expansion in this interactive shell. why: bash -i turns "!"
# into a history-recall metacharacter, so an everyday command like
# python3 -c "print('Hi!')" dies with "bash: !': event not found". Sourced into
# the persistent shell at boot, this turns it off session-wide. Logical "!"
# (if ! cmd; [ ! -f x ]) is unaffected -- only the !history footgun goes away.
set +H
# Clear unkernel Debian's default sudo apt aliases so our apt shims win cleanly.
unalias apt apt-get 2>/dev/null || true

# ---- peerd-egress wrappers (bash functions) ------------------------------
# Timeout for a single bridged request, in seconds (configurable). Bumped from
# the old hard 30s so large archive/package downloads don't die mid-stream; the
# poll loop sleeps 0.05s, so ticks = seconds * 20.
: "\${PEERD_HTTP_TIMEOUT:=120}"
PEERD_HTTP_TIMEOUT_TICKS=$(( PEERD_HTTP_TIMEOUT * 20 ))
export PEERD_HTTP_TIMEOUT PEERD_HTTP_TIMEOUT_TICKS

# peerd-fetch URL [OUT] — the GET fast path (cached host-side). Unchanged wire
# (___PEERD_HTTP___), body-only response.
peerd-fetch() {
  local url="$1"
  local out="$2"
  if [ -z "$url" ]; then
    echo "peerd-fetch: usage: peerd-fetch URL [OUTPUT]" >&2
    return 2
  fi
  local id="\${RANDOM}\${RANDOM}\${RANDOM}$$"
  printf '___PEERD_HTTP___:%s:%s\\n' "$id" "$url"
  local n=0
  while [ ! -f "/peerd-data/peerddone\${id}" ]; do
    sleep 0.05
    n=$((n + 1))
    if [ "$n" -gt "$PEERD_HTTP_TIMEOUT_TICKS" ]; then
      echo "peerd-fetch: timed out after \${PEERD_HTTP_TIMEOUT}s waiting for response (id=\${id})" >&2
      return 124
    fi
  done
  if [ -f "/peerd-data/peerderr\${id}" ]; then
    cat "/peerd-data/peerderr\${id}" >&2
    return 1
  fi
  # Map the common discard idiom (curl -o /dev/null) directly, and /dev/stdout
  # (or "-") to plain stdout, avoiding an extra copy.
  if [ -z "$out" ] || [ "$out" = "-" ] || [ "$out" = "/dev/stdout" ]; then
    cat "/peerd-data/peerdresp\${id}"
  elif [ "$out" = "/dev/null" ]; then
    : # discard the body; the fetch itself still succeeded
  else
    cat "/peerd-data/peerdresp\${id}" > "$out"
  fi
}
export -f peerd-fetch

# __peerd_emit_req OUT FAIL SHOW_STATUS — the rich path. Reads a wire blob on
# stdin (the line-oriented PEERDREQ1 format from vm-net/http-bridge.js),
# base64s it, emits the ___PEERD_REQ___ marker, waits, then surfaces the
# response body + status. Sets PEERD_LAST_STATUS.
__peerd_emit_req() {
  local out="$1" fail="$2" show_status="$3"
  local payload id n
  payload="$(base64 -w0)"
  id="\${RANDOM}\${RANDOM}\${RANDOM}$$"
  printf '___PEERD_REQ___:%s:%s\\n' "$id" "$payload"
  n=0
  while [ ! -f "/peerd-data/peerddone\${id}" ]; do
    sleep 0.05
    n=$((n + 1))
    if [ "$n" -gt "$PEERD_HTTP_TIMEOUT_TICKS" ]; then
      echo "peerd-http: timed out after \${PEERD_HTTP_TIMEOUT}s (id=\${id})" >&2
      return 124
    fi
  done
  PEERD_LAST_STATUS=""
  if [ -f "/peerd-data/peerdmeta\${id}" ]; then
    PEERD_LAST_STATUS="$(grep -Eo '"status":[0-9]+' "/peerd-data/peerdmeta\${id}" | grep -Eo '[0-9]+')"
  fi
  if [ -f "/peerd-data/peerderr\${id}" ]; then
    cat "/peerd-data/peerderr\${id}" >&2
    return 1
  fi
  if [ "$show_status" = 1 ]; then printf '%s' "\${PEERD_LAST_STATUS:-000}"; fi
  if [ "$fail" = 1 ] && [ -n "$PEERD_LAST_STATUS" ] && [ "$PEERD_LAST_STATUS" -ge 400 ]; then
    echo "peerd-http: HTTP $PEERD_LAST_STATUS" >&2
    return 22
  fi
  if [ -z "$out" ] || [ "$out" = "-" ] || [ "$out" = "/dev/stdout" ]; then
    cat "/peerd-data/peerdresp\${id}"
  elif [ "$out" = "/dev/null" ]; then
    :
  else
    cat "/peerd-data/peerdresp\${id}" > "$out"
  fi
}
export -f __peerd_emit_req

# __peerd_emit_headers "Name: Value"... — emit each header as a wire H line,
# stripping CR/LF/TAB from name AND value (they're the wire delimiters, so a
# value containing one would inject a forged line; the codec scrubs too).
# Shared by curl + wget so the security-relevant strip lives in ONE place.
__peerd_emit_headers() {
  local _h _n _v
  for _h in "$@"; do
    _n="\${_h%%:*}"; _v="\${_h#*:}"; _v="\${_v# }"
    _n="\${_n//[$'\\n\\r\\t']/}"; _v="\${_v//[$'\\n\\r\\t']/}"
    printf 'H\\t%s\\t%s\\n' "$_n" "$_v"
  done
}
export -f __peerd_emit_headers

# curl — now a real HTTP client over the bridge: methods, headers, body, fail,
# write-out %{http_code}. A plain header-less GET still takes the cached fast path.
curl() {
  local method="" url="" out="" guess_out=0 fail=0 show_status=0 has_body=0 body=""
  local -a hdrs=()
  while [ $# -gt 0 ]; do
    case "$1" in
      -X|--request) method="$2"; shift 2 ;;
      -o|--output) out="$2"; shift 2 ;;
      -O|--remote-name) guess_out=1; shift ;;
      -H|--header) hdrs+=("$2"); shift 2 ;;
      -A|--user-agent) hdrs+=("User-Agent: $2"); shift 2 ;;
      -e|--referer) hdrs+=("Referer: $2"); shift 2 ;;
      --json)
        hdrs+=("Content-Type: application/json")
        hdrs+=("Accept: application/json")
        if [ "\${2#@}" != "$2" ]; then body="\${body}$(cat "\${2#@}")"; else body="\${body}$2"; fi
        has_body=1; shift 2 ;;
      -d|--data|--data-raw|--data-ascii|--data-binary|--data-urlencode)
        if [ -n "$body" ]; then body="\${body}&"; fi
        if [ "\${2#@}" != "$2" ]; then body="\${body}$(cat "\${2#@}")"; else body="\${body}$2"; fi
        has_body=1; shift 2 ;;
      -I|--head) method="HEAD"; shift ;;
      -f|--fail|--fail-with-body) fail=1; shift ;;
      -w|--write-out) case "$2" in *%{http_code}*) show_status=1 ;; esac; shift 2 ;;
      -s|--silent|-S|--show-error|-L|--location|-k|--insecure|-g|--globoff|--compressed|--progress-bar) shift ;;
      -b|--cookie|-c|--cookie-jar|--connect-timeout|-m|--max-time|--retry|-u|--user|--url) shift 2 ;;
      http://*|https://*) url="$1"; shift ;;
      --) shift ;;
      -*) shift ;;
      *) if [ -z "$url" ]; then url="https://$1"; fi; shift ;;
    esac
  done
  if [ -z "$url" ]; then echo "peerd-curl: no URL provided" >&2; return 2; fi
  if [ "$guess_out" = 1 ]; then out="$(basename "$url")"; fi
  if [ -z "$method" ]; then if [ "$has_body" = 1 ]; then method="POST"; else method="GET"; fi; fi
  if [ "$method" = "GET" ] && [ "$has_body" = 0 ] && [ \${#hdrs[@]} -eq 0 ]; then
    peerd-fetch "$url" "$out"
    return $?
  fi
  {
    printf 'PEERDREQ1\\n'
    printf 'M\\t%s\\n' "$method"
    printf 'U\\t%s\\n' "$url"
    __peerd_emit_headers "\${hdrs[@]}"
    if [ "$has_body" = 1 ]; then printf 'B\\t'; printf '%s' "$body" | base64 -w0; printf '\\n'; fi
  } | __peerd_emit_req "$out" "$fail" "$show_status"
}
export -f curl

# wget — GET fast path; --post-data / --header / --method route through the rich path.
wget() {
  local url="" out="" body="" has_body=0 method="GET"
  local -a hdrs=()
  while [ $# -gt 0 ]; do
    case "$1" in
      -O|--output-document) out="$2"; shift 2 ;;
      --header) hdrs+=("$2"); shift 2 ;;
      --post-data) body="$2"; has_body=1; method="POST"; shift 2 ;;
      --post-file) body="$(cat "$2")"; has_body=1; method="POST"; shift 2 ;;
      --method) method="$2"; shift 2 ;;
      --body-data) body="$2"; has_body=1; shift 2 ;;
      -q|--quiet|-c|--continue|--no-check-certificate|-nv|--no-verbose) shift ;;
      http://*|https://*) url="$1"; shift ;;
      --) shift ;;
      -*) shift ;;
      *) if [ -z "$url" ]; then url="https://$1"; fi; shift ;;
    esac
  done
  if [ -z "$url" ]; then echo "peerd-wget: no URL provided" >&2; return 2; fi
  if [ -z "$out" ]; then out="$(basename "$url")"; fi
  if [ "$method" = "GET" ] && [ "$has_body" = 0 ] && [ \${#hdrs[@]} -eq 0 ]; then
    peerd-fetch "$url" "$out"
    return $?
  fi
  {
    printf 'PEERDREQ1\\n'; printf 'M\\t%s\\n' "$method"; printf 'U\\t%s\\n' "$url"
    __peerd_emit_headers "\${hdrs[@]}"
    if [ "$has_body" = 1 ]; then printf 'B\\t'; printf '%s' "$body" | base64 -w0; printf '\\n'; fi
  } | __peerd_emit_req "$out" 0 0
}
export -f wget

# git clone — SNAPSHOT clone of ANY ref on github/gitlab (and a best-effort
# github/gitlab-layout guess for self-hosted hosts), host-side default-branch + auth.
# The host runs the tested archive planner (peerd://git-clone control op) and
# returns the zip; we unzip it. No .git/history/push — see VM-NETWORKING.md.
git() {
  if [ "$1" != "clone" ]; then
    /usr/bin/git "$@"
    return $?
  fi
  shift
  local url="" ref="" dir=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -b|--branch) ref="$2"; shift 2 ;;
      --depth|-j|--jobs|--config|-c) shift 2 ;;
      --) shift ;;
      https://*|http://*) if [ -z "$url" ]; then url="$1"; else dir="$1"; fi; shift ;;
      -*) shift ;;
      *) if [ -z "$url" ]; then url="$1"; elif [ -z "$dir" ]; then dir="$1"; fi; shift ;;
    esac
  done
  if [ -z "$url" ]; then echo "peerd-git: clone requires an https URL" >&2; return 2; fi
  case "$url" in https://*) ;; *) echo "peerd-git: only https clone URLs are supported (no ssh/git protocol in the sandbox)" >&2; return 2 ;; esac
  if [ -z "$dir" ]; then dir="$(basename "\${url%.git}")"; fi
  local tmp="/tmp/peerd-clone-$$.zip" extract="/tmp/peerd-clone-$$-x" errf="/tmp/peerd-clone-$$.err"
  local json
  if [ -n "$ref" ]; then json="{\\"url\\":\\"$url\\",\\"ref\\":\\"$ref\\"}"; else json="{\\"url\\":\\"$url\\"}"; fi
  {
    printf 'PEERDREQ1\\n'; printf 'M\\tGET\\n'; printf 'U\\tpeerd://git-clone\\n'
    printf 'B\\t'; printf '%s' "$json" | base64 -w0; printf '\\n'
  } | __peerd_emit_req "$tmp" 0 0 2>>"$errf"
  if [ ! -s "$tmp" ]; then
    echo "peerd-git: clone failed for $url" >&2
    [ -f "$errf" ] && cat "$errf" >&2
    rm -f "$tmp" "$errf"
    return 1
  fi
  mkdir -p "$extract" "$dir" 2>>"$errf"
  # Keep extraction tolerant of non-fatal metadata warnings; judge by whether a dir appeared.
  unzip -q -o "$tmp" -d "$extract" 2>>"$errf" || true
  local inner="$(ls -d "$extract"/*/ 2>>"$errf" | head -1)"
  if [ -n "$inner" ]; then
    cp -r "$inner". "$dir"/ 2>>"$errf"
  else
    cp -r "$extract"/. "$dir"/ 2>>"$errf" || true
  fi
  rm -rf "$extract" "$tmp"
  rm -f "$errf"
  echo "Cloned $url into $dir (snapshot)"
  return 0
}
export -f git

# ---- package-manager shims (one core boilerplate) -----------------------
# Every shim resolves + downloads HOST-side (peerd://<op>) and installs the
# staged files offline. The shared plumbing is factored here; each shim keeps
# only its arg-parsing + the install action (which genuinely differs per tool).

# __peerd_json_pkgs PKG... — build {"packages":[...]} (+ optional pyTags from
# the PEERD_PYTAGS global). Package specs don't contain quotes/backslashes in
# practice, so no escaping — the host re-validates every name anyway.
__peerd_json_pkgs() {
  local out='{"packages":[' first=1 a
  for a in "$@"; do
    if [ "$first" = 1 ]; then first=0; else out="$out,"; fi
    out="$out\\"$a\\""
  done
  out="$out]"
  if [ -n "$PEERD_PYTAGS" ]; then out="$out,\\"pyTags\\":[$PEERD_PYTAGS]"; fi
  out="$out}"
  printf '%s' "$out"
}
export -f __peerd_json_pkgs

# __peerd_pkg_fetch OP JSON OUTFILE — the shared wire plumbing: emit a
# peerd://OP control request with the JSON body, staging the TSV manifest
# (name\\tversion\\tpath) into OUTFILE. Returns non-zero (printing any host
# error) if nothing came back. NB: the marker must reach the PTY, so callers
# invoke this directly — never via $(...), which would capture the marker.
__peerd_pkg_fetch() {
  local op="$1" json="$2" out="$3" errf="$3.err"
  {
    printf 'PEERDREQ1\\n'; printf 'M\\tGET\\n'; printf 'U\\tpeerd://%s\\n' "$op"
    printf 'B\\t'; printf '%s' "$json" | base64 -w0; printf '\\n'
  } | __peerd_emit_req "$out" 0 0 2>>"$errf"
  if [ ! -s "$out" ]; then
    [ -f "$errf" ] && cat "$errf" >&2
    rm -f "$errf"; return 1
  fi
  rm -f "$errf"; return 0
}
export -f __peerd_pkg_fetch

# __peerd_node_add TOOL PKG... — resolve+download npm packages host-side and
# extract them into ./node_modules. Shared by npm/yarn/pnpm (same registry).
__peerd_node_add() {
  local tool="$1"; shift
  local -a specs=()
  local PEERD_PYTAGS=""
  while [ $# -gt 0 ]; do case "$1" in -*) shift ;; *) specs+=("$1"); shift ;; esac; done
  if [ \${#specs[@]} -eq 0 ]; then
    echo "$tool: name packages explicitly (e.g. $tool add <pkg>); package.json install isn't supported yet" >&2
    return 2
  fi
  local manifest="/tmp/peerd-node-$$.tsv" errf="/tmp/peerd-node-$$.err"
  if ! __peerd_pkg_fetch npm-install "$(__peerd_json_pkgs "\${specs[@]}")" "$manifest"; then
    echo "$tool: install failed" >&2; rm -f "$manifest"; return 1
  fi
  mkdir -p node_modules 2>>"$errf"
  local name version file
  while IFS=$'\\t' read -r name version file; do
    # Defense-in-depth: $name becomes a node_modules extraction path. Reject
    # anything that isn't a plain or single-scoped name — no .., no leading /,
    # no second slash — so a hostile manifest can't traverse out of node_modules.
    # (The host already sanitizes the staged FILE; the name needs its own guard
    # because a scoped name legitimately contains one /.)
    case "$name" in
      ''|*..*|/*|*/*/*) echo "$tool: skipping unsafe package name: $name" >&2; rm -f "$file"; continue ;;
    esac
    mkdir -p "node_modules/$name" 2>>"$errf"
    # Tolerate non-fatal tar metadata warnings on extraction.
    # while extracting correctly.
    tar -xzf "$file" -C "node_modules/$name" --strip-components=1 2>>"$errf" || true
    rm -f "$file"
    echo "added $name@$version"
  done < "$manifest"
  rm -f "$manifest" "$errf"
  return 0
}
export -f __peerd_node_add

# npm / yarn / pnpm — same npm registry, same node_modules install. We intercept
# add|install (named packages only — no package.json; VM-NETWORKING.md) and pass
# every other subcommand through to a real binary if the image ships one.
npm() {
  case "$1" in
    install|i|add) shift; __peerd_node_add npm "$@" ;;
    *) if [ -x /usr/bin/npm ]; then /usr/bin/npm "$@"; return $?; fi
       echo "peerd-npm: only 'npm install <pkg...>' is supported in this sandbox" >&2; return 2 ;;
  esac
}
export -f npm
yarn() {
  case "$1" in
    add|install) shift; __peerd_node_add yarn "$@" ;;
    *) if [ -x /usr/bin/yarn ]; then /usr/bin/yarn "$@"; return $?; fi
       echo "peerd-yarn: only 'yarn add <pkg...>' is supported in this sandbox" >&2; return 2 ;;
  esac
}
export -f yarn
pnpm() {
  case "$1" in
    add|install|i) shift; __peerd_node_add pnpm "$@" ;;
    *) if [ -x /usr/bin/pnpm ]; then /usr/bin/pnpm "$@"; return $?; fi
       echo "peerd-pnpm: only 'pnpm add <pkg...>' is supported in this sandbox" >&2; return 2 ;;
  esac
}
export -f pnpm

# pip install <pkg...> | -r requirements.txt — PURE-PYTHON wheels
# (peerd://pip-install), installed offline with the image's pip.
pip() {
  if [ "$1" != "install" ]; then
    if [ -x /usr/bin/pip3 ]; then /usr/bin/pip3 "$@"; return $?; fi
    if [ -x /usr/bin/pip ]; then /usr/bin/pip "$@"; return $?; fi
    echo "peerd-pip: only 'pip install <pkg...>' is supported in this sandbox" >&2
    return 2
  fi
  shift
  local -a specs=()
  local PEERD_PYTAGS='"aarch64","manylinux_2_17_aarch64","manylinux2014_aarch64"'
  while [ $# -gt 0 ]; do
    case "$1" in
      -r|--requirement)
        if [ -f "$2" ]; then
          local line
          while IFS= read -r line; do
            line="\${line%%#*}"; line="\${line// /}"
            [ -n "$line" ] && specs+=("$line")
          done < "$2"
        fi
        shift 2 ;;
      -*) shift ;;
      *) specs+=("$1"); shift ;;
    esac
  done
  if [ \${#specs[@]} -eq 0 ]; then echo "peerd-pip: name packages or use -r requirements.txt" >&2; return 2; fi
  local manifest="/tmp/peerd-pip-$$.tsv" errf="/tmp/peerd-pip-$$.err"
  if ! __peerd_pkg_fetch pip-install "$(__peerd_json_pkgs "\${specs[@]}")" "$manifest"; then
    echo "peerd-pip: install failed" >&2; rm -f "$manifest"; return 1
  fi
  local name version file wheels=""
  while IFS=$'\\t' read -r name version file; do [ -n "$name" ] && wheels="$wheels $file"; done < "$manifest"
  if [ -z "$wheels" ]; then echo "peerd-pip: nothing staged to install" >&2; rm -f "$manifest" "$errf"; return 1; fi
  # Install each pure-Python wheel by UNZIPPING it into a writable
  # site-packages directory - deliberately NOT via pip, because the host stages
  # wheels as pkgstage_<id>_<name>.whl and pip derives the package name/version
  # from the filename. A py3-none-any wheel is just a zip already laid out for
  # site-packages, so unzip == install (and preserves .dist-info).
  python3 -c '
import site, os, sys, zipfile
cands = list(getattr(site, "getsitepackages", lambda: [])()) + [site.getusersitepackages()]
dest = None
for d in cands:
    try:
        os.makedirs(d, exist_ok=True)
        t = os.path.join(d, ".peerd_w"); open(t, "w").close(); os.remove(t); dest = d; break
    except Exception: pass
if not dest:
    print("peerd-pip: no writable site-packages dir", file=sys.stderr); sys.exit(1)
rc = 0
for whl in sys.argv[1:]:
    try:
        zipfile.ZipFile(whl).extractall(dest)
        b = os.path.basename(whl)
        if b.startswith("pkgstage_") and b.count("_") >= 2: b = b.split("_", 2)[2]
        print("installed " + (b[:-4] if b.endswith(".whl") else b))
    except Exception as e:
        print("peerd-pip: failed to unpack", os.path.basename(whl), e, file=sys.stderr); rc = 1
sys.exit(rc)
' $wheels 2>>"$errf"
  local rc=$?
  [ -f "$errf" ] && [ "$rc" != 0 ] && cat "$errf" >&2
  rm -f "$manifest" "$errf" $wheels
  return $rc
}
export -f pip

# gem install <name…> — PURE-RUBY gems (peerd://gem-install), installed offline
# with the image's gem. No native extensions, no Bundler/Gemfile.
gem() {
  if [ "$1" != "install" ] && [ "$1" != "i" ]; then
    if [ -x /usr/bin/gem ]; then /usr/bin/gem "$@"; return $?; fi
    echo "peerd-gem: only 'gem install <name...>' is supported in this sandbox" >&2
    return 2
  fi
  shift
  local -a specs=()
  local PEERD_PYTAGS=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -v|--version) shift 2 ;;
      -*) shift ;;
      *) specs+=("$1"); shift ;;
    esac
  done
  if [ \${#specs[@]} -eq 0 ]; then echo "peerd-gem: name gems explicitly (gem install <name>)" >&2; return 2; fi
  local manifest="/tmp/peerd-gem-$$.tsv" errf="/tmp/peerd-gem-$$.err"
  if ! __peerd_pkg_fetch gem-install "$(__peerd_json_pkgs "\${specs[@]}")" "$manifest"; then
    echo "peerd-gem: install failed" >&2; rm -f "$manifest"; return 1
  fi
  local name version file gems=""
  while IFS=$'\\t' read -r name version file; do [ -n "$name" ] && gems="$gems $file"; done < "$manifest"
  local gembin="" c
  for c in /usr/bin/gem /usr/local/bin/gem; do [ -x "$c" ] && { gembin="$c"; break; }; done
  if [ -z "$gembin" ]; then
    echo "peerd-gem: no gem binary in the VM to install the staged gems ($gems)" >&2
    rm -f "$manifest" $gems; return 1
  fi
  "$gembin" install --local --ignore-dependencies --no-document $gems 2>>"$errf"
  local rc=$?
  [ -f "$errf" ] && cat "$errf" >&2
  rm -f "$manifest" "$errf" $gems
  return $rc
}
export -f gem
# ---- end peerd-egress wrappers ------------------------------------------

${stubsBash()}

${aptShimsBash()}

${peerdNetBash()}
`;

// ---------------------------------------------------------------------------
// Marker scanning + bash-output filtering helpers
// (Same logic as the prior offscreen adapter, simplified.)
// ---------------------------------------------------------------------------

// stripChunk + the chunk-boundary hold logic live in marker-strip.js; the
// wrapped-run template + capture parser live in run-capture.js — both pure and
// bun-tested (imported above). Keep only the marker MINT here.

const makeMarker = () =>
  `___PEERD_${Math.random().toString(36).slice(2, 12)}_${Date.now().toString(36)}___`;

const shellEscape = (/** @type {any} */ s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ---------------------------------------------------------------------------
// xterm + PTY + unkernel boot
// ---------------------------------------------------------------------------

/** @type {any} */
let vm = null;
/** @type {any} */
let pty = null;
/** @type {any} */
let dataDisk = null;
/** @type {any} */
let peerdDataFs = null;
/** @type {any} */
let dataDev = null;
/** @type {any} */
let term = null;
/** @type {any} */ let fitAddon = null;
let syncConsoleSize = () => {};

/** @param {string | Uint8Array} data */
const writePty = (data) => {
  if (!pty) return;
  void pty.write(data).catch(() => {});
};

/** Best-effort disk sync so persistent ext4 writes flush to IndexedDB. */
const syncDiskBestEffort = () => {
  if (!vm || shellExit !== null) return;
  void vm.sync({ timeout: 5000 }).catch(() => {});
};

let silentMode = false;
let httpMarkerPending = '';
// Cap the partial-marker buffer so a marker line that never terminates (no
// newline) can't grow memory unbounded. Comfortably above a max-size body's
// base64 (8MB body → ~11MB line); past this we flush it as literal output.
const MAX_MARKER_PENDING = 24 * 1024 * 1024;
/** @type {{ marker: string, buffer: string, startedAt: number, lastChunkAt: number, reject: (error: Error) => void, resolve: (r: {exitCode: number, stdout: string, stderr: string, timing: {totalMs: number, tailMs: number}}) => void } | null} */
let activeRunCapture = null;
/** @type {string[] | null} */
let preTerminalBuffer = [];

// Held tail across calls -- catches markers that straddle a chunk
// boundary (the strip regex only sees one chunk at a time).
let xtermStripPending = '';

const emitToTerminal = (/** @type {string} */ text) => {
  if (silentMode) return;
  // Strip complete markers + hold any trailing partial for the next chunk.
  const { out, pending } = stripChunk(xtermStripPending, text);
  xtermStripPending = pending;
  if (out.length === 0) return;
  if (term) {
    term.write(out);
  } else if (preTerminalBuffer) {
    preTerminalBuffer.push(out);
  }
};

const emitStripped = (/** @type {string} */ text) => {
  if (activeRunCapture) {
    activeRunCapture.buffer += text;
    // Completion is the -end marker (run-capture.js), not the exit-code marker:
    // the stderr section streams BETWEEN them, so resolving earlier would race
    // a partial stderr.
    const parsed = parseRunCapture(activeRunCapture.buffer, activeRunCapture.marker);
    if (parsed) {
      const capture = activeRunCapture;
      activeRunCapture = null;
      // why timing: localize the "output showed, result lagged" gap. tailMs is the
      // time from the last output-only chunk to this completion marker — a large
      // tail means the VM stalled between producing output and the marker (a VM-
      // side cost); a near-zero tail means the lag is DOWNSTREAM (the actor's reply
      // turn + the orchestrator turn), not the VM. totalMs is the whole run.
      const doneAt = Date.now();
      capture.resolve({
        exitCode: parsed.exitCode,
        stdout: parsed.stdout,
        stderr: parsed.stderr,
        timing: {
          totalMs: doneAt - capture.startedAt,
          tailMs: capture.lastChunkAt ? doneAt - capture.lastChunkAt : 0,
        },
      });
    } else {
      // An output chunk with no marker yet — stamp it so the marker chunk can
      // measure how far behind the visible output the completion marker arrived.
      activeRunCapture.lastChunkAt = Date.now();
    }
  }
  emitToTerminal(text);
};

const handleShellByte = (/** @type {string} */ text) => {
  const buf = httpMarkerPending + text;
  httpMarkerPending = '';
  let out = '';
  let i = 0;
  while (i < buf.length) {
    // findNextMarker returns the EARLIEST of the GET fast-path marker
    // (___PEERD_HTTP___) and the rich-request marker (___PEERD_REQ___), so the
    // two coexist without the scanner missing one behind the other.
    const found = findNextMarker(buf, i);
    if (!found) {
      // Hold back any trailing bytes that could be a marker split across the
      // chunk boundary, so the next chunk can complete it.
      const holdFrom = partialMarkerHoldIndex(buf);
      out += buf.slice(i, holdFrom);
      httpMarkerPending = buf.slice(holdFrom);
      break;
    }
    const { index: mStart, kind, marker } = found;
    const nlIdx = buf.indexOf('\n', mStart);
    if (nlIdx < 0) {
      // marker present but its line hasn't fully arrived yet — wait for more,
      // unless it's grown past the cap (never-terminated / oversized), in which
      // case flush it as literal output instead of buffering unbounded.
      const pending = buf.slice(mStart);
      if (pending.length > MAX_MARKER_PENDING) {
        out += buf.slice(i);
        httpMarkerPending = '';
      } else {
        out += buf.slice(i, mStart);
        httpMarkerPending = pending;
      }
      break;
    }
    const parsed = parseMarkerLine(kind, buf.slice(mStart + marker.length, nlIdx));
    if (parsed) {
      out += buf.slice(i, mStart);
      serveVmHttp(parsed);
      i = nlIdx + 1;
    } else {
      // Malformed marker line: emit the prefix literally and move past it
      // rather than swallow terminal output.
      out += buf.slice(i, mStart + marker.length);
      i = mStart + marker.length;
    }
  }
  if (out) emitStripped(out);
};

/** Track previous call's DataDevice paths so we can delete (DataDevice
    writeFile is add-only). */
/** @type {any} */ let prevFetchPaths = null;

// Ask the SW to perform one fetch (denylist + SSRF + audit + cache live there).
// The wire carries the body as base64 (binary-safe on the PTY); decode it to
// bytes here so fetch sends the real payload, not the base64 text.
/** @param {any} req @returns {Promise<any>} */
const swFetch = (req) => browser.runtime.sendMessage({
  type: 'sw/web-fetch',
  url: req.url,
  method: req.method,
  headers: Object.keys(req.headers ?? {}).length ? req.headers : undefined,
  body: req.body != null ? base64ToBytes(req.body) : undefined,
  // why req.auth is safe here: only the HOST's own control ops (handleControlOp
  // git-clone) build request objects with auth:'git', on URLs the host derived.
  // VM-decoded requests carry NO auth field (the wire format has none), so the
  // VM cannot make the SW attach a token to a VM-chosen request.
  gitAuth: req.auth === 'git' || undefined,
});

// peerd:// control ops — host-side orchestration the VM can't do itself
// (git-clone, pkg installs). The tested flow lives in vm-net/control-ops.js
// (pure, IO injected); here we just bind the IO to swFetch + the DataDevice
// stage. `auth:'git'` is set ONLY inside runControlOp's git-clone path, on URLs
// the host derived — never from VM input.
const controlOpIo = (/** @type {any} */ ctx) => ({
  fetchJson: async (/** @type {string} */ url, /** @type {any} */ opts = {}) => {
    const r = await swFetch({ url, method: 'GET', auth: opts.auth });
    if (!r?.ok || !r.bodyB64) return null;
    return JSON.parse(new TextDecoder().decode(base64ToBytes(r.bodyB64)));
  },
  fetchBytes: async (/** @type {string} */ url, /** @type {any} */ opts = {}) => {
    const r = await swFetch({ url, method: 'GET', auth: opts.auth });
    if (!r?.ok || !r.bodyB64) return null;
    return base64ToBytes(r.bodyB64);
  },
  stage: ctx.stage,
});
const handleControlOp = (/** @type {any} */ request, /** @type {any} */ ctx) => runControlOp(request, controlOpIo(ctx));

// Serialize bridge requests through a one-at-a-time queue. Normal use is
// ALREADY sequential — the bash wrappers block polling for each response before
// emitting the next marker — so this is a no-op for legitimate traffic. Its job
// is to bound a MALICIOUS marker-burst (a VM printing thousands of markers
// without waiting): it caps BOTH the in-flight fetch concurrency (to one, so no
// unbounded fan-out of 50MB-buffering fetches) AND the queued-job COUNT (so the
// pending-closure chain can't grow without limit). Beyond the cap we shed load
// by staging an immediate error so the VM's poll sees /peerderr instead of
// hanging. Keeps the prevFetchPaths cleanup (assumes sequential) correct.
const MAX_BRIDGE_QUEUE = 512;
let bridgeQueue = Promise.resolve();
let bridgeDepth = 0;

// Stage an error response for a request we won't run (load-shed), so the VM's
// peerd-fetch poll resolves instead of timing out.
const stageBridgeError = async (/** @type {any} */ parsed, /** @type {string} */ msg) => {
  const sid = parsed.id.replace(/[^a-zA-Z0-9]/g, '');
  if (!sid) return;
  try {
    await dataDev.writeFile(`/peerderr${sid}`, new TextEncoder().encode(msg));
    await dataDev.writeFile(`/peerddone${sid}`, new Uint8Array([0x6f, 0x6b, 0x0a]));
  } catch { /* best effort */ }
};

const serveVmHttp = (/** @type {any} */ parsed) => {
  if (bridgeDepth >= MAX_BRIDGE_QUEUE) {
    return stageBridgeError(parsed, 'peerd-fetch: too many concurrent requests (load-shed)\n');
  }
  bridgeDepth++;
  const job = bridgeQueue.then(() => serveVmHttpInner(parsed)).finally(() => { bridgeDepth--; });
  bridgeQueue = job.catch(() => {}); // one failure must not break the chain
  return job;
};

// Unified handler for both marker kinds. `parsed` is the structured descriptor
// from parseMarkerLine: a GET fast-path {kind:'get',id,url} or a rich
// {kind:'req',id,request}. The GET path keeps its exact legacy semantics
// (body-only, >=400 → error, no meta file) so peerd-fetch is untouched; the
// rich path returns status + headers + body so curl -i/-f/-w, POST, and the
// peerd:// control ops work.
const serveVmHttpInner = async (/** @type {any} */ parsed) => {
  const sid = parsed.id.replace(/[^a-zA-Z0-9]/g, '');
  if (!sid) return;
  const rich = parsed.kind === 'req';
  const request = rich ? parsed.request : { method: 'GET', url: parsed.url, headers: {}, body: null };
  const t0 = Date.now();
  const shortUrl = request.url.length > 80 ? `${request.url.slice(0, 77)}...` : request.url;

  if (prevFetchPaths) {
    for (const p of prevFetchPaths) {
      try { await dataDev.delete(p); } catch { /* file may not exist */ }
    }
    prevFetchPaths = null;
  }

  let bodyBytes = null;
  let errMsg = null;
  let metaObj = null;
  let respMeta = '';
  try {
    if (rich && request.url.startsWith('peerd://')) {
      // stage(): write a file the VM keeps (NOT tracked in prevFetchPaths, so it
      // survives the next request's cleanup) — used to drop wheels/tarballs into
      // the VM for the offline install tail. The shim removes them when done.
      const stage = async (/** @type {string} */ name, /** @type {any} */ bytes) => {
        const devPath = `/pkgstage_${sid}_${name}`;
        await dataDev.writeFile(devPath, bytes);
        return `/peerd-data/pkgstage_${sid}_${name}`;
      };
      const r = /** @type {any} */ (await handleControlOp(request, { sid, stage }));
      bodyBytes = r.bodyBytes ?? null;
      errMsg = r.errMsg ?? null;
      metaObj = r.meta ?? null;
      respMeta = `control op -> ${errMsg ? 'ERR' : `OK ${bodyBytes?.byteLength ?? 0}B`}`;
    } else {
      const resp = await swFetch(request);
      respMeta = `ok=${resp?.ok} status=${resp?.status} bodyLen=${resp?.bodyB64?.length ?? 0}${resp?.fromCache ? ` cache=${resp.fromCache}` : ''}`;
      if (!resp || (resp.error && resp.bodyB64 == null)) {
        errMsg = `peerd-fetch: ${resp?.error ? friendlyFetchError(resp.error) : 'request failed'}\n`;
      } else if (!rich && (!resp.ok || resp.status >= 400)) {
        // GET fast path: legacy behavior — a >=400 is an error, body discarded.
        errMsg = resp.error ? `peerd-fetch: ${friendlyFetchError(resp.error)}\n` : `peerd-fetch: HTTP ${resp.status}\n`;
      } else {
        bodyBytes = resp.bodyB64 != null ? base64ToBytes(resp.bodyB64) : new Uint8Array(0);
        metaObj = { status: resp.status, statusText: resp.statusText, headers: resp.headers ?? {} };
      }
    }
  } catch (e) {
    errMsg = `peerd-fetch: ${(/** @type {{ message?: string }} */ (e))?.message ?? String(e)}\n`;
    respMeta = `threw: ${(/** @type {{ message?: string }} */ (e))?.message ?? String(e)}`;
  }
  const fetchMs = Date.now() - t0;
  const outcome = errMsg ? `ERR ${errMsg.trim()}` : `OK ${bodyBytes?.byteLength ?? 0}B`;

  const respPath = `/peerdresp${sid}`;
  const errPath = `/peerderr${sid}`;
  const metaPath = `/peerdmeta${sid}`;
  const donePath = `/peerddone${sid}`;
  const written = [];
  let stagingMs = -1;
  const stageStart = Date.now();
  try {
    if (bodyBytes) {
      await dataDev.writeFile(respPath, bodyBytes);
      written.push(respPath);
    } else {
      await dataDev.writeFile(errPath, new TextEncoder().encode(errMsg ?? 'unknown\n'));
      written.push(errPath);
    }
    // The rich path always stages a meta file (status + headers) so the
    // peerd-http wrapper can expose them; the GET fast path never does.
    if (rich && metaObj) {
      await dataDev.writeFile(metaPath, new TextEncoder().encode(encodeResponseMeta(metaObj)));
      written.push(metaPath);
    }
    await dataDev.writeFile(donePath, new Uint8Array([0x6f, 0x6b, 0x0a]));
    written.push(donePath);
    stagingMs = Date.now() - stageStart;
    prevFetchPaths = written;
  } catch (e) {
    stagingMs = Date.now() - stageStart;
    trace('error', `[fetch] staging failed sid=${sid}: ${(/** @type {{ message?: string }} */ (e))?.message ?? String(e)}`);
  }
  trace('info', `[fetch] ${request.method} ${shortUrl} -> ${outcome} (${fetchMs + stagingMs}ms) [${respMeta}]`);
};

// ---------------------------------------------------------------------------
// runViaShell: send a command into the persistent bash, capture stdout
// via the marker sentinel. Used for the install/verify and for every
// agent-issued vm/run.
// ---------------------------------------------------------------------------

/** @type {any} */ let shellExit = null;

const runViaShell = async (/** @type {string} */ cmd, /** @type {any} */ opts = {}) => {
  if (shellExit !== null) throw new Error(`persistent shell is dead (exit ${shellExit})`);
  const marker = makeMarker();
  // Per-call stderr capture file inside the VM (run-capture.js protocol); the
  // wrapper replays it between the -err/-end markers and removes it.
  const errFile = `${ERRFILE_PREFIX}${Math.random().toString(36).slice(2, 10)}`;
  /** @type {{ marker: string, buffer: string, startedAt: number, lastChunkAt: number, resolve: ((r: any) => void) | null, reject: ((error: Error) => void) | null }} */
  const capture = { marker, buffer: '', startedAt: Date.now(), lastChunkAt: 0, resolve: null, reject: null };
  let abortListener;
  const completion = new Promise((resolve, reject) => {
    capture.resolve = resolve; capture.reject = reject;
    if (opts.signal) {
      abortListener = () => {
        // Interrupt the still-running foreground command (SIGINT + Ctrl-C + newline)
        // so a timed-out command actually STOPS - otherwise it keeps running in
        // the persistent bash and its output bleeds into the next command.
        try { pty?.kill('SIGINT'); writePty('\x03\n'); } catch { /* shell gone */ }
        reject(new Error('aborted'));
      };
      opts.signal.addEventListener('abort', abortListener, { once: true });
    }
  });
  activeRunCapture = /** @type {any} */ (capture);
  const effectiveSilent = !!opts.silent;
  if (effectiveSilent) silentMode = true;
  const wrappedCmd = `\x15${buildWrappedCommand(cmd, marker, errFile)}`;
  try {
    if (!pty) throw new Error('persistent shell not started');
    await pty.write(wrappedCmd);
    // parseRunCapture already sliced the echo off and split stdout/stderr.
    return await completion;
  } finally {
    if (activeRunCapture === capture) activeRunCapture = null;
    if (effectiveSilent) silentMode = false;
    if (abortListener && opts.signal) opts.signal.removeEventListener('abort', abortListener);
  }
};

// ---------------------------------------------------------------------------
// Wrapper install (via DataDevice staging + source). Silent by default;
// devMode surfaces the [diag]/[verify] output. Never traces the shell.
// ---------------------------------------------------------------------------

const installWrappers = async () => {
  const encoder = new TextEncoder();
  const stagingName = `/peerdwrappers${Date.now().toString(36)}`;
  // why NO `set -x` prepend: it stays ON in the PERSISTENT shell and then traces
  // EVERY later interactive command — including peerd's own ___PEERD_*___
  // completion markers and the http/pkg-fetch bridge plumbing — so one `pip
  // install` reads as 40 lines of `+ __peerd_emit_req …`. devMode instead just
  // makes the one-time install/verify output VISIBLE at boot (the `silent` flag
  // below); off by default it stays captured-but-hidden (parsed for [verify],
  // never dumped). Your own commands are never traced either way.
  const wrappersSrc = WRAPPERS_BASH;
  await dataDev.writeFile(stagingName, encoder.encode(wrappersSrc));
  const stagedPath = `/peerd-data${stagingName}`;
  const script = [
    `echo "[diag] uid=$(id -u) user=$(whoami) HOME=$HOME"`,
    `echo "[diag] BASH_VERSION=$BASH_VERSION"`,
    `echo "[diag] sourcing ${stagedPath}"`,
    '',
    `source ${stagedPath}`,
    '',
    'for __f in peerd-fetch curl wget git; do',
    '  __t="$(type -t "$__f")"',
    '  if [ "$__t" = "function" ]; then',
    '    echo "[verify] ok:$__f"',
    '  else',
    '    echo "[verify] MISSING:$__f(type=${__t:-none})"',
    '  fi',
    'done',
    'unset __f __t',
    'echo "[peerd-egress] bash function wrappers installed"',
  ].join('\n');
  return runViaShell(script, { silent: !vmDevMode });
};

// ---------------------------------------------------------------------------
// Base-image integrity pin (TOFU) - the imperative shell around
// peerd-engine/image-pin.js.
//
// THE TRUST BOUNDARY, stated plainly: unkernel's HttpBase streams the
// read-only Debian EROFS rootfs lazily over HTTP Range requests with strict
// ETag/size checks on every range. Before opening the disk, we fetch the first
// 64 KiB + total size ourselves and pin them on first use. That fails the boot
// CLOSED if the bytes behind the pinned URL ever change under existing per-VM
// persistent data disks.
// ---------------------------------------------------------------------------

const sha256Hex = async (/** @type {any} */ buf) => {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

/**
 * @returns {Promise<{ action: 'skipped', reason: string }
 *         | { action: 'record' | 'match', observed: object }
 *         | { action: 'mismatch', mismatches: string[], pinned: object, observed: object }>}
 */
const verifyImagePin = async (/** @type {string} */ url) => {
  let resp;
  try {
    // why bare fetch (not safeFetch/webFetch): this is the SAME host +
    // bytes the vendored unkernel HttpBase streams from this page - pinned
    // infrastructure data verified by hash here, not agent-driven
    // egress; the egress allowlist semantics don't apply (same
    // precedent as voice/model-store's SRI-checked model download).
    // eslint-disable-next-line no-restricted-globals
    resp = await fetch(url, {
      headers: { Range: `bytes=0-${IMAGE_PIN_HEAD_BYTES - 1}` },
    });
  } catch (e) {
    // why skip instead of fail: a VM whose overlay already cached the
    // blocks it needs can boot OFFLINE; hard-failing on an unreachable
    // host would regress that. Unverifiable ≠ changed.
    return { action: 'skipped', reason: `image host unreachable: ${(/** @type {{ message?: string }} */ (e))?.message ?? String(e)}` };
  }
  if (resp.status !== 206) {
    // why not read the body: a non-206 means the host ignored the Range
    // request, so the body could be the full multi-GB image.
    try { await resp.body?.cancel(); } catch { /* already drained */ }
    return { action: 'skipped', reason: `ranged probe answered ${resp.status} (expected 206)` };
  }
  const head = await resp.arrayBuffer();
  const observed = {
    totalBytes: parseContentRangeTotal(resp.headers.get('content-range')),
    headSha256: await sha256Hex(head),
  };
  /** @type {Record<string, any>} */ let pins = {};
  try {
    const stored = await browser.storage.local.get(IMAGE_PIN_STORAGE_KEY);
    pins = stored?.[IMAGE_PIN_STORAGE_KEY] ?? {};
  } catch (e) {
    return { action: 'skipped', reason: `pin store unreadable: ${(/** @type {{ message?: string }} */ (e))?.message ?? String(e)}` };
  }
  const verdict = evaluateImagePin({ pinned: pins[url] ?? null, observed });
  if (verdict.action === 'record') {
    try {
      pins[url] = { ...observed, pinnedAt: Date.now() };
      await browser.storage.local.set({ [IMAGE_PIN_STORAGE_KEY]: pins });
    } catch (e) {
      return { action: 'skipped', reason: `pin store unwritable: ${(/** @type {{ message?: string }} */ (e))?.message ?? String(e)}` };
    }
  }
  return /** @type {any} */ ({ ...verdict, pinned: pins[url] ?? null, observed });
};

// ---------------------------------------------------------------------------
// Export — download this VM as a .peerd recipe (DESIGN-10). The SW
// reads the registry record + the stored image pin; the recipe carries
// the base-image URL + TOFU pin so the receiver pins BEFORE first boot.
// The disk overlay deliberately does NOT travel (100s of MB–GBs).
// why button-text feedback: once booted, the boot log is hidden and the
// terminal belongs to the shell — the button is the only chrome.
// ---------------------------------------------------------------------------

const exportVm = async () => {
  DOM.exportBtn.disabled = true;
  try {
    const reply = /** @type {any} */ (await browser.runtime.sendMessage({
      type: 'export/artifact', kind: 'vm', id: vmId,
    }));
    if (!reply?.ok) throw new Error(reply?.error ?? 'export failed');
    const blob = new Blob([JSON.stringify(reply.envelope)], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = reply.filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.warn('[vm-tab] export failed:', e);
    trace('warn', `export failed: ${(/** @type {{ message?: string }} */ (e))?.message ?? String(e)}`);
    DOM.exportBtn.textContent = 'export failed';
    setTimeout(() => { DOM.exportBtn.textContent = 'export ⤓'; }, 2500);
  } finally {
    DOM.exportBtn.disabled = false;
  }
};

DOM.exportBtn.addEventListener('click', exportVm);

// ---------------------------------------------------------------------------
// Main boot sequence
// ---------------------------------------------------------------------------

const boot = async () => {
  // 1. Load registry record
  setStage('Loading VM metadata');
  let record;
  try {
    record = await loadVmRecord();
  } catch (e) {
    failBoot('Could not load VM metadata', e);
    return;
  }
  vmId = record.id;
  vmName = record.name;
  diskOverlayKey = record.diskOverlayKey;
  document.title = `peerd · ${vmName}`;
  // Export needs a loaded record (the SW reads it by id); unhide only
  // once one exists so the button can never fire against nothing.
  DOM.exportBtn.hidden = false;
  trace('info', `vm record loaded: id=${vmId} name=${vmName} disk=${diskOverlayKey}`);

  // 1b. One tab per disk (see disk-lock.js): refuse before any device mounts.
  const diskLock = await holdDiskLock(diskOverlayKey);
  if (diskLock !== 'held') {
    // why drop the hash: after a service-worker restart the tab tracker adopts
    // every tab whose URL names this VM, and the last one wins. A refused tab
    // must not be a candidate, or agent commands land on a page with no VM.
    history.replaceState(null, '', location.pathname);
    if (diskLock === 'busy') failBoot('VM already open in another tab', 'close this tab and use the open one');
    else failBoot('Could not lock the VM disk', 'close this tab and reopen the VM to try again');
    return;
  }

  // 2. Load unkernel runtime + pre-flight JSPI support check
  // Single-CPU unkernel uses WebAssembly JSPI (WebAssembly.Suspending), not
  // SharedArrayBuffer, so WebVM runs on both Chrome 137+ and Firefox 153+.
  setStage('Loading unkernel');
  let mod;
  try { mod = await loadUnkernel(); }
  catch (e) { return failBoot('Failed to load unkernel module', e); }
  const {
    checkSupport,
    createKernel,
    openDistroDisk,
    openDataDisk,
    bundledBoot,
    gunzipIfNeeded,
    MemoryFs,
    ConsoleRouter,
  } = mod;
  const support = await checkSupport();
  trace(support.ok ? 'info' : 'warn',
    `wasm=${support.wasm} bigint=${support.bigint} jspi=${support.jspi}`);
  if (!support.ok) {
    failBoot('WebAssembly JSPI unavailable',
      new Error(`${support.problems.join('; ')}. WebVM requires Chrome/Edge 137+, Firefox 153+, or Safari 27+.`));
    return;
  }
  trace('info', `unkernel module loaded; base image = ${STOCK_DEBIAN_IMAGE_HTTP}`);

  // 3. Decompress and compile the bundled Linux 7.x Wasm kernel
  setStage('Compiling Linux kernel');
  let kernelModule;
  try {
    const wasmUrl = browser.runtime.getURL(UNKERNEL_WASM_GZ_PATH);
    // eslint-disable-next-line no-restricted-globals
    const wasmResp = await fetch(wasmUrl);
    if (!wasmResp.ok) throw new Error(`HTTP ${wasmResp.status} loading ${UNKERNEL_WASM_GZ_PATH}`);
    const wasmBytes = await gunzipIfNeeded(await wasmResp.arrayBuffer());
    kernelModule = await WebAssembly.compile(wasmBytes);
    trace('info', `kernel compiled (${(wasmBytes.byteLength / (1024 * 1024)).toFixed(1)} MiB)`);
  } catch (e) {
    return failBoot('Failed to compile Linux kernel', e);
  }

  // 4. Integrity-pin the streamed rootfs (TOFU - see verifyImagePin's
  //    trust-boundary comment). A mismatch fails the boot OUTRIGHT: streaming
  //    a changed base image under existing per-VM persistent data risks silent
  //    overlay corruption. Unverifiable (offline / non-206 / pin store
  //    unavailable) only warns.
  setStage('Verifying disk image');
  /** @type {any} */ let imagePin;
  try {
    imagePin = await verifyImagePin(STOCK_DEBIAN_IMAGE_HTTP);
  } catch (e) {
    imagePin = { action: 'skipped', reason: (/** @type {{ message?: string }} */ (e))?.message ?? String(e) };
  }
  if (imagePin.action === 'mismatch') {
    return failBoot('Disk image integrity', new VMBootFailedError(
      'image-integrity',
      new Error(
        `the bytes behind ${STOCK_DEBIAN_IMAGE_HTTP} changed since first use `
        + `(${imagePin.mismatches.join(' + ')} differ). Streaming a different base `
        + `image under this VM's existing disk overlay would silently corrupt it, `
        + `so the boot was refused. If the image was legitimately republished, `
        + `existing VMs cannot be migrated - create a new VM after clearing the `
        + `stored pin (chrome.storage.local key '${IMAGE_PIN_STORAGE_KEY}').`,
      ),
    ));
  }
  if (imagePin.action === 'skipped') {
    trace('warn', `image pin: verification skipped - ${imagePin.reason}`);
  } else {
    trace('info', `image pin: ${imagePin.action === 'record' ? 'recorded (first use)' : 'verified'} `
      + `head=${imagePin.observed.headSha256.slice(0, 16)}... total=${imagePin.observed.totalBytes ?? 'unknown'}B`);
  }

  // 5. Open persistent per-VM ext4 data disk (IndexedDB) + lazy HTTP Range
  //    Debian erofs distro image + host-backed 9p /peerd-data mount.
  setStage('Mounting disk', `Opening ${diskOverlayKey} and streaming Debian image...`);
  let distroDisk;
  try {
    const bootBundle = bundledBoot(kernelModule);
    if (!bootBundle.datadisk) {
      throw new Error('bundled kernel has no unkernel.datadisk template');
    }
    trace('info', `openDataDisk -> ${diskOverlayKey} (${DATA_DISK_VERSION})`);
    dataDisk = await openDataDisk({
      name: diskOverlayKey,
      version: DATA_DISK_VERSION,
      template: bootBundle.datadisk,
      log: (/** @type {string} */ msg) => trace('info', msg),
      onError: (/** @type {any} */ err) => trace('warn', `data disk save failed: ${err?.message ?? String(err)}`),
    });
    if (dataDisk.notice) trace('warn', `data disk: ${dataDisk.notice}`);
    trace('info', `openDistroDisk -> ${STOCK_DEBIAN_IMAGE_HTTP}`);
    distroDisk = await openDistroDisk(STOCK_DEBIAN_IMAGE_HTTP, {
      log: (/** @type {string} */ msg) => trace('info', msg),
    });
    peerdDataFs = new MemoryFs();
    dataDev = {
      writeFile: async (/** @type {string} */ path, /** @type {string | Uint8Array} */ content) => {
        peerdDataFs.writeFile(path, content);
      },
      delete: async (/** @type {string} */ path) => {
        peerdDataFs.rm(path, { force: true });
      },
    };
  } catch (e) {
    return failBoot('Disk setup failed', e);
  }

  // 6. Boot Linux 7.x via unkernel.
  // Deliberately omit `net`: all guest networking stays routed through peerd's
  // audited, denylist-gated HTTP bridge (sw/web-fetch) over /peerd-data.
  setStage('Booting Linux');
  try {
    trace('info', 'createKernel');
    vm = await createKernel({
      kernel: kernelModule,
      distro: distroDisk,
      disks: [dataDisk],
      mounts: {
        '/peerd-data': { fs: peerdDataFs, readOnly: true },
      },
      jit: true,
      onProgress: (/** @type {any} */ p) => {
        if (p?.stage) trace('info', `kernel: ${p.stage}`);
      },
    });
    if (ConsoleRouter) {
      const consoleRouter = new ConsoleRouter({
        onKernelLine: (/** @type {string} */ line, /** @type {{ important?: boolean }} */ meta) => {
          if (meta?.important) trace('warn', `[kernel] ${line}`);
        },
        onUserOutput: () => {},
      });
      vm.onOutput((/** @type {Uint8Array} */ bytes) => consoleRouter.write(bytes));
    }
    trace('info', `Linux booted (${vm.memoryMiB} MiB RAM)`);
  } catch (e) {
    return failBoot('Linux boot failed', e);
  }

  // 7. Spawn persistent interactive login bash on a real PTY (via kwtty/vsock)
  setStage('Starting shell');
  const decoder = new TextDecoder();
  // why: an active command can change disk before exit. Reject without the safe retry flag.
  const shellEnded = (/** @type {number} */ status) => {
    if (shellExit !== null) return;
    shellExit = status;
    pty = null;
    const capture = activeRunCapture; activeRunCapture = null;
    capture?.reject(new VMNotReadyError(`persistent shell exited (${status}); command outcome unknown`));
    trace('warn', `persistent shell exited (${status})`);
  };
  vm.exited.then(
    (/** @type {any} */ res) => shellEnded(res?.code ?? -1),
    () => shellEnded(-1),
  );
  try {
    pty = await vm.spawn('/bin/bash', ['--login', '-i'], {
      cols: 80,
      rows: 24,
      term: 'xterm',
      user: 'user',
      cwd: '/home/user',
      env: {
        TERM: 'xterm',
        HOME: '/home/user',
        USER: 'user',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        KW_AUTO_APT: '0',
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      },
    });
  } catch (e) {
    return failBoot('Shell spawn failed', e);
  }
  pty.ended.then(
    (/** @type {any} */ end) => shellEnded(end?.type === 'exit' ? end.code : -1),
    () => shellEnded(-1),
  );
  // Drain pty.output continuously (unkernel applies backpressure if unread).
  (async () => {
    const reader = pty.output.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text) handleShellByte(text);
      }
      const tail = decoder.decode();
      if (tail) handleShellByte(tail);
    } catch { /* pty closed */ }
    finally { reader.releaseLock(); }
  })();
  // Real SIGWINCH resize over kwtty!
  syncConsoleSize = () => {
    if (pty && term?.cols && term?.rows) pty.resize(term.cols, term.rows);
  };

  // 8. Wait briefly for the prompt to settle
  await new Promise((r) => setTimeout(r, 300));
  trace('info', 'persistent shell ready');

  // 9. Install wrappers (silent)
  try {
    trace('info', 'installing peerd-egress wrappers');
    const install = await installWrappers();
    const verifyLines = install.stdout.split('\n')
      .map((/** @type {string} */ l) => l.trim())
      .filter((/** @type {string} */ l) => l.startsWith('[verify]'))
      .map((/** @type {string} */ l) => l.replace(/^\[verify\]\s*/, ''));
    const missing = verifyLines.filter((/** @type {string} */ l) => l.startsWith('MISSING:'));
    if (install.exitCode !== 0) {
      trace('warn', `wrapper install exit=${install.exitCode}: ${install.stdout.slice(0, 500)}`);
    }
    if (missing.length) {
      trace('warn', `wrapper verify FAILED: ${missing.join(', ')}`);
    } else if (verifyLines.length === 4) {
      trace('info', `wrappers verified: ${verifyLines.join(', ')}`);
    }
  } catch (e) {
    trace('warn', `wrapper install threw: ${(/** @type {{ message?: string }} */ (e))?.message ?? String(e)} (continuing)`);
  }

  // 10. Swap boot card for terminal
  trace('info', 'mounting xterm');
  try {
    mountTerminal();
  } catch (e) {
    failBoot('xterm mount failed', e);
    return;
  }
  setStatus('ready', 'ready');
  trace('info', 'ready');

  // why: frame the networking model up front so the raw-socket ceiling and the
  // HTTP-native capabilities aren't a surprise (and `peerd-net` is discoverable).
  emitToTerminal(`\r\n${bannerText()}\r\n\r\n`);

  // 11. Announce ourselves so the SW can map vmId -> tabId
  browser.runtime.sendMessage({ type: 'vm/tab-ready', vmId })
    .catch((e) => console.debug('[vm-tab] tab-ready send failed', e));
};

const failBoot = (/** @type {string} */ stage, /** @type {any} */ err) => {
  setStatus('failed', 'failed');
  setStage('Boot failed', `${stage}: ${err?.message ?? String(err)}`);
  DOM.bootCard.classList.add('is-failed');
  trace('error', `boot failed @ ${stage}: ${err?.message ?? String(err)}`);
  void browser.runtime.sendMessage({ type: 'vm/tab-failed', vmId: vmId ?? location.hash.slice(1) }).catch(() => {});
};

// ---------------------------------------------------------------------------
// xterm mount + input wiring (runs once unkernel is ready)
// ---------------------------------------------------------------------------

const mountTerminal = () => {
  const TerminalCtor = (/** @type {any} */ (globalThis)).Terminal;
  const FitAddonNS = (/** @type {any} */ (globalThis)).FitAddon;
  if (!TerminalCtor) {
    failBoot('xterm.js not loaded', new Error('global Terminal missing'));
    return;
  }
  term = new TerminalCtor({
    // why: mirrors the boot console's monochrome phosphor (styles.css
    // :root) so boot→shell reads as one continuous surface — the rainbow
    // orb is the only color in the vm-tab; amber stays favicon-only.
    theme: {
      background: '#080909',
      foreground: '#F3F3EF',
      cursor: '#F3F3EF',
      selectionBackground: '#F3F3EF40',
    },
    fontSize: 13,
    fontFamily: 'JetBrains Mono, ui-monospace, "SF Mono", Menlo, monospace',
    cursorBlink: true,
    convertEol: true,
    scrollback: 10_000,
    allowProposedApi: true,
  });
  try {
    if (FitAddonNS?.FitAddon) {
      fitAddon = new FitAddonNS.FitAddon();
      term.loadAddon(fitAddon);
    }
  } catch (e) { console.warn('[vm-tab] fit addon failed', e); }

  DOM.bootCard.hidden = true;
  DOM.terminal.hidden = false;
  term.open(DOM.terminal);
  term.onResize(syncConsoleSize);
  try { fitAddon?.fit(); } catch { /* no-op */ }
  syncConsoleSize();

  // Opening banner — the live shell continues the boot console's look:
  // the wordmark letters in their module colors (24-bit ANSI; same five
  // as styles.css :root) on an otherwise-dim line. why: the wordmark and
  // the orb are peerd's only color carriers (brand rule, CLAUDE.md) —
  // the orb leaves with the boot card, the wordmark takes over in here.
  const BRAND = [
    ['p', '0;183;235'],   // cyan
    ['e', '239;68;68'],   // red
    ['e', '245;158;11'],  // amber
    ['r', '34;197;94'],   // green
    ['d', '217;70;239'],  // magenta
  ].map(([ch, rgb]) => `\x1b[1m\x1b[38;2;${rgb}m${ch}\x1b[0m`).join('');
  const DIM = (/** @type {any} */ s) => `\x1b[2m${s}\x1b[0m`;
  term.write(`${BRAND} ${DIM('· webvm — linux on webassembly · tty0')}\r\n\r\n`);

  // Drain pre-mount PTY output into xterm.
  if (preTerminalBuffer) {
    for (const chunk of preTerminalBuffer) term.write(chunk);
    preTerminalBuffer = null;
  }

  // User keystrokes -> bash stdin (UTF-8 native via unkernel kwtty).
  term.onData((/** @type {any} */ data) => {
    writePty(data);
  });

  // Auto-resize.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      try { fitAddon?.fit(); } catch { /* no-op */ }
    });
    ro.observe(DOM.terminal);
  }
  // Focus terminal on click anywhere in the tab body.
  DOM.terminal.addEventListener('click', () => term.focus());
  term.focus();
};

// ---------------------------------------------------------------------------
// Message handlers (SW → tab)
// ---------------------------------------------------------------------------

const DEFAULT_RUN_TIMEOUT_MS = 60_000;

// why cast: untyped cross-context message payload + the polyfill's strict
// OnMessageListener return-type (mirrors offscreen.js / pdf-extract.js).
browser.runtime.onMessage.addListener(/** @type {any} */ ((/** @type {any} */ msg, /** @type {any} */ _sender, /** @type {any} */ sendResponse) => {
  // Only handle vm/* messages targeted at this tab. The vmId field
  // lets the SW broadcast vm/reset to all tabs and only the addressed
  // one responds.
  if (!msg?.type?.startsWith?.('vm/')) return undefined;
  if (msg.vmId && msg.vmId !== vmId) return undefined;

  (async () => {
    try {
      // why: only this check proves no input or file staging occurred. Later failures stay unknown.
      if (['vm/run', 'vm/write-file'].includes(msg.type) && (!term || shellExit !== null)) {
        sendResponse({ ok: false, error: 'VMNotReadyError: shell not ready', shellExited: shellExit !== null });
        return;
      }
      switch (msg.type) {
        case 'vm/run': {
          const timeoutMs = msg.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
          const start = Date.now();
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), timeoutMs);
          try {
            const result = await runViaShell(msg.cmd, { signal: ctrl.signal });
            syncDiskBestEffort();
            sendResponse({
              ok: true,
              result: {
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                durationMs: Date.now() - start,
                // VM-side timing breadcrumb (totalMs run, tailMs = output->marker lag);
                // the SW logs it so a slow report can be split VM-tail vs downstream.
                timing: result.timing,
              },
            });
          } catch (e) {
            if (ctrl.signal.aborted) {
              sendResponse({ ok: false, error: `VMRunTimeoutError: cmd timed out after ${timeoutMs}ms` });
            } else {
              sendResponse({ ok: false, error: (/** @type {{ message?: string }} */ (e))?.message ?? String(e) });
            }
          } finally {
            clearTimeout(timer);
          }
          return;
        }

        case 'vm/write-file': {
          const bytes = base64ToBytes(msg.b64);
          const stagingName = `/peerd${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
          try {
            await dataDev.writeFile(stagingName, bytes);
            const dir = msg.path.replace(/\/[^/]*$/, '') || '/';
            const stagedPath = `/peerd-data${stagingName}`;
            const cmd = `mkdir -p ${shellEscape(dir)} && cp ${shellEscape(stagedPath)} ${shellEscape(msg.path)}`;
            const r = await runViaShell(cmd, { silent: true });
            try { await dataDev.delete(stagingName); } catch { /* ignore */ }
            if (r.exitCode !== 0) {
              sendResponse({ ok: false, error: `writeFile cp failed (exit ${r.exitCode}): ${r.stderr || r.stdout}` });
            } else {
              await vm?.sync?.({ timeout: 5000 }).catch(() => {});
              sendResponse({ ok: true });
            }
          } catch (e) {
            sendResponse({ ok: false, error: (/** @type {{ message?: string }} */ (e))?.message ?? String(e) });
          }
          return;
        }

        case 'vm/is-ready': {
          sendResponse({ ok: true, ready: !!term && shellExit === null, shellExited: shellExit !== null, vmId });
          return;
        }

        case 'vm/reset': {
          // Flush persistent disk and reload the page. Disk state persists in IDB.
          try { await vm?.sync?.({ timeout: 3000 }); } catch { /* best effort */ }
          try { await vm?.stop?.(); } catch { /* best effort */ }
          sendResponse({ ok: true });
          setTimeout(() => location.reload(), 50);
          return;
        }

        default:
          // Don't respond to unknown vm/* messages targeted elsewhere.
          return;
      }
    } catch (e) {
      console.error('[vm-tab] handler threw', msg.type, e);
      sendResponse({ ok: false, error: (/** @type {{ message?: string }} */ (e))?.message ?? String(e) });
    }
  })();
  return true;  // async response
}));

// ---------------------------------------------------------------------------
// Surface offscreen errors as boot-log entries
// ---------------------------------------------------------------------------

self.addEventListener('error', (e) => {
  trace('error', `unhandled error: ${(/** @type {{ message?: string }} */ (e))?.message ?? String(e)}`);
});
self.addEventListener('unhandledrejection', (e) => {
  trace('error', `unhandled rejection: ${e?.reason?.message ?? String(e?.reason)}`);
});

self.addEventListener('pagehide', () => {
  syncDiskBestEffort();
});

// ---------------------------------------------------------------------------
// Kickoff
// ---------------------------------------------------------------------------
//
// Reboot is just Cmd-R (or Ctrl-R) -- the browser reloads the tab,
// vm-tab.js runs again, unkernel re-mounts the same IDB data disk so
// the disk state is preserved. No reboot button needed.

// A peerd-owned tab carries the trigger to pull the side panel in — so you can
// keep chatting from this VM without a round-trip back to home. Mounted before
// boot so it's there during the (slow) disk stream and even if boot fails.
mountPullInPeerd();

boot();
