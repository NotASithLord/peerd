// @ts-check
// Real-browser proof that Pods reuse one rooted OPFS stack: durable reopen,
// directory operations, and per-instance confinement all exercise the same
// helper the trusted Pod host exposes to command Workers over RPC.

import { describe, it, expect } from '../../framework.js';
import { opfsHelpers, POD_OPFS_ROOT } from '/peerd-engine/index.js';

const POD_A = [POD_OPFS_ROOT, 'pod-browser-test-a'];
const POD_B = [POD_OPFS_ROOT, 'pod-browser-test-b'];

describe('Pod OPFS workspace', () => {
  it('persists across fresh mounts and supports shell-style file operations', async () => {
    await opfsHelpers(POD_A).nuke();
    const first = opfsHelpers(POD_A);
    await first.mkdir('src/nested', { recursive: true });
    await first.write('src/nested/a.txt', 'alpha');
    await first.copy('src/nested/a.txt', 'src/b.txt');
    await first.move('src/b.txt', 'moved.txt');

    const reopened = opfsHelpers(POD_A);
    expect(await reopened.read('moved.txt')).toBe('alpha');
    expect((await reopened.list()).map((entry) => entry.path).sort())
      .toEqual(['/moved.txt', '/src/nested/a.txt']);
    expect((await reopened.listDir('src')).map((entry) => `${entry.kind}:${entry.name}`))
      .toEqual(['directory:nested']);
    let recursiveCopyRefused = false;
    try { await reopened.copy('src', 'src/recursive-copy', { recursive: true }); }
    catch { recursiveCopyRefused = true; }
    expect(recursiveCopyRefused).toBe(true);
    let rootCopyRefused = false;
    try { await reopened.copy('/', 'backup', { recursive: true }); }
    catch { rootCopyRefused = true; }
    expect(rootCopyRefused).toBe(true);

    await reopened.remove('src', { recursive: true });
    expect(await reopened.exists('src/nested/a.txt')).toBe(false);
    await reopened.nuke();
  });

  it('one Pod cannot traverse into or observe a sibling workspace', async () => {
    await Promise.all([opfsHelpers(POD_A).nuke(), opfsHelpers(POD_B).nuke()]);
    await opfsHelpers(POD_B).write('secret.txt', 'sibling');
    const a = opfsHelpers(POD_A);
    await a.write('own.txt', 'own');
    expect(await a.exists('secret.txt')).toBe(false);
    let refused = false;
    try { await a.read('../pod-browser-test-b/secret.txt'); }
    catch { refused = true; }
    expect(refused).toBe(true);
    await Promise.all([a.nuke(), opfsHelpers(POD_B).nuke()]);
  });
});
