// ESLint flat config for the peerd extension.
//
// why flat config: ESLint v9 removed eslintrc (`.eslintrc.cjs`) support and
// v10 dropped even the `ESLINT_USE_FLAT_CONFIG=false` escape hatch, so the
// flat `eslint.config.js` is now the ONLY format ESLint will load. This file
// replaces the legacy `.eslintrc.cjs` (migrated per
// https://eslint.org/docs/latest/use/configure/migration-guide).
//
// Run it: `npm run lint` / `bun run lint`, or directly `npx eslint extension`.
// Requires ESLint >= 9.6 (uses the `regex` option of no-restricted-imports;
// v10.4.1 is what's installed). The `lint` script pins `npx --yes eslint@10`
// on purpose: it resolves a modern eslint (works under npm AND bun) instead
// of a stale global `eslint` — this machine has an ancient v8.31 global that
// both `eslint` and unpinned `bunx eslint` would otherwise pick up.
//
// why globals come from the `globals` package: the extension has no build
// step and no LOCAL eslint. CI invokes this via
// `npx --package=eslint --package=globals -- eslint extension/`, and the
// package is also a devDependency so a bare `npx eslint` resolves it too.
// `package.json` is `"type": "module"`, so this `.js` file loads as ESM and
// can `import`.
//
// The load-bearing security + architecture gates (carried over unchanged
// from the eslintrc version) are:
//   - `no-restricted-globals` forbids bare `fetch`. Use safeFetch from
//     /peerd-egress/index.js — bare fetch bypasses the egress allowlist.
//   - `no-restricted-syntax` forbids Mithril `m.request`, `m.jsonp`, and
//     `m.mount(document.body, …)`.
//   - `no-restricted-imports` enforces per-module public APIs — only
//     /peerd-<name>/index.js is importable from outside the module.
//     (CLAUDE.md: "index.js is the public API per module.")
//
// New in this pass — the shadow/TDZ class of bug (as warnings):
//   - `no-shadow`, `no-redeclare`, and `no-use-before-define`. These catch
//     the failure mode from eval/runner.js where a local `const fresh`
//     shadowed a module-level `function fresh()` and broke a synchronous
//     call — found only at runtime in the browser.

import globals from 'globals';

export default [
  // --- global ignores (was: `ignorePatterns`) ---------------------------
  // A config object with ONLY `ignores` sets global ignores.
  {
    ignores: [
      'extension/vendor/**',       // vendored third-party — not our style
      'extension/assets/webvm/**', // CheerpX runtime blobs
    ],
  },

  // --- base: applies to every linted .js file ---------------------------
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      // Default context is the browser + the WebExtension APIs (chrome.* /
      // browser.*) — this is the side panel, content scripts, the offscreen
      // doc, the *-tab pages, eval/, and the peerd-* modules when loaded
      // into a page. The service-worker and Node-ish test contexts layer
      // their extra globals on top (see below).
      globals: {
        ...globals.browser,
        ...globals.webextensions, // provides `chrome` and `browser`
        chrome: 'readonly',
        browser: 'readonly',
      },
    },
    rules: {
      // why no-undef: the extension has no bundler or type checker, so a
      // reference to a deleted/renamed binding is otherwise invisible
      // until the SW throws at load — exactly how a half-finished
      // refactor once shipped past every gate (none of which execute the
      // SW). This is the only static check that catches it.
      'no-undef': 'error',
      // why: bare fetch bypasses the egress allowlist.
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: 'Use safeFetch from /peerd-egress/index.js — bare fetch bypasses the egress allowlist.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.object.name="m"][callee.property.name="request"]',
          message: 'Mithril m.request bypasses safeFetch. Use safeFetch from /peerd-egress/index.js.',
        },
        {
          selector: 'CallExpression[callee.object.name="m"][callee.property.name="jsonp"]',
          message: 'Mithril m.jsonp would load remote scripts; forbidden by CSP and policy.',
        },
        {
          selector: 'CallExpression[callee.object.name="m"][callee.property.name="mount"][arguments.0.object.name="document"][arguments.0.property.name="body"]',
          message: 'Mount Mithril against a named container, not document.body.',
        },
      ],
      // Cross-module deep imports are forbidden. From outside a peerd-*
      // module you may only import the module's top-level index.js. Relaxed
      // below for files INSIDE any peerd-* module (deep imports there are
      // fine) and for tests.
      //
      // why regex, not the eslintrc's gitignore-style `group` globs
      // (`/peerd-*/*/**`, `/peerd-*/!(index)*.js`): that matcher silently
      // fails to match LEADING-SLASH import specifiers — and every real
      // import in this repo is leading-slash (`/peerd-egress/index.js`) or
      // relative (`../../peerd-engine/foo.js`). So the glob form matched
      // nothing; the rule was a no-op. (It went unnoticed because ESLint
      // itself never ran — the very gap this migration closes.) The regex
      // matches any `peerd-<name>/<deeper>` path that isn't the module's
      // own top-level `index.js`.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(^|/)peerd-[a-z]+/(?!index\\.js$).+',
              message: 'Cross-module imports must go through /peerd-<name>/index.js. See docs/architecture.md §4.',
            },
            // The dweb module is stricter still: NOTHING outside it
            // may import it — not even its index.js. Core code programs
            // against /shared/dweb-interface.js and obtains the live
            // client via loadDweb() in /shared/dweb-loader.js
            // (whose gated dynamic import this rule can't see — the CI
            // gate packaging/check-dweb-boundary.ts covers that). The
            // store package prunes the module entirely; a static import here
            // would break the store service worker outright.
            {
              regex: '(^|/)peerd-distributed/.*',
              message: 'Dweb is channel-gated. Import /shared/dweb-interface.js types + loadDweb() from /shared/dweb-loader.js — never peerd-distributed directly. See PACKAGING.md.',
            },
          ],
        },
      ],

      // --- shadow / TDZ class (new — warnings) -------------------------
      'no-shadow': 'warn',
      'no-redeclare': 'warn',
      // why { functions: false, variables: false }: the deferred-closure
      // pattern in eval/runner.js (settleSubject/navigateTab define a
      // `const onUpd`/`fin` pair where the earlier one references the later
      // one, but only fires inside a callback that runs after both exist) is
      // safe and would otherwise be a false positive. Hoisted function
      // declarations are likewise fine. Genuine use-before-init of classes
      // still warns.
      'no-use-before-define': ['warn', { functions: false, variables: false }],
    },
  },

  // --- stylistic modernization (added 2026-06-14) -----------------------
  // The base object above is the SECURITY + ARCHITECTURE + shadow/TDZ
  // class. This block is the house JS STYLE — modern ES, functional
  // idioms — encoded so it's enforced at the one gate a no-build
  // extension has, not re-litigated per file. Every rule here is
  // autofixable (`eslint extension --fix`) and none of them change
  // runtime behavior; they only change how the source reads.
  //
  // why a separate object, not folded into the base rules: it keeps the
  // split legible — "what keeps us safe" vs "what keeps us modern" —
  // and gives the injected-classic-script exemption below one clear thing
  // to switch off.
  {
    files: ['**/*.js'],
    rules: {
      // `var` is function-scoped and hoists; `const`/`let` are
      // block-scoped and say whether a binding is ever reassigned. The
      // only `var` in the tree is in injected bodies (exempted below).
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      // Functional core: callbacks read as expressions, not statements.
      // allowNamedFunctions keeps a deliberately-named helper callback
      // (useful in stack traces) as-is.
      'prefer-arrow-callback': ['error', { allowNamedFunctions: true }],
      // `{ foo }` over `{ foo: foo }`; method shorthand over `: function`.
      'object-shorthand': ['error', 'always'],
      // Template literals over `'a ' + x + ' b'` string concatenation.
      'prefer-template': 'error',
      'no-useless-concat': 'error',
      'no-useless-rename': 'error',
      // Spread over `.apply(null, args)` / `Array.prototype.slice.call`.
      'prefer-spread': 'error',
      // `{ ...a, ...b }` over `Object.assign({}, a, b)`.
      'prefer-object-spread': 'error',
      // `0b1010` / `0o755` over `parseInt('1010', 2)`.
      'prefer-numeric-literals': 'error',
      // `2 ** 8` over `Math.pow(2, 8)`.
      'prefer-exponentiation-operator': 'error',
      // ES2022 `Object.hasOwn(o, k)` over `Object.prototype.hasOwnProperty.call`.
      'prefer-object-has-own': 'error',
      // `[]` over `new Array()`.
      'no-array-constructor': 'error',
      'no-useless-computed-key': 'error',
      // `obj.foo` over `obj['foo']` when the key is a valid identifier.
      'dot-notation': 'error',
    },
  },

  // --- service-worker context (background/) ------------------------------
  // Adds SW globals (self, clients, importScripts, ServiceWorkerGlobalScope,
  // skipWaiting, …) on top of the base.
  {
    files: ['extension/background/**'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },

  // --- Node-ish test bootstrap (extension/tests/) ------------------------
  // The in-browser test bootstrap/helpers reach for Node-ish globals
  // (process, global, …) in spots; declare them so a future `no-undef`
  // pass stays quiet here.
  {
    files: ['extension/tests/**'],
    languageOptions: { globals: { ...globals.node } },
  },

  // === relaxations (was: eslintrc `overrides`) ==========================
  // Order matters: these come AFTER the base so they win for matching files.

  // The egress fetch wrappers ARE the sanctioned bare-fetch sites — they
  // implement the allowlist (safe-fetch, provider endpoints only) and the
  // web-tool egress path (web-fetch: scheme + denylist + audit). Both fall
  // back to the platform `fetch` by construction.
  {
    files: [
      'extension/peerd-egress/fetch/safe-fetch.js',
      'extension/peerd-egress/fetch/web-fetch.js',
    ],
    rules: { 'no-restricted-globals': 'off' },
  },
  // Storage wrappers and the SW chassis touch chrome.storage directly.
  {
    files: [
      'extension/peerd-egress/storage/**',
      'extension/background/service-worker.js',
    ],
    rules: { 'no-restricted-globals': 'off' },
  },
  // system-prompt loader fetches a chrome-extension:// static asset (NOT a
  // network egress). The egress allowlist intentionally wouldn't admit our
  // own extension origin, so safeFetch isn't the right tool here.
  {
    files: ['extension/peerd-runtime/loop/system-prompt.js'],
    rules: { 'no-restricted-globals': 'off' },
  },
  // voice/model-store loads Moonshine ONNX bytes from CDN URLs (Hugging
  // Face). The response is DATA verified by SRI hash; the provider-allowlist
  // motivation behind safeFetch doesn't apply, and webFetch's denylist
  // semantics are for arbitrary user-driven web tools, not pinned assets.
  {
    files: ['extension/peerd-runtime/voice/model-store.js'],
    rules: { 'no-restricted-globals': 'off' },
  },
  // pdf/ocr-store loads the opt-in OCR engine assets (CDN URLs); same posture
  // as voice/model-store — DATA verified by SRI, not a provider API call.
  // offscreen/pdf-extract fetches the PDF bytes for the read_pdf tool (the
  // target is denylist-checked at the tool boundary before we get here).
  {
    files: [
      'extension/peerd-runtime/pdf/ocr-store.js',
      'extension/offscreen/pdf-extract.js',
    ],
    rules: { 'no-restricted-globals': 'off' },
  },
  // Within a peerd-* module, deep relative imports are fine. ESLint can't
  // tell "this file is inside the same module as its import target" purely
  // from path patterns, so relax the cross-module rule for any file that
  // lives inside a peerd-* module. The rule still fires for chassis files
  // importing from /peerd-*/ and for tests that try to deep-import.
  //
  // why the dweb pattern STAYS on here: other modules must not
  // import peerd-distributed either — the store package prunes it, so a
  // static import would break the store SW. Only peerd-distributed's own
  // files (relaxed below) may reference themselves.
  {
    files: ['extension/peerd-*/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(^|/)peerd-distributed/.*',
              message: 'Dweb is channel-gated. Import /shared/dweb-interface.js types + loadDweb() from /shared/dweb-loader.js — never peerd-distributed directly. See PACKAGING.md.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['extension/peerd-distributed/**'],
    rules: { 'no-restricted-imports': 'off' },
  },
  // Tests use the public surface but may deep-import white-box helpers, so
  // disable the cross-module rule here. We KEEP no-restricted-globals on so
  // a stray bare fetch in a test still gets flagged.
  // why this differs from the eslintrc: the old override turned
  // no-restricted-globals OFF for tests, directly contradicting its own
  // comment ("keep no-restricted-globals enforcement so a stray bare fetch
  // in a test file still gets flagged"). We honor the documented intent —
  // it's strictly more secure and currently flags nothing (no test uses
  // bare fetch).
  {
    files: ['extension/tests/**'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // --- injected classic-script bodies: keep them ES5 --------------------
  // These files hold function bodies that are serialized (via
  // `.toString()`) and re-evaluated in a TARGET PAGE's classic-script
  // world by chrome.scripting.executeScript / CDP Runtime. They are
  // deliberately ES5 and must stay that way:
  //   - `var` — the ports rely on function-scope hoisting, and the bodies
  //     run in pages we don't control.
  //   - `function` expressions bound to a caller-supplied `this`
  //     (arrowing them would rebind `this` and break selection/typing).
  //   - classic counting loops over live NodeLists.
  // The modernization rules above would rewrite all of this, so switch
  // them off here. See CLAUDE.md ("All JS runs under strict mode" →
  // injected bodies) and each file's header comment for the full why.
  {
    files: [
      'extension/peerd-runtime/dom/walk-injected.js',
      'extension/peerd-runtime/dom/framework-state.js',
      'extension/peerd-runtime/dom/pull-in-hint-injected.js',
      'extension/background/debugger-pool.js',
      'extension/peerd-runtime/tools/defs/watch-changes.js',
    ],
    rules: {
      'no-var': 'off',
      'prefer-const': 'off',
      'prefer-arrow-callback': 'off',
      'object-shorthand': 'off',
      'prefer-template': 'off',
      'no-useless-concat': 'off',
      'no-useless-rename': 'off',
      'prefer-spread': 'off',
      'prefer-object-spread': 'off',
      'prefer-numeric-literals': 'off',
      'prefer-exponentiation-operator': 'off',
      // framework-state.js is a faithful PORT of debugger-pool.js's
      // FRAMEWORK_STATE_FN; both keep `Object.prototype.hasOwnProperty.call`
      // so the two stay byte-for-byte comparable. Modernizing one desyncs
      // the pair.
      'prefer-object-has-own': 'off',
      'no-array-constructor': 'off',
      'no-useless-computed-key': 'off',
      'dot-notation': 'off',
    },
  },

  // --- realm seal: the blocked-global stand-ins must be `function` -------
  // notebook-neutralizers.js replaces network-capable globals (Worker,
  // SharedWorker, importScripts, navigator.sendBeacon) with throwers that
  // must work under BOTH call and `new`. Arrow functions have no
  // [[Construct]], so arrowing them would make `new Worker()` throw "not a
  // constructor" instead of the actionable NotebookEgressBlockedError.
  {
    files: ['extension/notebook-tab/notebook-neutralizers.js'],
    rules: { 'prefer-arrow-callback': 'off' },
  },
];
