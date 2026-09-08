import { describe, test, expect } from 'bun:test';
import { decidePullIn } from '../../extension/background/kernel-front-door.js';

describe('decidePullIn', () => {
  describe('toolbar icon (fromShortcut: false) — default front door (panel)', () => {
    test('opens the side panel directly, even with no home open (Chrome)', () => {
      expect(decidePullIn({ homeOpen: false, hasSidePanel: true, hasSidebar: false }))
        .toBe('panel');
    });

    test('opens the sidebar directly, even with no home open (Firefox)', () => {
      expect(decidePullIn({ homeOpen: false, hasSidePanel: false, hasSidebar: true }))
        .toBe('sidebar');
    });

    test('still opens the panel when home is already open (Chrome)', () => {
      expect(decidePullIn({ homeOpen: true, hasSidePanel: true, hasSidebar: false }))
        .toBe('panel');
    });

    test('an explicit frontDoorView: "panel" behaves like the default', () => {
      expect(decidePullIn({ homeOpen: false, hasSidePanel: true, hasSidebar: false, frontDoorView: 'panel' }))
        .toBe('panel');
    });
  });

  describe('toolbar icon (fromShortcut: false) — frontDoorView: "home" (the original model)', () => {
    test('opens home when no home surface is open (Chrome)', () => {
      expect(decidePullIn({ homeOpen: false, hasSidePanel: true, hasSidebar: false, frontDoorView: 'home' }))
        .toBe('home');
    });

    test('complements with the side panel when home is already open (Chrome)', () => {
      expect(decidePullIn({ homeOpen: true, hasSidePanel: true, hasSidebar: false, frontDoorView: 'home' }))
        .toBe('panel');
    });

    test('opens home when no home surface is open (Firefox)', () => {
      expect(decidePullIn({ homeOpen: false, hasSidePanel: false, hasSidebar: true, frontDoorView: 'home' }))
        .toBe('home');
    });

    test('complements with the sidebar when home is already open (Firefox)', () => {
      expect(decidePullIn({ homeOpen: true, hasSidePanel: false, hasSidebar: true, frontDoorView: 'home' }))
        .toBe('sidebar');
    });
  });

  describe('keyboard command (fromShortcut: true) — toggle, regardless of front door', () => {
    test('pulls the side panel in when closed, even with no home open (Chrome)', () => {
      expect(decidePullIn({ homeOpen: false, panelOpen: false, hasSidePanel: true, hasSidebar: false, fromShortcut: true }))
        .toBe('panel');
    });

    test('pulls the sidebar in when closed, even with no home open (Firefox)', () => {
      expect(decidePullIn({ homeOpen: false, panelOpen: false, hasSidePanel: false, hasSidebar: true, fromShortcut: true }))
        .toBe('sidebar');
    });

    test('closes the panel when it is already open (Chrome)', () => {
      expect(decidePullIn({ homeOpen: true, panelOpen: true, hasSidePanel: true, hasSidebar: false, fromShortcut: true }))
        .toBe('close');
    });

    test('closes the sidebar when it is already open (Firefox)', () => {
      expect(decidePullIn({ homeOpen: false, panelOpen: true, hasSidePanel: false, hasSidebar: true, fromShortcut: true }))
        .toBe('close');
    });

    test('frontDoorView: "home" never changes the shortcut — it still pulls the panel in', () => {
      expect(decidePullIn({ homeOpen: false, panelOpen: false, hasSidePanel: true, hasSidebar: false, fromShortcut: true, frontDoorView: 'home' }))
        .toBe('panel');
    });

    test('frontDoorView: "home" never changes the shortcut — an open panel still toggles closed', () => {
      expect(decidePullIn({ homeOpen: false, panelOpen: true, hasSidePanel: true, hasSidebar: false, fromShortcut: true, frontDoorView: 'home' }))
        .toBe('close');
    });
  });

  describe('the native-mirror inference (Chrome setPanelBehavior)', () => {
    test('icon + mirror ⇒ home-first, even when the (pre-hydration) setting says panel', () => {
      // The cold-start case the mirror exists for: the settings store still
      // serves the channel default 'panel', but onClicked firing at all means
      // the browser-side behavior was off — the user chose 'home'.
      expect(decidePullIn({ homeOpen: false, hasSidePanel: true, hasSidebar: false, frontDoorView: 'panel', nativePanelMirror: true }))
        .toBe('home');
    });

    test('icon + mirror still complements with the panel once home is open', () => {
      expect(decidePullIn({ homeOpen: true, hasSidePanel: true, hasSidebar: false, frontDoorView: 'panel', nativePanelMirror: true }))
        .toBe('panel');
    });

    test('the shortcut never rides the inference — it pulls the panel in regardless', () => {
      expect(decidePullIn({ homeOpen: false, panelOpen: false, hasSidePanel: true, hasSidebar: false, fromShortcut: true, nativePanelMirror: true }))
        .toBe('panel');
    });
  });

  describe('toolbar icon never closes — only the shortcut toggles', () => {
    test('icon re-opens (focuses) an already-open panel rather than closing it', () => {
      expect(decidePullIn({ homeOpen: true, panelOpen: true, hasSidePanel: true, hasSidebar: false, fromShortcut: false }))
        .toBe('panel');
    });
  });

  test('falls back to home when neither panel API exists', () => {
    expect(decidePullIn({ homeOpen: true, hasSidePanel: false, hasSidebar: false, fromShortcut: true }))
      .toBe('home');
    expect(decidePullIn({ homeOpen: false, hasSidePanel: false, hasSidebar: false }))
      .toBe('home');
    expect(decidePullIn({ homeOpen: false, hasSidePanel: false, hasSidebar: false, frontDoorView: 'panel' }))
      .toBe('home');
  });

  test('prefers the side panel over the sidebar when both are somehow present', () => {
    expect(decidePullIn({ homeOpen: true, hasSidePanel: true, hasSidebar: true }))
      .toBe('panel');
  });
});
