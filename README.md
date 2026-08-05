<p align="center">
  <br>
  <img src="docs/store/assets/peerd-wordmark.svg" alt="peerd" width="240" height="48">
  <br>
  <br>
</p>

[![CI](https://github.com/NotASithLord/peerd/actions/workflows/package-and-release.yml/badge.svg)](https://github.com/NotASithLord/peerd/actions/workflows/package-and-release.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Status: 0.x experimental](https://img.shields.io/badge/status-0.x%20experimental-orange.svg)](#status)
[![Manifest V3](https://img.shields.io/badge/Manifest%20V3-Chrome%20%26%20Firefox-informational.svg)](#install)
[![Security policy](https://img.shields.io/badge/security-policy-blue.svg)](SECURITY.md)

peerd is a browser extension that runs an AI agent in the browser. It can work
with tabs, create isolated compute environments, and build local browser apps.
You choose the model provider and supply any required key. peerd has no account,
hosted agent backend, or telemetry. Model requests go directly from the
extension to the provider you choose.

## Status

peerd is an experimental 0.x beta. Breaking changes are likely. Storage formats
and product behavior may change. It can drive browser pages and use API keys, so
review the security model before using it with sensitive data.

The code is the source of truth for current behavior. Start with
[`CLAUDE.md`](CLAUDE.md), then read the relevant module under `extension/`.

## What it does

- Runs an agent loop in a Chrome or Firefox extension.
- Reads and drives browser tabs through per-environment actors.
- Runs Linux WebVMs, JavaScript Notebooks, browser Apps, and headless scripts.
- Supports cloud and local model providers. The live list is in
  [`extension/peerd-provider/registry.js`](extension/peerd-provider/registry.js).
- Stores provider secrets in a local encrypted vault.
- Includes an optional peer-to-peer dweb in preview builds.

Apps and WebVMs currently run on Chrome only. Apps have no ambient network access. Remote
resources, fetches, WebRTC, forms, and external document navigation are blocked.
External HTTP and HTTPS links require user confirmation.

## Security model

peerd uses browser isolation, narrow tool exposure, service-worker policy gates,
and explicit egress controls. The main agent delegates environment work to
keyless actors. On Chrome, non-orchestrator agent loops run in separate worker
heaps. Firefox uses a more limited fallback where browser APIs do not provide the
same isolation features.

Network behavior depends on the operation. Model calls, web reads, runtime asset
loads, sandbox traffic, and preview dweb traffic use different scoped paths and
policies. See [`SECURITY.md`](SECURITY.md) and the
[`threat model`](docs/security/THREAT-MODEL.md) for the current boundaries and
known limitations.

## Install

### Chrome from source

1. Clone the repository.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Choose **Load unpacked** and select the `extension/` directory.

Reload the extension from `chrome://extensions` after source changes.

### Firefox from source

Firefox needs a Firefox-specific package. Do not load the checked-in Chrome
development manifest.

```sh
bun run package -- --channel=preview --browser=firefox --no-sign
```

Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**,
and select `artifacts/peerd-preview-firefox.xpi`. Temporary add-ons must be
loaded again after Firefox restarts. Browser and channel transforms are defined
by the packaging scripts.

### Release packages

See [GitHub Releases](https://github.com/NotASithLord/peerd/releases) for current
artifacts. Store and preview builds differ. Store builds omit the dweb. Preview
builds include it and may enable additional automation features. The packaging
code is the authority for each browser and channel.

## First run

1. Open peerd from the browser toolbar.
2. Create and unlock the local vault. Passphrase unlock is always available.
   Passkey unlock depends on WebAuthn PRF support in the browser and device.
3. Open Settings, then add a provider key or choose a supported local provider.
4. Select a model and start a chat.

Only vault secrets and protected security records are covered by the vault
encryption boundary. Other local extension state follows the storage rules in
the security documentation.

## Architecture

The extension has five main modules. Each module exposes its public API through
its `index.js`.

| Module | Role |
|---|---|
| [`peerd-provider`](extension/peerd-provider/) | Model adapters and response formatting |
| [`peerd-egress`](extension/peerd-egress/) | Vault, network policy, denylist, and audit |
| [`peerd-engine`](extension/peerd-engine/) | WebVM, Notebook, App, and headless execution |
| [`peerd-runtime`](extension/peerd-runtime/) | Agent loop, actors, tools, sessions, memory, and permissions |
| [`peerd-distributed`](extension/peerd-distributed/) | Preview-only peer-to-peer network and dwapps |

The extension chassis lives in `background/`, `offscreen/`, `sidepanel/`,
`engine-tabs/`, `permissions/`, `shared/`, and related support directories.

## Development

The shipped extension is vanilla JavaScript with ES modules and no bundling or
transpilation. Bun is used for tests, generation, packaging, and release checks.

```sh
bun install
bun run gen:dev
bun test ./tests
bun scripts/cdp/run-inbrowser-tests.mjs
bun run typecheck
bun run lint
bun run e2e:verify
bun run preflight
```

There are three test surfaces:

- Bun tests for pure logic.
- In-browser tests for extension and browser integration.
- Live Chrome E2E and visual verification for complete flows.

For UI changes, run `bun run e2e:verify`, inspect
`scripts/cdp/artifacts/result.json`, and inspect the generated screenshots.

Generated files must not be edited by hand. In particular,
`extension/manifest.json` and `extension/shared/channel-config.js` come from the
manifest and packaging sources. CI checks them for drift.

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before changing code.

## Documentation

- [`CLAUDE.md`](CLAUDE.md): project structure, conventions, and current posture
- [`SECURITY.md`](SECURITY.md): security policy and reporting
- [`docs/security/THREAT-MODEL.md`](docs/security/THREAT-MODEL.md): trust boundaries and residual risks
- [`docs/security/RED-TEAM-RESULTS.md`](docs/security/RED-TEAM-RESULTS.md): red-team coverage
- [`docs/store/`](docs/store/): store packaging, permissions, privacy, and reviewer notes
- [`scripts/cdp/GALLERY.md`](scripts/cdp/GALLERY.md): E2E and visual states

Design records under `docs/design/` are point-in-time proposals. They explain
past decisions and planned work. They do not override current code.

## Dependencies and license

Runtime dependencies are vendored under `extension/vendor/`. Their source,
version, license, and integrity records live in the adjacent `SOURCE.txt` files
and [`extension/vendor/vendor.lock.json`](extension/vendor/vendor.lock.json).

peerd is licensed under the [Apache License 2.0](LICENSE). Vendored components
retain their own licenses. CheerpX is a proprietary runtime provided by Leaning
Technologies and is not covered by peerd's Apache license.
