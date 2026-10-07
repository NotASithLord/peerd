// @ts-check
import m from '/vendor/mithril/mithril.js';

// Short, valid DOM/JS fragments: each types out at its own random spot, like
// the rain but horizontal. Attention to detail: real browser APIs, not lorem.
const SNIPPETS = [
  "document.querySelector('#peerd')",
  "el.addEventListener('pointerdown', unlock)",
  "await navigator.credentials.get({ publicKey })",
  "crypto.subtle.deriveKey({ name: 'AES-GCM' })",
  "crypto.getRandomValues(new Uint8Array(32))",
  "cred.getClientExtensionResults().prf",
  "document.createElement('section')",
  "node.classList.add('peer', 'online')",
  "el.dataset.peerId = id",
  "root.replaceChildren(view(state))",
  "new WebSocket('wss://peerd.ai/rendezvous')",
  "socket.addEventListener('message', route)",
  "for (const peer of swarm) dial(peer)",
  "await indexedDB.open('peerd-vault', 1)",
  "requestAnimationFrame(frame)",
  "queueMicrotask(flush)",
  "new TextEncoder().encode(json)",
  "navigator.storage.persist()",
  "structuredClone(state)",
  "JSON.parse(event.data)",
  "vault.open(key)",
  "performance.now()",
];

/**
 * Faint typing backdrop behind the gate: short DOM/JS fragments type themselves
 * out, left-to-right, at many random spots at once, each leaving a fading trail:
 * a horizontal take on a code rain, a hint you're entering a browser-native
 * machine. Monochrome and very low-contrast (borrows --fg on a transparent
 * canvas, so it themes light/dark for free). This is atmosphere, not chrome.
 * prefers-reduced-motion shows a static scatter, no typing. Mounted only while
 * the gate is; the loop is cancelled on unmount.
 */
export const CodeStream = {
  /** @param {any} vnode */
  oncreate(vnode) {
    /** @type {HTMLCanvasElement} */
    const canvas = vnode.dom;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cs = getComputedStyle(document.documentElement);
    const fg = (cs.getPropertyValue('--fg') || '#F3F3EF').trim();
    const mono = (cs.getPropertyValue('--font-mono') || 'monospace').trim();
    const reduce = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const ROW = 24;                         // vertical spacing between typer rows
    // Trail decay per tick. why redraw-from-state (clearRect + explicit per-char
    // alpha) instead of the classic alpha-wash-toward-bg: source-over washing
    // only ASYMPTOTES to the background: every row ever typed on kept a faint
    // permanent residue, which read as lighter-than-black bands on the row grid
    // (owner report 2026-07-04). Clearing each frame and fading by age reaches
    // EXACT zero, so idle rows are indistinguishable from untouched background.
    const DECAY = 0.85;                     // matches the old wash (1 - 0.15)
    const HEAD = 0.8;                       // the bright typing head
    const FLOOR = 0.02;                     // below this a char is invisible → skip
    /** @typedef {{ x: number, y: number, text: string, i: number, wait: number, done: number }} Writer */
    /** @type {Writer[]} */
    let writers = [];
    let w = 0, h = 0, cw = 8, raf = 0, last = 0;

    /** @returns {Writer} a fresh typer at a random spot */
    const spawn = () => {
      const text = SNIPPETS[Math.floor(Math.random() * SNIPPETS.length)] || '';
      const maxX = Math.max(8, w - text.length * cw - 8);
      const rowN = Math.max(1, Math.floor((h - 16) / ROW));
      return {
        x: 8 + Math.floor(Math.random() * Math.max(1, maxX)),
        y: 12 + Math.floor(Math.random() * rowN) * ROW,
        text,
        i: 0,
        wait: Math.floor(Math.random() * 55), // stagger so they don't move in lockstep
        done: 0,                              // ticks since the line finished (fade-out age)
      };
    };

    const layout = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = `13px ${mono}`;
      ctx.textBaseline = 'top';
      cw = ctx.measureText('M').width || 8;
      writers = Array.from({ length: Math.max(3, Math.round((w * h) / 57500)) }, spawn);
    };

    const frame = (/** @type {number} */ t) => {
      raf = requestAnimationFrame(frame);
      if (t - last < 66) return;             // type cadence (unhurried)
      last = t;
      ctx.clearRect(0, 0, w, h);             // fresh frame: the page bg shows through, no residue
      ctx.fillStyle = fg;
      writers.forEach((wr, k) => {
        if (wr.wait > 0) { wr.wait -= 1; return; }
        // advance: type the next char, or age a finished line toward respawn
        if (wr.i < wr.text.length) wr.i += 1;
        else wr.done += 1;
        // draw the trail: each typed char fades by its age (newest = the bright
        // head), and a finished line keeps aging via `done` until fully out.
        let visible = false;
        for (let k2 = 0; k2 < wr.i; k2 += 1) {
          const age = (wr.i - 1 - k2) + wr.done;
          const alpha = HEAD * DECAY ** age;
          if (alpha < FLOOR) continue;
          visible = true;
          ctx.globalAlpha = alpha;
          ctx.fillText(wr.text[k2] || '', wr.x + k2 * cw, wr.y);
        }
        if (wr.done > 0 && !visible) writers[k] = spawn();   // fully faded → respawn elsewhere
      });
      ctx.globalAlpha = 1;
    };

    const still = () => {                     // reduced-motion: a static scatter
      ctx.fillStyle = fg;
      ctx.globalAlpha = 0.13;
      writers.forEach((wr) => ctx.fillText(wr.text, wr.x, wr.y));
      ctx.globalAlpha = 1;
    };

    // Hold the typing until the wordmark intro has fully settled (its last
    // block colorizes at 1480ms; see styles.css wmColor*) plus a 0.7s buffer,
    // so the gate renders calmly before the code starts.
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let startTimer;
    const onResize = () => { layout(); if (reduce) still(); };
    layout();
    window.addEventListener('resize', onResize);
    vnode.state.stop = () => { cancelAnimationFrame(raf); if (startTimer) clearTimeout(startTimer); window.removeEventListener('resize', onResize); };
    if (reduce) still();
    else startTimer = setTimeout(() => { raf = requestAnimationFrame(frame); }, 2180);
  },
  /** @param {any} vnode */
  onremove(vnode) { vnode.state.stop?.(); },
  view: () => m('canvas.code-stream', { 'aria-hidden': 'true' }),
};
