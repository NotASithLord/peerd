// @ts-check
// A packaged starter's own page in the real App runner, as Open draws it.
// ?starter= picks the app. A probe inside the app presses its main button
// once it is ready, as a person does, so the capture shows the result. why a
// probe: the runner's origin is opaque, so only a script inside it can press
// the button and read the status line, which it posts back here.
import { composeApp } from '/peerd-engine/app-compose.js';
import { openEnvelope } from '/peerd-engine/export.js';
import { loadPackagedStarter } from '/shared/starter-catalog.js';

const key = new URLSearchParams(location.search).get('starter') ?? 'csv-lab';
const image = key === 'wasm-image';
/** @type {Window & {__starterApp?: {pressed:boolean, status:string}}} */ (window).__starterApp = { pressed: false, status: '' };
const opened = await openEnvelope(await loadPackagedStarter(key));
const files = Object.fromEntries(Object.entries(opened.files).filter(([path]) => opened.fileKinds[path] !== 'binary')
  .map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]));
const assets = Object.fromEntries(Object.entries(opened.files).filter(([path]) => opened.fileKinds[path] === 'binary')
  .map(([path, bytes]) => [path, bytes.slice().buffer]));
// The Desaturator makes the sample black and white; Tables and charts draws its sample table.
const probe = `<script>(() => {
  'use strict';
  let pressed = false;
  const poll = setInterval(() => {
    const action = document.getElementById(${JSON.stringify(image ? 'apply' : 'analyze')});
    if (!action || action.disabled) return;
    if (!pressed) {
      pressed = true;
      if (${image}) document.getElementById('mode').value = 'threshold';
      action.click();
    }
    parent.postMessage({ type: 'starter-app', status: document.getElementById('status')?.textContent ?? '' }, '*');
    clearInterval(poll);
  }, 20);
})();<\/script>`;
const frame = document.createElement('iframe');
frame.title = opened.name ?? key;
window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow || event.data?.type !== 'starter-app') return;
  /** @type {Window & {__starterApp?: {pressed:boolean, status:string}}} */ (window).__starterApp = { pressed: true, status: String(event.data.status) };
});
frame.addEventListener('load', () => {
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => {
    if (event.data?.type !== 'runner-ready') return;
    channel.port1.postMessage({ type: 'app-body', html: composeApp(files, opened.entry) + probe, entry: opened.entry, assets }, Object.values(assets));
  };
  channel.port1.start();
  frame.contentWindow?.postMessage({ type: 'runner-init' }, '*', [channel.port2]);
}, { once: true });
frame.src = '/engine-tabs/app-tab/runner.html';
document.body.append(frame);
