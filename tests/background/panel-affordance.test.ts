import { describe, test, expect } from 'bun:test';
import { decidePullIn } from '../../extension/background/panel-affordance.js';

describe('decidePullIn', () => {
  describe('toolbar icon (fromShortcut: false)', () => {
    test('opens home when no home surface is open (Chrome)', () => {
      expect(decidePullIn({ homeOpen: false, hasSidePanel: true, hasSidebar: false }))
        .toBe('home');
    });

    test('complements with the side panel when home is already open (Chrome)', () => {
      expect(decidePullIn({ homeOpen: true, hasSidePanel: true, hasSidebar: false }))
        .toBe('panel');
    });

    test('opens home when no home surface is open (Firefox)', () => {
      expect(decidePullIn({ homeOpen: false, hasSidePanel: false, hasSidebar: true }))
        .toBe('home');
    });

    test('complements with the sidebar when home is already open (Firefox)', () => {
      expect(decidePullIn({ homeOpen: true, hasSidePanel: false, hasSidebar: true }))
        .toBe('sidebar');
    });
  });

  describe('keyboard command (fromShortcut: true) — toggle', () => {
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
  });

  test('prefers the side panel over the sidebar when both are somehow present', () => {
    expect(decidePullIn({ homeOpen: true, hasSidePanel: true, hasSidebar: true }))
      .toBe('panel');
  });
});
