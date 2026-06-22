import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

// Regression guard. The CheerpX kernel DENIES writes to /dev/null, and in
// bash a FAILED redirection makes the command not run at all — so any
// `cmd 2>/dev/null` (or `>/dev/null`, `&>/dev/null`) inside the VM bash
// wrappers silently breaks that command's step. This bit `git clone`
// (peerd-fetch/mkdir/unzip all "failed"). Keep the VM wrapper source free
// of write-redirects to /dev/null forever; use `2>>/tmp/...err` instead.
describe('vm-tab bash wrappers', () => {
  test('never write-redirect to /dev/null (CheerpX denies it)', () => {
    const src = readFileSync('extension/vm-tab/vm-tab.js', 'utf8');
    const offenders = src
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      // `>/dev/null` covers 2>/dev/null, &>/dev/null, >/dev/null. A read
      // redirect `</dev/null` is fine and won't match.
      .filter(({ line }) => /> ?\/dev\/null/.test(line))
      .map(({ line, n }) => `${n}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });

  // CheerpX has no utimes() syscall, so `unzip` exits non-zero on every
  // file even when extraction fully succeeds. Gating clone success on its
  // exit code (`if unzip ...; then`) is therefore ALWAYS false. Judge by
  // whether files appeared instead.
  test('git clone does not gate on unzip exit code', () => {
    const src = readFileSync('extension/vm-tab/vm-tab.js', 'utf8');
    expect(src).not.toMatch(/if\s+unzip\b/);
  });
});
