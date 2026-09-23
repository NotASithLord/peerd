import { describe, expect, test } from 'bun:test';
import { recordNetworkFloorVector } from '../../scripts/cdp/network-floor-oracle.mjs';

const record = (vector: string, observed: { attempted: boolean; connections: number; requests: string[] }) => {
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  recordNetworkFloorVector({ check: (name, pass, detail) => { checks.push({ name, pass, detail }); } }, vector, observed);
  return checks;
};

describe('Chrome private-network floor evidence', () => {
  test.each([0, 1, 3])('location reports %i TCP connections without claiming zero transport', (connections) => {
    const checks = record('location', { attempted: true, connections, requests: [] });
    expect(checks.every((check) => check.pass)).toBe(true);
    expect(checks[1]?.name).toBe('location sends no private HTTP request');
    expect(JSON.parse(checks[1]!.detail)).toMatchObject({
      connections, mode: connections ? 'connected-without-request' : 'blocked-before-connect',
    });
  });

  test('location still fails if an HTTP request reaches the private listener', () => {
    const checks = record('location', { attempted: true, connections: 1, requests: ['/probe'] });
    expect(checks[1]?.pass).toBe(false);
    expect(JSON.parse(checks[1]!.detail).mode).toBe('http-request-observed');
  });

  test.each(['location', 'fetch', 'websocket', 'image', 'form', 'redirect', 'meta', 'script', 'popup', 'cross-frame-popup', 'cross-frame-blank'])('%s requires proof that its probe ran', (vector) => {
    expect(record(vector, { attempted: false, connections: 0, requests: [] })[0]?.pass).toBe(false);
  });

  test.each(['fetch', 'websocket', 'image', 'form', 'redirect', 'meta', 'script', 'popup', 'cross-frame-popup', 'cross-frame-blank'])('%s retains both zero-TCP and zero-HTTP assertions', (vector) => {
    expect(record(vector, { attempted: true, connections: 0, requests: [] })[1]?.pass).toBe(true);
    expect(record(vector, { attempted: true, connections: 1, requests: [] })[1]?.pass).toBe(false);
    expect(record(vector, { attempted: true, connections: 0, requests: ['/probe'] })[1]?.pass).toBe(false);
  });
});
