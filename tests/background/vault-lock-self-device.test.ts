import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

test('vault lock settles self-device startup when its peer closes during HELLO', async () => {
  // Isolate only the browser loader/transport fixture: the child executes real
  // vault routes, self host, coordinator, mesh, room, and HELLO lifecycle code.
  const child = Bun.spawn([
    process.execPath, '--preload', './tests/setup.ts',
    fileURLToPath(new URL('./fixtures/vault-lock-self-device.ts', import.meta.url)),
  ], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
  });
  // Cover failures before either fixture barrier, too; always reap the child.
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 8_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    const line = stdout.split('\n').find((value) => value.startsWith('SELF_LOCK_RESULT:'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice('SELF_LOCK_RESULT:'.length))).toMatchObject({
      authorityLocked: true,
      startSettled: true,
      lockSettled: true,
      startResult: { running: false, reason: 'start-cancelled' },
    });
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
  }
}, 15_000);
