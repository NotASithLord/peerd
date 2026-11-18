import { describe, expect, test } from 'bun:test';
import { gameCsp, gameStartScript, passesToNetwork } from '../../../extension/engine-tabs/game-tab/game-network.js';

const origin = 'https://app-game.localhost';
const request = (patch: Partial<Parameters<typeof passesToNetwork>[0]> = {}) => ({
  url: 'https://rendezvous.example/x', resourceType: 'Fetch', origin, networkAllowed: true, ...patch,
});

// The game host sends one of two policies. The switch in the Library selects it.
describe('game CSP', () => {
  test('off: the page reaches only its own files and cannot use WebRTC', () => {
    const csp = gameCsp(false);
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("webrtc 'block'");
    expect(csp).not.toContain('https:');
    expect(csp).not.toContain('wss:');
  });

  test('on: the page reaches https: and wss: hosts and can use WebRTC', () => {
    const csp = gameCsp(true);
    expect(csp).toContain("connect-src 'self' https: wss:;");
    expect(csp).toContain("webrtc 'allow'");
    expect(csp).not.toContain("webrtc 'block'");
  });

  test('neither policy opens the plain http: or ws: schemes', () => {
    for (const csp of [gameCsp(false), gameCsp(true)]) {
      expect(csp).not.toContain(' http:');
      expect(csp).not.toContain(' ws:');
    }
  });

  test('the two policies differ only in connect-src and webrtc', () => {
    const directives = (csp: string) => csp.split('; ');
    const off = directives(gameCsp(false));
    const on = directives(gameCsp(true));
    expect(on.length).toBe(off.length);
    const changed = off.filter((directive, index) => directive !== on[index]).map(directive => directive.split(' ')[0]);
    expect(changed).toEqual(['connect-src', 'webrtc']);
  });

  test('a value that is not true gives the closed policy', () => {
    expect(gameCsp('yes' as unknown as boolean)).toBe(gameCsp(false));
  });
});

// Chromium does not apply the webrtc directive to the game page. The host runs this script instead.
// The host also cannot check the requests of a shared worker, so the script removes SharedWorker in both states.
describe('game start script', () => {
  const run = (networkAllowed: boolean) => {
    const scope: Record<string, unknown> = { RTCPeerConnection: class {}, webkitRTCPeerConnection: class {}, SharedWorker: class {}, Worker: class {} };
    new Function('globalThis', gameStartScript(networkAllowed))(scope);
    return scope;
  };
  const sealed = (scope: Record<string, unknown>, name: string) => {
    expect(scope[name]).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(scope, name)).toEqual({ value: undefined, writable: false, enumerable: true, configurable: false });
    expect(() => Object.defineProperty(scope, name, { value: class {} })).toThrow();
  };

  test('off: the script removes SharedWorker and both WebRTC constructors, and game code cannot put them back', () => {
    const scope = run(false);
    for (const name of ['SharedWorker', 'RTCPeerConnection', 'webkitRTCPeerConnection']) sealed(scope, name);
    expect(typeof scope.Worker).toBe('function');
  });

  test('on: the script removes SharedWorker only, so WebRTC stays', () => {
    const scope = run(true);
    sealed(scope, 'SharedWorker');
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'Worker']) expect(typeof scope[name]).toBe('function');
  });

  test('a value that is not true gives the off script', () => {
    expect(gameStartScript('yes' as unknown as boolean)).toBe(gameStartScript(false));
  });
});

describe('game request pass-through', () => {
  test('a public https request passes for each data request type when the switch is on', () => {
    for (const resourceType of ['XHR', 'Fetch', 'EventSource', 'Preflight']) {
      expect(passesToNetwork(request({ resourceType }))).toBe(true);
    }
  });

  test('nothing passes when the switch is off', () => {
    for (const resourceType of ['XHR', 'Fetch', 'EventSource', 'Preflight', 'Document']) {
      expect(passesToNetwork(request({ resourceType, networkAllowed: false }))).toBe(false);
    }
    expect(passesToNetwork(request({ networkAllowed: 'yes' as unknown as boolean }))).toBe(false);
  });

  test('a request for the game origin stays local', () => {
    expect(passesToNetwork(request({ url: `${origin}/data.bin` }))).toBe(false);
  });

  test('a navigation or a subresource never passes', () => {
    for (const resourceType of ['Document', 'Script', 'Image', 'Media', 'Stylesheet', 'Font', 'WebSocket', 'Other', '']) {
      expect(passesToNetwork(request({ resourceType }))).toBe(false);
    }
  });

  test('only the https: scheme passes', () => {
    for (const url of [
      'http://rendezvous.example/x', 'ws://rendezvous.example/x', 'wss://rendezvous.example/x',
      'data:text/plain,x', 'blob:https://rendezvous.example/1', 'chrome-extension://abcdefghijklmnop/x',
    ]) expect(passesToNetwork(request({ url }))).toBe(false);
  });

  test('a URL with credentials does not pass', () => {
    expect(passesToNetwork(request({ url: 'https://user:secret@rendezvous.example/x' }))).toBe(false);
    expect(passesToNetwork(request({ url: 'https://user@rendezvous.example/x' }))).toBe(false);
  });

  test('a local, private or metadata host does not pass', () => {
    for (const host of [
      'localhost', 'other-app.localhost', 'printer.local', '127.0.0.1', '10.0.0.5', '192.168.1.1',
      '169.254.169.254', '[::1]', 'metadata.google.internal', '2130706433', '0x7f000001', '0x7f.0.0.1',
    ]) expect(passesToNetwork(request({ url: `https://${host}/x` }))).toBe(false);
  });

  test('a URL that does not parse does not pass', () => {
    for (const url of ['', 'not a url', 'https://', '//rendezvous.example/x']) {
      expect(passesToNetwork(request({ url }))).toBe(false);
    }
  });
});
