import { describe, expect, test } from 'bun:test';
import { createAppToolAuthority } from '../../extension/background/app-tool-authority.js';
import { createAppClient } from '../../extension/background/app-client.js';
import { authorityEffectResourceKey } from '../../extension/background/authority-effect-resource.js';
import {
  CONTROLLER_DOMAIN_OPERATIONS,
  ORCHESTRATOR_OPERATION_GRANT,
  controllerOperationAllowedInPermissionMode,
  controllerOperationRequiresConfirmation,
} from '../../extension/shared/controller-kernel-quota.js';
import { classifyAction, ACTION_CLASSES } from '../../extension/peerd-runtime/permissions/policy.js';
import { getToolMetadata } from '../../extension/peerd-runtime/semantic.js';
import { podAppCopyTool } from '../../extension/peerd-runtime/tools/defs/pod-app-copy.js';

const OPERATION = 'turn.app.copy-pod-files';
type AppClientDeps = Parameters<typeof createAppClient>[0];
type AuthorityInput = Parameters<typeof createAppToolAuthority>[0];
type Prompt = { kind?: string; oneShot?: boolean; sessionId?: string; summary: string };
type CopyResult = {
  ok: boolean; error?: string; declined?: boolean; performed?: boolean; outcomeKnown?: boolean;
  direction?: string; podId?: string; appId?: string; outsideFiles?: { publisher: string };
  files: Array<{ from: string; to: string; bytes: number; sha256: string }>;
};
type CopyAuthority = {
  copyPodFiles: (direction: unknown, podId: unknown, appId: unknown, files: unknown) => Promise<CopyResult>;
};
const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xff, 0x00, 0x80]);

const hex = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');

type Event = string;

// A fake Pod whose workspace and lock are observable. The copy must read under
// the lock with its token, release the lock, and only then ask the user.
const fakePod = (events: Event[], files: Record<string, Uint8Array>) => {
  const writes: Array<{ path: string; bytes: Uint8Array }> = [];
  const marks: unknown[] = [];
  let reads = 0;
  const podClient = {
    withWorkspaceLock: async (podId: string, operation: (token: string | null) => Promise<unknown>) => {
      events.push(`lock:${podId}`);
      try { return await operation('lock-test-1'); } finally { events.push('unlock'); }
    },
    readBytes: async (path: string, options: { podId?: string; lockToken?: string }) => {
      reads += 1;
      events.push(`read:${path}:${options.lockToken ?? 'none'}`);
      const bytes = files[path];
      if (!bytes) throw Object.assign(new Error(`not found: ${path}`), { name: 'NotFoundError' });
      return new Uint8Array(bytes);
    },
    writeFile: async (path: string, bytes: Uint8Array) => {
      events.push(`pod-write:${path}`);
      writes.push({ path, bytes: new Uint8Array(bytes) });
      return 'pod-1';
    },
    setOutsideFiles: async (podId: string, mark: unknown) => {
      events.push(`mark:${podId}`);
      marks.push(mark);
      return podId;
    },
  };
  return { podClient, writes, marks, reads: () => reads };
};

// A real App client over an in-memory OPFS. Its writes must run inside the
// dweb authority with invalidate:true, then inside the repository lane.
type AppRecord = ReturnType<typeof appRecord>;
const fakeApp = (events: Event[], record: AppRecord, existing: Record<string, Uint8Array> = {}) => {
  const opfs = new Map<string, Uint8Array>(Object.entries(existing));
  let current: AppRecord = { ...record };
  const client = createAppClient({
    registry: {
      get: async (id: string) => (id === current.id ? { ...current } : null),
      update: async (id: string, patch: Partial<AppRecord>) => {
        if (id !== current.id) return null;
        current = { ...current, ...patch };
        return { ...current };
      },
    } as unknown as AppClientDeps['registry'],
    tracker: {
      reloadTab: async () => { events.push('reload'); return true; },
      withDwebAuthority: async (_id: string, operation: () => Promise<unknown>, options?: { invalidate?: boolean }) => {
        events.push(`dweb-authority:${options?.invalidate === true}`);
        return operation();
      },
    } as unknown as AppClientDeps['tracker'],
    repositories: {
      coordinate: async (_ref: unknown, operation: () => Promise<unknown>) => {
        events.push('app-lane');
        return operation();
      },
    } as unknown as AppClientDeps['repositories'],
    opfsForApp: () => ({
      list: async () => [...opfs.entries()].map(([path, bytes]) => ({ path: `/${path}`, size: bytes.byteLength })),
      readBytes: async (path: string) => {
        const bytes = opfs.get(path);
        if (!bytes) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
        return new Uint8Array(bytes);
      },
      write: async (path: string, bytes: Uint8Array | string) => {
        events.push(`app-write:${path}`);
        opfs.set(path, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes));
      },
      delete: async (path: string) => { opfs.delete(path); },
    }) as unknown as ReturnType<NonNullable<AppClientDeps['opfsForApp']>>,
  });
  return { client, opfs, record: () => current };
};

const appRecord = (extra: Record<string, unknown> = {}): {
  id: string; name: string; entryFile: string; tags: string[];
  fileKinds: Record<string, string>; [key: string]: unknown;
} => ({
  id: 'app-1', name: 'Ball game', entryFile: 'index.html', tags: [],
  fileKinds: { 'index.html': 'text' }, ...extra,
});

const authorityFor = ({
  args, events, pod, app, answer = 'yes_once', mode = 'act', modeAfterConfirm,
  actorType, onConfirm, signal,
}: {
  args: Record<string, unknown>; events: Event[];
  pod: ReturnType<typeof fakePod>; app: ReturnType<typeof fakeApp>;
  answer?: unknown; mode?: string; modeAfterConfirm?: string; actorType?: string;
  onConfirm?: (prompt: Prompt) => void; signal?: AbortSignal;
}) => {
  const prompts: Prompt[] = [];
  let liveMode = mode;
  const authority = createAppToolAuthority({
    binding: { operation: OPERATION, args },
    signal: signal ?? new AbortController().signal,
    ctx: {
      session: { sessionId: 'session-1' },
      ...(actorType ? { actorType, actorInstanceId: 'app-1' } : {}),
      podClient: pod.podClient,
      podRegistry: { get: async (id: string) => (id === 'pod-1' ? { id, name: 'Builder' } : null) },
      appClient: app.client,
      appRegistry: { get: async (id: string) => app.record().id === id ? app.record() : null },
      confirm: async (prompt: Prompt) => {
        events.push('confirm');
        prompts.push(prompt);
        onConfirm?.(prompt);
        if (modeAfterConfirm) liveMode = modeAfterConfirm;
        return answer;
      },
      readAuthorityPermission: async () => ({ mode: liveMode, confirmActions: false }),
    },
  } as AuthorityInput) as unknown as CopyAuthority;
  return { authority, prompts };
};

const podToApp = (files: unknown = [{ from: 'build/game.wasm', to: 'game.wasm' }]) => ({
  direction: 'pod_to_app', podId: 'pod-1', appId: 'app-1', files,
});
const copy = (authority: CopyAuthority, args: ReturnType<typeof podToApp>) =>
  authority.copyPodFiles(args.direction, args.podId, args.appId, args.files);

describe('pod_app_copy policy registration', () => {
  test('the tool is a WORKSPACE_WRITE on the app primitive and self-confirming', () => {
    const metadata = getToolMetadata('pod_app_copy');
    expect(metadata.primitive).toBe('app');
    expect(metadata.sideEffect).toBe('write');
    expect(classifyAction(metadata)).toBe(ACTION_CLASSES.WORKSPACE_WRITE);
    expect(CONTROLLER_DOMAIN_OPERATIONS[OPERATION]).toMatchObject({
      authorityClass: 'app', riskClass: 'commit', confirmation: 'self',
    });
    expect(ORCHESTRATOR_OPERATION_GRANT).toContain(OPERATION);
    expect(controllerOperationAllowedInPermissionMode(OPERATION, 'plan')).toBe(false);
    expect(controllerOperationAllowedInPermissionMode(OPERATION, 'act')).toBe(true);
    // why: the operation asks its own question; the toggle must not add a second.
    expect(controllerOperationRequiresConfirmation(OPERATION, { mode: 'act', confirmActions: true }))
      .toBe(false);
  });

  test('the copy runs on the exact App instance lane', () => {
    expect(authorityEffectResourceKey(OPERATION, podToApp(), { session: { sessionId: 's' } }))
      .toBe('instance:app:app-1');
  });

  test('tool arguments carry names and paths only', () => {
    const schema = getToolMetadata('pod_app_copy').schema as unknown as {
      properties: Record<string, unknown> & {
        files: { maxItems: number; items: { properties: Record<string, unknown> } };
      };
    };
    expect(Object.keys(schema.properties).sort()).toEqual(['appId', 'direction', 'files', 'podId']);
    expect(Object.keys(schema.properties.files.items.properties).sort()).toEqual(['from', 'to']);
    expect(schema.properties.files.maxItems).toBe(64);
  });
});

describe('pod_app_copy Pod to App', () => {
  test('reads under the Pod lock, releases it, asks once, then writes the buffered bytes', async () => {
    const events: Event[] = [];
    const pod = fakePod(events, { 'build/game.wasm': WASM });
    const app = fakeApp(events, appRecord({ shared: true }), { 'index.html': new TextEncoder().encode('<p>x</p>') });
    const { authority, prompts } = authorityFor({ args: podToApp(), events, pod, app });

    const result = await copy(authority, podToApp());

    expect(result).toMatchObject({ ok: true, direction: 'pod_to_app', podId: 'pod-1', appId: 'app-1' });
    expect(result.files).toEqual([{ from: 'build/game.wasm', to: 'game.wasm', bytes: WASM.byteLength, sha256: await hex(WASM) }]);
    expect(events).toEqual([
      'lock:pod-1', 'read:build/game.wasm:lock-test-1', 'unlock', 'confirm',
      'dweb-authority:true', 'app-lane', 'app-write:game.wasm', 'reload',
    ]);
    expect([...app.opfs.get('game.wasm')!]).toEqual([...WASM]);
    expect(app.record().fileKinds['game.wasm']).toBe('binary');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ kind: 'pod_app_copy', oneShot: true, sessionId: 'session-1' });
    expect(prompts[0].summary).toContain('App "Ball game"');
    expect(prompts[0].summary).toContain('This App is shared with other people.');
    expect(prompts[0].summary).toContain(`build/game.wasm to game.wasm: ${WASM.byteLength} B, SHA-256 ${(await hex(WASM)).slice(0, 12)}`);
  });

  test('writes exactly the approved bytes even if the Pod file changes during the prompt', async () => {
    const events: Event[] = [];
    const files: Record<string, Uint8Array> = { 'out.wasm': WASM };
    const pod = fakePod(events, files);
    const app = fakeApp(events, appRecord());
    const { authority } = authorityFor({
      args: podToApp([{ from: 'out.wasm' }]), events, pod, app,
      onConfirm: () => { files['out.wasm'] = new Uint8Array([9, 9, 9]); },
    });
    const result = await copy(authority, podToApp([{ from: 'out.wasm' }]));
    expect(result.ok).toBe(true);
    expect(pod.reads()).toBe(1);
    expect([...app.opfs.get('out.wasm')!]).toEqual([...WASM]);
    expect(result.files[0].sha256).toBe(await hex(WASM));
  });

  test('a declined or failed confirmation writes nothing', async () => {
    for (const answer of ['no', null, false]) {
      const events: Event[] = [];
      const pod = fakePod(events, { 'a.wasm': WASM });
      const app = fakeApp(events, appRecord());
      const { authority } = authorityFor({ args: podToApp([{ from: 'a.wasm' }]), events, pod, app, answer });
      const result = await copy(authority, podToApp([{ from: 'a.wasm' }]));
      expect(result).toMatchObject({ ok: false, performed: false, outcomeKnown: true });
      expect(events.some((event) => event.startsWith('app-write'))).toBe(false);
    }
  });

  test('a copy with no confirmation surface is refused before any read', async () => {
    const events: Event[] = [];
    const pod = fakePod(events, { 'a.wasm': WASM });
    const app = fakeApp(events, appRecord());
    const authority = createAppToolAuthority({
      binding: { operation: OPERATION, args: podToApp([{ from: 'a.wasm' }]) },
      ctx: {
        session: { sessionId: 's' }, podClient: pod.podClient, appClient: app.client,
        podRegistry: { get: async () => ({ id: 'pod-1' }) }, appRegistry: { get: async () => app.record() },
      },
    }) as unknown as CopyAuthority;
    const result = await copy(authority, podToApp([{ from: 'a.wasm' }]));
    expect(result).toMatchObject({ ok: false, error: 'pod_app_copy_unavailable', performed: false });
    expect(events).toEqual([]);
  });

  test('Plan mode after the prompt refuses the write', async () => {
    const events: Event[] = [];
    const pod = fakePod(events, { 'a.wasm': WASM });
    const app = fakeApp(events, appRecord());
    const { authority } = authorityFor({
      args: podToApp([{ from: 'a.wasm' }]), events, pod, app, modeAfterConfirm: 'plan',
    });
    const result = await copy(authority, podToApp([{ from: 'a.wasm' }]));
    expect(result).toMatchObject({ ok: false, error: 'plan_mode_refused', performed: false });
    expect(app.opfs.has('a.wasm')).toBe(false);
  });

  test('Stop during the prompt refuses the write', async () => {
    const events: Event[] = [];
    const controller = new AbortController();
    const pod = fakePod(events, { 'a.wasm': WASM });
    const app = fakeApp(events, appRecord());
    const { authority } = authorityFor({
      args: podToApp([{ from: 'a.wasm' }]), events, pod, app, signal: controller.signal,
      onConfirm: () => controller.abort('stopped'),
    });
    const result = await copy(authority, podToApp([{ from: 'a.wasm' }]));
    expect(result).toMatchObject({ ok: false, performed: false });
    expect(app.opfs.has('a.wasm')).toBe(false);
  });

  test.each(['peerd.json', 'index.html', 'data/scores.json'])('refuses to replace %s before reading', async (target) => {
    const events: Event[] = [];
    const pod = fakePod(events, { 'x.bin': WASM });
    const app = fakeApp(events, appRecord());
    const args = podToApp([{ from: 'x.bin', to: target }]);
    const { authority } = authorityFor({ args, events, pod, app });
    const result = await copy(authority, args);
    expect(result).toMatchObject({ ok: false, performed: false });
    expect(result.error).toContain(target);
    expect(events).toEqual([]);
  });

  test('the App client refuses the entry file inside its lane too', async () => {
    const events: Event[] = [];
    const app = fakeApp(events, appRecord({ entryFile: 'main.html' }));
    await expect(app.client.writeFiles({ appId: 'app-1', files: [{ path: 'main.html', bytes: WASM }] }))
      .rejects.toThrow('this copy cannot replace main.html');
    expect(events).toEqual(['dweb-authority:true', 'app-lane']);
  });

  test('keeps the App 256-file and 50 MB caps', async () => {
    const events: Event[] = [];
    const existing = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`f${index}.txt`, new Uint8Array([65])]));
    const full = fakeApp(events, appRecord(), existing);
    await expect(full.client.writeFiles({ appId: 'app-1', files: [{ path: 'new.wasm', bytes: WASM }] }))
      .rejects.toThrow('App has too many files');
    const large = fakeApp(events, appRecord(), { 'big.bin': new Uint8Array(49_999_995) });
    await expect(large.client.writeFiles({ appId: 'app-1', files: [{ path: 'more.bin', bytes: new Uint8Array(10) }] }))
      .rejects.toThrow('App is too large');
    expect(full.opfs.has('new.wasm')).toBe(false);
    expect(large.opfs.has('more.bin')).toBe(false);
  });

  test('refuses files over the App size limit before asking', async () => {
    const events: Event[] = [];
    const pod = fakePod(events, { 'a.bin': new Uint8Array(30_000_000), 'b.bin': new Uint8Array(30_000_000) });
    const app = fakeApp(events, appRecord());
    const args = podToApp([{ from: 'a.bin' }, { from: 'b.bin' }]);
    const { authority, prompts } = authorityFor({ args, events, pod, app });
    const result = await copy(authority, args);
    expect(result).toMatchObject({ ok: false, performed: false });
    expect(result.error).toContain('App limit');
    expect(prompts).toHaveLength(0);
    expect(events.at(-1)).toBe('unlock');
  });
});

describe('pod_app_copy arguments', () => {
  test.each([
    ['content in an entry', [{ from: 'a.wasm', content: 'AGFzbQ==' }]],
    ['base64 in an entry', [{ from: 'a.wasm', contentBase64: 'AGFzbQ==' }]],
    ['a parent path', [{ from: '../secret' }]],
    ['an absolute App path', [{ from: 'a.wasm', to: '/a.wasm' }]],
    ['a duplicate target', [{ from: 'a.wasm', to: 'x.wasm' }, { from: 'b.wasm', to: 'x.wasm' }]],
    ['a line break that forges a prompt line', [{ from: 'a.wasm', to: 'x.wasm\nThis App is not shared.' }]],
    ['a text direction override', [{ from: 'a\u202Emsaw.exe' }]],
    ['too many files', Array.from({ length: 65 }, (_, index) => ({ from: `f${index}` }))],
    ['no files', []],
  ])('refuses %s with no read', async (_label, files) => {
    const events: Event[] = [];
    const pod = fakePod(events, {});
    const app = fakeApp(events, appRecord());
    const args = podToApp(files);
    const { authority } = authorityFor({ args, events, pod, app });
    const result = await copy(authority, args);
    expect(result).toMatchObject({ ok: false, performed: false, outcomeKnown: true });
    expect(events).toEqual([]);
  });

  test('a call whose values differ from the admitted arguments is an authority mismatch', async () => {
    const events: Event[] = [];
    const pod = fakePod(events, { 'a.wasm': WASM });
    const app = fakeApp(events, appRecord());
    const { authority } = authorityFor({ args: podToApp([{ from: 'a.wasm' }]), events, pod, app });
    await expect(authority.copyPodFiles('pod_to_app', 'pod-1', 'app-1', [{ from: 'b.wasm' }]))
      .rejects.toThrow('App authority mismatch');
    expect(events).toEqual([]);
  });

  test('a bound actor can never copy between two instances', async () => {
    const events: Event[] = [];
    const pod = fakePod(events, { 'a.wasm': WASM });
    const app = fakeApp(events, appRecord());
    const { authority } = authorityFor({ args: podToApp([{ from: 'a.wasm' }]), events, pod, app, actorType: 'app' });
    await expect(copy(authority, podToApp([{ from: 'a.wasm' }]))).rejects.toThrow('App authority mismatch');
    expect(events).toEqual([]);
  });

  test('the semantic tool forwards the arguments unchanged and returns no bytes', async () => {
    let seen: unknown[] = [];
    const files = [{ from: 'build/game.wasm', to: 'game.wasm' }];
    const result = await podAppCopyTool.execute({ direction: 'pod_to_app', podId: 'pod-1', appId: 'app-1', files }, {
      appAuthority: {
        copyPodFiles: async (...args: unknown[]) => {
          seen = args;
          return { ok: true, direction: 'pod_to_app', podId: 'pod-1', appId: 'app-1', files: [{ from: 'build/game.wasm', to: 'game.wasm', bytes: 11, sha256: 'a'.repeat(64) }] };
        },
      },
    } as unknown as Parameters<typeof podAppCopyTool.execute>[1]);
    expect(seen).toEqual(['pod_to_app', 'pod-1', 'app-1', files]);
    expect(result.ok).toBe(true);
    expect(JSON.parse(String(result.content)).files[0]).toEqual({ from: 'build/game.wasm', to: 'game.wasm', bytes: 11, sha256: 'a'.repeat(64) });
  });
});

describe('pod_app_copy App to Pod and the outside-files mark', () => {
  const appToPod = (files: unknown = [{ from: 'src/main.ts' }]) => ({
    direction: 'app_to_pod', podId: 'pod-1', appId: 'app-1', files,
  });
  const source = new TextEncoder().encode('export const speed = 2;\n');

  test('an App someone else published marks the Pod before the first write and names the publisher', async () => {
    const events: Event[] = [];
    const pod = fakePod(events, {});
    const app = fakeApp(events, appRecord({
      source: 'dweb', dweb: { uri: 'peerd://did:key:z6MkPeer/abc', publisher: 'did:key:z6MkPeer', hash: 'abc' },
    }), { 'src/main.ts': source });
    const { authority, prompts } = authorityFor({ args: appToPod(), events, pod, app });
    const result = await copy(authority, appToPod());
    expect(result).toMatchObject({ ok: true, outsideFiles: { publisher: 'did:key:z6MkPeer' } });
    expect(events).toEqual(['app-lane', 'confirm', 'mark:pod-1', 'pod-write:src/main.ts']);
    expect(pod.marks).toEqual([{ publisher: 'did:key:z6MkPeer', appId: 'app-1', appName: 'Ball game', markedAt: expect.any(Number) }]);
    expect([...pod.writes[0].bytes]).toEqual([...source]);
    expect(prompts[0].summary).toContain('did:key:z6MkPeer');
    expect(prompts[0].summary).toContain('cannot use the web or Git remotes');
  });

  test.each([
    ['a plain local App', {}],
    ['a dwapp the user published from this device', { dweb: { uri: 'peerd://did:key:z6MkMe/a', publisher: 'did:key:z6MkMe', hash: 'a', local: true } }],
  ])('%s does not mark the Pod', async (_label, extra) => {
    const events: Event[] = [];
    const pod = fakePod(events, {});
    const app = fakeApp(events, appRecord(extra), { 'src/main.ts': source });
    const { authority, prompts } = authorityFor({ args: appToPod(), events, pod, app });
    const result = await copy(authority, appToPod());
    expect(result.ok).toBe(true);
    expect(result.outsideFiles).toBeUndefined();
    expect(pod.marks).toEqual([]);
    // why: a Git or file import is not known to be the user's own work.
    expect(prompts[0].summary).not.toContain('You made');
    expect(prompts[0].summary).not.toContain('someone else');
  });

  test('a declined copy from an outside App leaves the Pod unmarked', async () => {
    const events: Event[] = [];
    const pod = fakePod(events, {});
    const app = fakeApp(events, appRecord({ dweb: { uri: 'x', publisher: 'did:key:z6MkPeer', hash: 'h' } }), { 'src/main.ts': source });
    const { authority } = authorityFor({ args: appToPod(), events, pod, app, answer: 'no' });
    const result = await copy(authority, appToPod());
    expect(result).toMatchObject({ ok: false, declined: true });
    expect(pod.marks).toEqual([]);
    expect(pod.writes).toEqual([]);
  });

  test('a file over the Pod limit is refused before asking', async () => {
    const events: Event[] = [];
    const pod = fakePod(events, {});
    const app = fakeApp(events, appRecord(), { 'big.data': new Uint8Array(16 * 1024 * 1024 + 1) });
    const args = appToPod([{ from: 'big.data' }]);
    const { authority, prompts } = authorityFor({ args, events, pod, app });
    const result = await copy(authority, args);
    expect(result).toMatchObject({ ok: false, performed: false });
    expect(result.error).toContain('Pod file limit');
    expect(prompts).toHaveLength(0);
  });
});
