// Unit tests for the privileged-dispatcher sender-provenance guard.
//
// Pure predicate, no browser needed — covers the legitimate first-party
// surfaces (side panel, offscreen, vm/js/app tab pages) and the spoof /
// future-content-script cases the guard exists to reject.

import { describe, it, expect } from 'bun:test';
import { isFirstPartySender } from '../../extension/shared/sender-trust.js';

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

  it('accepts a vm/js/app tab page even though it carries a sender.tab', () => {
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
