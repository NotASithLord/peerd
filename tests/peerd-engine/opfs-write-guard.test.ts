import { describe, test, expect } from 'bun:test';
import { opfsHelpers } from '../../extension/peerd-engine/opfs.js';

const notFound = () => {
  const error = new Error('missing');
  error.name = 'NotFoundError';
  return error;
};

describe('OPFS open and mutation posture', () => {
  test('read opens every root component without creating it', async () => {
    const opens: Array<{ part: string, create: boolean | undefined }> = [];
    const file = { getFile: async () => ({ text: async () => 'kept' }) };
    const leaf = { getFileHandle: async () => file };
    const child = {
      getDirectoryHandle: async (part: string, options: { create?: boolean }) => {
        opens.push({ part, create: options.create });
        return leaf;
      },
    };
    const root = {
      getDirectoryHandle: async (part: string, options: { create?: boolean }) => {
        opens.push({ part, create: options.create });
        return child;
      },
    };
    let mutationChecks = 0;
    const opfs = opfsHelpers(['peerd-notebooks', 'nb-1'], {
      getDirectory: async () => root as any,
      beforeMutation: () => { mutationChecks += 1; },
    });
    await expect(opfs.read('notebook.js')).resolves.toBe('kept');
    expect(opens).toEqual([
      { part: 'peerd-notebooks', create: false },
      { part: 'nb-1', create: false },
    ]);
    expect(mutationChecks).toBe(0);
  });

  test('list of a missing root stays readable and does not create it', async () => {
    const creates: boolean[] = [];
    const root = {
      getDirectoryHandle: async (_part: string, options: { create?: boolean }) => {
        creates.push(options.create === true);
        throw notFound();
      },
    };
    const opfs = opfsHelpers(['peerd-workspace', 'chat-1'], {
      getDirectory: async () => root as any,
      beforeMutation: () => { throw new Error('read called the mutation gate'); },
    });
    await expect(opfs.list()).resolves.toEqual([]);
    await expect(opfs.listDir('/')).resolves.toEqual([]);
    await expect(opfs.stat('/')).resolves.toEqual({ path: '/', kind: 'directory', size: 0 });
    await expect(opfs.exists('/')).resolves.toBe(true);
    expect(creates).toEqual([false, false]);
  });

  test('a blocked posture stops every mutation before touching OPFS', async () => {
    let rootReads = 0;
    const blocked = new Error(
      "store 'opfs-workspaces' is read-only. No data was changed.",
    );
    const opfs = opfsHelpers(['peerd-workspace', 'chat-1'], {
      getDirectory: async () => {
        rootReads += 1;
        return {} as any;
      },
      beforeMutation: () => { throw blocked; },
    });
    await expect(opfs.write('x.txt', 'x')).rejects.toBe(blocked);
    await expect(opfs.delete('x.txt')).rejects.toBe(blocked);
    await expect(opfs.mkdir('dir')).rejects.toBe(blocked);
    await expect(opfs.remove('dir', { recursive: true })).rejects.toBe(blocked);
    await expect(opfs.copy('x.txt', 'copy.txt')).rejects.toBe(blocked);
    await expect(opfs.move('x.txt', 'moved.txt')).rejects.toBe(blocked);
    await expect(opfs.nuke()).rejects.toBe(blocked);
    expect(rootReads).toBe(0);
  });

  test('rejects traversal and invalid mounted roots before OPFS lookup', async () => {
    let rootReads = 0;
    const opfs = opfsHelpers(['peerd-pods', 'pod-1'], {
      getDirectory: async () => {
        rootReads += 1;
        return {} as any;
      },
    });
    await expect(opfs.read('../secret')).rejects.toThrow('unsafe path');
    await expect(opfs.stat('dir\\secret')).rejects.toThrow('invalid path');
    expect(() => opfsHelpers([])).toThrow('invalid root path');
    expect(rootReads).toBe(0);
  });
});
