// Unit tests for the privileged-dispatcher sender-provenance guard.
//
// Pure predicate, no browser needed — covers the legitimate first-party
// surfaces (side panel, offscreen, vm/js/pod/app tab pages) and the spoof /
// future-content-script cases the guard exists to reject.

import { describe, it, expect } from 'bun:test';
import {
  isEvalSender, isFirstPartySender, isHomeSender, isOffscreenSender,
  isOptionsSender, isServiceWorkerSender,
  isSidepanelPortSender, isSidepanelSender,
} from '../../extension/shared/sender-trust.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${ID}/`;
const trust = { runtimeId: ID, extensionOrigin: ORIGIN };

describe('isFirstPartySender', () => {
  it('accepts the side panel page', () => {
    expect(isFirstPartySender(
      { id: ID, url: `${ORIGIN}sidepanel/sidepanel.html` }, trust,
    )).toBe(true);
  });

  it('accepts the offscreen document', () => {
    expect(isFirstPartySender(
      { id: ID, url: `${ORIGIN}offscreen/offscreen.html` }, trust,
    )).toBe(true);
  });

  it('accepts an engine tab page even though it carries a sender.tab', () => {
    // Tab-hosted extension pages legitimately have sender.tab set; the
    // discriminator must be the URL origin, not the presence of a tab.
    const sender = { id: ID, url: `${ORIGIN}vm-tab/vm-tab.html#vm-1`, tab: { id: 7 } };
    expect(isFirstPartySender(sender, trust)).toBe(true);
  });

  it('accepts the permissions grant page', () => {
    expect(isFirstPartySender(
      { id: ID, url: `${ORIGIN}permissions/mic.html` }, trust,
    )).toBe(true);
  });

  it('rejects a content script in a web page (same extension id, web url)', () => {
    // The future case the guard future-proofs: a content script shares the
    // extension id but its sender.url is the WEB page it runs in.
    const sender = { id: ID, url: 'https://evil.example/login', tab: { id: 9 } };
    expect(isFirstPartySender(sender, trust)).toBe(false);
  });

  it('rejects another extension', () => {
    const sender = { id: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', url: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/x.html' };
    expect(isFirstPartySender(sender, trust)).toBe(false);
  });

  it('rejects a prefix-spoofed sibling id', () => {
    // startsWith on an origin WITHOUT the trailing slash would admit a
    // sibling id sharing a prefix; the trailing slash in extensionOrigin
    // (getURL('')) prevents it — and the id check is a second gate.
    const sibling = `${ID}EVIL`;
    const sender = { id: sibling, url: `chrome-extension://${sibling}/x.html` };
    expect(isFirstPartySender(sender, trust)).toBe(false);
  });

  it('rejects an @-host spoof in the url', () => {
    const sender = { id: ID, url: `chrome-extension://${ID}@evil.example/x.html` };
    expect(isFirstPartySender(sender, trust)).toBe(false);
  });

  it('rejects a sender with no url', () => {
    expect(isFirstPartySender({ id: ID }, trust)).toBe(false);
  });

  it('rejects null / undefined / non-object senders', () => {
    expect(isFirstPartySender(null, trust)).toBe(false);
    expect(isFirstPartySender(undefined, trust)).toBe(false);
    expect(isFirstPartySender('nope' as unknown as object, trust)).toBe(false);
  });

  it('fails closed when trust context is missing', () => {
    const sender = { id: ID, url: `${ORIGIN}sidepanel/sidepanel.html` };
    expect(isFirstPartySender(sender, {} as any)).toBe(false);
    expect(isFirstPartySender(sender, { runtimeId: ID, extensionOrigin: '' })).toBe(false);
    expect(isFirstPartySender(sender, undefined as any)).toBe(false);
  });

  it('accepts a Firefox moz-extension origin', () => {
    const fxOrigin = `moz-extension://11111111-2222-3333-4444-555555555555/`;
    const fx = { runtimeId: ID, extensionOrigin: fxOrigin };
    expect(isFirstPartySender({ id: ID, url: `${fxOrigin}sidepanel/sidepanel.html` }, fx)).toBe(true);
  });
});

describe('isOffscreenSender', () => {
  const offscreenUrl = `${ORIGIN}offscreen/offscreen.html`;
  const offscreenTrust = { ...trust, offscreenUrl };

  it('accepts only the exact browser-owned offscreen document', () => {
    expect(isOffscreenSender({ id: ID, url: offscreenUrl }, offscreenTrust)).toBe(true);
  });

  it('rejects query and hash variants', () => {
    expect(isOffscreenSender({ id: ID, url: `${offscreenUrl}?copy=1` }, offscreenTrust)).toBe(false);
    expect(isOffscreenSender({ id: ID, url: `${offscreenUrl}#frame` }, offscreenTrust)).toBe(false);
  });

  it('rejects a tab-hosted copy of the offscreen page', () => {
    expect(isOffscreenSender(
      { id: ID, url: offscreenUrl, tab: { id: 9 } }, offscreenTrust,
    )).toBe(false);
  });

  it('rejects prefix variants and missing trust data', () => {
    expect(isOffscreenSender(
      { id: ID, url: `${offscreenUrl}.evil.html` }, offscreenTrust,
    )).toBe(false);
    expect(isOffscreenSender({ id: ID, url: offscreenUrl }, trust as any)).toBe(false);
  });
});

describe('isServiceWorkerSender', () => {
  const serviceWorkerUrl = `${ORIGIN}background/service-worker.js`;
  const backgroundPageUrl = `${ORIGIN}_generated_background_page.html`;
  const swTrust = { ...trust, serviceWorkerUrl, backgroundPageUrl };

  it('accepts the exact Chrome worker or Firefox generated background page', () => {
    expect(isServiceWorkerSender({ id: ID, url: serviceWorkerUrl }, swTrust)).toBe(true);
    expect(isServiceWorkerSender({ id: ID, url: backgroundPageUrl }, swTrust)).toBe(true);
    expect(isServiceWorkerSender(
      { id: ID, url: backgroundPageUrl, documentId: 'firefox-background-document' },
      swTrust,
    )).toBe(true);
  });

  it('rejects a first-party engine page replay and document-hosted copies', () => {
    expect(isServiceWorkerSender(
      { id: ID, url: `${ORIGIN}engine-tabs/notebook-tab/index.html`, tab: { id: 7 } },
      swTrust,
    )).toBe(false);
    expect(isServiceWorkerSender(
      { id: ID, url: serviceWorkerUrl, documentId: 'forged-copy' }, swTrust,
    )).toBe(false);
    expect(isServiceWorkerSender(
      { id: ID, url: backgroundPageUrl, tab: { id: 8 } }, swTrust,
    )).toBe(false);
  });

  it('rejects suffix/query variants and missing trust data', () => {
    expect(isServiceWorkerSender({ id: ID, url: `${serviceWorkerUrl}?x=1` }, swTrust)).toBe(false);
    expect(isServiceWorkerSender({ id: ID, url: `${backgroundPageUrl}#copy` }, swTrust)).toBe(false);
    expect(isServiceWorkerSender({ id: ID, url: serviceWorkerUrl }, trust as any)).toBe(false);
    expect(isServiceWorkerSender(
      { id: ID, url: serviceWorkerUrl }, { ...trust, serviceWorkerUrl } as any,
    )).toBe(false);
  });
});

describe('isOptionsSender', () => {
  const optionsUrl = `${ORIGIN}options/options.html`;
  const optionsTrust = { ...trust, optionsUrl };

  it('accepts the exact full-tab options page and its hash routes', () => {
    expect(isOptionsSender(
      { id: ID, url: optionsUrl, tab: { id: 11 } }, optionsTrust,
    )).toBe(true);
    expect(isOptionsSender(
      { id: ID, url: `${optionsUrl}#!/transfer`, tab: { id: 11 } }, optionsTrust,
    )).toBe(true);
  });

  it('rejects no-tab, query, sibling-path, and wrong-origin senders', () => {
    expect(isOptionsSender({ id: ID, url: optionsUrl }, optionsTrust)).toBe(false);
    expect(isOptionsSender(
      { id: ID, url: `${optionsUrl}?mode=transfer`, tab: { id: 11 } }, optionsTrust,
    )).toBe(false);
    expect(isOptionsSender(
      { id: ID, url: `${optionsUrl}.evil`, tab: { id: 11 } }, optionsTrust,
    )).toBe(false);
    expect(isOptionsSender(
      { id: ID, url: 'https://evil.example/options/options.html', tab: { id: 11 } },
      optionsTrust,
    )).toBe(false);
  });
});

describe('isSidepanelSender', () => {
  const sidepanelUrl = `${ORIGIN}sidepanel/sidepanel.html`;
  const sidepanelTrust = { ...trust, sidepanelUrl };

  it('accepts only the exact browser-owned panel/sidebar document', () => {
    expect(isSidepanelSender({ id: ID, url: sidepanelUrl }, sidepanelTrust)).toBe(true);
    expect(isSidepanelSender(
      { id: ID, url: `${sidepanelUrl}#!/chat` }, sidepanelTrust,
    )).toBe(true);
  });

  it('rejects tab-hosted copies, engine pages, and suffix/query variants', () => {
    expect(isSidepanelSender(
      { id: ID, url: sidepanelUrl, tab: { id: 12 } }, sidepanelTrust,
    )).toBe(false);
    expect(isSidepanelSender(
      { id: ID, url: `${ORIGIN}engine-tabs/app-tab/index.html`, tab: { id: 9 } },
      sidepanelTrust,
    )).toBe(false);
    expect(isSidepanelSender({ id: ID, url: `${sidepanelUrl}?forged=1` }, sidepanelTrust)).toBe(false);
    expect(isSidepanelSender({ id: ID, url: `${sidepanelUrl}.evil` }, sidepanelTrust)).toBe(false);
  });
});

describe('isSidepanelPortSender', () => {
  const sidepanelUrl = `${ORIGIN}sidepanel/sidepanel.html`;
  const sidepanelTrust = { ...trust, sidepanelUrl };

  it('accepts routed and tab-specific connections from the exact panel document', () => {
    expect(isSidepanelPortSender(
      { id: ID, url: `${sidepanelUrl}#!/chat` }, sidepanelTrust,
    )).toBe(true);
    expect(isSidepanelPortSender(
      { id: ID, url: sidepanelUrl, tab: { id: 12 } }, sidepanelTrust,
    )).toBe(true);
  });

  it('rejects query, suffix, engine-page, and wrong-origin connections', () => {
    expect(isSidepanelPortSender(
      { id: ID, url: `${sidepanelUrl}?forged=1` }, sidepanelTrust,
    )).toBe(false);
    expect(isSidepanelPortSender(
      { id: ID, url: `${sidepanelUrl}.evil#!/chat` }, sidepanelTrust,
    )).toBe(false);
    expect(isSidepanelPortSender(
      { id: ID, url: `${ORIGIN}engine-tabs/app-tab/index.html`, tab: { id: 9 } },
      sidepanelTrust,
    )).toBe(false);
    expect(isSidepanelPortSender(
      { id: ID, url: 'https://evil.example/sidepanel/sidepanel.html' }, sidepanelTrust,
    )).toBe(false);
  });
});

describe('isHomeSender', () => {
  const homeUrl = `${ORIGIN}home/home.html`;
  const homeTrust = { ...trust, homeUrl };

  it('accepts the exact tab-hosted Home document and its one-shot hash links', () => {
    expect(isHomeSender(
      { id: ID, url: homeUrl, tab: { id: 12 } }, homeTrust,
    )).toBe(true);
    expect(isHomeSender(
      { id: ID, url: `${homeUrl}#chat`, tab: { id: 12 } }, homeTrust,
    )).toBe(true);
  });

  it('rejects no-tab, engine, query, sibling-path, and wrong-origin senders', () => {
    expect(isHomeSender({ id: ID, url: homeUrl }, homeTrust)).toBe(false);
    expect(isHomeSender(
      { id: ID, url: `${ORIGIN}engine-tabs/app-tab/index.html`, tab: { id: 9 } },
      homeTrust,
    )).toBe(false);
    expect(isHomeSender(
      { id: ID, url: `${homeUrl}?forged=1`, tab: { id: 12 } }, homeTrust,
    )).toBe(false);
    expect(isHomeSender(
      { id: ID, url: `${homeUrl}.evil`, tab: { id: 12 } }, homeTrust,
    )).toBe(false);
    expect(isHomeSender(
      { id: ID, url: 'https://evil.example/home/home.html', tab: { id: 12 } },
      homeTrust,
    )).toBe(false);
  });
});

describe('isEvalSender', () => {
  const homeUrl = `${ORIGIN}home/home.html`;
  const evalRunnerUrl = `${ORIGIN}eval/runner.html`;
  const evalTrust = { ...trust, homeUrl, evalRunnerUrl };

  it('accepts Home Lab and the standalone runner, including hash routes', () => {
    expect(isEvalSender(
      { id: ID, url: `${homeUrl}#lab`, tab: { id: 12 } }, evalTrust,
    )).toBe(true);
    expect(isEvalSender(
      { id: ID, url: evalRunnerUrl, tab: { id: 13 } }, evalTrust,
    )).toBe(true);
  });

  it('rejects engine pages, no-tab copies, queries, and suffix variants', () => {
    expect(isEvalSender(
      { id: ID, url: `${ORIGIN}engine-tabs/app-tab/index.html`, tab: { id: 9 } },
      evalTrust,
    )).toBe(false);
    expect(isEvalSender({ id: ID, url: evalRunnerUrl }, evalTrust)).toBe(false);
    expect(isEvalSender(
      { id: ID, url: `${evalRunnerUrl}?forged=1`, tab: { id: 13 } }, evalTrust,
    )).toBe(false);
    expect(isEvalSender(
      { id: ID, url: `${evalRunnerUrl}.evil`, tab: { id: 13 } }, evalTrust,
    )).toBe(false);
  });
});
