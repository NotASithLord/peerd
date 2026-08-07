import { describe, expect, test } from 'bun:test';
import {
  BROWSER_TARGET_CODES,
  BROWSER_TARGET_STAGES,
  classifyBrowserAutomationTarget,
} from '../../extension/peerd-runtime/tools/browser-automation-policy.js';

const expectBlocked = (target: unknown, reason: 'private_network' | 'cloud_metadata') => {
  const verdict = classifyBrowserAutomationTarget(target);
  expect(verdict.allowed).toBe(false);
  if (verdict.allowed) throw new Error('expected browser target to be refused');
  expect(verdict.code).toBe(BROWSER_TARGET_CODES.PRIVATE_NETWORK);
  expect(verdict.reason).toBe(reason);
  expect(verdict.stage).toBe(BROWSER_TARGET_STAGES.PRE_NAVIGATION);
  expect(verdict.outcome).toBe('not_run');
  expect(verdict.retryable).toBe(false);
  expect(verdict.message.length).toBeGreaterThan(0);
  expect(verdict.correction).toContain('Ask the user');
  expect(verdict.origin).not.toContain('/secret');
  expect(verdict.origin).not.toContain('?');
  expect(verdict.origin).not.toContain('#');
};

describe('classifyBrowserAutomationTarget: stable result shape', () => {
  test('allows a public URL and returns only its origin', () => {
    expect(classifyBrowserAutomationTarget('https://user:pass@example.com:8443/secret?q=token#fragment'))
      .toEqual({ allowed: true, origin: 'https://example.com:8443' });
  });

  test('accepts a URL instance', () => {
    expect(classifyBrowserAutomationTarget(new URL('https://example.com/path')))
      .toEqual({ allowed: true, origin: 'https://example.com' });
  });

  test('private refusals expose an origin but no path, query, fragment, or credentials', () => {
    const verdict = classifyBrowserAutomationTarget('http://user:pass@127.0.0.1:8080/secret?q=token#fragment');
    expect(verdict).toEqual({
      allowed: false,
      code: BROWSER_TARGET_CODES.PRIVATE_NETWORK,
      reason: 'private_network',
      stage: 'pre_navigation',
      outcome: 'not_run',
      retryable: false,
      message: 'peerd does not automate a localhost, private network, or link-local page. No browser action was run.',
      correction: 'Do not retry with another URL spelling or browser tool. Ask the user to handle this page directly.',
      origin: 'http://127.0.0.1:8080',
    });
  });

  test('a committed-origin refusal says the page may be loaded but was not automated', () => {
    const verdict = classifyBrowserAutomationTarget('http://127.0.0.1/private', {
      stage: BROWSER_TARGET_STAGES.COMMITTED_ORIGIN,
    });
    expect(verdict).toMatchObject({
      allowed: false,
      code: BROWSER_TARGET_CODES.PRIVATE_NETWORK,
      stage: 'committed_origin',
      outcome: 'page_loaded_not_automated',
      retryable: false,
    });
    if (verdict.allowed) throw new Error('expected committed target to be refused');
    expect(verdict.message).toContain('may have loaded');
    expect(verdict.message).toContain('did not inspect or operate it');
    expect(verdict.correction).toContain('Do not retry');
  });

  test('an unknown stage fails to the conservative pre-navigation UX contract', () => {
    const verdict = classifyBrowserAutomationTarget('http://127.0.0.1', {
      stage: 'unknown' as any,
    });
    expect(verdict).toMatchObject({ stage: 'pre_navigation', outcome: 'not_run' });
  });

  test('a committed metadata landing uses the same no-retry correction contract', () => {
    const verdict = classifyBrowserAutomationTarget('http://metadata.google.internal/computeMetadata/v1/', {
      stage: BROWSER_TARGET_STAGES.COMMITTED_ORIGIN,
    });
    expect(verdict).toMatchObject({
      allowed: false,
      reason: 'cloud_metadata',
      stage: 'committed_origin',
      outcome: 'page_loaded_not_automated',
    });
    if (verdict.allowed) throw new Error('expected metadata target to be refused');
    expect(verdict.message).toContain('cloud metadata page');
    expect(verdict.correction).toContain('Ask the user');
  });
});

describe('classifyBrowserAutomationTarget: localhost and local names', () => {
  const targets = [
    'http://localhost',
    'https://LOCALHOST:8443/path',
    'http://localhost./secret',
    'http://api.localhost',
    'http://deep.api.localhost./path',
    'http://localhost.localdomain',
    'http://api.localhost.localdomain./path',
    'http://ip6-localhost',
    'http://ip6-loopback',
    'http://local',
    'http://printer.local',
    'http://db.office.local./status',
    'http://home.arpa',
    'http://router.home.arpa./status',
  ];
  for (const target of targets) {
    test(`blocks ${target}`, () => expectBlocked(target, 'private_network'));
  }
});

describe('classifyBrowserAutomationTarget: private and special IPv4 ranges', () => {
  const targets = [
    'http://0.0.0.0', 'http://0.255.255.255',
    'http://10.0.0.0', 'https://10.255.255.255',
    'http://100.64.0.0', 'http://100.127.255.255',
    'http://127.0.0.0', 'http://127.255.255.255',
    'http://169.254.0.0', 'http://169.254.255.255',
    'http://172.16.0.0', 'http://172.31.255.255',
    'http://192.168.0.0', 'http://192.168.255.255',
    'http://198.18.0.0', 'http://198.19.255.255',
    'http://224.0.0.0', 'http://239.255.255.255',
    'http://240.0.0.0', 'http://255.255.255.255',
  ];
  for (const target of targets) {
    test(`blocks ${target}`, () => expectBlocked(target, 'private_network'));
  }
});

describe('classifyBrowserAutomationTarget: URL-accepted IPv4 spellings', () => {
  const targets = [
    'http://2130706433',          // decimal 127.0.0.1
    'http://0x7f000001',          // hexadecimal 127.0.0.1
    'http://0177.0.0.1',          // octal first octet
    'http://127.1',               // two-part shorthand
    'http://127.0.1',             // three-part shorthand
    'http://3232235777',          // decimal 192.168.1.1
    'http://0xc0.0xa8.0x1.0x1',  // per-part hexadecimal 192.168.1.1
    'http://0300.0250.0001.0001', // per-part octal 192.168.1.1
  ];
  for (const target of targets) {
    test(`blocks ${target}`, () => expectBlocked(target, 'private_network'));
  }
});

describe('classifyBrowserAutomationTarget: IPv6 and embedded IPv4', () => {
  const targets = [
    'http://[::]',
    'http://[::1]',
    'http://[0:0:0:0:0:0:0:1]',
    'http://[fc00::1]',
    'http://[fd12:3456::1]',
    'http://[fe80::1]',
    'http://[febf::ffff]',
    'http://[::ffff:127.0.0.1]',
    'http://[::ffff:7f00:1]',
    'http://[::ffff:a9fe:a9fe]',
    'http://[::ffff:0a00:1]',
    'http://[::ffff:c0a8:101]',
    'http://[64:ff9b::a9fe:a9fe]',
    'http://[64:ff9b:1::1]',
    'http://[fec0::1]',
    'http://[feff::ffff]',
    'http://[ff02::1]',
    'http://[ffff::1]',
    'http://[::7f00:1]',
  ];
  for (const target of targets) {
    test(`blocks ${target}`, () => expectBlocked(target, 'private_network'));
  }
});

describe('classifyBrowserAutomationTarget: cloud metadata', () => {
  const targets = [
    'http://169.254.169.254/latest/meta-data/',
    'http://100.100.100.200/latest/meta-data/',
    'http://168.63.129.16/machine/?comp=goalstate',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://METADATA.GOOGLE.INTERNAL./computeMetadata/v1/',
  ];
  for (const target of targets) {
    test(`blocks ${target}`, () => expectBlocked(target, 'cloud_metadata'));
  }

  test('does not turn the exact metadata alias into a broad .internal rule', () => {
    const allowed = [
      'https://service.internal/path',
      'https://metadata.internal/path',
      'https://metadata.google.internal.example.com/path',
      'https://notmetadata.google.internal/path',
    ];
    for (const target of allowed) expect(classifyBrowserAutomationTarget(target).allowed).toBe(true);
  });
});

describe('classifyBrowserAutomationTarget: malformed and non-web targets', () => {
  const invalid = [
    undefined, null, 42, {}, '', '   ', '/relative', 'example.com',
    'http://', 'http://[::1', 'http://999.999.999.999',
  ];
  for (const target of invalid) {
    test(`rejects invalid target ${String(target)}`, () => {
      expect(classifyBrowserAutomationTarget(target)).toEqual({
        allowed: false,
        code: BROWSER_TARGET_CODES.INVALID_URL,
        reason: 'invalid_url',
        stage: 'pre_navigation',
        outcome: 'not_run',
        retryable: false,
        message: 'Browser automation requires an absolute URL.',
        correction: 'Use a full address beginning with http:// or https://.',
      });
    });
  }

  const unsupported = [
    'file:///etc/passwd',
    'data:text/html,hello',
    'blob:https://example.com/id',
    'javascript:alert(1)',
    'chrome://settings',
    'chrome-extension://abcdefghijklmnop/page.html',
    'ws://example.com/socket',
    'wss://example.com/socket',
  ];
  for (const target of unsupported) {
    test(`rejects unsupported target ${target}`, () => {
      expect(classifyBrowserAutomationTarget(target)).toEqual({
        allowed: false,
        code: BROWSER_TARGET_CODES.UNSUPPORTED_SCHEME,
        reason: 'unsupported_scheme',
        stage: 'pre_navigation',
        outcome: 'not_run',
        retryable: false,
        message: 'Browser automation only supports web pages.',
        correction: 'Use a full address beginning with http:// or https://.',
      });
    });
  }
});

describe('classifyBrowserAutomationTarget: public targets remain allowed', () => {
  const targets = [
    'https://example.com',
    'http://api.anthropic.com/path',
    'https://8.8.8.8',
    'http://1.1.1.1',
    'http://11.0.0.1',
    'http://100.63.255.255',
    'http://100.128.0.0',
    'http://126.255.255.255',
    'http://128.0.0.0',
    'http://169.253.255.255',
    'http://169.255.0.0',
    'http://172.15.255.255',
    'http://172.32.0.0',
    'http://198.17.255.255',
    'http://198.20.0.0',
    'http://223.255.255.255',
    'http://[2606:4700:4700::1111]',
    'http://[2001:4860:4860::8888]',
    'http://[64:ff9b::808:808]',
    'http://[::ffff:808:808]',
    'https://mylocalshop.com',
    'https://notlocalhost.com',
    'https://local.example.com',
  ];
  for (const target of targets) {
    test(`allows ${target}`, () => expect(classifyBrowserAutomationTarget(target).allowed).toBe(true));
  }
});
