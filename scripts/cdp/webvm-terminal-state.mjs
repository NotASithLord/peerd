import {
  launchPeerd, unlockAndReady, evalIn, waitFor, rpc, attach, sleep, sseText, sseToolCall,
} from './e2e-harness.mjs';

const gap = (message, detail) => { throw new Error(`PROBE-GAP: ${message}${detail ? ` ${JSON.stringify(detail)}` : ''}`); };
const requireProof = (condition, message, detail) => { if (!condition) gap(message, detail); };
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const hex = (value) => Buffer.from(value, 'utf8').toString('hex');
const compactHex = (value) => value.replace(/\s/g, '').toLowerCase();
const poll = async (name, check, budgetMs = 30_000) => {
  const value = await waitFor(check, { budgetMs, pollMs: 100 });
  requireProof(value, name); return value;
};

// why: only the real web-security posture can establish a valid CheerpX boot.
export const openRealVm = async (extensionDir, name) => {
  const wire = [];
  let phase = { kind: 'create', issuedMain: false, issuedActor: false, token: '', command: '' };
  let vmId = '';
  const ctx = await launchPeerd({ extensionDir, enforceWebSecurity: true,
    modelResponder: (_index, request) => {
      const body = request?.postData ?? '';
      wire.push({ when: Date.now(), body });
      if (body.includes('<actor_agent>')) {
        if (phase.kind === 'delegate' && body.includes(phase.token) && !phase.issuedActor) {
          phase.issuedActor = true;
          return { sse: sseToolCall('vm_boot', { cmd: phase.command, timeoutMs: 30_000 }) };
        }
        return { sse: sseText('VM check finished.') };
      }
      if (!phase.issuedMain) {
        phase.issuedMain = true;
        return { sse: phase.kind === 'create'
          ? sseToolCall('sandbox_create', { kind: 'webvm', name })
          : sseToolCall('message_actor', { to: vmId, message: `${phase.token}: Run ${phase.command}`, await: true }) };
      }
      return { sse: sseText('VM request sent.') };
    },
  });
  let page;
  try {
    await unlockAndReady(ctx.page);
    const admitted = await rpc(ctx.page, { type: 'agent/send', text: `Create a WebVM named ${name}.` });
    requireProof(admitted?.ok === true, 'The real create request was refused.', admitted);
    const targets = () => fetch(`http://127.0.0.1:${ctx.port}/json/list`).then((reply) => reply.json());
    const target = await poll('The real VM tab did not open.', async () => (await targets())
      .find((row) => row.type === 'page' && row.url.startsWith(`chrome-extension://${ctx.sw.id}/engine-tabs/vm-tab/index.html#`)), 60_000);
    vmId = new URL(target.url).hash.slice(1);
    requireProof(vmId, 'The real VM has no identity.');
    page = await attach(target.webSocketDebuggerUrl);
    await page.send('Runtime.enable'); await page.send('Page.enable');
    const metrics = async (width, height) => {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await poll('The viewport did not resize.', () => evalIn(page, `innerWidth === ${width} && innerHeight === ${height}`));
      await sleep(300);
    };
    const boot = async () => {
      const visible = await poll('The real VM did not reach its terminal.', () => evalIn(page, `({
        failed: !!document.querySelector('.boot-card.is-failed'),
        mounted: !!document.querySelector('#vm-terminal:not([hidden]) .xterm-helper-textarea'),
        isolated: crossOriginIsolated, shared: typeof SharedArrayBuffer === 'function', origin: performance.timeOrigin,
        log: document.getElementById('boot-log')?.textContent?.slice(-2000),
      })`).then((value) => value.failed || value.mounted ? value : null).catch(() => null), 300_000);
      requireProof(visible.mounted && visible.isolated && visible.shared, 'CheerpX did not boot in a real isolated page.', visible);
      return visible;
    };
    await metrics(1280, 800); await boot();
    await page.send('Page.bringToFront');
    const host = (message) => evalIn(ctx.page, `(async () => {
      'use strict';
      const tabs = await chrome.tabs.query({});
      const matches = tabs.filter((tab) => tab.url === ${JSON.stringify(target.url)});
      if (matches.length !== 1 || !matches[0].id) throw new Error('PROBE-GAP: VM tab identity changed');
      return chrome.tabs.sendMessage(matches[0].id, ${JSON.stringify({ ...message, vmId })});
    })()`, true);
    const run = async (command, timeoutMs = 30_000) => {
      const reply = await host({ type: 'vm/run', cmd: command, timeoutMs });
      requireProof(reply?.ok === true && reply.result?.exitCode === 0, 'The guest command did not complete.', { command, reply });
      return reply.result.stdout;
    };
    const type = async (text) => {
      requireProof(await evalIn(page, `(() => {
        const input = document.querySelector('.xterm-helper-textarea'); input?.focus(); return document.activeElement === input;
      })()`), 'The real xterm input did not get focus.');
      await page.send('Input.insertText', { text });
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    };
    const rows = () => evalIn(page, `[...document.querySelectorAll('.xterm-rows > div')].map((row) => row.textContent).join('\\n')`);
    const idle = () => poll('The real chat did not settle.', () => evalIn(ctx.page,
      `!document.querySelector('form.input-bar button.stop, .message-assistant.streaming')`), 45_000);
    await idle();
    return { ctx, page, target, vmId, wire, metrics, boot, host, run, type, rows, idle,
      async delegate(command) {
        await idle();
        const token = `VM-CHECK-${crypto.randomUUID()}`;
        phase = { kind: 'delegate', command, token, issuedMain: false, issuedActor: false };
        const admitted = await rpc(ctx.page, { type: 'agent/send', text: token });
        requireProof(admitted?.ok === true, 'The real delegation was refused.', admitted);
        await poll('The bound WebVM actor did not request the command.', () => phase.issuedActor, 45_000);
        return { command, token, started: Date.now() };
      },
      async close() { try { page.close(); } finally { await ctx.close(); } },
    };
  } catch (error) { try { page?.close(); } finally { await ctx.close(); } throw error; }
};

export const WEBVM_TERMINAL_STATE = {
  name: 'webvm-terminal-live', kind: 'visual', phase: 'post-unlock',
  async run(ctx, rec) {
    // why: the normal runner disables web security. This real VM needs its own strict launch.
    const vm = await openRealVm(ctx.extensionDir, 'Terminal check');
    const base = process.env.PEERD_VISUAL_BASE_RENDER === '1';
    try {
      const directory = '/home/user/peerd-terminal-check';
      const environment = await vm.run('printf "TERM=%s HOME=%s LANG=%s\\n" "$TERM" "$HOME" "$LANG"; stty size');
      rec.observe('real guest environment', environment);
      if (!base) rec.check('the guest starts with its UTF-8 environment', environment.startsWith('TERM=xterm HOME=/home/user LANG=C.UTF-8\n'));
      await vm.run(`mkdir -p ${quote(directory)}`);
      await vm.type(`printf '%s' 'café' > ${quote(`${directory}/human.txt`)}; printf '\\n%s\\n' SAVED`);
      await poll('The human command did not finish in the guest.', async () => (await vm.rows()).split('\n').some((row) => row.trim() === 'SAVED'));
      const stored = await vm.run(`od -An -v -tx1 ${quote(`${directory}/human.txt`)}; cat ${quote(`${directory}/human.txt`)}; printf '\\n'`);
      rec.observe('real human input bytes', stored);
      if (!base) rec.check('human input retains its UTF-8 bytes', compactHex(stored.split('\n')[0]) === hex('café'));
      await rec.visualPage('webvm-terminal-ready', vm.page);
      await vm.metrics(900, 600);
      const resized = await vm.run('stty size; tput cols; tput lines; true');
      rec.observe('resized real guest', resized);
      const [size, columns, rows] = resized.trim().split('\n');
      if (!base) rec.check('the resized guest has consistent new dimensions',
        size === `${rows} ${columns}` && size !== environment.trim().split('\n').at(-1));
      await rec.visualPage('webvm-terminal-resized', vm.page);
      await vm.type('exit');
      const exited = await poll('The real shell exit is missing from its boot log.', () => evalIn(vm.page,
        `/persistent shell exited/.test(document.getElementById('boot-log')?.textContent ?? '')`));
      requireProof(exited, 'The shell exit is not observable.');
      const ready = await vm.host({ type: 'vm/is-ready' });
      rec.observe('dead-shell readiness', ready);
      if (!base) rec.check('a dead real shell is not ready', ready?.ready === false);
      await rec.visualPage('webvm-terminal-exited', vm.page);
    } finally { await vm.close(); }
  },
};
