// @ts-check
// Real-component fixture for the Firefox preview-update notice.

import m from '/vendor/mithril/mithril.js';
import { NoticeBar } from '/sidepanel/components/app.js';

let visible = true;

// Keep the functional state offline while proving the component sends the
// exact HTTPS target through the user-gesture path.
window.open = (url, target, features) => {
  document.body.dataset.openedUrl = String(url ?? '');
  document.body.dataset.openedTarget = String(target ?? '');
  document.body.dataset.openedFeatures = String(features ?? '');
  return null;
};

const Fixture = {
  view: () => m('.update-notice-fixture', visible
    ? m(NoticeBar, {
        notices: [{
          id: 1,
          text: 'peerd v0.7.0 is available (you have v0.6.0). Firefox installs preview updates on its own daily check, or install it now.',
          action: {
            kind: 'open-url',
            label: 'Install update',
            url: 'https://github.com/NotASithLord/peerd/releases/download/v0.7.0/peerd-preview-firefox.xpi',
          },
        }],
        uiActions: {
          dismissNotice: () => { visible = false; },
        },
      })
    : m('p', { role: 'status' }, 'Notice dismissed.')),
};

m.mount(document.getElementById('app'), Fixture);
