import { describe, expect, test } from 'bun:test';
import { handleAction } from '../../../extension/engine-tabs/app-tab/full-screen.js';

// The P handle in an App's full screen. Chrome keeps its side panel beside a
// full-screen element; Firefox hides its sidebar there (measured in Chrome for
// Testing 151 and Firefox 154). The DOM wiring runs in the in-browser lane.
describe('App full screen', () => {
  test('in Chrome the handle opens the side panel beside the full-screen App', () => {
    expect(handleAction('side-panel')).toBe('open-beside');
  });

  test('in Firefox the handle leaves full screen first, because the sidebar hides there', () => {
    expect(handleAction('sidebar')).toBe('leave-then-open');
  });

  test('with no panel to open there is no handle', () => {
    expect(handleAction(null)).toBe(null);
  });

  test('the page root goes full screen, and the App frame gets no full-screen permission', async () => {
    const host = await Bun.file('./extension/engine-tabs/app-tab/app-tab.js').text();
    const html = await Bun.file('./extension/engine-tabs/app-tab/index.html').text();
    // why the root: the consent bar and notices sit beside the frame, not in it.
    expect(host).toContain('target: document.documentElement');
    expect(html).toContain('<iframe id="app-frame" title="peerd app" sandbox="allow-scripts allow-modals allow-pointer-lock"></iframe>');
  });
});
