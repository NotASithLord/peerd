// @ts-check
// The app arm of sandbox_create — author a new App for the user.
// (Was the standalone app_create tool; merged into sandbox_create({kind:'app'})
// 2026-07-05: one kind-discriminated create tool.)
//
// Apps are multi-file. Pass `files` as a path → content map; the
// agent's HTML body lives at index.html (default entry). If you only
// have one file, pass `html` for back-compat.

import { APP_RUNTIME_NOTE } from './code-style-note.js';
import { oncePerSession } from './once-per-session.js';
import { isBinaryAssetPath, MAX_MODEL_APP_FILE_BYTES } from '/peerd-engine/index.js';
import { normalizeGitRemote } from '/peerd-engine/repository/remote.js';
import { base64ByteLength } from '/shared/bundle/bytes.js';

// Mirrors the local write-layer backstop in background/app-client.js. Dweb
// publishing separately measures the packed bundle, including base64 overhead.
const MAX_TOTAL_BYTES = 50_000_000;
const MAX_FILES = 256;

/**
 * Create + open an App from files/html; returns { id, name, kind, entryFile,
 * fileCount, opened } plus the App runtime note.
 * @param {any} args @param {import('/shared/tool-types.js').ToolContext} ctx
 * @returns {Promise<import('/shared/tool-types.js').ToolResult>}
 */
export const createAppSandbox = async (args, ctx) => {
    const gitUrl = typeof args?.gitUrl === 'string' ? args.gitUrl.trim() : '';
    if (!gitUrl && (typeof args?.name !== 'string' || !args.name.trim())) {
      return { ok: false, error: "sandbox_create kind:'app' requires `name` (the app's display name)" };
    }
    /** @type {Record<string, unknown> | null} */
    const files = (args.files && typeof args.files === 'object')
      ? args.files
      : (typeof args.html === 'string' ? { 'index.html': args.html } : null);
    if (!gitUrl && (!files || !Object.keys(files).length)) {
      return { ok: false, error: "sandbox_create kind:'app' requires `files` (path → content map) or `html` — start with a minimal index.html shell" };
    }
    const fileEntries = Object.entries(files ?? {});
    if (fileEntries.length > MAX_FILES) {
      return { ok: false, error: `app_has_too_many_files: ${fileEntries.length} > ${MAX_FILES}` };
    }
    let totalBytes = 0;
    for (const [path, value] of fileEntries) {
      let fileBytes;
      if (typeof value === 'string') {
        if (isBinaryAssetPath(path)) return { ok: false, error: `binary_asset_requires_base64: ${path}` };
        fileBytes = new TextEncoder().encode(value).byteLength;
      } else {
        const base64 = value && typeof value === 'object'
          ? /** @type {{ base64?: unknown }} */ (value).base64
          : null;
        if (typeof base64 !== 'string') {
          return { ok: false, error: `invalid_app_file_content: ${path}` };
        }
        try { fileBytes = base64ByteLength(base64); }
        catch { return { ok: false, error: `invalid_base64: ${path}` }; }
      }
      if (fileBytes > MAX_MODEL_APP_FILE_BYTES) {
        return { ok: false, error: `app_file_too_large: ${path} is ${fileBytes} > ${MAX_MODEL_APP_FILE_BYTES} bytes` };
      }
      totalBytes += fileBytes;
      if (totalBytes > MAX_TOTAL_BYTES) {
        return { ok: false, error: `app_too_large: ${totalBytes} > ${MAX_TOTAL_BYTES} bytes` };
      }
    }
    // why: appClient rides the opaque ctx contract (not on ToolContext); narrow
    // to the two methods this tool calls.
    const appClient = /** @type {{ create?: (opts: Record<string, any>) => Promise<{ id: string, name: string, entryFile: string }>, createFromGit?: (opts: Record<string, any>) => Promise<{record:{id:string,name:string,entryFile:string},repository:any,contract:any}>, open?: (opts: { appId: string, sessionId?: string, focus?: boolean }) => Promise<unknown> } | undefined} */ (
      /** @type {any} */ (ctx).appClient);
    if (!appClient) return { ok: false, error: 'app_not_available' };
    const createApp = appClient.create;
    const createFromGit = appClient.createFromGit;
    if ((!gitUrl && !createApp) || (gitUrl && !createFromGit)) {
      return { ok: false, error: 'app_not_available' };
    }
    // A MULTIPLAYER dwapp needs the dweb metadata SLOT, which is what the app-tab
    // checks before attaching the bridge (app-registry: "its presence is what
    // unlocks the app-tab dweb bridge"; app-tab.js attachDwebBridge gates on
    // appMeta.dweb). Gated on ctx.dweb so the flag is INERT when the dweb is off
    // (store / dweb-off) — a stray dwapp:true there can't mark an app as a dwapp
    // it could never be. local:true distinguishes a self-authored dwapp from an
    // installed one (uri/publisher/hash) or the commons seed.
    // why: dweb rides the opaque ctx contract (not on ToolContext) — its mere
    // presence gates the dwapp metadata slot; read it as the erased contract.
    const makeDwapp = args?.dwapp === true && !!(/** @type {any} */ (ctx).dweb);
    const tags = makeDwapp
      ? [...new Set([...(Array.isArray(args.tags) ? args.tags : []), 'dweb'])]
      : args.tags;
    try {
      let repository = null;
      let contract = null;
      let record;
      if (gitUrl) {
        if (!createFromGit) return { ok: false, error: 'app_not_available' };
        let remote;
        try { remote = normalizeGitRemote(gitUrl); }
        catch (error) { return { ok: false, error: `git_clone_failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}` }; }
        const confirm = /** @type {any} */ (ctx).confirm;
        if (!confirm) return { ok: false, error: 'git_confirmation_unavailable' };
        const answer = await confirm({
          tool: 'sandbox_create', kind: 'git_clone', sideEffect: 'write', origins: [new URL(remote.url).origin],
          summary: `Clone ${remote.url} and instantiate its peerd.json as a browser App?`,
        }, ctx.abortSignal);
        if (answer !== 'yes_once' && answer !== 'yes_session' && answer !== true) return { ok: false, error: 'git_clone_declined' };
        if (ctx.abortSignal?.aborted) return { ok: false, error: 'git_clone_aborted' };
        const result = await createFromGit({
          name: typeof args.name === 'string' ? args.name : new URL(remote.url).pathname.split('/').at(-1)?.replace(/\.git$/, ''),
          url: remote.url,
          ref: typeof args.gitRef === 'string' ? args.gitRef : undefined,
          depth: Math.min(500, Math.max(1, Number(args.gitDepth) || 50)),
          sessionId: ctx.session?.sessionId,
          signal: /** @type {any} */ (ctx).abortSignal,
          allowDweb: !!(/** @type {any} */ (ctx).dweb),
        });
        if (!result) return { ok: false, error: 'git_app_import_unavailable' };
        record = result.record; repository = result.repository; contract = result.contract;
      } else {
        if (!createApp) return { ok: false, error: 'app_not_available' };
        record = await createApp({
          name: args.name,
          files,
          tags,
          entryFile: args.entryFile,
          sessionId: ctx.session?.sessionId,
          ...(makeDwapp ? { dweb: { uri: null, publisher: null, hash: null, local: true } } : {}),
        });
      }
      // focus:false — open in the BACKGROUND + drop a "go there" card in the chat
      // instead of yanking the user to the new tab (DESIGN-12). They click to go.
      let opened = true;
      let openError;
      try { await appClient.open?.({ appId: record.id, sessionId: ctx.session?.sessionId, focus: false }); }
      catch (e) {
        opened = false;
        openError = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
        console.debug('[app_create] open failed', e);
      }
      const summary = JSON.stringify({
        id: record.id,
        name: record.name,
        // why kind: the merged sandbox_create result is the durable-handle
        // carrier — instance-handle.js reads it to label the harvested id.
        kind: 'app',
        entryFile: record.entryFile,
        fileCount: files ? fileEntries.length : undefined,
        ...(repository ? { repository, contract } : {}),
        opened,
        ...(openError ? { openError } : {}),
      }, null, 2);
      // The App ACTOR writes the files, so the code-style guidance rides ITS
      // prompt (system-prompt.js actorBlock), not this orchestrator
      // create-result. Only the runtime note (how the iframe behaves) belongs
      // here — and once per session (schema-diet 6b): a second app this session
      // doesn't need the full note re-stated, a pointer suffices.
      const note = oncePerSession(ctx.session?.sessionId, 'app-runtime-note')
        ? APP_RUNTIME_NOTE
        : '(App runtime note shown earlier this session — same iframe rules apply.)';
      return {
        ok: true,
        content: `${summary}\n\n${opened ? note : `The App was saved, but the browser could not establish its isolation floor: ${openError}. It cannot run safely here.\n\n${note}`}`,
      };
    } catch (e) {
      return { ok: false, error: `app_create_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  };
