import { describe, expect, test } from 'bun:test';
import {
  executePodShell,
  matchPodGrep,
  parsePodShell,
  podGitRemoteIntents,
  podGitRemoteOperation,
  PodShellSyntaxError,
  tokenizePodShell,
} from '../../extension/peerd-engine/pod-shell.js';

const harness = () => {
  const files = new Map<string, string>();
  const calls: Array<{ argv: string[]; stdin: string; cwd: string; env: Record<string, string> }> = [];
  const runCommand = async (input: { argv: string[]; stdin: string; cwd: string; env: Record<string, string> }) => {
    calls.push(input);
    const [name, ...args] = input.argv;
    if (name === 'echo') return { stdout: `${args.join(' ')}\n`, stderr: '', exitCode: 0 };
    if (name === 'cat') return { stdout: input.stdin, stderr: '', exitCode: 0 };
    if (name === 'upper') return { stdout: input.stdin.toUpperCase(), stderr: '', exitCode: 0 };
    if (name === 'fail') return { stdout: '', stderr: 'failed\n', exitCode: 7 };
    if (name === 'cd') return { stdout: '', stderr: '', exitCode: 0, cwd: args[0] };
    if (name === 'export') {
      const [key, value] = (args[0] ?? '').split('=');
      return { stdout: '', stderr: '', exitCode: 0, env: { [key]: value } };
    }
    return { stdout: '', stderr: `${name}: missing\n`, exitCode: 127 };
  };
  return {
    files,
    calls,
    ctx: {
      cwd: '/', env: { HOME: '/home/pod' }, runCommand,
      readText: async (path: string) => files.get(path) ?? '',
      writeText: async (path: string, content: string, { append }: { append: boolean }) => {
        files.set(path, append ? `${files.get(path) ?? ''}${content}` : content);
      },
    },
  };
};

describe('Pod shell syntax', () => {
  test('tokenizes quotes, escapes, comments, and operators without losing quote origin', () => {
    const tokens = tokenizePodShell(`echo "hello $NAME" '$NAME' one\\ two | cat # ignored`);
    expect(tokens.map((token) => token.type === 'op' ? token.value : token.segments.map((part) => part.text).join('')))
      .toEqual(['echo', 'hello $NAME', '$NAME', 'one two', '|', 'cat']);
  });

  test('parses pipelines, redirects, conditions, and a trailing background marker', () => {
    const parsed = parsePodShell('echo hi | cat > out && echo ok 2>> err &');
    expect(parsed.background).toBe(true);
    expect(parsed.pipelines).toHaveLength(2);
    expect(parsed.pipelines[0].commands).toHaveLength(2);
    expect(parsed.pipelines[1].connector).toBe('and');
    expect(parsed.pipelines[1].commands[0].redirections.stderrAppend).toBe(true);
  });

  test('rejects unsupported/malformed structures loudly', () => {
    expect(() => parsePodShell('echo hi |')).toThrow(PodShellSyntaxError);
    expect(() => parsePodShell('echo "oops')).toThrow('unterminated double quote');
    expect(() => parsePodShell('echo hi & echo no')).toThrow('only at the end');
  });
});

describe('Pod shell execution', () => {
  test('pipes stdout into stdin and keeps stderr separate', async () => {
    const h = harness();
    const result = await executePodShell('echo hello | upper', h.ctx);
    expect(result).toMatchObject({ stdout: 'HELLO\n', stderr: '', exitCode: 0 });
    expect(h.calls[1].stdin).toBe('hello\n');
  });

  test('redirection writes and appends through the injected filesystem only', async () => {
    const h = harness();
    const result = await executePodShell('echo one > notes.txt; echo two >> notes.txt; cat < notes.txt', h.ctx);
    expect(result.stdout).toBe('one\ntwo\n');
    expect(h.files.get('notes.txt')).toBe('one\ntwo\n');
  });

  test('propagates cwd/environment and honors &&/|| exit codes', async () => {
    const h = harness();
    const result = await executePodShell('export NAME=pod; cd /work; fail && echo no || echo "$NAME:$?"', h.ctx);
    expect(result.stdout).toBe('pod:7\n');
    expect(result.stderr).toBe('failed\n');
    expect(result.cwd).toBe('/work');
    expect(result.env?.NAME).toBe('pod');
    expect(result.exitCode).toBe(0);
  });

  test('a thrown command becomes stderr + exit 1 instead of escaping the job', async () => {
    const h = harness();
    h.ctx.runCommand = async () => { throw new Error('boom'); };
    expect(await executePodShell('anything', h.ctx)).toMatchObject({ stdout: '', stderr: 'boom\n', exitCode: 1 });
  });

  test('bounds pipeline and accumulated output incrementally', async () => {
    const h = harness();
    h.ctx.runCommand = async () => ({ stdout: 'x'.repeat(100), stderr: 'e'.repeat(100), exitCode: 0 });
    const result = await executePodShell('one; two', { ...h.ctx, maxOutputChars: 50 });
    expect(result.stdout).toHaveLength(50);
    expect(result.stderr).toHaveLength(50);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
  });

  test('does not use the display cap as the input cap for downstream stages', async () => {
    const h = harness();
    h.ctx.runCommand = async ({ argv, stdin }) => argv[0] === 'produce'
      ? { stdout: 'abcdefghij', stderr: '', exitCode: 0 }
      : { stdout: `${stdin.length}\n`, stderr: '', exitCode: 0 };
    const result = await executePodShell('produce | count', { ...h.ctx, maxOutputChars: 4 });
    expect(result.stdout).toBe('10\n');
    expect(result.stdoutTruncated).toBe(false);
  });

  test('fails a pipeline stage explicitly at its independent safety cap', async () => {
    const h = harness();
    let calls = 0;
    h.ctx.runCommand = async () => { calls += 1; return { stdout: 'abcdefghij', stderr: '', exitCode: 0 }; };
    const result = await executePodShell('produce | count', { ...h.ctx, maxOutputChars: 200, maxPipelineChars: 5 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('pipeline stage exceeded 5 characters');
    expect(calls).toBe(1);
  });
});

describe('Pod grep matching', () => {
  test('uses regex by default, literal matching only with the fixed flag', () => {
    expect(matchPodGrep('alpha\na.b\nacb', 'a.b')).toEqual(['a.b', 'acb']);
    expect(matchPodGrep('alpha\na.b\nacb', 'a.b', { fixed: true })).toEqual(['a.b']);
  });

  test('invalid regular expressions fail instead of silently becoming literals', () => {
    expect(() => matchPodGrep('value [', '[')).toThrow('invalid regular expression');
  });
});

describe('remote Git authority detection', () => {
  test('recognizes only executable literal remote Git commands', () => {
    expect(podGitRemoteIntents('git clone https://github.com/peerd/example.git')).toEqual([{ op: 'clone', url: 'https://github.com/peerd/example.git' }]);
    expect(podGitRemoteIntents('echo ready && git push origin main')).toEqual([{ op: 'push', url: null }]);
    expect(podGitRemoteIntents('git remote set-url origin https://gitlab.com/a/b.git')).toEqual([{ op: 'link', url: 'https://gitlab.com/a/b.git' }]);
    expect(podGitRemoteIntents('echo "git push"')).toEqual([]);
  });

  test('variable-expanded commands never mint remote authority', () => {
    expect(podGitRemoteIntents('$COMMAND push origin main')).toEqual([]);
    expect(podGitRemoteIntents('git $OP origin main')).toEqual([]);
  });

  test('enumerates every remote operation in a compound command', () => {
    expect(podGitRemoteIntents('git fetch; git push origin main')).toEqual([
      { op: 'fetch', url: null },
      { op: 'push', url: null },
    ]);
    expect(podGitRemoteIntents('git remote add origin https://example.com/a/b; git push')).toEqual([
      { op: 'link', url: 'https://example.com/a/b' },
      { op: 'push', url: null },
    ]);
  });

  test('classifies a concrete Git argv for host-side grant enforcement', () => {
    expect(podGitRemoteOperation(['push', 'origin', 'main'])).toBe('push');
    expect(podGitRemoteOperation(['remote', 'set-url', 'origin', 'https://example.com/a'])).toBe('link');
    expect(podGitRemoteOperation(['status'])).toBeNull();
  });
});
