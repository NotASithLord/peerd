// Wires the demo page to the web Notebook host. Function components hold no
// logic; this is the imperative shell that drives the host.
import { createNotebookHost } from './notebook-host.js';

const $ = (id) => document.getElementById(id);
const codeEl = $('code');
const runBtn = $('run');
const valueEl = $('value');
const consoleEl = $('console');
const filesEl = $('files');

const consoleLines = [];

const host = createNotebookHost({
  notebookId: 'poc-demo',
  onLog: (m) => {
    consoleLines.push(`${m.level === 'info' ? '' : `[${m.level}] `}${m.text}`);
    consoleEl.textContent = consoleLines.join('\n');
    consoleEl.classList.remove('muted');
  },
});

// Exposed so the headless validation (run-poc.mjs) can drive a run + read the
// result without scraping the DOM. The page UI works the same way.
window.runNotebookCell = async (code) => {
  const result = await host.run(code ?? codeEl.value);
  const files = await host.opfs.list().catch(() => []);
  return { result, files };
};

const render = ({ result, files }) => {
  if (result.error) {
    valueEl.textContent = result.error;
    valueEl.className = 'err';
  } else {
    valueEl.textContent = `${JSON.stringify(result.value, null, 2)}\n\n(${result.durationMs}ms, in a sealed worker)`;
    valueEl.className = 'ok';
  }
  filesEl.textContent = files.length
    ? files.map((f) => `${f.path}  ${f.size}b`).join('\n')
    : '(none)';
  filesEl.classList.remove('muted');
};

runBtn.addEventListener('click', async () => {
  runBtn.disabled = true;
  consoleLines.length = 0;
  consoleEl.textContent = '—';
  consoleEl.classList.add('muted');
  try {
    render(await window.runNotebookCell());
  } finally {
    runBtn.disabled = false;
  }
});
