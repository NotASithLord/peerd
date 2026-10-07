// @ts-check
import { describe, it, expect } from '../../../framework.js';
import { loadPackagedStarter } from '/shared/starter-catalog.js';
import { openEnvelope } from '/peerd-engine/export.js';
import { composeApp } from '/peerd-engine/app-compose.js';
/** @param {string} key */
const runStarter = async key => {
  const opened = await openEnvelope(await loadPackagedStarter(key));
  const files = Object.fromEntries(Object.entries(opened.files).filter(([path]) => opened.fileKinds[path] !== 'binary').map(([path, bytes]) => [path,new TextDecoder().decode(bytes)]));
  const assets = Object.fromEntries(Object.entries(opened.files).filter(([path]) => opened.fileKinds[path] === 'binary').map(([path,bytes]) => [path,bytes.slice().buffer]));
  const probe = `<script>(()=>{const poll=setInterval(()=>{try {
    const isWasm=${key === 'wasm-image'};
    const action=document.getElementById(isWasm?'apply':'analyze');
    if(!action||action.disabled)return;
    clearInterval(poll); action.click();
    let result;
    if(isWasm){const canvas=document.getElementById('filtered');const ctx=canvas.getContext('2d');const gray=[...ctx.getImageData(255,191,1,1).data];document.getElementById('mode').value='threshold';action.click();result={gray,threshold:[...ctx.getImageData(255,191,1,1).data],status:document.getElementById('status').textContent};}
    else {result={stats:document.getElementById('stats').textContent,rows:document.querySelectorAll('#table tr').length,status:document.getElementById('status').textContent};}
    parent.postMessage({type:'starter-result',result},'*');
  }catch(error){clearInterval(poll);parent.postMessage({type:'starter-error',error:String(error)},'*');}},20);})();<\/script>`;
  const html = composeApp(files, opened.entry) + probe;
  return new Promise((resolve,reject) => {
    const frame=document.createElement('iframe'); frame.style.cssText='position:fixed;left:-9999px;width:800px;height:600px';
    /** @type {MessagePort|null} */ let port=null;
    const close=()=>{clearTimeout(timer);port?.close();window.removeEventListener('message',receive);frame.remove();};
    const timer=setTimeout(()=>{close();reject(new Error(`starter ${key} sandbox did not produce a result`));},8000);
    /** @param {MessageEvent} event */
    const receive=event=>{if(event.source!==frame.contentWindow)return;if(event.data?.type==='starter-result'){close();resolve(event.data.result);}else if(event.data?.type==='starter-error'){close();reject(new Error(event.data.error));}};
    window.addEventListener('message',receive);
    frame.addEventListener('load',()=>{const channel=new MessageChannel();port=channel.port1;port.onmessage=event=>{if(event.data?.type==='runner-ready')port?.postMessage({type:'app-body',html,entry:opened.entry,assets},Object.values(assets));};port.start();frame.contentWindow?.postMessage({type:'runner-init'},'*',[channel.port2]);},{once:true});
    frame.src='/engine-tabs/app-tab/runner.html';document.body.append(frame);
  });
};
describe('packaged starters in the actual App sandbox',()=>{
  it('CSV Lab parses and renders the sample through the composed module script',async()=>{const result=/** @type {any} */(await runStarter('csv-lab'));expect(result.rows).toBe(6);expect(result.status).toContain('5 rows; 3 columns');expect(result.stats).toContain('mean: 1540');});
  it('WASM Image Lab loads the binary asset and produces actual grayscale and threshold pixels',async()=>{const result=/** @type {any} */(await runStarter('wasm-image'));expect(result.gray).toEqual([247,247,247,255]);expect(result.threshold).toEqual([255,255,255,255]);expect(result.status).toContain('WebAssembly processed 49152 pixels with threshold');});
});
