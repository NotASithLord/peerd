import { describe, expect, test } from 'bun:test';
import {
  attachKernelFrontDoor,
  createKernelFrontDoor,
} from '../../extension/background/kernel-front-door.js';

const event = () => {
  const listeners: Array<(...args: any[]) => any> = [];
  return {
    addListener(listener: (...args: any[]) => any) { listeners.push(listener); },
    emit(...args: any[]) { return listeners.map((listener) => listener(...args)); },
    count: () => listeners.length,
  };
};

const makeHarness = ({
  homeOpen = false,
  panelOpen = false,
  frontDoorView = 'panel' as 'panel'|'home',
  nativeMirror = false,
  firefox = false,
} = {}) => {
  const action = event();
  const command = event();
  const focus = event();
  const calls: string[] = [];
  const browser: any = {
    runtime: { id: 'extension-id' },
    action: { onClicked: action },
    commands: { onCommand: command },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: focus,
      getLastFocused: async () => ({ id: 8, focused: true }),
    },
    ...(firefox ? {
      sidebarAction: { open: () => { calls.push('sidebar'); return Promise.resolve(); } },
    } : {
      sidePanel: {
        open: ({ windowId }: any) => { calls.push(`panel:${windowId}`); return Promise.resolve(); },
        ...(nativeMirror ? {
          setPanelBehavior: ({ openPanelOnActionClick }: any) => {
            calls.push(`native:${openPanelOnActionClick}`);
            return Promise.resolve();
          },
        } : {}),
      },
    }),
  };
  const coldKeys: string[] = [];
  const api = createKernelFrontDoor({
    browser,
    coldEvent: (key, raw) => { coldKeys.push(key); return raw; },
    isHomeOpen: () => homeOpen,
    isPanelOpen: () => panelOpen,
    getFrontDoorView: () => frontDoorView,
    closePanel: () => { calls.push('close'); },
    openHome: () => { calls.push('home'); },
  });
  return { action, command, focus, calls, coldKeys, api };
};

describe('thin-kernel synchronous front door', () => {
  test('registers the three exact cold events once and opens in the gesture stack', () => {
    const harness = makeHarness();
    expect(harness.coldKeys).toEqual([
      'windows.onFocusChanged', 'action.onClicked', 'commands.onCommand',
    ]);
    expect([harness.focus.count(), harness.action.count(), harness.command.count()])
      .toEqual([1, 1, 1]);
    const result = harness.action.emit({ windowId: 17 });
    expect(result).toEqual([undefined]);
    expect(harness.calls).toEqual(['panel:17']);
  });

  test('keeps home preference, shortcut toggle, Firefox sidebar, and command filter exact', async () => {
    const home = makeHarness({ frontDoorView: 'home' });
    home.action.emit({ windowId: 4 });
    expect(home.calls).toEqual(['home']);

    const toggle = makeHarness({ panelOpen: true });
    toggle.command.emit('unrelated', { windowId: 5 });
    toggle.command.emit('pull-in-peerd', { windowId: 5 });
    expect(toggle.calls).toEqual(['close']);

    const firefox = makeHarness({ firefox: true });
    firefox.command.emit('pull-in-peerd', { windowId: 6 });
    expect(firefox.calls).toEqual(['sidebar']);
    expect(await firefox.api.syncNativeBehavior()).toBe(false);
    expect(firefox.calls).toEqual(['sidebar']);
  });

  test('uses the focused-window backstop and mirrors the native Chrome preference', async () => {
    const harness = makeHarness({ nativeMirror: true });
    await Promise.resolve();
    harness.command.emit('pull-in-peerd', {});
    expect(harness.calls).toEqual(['panel:8']);
    expect(await harness.api.syncNativeBehavior()).toBe(true);
    expect(harness.calls).toEqual(['panel:8', 'native:true']);
    harness.focus.emit(-1);
    expect(harness.api.snapshot()).toEqual({ lastFocusedWindowId: 8, browserFocused: false });
  });

  test('attaches recovery and returns one shared panel closer', async () => {
    const action = event();
    const command = event();
    const focus = event();
    let closed = 0;
    let recovery: any = null;
    const browser: any = {
      runtime: {}, action: { onClicked: action }, commands: { onCommand: command },
      windows: {
        WINDOW_ID_NONE: -1, onFocusChanged: focus,
        getLastFocused: async () => ({ id: 4, focused: true }),
      },
      sidebarAction: { close: async () => { closed += 1; } },
    };
    const attached = attachKernelFrontDoor({
      browser,
      events: {
        event: (_key: string, raw: any) => raw,
        registerRecovery: (entry: any) => { recovery = entry; },
      },
      uiPorts: { hasNamed: () => false },
      settingsStore: { get: () => ({ frontDoorView: 'panel' }) },
      openHome: () => {},
      ready: Promise.resolve(),
    });
    expect(await attached.closePanel()).toEqual({ ok: true });
    expect(closed).toBe(1);
    expect(recovery).toMatchObject({
      event: 'windows.onFocusChanged', owner: 'kernel-front-door',
    });
    expect(await recovery.reconcile()).toEqual({ lastFocusedWindowId: 4, browserFocused: true });
  });
});

describe('closing the side panel', () => {
  type Closer = { close?: (options: { windowId: number }) => Promise<void> };
  const attachCloser = (sidePanel: Closer) => {
    const calls: string[] = [];
    const browser = {
      runtime: {},
      windows: {
        WINDOW_ID_NONE: -1,
        onFocusChanged: event(),
        getLastFocused: async () => ({ id: 4, focused: true }),
        getAll: async ({ windowTypes }: { windowTypes: string[] }) => {
          calls.push(`getAll:${windowTypes.join(',')}`);
          return [{ id: 4 }, { id: 9 }];
        },
      },
      sidePanel: {
        ...sidePanel,
        setOptions: async (options: { enabled: boolean }) => { calls.push(`setOptions:${options.enabled}`); },
      },
    };
    const { closePanel } = attachKernelFrontDoor({
      browser,
      events: { event: (_key: string, raw: unknown) => raw, registerRecovery: () => {} },
      uiPorts: { hasNamed: () => false },
      settingsStore: { get: () => ({ frontDoorView: 'panel' }) },
      openHome: () => {},
      ready: Promise.resolve(),
    });
    return { closePanel, calls };
  };

  test('Chrome 141+ closes the panel in every normal window, with no disable and re-enable', async () => {
    const closedIn: number[] = [];
    const { closePanel, calls } = attachCloser({
      close: async ({ windowId }) => { closedIn.push(windowId); },
    });
    expect(await closePanel()).toEqual({ ok: true });
    expect(closedIn).toEqual([4, 9]);
    expect(calls).toEqual(['getAll:normal']);
  });

  test('a window without the panel does not fail the close', async () => {
    const { closePanel, calls } = attachCloser({
      close: async ({ windowId }) => { if (windowId === 4) throw new Error('No active side panel'); },
    });
    expect(await closePanel()).toEqual({ ok: true });
    expect(calls).toEqual(['getAll:normal']);
  });

  test('falls back to the disable and re-enable trick without close, or when every close fails', async () => {
    const old = attachCloser({});
    expect(await old.closePanel()).toEqual({ ok: true });
    expect(old.calls).toEqual(['setOptions:false']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(old.calls).toEqual(['setOptions:false', 'setOptions:true']);

    const failing = attachCloser({ close: async () => { throw new Error('close failed'); } });
    expect(await failing.closePanel()).toEqual({ ok: true });
    expect(failing.calls).toEqual(['getAll:normal', 'setOptions:false']);
  });
});
