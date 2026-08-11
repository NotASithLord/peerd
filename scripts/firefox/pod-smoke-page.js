// @ts-check
// Loaded only by run-pod-smoke.mjs's disposable staged extension. It drives the
// real Pod tab in Firefox, reloads it once, and reports evidence to the local
// harness. This file is never included in a release artifact.

const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
const reportUrl = params.get('report');
const stageKey = 'peerd-pod-firefox-smoke-stage';
const podId = location.hash.slice(1).split(/[?&]/)[0];

// The disposable background fixture uses the real registry API to create the
// catalog record, then this page reloads at that returned durable id before the
// production Pod module runs. No production route or fake metadata is needed.
if (podId === 'pod-firefox-smoke') {
  const created = await browser.runtime.sendMessage({ type: 'firefox-smoke/create-pod' });
  if (!created?.ok || !created.record?.id) throw new Error(created?.error ?? 'Firefox smoke could not create its Pod');
  // A hash-only location.replace is a same-document navigation and would leave
  // this top-level-await module blocking pod-tab.js forever. Rewrite the URL,
  // then force a real document reload so the production module boots normally.
  history.replaceState(null, '', `#${created.record.id}?report=${encodeURIComponent(reportUrl ?? '')}`);
  location.reload();
  await new Promise(() => {});
}

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
    return nodes.some((node) => node.classList.contains('entry-meta') && node.textContent?.includes('· exit '))
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

// Probe the browser primitive independently of Peerd's product guard. Firefox's
// MV3 Worker/CSP behavior has changed over time (Mozilla Bug 1869152), so the
// smoke report must distinguish "the browser rejected this construction" from
// "Peerd deliberately kept the path disabled pending policy/security review".
const probeBlobModuleWorker = async () => {
  const url = URL.createObjectURL(new Blob([
    'postMessage({ ok: true, source: "blob-module-worker" });',
  ], { type: 'application/javascript' }));
  /** @type {Worker | null} */
  let worker = null;
  try {
    worker = new Worker(url, { type: 'module', name: 'peerd-firefox-compat-probe' });
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 3_000);
      worker.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data?.ok === true
          ? { ok: true }
          : { ok: false, error: `unexpected message: ${JSON.stringify(event.data)}` });
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        event.preventDefault();
        resolve({ ok: false, error: event.message || 'worker error' });
      };
    });
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  } finally {
    worker?.terminate();
    URL.revokeObjectURL(url);
  }
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
  const blobModuleWorkerProbe = await probeBlobModuleWorker();
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
    // Deliberately pin today's rejection. If Firefox starts executing this
    // Worker, fail the smoke so the Pod JS guard gets an explicit review.
    blobModuleWorkerRejected: blobModuleWorkerProbe?.ok === false,
    javascriptPolicy: javascript.includes('Peerd disables dynamic blob Workers') && javascript.includes('exit 1'),
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
    details: { shell, blobModuleWorkerProbe, javascript, wasi, denied, jobs, cancelled, isolated, saved },
  }));
  location.reload();
};

main().catch((error) => report({ ok: false, phase: 'error', error: error?.stack ?? String(error) }).catch(() => {}));
