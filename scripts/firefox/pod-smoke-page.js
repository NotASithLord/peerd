// @ts-check
// Loaded only by run-pod-smoke.mjs's disposable staged extension. It drives the
// real Pod tab in Firefox, reloads it once, and reports evidence to the local
// harness. This file is never included in a release artifact.

const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
const reportUrl = params.get('report');
const stageKey = 'peerd-pod-firefox-smoke-stage';

const waitFor = async (probe, budgetMs = 20_000) => {
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Firefox Pod smoke timed out');
};

const runTerminal = async (command, budgetMs = 20_000) => {
  const output = /** @type {HTMLElement} */ (document.getElementById('terminal-output'));
  const before = output.children.length;
  const input = /** @type {HTMLInputElement} */ (document.getElementById('terminal-input'));
  input.value = command;
  /** @type {HTMLFormElement} */ (document.getElementById('terminal-form')).requestSubmit();
  return waitFor(() => {
    const nodes = [...output.children].slice(before);
    return nodes.some((node) => node.classList.contains('entry-meta'))
      ? nodes.map((node) => node.textContent ?? '').join('') : '';
  }, budgetMs);
};

const report = async (payload) => {
  if (!reportUrl) throw new Error('Firefox smoke report URL missing');
  // Harness-only: this disposable trusted page reports to the loopback origin
  // injected into its temporary CSP. It is not Pod code or shipped code.
  // eslint-disable-next-line no-restricted-globals
  await fetch(reportUrl, { method: 'POST', body: JSON.stringify(payload) });
};

const phase = async (name) => {
  if (!reportUrl) return;
  // Harness-only loopback diagnostic; see report().
  // eslint-disable-next-line no-restricted-globals
  await fetch(reportUrl.replace('/pod-report', '/pod-phase'), { method: 'POST', body: name }).catch(() => {});
};

const main = async () => {
  await phase('pod-script-started');
  await waitFor(() => document.querySelector('#pod-app:not([hidden])'));
  await phase('pod-ready');
  const ready = document.getElementById('terminal-output')?.textContent ?? '';
  const bootMs = Number(ready.match(/ready in (\d+)ms/i)?.[1] ?? NaN);
  if (sessionStorage.getItem(stageKey) === 'reopen') {
    sessionStorage.removeItem(stageKey);
    const first = JSON.parse(sessionStorage.getItem(`${stageKey}-first`) ?? '{}');
    sessionStorage.removeItem(`${stageKey}-first`);
    const persistent = await runTerminal('cat firefox-persistent.txt');
    const persisted = persistent.includes('survives-firefox') && persistent.includes('exit 0');
    await report({
      ok: persisted && Object.values(first.checks ?? {}).every(Boolean),
      browser: first.browser ?? navigator.userAgent,
      phase: 'reopen',
      coldBootMs: first.bootMs,
      reopenMs: bootMs,
      checks: { ...(first.checks ?? {}), persistence: persisted },
      details: first.details ?? {},
      persistent,
    });
    return;
  }

  const shell = await runTerminal("mkdir -p src; echo firefox > src/a.txt; cat src/a.txt | grep fire");
  const javascript = await runTerminal("js -e 'console.log(6 * 7)'");
  const wasi = await runTerminal('wasi-demo');
  const denied = await runTerminal('curl http://127.0.0.1:9/private');
  const input = /** @type {HTMLInputElement} */ (document.getElementById('terminal-input'));
  input.value = 'sleep 3 &';
  /** @type {HTMLFormElement} */ (document.getElementById('terminal-form')).requestSubmit();
  await waitFor(() => document.getElementById('pod-status')?.textContent === 'running');
  const jobs = await runTerminal('jobs');
  const sleepingJob = jobs.match(/(job-\S+)\trunning\tsleep 3 &/)?.[1] ?? '';
  const cancelled = sleepingJob ? await runTerminal(`kill ${sleepingJob}`) : '';
  await runTerminal('export POD_PARENT=kept');
  await runTerminal('export POD_PARENT=background &');
  const isolated = await runTerminal('echo $POD_PARENT');
  const saved = await runTerminal('echo survives-firefox > firefox-persistent.txt');
  const checks = {
    shell: shell.includes('firefox\n') && shell.includes('exit 0'),
    javascriptPolicy: javascript.includes('Firefox MV3 forbids dynamic blob Workers') && javascript.includes('exit 1'),
    wasi: wasi.includes('hello from wasi') && wasi.includes('exit 0'),
    egressDenial: denied.includes('private_network') && denied.includes('exit 1'),
    concurrentJobs: !!sleepingJob && jobs.includes('\trunning\tjobs'),
    cancellation: cancelled.includes('exit 0'),
    jobIsolation: isolated.includes('kept\n') && isolated.includes('exit 0'),
    persistedWrite: saved.includes('exit 0'),
  };
  sessionStorage.setItem(stageKey, 'reopen');
  sessionStorage.setItem(`${stageKey}-first`, JSON.stringify({
    browser: navigator.userAgent, bootMs, checks,
    details: { shell, javascript, wasi, denied, jobs, cancelled, isolated, saved },
  }));
  location.reload();
};

main().catch((error) => report({ ok: false, phase: 'error', error: error?.stack ?? String(error) }).catch(() => {}));
