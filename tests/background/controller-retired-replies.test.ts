import { expect, test } from 'bun:test';
import { bindControllerChannel } from '../../extension/offscreen/controller-shell.js';
import { connectOffscreenController } from '../../extension/background/offscreen-controller-client.js';

const within = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), 1000);
    })]);
  } finally { clearTimeout(timer); }
};

test('in-flight exact reverse reply crossing host settlement does not close another live run', async () => {
  const reverseEntered = Promise.withResolvers<void>();
  const reverseResult = Promise.withResolvers<any>();
  const finishFirst = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  const firstSettledAtHost = Promise.withResolvers<void>();
  let hostClosed = 0;
  let hostClock: number | null = null;
  let secondSignal: AbortSignal | undefined;
  let calls = 0;
  let heldSettlement: any;
  const quota = () => ({
    pendingCap: 8, admit: () => ({ ok: true, outcomeKnown: true }),
    observe: () => ({ ok: true, outcomeKnown: true }),
    pendingLoss: () => ({ outcomeKnown: false, retryable: false }),
    custody: () => ({ outcomeKnown: true, retryable: true }),
  });
  let binding: ReturnType<typeof bindControllerChannel> | undefined;
  const client = await connectOffscreenController({
    ensureOffscreen: async () => {},
    handshakeTimeoutMs: 1000,
    capabilities: ['turn.run'], buildDigest: 'a'.repeat(64),
    authorizeCall: () => ({
      ownerId: 'root:test', sessionId: 'session:test', instanceId: null,
      origin: null, target: null, replayClass: 'E',
    }),
    createQuota: quota,
    handleKernelCall: async () => { reverseEntered.resolve(); return reverseResult.promise; },
    findHost: async () => ({
      postMessage: (offer: any, transfer: Transferable[]) => {
        const port = transfer[0] as MessagePort;
        const send = port.postMessage.bind(port);
        port.postMessage = (message: any) => {
          // Opposite directions have independent queues. Delay only delivery
          // of the terminal host message, not the live SW's reverse reply.
          if (message.type === 'controller/settled') {
            heldSettlement = message;
            firstSettledAtHost.resolve();
          } else send(message);
        };
        binding = bindControllerChannel({
          port, channelId: offer.channelId, buildDigest: offer.buildDigest,
          kernelEpoch: offer.kernelEpoch, hostEpoch: 'host-crossing-result',
          offeredCaps: offer.capabilities, supportedCaps: ['turn.run'],
          createQuota: quota, now: () => hostClock ?? Date.now(),
          onClose: () => { hostClosed += 1; },
          loadController: async () => ({
            call: async (_cap: string, _payload: any, options: any) => {
              if (++calls === 1) {
                void options.kernelCall('turn.session.get', { runId: 'first', value: { sessionId: 'session:test' } });
                await finishFirst.promise;
                hostClock = options.deadlineAt + 1;
                return { ok: true, outcomeKnown: true };
              }
              secondSignal = options.signal;
              secondEntered.resolve();
              return new Promise((resolve) => options.signal.addEventListener('abort', () => {
                resolve({ ok: false, outcomeKnown: false });
              }, { once: true }));
            },
          }),
        });
      },
    }),
  });
  const first = client.call('turn.run', { maxSteps: 1 }, { timeoutMs: 5000 });
  let second: Promise<any> | undefined;
  try {
    await within(reverseEntered.promise, 'first reverse effect');
    second = client.call('turn.run', { maxSteps: 1 }, { timeoutMs: 5000 });
    await within(secondEntered.promise, 'second live turn');
    finishFirst.resolve();
    await within(firstSettledAtHost.promise, 'host settlement');
    expect(heldSettlement.result).toMatchObject({
      code: 'controller-pending-kernel-effect', outcomeKnown: false, retryable: false,
    });
    reverseResult.resolve({ ok: true, outcomeKnown: true, value: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hostClosed).toBe(0);
    expect(secondSignal?.aborted).toBe(false);
  } finally {
    client.close();
    binding?.close();
    finishFirst.resolve();
    reverseResult.resolve({ ok: false, outcomeKnown: false });
    await within(Promise.all([first, second]), 'closed client calls');
  }
});

const fixture = ({ waitForReplies = false, abortCleanup = false } = {}) => {
  const messages: any[] = [];
  let closed = 0;
  let observed = 0;
  let sequence = 0;
  let rpcSequence = 0;
  let rpcCount = 1;
  const port: any = {
    onmessage: null, onmessageerror: null,
    postMessage: (message: any) => { messages.push(message); },
    start: () => {}, close: () => {}, addEventListener: () => {},
  };
  const common = {
    protocol: 2, channelId: 'retired-reply-channel', buildDigest: 'a'.repeat(64),
    kernelEpoch: 'retired-reply-kernel', hostEpoch: 'retired-reply-host',
  };
  const binding = bindControllerChannel({
    port, ...common, offeredCaps: ['turn.run'], supportedCaps: ['turn.run'],
    onClose: () => { closed += 1; },
    newId: () => `retired-rpc-${++rpcSequence}`,
    createQuota: () => ({
      pendingCap: 256, admit: () => ({ ok: true, outcomeKnown: true }),
      observe: () => { observed += 1; return { ok: true, outcomeKnown: true }; },
      pendingLoss: () => ({ outcomeKnown: false, retryable: false }),
      custody: () => ({ outcomeKnown: true, retryable: true }),
    }),
    loadController: async () => ({
      call: async (_cap: string, _payload: any, options: any) => {
        if (abortCleanup) options.signal.addEventListener('abort', () => {
          void options.kernelCall('turn.finalize', {});
        }, { once: true });
        const replies = [];
        for (let index = 0; index < rpcCount; index += 1) {
          replies.push(options.kernelCall('turn.session.get', { index }));
        }
        if (waitForReplies) await Promise.all(replies);
        // Model an abrupt worker completion with reverse RPCs already posted.
        // The host must preserve unknown custody while retiring their replies.
        return { ok: true, outcomeKnown: true };
      },
    }),
  });
  const deliver = (type: string, value: Record<string, any> = {}) =>
    port.onmessage({ data: { ...common, sequence: ++sequence, type, ...value } });
  const start = async (requestId = 'retired-request', grantId = 'retired-grant', count = 1) => {
    rpcCount = count;
    deliver('kernel/open', {
      requestId, grantId, deadlineAt: Date.now() + 5_000, capability: 'turn.run',
      authority: { ownerId: 'root:test', sessionId: 'session:test', instanceId: null,
        origin: null, target: null, replayClass: 'E' },
      payload: { maxSteps: 1 },
    });
    deliver('kernel/commit', { requestId, grantId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return messages.filter((message) => message.type === 'controller/kernel-call'
      && message.requestId === requestId);
  };
  const reply = (call: any, patch: Record<string, any> = {}) => deliver('kernel/kernel-result', {
    requestId: call.requestId, grantId: call.grantId, rpcId: call.rpcId,
    result: { ok: true, outcomeKnown: true }, ...patch,
  });
  return { messages, start, reply, deliver, close: binding.close,
    closed: () => closed, observed: () => observed };
};

test('late pending replies are discarded once, without observing results or changing custody', async () => {
  const host = fixture();
  try {
    const pending = await host.start('two-replies', 'two-grant', 2);
    expect(pending).toHaveLength(2);
    expect(host.messages.at(-1).result).toMatchObject({
      code: 'controller-pending-kernel-effect', outcomeKnown: false, retryable: false,
    });
    host.reply(pending[0]);
    expect(host.closed()).toBe(0);
    host.reply(pending[1]);
    expect(host.closed()).toBe(0);
    expect(host.observed()).toBe(0);
    host.reply(pending[0]);
    expect(host.closed()).toBe(1);
  } finally { host.close(); }
});

test.each(['requestId', 'grantId', 'rpcId'])('a retired reply with a forged %s closes the channel', async (key) => {
  const host = fixture();
  try {
    const pending = await host.start();
    host.reply(pending[0], { [key]: 'forged-identity' });
    expect(host.closed()).toBe(1);
    expect(host.observed()).toBe(0);
  } finally { host.close(); }
});

test('a retired reply still requires the next exact channel sequence', async () => {
  const host = fixture();
  try {
    const pending = await host.start();
    host.reply(pending[0], { sequence: 1 });
    expect(host.closed()).toBe(1);
  } finally { host.close(); }
});

test('a retained request identity cannot be reopened under a new grant', async () => {
  const host = fixture();
  try {
    await host.start('same-request', 'first-grant');
    await host.start('same-request', 'second-grant');
    expect(host.closed()).toBe(1);
  } finally { host.close(); }
});

test('retired request count is bounded without evicting authenticated late identities', async () => {
  const host = fixture();
  try {
    for (let index = 0; index < 65; index += 1) {
      await host.start(`bounded-request-${index}`, `bounded-grant-${index}`);
    }
    expect(host.closed()).toBe(1);
    expect(host.messages.at(-1)).toMatchObject({
      type: 'controller/settled', requestId: 'bounded-request-64',
      result: { outcomeKnown: false, retryable: false },
    });
  } finally { host.close(); }
});

test('retired RPC count is bounded even when only a few request buckets exist', async () => {
  const host = fixture();
  try {
    for (let index = 0; index < 5; index += 1) {
      await host.start(`many-rpcs-${index}`, `many-grant-${index}`, 256);
    }
    expect(host.closed()).toBe(1);
    expect(host.messages.at(-1)).toMatchObject({
      type: 'controller/settled', requestId: 'many-rpcs-4',
      result: { outcomeKnown: false, retryable: false },
    });
  } finally { host.close(); }
});

test('retired identity storage is byte-bounded, not merely entry-bounded', async () => {
  const host = fixture();
  try {
    await host.start('x'.repeat(256 * 1024), 'large-grant');
    expect(host.closed()).toBe(1);
    expect(host.messages.at(-1)).toMatchObject({
      type: 'controller/settled', result: { outcomeKnown: false, retryable: false },
    });
  } finally { host.close(); }
});

test('consumed reply identities release their request capacity', async () => {
  const host = fixture();
  try {
    for (let index = 0; index < 66; index += 1) {
      for (const call of await host.start(`consumed-${index}`, 'grant')) host.reply(call);
    }
    expect(host.closed()).toBe(0);
    expect(host.observed()).toBe(0);
  } finally { host.close(); }
});

test('consumed replies release their RPC capacity across more than 1024 identities', async () => {
  const host = fixture();
  try {
    let consumed = 0;
    for (let index = 0; index < 5; index += 1) {
      const pending = await host.start(`consumed-rpcs-${index}`, 'grant', 256);
      expect(pending).toHaveLength(256);
      for (const call of pending) { host.reply(call); consumed += 1; }
    }
    expect(consumed).toBe(1280);
    expect(host.closed()).toBe(0);
    expect(host.observed()).toBe(0);
  } finally { host.close(); }
});

test('a previously completed RPC is never treated as a retired pending reply', async () => {
  const host = fixture({ waitForReplies: true });
  try {
    const pending = await host.start();
    host.reply(pending[0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.closed()).toBe(0);
    expect(host.observed()).toBe(1);
    host.reply(pending[0]);
    expect(host.closed()).toBe(1);
    expect(host.observed()).toBe(1);
  } finally { host.close(); }
});

test('synchronously posted abort cleanup is included in exact retired identities', async () => {
  const host = fixture({ abortCleanup: true });
  try {
    const pending = await host.start();
    expect(pending.map((call) => call.operation)).toEqual(['turn.session.get', 'turn.finalize']);
    for (const call of pending) host.reply(call);
    expect(host.closed()).toBe(0);
    expect(host.observed()).toBe(0);
  } finally { host.close(); }
});

test('consumed long identities release their storage capacity', async () => {
  const host = fixture();
  try {
    for (let index = 0; index < 4; index += 1) {
      for (const call of await host.start('x'.repeat(64 * 1024) + index, 'grant')) host.reply(call);
    }
    expect(host.closed()).toBe(0);
  } finally { host.close(); }
});
