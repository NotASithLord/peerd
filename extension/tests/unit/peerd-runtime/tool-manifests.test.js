// @ts-check
// Per-session tool exposure manifests — the surfaces that want the REAL
// extension environment:
//   - preset data validated against the REAL registered tool inventory
//     (a tool rename that strands a preset entry fails here, not in prod);
//   - the main-turn descriptor pipeline (mainAgentDescriptors ∘ manifest
//     filter) over the real tool list;
//   - the /tools command flow end-to-end against the real session store.
// The pure resolve/label/gate/narrowing logic is bun-tested in
// tests/peerd-runtime/tool-manifests.test.ts.

import { describe, it, expect } from '../../framework.js';
import {
  TOOL_MANIFEST_PRESETS,
  resolveManifestAllow,
  filterDescriptorsByManifest,
  filterResidentSurface,
  manifestLabel,
  makeToolsCommand,
  mainAgentDescriptors,
  MAIN_AGENT_HIDDEN_TOOLS,
  BUILTIN_TOOLS,
  CLOCK_TOOLS,
  WEB_TOOLS,
  loadSkillTool,
  createSessionStore,
} from '/peerd-runtime/index.js';
import { makeMockIdb } from '../../mocks/idb.js';

/** @typedef {import('/peerd-runtime/sessions/types.js').Session} Session */

// why: store.get() returns `Session | undefined` and current() returns
// `string | undefined` — both are concrete at these read sites. Cast
// (don't `!`) to keep the prod types honest.
/** @param {Session | undefined | null} s @returns {Session} */
const present = (s) => /** @type {Session} */ (s);
/** @param {string | undefined} v @returns {string} */
const id = (v) => /** @type {string} */ (v);

// The full registered inventory, exactly as the SW registers it
// (BUILTIN + clock + web + load_skill).
const registered = [...BUILTIN_TOOLS, ...CLOCK_TOOLS, ...WEB_TOOLS, loadSkillTool];
const registeredNames = new Set(registered.map((t) => t.name));

describe('tool manifests — presets vs the real registry', () => {
  it('every preset entry names a REGISTERED tool (rename-drift guard)', () => {
    for (const [presetName, preset] of Object.entries(TOOL_MANIFEST_PRESETS)) {
      const stranded = preset.allow.filter((n) => !registeredNames.has(n));
      expect(`${presetName}: ${stranded.join(',')}`).toBe(`${presetName}: `);
    }
  });

  it('presets have no duplicate entries', () => {
    for (const preset of Object.values(TOOL_MANIFEST_PRESETS)) {
      expect(new Set(preset.allow).size).toBe(preset.allow.length);
    }
  });

  it('every preset NARROWS — strictly fewer tools than the registry', () => {
    for (const preset of Object.values(TOOL_MANIFEST_PRESETS)) {
      expect(preset.allow.length < registered.length).toBe(true);
    }
  });
});

describe('tool manifests — main-turn descriptor pipeline (real tool list)', () => {
  // The REAL main-turn pipeline (turn-driver.js): the manifest filter THEN
  // filterResidentSurface as the outermost cut. DESIGN-17 folded do/get/check +
  // the mutating tier into the tab's resident, so they leave the MAIN agent even
  // when a preset names them (the preset still lists them for the SUBAGENT path).
  /** @param {string} preset */
  const mainListFor = (preset) => filterResidentSurface(
    filterDescriptorsByManifest(mainAgentDescriptors(registered), resolveManifestAllow({ preset })),
  ).map((t) => t.name);

  it('research: keeps the page-via-resident channel + memory, folds do/get/check away', () => {
    const names = mainListFor('research');
    // fetch_url is resident-only (correctly NOT in the main list); the main
    // agent's web channel is the resident (message_resident) + tab management.
    for (const keep of ['message_resident', 'list_tabs', 'open_tab', 'remember', 'read_memory', 'inspect_audit_log']) {
      expect(names).toContain(keep);
    }
    // do/get/check folded into the resident; execution/edit/spawn dropped by the preset.
    for (const drop of ['do', 'get', 'check', 'vm_boot', 'js_notebook', 'app_create', 'edit_file', 'spawn_subagent', 'request_review', 'load_skill']) {
      expect(names.indexOf(drop)).toBe(-1);
    }
  });

  it('browse-only: keeps tabs + the resident channel, folds get/check away', () => {
    const names = mainListFor('browse-only');
    // fetch_url is resident-only (correctly NOT in the main list); the main
    // agent reaches web reads via the resident (message_resident).
    for (const keep of ['message_resident', 'list_tabs', 'open_tab']) {
      expect(names).toContain(keep);
    }
    for (const drop of ['do', 'get', 'check', 'remember', 'read_memory', 'edit_file', 'vm_boot', 'capture']) {
      expect(names.indexOf(drop)).toBe(-1);
    }
  });

  it('runner internals named by a preset NEVER surface in the main list (exposure filter wins)', () => {
    for (const preset of Object.keys(TOOL_MANIFEST_PRESETS)) {
      const names = mainListFor(preset);
      for (const hidden of MAIN_AGENT_HIDDEN_TOOLS) {
        expect(names.indexOf(hidden)).toBe(-1);
      }
    }
  });

  it('no manifest → the main list is exactly mainAgentDescriptors (today\'s behavior)', () => {
    const filtered = filterDescriptorsByManifest(
      mainAgentDescriptors(registered), resolveManifestAllow(undefined),
    );
    expect(filtered.map((t) => t.name)).toEqual(mainAgentDescriptors(registered).map((t) => t.name));
  });
});

describe('tool manifests — the /tools command flow (real session store)', () => {
  const harness = () => {
    const store = createSessionStore({
      idb: makeMockIdb(),
      now: () => 1000,
      makeId: (() => { let i = 0; return () => `tm-${++i}`; })(),
    });
    /** @type {string[]} */
    const notes = [];
    /** @type {any[]} */
    const audits = [];
    /** @type {string | undefined} */
    let currentId;
    const cmd = makeToolsCommand({
      sessions: store,
      getCurrentSessionId: async () => currentId,
      ensureSession: async () => {
        if (!currentId) currentId = (await store.create({})).sessionId;
        return currentId;
      },
      postNote: (/** @type {string} */ t) => { notes.push(t); },
      audit: async (/** @type {any} */ e) => { audits.push(e); },
    });
    return { cmd, store, notes, audits, current: () => currentId };
  };

  it('/tools research narrows the chat: record persisted, descriptors shrink next turn', async () => {
    const { cmd, store, notes, current } = harness();
    const out = await cmd('research');
    expect(present(out.session).toolManifest).toEqual({ preset: 'research' });
    expect(notes[0]).toContain('research');

    // what runAgentTurn does at the next turn start, against the REAL list (the
    // manifest filter THEN filterResidentSurface — the production pipeline):
    const record = present(await store.get(id(current())));
    const allow = resolveManifestAllow(record.toolManifest);
    const descriptors = filterResidentSurface(
      filterDescriptorsByManifest(mainAgentDescriptors(registered), allow),
    );
    expect(descriptors.length < mainAgentDescriptors(registered).length).toBe(true);
    // the page-via-resident channel stays; do/get/check + vm_boot are off the main agent.
    expect(descriptors.map((t) => t.name)).toContain('message_resident');
    expect(descriptors.map((t) => t.name).indexOf('do')).toBe(-1);
    expect(descriptors.map((t) => t.name).indexOf('vm_boot')).toBe(-1);
  });

  it('/tools full restores everything (key absent, full descriptor list back)', async () => {
    const { cmd, store, current } = harness();
    await cmd('browse-only');
    await cmd('full');
    const record = present(await store.get(id(current())));
    expect('toolManifest' in record).toBe(false);
    const descriptors = filterDescriptorsByManifest(
      mainAgentDescriptors(registered), resolveManifestAllow(record.toolManifest),
    );
    expect(descriptors.length).toBe(mainAgentDescriptors(registered).length);
  });

  it('/tools (show) + /tools list narrate without mutating', async () => {
    const { cmd, notes, current } = harness();
    await cmd('');
    expect(notes[0]).toContain('No tool manifest set');
    await cmd('list');
    expect(notes[1]).toContain('/tools research');
    expect(notes[1]).toContain('/tools browse-only');
    expect(current()).toBe(undefined);   // read-only forms never create a session
  });

  it('unknown preset is refused — nothing persisted, presets listed', async () => {
    const { cmd, notes, audits, current } = harness();
    const out = await cmd('everything');
    expect(out.session).toBe(null);
    expect(current()).toBe(undefined);
    expect(audits.length).toBe(0);
    expect(notes[0]).toContain('Unknown tool preset');
    expect(notes[0]).toContain('browse-only');
  });

  it('manifestLabel matches what the chips render', async () => {
    const { cmd, store, current } = harness();
    await cmd('browse-only');
    const record = present(await store.get(id(current())));
    expect(manifestLabel(record.toolManifest)).toBe('browse-only');
  });
});
