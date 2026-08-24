import { describe, expect, test } from 'bun:test';
import { makeDwebCustodyHost } from '../../extension/offscreen/dweb-custody-host.js';

const port = () => {
  const listeners: Array<(message: any) => void> = [];
  const sent: any[] = [];
  return {
    value: {
      onMessage: { addListener: (listener: (message: any) => void) => listeners.push(listener) },
      postMessage: (message: any) => { sent.push(message); },
    } as any,
    receive: (message: any) => listeners.forEach((listener) => listener(message)),
    sent,
  };
};

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('dweb custody receipt host', () => {
  test('keeps a terminal receipt across Port replacement and acknowledges it once claimed', async () => {
    let release = (value: any) => {};
    let runs = 0;
    const host = makeDwebCustodyHost({
      authorityId: 'authority:receipt',
      readState: () => ({ suspensionOwner: null }),
      runOperation: async () => {
        runs += 1;
        return new Promise((resolve) => { release = resolve; });
      },
    });
    const first = port();
    host.attach(first.value);
    first.receive({
      type: 'custody/request', requestId: 'request:first',
      operationId: 'operation:one', operation: 'reset', args: {},
    });
    await nextTask();
    release({ reset: true });
    await nextTask();

    const successor = port();
    host.attach(successor.value);
    successor.receive({
      type: 'custody/status', requestId: 'status:first', operationId: 'operation:one',
    });
    expect(successor.sent.at(-1)).toMatchObject({
      type: 'custody/status-response', authorityId: 'authority:receipt',
      receipt: { state: 'succeeded', result: { reset: true } },
    });
    successor.receive({
      type: 'custody/request', requestId: 'request:duplicate',
      operationId: 'operation:one', operation: 'reset', args: {},
    });
    await nextTask();
    expect(successor.sent.at(-1)).toMatchObject({
      type: 'custody/response', requestId: 'request:duplicate', ok: true,
      result: { reset: true },
    });
    expect(runs).toBe(1);

    successor.receive({ type: 'custody/ack', operationId: 'operation:one' });
    successor.receive({
      type: 'custody/status', requestId: 'status:after-ack', operationId: 'operation:one',
    });
    expect(successor.sent.at(-1)).toMatchObject({ receipt: { state: 'missing' } });
  });

  test('an operation id cannot be reused for a different operation', async () => {
    let runs = 0;
    const order: string[] = [];
    const host = makeDwebCustodyHost({
      authorityId: 'authority:conflict',
      readState: () => { order.push('read'); return { suspensionOwner: null }; },
      runOperation: async () => { order.push('run'); runs += 1; return { reset: true }; },
    });
    const connected = port();
    host.attach(connected.value);
    connected.receive({
      type: 'custody/request', requestId: 'request:reset',
      operationId: 'operation:shared', operation: 'reset', args: {},
    });
    await nextTask();
    connected.receive({
      type: 'custody/request', requestId: 'request:adopt',
      operationId: 'operation:shared', operation: 'adopt', args: {},
    });
    expect(connected.sent.at(-1)).toMatchObject({
      type: 'custody/response', requestId: 'request:adopt',
      ok: false, error: 'operation-id-conflict',
    });
    expect(runs).toBe(1);
    expect(order).toEqual(['read', 'run']);
  });
});
