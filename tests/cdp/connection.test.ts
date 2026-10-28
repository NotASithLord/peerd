import { expect, test } from 'bun:test';
import { attach, CDPSessionDetachedError } from '../../scripts/cdp/e2e-harness.mjs';

const fixture = () => {
  const commands: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response('Upgrade required', { status: 426 });
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw));
        commands.push(message.method);
        if (message.method === 'close') socket.close();
        else if (message.method === 'detach') {
          socket.send(JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: 'retired-worker' } }));
          socket.send(JSON.stringify({ id: message.id, result: {} }));
        }
        else if (message.method === 'ok') socket.send(JSON.stringify({ id: message.id, result: { accepted: true } }));
        else if (message.method === 'refuse') socket.send(JSON.stringify({ id: message.id, error: { message: 'refused' } }));
        else if (message.method === 'forged-detach') socket.send(JSON.stringify({ id: message.id,
          error: { name: 'CDPSessionDetachedError', sessionId: 'retired-worker', message: 'CDP session detached; outcome unknown' } }));
      },
    },
  });
  return { url: `ws://127.0.0.1:${server.port}`, commands, close: () => server.stop(true) };
};

test('CDP correlates success and protocol refusal without retrying', async () => {
  const server = fixture();
  const connection = await attach(server.url, undefined, { commandTimeoutMs: 1000 });
  try {
    expect(await connection.send('ok')).toEqual({ accepted: true });
    await expect(connection.send('refuse')).rejects.toThrow('refuse: refused');
    const forged = await connection.send('forged-detach').catch(error => error);
    expect(forged).toBeInstanceOf(Error);
    expect(forged).not.toBeInstanceOf(CDPSessionDetachedError);
    expect(server.commands).toEqual(['ok', 'refuse', 'forged-detach']);
  } finally { connection.close(); server.close(); }
});

test('lost CDP response retires the connection and never replays the command', async () => {
  const server = fixture();
  const connection = await attach(server.url, undefined, { commandTimeoutMs: 100 });
  try {
    await expect(connection.send('Page.captureScreenshot')).rejects.toThrow('outcome unknown');
    await expect(connection.send('ok')).rejects.toThrow('CDP command Page.captureScreenshot timed out; outcome unknown');
    expect(server.commands).toEqual(['Page.captureScreenshot']);
  } finally { connection.close(); server.close(); }
});

test('socket closure rejects pending commands instead of leaving unresolved promises', async () => {
  const server = fixture();
  const connection = await attach(server.url, undefined, { commandTimeoutMs: 1000 });
  try {
    const outcomes = await Promise.allSettled([connection.send('pending'), connection.send('close')]);
    expect(outcomes.map(result => result.status)).toEqual(['rejected', 'rejected']);
    for (const result of outcomes) {
      if (result.status === 'rejected') expect(String(result.reason)).toContain('CDP connection closed');
    }
    expect(server.commands).toEqual(['pending', 'close']);
  } finally { connection.close(); server.close(); }
});


test('native child detach rejects only its pending commands and preserves the browser connection', async () => {
  const server = fixture();
  const connection = await attach(server.url, undefined, { commandTimeoutMs: 100 });
  try {
    const retired = connection.send('Runtime.enable', {}, 'retired-worker').then(
      () => 'unexpected success', error => error);
    const live = connection.send('ok', {}, 'live-worker');
    await connection.send('detach');
    expect(await retired).toBeInstanceOf(CDPSessionDetachedError);
    expect(await retired).toMatchObject({ sessionId: 'retired-worker' });
    expect(await live).toEqual({ accepted: true });
    await expect(connection.send('Runtime.enable', {}, 'retired-worker'))
      .rejects.toThrow('CDP session detached; outcome unknown');
    // Cross the orphan command's original deadline: it must have been cleared.
    await Bun.sleep(150);
    expect(await connection.send('ok')).toEqual({ accepted: true });
    expect(server.commands).toEqual(['Runtime.enable', 'ok', 'detach', 'ok']);
  } finally { connection.close(); server.close(); }
});
