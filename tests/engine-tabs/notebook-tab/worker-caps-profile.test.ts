// PR #119 — the sealed worker's capability profile. buildWorkerSource assembles
// the worker source string; the profile decides which peerd.* surfaces exist.
// These are STRING-SHAPE assertions on the generated source (pure — no Worker),
// proving the code-REPL arm's `page` bridge is present ONLY under page:true and
// the disabled caps get an in-realm throw-shim (the SECOND wall behind the host
// relay's own refusal in job-runner.js). why string-shape: the worker only runs
// in a browser (in-browser + e2e tiers cover execution); the profile GATING is
// pure source assembly and belongs in the fast bun tier.

import { describe, test, expect } from 'bun:test';
import {
  buildWorkerSource, DEFAULT_WORKER_CAPS, REMOTE_MODULE_WORKER_CAPS,
} from '../../../extension/engine-tabs/notebook-tab/worker-source.js';

// A minimal resolverDeps — buildEntry only needs these to assemble the entry;
// the user code has no imports, so readFile/makeBlobUrl are never hit.
const deps = {
  readFile: async (_p: string) => '',
  makeBlobUrl: (src: string) => `blob:${src.length}`,
  log: () => {},
};
const build = (caps?: object) =>
  buildWorkerSource('return 1', { entryPath: 'job.js', notebookId: 'job-1', resolverDeps: deps, caps: caps as any });

describe('worker capability profile — the default (historical) surface', () => {
  test('DEFAULT_WORKER_CAPS is the pre-profile surface: no page, no provider, distributed + everything else on', () => {
    // provider is the ONE spend-capable cap — off by default everywhere; the
    // script tool mints it per-run (design 5). distributed defaults ON (the tab
    // host answers it); the headless runner forces it off (design 7.3).
    expect(DEFAULT_WORKER_CAPS).toEqual({ app: false, page: false, egress: true, subagent: true, opfs: true, provider: false, distributed: true });
  });

  test('a default build has NO page bridge and only the provider throw-shim', async () => {
    const { source } = await build();               // no caps → defaults
    expect(source).not.toContain('peerd.page');
    expect(source).not.toContain("makeBridge('page'");
    expect(source).not.toContain('globalThis.page');
    // egress / subagent / opfs stay wired — no throw-shims for them.
    expect(source).not.toContain('no-egress capability profile');
    expect(source).not.toContain('no-subagent capability profile');
    expect(source).not.toContain('no-opfs capability profile');
    // provider (default OFF, design 5) is the one shimmed surface.
    expect(source).toContain('no-provider capability profile');
    expect(source).not.toContain("makeBridge('provider'");
    // distributed (default ON) stays on the live bridge (the tab host answers it).
    expect(source).not.toContain('no-distributed capability profile');
    expect(source).toContain("makeBridge('distributed'");
  });
});

describe('worker capability profile — the sub-model lane (design 5)', () => {
  test('provider:true installs the provider bridge and drops the shim', async () => {
    const { source } = await build({ provider: true });
    expect(source).toContain("makeBridge('provider'");
    expect(source).toContain('globalThis.peerd.provider.call = (args) => providerRelay');
    expect(source).not.toContain('no-provider capability profile');
  });

  test('provider stays OFF under the code-REPL profile (page workers must not spend the key)', async () => {
    const { source } = await build({ page: true, egress: false, subagent: false, opfs: false });
    expect(source).not.toContain("makeBridge('provider'");
    expect(source).toContain('no-provider capability profile');
  });
});

describe('worker capability profile — headless distributed fast-fail (design 7.3)', () => {
  // The headless job runner forces distributed:false (it has no
  // 'distributed-request' handler); the in-realm wall must throw synchronously
  // instead of letting the un-answered bridge hang the run to its wall-clock.
  // The host relay's refusal in job-runner.js is the second wall.
  test('distributed:false replaces every wired read with a throw-shim', async () => {
    const { source } = await build({ distributed: false });
    expect(source).toContain('no-distributed capability profile');
    for (const m of ['whoami', 'status', 'peers', 'presence']) {
      expect(source).toContain(`globalThis.peerd.distributed.${m} = noDistributed('${m}')`);
    }
  });
});

describe('worker capability profile — the code-REPL arm (page + compute only)', () => {
  const CODE_CAPS = { page: true, egress: false, subagent: false, opfs: false };

  test('page:true installs the page bridge (peerd.page riding makeBridge)', async () => {
    const { source } = await build(CODE_CAPS);
    expect(source).toContain('globalThis.peerd.page');
    expect(source).toContain('globalThis.page = __page');
    // The bridge rides the generalized makeBridge protocol (post-#149): the wire
    // type is computed (name + '-request' → 'page-request' at runtime), so the
    // shape assertion is on the bridge mint, not a literal envelope string.
    expect(source).toContain("makeBridge('page'");
    expect(source).toContain("pageRelay({ method, args })");
    // the five surfaced methods
    for (const m of ['goto:', 'click:', 'fill:', 'snapshot:', 'content:']) {
      expect(source).toContain(m);
    }
  });

  test('egress:false / subagent:false / opfs:false each install an in-realm throw-shim', async () => {
    const { source } = await build(CODE_CAPS);
    // The realm seal's global fetch can't be removed from here, so egress is
    // disabled by overriding peerd.egress.fetch to throw (host also refuses it).
    expect(source).toContain('peerd.egress.fetch = ()');
    expect(source).toContain('no-egress capability profile');
    expect(source).toContain('peerd.runtime.runAgent = ()');
    expect(source).toContain('no-subagent capability profile');
    expect(source).toContain('no-opfs capability profile');
    // The dynamic-import shim is also stubbed under no-opfs.
    expect(source).toContain('__peerd_dynamic_import = noOpfs');
  });

  test('a page-only worker still keeps the peerd:std pure-compute stdlib import', async () => {
    // The profile strips IO capabilities, NOT computation — page.* + peerd:std is
    // the whole point (drive the tab, compute over what you read).
    const { source } = await build(CODE_CAPS);
    expect(source).toContain('peerd');               // the surface object is still assembled
    expect(source).toContain("makeBridge('page'");   // and the only IO it has is the page bridge
  });
});

describe('worker capability profile for remote modules', () => {
  const remoteDeps = {
    ...deps,
    remoteModulesEnabled: true,
    fetchRemote: async (_url: string) => 'export const remoteValue = 42;',
  };

  test('a remote graph restricts the whole run regardless of requested caps', async () => {
    const { source, usedRemoteModules } = await buildWorkerSource(
      "import { remoteValue } from 'https://modules.example/value.js'; return remoteValue;",
      {
        entryPath: 'job.js', notebookId: 'job-remote', resolverDeps: remoteDeps,
        actors: true,
        a2a: true,
        siteFetch: 'https://site.example',
        caps: { page: true, egress: true, subagent: true, opfs: true, provider: true, distributed: true },
      },
    );

    expect(usedRemoteModules).toBe(true);
    expect(REMOTE_MODULE_WORKER_CAPS).toEqual({
      app: false, page: false, egress: false, subagent: false,
      opfs: false, provider: false, distributed: false,
    });
    expect(source).not.toContain("makeBridge('page'");
    expect(source).not.toContain("makeBridge('provider'");
    expect(source).not.toContain("makeBridge('actors'");
    expect(source).not.toContain("makeBridge('a2a'");
    expect(source).not.toContain("makeBridge('site-fetch'");
    expect(source).toContain('remote_module_capability_blocked: network access is disabled');
    expect(source).toContain('remote_module_capability_blocked: subagents is disabled');
    expect(source).toContain('remote_module_capability_blocked: Notebook files is disabled');
    expect(source).toContain('remote_module_capability_blocked: dweb reads is disabled');
  });

  test('a local graph keeps its requested capability profile', async () => {
    const { usedRemoteModules } = await buildWorkerSource('return 42;', {
      entryPath: 'job.js', notebookId: 'job-local', resolverDeps: deps,
    });
    expect(usedRemoteModules).toBe(false);
  });
});
