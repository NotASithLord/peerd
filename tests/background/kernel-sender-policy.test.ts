import { describe, expect, test } from 'bun:test';
import { createKernelSenderPolicy } from '../../extension/background/kernel-control-plane.js';

const origin = 'chrome-extension://runtime/';
const policy = createKernelSenderPolicy({
  runtimeId: 'runtime', extensionOrigin: origin,
  sidepanelUrl: `${origin}sidepanel/sidepanel.html`,
  homeUrl: `${origin}home/home.html`,
  optionsUrl: `${origin}options/options.html`,
  evalRunnerUrl: `${origin}eval/runner.html`,
  notebookTabUrl: `${origin}engine-tabs/notebook-tab/index.html`,
  offscreenUrl: `${origin}offscreen/offscreen.html`,
  appTabUrl: `${origin}engine-tabs/app-tab/index.html`,
  micUrl: `${origin}permissions/mic.html`,
});

describe('kernel sender policy', () => {
  test('notebook and App documents require exact first-party provenance', () => {
    const notebook = {
      id: 'runtime', tab: { id: 4 },
      url: `${origin}engine-tabs/notebook-tab/index.html`,
    };
    const app = {
      id: 'runtime', tab: { id: 5 },
      url: `${origin}engine-tabs/app-tab/index.html#demo?owner=root`,
    };
    expect(policy.notebookUi(notebook)).toBe(true);
    expect(policy.appUi(app, 'demo')).toBe(true);
    expect(policy.notebookUi({ ...notebook, id: 'foreign' })).toBe(false);
    expect(policy.appUi({ ...app, id: 'foreign' }, 'demo')).toBe(false);
    expect(policy.appUi({ ...app, url: `${origin}engine-tabs/app-tab/index.html?x#demo` }, 'demo'))
      .toBe(false);
  });

  test('mic permission results require the exact first-party grant page', () => {
    const sender = {
      id: 'runtime', tab: { id: 8 }, url: `${origin}permissions/mic.html`,
    };
    expect(policy.micUi(sender)).toBe(true);
    expect(policy.micUi({ ...sender, id: 'foreign' })).toBe(false);
    expect(policy.micUi({ ...sender, url: `${origin}permissions/mic.html?forged` })).toBe(false);
  });
});
