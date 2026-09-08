import { describe, expect, test } from 'bun:test';
import { makeDwebCustodyHost } from '../../extension/offscreen/dweb-custody-host.js';
import { coldPortNamesFor } from '../../extension/background/cold-kernel-inventory.js';

const event = () => {
  const listeners: Array<(message?: any) => void> = [];
  return {
    addListener: (listener: (message?: any) => void) => { listeners.push(listener); },
    emit: (message?: any) => { for (const listener of listeners) listener(message); },
  };
};

const pair = () => {
  const clientMessage = event();
  const hostMessage = event();
  const clientDisconnect = event();
  const hostDisconnect = event();
  const clientSent: any[] = [];
  const hostSent: any[] = [];
  return {
    client: {
      onMessage: clientMessage,
      onDisconnect: clientDisconnect,
      postMessage: (message: any) => { clientSent.push(message); hostMessage.emit(message); },
    } as any,
    host: {
      onMessage: hostMessage,
      onDisconnect: hostDisconnect,
      postMessage: (message: any) => { hostSent.push(message); clientMessage.emit(message); },
    } as any,
    clientSent,
    hostSent,
  };
};
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));
const waitForPacket = async (sent: any[], requestId: string) => {
  for (let attempt = 0; attempt < 30
    && !sent.some((message) => message.requestId === requestId); attempt += 1) await nextTask();
  return sent.find((message) => message.requestId === requestId);
};

describe('dweb custody receipt host', () => {
  test('retains a completed receipt until acknowledgement and never reruns it', async () => {
    let runs = 0;
    const host = makeDwebCustodyHost({
      authorityId: 'authority:stable', readState: () => ({}),
      runOperation: async () => { runs += 1; return { adopted: true }; },
    });
    const first = pair();
    host.attach(first.host);
    const args = { record: {} };
    first.client.postMessage({
      type: 'custody/request', requestId: 'request:first',
      operationId: 'operation:stable', operation: 'adopt', args,
    });
    expect(await waitForPacket(first.hostSent, 'request:first')).toMatchObject({
      type: 'custody/response', ok: true, result: { adopted: true },
    });

    const second = pair();
    host.attach(second.host);
    second.client.postMessage({
      type: 'custody/status', requestId: 'status:second', operationId: 'query:second',
      operation: 'adopt', args,
    });
    expect(await waitForPacket(second.hostSent, 'status:second')).toMatchObject({
      type: 'custody/status-response', receipt: {
        state: 'succeeded', result: { adopted: true },
      },
    });
    second.client.postMessage({
      type: 'custody/request', requestId: 'request:second',
      operationId: 'operation:stable', operation: 'adopt', args,
    });
    await waitForPacket(second.hostSent, 'request:second');
    expect(runs).toBe(1);
    second.client.postMessage({ type: 'custody/ack', operationId: 'operation:stable' });
    second.client.postMessage({
      type: 'custody/status', requestId: 'status:missing', operationId: 'query:missing',
      operation: 'adopt', args,
    });
    expect((await waitForPacket(second.hostSent, 'status:missing'))?.receipt)
      .toEqual({ state: 'missing' });
  });

  test('binds an operation id to exact arguments', async () => {
    const host = makeDwebCustodyHost({
      authorityId: 'authority:args', readState: () => ({}),
      runOperation: async () => ({ ok: true }),
    });
    const ports = pair();
    host.attach(ports.host);
    ports.client.postMessage({
      type: 'custody/request', requestId: 'request:one',
      operationId: 'operation:one', operation: 'prepare', args: { passphrase: 'one' },
    });
    await waitForPacket(ports.hostSent, 'request:one');
    ports.client.postMessage({
      type: 'custody/request', requestId: 'request:two',
      operationId: 'operation:one', operation: 'prepare', args: { passphrase: 'two' },
    });
    expect(await waitForPacket(ports.hostSent, 'request:two')).toMatchObject({
      ok: false, error: 'operation-id-conflict',
    });
  });

  test('preserves unknown effect custody in the final receipt', async () => {
    const host = makeDwebCustodyHost({
      authorityId: 'authority:unknown', readState: () => ({}),
      runOperation: async () => {
        throw Object.assign(new Error('identity-store-outcome-unknown'), {
          code: 'identity-store-outcome-unknown', outcomeKnown: false,
        });
      },
    });
    const ports = pair();
    host.attach(ports.host);
    ports.client.postMessage({
      type: 'custody/request', requestId: 'request:unknown',
      operationId: 'operation:unknown', operation: 'adopt', args: {},
    });
    expect(await waitForPacket(ports.hostSent, 'request:unknown')).toMatchObject({
      ok: false, error: 'identity-store-outcome-unknown', outcomeKnown: false,
    });
  });

  test('dweb custody remains Preview-only in the native Port inventory', () => {
    expect(coldPortNamesFor()).not.toContain('dweb-custody');
    expect(coldPortNamesFor({ firefox: true })).not.toContain('dweb-custody');
    expect(coldPortNamesFor({ dweb: true })).toContain('dweb-custody');
  });
});
