var xl=Object.defineProperty,Bt=(e,t,r)=>()=>{if(r)throw r[0];try{return e&&(t=e(e=0)),t}catch(a){throw r=[a],a}},ka=(e,t)=>{for(var r in t)xl(e,r,{get:t[r],enumerable:!0})};function Zt(e){if(Object.hasOwn(Fe,e))return e;throw new Error(`Unsupported dtype: ${e}`)}function Oe(e){return Fe[e].storageByteSize}function ke(e){if(!Array.isArray(e))throw new Error("shape must be an array");let t=1;for(let r of e){if(!Number.isInteger(r)||r<0)throw new Error(`invalid shape dimension: ${r}`);t*=r}return t}function Tr(e,t){return Math.ceil(e/t)*t}function gt(e){return Math.max(4,Tr(e,4))}function Js(e,t){return e.length===t.length&&e.every((r,a)=>r===t[a])}function Jt(e){return e!==null&&typeof e=="object"&&typeof e.dtype=="string"&&Array.isArray(e.shape)&&typeof e.size=="number"&&typeof e.byteLength=="number"&&"buffer"in e&&"runtime"in e}function en(){}function Sl(e,t){let r=ke([...t]);return{dtype:e,shape:[...t],size:r,byteLength:r*Oe(e),byteOffset:0,buffer:{destroy(){}},runtime:null,destroy(){}}}var ql,Fe,qe=Bt(()=>{"use strict";ql=Object.freeze({float16:"float16",float32:"float32",int8:"int8",int16:"int16",int32:"int32",uint8:"uint8",uint32:"uint32",bool:"bool"}),Fe=Object.freeze({float16:{storageByteSize:2,onDiskByteSize:2,wgslScalar:"f16",arrayCtor:Uint16Array},float32:{storageByteSize:4,onDiskByteSize:4,wgslScalar:"f32",arrayCtor:Float32Array},int8:{storageByteSize:4,onDiskByteSize:1,wgslScalar:"i32",arrayCtor:Int32Array},int16:{storageByteSize:4,onDiskByteSize:2,wgslScalar:"i32",arrayCtor:Int32Array},int32:{storageByteSize:4,onDiskByteSize:4,wgslScalar:"i32",arrayCtor:Int32Array},uint8:{storageByteSize:4,onDiskByteSize:1,wgslScalar:"u32",arrayCtor:Uint32Array},uint32:{storageByteSize:4,onDiskByteSize:4,wgslScalar:"u32",arrayCtor:Uint32Array},bool:{storageByteSize:4,onDiskByteSize:1,wgslScalar:"u32",arrayCtor:Uint32Array}})});function El(e){return Object.fromEntries(Object.entries(e).filter(([,t])=>t!==void 0))}function tn(e){if(e==="u32"||e==="i32"||e==="f32")return{align:4,size:4,scalar:e,components:1};let t=sn.exec(e);if(!t)throw new Error(`Unsupported uniform field type: ${e}`);let r=Number(t[1]);return{align:r===2?8:16,size:r===3?12:r*4,scalar:t[2],components:r}}function Tl(e){return e==="u32"||e==="i32"||e==="f32"}function Il(e,t={}){return Ir(e,"u32",t)}function Al(e,t={}){return Ir(e,"i32",t)}function Bl(e,t={}){return Ir(e,"f32",t)}function Ir(e,t,r={}){return Ar(e,"uniform field"),tn(t),Object.freeze({kind:"uniform-field",name:e,type:t,semantic:r.semantic,required:r.required??!r.internal,internal:!!r.internal,default:r.default,description:r.description})}function rn(e,t,r={}){if(Ar(e,"uniform struct"),!Array.isArray(t)||t.length===0)throw new Error(`uniform struct ${e} requires at least one field`);let a=t.map(s=>Pl(s,e));return Object.freeze({kind:"uniform-struct",name:e,fields:Object.freeze(Cl(a,r))})}function jl(e){xa(e);let t=e.fields.map(r=>`${r.name}: ${r.type}`).join(", ");return`struct ${e.name} { ${t} };`}function Ml(e,t={}){if(xa(e),!e.fields.every(u=>Tl(u.type)))return Dl(e,t);let r=Math.max(16,Math.ceil(e.fields.length*4/16)*16),a=new ArrayBuffer(r),s=new Uint32Array(a),n=new Int32Array(a),i=new Float32Array(a);return e.fields.forEach((u,o)=>{let l=t[u.name];if(l===void 0&&u.required)throw new Error(`Missing uniform field ${e.name}.${u.name}`);if(l===void 0&&(l=u.default??0),typeof l!="number")throw new Error(`Uniform ${e.name}.${u.name} expects a scalar number`);an(u.type,o,l,`${e.name}.${u.name}`,s,n,i)}),new Uint32Array(a)}function Dl(e,t){let r=[],a=0;for(let o of e.fields){let l=tn(o.type);a=Tr(a,l.align),r.push({field:o,layout:l,offset:a}),a+=l.size}let s=new ArrayBuffer(Math.max(16,Tr(a,16))),n=new Uint32Array(s),i=new Int32Array(s),u=new Float32Array(s);for(let{field:o,layout:l,offset:c}of r){let d=t[o.name];if(d===void 0&&o.required)throw new Error(`Missing uniform field ${e.name}.${o.name}`);d===void 0&&(d=o.default??(l.components===1?0:new Array(l.components).fill(0)));let f=typeof d=="number"?[d]:d;if(f.length!==l.components)throw new Error(`Uniform ${e.name}.${o.name} expects ${l.components} component(s), got ${f.length}`);for(let p=0;p<l.components;++p)an(l.scalar,(c+p*4)/4,f[p],`${e.name}.${o.name}[${p}]`,n,i,u)}return new Uint32Array(s)}function an(e,t,r,a,s,n,i){if(e==="u32"){if(!Number.isInteger(r)||r<0||r>4294967295)throw new Error(`Uniform ${a} must be an integer u32 in [0, 4294967295]`);s[t]=r;return}if(e==="i32"){if(!Number.isInteger(r)||r<-2147483648||r>2147483647)throw new Error(`Uniform ${a} must be an integer i32 in [-2147483648, 2147483647]`);n[t]=r;return}if(Number.isNaN(r))throw new Error(`Uniform ${a} must not be NaN (f32)`);i[t]=r}function $l(e,t,r,a){return e.createUniformU32(Ml(t,r),a)}function Fl(e){return xa(e),{kind:e.kind,name:e.name,fields:e.fields.map(t=>El({name:t.name,type:t.type,required:t.required,internal:t.internal,semantic:t.semantic,default:t.default,description:t.description}))}}function Pl(e,t){if(!e||e.kind!=="uniform-field")throw new Error(`uniform struct ${t} fields must be created with u32(), i32(), or f32()`);return e}function Cl(e,t){let r=t.alignFieldsTo??4;if(!Number.isInteger(r)||r<=0)throw new Error(`alignFieldsTo must be a positive integer, got ${r}`);let a=[...e],s=a.length%r;if(s===0)return Object.freeze(a);let n=r-s,i=0,u=new Set(a.map(o=>o.name));for(let o=0;o<n;++o){for(;u.has(`_pad${i}`);)i++;let l=`_pad${i++}`;u.add(l),a.push(Ir(l,"u32",{internal:!0,required:!1,default:0}))}return Object.freeze(a)}function xa(e){if(!e||e.kind!=="uniform-struct")throw new Error("Expected a uniform struct schema")}function Ar(e,t){if(typeof e!="string"||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e))throw new Error(`${t} name must be a WGSL-compatible identifier, got ${e}`)}var sn,Sa=Bt(()=>{"use strict";qe(),sn=/^vec([234])<(u32|i32|f32)>$/});function Ll(e,t={}){Ar(e,"storage binding");let r=t.access??"read";if(!(r in qa))throw new Error(`storage binding ${e} has unsupported access ${r}`);return Object.freeze({kind:"storage",name:e,arg:t.arg,access:r,elementType:t.elementType??"f32",semantic:t.semantic})}function zl(e,t,r={}){Ar(e,"uniform binding");let a;if(Vl(t)?a=rn(r.structName??Ul(e),t):a=t,!a||a.kind!=="uniform-struct")throw new Error(`uniform binding ${e} requires a uniformStruct schema or field array`);return Object.freeze({kind:"uniform",name:e,struct:a,semantic:r.semantic})}function Br(e){if(!Array.isArray(e)||e.length===0)throw new Error("bindGroup requires at least one binding");let t=new Set;return Object.freeze(e.map((r,a)=>{if(!r||r.kind!=="storage"&&r.kind!=="uniform")throw new Error("bindGroup entries must be storage() or uniform() bindings");if(t.has(r.name))throw new Error(`duplicate bindGroup binding name: ${r.name}`);return t.add(r.name),Object.freeze({...r,binding:a})}))}function Ol(e,t={}){return Br(e).map(r=>Gl(r,t)).join(`
`)}function Nl(e){let t=[],r=new Map;for(let a of Br(e)){if(a.kind!=="uniform")continue;let s=JSON.stringify(Fl(a.struct)),n=r.get(a.struct.name);if(n!==void 0){if(n!==s)throw new Error(`uniform struct ${a.struct.name} is declared with conflicting schemas`);continue}r.set(a.struct.name,s),t.push(jl(a.struct))}return t.join(`
`)}function Wl(e,t,r,a={}){let s=Br(t),n=a.labelPrefix??"kernel",i=[],u=()=>{let l=[];for(let c of i.splice(0))try{c()}catch(d){l.push(d)}if(l.length===1)throw l[0];if(l.length>1)throw new AggregateError(l,"WebGPU binding cleanup failed")},o=[];try{for(let l of s){let c=r?.[l.name];if(c==null)throw new Error(`Missing resource for binding ${l.name}`);if(l.kind==="uniform"){let m;Hl(c)?m=c:(m=$l(e,l.struct,c,`${n}-${l.name}`),typeof m.destroy=="function"&&i.push(()=>m.destroy?.())),o.push({buffer:m,type:"uniform",binding:l.binding});continue}let d=c,f=typeof d.byteOffset=="number"?d.byteOffset:0,p=typeof d.byteLength=="number"?gt(d.byteLength):void 0;o.push({tensor:c,type:qa[l.access],binding:l.binding,...f?{offset:f}:{},...p!==void 0?{size:p}:{}})}return{bindings:o,cleanup:u}}catch(l){try{u()}catch(c){throw new AggregateError([l,c],"WebGPU binding materialization and cleanup both failed")}throw l}}function Gl(e,t){if(e.kind==="storage"){let r=e.access==="read_write"?"read_write":"read",a=Rl(e.elementType,t,`binding ${e.name} elementType`);return`@group(0) @binding(${e.binding}) var<storage, ${r}> ${e.name}: array<${a}>;`}return`@group(0) @binding(${e.binding}) var<uniform> ${e.name}: ${e.struct.name};`}function Rl(e,t,r){if(typeof e!="string"||!e.startsWith("$"))return e;let a=e.slice(1),s=t[a];if(s==null)throw new Error(`Missing template value ${a} for ${r}`);return s}function Hl(e){return e!==null&&typeof e=="object"&&typeof e.destroy=="function"&&!("shape"in e)}function Ul(e){return e.length===0?e:e[0].toUpperCase()+e.slice(1)}function Vl(e){return Array.isArray(e)}var qa,jr=Bt(()=>{"use strict";Sa(),qe(),qa=Object.freeze({read:"read-only-storage",read_write:"storage"})}),nn={};ka(nn,{executeWebGpuPlan:()=>Xl,materializeWebGpuExecutionPlan:()=>Ea});function Ql(e){let t=0;for(let r of e){if(r.type==="uniform")continue;let a=r.tensor,s=typeof r.size=="number"?r.size:typeof a?.byteLength=="number"?a.byteLength:void 0;typeof s=="number"&&Number.isFinite(s)&&s>0&&(t+=s)}return t}function Kl(e,t){return t<=0?e?{profile:e}:{}:{profile:{...e??{},bytesMoved:t}}}async function Xl(e,t,r={}){let a=Ea(e,t);try{if(a.programs.length===0)return;if(typeof e.runProgramSequence=="function")await e.runProgramSequence(a.programs,r);else for(let s of a.programs)await e.runProgram(s,r)}finally{a.cleanup()}}function Ea(e,t,r={}){let a=r.scratchResources,s=a===void 0,n=a===void 0?Zl(e,t):Jl(t,a),i=[],u=[],o=!1,l=()=>{if(o)return;o=!0;let c;for(let d of i)try{d()}catch(f){c??=f}if(s)try{un(n)}catch(d){c??=d}if(c!==void 0)throw c};try{for(let c=0;c<t.program.passes.length;++c){let d=t.program.passes[c],f=t.plan.passes[c],p=`${t.program.op} (variant ${t.program.variant}, pass ${d.id})`,m=ec(t,d.bindingSpecs,f.uniforms,n);if(ac(d,m))continue;tc(p,d.bindings,b=>m[b.name]);let h=Wl(e,d.bindings,m,{labelPrefix:d.name});i.push(h.cleanup),u.push({name:d.name,source:d.source,entryPoint:d.entryPoint,cacheKey:`webgpu:${t.program.key}:pass=${d.pipelineCacheId}`,bindings:h.bindings,dispatchWorkgroups:f.dispatchWorkgroups,...d.submitAfter?{submitAfter:!0}:{},...Kl(d.profile,Ql(h.bindings))})}return{programs:u,cleanup:l}}catch(c){try{l()}catch(d){throw new AggregateError([c,d],"WebGPU plan materialization and cleanup both failed")}throw c}}function Yl(e,t){return t[e.arg??""]??t[e.name]}function Zl(e,t){let r={};if(t.plan.scratches.length===0)return r;if(typeof e.empty!="function")throw new Error("WebGPU multi-pass plan requires a runtime with empty(dtype, shape)");try{for(let a of t.plan.scratches)r[a.id]=e.empty(a.dtype,a.shape,`webgpu-scratch-${a.id}`)}catch(a){try{un(r)}catch(s){throw new AggregateError([a,s],"WebGPU scratch allocation and cleanup both failed")}throw a}return r}function Jl(e,t){let r={};for(let a of e.plan.scratches){let s=t[a.id];if(s==null)throw new Error(`Missing caller-owned WebGPU scratch resource ${a.id}`);let n=s;if(n.dtype!==a.dtype||!Array.isArray(n.shape)||!Js(n.shape,a.shape)){let i=Array.isArray(n.shape)?`[${n.shape.join(",")}]`:String(n.shape);throw new Error(`Caller-owned WebGPU scratch ${a.id} must be ${a.dtype}[${a.shape.join(",")}], got ${String(n.dtype)}${i}`)}r[a.id]=s}return r}function un(e){let t;for(let r of Object.values(e))if(typeof r.destroy=="function")try{r.destroy()}catch(a){t??=a}if(t!==void 0)throw t}function ec(e,t,r,a){let s={};for(let n of t){if(n.buffer.type==="uniform"){let i=on(e,n,a);s[n.name]=i??r[n.name];continue}s[n.name]=on(e,n,a)}return s}function on(e,t,r){return r[t.semantic??""]??r[t.name]??Yl(t,e.request.resources)}function tc(e,t,r){let a=null;for(let s of t){let n=rc(s);if(n===null)continue;let i=Ta(r(s));if(i===null)continue;a===null&&(a=new Map);let u=a.get(i.buffer);if(u===void 0){a.set(i.buffer,{name:s.name,access:n,view:i});continue}if(u.access==="read"&&n==="read")continue;if(u.access==="read_write"&&n==="read_write"){if(!sc(u.view.offset,u.view.end,i.offset,i.end))continue;throw new Error(`${e}: storage bindings "${u.name}" and "${s.name}" alias overlapping writable ranges of the same GPU buffer; overlapping storage aliases are unsafe when either binding is writable`)}let[o,l]=n==="read_write"?[u.name,s.name]:[s.name,u.name];throw new Error(`${e}: storage aliasing hazard — binding "${o}" (read-only-storage) and binding "${l}" (storage, read_write) resolve to the same GPU buffer. WebGPU usage scopes cover the whole buffer, so this poisons the entire command buffer and corrupts downstream results. Bind it once as storage (read_write) for intentional in-place, or use distinct buffers.`)}}function rc(e){if("buffer"in e&&e.buffer!==void 0)switch(e.buffer.type){case"read-only-storage":return"read";case"storage":return"read_write";default:return null}let t=e;return t.kind==="storage"?t.access:null}function ac(e,t){let r=e.viewAlias;if(r===void 0)return!1;for(let{input:a,output:s}of r){let n=Ta(t[a]),i=Ta(t[s]);if(n===null||i===null||!(n.buffer===i.buffer&&n.offset===i.offset&&n.end===i.end)||n.dtype!==i.dtype)return!1}return!0}function Ta(e){if(e===null||typeof e!="object")return null;let t=e,r=t.buffer??e;if(r===null||typeof r!="object"&&typeof r!="function")return null;let a=typeof t.byteOffset=="number"?t.byteOffset:0,s=typeof t.byteLength=="number"?t.byteLength:typeof t.size=="number"?t.size:Number.POSITIVE_INFINITY,n=typeof t.dtype=="string"?t.dtype:void 0;return{buffer:r,offset:a,end:a+s,dtype:n}}function sc(e,t,r,a){return e<a&&r<t}var ln=Bt(()=>{"use strict";jr(),qe()}),Ia={};ka(Ia,{default:()=>hn,fileURLToPath:()=>mn,join:()=>pn,open:()=>dn,readFile:()=>cn,stat:()=>fn});var jt,cn,dn,fn,pn,mn,hn,gn=Bt(()=>{jt=e=>()=>{throw new Error("Node built-in node:fs/promises."+e+" is unavailable in this browser bundle (node-only code path).")},cn=jt("readFile"),dn=jt("open"),fn=jt("stat"),pn=jt("join"),mn=jt("fileURLToPath"),hn={}}),wn={};ka(wn,{default:()=>xn,fileURLToPath:()=>kn,join:()=>yn,open:()=>vn,readFile:()=>bn,stat:()=>_n});var Mt,bn,vn,_n,yn,kn,xn,nc=Bt(()=>{Mt=e=>()=>{throw new Error("Node built-in node:url."+e+" is unavailable in this browser bundle (node-only code path).")},bn=Mt("readFile"),vn=Mt("open"),_n=Mt("stat"),yn=Mt("join"),kn=Mt("fileURLToPath"),xn={}});function ic(e){let t=[],r="",a=0,s=0,n=i=>{if(!i.startsWith(r))return"";let u=i.slice(r.length);return r=i,u};return{push(i){t.push(i);let u=e(t),o=u.length;for(;o>0&&u[o-1]==="�";)o--;let l=o!==u.length;return a=!l||o>s?0:a+1,s=o,n(l?a>3?u:u.slice(0,o):u)},flush(){if(t.length===0)return"";let i=e(t);if(a=0,i.startsWith(r))return n(i);let u=0;for(;u<r.length&&u<i.length&&r[u]===i[u];)u+=1;let o=i.slice(u);return r=i,o},get text(){return r}}}function uc(e,t){let r=Math.min(e.length,t.length),a=0;for(;a<r&&e[a]===t[a];)a+=1;return a}function Aa(e,t,r){return t.length===0?"":e.decode(t,r)}function oc(e,t,r,a=[]){for(let n=a.length;n>=0;--n){let i=[...r,...a.slice(0,n)];if(i.length===0)continue;let u=Aa(e,i,{skip_special_tokens:!1});if(!t.startsWith(u))continue;let o=e.encode(t.slice(u.length),{add_special_tokens:!1}).ids,l=[...i,...o];if(Aa(e,l,{skip_special_tokens:!1})===t)return{fullyEncodedIds:l,inputIds:l,prefixLength:r.length}}let s=e.encode(t,{add_special_tokens:!1}).ids;return{fullyEncodedIds:s,inputIds:s,prefixLength:uc(r,s)}}var lc=class{#e;#t=[];#r=[];constructor(e){this.#e=e}get cacheLength(){return this.#t.length}prepare(e){return oc(this.#e,e,this.#t,this.#r)}commit(e,t,r){let a=[...e,...t];if(!Number.isInteger(r)||r<e.length||r>a.length)throw new Error(`chat token ledger cannot commit cache length ${r} for ${e.length} input + ${t.length} generated tokens`);this.#t=a.slice(0,r),this.#r=a.slice(r)}clear(){this.#t=[],this.#r=[]}};function cc(e,t){return e?.assistantContent?.(t)??t.visibleText}function dc(e,t){return{...e?.assistantMessageFields?.(t)??{},role:"assistant",content:cc(e,t)}}function Mr(e){return typeof e=="number"&&Number.isFinite(e)}var Sn="webgpu-template-policy-probe",qn=`<|turn>system
<|think|>
<turn|>
`,fc=`<|turn>model
`,pc=`<|channel>thought
<channel|>`,mc=Object.freeze({templateArgs:Object.freeze({enable_thinking:!0})});function En(e,t,r,a){return e.render({messages:r,tools:null,bos_token:t.bos_token,eos_token:t.eos_token,add_generation_prompt:!0,enable_thinking:a,preserve_thinking:!0})}function hc(e,t){let r={role:"user",content:Sn};try{let a=En(e,t,[r],!0),s=En(e,t,[r],!1),n=`<|turn>user
${Sn}<turn|>
${fc}`;return!a.includes(qn)||!a.endsWith(n)||s.includes(qn)||!s.endsWith(n+pc)?void 0:mc}catch{return}}var er="<|start|>assistant",Ba=" to=self<|message|>",Dr=" to=user<|message|>",Tn="<|message|>",ja="<|eom|>",Ma="<|eot|>",Da="webgpu-template-policy-probe";function In(e){let t=e,r;if(t.startsWith(Ba)){let s=t.indexOf(ja);if(s<0||(r=t.slice(Ba.length,s),t=t.slice(s+ja.length),!t.startsWith(er)))return;t=t.slice(er.length)}if(t.startsWith(Dr))t=t.slice(Dr.length);else if(t.startsWith(Tn))t=t.slice(Tn.length);else return;if(t.includes(er))return;let a=t.indexOf(Ma);return{reasoning:r??"",content:a<0?t:t.slice(0,a)}}var gc=Object.freeze({assistantContent(e){return In(e.rawText)?.content??e.visibleText},assistantMessageFields(e){let t=In(e.rawText);return t&&t.reasoning!==""?{reasoning_content:t.reasoning}:{}}});function $a(e,t,r,a){return e.render({messages:r,tools:null,bos_token:t.bos_token,eos_token:t.eos_token,add_generation_prompt:a})}function wc(e,t){let r={role:"user",content:Da},a=`${Da}-answer`,s=`${Da}-reasoning`;try{let n=$a(e,t,[r],!0);return!n.endsWith(er)||$a(e,t,[r,{role:"assistant",content:a}],!1)!==n+Dr+a+Ma?void 0:$a(e,t,[r,{role:"assistant",content:a,reasoning_content:s}],!1)===n+Ba+s+ja+er+Dr+a+Ma?gc:void 0}catch{return}}var An=`<think>
`,Bn=`<think>

</think>

`,bc="webgpu-template-policy-probe";function $r({rawText:e,templateArgs:t}){let r=t.enable_thinking===!1?Bn:An;return r.includes("</think>")||e.includes("</think>")?r+e:r+e+(e.endsWith(`
`)?"":`
`)+`</think>

`}var vc=Object.freeze({templateArgs:Object.freeze({preserve_thinking:!0}),assistantContent:$r});function tr(e,t,r,a,s){return e.render({...s,messages:r,tools:null,bos_token:t.bos_token,eos_token:t.eos_token,add_generation_prompt:a})}function _c(e,t){let r={role:"user",content:bc},a=Object.freeze({preserve_thinking:!0,enable_thinking:!0}),s=Object.freeze({preserve_thinking:!0,enable_thinking:!1});try{let n=tr(e,t,[r],!0,a),i=tr(e,t,[r],!0,s);if(!n.endsWith(An)||!i.endsWith(Bn))return;let u=`reasoning
</think>

answer`;if(!tr(e,t,[r,{role:"assistant",content:$r({visibleText:`reasoning
answer`,rawText:u,templateArgs:a})}],!1,a).startsWith(n+u))return;let o="unfinished reasoning";if(!tr(e,t,[r,{role:"assistant",content:$r({visibleText:o,rawText:o,templateArgs:a})}],!1,a).startsWith(n+o))return;let l="answer";return tr(e,t,[r,{role:"assistant",content:$r({visibleText:l,rawText:l,templateArgs:s})}],!1,s).startsWith(i+l)?vc:void 0}catch{return}}function yc(e,t){return hc(e,t)??_c(e,t)??wc(e,t)}async function kc(e,t){let r=Math.max(1,Math.floor(t.baseDepth)),a=Math.max(r,Math.floor(t.maxDepth)),s=Sc(t.minSampleTokens,24,2),n=.97,i=5,u=[r];for(;u.length<i&&u.at(-1)<a;){let d=u.at(-1);u.push(Math.min(a,d*2))}let o=[],l=null,c=0;for(let d of u){let f=Math.max(s,d+1),p=await e(d,f);if(!Number.isFinite(p.tokensPerSecond)||p.tokensPerSecond<=0)throw new Error(`decode calibration at depth ${d} returned invalid throughput`);if(p.tokenIds.length!==f)throw new Error(`decode calibration at depth ${d} produced ${p.tokenIds.length}/${f} tokens`);let m=l===null||xc(l,p.tokenIds);if(o.push({depth:d,sampleTokens:f,tokensPerSecond:p.tokensPerSecond,outputMatchesReference:m}),!m)return Fa(o,n,"output-mismatch");if((l===null||p.tokenIds.length>l.length)&&(l=p.tokenIds),c>0&&p.tokensPerSecond<=c/n)return Fa(o,n,"saturated");c=p.tokensPerSecond}return Fa(o,n,"max-depth")}function Fa(e,t,r){let a=e.filter(n=>n.outputMatchesReference),s=Math.max(...a.map(n=>n.tokensPerSecond));return{depth:a.find(n=>n.tokensPerSecond>=s*t)?.depth??a[0]?.depth??1,samples:e,totalSampleTokens:e.reduce((n,i)=>n+i.sampleTokens,0),stoppedBecause:r}}function xc(e,t){let r=Math.min(e.length,t.length);for(let a=0;a<r;++a)if(e[a]!==t[a])return!1;return!0}function Sc(e,t,r){return Number.isFinite(e)?Math.max(r,Math.floor(e)):t}async function qc(e,t=6){let r=Math.max(1,Math.floor(t)),a=e.tensorFromTypedArray("uint32",[1,1],new Uint32Array([0]));try{await e.readTensor(a);let s=[];for(let n=0;n<r;++n){let i=performance.now();await e.readTensor(a),s.push(performance.now()-i)}return s.sort((n,i)=>n-i),s[s.length>>1]}finally{a.destroy()}}var Ec="https://huggingface.co";function Tc(e){return typeof e=="string"&&/^https?:/i.test(e)}function Ic(e){return Tc(e)||e.startsWith("/")||e.startsWith(".")}function Ac(e,t={}){let{revision:r="main",file:a}=t,s=a?a.slice(a.lastIndexOf(".")).toLowerCase():"";if(s&&e.toLowerCase().endsWith(s))return e;if(Ic(e))return a?`${Bc(e)}/${a}`:e;let n=`${Ec}/${e}/resolve/${r}`;return a?`${n}/${a}`:n}function Bc(e){return e.endsWith("/")?e.slice(0,-1):e}function jc(e){return(t,r={})=>{let a=new Headers(r.headers);return a.set("Authorization",`Bearer ${e}`),globalThis.fetch(t,{...r,headers:a})}}var Mc=Object.freeze({vendor:"",architecture:"",device:"",description:""}),Pa=Object.freeze(["maxTextureDimension1D","maxTextureDimension2D","maxTextureDimension3D","maxTextureArrayLayers","maxBindGroups","maxBindGroupsPlusVertexBuffers","maxBindingsPerBindGroup","maxDynamicUniformBuffersPerPipelineLayout","maxDynamicStorageBuffersPerPipelineLayout","maxSampledTexturesPerShaderStage","maxSamplersPerShaderStage","maxStorageBuffersPerShaderStage","maxStorageTexturesPerShaderStage","maxUniformBuffersPerShaderStage","maxUniformBufferBindingSize","maxStorageBufferBindingSize","minUniformBufferOffsetAlignment","minStorageBufferOffsetAlignment","maxVertexBuffers","maxBufferSize","maxVertexAttributes","maxVertexBufferArrayStride","maxInterStageShaderVariables","maxColorAttachments","maxColorAttachmentBytesPerSample","maxComputeWorkgroupStorageSize","maxComputeInvocationsPerWorkgroup","maxComputeWorkgroupSizeX","maxComputeWorkgroupSizeY","maxComputeWorkgroupSizeZ","maxComputeWorkgroupsPerDimension","maxImmediateSize","maxStorageBuffersInVertexStage","maxStorageBuffersInFragmentStage","maxStorageTexturesInVertexStage","maxStorageTexturesInFragmentStage"]),Fr=Object.freeze(["shader-f16","subgroups","chromium-experimental-subgroup-matrix","timestamp-query","texture-formats-tier1","texture-formats-tier2"]),Dc=Object.freeze({maxTextureDimension1D:8192,maxTextureDimension2D:8192,maxTextureDimension3D:2048,maxTextureArrayLayers:256,maxBindGroups:4,maxBindGroupsPlusVertexBuffers:24,maxBindingsPerBindGroup:1e3,maxDynamicUniformBuffersPerPipelineLayout:8,maxDynamicStorageBuffersPerPipelineLayout:4,maxSampledTexturesPerShaderStage:16,maxSamplersPerShaderStage:16,maxStorageBuffersPerShaderStage:10,maxStorageTexturesPerShaderStage:4,maxUniformBuffersPerShaderStage:12,maxUniformBufferBindingSize:64*1024,maxStorageBufferBindingSize:128*1024*1024,minUniformBufferOffsetAlignment:256,minStorageBufferOffsetAlignment:256,maxVertexBuffers:8,maxBufferSize:256*1024*1024,maxVertexAttributes:16,maxVertexBufferArrayStride:2048,maxInterStageShaderVariables:16,maxColorAttachments:8,maxColorAttachmentBytesPerSample:32,maxComputeInvocationsPerWorkgroup:256,maxComputeWorkgroupSizeX:256,maxComputeWorkgroupSizeY:256,maxComputeWorkgroupSizeZ:64,maxComputeWorkgroupStorageSize:16*1024,maxComputeWorkgroupsPerDimension:65535,maxImmediateSize:64}),jn=new WeakSet;function Dt(e=null){if(e!==null&&typeof e=="object"&&jn.has(e))return e;let t=Cr(e)?e:{},r=Cr(t.adapterInfo)?t.adapterInfo:{},a={adapterInfo:Lc(r),features:Dn(t.features),wgslLanguageFeatures:$n(t.wgslLanguageFeatures),limits:Pn(t.limits)};return jn.add(a),a}function Mn(e){let t=new Set(e),r={size:t.size,has(a){return t.has(a)},entries(){return t.entries()},forEach(a,s){t.forEach(n=>a.call(s,n,n,r))},keys(){return t.keys()},values(){return t.values()},[Symbol.iterator](){return t[Symbol.iterator]()}};return r}function Dn(e=[]){return Mn(Cn(e))}function $n(e=[]){return Mn(Cn(e))}function rr(e=null){let t=Dt(e);return{adapterInfo:{...t.adapterInfo},features:Array.from(t.features.values()).sort(),wgslLanguageFeatures:Array.from(t.wgslLanguageFeatures.values()).sort(),limits:{...t.limits}}}function $c(e,t){if(!e)return null;for(let a of e.features??[])if(!t.features.has(a))return`requires device.features.has("${a}")`;for(let[a,s]of Object.entries(e.limits??{})){if(s===void 0)continue;let n=t.limits[a];if(typeof n!="number"||n<s)return`requires device.limits.${a} >= ${s}`}if(e.subgroupMinSize!==void 0){let a=t.adapterInfo.subgroupMinSize;if(typeof a!="number")return`requires adapterInfo.subgroupMinSize >= ${e.subgroupMinSize} (adapter does not report subgroup sizes)`;if(a<e.subgroupMinSize)return`requires adapterInfo.subgroupMinSize >= ${e.subgroupMinSize}`}let r=e.subgroupMatrixConfigs;if(r!==void 0&&r.length>0){let a=t.adapterInfo.subgroupMatrixConfigs;if(Array.isArray(a)&&!r.some(s=>a.some(n=>Fc(s,n))))return`requires adapterInfo.subgroupMatrixConfigs to match one of [${r.map(Pr).join(", ")}] (device reports [${a.map(Pr).join(", ")}])`}return null}function Fc(e,t){return(e.componentType===void 0||e.componentType===t.componentType)&&(e.resultComponentType===void 0||e.resultComponentType===t.resultComponentType)&&(e.M===void 0||e.M===t.M)&&(e.N===void 0||e.N===t.N)&&(e.K===void 0||e.K===t.K)}function Pr(e){return`${e.componentType??"*"}-${e.resultComponentType??"*"}-${e.M??"*"}x${e.N??"*"}x${e.K??"*"}`}var Ca=Object.freeze(["f32","f16","u32","i32","u8","i8"]);function Pc(e){if(!Cr(e))return null;let t=e.componentType,r=e.resultComponentType,{M:a,N:s,K:n}=e;return!Ca.includes(t)||!Ca.includes(r)||!La(a)||!La(s)||!La(n)?null:Object.freeze({componentType:t,resultComponentType:r,M:a,N:s,K:n})}function Fn(e){if(e==null||typeof e=="string"||typeof e[Symbol.iterator]!="function")return null;let t=[];for(let r of e){let a=Pc(r);a!==null&&t.push(a)}return t.sort((r,a)=>Pr(r).localeCompare(Pr(a))),Object.freeze(t)}function La(e){return typeof e=="number"&&Number.isInteger(e)&&e>0}function Cc(e){let t=e.adapterInfo;return{vendor:typeof t.vendor=="string"?t.vendor.toLowerCase():"",architecture:typeof t.architecture=="string"?t.architecture.toLowerCase():"",...typeof t.subgroupMinSize=="number"?{subgroupMinSize:t.subgroupMinSize}:{},...typeof t.subgroupMaxSize=="number"?{subgroupMaxSize:t.subgroupMaxSize}:{},isFallbackAdapter:t.isFallbackAdapter===!0,...Array.isArray(t.subgroupMatrixConfigs)?{subgroupMatrixConfigs:t.subgroupMatrixConfigs}:{}}}function Lc(e){let{subgroupMatrixConfigs:t,...r}=e,a=Fn(t);return{...Mc,...r,...a!==null?{subgroupMatrixConfigs:a}:{}}}function Pn(e){let t=Cr(e)?e:{},r={...Dc};for(let a of Pa){let s=zc(t,a);s!==void 0&&(r[a]=s)}for(let[a,s]of Object.entries(t))typeof s=="number"&&Number.isFinite(s)&&(r[a]=s);return r}function Cn(e){return e==null?[]:Array.isArray(e)?e.filter(za):typeof e[Symbol.iterator]=="function"?Array.from(e).filter(za):typeof e.values=="function"?Array.from(e.values()).filter(za):[]}function zc(e,t){let r=e[t];return typeof r=="number"&&Number.isFinite(r)?r:void 0}function za(e){return typeof e=="string"}function Cr(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}var Oc=new Set(["mozilla","brave","chrome","graphics","generic renderer","webkit webgl","webgl","webgpu","angle","unknown","subsystem opengl es translator"]),Nc=new Set(["apple","apple gpu","intel","intel graphics","hd graphics","intel hd graphics","intel hd graphics family","intel uhd graphics","intel arc graphics","intel iris","intel iris graphics","intel iris plus","intel iris plus graphics","intel iris pro","intel iris pro graphics","amd","amd radeon","amd radeon graphics","amd radeon pro graphics","amd unknown","nvidia","nvidia tegra","nvidia graphics device","nvidia geforce gpu","adreno","adreno gpu","mali","powervr"]),V_=Math.max(...[...Oc].map(e=>e.length)),Q_=Math.max(...[...Nc].map(e=>e.length)),Wc="shader-f16",Gc="subgroups",Rc="chromium-experimental-subgroup-matrix",Hc="timestamp-query",Uc="packed_4x8_integer_dot_product";function Vc(e){let t=rr(e),r=t.adapterInfo,a=new Set(t.features),s=new Set(t.wgslLanguageFeatures),n={};for(let i of Pa){let u=t.limits[i];typeof u=="number"&&(n[i]=u)}return{vendor:r.vendor??"",architecture:r.architecture??"",device:r.device??"",description:r.description??"",isFallbackAdapter:r.isFallbackAdapter===!0,subgroupMinSize:r.subgroupMinSize??null,subgroupMaxSize:r.subgroupMaxSize??null,subgroupMatrixConfigs:r.subgroupMatrixConfigs??null,features:t.features,wgslLanguageFeatures:t.wgslLanguageFeatures,capabilities:{shaderF16:a.has(Wc),subgroups:a.has(Gc),subgroupMatrix:a.has(Rc),timestampQuery:a.has(Hc),dp4a:s.has(Uc)},limits:n}}function Qc(e){let t=Vc(e);return{vendor:t.vendor,architecture:t.architecture,device:t.device,description:t.description,isFallbackAdapter:t.isFallbackAdapter,subgroupMinSize:t.subgroupMinSize??void 0,subgroupMaxSize:t.subgroupMaxSize??void 0,features:{shaderF16:t.capabilities.shaderF16,subgroups:t.capabilities.subgroups,subgroupMatrix:t.capabilities.subgroupMatrix,timestampQuery:t.capabilities.timestampQuery}}}function Ln(e){return e.fetch??(e.accessToken?jc(e.accessToken):void 0)}async function Kc(e){let t=globalThis.navigator?.gpu;if(!t)return{ok:!1,reason:"WebGPU isn't available in this browser. Try a recent Chrome or Edge."};let r=null;try{r=await t.requestAdapter({powerPreference:"high-performance"})}catch{}if(!r)return{ok:!1,reason:"No WebGPU adapter is available on this device."};try{let a=await e(r);return a?{ok:!1,reason:a}:{ok:!0}}catch{return{ok:!0}}}var Xc=class{#e;#t;model;tokenizer;#r;#s;#a;#n;eosTokenIds;#c;generationState;#o;#l;#u=null;#i=!1;destroyed=!1;chatTemplateArgs={};constructor(e){this.#e=e.runtime,this.#t=e.ownsRuntime,this.model=e.model,this.tokenizer=e.tokenizer,this.#r=e.chatTemplate,this.#s=e.tokenizerConfig,this.#a=e.chatTemplatePolicy===null?void 0:e.chatTemplatePolicy??yc(e.chatTemplate,e.tokenizerConfig),this.#n=new lc(e.tokenizer),this.eosTokenIds=e.eosTokenIds,this.generationState=e.generationState,this.#c=e.defaultMaxNewTokens;let t=e.tokenizer.token_to_id?.bind(e.tokenizer);this.#o=t?.("<think>")??null,this.#l=t?.("</think>")??null}get thinkOpenTokenId(){return this.#o}get thinkCloseTokenId(){return this.#l}get runtime(){return this.#e}acquireGenerationLease(){if(this.destroyed)throw new Error(`${this.constructor.name} has been disposed`);if(this.#i)throw new Error(`${this.constructor.name} is already generating`);this.#i=!0;let e=!0;return()=>{e&&(e=!1,this.#i=!1)}}get lastAssistantContent(){return this.#u?.content??null}get lastAssistantMessage(){return this.#u}get contextLength(){return this.generationState.cache.maxLength}get contextFull(){return this.generationState.cache.get_seq_length()>=this.generationState.cache.maxLength}#d(){return Object.freeze({...this.#a?.templateArgs??{},...this.chatTemplateArgs})}#f(e,t,r){return this.#r.render({...r,messages:e,tools:null,bos_token:this.#s.bos_token,eos_token:this.#s.eos_token,add_generation_prompt:t})}renderPrompt(e,t=!0){return this.#f(e,t,this.#d())}encodePrompt(e){return this.tokenizer.encode(this.renderPrompt(e),{add_special_tokens:!1}).ids}async*generate(e,t={}){let r=this.acquireGenerationLease();this.#u=null;let a=this.#d(),s=[],n="",i=!1;try{this.generationState.cache.get_seq_length()!==this.#n.cacheLength&&this.resetCache();let u=t.maxNewTokens??this.#c,o=t.eosTokenId??this.eosTokenIds,l=this.#f(e,!0,a),c=this.#n.prepare(l),{inputIds:d,prefixLength:f}=c;f!==this.#n.cacheLength&&(this.resetCache(),f=0,d=c.fullyEncodedIds);let p=d.slice(f);p.length===0&&(this.resetCache(),d=c.fullyEncodedIds,p=d.slice());let m=this.generationState.cache.maxLength-this.generationState.cache.get_seq_length()-p.length;if(m<1)throw new Error(p.length>=this.generationState.cache.maxLength?`message is too long for the context window (${p.length} tokens; window is ${this.generationState.cache.maxLength})`:`context window is full (${this.generationState.cache.maxLength} tokens) — clear the chat to continue`);let h=Math.min(u,m),b=ic(w=>this.tokenizer.decode(w,{skip_special_tokens:!0}));for await(let w of this.streamTokens({suffixIds:p,maxNewTokens:h,eosTokenId:o,stopOnEos:!0},t)){if(t.signal?.aborted)return;s.push(w);let y=b.push(w);n=b.text,yield{token:w,delta:y,text:n}}let g=b.flush();g!==""&&(n=b.text,yield{token:null,delta:g,text:n});let v=Aa(this.tokenizer,s,{skip_special_tokens:!1});this.#u=dc(this.#a,{visibleText:n,rawText:v,templateArgs:a}),this.#n.commit(d,s,this.generationState.cache.get_seq_length()),i=!0}finally{i||this.resetCache(),r()}}async complete(e,t={}){let r="";for await(let a of this.generate(e,t))r=a.text;return r}async benchmarkFixedTokenIds(e,t,r){let a=this.acquireGenerationLease();try{return await this.#p(e,t,r)}finally{a()}}async calibrateDecodePipeline(e,t,r=[0]){let a=this.acquireGenerationLease();try{return await kc(async(s,n)=>{let i=await this.#p(r,n,t(s));return{tokensPerSecond:i.decodeTps,tokenIds:i.ids}},e)}finally{a()}}async#p(e,t,r){this.resetCache();let a=[],s=0,n=0,i=performance.now();try{for await(let u of this.streamTokens({suffixIds:[...e],maxNewTokens:t,eosTokenId:r.eosTokenId??this.eosTokenIds,stopOnEos:!1},r))a.length===0&&(s=performance.now()),a.push(u);n=performance.now()}finally{this.resetCache()}return{ttftMs:a.length>0?s-i:NaN,decodeTps:a.length>1?(a.length-1)/((n-s)/1e3):0,tokens:a.length,ids:a}}deviceInfo(){return Qc(this.#e.device)}reset(){this.resetCache()}resetCache(){this.generationState.cache.truncate(0),this.#n.clear(),this.#u=null}dispose(){this.destroyed||(this.destroyed=!0,this.model.dispose(),this.#t&&this.#e.destroy())}};function Yc(e,t){let r=Oa(e.minimumCapacity??0,"minimumCapacity"),a=e.maxLength??e.max_length;if(a!==void 0){if(a<r)throw new Error(`maxLength ${a} is smaller than minimumCapacity ${r}`);return a}return Math.max(t,r)}function Oa(e,t){if(typeof e!="number"||!Number.isSafeInteger(e)||e<0)throw new Error(`${t} must be a non-negative safe integer, got ${String(e)}`);return e}function zn(e){return Oa(e??0,"max_new_tokens")}function On(e,t){let r=Oa(e,"input length")+zn(t);if(!Number.isSafeInteger(r))throw new Error(`generation capacity exceeds the safe integer range: ${r}`);return r}function Zc(e,t={}){return{maxNewTokens:zn(e.max_new_tokens),eosTokenId:e.eos_token_id??t.eosTokenId??null,stopOnEos:e.stop_on_eos!==!1,onPrefillDone:e.on_prefill_done??null}}function Jc(e,t){return t==null?!1:Array.isArray(t)?t.includes(e):e===t}function ed(e){return e==null?[]:Array.isArray(e)?[...e]:[e]}function Na(e){if(e instanceof Uint32Array)return e;if(ArrayBuffer.isView(e)&&Object.prototype.toString.call(e)==="[object Uint32Array]")return Uint32Array.from(e);if(!Array.isArray(e))throw new Error("input_ids must be a token row or a batch containing one row");let t=e.length>0&&Array.isArray(e[0]);if(t&&e.length!==1)throw new Error(`input_ids supports batch size 1, got ${e.length} rows`);let r=t?e[0]:e;for(let a=0;a<r.length;++a){let s=r[a];if(typeof s!="number"||!Number.isSafeInteger(s)||s<0||s>4294967295)throw new Error(`input_ids[${a}] must be a uint32 integer, got ${String(s)}`)}return Uint32Array.from(r)}async function*Nn(e){let t=[],r=()=>{let s=e.submit();return{unit:s,result:nd(s.result)}},a=[];try{for(;t.length<e.depth&&e.shouldSubmit();)t.push(r());for(;t.length>0;){let s=t[0];e.shouldSubmit()&&t.length-1<e.depth&&t.push(r()),t.shift();let n=await s.result;if(yield*e.accept(s.unit,n))return}}catch(s){throw a.push(s),s}finally{let s=await Promise.allSettled(t.map(({result:n})=>n));if(a.length>0){let n=s.flatMap(i=>i.status==="rejected"?[i.reason]:[]);if(n.length>0)throw new AggregateError([...a,...n],"Pipelined generation and in-flight cleanup both failed")}}}var ar=64,td=4;function rd(e){return Math.max(e,Math.min(ar,e*td))}function Wa(e,t,r=t){let a=e.decode_pipeline_depth;return typeof a!="number"||!Number.isFinite(a)||t<=1?t:Math.max(1,Math.min(Math.floor(a),r))}async function ad(e,t,r){for(let a of r){for await(let s of e.streamTokenIdsFromCache({input_ids:[new Array(a).fill(0)],generation_state:{cache:t},max_new_tokens:2,stop_on_eos:!1}));t.truncate(0)}}async function*sd(e,t,r){if(t.length===0)throw new Error("generation requires at least one input token");let{maxNewTokens:a,eosTokenId:s,stopOnEos:n,onPrefillDone:i}=Zc(r,e.eosTokenId!==void 0?{eosTokenId:e.eosTokenId}:{}),u=e.cache,o=g=>n&&Jc(g,s),l=u.get_seq_length(),c=await e.prefill(t,l);if(u.advance(t.length),i?.({tokens:t.length,cache_length:u.get_seq_length()}),a<=0||o(c))return;yield c;let d=1;if(d>=a)return;let f={value:null},p=async g=>f.value??=await e.beginDecode(g,a-d),m=async function*(g){return u.advance(1),o(g)?!0:(yield g,d+=1,d>=a)},h=u.get_seq_length();if(h>=u.maxLength)return;let b=[];try{if(e.pipelineDepth>1){let w=await u.mutableStateCheckpoint?.()??null;if(w){let B=await p(h),F=rd(e.pipelineDepth),z=c,W=h;for(;d<a&&W<u.maxLength;){let Y=Math.min(F,a-d,u.maxLength-W),L=W,N=[z],R=0,$=0,x=!1;w.capture();let _=[];try{yield*Nn({depth:e.pipelineDepth,shouldSubmit:()=>R<Y,submit:()=>{let T=B.submitStep(R===0?z:null,L+R);return R+=1,{result:T}},accept:async function*(T,M){return u.advance(1),$+=1,o(M)?(x=!0,!0):(yield M,d+=1,z=M,N.push(M),!1)}})}catch(T){throw _.push(...T instanceof AggregateError?T.errors:[T]),T}finally{try{if($<R){w.restore();let T=N.slice(0,$);if(B.replayKnownInputs)await B.replayKnownInputs(T,L);else for(let M=0;M<T.length;++M)await B.step(T[M],L+M)}}catch(T){throw _.length>0?new AggregateError([..._,T],"Pipelined decode and cleanup both failed"):T}}if(x)return;W=u.get_seq_length()}return}let y=a-d,q=h,k=0,D=!0,I=await p(h);yield*Nn({depth:e.pipelineDepth,shouldSubmit:()=>k<y&&q<u.maxLength,submit:()=>{let B=I.submitStep(D?c:null,q);return q+=1,k+=1,D=!1,{result:B}},accept:(B,F)=>m(F)});return}let g=c,v=h;for(;d<a&&v<u.maxLength;){let w=await(await p(v)).step(g,v);if(yield*m(w))break;g=w,v=u.get_seq_length()}}catch(g){throw b.push(g),g}finally{try{await f.value?.finish()}catch(g){throw b.length>0?new AggregateError([...b,g],"Token decode and session cleanup both failed"):g}}}function nd(e){let t=e instanceof Promise?e:new Promise((r,a)=>{e.then(r,a)});return t.catch(()=>{}),t}var $t=4,id=class extends Xc{#e;#t=0;constructor(e){super(e)}streamTokens(e,t){return this.model.streamTokenIdsFromCache({input_ids:[e.suffixIds],generation_state:this.generationState,max_new_tokens:e.maxNewTokens,eos_token_id:e.eosTokenId,stop_on_eos:e.stopOnEos,decode_pipeline_depth:t.decodePipelineDepth??this.#e})}get decodePipelineDepth(){return this.#e}get readbackLatencyMs(){return this.#t}async tuneDecodePipeline(e={}){if(this.#t=await qc(this.runtime),e.decodePipelineDepth!==void 0)return this.#e=Wa({decode_pipeline_depth:e.decodePipelineDepth},$t,ar),this.#e;let t=this.contextLength,r=Math.min(ar,t-1);if(r<=$t)return this.#e=$t,$t;let a=await this.calibrateDecodePipeline({baseDepth:$t,maxDepth:r,minSampleTokens:Math.min(24,t)},s=>({decodePipelineDepth:s}));return this.#e=a.depth,a.depth}async benchmark(e,t={}){let r=Wa({decode_pipeline_depth:t.decodePipelineDepth??this.#e},$t,ar);return{...await this.benchmarkFixedTokenIds(this.encodePrompt(e),t.maxNewTokens??128,{decodePipelineDepth:r}),depth:r}}},ud=Object.defineProperty,od=(e,t,r)=>t in e?ud(e,t,{enumerable:!0,configurable:!0,writable:!0,value:r}):e[t]=r,ld=(e,t,r)=>(od(e,typeof t!="symbol"?t+"":t,r),r),E=Object.freeze({Text:"Text",NumericLiteral:"NumericLiteral",StringLiteral:"StringLiteral",Identifier:"Identifier",Equals:"Equals",OpenParen:"OpenParen",CloseParen:"CloseParen",OpenStatement:"OpenStatement",CloseStatement:"CloseStatement",OpenExpression:"OpenExpression",CloseExpression:"CloseExpression",OpenSquareBracket:"OpenSquareBracket",CloseSquareBracket:"CloseSquareBracket",OpenCurlyBracket:"OpenCurlyBracket",CloseCurlyBracket:"CloseCurlyBracket",Comma:"Comma",Dot:"Dot",Colon:"Colon",Pipe:"Pipe",CallOperator:"CallOperator",AdditiveBinaryOperator:"AdditiveBinaryOperator",MultiplicativeBinaryOperator:"MultiplicativeBinaryOperator",ComparisonBinaryOperator:"ComparisonBinaryOperator",UnaryOperator:"UnaryOperator",Comment:"Comment"}),Pe=class{constructor(e,t){this.value=e,this.type=t}};function Wn(e){return/\w/.test(e)}function sr(e){return/[0-9]/.test(e)}function Gn(e){return/\s/.test(e)}var cd=[["{%",E.OpenStatement],["%}",E.CloseStatement],["{{",E.OpenExpression],["}}",E.CloseExpression],["(",E.OpenParen],[")",E.CloseParen],["{",E.OpenCurlyBracket],["}",E.CloseCurlyBracket],["[",E.OpenSquareBracket],["]",E.CloseSquareBracket],[",",E.Comma],[".",E.Dot],[":",E.Colon],["|",E.Pipe],["<=",E.ComparisonBinaryOperator],[">=",E.ComparisonBinaryOperator],["==",E.ComparisonBinaryOperator],["!=",E.ComparisonBinaryOperator],["<",E.ComparisonBinaryOperator],[">",E.ComparisonBinaryOperator],["+",E.AdditiveBinaryOperator],["-",E.AdditiveBinaryOperator],["~",E.AdditiveBinaryOperator],["*",E.MultiplicativeBinaryOperator],["/",E.MultiplicativeBinaryOperator],["%",E.MultiplicativeBinaryOperator],["=",E.Equals]],dd=new Map([["n",`
`],["t","	"],["r","\r"],["b","\b"],["f","\f"],["v","\v"],["'","'"],['"','"'],["\\","\\"]]);function fd(e,t={}){return e.endsWith(`
`)&&(e=e.slice(0,-1)),t.lstrip_blocks&&(e=e.replace(/^[ \t]*({[#%-])/gm,"$1")),t.trim_blocks&&(e=e.replace(/([#%-]})\n/g,"$1")),e.replace(/(\s*){%(-?)\s*(?:end)?generation\s*(-?)%}(\s*)/gs,(r,a,s,n,i)=>(s?"":a)+(n?"":i))}function Rn(e,t={}){let r=[],a=fd(e,t),s=0,n=0,i=l=>{let c="";for(;l(a[s]);){if(a[s]==="\\"){if(++s,s>=a.length)throw new SyntaxError("Unexpected end of input");let d=a[s++],f=dd.get(d);if(f===void 0)throw new SyntaxError(`Unexpected escaped character: ${d}`);c+=f;continue}if(c+=a[s++],s>=a.length)throw new SyntaxError("Unexpected end of input")}return c},u=()=>{let l=r.at(-1);l&&l.type===E.Text&&(l.value=l.value.trimEnd(),l.value===""&&r.pop())},o=()=>{for(;s<a.length&&Gn(a[s]);)++s};e:for(;s<a.length;){let l=r.at(-1)?.type;if(l===void 0||l===E.CloseStatement||l===E.CloseExpression||l===E.Comment){let d="";for(;s<a.length&&!(a[s]==="{"&&(a[s+1]==="%"||a[s+1]==="{"||a[s+1]==="#"));)d+=a[s++];if(d.length>0){r.push(new Pe(d,E.Text));continue}}if(a[s]==="{"&&a[s+1]==="#"){s+=2;let d=a[s]==="-";d&&++s;let f="";for(;a[s]!=="#"||a[s+1]!=="}";){if(s+2>=a.length)throw new SyntaxError("Missing end of comment tag");f+=a[s++]}let p=f.endsWith("-");p&&(f=f.slice(0,-1)),d&&u(),r.push(new Pe(f,E.Comment)),s+=2,p&&o();continue}if(a.slice(s,s+3)==="{%-"){u(),r.push(new Pe("{%",E.OpenStatement)),s+=3;continue}if(a.slice(s,s+3)==="{{-"){u(),r.push(new Pe("{{",E.OpenExpression)),n=0,s+=3;continue}if(i(Gn),a.slice(s,s+3)==="-%}"){r.push(new Pe("%}",E.CloseStatement)),s+=3,o();continue}if(a.slice(s,s+3)==="-}}"){r.push(new Pe("}}",E.CloseExpression)),s+=3,o();continue}let c=a[s];if(c==="-"||c==="+"){let d=r.at(-1)?.type;if(d===E.Text||d===void 0)throw new SyntaxError(`Unexpected character: ${c}`);switch(d){case E.Identifier:case E.NumericLiteral:case E.StringLiteral:case E.CloseParen:case E.CloseSquareBracket:break;default:{++s;let f=i(sr);r.push(new Pe(`${c}${f}`,f.length>0?E.NumericLiteral:E.UnaryOperator));continue}}}for(let[d,f]of cd)if(!(d==="}}"&&n>0)&&a.slice(s,s+d.length)===d){r.push(new Pe(d,f)),f===E.OpenExpression?n=0:f===E.OpenCurlyBracket?++n:f===E.CloseCurlyBracket&&--n,s+=d.length;continue e}if(c==="'"||c==='"'){++s;let d=i(f=>f!==c);r.push(new Pe(d,E.StringLiteral)),++s;continue}if(sr(c)){let d=i(sr);if(r.at(-1)?.type!==E.Dot&&a[s]==="."&&sr(a[s+1])){++s;let f=i(sr);d=`${d}.${f}`}r.push(new Pe(d,E.NumericLiteral));continue}if(Wn(c)){let d=i(Wn);r.push(new Pe(d,E.Identifier));continue}throw new SyntaxError(`Unexpected character: ${c}`)}return r}var Ne=class{type="Statement"},pd=class extends Ne{constructor(e){super(),this.body=e}type="Program"},md=class extends Ne{constructor(e,t,r){super(),this.test=e,this.body=t,this.alternate=r}type="If"},hd=class extends Ne{constructor(e,t,r,a){super(),this.loopvar=e,this.iterable=t,this.body=r,this.defaultBlock=a}type="For"},gd=class extends Ne{type="Break"},wd=class extends Ne{type="Continue"},bd=class extends Ne{constructor(e,t,r){super(),this.assignee=e,this.value=t,this.body=r}type="Set"},vd=class extends Ne{constructor(e,t,r){super(),this.name=e,this.args=t,this.body=r}type="Macro"},_d=class extends Ne{constructor(e){super(),this.value=e}type="Comment"},je=class extends Ne{type="Expression"},yd=class extends je{constructor(e,t,r){super(),this.object=e,this.property=t,this.computed=r}type="MemberExpression"},Hn=class extends je{constructor(e,t){super(),this.callee=e,this.args=t}type="CallExpression"},Ft=class extends je{constructor(e){super(),this.value=e}type="Identifier"},Pt=class extends je{constructor(e){super(),this.value=e}type="Literal"},kd=class extends Pt{type="IntegerLiteral"},xd=class extends Pt{type="FloatLiteral"},Un=class extends Pt{type="StringLiteral"},Sd=class extends Pt{type="ArrayLiteral"},Vn=class extends Pt{type="TupleLiteral"},qd=class extends Pt{type="ObjectLiteral"},nr=class extends je{constructor(e,t,r){super(),this.operator=e,this.left=t,this.right=r}type="BinaryExpression"},Ed=class extends je{constructor(e,t){super(),this.operand=e,this.filter=t}type="FilterExpression"},Td=class extends Ne{constructor(e,t){super(),this.filter=e,this.body=t}type="FilterStatement"},Id=class extends je{constructor(e,t){super(),this.lhs=e,this.test=t}type="SelectExpression"},Ad=class extends je{constructor(e,t,r){super(),this.operand=e,this.negate=t,this.test=r}type="TestExpression"},Bd=class extends je{constructor(e,t){super(),this.operator=e,this.argument=t}type="UnaryExpression"},jd=class extends je{constructor(e=void 0,t=void 0,r=void 0){super(),this.start=e,this.stop=t,this.step=r}type="SliceExpression"},Md=class extends je{constructor(e,t){super(),this.key=e,this.value=t}type="KeywordArgumentExpression"},Dd=class extends je{constructor(e){super(),this.argument=e}type="SpreadExpression"},$d=class extends Ne{constructor(e,t,r){super(),this.call=e,this.callerArgs=t,this.body=r}type="CallStatement"},Fd=class extends je{constructor(e,t,r){super(),this.condition=e,this.trueExpr=t,this.falseExpr=r}type="Ternary"};function Qn(e){let t=new pd([]),r=0;function a(x,_){let T=e[r++];if(!T||T.type!==x)throw new Error(`Parser Error: ${_}. ${T.type} !== ${x}.`);return T}function s(x){if(!o(x))throw new SyntaxError(`Expected ${x}`);++r}function n(){switch(e[r].type){case E.Comment:return new _d(e[r++].value);case E.Text:return l();case E.OpenStatement:return c();case E.OpenExpression:return d();default:throw new SyntaxError(`Unexpected token type: ${e[r].type}`)}}function i(...x){return r+x.length<=e.length&&x.every((_,T)=>_===e[r+T].type)}function u(...x){return e[r]?.type===E.OpenStatement&&e[r+1]?.type===E.Identifier&&x.includes(e[r+1]?.value)}function o(...x){return r+x.length<=e.length&&x.every((_,T)=>e[r+T].type==="Identifier"&&_===e[r+T].value)}function l(){return new Un(a(E.Text,"Expected text token").value)}function c(){if(a(E.OpenStatement,"Expected opening statement token"),e[r].type!==E.Identifier)throw new SyntaxError(`Unknown statement, got ${e[r].type}`);let x=e[r].value,_;switch(x){case"set":++r,_=f();break;case"if":++r,_=p(),a(E.OpenStatement,"Expected {% token"),s("endif"),a(E.CloseStatement,"Expected %} token");break;case"macro":++r,_=m(),a(E.OpenStatement,"Expected {% token"),s("endmacro"),a(E.CloseStatement,"Expected %} token");break;case"for":++r,_=b(),a(E.OpenStatement,"Expected {% token"),s("endfor"),a(E.CloseStatement,"Expected %} token");break;case"call":{++r;let T=null;i(E.OpenParen)&&(T=F());let M=$();if(M.type!=="Identifier")throw new SyntaxError("Expected identifier following call statement");let ie=F();a(E.CloseStatement,"Expected closing statement token");let Te=[];for(;!u("endcall");)Te.push(n());a(E.OpenStatement,"Expected '{%'"),s("endcall"),a(E.CloseStatement,"Expected closing statement token");let Ue=new Hn(M,ie);_=new $d(Ue,T,Te);break}case"break":++r,a(E.CloseStatement,"Expected closing statement token"),_=new gd;break;case"continue":++r,a(E.CloseStatement,"Expected closing statement token"),_=new wd;break;case"filter":{++r;let T=$();T instanceof Ft&&i(E.OpenParen)&&(T=B(T)),a(E.CloseStatement,"Expected closing statement token");let M=[];for(;!u("endfilter");)M.push(n());a(E.OpenStatement,"Expected '{%'"),s("endfilter"),a(E.CloseStatement,"Expected '%}'"),_=new Td(T,M);break}default:throw new SyntaxError(`Unknown statement type: ${x}`)}return _}function d(){a(E.OpenExpression,"Expected opening expression token");let x=g();return a(E.CloseExpression,"Expected closing expression token"),x}function f(){let x=h(),_=null,T=[];if(i(E.Equals))++r,_=h();else{for(a(E.CloseStatement,"Expected %} token");!u("endset");)T.push(n());a(E.OpenStatement,"Expected {% token"),s("endset")}return a(E.CloseStatement,"Expected closing statement token"),new bd(x,_,T)}function p(){let x=g();a(E.CloseStatement,"Expected closing statement token");let _=[],T=[];for(;!u("elif","else","endif");)_.push(n());if(u("elif")){++r,++r;let M=p();T.push(M)}else if(u("else"))for(++r,++r,a(E.CloseStatement,"Expected closing statement token");!u("endif");)T.push(n());return new md(x,_,T)}function m(){let x=$();if(x.type!=="Identifier")throw new SyntaxError("Expected identifier following macro statement");let _=F();a(E.CloseStatement,"Expected closing statement token");let T=[];for(;!u("endmacro");)T.push(n());return new vd(x,_,T)}function h(x=!1){let _=x?$:g,T=[_()],M=i(E.Comma);for(;M&&(++r,T.push(_()),!!i(E.Comma)););return M?new Vn(T):T[0]}function b(){let x=h(!0);if(!(x instanceof Ft||x instanceof Vn))throw new SyntaxError(`Expected identifier/tuple for the loop variable, got ${x.type} instead`);if(!o("in"))throw new SyntaxError("Expected `in` keyword following loop variable");++r;let _=g();a(E.CloseStatement,"Expected closing statement token");let T=[];for(;!u("endfor","else");)T.push(n());let M=[];if(u("else"))for(++r,++r,a(E.CloseStatement,"Expected closing statement token");!u("endfor");)M.push(n());return new hd(x,_,T,M)}function g(){return v()}function v(){let x=w();if(o("if")){++r;let _=w();if(o("else")){++r;let T=v();return new Fd(_,x,T)}else return new Id(x,_)}return x}function w(){let x=y();for(;o("or");){let _=e[r];++r;let T=y();x=new nr(_,x,T)}return x}function y(){let x=q();for(;o("and");){let _=e[r];++r;let T=q();x=new nr(_,x,T)}return x}function q(){let x;for(;o("not");){let _=e[r];++r;let T=q();x=new Bd(_,T)}return x??k()}function k(){let x=D();for(;;){let _;if(o("not","in"))_=new Pe("not in",E.Identifier),r+=2;else if(o("in"))_=e[r++];else if(i(E.ComparisonBinaryOperator))_=e[r++];else break;let T=D();x=new nr(_,x,T)}return x}function D(){let x=L();for(;i(E.AdditiveBinaryOperator);){let _=e[r];++r;let T=L();x=new nr(_,x,T)}return x}function I(){let x=Y($());return i(E.OpenParen)?B(x):x}function B(x){let _=new Hn(x,F());return _=Y(_),i(E.OpenParen)&&(_=B(_)),_}function F(){a(E.OpenParen,"Expected opening parenthesis for arguments list");let x=z();return a(E.CloseParen,"Expected closing parenthesis for arguments list"),x}function z(){let x=[];for(;!i(E.CloseParen);){let _;if(e[r].type===E.MultiplicativeBinaryOperator&&e[r].value==="*"){++r;let T=g();_=new Dd(T)}else if(_=g(),i(E.Equals)){if(++r,!(_ instanceof Ft))throw new SyntaxError("Expected identifier for keyword argument");let T=g();_=new Md(_,T)}x.push(_),i(E.Comma)&&++r}return x}function W(){let x=[],_=!1;for(;!i(E.CloseSquareBracket);)i(E.Colon)?(x.push(void 0),++r,_=!0):(x.push(g()),i(E.Colon)&&(++r,_=!0));if(x.length===0)throw new SyntaxError("Expected at least one argument for member/slice expression");if(_){if(x.length>3)throw new SyntaxError("Expected 0-3 arguments for slice expression");return new jd(...x)}return x[0]}function Y(x){for(;i(E.Dot)||i(E.OpenSquareBracket);){let _=e[r];++r;let T,M=_.type===E.OpenSquareBracket;if(M)T=W(),a(E.CloseSquareBracket,"Expected closing square bracket");else if(T=$(),T.type!=="Identifier"&&T.type!=="IntegerLiteral")throw new SyntaxError("Expected identifier or integer following dot operator");x=new yd(x,T,M)}return x}function L(){let x=N();for(;i(E.MultiplicativeBinaryOperator);){let _=e[r++],T=N();x=new nr(_,x,T)}return x}function N(){let x=R();for(;o("is");){++r;let _=o("not");_&&++r;let T=$();if(!(T instanceof Ft))throw new SyntaxError("Expected identifier for the test");x=new Ad(x,_,T)}return x}function R(){let x=I();for(;i(E.Pipe);){++r;let _=$();if(!(_ instanceof Ft))throw new SyntaxError("Expected identifier for the filter");i(E.OpenParen)&&(_=B(_)),x=new Ed(x,_)}return x}function $(){let x=e[r++];switch(x.type){case E.NumericLiteral:{let _=x.value;return _.includes(".")?new xd(Number(_)):new kd(Number(_))}case E.StringLiteral:{let _=x.value;for(;i(E.StringLiteral);)_+=e[r++].value;return new Un(_)}case E.Identifier:return new Ft(x.value);case E.OpenParen:{let _=h();return a(E.CloseParen,"Expected closing parenthesis, got ${tokens[current].type} instead."),_}case E.OpenSquareBracket:{let _=[];for(;!i(E.CloseSquareBracket);)_.push(g()),i(E.Comma)&&++r;return++r,new Sd(_)}case E.OpenCurlyBracket:{let _=new Map;for(;!i(E.CloseCurlyBracket);){let T=g();a(E.Colon,"Expected colon between key and value in object literal");let M=g();_.set(T,M),i(E.Comma)&&++r}return++r,new qd(_)}default:throw new SyntaxError(`Unexpected token: ${x.type}`)}}for(;r<e.length;)t.body.push(n());return t}function Pd(e,t,r=1){if(t===void 0&&(t=e,e=0),r===0)throw new Error("range() step must not be zero");let a=[];if(r>0)for(let s=e;s<t;s+=r)a.push(s);else for(let s=e;s>t;s+=r)a.push(s);return a}function Kn(e,t,r,a=1){let s=Math.sign(a);s>=0?(t=(t??=0)<0?Math.max(e.length+t,0):Math.min(t,e.length),r=(r??=e.length)<0?Math.max(e.length+r,0):Math.min(r,e.length)):(t=(t??=e.length-1)<0?Math.max(e.length+t,-1):Math.min(t,e.length-1),r=(r??=-1)<-1?Math.max(e.length+r,-1):Math.min(r,e.length-1));let n=[];for(let i=t;s*i<s*r;i+=a)n.push(e[i]);return n}function Cd(e){return e.replace(/\b\w/g,t=>t.toUpperCase())}function Ld(e){return zd(new Date,e)}function zd(e,t){let r=new Intl.DateTimeFormat(void 0,{month:"long"}),a=new Intl.DateTimeFormat(void 0,{month:"short"}),s=n=>n<10?"0"+n:n.toString();return t.replace(/%[YmdbBHM%]/g,n=>{switch(n){case"%Y":return e.getFullYear().toString();case"%m":return s(e.getMonth()+1);case"%d":return s(e.getDate());case"%b":return a.format(e);case"%B":return r.format(e);case"%H":return s(e.getHours());case"%M":return s(e.getMinutes());case"%%":return"%";default:return n}})}function Od(e){return e.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}function Nd(e,t,r,a){if(a===0)return e;let s=a==null||a<0?1/0:a,n=t.length===0?new RegExp("(?=)","gu"):new RegExp(Od(t),"gu");return e.replaceAll(n,i=>s>0?(--s,r):i)}var Xn=class extends Error{},Yn=class extends Error{},Wd=new Map,Ye=class{type="RuntimeValue";value;get builtins(){return Wd}constructor(e=void 0){this.value=e}__bool__(){return new G(!!this.value)}toString(){return String(this.value)}},H=class extends Ye{type="IntegerValue"},oe=class extends Ye{type="FloatValue";toString(){return this.value%1===0?this.value.toFixed(1):this.value.toString()}},P=class extends Ye{type="StringValue";_builtins;get builtins(){return this._builtins??=new Map([["upper",new te(()=>new P(this.value.toUpperCase()))],["lower",new te(()=>new P(this.value.toLowerCase()))],["strip",new te(()=>new P(this.value.trim()))],["title",new te(()=>new P(Cd(this.value)))],["capitalize",new te(()=>new P(this.value.charAt(0).toUpperCase()+this.value.slice(1)))],["length",new H(this.value.length)],["rstrip",new te(()=>new P(this.value.trimEnd()))],["lstrip",new te(()=>new P(this.value.trimStart()))],["startswith",new te(e=>{if(e.length===0)throw new Error("startswith() requires at least one argument");let t=e[0];if(t instanceof P)return new G(this.value.startsWith(t.value));if(t instanceof V){for(let r of t.value){if(!(r instanceof P))throw new Error("startswith() tuple elements must be strings");if(this.value.startsWith(r.value))return new G(!0)}return new G(!1)}throw new Error("startswith() argument must be a string or tuple of strings")})],["endswith",new te(e=>{if(e.length===0)throw new Error("endswith() requires at least one argument");let t=e[0];if(t instanceof P)return new G(this.value.endsWith(t.value));if(t instanceof V){for(let r of t.value){if(!(r instanceof P))throw new Error("endswith() tuple elements must be strings");if(this.value.endsWith(r.value))return new G(!0)}return new G(!1)}throw new Error("endswith() argument must be a string or tuple of strings")})],["split",new te(e=>{let t=e[0]??new se;if(!(t instanceof P||t instanceof se))throw new Error("sep argument must be a string or null");let r=e[1]??new H(-1);if(!(r instanceof H))throw new Error("maxsplit argument must be a number");let a=[];if(t instanceof se){let s=this.value.trimStart();for(let{0:n,index:i}of s.matchAll(/\S+/g)){if(r.value!==-1&&a.length>=r.value&&i!==void 0){a.push(n+s.slice(i+n.length));break}a.push(n)}}else{if(t.value==="")throw new Error("empty separator");a=this.value.split(t.value),r.value!==-1&&a.length>r.value&&a.push(a.splice(r.value).join(t.value))}return new V(a.map(s=>new P(s)))})],["replace",new te(e=>{if(e.length<2)throw new Error("replace() requires at least two arguments");let t=e[0],r=e[1];if(!(t instanceof P&&r instanceof P))throw new Error("replace() arguments must be strings");let a;if(e.length>2?e[2].type==="KeywordArgumentsValue"?a=e[2].value.get("count")??new se:a=e[2]:a=new se,!(a instanceof H||a instanceof se))throw new Error("replace() count argument must be a number or null");return new P(Nd(this.value,t.value,r.value,a.value))})]])}},G=class extends Ye{type="BooleanValue"},Gd=/[\x7f-\uffff]/g;function Zn(e){return e.replace(Gd,t=>"\\u"+t.charCodeAt(0).toString(16).padStart(4,"0"))}function wt(e,t={},r=0,a=!0){let{indent:s=null,ensureAscii:n=!1,separators:i=null,sortKeys:u=!1}=t,o,l;switch(i?[o,l]=i:s?(o=",",l=": "):(o=", ",l=": "),e.type){case"NullValue":return"null";case"UndefinedValue":return a?"null":"undefined";case"IntegerValue":case"FloatValue":case"BooleanValue":return JSON.stringify(e.value);case"StringValue":{let c=JSON.stringify(e.value);return n&&(c=Zn(c)),c}case"ArrayValue":case"ObjectValue":{let c=s?" ".repeat(s):"",d=`
`+c.repeat(r),f=d+c;if(e.type==="ArrayValue"){let p=e.value.map(m=>wt(m,t,r+1,a));return s?`[${f}${p.join(`${o}${f}`)}${d}]`:`[${p.join(o)}]`}else{let p=Array.from(e.value.entries());u&&(p=p.sort(([h],[b])=>h.localeCompare(b)));let m=p.map(([h,b])=>{let g=JSON.stringify(h);n&&(g=Zn(g));let v=`${g}${l}${wt(b,t,r+1,a)}`;return s?`${f}${v}`:v});return s?`{${m.join(o)}${d}}`:`{${m.join(o)}}`}}default:throw new Error(`Cannot convert to JSON: ${e.type}`)}}var me=class extends Ye{type="ObjectValue";_builtins;__bool__(){return new G(this.value.size>0)}get builtins(){return this._builtins??=new Map([["get",new te(([e,t])=>{if(!(e instanceof P))throw new Error(`Object key must be a string: got ${e.type}`);return this.value.get(e.value)??t??new se})],["items",new te(()=>this.items())],["keys",new te(()=>this.keys())],["values",new te(()=>this.values())],["dictsort",new te(e=>{let t=new Map,r=e.filter(u=>u instanceof ir?(t=u.value,!1):!0),a=r.at(0)??t.get("case_sensitive")??new G(!1);if(!(a instanceof G))throw new Error("case_sensitive must be a boolean");let s=r.at(1)??t.get("by")??new P("key");if(!(s instanceof P))throw new Error("by must be a string");if(!["key","value"].includes(s.value))throw new Error("by must be either 'key' or 'value'");let n=r.at(2)??t.get("reverse")??new G(!1);if(!(n instanceof G))throw new Error("reverse must be a boolean");let i=Array.from(this.value.entries()).map(([u,o])=>new V([new P(u),o])).sort((u,o)=>{let l=s.value==="key"?0:1,c=u.value[l],d=o.value[l],f=Ga(c,d,a.value);return n.value?-f:f});return new V(i)})]])}items(){return new V(Array.from(this.value.entries()).map(([e,t])=>new V([new P(e),t])))}keys(){return new V(Array.from(this.value.keys()).map(e=>new P(e)))}values(){return new V(Array.from(this.value.values()))}toString(){return wt(this,{},0,!1)}},ir=class extends me{type="KeywordArgumentsValue"},V=class extends Ye{type="ArrayValue";_builtins;get builtins(){return this._builtins??=new Map([["length",new H(this.value.length)]])}__bool__(){return new G(this.value.length>0)}toString(){return wt(this,{},0,!1)}},Jn=class extends V{type="TupleValue"},te=class extends Ye{type="FunctionValue"},se=class extends Ye{type="NullValue"},re=class extends Ye{type="UndefinedValue"},ei=class{constructor(e){this.parent=e}variables=new Map([["namespace",new te(e=>{if(e.length===0)return new me(new Map);if(e.length!==1||!(e[0]instanceof me))throw new Error("`namespace` expects either zero arguments or a single object argument");return e[0]})]]);tests=ei.TESTS;set(e,t){return this.declareVariable(e,Lr(t))}declareVariable(e,t){if(this.variables.has(e))throw new SyntaxError(`Variable already declared: ${e}`);return this.variables.set(e,t),t}setVariable(e,t){return this.variables.set(e,t),t}resolve(e){if(this.variables.has(e))return this;if(this.parent)return this.parent.resolve(e);throw new Error(`Unknown variable: ${e}`)}lookupVariable(e){try{return this.resolve(e).variables.get(e)??new re}catch{return new re}}},at=ei;ld(at,"TESTS",new Map([["boolean",e=>e.type==="BooleanValue"],["callable",e=>e instanceof te],["odd",e=>{if(!(e instanceof H))throw new Error(`cannot odd on ${e.type}`);return e.value%2!==0}],["even",e=>{if(!(e instanceof H))throw new Error(`cannot even on ${e.type}`);return e.value%2===0}],["false",e=>e.type==="BooleanValue"&&!e.value],["true",e=>e.type==="BooleanValue"&&e.value],["none",e=>e.type==="NullValue"],["string",e=>e.type==="StringValue"],["number",e=>e instanceof H||e instanceof oe],["integer",e=>e instanceof H],["iterable",e=>e.type==="ArrayValue"||e.type==="StringValue"],["mapping",e=>e instanceof me],["sequence",e=>e instanceof V||e instanceof me||e instanceof P],["lower",e=>{let t=e.value;return e.type==="StringValue"&&t===t.toLowerCase()}],["upper",e=>{let t=e.value;return e.type==="StringValue"&&t===t.toUpperCase()}],["none",e=>e.type==="NullValue"],["defined",e=>e.type!=="UndefinedValue"],["undefined",e=>e.type==="UndefinedValue"],["equalto",(e,t)=>e.value===t.value],["eq",(e,t)=>e.value===t.value]]));function Rd(e){e.set("false",!1),e.set("true",!0),e.set("none",null),e.set("raise_exception",t=>{throw new Error(t)}),e.set("range",Pd),e.set("strftime_now",Ld),e.set("True",!0),e.set("False",!1),e.set("None",null)}function ti(e,t){let r=t.split("."),a=e;for(let s of r)if(a instanceof me)a=a.value.get(s)??new re;else if(a instanceof V){let n=parseInt(s,10);if(!isNaN(n)&&n>=0&&n<a.value.length)a=a.value[n];else return new re}else return new re;return a}function Ga(e,t,r=!1){if(e instanceof se&&t instanceof se)return 0;if(e instanceof se||t instanceof se)throw new Error(`Cannot compare ${e.type} with ${t.type}`);if(e instanceof re&&t instanceof re)return 0;if(e instanceof re||t instanceof re)throw new Error(`Cannot compare ${e.type} with ${t.type}`);let a=n=>n instanceof H||n instanceof oe||n instanceof G,s=n=>n instanceof G?n.value?1:0:n.value;if(a(e)&&a(t)){let n=s(e),i=s(t);return n<i?-1:n>i?1:0}if(e.type!==t.type)throw new Error(`Cannot compare different types: ${e.type} and ${t.type}`);if(e.type==="StringValue"){let n=e.value,i=t.value;return r||(n=n.toLowerCase(),i=i.toLowerCase()),n<i?-1:n>i?1:0}else throw new Error(`Cannot compare type: ${e.type}`)}var ri=class{global;constructor(e){this.global=e??new at}run(e){return this.evaluate(e,this.global)}evaluateBinaryExpression(e,t){let r=this.evaluate(e.left,t);switch(e.operator.value){case"and":return r.__bool__().value?this.evaluate(e.right,t):r;case"or":return r.__bool__().value?r:this.evaluate(e.right,t)}let a=this.evaluate(e.right,t);switch(e.operator.value){case"==":return new G(r.value==a.value);case"!=":return new G(r.value!=a.value)}if(r instanceof re||a instanceof re){if(a instanceof re&&["in","not in"].includes(e.operator.value))return new G(e.operator.value==="not in");throw new Error(`Cannot perform operation ${e.operator.value} on undefined values`)}else{if(r instanceof se||a instanceof se)throw new Error("Cannot perform operation on null values");if(e.operator.value==="~")return new P(r.value.toString()+a.value.toString());if((r instanceof H||r instanceof oe)&&(a instanceof H||a instanceof oe)){let s=r.value,n=a.value;switch(e.operator.value){case"+":case"-":case"*":{let i=e.operator.value==="+"?s+n:e.operator.value==="-"?s-n:s*n;return r instanceof oe||a instanceof oe?new oe(i):new H(i)}case"/":return new oe(s/n);case"%":{let i=s%n;return r instanceof oe||a instanceof oe?new oe(i):new H(i)}case"<":return new G(s<n);case">":return new G(s>n);case">=":return new G(s>=n);case"<=":return new G(s<=n)}}else if(r instanceof V&&a instanceof V){if(e.operator.value==="+")return new V(r.value.concat(a.value))}else if(a instanceof V){let s=a.value.find(n=>n.value===r.value)!==void 0;switch(e.operator.value){case"in":return new G(s);case"not in":return new G(!s)}}}if((r instanceof P||a instanceof P)&&e.operator.value==="+")return new P(r.value.toString()+a.value.toString());if(r instanceof P&&a instanceof P)switch(e.operator.value){case"in":return new G(a.value.includes(r.value));case"not in":return new G(!a.value.includes(r.value))}if(r instanceof P&&a instanceof me)switch(e.operator.value){case"in":return new G(a.value.has(r.value));case"not in":return new G(!a.value.has(r.value))}throw new SyntaxError(`Unknown operator "${e.operator.value}" between ${r.type} and ${a.type}`)}evaluateArguments(e,t){let r=[],a=new Map;for(let s of e)if(s.type==="SpreadExpression"){let n=s,i=this.evaluate(n.argument,t);if(!(i instanceof V))throw new Error(`Cannot unpack non-iterable type: ${i.type}`);for(let u of i.value)r.push(u)}else if(s.type==="KeywordArgumentExpression"){let n=s;a.set(n.key.value,this.evaluate(n.value,t))}else{if(a.size>0)throw new Error("Positional arguments must come before keyword arguments");r.push(this.evaluate(s,t))}return[r,a]}applyFilter(e,t,r){if(t.type==="Identifier"){let a=t;if(a.value==="safe")return e;if(a.value==="tojson")return new P(wt(e,{}));if(e instanceof V)switch(a.value){case"list":return e;case"first":return e.value[0];case"last":return e.value[e.value.length-1];case"length":return new H(e.value.length);case"reverse":return new V(e.value.slice().reverse());case"sort":return new V(e.value.slice().sort((s,n)=>Ga(s,n,!1)));case"join":return new P(e.value.map(s=>s.value).join(""));case"string":return new P(wt(e,{},0,!1));case"unique":{let s=new Set,n=[];for(let i of e.value)s.has(i.value)||(s.add(i.value),n.push(i));return new V(n)}default:throw new Error(`Unknown ArrayValue filter: ${a.value}`)}else if(e instanceof P)switch(a.value){case"length":case"upper":case"lower":case"title":case"capitalize":{let s=e.builtins.get(a.value);if(s instanceof te)return s.value([],r);if(s instanceof H)return s;throw new Error(`Unknown StringValue filter: ${a.value}`)}case"trim":return new P(e.value.trim());case"indent":return new P(e.value.split(`
`).map((s,n)=>n===0||s.length===0?s:"    "+s).join(`
`));case"join":case"string":return e;case"int":{let s=parseInt(e.value,10);return new H(isNaN(s)?0:s)}case"float":{let s=parseFloat(e.value);return new oe(isNaN(s)?0:s)}default:throw new Error(`Unknown StringValue filter: ${a.value}`)}else if(e instanceof H||e instanceof oe)switch(a.value){case"abs":return e instanceof H?new H(Math.abs(e.value)):new oe(Math.abs(e.value));case"int":return new H(Math.floor(e.value));case"float":return new oe(e.value);case"string":return new P(e.toString());default:throw new Error(`Unknown NumericValue filter: ${a.value}`)}else if(e instanceof me)switch(a.value){case"items":return new V(Array.from(e.value.entries()).map(([s,n])=>new V([new P(s),n])));case"length":return new H(e.value.size);default:{let s=e.builtins.get(a.value);if(s)return s instanceof te?s.value([],r):s;throw new Error(`Unknown ObjectValue filter: ${a.value}`)}}else if(e instanceof G)switch(a.value){case"bool":return new G(e.value);case"int":return new H(e.value?1:0);case"float":return new oe(e.value?1:0);case"string":return new P(e.value?"true":"false");default:throw new Error(`Unknown BooleanValue filter: ${a.value}`)}throw new Error(`Cannot apply filter "${a.value}" to type: ${e.type}`)}else if(t.type==="CallExpression"){let a=t;if(a.callee.type!=="Identifier")throw new Error(`Unknown filter: ${a.callee.type}`);let s=a.callee.value;if(s==="tojson"){let[,n]=this.evaluateArguments(a.args,r),i=n.get("indent")??new se;if(!(i instanceof H||i instanceof se))throw new Error("If set, indent must be a number");let u=n.get("ensure_ascii")??new G(!1);if(!(u instanceof G))throw new Error("If set, ensure_ascii must be a boolean");let o=n.get("sort_keys")??new G(!1);if(!(o instanceof G))throw new Error("If set, sort_keys must be a boolean");let l=n.get("separators")??new se,c=null;if(l instanceof V||l instanceof Jn){if(l.value.length!==2)throw new Error("separators must be a tuple of two strings");let[d,f]=l.value;if(!(d instanceof P)||!(f instanceof P))throw new Error("separators must be a tuple of two strings");c=[d.value,f.value]}else if(!(l instanceof se))throw new Error("If set, separators must be a tuple of two strings");return new P(wt(e,{indent:i.value,ensureAscii:u.value,sortKeys:o.value,separators:c}))}else if(s==="join"){let n;if(e instanceof P)n=Array.from(e.value);else if(e instanceof V)n=e.value.map(l=>l.value);else throw new Error(`Cannot apply filter "${s}" to type: ${e.type}`);let[i,u]=this.evaluateArguments(a.args,r),o=i.at(0)??u.get("separator")??new P("");if(!(o instanceof P))throw new Error("separator must be a string");return new P(n.join(o.value))}else if(s==="int"||s==="float"){let[n,i]=this.evaluateArguments(a.args,r),u=n.at(0)??i.get("default")??(s==="int"?new H(0):new oe(0));if(e instanceof P){let o=s==="int"?parseInt(e.value,10):parseFloat(e.value);return isNaN(o)?u:s==="int"?new H(o):new oe(o)}else{if(e instanceof H||e instanceof oe)return e;if(e instanceof G)return s==="int"?new H(e.value?1:0):new oe(e.value?1:0);throw new Error(`Cannot apply filter "${s}" to type: ${e.type}`)}}else if(s==="default"){let[n,i]=this.evaluateArguments(a.args,r),u=n[0]??new P(""),o=n[1]??i.get("boolean")??new G(!1);if(!(o instanceof G))throw new Error("`default` filter flag must be a boolean");return e instanceof re||o.value&&!e.__bool__().value?u:e}if(e instanceof V){switch(s){case"sort":{let[n,i]=this.evaluateArguments(a.args,r),u=n.at(0)??i.get("reverse")??new G(!1);if(!(u instanceof G))throw new Error("reverse must be a boolean");let o=n.at(1)??i.get("case_sensitive")??new G(!1);if(!(o instanceof G))throw new Error("case_sensitive must be a boolean");let l=n.at(2)??i.get("attribute")??new se;if(!(l instanceof P||l instanceof H||l instanceof se))throw new Error("attribute must be a string, integer, or null");let c=d=>{if(l instanceof se)return d;let f=l instanceof H?String(l.value):l.value;return ti(d,f)};return new V(e.value.slice().sort((d,f)=>{let p=c(d),m=c(f),h=Ga(p,m,o.value);return u.value?-h:h}))}case"selectattr":case"rejectattr":{let n=s==="selectattr";if(e.value.some(d=>!(d instanceof me)))throw new Error(`\`${s}\` can only be applied to array of objects`);if(a.args.some(d=>d.type!=="StringLiteral"))throw new Error(`arguments of \`${s}\` must be strings`);let[i,u,o]=a.args.map(d=>this.evaluate(d,r)),l;if(u){let d=r.tests.get(u.value);if(!d)throw new Error(`Unknown test: ${u.value}`);l=d}else l=(...d)=>d[0].__bool__().value;let c=e.value.filter(d=>{let f=d.value.get(i.value),p=f?l(f,o):!1;return n?p:!p});return new V(c)}case"map":{let[,n]=this.evaluateArguments(a.args,r);if(n.has("attribute")){let i=n.get("attribute");if(!(i instanceof P))throw new Error("attribute must be a string");let u=n.get("default"),o=e.value.map(l=>{if(!(l instanceof me))throw new Error("items in map must be an object");let c=ti(l,i.value);return c instanceof re?u??new re:c});return new V(o)}else throw new Error("`map` expressions without `attribute` set are not currently supported.")}}throw new Error(`Unknown ArrayValue filter: ${s}`)}else if(e instanceof P){switch(s){case"indent":{let[n,i]=this.evaluateArguments(a.args,r),u=n.at(0)??i.get("width")??new H(4);if(!(u instanceof H))throw new Error("width must be a number");let o=n.at(1)??i.get("first")??new G(!1),l=n.at(2)??i.get("blank")??new G(!1),c=e.value.split(`
`),d=" ".repeat(u.value),f=c.map((p,m)=>!o.value&&m===0||!l.value&&p.length===0?p:d+p);return new P(f.join(`
`))}case"replace":{let n=e.builtins.get("replace");if(!(n instanceof te))throw new Error("replace filter not available");let[i,u]=this.evaluateArguments(a.args,r);return n.value([...i,new ir(u)],r)}}throw new Error(`Unknown StringValue filter: ${s}`)}else if(e instanceof me){let n=e.builtins.get(s);if(n&&n instanceof te){let[i,u]=this.evaluateArguments(a.args,r);return u.size>0&&i.push(new ir(u)),n.value(i,r)}throw new Error(`Unknown ObjectValue filter: ${s}`)}else throw new Error(`Cannot apply filter "${s}" to type: ${e.type}`)}throw new Error(`Unknown filter: ${t.type}`)}evaluateFilterExpression(e,t){let r=this.evaluate(e.operand,t);return this.applyFilter(r,e.filter,t)}evaluateTestExpression(e,t){let r=this.evaluate(e.operand,t),a=t.tests.get(e.test.value);if(!a)throw new Error(`Unknown test: ${e.test.value}`);let s=a(r);return new G(e.negate?!s:s)}evaluateSelectExpression(e,t){return this.evaluate(e.test,t).__bool__().value?this.evaluate(e.lhs,t):new re}evaluateUnaryExpression(e,t){let r=this.evaluate(e.argument,t);if(e.operator.value==="not")return new G(!r.value);throw new SyntaxError(`Unknown operator: ${e.operator.value}`)}evaluateTernaryExpression(e,t){return this.evaluate(e.condition,t).__bool__().value?this.evaluate(e.trueExpr,t):this.evaluate(e.falseExpr,t)}evalProgram(e,t){return this.evaluateBlock(e.body,t)}evaluateBlock(e,t){let r="";for(let a of e){let s=this.evaluate(a,t);s.type!=="NullValue"&&s.type!=="UndefinedValue"&&(r+=s.toString())}return new P(r)}evaluateIdentifier(e,t){return t.lookupVariable(e.value)}evaluateCallExpression(e,t){let[r,a]=this.evaluateArguments(e.args,t);a.size>0&&r.push(new ir(a));let s=this.evaluate(e.callee,t);if(s.type!=="FunctionValue")throw new Error(`Cannot call something that is not a function: got ${s.type}`);return s.value(r,t)}evaluateSliceExpression(e,t,r){if(!(e instanceof V||e instanceof P))throw new Error("Slice object must be an array or string");let a=this.evaluate(t.start,r),s=this.evaluate(t.stop,r),n=this.evaluate(t.step,r);if(!(a instanceof H||a instanceof re))throw new Error("Slice start must be numeric or undefined");if(!(s instanceof H||s instanceof re))throw new Error("Slice stop must be numeric or undefined");if(!(n instanceof H||n instanceof re))throw new Error("Slice step must be numeric or undefined");return e instanceof V?new V(Kn(e.value,a.value,s.value,n.value)):new P(Kn(Array.from(e.value),a.value,s.value,n.value).join(""))}evaluateMemberExpression(e,t){let r=this.evaluate(e.object,t),a;if(e.computed){if(e.property.type==="SliceExpression")return this.evaluateSliceExpression(r,e.property,t);a=this.evaluate(e.property,t)}else e.property.type==="IntegerLiteral"?a=new H(e.property.value):a=new P(e.property.value);let s;if(r instanceof me){if(!(a instanceof P))throw new Error(`Cannot access property with non-string: got ${a.type}`);s=r.value.get(a.value)??r.builtins.get(a.value)}else if(r instanceof V||r instanceof P)if(a instanceof H)s=r.value.at(a.value),r instanceof P&&(s=new P(r.value.at(a.value)));else if(a instanceof P)s=r.builtins.get(a.value);else throw new Error(`Cannot access property with non-string/non-number: got ${a.type}`);else{if(!(a instanceof P))throw new Error(`Cannot access property with non-string: got ${a.type}`);s=r.builtins.get(a.value)}return s instanceof Ye?s:new re}evaluateSet(e,t){let r=e.value?this.evaluate(e.value,t):this.evaluateBlock(e.body,t);if(e.assignee.type==="Identifier"){let a=e.assignee.value;t.setVariable(a,r)}else if(e.assignee.type==="TupleLiteral"){let a=e.assignee;if(!(r instanceof V))throw new Error(`Cannot unpack non-iterable type in set: ${r.type}`);let s=r.value;if(s.length!==a.value.length)throw new Error(`Too ${a.value.length>s.length?"few":"many"} items to unpack in set`);for(let n=0;n<a.value.length;++n){let i=a.value[n];if(i.type!=="Identifier")throw new Error(`Cannot unpack to non-identifier in set: ${i.type}`);t.setVariable(i.value,s[n])}}else if(e.assignee.type==="MemberExpression"){let a=e.assignee,s=this.evaluate(a.object,t);if(!(s instanceof me))throw new Error("Cannot assign to member of non-object");if(a.property.type!=="Identifier")throw new Error("Cannot assign to member with non-identifier property");s.value.set(a.property.value,r)}else throw new Error(`Invalid LHS inside assignment expression: ${JSON.stringify(e.assignee)}`);return new se}evaluateIf(e,t){let r=this.evaluate(e.test,t);return this.evaluateBlock(r.__bool__().value?e.body:e.alternate,t)}evaluateFor(e,t){let r=new at(t),a,s;if(e.iterable.type==="SelectExpression"){let l=e.iterable;s=this.evaluate(l.lhs,r),a=l.test}else s=this.evaluate(e.iterable,r);if(!(s instanceof V||s instanceof me))throw new Error(`Expected iterable or object type in for loop: got ${s.type}`);s instanceof me&&(s=s.keys());let n=[],i=[];for(let l=0;l<s.value.length;++l){let c=new at(r),d=s.value[l],f;if(e.loopvar.type==="Identifier")f=p=>p.setVariable(e.loopvar.value,d);else if(e.loopvar.type==="TupleLiteral"){let p=e.loopvar;if(d.type!=="ArrayValue")throw new Error(`Cannot unpack non-iterable type: ${d.type}`);let m=d;if(p.value.length!==m.value.length)throw new Error(`Too ${p.value.length>m.value.length?"few":"many"} items to unpack`);f=h=>{for(let b=0;b<p.value.length;++b){if(p.value[b].type!=="Identifier")throw new Error(`Cannot unpack non-identifier type: ${p.value[b].type}`);h.setVariable(p.value[b].value,m.value[b])}}}else throw new Error(`Invalid loop variable(s): ${e.loopvar.type}`);a&&(f(c),!this.evaluate(a,c).__bool__().value)||(n.push(d),i.push(f))}let u="",o=!0;for(let l=0;l<n.length;++l){let c=new Map([["index",new H(l+1)],["index0",new H(l)],["revindex",new H(n.length-l)],["revindex0",new H(n.length-l-1)],["first",new G(l===0)],["last",new G(l===n.length-1)],["length",new H(n.length)],["previtem",l>0?n[l-1]:new re],["nextitem",l<n.length-1?n[l+1]:new re]]);r.setVariable("loop",new me(c)),i[l](r);try{let d=this.evaluateBlock(e.body,r);u+=d.value}catch(d){if(d instanceof Yn)continue;if(d instanceof Xn)break;throw d}o=!1}if(o){let l=this.evaluateBlock(e.defaultBlock,r);u+=l.value}return new P(u)}evaluateMacro(e,t){return t.setVariable(e.name.value,new te((r,a)=>{let s=new at(a);r=r.slice();let n;r.at(-1)?.type==="KeywordArgumentsValue"&&(n=r.pop());for(let i=0;i<e.args.length;++i){let u=e.args[i],o=r[i];if(u.type==="Identifier"){let l=u;if(!o)throw new Error(`Missing positional argument: ${l.value}`);s.setVariable(l.value,o)}else if(u.type==="KeywordArgumentExpression"){let l=u,c=o??n?.value.get(l.key.value)??this.evaluate(l.value,s);s.setVariable(l.key.value,c)}else throw new Error(`Unknown argument type: ${u.type}`)}return this.evaluateBlock(e.body,s)})),new se}evaluateCallStatement(e,t){let r=new te((u,o)=>{let l=new at(o);if(e.callerArgs)for(let c=0;c<e.callerArgs.length;++c){let d=e.callerArgs[c];if(d.type!=="Identifier")throw new Error(`Caller parameter must be an identifier, got ${d.type}`);l.setVariable(d.value,u[c]??new re)}return this.evaluateBlock(e.body,l)}),[a,s]=this.evaluateArguments(e.call.args,t);a.push(new ir(s));let n=this.evaluate(e.call.callee,t);if(n.type!=="FunctionValue")throw new Error(`Cannot call something that is not a function: got ${n.type}`);let i=new at(t);return i.setVariable("caller",r),n.value(a,i)}evaluateFilterStatement(e,t){let r=this.evaluateBlock(e.body,t);return this.applyFilter(r,e.filter,t)}evaluate(e,t){if(!e)return new re;switch(e.type){case"Program":return this.evalProgram(e,t);case"Set":return this.evaluateSet(e,t);case"If":return this.evaluateIf(e,t);case"For":return this.evaluateFor(e,t);case"Macro":return this.evaluateMacro(e,t);case"CallStatement":return this.evaluateCallStatement(e,t);case"Break":throw new Xn;case"Continue":throw new Yn;case"IntegerLiteral":return new H(e.value);case"FloatLiteral":return new oe(e.value);case"StringLiteral":return new P(e.value);case"ArrayLiteral":return new V(e.value.map(r=>this.evaluate(r,t)));case"TupleLiteral":return new Jn(e.value.map(r=>this.evaluate(r,t)));case"ObjectLiteral":{let r=new Map;for(let[a,s]of e.value){let n=this.evaluate(a,t);if(!(n instanceof P))throw new Error(`Object keys must be strings: got ${n.type}`);r.set(n.value,this.evaluate(s,t))}return new me(r)}case"Identifier":return this.evaluateIdentifier(e,t);case"CallExpression":return this.evaluateCallExpression(e,t);case"MemberExpression":return this.evaluateMemberExpression(e,t);case"UnaryExpression":return this.evaluateUnaryExpression(e,t);case"BinaryExpression":return this.evaluateBinaryExpression(e,t);case"FilterExpression":return this.evaluateFilterExpression(e,t);case"FilterStatement":return this.evaluateFilterStatement(e,t);case"TestExpression":return this.evaluateTestExpression(e,t);case"SelectExpression":return this.evaluateSelectExpression(e,t);case"Ternary":return this.evaluateTernaryExpression(e,t);case"Comment":return new se;default:throw new SyntaxError(`Unknown node type: ${e.type}`)}}};function Lr(e){switch(typeof e){case"number":return Number.isInteger(e)?new H(e):new oe(e);case"string":return new P(e);case"boolean":return new G(e);case"undefined":return new re;case"object":return e===null?new se:Array.isArray(e)?new V(e.map(Lr)):new me(new Map(Object.entries(e).map(([t,r])=>[t,Lr(r)])));case"function":return new te((t,r)=>{let a=e(...t.map(s=>s.value))??null;return Lr(a)});default:throw new Error(`Cannot convert to runtime value: ${e}`)}}var de=`
`,Hd="{%- ",Ud=" -%}";function Vd(e){switch(e.operator.type){case"MultiplicativeBinaryOperator":return 4;case"AdditiveBinaryOperator":return 3;case"ComparisonBinaryOperator":return 2;case"Identifier":return e.operator.value==="and"?1:e.operator.value==="in"||e.operator.value==="not in"?2:0}return 0}function Qd(e,t="	"){let r=typeof t=="number"?" ".repeat(t):t;return We(e.body,0,r).replace(/\n$/,"")}function he(...e){return Hd+e.join(" ")+Ud}function We(e,t,r){return e.map(a=>Kd(a,t,r)).join(de)}function Kd(e,t,r){let a=r.repeat(t);switch(e.type){case"Program":return We(e.body,t,r);case"If":return Xd(e,t,r);case"For":return Yd(e,t,r);case"Set":return Zd(e,t,r);case"Macro":return Jd(e,t,r);case"Break":return a+he("break");case"Continue":return a+he("continue");case"CallStatement":return ef(e,t,r);case"FilterStatement":return tf(e,t,r);case"Comment":return a+"{# "+e.value+" #}";default:return a+"{{- "+Q(e)+" -}}"}}function Xd(e,t,r){let a=r.repeat(t),s=[],n=e;for(;n&&(s.push({test:n.test,body:n.body}),n.alternate.length===1&&n.alternate[0].type==="If");)n=n.alternate[0];let i=a+he("if",Q(s[0].test))+de+We(s[0].body,t+1,r);for(let u=1;u<s.length;++u)i+=de+a+he("elif",Q(s[u].test))+de+We(s[u].body,t+1,r);return n&&n.alternate.length>0&&(i+=de+a+he("else")+de+We(n.alternate,t+1,r)),i+=de+a+he("endif"),i}function Yd(e,t,r){let a=r.repeat(t),s="";if(e.iterable.type==="SelectExpression"){let i=e.iterable;s=`${Q(i.lhs)} if ${Q(i.test)}`}else s=Q(e.iterable);let n=a+he("for",Q(e.loopvar),"in",s)+de+We(e.body,t+1,r);return e.defaultBlock.length>0&&(n+=de+a+he("else")+de+We(e.defaultBlock,t+1,r)),n+=de+a+he("endfor"),n}function Zd(e,t,r){let a=r.repeat(t),s=Q(e.assignee),n=e.value?Q(e.value):"",i=a+he("set",`${s}${e.value?" = "+n:""}`);return e.body.length===0?i:i+de+We(e.body,t+1,r)+de+a+he("endset")}function Jd(e,t,r){let a=r.repeat(t),s=e.args.map(Q).join(", ");return a+he("macro",`${e.name.value}(${s})`)+de+We(e.body,t+1,r)+de+a+he("endmacro")}function ef(e,t,r){let a=r.repeat(t),s=e.callerArgs&&e.callerArgs.length>0?`(${e.callerArgs.map(Q).join(", ")})`:"",n=Q(e.call),i=a+he(`call${s}`,n)+de;return i+=We(e.body,t+1,r)+de,i+=a+he("endcall"),i}function tf(e,t,r){let a=r.repeat(t),s=e.filter.type==="Identifier"?e.filter.value:Q(e.filter),n=a+he("filter",s)+de;return n+=We(e.body,t+1,r)+de,n+=a+he("endfilter"),n}function Q(e,t=-1){switch(e.type){case"SpreadExpression":return`*${Q(e.argument)}`;case"Identifier":return e.value;case"IntegerLiteral":return`${e.value}`;case"FloatLiteral":return`${e.value}`;case"StringLiteral":return JSON.stringify(e.value);case"BinaryExpression":{let r=e,a=Vd(r),s=Q(r.left,a),n=Q(r.right,a+1),i=`${s} ${r.operator.value} ${n}`;return a<t?`(${i})`:i}case"UnaryExpression":{let r=e;return r.operator.value+(r.operator.value==="not"?" ":"")+Q(r.argument,1/0)}case"CallExpression":{let r=e,a=r.args.map(Q).join(", ");return`${Q(r.callee)}(${a})`}case"MemberExpression":{let r=e,a=Q(r.object);["Identifier","MemberExpression","CallExpression","StringLiteral","IntegerLiteral","FloatLiteral","ArrayLiteral","TupleLiteral","ObjectLiteral"].includes(r.object.type)||(a=`(${a})`);let s=Q(r.property);return!r.computed&&r.property.type!=="Identifier"&&r.property.type!=="IntegerLiteral"&&(s=`(${s})`),r.computed?`${a}[${s}]`:`${a}.${s}`}case"FilterExpression":{let r=e,a=Q(r.operand,1/0);return r.filter.type==="CallExpression"?`${a} | ${Q(r.filter)}`:`${a} | ${r.filter.value}`}case"SelectExpression":{let r=e;return`${Q(r.lhs)} if ${Q(r.test)}`}case"TestExpression":{let r=e;return`${Q(r.operand)} is${r.negate?" not":""} ${r.test.value}`}case"ArrayLiteral":case"TupleLiteral":{let r=e.value.map(Q),a=e.type==="ArrayLiteral"?"[]":"()";return`${a[0]}${r.join(", ")}${a[1]}`}case"ObjectLiteral":return`{${Array.from(e.value.entries()).map(([r,a])=>`${Q(r)}: ${Q(a)}`).join(", ")}}`;case"SliceExpression":{let r=e,a=r.start?Q(r.start):"",s=r.stop?Q(r.stop):"",n=r.step?`:${Q(r.step)}`:"";return`${a}:${s}${n}`}case"KeywordArgumentExpression":{let r=e;return`${r.key.value}=${Q(r.value)}`}case"Ternary":{let r=e,a=`${Q(r.trueExpr)} if ${Q(r.condition,0)} else ${Q(r.falseExpr)}`;return t>-1?`(${a})`:a}default:throw new Error(`Unknown expression type: ${e.type}`)}}var ai=class{parsed;constructor(e){let t=Rn(e,{lstrip_blocks:!0,trim_blocks:!0});this.parsed=Qn(t)}render(e){let t=new at;if(Rd(t),e)for(let[r,a]of Object.entries(e))t.set(r,a);return new ri(t).run(this.parsed).value}format(e){return Qd(this.parsed,e?.indent||"	")}},rf=class{constructor(e){this.trie=this._build_trie(e)}_build_trie(e){let t=Object.create(null);for(let r of e){let a=t;for(let s=0;s<r.length;++s){let n=r[s];a=a[n]??=Object.create(null)}a.end=r}return t}split(e){let t=[],r=e.length,a=0,s=0;for(;s<r;){let n=this.trie,i=null,u=s;for(;u<r&&(n=n[e[u]]);)n.end&&(i=n.end),++u;i?(s>a&&t.push(e.slice(a,s)),t.push(i),s+=i.length,a=s):++s}return a<r&&t.push(e.slice(a)),t}},si=rf,af=class{constructor(e){this.content=e.content,this.id=e.id,this.single_word=e.single_word??!1,this.lstrip=e.lstrip??!1,this.rstrip=e.rstrip??!1,this.special=e.special??!1,this.normalized=e.normalized??!this.special}},sf=af,ni=(e,t)=>{try{return new RegExp(e,t)}catch(r){if(!(r instanceof SyntaxError))throw r;let a=new Map,s=e.replace(/(\\[pP])\{([^}=]+)\}/g,(n,i,u,o)=>{let l=0;for(let d=o-1;d>=0&&e[d]==="\\";--d)++l;if(l%2===1)return n;let c=a.get(u);if(c===void 0){try{new RegExp(`\\p{${u}}`,"u"),c=u}catch{c=`Script=${u}`}a.set(u,c)}return`${i}{${c}}`});if(s===e)throw r;try{return new RegExp(s,t)}catch{throw r}}},Ra=e=>e.replace(/ \./g,".").replace(/ \?/g,"?").replace(/ \!/g,"!").replace(/ ,/g,",").replace(/ \' /g,"'").replace(/ n't/g,"n't").replace(/ 'm/g,"'m").replace(/ 's/g,"'s").replace(/ 've/g,"'ve").replace(/ 're/g,"'re"),zr=(e,t=!0)=>{if(e.Regex!==void 0){let r=kf(vf(e.Regex));return ni(r,"gu")}else if(e.String!==void 0){let r=xf(e.String);return new RegExp(t?r:`(${r})`,"gu")}else return console.warn("Unknown pattern type:",e),null},Ct="\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}",ii=`${Ct}\\u00B2\\u00B3\\u00B9\\u00BC-\\u00BE`,Ze=`[${ii}]`,ui=`[^${ii}]`,nf=`(?:(?<!${Ze})(?=${Ze})|(?<=${Ze})(?!${Ze}))`,uf=`(?:(?<!${Ze})(?!${Ze})|(?<=${Ze})(?=${Ze}))`,of="(?:(?<![\\s\\S])|(?<=\\n))",lf="(?:(?=\\n)|(?![\\s\\S]))",ur="0-9A-Fa-f",cf=new Map([["A","(?<![\\s\\S])"],["z","(?![\\s\\S])"],["Z","(?=\\n?(?![\\s\\S]))"],["h",`[${ur}]`],["H",`[^${ur}]`],["w",Ze],["W",ui],["d","\\p{Nd}"],["D","\\P{Nd}"],["s","\\p{White_Space}"],["S","\\P{White_Space}"],["b",nf],["B",uf],["a","\\x07"],["e","\\x1B"]]),df=new Map([["h",ur],["w",Ct],["d","\\p{Nd}"],["D","\\P{Nd}"],["s","\\p{White_Space}"],["S","\\P{White_Space}"],["a","\\x07"],["e","\\x1B"]]),ff=new Map([["W",`[^${Ct}]`],["H",`[^${ur}]`]]),oi=new Map([[`
`,"\\n"],["\r","\\r"],["	","\\t"],["\f","\\f"],["\v","\\v"]]),pf=new Map([["alpha","\\p{Alphabetic}"],["alnum","\\p{Alphabetic}\\p{Nd}"],["digit","\\p{Nd}"],["lower","\\p{Lowercase}"],["upper","\\p{Uppercase}"],["space","\\p{White_Space}"],["blank","\\t\\p{Zs}"],["punct","\\p{P}\\p{S}"],["cntrl","\\p{Cc}"],["word",Ct],["xdigit",ur]]),li="^$\\.*+?()[]{}|/",mf=/^\(\?(?:<[=!]|<[A-Za-z_][A-Za-z0-9_]*>|[:=!>])/,ci=/^\\([pPxu])\{([^}]*)\}/,hf=/^\{(\d+(?:,\d*)?|,\d+)\}/,gf=/^\[:(\^?)(\p{Alphabetic}+):\]/u,wf=/^\[:\^:\]/,bf=/^\[(?:\.[^\]]*\.\]|=[^\]]*=\])/,di=/^(?:\\x[0-9A-Fa-f]{2}|\\u[0-9A-Fa-f]{4}|\\c[A-Za-z])/,fi=e=>e>="A"&&e<="Z"||e>="a"&&e<="z",Or=(e,t)=>String.fromCodePoint(e.codePointAt(t)),pi=e=>{if(!/^[0-9A-Fa-f]{1,8}$/.test(e))return null;let t=Number.parseInt(e,16);if(t>127)return null;let r=String.fromCharCode(t);return fi(r)?`[${r.toLowerCase()}${r.toUpperCase()}]`:null},vf=e=>e.replace(/\[\^\(\\s\|\[([^\]]+)\]\)\]/g,"[^()|\\s$1]"),mi="[\\s\\S]",hi=256,gi=()=>({fragment:"",alternatives:[],tail:null,contains_complex_set:!1}),Ha=e=>{throw new SyntaxError(`Unsupported range with a set-valued character-class operand at index ${e}`)},Nr=(e,t,r,a=!0)=>{e.tail==="range"&&Ha(r),e.alternatives.push(t),e.tail="set",e.contains_complex_set=e.contains_complex_set||a},ot=(e,t,r=!1,a=-1)=>{if(r&&e.tail==="range"&&Ha(a),e.tail==="range"){e.fragment+=t,e.tail="complete_range";return}e.fragment+=t,e.tail=r?"set":"scalar",e.contains_complex_set=e.contains_complex_set||r},_f=(e,t,r)=>{let a=ci.exec(e.slice(t));if(a){let[f,p,m]=a;if(p==="P"&&m==="Word")Nr(r,`[^${Ct}]`,t);else{let h=p==="x"?`\\u{${m}}`:p==="p"&&m==="Word"?Ct:f;ot(r,h,p==="p"||p==="P",t)}return t+f.length}let s=di.exec(e.slice(t));if(s)return ot(r,s[0]),t+s[0].length;if(t+1>=e.length)throw new SyntaxError(`Unterminated escape in character class at index ${t}`);let n=Or(e,t+1),i=t+1+n.length,u=oi.get(n);if(u!==void 0)return ot(r,u),i;let o=ff.get(n);if(o!==void 0)return Nr(r,o,t),i;let l=df.get(n),c,d=!1;return l!==void 0?(c=l,d=n!=="a"&&n!=="e"):/[A-Za-z0-9]/.test(n)?c=`\\${n}`:li.includes(n)||n==="-"?c=`\\${n}`:c=n,ot(r,c,d,t),i},wi=e=>e.length===1?e[0]:`(?:(?=(?:${e.join("|")}))${mi})`,bi=e=>{let t=e.fragment.length===0?e.alternatives:[`[${e.fragment}]`,...e.alternatives];return wi(t)},yf=e=>{let t=ni(`^(?:${e})$`,"u"),r="";for(let a=0;a<26;++a){let s=String.fromCharCode(65+a),n=String.fromCharCode(97+a),i=t.test(s),u=t.test(n);i!==u&&(r+=i?n:s)}return r},vi=(e,t,r,a=!0,s=1)=>{if(s>hi)throw new SyntaxError(`Maximum character-class nesting depth of ${hi} exceeded at index ${t}`);let n=t+1,i=e[n]==="^";i&&++n;let u=n,o=[gi()],l=o[0],c=!1;for(;n<e.length;){let d=Or(e,n);if(d==="\\"){n=_f(e,n,l);continue}if(d==="]"){if(n===u){ot(l,"\\]"),++n;continue}if(l.tail===null)throw o.length>1?new SyntaxError(`Malformed character-class intersection with an empty operand at index ${n}`):new SyntaxError(`Empty character class at index ${t}`);let f=o.some(g=>g.contains_complex_set);if(i&&o.length>1&&c)throw new SyntaxError(`Unsupported outer-negated character-class intersection with a nested negated class containing a Unicode property, POSIX class, or shorthand at index ${t}`);let p=bi(o[0]),m=p;if(o.length>1){let g="";for(let v=1;v<o.length;++v)g+=`(?=${bi(o[v])})`;m=`(?:${g}${p})`}let h=o.length===1&&l.alternatives.length===0,b=l.fragment;if(r&&a){let g=yf(m);g.length>0&&(h?(b+=g,m=`[${b}]`):m=wi([m,`[${g}]`]))}return{atom:i?h?`[^${b}]`:`(?:(?!${m})${mi})`:m,end:n+1,negated:i,contains_complex_set:f,contains_nested_negated_complex_set:c}}if(e.startsWith("&&",n)){if(l.tail===null)throw new SyntaxError(`Malformed character-class intersection with an empty operand at index ${n}`);l=gi(),o.push(l),n+=2;continue}if(d==="["){let f=e.slice(n);if(wf.test(f))throw new SyntaxError(`Malformed empty negated POSIX character class at index ${n}`);let p=gf.exec(f);if(p){let[,h,b]=p,g=pf.get(b);if(g===void 0)throw new SyntaxError(`Unsupported POSIX character class "${b}" at index ${n}`);if(r&&h&&(b==="lower"||b==="upper"))throw new SyntaxError(`Unsupported negated POSIX ${b} class inside an inline case-insensitive group`);h?Nr(l,`[^${g}]`,n):ot(l,g,!0,n),n+=p[0].length;continue}if(bf.test(f))throw new SyntaxError(`Unsupported POSIX collating or equivalence bracket expression at index ${n}`);let m=vi(e,n,r,!1,s+1);Nr(l,m.atom,n,m.contains_complex_set),c||=m.contains_nested_negated_complex_set||m.negated&&m.contains_complex_set,n=m.end;continue}if(d==="-"){let f=e[n+1]==="]"||e.startsWith("&&",n+1);l.tail==="set"&&!f&&Ha(n),l.tail===null||l.tail==="range"||l.tail==="complete_range"||f?ot(l,"\\-"):(l.fragment+="-",l.tail="range"),++n;continue}ot(l,d==="^"&&l.fragment.length===0?"\\^":d),n+=d.length}throw new SyntaxError(`${o.length>1?"Unterminated character-class intersection":"Unterminated character class"} at index ${t}`)},kf=e=>{let t="",r=-1,a=!1,s=!1,n=[],i=u=>{r=t.length,t+=u,a=!1};for(let u=0;u<e.length;){let o=Or(e,u);if(o==="\\"){let l=ci.exec(e.slice(u));if(l){let[h,b,g]=l,v=h;if(b==="x"){let w=`\\u{${g}}`;v=s?pi(g)??w:w}else g==="Word"&&(v=b==="p"?Ze:ui);i(v),u+=h.length;continue}let c=di.exec(e.slice(u));if(c){let h=c[0],b=s&&h[1]!=="c"?pi(h.slice(2))??h:h;i(b),u+=h.length;continue}if(u+1>=e.length){t+=o;break}let d=Or(e,u+1);if(u+=1+d.length,d==="G")continue;let f=oi.get(d);if(f!==void 0){i(f);continue}let p=cf.get(d),m;p!==void 0?m=p:/[A-Za-z0-9]/.test(d)?m=`\\${d}`:li.includes(d)?m=`\\${d}`:m=d,i(m);continue}switch(o){case"[":{let l=vi(e,u,s);i(l.atom),u=l.end;continue}case"]":i("\\]"),++u;continue;case".":i("[^\\n]"),++u;continue;case"^":i(of),++u;continue;case"$":i(lf),++u;continue;case"(":{let l=e.startsWith("(?i:",u),c=l?"(?i:":mf.exec(e.slice(u))?.[0]??"(",d=l||c==="(?>"?"(?:":c;n.push([t.length,s]),l&&(s=!0),t+=d,a=!1,u+=c.length;continue}case")":t+=o,[r,s]=n.pop()??[-1,!1],a=!1,++u;continue;case"|":t+=o,r=-1,a=!1,++u;continue;case"{":{let l=hf.exec(e.slice(u));if(!l||r<0){i("\\{"),++u;continue}let c=l[1].startsWith(",")?`0${l[1]}`:l[1];u+=l[0].length;let d=e[u];d==="+"||d==="*"?(t=`${t.slice(0,r)}(?:${t.slice(r)}{${c}})${d}`,++u):t+=`{${c}}`,a=!0;continue}case"}":i("\\}"),++u;continue;case"+":if(a){++u;continue}t+=o,a=!0,++u;continue;case"*":case"?":t+=o,a=!0,++u;continue;default:i(s&&fi(o)?`[${o.toLowerCase()}${o.toUpperCase()}]`:o),u+=o.length;continue}}return t},xf=e=>e.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),Sf=(e,t,r)=>{let a=[],s=0;for(;s<e.length;){if(a.push(e[s]),(t.get(e[s])??r)!==r){++s;continue}for(;++s<e.length&&(t.get(e[s])??r)===r;)t.get(a.at(-1))!==r&&(a[a.length-1]+=e[s])}return a},qf=e=>e>=19968&&e<=40959||e>=13312&&e<=19903||e>=131072&&e<=173791||e>=173824&&e<=177983||e>=177984&&e<=178207||e>=178208&&e<=183983||e>=63744&&e<=64255||e>=194560&&e<=195103,Ef=e=>Number.isInteger(e)||typeof e=="bigint",Tf=e=>{let t=0;for(let r of e)++t;return t},If=e=>_i(e.toLowerCase()),Ge=(...e)=>Array.prototype.concat.apply([],e),Ua=e=>new Map(Object.entries(e)),Af=(e,t)=>{let r=[],a=0;for(let s of e.matchAll(t)){let n=s[0];a<s.index&&r.push(e.slice(a,s.index)),n.length>0&&r.push(n),a=s.index+n.length}return a<e.length&&r.push(e.slice(a)),r},_i=e=>e.replace(/\p{M}/gu,""),yi=(e,t,r=[])=>{if(!e||Array.isArray(e)||typeof e!="object")return`${t} must be a valid object`;for(let a of r)if(!(a in e))return`${t} must contain a "${a}" property`;return null},Bf=e=>e.match(/\S+/g)||[],jf=class{constructor(){let e=function(...t){return e._call(...t)};return Object.setPrototypeOf(e,new.target.prototype)}},or=jf,Mf=class extends or{constructor(e){super(),this.config=e}_call(e){return this.normalize(e)}},st=Mf,Df=class extends st{tokenize_chinese_chars(e){let t=[];for(let r=0;r<e.length;++r){let a=e[r],s=a.charCodeAt(0);qf(s)?(t.push(" "),t.push(a),t.push(" ")):t.push(a)}return t.join("")}strip_accents(e){return e.normalize("NFD").replace(/\p{Mn}/gu,"")}is_control(e){switch(e){case"	":case`
`:case"\r":return!1;default:return/^\p{Cc}|\p{Cf}|\p{Co}|\p{Cs}$/u.test(e)}}clean_text(e){let t=[];for(let r of e){let a=r.charCodeAt(0);a===0||a===65533||this.is_control(r)||(/^\s$/.test(r)?t.push(" "):t.push(r))}return t.join("")}normalize(e){return this.config.clean_text&&(e=this.clean_text(e)),this.config.handle_chinese_chars&&(e=this.tokenize_chinese_chars(e)),this.config.lowercase?(e=e.toLowerCase(),this.config.strip_accents!==!1&&(e=this.strip_accents(e))):this.config.strip_accents&&(e=this.strip_accents(e)),e}},$f=Df,Ff=class extends st{constructor(e){super(e),this.charsmap=e.precompiled_charsmap??null}normalize(e){return e=e.replace(/[\u0001-\u0008\u000B\u000E-\u001F\u007F\u008F\u009F]/gm,""),e=e.replace(/[\u0009\u000A\u000C\u000D\u00A0\u1680\u2000-\u200F\u2028\u2029\u202F\u205F\u2581\u3000\uFEFF\uFFFD]/gm," "),e.includes("～")?e=e.split("～").map(t=>t.normalize("NFKC")).join("～"):e=e.normalize("NFKC"),e}},Pf=Ff,Cf=class extends st{constructor(e){super(e),this.normalizers=(e.normalizers??[]).map(t=>ki(t))}normalize(e){return this.normalizers.reduce((t,r)=>r?r.normalize(t):t,e)}},Lf=Cf,zf=class extends st{constructor(e){super(e),this.pattern=zr(this.config.pattern??{})}normalize(e){return this.pattern===null?e:e.replaceAll(this.pattern,this.config.content??"")}},Of=zf,Nf=class extends st{constructor(){super(...arguments),this.form="NFC"}normalize(e){return e=e.normalize(this.form),e}},Wr=Nf,Wf=class extends Wr{constructor(){super(...arguments),this.form="NFC"}},Gf=Wf,Rf=class extends Wr{constructor(){super(...arguments),this.form="NFD"}},Hf=Rf,Uf=class extends Wr{constructor(){super(...arguments),this.form="NFKC"}},Vf=Uf,Qf=class extends Wr{constructor(){super(...arguments),this.form="NFKD"}},Kf=Qf,Xf=class extends st{normalize(e){return this.config.strip_left&&this.config.strip_right?e=e.trim():(this.config.strip_left&&(e=e.trimStart()),this.config.strip_right&&(e=e.trimEnd())),e}},Yf=Xf,Zf=class extends st{normalize(e){return _i(e)}},Jf=Zf,ep=class extends st{normalize(e){return e.toLowerCase()}},tp=ep,rp=class extends st{normalize(e){return e=this.config.prepend+e,e}},ap=rp;function sp(e){if(e===null)return null;switch(e.type){case"BertNormalizer":return new $f(e);case"Precompiled":return new Pf(e);case"Sequence":return new Lf(e);case"Replace":return new Of(e);case"NFC":return new Gf(e);case"NFD":return new Hf(e);case"NFKC":return new Vf(e);case"NFKD":return new Kf(e);case"Strip":return new Yf(e);case"StripAccents":return new Jf(e);case"Lowercase":return new tp(e);case"Prepend":return new ap(e);default:throw new Error(`Unknown Normalizer type: ${e.type}`)}}var ki=sp,np=class extends or{pre_tokenize(e,t){return(Array.isArray(e)?e.map(r=>this.pre_tokenize_text(r,t)):this.pre_tokenize_text(e,t)).flat()}_call(e,t){return this.pre_tokenize(e,t)}},Re=np,xi=(()=>{let e=[...Array.from({length:94},(s,n)=>n+33),...Array.from({length:12},(s,n)=>n+161),...Array.from({length:82},(s,n)=>n+174)],t=e.slice(),r=0;for(let s=0;s<256;++s)e.includes(s)||(e.push(s),t.push(256+r),r+=1);let a=t.map(s=>String.fromCharCode(s));return Object.fromEntries(e.map((s,n)=>[s,a[n]]))})(),ip=e=>Object.fromEntries(Object.entries(e).map(([t,r])=>[r,t])),up=ip(xi),Gr="\\p{P}\\u0021-\\u002F\\u003A-\\u0040\\u005B-\\u0060\\u007B-\\u007E",op=class extends Re{constructor(e){super(),this.config=e,this.add_prefix_space=this.config.add_prefix_space??!1,this.trim_offsets=this.config.trim_offsets??!1,this.use_regex=this.config.use_regex??!0,this.pattern=/'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu,this.byte_encoder=xi,this.text_encoder=new TextEncoder}pre_tokenize_text(e,t){return this.add_prefix_space&&!e.startsWith(" ")&&(e=" "+e),(this.use_regex?e.match(this.pattern)||[]:[e]).map(r=>Array.from(this.text_encoder.encode(r),a=>this.byte_encoder[a]).join(""))}},lp=op,cp=class extends Re{pre_tokenize_text(e,t){return e.match(/\w+|[^\w\s]+/g)||[]}},dp=cp,fp=class extends Re{constructor(e){super(),this.replacement=e.replacement??"▁",this.str_rep=e.str_rep||this.replacement,this.prepend_scheme=e.prepend_scheme??"always"}pre_tokenize_text(e,t){let{section_index:r=void 0}=t??{},a=e.replaceAll(" ",this.str_rep);return!a.startsWith(this.replacement)&&(this.prepend_scheme==="always"||this.prepend_scheme==="first"&&r===0)&&(a=this.str_rep+a),[a]}},pp=fp,mp=class extends Re{constructor(e){super(),this.config=e,this.pattern=zr(this.config.pattern??{},this.config.invert??!0)}pre_tokenize_text(e){return this.pattern===null?[]:this.config.invert?(e.match(this.pattern)||[]).filter(t=>t):this.config.behavior?.toLowerCase()==="removed"?e.split(this.pattern).filter(t=>t):Af(e,this.pattern)}},hp=mp,gp=class extends Re{constructor(e){super(),this.config=e,this.pattern=new RegExp(`[^${Gr}]+|[${Gr}]+`,"gu")}pre_tokenize_text(e){return e.match(this.pattern)||[]}},wp=gp,bp=class extends Re{constructor(e){super(),this.config=e;let t=`[^\\d]+|\\d${this.config.individual_digits?"":"+"}`;this.pattern=new RegExp(t,"gu")}pre_tokenize_text(e){return e.match(this.pattern)||[]}},vp=bp,_p=class extends Re{constructor(){super(),this.pattern=new RegExp(`[^\\s${Gr}]+|[${Gr}]`,"gu")}pre_tokenize_text(e,t){return e.trim().match(this.pattern)||[]}},yp=_p,kp=class extends Re{constructor(e){super(),this.config=e,this.pattern=zr(this.config.pattern??{}),this.content=this.config.content??""}pre_tokenize_text(e){return this.pattern===null?[e]:[e.replaceAll(this.pattern,this.config.content??"")]}},xp=kp,Sp=class extends Re{constructor(e){super(),this.tokenizers=(e.pretokenizers??[]).map(t=>Si(t))}pre_tokenize_text(e,t){return this.tokenizers.reduce((r,a)=>a?a.pre_tokenize(r,t):r,[e])}},qp=Sp,Ep=class extends Re{pre_tokenize_text(e){return Bf(e)}},Tp=Ep,Ip=class extends Re{constructor(e){super(),this.config=e,this._length=e.length}pre_tokenize_text(e){let t=[];for(let r=0;r<e.length;r+=this._length)t.push(e.slice(r,r+this._length));return t}},Ap=Ip;function Bp(e){if(e===null)return null;switch(e.type){case"BertPreTokenizer":return new yp;case"Sequence":return new qp(e);case"Whitespace":return new dp;case"WhitespaceSplit":return new Tp;case"Metaspace":return new pp(e);case"ByteLevel":return new lp(e);case"Split":return new hp(e);case"Punctuation":return new wp(e);case"Digits":return new vp(e);case"Replace":return new xp(e);case"FixedLength":return new Ap(e);default:throw new Error(`Unknown PreTokenizer type: ${e.type}`)}}var Si=Bp,jp=class extends or{constructor(e){super(),this.config=e,this.vocab=[],this.tokens_to_ids=new Map,this.unk_token_id=void 0,this.unk_token=void 0,this.end_of_word_suffix=void 0,this.fuse_unk=this.config.fuse_unk??!1}_call(e){let t=this.encode(e);return this.fuse_unk&&(t=Sf(t,this.tokens_to_ids,this.unk_token_id)),t}},Rr=jp,Mp=class extends Rr{constructor(e){super(e),this.max_input_chars_per_word=100,this.tokens_to_ids=Ua(e.vocab),this.unk_token_id=this.tokens_to_ids.get(e.unk_token),this.unk_token=e.unk_token,this.max_input_chars_per_word=e.max_input_chars_per_word??100,this.vocab=new Array(this.tokens_to_ids.size);for(let[t,r]of this.tokens_to_ids)this.vocab[r]=t}encode(e){let t=[];for(let r of e){let a=[...r];if(a.length>this.max_input_chars_per_word){t.push(this.unk_token);continue}let s=!1,n=0,i=[];for(;n<a.length;){let u=a.length,o=null;for(;n<u;){let l=a.slice(n,u).join("");if(n>0&&(l=this.config.continuing_subword_prefix+l),this.tokens_to_ids.has(l)){o=l;break}--u}if(o===null){s=!0;break}i.push(o),n=u}s?t.push(this.unk_token):t.push(...i)}return t}},qi=Mp,Ei=class dl{constructor(t,r){this.is_leaf=t,this.children=r}static default(){return new dl(!1,new Map)}},Dp=class{constructor(){this.root=Ei.default()}extend(e){for(let t of e)this.push(t)}push(e){let t=this.root;for(let r of e){let a=t.children.get(r);a===void 0&&(a=Ei.default(),t.children.set(r,a)),t=a}t.is_leaf=!0}*common_prefix_search(e){let t=this.root;if(t===void 0)return;let r="";for(let a of e){if(r+=a,t=t.children.get(a),t===void 0)return;t.is_leaf&&(yield r)}}},$p=Dp,Va=class fl{constructor(t,r,a,s,n){this.token_id=t,this.node_id=r,this.pos=a,this.length=s,this.score=n,this.prev=null,this.backtrace_score=0}clone(){let t=new fl(this.token_id,this.node_id,this.pos,this.length,this.score);return t.prev=this.prev,t.backtrace_score=this.backtrace_score,t}},Fp=class{constructor(e,t,r){this.chars=Array.from(e),this.len=this.chars.length,this.bos_token_id=t,this.eos_token_id=r,this.nodes=[],this.begin_nodes=Array.from({length:this.len+1},()=>[]),this.end_nodes=Array.from({length:this.len+1},()=>[]);let a=new Va(this.bos_token_id??0,0,0,0,0),s=new Va(this.eos_token_id??0,1,this.len,0,0);this.nodes.push(a.clone()),this.nodes.push(s.clone()),this.begin_nodes[this.len].push(s),this.end_nodes[0].push(a)}insert(e,t,r,a){let s=this.nodes.length,n=new Va(a,s,e,t,r);this.begin_nodes[e].push(n),this.end_nodes[e+t].push(n),this.nodes.push(n)}viterbi(){let e=this.len,t=0;for(;t<=e;){if(this.begin_nodes[t].length==0)return[];for(let n of this.begin_nodes[t]){n.prev=null;let i=0,u=null;for(let o of this.end_nodes[t]){let l=o.backtrace_score+n.score;(u===null||l>i)&&(u=o.clone(),i=l)}if(u!==null)n.prev=u,n.backtrace_score=i;else return[]}++t}let r=[],a=this.begin_nodes[e][0].prev;if(a===null)return[];let s=a.clone();for(;s.prev!==null;)r.push(s.clone()),s=s.clone().prev.clone();return r.reverse(),r}piece(e){return this.chars.slice(e.pos,e.pos+e.length).join("")}tokens(){return this.viterbi().map(e=>this.piece(e))}token_ids(){return this.viterbi().map(e=>e.token_id)}},Pp=Fp;function Cp(e){if(e.length===0)throw new Error("Array must not be empty");let t=e[0],r=0;for(let a=1;a<e.length;++a)e[a]<t&&(t=e[a],r=a);return[t,r]}var Lp=class extends Rr{constructor(e,t){super(e);let r=e.vocab.length;this.vocab=new Array(r),this.scores=new Array(r);for(let a=0;a<r;++a)[this.vocab[a],this.scores[a]]=e.vocab[a];this.unk_token_id=e.unk_id,this.unk_token=this.vocab[e.unk_id],this.tokens_to_ids=new Map(this.vocab.map((a,s)=>[a,s])),this.bos_token=" ",this.bos_token_id=this.tokens_to_ids.get(this.bos_token),this.eos_token=t,this.eos_token_id=this.tokens_to_ids.get(this.eos_token),this.unk_token=this.vocab[this.unk_token_id],this.min_score=Cp(this.scores)[0],this.unk_score=this.min_score-10,this.scores[this.unk_token_id]=this.unk_score,this.trie=new $p,this.trie.extend(this.vocab),this.fuse_unk=!0}populate_nodes(e){let t=e.chars,r=1,a=0;for(;a<t.length;){let s=!1,n=[],i=t.slice(a).join(""),u=this.trie.common_prefix_search(i);for(let o of u){n.push(o);let l=this.tokens_to_ids.get(o),c=this.scores[l],d=Tf(o);e.insert(a,d,c,l),!s&&d===r&&(s=!0)}s||e.insert(a,r,this.unk_score,this.unk_token_id),a+=r}}tokenize(e){let t=new Pp(e,this.bos_token_id,this.eos_token_id);return this.populate_nodes(t),t.tokens()}encode(e){let t=[];for(let r of e){let a=this.tokenize(r);t.push(...a)}return t}},Ti=Lp,zp=class{constructor(e=(r,a)=>r>a,t=1/0){this._heap=[],this._comparator=e,this._max_size=t}get size(){return this._heap.length}is_empty(){return this.size===0}peek(){return this._heap[0]}push(...e){return this.extend(e)}extend(e){for(let t of e)if(this.size<this._max_size)this._heap.push(t),this._sift_up();else{let r=this._smallest();this._comparator(t,this._heap[r])&&(this._heap[r]=t,this._sift_up_from(r))}return this.size}pop(){let e=this.peek(),t=this.size-1;return t>0&&this._swap(0,t),this._heap.pop(),this._sift_down(),e}replace(e){let t=this.peek();return this._heap[0]=e,this._sift_down(),t}_parent(e){return(e+1>>>1)-1}_left(e){return(e<<1)+1}_right(e){return e+1<<1}_greater(e,t){return this._comparator(this._heap[e],this._heap[t])}_swap(e,t){let r=this._heap[e];this._heap[e]=this._heap[t],this._heap[t]=r}_sift_up(){this._sift_up_from(this.size-1)}_sift_up_from(e){for(;e>0&&this._greater(e,this._parent(e));)this._swap(e,this._parent(e)),e=this._parent(e)}_sift_down(){let e=0;for(;this._left(e)<this.size&&this._greater(this._left(e),e)||this._right(e)<this.size&&this._greater(this._right(e),e);){let t=this._right(e)<this.size&&this._greater(this._right(e),this._left(e))?this._right(e):this._left(e);this._swap(e,t),e=t}}_smallest(){return 2**Math.floor(Math.log2(this.size))-1}},Op=zp,Np=class{constructor(e){this.capacity=e,this.cache=new Map}get(e){if(!this.cache.has(e))return;let t=this.cache.get(e);return this.cache.delete(e),this.cache.set(e,t),t}put(e,t){this.cache.has(e)&&this.cache.delete(e),this.cache.set(e,t),this.cache.size>this.capacity&&this.cache.delete(this.cache.keys().next().value)}clear(){this.cache.clear()}},Wp=Np,Gp=class extends Rr{constructor(e){super(e),this.tokens_to_ids=Ua(e.vocab),this.unk_token_id=this.tokens_to_ids.get(e.unk_token),this.unk_token=e.unk_token,this.vocab=new Array(this.tokens_to_ids.size);for(let[r,a]of this.tokens_to_ids)this.vocab[a]=r;let t=Array.isArray(e.merges[0]);this.merges=t?e.merges:e.merges.map(r=>r.split(" ",2)),this.bpe_ranks=new Map(this.merges.map((r,a)=>[JSON.stringify(r),a])),this.end_of_word_suffix=e.end_of_word_suffix,this.continuing_subword_suffix=e.continuing_subword_suffix??null,this.byte_fallback=this.config.byte_fallback??!1,this.byte_fallback&&(this.text_encoder=new TextEncoder),this.ignore_merges=this.config.ignore_merges??!1,this.max_length_to_cache=256,this.cache_capacity=1e4,this.cache=new Wp(this.cache_capacity)}clear_cache(){this.cache.clear()}bpe(e){if(e.length===0)return[];let t=this.cache.get(e);if(t!==void 0)return t;let r=Array.from(e);this.end_of_word_suffix&&(r[r.length-1]+=this.end_of_word_suffix);let a=[];if(r.length>1){let s=new Op((u,o)=>u.score<o.score),n={token:r[0],bias:0,prev:null,next:null},i=n;for(let u=1;u<r.length;++u){let o={bias:u/r.length,token:r[u],prev:i,next:null};i.next=o,this.add_node(s,i),i=o}for(;!s.is_empty();){let u=s.pop();if(u.deleted||!u.next||u.next.deleted)continue;if(u.deleted=!0,u.next.deleted=!0,u.prev){let l={...u.prev};u.prev.deleted=!0,u.prev=l,l.prev?l.prev.next=l:n=l}let o={token:u.token+u.next.token,bias:u.bias,prev:u.prev,next:u.next.next};o.prev?(o.prev.next=o,this.add_node(s,o.prev)):n=o,o.next&&(o.next.prev=o,this.add_node(s,o))}for(let u=n;u!==null;u=u.next)a.push(u.token)}else a=r;if(this.continuing_subword_suffix)for(let s=0;s<a.length-1;++s)a[s]+=this.continuing_subword_suffix;return e.length<this.max_length_to_cache&&this.cache.put(e,a),a}add_node(e,t){let r=this.bpe_ranks.get(JSON.stringify([t.token,t.next.token]));r!==void 0&&(t.score=r+t.bias,e.push(t))}encode(e){let t=[];for(let r of e){if(this.ignore_merges&&this.tokens_to_ids.has(r)){t.push(r);continue}let a=this.bpe(r);for(let s of a)if(this.tokens_to_ids.has(s))t.push(s);else if(this.byte_fallback){let n=Array.from(this.text_encoder.encode(s)).map(i=>`<0x${i.toString(16).toUpperCase().padStart(2,"0")}>`);n.every(i=>this.tokens_to_ids.has(i))?t.push(...n):this.unk_token!=null&&t.push(this.unk_token)}else this.unk_token!=null&&t.push(this.unk_token)}return t}},Ii=Gp,Rp=class extends Rr{constructor(e,t){super(e);let r=e.vocab;this.tokens_to_ids=Ua(t.target_lang?r[t.target_lang]:r),this.bos_token=t.bos_token,this.bos_token_id=this.tokens_to_ids.get(this.bos_token),this.eos_token=t.eos_token,this.eos_token_id=this.tokens_to_ids.get(this.eos_token),this.pad_token=t.pad_token,this.pad_token_id=this.tokens_to_ids.get(this.pad_token),this.unk_token=t.unk_token,this.unk_token_id=this.tokens_to_ids.get(this.unk_token),this.vocab=new Array(this.tokens_to_ids.size);for(let[a,s]of this.tokens_to_ids)this.vocab[s]=a}encode(e){return e}},Hp=Rp;function Up(e,t){switch(e.type){case"WordPiece":return new qi(e);case"Unigram":return new Ti(e,t.eos_token);case"BPE":return new Ii(e);default:if(e.vocab)return Array.isArray(e.vocab)?new Ti(e,t.eos_token):Object.hasOwn(e,"continuing_subword_prefix")&&Object.hasOwn(e,"unk_token")?Object.hasOwn(e,"merges")?new Ii(e):new qi(e):new Hp(e,{target_lang:t.target_lang,bos_token:t.bos_token,eos_token:t.eos_token,pad_token:t.pad_token,unk_token:t.unk_token});throw new Error(`Unknown TokenizerModel type: ${e?.type}`)}}var Vp=Up,Qp=class extends or{constructor(e){super(),this.config=e}_call(e,...t){return this.post_process(e,...t)}},lr=Qp,Kp=class extends lr{post_process(e,t=null,r=!0){let a=t===null?this.config.single:this.config.pair,s=[],n=[];for(let i of a)"SpecialToken"in i?r&&(s.push(i.SpecialToken.id),n.push(i.SpecialToken.type_id)):"Sequence"in i&&(i.Sequence.id==="A"?(s=Ge(s,e),n=Ge(n,new Array(e.length).fill(i.Sequence.type_id))):i.Sequence.id==="B"&&(s=Ge(s,t),n=Ge(n,new Array(t.length).fill(i.Sequence.type_id))));return{tokens:s,token_type_ids:n}}},Xp=Kp,Yp=class extends lr{post_process(e,t=null){return{tokens:e,tokens_pair:t}}},Zp=Yp,Jp=class extends lr{constructor(e){super(e),this.sep=e.sep,this.cls=e.cls}post_process(e,t=null,r=!0){r&&(e=Ge([this.cls[0]],e,[this.sep[0]]));let a=new Array(e.length).fill(0);if(t){let s=[],n=r?[this.sep[0]]:[];e=Ge(e,s,t,n),a=Ge(a,new Array(t.length+s.length+n.length).fill(1))}return{tokens:e,token_type_ids:a}}},em=Jp,tm=class extends lr{constructor(e){super(e),this.sep=e.sep,this.cls=e.cls}post_process(e,t,r=!0){r&&(e=Ge([this.cls[0]],e,[this.sep[0]]));let a=new Array(e.length).fill(0);if(t){let s=r?[this.sep[0]]:[],n=r?[this.sep[0]]:[];e=Ge(e,s,t,n),a=Ge(a,new Array(t.length+s.length+n.length).fill(1))}return{tokens:e,token_type_ids:a}}},rm=tm,am=class extends lr{constructor(e){super(e),this.processors=(e.processors??[]).map(t=>Ai(t))}post_process(e,t=null,r=!0){let a={tokens:e,tokens_pair:t};for(let s of this.processors)a=s.post_process(a.tokens,a.tokens_pair,r);return a}},sm=am;function nm(e){if(e===null)return null;switch(e.type){case"TemplateProcessing":return new Xp(e);case"ByteLevel":return new Zp(e);case"BertProcessing":return new em(e);case"RobertaProcessing":return new rm(e);case"Sequence":return new sm(e);default:throw new Error(`Unknown PostProcessor type: ${e.type}`)}}var Ai=nm,im=class extends or{constructor(e){super(),this.config=e,this.added_tokens=[],this.end_of_word_suffix=null,this.trim_offsets="trim_offsets"in e?e.trim_offsets:!1}_call(e){return this.decode(e)}decode(e){return this.decode_chain(e).join("")}},Je=im,um=class extends Je{constructor(e){super(e),this.byte_decoder=up,this.text_decoder=new TextDecoder("utf-8",{fatal:!1,ignoreBOM:!0}),this.end_of_word_suffix=null}convert_tokens_to_string(e){let t=e.join(""),r=new Uint8Array([...t].map(a=>this.byte_decoder[a]));return this.text_decoder.decode(r)}decode_chain(e){let t=[],r=[];for(let a of e)this.added_tokens.find(s=>s.content===a)!==void 0?(r.length>0&&(t.push(this.convert_tokens_to_string(r)),r=[]),t.push(a)):r.push(a);return r.length>0&&t.push(this.convert_tokens_to_string(r)),t}},om=um,lm=class extends Je{constructor(e){super(e),this.cleanup=e.cleanup}decode_chain(e){return e.map((t,r)=>{if(r!==0){let a=this.config.prefix;a&&t.startsWith(a)?t=t.replace(a,""):t=" "+t}return this.cleanup&&(t=Ra(t)),t})}},cm=lm,dm=class extends Je{constructor(e){super(e),this.replacement=e.replacement??"▁"}decode_chain(e){let t=[];for(let r=0;r<e.length;++r){let a=e[r].replaceAll(this.replacement," ");r==0&&a.startsWith(" ")&&(a=a.substring(1)),t.push(a)}return t}},fm=dm,pm=class extends Je{constructor(e){super(e),this.suffix=e.suffix??""}decode_chain(e){return e.map((t,r)=>t.replaceAll(this.suffix,r===e.length-1?"":" "))}},mm=pm,hm=class extends Je{constructor(e){super(e),this.pad_token=e.pad_token??"",this.word_delimiter_token=e.word_delimiter_token??"",this.cleanup=e.cleanup}convert_tokens_to_string(e){if(e.length===0)return"";let t=[e[0]];for(let a=1;a<e.length;++a)e[a]!==t.at(-1)&&t.push(e[a]);let r=t.filter(a=>a!==this.pad_token).join("");return this.cleanup&&(r=Ra(r).replaceAll(this.word_delimiter_token," ").trim()),r}decode_chain(e){return[this.convert_tokens_to_string(e)]}},gm=hm,wm=class extends Je{constructor(e){super(e),this.decoders=(e.decoders??[]).map(t=>Bi(t))}decode_chain(e){return this.decoders.reduce((t,r)=>r.decode_chain(t),e)}},bm=wm,vm=class extends Je{constructor(e){super(e),this.pattern=zr(this.config.pattern)}decode_chain(e){let t=this.config.content??"",r=this.pattern;return r===null?e:e.map(a=>a.replaceAll(r,t))}},_m=vm,ym=class extends Je{decode_chain(e){return[e.join("")]}},km=ym,xm=class extends Je{constructor(e){super(e),this.content=e.content??"",this.start=e.start??0,this.stop=e.stop??0}decode_chain(e){return e.map(t=>{let r=0;for(let s=0;s<this.start&&t[s]===this.content;++s)r=s+1;let a=t.length;for(let s=0;s<this.stop;++s){let n=t.length-s-1;if(t[n]===this.content){a=n;continue}else break}return t.slice(r,a)})}},Sm=xm,qm=class extends Je{constructor(e){super(e),this.text_decoder=new TextDecoder}decode_chain(e){let t=[],r=[];for(let a of e){let s=null;if(a.length===6&&a.startsWith("<0x")&&a.endsWith(">")){let n=parseInt(a.slice(3,5),16);isNaN(n)||(s=n)}if(s!==null)r.push(s);else{if(r.length>0){let n=this.text_decoder.decode(Uint8Array.from(r));t.push(n),r=[]}t.push(a)}}if(r.length>0){let a=this.text_decoder.decode(Uint8Array.from(r));t.push(a),r=[]}return t}},Em=qm;function Tm(e){if(e===null)return null;switch(e.type){case"ByteLevel":return new om(e);case"WordPiece":return new cm(e);case"Metaspace":return new fm(e);case"BPEDecoder":return new mm(e);case"CTC":return new gm(e);case"Sequence":return new bm(e);case"Replace":return new _m(e);case"Fuse":return new km(e);case"Strip":return new Sm(e);case"ByteFallback":return new Em(e);default:throw new Error(`Unknown Decoder type: ${e.type}`)}}var Bi=Tm,Im=class{constructor(e,t){let r=yi(e,"Tokenizer",["model","decoder","post_processor","pre_tokenizer","normalizer"]);if(r)throw new Error(r);let a=yi(t,"Config");if(a)throw new Error(a);this.tokenizer=e,this.config=t,this.normalizer=ki(this.tokenizer.normalizer),this.pre_tokenizer=Si(this.tokenizer.pre_tokenizer),this.model=Vp(this.tokenizer.model,this.config),this.post_processor=Ai(this.tokenizer.post_processor),this.decoder=Bi(this.tokenizer.decoder),this.special_tokens=[],this.all_special_ids=[],this.added_tokens=[];let s=[],n=[];this.added_tokens_map=new Map;for(let i of this.tokenizer.added_tokens){let u=new sf(i);if(this.added_tokens.push(u),this.model.tokens_to_ids.set(u.content,u.id),this.model.vocab[u.id]=u.content,u.special&&(this.special_tokens.push(u.content),this.all_special_ids.push(u.id)),this.added_tokens_map.set(u.content,u),u.normalized&&this.normalizer!==null){let o=this.normalizer(u.content);n.push(o),this.added_tokens_map.set(o,u)}else s.push(u.content)}(this.config.additional_special_tokens??[]).forEach(i=>{this.special_tokens.includes(i)||this.special_tokens.push(i)}),this.decoder&&(this.decoder.added_tokens=this.added_tokens,this.decoder.end_of_word_suffix=this.model.end_of_word_suffix),this.splitter_unnormalized=new si(s),this.splitter_normalized=new si(n),this.remove_space=this.config.remove_space,this.clean_up_tokenization_spaces=this.config.clean_up_tokenization_spaces??!0,this.do_lowercase_and_remove_accent=this.config.do_lowercase_and_remove_accent??!1}encode(e,{text_pair:t=null,add_special_tokens:r=!0,return_token_type_ids:a=null}={}){let{tokens:s,token_type_ids:n}=this.tokenize_helper(e,{text_pair:t,add_special_tokens:r}),i=s.map(o=>this.added_tokens_map.get(o)?.id??this.model.tokens_to_ids.get(o)??this.model.unk_token_id),u={ids:i,tokens:s,attention_mask:new Array(i.length).fill(1)};return a&&n&&(u.token_type_ids=n),u}decode(e,t={}){if(!Array.isArray(e)||e.length===0||!Ef(e[0]))throw Error("token_ids must be a non-empty array of integers.");let r=e.map(s=>this.model.vocab[Number(s)]??this.model.unk_token);t.skip_special_tokens&&(r=r.filter(s=>!this.special_tokens.includes(s)));let a=this.decoder?this.decoder(r):r.join(" ");return this.decoder&&this.decoder.end_of_word_suffix&&(a=a.replaceAll(this.decoder.end_of_word_suffix," "),t.skip_special_tokens&&(a=a.trim())),(t.clean_up_tokenization_spaces??this.clean_up_tokenization_spaces)&&(a=Ra(a)),a}tokenize(e,{text_pair:t=null,add_special_tokens:r=!1}={}){return this.tokenize_helper(e,{text_pair:t,add_special_tokens:r}).tokens}encode_text(e){if(e===null)return null;let t=this.splitter_unnormalized.split(e);return t.forEach((r,a)=>{let s=this.added_tokens_map.get(r);s&&(s.lstrip&&a>0&&(t[a-1]=t[a-1].trimEnd()),s.rstrip&&a<t.length-1&&(t[a+1]=t[a+1].trimStart()))}),t.flatMap((r,a)=>{if(r.length===0)return[];if(this.added_tokens_map.has(r))return[r];if(this.remove_space===!0&&(r=r.trim().split(/\s+/).join(" ")),this.do_lowercase_and_remove_accent&&(r=If(r)),this.normalizer!==null&&(r=this.normalizer(r)),r.length===0)return[];let s=this.splitter_normalized.split(r);return s.forEach((n,i)=>{let u=this.added_tokens_map.get(n);u&&(u.lstrip&&i>0&&(s[i-1]=s[i-1].trimEnd()),u.rstrip&&i<s.length-1&&(s[i+1]=s[i+1].trimStart()))}),s.flatMap(n=>{if(n.length===0)return[];if(this.added_tokens_map.has(n))return[n];let i=this.pre_tokenizer!==null?this.pre_tokenizer(n,{section_index:a}):[n];return this.model(i)})})}tokenize_helper(e,{text_pair:t=null,add_special_tokens:r=!0}){let a=this.encode_text(e),s=this.encode_text(t||null);return this.post_processor?this.post_processor(a,s,r):{tokens:Ge(a??[],s??[])}}token_to_id(e){return this.model.tokens_to_ids.get(e)}id_to_token(e){return this.model.vocab[e]}get_added_tokens_decoder(){let e=new Map;for(let t of this.added_tokens)e.set(t.id,t);return e}get_vocab(e=!0){let t=new Map;for(let r=0;r<this.model.vocab.length;++r){let a=this.model.vocab[r];(e||!this.added_tokens_map.has(a))&&t.set(a,r)}return t}},Am=Im;function Qa(e){return typeof e=="string"?e.trim():""}function cr(e,t){try{return e[t]}catch{return}}function ji(e){let t=cr(e,"constructor");return typeof t=="object"||typeof t=="function"?Qa(cr(t,"name")):""}function Bm(e){let t=Qa(cr(e,"name"));if(t&&t!=="Error")return t;let r=ji(e);return r&&r!=="Error"&&r!=="Object"?r:""}function Mi(e){if(e===null)return"null thrown";if(e===void 0)return"undefined thrown";if(typeof e=="object"){let t=cr(e,"message"),r=typeof t=="string"?t:"",a=Bm(e);if(r.trim())return a&&!r.startsWith(a)?`${a}: ${r}`:r;let s=a||ji(e)||"unknown error",n=cr(e,"cause"),i=n===void 0?"":Mi(n);if(i&&i!==s)return`${s} (no message; caused by ${i})`;if(!(e instanceof Error)){let u=Di(e);if(u&&u!=="[object Object]"&&u!==s)return`${s}: ${u}`}return`${s} (no message)`}return Di(e)||`${typeof e} thrown`}function Di(e){try{return Qa(String(e))}catch{return""}}function $i(e,t=0){return`${(e/(1024*1024)).toFixed(t)} MiB`}jr(),Sa(),qe();function Hr(e,t,r){return e===1?t:r!==void 0?r:/(s|x|z|ch|sh)$/.test(t)?`${t}es`:`${t}s`}var Fi=new Map;function dr(e){return e==null?e:Array.isArray(e)?e.map(dr):e instanceof Map?Object.fromEntries([...e].map(([t,r])=>[t,dr(r)])):typeof e=="object"&&"value"in e?e.type==="NullValue"?null:dr(e.value):e}function le(e){return((...t)=>e(...t.map(dr)))}var Pi=Object.freeze({ceil:le(e=>Math.ceil(e)),floor:le(e=>Math.floor(e)),min:le((...e)=>Math.min(...e)),max:le((...e)=>Math.max(...e)),pow:le((e,t)=>Math.pow(e,t)),ceilDiv:le((e,t)=>Math.ceil(e/t)),pow2ceil:le(e=>e<=1?1:2**Math.ceil(Math.log2(e))),log2ceil:le(e=>e<=1?0:Math.ceil(Math.log2(e))),numel:le(e=>e.reduce((t,r)=>t*r,1)),dim:le((e,t)=>{let r=(t%e.length+e.length)%e.length;return e[r]}),rows:le((e,t)=>{let r=(t%e.length+e.length)%e.length;return e.reduce((a,s,n)=>n===r?a:a*s,1)}),outer:le((e,t)=>{let r=(t%e.length+e.length)%e.length;return e.slice(0,r).reduce((a,s)=>a*s,1)}),inner:le((e,t)=>{let r=(t%e.length+e.length)%e.length;return e.slice(r+1).reduce((a,s)=>a*s,1)}),broadcastable:le((e,t)=>{if(e.length>t.length)return!1;let r=t.length-e.length;return e.every((a,s)=>a===1||a===t[s+r])}),sameShape:le((e,t)=>e.length===t.length&&e.every((r,a)=>r===t[a])),hasAxis:le((e,t,r)=>{let a=(t%r+r)%r;return e.some(s=>(s%r+r)%r===a)}),has:le((e,t)=>e instanceof Map?e.has(t):!!(e&&Object.prototype.hasOwnProperty.call(e,t))),dtypeBytes:le(e=>{let t=Fe[Ur(e)];if(!t)throw new Error(`Unsupported dtype for dtypeBytes(): ${e}`);return t.storageByteSize}),pick:le((e,t)=>{if(!Array.isArray(e))throw new Error("pick() expects a list of [condition, value] pairs as its first argument");for(let r of e){if(!Array.isArray(r)||r.length<2)throw new Error("pick() entries must be [condition, value] pairs");if(r[0])return r[1]}return t})});function jm(e){let t=Fe[Ur(e)];if(!t)throw new Error(`Unsupported WebGPU dtype: ${e}`);return t.wgslScalar}function Ur(e){return e==="f32"?"float32":e==="f16"?"float16":e==="u32"?"uint32":e==="i32"?"int32":Zt(e)}var Mm=["f16Ok","f16Allowed"],Dm=["repeat","constants","tunables","dtypes","tensorDtypes","ranks","shapes","present","source","args","attrs","device"],Ci=new WeakMap;function Ka(e){let t=Dt(e),r=Ci.get(t);return r===void 0&&(r={features:t.features,wgslLanguageFeatures:t.wgslLanguageFeatures,limits:t.limits,adapterInfo:Cc(t)},Ci.set(t,r)),r}var $m=[["true",!0],["false",!1],["none",null],["True",!0],["False",!1],["None",null]];function nt(e,t={}){if(typeof e!="string")return e;let r=Ni(e),a=new Map;for(let i of new Set([...r.freeIdentifiers,...r.probedIdentifiers]))a.set(i,Li(t,i));let s=r.freeIdentifiers.filter(i=>!a.get(i)?.present);if(s.length>0)throw new Error(`Unknown ${Hr(s.length,"identifier")} ${s.map(i=>`"${i}"`).join(", ")} in WebGPU expression: ${e}
Identifiers resolve against the expression scope. Namespaces: ${[...Dm].sort().join(", ")} (plus the bare names declared in \`derive\`).
device sub-fields: features, wgslLanguageFeatures, limits, adapterInfo.
Helper functions: ${[...Object.keys(Pi),...Mm].join(", ")}.
If a string literal was intended, quote it (e.g. '"${s[0]}"' not '${s[0]}').`);if(r.statement===void 0)throw r.parseError??new Error(`Empty WebGPU expression: ${e}`);let n=new at;for(let[i,u]of $m)n.set(i,u);for(let i of r.freeIdentifiers)n.set(i,a.get(i)?.value);for(let i of r.probedIdentifiers){let u=a.get(i);u?.present&&n.set(i,u.value)}return dr(new ri(n).evaluate(r.statement,n))}var Fm=Object.freeze({present:!1});function Xa(e,t){return e!==void 0&&Object.prototype.propertyIsEnumerable.call(e,t)?{present:!0,value:e[t]}:null}function Li(e,t,r=!0){let a=e;if(t==="env"&&a.env!==void 0)return{present:!0,value:a.env};let s=Xa(e.constants,t);if(s)return s;switch(t){case"repeat":return{present:!0,value:e.repeat??{}};case"constants":return{present:!0,value:e.constants??{}};case"tunables":return{present:!0,value:e.tunables??{}}}let n=Xa(e.derived,t);if(n)return n;switch(t){case"dtypes":return{present:!0,value:e.dtypes??{}};case"tensorDtypes":return{present:!0,value:e.tensorDtypes??{}};case"ranks":return{present:!0,value:e.ranks??{}};case"shapes":return{present:!0,value:e.shapes??{}};case"present":return{present:!0,value:e.present??{}};case"source":return{present:!0,value:e.sourceContext??{}};case"args":return{present:!0,value:e.args??{}};case"attrs":return{present:!0,value:e.attrs??{}};case"device":return{present:!0,value:Ka(e.device)};case"f16Ok":case"f16Allowed":{let u=Ka(e.device).features.has("shader-f16");return t==="f16Ok"?{present:!0,value:le(o=>o!=="f16"&&o!=="float16"||u)}:{present:!0,value:le(o=>o==="f32"||o==="float32"||(o==="f16"||o==="float16")&&u)}}}return Xa(Pi,t)||(r&&t in Object.prototype?{present:!0,value:Object.prototype[t]}:Fm)}function Pm(e,t={}){let r=Cm(e),a=Lm(e,r.parsed),s={};for(let n of a){let i=Li(t,n,!1);i.present&&(s[n]=i.value)}return r.render(s)}function Cm(e){let t=Fi.get(e);return t||(t=new ai(e),Fi.set(e,t)),t}var zi=new Map;function Lm(e,t){let r=zi.get(e);if(r!==void 0)return r;let a=new Set,s=i=>{if(!i||typeof i!="object")return;if(Array.isArray(i)){for(let o of i)s(o);return}if(i instanceof Map){for(let[o,l]of i)s(o),s(l);return}let u=i;u.type==="Identifier"&&typeof u.value=="string"&&a.add(u.value);for(let o of Object.keys(u))o!=="type"&&s(u[o])};s(t);let n=a;return zi.set(e,n),n}var Oi=new Map,zm=Object.freeze({lstrip_blocks:!0,trim_blocks:!0}),Om=new Set(["true","false","none","True","False","None"]);function Ni(e){let t=Oi.get(e);if(t!==void 0)return t;let r=new Set,a=new Set,s=u=>{if(!u||typeof u!="object")return;if(Array.isArray(u)){for(let l of u)s(l);return}if(u instanceof Map){for(let[l,c]of u)s(l),s(c);return}let o=u;switch(o.type){case"Identifier":Om.has(o.value)||r.add(o.value);return;case"MemberExpression":s(o.object),o.computed&&s(o.property);return;case"BinaryExpression":s(o.left),s(o.right);return;case"UnaryExpression":s(o.argument);return;case"FilterExpression":{s(o.operand);let l=o.filter;l?.type==="CallExpression"&&s(l.args);return}case"TestExpression":{let l=o.test,c=o.operand;(l?.value==="defined"||l?.value==="undefined")&&c?.type==="Identifier"?a.add(c.value):s(o.operand);return}case"CallExpression":s(o.callee),s(o.args);return;case"KeywordArgumentExpression":s(o.value);return;default:{for(let[l,c]of Object.entries(o))l!=="type"&&s(c);return}}},n,i;try{let u=Qn(Rn(`{{ ${e} }}`,zm));n=u.body[0],s(u)}catch(u){i=u}for(let u of r)a.delete(u);return t=Object.freeze({statement:n,...i!==void 0?{parseError:i}:{},freeIdentifiers:Object.freeze([...r]),probedIdentifiers:Object.freeze([...a])}),Oi.set(e,t),t}function Nm(e){let t=Ni(e);return{free:t.freeIdentifiers,probed:t.probedIdentifiers,parseError:t.parseError!==void 0}}function lt(e,t){let r={};for(let[a,s]of Object.entries(e??{}))r[a]=ct(s,t);return r}function ct(e,t){return typeof e=="string"?nt(e,t):Array.isArray(e)?e.map(r=>ct(r,t)):e&&typeof e=="object"?Object.fromEntries(Object.entries(e).map(([r,a])=>[r,ct(a,t)])):e}jr(),Sa();var Wm=new Set(["read-only-storage","storage","uniform"]);function Ya(e){let t=e instanceof Map?new Map(e):new Map(Object.entries(e));return Object.freeze({readText(r){let a=t.get(r);if(a===void 0)throw new Error(`WebGPU template asset is missing: ${r}`);return a},has(r){return t.has(r)}})}function Gm(e){He(e,"WebGPU manifest");let t=e.domain??"ai.onnx";Th(t,"WebGPU manifest domain");let r=e.name;if(typeof r!="string"||r.length===0)throw new Error("WebGPU manifest requires a non-empty name");if(!Array.isArray(e.inputs))throw new Error(`WebGPU manifest ${t}.${r} requires inputs`);if(!Array.isArray(e.outputs))throw new Error(`WebGPU manifest ${t}.${r} requires outputs`);if(!dt(e.args)||Object.keys(e.args).length===0)throw new Error(`WebGPU manifest ${t}.${r} requires explicit args`);Eh(e.args,`${t}.${r}.args`);let a=Xm(e,`${t}.${r}`);Qi(e.derive,`WebGPU manifest ${t}.${r} derive`);let s=Ym(e,a);return Object.freeze({domain:t,name:r,id:`${t}.${r}`,sinceVersion:e.sinceVersion,inputs:Object.freeze([...e.inputs]),outputs:Object.freeze([...e.outputs]),args:Object.freeze({...e.args}),attributes:Object.freeze({...e.attributes??{}}),derive:Object.freeze({...e.derive??{}}),typeConstraints:Object.freeze({...e.typeConstraints??{}}),tunables:Object.freeze({...e.tunables??{}}),variants:Object.freeze(s)})}function Rm(e){let t=new Map;for(let[r,a]of Object.entries(e)){if(a.kind!=="tensor")continue;let s=new Set([r,a.semantic].filter(n=>typeof n=="string"&&n.length>0));for(let n of s){let i=t.get(n);i?i.push(r):t.set(n,[r])}}for(let[r,a]of t)a.length<2&&t.delete(r);return t}function Hm(e){let t=Rm(e),r=new Map;for(let[a,s]of Object.entries(e)){if(s.kind!=="tensor")continue;let n=new Set([a,s.semantic].filter(i=>typeof i=="string"&&i.length>0));r.set(a,[...n].filter(i=>!t.has(i)))}return r}function Um(e){let t=new Map;for(let[r,a]of Object.entries(e))a.kind==="tensor"&&a.semantic&&t.set(a.semantic,r);return r=>t.get(r)??r}function Vm(e){return e.map(t=>ts(t)?zl(t.name,rn(t.struct.name,t.struct.fields.map(qh)),{semantic:t.semantic}):Ll(t.name,{arg:t.arg,access:t.buffer.type==="storage"?"read_write":"read",elementType:t.elementType,semantic:t.semantic}))}var Qm="main",Km=["shader","bindings","profile","submitAfter","dispatch"];function Xm(e,t){let r=new Map;for(let[a,s]of Object.entries(e.bindingSets??{})){if(!Array.isArray(s)||s.length===0)throw new Error(`WebGPU manifest ${t} bindingSet "${a}" must be a non-empty binding array`);r.set(a,s)}return r}function Wi(e,t,r){if(Array.isArray(e))return e;if(typeof e=="string"){let a=t.get(e);if(!a)throw new Error(`WebGPU ${r} references unknown bindingSet "${e}"`);return a}throw new Error(`WebGPU ${r} bindings must be an array or a bindingSet name`)}function Ym(e,t){let r=`${e.domain??"ai.onnx"}.${e.name}`,a=Km.filter(o=>e[o]!==void 0);if(a.length>0)throw new Error(`WebGPU manifest ${r} has pass ${Hr(a.length,"field")} at the top level: ${a.join(", ")}. Declare ${a.length===1?"it":"them"} on variants[].passes[] (kernel-authoring framework, §4).`);let s=Ri(e,r);if(s.length===0)throw new Error(`WebGPU manifest ${r} requires a non-empty variants list`);let n=rs(e.constants,`WebGPU manifest ${r} constants`),i=s.map((o,l)=>ih(o,l,t,n)),u=new Set;for(let o of i){if(u.has(o.id))throw new Error(`WebGPU manifest ${r} has duplicate expanded variant id "${o.id}"`);u.add(o.id)}return bh(i,r),i}function Gi(e,t){return t.priority-e.priority}function Ri(e,t){let r=[...e.variants??[]];for(let[a,s]of(e.variantFamilies??[]).entries()){if(!Array.isArray(s.variants)||s.variants.length===0)throw new Error(`WebGPU manifest ${t}: a variantFamily requires at least one base variant`);let n=s.axes!==void 0,i=s.cases!==void 0;if(n===i)throw new Error(`WebGPU manifest ${t}: a variantFamily requires exactly one of axes or cases`);let u;if(s.axes!==void 0){let o=Object.keys(s.axes);if(o.length===0)throw new Error(`WebGPU manifest ${t}: a variantFamily requires at least one axis`);for(let l of o){if(!/^[A-Za-z_]\w*$/.test(l))throw new Error(`WebGPU manifest ${t}: variantFamily axis "${l}" must be an identifier`);let c=s.axes[l];if(!Array.isArray(c)||c.length===0)throw new Error(`WebGPU manifest ${t}: variantFamily axis "${l}" must be a non-empty array`);for(let d of c){if(!Vr(d,!1))throw new Error(`WebGPU manifest ${t}: variantFamily axis "${l}" values must be finite numbers or strings`);if(d===bt)throw new Error(`WebGPU manifest ${t}: variantFamily axis "${l}" values cannot use the reserved "${bt}" sentinel (use cases)`)}}u=Zm(o,s.axes)}else{let o=s.cases;if(!Array.isArray(o)||o.length===0)throw new Error(`WebGPU manifest ${t}: variantFamily cases must be a non-empty array`);let l=(d,f)=>{if(!Hi(d)||Object.keys(d).length===0)throw new Error(`WebGPU manifest ${t}: variantFamily ${f} must be a non-empty record`);for(let[p,m]of Object.entries(d)){if(!/^[A-Za-z_]\w*$/.test(p))throw new Error(`WebGPU manifest ${t}: variantFamily ${f} key "${p}" must be an identifier`);if(!Qr(m))throw new Error(`WebGPU manifest ${t}: variantFamily ${f} values must be non-null finite JSON values`)}},c=o.some(d=>Array.isArray(d));if(c&&!o.every(d=>Array.isArray(d)))throw new Error(`WebGPU manifest ${t}: variantFamily cases must be either case records or crossed case groups, not both`);if(c){let d=o;for(let[f,p]of d.entries()){if(p.length===0)throw new Error(`WebGPU manifest ${t}: variantFamily case group ${f} must be a non-empty array`);for(let[m,h]of p.entries())l(h,`case group ${f} case ${m}`)}u=Jm(d,t)}else{for(let[d,f]of o.entries())l(f,`case ${d}`);u=o}}for(let[o,l]of u.entries())for(let[c,d]of s.variants.entries()){let f=s.axes!==void 0?"axis combination":"case",p=`WebGPU manifest ${t}: variantFamily ${a} ${f} ${o} template ${c}`,m=fr(d,l,!0,[],p);Xr(m,p,`variantFamilies[${a}].variants[${c}]`),r.push(m)}}return r}function Vr(e,t){return typeof e=="string"||typeof e=="number"&&Number.isFinite(e)||t&&typeof e=="boolean"}function Qr(e,t=new Set){if(Vr(e,!0))return!0;if(e===null||typeof e!="object"||t.has(e))return!1;t.add(e);let r;if(Array.isArray(e)){r=!0;for(let a=0;a<e.length;a+=1)if(!Object.hasOwn(e,a)||!Qr(e[a],t)){r=!1;break}}else Hi(e)?r=Object.values(e).every(a=>Qr(a,t)):r=!1;return t.delete(e),r}function Hi(e){if(e===null||typeof e!="object"||Array.isArray(e))return!1;let t=Object.getPrototypeOf(e);return t===Object.prototype||t===null}function Zm(e,t){let r=[{}];for(let a of e)r=r.flatMap(s=>t[a].map(n=>({...s,[a]:n})));return r}function Jm(e,t){let r=[{}];for(let a of e)r=r.flatMap(s=>a.map(n=>{for(let i of Object.keys(n))if(Object.hasOwn(s,i))throw new Error(`WebGPU manifest ${t}: variantFamily crossed case groups both define "${i}"`);return{...s,...n}}));return r}var bt="@omit",Ui=Symbol("variantFamily.omit");function eh(e,t,r){let a=e.at(-1);if(typeof a=="number")throw new Error(`${r}: "${bt}" substitution "{${t}}" must replace a whole object member, not the array element at ${Ja(e)} (substitute an empty array to splice nothing)`);if(e.length===0||a==="id"||e.length===1&&e[0]==="passes")throw new Error(`${r}: "${bt}" substitution "{${t}}" cannot remove ${Ja(e)}, which is required`)}function fr(e,t,r=!1,a=[],s="variantFamily"){if(typeof e=="string"){if(r){let n=Vi.exec(e);if(n&&Object.hasOwn(t,n[1])){let i=t[n[1]];if(i===bt)return eh(a,n[1],s),Ui;if(!Vr(i,!0)&&!ah(a))throw new Error(`${s}: structured substitution "{${n[1]}}" is not supported at ${Ja(a)}; structured whole values are limited to variant when/demoteWhen/supersededBy/constants/derive/tunables/intermediates/requires, requires.features/limits/subgroupMatrixConfigs, and pass constants/dispatch/viewAlias/source.inputs`);return Yr(i)}}return e.replace(/\{([A-Za-z_]\w*)\}/g,(n,i)=>{if(!Object.hasOwn(t,i))return n;let u=t[i];if(u===bt)throw new Error(`variantFamily "${bt}" substitution "{${i}}" must occupy the whole value`);if(!Vr(u,!0))throw new Error(`variantFamily structured substitution "{${i}}" must occupy the whole value`);return String(u)})}if(Array.isArray(e)){let n=r&&sh(a),i=[];for(let u=0;u<e.length;u+=1){let o=e[u],l=n&&typeof o=="string"?Vi.exec(o):null,c=l!==null&&Object.hasOwn(t,l[1])?t[l[1]]:void 0;if(Array.isArray(c)){for(let d of c)i.push(Yr(d));continue}i.push(fr(o,t,r,[...a,u],s))}return i}if(e!==null&&typeof e=="object"){let n=[],i=new Set;for(let[u,o]of Object.entries(e)){let l=fr(u,t,!1,[...a,u],s),c=String(l);if(i.has(c))throw new Error(`variantFamily substitution produced duplicate object key "${c}"`);i.add(c);let d=fr(o,t,r,[...a,u],s);d!==Ui&&n.push([c,d])}return Object.fromEntries(n)}return e}var Vi=/^\{([A-Za-z_]\w*)\}$/,th=new Set(["when","demoteWhen","supersededBy","constants","derive","tunables","intermediates","requires"]),rh=new Set(["features","limits","subgroupMatrixConfigs"]);function ah(e){if(e.length===1&&typeof e[0]=="string"&&th.has(e[0])||e.length===2&&e[0]==="requires"&&typeof e[1]=="string"&&rh.has(e[1]))return!0;let t=e.at(-1);return t==="inputs"&&e.at(-2)==="source"&&Za(e.slice(0,-2))||e.at(-2)==="inputs"&&e.at(-3)==="source"&&Za(e.slice(0,-3))?!0:t!=="constants"&&t!=="dispatch"&&t!=="viewAlias"?!1:Za(e.slice(0,-1))}function sh(e){return e.length===1&&(e[0]==="when"||e[0]==="demoteWhen"||e[0]==="supersededBy")}function Za(e){if(e.length<2||e.length%2!==0)return!1;for(let t=0;t<e.length;t+=2)if(e[t]!=="passes"||typeof e[t+1]!="number")return!1;return!0}function Ja(e){return e.length===0?"variant":`variant${e.map(t=>typeof t=="number"?`[${t}]`:`.${t}`).join("")}`}function nh(e,t,r){return fr(e,t,!0,[],r)}function Kr(e,t=new Set){if(typeof e=="string"){for(let r of e.matchAll(/\{([A-Za-z_]\w*)\}/g))t.add(r[1]);return t}if(Array.isArray(e)){for(let r of e)Kr(r,t);return t}if(e!==null&&typeof e=="object")for(let[r,a]of Object.entries(e))Kr(r,t),Kr(a,t);return t}function Xr(e,t,r){if(typeof e=="string"){let a=/\{[A-Za-z_]\w*\}/.exec(e);if(a!==null)throw new Error(`${t} leaves unresolved placeholder "${a[0]}" at ${r}`);return}if(Array.isArray(e)){for(let a=0;a<e.length;a+=1)Xr(e[a],t,`${r}[${a}]`);return}if(e!==null&&typeof e=="object")for(let[a,s]of Object.entries(e)){let n=/\{[A-Za-z_]\w*\}/.exec(a);if(n!==null)throw new Error(`${t} leaves unresolved placeholder "${n[0]}" in object key at ${r}`);Xr(s,t,`${r}.${a}`)}}function Yr(e){return Array.isArray(e)?e.map(Yr):e!==null&&typeof e=="object"?Object.fromEntries(Object.entries(e).map(([t,r])=>[t,Yr(r)])):e}function Qi(e,t){if(dt(e)&&Object.hasOwn(e,"$use"))throw new Error(`${t} still carries a "$use" shared-derive splice — expand the manifest through shared-libraries.ts before normalizing it`)}function ih(e,t,r,a={}){He(e,"WebGPU variant");let s=e.id??`variant_${t}`;if(typeof s!="string")throw new Error(`WebGPU variant id must be a string, got ${JSON.stringify(s)}`);let n=e.priority??0;if(typeof n!="number"||!Number.isFinite(n))throw new Error(`WebGPU variant ${s} priority must be a finite number`);if(!/^[A-Za-z0-9][A-Za-z0-9_]*$/.test(s))throw new Error(`WebGPU variant id must be stable, got ${s}`);let i=e.passes;if(!Array.isArray(i)||i.length===0)throw new Error(`WebGPU variant ${s} requires passes`);let u=e.bindings!==void 0?Wi(e.bindings,r,`variant ${s}`):void 0;Qi(e.derive,`WebGPU variant ${s} derive`);let o=Ki(i,u,r,s),l=Xi(o);return Object.freeze({id:s,priority:n,when:hh(e.when,s),demoteWhen:gh(e.demoteWhen,s),supersededBy:wh(e.supersededBy,s),requires:yh(e),tunables:Object.freeze({...e.tunables??{}}),derive:Object.freeze({...e.derive??{}}),constants:Object.freeze({...a,...rs(e.constants,`WebGPU variant ${s} constants`)}),intermediates:Object.freeze(xh(e.intermediates,s)),passes:Object.freeze(l),passSequence:Object.freeze(o)})}function Ki(e,t,r,a,s=new Set){return e.map((n,i)=>{if(!uh(n))return ch(n,t,i,r);let u=n.id??`repeat_${i}`;if(typeof u!="string"||!/^[A-Za-z0-9][A-Za-z0-9_]*$/.test(u))throw new Error(`WebGPU variant ${a} repeat group id must be stable, got ${String(u)}`);He(n.repeat,`WebGPU repeat group ${u}.repeat`);let o=n.repeat.index;if(typeof o!="string"||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(o))throw new Error(`WebGPU repeat group ${u} index must be an identifier, got ${String(o)}`);if(o==="index"||o==="count")throw new Error(`WebGPU repeat group ${u} index cannot use reserved repeat member ${o}`);if(s.has(o))throw new Error(`WebGPU repeat group ${u} index ${o} shadows an outer repeat index`);if(n.repeat.count===void 0)throw new Error(`WebGPU repeat group ${u} requires repeat.count`);if(!Array.isArray(n.passes)||n.passes.length===0)throw new Error(`WebGPU repeat group ${u} requires passes`);let l=new Set(s);return l.add(o),Object.freeze({kind:"repeat",id:u,count:n.repeat.count,index:o,passes:Object.freeze(Ki(n.passes,t,r,a,l))})})}function uh(e){return dt(e)&&"repeat"in e}function Xi(e){let t=[];for(let r of e)oh(r)?t.push(...Xi(r.passes)):t.push(r);return t}function oh(e){return"kind"in e&&e.kind==="repeat"}function lh(e,t){if(!e||typeof e!="object")return e;let r=e,a="threads"in e,s="workgroups"in e,n="gridStride"in e,i=Number(a)+Number(s)+Number(n);if(i===0)return e;if(i>1)throw new Error(`WebGPU pass ${t} dispatch must use exactly one of 'threads'+'workgroupSize', 'workgroups', or 'gridStride'[+'workgroupSize']`);let u=["x","y","z"].filter(l=>r[l]!==void 0);if(n){if(u.length)throw new Error(`WebGPU pass ${t} dispatch 'gridStride' shorthand takes no 'x'/'y'/'z' axis (it clamps without folding)`);let l=r.workgroupSize!==void 0?`ceilDiv((${vt(r.gridStride,t)}), (${vt(r.workgroupSize,t)}))`:vt(r.gridStride,t);return es(l,!1)}if(u.length>1)throw new Error(`WebGPU pass ${t} dispatch shorthand may pin at most one axis ('x', 'y', or 'z'); the overflow fold needs two free axes`);let o={};for(let l of u)o[l]=vt(r[l],t);if(a){if(r.workgroupSize===void 0)throw new Error(`WebGPU pass ${t} dispatch shorthand requires both 'threads' and 'workgroupSize'`);return es(`ceilDiv((${vt(r.threads,t)}), (${vt(r.workgroupSize,t)}))`,!0,o)}if(r.workgroupSize!==void 0)throw new Error(`WebGPU pass ${t} dispatch 'workgroups' shorthand takes no 'workgroupSize' (use 'threads'+'workgroupSize' instead)`);return es(vt(r.workgroups,t),!0,o)}var Yi="device.limits.maxComputeWorkgroupsPerDimension";function es(e,t,r={}){let a=`min(${e}, ${Yi})`;if(!t)return Object.freeze({x:a,y:1,z:1});let s=`ceilDiv(${e}, ${Yi})`,n=["x","y","z"],i={x:1,y:1,z:1};for(let o of n)r[o]!==void 0&&(i[o]=r[o]);let u=n.filter(o=>r[o]===void 0);return i[u[0]]=a,i[u[1]]=s,Object.freeze(i)}function vt(e,t){if(typeof e=="string")return e;if(typeof e=="number"&&Number.isFinite(e))return String(e);throw new Error(`WebGPU pass ${t} dispatch threads/workgroupSize must be an expression string or finite number, got ${typeof e}`)}function ch(e,t,r,a){He(e,`WebGPU pass ${r}`);let s=e.id??`pass_${r}`;if(typeof s!="string"||s.length===0)throw new Error(`WebGPU pass ${r} id must be a non-empty string`);if(e.name!==void 0&&(typeof e.name!="string"||e.name.length===0))throw new Error(`WebGPU pass ${s} name must be a non-empty string`);if(e.submitAfter!==void 0&&typeof e.submitAfter!="boolean")throw new Error(`WebGPU pass ${s} submitAfter must be a boolean`);let n=fh(e,s);if(!e.dispatch)throw new Error(`WebGPU pass ${s} requires dispatch`);He(e.dispatch,`WebGPU pass ${s} dispatch`);let i=lh(e.dispatch,s),u=e.bindings!==void 0?Wi(e.bindings,a,`pass ${s}`):t;if(!Array.isArray(u)||u.length===0)throw new Error(`WebGPU pass ${s} requires bindings`);let o=Object.freeze(u.map(ph));return Object.freeze({id:s,...e.name?{name:e.name}:{},source:n,entryPoint:Qm,bindings:o,constants:Object.freeze(rs(e.constants,`WebGPU pass ${s} constants`)),dispatch:i,profile:Object.freeze({...e.profile??{}}),submitAfter:e.submitAfter===!0,...e.viewAlias?{viewAlias:dh(e.viewAlias,o,`pass ${e.id??r}`)}:{}})}function dh(e,t,r){if(!Array.isArray(e)||e.length===0)throw new Error(`WebGPU ${r} viewAlias must be a non-empty array of { input, output } binding-name pairs`);let a=n=>t.find(i=>i.name===n)?.buffer.type,s=e.map(n=>{if(typeof n?.input!="string"||typeof n?.output!="string")throw new Error(`WebGPU ${r} viewAlias pair must be { "input": <binding>, "output": <binding> }`);if(a(n.input)!=="read-only-storage")throw new Error(`WebGPU ${r} viewAlias.input "${n.input}" must name a read-only-storage binding of the pass`);if(a(n.output)!=="storage")throw new Error(`WebGPU ${r} viewAlias.output "${n.output}" must name a storage (read_write) binding of the pass`);return Object.freeze({input:n.input,output:n.output})});return Object.freeze(s)}function fh(e,t){let r=`WebGPU pass ${t}`,a=e.source;if(a!==void 0){He(a,`${r}.source`);let s=a.shader??e.shader;if(typeof s!="string"||s.length===0)throw new Error(`${r} source requires shader`);if(e.shader!==void 0&&e.shader!==s)throw new Error(`${r} has conflicting shader and source.shader`);if(a.inputs!==void 0&&!dt(a.inputs))throw new Error(`${r} source inputs must be an object`);return Object.freeze({shader:s,inputs:Object.freeze({...a.inputs??{}})})}if(typeof e.shader!="string"||e.shader.length===0)throw new Error(`${r} requires shader or source`);return Object.freeze({shader:e.shader,inputs:Object.freeze({})})}function ph(e,t){He(e,`WebGPU binding ${t}`);for(let n of["semantic","arg","elementType"])if(e[n]!==void 0&&typeof e[n]!="string")throw new Error(`WebGPU binding ${e.name??t} ${n} must be a string`);let r=e.buffer?.type;if(!r||!Wm.has(r))throw new Error(`WebGPU binding ${e.name??t} has invalid buffer type`);let a=e.name??e.semantic;if(typeof a!="string"||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(a))throw new Error(`WebGPU binding requires a WGSL-compatible name, got ${String(a)}`);if(e.struct!==void 0&&mh(e.struct,a),e.optional!==void 0)throw new Error(`WebGPU binding ${e.name??t} cannot be optional; use a separate variant`);let s={name:a,...e.semantic!==void 0?{semantic:e.semantic}:{},...e.arg!==void 0?{arg:e.arg}:{}};if(r==="uniform"){if(!e.struct)throw new Error(`WebGPU uniform binding ${a} requires struct`);return Object.freeze({...s,buffer:{type:r},...e.elementType?{elementType:e.elementType}:{},struct:e.struct})}if(!e.elementType)throw new Error(`WebGPU storage binding ${a} requires elementType`);return Object.freeze({...s,buffer:{type:r},elementType:e.elementType,...e.struct?{struct:e.struct}:{}})}function ts(e){return e.buffer.type==="uniform"}function mh(e,t){if(He(e,`WebGPU uniform binding ${t} struct`),typeof e.name!="string"||e.name.length===0)throw new Error(`WebGPU uniform binding ${t} struct name must be a non-empty string`);if(!Array.isArray(e.fields)||e.fields.length===0)throw new Error(`WebGPU uniform binding ${t} struct fields must be a non-empty array`);for(let[r,a]of e.fields.entries()){if(He(a,`WebGPU uniform binding ${t} field ${r}`),typeof a.name!="string"||a.name.length===0)throw new Error(`WebGPU uniform binding ${t} field ${r} name must be a non-empty string`);if(!["u32","i32","f32"].includes(a.type))throw new Error(`WebGPU uniform binding ${t} field ${a.name} has invalid type ${String(a.type)}`)}}function hh(e,t){if(e===void 0)return!0;if(Array.isArray(e)){if(e.length===0)throw new Error(`WebGPU variant ${t} when[] must be a non-empty list of predicates`);for(let r of e)if(typeof r!="string"||r.length===0)throw new Error(`WebGPU variant ${t} when[] entries must be non-empty expression strings, got ${JSON.stringify(r)}`);return Object.freeze([...e])}if(typeof e!="string"&&typeof e!="boolean")throw new Error(`WebGPU variant ${t} when must be a string, boolean, or string[], got ${JSON.stringify(e)}`);return e}function gh(e,t){if(e===void 0)return null;if(!Array.isArray(e))throw new Error(`WebGPU variant ${t} demoteWhen must be a string[], got ${JSON.stringify(e)}`);if(e.length===0)throw new Error(`WebGPU variant ${t} demoteWhen[] must be a non-empty list of predicates`);for(let r of e)if(typeof r!="string"||r.length===0)throw new Error(`WebGPU variant ${t} demoteWhen[] entries must be non-empty expression strings, got ${JSON.stringify(r)}`);return Object.freeze([...e])}function wh(e,t){if(e===void 0)return null;if(!Array.isArray(e))throw new Error(`WebGPU variant ${t} supersededBy must be a string[], got ${JSON.stringify(e)}`);if(e.length===0)throw new Error(`WebGPU variant ${t} supersededBy[] must be a non-empty list of variant ids`);for(let r of e)if(typeof r!="string"||r.length===0)throw new Error(`WebGPU variant ${t} supersededBy[] entries must be non-empty variant ids, got ${JSON.stringify(r)}`);return Object.freeze([...e])}function bh(e,t){let r=new Map(e.map(s=>[s.id,s])),a=new Map(e.map((s,n)=>[s.id,n]));for(let s of e)for(let n of s.supersededBy??[]){if(n===s.id)throw new Error(`WebGPU manifest ${t} variant "${s.id}" lists itself in supersededBy`);let i=r.get(n);if(!i)throw new Error(`WebGPU manifest ${t} variant "${s.id}" supersededBy names unknown variant "${n}"`);if((Gi(i,s)||(a.get(n)??0)-(a.get(s.id)??0))>=0)throw new Error(`WebGPU manifest ${t} variant "${s.id}" (priority ${s.priority}) is supersededBy "${n}" (priority ${i.priority}), which does not outrank it. supersededBy removes a variant where a HIGHER-ranked sibling already covers the shape; to express the reverse, put the guard on the other variant.`)}}var Zi=new Set(["features","limits","subgroupMinSize","subgroupMatrixConfigs"]),vh=new Set(Fr),_h=new Set(Pa);function yh(e){let t=`WebGPU variant ${e.id??"?"}`;if(e.requires===void 0)return null;if(!dt(e.requires))throw new Error(`${t} requires must be an object`);for(let l of Object.keys(e.requires))if(!Zi.has(l))throw new Error(`${t} requires has unknown key "${l}"; expected one of ${[...Zi].join(", ")}`);let{features:r,limits:a,subgroupMinSize:s,subgroupMatrixConfigs:n}=e.requires,i=Sh(r,`${t} requires.features`);for(let l of i)if(!vh.has(l))throw new Error(`${t} requires.features has unknown feature "${l}"; expected one of ${Fr.join(", ")}`);if(a!==void 0&&!dt(a))throw new Error(`${t} requires.limits must be an object`);for(let[l,c]of Object.entries(a??{})){if(!_h.has(l))throw new Error(`${t} requires.limits has unknown limit "${l}"; not a canonical WebGPU limit name`);if(typeof c!="number"||!Number.isFinite(c))throw new Error(`${t} requires.limits.${l} must be a finite number`)}let u=kh(n,t);if(s!==void 0&&(!Number.isInteger(s)||s<1))throw new Error(`${t} requires.subgroupMinSize must be a positive integer`);let o={...i.length>0?{features:i}:{},...a&&Object.keys(a).length>0?{limits:a}:{},...s!==void 0?{subgroupMinSize:s}:{},...u!==null?{subgroupMatrixConfigs:u}:{}};return Object.keys(o).length===0?null:o}function kh(e,t){if(e===void 0)return null;if(!Array.isArray(e)||e.length===0)throw new Error(`${t} requires.subgroupMatrixConfigs must be a non-empty array of config patterns`);let r=Ca,a=e.map((s,n)=>{let i=`${t} requires.subgroupMatrixConfigs[${n}]`;if(!dt(s))throw new Error(`${i} must be an object with optional componentType/resultComponentType/M/N/K`);let u=Object.keys(s).filter(l=>!["componentType","resultComponentType","M","N","K"].includes(l));if(u.length>0)throw new Error(`${i} has unknown ${u.length===1?"key":"keys"} ${u.join(", ")}`);for(let l of["componentType","resultComponentType"]){let c=s[l];if(c!==void 0&&(typeof c!="string"||!r.includes(c)))throw new Error(`${i}.${l} must be one of ${r.join(", ")}, got ${JSON.stringify(c)}`)}for(let l of["M","N","K"]){let c=s[l];if(c!==void 0&&(!Number.isInteger(c)||c<1))throw new Error(`${i}.${l} must be a positive integer, got ${JSON.stringify(c)}`)}let o={...s.componentType!==void 0?{componentType:s.componentType}:{},...s.resultComponentType!==void 0?{resultComponentType:s.resultComponentType}:{},...s.M!==void 0?{M:s.M}:{},...s.N!==void 0?{N:s.N}:{},...s.K!==void 0?{K:s.K}:{}};if(Object.keys(o).length===0)throw new Error(`${i} must constrain at least one field (an empty pattern matches everything)`);return Object.freeze(o)});return Object.freeze(a)}function xh(e,t){if(e===void 0)return[];if(!Array.isArray(e))throw new Error(`WebGPU variant ${t} intermediates must be an array`);return e.map((r,a)=>{if(He(r,`WebGPU variant ${t} intermediate ${a}`),typeof r.id!="string"||r.id.length===0)throw new Error(`WebGPU variant ${t} intermediate ${a} id must be a non-empty string`);if(typeof r.dtype!="string"||r.dtype.length===0)throw new Error(`WebGPU variant ${t} intermediate ${r.id} dtype must be a non-empty string`);return Object.freeze({id:r.id,dtype:r.dtype,shape:r.shape})})}function Sh(e,t){if(e===void 0)return[];if(!Array.isArray(e)||![...e].every(r=>typeof r=="string"))throw new Error(`${t} must be an array of strings`);return[...e]}function qh(e){if(e.type==="u32")return Il(e.name,e);if(e.type==="i32")return Al(e.name,e);if(e.type==="f32")return Bl(e.name,e);throw new Error(`Unsupported WebGPU uniform field type: ${e.type}`)}function Eh(e,t){for(let[r,a]of Object.entries(e)){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(r))throw new Error(`${t}.${r} is not a valid arg name`);if(!["tensor","u32","i32","f32","bool","string"].includes(a.kind))throw new Error(`${t}.${r} has unsupported kind ${String(a.kind)}`)}}function Th(e,t){if(!/^[a-z][a-z0-9]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(e))throw new Error(`${t} must be a dotted canonical domain, got ${e}`)}function He(e,t){if(!dt(e))throw new Error(`${t} must be an object`)}function rs(e,t){return e===void 0?{}:(He(e,t),{...e})}function dt(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}function K_(e,t){if(typeof e!="object"||e===null||Array.isArray(e))throw new Error(`${t} must be an object of named binding lists`);let r=new Map;for(let[a,s]of Object.entries(e)){if(!Array.isArray(s)||s.length===0)throw new Error(`${t} entry "${a}" must be a non-empty binding array`);r.set(a,s)}return r}function pr(e){return typeof e=="object"&&e!==null&&!Array.isArray(e)}function X_(e,t){let r=new Set(Object.entries(e.bindingSets??{}).filter(([,g])=>typeof g!="string").map(([g])=>g)),a=g=>{if(Array.isArray(g))return g.map(a);if(typeof g!="object"||g===null)return g;let v={};for(let[w,y]of Object.entries(g)){if(w==="bindings"&&typeof y=="string"&&!r.has(y)){let q=t.get(y);v[w]=q===void 0?y:q;continue}v[w]=a(y)}return v},s=a(e);if(s.bindingSets===void 0&&s.bindingEntries===void 0)return s;let n=`WebGPU manifest ${e.domain}.${e.name}`,i=s.bindingEntries;if(i!==void 0){if(!pr(i))throw new Error(`${n} bindingEntries must be an object of named binding entries`);for(let[g,v]of Object.entries(i))if(!pr(v))throw new Error(`${n} bindingEntries "${g}" must be a binding object`)}let{bindingEntries:u,...o}=s;if(s.bindingSets===void 0)return o;let l=s.bindingSets,c=new Map,d=[],f=(g,v)=>{let w=g.slice(1),y=i!==void 0&&Object.hasOwn(i,w)?i[w]:void 0;if(y===void 0)throw new Error(`${n} ${v} references unknown bindingEntries name "${w}"`);return y},p=(g,v)=>{if(!Object.hasOwn(l,g))throw new Error(`${n} ${v} references unknown bindingSet "${g}"`);return m(g)},m=g=>{let v=c.get(g);if(v!==void 0)return v;if(d.includes(g))throw new Error(`${n} bindingSet "${g}" is defined in terms of itself (${[...d,g].join(" -> ")})`);d.push(g);let w=h(g,l[g]);return d.pop(),c.set(g,w),w},h=(g,v)=>{let w=`bindingSet "${g}"`;if(typeof v=="string"){let y=t.get(v);if(y===void 0)throw new Error(`${n} ${w} references unknown shared binding set "${v}"`);return y}if(Array.isArray(v)){let y=[];for(let[q,k]of v.entries()){if(typeof k=="string"){if(!k.startsWith("@"))throw new Error(`${n} ${w} member ${q} must be a binding object, an "@name" bindingEntries reference, or a { "$from": … } splice`);y.push(f(k,`${w} member ${q}`));continue}if(pr(k)&&Object.hasOwn(k,"$from")){if(Object.keys(k).length!==1||typeof k.$from!="string")throw new Error(`${n} ${w} member ${q} splice must be exactly { "$from": "<setName>" }`);y.push(...p(k.$from,`${w} member ${q}`));continue}if(!pr(k))throw new Error(`${n} ${w} member ${q} must be a binding object, an "@name" bindingEntries reference, or a { "$from": … } splice`);y.push(k)}return y}if(pr(v)&&Object.hasOwn(v,"from")){let y=Object.keys(v).filter(z=>z!=="from"&&z!=="omit");if(y.length>0)throw new Error(`${n} ${w} derived set has unknown ${y.length===1?"key":"keys"} ${y.join(", ")}`);let q=v.from;if(typeof q!="string")throw new Error(`${n} ${w} derived set "from" must be a bindingSet name`);let k=v.omit??[];if(!Array.isArray(k)||!k.every(z=>typeof z=="string"))throw new Error(`${n} ${w} derived set "omit" must be an array of binding names`);let D=p(q,w),I=new Set(k),B=D.filter(z=>z.name===void 0||!I.has(z.name)),F=[...I].filter(z=>!D.some(W=>W.name===z));if(F.length>0)throw new Error(`${n} ${w} omits ${F.map(z=>`"${z}"`).join(", ")}, which bindingSet "${q}" does not declare`);return B}throw new Error(`${n} ${w} must be a binding array, a shared binding set name, or { "from": "<setName>", "omit": [ … ] }`)},b={};for(let g of Object.keys(l))b[g]=m(g);return{...o,bindingSets:b}}var Y_="_shared/variants.json",Z_="_shared/derives.json",as="use",Ji="with",mr="$use",eu=/^[A-Za-z_]\w*$/;function ft(e){return typeof e=="object"&&e!==null&&!Array.isArray(e)}function ss(e){return ft(e)&&Object.hasOwn(e,as)}function J_(e,t){if(!ft(e))throw new Error(`${t} must be an object of named variants fragments`);let r=new Map;for(let[a,s]of Object.entries(e)){if(!Array.isArray(s)||s.length===0)throw new Error(`${t} entry "${a}" must be a non-empty variants array`);r.set(a,s)}return r}function e2(e,t){if(!ft(e))throw new Error(`${t} must be an object of named derive groups`);let r=new Map;for(let[a,s]of Object.entries(e)){if(!ft(s)||Object.keys(s).length===0)throw new Error(`${t} entry "${a}" must be a non-empty derive record`);for(let n of Object.keys(s))if(!(n===mr||eu.test(n)))throw new Error(`${t} entry "${a}" derive name "${n}" must be an identifier`);r.set(a,s)}return r}function t2(e,t){return Ah(Ih(e,t.variants),t.derives)}function Ih(e,t){let r=e.variants;if(!Array.isArray(r)||!r.some(ss))return e;let a=`WebGPU manifest ${e.domain}.${e.name}`,s=(u,o)=>{let l=Object.keys(u).filter(g=>g!==as&&g!==Ji);if(l.length>0)throw new Error(`${a} ${o} has unknown ${l.length===1?"key":"keys"} ${l.join(", ")}`);let c=u[as];if(typeof c!="string")throw new Error(`${a} ${o} "use" must name a shared variants entry`);let d=u[Ji]??{};if(!ft(d))throw new Error(`${a} ${o} "with" must be an object of substitutions`);for(let[g,v]of Object.entries(d))if(!Qr(v))throw new Error(`${a} ${o} substitution "${g}" must be a non-null finite JSON value`);let f=n(c,o),p=new Set;for(let g of f)Kr(g,p);let m=[...p].filter(g=>!Object.hasOwn(d,g)).sort(),h=Object.keys(d).filter(g=>!p.has(g)).sort();if(m.length>0||h.length>0){let g=[m.length>0?`does not substitute ${m.map(v=>`"${v}"`).join(", ")}`:"",h.length>0?`substitutes ${h.map(v=>`"${v}"`).join(", ")}, which it does not use`:""].filter(v=>v.length>0);throw new Error(`${a} ${o} ${g.join(" and ")} (shared variants entry "${c}")`)}let b=`${a} ${o}`;return f.map(g=>nh(g,d,b))};function n(u,o){let l=t.get(u);if(l===void 0)throw new Error(`${a} ${o} references unknown shared variants entry "${u}"`);for(let[c,d]of l.entries())if(ss(d))throw new Error(`${a} ${o}: shared variants entry "${u}" member ${c} is itself a "use" reference; shared variants entries are flat — inline the referenced entry's templates instead`);return l}let i=[];for(let[u,o]of r.entries()){if(!ss(o)){i.push(o);continue}let l=`variants[${u}]`,c=`${a} ${l}`;for(let[d,f]of s(o,l).entries())Xr(f,c,`${l} + ${d}`),i.push(f)}return{...e,variants:i}}function Ah(e,t){if(!ns(e))return e;let r=`WebGPU manifest ${e.domain}.${e.name}`;function a(i,u){let o=t.get(i);if(o===void 0)throw new Error(`${r} ${u} references unknown shared derive group "${i}"`);if(Object.hasOwn(o,mr))throw new Error(`${r} ${u}: shared derive group "${i}" carries its own "$use"; shared derive groups are flat — inline the referenced group's entries instead`);return s(o,`shared derive group "${i}"`,`shared derive group "${i}"`)}function s(i,u,o){let l={},c=new Map,d=(f,p,m)=>{if(!eu.test(f))throw new Error(`${r} ${o} derive name "${f}" must be an identifier`);let h=c.get(f);if(h!==void 0)throw new Error(`${r} ${o} defines derive "${f}" twice (${h}, then ${m})`);c.set(f,m),l[f]=p};for(let[f,p]of Object.entries(i)){if(f!==mr){d(f,p,u);continue}if(!Array.isArray(p)||p.length===0||!p.every(m=>typeof m=="string"))throw new Error(`${r} ${o} "$use" must be a non-empty array of shared derive group names`);for(let m of p)for(let[h,b]of Object.entries(a(m,o)))d(h,b,`shared derive group "${m}"`)}return l}let n=(i,u)=>{if(Array.isArray(i))return i.map((l,c)=>n(l,`${u}[${c}]`));if(!ft(i))return i;let o={};for(let[l,c]of Object.entries(i)){let d=u===""?l:`${u}.${l}`;if(l==="derive"&&ft(c)&&Object.hasOwn(c,mr)){o[l]=s(c,"the manifest",d);continue}o[l]=n(c,d)}return o};return n(e,"")}function ns(e){return Array.isArray(e)?e.some(ns):ft(e)?Object.hasOwn(e,mr)||Object.values(e).some(ns):!1}jr(),qe();function Zr(e){if(typeof e=="number"){if(Number.isNaN(e))return"NaN";if(e===Number.POSITIVE_INFINITY)return"Infinity";if(e===Number.NEGATIVE_INFINITY)return"-Infinity";if(Object.is(e,-0))return"-0"}if(Array.isArray(e))return`[${e.map(Zr).join(",")}]`;if(e&&typeof e=="object"){let t=e;return`{${Object.keys(t).sort().map(r=>`${JSON.stringify(r)}:${Zr(t[r])}`).join(",")}}`}return JSON.stringify(e)}var tu=class{entries=new Map;hits=0;misses=0;get(e){let t=this.entries.get(e);if(t===void 0){this.misses+=1;return}return this.hits+=1,t}getOrCreate(e,t){let r=this.get(e);if(r!==void 0)return r;let a=t();return this.entries.set(e,a),a}clear(){this.entries.clear(),this.hits=0,this.misses=0}},Bh=class extends tu{},jh=class extends tu{};function ru(e){return{attrs:e.attrs,dtypes:e.dtypes,tensorDtypes:e.tensorDtypes,ranks:e.ranks,tunables:e.tunables}}function Mh(e,t,r,a=null){return Lt({op:e.id,sinceVersion:e.sinceVersion,variant:t.id,...ru(r),specialization:a,device:rr(r.device),bindings:t.passes.map(s=>s.bindings.map(n=>({name:n.name,binding:void 0,group:void 0,type:n.buffer.type,elementType:n.elementType,struct:Dh(n.struct)})))})}function Dh(e){return e&&{name:e.name,fields:e.fields.map(t=>({name:t.name,type:t.type}))}}function $h(e){return Lt({shapes:e.shapes,args:e.args})}function Fh(e,t){return`${e}|shapes=${t}`}var Lt=Zr;function Ph(e){let t=2166136261;for(let r=0;r<e.length;++r)t^=e.charCodeAt(r),t=Math.imul(t,16777619);return(t>>>0).toString(16).padStart(8,"0")}function Ch(e){return`${Ph(e)}:${e.length}`}function Lh(e,t,r){let a=t.map((s,n)=>{let i=s.offset??0,u=s.size!==void 0&&s.size>0?s.size:"";return`${s.binding??n}:${r(s)}:${i}:${u}`});return`${e}|${a.join("|")}`}qe();function zh(e,t,r=!1){return e.map(a=>{let s=r?[0]:Oh(ct(a.shape,t),a.id),n=Ur(a.dtype);return Object.freeze({id:a.id,dtype:n,shape:s,byteLength:ke(s)*Oe(n)})})}function Oh(e,t){let r=Array.isArray(e)?e:[e];if(r.length===0)throw new Error(`WebGPU scratch ${t} shape must not be empty`);return Object.freeze(r.map(a=>{if(!Number.isInteger(a)||Number(a)<0)throw new Error(`WebGPU scratch ${t} shape dimension must be a nonnegative integer, got ${String(a)}`);return Number(a)}))}var au=65535,Jr=131072;function Nh(e,t){let r=[];if(su(e.passSequence,t,t.repeat,"","",!1,r),r.length>Jr)throw new Error(`WebGPU variant ${e.id} expands to ${r.length} passes; maximum is ${Jr}`);let a=new Set;for(let s of r){if(a.has(s.id))throw new Error(`WebGPU variant ${e.id} expands duplicate pass id ${s.id}`);a.add(s.id)}return Object.freeze(r)}function Wh(e){return e.some(nu)}function su(e,t,r,a,s,n,i){for(let u of e){if(!nu(u)){if(i.push(Object.freeze({pass:u,id:`${a}${u.id}`,pipelineBaseId:`${s}${u.id}`,repeat:r,repeated:n})),i.length>Jr)return;continue}let o=nt(u.count,{...t,repeat:r});if(!Number.isInteger(o)||Number(o)<0||Number(o)>au)throw new Error(`WebGPU repeat group ${u.id} count must resolve to an integer in [0, ${au}], got ${String(o)}`);let l=Number(o);for(let c=0;c<l;++c){let d=Object.freeze({...r,index:c,count:l,[u.index]:c,[`${u.index}_count`]:l});if(su(u.passes,t,d,`${a}${u.id}[${c}].`,`${s}${u.id}.`,!0,i),i.length>Jr)return}}}function nu(e){return"kind"in e&&e.kind==="repeat"}var Gh=Object.freeze({f16:"shader-f16",subgroups:"subgroups",chromium_experimental_subgroup_matrix:"chromium-experimental-subgroup-matrix"}),Rh=/^\s*enable\s+([^;]+);/,Hh=/@workgroup_size\s*\(([^)]*)\)/;function iu(e){let t=[];for(let r of e.split(`
`)){let a=Rh.exec(r);if(a)for(let s of a[1].split(",")){let n=s.trim();n.length>0&&!t.includes(n)&&t.push(n)}}return t}var Uh=/\bconst\s+([A-Za-z_]\w*)\s*:\s*u32\s*=\s*([^;]+);/g;function uu(e,t,r){let a=e.match(/\d+u?|[A-Za-z_]\w*|[()+\-*/]/g);if(a===null||a.join("").length!==e.replace(/\s+/g,"").length)return null;let s=a,n=0,i=()=>{let c=s[n++];if(c===void 0)return null;if(c==="("){let p=o();return s[n++]===")"?p:null}if(/^\d+u?$/.test(c))return Number.parseInt(c,10);if(!/^[A-Za-z_]\w*$/.test(c))return null;let d=t.get(c);if(d===void 0||r.has(c))return null;r.add(c);let f=uu(d,t,r);return r.delete(c),f},u=()=>{let c=i();for(;c!==null&&(s[n]==="*"||s[n]==="/");){let d=s[n++],f=i();if(f===null||d==="/"&&f===0)return null;c=d==="*"?c*f:Math.floor(c/f)}return c};function o(){let c=u();for(;c!==null&&(s[n]==="+"||s[n]==="-");){let d=s[n++],f=u();if(f===null)return null;c=d==="+"?c+f:c-f}return c}let l=o();return n===s.length&&l!==null&&Number.isSafeInteger(l)&&l>=0?l:null}function Vh(e){let t=e.replace(/\/\*[\s\S]*?\*\//g,"").replace(/\/\/[^\n\r]*/g,""),r=t.match(Hh)?.[1]?.split(",").map(n=>n.trim())??[];if(r.length===0||r.length>3)return null;let a=new Map;for(let[,n,i]of t.matchAll(Uh))a.set(n,i);let s=(r.length===3?r:[...r,...Array.from({length:3-r.length},()=>"1u")]).map(n=>uu(n,a,new Set));return s.every(n=>n!==null&&n>0)?[s[0],s[1],s[2]]:null}function Qh(e,t){let r=[];for(let a of e){let s=Gh[a];s&&!t.has(s)&&r.push(`enable ${a}; (requires device feature "${s}")`)}return r}function ou(e){return typeof e=="string"?e:String(e)}function Kh(e,t){let r=ou(e);return{kind:"whenFailed",clause:r,value:String(t),message:`when clause failed: \`${r}\` → ${String(t)}`}}function Xh(e){let t=0,r=0;for(let a of e.passes){let s=0,n=0;for(let i of a.bindings){let u=i.buffer?.type;u&&(u==="uniform"?n+=1:s+=1)}t=Math.max(t,s),r=Math.max(r,n)}return{storage:t,uniform:r}}function Yh(e,t){let{storage:r,uniform:a}=Xh(e),s=t.limits.maxStorageBuffersPerShaderStage;if(typeof s=="number"&&r>s)return`needs ${r} storage buffers per shader stage, device allows ${s} (maxStorageBuffersPerShaderStage)`;let n=t.limits.maxUniformBuffersPerShaderStage;return typeof n=="number"&&a>n?`needs ${a} uniform buffers per shader stage, device allows ${n} (maxUniformBuffersPerShaderStage)`:null}function Zh(e,t){let r={};for(let a of Object.keys(e)){let s=e[a];s!==void 0&&(r[a]=ea(s)?{dtype:s.dtype,shape:s.shape}:s)}return Lt({inputs:r,args:t.args??{},attrs:t.attrs??{}})}var lu=new WeakMap;function Jh(e){let t=lu.get(e);if(t!==void 0)return t;let r=Object.entries(e.derive),a=new Set(r.map(([u])=>u)),s=new Set,n=u=>{if(typeof u=="string"){let o=Nm(u);for(let l of[...o.free,...o.probed])!a.has(l)||s.has(l)||(s.add(l),n(e.derive[l]));return}if(Array.isArray(u)){for(let o of u)n(o);return}if(u&&typeof u=="object")for(let o of Object.values(u))n(o)};for(let u of e.outputs)u.shape!==void 0&&n(u.shape);let i=Object.freeze(r.filter(([u])=>s.has(u)).map(([u,o])=>Object.freeze([u,o])));return lu.set(e,i),i}var eg=class{manifest;assets;programCache;planCache;prepareCache=new Map;explainCache=new Map;inferCache=new Map;scopeNamesByArg;acceptedArgKeys;acceptedResourceKeys;variantsById;constructor(e,t={}){this.manifest=Gm(e),this.assets=sg(t.assets??{}),this.programCache=t.programCache??new Bh,this.planCache=t.planCache??new jh,this.scopeNamesByArg=Hm(this.manifest.args),this.variantsById=new Map(this.manifest.variants.map(a=>[a.id,a])),this.acceptedArgKeys=new Set(Object.keys(this.manifest.args));let r=new Set(this.acceptedArgKeys);for(let a of this.manifest.variants)for(let s of a.passes)for(let n of s.bindings)r.add(n.name),n.arg&&r.add(n.arg);this.acceptedResourceKeys=r}get prepareCacheSize(){return this.prepareCache.size}explain(e,t,r={}){let a=Dt(e.device),s=this.buildBaseScope(a,t),n=pu(e.device,s,r.variant),i=this.explainCache.get(n);if(i)return i;let u=this.applyManifestDerive(s),o=new Map,l=this.variantCandidates(r.variant).map(f=>{let p=this.checkVariant(f,u,o);return p.ok?{id:f.id,ok:!0,demoted:p.demotions.length>0?Object.freeze([...p.demotions]):null}:{id:f.id,ok:!1,rejection:p.rejection}}),c=null;for(let f of l)if(f.ok){if(f.demoted===null){c=f.id;break}c??=f.id}let d={selected:c,candidates:l};return this.explainCache.set(n,d),d}prepare(e,t,r={}){this.validateRequest(t);let a=Dt(e.device),s=this.buildBaseScope(a,t),n=pu(e.device,s,r.variant),i=this.prepareCache.get(n);if(i)return{program:i.program,plan:i.plan,request:t};let u=this.applyManifestDerive(s),{variant:o,scope:l}=this.selectVariantAndScope(u,t,r.variant),c=Nh(o,l),d=Mh(this.manifest,o,l,this.programSpecialization(o,l,c)),f=this.programCache.getOrCreate(d,()=>this.buildProgram(d,o,l,c)),p=$h(l),m=Fh(d,p),h=this.planCache.getOrCreate(m,()=>this.buildPlan(m,d,o,l,c));return this.prepareCache.set(n,{program:f,plan:h}),{program:f,plan:h,request:t}}clearPreparedState(){this.prepareCache.clear(),this.explainCache.clear(),this.programCache.clear(),this.planCache.clear()}inferOutputs(e,t={}){let r=Zh(e,t),a=this.inferCache.get(r);if(a)return a;this.rejectUnknownKeys(this.manifest.id,"binding",e,t.args);let s=Um(this.manifest.args);for(let l of this.manifest.outputs){if(l.shape!==void 0||l.optional)continue;let c=s(l.role),d=e[c];if(d===void 0||!ea(d))throw new Error(`${this.manifest.id}: output "${l.role}" has no shape expression — add outputs[].shape to ops/${this.manifest.id}/manifest.json, or pass "${c}" as an explicit destination.`)}let n={};for(let[l,c]of Object.entries(e))c!==void 0&&(n[l]=ea(c)?og(c):c);let i={resources:n,...t.args?{args:t.args}:{},...t.attrs?{attrs:t.attrs}:{}},u=this.applyManifestDeriveForInference(this.buildBaseScope(Dt(void 0),i)),o={};for(let l of this.manifest.outputs){let c=s(l.role);if(l.shape===void 0){let f=e[c];if(f!==void 0&&ea(f)){o[c]={role:l.role,shape:[...f.shape],dtype:this.resolveOutputDtype(l,u)};continue}if(l.optional)continue;throw new Error(`${this.manifest.id}: output "${l.role}" has no shape expression — add outputs[].shape to ops/${this.manifest.id}/manifest.json, or pass "${c}" as an explicit destination.`)}let d=typeof l.shape=="string"?nt(l.shape,u):l.shape.map(f=>ct(f,u));if(!Array.isArray(d)||!d.every(f=>Number.isInteger(f)&&f>=0))throw new Error(`${this.manifest.id}: output "${l.role}" shape evaluated to ${JSON.stringify(d)} (expected non-negative integers)`);o[c]={role:l.role,shape:d,dtype:this.resolveOutputDtype(l,u)}}return this.inferCache.set(r,o),o}resolveOutputDtype(e,t){if(!e.dtype)return"float32";if(ug.has(e.dtype))return e.dtype;let r=t.dtypes[e.dtype];if(typeof r=="string")return Ur(r);let a=this.manifest.typeConstraints[e.dtype],s=t.tensorDtypes;for(let n of this.manifest.inputs){let i=s[n.role];if(typeof i=="string"&&(!Array.isArray(a)||a.includes(i)))return i}throw new Error(`${this.manifest.id}: output "${e.role}" dtype "${e.dtype}" is a constraint var with no bound input — pass a dtype override or bind an input sharing the var.`)}async run(e,t,r={}){let a=this.prepare(e,t,r),{executeWebGpuPlan:s}=await Promise.resolve().then(()=>(ln(),nn));return await s(e,a,r.runOptions??{}),a}buildProgram(e,t,r,a){let s=new Map,n=a.map(i=>this.buildProgramPass(t,i,r,s));return Object.freeze({key:e,op:this.manifest.id,variant:t.id,passes:Object.freeze(n)})}buildProgramPass(e,t,r,a){let s=t.pass,n={...r,repeat:t.repeat},i=this.passConstants(e,s,n),u={...n,constants:i},o=Br(Vm(s.bindings)),l=[Nl(o),Ol(o,i)].filter(Boolean).join(`
`),c=this.passSourceInputs(s.source,u),d={...u,sourceContext:c},f=this.buildTemplateSource(e,s,d,l),p=t.pipelineBaseId;if(t.repeated){let h=a.get(t.pipelineBaseId);h===void 0&&(h=new Map,a.set(t.pipelineBaseId,h));let b=h.get(f);b!==void 0?(f=b.source,p=b.pipelineCacheId):(p=`${t.pipelineBaseId}|source=${h.size}`,h.set(f,{source:f,pipelineCacheId:p}))}let m=lt(s.profile,d);return Object.freeze({id:t.id,pipelineCacheId:p,name:s.name??`${this.manifest.id}.${e.id}.${s.id}`,source:f,constants:i,workgroupSize:Vh(f),enables:iu(f),entryPoint:s.entryPoint,bindings:o,bindingSpecs:s.bindings,...Object.keys(m).length>0?{profile:m}:{},...s.submitAfter?{submitAfter:!0}:{},...s.viewAlias?{viewAlias:s.viewAlias}:{}})}buildTemplateSource(e,t,r,a){let s=cu(t.source.shader,this.assets.readText(t.source.shader),u=>this.assets.readText(u),new Set),n=Pm(s,{...r,env:{device:Ka(r.device),wgsl:{resourceDeclarations:a}}}),i=Qh(iu(n),r.device.features);if(i.length>0)throw new Error(`WebGPU op ${this.manifest.id} variant ${e.id} pass ${t.id} rendered WGSL enable directives the device does not support: ${i.join(", ")}. Gate the directive in the template (env.device.features) or declare the feature in the variant's requires.features.`);return n}programSpecialization(e,t,r){return Wh(e.passSequence)?{variant:lt(e.constants,t),passes:r.map(a=>{let s=a.pass,n={...t,repeat:a.repeat};return{id:a.id,pipelineBaseId:a.pipelineBaseId,constants:lt(s.constants,n),source:this.passSourceSpecialization(e,s,n),...s.submitAfter?{submitAfter:!0}:{}}})}:{variant:lt(e.constants,t),passes:e.passes.map(a=>({id:a.id,constants:lt(a.constants,t),source:this.passSourceSpecialization(e,a,t),...a.submitAfter?{submitAfter:!0}:{}}))}}passSourceSpecialization(e,t,r){let a=this.passConstants(e,t,r),s={...r,constants:a};return{shader:t.source.shader,inputs:this.passSourceInputs(t.source,s)}}buildPlan(e,t,r,a,s){let n=this.allOutputsEmpty(a),i=zh(r.intermediates,a,n),u=s.map(o=>this.buildPlanPass(r,o,a,n));return Object.freeze({key:e,programKey:t,scratches:i,passes:Object.freeze(u)})}allOutputsEmpty(e){let t=0;for(let[r,a]of Object.entries(this.manifest.args)){if(a.role!=="output"&&a.role!=="inout")continue;let s=e.resources[r];if(!Jt(s)||(t+=1,s.shape.reduce((n,i)=>n*i,1)!==0))return!1}return t>0}buildPlanPass(e,t,r,a){let s=t.pass,n={...r,repeat:t.repeat},i=this.passConstants(e,s,n);if(a)return Object.freeze({id:t.id,dispatchWorkgroups:[0,0,0],uniforms:this.zeroFilledUniforms(s)});let u={...n,constants:i},o={...u,sourceContext:this.passSourceInputs(s.source,u)},l=s.bindings.filter(ts).reduce((c,d)=>(c[d.name]=this.uniformValues(d,o),c),{});return Object.freeze({id:t.id,dispatchWorkgroups:this.passDispatchWorkgroups(s,o),uniforms:l})}zeroFilledUniforms(e){let t={};for(let r of e.bindings)ts(r)&&(t[r.name]=Object.fromEntries(r.struct.fields.map(a=>[a.name,0])));return t}passDispatchWorkgroups(e,t){let r=t.device.limits.maxComputeWorkgroupsPerDimension;return[nt(e.dispatch.x,t),nt(e.dispatch.y??1,t),nt(e.dispatch.z??1,t)].map((a,s)=>{if(!Number.isInteger(a)||Number(a)<0)throw new Error(`WebGPU pass ${e.id} dispatch axis ${s} must resolve to a nonnegative integer, got ${String(a)}`);if(Number(a)>r)throw new Error(`WebGPU pass ${e.id} dispatch axis ${s} = ${a} exceeds maxComputeWorkgroupsPerDimension (${r}); clamp the dispatch (min(..., ${r})) and grid-stride over the remainder, or fold into 2D/3D.`);return Number(a)})}uniformValues(e,t){let r=e.struct,a={};for(let s of r.fields){let n=s.value??t.args[s.name]??s.default;if(n===void 0)continue;let i=nt(n,t),u=s.type==="f32";if(typeof i!="number"||Number.isNaN(i)||!Number.isFinite(i)&&!u)throw new Error(`WebGPU uniform ${e.name}.${s.name} must resolve to a finite number`);a[s.name]=i}return a}passConstants(e,t,r){return{...r.dtypes,...lt(e.constants,r),...lt(t.constants,r)}}passSourceInputs(e,t){return ng(lt(e.inputs,t),`WebGPU template source ${e.shader} inputs`)}selectVariantAndScope(e,t,r){let a=this.selectVariant(e,r),s=this.applyVariantDerive(e,t,a);return{variant:a,scope:s}}selectVariant(e,t){let r=[],a=null,s=new Map;for(let n of this.variantCandidates(t)){let i=this.checkVariant(n,e,s);if(!i.ok){r.push(`${n.id}: ${i.rejection.message}`);continue}if(i.demotions.length===0)return n;a??=n}if(a!==null)return a;throw new Error(`No supported WebGPU variant for ${this.manifest.id}; rejected ${r.join("; ")}`)}variantCandidates(e){if(e!==void 0){let t=this.manifest.variants.find(r=>r.id===e);if(!t)throw new Error(`WebGPU op ${this.manifest.id} has no variant ${e}`);return[t]}return[...this.manifest.variants].sort(Gi)}checkVariant(e,t,r=new Map){let a=r.get(e.id);if(a)return a;let s=this.computeVariantCheck(e,t,r);return r.set(e.id,s),s}computeVariantCheck(e,t,r){let a=$c(e.requires,t.device);if(a)return{ok:!1,rejection:{kind:"requires",message:a}};let s=Yh(e,t.device);if(s)return{ok:!1,rejection:{kind:"bufferBudget",message:s}};let n=t;for(let u of Array.isArray(e.when)?e.when:[e.when]){let o;try{o=nt(u,n)}catch(l){let c=ou(u);return{ok:!1,rejection:{kind:"whenError",clause:c,message:`when eval error in \`${c}\`: ${l.message}`}}}if(o!==!0)return{ok:!1,rejection:Kh(u,o)}}for(let u of e.supersededBy??[]){let o=this.variantsById.get(u);if(!o)continue;let l=this.checkVariant(o,t,r);if(l.ok&&l.demotions.length===0)return{ok:!1,rejection:{kind:"superseded",variant:u,message:`superseded by \`${u}\`, which is eligible here and outranks it`}}}let i=[];for(let u of e.demoteWhen??[]){let o;try{o=nt(u,n)}catch(l){return{ok:!1,rejection:{kind:"demoteError",clause:u,message:`demoteWhen eval error in \`${u}\`: ${l.message}`}}}o===!0&&i.push(u)}return{ok:!0,demotions:i}}buildBaseScope(e,t){let r={...t.resources},a={...this.manifest.attributes,...t.attrs??{}},s={...t.args??{}},n={...t.sourceContext??{}};for(let[d,f]of Object.entries(r))!Jt(f)&&typeof f!="object"&&(s[d]=f);let i=Object.fromEntries(Object.keys({...this.manifest.args,...r}).map(d=>[d,r[d]!==void 0&&r[d]!==null])),u={},o={},l={},c={};for(let d of this.scopeNamesByArg.keys()){let f=r[d];if(Jt(f))for(let p of this.scopeNamesByArg.get(d))u[p]=f.shape,o[p]=f.shape.length,l[p]=f.dtype}for(let d of[...this.manifest.inputs,...this.manifest.outputs]){if(!d.dtype)continue;let f=l[d.role];f!==void 0&&(c[d.dtype]=jm(f))}return this.validateInputDtypes(l),{device:e,attrs:a,args:s,sourceContext:n,resources:r,present:i,shapes:u,ranks:o,tensorDtypes:l,dtypes:c,derived:{},tunables:{...this.manifest.tunables,...t.tunables??{}},constants:{},repeat:{}}}validateInputDtypes(e){for(let t of[...this.manifest.inputs,...this.manifest.outputs]){let r=t.dtype;if(!r)continue;let a=e[t.role];if(a===void 0)continue;let s=this.manifest.typeConstraints[r];if(Array.isArray(s)&&s.length>0&&!s.includes(a)){let n=this.manifest.inputs.includes(t)?"input":"output";throw new Error(`${this.manifest.id}: ${n} "${t.role}" has dtype ${a}, not allowed by type constraint ${r} = [${s.join(", ")}]`)}}}applyManifestDerive(e){let t={};for(let[r,a]of Object.entries(this.manifest.derive))t[r]=ct(a,{...e,derived:t});return{...e,derived:t}}applyManifestDeriveForInference(e){let t={};for(let[r,a]of Jh(this.manifest))try{t[r]=ct(a,{...e,derived:t})}catch{}return{...e,derived:t}}applyVariantDerive(e,t,r){let a={...e,tunables:{...this.manifest.tunables,...r.tunables,...t.tunables??{}}},s={...e.derived};for(let[n,i]of Object.entries(r.derive))s[n]=ct(i,{...a,derived:s});return{...a,derived:s}}rejectUnknownKeys(e,t,r,a){for(let s of Object.keys(r))if(!this.acceptedResourceKeys.has(s))throw new Error(`${e}: unknown ${t} "${s}" — not a declared arg or binding name (known: ${[...this.acceptedResourceKeys].sort().join(", ")})`);for(let s of Object.keys(a??{}))if(!this.acceptedArgKeys.has(s))throw new Error(`${e}: unknown arg "${s}" — not declared in manifest.args (known: ${[...this.acceptedArgKeys].sort().join(", ")})`)}validateRequest(e){this.rejectUnknownKeys(`WebGPU op ${this.manifest.id}`,"resource",e.resources,e.args);for(let[t,r]of Object.entries(this.manifest.args)){let a=e.resources[t]??e.args?.[t];if(a==null){if(r.required!==!1)throw new Error(`WebGPU op ${this.manifest.id} missing required arg ${t}`);continue}ag(t,r,a)}}},tg=/{%\s*include\s+["']([^"']+)["']\s*%}/g;function cu(e,t,r,a){let s=is(e);if(a.has(s))throw new Error(`Circular WebGPU template include: ${[...a,s].join(" -> ")}`);a.add(s);let n=t.replace(tg,(i,u)=>{let o=rg(s,u);return cu(o,r(o),r,a)});return a.delete(s),n}function rg(e,t){if(t.startsWith(".")){let r=e.slice(0,Math.max(0,e.lastIndexOf("/")));return is(`${r}/${t}`)}return is(t)}function is(e){let t=[];for(let r of e.replaceAll("\\","/").split("/"))if(!(r===""||r===".")){if(r===".."){if(t.length===0)throw new Error(`WebGPU template path escapes package root: ${e}`);t.pop();continue}t.push(r)}return t.join("/")}function ag(e,t,r){if(t.kind==="tensor"){if(!Jt(r))throw new Error(`WebGPU arg ${e} must be a GPU tensor`);if(t.dtype&&r.dtype!==t.dtype)throw new Error(`WebGPU arg ${e} dtype ${r.dtype} does not match ${t.dtype}`);return}if(t.kind==="string"){if(typeof r!="string")throw new Error(`WebGPU arg ${e} must be a string`);if(t.oneOf&&!t.oneOf.includes(r))throw new Error(`WebGPU arg ${e} must be one of ${t.oneOf.join(", ")}`);return}if(t.kind==="bool"){if(typeof r!="boolean")throw new Error(`WebGPU arg ${e} must be a boolean`);return}if(typeof r!="number"||!Number.isFinite(r))throw new Error(`WebGPU arg ${e} must be a finite number`);if(t.kind==="u32"&&(!Number.isInteger(r)||r<0||r>4294967295))throw new Error(`WebGPU arg ${e} must be a u32`);if(t.kind==="i32"&&(!Number.isInteger(r)||r<-2147483648||r>2147483647))throw new Error(`WebGPU arg ${e} must be an i32`)}function sg(e){return typeof e.readText=="function"?e:Ya(e)}function ng(e,t){if(!du(e))throw new Error(`${t} must be a JSON object`);return us(e,t)}function us(e,t){if(e===null)return null;if(typeof e=="boolean"||typeof e=="string")return e;if(typeof e=="number"){if(!Number.isFinite(e))throw new Error(`${t} number must be finite`);return e}if(Array.isArray(e))return Object.freeze(e.map((r,a)=>us(r,`${t}[${a}]`)));if(du(e)){let r={};for(let[a,s]of Object.entries(e)){if(s===void 0)throw new Error(`${t}.${a} must be JSON; got undefined`);r[a]=us(s,`${t}.${a}`)}return Object.freeze(r)}throw new Error(`${t} must be JSON-compatible`)}function du(e){if(e===null||typeof e!="object"||Array.isArray(e))return!1;let t=Object.getPrototypeOf(e);return t===Object.prototype||t===null}var fu=new WeakMap;function ig(e,t){if(e&&typeof e=="object"){let r=e,a=fu.get(e);if(a!==void 0&&a.features===r.features&&a.wgslLanguageFeatures===r.wgslLanguageFeatures&&a.limits===r.limits&&a.adapterInfo===r.adapterInfo)return a.token;let s=Lt(rr(t));return fu.set(e,{token:s,features:r.features,wgslLanguageFeatures:r.wgslLanguageFeatures,limits:r.limits,adapterInfo:r.adapterInfo}),s}return Lt(rr(t))}function pu(e,t,r){return Lt({v:r??null,d:ig(e,t.device),...ru(t),args:t.args,shapes:t.shapes,present:t.present,source:t.sourceContext})}var ug=new Set(Object.keys(Fe));function ea(e){return e!==null&&typeof e=="object"&&typeof e.dtype=="string"&&Array.isArray(e.shape)}function og(e){let t=e.shape.reduce((r,a)=>r*a,1);return{dtype:e.dtype,shape:e.shape,size:t,byteLength:t*4,buffer:{},runtime:null}}var lg=new Map([["ops/_shared/reduce-arg-axis-split-combine.wgsl.jinja",`{% set cmp = ">" if source.mode == "max" else "<" %}
{% set is_int = scalar == "i32" or scalar == "u32" %}
{% set work = scalar if is_int else "f32" %}
{{ env.wgsl.resourceDeclarations }}

const WG: u32 = {{ workgroupSize }}u;
const SPLIT: u32 = {{ split }}u;
const SENTINEL_IDX: u32 = 4294967295u;

@compute @workgroup_size(WG, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>,
        @builtin(num_workgroups) nwg: vec3<u32>) {
  let output_index = gid.x + gid.y * nwg.x * WG;
  if (output_index >= params.outputCount) {
    return;
  }
{% if scalar == "u32" %}
  var out_val = partials_val[output_index];
{% else %}
  var out_val = bitcast<{{ work }}>(partials_val[output_index]);
{% endif %}
  var out_idx = partials_idx[output_index];
  for (var split_index = 1u; split_index < SPLIT; split_index++) {
{% if scalar == "u32" %}
    let candidate_val = partials_val[split_index * params.outputCount + output_index];
{% else %}
    let candidate_val = bitcast<{{ work }}>(partials_val[split_index * params.outputCount + output_index]);
{% endif %}
    let candidate_idx = partials_idx[split_index * params.outputCount + output_index];
{% if selectLastIndex %}
    if (candidate_idx != SENTINEL_IDX && (out_idx == SENTINEL_IDX || candidate_val {{ cmp }} out_val || (candidate_val == out_val && candidate_idx > out_idx))) {
{% else %}
    if (candidate_idx != SENTINEL_IDX && (out_idx == SENTINEL_IDX || candidate_val {{ cmp }} out_val || (candidate_val == out_val && candidate_idx < out_idx))) {
{% endif %}
      out_val = candidate_val;
      out_idx = candidate_idx;
    }
  }
  y[output_index] = select(out_idx, 0u, out_idx == SENTINEL_IDX);
}
`],["ops/_shared/reduce-arg-axis.wgsl.jinja",`{%- set cmp = ">" if source.mode == "max" else "<" %}
{%- if usesF16 %}
enable f16;
{%- endif %}
{{ env.wgsl.resourceDeclarations }}

@compute @workgroup_size({{ workgroupSize }})
fn main(@builtin(global_invocation_id) gid: vec3<u32>,
        @builtin(num_workgroups) nwg: vec3<u32>) {

  let output_index = gid.x + gid.y * nwg.x * {{ workgroupSize }}u;
  if (output_index >= params.outputCount) {
    return;
  }

  let outer_index = output_index / params.innerSize;
  let inner_index = output_index % params.innerSize;
  let input_base = outer_index * params.axisDim * params.innerSize + inner_index;

  var best_index = 0u;
{%- if scalar == "i32" or scalar == "u32" %}
  var best = x[input_base];
  for (var axis_index = 1u; axis_index < params.axisDim; axis_index++) {
    let candidate = x[input_base + axis_index * params.innerSize];
    if (candidate {{ cmp }} best{% if selectLastIndex %} || candidate == best{% endif %}) {
      best = candidate;
      best_index = axis_index;
    }
  }
{%- else %}
  var best = f32(x[input_base]);
  for (var axis_index = 1u; axis_index < params.axisDim; axis_index++) {
    let candidate = f32(x[input_base + axis_index * params.innerSize]);
    if (candidate {{ cmp }} best{% if selectLastIndex %} || candidate == best{% endif %}) {
      best = candidate;
      best_index = axis_index;
    }
  }
{%- endif %}
  y[output_index] = best_index;
}
`],["ops/_shared/reduce-arg-row-split.wgsl.jinja",`{%- if source.useSubgroups is defined %}{%- set useSubgroups = source.useSubgroups %}{%- else %}{%- set useSubgroups = false %}{%- endif %}
{%- if usesF16 %}
enable f16;
{%- endif %}
{%- if useSubgroups %}
enable subgroups;
{%- endif %}
{{ env.wgsl.resourceDeclarations }}

const WG: u32 = {{ workgroupSize }}u;
const SPLIT: u32 = {{ split }}u;
const SENTINEL_IDX: u32 = 4294967295u;

{%- if scalar == "i32" %}
{%- set work = "i32" %}
{%- elif scalar == "u32" %}
{%- set work = "u32" %}
{%- else %}
{%- set work = "f32" %}
{%- endif %}
{%- set cmp = ">" if source.mode == "max" else "<" %}

fn lane_identity() -> {{ work }} {
{%- if scalar == "i32" %}
  return bitcast<i32>({{ "0x80000000u" if source.mode == "max" else "0x7fffffffu" }});
{%- elif scalar == "u32" %}
  return {{ "0u" if source.mode == "max" else "0xffffffffu" }};
{%- else %}
  var bits = {{ "0xff800000u" if source.mode == "max" else "0x7f800000u" }};
  return bitcast<f32>(bits);
{%- endif %}
}

var<workgroup> wg_val: array<{{ work }}, WG>;
var<workgroup> wg_idx: array<u32, WG>;

@compute @workgroup_size(WG, 1, 1)
fn main(@builtin(workgroup_id) wg: vec3<u32>,
        @builtin(local_invocation_id) lid: vec3<u32>{% if useSubgroups %},
        @builtin(subgroup_invocation_id) subgroup_lane: u32,
        @builtin(subgroup_size) subgroup_size: u32{% endif %}) {
  let row = wg.x;
  let split_index = wg.y;
  let tid = lid.x;
  let segment_size = (params.chunkCount + SPLIT - 1u) / SPLIT;
  let segment_begin = split_index * segment_size;
  let segment_end = min(segment_begin + segment_size, params.chunkCount);
  let base = row * params.chunkCount;

  var best_val = lane_identity();
  var best_idx = SENTINEL_IDX;
  for (var chunk = segment_begin + tid; chunk < segment_end; chunk += WG) {
{%- if source.vec4 %}
    let value4 = x[base + chunk];
{%- for component in ["x", "y", "z", "w"] %}
    {
{%- if scalar == "f16" %}
      let value = f32(value4.{{ component }});
{%- else %}
      let value = value4.{{ component }};
{%- endif %}
      let index = chunk * 4u + {{ loop.index0 }}u;
{%- if selectLastIndex %}
      if (value {{ cmp }} best_val || (value == best_val && (best_idx == SENTINEL_IDX || index > best_idx))) {
{%- else %}
      if (value {{ cmp }} best_val || (value == best_val && index < best_idx)) {
{%- endif %}
        best_val = value;
        best_idx = index;
      }
    }
{%- endfor %}
{%- else %}
{%- if scalar == "f16" %}
    let value = f32(x[base + chunk]);
{%- else %}
    let value = x[base + chunk];
{%- endif %}
{%- if selectLastIndex %}
    if (value {{ cmp }} best_val || (value == best_val && (best_idx == SENTINEL_IDX || chunk > best_idx))) {
{%- else %}
    if (value {{ cmp }} best_val || (value == best_val && chunk < best_idx)) {
{%- endif %}
      best_val = value;
      best_idx = chunk;
    }
{%- endif %}
  }

{%- if useSubgroups %}
{%- if source.mode == "max" %}
  let subgroup_val = subgroupMax(best_val);
{%- else %}
  let subgroup_val = subgroupMin(best_val);
{%- endif %}
{%- if selectLastIndex %}
  let subgroup_candidate = select(0u, best_idx, best_val == subgroup_val && best_idx != SENTINEL_IDX);
  let subgroup_idx = subgroupMax(subgroup_candidate);
{%- else %}
  let subgroup_candidate = select(SENTINEL_IDX, best_idx, best_val == subgroup_val);
  let subgroup_idx = subgroupMin(subgroup_candidate);
{%- endif %}
  let safe_subgroup_size = max(subgroup_size, 1u);

  let subgroup_count = max(1u, (WG + safe_subgroup_size - 1u) / safe_subgroup_size);
  if (subgroup_lane == 0u) {
    let slot = min(tid / safe_subgroup_size, WG - 1u);
    wg_val[slot] = subgroup_val;
    wg_idx[slot] = subgroup_idx;
  }
  workgroupBarrier();
  if (tid == 0u) {
    var output_val = wg_val[0];
    var output_idx = wg_idx[0];
    for (var slot = 1u; slot < subgroup_count; slot++) {
      let candidate_val = wg_val[slot];
      let candidate_idx = wg_idx[slot];
{%- if selectLastIndex %}
      if (candidate_idx != SENTINEL_IDX && (output_idx == SENTINEL_IDX || candidate_val {{ cmp }} output_val || (candidate_val == output_val && candidate_idx > output_idx))) {
{%- else %}
      if (candidate_idx != SENTINEL_IDX && (output_idx == SENTINEL_IDX || candidate_val {{ cmp }} output_val || (candidate_val == output_val && candidate_idx < output_idx))) {
{%- endif %}
        output_val = candidate_val;
        output_idx = candidate_idx;
      }
    }
    let scratch_index = split_index * params.rows + row;
{%- if scalar == "u32" %}
    partials_val[scratch_index] = output_val;
{%- else %}
    partials_val[scratch_index] = bitcast<u32>(output_val);
{%- endif %}
    partials_idx[scratch_index] = output_idx;
  }
{%- else %}
  wg_val[tid] = best_val;
  wg_idx[tid] = best_idx;
  workgroupBarrier();
  for (var stride = WG / 2u; stride > 0u; stride >>= 1u) {
    if (tid < stride) {
      let candidate_val = wg_val[tid + stride];
      let candidate_idx = wg_idx[tid + stride];
      let current_idx = wg_idx[tid];
{%- if selectLastIndex %}
      if (candidate_idx != SENTINEL_IDX && (current_idx == SENTINEL_IDX || candidate_val {{ cmp }} wg_val[tid] || (candidate_val == wg_val[tid] && candidate_idx > current_idx))) {
{%- else %}
      if (candidate_idx != SENTINEL_IDX && (current_idx == SENTINEL_IDX || candidate_val {{ cmp }} wg_val[tid] || (candidate_val == wg_val[tid] && candidate_idx < current_idx))) {
{%- endif %}
        wg_val[tid] = candidate_val;
        wg_idx[tid] = candidate_idx;
      }
    }
    workgroupBarrier();
  }
  if (tid == 0u) {
    let scratch_index = split_index * params.rows + row;
{%- if scalar == "u32" %}
    partials_val[scratch_index] = wg_val[0];
{%- else %}
    partials_val[scratch_index] = bitcast<u32>(wg_val[0]);
{%- endif %}
    partials_idx[scratch_index] = wg_idx[0];
  }
{%- endif %}
}
`],["ops/_shared/reduce-arg-row-subgroup.wgsl.jinja",`{%- if source.useSubgroups is defined %}{%- set useSubgroups = source.useSubgroups %}{%- else %}{%- set useSubgroups = true %}{%- endif %}
{%- if usesF16 %}
enable f16;
{%- endif %}
{%- if useSubgroups %}
enable subgroups;
{%- endif %}
{{ env.wgsl.resourceDeclarations }}

const WG: u32 = {{ workgroupSize }}u;
const SENTINEL_IDX: u32 = 4294967295u;

fn neg_inf_f32() -> f32 {
  var bits = 0xff800000u;
  return bitcast<f32>(bits);
}

fn pos_inf_f32() -> f32 {
  var bits = 0x7f800000u;
  return bitcast<f32>(bits);
}

{%- if scalar == "i32" %}
{%- set cmpType = "i32" %}
{%- elif scalar == "u32" %}
{%- set cmpType = "u32" %}
{%- else %}
{%- set cmpType = "f32" %}
{%- endif %}
{%- if source.mode == "max" %}
{%- set cmp = ">" %}
{%- else %}
{%- set cmp = "<" %}
{%- endif %}

{%- if not (useSubgroups and source.singleSubgroup is defined and source.singleSubgroup) %}
var<workgroup> wgVal: array<{{ cmpType }}, WG>;
var<workgroup> wgIdx: array<u32, WG>;
{%- endif %}

@compute @workgroup_size(WG, 1, 1)
fn main(@builtin(workgroup_id) wg: vec3<u32>,
        @builtin(local_invocation_id) lid: vec3<u32>{% if useSubgroups %},
        @builtin(subgroup_invocation_id) sgLid: u32,
        @builtin(subgroup_size) sgSize: u32{% endif %}) {
  let row = wg.x + wg.y * params.rowStride;
  if (row >= params.rows) {
    return;
  }
  let tid = lid.x;
  let base = row * params.chunkCount;
{%- if source.mode == "max" %}
{%- if cmpType == "i32" %}
  var bestVal: i32 = -2147483647i - 1i;
{%- elif cmpType == "u32" %}
  var bestVal: u32 = 0u;
{%- else %}
  var bestVal: f32 = neg_inf_f32();
{%- endif %}
{%- else %}
{%- if cmpType == "i32" %}
  var bestVal: i32 = 2147483647i;
{%- elif cmpType == "u32" %}
  var bestVal: u32 = 4294967295u;
{%- else %}
  var bestVal: f32 = pos_inf_f32();
{%- endif %}
{%- endif %}
  var bestIdx: u32 = SENTINEL_IDX;
{%- if source.vec4 %}
  for (var c = tid; c < params.chunkCount; c = c + WG) {
    let v4 = x[base + c];
{%- for comp in ["x", "y", "z", "w"] %}
    {
{%- if scalar == "f16" %}
      let v = f32(v4.{{ comp }});
{%- else %}
      let v = v4.{{ comp }};
{%- endif %}
      let idx = c * 4u + {{ loop.index0 }}u;
{%- if selectLastIndex %}
      if (v {{ cmp }} bestVal || (v == bestVal && (bestIdx == SENTINEL_IDX || idx > bestIdx))) {
{%- else %}
      if (v {{ cmp }} bestVal || (v == bestVal && idx < bestIdx)) {
{%- endif %}
        bestVal = v;
        bestIdx = idx;
      }
    }
{%- endfor %}
  }
{%- else %}

  for (var c0 = tid; c0 < params.chunkCount; c0 = c0 + 4u * WG) {
{%- for plane in [0, 1, 2, 3] %}
    {
      let c = c0 + {{ plane }}u * WG;
      if (c < params.chunkCount) {
{%- if scalar == "f16" %}
        let v = f32(x[base + c]);
{%- else %}
        let v = x[base + c];
{%- endif %}
{%- if selectLastIndex %}
        if (v {{ cmp }} bestVal || (v == bestVal && (bestIdx == SENTINEL_IDX || c > bestIdx))) {
{%- else %}
        if (v {{ cmp }} bestVal || (v == bestVal && c < bestIdx)) {
{%- endif %}
          bestVal = v;
          bestIdx = c;
        }
      }
    }
{%- endfor %}
  }
{%- endif %}

{%- if useSubgroups %}
{%- if source.mode == "max" %}
  let m = subgroupMax(bestVal);
{%- else %}
  let m = subgroupMin(bestVal);
{%- endif %}
{%- if selectLastIndex %}

  let cand = select(0u, bestIdx, bestVal == m && bestIdx != SENTINEL_IDX);
  let sgIdx = subgroupMax(cand);
{%- else %}

  let cand = select(SENTINEL_IDX, bestIdx, bestVal == m);
  let sgIdx = subgroupMin(cand);
{%- endif %}
{%- if source.singleSubgroup is defined and source.singleSubgroup %}
  if (sgLid == 0u) {
    y[row] = select(sgIdx, 0u, sgIdx == SENTINEL_IDX);
  }
{%- else %}
  let safeSg = max(sgSize, 1u);
  let slotCount = max(1u, (WG + safeSg - 1u) / safeSg);
  if (sgLid == 0u) {
    let slot = min(tid / safeSg, WG - 1u);
    wgVal[slot] = m;
    wgIdx[slot] = sgIdx;
  }
  workgroupBarrier();
  if (tid == 0u) {
    var outVal = wgVal[0];
    var outIdx = wgIdx[0];
    for (var i = 1u; i < slotCount; i = i + 1u) {
      let v = wgVal[i];
      let vi = wgIdx[i];
{%- if selectLastIndex %}
      if (vi != SENTINEL_IDX && (v {{ cmp }} outVal || (v == outVal && (outIdx == SENTINEL_IDX || vi > outIdx)))) {
{%- else %}
      if (vi != SENTINEL_IDX && (v {{ cmp }} outVal || (v == outVal && vi < outIdx))) {
{%- endif %}
        outVal = v;
        outIdx = vi;
      }
    }
    y[row] = select(outIdx, 0u, outIdx == SENTINEL_IDX);
  }
{%- endif %}
{%- else %}

  wgVal[tid] = bestVal;
  wgIdx[tid] = bestIdx;
  workgroupBarrier();
  for (var stride = WG / 2u; stride > 0u; stride = stride >> 1u) {
    if (tid < stride) {
      let v = wgVal[tid + stride];
      let vi = wgIdx[tid + stride];
      let curIdx = wgIdx[tid];
{%- if selectLastIndex %}
      if (vi != SENTINEL_IDX && (curIdx == SENTINEL_IDX || v {{ cmp }} wgVal[tid] || (v == wgVal[tid] && vi > curIdx))) {
{%- else %}
      if (vi != SENTINEL_IDX && (curIdx == SENTINEL_IDX || v {{ cmp }} wgVal[tid] || (v == wgVal[tid] && vi < curIdx))) {
{%- endif %}
        wgVal[tid] = v;
        wgIdx[tid] = vi;
      }
    }
    workgroupBarrier();
  }
  if (tid == 0u) {
    y[row] = select(wgIdx[0], 0u, wgIdx[0] == SENTINEL_IDX);
  }
{%- endif %}
}
`],["ops/_shared/binary-broadcast-vec4.wgsl.jinja",`{% include "ops/_shared/broadcast-offset.wgsl.jinja" %}
{% if usesF16 %}
enable f16;
{% endif %}
{{ env.wgsl.resourceDeclarations }}

{% set a_numel = namespace(value=1) %}
{% for d in source.aShape %}
{% set a_numel.value = a_numel.value * d %}
{% endfor %}
{% set b_numel = namespace(value=1) %}
{% for d in source.bShape %}
{% set b_numel.value = b_numel.value * d %}
{% endfor %}
{% set c_numel = namespace(value=1) %}
{% for d in source.cShape %}
{% set c_numel.value = c_numel.value * d %}
{% endfor %}
{% set a_same = namespace(value=(source.aRank == source.cRank)) %}
{% if a_same.value %}
{% for axis in range(source.cRank) %}
{% if source.aShape[axis] != source.cShape[axis] %}
{% set a_same.value = false %}
{% endif %}
{% endfor %}
{% endif %}
{% set b_same = namespace(value=(source.bRank == source.cRank)) %}
{% if b_same.value %}
{% for axis in range(source.cRank) %}
{% if source.bShape[axis] != source.cShape[axis] %}
{% set b_same.value = false %}
{% endif %}
{% endfor %}
{% endif %}
{% set a_inner = source.aShape[source.aRank - 1] if source.aRank >= 1 else 1 %}
{% set b_inner = source.bShape[source.bRank - 1] if source.bRank >= 1 else 1 %}
{% set c_inner = source.cShape[source.cRank - 1] if source.cRank >= 1 else 1 %}
{% set crosses_inner_rows = c_inner % 4 != 0 %}
{% if a_numel.value == 1 %}{% set a_mode = "scalar" %}
{% elif a_inner == 1 %}{% set a_mode = "splat" %}
{% else %}{% set a_mode = "contig" %}{% endif %}
{% if b_numel.value == 1 %}{% set b_mode = "scalar" %}
{% elif b_inner == 1 %}{% set b_mode = "splat" %}
{% else %}{% set b_mode = "contig" %}{% endif %}

{% if not a_same.value %}
{{ offset_fn("a_offset", source.aShape, source.aRank, false, a_numel.value, source.cShape, source.cRank, c_numel.value) }}
{% endif %}

{% if not b_same.value %}
{{ offset_fn("b_offset", source.bShape, source.bRank, false, b_numel.value, source.cShape, source.cRank, c_numel.value) }}
{% endif %}

{% set isInt = scalar == "i32" or scalar == "u32" %}
{% set acc = scalar if isInt else "f32" %}
{% if source.cDtype == "int8" %}
fn wrap_dtype(v: vec4<i32>) -> vec4<i32> { return (v << vec4<u32>(24u)) >> vec4<u32>(24u); }
{% set wrap = "wrap_dtype" %}
{% elif source.cDtype == "uint8" %}
fn wrap_dtype(v: vec4<u32>) -> vec4<u32> { return v & vec4<u32>(0xFFu); }
{% set wrap = "wrap_dtype" %}
{% else %}
{% set wrap = "" %}
{% endif %}
@compute @workgroup_size({{ tunables.WORKGROUP_SIZE }})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {

  let i4 = gid.x + gid.y * nwg.x * {{ tunables.WORKGROUP_SIZE }}u;
  if (i4 >= params.count) {
    return;
  }
  let base = i4 * 4u;
{% if a_same.value %}
  let av = vec4<{{ acc }}>(a[i4]);
{% elif a_mode == "scalar" %}
  let av = vec4<{{ acc }}>({{ acc }}(a[0]));
{% elif crosses_inner_rows %}
  let av = vec4<{{ acc }}>(
    {{ acc }}(a[a_offset(base)]),
    {{ acc }}(a[a_offset(base + 1u)]),
    {{ acc }}(a[a_offset(base + 2u)]),
    {{ acc }}(a[a_offset(base + 3u)])
  );
{% elif a_mode == "splat" %}
  let av = vec4<{{ acc }}>({{ acc }}(a[a_offset(base)]));
{% else %}
  let ao = a_offset(base);
  let av = vec4<{{ acc }}>({{ acc }}(a[ao]), {{ acc }}(a[ao + 1u]), {{ acc }}(a[ao + 2u]), {{ acc }}(a[ao + 3u]));
{% endif %}
{% if b_same.value %}
  let bv = vec4<{{ acc }}>(b[i4]);
{% elif b_mode == "scalar" %}
  let bv = vec4<{{ acc }}>({{ acc }}(b[0]));
{% elif crosses_inner_rows %}
  let bv = vec4<{{ acc }}>(
    {{ acc }}(b[b_offset(base)]),
    {{ acc }}(b[b_offset(base + 1u)]),
    {{ acc }}(b[b_offset(base + 2u)]),
    {{ acc }}(b[b_offset(base + 3u)])
  );
{% elif b_mode == "splat" %}
  let bv = vec4<{{ acc }}>({{ acc }}(b[b_offset(base)]));
{% else %}
  let bo = b_offset(base);
  let bv = vec4<{{ acc }}>({{ acc }}(b[bo]), {{ acc }}(b[bo + 1u]), {{ acc }}(b[bo + 2u]), {{ acc }}(b[bo + 3u]));
{% endif %}
{% if source.op == "add" %}
  c[i4] = {{ wrap }}(vec4<{{ scalar }}>(av + bv));
{% elif source.op == "sub" %}
  c[i4] = {{ wrap }}(vec4<{{ scalar }}>(av - bv));
{% elif source.op == "mul" %}
  c[i4] = {{ wrap }}(vec4<{{ scalar }}>(av * bv));
{% elif source.op == "div" %}
{% if isInt %}
  c[i4] = {{ wrap }}(vec4<{{ scalar }}>(av / bv));
{% else %}
  let quotient = av / bv;
  let rounded = round(quotient);

  let snapProduct = rounded * bv == av;
  let snapClose = abs(quotient - rounded) < vec4<f32>(0.5);
  c[i4] = vec4<{{ scalar }}>(vec4<f32>(
    select(quotient.x, rounded.x, snapProduct.x && snapClose.x),
    select(quotient.y, rounded.y, snapProduct.y && snapClose.y),
    select(quotient.z, rounded.z, snapProduct.z && snapClose.z),
    select(quotient.w, rounded.w, snapProduct.w && snapClose.w)
  ));
{% endif %}
{% endif %}
}
`],["ops/_shared/binary-broadcast.wgsl.jinja",`{% include "ops/_shared/elementwise-tail-loop.wgsl.jinja" %}
{% include "ops/_shared/broadcast-offset.wgsl.jinja" %}
{% if usesF16 %}
enable f16;
{% endif %}
{{ env.wgsl.resourceDeclarations }}

{{ binary_broadcast_offsets() }}

{{ flat_tail_open() }}
{% if scalar == "i32" or scalar == "u32" %}
  let av = a[a_offset(i)];
  let bv = b[b_offset(i)];
{% if source.op == "add" %}
  let r = av + bv;
{% elif source.op == "sub" %}
  let r = av - bv;
{% elif source.op == "mul" %}
  let r = av * bv;
{% elif source.op == "div" %}
  let r = av / bv;
{% endif %}
{% if source.cDtype == "int8" %}
  c[i] = (r << 24u) >> 24u;
{% elif source.cDtype == "uint8" %}
  c[i] = r & 0xFFu;
{% else %}
  c[i] = r;
{% endif %}
{% else %}
  let av = f32(a[a_offset(i)]);
  let bv = f32(b[b_offset(i)]);
{% if source.op == "add" %}
  c[i] = {{ scalar }}(av + bv);
{% elif source.op == "sub" %}
  c[i] = {{ scalar }}(av - bv);
{% elif source.op == "mul" %}
  c[i] = {{ scalar }}(av * bv);
{% elif source.op == "div" %}
  let quotient = av / bv;
  let rounded = round(quotient);

  let snap = rounded * bv == av && abs(quotient - rounded) < 0.5;
  c[i] = {{ scalar }}(select(quotient, rounded, snap));
{% endif %}
{% endif %}
{{ flat_tail_close() -}}
}
`],["ops/_shared/binary-vec4.wgsl.jinja",`{% if usesF16 %}
enable f16;
{% endif %}
{{ env.wgsl.resourceDeclarations }}

@compute @workgroup_size({{ tunables.WORKGROUP_SIZE }})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {

  let i = gid.x + gid.y * nwg.x * {{ tunables.WORKGROUP_SIZE }}u;
  if (i >= params.count) {
    return;
  }
  let av = a[i];
  let bv = b[i];
{% if scalar == "i32" or scalar == "u32" %}
{% if source.op == "add" %}
  let r = av + bv;
{% elif source.op == "sub" %}
  let r = av - bv;
{% elif source.op == "mul" %}
  let r = av * bv;
{% elif source.op == "div" %}
  let r = av / bv;
{% endif %}
{% if source.cDtype == "int8" %}
  c[i] = (r << vec4<u32>(24u)) >> vec4<u32>(24u);
{% elif source.cDtype == "uint8" %}
  c[i] = r & vec4<u32>(0xFFu);
{% else %}
  c[i] = r;
{% endif %}
{% elif scalar == "f16" %}
{% if source.op == "add" %}
  c[i] = vec4<f16>(vec4<f32>(av) + vec4<f32>(bv));
{% elif source.op == "sub" %}
  c[i] = vec4<f16>(vec4<f32>(av) - vec4<f32>(bv));
{% elif source.op == "mul" %}
  c[i] = vec4<f16>(vec4<f32>(av) * vec4<f32>(bv));
{% elif source.op == "div" %}
  let avf = vec4<f32>(av);
  let bvf = vec4<f32>(bv);
  let quotient = avf / bvf;
  let rounded = round(quotient);
  let snapProduct = rounded * bvf == avf;
  let snapClose = abs(quotient - rounded) < vec4<f32>(0.5);
  c[i] = vec4<f16>(vec4<f32>(
    select(quotient.x, rounded.x, snapProduct.x && snapClose.x),
    select(quotient.y, rounded.y, snapProduct.y && snapClose.y),
    select(quotient.z, rounded.z, snapProduct.z && snapClose.z),
    select(quotient.w, rounded.w, snapProduct.w && snapClose.w)
  ));
{% endif %}
{% else %}
{% if source.op == "add" %}
  c[i] = av + bv;
{% elif source.op == "sub" %}
  c[i] = av - bv;
{% elif source.op == "mul" %}
  c[i] = av * bv;
{% elif source.op == "div" %}
  let quotient = av / bv;
  let rounded = round(quotient);
  let snapProduct = rounded * bv == av;
  let snapClose = abs(quotient - rounded) < vec4<f32>(0.5);
  c[i] = vec4<f32>(
    select(quotient.x, rounded.x, snapProduct.x && snapClose.x),
    select(quotient.y, rounded.y, snapProduct.y && snapClose.y),
    select(quotient.z, rounded.z, snapProduct.z && snapClose.z),
    select(quotient.w, rounded.w, snapProduct.w && snapClose.w)
  );
{% endif %}
{% endif %}
}
`],["ops/_shared/broadcast-offset.wgsl.jinja",`{% macro offset_fn(fn_name, opShape, opRank, op_same, op_numel, outShape, outRank, out_numel) -%}
fn {{ fn_name }}(out_index: u32) -> u32 {
{% if out_numel == 0 %}
  return 0u;
{% elif op_same %}
  return out_index;
{% elif op_numel == 1 %}
  return 0u;
{% else %}
  var offset = 0u;
{% for axis in range(outRank) %}
{% set op_axis = axis - (outRank - opRank) %}
{% if op_axis >= 0 and opShape[op_axis] != 1 %}
{% set c_stride = namespace(value=1) %}
{% for j in range(axis + 1, outRank) %}
{% set c_stride.value = c_stride.value * outShape[j] %}
{% endfor %}
{% set op_stride = namespace(value=1) %}
{% for j in range(op_axis + 1, opRank) %}
{% set op_stride.value = op_stride.value * opShape[j] %}
{% endfor %}
{% if c_stride.value == 1 %}
  let coord{{ axis }} = out_index % {{ outShape[axis] }}u;
{% else %}
  let coord{{ axis }} = (out_index / {{ c_stride.value }}u) % {{ outShape[axis] }}u;
{% endif %}
{% if op_stride.value == 1 %}
  offset = offset + coord{{ axis }};
{% else %}
  offset = offset + coord{{ axis }} * {{ op_stride.value }}u;
{% endif %}
{% endif %}
{% endfor %}
  return offset;
{% endif %}
}
{%- endmacro -%}

{% macro broadcast_offset_fn(fn_name, opShape, opRank, outShape, outRank) -%}
{% set op_numel = namespace(value=1) %}
{% for d in opShape %}
{% set op_numel.value = op_numel.value * d %}
{% endfor %}
{% set out_numel = namespace(value=1) %}
{% for d in outShape %}
{% set out_numel.value = out_numel.value * d %}
{% endfor %}
{% set op_same = namespace(value=(opRank == outRank)) %}
{% if op_same.value %}
{% for axis in range(outRank) %}
{% if opShape[axis] != outShape[axis] %}
{% set op_same.value = false %}
{% endif %}
{% endfor %}
{% endif %}
{{- offset_fn(fn_name, opShape, opRank, op_same.value, op_numel.value, outShape, outRank, out_numel.value) }}
{%- endmacro %}

{% macro binary_broadcast_offsets() -%}
{{ broadcast_offset_fn("a_offset", source.aShape, source.aRank, source.cShape, source.cRank) }}

{{ broadcast_offset_fn("b_offset", source.bShape, source.bRank, source.cShape, source.cRank) }}
{%- endmacro %}`],["ops/_shared/elementwise-tail-loop.wgsl.jinja",`{% macro flat_tail_open() -%}
@compute @workgroup_size({{ tunables.WORKGROUP_SIZE }})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {

  let invocation = gid.x + gid.y * nwg.x * {{ tunables.WORKGROUP_SIZE }}u;
{% if source.itemsPerInvocation is defined %}

  let begin = invocation * {{ source.itemsPerInvocation }}u;
  let end = min(begin + {{ source.itemsPerInvocation }}u, params.count);
  for (var i = begin; i < end; i = i + 1u) {
{%- else %}
  let i = invocation;
  if (i >= params.count) {
    return;
  }
{%- endif %}
{%- endmacro %}
{% macro flat_tail_close() -%}
{% if source.itemsPerInvocation is defined %}
  }
{% endif %}
{%- endmacro %}`],["ops/_shared/float-is-nan.wgsl.jinja",`fn is_nan_f32(value: f32) -> bool {
  let bits = bitcast<u32>(value);
  return (bits & 0x7f800000u) == 0x7f800000u && (bits & 0x007fffffu) != 0u;
}
`],["ops/_shared/float-neg-inf.wgsl.jinja",`fn negative_infinity() -> f32 {
  var bits = 0xff800000u;
  return bitcast<f32>(bits);
}
`],["ops/_shared/gelu-erf.wgsl.jinja",`fn erf_approx(x: f32) -> f32 {
  let sign = select(-1.0, 1.0, x >= 0.0);
  let ax = abs(x);
  let t = 1.0 / (1.0 + 0.3275911 * ax);
  let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-(ax * ax));
  return sign * y;
}
`],["ops/_shared/precise-inverse-trig-f32.wgsl.jinja",`const PRECISE_INV_TRIG_PI: f32 = 3.141592653589793;
const PRECISE_INV_TRIG_HALF_PI: f32 = 1.5707963267948966;
const PRECISE_INV_TRIG_QUARTER_PI: f32 = 0.7853981633974483;
const PRECISE_INV_TRIG_HALF_PI_HI: f32 = 1.570796251296997;
const PRECISE_INV_TRIG_HALF_PI_LO: f32 = 7.549789415861596e-8;

fn precise_atan_unit(z: f32) -> f32 {
  let z2 = z * z;
  var polynomial = -0.05263157894736842;
  polynomial = fma(polynomial, z2, 0.058823529411764705);
  polynomial = fma(polynomial, z2, -0.06666666666666667);
  polynomial = fma(polynomial, z2, 0.07692307692307693);
  polynomial = fma(polynomial, z2, -0.09090909090909091);
  polynomial = fma(polynomial, z2, 0.1111111111111111);
  polynomial = fma(polynomial, z2, -0.14285714285714285);
  polynomial = fma(polynomial, z2, 0.2);
  polynomial = fma(polynomial, z2, -0.3333333333333333);
  return z * fma(polynomial, z2, 1.0);
}

fn precise_atan_positive(value: f32) -> f32 {
  if (value > 2.414213562373095) {
    let tail = fma(-1.0, precise_atan_unit(1.0 / value),
      PRECISE_INV_TRIG_HALF_PI_LO);

    let stableTail = bitcast<f32>(bitcast<u32>(tail));

    return fma(1.0, stableTail, PRECISE_INV_TRIG_HALF_PI_HI);
  }
  if (value > 0.41421356237309503) {
    return PRECISE_INV_TRIG_QUARTER_PI
      + precise_atan_unit((value - 1.0) / (value + 1.0));
  }
  return precise_atan_unit(value);
}

fn precise_domain_nan(value: f32) -> f32 {
  return bitcast<f32>((bitcast<u32>(value) & 0x80000000u) | 0x7fc00000u);
}

{% if source.op == "atan" %}
fn atan_accurate(value: f32) -> f32 {
  let bits = bitcast<u32>(value);
  let magnitudeBits = bits & 0x7fffffffu;
  if (magnitudeBits > 0x7f800000u) {
    return value;
  }
  if (magnitudeBits == 0x7f800000u) {
    return select(PRECISE_INV_TRIG_HALF_PI, -PRECISE_INV_TRIG_HALF_PI,
      (bits & 0x80000000u) != 0u);
  }
  if (magnitudeBits == 0u) {
    return value;
  }
  let result = precise_atan_positive(abs(value));
  return select(result, -result, (bits & 0x80000000u) != 0u);
}
{% elif source.op == "asin" %}
fn asin_accurate(value: f32) -> f32 {
  let bits = bitcast<u32>(value);
  let magnitudeBits = bits & 0x7fffffffu;
  if (magnitudeBits > 0x7f800000u) {
    return value;
  }
  let magnitude = abs(value);
  if (magnitude > 1.0) {
    return precise_domain_nan(value);
  }
  if (magnitudeBits == 0u) {
    return value;
  }
  var result: f32;
  if (magnitude > 0.5) {
    let complement = 2.0 * precise_atan_positive(
      sqrt((1.0 - magnitude) / (1.0 + magnitude)));

    let tail = fma(-1.0, complement, PRECISE_INV_TRIG_HALF_PI_LO);
    let stableTail = bitcast<f32>(bitcast<u32>(tail));
    result = fma(1.0, stableTail, PRECISE_INV_TRIG_HALF_PI_HI);
  } else {
    let root = sqrt((1.0 - magnitude) * (1.0 + magnitude));
    result = 2.0 * precise_atan_positive(magnitude / (1.0 + root));
  }
  return select(result, -result, (bits & 0x80000000u) != 0u);
}
{% elif source.op == "acos" %}
fn acos_accurate(value: f32) -> f32 {
  let bits = bitcast<u32>(value);
  let magnitudeBits = bits & 0x7fffffffu;
  if (magnitudeBits > 0x7f800000u) {
    return value;
  }
  if (abs(value) > 1.0) {
    return precise_domain_nan(value);
  }
  if (value == 1.0) {
    return 0.0;
  }
  if (value == -1.0) {
    return PRECISE_INV_TRIG_PI;
  }
  if (value >= 0.0) {
    return 2.0 * precise_atan_positive(sqrt((1.0 - value) / (1.0 + value)));
  }

  return 2.0 * precise_atan_positive(
    sqrt((1.0 - value) / (1.0 + value)));
}
{% endif %}
`],["ops/_shared/precise-trig-f32.wgsl.jinja",`const PRECISE_TRIG_PI: f32 = 3.141592653589793;
const PRECISE_TRIG_TWO_PI: f32 = 6.283185307179586;
const PRECISE_TRIG_HALF_PI: f32 = 1.5707963267948966;

fn precise_sincos_half_pi(x: f32) -> vec2<f32> {
  let x2 = x * x;

  var sinPolynomial = 1.6059043836821613e-10;
  sinPolynomial = fma(sinPolynomial, x2, -2.505210838544172e-8);
  sinPolynomial = fma(sinPolynomial, x2, 2.7557319223985893e-6);
  sinPolynomial = fma(sinPolynomial, x2, -1.984126984126984e-4);
  sinPolynomial = fma(sinPolynomial, x2, 8.333333333333333e-3);
  sinPolynomial = fma(sinPolynomial, x2, -1.6666666666666666e-1);
  let sine = x * fma(sinPolynomial, x2, 1.0);

  var cosPolynomial = 2.08767569878681e-9;
  cosPolynomial = fma(cosPolynomial, x2, -2.755731922398589e-7);
  cosPolynomial = fma(cosPolynomial, x2, 2.48015873015873e-5);
  cosPolynomial = fma(cosPolynomial, x2, -1.388888888888889e-3);
  cosPolynomial = fma(cosPolynomial, x2, 4.1666666666666664e-2);
  cosPolynomial = fma(cosPolynomial, x2, -5.0e-1);
  let cosine = fma(cosPolynomial, x2, 1.0);

  return vec2<f32>(cosine, sine);
}

fn precise_sincos_centered(x: f32) -> vec2<f32> {
  var folded = x;
  var cosineSign = 1.0;
  if (folded > PRECISE_TRIG_HALF_PI) {
    folded = PRECISE_TRIG_PI - folded;
    cosineSign = -1.0;
  } else if (folded < -PRECISE_TRIG_HALF_PI) {
    folded = -PRECISE_TRIG_PI - folded;
    cosineSign = -1.0;
  }
  let value = precise_sincos_half_pi(folded);
  return vec2<f32>(cosineSign * value.x, value.y);
}
`],["ops/_shared/sigmoid-safe.wgsl.jinja",`fn sigmoid_safe(x: f32) -> f32 {
  if (x >= 0.0) {
    let z = exp(-x);
    return 1.0 / (1.0 + z);
  }
  let z = exp(x);
  return z / (1.0 + z);
}`],["ops/_shared/unary-numeric-helpers.wgsl.jinja",`{%- macro emit_is_nan_f32() -%}
fn is_nan_f32(value: f32) -> bool {
  let bits = bitcast<u32>(value);
  return (bits & 0x7f800000u) == 0x7f800000u && (bits & 0x007fffffu) != 0u;
}{%- endmacro -%}
{%- macro emit_erf_approx() -%}
{% include "ops/_shared/gelu-erf.wgsl.jinja" %}{%- endmacro -%}
{%- macro emit_sigmoid_safe() -%}
{% include "ops/_shared/sigmoid-safe.wgsl.jinja" %}{%- endmacro -%}
{%- macro emit_log1p_small_positive() -%}
fn log1p_small_positive(y: f32) -> f32 {
  return y * (1.0 + y * (-0.5 + y * (0.3333333333333333 + y * (-0.25 + y * 0.2))));
}{%- endmacro -%}
{%- macro emit_softplus() -%}
fn softplus(v: f32) -> f32 {

  if (v > SOFTPLUS_POSITIVE_THRESHOLD) {
    return v;
  }
  if (v < SOFTPLUS_LOG1P_SERIES_THRESHOLD) {
    return log1p_small_positive(exp(v));
  }
  return log(1.0 + exp(-abs(v))) + max(v, 0.0);
}{%- endmacro -%}
{%- macro emit_round_half_to_even() -%}
fn round_half_to_even(v: f32) -> f32 {
  let fl = floor(v);
  let diff = v - fl;
  if (diff < 0.5) {
    return fl;
  }
  if (diff > 0.5) {
    return fl + 1.0;
  }
  let half = floor(fl * 0.5);
  let is_even = (fl - half * 2.0) == 0.0;
  return select(fl + 1.0, fl, is_even);
}{%- endmacro -%}
{%- macro emit_asinh_safe() -%}
fn asinh_safe(x: f32) -> f32 {

  let a = abs(x);
  if (a > 1.0e16) {
    return sign(x) * (log(a) + 0.6931471805599453);
  }
  return asinh(x);
}{%- endmacro -%}
{%- macro emit_acosh_safe() -%}
fn acosh_safe(x: f32) -> f32 {

  if (x > 1.0e16) {
    return log(x) + 0.6931471805599453;
  }
  return acosh(x);
}{%- endmacro -%}
{%- set unaryDomainGuard = device.adapterInfo.architecture == "" or device.adapterInfo.architecture == "apple" -%}
{%- macro emit_atanh_safe(guarded) -%}
fn atanh_safe(x: f32) -> f32 {
{%- if guarded %}

  let bits = bitcast<u32>(x);
  let magnitude = bits & 0x7fffffffu;
  if (magnitude == 0x3f800000u) {
    return bitcast<f32>((bits & 0x80000000u) | 0x7f800000u);
  }
  if (magnitude > 0x3f800000u) {
    return bitcast<f32>(bits | 0x7fc00000u);
  }
{%- endif %}
  return atanh(x);
}{%- endmacro -%}
{%- macro emit_log_safe(guarded) -%}
fn log_safe(x: f32) -> f32 {
{%- if guarded %}

  let bits = bitcast<u32>(x);
  let magnitude = bits & 0x7fffffffu;
  if (magnitude == 0u) {
    return negative_infinity();
  }
  let exponent_all = (magnitude & 0x7f800000u) == 0x7f800000u;
  let input_nan = exponent_all && (magnitude & 0x007fffffu) != 0u;
  if ((bits & 0x80000000u) != 0u || input_nan) {
    return bitcast<f32>(bits | 0x7fc00000u);
  }
{%- endif %}
  return log(x);
}{%- endmacro -%}
{%- macro emit_cosh_safe() -%}
fn cosh_safe(x: f32) -> f32 {

  let ax = abs(x);
  if (ax > 89.41598510742188) {

    return bitcast<f32>(0x7f800000u | (bitcast<u32>(x) & 0u));
  }
  if (ax > 88.0) {

    return exp(ax - 0.6931471805599453);
  }
  return cosh(x);
}{%- endmacro -%}
{%- macro emit_sinh_safe() -%}
fn sinh_safe(x: f32) -> f32 {

  let ax = abs(x);
  if (ax > 89.41598510742188) {
    return bitcast<f32>(select(0x7f800000u, 0xff800000u, x < 0.0));
  }
  if (ax > 88.0) {
    let magnitude = exp(ax - 0.6931471805599453);
    return select(magnitude, -magnitude, x < 0.0);
  }
  return sinh(x);
}{%- endmacro -%}
{%- macro emit_is_inf_f32() -%}
fn is_inf_f32(value: f32) -> bool {
  return (bitcast<u32>(value) & 0x7fffffffu) == 0x7f800000u;
}{%- endmacro -%}
{%- macro emit_nan_from_inf_f32() -%}
fn nan_from_inf_f32(value: f32) -> f32 {
  return bitcast<f32>(bitcast<u32>(value) | 0x00400000u);
}{%- endmacro -%}
{%- macro emit_reduce_pio2() -%}
fn reduce_pio2(ax: f32) -> Pio2 {
  let ix = bitcast<u32>(ax);
  let e = (ix >> 23u) & 0xffu;
  let mant = (ix & 0x7fffffu) | 0x800000u;
  let p = i32(e) - 150;

  var a0 = 0u; var a1 = 0u; var a2 = 0u;
  for (var k = 0u; k < 14u; k = k + 1u) {
    let shift = p - 24 * (i32(k) + 1) + 94;
    if (shift <= -48 || shift >= 96) { continue; }

    let t = TWO_OVER_PI[k];
    let mlo = mant & 0xffffu; let mhi = mant >> 16u;
    let tlo = t & 0xffffu;    let thi = t >> 16u;
    let ll = mlo * tlo;
    let mid = mlo * thi + mhi * tlo;
    let hh = mhi * thi;
    let plo = ll + ((mid & 0xffffu) << 16u);
    let carry = select(0u, 1u, plo < ll);
    let phi32 = hh + (mid >> 16u) + carry;

    var v0 = 0u; var v1 = 0u; var off = 0;
    if (shift < 0) {
      let s = u32(-shift);
      if (s < 32u) {
        v0 = (plo >> s) | (phi32 << (32u - s));
        v1 = phi32 >> s;
      } else {
        v0 = phi32 >> (s - 32u);
        v1 = 0u;
      }
      off = 0;
    } else {
      v0 = plo; v1 = phi32; off = shift;
    }

    let li = off / 32; let b = u32(off % 32);
    var w0 = 0u; var w1 = 0u; var w2 = 0u;
    if (b == 0u) { w0 = v0; w1 = v1; w2 = 0u; }
    else {
      w0 = v0 << b;
      w1 = (v1 << b) | (v0 >> (32u - b));
      w2 = v1 >> (32u - b);
    }
    var t0 = 0u; var t1 = 0u; var t2 = 0u;
    if (li == 0) { t0 = w0; t1 = w1; t2 = w2; }
    else if (li == 1) { t1 = w0; t2 = w1; }
    else { t2 = w0; }

    let n0 = a0 + t0; let c0 = select(0u, 1u, n0 < a0);
    let n1a = a1 + t1; let c1a = select(0u, 1u, n1a < a1);
    let n1 = n1a + c0; let c1b = select(0u, 1u, n1 < n1a);
    let n2 = a2 + t2 + c1a + c1b;
    a0 = n0; a1 = n1; a2 = n2;
  }
  var n = a2 >> 30u;
  var phi = f32(a2 & 0x3fffffffu) * (1.0 / 1073741824.0)
          + f32(a1) * (1.0 / 4611686018427387904.0);
  if (phi >= 0.5) { phi = phi - 1.0; n = n + 1u; }
  var out: Pio2;
  out.octant = n & 3u;
  out.r = phi * PIO2_F;
  return out;
}{%- endmacro -%}
{%- macro emit_reduce_pio2_fast() -%}
fn reduce_pio2_fast(ax: f32) -> Pio2 {

  let nFloat = floor(fma(ax, INV_PIO2_F, 0.5));
  var residual = fma(-nFloat, PIO2_HI_F, ax);
  residual = fma(-nFloat, PIO2_LO_F, residual);
  var out: Pio2;
  out.octant = u32(nFloat) & 3u;
  out.r = residual;
  return out;
}{%- endmacro -%}
{%- macro emit_trig_reduction_support() -%}
{% include "ops/_shared/precise-trig-f32.wgsl.jinja" %}

const TWO_OVER_PI: array<u32, 14> = array<u32, 14>(
  0xa2f983u, 0x6e4e44u, 0x1529fcu, 0x2757d1u, 0xf534ddu, 0xc0db62u,
  0x95993cu, 0x439041u, 0xfe5163u, 0xabdebbu, 0xc561b7u, 0x246e3au,
  0x424dd2u, 0xe00649u
);
const PIO2_F: f32 = 1.5707963267948966;
const INV_PIO2_F: f32 = 0.6366197723675814;
const PIO2_HI_F: f32 = 1.570796251296997;
const PIO2_LO_F: f32 = 7.549789415861596e-8;
const REDUCE_THRESHOLD: f32 = 1.0e4;

struct Pio2 { octant: u32, r: f32 };

{{ emit_reduce_pio2_fast() }}

{{ emit_reduce_pio2() }}
{%- endmacro -%}
{%- macro emit_sin_accurate() -%}
fn sin_accurate(x: f32) -> f32 {
  if (is_nan_f32(x)) {
    return x;
  }
  if (is_inf_f32(x)) {
    return nan_from_inf_f32(x);
  }
  let ax = abs(x);
  var red: Pio2;
  if (ax < REDUCE_THRESHOLD) { red = reduce_pio2_fast(ax); }
  else { red = reduce_pio2(ax); }
  let reduced = precise_sincos_half_pi(red.r);
  var s: f32;
  switch (red.octant) {
    case 0u: { s = reduced.y; }
    case 1u: { s = reduced.x; }
    case 2u: { s = -reduced.y; }
    default: { s = -reduced.x; }
  }
  return select(s, -s, x < 0.0);
}{%- endmacro -%}
{%- macro emit_cos_accurate() -%}
fn cos_accurate(x: f32) -> f32 {
  let ax = abs(x);
  let ax_bits = bitcast<u32>(ax);
  if (((ax_bits >> 23u) & 0xffu) == 0xffu) {

    return bitcast<f32>(ax_bits | 0x00400000u);
  }
  var red: Pio2;
  if (ax < REDUCE_THRESHOLD) { red = reduce_pio2_fast(ax); }
  else { red = reduce_pio2(ax); }
  let reduced = precise_sincos_half_pi(red.r);
  switch (red.octant) {
    case 0u: { return reduced.x; }
    case 1u: { return -reduced.y; }
    case 2u: { return -reduced.x; }
    default: { return reduced.y; }
  }
}{%- endmacro -%}
{%- macro emit_tan_accurate() -%}
fn tan_accurate(x: f32) -> f32 {
  if (is_nan_f32(x)) {
    return x;
  }
  if (is_inf_f32(x)) {
    return nan_from_inf_f32(x);
  }
  let ax = abs(x);
  var red: Pio2;
  if (ax < REDUCE_THRESHOLD) { red = reduce_pio2_fast(ax); }
  else { red = reduce_pio2(ax); }
  let reduced = precise_sincos_half_pi(red.r);
  let sr = reduced.y;
  let cr = reduced.x;
  var sn: f32; var cs: f32;
  switch (red.octant) {
    case 0u: { sn = sr;  cs = cr;  }
    case 1u: { sn = cr;  cs = -sr; }
    case 2u: { sn = -sr; cs = -cr; }
    default: { sn = -cr; cs = sr;  }
  }
  let tn = sn / cs;
  return select(tn, -tn, x < 0.0);
}{%- endmacro -%}
{% if unaryVectorized %}{% if (source.op == "clip" and scalar != "i32" and scalar != "u32") or source.op == "relu" or source.op == "sin" or source.op == "tan" %}
{{ emit_is_nan_f32() }}
{% endif %}
{% if source.op == "relu" and scalar != "i32" %}
fn relu_value(value: f32) -> f32 {

  if (is_nan_f32(value)) {
    return value;
  }
  return max(value, 0.0);
}
{% endif %}
{% if source.op == "gelu" or source.op == "erf" %}
{{ emit_erf_approx() }}
{% endif %}
{% if source.op == "tanh" or source.op == "mish" or (source.op == "gelu" and source.approximate == "tanh") %}
fn tanh_safe(x: f32) -> f32 {

  if (x > 10.0) { return 1.0; }
  if (x < -10.0) { return -1.0; }

  if (x > -1.0e-4 && x < 1.0e-4) { return x; }
  return tanh(x);
}
{% endif %}
{% if source.op == "gelu" %}
fn gelu_value(v: f32) -> f32 {
{% if source.approximate == "tanh" %}
  return 0.5 * v * (1.0 + tanh_safe(0.7978845608028654 * (v + 0.044715 * v * v * v)));
{% else %}
  return 0.5 * v * (1.0 + erf_approx(v * 0.7071067811865476));
{% endif %}
}
{% endif %}
{% if source.op == "sigmoid" %}
{{ emit_sigmoid_safe() }}
{% endif %}
{% if source.op == "reciprocal" %}
fn reciprocal_value(v: f32) -> f32 {
  let av = abs(v);
  var r = 1.0 / v;
  if (av > 0.0 && av < 1.17549435e-38) {
    r = (1.0 / (v * 16777216.0)) * 16777216.0;
  }
  return r;
}
{% endif %}
{% if source.op == "clip" and scalar != "i32" and scalar != "u32" %}
fn clip_value(v: f32) -> f32 {
{% if source.boundsFromUniform %}
  var out = min(max(v, params.minValue), params.maxValue);
{% else %}
  var out = min(max(v, f32({{ source.minValue }})), f32({{ source.maxValue }}));
{% endif %}
  if (is_nan_f32(v)) {
    out = v;
  }
  return out;
}
{% endif %}
{% if source.op == "leaky_relu" %}
const LEAKY_RELU_ALPHA: f32 = f32({{ source.alpha }});
{% endif %}
{% if source.op == "swish" %}
const SWISH_ALPHA: f32 = f32({{ source.alpha }});
{% endif %}
{% if source.op == "mish" %}
fn mish_log1p_small_positive(y: f32) -> f32 {

  return y * (1.0 + y * (-0.5 + y * (0.3333333333333333 + y * (-0.25 + y * 0.2))));
}
fn mish_softplus(v: f32) -> f32 {

  if (v > 20.0) { return v; }
  if (v < -8.0) { return mish_log1p_small_positive(exp(v)); }
  return log(1.0 + exp(-abs(v))) + max(v, 0.0);
}
fn mish_value(v: f32) -> f32 {
  let softplus = mish_softplus(v);
  return v * tanh_safe(softplus);
}
{% endif %}
{% if source.op == "softplus" %}
const SOFTPLUS_POSITIVE_THRESHOLD: f32 = {% if usesF16 %}11.0{% else %}20.0{% endif %};
const SOFTPLUS_LOG1P_SERIES_THRESHOLD: f32 = {% if usesF16 %}-4.0{% else %}-8.0{% endif %};

{{ emit_log1p_small_positive() }}

{{ emit_softplus() }}
{% endif %}
{% if source.op == "softsign" %}
fn softsign_value(v: f32) -> f32 {
  let av = abs(v);
  var result: f32;
  if (av > 3.4028234663852886e38) {
    result = v / (1.0 + av);
  } else if (av > 1.0) {
    result = sign(v) / (1.0 + (1.0 / av));
  } else {
    result = v / (1.0 + av);
  }
  return result;
}
{% endif %}
{% if source.op == "hard_sigmoid" %}

const HARD_SIGMOID_ALPHA: f32 = f32({{ source.alpha }});
const HARD_SIGMOID_BETA: f32 = f32({{ source.beta }});
{% endif %}
{% if source.op == "elu" or source.op == "selu" or source.op == "celu" %}
fn expm1_safe(x: vec4<f32>) -> vec4<f32> {

  let series = x * (1.0 + x * (0.5 + x * (0.16666666666666666 + x * (0.041666666666666664 + x * (0.008333333333333333 + x * 0.001388888888888889)))));
  let direct = exp(x) - 1.0;
  return select(direct, series, abs(x) < vec4<f32>(0.125));
}
{% endif %}
{% if source.op == "elu" %}
const ELU_ALPHA: f32 = f32({{ source.alpha }});
{% endif %}
{% if source.op == "selu" %}
const SELU_ALPHA: f32 = f32({{ source.alpha }});
const SELU_GAMMA: f32 = f32({{ source.gamma }});
{% endif %}
{% if source.op == "celu" %}
const CELU_ALPHA: f32 = f32({{ source.alpha }});
{% endif %}
{% if source.op == "thresholded_relu" %}
const THRESHOLDED_RELU_ALPHA: f32 = f32({{ source.alpha }});
{% endif %}
{% if source.op == "shrink" %}
const SHRINK_BIAS: f32 = f32({{ source.bias }});
const SHRINK_LAMBD: f32 = f32({{ source.lambd }});
{% endif %}
{% if source.op == "round" %}
{{ emit_round_half_to_even() }}
{% endif %}
{% if source.op == "asinh" %}
{{ emit_asinh_safe() }}
{% endif %}
{% if source.op == "acosh" %}
{{ emit_acosh_safe() }}
{% endif %}
{% if source.op == "cosh" %}
{{ emit_cosh_safe() }}
{% endif %}
{% if source.op == "sinh" %}
{{ emit_sinh_safe() }}
{% endif %}
{% if source.op == "sin" or source.op == "cos" or source.op == "tan" %}
{{ emit_trig_reduction_support() }}

{% if source.op == "sin" or source.op == "tan" %}
{{ emit_is_inf_f32() }}

{{ emit_nan_from_inf_f32() }}
{% endif %}

{% endif %}
{% if source.op == "sin" %}
{{ emit_sin_accurate() }}
{% endif %}
{% if source.op == "cos" %}
{{ emit_cos_accurate() }}
{% endif %}
{% if source.op == "tan" %}
{{ emit_tan_accurate() }}
{% endif %}
{% if source.op == "acos" or source.op == "asin" or source.op == "atan" %}
{% include "ops/_shared/precise-inverse-trig-f32.wgsl.jinja" %}
{% endif %}
{% if source.op == "atanh" %}
{{ emit_atanh_safe(unaryDomainGuard) }}
{% endif %}
{% if source.op == "log" %}
{% if unaryDomainGuard %}{% include "ops/_shared/float-neg-inf.wgsl.jinja" %}{% endif %}
{{ emit_log_safe(unaryDomainGuard) }}
{% endif %}

{% else %}{% if source.op == "acos" or source.op == "asin" or source.op == "atan" %}
{% include "ops/_shared/precise-inverse-trig-f32.wgsl.jinja" %}
{% elif source.op == "acosh" %}
{{ emit_acosh_safe() }}
{% elif source.op == "asinh" %}
{{ emit_asinh_safe() }}
{% elif source.op == "clip" %}
{{ emit_is_nan_f32() }}
{% elif source.op == "cos" %}
{{ emit_trig_reduction_support() }}

{{ emit_cos_accurate() }}
{% elif source.op == "cosh" %}
{{ emit_cosh_safe() }}
{% elif source.op == "sinh" %}
{{ emit_sinh_safe() }}
{% elif source.op == "elu" or source.op == "selu" or source.op == "celu" %}
fn expm1_safe(x: f32) -> f32 {

  if (x > -0.125 && x < 0.125) {
    return x * (1.0 + x * (0.5 + x * (0.16666666666666666 + x * (0.041666666666666664 + x * (0.008333333333333333 + x * 0.001388888888888889)))));
  }
  return exp(x) - 1.0;
}
{% elif source.op == "erf" %}
{{ emit_erf_approx() }}
{% elif source.op == "gelu" %}
{{ emit_erf_approx() }}

{% if approximate == "tanh" %}
fn tanh_safe(x: f32) -> f32 {

  if (x > 10.0) { return 1.0; }
  if (x < -10.0) { return -1.0; }
  return tanh(x);
}
{% endif %}

fn gelu_value(v: f32) -> f32 {
{% if approximate == "tanh" %}
  return 0.5 * v * (1.0 + tanh_safe(0.7978845608028654 * (v + 0.044715 * v * v * v)));
{% else %}
  return 0.5 * v * (1.0 + erf_approx(v * 0.7071067811865476));
{% endif %}
}
{% elif source.op == "mish" %}
fn tanh_safe(x: f32) -> f32 {

  if (x > 10.0) { return 1.0; }
  if (x < -10.0) { return -1.0; }

  if (x > -1.0e-4 && x < 1.0e-4) { return x; }
  return tanh(x);
}
fn log1p_small_positive(y: f32) -> f32 {

  return y * (1.0 + y * (-0.5 + y * (0.3333333333333333 + y * (-0.25 + y * 0.2))));
}
fn mish_softplus(v: f32) -> f32 {

  if (v > 20.0) { return v; }
  if (v < -8.0) { return log1p_small_positive(exp(v)); }
  return log(1.0 + exp(-abs(v))) + max(v, 0.0);
}
{% elif source.op == "round" %}
{{ emit_round_half_to_even() }}
{% elif source.op == "atanh" %}
{{ emit_atanh_safe(unaryDomainGuard) }}
{% elif source.op == "log" %}
{% if unaryDomainGuard %}{% include "ops/_shared/float-neg-inf.wgsl.jinja" %}{% endif %}
{{ emit_log_safe(unaryDomainGuard) }}
{% elif source.op == "sigmoid" %}
{{ emit_sigmoid_safe() }}
{% elif source.op == "sin" %}
{{ emit_trig_reduction_support() }}

{{ emit_is_nan_f32() }}

{{ emit_is_inf_f32() }}

{{ emit_nan_from_inf_f32() }}

{{ emit_sin_accurate() }}
{% elif source.op == "softplus" %}
const SOFTPLUS_POSITIVE_THRESHOLD: f32 = {% if usesF16 %}11.0{% else %}20.0{% endif %};
const SOFTPLUS_LOG1P_SERIES_THRESHOLD: f32 = {% if usesF16 %}-4.0{% else %}-8.0{% endif %};

{{ emit_log1p_small_positive() }}

{{ emit_softplus() }}
{% elif source.op == "tan" %}
{{ emit_trig_reduction_support() }}

{{ emit_is_nan_f32() }}

{{ emit_is_inf_f32() }}

{{ emit_nan_from_inf_f32() }}

{{ emit_tan_accurate() }}
{% elif source.op == "tanh" %}
fn tanh_safe(x: f32) -> f32 {

  if (x > 10.0) { return 1.0; }
  if (x < -10.0) { return -1.0; }
  return tanh(x);
}
{% endif %}
{% endif %}
`],["ops/_shared/unary-scalar.wgsl.jinja",`{% include "ops/_shared/elementwise-tail-loop.wgsl.jinja" %}
{% if source.op == "cast" %}
{% if T == "f16" or U == "f16" %}
enable f16;
{% endif %}
{{ env.wgsl.resourceDeclarations }}
@compute @workgroup_size({{ tunables.WORKGROUP_SIZE }})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {

  let i = gid.x + gid.y * nwg.x * {{ tunables.WORKGROUP_SIZE }}u;
  if (i >= params.count) {
    return;
  }
{% if toBool %}
{% if T == "f16" or T == "f32" %}

  y[i] = select(0u, 1u, (bitcast<u32>(f32(x[i])) & 0x7fffffffu) != 0u);
{% else %}

  y[i] = select(0u, 1u, x[i] != {{ T }}(0));
{% endif %}
{% elif wrapNarrowInt %}

  let low = i32(f32(x[i])) & 0xFF;
  y[i] = {{ U }}({% if wrapSigned %}select(low, low - 256, low > 127){% else %}low{% endif %});
{% else %}
  y[i] = {{ U }}(x[i]);
{% endif %}
}
{% elif source.op == "not" %}
{{ env.wgsl.resourceDeclarations }}

@compute @workgroup_size({{ tunables.WORKGROUP_SIZE }})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {

  let i = gid.x + gid.y * nwg.x * {{ tunables.WORKGROUP_SIZE }}u;
  if (i >= params.count) {
    return;
  }
  y[i] = select(0u, 1u, x[i] == 0u);
}
{% elif source.op == "relu" %}
{% if T == "f16" %}
enable f16;
{% endif %}
{{ env.wgsl.resourceDeclarations }}

{% include "ops/_shared/float-is-nan.wgsl.jinja" %}
{{ flat_tail_open() }}
{% if T == "i32" %}
  let value = x[i];
  y[i] = select(value, 0i, value < 0i);
{% else %}
  let value = f32(x[i]);
  var out = max(value, 0.0);
  if (is_nan_f32(value)) {
    out = value;
  }
  y[i] = {{ T }}(out);
{% endif %}
{{ flat_tail_close() -}}
}
{% else %}
{% if usesF16 %}
enable f16;
{% endif %}
{{ env.wgsl.resourceDeclarations }}
{% set unaryVectorized = false %}{% include "ops/_shared/unary-numeric-helpers.wgsl.jinja" %}{{ flat_tail_open() }}
{% if source.op == "abs" %}
{% if scalar == "i32" %}
  let value = x[i];
  let absval = select(value, -value, value < 0i);
{% if isInt8 %}

  y[i] = (absval << 24u) >> 24u;
{% else %}
  y[i] = absval;
{% endif %}
{% elif scalar == "u32" %}
  y[i] = x[i];
{% else %}
  y[i] = {{ scalar }}(abs(f32(x[i])));
{% endif %}
{% elif source.op == "acos" %}
  let v = f32(x[i]);
  y[i] = {{ scalar }}(acos_accurate(v));
{% elif source.op == "acosh" %}
  let v = f32(x[i]);
  y[i] = {{ scalar }}(acosh_safe(v));
{% elif source.op == "asin" %}
  let v = f32(x[i]);
  y[i] = {{ scalar }}(asin_accurate(v));
{% elif source.op == "asinh" %}
  let v = f32(x[i]);
  y[i] = {{ scalar }}(asinh_safe(v));
{% elif source.op == "atan" %}
  let v = f32(x[i]);
  y[i] = {{ scalar }}(atan_accurate(v));
{% elif source.op == "atanh" %}
  let v = f32(x[i]);
  y[i] = {{ scalar }}(atanh_safe(v));
{% elif source.op == "castlike" %}
{% if toBool %}
{% if inScalar == "f16" or inScalar == "f32" %}

  y[i] = select(0u, 1u, (bitcast<u32>(f32(x[i])) & 0x7fffffffu) != 0u);
{% else %}
  y[i] = select(0u, 1u, x[i] != {{ inScalar }}(0));
{% endif %}
{% elif wrapNarrowInt %}

  let low = i32(f32(x[i])) & 0xFF;
  y[i] = {{ outScalar }}({% if wrapSigned %}select(low, low - 256, low > 127){% else %}low{% endif %});
{% else %}
  y[i] = {{ outScalar }}(x[i]);
{% endif %}
{% elif source.op == "ceil" %}
  y[i] = {{ scalar }}(ceil(f32(x[i])));
{% elif source.op == "celu" %}
  let v = f32(x[i]);
  y[i] = {{ scalar }}(select(params.alpha * expm1_safe(v / params.alpha), v, v >= 0.0));
{% elif source.op == "clip" %}
{% if scalar == "i32" or scalar == "u32" %}
  let value = input[i];
{% if source.boundsFromInput %}
  output[i] = min(max(value, clipMin[0]), clipMax[0]);
{% elif source.boundsFromUniform %}
  output[i] = min(max(value, {{ scalar }}(params.minValue)), {{ scalar }}(params.maxValue));
{% else %}
  output[i] = min(max(value, {{ scalar }}({{ source.minValue }})), {{ scalar }}({{ source.maxValue }}));
{% endif %}
{% else %}
  let value = f32(input[i]);
{% if source.boundsFromInput %}
  var out = min(max(value, f32(clipMin[0])), f32(clipMax[0]));
{% elif source.boundsFromUniform %}
  var out = min(max(value, params.minValue), params.maxValue);
{% else %}
  var out = min(max(value, f32({{ source.minValue }})), f32({{ source.maxValue }}));
{% endif %}
  if (is_nan_f32(value)) {
    out = value;
  }
  output[i] = {{ scalar }}(out);
{% endif %}
{% elif source.op == "cos" %}
  y[i] = {{ scalar }}(cos_accurate(f32(x[i])));
{% elif source.op == "cosh" %}
  let v = f32(x[i]);
  y[i] = {{ scalar }}(cosh_safe(v));
{% elif source.op == "elu" %}
  let v = f32(x[i]);
  y[i] = {{ scalar }}(select(params.alpha * expm1_safe(v), v, v >= 0.0));
{% elif source.op == "erf" %}
  y[i] = {{ scalar }}(erf_approx(f32(x[i])));
{% elif source.op == "exp" %}
  y[i] = {{ scalar }}(exp(f32(x[i])));
{% elif source.op == "floor" %}
  y[i] = {{ scalar }}(floor(f32(x[i])));
{% elif source.op == "gelu" %}
  y[i] = {{ scalar }}(gelu_value(f32(x[i])));
{% elif source.op == "hard_sigmoid" %}

  let xf = f32(x[i]);
  let value = params.alpha * xf + params.beta;
  let x_bits = bitcast<u32>(xf);
  let x_exp_all = (x_bits & 0x7f800000u) == 0x7f800000u;
  let nan_lane = x_exp_all && (((x_bits & 0x007fffffu) != 0u) || params.alpha == 0.0);
  let nan_val = bitcast<f32>(x_bits | 0x00400000u);
  y[i] = {{ scalar }}(select(clamp(value, 0.0, 1.0), nan_val, nan_lane));
{% elif source.op == "hard_swish" %}
  let v = f32(x[i]);
  y[i] = {{ scalar }}(v * clamp(v / 6.0 + 0.5, 0.0, 1.0));
{% elif source.op == "isinf" %}
  let value = f32(x[i]);
  let bits = bitcast<u32>(value);
  let exponent = bits & 0x7f800000u;
  let mantissa = bits & 0x007fffffu;
  let sign = bits & 0x80000000u;
  let is_inf = exponent == 0x7f800000u && mantissa == 0u;
  let positive = params.detectPositive != 0u && is_inf && sign == 0u;
  let negative = params.detectNegative != 0u && is_inf && sign != 0u;
  y[i] = select(0u, 1u, positive || negative);
{% elif source.op == "isnan" %}
  let value = f32(x[i]);
  let bits = bitcast<u32>(value);
  let exponent = bits & 0x7f800000u;
  let mantissa = bits & 0x007fffffu;
  y[i] = select(0u, 1u, exponent == 0x7f800000u && mantissa != 0u);
{% elif source.op == "leaky_relu" %}
  let v = f32(x[i]);
  y[i] = {{ scalar }}(select(params.alpha * v, v, v >= 0.0));
{% elif source.op == "log" %}
  y[i] = {{ scalar }}(log_safe(f32(x[i])));
{% elif source.op == "mish" %}
  let v = f32(x[i]);
  let softplus = mish_softplus(v);
  y[i] = {{ scalar }}(v * tanh_safe(softplus));
{% elif source.op == "neg" %}
{% if scalar == "i32" %}
{% if isInt8 %}

  y[i] = ((-x[i]) << 24u) >> 24u;
{% else %}
  y[i] = -x[i];
{% endif %}
{% else %}
  y[i] = {{ scalar }}(-f32(x[i]));
{% endif %}
{% elif source.op == "reciprocal" %}
  let v = f32(x[i]);
  let av = abs(v);
  var r = 1.0 / v;
  if (av > 0.0 && av < 1.17549435e-38) {
    r = (1.0 / (v * 16777216.0)) * 16777216.0;
  }
  y[i] = {{ scalar }}(r);
{% elif source.op == "round" %}
  y[i] = {{ scalar }}(round_half_to_even(f32(x[i])));
{% elif source.op == "selu" %}
  let v = f32(x[i]);
  let elu = select(params.alpha * expm1_safe(v), v, v > 0.0);
  y[i] = {{ scalar }}(params.gamma * elu);
{% elif source.op == "shrink" %}
  let v = f32(x[i]);
  y[i] = {{ scalar }}(select(select(0.0, v - params.bias, v > params.lambd), v + params.bias, v < -params.lambd));
{% elif source.op == "sigmoid" %}
  y[i] = {{ scalar }}(sigmoid_safe(f32(x[i])));
{% elif source.op == "sign" %}
{% if scalar == "i32" %}
  let v = input[i];
  output[i] = select(select(0i, 1i, v > 0i), -1i, v < 0i);
{% elif scalar == "u32" %}
  let v = input[i];
  output[i] = select(0u, 1u, v > 0u);
{% else %}
  let v = f32(input[i]);

  let v_bits = bitcast<u32>(v);
  let v_is_nan = (v_bits & 0x7f800000u) == 0x7f800000u && (v_bits & 0x007fffffu) != 0u;
  var s = select(select(0.0, 1.0, v > 0.0), -1.0, v < 0.0);
  if (v_is_nan) { s = v; }
  output[i] = {{ scalar }}(s);
{% endif %}
{% elif source.op == "sin" %}
  y[i] = {{ scalar }}(sin_accurate(f32(x[i])));
{% elif source.op == "sinh" %}
  let v = f32(x[i]);
  y[i] = {{ scalar }}(sinh_safe(v));
{% elif source.op == "softplus" %}
  y[i] = {{ scalar }}(softplus(f32(x[i])));
{% elif source.op == "softsign" %}
  let v = f32(input[i]);
  let av = abs(v);
  var result: f32;
  if (av > 3.4028234663852886e38) {
    result = v / (1.0 + av);
  } else if (av > 1.0) {
    result = sign(v) / (1.0 + (1.0 / av));
  } else {
    result = v / (1.0 + av);
  }
  output[i] = {{ scalar }}(result);
{% elif source.op == "sqrt" %}
  y[i] = {{ scalar }}(sqrt(f32(x[i])));
{% elif source.op == "swish" %}
  let v = f32(x[i]);
  y[i] = {{ scalar }}(v / (1.0 + exp(-params.alpha * v)));
{% elif source.op == "tan" %}
  y[i] = {{ scalar }}(tan_accurate(f32(x[i])));
{% elif source.op == "tanh" %}
  y[i] = {{ scalar }}(tanh_safe(f32(x[i])));
{% elif source.op == "thresholded_relu" %}
  let v = f32(x[i]);
  y[i] = {{ scalar }}(select(0.0, v, v > params.alpha));
{% endif %}
{{ flat_tail_close() -}}
}
{% endif %}
`],["ops/_shared/unary-vec4.wgsl.jinja",`{% if usesF16 %}
enable f16;
{% endif %}
{{ env.wgsl.resourceDeclarations }}

{% set unaryVectorized = true %}{% include "ops/_shared/unary-numeric-helpers.wgsl.jinja" %}@compute @workgroup_size({{ tunables.WORKGROUP_SIZE }})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {

  let i = gid.x + gid.y * nwg.x * {{ tunables.WORKGROUP_SIZE }}u;
  if (i >= params.count) {
    return;
  }
  let xv = x[i];
{% if source.op == "relu" %}
{% if scalar == "i32" %}
  y[i] = select(xv, vec4<i32>(0i), xv < vec4<i32>(0i));
{% else %}

  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(
    relu_value(fv.x), relu_value(fv.y), relu_value(fv.z), relu_value(fv.w)));
{% endif %}
{% elif source.op == "abs" %}
{% if scalar == "i32" %}
  let absv = select(xv, -xv, xv < vec4<i32>(0i));
{% if isInt8 %}

  y[i] = (absv << vec4<u32>(24u)) >> vec4<u32>(24u);
{% else %}
  y[i] = absv;
{% endif %}
{% elif scalar == "u32" %}
  y[i] = xv;
{% else %}
  y[i] = {{ vectorScalar }}(abs(vec4<f32>(xv)));
{% endif %}
{% elif source.op == "neg" %}
{% if scalar == "i32" %}
{% if isInt8 %}

  y[i] = ((-xv) << vec4<u32>(24u)) >> vec4<u32>(24u);
{% else %}
  y[i] = -xv;
{% endif %}
{% else %}
  y[i] = {{ vectorScalar }}(-vec4<f32>(xv));
{% endif %}
{% elif source.op == "exp" %}
  y[i] = {{ vectorScalar }}(exp(vec4<f32>(xv)));
{% elif source.op == "log" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(
    log_safe(fv.x), log_safe(fv.y), log_safe(fv.z), log_safe(fv.w)));
{% elif source.op == "sqrt" %}
  y[i] = {{ vectorScalar }}(sqrt(vec4<f32>(xv)));
{% elif source.op == "sigmoid" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(sigmoid_safe(fv.x), sigmoid_safe(fv.y), sigmoid_safe(fv.z), sigmoid_safe(fv.w)));
{% elif source.op == "tanh" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(tanh_safe(fv.x), tanh_safe(fv.y), tanh_safe(fv.z), tanh_safe(fv.w)));
{% elif source.op == "erf" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(erf_approx(fv.x), erf_approx(fv.y), erf_approx(fv.z), erf_approx(fv.w)));
{% elif source.op == "gelu" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(gelu_value(fv.x), gelu_value(fv.y), gelu_value(fv.z), gelu_value(fv.w)));
{% elif source.op == "leaky_relu" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(select(LEAKY_RELU_ALPHA * fv, fv, fv >= vec4<f32>(0.0)));
{% elif source.op == "reciprocal" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(reciprocal_value(fv.x), reciprocal_value(fv.y), reciprocal_value(fv.z), reciprocal_value(fv.w)));
{% elif source.op == "clip" %}
{% if scalar == "i32" or scalar == "u32" %}
{% if source.boundsFromUniform %}
  let lower = {{ scalar }}(params.minValue);
  let upper = {{ scalar }}(params.maxValue);
{% else %}
  let lower = {{ scalar }}({{ source.minValue }});
  let upper = {{ scalar }}({{ source.maxValue }});
{% endif %}
  y[i] = min(max(xv, vec4<{{ scalar }}>(lower)), vec4<{{ scalar }}>(upper));
{% else %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(clip_value(fv.x), clip_value(fv.y), clip_value(fv.z), clip_value(fv.w)));
{% endif %}
{% elif source.op == "swish" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(fv / (1.0 + exp(-SWISH_ALPHA * fv)));
{% elif source.op == "mish" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(mish_value(fv.x), mish_value(fv.y), mish_value(fv.z), mish_value(fv.w)));
{% elif source.op == "softplus" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(softplus(fv.x), softplus(fv.y), softplus(fv.z), softplus(fv.w)));
{% elif source.op == "softsign" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(softsign_value(fv.x), softsign_value(fv.y), softsign_value(fv.z), softsign_value(fv.w)));
{% elif source.op == "hard_sigmoid" %}
  let fv = vec4<f32>(xv);

  let hv = fv * HARD_SIGMOID_ALPHA + HARD_SIGMOID_BETA;
  let fv_bits = bitcast<vec4<u32>>(fv);
  let fv_exp_all = (fv_bits & vec4<u32>(0x7f800000u)) == vec4<u32>(0x7f800000u);
{% if source.alpha == 0 %}

  let nan_lane = fv_exp_all;
{% else %}
  let nan_lane = fv_exp_all & ((fv_bits & vec4<u32>(0x007fffffu)) != vec4<u32>(0u));
{% endif %}

  let nan_val = bitcast<vec4<f32>>(fv_bits | vec4<u32>(0x00400000u));
  y[i] = {{ vectorScalar }}(select(clamp(hv, vec4<f32>(0.0), vec4<f32>(1.0)), nan_val, nan_lane));
{% elif source.op == "hard_swish" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(fv * clamp(fv / 6.0 + 0.5, vec4<f32>(0.0), vec4<f32>(1.0)));
{% elif source.op == "elu" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(select(ELU_ALPHA * expm1_safe(fv), fv, fv >= vec4<f32>(0.0)));
{% elif source.op == "selu" %}
  let fv = vec4<f32>(xv);
  let eluv = select(SELU_ALPHA * expm1_safe(fv), fv, fv > vec4<f32>(0.0));
  y[i] = {{ vectorScalar }}(SELU_GAMMA * eluv);
{% elif source.op == "celu" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(select(CELU_ALPHA * expm1_safe(fv / CELU_ALPHA), fv, fv >= vec4<f32>(0.0)));
{% elif source.op == "thresholded_relu" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(select(vec4<f32>(0.0), fv, fv > vec4<f32>(THRESHOLDED_RELU_ALPHA)));
{% elif source.op == "shrink" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(select(select(vec4<f32>(0.0), fv - SHRINK_BIAS, fv > vec4<f32>(SHRINK_LAMBD)), fv + SHRINK_BIAS, fv < vec4<f32>(-SHRINK_LAMBD)));
{% elif source.op == "sign" %}
{% if scalar == "i32" %}
  y[i] = select(select(vec4<i32>(0i), vec4<i32>(1i), xv > vec4<i32>(0i)), vec4<i32>(-1i), xv < vec4<i32>(0i));
{% elif scalar == "u32" %}
  y[i] = select(vec4<u32>(0u), vec4<u32>(1u), xv > vec4<u32>(0u));
{% else %}
  let fv = vec4<f32>(xv);

  let fv_bits = bitcast<vec4<u32>>(fv);
  let fv_is_nan = ((fv_bits & vec4<u32>(0x7f800000u)) == vec4<u32>(0x7f800000u)) & ((fv_bits & vec4<u32>(0x007fffffu)) != vec4<u32>(0u));
  let signed = select(select(vec4<f32>(0.0), vec4<f32>(1.0), fv > vec4<f32>(0.0)), vec4<f32>(-1.0), fv < vec4<f32>(0.0));
  y[i] = {{ vectorScalar }}(select(signed, fv, fv_is_nan));
{% endif %}
{% elif source.op == "floor" %}
  y[i] = {{ vectorScalar }}(floor(vec4<f32>(xv)));
{% elif source.op == "ceil" %}
  y[i] = {{ vectorScalar }}(ceil(vec4<f32>(xv)));
{% elif source.op == "round" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(round_half_to_even(fv.x), round_half_to_even(fv.y), round_half_to_even(fv.z), round_half_to_even(fv.w)));
{% elif source.op == "sin" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(sin_accurate(fv.x), sin_accurate(fv.y), sin_accurate(fv.z), sin_accurate(fv.w)));
{% elif source.op == "cos" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(cos_accurate(fv.x), cos_accurate(fv.y), cos_accurate(fv.z), cos_accurate(fv.w)));
{% elif source.op == "tan" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(tan_accurate(fv.x), tan_accurate(fv.y), tan_accurate(fv.z), tan_accurate(fv.w)));
{% elif source.op == "sinh" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(sinh_safe(fv.x), sinh_safe(fv.y), sinh_safe(fv.z), sinh_safe(fv.w)));
{% elif source.op == "cosh" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(cosh_safe(fv.x), cosh_safe(fv.y), cosh_safe(fv.z), cosh_safe(fv.w)));
{% elif source.op == "asin" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(asin_accurate(fv.x), asin_accurate(fv.y), asin_accurate(fv.z), asin_accurate(fv.w)));
{% elif source.op == "acos" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(acos_accurate(fv.x), acos_accurate(fv.y), acos_accurate(fv.z), acos_accurate(fv.w)));
{% elif source.op == "atan" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(atan_accurate(fv.x), atan_accurate(fv.y), atan_accurate(fv.z), atan_accurate(fv.w)));
{% elif source.op == "atanh" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(
    atanh_safe(fv.x), atanh_safe(fv.y), atanh_safe(fv.z), atanh_safe(fv.w)));
{% elif source.op == "asinh" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(asinh_safe(fv.x), asinh_safe(fv.y), asinh_safe(fv.z), asinh_safe(fv.w)));
{% elif source.op == "acosh" %}
  let fv = vec4<f32>(xv);
  y[i] = {{ vectorScalar }}(vec4<f32>(acosh_safe(fv.x), acosh_safe(fv.y), acosh_safe(fv.z), acosh_safe(fv.w)));
{% elif source.op == "isnan" %}
  let fv = vec4<f32>(xv);
  let bits = bitcast<vec4<u32>>(fv);
  let exponent = bits & vec4<u32>(0x7f800000u);
  let mantissa = bits & vec4<u32>(0x007fffffu);
  y[i] = select(vec4<u32>(0u), vec4<u32>(1u), (exponent == vec4<u32>(0x7f800000u)) & (mantissa != vec4<u32>(0u)));
{% elif source.op == "isinf" %}
  let fv = vec4<f32>(xv);
  let bits = bitcast<vec4<u32>>(fv);
  let exponent = bits & vec4<u32>(0x7f800000u);
  let mantissa = bits & vec4<u32>(0x007fffffu);
  let sgn = bits & vec4<u32>(0x80000000u);
  let is_inf = (exponent == vec4<u32>(0x7f800000u)) & (mantissa == vec4<u32>(0u));
{% if source.detectPositive %}
  let positive = is_inf & (sgn == vec4<u32>(0u));
{% else %}
  let positive = vec4<bool>(false);
{% endif %}
{% if source.detectNegative %}
  let negative = is_inf & (sgn != vec4<u32>(0u));
{% else %}
  let negative = vec4<bool>(false);
{% endif %}
  y[i] = select(vec4<u32>(0u), vec4<u32>(1u), positive | negative);
{% elif source.op == "not" %}
  y[i] = select(vec4<u32>(0u), vec4<u32>(1u), xv == vec4<u32>(0u));
{% elif source.op == "cast" or source.op == "castlike" %}
{% if wrapNarrowInt %}

  let low = vec4<i32>(vec4<f32>(xv)) & vec4<i32>(0xFF);
  y[i] = {{ outVec }}({% if wrapSigned %}select(low, low - vec4<i32>(256), low > vec4<i32>(127)){% else %}low{% endif %});
{% else %}
  y[i] = {{ outVec }}(xv);
{% endif %}
{% endif %}
}
`],["ops/_shared/norm-row-stats.wgsl.jinja",`{% if source.usesF16 %}
enable f16;
{% endif %}
{% set combineSubgroups = source.combineSubgroups if source.combineSubgroups is defined else true %}
{% set scalarIo = source.scalarIo if source.scalarIo is defined else false %}
{% set packedBf16Embedding = source.packedBf16Embedding if source.packedBf16Embedding is defined else false %}
{% set rmsWeightOffset = source.rmsWeightOffset if source.rmsWeightOffset is defined else false %}
{% set rmsScaleAfterCast = source.rmsScaleAfterCast if source.rmsScaleAfterCast is defined else false %}
{% set rmsResidualAdd = source.rmsResidualAdd if source.rmsResidualAdd is defined else false %}
{% set rmsChainNorm = source.rmsChainNorm if source.rmsChainNorm is defined else false %}
{% if rmsWeightOffset %}
{% set rmsScaleVec = "(vec4<f32>(1.0) + vec4<f32>(scale[i]))" %}
{% set rmsScaleScalar = "(1.0 + f32(scale[i]))" %}
{% else %}
{% set rmsScaleVec = "vec4<f32>(scale[i])" %}
{% set rmsScaleScalar = "f32(scale[i])" %}
{% endif %}
{% set subgroupMinSize = env.device.adapterInfo.subgroupMinSize if env.device.adapterInfo.subgroupMinSize is defined else 4 %}
{% set maySpanSubgroups = combineSubgroups and source.wg > subgroupMinSize %}
{% if combineSubgroups %}
enable subgroups;
{% endif %}
{{ env.wgsl.resourceDeclarations }}

const HIDDEN: u32 = {{ source.hidden }}u;
{% if source.vec4 %}
const HIDDEN_V: u32 = {{ source.hiddenVec }}u;
{% endif %}
{% if packedBf16Embedding %}
const HIDDEN_PAIRS: u32 = {{ source.hiddenPairs }}u;
const NUM_ROWS: u32 = {{ source.numRows }}u;
{% endif %}
const WG: u32 = {{ source.wg }}u;
{% if source.mode != "lp" %}
const EPSILON: f32 = {{ source.epsilon }};
{% endif %}
{% if rmsChainNorm %}
const EPSILON2: f32 = {{ source.epsilon2 }};
{% endif %}
{% if source.mode == "group" %}
const NUM_GROUPS: u32 = {{ source.numGroups }}u;
const CPG: u32 = {{ source.cpg }}u;
{% if source.vec4 %}
const SPATIAL_V: u32 = {{ source.spatialVec }}u;
{% else %}
const SPATIAL: u32 = {{ source.spatial }}u;
{% endif %}
{% endif %}
{% if source.mode == "instance" %}
const CHANNELS: u32 = {{ source.channels }}u;
{% endif %}

{% if packedBf16Embedding %}
fn unpack_bf16_pair(word: u32) -> vec2<f32> {
  let bits = vec2<u32>(word & 0xffffu, word >> 16u);
  return bitcast<vec2<f32>>(bits << vec2<u32>(16u));
}

fn embedding_scalar(source_row: u32, hidden: u32) -> f32 {
  if (source_row >= NUM_ROWS) {
    return 0.0;
  }
  let word = x[source_row * HIDDEN_PAIRS + (hidden >> 1u)];
  let bits = select(word & 0xffffu, word >> 16u, (hidden & 1u) != 0u);
  return bitcast<f32>(bits << 16u);
}

{% if source.vec4 %}
fn embedding_vec4(source_row: u32, hidden_vec: u32) -> vec4<f32> {
  if (source_row >= NUM_ROWS) {
    return vec4<f32>(0.0);
  }
  let base = source_row * HIDDEN_PAIRS + hidden_vec * 2u;
  let low = unpack_bf16_pair(x[base]);
  let high = unpack_bf16_pair(x[base + 1u]);
  return vec4<f32>(low, high);
}
{% endif %}
{% endif %}

{% if source.vec4 and scalarIo %}
fn load_vec4(index: u32) -> vec4<f32> {
  return vec4<f32>(x[index], x[index + 1u], x[index + 2u], x[index + 3u]);
}
{% endif %}

{% if combineSubgroups %}
{% if maySpanSubgroups %}

const MAX_SG: u32 = {{ source.maxSubgroups }}u;
{% if source.mode == "rms" or source.mode == "lp" %}
var<workgroup> sg_partials: array<f32, MAX_SG>;
{% else %}
var<workgroup> sg_partials: array<vec2<f32>, MAX_SG>;
{% endif %}
{% endif %}

{% if source.mode == "rms" or source.mode == "lp" %}
fn reduce_scalar(value: f32, tid: u32, sg_lane: u32, sg_size: u32) -> f32 {
  let s = subgroupAdd(value);
{% if maySpanSubgroups %}

  if (WG <= sg_size) {
    return s;
  }
  if (sg_lane == 0u) {
    sg_partials[tid / sg_size] = s;
  }
  workgroupBarrier();
  let num_sg = (WG + sg_size - 1u) / sg_size;

  if (num_sg <= sg_size) {
    let partial = sg_partials[min(sg_lane, num_sg - 1u)];
    return subgroupAdd(select(0.0, partial, sg_lane < num_sg));
  }
  var total = 0.0;
  for (var i = 0u; i < num_sg; i++) {
    total += sg_partials[i];
  }
  return total;
{% else %}
  return s;
{% endif %}
}
{% else %}
fn reduce_pair(value: vec2<f32>, tid: u32, sg_lane: u32, sg_size: u32) -> vec2<f32> {
  let s = vec2<f32>(subgroupAdd(value.x), subgroupAdd(value.y));
{% if maySpanSubgroups %}

  if (WG <= sg_size) {
    return s;
  }
  if (sg_lane == 0u) {
    sg_partials[tid / sg_size] = s;
  }
  workgroupBarrier();
  let num_sg = (WG + sg_size - 1u) / sg_size;
  if (num_sg <= sg_size) {
    let partial = sg_partials[min(sg_lane, num_sg - 1u)];
    return vec2<f32>(
      subgroupAdd(select(0.0, partial.x, sg_lane < num_sg)),
      subgroupAdd(select(0.0, partial.y, sg_lane < num_sg))
    );
  }
  var total = vec2<f32>(0.0);
  for (var i = 0u; i < num_sg; i++) {
    total += sg_partials[i];
  }
  return total;
{% else %}
  return s;
{% endif %}
}
{% endif %}
{% else %}
{% if source.mode == "rms" or source.mode == "lp" %}
var<workgroup> tr0: array<f32, WG>;
fn reduce_scalar(value: f32, tid: u32) -> f32 {
  tr0[tid] = value;
  workgroupBarrier();
  var stride: u32 = WG / 2u;
  loop {
    if (stride == 0u) { break; }
    if (tid < stride) { tr0[tid] = tr0[tid] + tr0[tid + stride]; }
    stride = stride / 2u;
    workgroupBarrier();
  }
  let reduced = tr0[0];
  workgroupBarrier();
  return reduced;
}
{% else %}
var<workgroup> tr0: array<f32, WG>;
var<workgroup> tr1: array<f32, WG>;
fn reduce_pair(value: vec2<f32>, tid: u32) -> vec2<f32> {
  tr0[tid] = value.x;
  tr1[tid] = value.y;
  workgroupBarrier();
  var stride: u32 = WG / 2u;
  loop {
    if (stride == 0u) { break; }
    if (tid < stride) {
      tr0[tid] = tr0[tid] + tr0[tid + stride];
      tr1[tid] = tr1[tid] + tr1[tid + stride];
    }
    stride = stride / 2u;
    workgroupBarrier();
  }
  let reduced = vec2<f32>(tr0[0], tr1[0]);
  workgroupBarrier();
  return reduced;
}
{% endif %}
{% endif %}

@compute @workgroup_size(WG, 1, 1)
fn main(
  @builtin(workgroup_id) wg_id: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>{% if combineSubgroups %},
  @builtin(subgroup_invocation_id) sg_lane: u32,
  @builtin(subgroup_size) sg_size: u32{% endif %}
) {
  let row = wg_id.x + wg_id.y * params.rowStride;
  if (row >= params.rows) {
    return;
  }
  let tid = lid.x;
{% if packedBf16Embedding %}
  let source_row = indices[row];
{% if source.vec4 %}
  let base = row * HIDDEN_V;
{% else %}
  let base = row * HIDDEN;
{% endif %}
{% elif source.vec4 and not scalarIo %}
  let base = row * HIDDEN_V;
{% else %}
  let base = row * HIDDEN;
{% endif %}

{% if source.mode == "layer" or source.mode == "group" or source.mode == "instance" %}
{% if source.vec4 %}
{% if scalarIo %}
  let shift = f32(x[base]);
{% else %}
  let shift = f32(x[base].x);
{% endif %}
{% else %}
  let shift = f32(x[base]);
{% endif %}
{% endif %}

{% if source.mode == "rms" or source.mode == "lp" %}
  var acc = 0.0;
{% else %}
  var acc = vec2<f32>(0.0, 0.0);
{% endif %}
{% if source.vec4 %}
  for (var i = tid; i < HIDDEN_V; i = i + WG) {
{% if packedBf16Embedding %}
    let v = embedding_vec4(source_row, i);
    embedding_out[base + i] = v;
{% elif scalarIo %}
    let v = load_vec4(base + i * 4u);
{% else %}
    let v = vec4<f32>(x[base + i]);
{% endif %}
{% if source.mode == "layer" or source.mode == "group" or source.mode == "instance" %}
    let d = v - vec4<f32>(shift);
    acc.x = acc.x + d.x + d.y + d.z + d.w;
    acc.y = acc.y + dot(d, d);
{% elif source.mode == "rms" %}
    acc = acc + dot(v, v);
{% elif source.mode == "lp" %}
{% if source.p == 1 %}
    let a = abs(v);
    acc = acc + a.x + a.y + a.z + a.w;
{% else %}
    acc = acc + dot(v, v);
{% endif %}
{% endif %}
  }
{% else %}
  for (var i = tid; i < HIDDEN; i = i + WG) {
{% if packedBf16Embedding %}
    let v = embedding_scalar(source_row, i);
    embedding_out[base + i] = v;
{% else %}
    let v = f32(x[base + i]);
{% endif %}
{% if source.mode == "layer" or source.mode == "group" or source.mode == "instance" %}
    let d = v - shift;
    acc.x = acc.x + d;
    acc.y = acc.y + d * d;
{% elif source.mode == "rms" %}
    acc = acc + v * v;
{% elif source.mode == "lp" %}
{% if source.p == 1 %}
    acc = acc + abs(v);
{% else %}
    acc = acc + v * v;
{% endif %}
{% endif %}
  }
{% endif %}

{% if source.mode == "rms" or source.mode == "lp" %}
  let total = reduce_scalar(acc, tid{% if combineSubgroups %}, sg_lane, sg_size{% endif %});
{% else %}
  let totals = reduce_pair(acc, tid{% if combineSubgroups %}, sg_lane, sg_size{% endif %});
{% endif %}

{% if source.mode == "layer" %}
  let mean_d = totals.x / f32(HIDDEN);
  let variance = max(totals.y / f32(HIDDEN) - mean_d * mean_d, 0.0);
  let inv = inverseSqrt(variance + EPSILON);
  let row_mean = shift + mean_d;
{% if source.writeStats %}
  if (tid == 0u) {
    mean_out[row] = row_mean;
    inv_std_out[row] = inv;
  }
{% endif %}
{% elif source.mode == "group" %}
  let mean_d = totals.x / f32(HIDDEN);
  let variance = max(totals.y / f32(HIDDEN) - mean_d * mean_d, 0.0);
  let denom = sqrt(variance + EPSILON);
  let row_mean = shift + mean_d;
  let g_ch_base = (row % NUM_GROUPS) * CPG;
{% elif source.mode == "instance" %}
  let mean_d = totals.x / f32(HIDDEN);
  let variance = max(totals.y / f32(HIDDEN) - mean_d * mean_d, 0.0);
  let inv = inverseSqrt(variance + EPSILON);
  let row_mean = shift + mean_d;
  let c = row % CHANNELS;
  let ch_scale = f32(scale[c]);
  let ch_bias = f32(bias[c]);
{% elif source.mode == "rms" %}
  let inv = inverseSqrt(total / f32(HIDDEN) + EPSILON);
{% if source.writeStats %}
  if (tid == 0u) {
    inv_std_out[row] = inv;
  }
{% endif %}
{% elif source.mode == "lp" %}
{% if source.p == 2 %}
  let norm = sqrt(total);
{% else %}
  let norm = total;
{% endif %}
{% endif %}

{% if rmsChainNorm %}
  var acc2 = 0.0;
{% endif %}
{% if source.vec4 %}
  for (var i = tid; i < HIDDEN_V; i = i + WG) {
{% if packedBf16Embedding %}
    let idx = base + i;
    let v = embedding_vec4(source_row, i);
{% elif scalarIo %}
    let idx = base + i * 4u;
    let v = load_vec4(idx);
{% else %}
    let idx = base + i;
    let v = vec4<f32>(x[idx]);
{% endif %}
{% if source.mode == "layer" %}
    var value = (v - vec4<f32>(row_mean)) * inv * vec4<f32>(scale[i]);
{% if source.hasBias %}
    value = value + vec4<f32>(bias[i]);
{% endif %}
    y[idx] = {{ source.vecType }}(value);
{% elif source.mode == "group" %}
    let ch = g_ch_base + i / SPATIAL_V;
    let normed = (v - vec4<f32>(row_mean)) / vec4<f32>(denom);
    y[idx] = {{ source.vecType }}(normed * vec4<f32>(f32(scale[ch])) + vec4<f32>(f32(bias[ch])));
{% elif source.mode == "instance" %}
{% if scalarIo %}
    let value = (v - vec4<f32>(row_mean)) * inv * vec4<f32>(ch_scale) + vec4<f32>(ch_bias);
    y[idx] = value.x;
    y[idx + 1u] = value.y;
    y[idx + 2u] = value.z;
    y[idx + 3u] = value.w;
{% else %}
    y[idx] = {{ source.vecType }}((v - vec4<f32>(row_mean)) * inv * vec4<f32>(ch_scale) + vec4<f32>(ch_bias));
{% endif %}
{% elif source.mode == "rms" %}
{% if rmsScaleAfterCast %}
    y[idx] = {{ source.vecType }}(v * inv) * {{ source.vecType }}({{ rmsScaleVec }});
{% elif rmsChainNorm %}

    let hv = y[idx] + fma(v * inv, {{ rmsScaleVec }}, vec4<f32>(0.0));
    y[idx] = hv;
    acc2 = acc2 + dot(hv, hv);
{% elif rmsResidualAdd %}

    y[idx] = y[idx] + fma(v * inv, {{ rmsScaleVec }}, vec4<f32>(0.0));
{% else %}
    y[idx] = {{ source.vecType }}(v * inv * {{ rmsScaleVec }});
{% endif %}
{% elif source.mode == "lp" %}
    let normalized = select(v / vec4<f32>(norm), vec4<f32>(0.0), vec4<bool>(norm == 0.0));
    y[idx] = {{ source.vecType }}(normalized);
{% endif %}
  }
{% if rmsChainNorm %}

  workgroupBarrier();
  let total2 = reduce_scalar(acc2, tid{% if combineSubgroups %}, sg_lane, sg_size{% endif %});
  let inv2 = inverseSqrt(total2 / f32(HIDDEN) + EPSILON2);
  for (var i = tid; i < HIDDEN_V; i = i + WG) {
    let idx = base + i;
    let hv = vec4<f32>(y[idx]);
    normed2[idx] = {{ source.vecType }}(hv * inv2 * vec4<f32>(scale2[i]));
  }
{% endif %}
{% else %}
  for (var i = tid; i < HIDDEN; i = i + WG) {
    let idx = base + i;
{% if packedBf16Embedding %}
    let v = embedding_scalar(source_row, i);
{% else %}
    let v = f32(x[idx]);
{% endif %}
{% if source.mode == "layer" %}
    var value = (v - row_mean) * inv * f32(scale[i]);
{% if source.hasBias %}
    value = value + f32(bias[i]);
{% endif %}
    y[idx] = {{ source.scalar }}(value);
{% elif source.mode == "group" %}
    let ch = g_ch_base + i / SPATIAL;
    let normed = (v - row_mean) / denom;
    y[idx] = {{ source.scalar }}(normed * f32(scale[ch]) + f32(bias[ch]));
{% elif source.mode == "instance" %}
    y[idx] = {{ source.scalar }}((v - row_mean) * inv * ch_scale + ch_bias);
{% elif source.mode == "rms" %}
{% if rmsScaleAfterCast %}
    y[idx] = {{ source.scalar }}(v * inv) * {{ source.scalar }}({{ rmsScaleScalar }});
{% elif rmsResidualAdd %}
    y[idx] = y[idx] + fma(v * inv, {{ rmsScaleScalar }}, 0.0);
{% else %}
    y[idx] = {{ source.scalar }}(v * inv * {{ rmsScaleScalar }});
{% endif %}
{% elif source.mode == "lp" %}
    let normalized = select(v / norm, 0.0, norm == 0.0);
    y[idx] = {{ source.scalar }}(normalized);
{% endif %}
  }
{% endif %}
}
`],["ops/_shared/reduce-sum.wgsl.jinja",`{% include "ops/_shared/tree-fold-inplace.wgsl.jinja" %}
fn reduce_sum(value: f32, tid: u32) -> f32 {
  partial[tid] = value;
  workgroupBarrier();
{{ wgsl_tree_fold(["partial"], idx="tid", wg="WG", form="head") }}
{% if trailingBarrier %}
  let total = partial[0];
  workgroupBarrier();
  return total;
{% else %}
  return partial[0];
{% endif %}
}`],["ops/_shared/tree-fold-inplace.wgsl.jinja",`{% macro wgsl_tree_fold_stmt(a, op, idx, svar) %}
{%- if op == "max" -%}
{{ a }}[{{ idx }}] = max({{ a }}[{{ idx }}], {{ a }}[{{ idx }} + {{ svar }}]);
{%- else -%}
{{ a }}[{{ idx }}] = {{ a }}[{{ idx }}] + {{ a }}[{{ idx }} + {{ svar }}];
{%- endif -%}
{% endmacro %}
{% macro wgsl_tree_fold(arrays, op="add", idx="lid", wg="WORKGROUP_SIZE", svar="stride", typed=false, form="tail", breakInline=false, bodyInline=false, barrierFirst=false) %}
  var {{ svar }}{{ ": u32 " if typed else " " }}= {{ wg }} / 2u;
  loop {
{% if form == "head" %}
{% if breakInline %}
    if ({{ svar }} == 0u) { break; }
{% else %}
    if ({{ svar }} == 0u) {
      break;
    }
{% endif %}
{% endif %}
{% if bodyInline %}
    if ({{ idx }} < {{ svar }}) { {{ wgsl_tree_fold_stmt(arrays[0], op, idx, svar) }} }
{% else %}
    if ({{ idx }} < {{ svar }}) {
{% for a in arrays %}
      {{ wgsl_tree_fold_stmt(a, op, idx, svar) }}
{% endfor %}
    }
{% endif %}
{% if form == "head" %}
{% if barrierFirst %}
    workgroupBarrier();
    {{ svar }} = {{ svar }} / 2u;
{% else %}
    {{ svar }} = {{ svar }} / 2u;
    workgroupBarrier();
{% endif %}
{% else %}
    workgroupBarrier();
    if ({{ svar }} == 1u) {
      break;
    }
    {{ svar }} = {{ svar }} / 2u;
{% endif %}
  }
{%- endmacro %}`],["ops/_shared/attn-flash-prefill-cluster.wgsl.jinja",`{%- set sourceProfile = source.sourceProfile if source.sourceProfile is defined else 0 -%}
{%- set QSEQ = "params.seq_len" if sourceProfile == 1 else "params.qSeq" -%}
{%- set KVSEQ = "(params.past_len + params.seq_len)" if sourceProfile == 1 else "params.kvSeq" -%}
{%- set IS_CAUSAL = "1u" if sourceProfile == 1 else "params.isCausal" -%}
{%- set Q_STRIDE = "QKV_STRIDE_V4" if sourceProfile == 1 else "Q_HIDDEN_V4" -%}
{%- set QUERY = "qkv" if sourceProfile == 1 else "query" -%}
{%- set KEY = "cache_keys" if sourceProfile == 1 else "key" -%}
{%- set VALUE = "cache_values" if sourceProfile == 1 else "value" -%}
{%- set OUTPUT = "attn_out" if sourceProfile == 1 else "output" -%}
{%- set HAS_OUTPUT_GATE = source.outputGate if source.outputGate is defined else false -%}
{%- if sourceProfile == 1 -%}{%- set ATTN_SCALE_OVERRIDE = scaling -%}{%- endif -%}
{% if useSubgroups is not defined %}{% set useSubgroups = true %}{% endif %}
{% if batchNoSgReduction is not defined %}{% set batchNoSgReduction = false %}{% endif %}
{% if maskIsKeyKeep is not defined %}{% set maskIsKeyKeep = false %}{% endif %}
{% if hasSoftcap is not defined %}{% set hasSoftcap = false %}{% endif %}
{% if hasHeadSink is not defined %}{% set hasHeadSink = false %}{% endif %}
{% if quantCacheFormat is not defined %}{% set quantCacheFormat = "" %}{% endif %}
{% if useSeqlens is not defined %}{% set useSeqlens = false %}{% endif %}
{% set KVA = "kvActive" if useSeqlens else KVSEQ %}
{% macro score_expr(part) %}{% if hasSoftcap %}params.softcap * tanh(clamp(({{ part }} * SCALE) / params.softcap, -30.0, 30.0)){% else %}{{ part }} * SCALE{% endif %}{% endmacro %}
{% if useSubgroups %}
enable subgroups;
{% endif %}
{% if usesF16 %}
enable f16;
{% endif %}
{{ env.wgsl.resourceDeclarations }}
{% set ST = "f16" if usesF16 else "f32" %}
{% set FUSED_ROTARY = fusedRotary is defined and fusedRotary %}
{% set STAGE_MASK = hasMask and useSubgroups and stageMask is defined and stageMask %}
{% set SLICE_COUNT = ((headDimV4 / LPQ) | int) %}
{% set ROPE_LANE_XOR = ((LPQ / 2) | int) %}
{% set QL = source.qLayout if source.qLayout is defined else source.layout %}
{% set KL = source.kvLayout if source.kvLayout is defined else source.layout %}
{% set RIGHT = causalRightAlign is defined and causalRightAlign %}

const HEAD_DIM: u32 = {{ headDim }}u;
const HEAD_DIM_V4: u32 = {{ headDimV4 }}u;
{% if QL != "bhsd" %}
const Q_HIDDEN_V4: u32 = {{ qHiddenV4 }}u;
{% if sourceProfile == 1 %}const QKV_STRIDE_V4: u32 = {{ qkvStrideV4 }}u;
{% endif %}{% endif %}
{% if KL != "bhsd" %}
const KV_HIDDEN_V4: u32 = {{ kvHiddenV4 }}u;
{% endif %}
const Q_HEADS: u32 = {{ qNumHeads }}u;
const KV_HEADS: u32 = {{ kvNumHeads }}u;
const TILE_Q: u32 = {{ TILE_Q }}u;

const LPQ: u32 = {{ LPQ }}u;
const SLICE: u32 = HEAD_DIM / (4u * LPQ);
{% if FUSED_ROTARY %}
const HALF_DIM: u32 = HEAD_DIM / 2u;
const HALF_LPQ: u32 = LPQ / 2u;
{% endif %}
const TILE_K: u32 = {{ TILE_K }}u;
const WG: u32 = TILE_Q * LPQ;

const NEG_INF: f32 = -3.4028234663852886e38;
const MASK_NEG: f32 = -1e38;

var<workgroup> k_tile: array<vec4<{{ ST }}>, TILE_K * (HEAD_DIM / 4u)>;
var<workgroup> v_tile: array<vec4<{{ ST }}>, TILE_K * (HEAD_DIM / 4u)>;
{% if STAGE_MASK %}
{% if maskIsKeyKeep or maskIsBool %}
var<workgroup> mask_tile: array<u32, TILE_Q * TILE_K>;
{% else %}
var<workgroup> mask_tile: array<f32, TILE_Q * TILE_K>;
{% endif %}
{% endif %}
{% if not useSubgroups %}
{% if batchNoSgReduction %}

var<workgroup> red: array<f32, TILE_K * WG>;
{% else %}

var<workgroup> red: array<f32, WG>;
{% endif %}
{% endif %}

{% include "ops/_shared/attn-scale-value.wgsl.jinja" %}

{% if quantCacheFormat == "turbo" %}

const TQ_WORDS_PER_ROW: u32 = HEAD_DIM / 8u + 1u;
{% include "ops/_shared/turbo-quant.wgsl.jinja" %}
{% include "ops/_shared/hadamard-transform-tile.wgsl.jinja" %}
{% endif %}
{% if quantCacheFormat %}
{% include "ops/_shared/attn-quant-cache-load.wgsl.jinja" %}
{{ emit_quant_load4(quantCacheFormat, "key", KEY, "k_scale") }}
{{ emit_quant_load4(quantCacheFormat, "value", VALUE, "v_scale") }}
{% endif %}

{% if hasBias %}
{% include "ops/_shared/attn-load-bias4.wgsl.jinja" %}
{% endif %}

@compute @workgroup_size(WG, 1, 1)
fn main(
  @builtin(workgroup_id) wg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>{% if useSubgroups %},
  @builtin(subgroup_size) sgSize: u32{% endif %}
) {
  let h = wg.y;
  let b = wg.z;
  let tid = lid.x;
{% if useSubgroups %}

  if (sgSize < LPQ || sgSize % LPQ != 0u) { return; }
{% endif %}
  let qSub = tid / LPQ;
  let lane8 = tid % LPQ;
  let qIdx = wg.x * TILE_Q + qSub;
  let qValid = qIdx < {{ QSEQ }} && h < Q_HEADS;
  let hKv = h / (Q_HEADS / KV_HEADS);
  let SCALE = scale_value();

  let qClamped = min(qIdx, {{ QSEQ }} - 1u);
{% if QL == "bhsd" %}
  let qBase4 = ((b * Q_HEADS + h) * {{ QSEQ }} + qClamped) * HEAD_DIM_V4 + lane8 * SLICE;
{% else %}
  let qBase4 = (b * {{ QSEQ }} + qClamped) * {{ Q_STRIDE }} + h * HEAD_DIM_V4 + lane8 * SLICE;
{% endif %}
{% for c in range(SLICE_COUNT) %}
  var qr{{ c }} = vec4<f32>({{ QUERY }}[qBase4 + {{ c }}u]);
{% if hasBias %}
  qr{{ c }} = qr{{ c }} + load_bias4(h * HEAD_DIM, lane8 * SLICE + {{ c }}u);
{% endif %}
  var o{{ c }} = vec4<f32>(0.0);
{% endfor %}
{% if FUSED_ROTARY %}

  let qHeadBase4 = qBase4 - lane8 * SLICE;
  let pairedLane = (lane8 + HALF_LPQ) % LPQ;
  let ropeChunk = (lane8 % HALF_LPQ) * SLICE;
  let pastLenForRope = select(0u, {{ KVSEQ }} - {{ QSEQ }}, {{ KVSEQ }} >= {{ QSEQ }});
  let ropePosition = pastLenForRope + qClamped;
{% for c in range(SLICE_COUNT) %}
{% if useSubgroups %}
  let pairedQ{{ c }} = subgroupShuffleXor(qr{{ c }}, {{ ROPE_LANE_XOR }}u);
{% else %}
  let pairedQ{{ c }} = vec4<f32>({{ QUERY }}[qHeadBase4 + pairedLane * SLICE + {{ c }}u]);
{% endif %}
  let ropeBase{{ c }} = ropePosition * HALF_DIM + (ropeChunk + {{ c }}u) * 4u;
  let ropeCos{{ c }} = vec4<f32>(
    f32(cos_cache[ropeBase{{ c }}]),
    f32(cos_cache[ropeBase{{ c }} + 1u]),
    f32(cos_cache[ropeBase{{ c }} + 2u]),
    f32(cos_cache[ropeBase{{ c }} + 3u])
  );
  let ropeSin{{ c }} = vec4<f32>(
    f32(sin_cache[ropeBase{{ c }}]),
    f32(sin_cache[ropeBase{{ c }} + 1u]),
    f32(sin_cache[ropeBase{{ c }} + 2u]),
    f32(sin_cache[ropeBase{{ c }} + 3u])
  );
  qr{{ c }} = select(
    qr{{ c }} * ropeCos{{ c }} + pairedQ{{ c }} * ropeSin{{ c }},
    qr{{ c }} * ropeCos{{ c }} - pairedQ{{ c }} * ropeSin{{ c }},
    lane8 < HALF_LPQ
  );
{% endfor %}
{% endif %}
  var m: f32 = NEG_INF;
  var l: f32 = 0.0;

{% if useSeqlens %}

  let kvActive = min({{ KVSEQ }}, u32(seqlens_k[b]) + 1u);
{% endif %}

{% if hasCausal or hasWindow %}

{% if RIGHT or hasWindow %}
  let pastLen = select(0u, {{ KVA }} - {{ QSEQ }}, {{ KVA }} >= {{ QSEQ }});
{% endif %}
{% if hasCausal %}
{% if RIGHT %}
  var maxKjV = select({{ KVA }}, min(pastLen + qIdx + 1u, {{ KVA }}), {{ IS_CAUSAL }} != 0u);
{% else %}
  var maxKjV = select({{ KVA }}, min(qIdx + 1u, {{ KVA }}), {{ IS_CAUSAL }} != 0u);
{% endif %}
{% else %}
  var maxKjV = {{ KVA }};
{% endif %}
  var minKjV: u32 = 0u;
  let lastQ = min(wg.x * TILE_Q + TILE_Q - 1u, {{ QSEQ }} - 1u);
{% if hasCausal %}
{% if RIGHT %}
  var wgEndV = select({{ KVA }}, min(pastLen + lastQ + 1u, {{ KVA }}), {{ IS_CAUSAL }} != 0u);
{% else %}
  var wgEndV = select({{ KVA }}, min(lastQ + 1u, {{ KVA }}), {{ IS_CAUSAL }} != 0u);
{% endif %}
{% else %}
  var wgEndV = {{ KVA }};
{% endif %}
  var wgStartV: u32 = 0u;
{% if hasWindow %}
  let qAbsP1 = pastLen + qIdx + 1u;
  maxKjV = min(maxKjV, qAbsP1);
  if (qAbsP1 > params.windowSize) { minKjV = qAbsP1 - params.windowSize; }
  let lastQAbsP1 = pastLen + lastQ + 1u;
  wgEndV = min(wgEndV, lastQAbsP1);
  let firstQAbsP1 = pastLen + wg.x * TILE_Q + 1u;
  if (firstQAbsP1 > params.windowSize) { wgStartV = firstQAbsP1 - params.windowSize; }
{% endif %}
  let maxKj = maxKjV;
  let minKj = minKjV;
  let wgEnd = wgEndV;
  let wgStart = wgStartV;
{% else %}
  let maxKj = {{ KVA }};
  let minKj: u32 = 0u;
  let wgEnd = {{ KVA }};
  let wgStart: u32 = 0u;
{% endif %}
{% if quantCacheFormat == "int4" %}
  let kvRowStride4 = HEAD_DIM_V4 * 2u;
{% elif quantCacheFormat == "turbo" %}
  let kvRowStride4 = TQ_WORDS_PER_ROW;
{% else %}
  let kvRowStride4 = HEAD_DIM_V4;
{% endif %}
{% if KL == "bhsd" %}
  let kvBatch4 = (b * KV_HEADS + hKv) * {{ KVSEQ }} * kvRowStride4;
{% else %}
  let kvBatch4 = b * {{ KVSEQ }} * KV_HIDDEN_V4 + hKv * HEAD_DIM_V4;
{% endif %}

  var kStart: u32 = wgStart;
  loop {
    if (kStart >= wgEnd) { break; }

    workgroupBarrier();
    for (var i: u32 = tid; i < TILE_K * HEAD_DIM_V4; i = i + WG) {
      let slot = i / HEAD_DIM_V4;
      let d4 = i % HEAD_DIM_V4;
      let kj = kStart + slot;
      if (kj < wgEnd) {
{% if KL == "bhsd" %}
        let base4 = kvBatch4 + kj * kvRowStride4 + d4;
{% else %}
        let base4 = kvBatch4 + kj * KV_HIDDEN_V4 + d4;
{% endif %}
{% if quantCacheFormat %}
        k_tile[i] = vec4<{{ ST }}>(load_key4(base4, d4, hKv));
        v_tile[i] = vec4<{{ ST }}>(load_value4(base4, d4, hKv));
{% else %}
        k_tile[i] = vec4<{{ ST }}>({{ KEY }}[base4]);
        v_tile[i] = vec4<{{ ST }}>({{ VALUE }}[base4]);
{% endif %}
      } else {
        k_tile[i] = vec4<{{ ST }}>(0.0);
        v_tile[i] = vec4<{{ ST }}>(0.0);
      }
    }
{% if STAGE_MASK %}

    for (var i: u32 = tid; i < TILE_Q * TILE_K; i = i + WG) {
      let qSlot = i / TILE_K;
      let kSlot = i % TILE_K;
      let maskQ = min(wg.x * TILE_Q + qSlot, {{ QSEQ }} - 1u);
      let maskK = kStart + kSlot;
      if (maskK < wgEnd) {
        let maskIndex = b * params.maskBatchStride + h * params.maskHeadStride + maskQ * params.maskSeqStride + maskK;
{% if maskIsKeyKeep or maskIsBool %}
        mask_tile[i] = attn_mask[maskIndex];
{% else %}
        mask_tile[i] = f32(attn_mask[maskIndex]);
{% endif %}
      } else {
{% if maskIsKeyKeep or maskIsBool %}
        mask_tile[i] = 0u;
{% else %}
        mask_tile[i] = 0.0;
{% endif %}
      }
    }
{% endif %}
    workgroupBarrier();
{% if quantCacheFormat == "turbo" %}

{{ emit_wht_tile_pair_v4("k_tile", "v_tile", "TILE_K", headDimV4, "tid", "WG", ST) }}
{% endif %}

{% if not useSubgroups and batchNoSgReduction %}

    var s: array<f32, TILE_K>;
    for (var kk: u32 = 0u; kk < TILE_K; kk = kk + 1u) {
      s[kk] = NEG_INF;
      var part: f32 = 0.0;
      let kb = kk * HEAD_DIM_V4 + lane8 * SLICE;
{% for c in range(SLICE_COUNT) %}
      part = part + dot(qr{{ c }}, vec4<f32>(k_tile[kb + {{ c }}u]));
{% endfor %}
      red[kk * WG + tid] = part;
    }
    workgroupBarrier();

    let cbase = tid - lane8;
    for (var kk: u32 = lane8; kk < TILE_K; kk = kk + LPQ) {
{% for j in range(LPQ) %}
      let r{{ j }} = red[kk * WG + cbase + {{ j }}u];
{% endfor %}
{% if LPQ == 8 %}
      let part = ((r0 + r1) + (r2 + r3)) + ((r4 + r5) + (r6 + r7));
{% elif LPQ == 4 %}
      let part = (r0 + r1) + (r2 + r3);
{% elif LPQ == 2 %}
      let part = r0 + r1;
{% else %}
      var part = 0.0;
{% for j in range(LPQ) %}
      part = part + r{{ j }};
{% endfor %}
{% endif %}
      red[kk * WG + cbase] = part;
    }
    workgroupBarrier();

    for (var kk: u32 = 0u; kk < TILE_K; kk = kk + 1u) {
      let kj = kStart + kk;
      let part = red[kk * WG + tid - lane8];
      if (kj >= minKj && kj < maxKj) {
{% if hasMask %}
        let maskIndex = b * params.maskBatchStride + h * params.maskHeadStride + qClamped * params.maskSeqStride + kj;
{% if maskIsKeyKeep %}
        s[kk] = {{ score_expr("part") }} + (1.0 - f32(attn_mask[maskIndex])) * MASK_NEG;
{% elif maskIsBool %}
        if (attn_mask[maskIndex] != 0u) {
          s[kk] = {{ score_expr("part") }};
        } else {
          s[kk] = MASK_NEG;
        }
{% else %}
        s[kk] = {{ score_expr("part") }} + f32(attn_mask[maskIndex]);
{% endif %}
{% else %}
        s[kk] = {{ score_expr("part") }};
{% endif %}
      }
    }
{% else %}
    var s: array<f32, TILE_K>;
    for (var kk: u32 = 0u; kk < TILE_K; kk = kk + 1u) {
      let kj = kStart + kk;
      s[kk] = NEG_INF;
      var part: f32 = 0.0;
      let kb = kk * HEAD_DIM_V4 + lane8 * SLICE;
{% for c in range(SLICE_COUNT) %}
      part = part + dot(qr{{ c }}, vec4<f32>(k_tile[kb + {{ c }}u]));
{% endfor %}
{% if useSubgroups %}

      part = part + subgroupShuffleXor(part, 1u);
{% if LPQ >= 4 %}
      part = part + subgroupShuffleXor(part, 2u);
{% endif %}
{% if LPQ >= 8 %}
      part = part + subgroupShuffleXor(part, 4u);
{% endif %}
{% else %}
      red[tid] = part;
      workgroupBarrier();
      let cbase = tid - lane8;
      part = 0.0;
      for (var j: u32 = 0u; j < LPQ; j = j + 1u) {
        part = part + red[cbase + j];
      }
      workgroupBarrier();
{% endif %}
      if (kj >= minKj && kj < maxKj) {
{% if hasMask %}
{% if STAGE_MASK %}
        let maskValue = mask_tile[qSub * TILE_K + kk];
{% else %}

        let maskIndex = b * params.maskBatchStride + h * params.maskHeadStride + qClamped * params.maskSeqStride + kj;
{% endif %}
{% if maskIsKeyKeep %}

{% if STAGE_MASK %}
        s[kk] = {{ score_expr("part") }} + (1.0 - f32(maskValue)) * MASK_NEG;
{% else %}
        s[kk] = {{ score_expr("part") }} + (1.0 - f32(attn_mask[maskIndex])) * MASK_NEG;
{% endif %}
{% elif maskIsBool %}

{% if STAGE_MASK %}
        if (maskValue != 0u) {
{% else %}
        if (attn_mask[maskIndex] != 0u) {
{% endif %}
          s[kk] = {{ score_expr("part") }};
        } else {
          s[kk] = MASK_NEG;
        }
{% else %}
{% if STAGE_MASK %}
        s[kk] = {{ score_expr("part") }} + maskValue;
{% else %}
        s[kk] = {{ score_expr("part") }} + f32(attn_mask[maskIndex]);
{% endif %}
{% endif %}
{% else %}
        s[kk] = {{ score_expr("part") }};
{% endif %}
      }
    }
{% endif %}

    var tileMax: f32 = s[0];
    for (var kk: u32 = 1u; kk < TILE_K; kk = kk + 1u) {
      tileMax = max(tileMax, s[kk]);
    }
    let newMax = max(m, tileMax);
    let corr = select(exp(m - newMax), 0.0, m == NEG_INF);
    var pSum: f32 = 0.0;
    for (var kk: u32 = 0u; kk < TILE_K; kk = kk + 1u) {
      let pk = select(0.0, exp(s[kk] - newMax), s[kk] != NEG_INF);
      s[kk] = pk;
      pSum = pSum + pk;
    }
    l = l * corr + pSum;
    m = newMax;
{% for c in range(SLICE_COUNT) %}
    {
      var acc = o{{ c }} * corr;
      for (var kk: u32 = 0u; kk < TILE_K; kk = kk + 1u) {
        acc = acc + s[kk] * vec4<f32>(v_tile[kk * HEAD_DIM_V4 + lane8 * SLICE + {{ c }}u]);
      }
      o{{ c }} = acc;
    }
{% endfor %}

    kStart = kStart + TILE_K;
  }

  if (qValid) {
{% if QL == "bhsd" %}
    let outBase4 = ((b * Q_HEADS + h) * {{ QSEQ }} + qIdx) * HEAD_DIM_V4 + lane8 * SLICE;
{% else %}
    let outBase4 = (b * {{ QSEQ }} + qIdx) * Q_HIDDEN_V4 + h * HEAD_DIM_V4 + lane8 * SLICE;
{% endif %}
{% if hasHeadSink %}

    let sink = f32(head_sink[h]);
    let finalM = max(m, sink);
    let accScale = exp(m - finalM);
    let inv = accScale / (exp(sink - finalM) + l * accScale);
{% else %}

    let inv = select(0.0, 1.0 / l, l > 0.0);
{% endif %}
{% for c in range(SLICE_COUNT) %}
{% if HAS_OUTPUT_GATE %}
    {
{% if hasBias %}
      let attentionValue = o{{ c }} * inv + load_bias4(2u * {{ qHidden }}u + h * HEAD_DIM, lane8 * SLICE + {{ c }}u);
{% else %}
      let attentionValue = o{{ c }} * inv;
{% endif %}
      let rounded = vec4<f32>(vec4<{{ scalar }}>(attentionValue));
      let gateValue = vec4<f32>(1.0) / (vec4<f32>(1.0) + exp(-vec4<f32>(gate[outBase4 + {{ c }}u])));
      {{ OUTPUT }}[outBase4 + {{ c }}u] = vec4<{{ scalar }}>(rounded * gateValue);
    }
{% elif hasBias %}
    {{ OUTPUT }}[outBase4 + {{ c }}u] = vec4<{{ scalar }}>(o{{ c }} * inv + load_bias4(2u * {{ qHidden }}u + h * HEAD_DIM, lane8 * SLICE + {{ c }}u));
{% else %}
    {{ OUTPUT }}[outBase4 + {{ c }}u] = vec4<{{ scalar }}>(o{{ c }} * inv);
{% endif %}
{% endfor %}
  }
}
`],["ops/_shared/attn-load-bias4.wgsl.jinja",`fn load_bias4(base: u32, d4: u32) -> vec4<f32> {
  let offset = base + d4 * 4u;
  return vec4<f32>(bias[offset], bias[offset + 1u], bias[offset + 2u], bias[offset + 3u]);
}`],["ops/_shared/attn-quant-cache-load.wgsl.jinja",`{%- macro emit_quant_scale4(kind, scaleBuffer) %}
fn {{ kind }}scale4(d4: u32, hk: u32) -> vec4<f32> {
  if (params.perChannel == 0u) {
    return vec4<f32>({{ scaleBuffer }}[0]);
  }
  let base = hk * HEAD_DIM + d4 * 4u;
  return vec4<f32>(
    {{ scaleBuffer }}[base],
    {{ scaleBuffer }}[base + 1u],
    {{ scaleBuffer }}[base + 2u],
    {{ scaleBuffer }}[base + 3u]
  );
}
{%- endmacro %}

{%- macro emit_quant_load4(format, kind, buffer, scaleBuffer) %}
{% if format != "turbo" %}{{ emit_quant_scale4(kind, scaleBuffer) }}{% endif %}
fn load_{{ kind }}4(indexV4: u32, d4: u32, hk: u32) -> vec4<f32> {
{%- if format == "int8" %}
  return vec4<f32>({{ buffer }}[indexV4]) * {{ kind }}scale4(d4, hk);
{%- elif format == "int4" %}

  let rowBase = indexV4 - d4;
  let lo = {{ buffer }}[rowBase + d4 * 2u];
  let hi = {{ buffer }}[rowBase + d4 * 2u + 1u];
  let nibbles = vec4<i32>(
    i32(lo & 0xFu), i32((lo >> 4u) & 0xFu),
    i32(hi & 0xFu), i32((hi >> 4u) & 0xFu)
  );

  let signed = nibbles - 16 * vec4<i32>(nibbles >= vec4<i32>(8));
  return vec4<f32>(signed) * {{ kind }}scale4(d4, hk);
{%- else %}
  let rowBase = indexV4 - d4;
  let scale = tq_row_scale({{ buffer }}[rowBase], inverseSqrt(f32(HEAD_DIM)));
  let packed = {{ buffer }}[rowBase + 1u + (d4 >> 1u)];
  if ((d4 & 1u) == 0u) {
    return tq_dequant_low4(packed, scale);
  }
  return tq_dequant_high4(packed, scale);
{%- endif %}
}
{%- endmacro %}
`],["ops/_shared/attn-scale-value.wgsl.jinja",`{% if ATTN_SCALE_DIM is not defined %}{% set ATTN_SCALE_DIM = "HEAD_DIM" %}{% endif %}
fn scale_value() -> f32 {
{% if ATTN_SCALE_OVERRIDE is defined %}
  return {{ ATTN_SCALE_OVERRIDE }};
{% else %}
  if (params.scale != 0.0) { return params.scale; }
  return inverseSqrt(f32({{ ATTN_SCALE_DIM }}));
{% endif %}
}`],["ops/_shared/hadamard-transform-row.wgsl.jinja",`{%- macro emit_wht_private(arr, size) %}
  {
    for (var wht_span = 1u; wht_span < {{ size }}u; wht_span = wht_span * 2u) {
      for (var wht_base = 0u; wht_base < {{ size }}u; wht_base = wht_base + wht_span * 2u) {
        for (var wht_off = 0u; wht_off < wht_span; wht_off = wht_off + 1u) {
          let wht_lo = wht_base + wht_off;
          let wht_hi = wht_lo + wht_span;
          let wht_a = {{ arr }}[wht_lo];
          let wht_b = {{ arr }}[wht_hi];
          {{ arr }}[wht_lo] = wht_a + wht_b;
          {{ arr }}[wht_hi] = wht_a - wht_b;
        }
      }
    }
    let wht_norm = inverseSqrt(f32({{ size }}u));
    for (var wht_i = 0u; wht_i < {{ size }}u; wht_i = wht_i + 1u) {
      {{ arr }}[wht_i] = {{ arr }}[wht_i] * wht_norm;
    }
  }
{%- endmacro %}

{%- macro emit_wht_shared(buf, size, tid, wg) %}
  {
    for (var wht_span = 1u; wht_span < {{ size }}u; wht_span = wht_span * 2u) {
      for (var wht_i = {{ tid }}; wht_i < {{ (size / 2) | int }}u; wht_i = wht_i + {{ wg }}) {
        let wht_lo = (wht_i / wht_span) * wht_span * 2u + (wht_i % wht_span);
        let wht_hi = wht_lo + wht_span;
        let wht_a = {{ buf }}[wht_lo];
        let wht_b = {{ buf }}[wht_hi];
        {{ buf }}[wht_lo] = wht_a + wht_b;
        {{ buf }}[wht_hi] = wht_a - wht_b;
      }
      workgroupBarrier();
    }
    let wht_norm = inverseSqrt(f32({{ size }}u));
    for (var wht_i = {{ tid }}; wht_i < {{ size }}u; wht_i = wht_i + {{ wg }}) {
      {{ buf }}[wht_i] = {{ buf }}[wht_i] * wht_norm;
    }
    workgroupBarrier();
  }
{%- endmacro %}

{%- macro emit_wht_shared_v4(buf, sizeV4, tid, wg) %}
  {
    for (var wht_i = {{ tid }}; wht_i < {{ sizeV4 }}u; wht_i = wht_i + {{ wg }}) {
      let wht_v = {{ buf }}[wht_i];
      let wht_s1 = vec4<f32>(wht_v.x + wht_v.y, wht_v.x - wht_v.y, wht_v.z + wht_v.w, wht_v.z - wht_v.w);
      {{ buf }}[wht_i] = vec4<f32>(wht_s1.x + wht_s1.z, wht_s1.y + wht_s1.w, wht_s1.x - wht_s1.z, wht_s1.y - wht_s1.w);
    }
    workgroupBarrier();
    for (var wht_span = 1u; wht_span < {{ sizeV4 }}u; wht_span = wht_span * 2u) {
      for (var wht_i = {{ tid }}; wht_i < {{ (sizeV4 / 2) | int }}u; wht_i = wht_i + {{ wg }}) {
        let wht_lo = (wht_i / wht_span) * wht_span * 2u + (wht_i % wht_span);
        let wht_hi = wht_lo + wht_span;
        let wht_a = {{ buf }}[wht_lo];
        let wht_b = {{ buf }}[wht_hi];
        {{ buf }}[wht_lo] = wht_a + wht_b;
        {{ buf }}[wht_hi] = wht_a - wht_b;
      }
      workgroupBarrier();
    }
    let wht_norm = inverseSqrt(f32({{ sizeV4 * 4 }}u));
    for (var wht_i = {{ tid }}; wht_i < {{ sizeV4 }}u; wht_i = wht_i + {{ wg }}) {
      {{ buf }}[wht_i] = {{ buf }}[wht_i] * wht_norm;
    }
    workgroupBarrier();
  }
{%- endmacro %}
`],["ops/_shared/hadamard-transform-tile.wgsl.jinja",`{%- macro emit_wht_tile_pair_v4(bufA, bufB, rows, sizeV4, tid, wg, scalar) %}
{%- set halfV4 = (sizeV4 / 2) | int %}
  {

    for (var wht_i = {{ tid }}; wht_i < {{ rows }} * {{ sizeV4 }}u; wht_i = wht_i + {{ wg }}) {
      let wht_a = vec4<f32>({{ bufA }}[wht_i]);
      let wht_a1 = vec4<f32>(wht_a.x + wht_a.y, wht_a.x - wht_a.y, wht_a.z + wht_a.w, wht_a.z - wht_a.w);
      {{ bufA }}[wht_i] = vec4<{{ scalar }}>(wht_a1.x + wht_a1.z, wht_a1.y + wht_a1.w, wht_a1.x - wht_a1.z, wht_a1.y - wht_a1.w);
      let wht_b = vec4<f32>({{ bufB }}[wht_i]);
      let wht_b1 = vec4<f32>(wht_b.x + wht_b.y, wht_b.x - wht_b.y, wht_b.z + wht_b.w, wht_b.z - wht_b.w);
      {{ bufB }}[wht_i] = vec4<{{ scalar }}>(wht_b1.x + wht_b1.z, wht_b1.y + wht_b1.w, wht_b1.x - wht_b1.z, wht_b1.y - wht_b1.w);
    }
    workgroupBarrier();

    for (var wht_step = 1u; wht_step < {{ sizeV4 }}u; wht_step = wht_step << 1u) {
      for (var wht_i = {{ tid }}; wht_i < {{ rows }} * {{ halfV4 }}u; wht_i = wht_i + {{ wg }}) {
        let wht_row = wht_i / {{ halfV4 }}u;
        let wht_j = wht_i % {{ halfV4 }}u;

        let wht_pos = wht_j & (wht_step - 1u);
        let wht_lo = wht_row * {{ sizeV4 }}u + ((wht_j - wht_pos) << 1u) + wht_pos;
        let wht_hi = wht_lo + wht_step;
        let wht_la = vec4<f32>({{ bufA }}[wht_lo]);
        let wht_ha = vec4<f32>({{ bufA }}[wht_hi]);
        {{ bufA }}[wht_lo] = vec4<{{ scalar }}>(wht_la + wht_ha);
        {{ bufA }}[wht_hi] = vec4<{{ scalar }}>(wht_la - wht_ha);
        let wht_lb = vec4<f32>({{ bufB }}[wht_lo]);
        let wht_hb = vec4<f32>({{ bufB }}[wht_hi]);
        {{ bufB }}[wht_lo] = vec4<{{ scalar }}>(wht_lb + wht_hb);
        {{ bufB }}[wht_hi] = vec4<{{ scalar }}>(wht_lb - wht_hb);
      }
      workgroupBarrier();
    }
    let wht_norm = inverseSqrt(f32({{ sizeV4 * 4 }}u));
    for (var wht_i = {{ tid }}; wht_i < {{ rows }} * {{ sizeV4 }}u; wht_i = wht_i + {{ wg }}) {
      {{ bufA }}[wht_i] = vec4<{{ scalar }}>(vec4<f32>({{ bufA }}[wht_i]) * wht_norm);
      {{ bufB }}[wht_i] = vec4<{{ scalar }}>(vec4<f32>({{ bufB }}[wht_i]) * wht_norm);
    }
    workgroupBarrier();
  }
{%- endmacro %}
`],["ops/_shared/turbo-quant.wgsl.jinja",`const TQ_CENTROIDS: array<f32, 16> = array<f32, 16>(
  -2.733167, -2.069673, -1.618733, -1.256888, -0.942924, -0.657246, -0.388391, -0.128522,
   0.128522,  0.388391,  0.657246,  0.942924,  1.256888,  1.618733,  2.069673,  2.733167);

const TQ_BOUNDS: array<f32, 15> = array<f32, 15>(
  (TQ_CENTROIDS[0] + TQ_CENTROIDS[1]) * 0.5, (TQ_CENTROIDS[1] + TQ_CENTROIDS[2]) * 0.5,
  (TQ_CENTROIDS[2] + TQ_CENTROIDS[3]) * 0.5, (TQ_CENTROIDS[3] + TQ_CENTROIDS[4]) * 0.5,
  (TQ_CENTROIDS[4] + TQ_CENTROIDS[5]) * 0.5, (TQ_CENTROIDS[5] + TQ_CENTROIDS[6]) * 0.5,
  (TQ_CENTROIDS[6] + TQ_CENTROIDS[7]) * 0.5, (TQ_CENTROIDS[7] + TQ_CENTROIDS[8]) * 0.5,
  (TQ_CENTROIDS[8] + TQ_CENTROIDS[9]) * 0.5, (TQ_CENTROIDS[9] + TQ_CENTROIDS[10]) * 0.5,
  (TQ_CENTROIDS[10] + TQ_CENTROIDS[11]) * 0.5, (TQ_CENTROIDS[11] + TQ_CENTROIDS[12]) * 0.5,
  (TQ_CENTROIDS[12] + TQ_CENTROIDS[13]) * 0.5, (TQ_CENTROIDS[13] + TQ_CENTROIDS[14]) * 0.5,
  (TQ_CENTROIDS[14] + TQ_CENTROIDS[15]) * 0.5);

fn tq_snap(x: f32) -> u32 {
  var index = 0u;
  index = index + select(0u, 8u, x > TQ_BOUNDS[7]);
  index = index + select(0u, 4u, x > TQ_BOUNDS[index + 3u]);
  index = index + select(0u, 2u, x > TQ_BOUNDS[index + 1u]);
  index = index + select(0u, 1u, x > TQ_BOUNDS[index]);
  return index;
}

fn tq_row_scale(norm_bits: u32, inv_sqrt_head: f32) -> f32 {
  return bitcast<f32>(norm_bits) * inv_sqrt_head;
}

fn tq_dequant_low4(packed: u32, scale: f32) -> vec4<f32> {
  return vec4<f32>(
    TQ_CENTROIDS[packed & 15u],
    TQ_CENTROIDS[(packed >> 4u) & 15u],
    TQ_CENTROIDS[(packed >> 8u) & 15u],
    TQ_CENTROIDS[(packed >> 12u) & 15u]) * scale;
}

fn tq_dequant_high4(packed: u32, scale: f32) -> vec4<f32> {
  return vec4<f32>(
    TQ_CENTROIDS[(packed >> 16u) & 15u],
    TQ_CENTROIDS[(packed >> 20u) & 15u],
    TQ_CENTROIDS[(packed >> 24u) & 15u],
    TQ_CENTROIDS[(packed >> 28u) & 15u]) * scale;
}
`],["ops/_shared/prefill-quant-subgroup-stage-a.wgsl.jinja",`{%- if smallM is defined and smallM %}

    var av0 = vec4<f32>(0.0);
    if (m0 + am < params.m) {
      av0 = vec4<f32>(a[(m0 + am) * K_V4 + kb * 8u + aq]);
    }
    let abase = am * TILE_K + aq * 4u;
    tile_A[abase] = f16(av0.x);
    tile_A[abase + 1u] = f16(av0.y);
    tile_A[abase + 2u] = f16(av0.z);
    tile_A[abase + 3u] = f16(av0.w);
{%- else %}

    var av0 = vec4<f32>(0.0);
    var av1 = vec4<f32>(0.0);
    if (m0 + am < params.m) {
      av0 = vec4<f32>(a[(m0 + am) * K_V4 + kb * 8u + aq]);
      av1 = vec4<f32>(a[(m0 + am) * K_V4 + kb * 8u + aq + 1u]);
    }
    let abase = am * TILE_K + aq * 4u;
    tile_A[abase] = f16(av0.x);
    tile_A[abase + 1u] = f16(av0.y);
    tile_A[abase + 2u] = f16(av0.z);
    tile_A[abase + 3u] = f16(av0.w);
    tile_A[abase + 4u] = f16(av1.x);
    tile_A[abase + 5u] = f16(av1.y);
    tile_A[abase + 6u] = f16(av1.z);
    tile_A[abase + 7u] = f16(av1.w);
{%- endif %}
`],["ops/_shared/prefill-subgroup-matmul-epilogue.wgsl.jinja",`    for (var step = 0u; step < TILE_K; step = step + 8u) {
      let matA0 = subgroupMatrixLoad<subgroup_matrix_left<f16, 8, 8>>(&tile_A, (base_A + 0u) * TILE_K + step, false, TILE_K);
      let matA1 = subgroupMatrixLoad<subgroup_matrix_left<f16, 8, 8>>(&tile_A, (base_A + 8u) * TILE_K + step, false, TILE_K);
      let boff = base_B * TILE_K + step;
      let matB0 = subgroupMatrixLoad<subgroup_matrix_right<f16, 8, 8>>(&tile_B, boff, true, TILE_K);
      let matB1 = subgroupMatrixLoad<subgroup_matrix_right<f16, 8, 8>>(&tile_B, boff + 8u * TILE_K, true, TILE_K);
      let matB2 = subgroupMatrixLoad<subgroup_matrix_right<f16, 8, 8>>(&tile_B, boff + 16u * TILE_K, true, TILE_K);
      let matB3 = subgroupMatrixLoad<subgroup_matrix_right<f16, 8, 8>>(&tile_B, boff + 24u * TILE_K, true, TILE_K);
      matC00 = subgroupMatrixMultiplyAccumulate(matA0, matB0, matC00);
      matC01 = subgroupMatrixMultiplyAccumulate(matA0, matB1, matC01);
      matC02 = subgroupMatrixMultiplyAccumulate(matA0, matB2, matC02);
      matC03 = subgroupMatrixMultiplyAccumulate(matA0, matB3, matC03);
      matC10 = subgroupMatrixMultiplyAccumulate(matA1, matB0, matC10);
      matC11 = subgroupMatrixMultiplyAccumulate(matA1, matB1, matC11);
      matC12 = subgroupMatrixMultiplyAccumulate(matA1, matB2, matC12);
      matC13 = subgroupMatrixMultiplyAccumulate(matA1, matB3, matC13);
    }
    workgroupBarrier();
  }

  let bank = subtile_id * 8u;
  subgroupMatrixStore(&scratch[bank + 0u], 0u, matC00, false, 8u);
  subgroupMatrixStore(&scratch[bank + 1u], 0u, matC01, false, 8u);
  subgroupMatrixStore(&scratch[bank + 2u], 0u, matC02, false, 8u);
  subgroupMatrixStore(&scratch[bank + 3u], 0u, matC03, false, 8u);
  subgroupMatrixStore(&scratch[bank + 4u], 0u, matC10, false, 8u);
  subgroupMatrixStore(&scratch[bank + 5u], 0u, matC11, false, 8u);
  subgroupMatrixStore(&scratch[bank + 6u], 0u, matC12, false, 8u);
  subgroupMatrixStore(&scratch[bank + 7u], 0u, matC13, false, 8u);
  workgroupBarrier();

  for (var i = local_idx; i < TILE_ROWS * TILE_COLS; i = i + 128u) {
    let r = i / TILE_COLS;
    let c = i % TILE_COLS;
    if (m0 + r < params.m{% if smallM is defined and smallM %} && n0 + c < {{ outFeatures }}u{% endif %}) {
{%- if smallM is defined and smallM %}

      let b = (c / 32u) * 8u + ((r % 16u) / 8u) * 4u + ((c % 32u) / 8u);
{%- else %}

      let b = (c / 32u) * 16u + (r / 16u) * 8u + ((r % 16u) / 8u) * 4u + ((c % 32u) / 8u);
{%- endif %}
      let e = (r % 8u) * 8u + (c % 8u);
{%- if sgSplitK is defined and sgSplitK %}
      partials[(wid.z * params.m + (m0 + r)) * N_OUT + n0 + c] = scratch[b][e];
{%- else %}
      y[(m0 + r) * OUT_STRIDE + DST_COL + n0 + c] = {{ yScalar }}(scratch[b][e]);
{%- endif %}
    }
  }
}`],["ops/_shared/projection-multirow-reduce.wgsl.jinja",`{%- if useSubgroups %}
{%- for r in range(regRows) %}
  let total{{ r }} = sg_sum(acc{{ r }});
{%- endfor %}
{%- else %}
{%- for r in range(regRows) %}
  partials4[lid] = acc{{ r }};
  workgroupBarrier();
  var stride{{ r }} = 16u;
  loop {
    if (stride{{ r }} == 0u) { break; }
    if (lane < stride{{ r }}) { partials4[lid] = partials4[lid] + partials4[lid + stride{{ r }}]; }
    workgroupBarrier();
    stride{{ r }} = stride{{ r }} / 2u;
  }
  let total{{ r }} = partials4[cluster * 32u];
  workgroupBarrier();
{%- endfor %}
{%- endif %}
`],["ops/_shared/q4-decode-row-block-accumulate.wgsl.jinja",`{%- if hasMin or (q4knCompact is defined and q4knCompact) or (q4kn is defined and q4kn) or (q5k is defined and q5k) %}
    let sa = dot(x0 + x1 + x2 + x3 + x4 + x5 + x6 + x7, vec4<f32>(1.0));
{%- endif %}
{%- if q2k is defined and q2k %}
    let xsLo = dot(x0 + x1 + x2 + x3, vec4<f32>(1.0));
    let xsHi = dot(x4 + x5 + x6 + x7, vec4<f32>(1.0));
{%- endif %}
{%- for r in range(regRows) %}
    let blk{{ r }} = base0 + b + {{ r }}u * BPR;
{%- if q4knCompact is defined and q4knCompact %}

    let sb{{ r }} = blk{{ r }} >> 3u;
    let j{{ r }} = blk{{ r }} & 7u;
    let smBase{{ r }} = sb{{ r }} * 5u;
    let dm{{ r }} = unpack2x16float(q4_metadata[smBase{{ r }}]);
    let smCarrier{{ r }} = q4_metadata[smBase{{ r }} + 1u + (j{{ r }} >> 1u)];
    let smPair{{ r }} = smCarrier{{ r }} >> ((j{{ r }} & 1u) * 12u);
    let sc{{ r }} = smPair{{ r }} & 63u;
    let mn{{ r }} = (smPair{{ r }} >> 6u) & 63u;
    let dl{{ r }} = dm{{ r }}.x * f32(sc{{ r }});
    let ml{{ r }} = dm{{ r }}.y * f32(mn{{ r }});
    let bias{{ r }} = 8.0 * dl{{ r }} - ml{{ r }};
    let words{{ r }} = q4_bits[blk{{ r }}];
    acc{{ r }} = acc{{ r }} + dl{{ r }} * (
      q4wp(words{{ r }}.x, x0, x4) + q4wp(words{{ r }}.y, x1, x5) + q4wp(words{{ r }}.z, x2, x6) + q4wp(words{{ r }}.w, x3, x7)) + bias{{ r }} * sa;
{%- elif q4kn is defined and q4kn %}

    let sb{{ r }} = blk{{ r }} >> 3u;
    let j{{ r }} = blk{{ r }} & 7u;
    let smBase{{ r }} = sb{{ r }} * 6u;
    let smCarrier{{ r }} = u32(q4_scales[smBase{{ r }} + 2u + (j{{ r }} >> 1u)]);
    let smPair{{ r }} = smCarrier{{ r }} >> ((j{{ r }} & 1u) * 12u);
    let sc{{ r }} = smPair{{ r }} & 63u;
    let mn{{ r }} = (smPair{{ r }} >> 6u) & 63u;
    let dl{{ r }} = f32(q4_scales[smBase{{ r }}]) * f32(sc{{ r }});
    let ml{{ r }} = f32(q4_scales[smBase{{ r }} + 1u]) * f32(mn{{ r }});
    let bias{{ r }} = 8.0 * dl{{ r }} - ml{{ r }};
    let words{{ r }} = q4_bits[blk{{ r }}];
    acc{{ r }} = acc{{ r }} + dl{{ r }} * (
      q4wp(words{{ r }}.x, x0, x4) + q4wp(words{{ r }}.y, x1, x5) + q4wp(words{{ r }}.z, x2, x6) + q4wp(words{{ r }}.w, x3, x7)) + bias{{ r }} * sa;
{%- elif hasMin %}
{%- if scalesPk2 is defined and scalesPk2 %}
    let sb{{ r }} = unpack2x16float(q4_scales[blk{{ r }}]);
    let scale{{ r }} = sb{{ r }}.x;
    let bias{{ r }} = sb{{ r }}.y;
{%- else %}
    let scale{{ r }} = f32(q4_scales[blk{{ r }} * 2u]);
    let bias{{ r }} = f32(q4_scales[blk{{ r }} * 2u + 1u]);
{%- endif %}
    let words{{ r }} = q4_bits[blk{{ r }}];
    acc{{ r }} = acc{{ r }} + scale{{ r }} * (
      q4wp(words{{ r }}.x, x0, x4) + q4wp(words{{ r }}.y, x1, x5) + q4wp(words{{ r }}.z, x2, x6) + q4wp(words{{ r }}.w, x3, x7)) + bias{{ r }} * sa;
{%- elif q2k is defined and q2k %}

    let sb{{ r }} = blk{{ r }} >> 3u; let j{{ r }} = blk{{ r }} & 7u; let g{{ r }} = sb{{ r }} * 5u;
    let cv{{ r }} = q4_bits[g{{ r }} + (j{{ r }} >> 1u)];
    let cLo{{ r }} = cv{{ r }}[(j{{ r }} & 1u) * 2u];
    let cHi{{ r }} = cv{{ r }}[(j{{ r }} & 1u) * 2u + 1u];
    let sw{{ r }} = q4_bits[g{{ r }} + 4u][j{{ r }} >> 1u];
    let bLo{{ r }} = (sw{{ r }} >> ((j{{ r }} & 1u) * 16u)) & 0xFFu;
    let bHi{{ r }} = (sw{{ r }} >> ((j{{ r }} & 1u) * 16u + 8u)) & 0xFFu;
    let d{{ r }} = f32(q4_scales[sb{{ r }} * 2u]);
    let dm{{ r }} = f32(q4_scales[sb{{ r }} * 2u + 1u]);
    acc{{ r }} = acc{{ r }}
      + (d{{ r }} * f32(bLo{{ r }} & 15u)) * (dot(x0, q2w(cLo{{ r }}, 0u)) + dot(x1, q2w(cLo{{ r }}, 1u)) + dot(x2, q2w(cLo{{ r }}, 2u)) + dot(x3, q2w(cLo{{ r }}, 3u)))
      - (dm{{ r }} * f32(bLo{{ r }} >> 4u)) * xsLo
      + (d{{ r }} * f32(bHi{{ r }} & 15u)) * (dot(x4, q2w(cHi{{ r }}, 0u)) + dot(x5, q2w(cHi{{ r }}, 1u)) + dot(x6, q2w(cHi{{ r }}, 2u)) + dot(x7, q2w(cHi{{ r }}, 3u)))
      - (dm{{ r }} * f32(bHi{{ r }} >> 4u)) * xsHi;
{%- elif q3k is defined and q3k %}

    let sb{{ r }} = blk{{ r }} >> 3u; let j{{ r }} = blk{{ r }} & 7u; let g{{ r }} = sb{{ r }} * 7u;
    let cv{{ r }} = q4_bits[g{{ r }} + (j{{ r }} >> 1u)];
    let cLo{{ r }} = cv{{ r }}[(j{{ r }} & 1u) * 2u];
    let cHi{{ r }} = cv{{ r }}[(j{{ r }} & 1u) * 2u + 1u];
    let hw{{ r }} = q4_bits[g{{ r }} + 4u + (j{{ r }} >> 2u)][j{{ r }} & 3u];
    let s8{{ r }} = unpack4xI8(q4_bits[g{{ r }} + 6u][j{{ r }} >> 1u]);
    let d{{ r }} = f32(q4_scales[sb{{ r }}]);
    let scLo{{ r }} = d{{ r }} * f32(s8{{ r }}[(j{{ r }} & 1u) * 2u]);
    let scHi{{ r }} = d{{ r }} * f32(s8{{ r }}[(j{{ r }} & 1u) * 2u + 1u]);
    acc{{ r }} = acc{{ r }}
      + scLo{{ r }} * (dot(x0, q3w_lo(cLo{{ r }}, hw{{ r }}, 0u)) + dot(x1, q3w_lo(cLo{{ r }}, hw{{ r }}, 1u)) + dot(x2, q3w_lo(cLo{{ r }}, hw{{ r }}, 2u)) + dot(x3, q3w_lo(cLo{{ r }}, hw{{ r }}, 3u)))
      + scHi{{ r }} * (dot(x4, q3w_hi(cHi{{ r }}, hw{{ r }}, 0u)) + dot(x5, q3w_hi(cHi{{ r }}, hw{{ r }}, 1u)) + dot(x6, q3w_hi(cHi{{ r }}, hw{{ r }}, 2u)) + dot(x7, q3w_hi(cHi{{ r }}, hw{{ r }}, 3u)));
{%- elif q6k is defined and q6k %}
    let sb{{ r }} = blk{{ r }} >> 3u; let j{{ r }} = blk{{ r }} & 7u; let g{{ r }} = sb{{ r }} * 13u;
    let words{{ r }} = q4_bits[g{{ r }} + j{{ r }}];
    let hv{{ r }} = q4_bits[g{{ r }} + 8u + (j{{ r }} >> 1u)];
    let hLo{{ r }} = hv{{ r }}[(j{{ r }} & 1u) * 2u];
    let hHi{{ r }} = hv{{ r }}[(j{{ r }} & 1u) * 2u + 1u];
    let s8{{ r }} = unpack4xI8(q4_bits[g{{ r }} + 12u][j{{ r }} >> 1u]);
    let d{{ r }} = f32(q4_scales[sb{{ r }}]);
    let scLo{{ r }} = d{{ r }} * f32(s8{{ r }}[(j{{ r }} & 1u) * 2u]);
    let scHi{{ r }} = d{{ r }} * f32(s8{{ r }}[(j{{ r }} & 1u) * 2u + 1u]);
    acc{{ r }} = acc{{ r }}
      + scLo{{ r }} * (dot(x0, q6_lo(words{{ r }}.x, hLo{{ r }}, 0u)) + dot(x1, q6_lo(words{{ r }}.y, hLo{{ r }}, 1u)) + dot(x2, q6_lo(words{{ r }}.z, hLo{{ r }}, 2u)) + dot(x3, q6_lo(words{{ r }}.w, hLo{{ r }}, 3u)))
      + scHi{{ r }} * (dot(x4, q6_hi(words{{ r }}.x, hHi{{ r }}, 0u)) + dot(x5, q6_hi(words{{ r }}.y, hHi{{ r }}, 1u)) + dot(x6, q6_hi(words{{ r }}.z, hHi{{ r }}, 2u)) + dot(x7, q6_hi(words{{ r }}.w, hHi{{ r }}, 3u)));
{%- elif q5k is defined and q5k %}

    let sb{{ r }} = blk{{ r }} >> 3u; let j{{ r }} = blk{{ r }} & 7u; let g{{ r }} = sb{{ r }} * 11u;
    let words{{ r }} = q4_bits[g{{ r }} + j{{ r }}];
    let qh{{ r }} = q4_bits[g{{ r }} + 8u + (j{{ r }} >> 2u)][j{{ r }} & 3u];
    let smv{{ r }} = q4_bits[g{{ r }} + 10u];
    let sc{{ r }} = f32((smv{{ r }}[j{{ r }} >> 2u] >> ((j{{ r }} & 3u) * 8u)) & 0xFFu);
    let mn{{ r }} = f32((smv{{ r }}[2u + (j{{ r }} >> 2u)] >> ((j{{ r }} & 3u) * 8u)) & 0xFFu);
    let scEff{{ r }} = f32(q4_scales[sb{{ r }} * 2u]) * sc{{ r }};
    let mEff{{ r }} = f32(q4_scales[sb{{ r }} * 2u + 1u]) * mn{{ r }};
    acc{{ r }} = acc{{ r }} - mEff{{ r }} * sa
      + scEff{{ r }} * (dot(x0, q5k_lo(words{{ r }}.x, qh{{ r }} & 15u)) + dot(x1, q5k_lo(words{{ r }}.y, (qh{{ r }} >> 4u) & 15u)) + dot(x2, q5k_lo(words{{ r }}.z, (qh{{ r }} >> 8u) & 15u)) + dot(x3, q5k_lo(words{{ r }}.w, (qh{{ r }} >> 12u) & 15u))
      + dot(x4, q5k_hi(words{{ r }}.x, (qh{{ r }} >> 16u) & 15u)) + dot(x5, q5k_hi(words{{ r }}.y, (qh{{ r }} >> 20u) & 15u)) + dot(x6, q5k_hi(words{{ r }}.z, (qh{{ r }} >> 24u) & 15u)) + dot(x7, q5k_hi(words{{ r }}.w, (qh{{ r }} >> 28u) & 15u)));
{%- elif quantBits == 8 and iq %}
    let sLo{{ r }} = f32(q4_scales[blk{{ r }} * 2u]);
    let sHi{{ r }} = f32(q4_scales[blk{{ r }} * 2u + 1u]);
    let wa{{ r }} = q4_bits[blk{{ r }} * 2u];
    let wb{{ r }} = q4_bits[blk{{ r }} * 2u + 1u];
    acc{{ r }} = acc{{ r }}
      + sLo{{ r }} * (q8dot(wa{{ r }}.x, x0) + q8dot(wa{{ r }}.y, x1) + q8dot(wa{{ r }}.z, x2) + q8dot(wa{{ r }}.w, x3))
      + sHi{{ r }} * (q8dot(wb{{ r }}.x, x4) + q8dot(wb{{ r }}.y, x5) + q8dot(wb{{ r }}.z, x6) + q8dot(wb{{ r }}.w, x7));
{%- elif lut16 %}
    let sLo{{ r }} = f32(q4_scales[blk{{ r }} * 2u]);
    let sHi{{ r }} = f32(q4_scales[blk{{ r }} * 2u + 1u]);
    let words{{ r }} = q4_bits[blk{{ r }}];
    acc{{ r }} = acc{{ r }}
      + sLo{{ r }} * (dot(x0, q4_lo(words{{ r }}.x)) + dot(x1, q4_lo(words{{ r }}.y)) + dot(x2, q4_lo(words{{ r }}.z)) + dot(x3, q4_lo(words{{ r }}.w)))
      + sHi{{ r }} * (dot(x4, q4_hi(words{{ r }}.x)) + dot(x5, q4_hi(words{{ r }}.y)) + dot(x6, q4_hi(words{{ r }}.z)) + dot(x7, q4_hi(words{{ r }}.w)));
{%- elif quantBits == 8 %}
    let scale{{ r }} = f32(q4_scales[blk{{ r }}]);
    let wa{{ r }} = q4_bits[blk{{ r }} * 2u];
    let wb{{ r }} = q4_bits[blk{{ r }} * 2u + 1u];
    acc{{ r }} = acc{{ r }} + scale{{ r }} * (
      q8dot(wa{{ r }}.x, x0) + q8dot(wa{{ r }}.y, x1) + q8dot(wa{{ r }}.z, x2) + q8dot(wa{{ r }}.w, x3) +
      q8dot(wb{{ r }}.x, x4) + q8dot(wb{{ r }}.y, x5) + q8dot(wb{{ r }}.z, x6) + q8dot(wb{{ r }}.w, x7));
{%- else %}
    let scale{{ r }} = f32(q4_scales[blk{{ r }}]);
    let words{{ r }} = q4_bits[blk{{ r }}];
    acc{{ r }} = acc{{ r }} + scale{{ r }} * (
      q4wp(words{{ r }}.x, x0, x4) + q4wp(words{{ r }}.y, x1, x5) + q4wp(words{{ r }}.z, x2, x6) + q4wp(words{{ r }}.w, x3, x7));
{%- endif %}
{%- endfor %}
`],["ops/_shared/q4-dequant-helpers.wgsl.jinja",`{%- if quantBits == 8 %}

fn q8dot(word: u32, xv: vec4<f32>) -> f32 {
  return dot(vec4<f32>(unpack4xI8(word)), xv);
}
{%- if q8Pair | default(false) %}

fn q8pair_base(block: u32) -> u32 {
  return (block >> 3u) * 17u;
}
fn q8pair_code_base(block: u32) -> u32 {
  return q8pair_base(block) + (block & 7u) * 2u;
}
fn q8pair_scale(block: u32) -> f32 {
  return f32(q4_scales[(block >> 3u) * 136u + 128u + (block & 7u)]);
}
{%- endif %}
{%- else %}

fn q4_lo(word: u32) -> vec4<f32> {
  return vec4<f32>(unpack4xU8(word & 0x0F0F0F0Fu)) - 8.0;
}
fn q4_hi(word: u32) -> vec4<f32> {
  return vec4<f32>(unpack4xU8((word >> 4u) & 0x0F0F0F0Fu)) - 8.0;
}
fn q4wp(word: u32, lo: vec4<f32>, hi: vec4<f32>) -> f32 {
  return dot(lo, q4_lo(word)) + dot(hi, q4_hi(word));
}
{%- endif %}{%- if q5 %}

fn q5spread(h: u32) -> u32 {
  return (h * 0x02040810u) & 0x10101010u;
}
fn q5_lo(word: u32, h: u32) -> vec4<f32> {
  return vec4<f32>(unpack4xU8((word & 0x0F0F0F0Fu) | q5spread(h))) - 16.0;
}
fn q5_hi(word: u32, h: u32) -> vec4<f32> {
  return vec4<f32>(unpack4xU8(((word >> 4u) & 0x0F0F0F0Fu) | q5spread(h))) - 16.0;
}
fn q5wp(word: u32, qh: u32, w: u32, lo: vec4<f32>, hi: vec4<f32>) -> f32 {
  return dot(lo, q5_lo(word, (qh >> (4u * w)) & 15u)) + dot(hi, q5_hi(word, (qh >> (4u * w + 16u)) & 15u));
}
{%- endif %}{%- if q2k %}

fn q2w(cw: u32, w: u32) -> vec4<f32> {
  return vec4<f32>(unpack4xU8((cw >> (2u * w)) & 0x03030303u));
}
{%- endif %}{%- if q3k is defined and q3k %}

fn q3w_lo(cw: u32, h: u32, w: u32) -> vec4<f32> {
  return vec4<f32>(unpack4xU8(((cw >> (2u * w)) & 0x03030303u) | (((h >> w) & 0x01010101u) << 2u))) - 4.0;
}
fn q3w_hi(cw: u32, h: u32, w: u32) -> vec4<f32> {
  return vec4<f32>(unpack4xU8(((cw >> (2u * w)) & 0x03030303u) | (((h >> (4u + w)) & 0x01010101u) << 2u))) - 4.0;
}
{%- endif %}{%- if q6k %}

fn q6_lo(word: u32, hLo: u32, w: u32) -> vec4<f32> {
  return vec4<f32>(unpack4xU8((word & 0x0F0F0F0Fu) | (((hLo >> (2u * w)) & 0x03030303u) << 4u))) - 32.0;
}
fn q6_hi(word: u32, hHi: u32, w: u32) -> vec4<f32> {
  return vec4<f32>(unpack4xU8(((word >> 4u) & 0x0F0F0F0Fu) | (((hHi >> (2u * w)) & 0x03030303u) << 4u))) - 32.0;
}
{%- endif %}{%- if q5k is defined and q5k %}

fn q5kspread(h: u32) -> u32 {
  return (h * 0x02040810u) & 0x10101010u;
}
fn q5k_lo(word: u32, h: u32) -> vec4<f32> {
  return vec4<f32>(unpack4xU8((word & 0x0F0F0F0Fu) | q5kspread(h)));
}
fn q5k_hi(word: u32, h: u32) -> vec4<f32> {
  return vec4<f32>(unpack4xU8(((word >> 4u) & 0x0F0F0F0Fu) | q5kspread(h)));
}
{%- endif %}
`],["ops/_shared/q4nl-dequant-helpers.wgsl.jinja",`{%- if quantBits == 8 %}

fn q8dot(word: u32, xv: vec4<f32>) -> f32 {
  return dot(vec4<f32>(unpack4xI8(word)), xv);
}
{%- else %}
{%- if lutId and lutId == 2 %}

{% set gridRow0 = "8.0, 25.0, 43.0, 0.0, 0.0, 0.0, 0.0, 0.0" %}
{% set gridRow1 = "-8.0, -25.0, -43.0, 0.0, 0.0, 0.0, 0.0, 0.0" %}
{%- elif lutId and lutId == 3 %}

{% set gridRow0 = "1.0, 3.0, 5.0, 7.0, 9.0, 11.0, 13.0, 15.0" %}
{% set gridRow1 = "-1.0, -3.0, -5.0, -7.0, -9.0, -11.0, -13.0, -15.0" %}
{%- elif lutId and lutId == 5 %}

{% set gridRow0 = "4.0, 12.0, 20.0, 28.0, 36.0, 44.0, 52.0, 62.0" %}
{% set gridRow1 = "-4.0, -12.0, -20.0, -28.0, -36.0, -44.0, -52.0, -62.0" %}
{%- elif lutId and lutId == 4 %}

{% set gridRow0 = "-4.0, -3.0, -2.0, -1.0, 0.0, 1.0, 2.0, 3.0" %}
{% set gridRow1 = "0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0" %}
{%- elif lutId and lutId == 6 %}

{% set gridRow0 = "0.0, 1.0, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0" %}
{% set gridRow1 = "0.0, -1.0, -2.0, -3.0, -4.0, -6.0, -8.0, -12.0" %}
{%- elif lutId and lutId == 7 %}

{% set gridRow0 = "-9.0, -1.0, 7.0, 0.0, 0.0, 0.0, 0.0, 0.0" %}
{% set gridRow1 = "-7.0, 1.0, 9.0, 0.0, 0.0, 0.0, 0.0, 0.0" %}
{%- else %}

{% set gridRow0 = "-127.0, -104.0, -83.0, -65.0, -49.0, -35.0, -22.0, -10.0" %}
{% set gridRow1 = "1.0, 13.0, 25.0, 38.0, 53.0, 69.0, 89.0, 113.0" %}
{%- endif %}

const LUT_GRID = array<f32, 16>(
  {{ gridRow0 }},
  {{ gridRow1 }});
fn q4nl(v: u32) -> f32 {
  return LUT_GRID[v & 15u];
}
fn q4_lo(word: u32) -> vec4<f32> {
  return vec4<f32>(q4nl(word), q4nl(word >> 8u), q4nl(word >> 16u), q4nl(word >> 24u));
}
fn q4_hi(word: u32) -> vec4<f32> {
  return vec4<f32>(q4nl(word >> 4u), q4nl(word >> 12u), q4nl(word >> 20u), q4nl(word >> 28u));
}
fn q4wp(word: u32, lo: vec4<f32>, hi: vec4<f32>) -> f32 {
  return dot(lo, q4_lo(word)) + dot(hi, q4_hi(word));
}
{%- endif %}
`],["ops/_shared/sg-sum.wgsl.jinja",`fn sg_sum(value: f32) -> f32 {
{% if sgExact32 %}
  return subgroupAdd(value);
{% else %}
  var x = value;
  x = x + subgroupShuffleXor(x, 1u);
  x = x + subgroupShuffleXor(x, 2u);
  x = x + subgroupShuffleXor(x, 4u);
  x = x + subgroupShuffleXor(x, 8u);
  x = x + subgroupShuffleXor(x, 16u);
  return x;
{% endif %}
}`],["ops/_shared/subgroup-matrix-8x8-accumulators.wgsl.jinja",`  var matC00: subgroup_matrix_result<f32, 8, 8>;
  var matC01: subgroup_matrix_result<f32, 8, 8>;
  var matC02: subgroup_matrix_result<f32, 8, 8>;
  var matC03: subgroup_matrix_result<f32, 8, 8>;
  var matC10: subgroup_matrix_result<f32, 8, 8>;
  var matC11: subgroup_matrix_result<f32, 8, 8>;
  var matC12: subgroup_matrix_result<f32, 8, 8>;
  var matC13: subgroup_matrix_result<f32, 8, 8>;
`],["ops/_shared/attn-flash-decode-splitk-merge.wgsl.jinja",`{% if usesF16 %}
enable f16;
{% endif %}
{% if splitQueries is not defined %}{% set splitQueries = false %}{% endif %}
{% if hasGate is not defined %}{% set hasGate = false %}{% endif %}
{% if turboQuantCache is not defined %}{% set turboQuantCache = false %}{% endif %}
{{ env.wgsl.resourceDeclarations }}
{% if normedGatedGqa is defined and normedGatedGqa %}{% include "ops/_shared/sigmoid-safe.wgsl.jinja" %}
{% endif %}
{% if turboQuantCache %}
{% include "ops/_shared/hadamard-transform-row.wgsl.jinja" %}
{% endif %}

{% if source.layout == "bhsd" %}

{% elif source.layout == "layer_cache" %}

{% else %}

{% endif %}
const HEAD_DIM_V4: u32 = {{ headDimV4 }}u;
const Q_HEADS: u32 = {{ qNumHeads }}u;
const NUM_SPLITS: u32 = {{ numSplits }}u;
{% if splitQueries %}
const Q_SEQ: u32 = {{ qSeq }}u;
{% endif %}
{% if source.layout == "bsh" %}
const Q_HIDDEN_V4: u32 = {{ qHiddenV4 }}u;
{% endif %}
{% if hasBias %}

const HEAD_DIM: u32 = {{ headDim }}u;
const Q_HIDDEN: u32 = {{ qHidden }}u;
{% endif %}
{% include "ops/_shared/softmax-stable-helpers.wgsl.jinja" %}
{% if turboQuantCache %}

var<workgroup> unrotate: array<vec4<f32>, HEAD_DIM_V4>;
{% endif %}

@compute @workgroup_size(HEAD_DIM_V4, 1, 1)
fn main(
  @builtin(workgroup_id) wg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>
) {
{% if splitQueries %}
  let queryToken = wg.x;
{% endif %}
  let h = wg.y;
  let b = wg.z;
  let d4 = lid.x;
  if (h >= Q_HEADS{% if not turboQuantCache %} || d4 >= HEAD_DIM_V4{% endif %}{% if splitQueries %} || queryToken >= Q_SEQ{% endif %}) {
    return;
  }

{% if splitQueries %}
  let mdBase = ((b * Q_SEQ + queryToken) * Q_HEADS + h) * NUM_SPLITS;
{% else %}
  let mdBase = (b * Q_HEADS + h) * NUM_SPLITS;
{% endif %}
  var globalMax = -FLT_MAX;
  for (var s: u32 = 0u; s < NUM_SPLITS; s = s + 1u) {
{% if normedGatedGqa is defined and normedGatedGqa %}
    let statsBase = (mdBase + s) * (HEAD_DIM_V4 + 1u);
    globalMax = max(globalMax, partial_out[statsBase + HEAD_DIM_V4].x);
{% else %}
    globalMax = max(globalMax, partial_stats[mdBase + s].x);
{% endif %}
  }
  var globalDenom = 0.0;
  var outV = vec4<f32>(0.0);
  for (var s: u32 = 0u; s < NUM_SPLITS; s = s + 1u) {
{% if normedGatedGqa is defined and normedGatedGqa %}
    let pBase = (mdBase + s) * (HEAD_DIM_V4 + 1u);
    let stats = partial_out[pBase + HEAD_DIM_V4].xy;
{% else %}
    let stats = partial_stats[mdBase + s];
{% endif %}
    let w = exp_shift(stats.x, globalMax);
    globalDenom = globalDenom + stats.y * w;
{% if not (normedGatedGqa is defined and normedGatedGqa) %}
{% if splitQueries %}
    let pBase = (((b * Q_SEQ + queryToken) * Q_HEADS + h) * NUM_SPLITS + s) * HEAD_DIM_V4;
{% else %}
    let pBase = ((b * Q_HEADS + h) * NUM_SPLITS + s) * HEAD_DIM_V4;
{% endif %}
{% endif %}
    outV = outV + partial_out[pBase + d4] * w;
  }

{% if source.layout == "bsh" %}
{% if splitQueries %}
  let qBaseV4 = (b * Q_SEQ + queryToken) * Q_HIDDEN_V4 + h * HEAD_DIM_V4;
{% else %}
  let qBaseV4 = b * Q_HIDDEN_V4 + h * HEAD_DIM_V4;
{% endif %}
{% elif source.layout == "layer_cache" %}
  let qBaseV4 = h * HEAD_DIM_V4;
{% else %}
{% if splitQueries %}
  let qBaseV4 = ((b * Q_HEADS + h) * Q_SEQ + queryToken) * HEAD_DIM_V4;
{% else %}
  let qBaseV4 = (b * Q_HEADS + h) * HEAD_DIM_V4;
{% endif %}
{% endif %}

  var outValue = select(vec4<f32>(0.0), outV / globalDenom, globalDenom > 0.0);
{% if turboQuantCache %}
  unrotate[d4] = outValue;
  workgroupBarrier();
{{ emit_wht_shared_v4("unrotate", headDimV4, "d4", "HEAD_DIM_V4") }}
  outValue = unrotate[d4];
{% endif %}
{% if hasBias %}

  let vBiasBase = 2u * Q_HIDDEN + h * HEAD_DIM + d4 * 4u;
  outValue = outValue + vec4<f32>(bias[vBiasBase], bias[vBiasBase + 1u], bias[vBiasBase + 2u], bias[vBiasBase + 3u]);
{% endif %}
{% if normedGatedGqa is defined and normedGatedGqa %}

  let attentionStored = fma(outValue, vec4<f32>(1.0), vec4<f32>(0.0));
  let gateV = vec4<f32>(gate[qBaseV4 + d4]);
  let sigmoidV = vec4<f32>(
    sigmoid_safe(gateV.x),
    sigmoid_safe(gateV.y),
    sigmoid_safe(gateV.z),
    sigmoid_safe(gateV.w)
  );
  let sigmoidStored = fma(sigmoidV, vec4<f32>(1.0), vec4<f32>(0.0));
  outValue = attentionStored * sigmoidStored;
{% elif hasGate %}

  let gateV = vec4<f32>(gate[qBaseV4 + d4]);
  outValue = outValue * (vec4<f32>(1.0) / (vec4<f32>(1.0) + exp(-gateV)));
{% endif %}
  output[qBaseV4 + d4] = vec4<{{ scalar }}>(outValue);
}
`],["ops/_shared/attn-flash-decode-splitk.wgsl.jinja",`{% if useSubgroups is not defined %}{% set useSubgroups = true %}{% endif %}
{% if splitQueries is not defined %}{% set splitQueries = false %}{% endif %}
{% if quantizedCache is not defined %}{% set quantizedCache = false %}{% endif %}
{% if turboQuantCache is not defined %}{% set turboQuantCache = false %}{% endif %}
{% if cacheSeqlens is not defined %}{% set cacheSeqlens = false %}{% endif %}
{% if hasMask is not defined %}{% set hasMask = false %}{% endif %}
{% if maskIsBool is not defined %}{% set maskIsBool = false %}{% endif %}
{% set splitKWorkgroupSize = source.workgroupSize if source.workgroupSize is defined else tunables.WORKGROUP_SIZE %}
{% if useSubgroups %}
enable subgroups;
{% endif %}
{% if usesF16 %}
enable f16;
{% endif %}
{{ env.wgsl.resourceDeclarations }}

{% if source.layout == "bhsd" %}

{% elif source.layout == "layer_cache" %}

{% else %}

{% endif %}
const HEAD_DIM: u32 = {{ headDim }}u;
const HEAD_DIM_V4: u32 = {{ headDimV4 }}u;
const Q_HEADS: u32 = {{ qNumHeads }}u;
const KV_HEADS: u32 = {{ kvNumHeads }}u;
{% if source.layout == "bsh" %}
const Q_HIDDEN_V4: u32 = {{ qHiddenV4 }}u;
const KV_HIDDEN_V4: u32 = {{ kvHiddenV4 }}u;
{% elif source.layout == "layer_cache" %}
const LAYER: u32 = {{ layer }}u;
const CACHE_LEN: u32 = {{ cacheLen }}u;
const ATTN_SCALE: f32 = {{ scale }};
{% endif %}
const WG: u32 = {{ splitKWorkgroupSize }}u;
const NUM_SPLITS: u32 = {{ numSplits }}u;
{% if normedGatedGqa is defined and normedGatedGqa %}const HALF_DIM: u32 = HEAD_DIM / 2u;
{% if hasRotary and headDim % 8 == 0 %}const HALF_DIM_V4: u32 = HEAD_DIM_V4 / 2u;
{% endif %}
const QK_EPS: f32 = {{ qkEps }};
{% endif %}{% if hasMask and maskIsBool %}

const MASK_NEG: f32 = -1e38;
{% endif %}
{% if turboQuantCache %}

const TQ_WORDS_PER_ROW: u32 = HEAD_DIM / 8u + 1u;
{% include "ops/_shared/hadamard-transform-row.wgsl.jinja" %}
{% include "ops/_shared/turbo-quant.wgsl.jinja" %}
{% endif %}
{% if splitQueries %}
const Q_SEQ: u32 = {{ qSeq }}u;
{% endif %}
{% include "ops/_shared/softmax-stable-helpers.wgsl.jinja" %}

var<workgroup> q_shared: array<vec4<f32>, HEAD_DIM_V4>;
var<workgroup> running_out: array<vec4<f32>, HEAD_DIM_V4>;
var<workgroup> probs: array<f32, WG>;
{% if normedGatedGqa is defined and normedGatedGqa %}var<workgroup> fused_q_inv: f32;
{% if not useSubgroups %}var<workgroup> fused_q_partials: array<f32, 32>;
{% endif %}{% endif %}{% set coopQk = useSubgroups and headDimV4 >= 8 and not (usesF16 and headDimV4 <= 32) %}
{% set jGroups = (splitKWorkgroupSize / headDimV4)|int %}
{% set jSplitV = (splitKWorkgroupSize % headDimV4 == 0) and (jGroups >= 2) %}
{% if coopQk %}
var<workgroup> sval_sh: array<f32, WG>;
{% endif %}
{% if jSplitV %}
var<workgroup> vacc_sh: array<vec4<f32>, WG>;
{% endif %}
{% set combineSubgroups = useSubgroups %}
{% include "ops/_shared/softmax-md-combine.wgsl.jinja" %}

{% if source.layout == "layer_cache" %}{% set ATTN_SCALE_OVERRIDE = "ATTN_SCALE" %}{% endif %}
{% include "ops/_shared/attn-scale-value.wgsl.jinja" %}

{% if quantizedCache or turboQuantCache %}
{% include "ops/_shared/attn-quant-cache-load.wgsl.jinja" %}
{% set quantCacheFormat = "turbo" if turboQuantCache else "int8" %}
{{ emit_quant_load4(quantCacheFormat, "key", "key", "k_scale") }}
{{ emit_quant_load4(quantCacheFormat, "value", "value", "v_scale") }}
{% else %}
fn load_key4(indexV4: u32, d4: u32, hk: u32) -> vec4<f32> {
  return vec4<f32>(key[indexV4]);
}

fn load_value4(indexV4: u32, d4: u32, hk: u32) -> vec4<f32> {
  return vec4<f32>(value[indexV4]);
}
{% endif %}

{% if hasBias %}

{% include "ops/_shared/attn-load-bias4.wgsl.jinja" %}
{% endif %}

@compute @workgroup_size(WG, 1, 1)
fn main(
  @builtin(workgroup_id) wg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>{% if useSubgroups %},
  @builtin(subgroup_size) sgSize: u32{% endif %}
) {
{% if useSubgroups %}

  if (sgSize == 0u || sgSize > WG || WG % sgSize != 0u) { return; }
{% endif %}
{% if splitQueries %}
  let queryToken = wg.x / NUM_SPLITS;
  let split = wg.x % NUM_SPLITS;
{% else %}
  let split = wg.x;
{% endif %}
  let h = wg.y;
  let b = wg.z;
  if (h >= Q_HEADS || split >= NUM_SPLITS{% if splitQueries %} || queryToken >= Q_SEQ{% endif %}{% if source.layout == "layer_cache" %} || params.past_len >= CACHE_LEN{% endif %}) {
    return;
  }
  let tid = lid.x;
  let hKv = h / (Q_HEADS / KV_HEADS);
{% if source.layout == "layer_cache" %}
  let kvSeq = params.past_len + 1u;
{% else %}
  let cacheSeq = params.kvSeq;
{% if cacheSeqlens %}

  let kvSeq = min(cacheSeq, u32(seqlens_k[b]) + 1u);
{% else %}
  let kvSeq = cacheSeq;
{% endif %}
{% endif %}

{% if source.layout == "bsh" %}
{% if splitQueries %}
  let qBaseV4 = (b * Q_SEQ + queryToken) * Q_HIDDEN_V4 + h * HEAD_DIM_V4;
{% else %}
  let qBaseV4 = b * Q_HIDDEN_V4 + h * HEAD_DIM_V4;
{% endif %}
  let kvBaseV4 = b * kvSeq * KV_HIDDEN_V4 + hKv * HEAD_DIM_V4;
  let kvTokenStrideV4 = KV_HIDDEN_V4;
{% elif source.layout == "layer_cache" %}
  let qBaseV4 = h * HEAD_DIM_V4;
  let kvBaseV4 = (LAYER * CACHE_LEN * KV_HEADS + hKv) * HEAD_DIM_V4;
  let kvTokenStrideV4 = KV_HEADS * HEAD_DIM_V4;
{% elif turboQuantCache %}
  let qBaseV4 = (b * Q_HEADS + h) * HEAD_DIM_V4;
  let kvBaseV4 = (b * KV_HEADS + hKv) * cacheSeq * TQ_WORDS_PER_ROW;
  let kvTokenStrideV4 = TQ_WORDS_PER_ROW;
{% else %}
{% if splitQueries %}
  let qBaseV4 = ((b * Q_HEADS + h) * Q_SEQ + queryToken) * HEAD_DIM_V4;
{% else %}
  let qBaseV4 = (b * Q_HEADS + h) * HEAD_DIM_V4;
{% endif %}
  let kvBaseV4 = (b * KV_HEADS + hKv) * cacheSeq * HEAD_DIM_V4;
  let kvTokenStrideV4 = HEAD_DIM_V4;
{% endif %}

{% if hasWindow %}

  var windowStart: u32 = 0u;
  if (kvSeq > params.windowSize) {
    windowStart = kvSeq - params.windowSize;
  }
  let activeKeys = kvSeq - windowStart;
  let keysPerSplit = (activeKeys + NUM_SPLITS - 1u) / NUM_SPLITS;
  let splitStart = windowStart + split * keysPerSplit;
{% else %}
{% if source.minKeysPerChunk is defined %}
  let evenKeysPerSplit = (kvSeq + NUM_SPLITS - 1u) / NUM_SPLITS;
  let keysPerSplit = max(evenKeysPerSplit, {{ source.minKeysPerChunk }}u);
{% else %}
  let keysPerSplit = (kvSeq + NUM_SPLITS - 1u) / NUM_SPLITS;
{% endif %}
  let splitStart = split * keysPerSplit;
{% endif %}
  var splitEnd = splitStart + keysPerSplit;
  if (splitEnd > kvSeq) {
    splitEnd = kvSeq;
  }

{% if normedGatedGqa is defined and normedGatedGqa %}

  var q_acc = 0.0;
  if (tid < 32u) {
    for (var d4 = tid; d4 < HEAD_DIM_V4; d4 = d4 + 32u) {
      let q4 = vec4<f32>(query[qBaseV4 + d4]);
      q_acc = q_acc + dot(q4, q4);
    }
  }
{% if useSubgroups %}
  let q_total = subgroupAdd(q_acc);
  if (tid == 0u) {
    fused_q_inv = inverseSqrt(q_total / f32(HEAD_DIM) + QK_EPS);
  }
{% else %}
  if (tid < 32u) {
    fused_q_partials[tid] = q_acc;
  }
  workgroupBarrier();
  var q_stride = 16u;
  loop {
    if (q_stride == 0u) { break; }
    if (tid < q_stride) {
      fused_q_partials[tid] = fused_q_partials[tid] + fused_q_partials[tid + q_stride];
    }
    workgroupBarrier();
    q_stride = q_stride >> 1u;
  }
  if (tid == 0u) {
    fused_q_inv = inverseSqrt(fused_q_partials[0] / f32(HEAD_DIM) + QK_EPS);
  }
{% endif %}
  workgroupBarrier();
  for (var d4 = tid; d4 < HEAD_DIM_V4; d4 = d4 + WG) {
    q_shared[d4] = fma(
      vec4<f32>(query[qBaseV4 + d4]) * fused_q_inv * q_norm_weight[d4],
      vec4<f32>(1.0),
      vec4<f32>(0.0)
    );
    running_out[d4] = vec4<f32>(0.0);
  }
  workgroupBarrier();
{% if hasRotary %}
{% if headDim % 8 == 0 %}

  for (var d4 = tid; d4 < HALF_DIM_V4; d4 = d4 + WG) {
    let x0 = q_shared[d4];
    let x1 = q_shared[d4 + HALF_DIM_V4];
    let d = d4 * 4u;
    let c = vec4<f32>(cos_cache[d], cos_cache[d + 1u], cos_cache[d + 2u], cos_cache[d + 3u]);
    let s = vec4<f32>(sin_cache[d], sin_cache[d + 1u], sin_cache[d + 2u], sin_cache[d + 3u]);
    q_shared[d4] = x0 * c - x1 * s;
    q_shared[d4 + HALF_DIM_V4] = x1 * c + x0 * s;
  }
{% else %}
  if (tid == 0u) {
    for (var d = 0u; d < HALF_DIM; d = d + 1u) {
      let hi_d = d + HALF_DIM;
      let lo_i = d / 4u;
      let hi_i = hi_d / 4u;
      let lo_lane = d & 3u;
      let hi_lane = hi_d & 3u;
      let x0 = q_shared[lo_i][lo_lane];
      let x1 = q_shared[hi_i][hi_lane];
      let c = cos_cache[d];
      let s = sin_cache[d];
      q_shared[lo_i][lo_lane] = x0 * c - x1 * s;
      q_shared[hi_i][hi_lane] = x1 * c + x0 * s;
    }
  }
{% endif %}
  workgroupBarrier();
{% endif %}
{% else %}
{% include "ops/_shared/attn-q-row-load.wgsl.jinja" %}
{% endif %}
{% if turboQuantCache %}

{{ emit_wht_shared_v4("q_shared", headDimV4, "tid", "WG") }}
{% endif %}

  let scale = scale_value();
  var runningMax = -FLT_MAX;
  var runningDenom = 0.0;

  var kjBase = splitStart;
  loop {
    if (kjBase >= splitEnd) {
      break;
    }
    let kj = kjBase + tid;
    let keyAllowed = kj < splitEnd;
    let tileCount = min(WG, splitEnd - kjBase);

    var score = -FLT_MAX;
    var m = -FLT_MAX;
    var dPart = 0.0;
{% if coopQk %}

    let sgPerWg = WG / sgSize;
    let qkRounds = (tileCount + sgPerWg - 1u) / sgPerWg;
    let lane = tid % sgSize;
    let sgInWg = tid / sgSize;
    for (var rr: u32 = 0u; rr < qkRounds; rr = rr + 1u) {
      let j = rr * sgPerWg + sgInWg;
      var accS: f32 = 0.0;
      if (j < tileCount) {
        let kRowV4 = kvBaseV4 + (kjBase + j) * kvTokenStrideV4;
        for (var d4: u32 = lane; d4 < HEAD_DIM_V4; d4 = d4 + sgSize) {
          accS = accS + dot(q_shared[d4], load_key4(kRowV4 + d4, d4, hKv));
        }
      }
      let sj = subgroupAdd(accS);
      if (lane == 0u && j < tileCount) {
        sval_sh[j] = sj;
      }
    }
    workgroupBarrier();
    if (keyAllowed) {
      score = sval_sh[tid] * scale;
      m = score;
      dPart = 1.0;
    }
{% else %}
    if (keyAllowed) {
      let kRowV4 = kvBaseV4 + kj * kvTokenStrideV4;
      var acc: f32 = 0.0;
      for (var d4: u32 = 0u; d4 < HEAD_DIM_V4; d4 = d4 + 1u) {
        acc = acc + dot(q_shared[d4], load_key4(kRowV4 + d4, d4, hKv));
      }
      score = acc * scale;
      m = score;
      dPart = 1.0;
    }
{% endif %}
{% if hasMask %}
    if (keyAllowed) {
{% if splitQueries %}
      let maskQuery = queryToken;
{% else %}
      let maskQuery = 0u;
{% endif %}
      let maskIndex = b * params.maskBatchStride + h * params.maskHeadStride + maskQuery * params.maskSeqStride + kj;
{% if maskIsBool %}

      if (attn_mask[maskIndex] == 0u) {
        score = MASK_NEG;
      }
{% else %}
      score = score + f32(attn_mask[maskIndex]);
{% endif %}
      m = score;
    }
{% endif %}
    let tile = combine_partials(m, dPart, tid{% if useSubgroups %}, sgSize{% endif %});

{% include "ops/_shared/attn-online-merge-tile.wgsl.jinja" %}

{% if jSplitV %}

    const J_GROUPS: u32 = {{ jGroups }}u;
    let jg = tid / HEAD_DIM_V4;
    let d4v = tid % HEAD_DIM_V4;
    var vacc = vec4<f32>(0.0);
    var jj = jg;
    loop {
      if (jj >= tileCount) { break; }
      vacc = vacc + probs[jj] * load_value4(
        kvBaseV4 + (kjBase + jj) * kvTokenStrideV4 + d4v,
        d4v,
        hKv
      );
      jj = jj + J_GROUPS;
    }
    vacc_sh[tid] = vacc;
    workgroupBarrier();
    for (var d4: u32 = tid; d4 < HEAD_DIM_V4; d4 = d4 + WG) {
      var a4 = running_out[d4] * correction;
      for (var g: u32 = 0u; g < J_GROUPS; g = g + 1u) {
        a4 = a4 + vacc_sh[g * HEAD_DIM_V4 + d4];
      }
      running_out[d4] = a4;
    }
    workgroupBarrier();
{% else %}
    for (var d4: u32 = tid; d4 < HEAD_DIM_V4; d4 = d4 + WG) {
      var vSum = vec4<f32>(0.0);
      for (var i: u32 = 0u; i < tileCount; i = i + 1u) {
        vSum = vSum + probs[i] * load_value4(
          kvBaseV4 + (kjBase + i) * kvTokenStrideV4 + d4,
          d4,
          hKv
        );
      }
      running_out[d4] = running_out[d4] * correction + vSum;
    }
    workgroupBarrier();
{% endif %}

    kjBase = kjBase + WG;
  }

{% if splitQueries %}
{% if normedGatedGqa is defined and normedGatedGqa %}
  let partialBase = (((b * Q_SEQ + queryToken) * Q_HEADS + h) * NUM_SPLITS + split) * (HEAD_DIM_V4 + 1u);
{% else %}
  let partialBase = (((b * Q_SEQ + queryToken) * Q_HEADS + h) * NUM_SPLITS + split) * HEAD_DIM_V4;
{% endif %}
{% else %}
{% if normedGatedGqa is defined and normedGatedGqa %}
  let partialBase = ((b * Q_HEADS + h) * NUM_SPLITS + split) * (HEAD_DIM_V4 + 1u);
{% else %}
  let partialBase = ((b * Q_HEADS + h) * NUM_SPLITS + split) * HEAD_DIM_V4;
{% endif %}
{% endif %}
  for (var d4: u32 = tid; d4 < HEAD_DIM_V4; d4 = d4 + WG) {
    partial_out[partialBase + d4] = running_out[d4];
  }
  if (tid == 0u) {
{% if normedGatedGqa is defined and normedGatedGqa %}
    partial_out[partialBase + HEAD_DIM_V4] = vec4<f32>(runningMax, runningDenom, 0.0, 0.0);
{% else %}
{% if splitQueries %}
    let mdBase = ((b * Q_SEQ + queryToken) * Q_HEADS + h) * NUM_SPLITS + split;
{% else %}
    let mdBase = (b * Q_HEADS + h) * NUM_SPLITS + split;
{% endif %}

    partial_stats[mdBase] = vec2<f32>(runningMax, runningDenom);
{% endif %}
  }
}
`],["ops/_shared/attn-online-merge-tile.wgsl.jinja",`    let newMax = max(runningMax, tile.x);
    let correction = exp_shift(runningMax, newMax);
    runningDenom = runningDenom * correction + tile.y * exp_shift(tile.x, newMax);
    runningMax = newMax;

    var prob = 0.0;
    if (keyAllowed) {
      prob = exp_shift(score, newMax);
    }
    probs[tid] = prob;
    workgroupBarrier();`],["ops/_shared/attn-q-row-load.wgsl.jinja",`  for (var d4 = tid; d4 < HEAD_DIM_V4; d4 = d4 + WG) {
    var qv = vec4<f32>(query[qBaseV4 + d4]);
{% if hasBias %}
    qv = qv + load_bias4(h * HEAD_DIM, d4);
{% endif %}
    q_shared[d4] = qv;
    running_out[d4] = vec4<f32>(0.0);
  }
  workgroupBarrier();`],["ops/_shared/softmax-md-combine.wgsl.jinja",`{% if combineSubgroups %}

var<workgroup> partialM: array<f32, WG>;
var<workgroup> partialD: array<f32, WG>;
var<workgroup> combinedMD: vec2<f32>;

fn combine_partials(m: f32, d: f32, lidx: u32, sgSize: u32) -> vec2<f32> {
  let sgM = subgroupMax(m);

  let sgD = subgroupAdd(d * exp_shift(m, sgM));
  if (sgSize == WG) {
    return vec2<f32>(sgM, sgD);
  }
  let subgroupCount = (WG + sgSize - 1u) / sgSize;

  if (lidx < subgroupCount) {
    partialM[lidx] = -FLT_MAX;
    partialD[lidx] = 0.0;
  }
  workgroupBarrier();
  if (subgroupElect()) {
    let slot = lidx / sgSize;
    partialM[slot] = sgM;
    partialD[slot] = sgD;
  }
  workgroupBarrier();
  if (lidx == 0u) {
    var accM = -FLT_MAX;
    var accD = 0.0;
    for (var i = 0u; i < subgroupCount; i = i + 1u) {
      let mNew = max(accM, partialM[i]);
      accD = accD * exp_shift(accM, mNew) + partialD[i] * exp_shift(partialM[i], mNew);
      accM = mNew;
    }
    combinedMD = vec2<f32>(accM, accD);
  }
  workgroupBarrier();
  return combinedMD;
}
{% else %}
var<workgroup> partialM: array<f32, WG>;
var<workgroup> partialD: array<f32, WG>;

fn combine_partials(m: f32, d: f32, lidx: u32) -> vec2<f32> {
  partialM[lidx] = m;
  partialD[lidx] = d;
  workgroupBarrier();
  var stride = WG / 2u;
  loop {
    if (stride == 0u) {
      break;
    }
    if (lidx < stride) {
      let m1 = partialM[lidx];
      let d1 = partialD[lidx];
      let m2 = partialM[lidx + stride];
      let d2 = partialD[lidx + stride];
      let mNew = max(m1, m2);
      partialD[lidx] = d1 * exp_shift(m1, mNew) + d2 * exp_shift(m2, mNew);
      partialM[lidx] = mNew;
    }
    workgroupBarrier();
    stride = stride / 2u;
  }
  let merged = vec2<f32>(partialM[0], partialD[0]);

  workgroupBarrier();
  return merged;
}
{% endif %}
`],["ops/_shared/softmax-stable-helpers.wgsl.jinja",`const FLT_MAX: f32 = 3.4028234663852886e38;

fn is_finite_f32(value: f32) -> bool {
  return select(false, value <= FLT_MAX, value >= -FLT_MAX);
}

fn shifted_value(value: f32, maxValue: f32) -> f32 {
  let equalFiniteMax = select(false, value == maxValue, is_finite_f32(maxValue));
  return select(value - maxValue, 0.0, equalFiniteMax);
}

fn exp_shift(value: f32, maxValue: f32) -> f32 {
  return exp(shifted_value(value, maxValue));
}

fn is_nan_f32(value: f32) -> bool {
  let bits = bitcast<u32>(value);
  return (bits & 0x7f800000u) == 0x7f800000u && (bits & 0x007fffffu) != 0u;
}
`]]),cg=new Map([["ai.onnx.ArgMax",{manifest:{domain:"ai.onnx",name:"ArgMax",sinceVersion:13,inputs:[{role:"data",dtype:"T"}],outputs:[{role:"reduced",dtype:"I"}],attributes:{axis:1,keepdims:1,select_last_index:0},typeConstraints:{T:["float32","float16","int32","uint32","int8","uint8"],I:["uint32"]},args:{x:{kind:"tensor",semantic:"data",role:"input"},y:{kind:"tensor",semantic:"reduced",role:"output"}},tunables:{WORKGROUP_SIZE:256,TILE_COLUMNS:16,TILED_MIN_AXIS:64,TILED_MIN_OUTPUTS:16,SPLIT_MIN_AXIS:8192,SPLIT_MAX_OUTPUTS:4096,SPLIT_TARGET_AXIS:256,SPLIT_TILE_COLUMNS:8,MAX_SPLITS:128,ROW_SPLIT_MIN_AXIS:32768,ROW_SPLIT_MAX_OUTPUTS:32,ROW_SPLIT_TARGET_AXIS:2048,ROW_SPLIT_MAX_SPLITS:64},derive:{deviceWorkgroupCap:"min(device.limits.maxComputeInvocationsPerWorkgroup, device.limits.maxComputeWorkgroupSizeX)",foldedDispatchCapacity:"device.limits.maxComputeWorkgroupsPerDimension * device.limits.maxComputeWorkgroupsPerDimension",wave32Adapter:'has(device.adapterInfo, "subgroupMinSize") and has(device.adapterInfo, "subgroupMaxSize") and device.adapterInfo.subgroupMinSize == 32 and device.adapterInfo.subgroupMaxSize == 32',subgroupsWave32:'device.features.has("subgroups") and wave32Adapter',narrowSubgroupRange:'has(device.adapterInfo, "subgroupMinSize") and has(device.adapterInfo, "subgroupMaxSize") and device.adapterInfo.subgroupMinSize < device.adapterInfo.subgroupMaxSize and device.adapterInfo.subgroupMaxSize <= 16',subgroupsWide32:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize >= 32',reportedNonWave32Adapter:'not wave32Adapter and (has(device.adapterInfo, "subgroupMinSize") or has(device.adapterInfo, "subgroupMaxSize"))',normalizedAxis:"attrs.axis if attrs.axis >= 0 else attrs.axis + ranks.data",axisInRange:"ranks.data >= 1 and normalizedAxis >= 0 and normalizedAxis < ranks.data",axisDim:"dim(shapes.data, normalizedAxis)",axisInner:"inner(shapes.data, normalizedAxis)",outputCount:"numel(shapes.reduced)",outputRankOk:"(attrs.keepdims == 1 and ranks.reduced == ranks.data) or (attrs.keepdims == 0 and ranks.reduced == ranks.data - 1)",outputShapeOk:"outputRankOk and outputCount * axisDim == numel(shapes.data)",attributesOk:"(attrs.keepdims == 0 or attrs.keepdims == 1) and (attrs.select_last_index == 0 or attrs.select_last_index == 1)",baseContract:"axisInRange and axisDim > 0 and outputShapeOk and attributesOk and f16Ok(dtypes.T)",lastAxis:"normalizedAxis == ranks.data - 1",nativeParallelType:'dtypes.T == "f32" or dtypes.T == "i32" or dtypes.T == "u32"',rowParallelType:'nativeParallelType or dtypes.T == "f16"',workgroupSize:"min(tunables.WORKGROUP_SIZE, deviceWorkgroupCap)",narrowLargeAxisTilePreferred:"narrowSubgroupRange and outputCount >= workgroupSize",threadDispatchFits:"ceilDiv(outputCount, workgroupSize) <= foldedDispatchCapacity",rowDispatchFits:"outputCount <= foldedDispatchCapacity",rowStorageFits:"workgroupSize * 8 <= device.limits.maxComputeWorkgroupStorageSize",parallelRowWorthwhile:"axisDim >= 256 or outputCount < 32768",splitCount:"min(tunables.MAX_SPLITS, pow2ceil(ceilDiv(axisDim, tunables.SPLIT_TARGET_AXIS)))",splitScratchBytes:"splitCount * outputCount * 8",splitScratchFits:"splitScratchBytes <= device.limits.maxStorageBufferBindingSize and splitScratchBytes <= device.limits.maxBufferSize",splitDispatchFits:"splitCount <= device.limits.maxComputeWorkgroupsPerDimension and ceilDiv(ceilDiv(outputCount, workgroupSize), device.limits.maxComputeWorkgroupsPerDimension) <= device.limits.maxComputeWorkgroupsPerDimension",splitTileDispatchFits:"splitCount <= device.limits.maxComputeWorkgroupsPerDimension and ceilDiv(outputCount, tunables.SPLIT_TILE_COLUMNS) <= device.limits.maxComputeWorkgroupsPerDimension",rowSplitCount:"min(tunables.ROW_SPLIT_MAX_SPLITS, pow2ceil(ceilDiv(axisDim, tunables.ROW_SPLIT_TARGET_AXIS)))",rowSplitScratchBytes:"rowSplitCount * outputCount * 8",rowSplitScratchFits:"rowSplitScratchBytes <= device.limits.maxStorageBufferBindingSize and rowSplitScratchBytes <= device.limits.maxBufferSize",rowSplitDispatchFits:"outputCount <= device.limits.maxComputeWorkgroupsPerDimension and rowSplitCount <= device.limits.maxComputeWorkgroupsPerDimension",tileDispatchFits:"ceilDiv(outputCount, tunables.TILE_COLUMNS) <= foldedDispatchCapacity"},bindingSets:{contiguousVec4:[{name:"x",arg:"x",semantic:"data",buffer:{type:"read-only-storage"},elementType:"$vectorScalar"},{name:"y",arg:"y",semantic:"reduced",buffer:{type:"storage"},elementType:"u32"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"rows",type:"u32",value:"outputCount"},{name:"cols",type:"u32",value:"axisDim"},{name:"chunkCount",type:"u32",value:"axisDim / 4"},{name:"rowStride",type:"u32",value:"max(1, min(outputCount, device.limits.maxComputeWorkgroupsPerDimension))"}]}}],axisGeometry:[{name:"x",arg:"x",semantic:"data",buffer:{type:"read-only-storage"},elementType:"$scalar"},{name:"y",arg:"y",semantic:"reduced",buffer:{type:"storage"},elementType:"u32"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"axisDim",type:"u32",value:"axisDim"},{name:"outputCount",type:"u32",value:"outputCount"},{name:"innerSize",type:"u32",value:"axisInner"}]}}],rowSplitVec4:[{name:"x",arg:"x",semantic:"data",buffer:{type:"read-only-storage"},elementType:"$vectorScalar"},{name:"partials_val",semantic:"partials_val",buffer:{type:"storage"},elementType:"u32"},{name:"partials_idx",semantic:"partials_idx",buffer:{type:"storage"},elementType:"u32"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"rows",type:"u32",value:"outputCount"},{name:"chunkCount",type:"u32",value:"axisDim / 4"}]}}],splitCombine:[{name:"partials_val",semantic:"partials_val",buffer:{type:"read-only-storage"},elementType:"u32"},{name:"partials_idx",semantic:"partials_idx",buffer:{type:"read-only-storage"},elementType:"u32"},{name:"y",arg:"y",semantic:"reduced",buffer:{type:"storage"},elementType:"u32"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"outputCount",type:"u32",value:"outputCount"}]}}]},variants:[{id:"last_axis_split_vec4",priority:41,when:["baseContract","rowParallelType","lastAxis","axisDim >= tunables.ROW_SPLIT_MIN_AXIS","axisDim % 4 == 0","outputCount <= tunables.ROW_SPLIT_MAX_OUTPUTS","rowSplitScratchFits","rowSplitDispatchFits","rowStorageFits"],constants:{scalar:"dtypes.T",vectorScalar:'"vec4<" ~ dtypes.T ~ ">"',usesF16:'dtypes.T == "f16"',selectLastIndex:"attrs.select_last_index != 0",workgroupSize:"workgroupSize",split:"rowSplitCount"},intermediates:[{id:"partials_val",dtype:"uint32",shape:"[rowSplitCount * outputCount]"},{id:"partials_idx",dtype:"uint32",shape:"[rowSplitCount * outputCount]"}],passes:[{id:"split_reduce",name:"ArgMax.LastAxisSplitVec4Reduce",source:{shader:"ops/_shared/reduce-arg-row-split.wgsl.jinja",inputs:{mode:'"max"',vec4:!0,useSubgroups:'device.features.has("subgroups")'}},bindings:"rowSplitVec4",dispatch:{x:"outputCount",y:"rowSplitCount"}},{id:"combine",name:"ArgMax.LastAxisSplitCombine",source:{shader:"ops/_shared/reduce-arg-axis-split-combine.wgsl.jinja",inputs:{mode:'"max"'}},bindings:"splitCombine",dispatch:{threads:"outputCount",workgroupSize:"workgroupSize"}}]},{id:"last_axis_vec4",priority:40,when:["baseContract","rowParallelType","lastAxis","axisDim >= 4","axisDim % 4 == 0","parallelRowWorthwhile","rowDispatchFits","rowStorageFits"],constants:{scalar:"dtypes.T",vectorScalar:'"vec4<" ~ dtypes.T ~ ">"',usesF16:'dtypes.T == "f16"',selectLastIndex:"attrs.select_last_index != 0",workgroupSize:"min(workgroupSize, max(32, pow2ceil(ceilDiv(axisDim, 4))))"},passes:[{id:"main",name:"ArgMax.LastAxisVec4",source:{shader:"ops/_shared/reduce-arg-row-subgroup.wgsl.jinja",inputs:{mode:'"max"',vec4:!0,useSubgroups:'device.features.has("subgroups")'}},bindings:"contiguousVec4",dispatch:{workgroups:"outputCount"}}]},{id:"axis_serial",priority:0,when:["baseContract","threadDispatchFits"],constants:{scalar:"dtypes.T",usesF16:'dtypes.T == "f16"',selectLastIndex:"attrs.select_last_index != 0",workgroupSize:"workgroupSize"},passes:[{id:"main",name:"ArgMax.AxisSerial",source:{shader:"ops/_shared/reduce-arg-axis.wgsl.jinja",inputs:{mode:'"max"'}},bindings:"axisGeometry",dispatch:{threads:"outputCount",workgroupSize:"workgroupSize"}}]}]},assets:[]}],["ai.onnx.Mul",{manifest:{domain:"ai.onnx",name:"Mul",sinceVersion:14,inputs:[{role:"A",dtype:"T"},{role:"B",dtype:"T"}],outputs:[{role:"C",dtype:"T"}],typeConstraints:{T:["float32","float16","int32","uint32","int8","uint8"]},args:{a:{kind:"tensor",semantic:"A",role:"input"},b:{kind:"tensor",semantic:"B",role:"input"},c:{kind:"tensor",semantic:"C",role:"output"}},tunables:{WORKGROUP_SIZE:256},variants:[{id:"same_shape_vec4",priority:20,when:["sameShape(shapes.A, shapes.C)","sameShape(shapes.B, shapes.C)","numel(shapes.C) > 0","numel(shapes.C) % 4 == 0","f16Ok(dtypes.T)"],constants:{scalar:"dtypes.T",vectorScalar:'"vec4<" ~ dtypes.T ~ ">"',usesF16:'dtypes.T == "f16"'},passes:[{id:"main",name:"Mul.vec4",source:{shader:"ops/_shared/binary-vec4.wgsl.jinja",inputs:{op:'"mul"',cDtype:"tensorDtypes.C"}},bindings:[{name:"a",arg:"a",semantic:"A",buffer:{type:"read-only-storage"},elementType:"$vectorScalar"},{name:"b",arg:"b",semantic:"B",buffer:{type:"read-only-storage"},elementType:"$vectorScalar"},{name:"c",arg:"c",semantic:"C",buffer:{type:"storage"},elementType:"$vectorScalar"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"count",type:"u32",value:"numel(shapes.C) / 4"}]}}],dispatch:{threads:"numel(shapes.C) / 4",workgroupSize:"tunables.WORKGROUP_SIZE"}}]},{id:"broadcast_vec4",when:["ranks.A <= ranks.C","ranks.B <= ranks.C","ranks.C >= 1","ranks.C <= 7","numel(shapes.C) % 4 == 0","numel(shapes.C) >= 4","f16Ok(dtypes.T)"],constants:{scalar:"dtypes.T",aElement:'"vec4<" ~ dtypes.T ~ ">" if sameShape(shapes.A, shapes.C) else dtypes.T',bElement:'"vec4<" ~ dtypes.T ~ ">" if sameShape(shapes.B, shapes.C) else dtypes.T',vec4Scalar:'"vec4<" ~ dtypes.T ~ ">"',usesF16:'dtypes.T == "f16"'},passes:[{id:"main",name:"Mul",source:{shader:"ops/_shared/binary-broadcast-vec4.wgsl.jinja",inputs:{aShape:"shapes.A",bShape:"shapes.B",cShape:"shapes.C",aRank:"ranks.A",bRank:"ranks.B",cRank:"ranks.C",op:'"mul"',cDtype:"tensorDtypes.C"}},bindings:[{name:"a",arg:"a",semantic:"A",buffer:{type:"read-only-storage"},elementType:"$aElement"},{name:"b",arg:"b",semantic:"B",buffer:{type:"read-only-storage"},elementType:"$bElement"},{name:"c",arg:"c",semantic:"C",buffer:{type:"storage"},elementType:"$vec4Scalar"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"count",type:"u32",value:"numel(shapes.C) / 4"}]}}],dispatch:{threads:"numel(shapes.C) / 4",workgroupSize:"tunables.WORKGROUP_SIZE"}}],priority:10},{id:"broadcast",when:["ranks.A <= ranks.C","ranks.B <= ranks.C","ranks.C <= 7","f16Ok(dtypes.T)"],constants:{scalar:"dtypes.T",usesF16:'dtypes.T == "f16"'},passes:[{id:"main",name:"Mul",source:{shader:"ops/_shared/binary-broadcast.wgsl.jinja",inputs:{aShape:"shapes.A",bShape:"shapes.B",cShape:"shapes.C",aRank:"ranks.A",bRank:"ranks.B",cRank:"ranks.C",op:'"mul"',cDtype:"tensorDtypes.C"}},bindings:[{name:"a",arg:"a",semantic:"A",buffer:{type:"read-only-storage"},elementType:"$scalar"},{name:"b",arg:"b",semantic:"B",buffer:{type:"read-only-storage"},elementType:"$scalar"},{name:"c",arg:"c",semantic:"C",buffer:{type:"storage"},elementType:"$scalar"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"count",type:"u32",value:"numel(shapes.C)"}]}}],dispatch:{threads:"numel(shapes.C)",workgroupSize:"tunables.WORKGROUP_SIZE"}}]}]},assets:[]}],["ai.onnx.Sigmoid",{manifest:{domain:"ai.onnx",name:"Sigmoid",sinceVersion:13,inputs:[{role:"X",dtype:"T"}],outputs:[{role:"Y",dtype:"T"}],typeConstraints:{T:["float32","float16"]},args:{x:{kind:"tensor",semantic:"X",role:"input"},y:{kind:"tensor",semantic:"Y",role:"output"}},tunables:{WORKGROUP_SIZE:256},variants:[{id:"same_layout_vec4",when:["numel(shapes.X) > 0","numel(shapes.X) % 4 == 0","numel(shapes.X) == numel(shapes.Y)","f16Ok(dtypes.T)"],constants:{scalar:"dtypes.T",usesF16:'dtypes.T == "f16"',vectorScalar:'"vec4<" ~ dtypes.T ~ ">"'},passes:[{id:"main",name:"Sigmoid.vec4",source:{shader:"ops/_shared/unary-vec4.wgsl.jinja",inputs:{op:'"sigmoid"'}},bindings:[{name:"x",arg:"x",semantic:"X",buffer:{type:"read-only-storage"},elementType:"$vectorScalar"},{name:"y",arg:"y",semantic:"Y",buffer:{type:"storage"},elementType:"$vectorScalar"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"count",type:"u32",value:"numel(shapes.Y) / 4"}]}}],dispatch:{threads:"numel(shapes.Y) / 4",workgroupSize:"tunables.WORKGROUP_SIZE"}}],priority:20},{id:"scalar",when:["numel(shapes.X) == numel(shapes.Y)","f16Ok(dtypes.T)"],constants:{scalar:"dtypes.T",usesF16:'dtypes.T == "f16"'},passes:[{id:"main",name:"Sigmoid",source:{shader:"ops/_shared/unary-scalar.wgsl.jinja",inputs:{op:'"sigmoid"',itemsPerInvocation:4}},bindings:[{name:"x",arg:"x",semantic:"X",buffer:{type:"read-only-storage"},elementType:"$scalar"},{name:"y",arg:"y",semantic:"Y",buffer:{type:"storage"},elementType:"$scalar"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"count",type:"u32",value:"numel(shapes.Y)"}]}}],dispatch:{threads:"ceilDiv(numel(shapes.Y), 4)",workgroupSize:"tunables.WORKGROUP_SIZE"}}]}]},assets:[]}],["ai.onnx.Tanh",{manifest:{domain:"ai.onnx",name:"Tanh",sinceVersion:13,inputs:[{role:"X",dtype:"T"}],outputs:[{role:"Y",dtype:"T"}],typeConstraints:{T:["float32","float16"]},args:{x:{kind:"tensor",semantic:"X",role:"input"},y:{kind:"tensor",semantic:"Y",role:"output"}},tunables:{WORKGROUP_SIZE:256},variants:[{id:"same_layout_vec4",when:["numel(shapes.X) > 0","numel(shapes.X) % 4 == 0","numel(shapes.X) == numel(shapes.Y)","f16Ok(dtypes.T)"],constants:{scalar:"dtypes.T",usesF16:'dtypes.T == "f16"',vectorScalar:'"vec4<" ~ dtypes.T ~ ">"'},passes:[{id:"main",name:"Tanh.vec4",source:{shader:"ops/_shared/unary-vec4.wgsl.jinja",inputs:{op:'"tanh"'}},bindings:[{name:"x",arg:"x",semantic:"X",buffer:{type:"read-only-storage"},elementType:"$vectorScalar"},{name:"y",arg:"y",semantic:"Y",buffer:{type:"storage"},elementType:"$vectorScalar"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"count",type:"u32",value:"numel(shapes.Y) / 4"}]}}],dispatch:{threads:"numel(shapes.Y) / 4",workgroupSize:"tunables.WORKGROUP_SIZE"}}],priority:20},{id:"scalar",when:["numel(shapes.X) == numel(shapes.Y)","f16Ok(dtypes.T)"],constants:{scalar:"dtypes.T",usesF16:'dtypes.T == "f16"'},passes:[{id:"main",name:"Tanh",source:{shader:"ops/_shared/unary-scalar.wgsl.jinja",inputs:{op:'"tanh"',itemsPerInvocation:4}},bindings:[{name:"x",arg:"x",semantic:"X",buffer:{type:"read-only-storage"},elementType:"$scalar"},{name:"y",arg:"y",semantic:"Y",buffer:{type:"storage"},elementType:"$scalar"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"count",type:"u32",value:"numel(shapes.Y)"}]}}],dispatch:{threads:"ceilDiv(numel(shapes.Y), 4)",workgroupSize:"tunables.WORKGROUP_SIZE"}}]}]},assets:[]}],["co.huggingface.GatedMlpActivation",{manifest:{domain:"co.huggingface",name:"GatedMlpActivation",sinceVersion:1,inputs:[{role:"X",dtype:"X",rank:2}],outputs:[{role:"Y",dtype:"Y",rank:2,shape:["args.rows","args.mlpInner"]}],typeConstraints:{X:["float32","float16"],Y:["float32","float16"]},tunables:{WG:256},args:{xT:{kind:"tensor",semantic:"X",role:"input"},yT:{kind:"tensor",semantic:"Y",role:"output"},rows:{kind:"u32",semantic:"rows"},mlpInner:{kind:"u32",semantic:"mlpInner"},activation:{kind:"string",semantic:"activation",required:!1,oneOf:["silu","fast_silu"]},split:{kind:"string",semantic:"split",required:!1,oneOf:["chunk","interleaved"]},clampLimit:{kind:"f32",semantic:"clampLimit",required:!1},alpha:{kind:"f32",semantic:"alpha",required:!1},upBias:{kind:"f32",semantic:"upBias",required:!1}},derive:{interleavedSplit:'args.split == "interleaved"',gluAlpha:"args.alpha if args.alpha is defined else 1",gluUpBias:"args.upBias if args.upBias is defined else 0",gluClamp:"args.clampLimit if args.clampLimit is defined else 0",hasClampArg:"args.clampLimit is defined",generalizedGlu:"interleavedSplit or hasClampArg or (gluAlpha != 1) or (gluUpBias != 0)"},bindingSets:{activation:[{name:"x",arg:"xT",semantic:"X",buffer:{type:"read-only-storage"},elementType:"$xElement"},{name:"y",arg:"yT",semantic:"Y",buffer:{type:"storage"},elementType:"$yElement"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"rows",type:"u32",value:"args.rows"}]}}]},variants:[{id:"scalar",priority:0,when:["ranks.xT == 2","ranks.yT == 2","args.rows == dim(shapes.xT, 0)","dim(shapes.xT, 1) == args.mlpInner * 2","dim(shapes.yT, 0) == args.rows","dim(shapes.yT, 1) == args.mlpInner","f16Ok(dtypes.X) and f16Ok(dtypes.Y)"],constants:{vectorized:!1,usesF16:'dtypes.X == "f16" or dtypes.Y == "f16"',fastSilu:'args.activation == "fast_silu"',interleaved:"interleavedSplit",generalized:"generalizedGlu",hasClamp:"hasClampArg",clampLimit:"gluClamp",alpha:"gluAlpha",upBias:"gluUpBias",xElement:"dtypes.X",yElement:"dtypes.Y",yScalar:"dtypes.Y",mlpInner:"args.mlpInner",wg:"tunables.WG"},passes:[{id:"main",name:"GatedMlpActivation",shader:"gated-mlp-activation.wgsl.jinja",bindings:"activation",dispatch:{workgroups:"args.rows",y:"ceil(args.mlpInner / tunables.WG)"}}]},{id:"vec4_f32",priority:10,when:['dtypes.X == "f32"','dtypes.Y == "f32"',"f16Ok(dtypes.X)","args.mlpInner % 4 == 0","ranks.xT == 2","ranks.yT == 2","args.rows == dim(shapes.xT, 0)","dim(shapes.xT, 1) == args.mlpInner * 2","dim(shapes.yT, 0) == args.rows","dim(shapes.yT, 1) == args.mlpInner"],constants:{vectorized:!0,usesF16:'dtypes.X == "f16"',fastSilu:'args.activation == "fast_silu"',generalized:"generalizedGlu",hasClamp:"hasClampArg",clampLimit:"gluClamp",alpha:"gluAlpha",upBias:"gluUpBias",xElement:'"vec4<" ~ dtypes.X ~ ">"',yElement:'"vec4<" ~ dtypes.Y ~ ">"',yScalar:"dtypes.Y",mlpInnerV4:"args.mlpInner / 4",wg:"tunables.WG",interleaved:"interleavedSplit"},passes:[{id:"main",name:"GatedMlpActivation",shader:"gated-mlp-activation.wgsl.jinja",bindings:"activation",dispatch:{workgroups:"args.rows",y:"ceil((args.mlpInner / 4) / tunables.WG)"}}]}]},assets:[["gated-mlp-activation.wgsl.jinja",`{% if usesF16 %}
enable f16;
{% endif %}
{{ env.wgsl.resourceDeclarations }}
{% if vectorized %}
const MLP_V4: u32 = {{ mlpInnerV4 }}u;
{% else %}
const MLP: u32 = {{ mlpInner }}u;
{% endif %}
const WG: u32 = {{ wg }}u;
@compute @workgroup_size(WG, 1, 1)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {

  let r = wg.x + wg.z * nwg.x;
  if (r >= params.rows) {
    return;
  }
  let i0 = wg.y * WG + lid.x;
{% if vectorized %}
  if (i0 >= MLP_V4) {
    return;
  }
  let row_base = r * 2u * MLP_V4;
{% if interleaved %}

  let pair_a = vec4<f32>(x[row_base + 2u * i0]);
  let pair_b = vec4<f32>(x[row_base + 2u * i0 + 1u]);
  let x1 = vec4<f32>(pair_a.x, pair_a.z, pair_b.x, pair_b.z);
  let x2 = vec4<f32>(pair_a.y, pair_a.w, pair_b.y, pair_b.w);
{% else %}
  let x1 = vec4<f32>(x[row_base + i0]);
  let x2 = vec4<f32>(x[row_base + MLP_V4 + i0]);
{% endif %}
{% if generalized %}

{% if hasClamp %}
  let g = min(x1, vec4<f32>({{ clampLimit }}));
  let u = clamp(x2, vec4<f32>(-{{ clampLimit }}), vec4<f32>({{ clampLimit }}));
{% else %}
  let g = x1;
  let u = x2;
{% endif %}
  let glu = g / (vec4<f32>(1.0) + exp(-g * vec4<f32>({{ alpha }})));
  y[r * MLP_V4 + i0] = {{ yElement }}((u + vec4<f32>({{ upBias }})) * glu);
{% elif fastSilu %}
  let sigmoid = vec4<f32>(0.5) + vec4<f32>(0.5) * x1 / (vec4<f32>(1.0) + abs(x1));
  y[r * MLP_V4 + i0] = {{ yElement }}((x1 * sigmoid) * x2);
{% else %}
  y[r * MLP_V4 + i0] = {{ yElement }}((x1 / (vec4<f32>(1.0) + exp(-x1))) * x2);
{% endif %}
{% else %}
  if (i0 >= MLP) {
    return;
  }
{% if interleaved %}

  let x1 = f32(x[r * 2u * MLP + 2u * i0]);
  let x2 = f32(x[r * 2u * MLP + 2u * i0 + 1u]);
{% else %}
  let x1 = f32(x[r * 2u * MLP + i0]);
  let x2 = f32(x[r * 2u * MLP + MLP + i0]);
{% endif %}
{% if generalized %}
{% if hasClamp %}
  let g = min(x1, f32({{ clampLimit }}));
  let u = clamp(x2, f32(-{{ clampLimit }}), f32({{ clampLimit }}));
{% else %}
  let g = x1;
  let u = x2;
{% endif %}
  let glu = g / (1.0 + exp(-g * f32({{ alpha }})));
  y[r * MLP + i0] = {{ yScalar }}((u + f32({{ upBias }})) * glu);
{% elif fastSilu %}
  let sigmoid = 0.5 + 0.5 * x1 / (1.0 + abs(x1));
  y[r * MLP + i0] = {{ yScalar }}((x1 * sigmoid) * x2);
{% else %}
  y[r * MLP + i0] = {{ yScalar }}((x1 / (1.0 + exp(-x1))) * x2);
{% endif %}
{% endif %}
}
`]]}],["co.huggingface.RMSNorm",{manifest:{domain:"co.huggingface",name:"RMSNorm",sinceVersion:1,inputs:[{role:"X",dtype:"X"},{role:"W",dtype:"W",rank:1,optional:!0}],outputs:[{role:"Y",dtype:"Y",shape:"shapes.xT"}],typeConstraints:{X:["float32","float16"],W:["float32","float16"],Y:["float32","float16"]},tunables:{WG_CAP:256,ROW_WG:64},args:{xT:{kind:"tensor",semantic:"X",role:"input"},wT:{kind:"tensor",semantic:"W",role:"weights",required:!1},yT:{kind:"tensor",semantic:"Y",role:"output"},rows:{kind:"u32",semantic:"rows"},dim:{kind:"u32",semantic:"dim"},eps:{kind:"f32",semantic:"eps",required:!1},weightBaseOffset:{kind:"u32",semantic:"weight_base_offset",required:!1},weightOffset:{kind:"u32",semantic:"weight_offset",required:!1},castBeforeScale:{kind:"bool",semantic:"cast_before_scale",required:!1},exact:{kind:"u32",semantic:"exact_reference_order",required:!1}},derive:{wave32Adapter:'has(device.adapterInfo, "subgroupMinSize") and has(device.adapterInfo, "subgroupMaxSize") and device.adapterInfo.subgroupMinSize == 32 and device.adapterInfo.subgroupMaxSize == 32',subgroupsWave32:'device.features.has("subgroups") and wave32Adapter',narrowSubgroupRange:'has(device.adapterInfo, "subgroupMinSize") and has(device.adapterInfo, "subgroupMaxSize") and device.adapterInfo.subgroupMinSize < device.adapterInfo.subgroupMaxSize and device.adapterInfo.subgroupMaxSize <= 16',subgroupsWide32:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize >= 32',reportedNonWave32Adapter:'not wave32Adapter and (has(device.adapterInfo, "subgroupMinSize") or has(device.adapterInfo, "subgroupMaxSize"))',normWgCap:"tunables.WG_CAP if subgroupsWide32 else min(128, tunables.WG_CAP)",normWg:"min(normWgCap, max(32, pow2ceil(args.dim / 8)))",normMaxSubgroups:"max(1, normWg / 32)",weightPlusOne:"args.weightOffset == 1",applyCastBeforeScale:'(args.castBeforeScale == true) and present.wT and (dtypes.Y != "f32")',arenaMode:"args.weightBaseOffset is defined and (not args.exact) and (not args.weightOffset) and (not args.castBeforeScale) and present.wT and args.dim > 0",arenaDecodeContract:'arenaMode and ranks.xT == 1 and ranks.wT == 1 and ranks.yT == 1 and tensorDtypes.xT == "float32" and (tensorDtypes.wT == "float32" or tensorDtypes.wT == "float16") and f16Ok(dtypes.W) and f16Ok(dtypes.Y) and args.rows == 1 and args.dim % 4 == 0 and args.weightBaseOffset % 4 == 0 and dim(shapes.xT, 0) == args.dim and dim(shapes.yT, 0) == args.dim and dim(shapes.wT, 0) >= args.weightBaseOffset + args.dim',arenaRowsContract:'arenaMode and ranks.xT == 2 and ranks.wT == 1 and ranks.yT == 2 and (tensorDtypes.xT == "float32" or tensorDtypes.xT == "float16") and (tensorDtypes.wT == "float32" or tensorDtypes.wT == "float16") and f16Ok(dtypes.X) and f16Ok(dtypes.W) and f16Ok(dtypes.Y) and args.rows > 0 and numel(shapes.xT) >= args.rows * args.dim and numel(shapes.wT) >= args.weightBaseOffset + args.dim and numel(shapes.yT) >= args.rows * args.dim'},bindingSets:{weightedVec4:[{name:"x",arg:"xT",semantic:"X",buffer:{type:"read-only-storage"},elementType:"$xVec4"},{name:"scale",arg:"wT",semantic:"W",buffer:{type:"read-only-storage"},elementType:"$wVec4"},{name:"y",arg:"yT",semantic:"Y",buffer:{type:"storage"},elementType:"$yVec4"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"rows",type:"u32",value:"args.rows"},{name:"rowStride",type:"u32",value:"max(1, min(args.rows, device.limits.maxComputeWorkgroupsPerDimension))"}]}}],rowWeighted:[{name:"x",arg:"xT",semantic:"X",buffer:{type:"read-only-storage"},elementType:"$xScalar"},{name:"w",arg:"wT",semantic:"W",buffer:{type:"read-only-storage"},elementType:"$wScalar"},{name:"y",arg:"yT",semantic:"Y",buffer:{type:"storage"},elementType:"$yScalar"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"rows",type:"u32",value:"args.rows"},{name:"rowStride",type:"u32",value:"min(args.rows, device.limits.maxComputeWorkgroupsPerDimension)"}]}}],rowUnweighted:[{name:"x",arg:"xT",semantic:"X",buffer:{type:"read-only-storage"},elementType:"$xScalar"},{name:"y",arg:"yT",semantic:"Y",buffer:{type:"storage"},elementType:"$yScalar"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"rows",type:"u32",value:"args.rows"},{name:"rowStride",type:"u32",value:"min(args.rows, device.limits.maxComputeWorkgroupsPerDimension)"}]}}]},variants:[{id:"weighted_vec4",priority:14,when:["args.weightBaseOffset is undefined","not args.exact","present.wT","ranks.wT == 1","dim(shapes.wT, 0) == args.dim","args.rows >= 0","args.dim > 0","args.dim % 4 == 0","numel(shapes.xT) >= args.rows * args.dim","numel(shapes.yT) >= args.rows * args.dim","f16Ok(dtypes.X) and f16Ok(dtypes.W) and f16Ok(dtypes.Y)"],constants:{xVec4:'"vec4<f16>" if dtypes.X == "f16" else "vec4<f32>"',wVec4:'"vec4<f16>" if dtypes.W == "f16" else "vec4<f32>"',yVec4:'"vec4<f16>" if dtypes.Y == "f16" else "vec4<f32>"'},passes:[{id:"main",name:"RMSNorm",source:{shader:"ops/_shared/norm-row-stats.wgsl.jinja",inputs:{mode:'"rms"',vec4:!0,scalar:"dtypes.Y",usesF16:'dtypes.X == "f16" or dtypes.W == "f16" or dtypes.Y == "f16"',hidden:"args.dim",hiddenVec:"args.dim / 4",wg:"normWg",maxSubgroups:"normMaxSubgroups",epsilon:"args.eps if args.eps is defined else 0.000001",vecType:'"vec4<" ~ dtypes.Y ~ ">"',combineSubgroups:"subgroupsWide32",rmsWeightOffset:"weightPlusOne",rmsScaleAfterCast:"applyCastBeforeScale"}},bindings:"weightedVec4",dispatch:{workgroups:"args.rows"}}]},{id:"unweighted",priority:0,when:"args.weightBaseOffset is undefined and (not args.exact) and (not present.wT and args.rows >= 0 and args.dim > 0 and numel(shapes.xT) >= args.rows * args.dim and numel(shapes.yT) >= args.rows * args.dim and f16Ok(dtypes.X) and f16Ok(dtypes.Y))",constants:{hasWeight:!1,weightPlusOne:!1,castBeforeScale:!1,xScalar:"dtypes.X",yScalar:"dtypes.Y",usesF16:'dtypes.X == "f16" or dtypes.Y == "f16"',dim:"args.dim",eps:"args.eps if args.eps is defined else 0.000001",rowWg:"tunables.ROW_WG"},passes:[{id:"main",name:"RMSNorm",shader:"rms-norm.wgsl.jinja",bindings:"rowUnweighted",dispatch:{workgroups:"args.rows"}}]},{id:"weighted",priority:10,when:"args.weightBaseOffset is undefined and (not args.exact) and (present.wT and ranks.wT == 1 and args.rows >= 0 and args.dim > 0 and numel(shapes.xT) >= args.rows * args.dim and dim(shapes.wT, 0) == args.dim and numel(shapes.yT) >= args.rows * args.dim and f16Ok(dtypes.X) and f16Ok(dtypes.W) and f16Ok(dtypes.Y))",constants:{usesF16:'dtypes.X == "f16" or dtypes.W == "f16" or dtypes.Y == "f16"',hasWeight:!0,weightPlusOne:"weightPlusOne",castBeforeScale:"applyCastBeforeScale",xScalar:"dtypes.X",wScalar:"dtypes.W",yScalar:"dtypes.Y",dim:"args.dim",eps:"args.eps if args.eps is defined else 0.000001",rowWg:"tunables.ROW_WG"},passes:[{id:"main",name:"RMSNorm",shader:"rms-norm.wgsl.jinja",bindings:"rowWeighted",dispatch:{workgroups:"args.rows"}}]}]},assets:[["rms-norm.wgsl.jinja",`{% if usesF16 %}
enable f16;
{% endif %}
{{ env.wgsl.resourceDeclarations }}

const DIM: u32 = {{ dim }}u;
const EPS: f32 = {{ eps }};
const WG: u32 = {{ rowWg }}u;

var<workgroup> partial: array<f32, WG>;

{% include "ops/_shared/reduce-sum.wgsl.jinja" %}

@compute @workgroup_size(WG, 1, 1)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let rowStride = select(params.rowStride, params.rows, params.rowStride == 0u);
  let row = wg.x + wg.y * rowStride;
  if (row >= params.rows) {
    return;
  }
  let tid = lid.x;
  let base = row * DIM;

  var acc: f32 = 0.0;
  var i: u32 = tid;
  loop {
    if (i >= DIM) {
      break;
    }
    let v = f32(x[base + i]);
    acc = acc + v * v;
    i = i + WG;
  }
  let scale = inverseSqrt(reduce_sum(acc, tid) / f32(DIM) + EPS);

  var j: u32 = tid;
  loop {
    if (j >= DIM) {
      break;
    }
    let xv = f32(x[base + j]);
{% if hasWeight %}
{% if weightPlusOne %}

    let wv = 1.0 + f32(w[j]);
{% else %}
    let wv = f32(w[j]);
{% endif %}
{% if castBeforeScale %}

    y[base + j] = {{ yScalar }}(xv * scale) * {{ yScalar }}(wv);
{% else %}
    y[base + j] = {{ yScalar }}(xv * scale * wv);
{% endif %}
{% else %}
    y[base + j] = {{ yScalar }}(xv * scale);
{% endif %}
    j = j + WG;
  }
}
`]]}],["co.huggingface.RopeApply",{manifest:{domain:"co.huggingface",name:"RopeApply",sinceVersion:1,inputs:[{role:"X",dtype:"T"},{role:"Cos",dtype:"float32",rank:2},{role:"Sin",dtype:"float32",rank:2}],outputs:[{role:"X",dtype:"T",shape:"shapes.xT"}],typeConstraints:{T:["float32","float16"]},tunables:{WG:128},args:{xT:{kind:"tensor",semantic:"X",role:"inout"},cosT:{kind:"tensor",semantic:"Cos",role:"input"},sinT:{kind:"tensor",semantic:"Sin",role:"input"},seq:{kind:"u32",semantic:"seq"},heads:{kind:"u32",semantic:"heads"},headDim:{kind:"u32",semantic:"headDim"},rotaryDim:{kind:"u32",semantic:"rotaryDim",required:!1},layout:{kind:"string",semantic:"layout",required:!1,oneOf:["half","interleaved"]},exact:{kind:"u32",semantic:"exact_reference_order",required:!1}},derive:{rotaryWidth:"args.rotaryDim if args.rotaryDim else args.headDim",rotaryPairs:"rotaryWidth / 2",interleaved:'args.layout == "interleaved"',rotaryGroups:"rotaryPairs / 4",vec4Ok:"(args.headDim % 4 == 0) and (rotaryPairs % 4 == 0)"},bindingSets:{rope:[{name:"q",arg:"xT",semantic:"X",buffer:{type:"storage"},elementType:"$T"},{name:"cosTbl",arg:"cosT",semantic:"Cos",buffer:{type:"read-only-storage"},elementType:"f32"},{name:"sinTbl",arg:"sinT",semantic:"Sin",buffer:{type:"read-only-storage"},elementType:"f32"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"seq",type:"u32",value:"args.seq"},{name:"heads",type:"u32",value:"args.heads"}]}}],ropeVec4:[{name:"q",arg:"xT",semantic:"X",buffer:{type:"storage"},elementType:"$TVec4"},{name:"cosTbl",arg:"cosT",semantic:"Cos",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"sinTbl",arg:"sinT",semantic:"Sin",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"seq",type:"u32",value:"args.seq"},{name:"heads",type:"u32",value:"args.heads"}]}}]},variants:[{id:"rope",priority:0,when:'(not args.exact) and (ranks.cosT == 2 and ranks.sinT == 2 and args.seq >= 0 and args.heads > 0 and args.headDim > 0 and rotaryWidth > 0 and rotaryWidth % 2 == 0 and rotaryWidth <= args.headDim and numel(shapes.xT) >= args.seq * args.heads * args.headDim and dim(shapes.cosT, 0) >= args.seq and dim(shapes.sinT, 0) >= args.seq and dim(shapes.cosT, 1) == rotaryPairs and dim(shapes.sinT, 1) == rotaryPairs and tensorDtypes.cosT == "float32" and tensorDtypes.sinT == "float32" and (f16Ok(dtypes.T)))',constants:{layout:'"interleaved" if interleaved else "split-half"',activationScalar:"dtypes.T",usesF16:'dtypes.T == "f16"',headDim:"args.headDim",halfDim:"rotaryPairs",workgroupSize:"min(tunables.WG, rotaryPairs)",EXACT:0},passes:[{id:"main",name:"RopeApply",shader:"rope-apply.wgsl.jinja",bindings:"rope",dispatch:{workgroups:"args.seq",y:"args.heads"}}]},{id:"rope_vec4",priority:20,when:'(not args.exact) and (ranks.cosT == 2 and ranks.sinT == 2 and args.seq >= 0 and args.heads > 0 and args.headDim > 0 and rotaryWidth > 0 and rotaryWidth % 2 == 0 and rotaryWidth <= args.headDim and numel(shapes.xT) >= args.seq * args.heads * args.headDim and dim(shapes.cosT, 0) >= args.seq and dim(shapes.sinT, 0) >= args.seq and dim(shapes.cosT, 1) == rotaryPairs and dim(shapes.sinT, 1) == rotaryPairs and tensorDtypes.cosT == "float32" and tensorDtypes.sinT == "float32" and (f16Ok(dtypes.T))) and vec4Ok',constants:{layout:'"interleaved" if interleaved else "split-half"',activationScalar:"dtypes.T",usesF16:'dtypes.T == "f16"',headDim:"args.headDim",halfDim:"rotaryPairs",workgroupSize:"tunables.WG",EXACT:0,vectorized:!0,headDimV:"args.headDim / 4",halfDimV:"rotaryGroups",vecType:'"vec4<" ~ dtypes.T ~ ">"',TVec4:'"vec4<f16>" if dtypes.T == "f16" else "vec4<f32>"'},passes:[{id:"main",name:"RopeApply.Vec4",shader:"rope-apply.wgsl.jinja",bindings:"ropeVec4",dispatch:{threads:"args.seq * args.heads * rotaryGroups",workgroupSize:"tunables.WG"}}]}]},assets:[["rope-apply.wgsl.jinja",`{% if usesF16 %}
enable f16;
{% endif %}
{{ env.wgsl.resourceDeclarations }}

const HEAD_DIM: u32 = {{ headDim }}u;
const HALF_DIM: u32 = {{ halfDim }}u;
{% if vectorized %}
const HEAD_DIM_V: u32 = {{ headDimV }}u;
const HALF_DIM_V: u32 = {{ halfDimV }}u;
{% endif %}
const WG: u32 = {{ workgroupSize }}u;

{% if vectorized %}
@compute @workgroup_size(WG, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let total = params.seq * params.heads * HALF_DIM_V;
  let i = gid.x + gid.y * nwg.x * WG;
  if (i >= total) {
    return;
  }
  let k = i % HALF_DIM_V;
  let th = i / HALF_DIM_V;
  let t = th / params.heads;
  let qBase = th * HEAD_DIM_V;
  let cs = t * HALF_DIM_V + k;
  let c = cosTbl[cs];
  let s = sinTbl[cs];
{% if layout == "interleaved" %}

  let ia = qBase + 2u * k;
  let a = vec4<f32>(q[ia]);
  let b = vec4<f32>(q[ia + 1u]);
  let x0 = vec4<f32>(a.x, a.z, b.x, b.z);
  let x1 = vec4<f32>(a.y, a.w, b.y, b.w);
  let r0 = x0 * c - x1 * s;
  let r1 = x1 * c + x0 * s;
  q[ia] = {{ vecType }}(vec4<f32>(r0.x, r1.x, r0.y, r1.y));
  q[ia + 1u] = {{ vecType }}(vec4<f32>(r0.z, r1.z, r0.w, r1.w));
{% else %}
  let i0 = qBase + k;
  let i1 = i0 + HALF_DIM_V;
  let x0 = vec4<f32>(q[i0]);
  let x1 = vec4<f32>(q[i1]);
  q[i0] = {{ vecType }}(x0 * c - x1 * s);
  q[i1] = {{ vecType }}(x1 * c + x0 * s);
{% endif %}
}
{% else %}
@compute @workgroup_size(WG, 1, 1)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {

  let t = wg.x + wg.z * nwg.x;
  let h = wg.y;
  if (t >= params.seq || h >= params.heads) {
    return;
  }
  let tid = lid.x;
  let qBase = (t * params.heads + h) * HEAD_DIM;
  let csBase = t * HALF_DIM;

  var k: u32 = tid;
  loop {
    if (k >= HALF_DIM) {
      break;
    }
    let c = cosTbl[csBase + k];
    let s = sinTbl[csBase + k];
{% if layout == "interleaved" %}

    let i0 = qBase + 2u * k;
    let x0 = f32(q[i0]);
    let x1 = f32(q[i0 + 1u]);
{% if EXACT %}
    q[i0] = {{ activationScalar }}(fma(x0, c, 0.0) + fma(-x1, s, 0.0));
    q[i0 + 1u] = {{ activationScalar }}(fma(x1, c, 0.0) + fma(x0, s, 0.0));
{% else %}
    q[i0] = {{ activationScalar }}(x0 * c - x1 * s);
    q[i0 + 1u] = {{ activationScalar }}(x1 * c + x0 * s);
{% endif %}
{% else %}
    let x0 = f32(q[qBase + k]);
    let x1 = f32(q[qBase + k + HALF_DIM]);
{% if EXACT %}

    q[qBase + k] = {{ activationScalar }}(fma(x0, c, 0.0) + fma(-x1, s, 0.0));
    q[qBase + k + HALF_DIM] = {{ activationScalar }}(fma(x1, c, 0.0) + fma(x0, s, 0.0));
{% else %}
    q[qBase + k] = {{ activationScalar }}(x0 * c - x1 * s);
    q[qBase + k + HALF_DIM] = {{ activationScalar }}(x1 * c + x0 * s);
{% endif %}
{% endif %}
    k = k + WG;
  }
}
{% endif %}
`]]}],["com.microsoft.GroupQueryAttention",{manifest:{domain:"com.microsoft",name:"GroupQueryAttention",sinceVersion:1,inputs:[{role:"query",rank:3},{role:"key",rank:3},{role:"value",rank:3},{role:"past_key",rank:4,optional:!0},{role:"past_value",rank:4,optional:!0},{role:"seqlens_k",rank:1,optional:!0},{role:"total_sequence_length",rank:1,optional:!0},{role:"cos_cache",rank:2,optional:!0},{role:"sin_cache",rank:2,optional:!0},{role:"position_ids",rank:2,optional:!0},{role:"q_norm_weight",rank:1,optional:!0},{role:"k_norm_weight",rank:1,optional:!0},{role:"k_scale",rank:1,optional:!0},{role:"v_scale",rank:1,optional:!0},{role:"attention_bias",rank:4,optional:!0},{role:"head_sink",rank:1,optional:!0}],outputs:[{role:"output",rank:3},{role:"present_key",rank:4},{role:"present_value",rank:4}],args:{queryT:{kind:"tensor",semantic:"query",role:"input"},keyT:{kind:"tensor",semantic:"key",role:"input"},valueT:{kind:"tensor",semantic:"value",role:"input"},outputT:{kind:"tensor",semantic:"output",role:"output"},presentKeyT:{kind:"tensor",semantic:"present_key",role:"output"},presentValueT:{kind:"tensor",semantic:"present_value",role:"output"},numHeads:{kind:"u32",semantic:"num_heads"},kvNumHeads:{kind:"u32",semantic:"kv_num_heads"},scale:{kind:"f32",semantic:"scale",required:!1},localWindowSize:{kind:"u32",semantic:"local_window_size",required:!1},pastKeyT:{kind:"tensor",semantic:"past_key",role:"input",required:!1},pastValueT:{kind:"tensor",semantic:"past_value",role:"input",required:!1},seqlensKT:{kind:"tensor",semantic:"seqlens_k",role:"input",required:!1},totalSequenceLengthT:{kind:"tensor",semantic:"total_sequence_length",role:"input",required:!1},cosCacheT:{kind:"tensor",semantic:"cos_cache",role:"input",required:!1},sinCacheT:{kind:"tensor",semantic:"sin_cache",role:"input",required:!1},positionIdsT:{kind:"tensor",semantic:"position_ids",role:"input",required:!1},qNormWeightT:{kind:"tensor",semantic:"q_norm_weight",role:"input",required:!1},kNormWeightT:{kind:"tensor",semantic:"k_norm_weight",role:"input",required:!1},kScaleT:{kind:"tensor",semantic:"k_scale",role:"input",required:!1},vScaleT:{kind:"tensor",semantic:"v_scale",role:"input",required:!1},doRotary:{kind:"u32",semantic:"do_rotary",required:!1},rotaryInterleaved:{kind:"u32",semantic:"rotary_interleaved",required:!1},smoothSoftmax:{kind:"u32",semantic:"smooth_softmax",required:!1},softcap:{kind:"f32",semantic:"softcap",required:!1},qkNormEpsilon:{kind:"f32",semantic:"qk_norm_epsilon",required:!1},slidingWindowCache:{kind:"u32",semantic:"sliding_window_cache",required:!1},kvCacheBitWidth:{kind:"u32",semantic:"kv_cache_bit_width",required:!1},attentionBiasT:{kind:"tensor",semantic:"attention_bias",role:"input",required:!1},headSinkT:{kind:"tensor",semantic:"head_sink",role:"input",required:!1}},tunables:{WORKGROUP_SIZE:256,COPY_WORKGROUP_SIZE:64,SCALAR_WORKGROUP_SIZE:64,COOPERATIVE_QUERY_THRESHOLD:6144,MAX_SPLITS:16,QKV_SPLIT_TILE_K:128,CACHED_SPLIT_TILE_K:256,FLASH_MIN_HEAD_DIM:32,FLASH_MAX_HEAD_DIM:256,PREFILL_QUERY_TILE:32,PREFILL_LANES_PER_QUERY:4,PREFILL_QUERY_TILE_F16:16,PREFILL_LANES_PER_QUERY_F16:8,QKV_PREFILL_MIN_QUERY_TOKENS:31,QKV_DECODE_MIN_KV_TOKENS:512,CACHED_FLASH_MIN_HEAD_DIM:64,CACHED_DECODE_MIN_KV_TOKENS:1024,CLUSTER_TILE_K_F32:8,CLUSTER_TILE_K_F16:8,NO_SG_TILE_K_MAX:16,COOPERATIVE_WORKGROUP_SIZE:32,REQUIRED_SUBGROUP_SIZE:32,CLUSTER_MAX_SLICE:8},derive:{deviceWorkgroupCap:"min(device.limits.maxComputeInvocationsPerWorkgroup, device.limits.maxComputeWorkgroupSizeX)",wave32Adapter:'has(device.adapterInfo, "subgroupMinSize") and has(device.adapterInfo, "subgroupMaxSize") and device.adapterInfo.subgroupMinSize == 32 and device.adapterInfo.subgroupMaxSize == 32',subgroupsWave32:'device.features.has("subgroups") and wave32Adapter',narrowSubgroupRange:'has(device.adapterInfo, "subgroupMinSize") and has(device.adapterInfo, "subgroupMaxSize") and device.adapterInfo.subgroupMinSize < device.adapterInfo.subgroupMaxSize and device.adapterInfo.subgroupMaxSize <= 16',subgroupsWide32:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize >= 32',reportedNonWave32Adapter:'not wave32Adapter and (has(device.adapterInfo, "subgroupMinSize") or has(device.adapterInfo, "subgroupMaxSize"))',windowCacheRequested:"args.slidingWindowCache > 0 if args.slidingWindowCache else false",headDim:"dim(shapes.query, 2) / args.numHeads if (ranks.query == 3 and args.numHeads > 0) else 0",copyWorkgroupSize:"min(tunables.COPY_WORKGROUP_SIZE, min(device.limits.maxComputeInvocationsPerWorkgroup, device.limits.maxComputeWorkgroupSizeX))",scalarWorkgroupSize:"min(tunables.SCALAR_WORKGROUP_SIZE, min(device.limits.maxComputeInvocationsPerWorkgroup, device.limits.maxComputeWorkgroupSizeX))",copyWorkgroupOk:"copyWorkgroupSize >= 1",scalarWorkgroupOk:"scalarWorkgroupSize >= 1",qkvContractOk:'not windowCacheRequested and copyWorkgroupOk and (not present.seqlensKT) and (not present.pastKeyT) and ranks.query == 3 and ranks.key == 3 and ranks.value == 3 and ranks.outputT == 3 and ranks.presentKeyT == 4 and ranks.presentValueT == 4 and (tensorDtypes.query == "float32" or (tensorDtypes.query == "float16" and device.features.has("shader-f16"))) and tensorDtypes.key == tensorDtypes.query and tensorDtypes.value == tensorDtypes.query and tensorDtypes.outputT == tensorDtypes.query and tensorDtypes.presentKeyT == tensorDtypes.query and tensorDtypes.presentValueT == tensorDtypes.query and args.numHeads > 0 and args.kvNumHeads > 0 and args.numHeads % args.kvNumHeads == 0 and dim(shapes.query, 2) % args.numHeads == 0 and dim(shapes.key, 2) == args.kvNumHeads * headDim and dim(shapes.value, 2) == dim(shapes.key, 2) and dim(shapes.query, 0) == dim(shapes.key, 0) and dim(shapes.query, 0) == dim(shapes.value, 0) and dim(shapes.key, 1) == dim(shapes.value, 1) and dim(shapes.outputT, 0) == dim(shapes.query, 0) and dim(shapes.outputT, 1) == dim(shapes.query, 1) and dim(shapes.outputT, 2) == dim(shapes.query, 2) and dim(shapes.presentKeyT, 0) == dim(shapes.query, 0) and dim(shapes.presentKeyT, 1) == args.kvNumHeads and dim(shapes.presentKeyT, 2) == dim(shapes.key, 1) and dim(shapes.presentKeyT, 3) == headDim and dim(shapes.presentValueT, 0) == dim(shapes.presentKeyT, 0) and dim(shapes.presentValueT, 1) == dim(shapes.presentKeyT, 1) and dim(shapes.presentValueT, 2) == dim(shapes.presentKeyT, 2) and dim(shapes.presentValueT, 3) == dim(shapes.presentKeyT, 3)',flashWorkgroupOk:"tunables.WORKGROUP_SIZE <= deviceWorkgroupCap",flashShapeOk:"qkvContractOk and flashWorkgroupOk and headDim % 4 == 0 and headDim >= tunables.FLASH_MIN_HEAD_DIM and headDim <= tunables.FLASH_MAX_HEAD_DIM and (dim(shapes.query, 1) * args.numHeads >= 248 or (dim(shapes.query, 1) == 1 and dim(shapes.key, 1) >= tunables.QKV_DECODE_MIN_KV_TOKENS) or (dim(shapes.query, 1) > 1 and dim(shapes.key, 1) >= 2048)) and dim(shapes.query, 0) <= device.limits.maxComputeWorkgroupsPerDimension and dim(shapes.query, 1) <= device.limits.maxComputeWorkgroupsPerDimension and args.numHeads <= device.limits.maxComputeWorkgroupsPerDimension",decodeSplitKShapeOk:"qkvContractOk and flashWorkgroupOk and dim(shapes.query, 1) == 1 and dim(shapes.key, 1) >= tunables.QKV_DECODE_MIN_KV_TOKENS and headDim % 4 == 0 and headDim >= tunables.FLASH_MIN_HEAD_DIM and headDim <= tunables.FLASH_MAX_HEAD_DIM and dim(shapes.query, 0) <= device.limits.maxComputeWorkgroupsPerDimension and args.numHeads <= device.limits.maxComputeWorkgroupsPerDimension",fallbackShapeOk:"qkvContractOk and headDim <= deviceWorkgroupCap and headDim <= tunables.FLASH_MAX_HEAD_DIM",gqaHeadDim:"dim(shapes.queryT, 2) / args.numHeads",qkvScalar:'"f16" if tensorDtypes.query == "float16" else "f32"',qkvInputVec4:'"vec4<f16>" if tensorDtypes.query == "float16" else "vec4<f32>"',gqaScalar:'"f16" if tensorDtypes.queryT == "float16" else "f32"',gqaInputVec4:'"vec4<f16>" if tensorDtypes.queryT == "float16" else "vec4<f32>"',qkvNumSplits:"min(tunables.MAX_SPLITS, ceilDiv(dim(shapes.key, 1), tunables.QKV_SPLIT_TILE_K))",cachedNumSplits:"min(tunables.MAX_SPLITS, ceilDiv(dim(shapes.presentKeyT, 2), tunables.CACHED_SPLIT_TILE_K))",sharedKvCacheOk:"not windowCacheRequested and copyWorkgroupOk and present.seqlensKT and present.pastKeyT and dim(shapes.keyT, 1) == 0 and (not present.kScaleT) and dim(shapes.queryT, 2) % args.numHeads == 0 and dim(shapes.pastKeyT, 1) == args.kvNumHeads and dim(shapes.pastKeyT, 3) == gqaHeadDim",gqaFlashHd:"gqaHeadDim >= tunables.CACHED_FLASH_MIN_HEAD_DIM and gqaHeadDim <= tunables.FLASH_MAX_HEAD_DIM",f16OrF32:'tensorDtypes.queryT == "float32" or (tensorDtypes.queryT == "float16" and device.features.has("shader-f16"))',sg32:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize == tunables.REQUIRED_SUBGROUP_SIZE and device.adapterInfo.subgroupMaxSize == tunables.REQUIRED_SUBGROUP_SIZE',subgroupCluster8:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and has(device.adapterInfo, "subgroupMaxSize") and device.adapterInfo.subgroupMinSize >= 8 and device.adapterInfo.subgroupMinSize % 8 == 0 and device.adapterInfo.subgroupMaxSize % 8 == 0',qkvPrefillQueryTile:'tunables.PREFILL_QUERY_TILE_F16 if tensorDtypes.query == "float16" else tunables.PREFILL_QUERY_TILE',qkvPrefillLanesPerQuery:'tunables.PREFILL_LANES_PER_QUERY_F16 if tensorDtypes.query == "float16" else tunables.PREFILL_LANES_PER_QUERY',cachedPrefillQueryTile:'tunables.PREFILL_QUERY_TILE_F16 if tensorDtypes.queryT == "float16" else tunables.PREFILL_QUERY_TILE',cachedPrefillLanesPerQuery:'max(tunables.PREFILL_LANES_PER_QUERY_F16 if tensorDtypes.queryT == "float16" else tunables.PREFILL_LANES_PER_QUERY, ceilDiv(gqaHeadDim / 4, tunables.CLUSTER_MAX_SLICE))',subgroupQkvPrefillCluster:'not narrowSubgroupRange and device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and has(device.adapterInfo, "subgroupMaxSize") and device.adapterInfo.subgroupMinSize >= qkvPrefillLanesPerQuery and device.adapterInfo.subgroupMinSize % qkvPrefillLanesPerQuery == 0 and device.adapterInfo.subgroupMaxSize % qkvPrefillLanesPerQuery == 0',subgroupCachedPrefillCluster:'not narrowSubgroupRange and device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and has(device.adapterInfo, "subgroupMaxSize") and device.adapterInfo.subgroupMinSize >= cachedPrefillLanesPerQuery and device.adapterInfo.subgroupMinSize % cachedPrefillLanesPerQuery == 0 and device.adapterInfo.subgroupMaxSize % cachedPrefillLanesPerQuery == 0',subgroupSplitK:"subgroupCluster8 and device.adapterInfo.subgroupMaxSize <= tunables.WORKGROUP_SIZE and tunables.WORKGROUP_SIZE % device.adapterInfo.subgroupMinSize == 0 and tunables.WORKGROUP_SIZE % device.adapterInfo.subgroupMaxSize == 0",gqaQueryCount:"dim(shapes.queryT, 0) * args.numHeads * dim(shapes.queryT, 1)",cooperativeWorkgroupOk:"tunables.COOPERATIVE_WORKGROUP_SIZE <= deviceWorkgroupCap",gqaCoopWorkgroupBytes:"((tunables.COOPERATIVE_WORKGROUP_SIZE + 1) * gqaHeadDim + tunables.COOPERATIVE_WORKGROUP_SIZE * 2) * 4",gqaCoop:"cooperativeWorkgroupOk and gqaQueryCount < tunables.COOPERATIVE_QUERY_THRESHOLD and gqaCoopWorkgroupBytes <= device.limits.maxComputeWorkgroupStorageSize",gqaScalarDispatchOk:"gqaCoop or scalarWorkgroupOk",gqaDispatchUnits:"gqaQueryCount if gqaCoop else ceilDiv(gqaQueryCount, scalarWorkgroupSize)",gqaDispatchFits:"dim(shapes.queryT, 0) <= device.limits.maxComputeWorkgroupsPerDimension and args.numHeads <= device.limits.maxComputeWorkgroupsPerDimension",noAuxAttentionInputs:"not present.cosCacheT and not present.qNormWeightT and not present.attentionBiasT and not present.headSinkT",standardSoftmax:"not args.softcap and not args.smoothSoftmax",plainAttentionOptions:"noAuxAttentionInputs and standardSoftmax",sharedKvFloatOk:"sharedKvCacheOk and f16OrF32",newKvPastOk:"not windowCacheRequested and copyWorkgroupOk and present.seqlensKT and present.pastKeyT and dim(shapes.keyT, 1) > 0 and f16OrF32 and not present.kScaleT and dim(shapes.queryT, 2) % args.numHeads == 0 and dim(shapes.pastKeyT, 1) == args.kvNumHeads and dim(shapes.pastKeyT, 3) == gqaHeadDim and dim(shapes.presentKeyT, 2) == dim(shapes.pastKeyT, 2) + dim(shapes.keyT, 1)",windowCapacity:"dim(shapes.pastKeyT, 2) if present.pastKeyT else 0",windowFitsCapacity:"args.localWindowSize <= windowCapacity if (args.localWindowSize and args.localWindowSize > 0) else true",windowShiftOk:"not present.cosCacheT and windowCacheRequested and copyWorkgroupOk and present.seqlensKT and present.pastKeyT and dim(shapes.keyT, 1) > 0 and f16OrF32 and not present.kScaleT and dim(shapes.queryT, 2) % args.numHeads == 0 and dim(shapes.pastKeyT, 1) == args.kvNumHeads and dim(shapes.pastKeyT, 3) == gqaHeadDim and dim(shapes.presentKeyT, 2) == windowCapacity and dim(shapes.keyT, 1) <= windowCapacity and windowFitsCapacity",shareAppendOk:"not windowCacheRequested and copyWorkgroupOk and present.seqlensKT and present.pastKeyT and dim(shapes.keyT, 1) > 0 and f16OrF32 and not present.kScaleT and dim(shapes.queryT, 2) % args.numHeads == 0 and dim(shapes.pastKeyT, 1) == args.kvNumHeads and dim(shapes.pastKeyT, 3) == gqaHeadDim and dim(shapes.presentKeyT, 2) == dim(shapes.pastKeyT, 2) and dim(shapes.keyT, 1) <= dim(shapes.pastKeyT, 2)",decodeFlashShapeOk:"flashWorkgroupOk and dim(shapes.queryT, 1) == 1 and gqaHeadDim % 4 == 0 and gqaFlashHd and dim(shapes.presentKeyT, 2) >= tunables.CACHED_DECODE_MIN_KV_TOKENS and gqaDispatchFits",qkvPrefillClusterWorkgroupSize:"qkvPrefillQueryTile * qkvPrefillLanesPerQuery",cachedPrefillClusterWorkgroupSize:"cachedPrefillQueryTile * cachedPrefillLanesPerQuery",cachedPrefillClusterWorkgroupOk:"cachedPrefillClusterWorkgroupSize <= deviceWorkgroupCap",prefillFlashShapeOk:"cachedPrefillClusterWorkgroupOk and gqaHeadDim % (4 * cachedPrefillLanesPerQuery) == 0 and gqaFlashHd and dim(shapes.queryT, 1) >= cachedPrefillQueryTile and gqaDispatchFits and ceilDiv(dim(shapes.queryT, 1), cachedPrefillQueryTile) <= device.limits.maxComputeWorkgroupsPerDimension",quantizedNewKvOk:'copyWorkgroupOk and present.kScaleT and present.vScaleT and present.seqlensKT and tensorDtypes.queryT == "float32" and tensorDtypes.keyT == "float32" and tensorDtypes.valueT == "float32" and dim(shapes.keyT, 1) > 0 and gqaHeadDim % 2 == 0',quantizedPromptOk:"quantizedNewKvOk and dim(shapes.keyT, 1) == dim(shapes.presentKeyT, 2)",quantizedDecodeOptionsOk:"plainAttentionOptions and not present.sinCacheT and not present.positionIdsT and not present.kNormWeightT",turboPacked:"gqaHeadDim / 8 + 1",turboCacheOk:'copyWorkgroupOk and args.kvCacheBitWidth == 4 and not present.kScaleT and not present.vScaleT and present.seqlensKT and tensorDtypes.queryT == "float32" and tensorDtypes.keyT == "float32" and tensorDtypes.valueT == "float32" and tensorDtypes.presentKeyT == "uint32" and tensorDtypes.presentValueT == "uint32" and dim(shapes.keyT, 1) > 0 and gqaHeadDim >= 8 and pow2ceil(gqaHeadDim) == gqaHeadDim and dim(shapes.queryT, 2) % args.numHeads == 0 and dim(shapes.presentKeyT, 1) == args.kvNumHeads and dim(shapes.presentKeyT, 3) == turboPacked and dim(shapes.presentValueT, 3) == turboPacked and dim(shapes.presentValueT, 1) == args.kvNumHeads and dim(shapes.presentValueT, 2) == dim(shapes.presentKeyT, 2)',turboPackWorkgroupOk:"gqaHeadDim / 4 <= deviceWorkgroupCap",turboPromptOk:"turboCacheOk and dim(shapes.keyT, 1) == dim(shapes.presentKeyT, 2)",turboCachedDecodeOk:'not windowCacheRequested and turboCacheOk and quantizedDecodeOptionsOk and present.pastKeyT and present.pastValueT and dim(shapes.queryT, 1) == 1 and dim(shapes.keyT, 1) == 1 and tensorDtypes.pastKeyT == "uint32" and tensorDtypes.pastValueT == "uint32" and dim(shapes.pastKeyT, 0) == dim(shapes.presentKeyT, 0) and dim(shapes.pastKeyT, 1) == dim(shapes.presentKeyT, 1) and dim(shapes.pastKeyT, 2) == dim(shapes.presentKeyT, 2) and dim(shapes.pastKeyT, 3) == dim(shapes.presentKeyT, 3)',quantizedCachedDecodeOk:'not windowCacheRequested and quantizedNewKvOk and quantizedDecodeOptionsOk and args.kvCacheBitWidth == 8 and present.pastKeyT and present.pastValueT and dim(shapes.queryT, 1) == 1 and dim(shapes.keyT, 1) == 1 and tensorDtypes.pastKeyT == "int8" and tensorDtypes.pastValueT == "int8" and tensorDtypes.presentKeyT == "int8" and tensorDtypes.presentValueT == "int8" and dim(shapes.pastKeyT, 0) == dim(shapes.presentKeyT, 0) and dim(shapes.pastKeyT, 1) == dim(shapes.presentKeyT, 1) and dim(shapes.pastKeyT, 2) == dim(shapes.presentKeyT, 2) and dim(shapes.pastKeyT, 3) == dim(shapes.presentKeyT, 3)',qkvSplitScratchBytes:"dim(shapes.query, 0) * args.numHeads * qkvNumSplits * headDim * 4",qkvSplitStatsBytes:"2 * dim(shapes.query, 0) * args.numHeads * qkvNumSplits * 4",qkvSplitScratchFits:"qkvSplitScratchBytes <= device.limits.maxStorageBufferBindingSize and qkvSplitScratchBytes <= device.limits.maxBufferSize and qkvSplitStatsBytes <= device.limits.maxStorageBufferBindingSize and qkvSplitStatsBytes <= device.limits.maxBufferSize",cachedSplitScratchBytes:"dim(shapes.queryT, 0) * args.numHeads * cachedNumSplits * gqaHeadDim * 4",cachedSplitStatsBytes:"2 * dim(shapes.queryT, 0) * args.numHeads * cachedNumSplits * 4",cachedSplitScratchFits:"cachedSplitScratchBytes <= device.limits.maxStorageBufferBindingSize and cachedSplitScratchBytes <= device.limits.maxBufferSize and cachedSplitStatsBytes <= device.limits.maxStorageBufferBindingSize and cachedSplitStatsBytes <= device.limits.maxBufferSize",qPrepScratchBytes:"numel(shapes.queryT) * 4",qPrepScratchFits:"qPrepScratchBytes <= device.limits.maxStorageBufferBindingSize and qPrepScratchBytes <= device.limits.maxBufferSize",qkvTiledWorkgroupBytes:"dim(shapes.value, 2) / args.kvNumHeads * 32 * 4",qkvTiledStorageOk:"qkvTiledWorkgroupBytes <= device.limits.maxComputeWorkgroupStorageSize",qkvClusterTileK:'tunables.CLUSTER_TILE_K_F32 if tensorDtypes.query == "float32" and headDim <= tunables.QKV_SPLIT_TILE_K else tunables.CLUSTER_TILE_K_F16',qkvClusterWorkgroupBytes:'qkvClusterTileK * headDim * (8 if tensorDtypes.query == "float32" else 4)',qkvClusterStorageOk:"qkvClusterWorkgroupBytes <= device.limits.maxComputeWorkgroupStorageSize",qkvF32ClusterRegisterGeometry:'tensorDtypes.query != "float32" or (headDim % 4 == 0 and headDim / 4 <= tunables.REQUIRED_SUBGROUP_SIZE)',cachedF32ClusterRegisterGeometry:'tensorDtypes.queryT != "float32" or (gqaHeadDim % 4 == 0 and gqaHeadDim / (4 * cachedPrefillLanesPerQuery) <= tunables.CLUSTER_MAX_SLICE)',qkvNoSgReductionBytesPerKey:"qkvPrefillClusterWorkgroupSize * 4",cachedNoSgReductionBytesPerKey:"cachedPrefillClusterWorkgroupSize * 4",qkvNoSgTileBytes:'headDim * (8 if tensorDtypes.query == "float32" else 4) + qkvNoSgReductionBytesPerKey',qkvNoSgTileK:"min(tunables.NO_SG_TILE_K_MAX, max(1, floor(device.limits.maxComputeWorkgroupStorageSize / qkvNoSgTileBytes)))",qkvNoSgWorkgroupBytes:"qkvNoSgTileK * qkvNoSgTileBytes",qkvNoSgClusterStorageOk:"qkvNoSgWorkgroupBytes <= device.limits.maxComputeWorkgroupStorageSize",cachedClusterTileK:'tunables.CLUSTER_TILE_K_F32 if tensorDtypes.queryT == "float32" and gqaHeadDim <= tunables.QKV_SPLIT_TILE_K else tunables.CLUSTER_TILE_K_F16',cachedClusterWorkgroupBytes:'cachedClusterTileK * gqaHeadDim * (8 if tensorDtypes.queryT == "float32" else 4)',cachedClusterStorageOk:"cachedClusterWorkgroupBytes <= device.limits.maxComputeWorkgroupStorageSize",cachedMaskClusterWorkgroupBytes:"cachedClusterWorkgroupBytes + cachedPrefillQueryTile * cachedClusterTileK * 4",cachedMaskClusterStorageOk:"cachedMaskClusterWorkgroupBytes <= device.limits.maxComputeWorkgroupStorageSize",cachedNoSgTileBytes:'gqaHeadDim * (8 if tensorDtypes.queryT == "float32" else 4) + cachedNoSgReductionBytesPerKey',cachedNoSgTileK:"min(tunables.NO_SG_TILE_K_MAX, max(1, floor(device.limits.maxComputeWorkgroupStorageSize / cachedNoSgTileBytes)))",cachedNoSgWorkgroupBytes:"cachedNoSgTileK * cachedNoSgTileBytes",cachedNoSgClusterStorageOk:"cachedNoSgWorkgroupBytes <= device.limits.maxComputeWorkgroupStorageSize"},bindingSets:{flashPrefillSeqlens:[{name:"query",arg:"queryT",buffer:{type:"read-only-storage"},elementType:"$inputVec4"},{name:"key",arg:"presentKeyT",buffer:{type:"read-only-storage"},elementType:"$inputVec4"},{name:"value",arg:"presentValueT",buffer:{type:"read-only-storage"},elementType:"$inputVec4"},{name:"output",arg:"outputT",buffer:{type:"storage"},elementType:"$inputVec4"},{name:"seqlens_k",arg:"seqlensKT",buffer:{type:"read-only-storage"},elementType:"i32"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"scale",type:"f32",value:"args.scale if args.scale else 0"},{name:"kvSeq",type:"u32",value:"dim(shapes.presentKeyT, 2)"},{name:"qSeq",type:"u32",value:"dim(shapes.queryT, 1)"},{name:"isCausal",type:"u32",value:1},{name:"windowSize",type:"u32",value:"args.localWindowSize if (args.localWindowSize and args.localWindowSize > 0) else 0"}]}}],presentMergeShareRetain:[{name:"past_k",arg:"pastKeyT",buffer:{type:"read-only-storage"},elementType:"$inputScalar"},{name:"past_v",arg:"pastValueT",buffer:{type:"read-only-storage"},elementType:"$inputScalar"},{name:"present_key",arg:"presentKeyT",buffer:{type:"storage"},elementType:"$inputScalar"},{name:"present_value",arg:"presentValueT",buffer:{type:"storage"},elementType:"$inputScalar"},{name:"seqlens_k",arg:"seqlensKT",buffer:{type:"read-only-storage"},elementType:"i32"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"count",type:"u32",value:"dim(shapes.queryT, 0) * args.kvNumHeads * dim(shapes.presentKeyT, 2)"},{name:"seq",type:"u32",value:"dim(shapes.presentKeyT, 2)"},{name:"keySeq",type:"u32",value:"dim(shapes.keyT, 1)"}]}}],presentMergeShareAppend:[{name:"new_k",arg:"keyT",buffer:{type:"read-only-storage"},elementType:"$inputScalar"},{name:"new_v",arg:"valueT",buffer:{type:"read-only-storage"},elementType:"$inputScalar"},{name:"present_key",arg:"presentKeyT",buffer:{type:"storage"},elementType:"$inputScalar"},{name:"present_value",arg:"presentValueT",buffer:{type:"storage"},elementType:"$inputScalar"},{name:"seqlens_k",arg:"seqlensKT",buffer:{type:"read-only-storage"},elementType:"i32"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"count",type:"u32",value:"dim(shapes.queryT, 0) * args.kvNumHeads * dim(shapes.keyT, 1)"},{name:"seq",type:"u32",value:"dim(shapes.presentKeyT, 2)"},{name:"keySeq",type:"u32",value:"dim(shapes.keyT, 1)"}]}}],mergedSeqlensAttention:[{name:"query",arg:"queryT",buffer:{type:"read-only-storage"},elementType:"$inputScalar"},{name:"kcache",arg:"presentKeyT",buffer:{type:"read-only-storage"},elementType:"$inputScalar"},{name:"vcache",arg:"presentValueT",buffer:{type:"read-only-storage"},elementType:"$inputScalar"},{name:"output",arg:"outputT",buffer:{type:"storage"},elementType:"$inputScalar"},{name:"seqlens_k",arg:"seqlensKT",buffer:{type:"read-only-storage"},elementType:"i32"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"batch",type:"u32",value:"dim(shapes.queryT, 0)"},{name:"qSeq",type:"u32",value:"dim(shapes.queryT, 1)"},{name:"totalSeq",type:"u32",value:"dim(shapes.presentKeyT, 2)"},{name:"windowSize",type:"u32",value:"args.localWindowSize if (args.localWindowSize and args.localWindowSize > 0) else 0"},{name:"scale",type:"f32",value:"args.scale if args.scale else 0"},{name:"softcap",type:"f32",value:"args.softcap if args.softcap else 0"},{name:"smoothSoftmax",type:"u32",value:"args.smoothSoftmax if args.smoothSoftmax else 0"}]}}]},variants:[{id:"new_kv_share_append_split",priority:32,when:["shareAppendOk","gqaScalarDispatchOk","noAuxAttentionInputs","not present.kNormWeightT","gqaHeadDim % 2 == 0"],constants:{useSeqlens:!0,headDim:"gqaHeadDim",cooperative:"gqaCoop",dispatchUnits:"gqaDispatchUnits",qHeads:"args.numHeads",kvHeads:"args.kvNumHeads",qHidden:"dim(shapes.queryT, 2)",packed:"gqaHeadDim",mode:'"merge_share"',usesF16:'tensorDtypes.queryT == "float16"',inputScalar:"gqaScalar"},passes:[{id:"present_retain",name:"GroupQueryAttention.MergeShareRetain",shader:"gqa-present.wgsl.jinja",bindings:"presentMergeShareRetain",constants:{shareRegion:'"retain"'},dispatch:{threads:"dim(shapes.queryT, 0) * args.kvNumHeads * dim(shapes.presentKeyT, 2)",workgroupSize:"copyWorkgroupSize"},viewAlias:[{input:"past_k",output:"present_key"},{input:"past_v",output:"present_value"}]},{id:"present_append",name:"GroupQueryAttention.MergeShareAppend",shader:"gqa-present.wgsl.jinja",bindings:"presentMergeShareAppend",constants:{shareRegion:'"append"'},dispatch:{threads:"dim(shapes.queryT, 0) * args.kvNumHeads * dim(shapes.keyT, 1)",workgroupSize:"copyWorkgroupSize"}},{id:"attention",name:"GroupQueryAttention.Attn",shader:"gqa-attention.wgsl.jinja",bindings:"mergedSeqlensAttention",dispatch:{workgroups:"constants.dispatchUnits"}}]},{id:"share_append_split_flash_prefill",priority:35,when:["shareAppendOk","prefillFlashShapeOk",'cachedClusterStorageOk if "" == "" else cachedNoSgClusterStorageOk',"plainAttentionOptions",'(subgroupCachedPrefillCluster and cachedF32ClusterRegisterGeometry) if "" == "" else true'],constants:{scalar:"gqaScalar",usesF16:'tensorDtypes.queryT == "float16"',hasCausal:!0,causalRightAlign:!0,hasBias:!1,hasMask:!1,maskIsBool:!1,hasWindow:"args.localWindowSize > 0 if args.localWindowSize else false",headDim:"gqaHeadDim",headDimV4:"gqaHeadDim / 4",qHiddenV4:"dim(shapes.queryT, 2) / 4",qNumHeads:"args.numHeads",kvNumHeads:"args.kvNumHeads",TILE_Q:"cachedPrefillQueryTile",TILE_K:'cachedClusterTileK if "" == "" else cachedNoSgTileK',LPQ:"cachedPrefillLanesPerQuery",kvHeads:"args.kvNumHeads",packed:"gqaHeadDim",mode:'"merge_share"',useSeqlens:!0,inputVec4:"gqaInputVec4",inputScalar:"gqaScalar",batchNoSgReduction:'"" == "_nosg"',useSubgroups:'"" == ""'},passes:[{id:"present_retain",name:"GroupQueryAttention.MergeShareRetain",shader:"gqa-present.wgsl.jinja",bindings:"presentMergeShareRetain",constants:{shareRegion:'"retain"'},dispatch:{threads:"dim(shapes.queryT, 0) * args.kvNumHeads * dim(shapes.presentKeyT, 2)",workgroupSize:"copyWorkgroupSize"},viewAlias:[{input:"past_k",output:"present_key"},{input:"past_v",output:"present_value"}]},{id:"present_append",name:"GroupQueryAttention.MergeShareAppend",shader:"gqa-present.wgsl.jinja",bindings:"presentMergeShareAppend",constants:{shareRegion:'"append"'},dispatch:{threads:"dim(shapes.queryT, 0) * args.kvNumHeads * dim(shapes.keyT, 1)",workgroupSize:"copyWorkgroupSize"}},{id:"attention",name:"GroupQueryAttention.FlashPrefill",source:{shader:"ops/_shared/attn-flash-prefill-cluster.wgsl.jinja",inputs:{layout:'"bsh"',qLayout:'"bsh"',kvLayout:'"bhsd"'}},bindings:"flashPrefillSeqlens",dispatch:{x:"ceilDiv(dim(shapes.queryT, 1), constants.TILE_Q)",y:"args.numHeads",z:"dim(shapes.queryT, 0)"}}]},{id:"share_append_split_flash_prefill_nosg",priority:35,when:["shareAppendOk","prefillFlashShapeOk",'cachedClusterStorageOk if "_nosg" == "" else cachedNoSgClusterStorageOk',"plainAttentionOptions",'(subgroupCachedPrefillCluster and cachedF32ClusterRegisterGeometry) if "_nosg" == "" else true'],constants:{scalar:"gqaScalar",usesF16:'tensorDtypes.queryT == "float16"',hasCausal:!0,causalRightAlign:!0,hasBias:!1,hasMask:!1,maskIsBool:!1,hasWindow:"args.localWindowSize > 0 if args.localWindowSize else false",headDim:"gqaHeadDim",headDimV4:"gqaHeadDim / 4",qHiddenV4:"dim(shapes.queryT, 2) / 4",qNumHeads:"args.numHeads",kvNumHeads:"args.kvNumHeads",TILE_Q:"cachedPrefillQueryTile",TILE_K:'cachedClusterTileK if "_nosg" == "" else cachedNoSgTileK',LPQ:"cachedPrefillLanesPerQuery",kvHeads:"args.kvNumHeads",packed:"gqaHeadDim",mode:'"merge_share"',useSeqlens:!0,inputVec4:"gqaInputVec4",inputScalar:"gqaScalar",batchNoSgReduction:'"_nosg" == "_nosg"',useSubgroups:'"_nosg" == ""'},passes:[{id:"present_retain",name:"GroupQueryAttention.MergeShareRetain",shader:"gqa-present.wgsl.jinja",bindings:"presentMergeShareRetain",constants:{shareRegion:'"retain"'},dispatch:{threads:"dim(shapes.queryT, 0) * args.kvNumHeads * dim(shapes.presentKeyT, 2)",workgroupSize:"copyWorkgroupSize"},viewAlias:[{input:"past_k",output:"present_key"},{input:"past_v",output:"present_value"}]},{id:"present_append",name:"GroupQueryAttention.MergeShareAppend",shader:"gqa-present.wgsl.jinja",bindings:"presentMergeShareAppend",constants:{shareRegion:'"append"'},dispatch:{threads:"dim(shapes.queryT, 0) * args.kvNumHeads * dim(shapes.keyT, 1)",workgroupSize:"copyWorkgroupSize"}},{id:"attention",name:"GroupQueryAttention.FlashPrefill",source:{shader:"ops/_shared/attn-flash-prefill-cluster.wgsl.jinja",inputs:{layout:'"bsh"',qLayout:'"bsh"',kvLayout:'"bhsd"'}},bindings:"flashPrefillSeqlens",dispatch:{x:"ceilDiv(dim(shapes.queryT, 1), constants.TILE_Q)",y:"args.numHeads",z:"dim(shapes.queryT, 0)"}}]}]},assets:[["gqa-attention.wgsl.jinja",`{% set USESF16 = usesF16 is defined and usesF16 %}
{% if useSeqlens is not defined %}{% set useSeqlens = false %}{% endif %}
{% if turboQuant is not defined %}{% set turboQuant = false %}{% endif %}
{% if USESF16 %}enable f16;
{% endif %}{{ env.wgsl.resourceDeclarations }}
{% if turboQuant %}
{% include "ops/_shared/hadamard-transform-row.wgsl.jinja" %}
{% include "ops/_shared/turbo-quant.wgsl.jinja" %}
{% endif %}
{% set IO = "f16" if USESF16 else "f32" %}

{% if cooperative %}

{% else %}

{% endif %}

{% if turboQuant %}

{% endif %}
const HEAD_DIM: u32 = {{ headDim }}u;
{% if hasRotary %}const HALF: u32 = {{ half }}u;{% endif %}
const Q_HEADS: u32 = {{ qHeads }}u;
const KV_HEADS: u32 = {{ kvHeads }}u;
const Q_HIDDEN: u32 = {{ qHidden }}u;
const GROUP: u32 = {{ qHeads }}u / {{ kvHeads }}u;
const PACKED: u32 = {{ packed }}u;
{% if hasQNorm %}const QK_EPS: f32 = {{ qkEps }};{% endif %}
{% if cooperative %}const WG: u32 = {{ tunables.COOPERATIVE_WORKGROUP_SIZE }}u;{% else %}const WG: u32 = {{ scalarWorkgroupSize }}u;{% endif %}
const NEG_INF: f32 = -3.4028234663852886e38;

{% if quantized %}
fn kscale(d: u32, hk: u32) -> f32 { return k_scale[select(0u, hk * HEAD_DIM + d, params.perChannel != 0u)]; }
fn vscale(d: u32, hk: u32) -> f32 { return v_scale[select(0u, hk * HEAD_DIM + d, params.perChannel != 0u)]; }
{% endif %}

{% if turboQuant %}

const TQ_WORDS: u32 = PACKED - 1u;

{% macro turbo_dot(buffer, base, q, out) %}
  {
    let tq_scale = tq_row_scale({{ buffer }}[{{ base }}], inverseSqrt(f32(HEAD_DIM)));
    for (var w = 0u; w < TQ_WORDS; w = w + 1u) {
      let packed = {{ buffer }}[{{ base }} + 1u + w];
      let lo = tq_dequant_low4(packed, tq_scale);
      let hi = tq_dequant_high4(packed, tq_scale);
      let d0 = w * 8u;
      {{ out }} = {{ out }}
        + {{ q }}[d0] * lo.x + {{ q }}[d0 + 1u] * lo.y + {{ q }}[d0 + 2u] * lo.z + {{ q }}[d0 + 3u] * lo.w
        + {{ q }}[d0 + 4u] * hi.x + {{ q }}[d0 + 5u] * hi.y + {{ q }}[d0 + 6u] * hi.z + {{ q }}[d0 + 7u] * hi.w;
    }
  }
{% endmacro %}

{% macro turbo_accumulate(buffer, base, acc, accBase, corr, weight) %}
  {
    let tq_scale = tq_row_scale({{ buffer }}[{{ base }}], inverseSqrt(f32(HEAD_DIM)));
    for (var w = 0u; w < TQ_WORDS; w = w + 1u) {
      let packed = {{ buffer }}[{{ base }} + 1u + w];
      let lo = tq_dequant_low4(packed, tq_scale) * {{ weight }};
      let hi = tq_dequant_high4(packed, tq_scale) * {{ weight }};
      let d0 = {{ accBase }} + w * 8u;
      {{ acc }}[d0] = {{ acc }}[d0] * {{ corr }} + lo.x;
      {{ acc }}[d0 + 1u] = {{ acc }}[d0 + 1u] * {{ corr }} + lo.y;
      {{ acc }}[d0 + 2u] = {{ acc }}[d0 + 2u] * {{ corr }} + lo.z;
      {{ acc }}[d0 + 3u] = {{ acc }}[d0 + 3u] * {{ corr }} + lo.w;
      {{ acc }}[d0 + 4u] = {{ acc }}[d0 + 4u] * {{ corr }} + hi.x;
      {{ acc }}[d0 + 5u] = {{ acc }}[d0 + 5u] * {{ corr }} + hi.y;
      {{ acc }}[d0 + 6u] = {{ acc }}[d0 + 6u] * {{ corr }} + hi.z;
      {{ acc }}[d0 + 7u] = {{ acc }}[d0 + 7u] * {{ corr }} + hi.w;
    }
  }
{% endmacro %}
{% else %}
fn read_k(base: u32, d: u32, hk: u32) -> f32 {
{% if not quantized %}
  return f32(kcache[base + d]);
{% elif bits == 8 %}
  return f32(kcache[base + d]) * kscale(d, hk);
{% else %}
  let byte = kcache[base + (d >> 1u)];
  var nib = i32((byte >> ((d & 1u) * 4u)) & 0xFu);
  if (nib >= 8) { nib = nib - 16; }
  return f32(nib) * kscale(d, hk);
{% endif %}
}
fn read_v(base: u32, d: u32, hk: u32) -> f32 {
{% if not quantized %}
  return f32(vcache[base + d]);
{% elif bits == 8 %}
  return f32(vcache[base + d]) * vscale(d, hk);
{% else %}
  let byte = vcache[base + (d >> 1u)];
  var nib = i32((byte >> ((d & 1u) * 4u)) & 0xFu);
  if (nib >= 8) { nib = nib - 16; }
  return f32(nib) * vscale(d, hk);
{% endif %}
}
{% endif %}

{% if cooperative %}
var<workgroup> qsh: array<f32, HEAD_DIM>;
var<workgroup> acc_sh: array<f32, HEAD_DIM * 32u>;
var<workgroup> m_sh: array<f32, 32u>;
var<workgroup> l_sh: array<f32, 32u>;

@compute @workgroup_size(WG)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {

  let qi = wid.x + wid.y * nwg.x;
  let total = params.batch * Q_HEADS * params.qSeq;
  if (qi >= total) { return; }
  let lane = lid.x;
  let s = qi % params.qSeq;
  let tmp = qi / params.qSeq;
  let h = tmp % Q_HEADS;
  let b = tmp / Q_HEADS;
  let hk = h / GROUP;
  let totalSeq = params.totalSeq;
{% if useSeqlens %}

  let activeEnd = min(totalSeq, max(params.qSeq, u32(seqlens_k[b]) + 1u));
{% else %}
  let activeEnd = totalSeq;
{% endif %}
  let absPos = activeEnd - params.qSeq + s;

  let qBase = (b * params.qSeq + s) * Q_HIDDEN + h * HEAD_DIM;
  for (var d = lane; d < HEAD_DIM; d = d + WG) { qsh[d] = f32(query[qBase + d]); }
  workgroupBarrier();
{% if hasQNorm %}
  var part = 0.0;
  for (var d = lane; d < HEAD_DIM; d = d + WG) { part = part + qsh[d] * qsh[d]; }
  m_sh[lane] = part;
  workgroupBarrier();
  var ms = 0.0;
  for (var L = 0u; L < WG; L = L + 1u) { ms = ms + m_sh[L]; }
  let invRms = inverseSqrt(ms / f32(HEAD_DIM) + QK_EPS);
  for (var d = lane; d < HEAD_DIM; d = d + WG) { qsh[d] = qsh[d] * invRms * f32(q_norm_weight[d]); }
  workgroupBarrier();
{% endif %}
{% if hasRotary %}

  for (var d = lane; d < HALF; d = d + WG) {
    let cs = f32(cos_cache[absPos * HALF + d]);
    let sn = f32(sin_cache[absPos * HALF + d]);
    let x0 = qsh[d];
    let x1 = qsh[d + HALF];
    qsh[d] = x0 * cs - x1 * sn;
    qsh[d + HALF] = x1 * cs + x0 * sn;
  }
  workgroupBarrier();
{% endif %}
{% if turboQuant %}
{{ emit_wht_shared("qsh", headDim, "lane", "WG") }}
{% endif %}

  let scale = select(params.scale, inverseSqrt(f32(HEAD_DIM)), params.scale == 0.0);
  let maxKj = absPos + 1u;
  var minKj = 0u;
  if (params.windowSize > 0u && maxKj > params.windowSize) { minKj = maxKj - params.windowSize; }

  let accBase = lane * HEAD_DIM;
  for (var d = 0u; d < HEAD_DIM; d = d + 1u) { acc_sh[accBase + d] = 0.0; }
  var m = NEG_INF;
  var l = 0.0;

  for (var j = minKj + lane; j < maxKj; j = j + WG) {
    let base = ((b * KV_HEADS + hk) * totalSeq + j) * PACKED;
    var dot = 0.0;
{% if turboQuant %}
{{ turbo_dot("kcache", "base", "qsh", "dot") }}
{% else %}
    for (var d = 0u; d < HEAD_DIM; d = d + 1u) { dot = dot + qsh[d] * read_k(base, d, hk); }
{% endif %}
    var score = dot * scale;
    if (params.softcap > 0.0) { score = params.softcap * tanh(clamp(score / params.softcap, -30.0, 30.0)); }
{% if hasBias %}
    let bb = select(b, 0u, params.biasBatch == 1u);
    let bh = select(h, 0u, params.biasHeads == 1u);
    score = score + attn_bias[((bb * params.biasHeads + bh) * params.qSeq + s) * totalSeq + j];
{% endif %}
    let newM = max(m, score);
    let corr = exp(m - newM);
    let p = exp(score - newM);
    l = l * corr + p;
{% if turboQuant %}
{{ turbo_accumulate("vcache", "base", "acc_sh", "accBase", "corr", "p") }}
{% else %}
    for (var d = 0u; d < HEAD_DIM; d = d + 1u) { acc_sh[accBase + d] = acc_sh[accBase + d] * corr + p * read_v(base, d, hk); }
{% endif %}
    m = newM;
  }

  m_sh[lane] = m;
  workgroupBarrier();
  var gm = NEG_INF;
  for (var L = 0u; L < WG; L = L + 1u) { gm = max(gm, m_sh[L]); }
  let fctr = exp(m - gm);
  l = l * fctr;
  for (var d = 0u; d < HEAD_DIM; d = d + 1u) { acc_sh[accBase + d] = acc_sh[accBase + d] * fctr; }
  l_sh[lane] = l;
  workgroupBarrier();
  var glsum = 0.0;
  for (var L = 0u; L < WG; L = L + 1u) { glsum = glsum + l_sh[L]; }

  var sink = 0.0;
{% if hasHeadSink %}
  sink = head_sink[h];
  let useSmooth = true;
{% else %}
  let useSmooth = params.smoothSoftmax != 0u;
{% endif %}
  var finalM = gm;
  var smoothTerm = 0.0;
  if (useSmooth) {
    finalM = max(gm, sink);
    smoothTerm = exp(sink - finalM);
  }
  let accScale = exp(gm - finalM);
  let invDenom = accScale / (smoothTerm + glsum * accScale);

  let oBase = (b * params.qSeq + s) * Q_HIDDEN + h * HEAD_DIM;
{% if turboQuant %}

  workgroupBarrier();
  for (var d = lane; d < HEAD_DIM; d = d + WG) {
    var sumacc = 0.0;
    for (var L = 0u; L < WG; L = L + 1u) { sumacc = sumacc + acc_sh[L * HEAD_DIM + d]; }
    qsh[d] = sumacc * invDenom;
  }
  workgroupBarrier();
{{ emit_wht_shared("qsh", headDim, "lane", "WG") }}
  for (var d = lane; d < HEAD_DIM; d = d + WG) { output[oBase + d] = {{ IO }}(qsh[d]); }
{% else %}
  for (var d = lane; d < HEAD_DIM; d = d + WG) {
    var sumacc = 0.0;
    for (var L = 0u; L < WG; L = L + 1u) { sumacc = sumacc + acc_sh[L * HEAD_DIM + d]; }
    output[oBase + d] = {{ IO }}(sumacc * invDenom);
  }
{% endif %}
}
{% else %}
@compute @workgroup_size(WG)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {

  let qi = (wid.x + wid.y * nwg.x) * WG + lid.x;
  let total = params.batch * Q_HEADS * params.qSeq;
  if (qi >= total) { return; }
  let s = qi % params.qSeq;
  let tmp = qi / params.qSeq;
  let h = tmp % Q_HEADS;
  let b = tmp / Q_HEADS;
  let hk = h / GROUP;
  let totalSeq = params.totalSeq;
{% if useSeqlens %}

  let activeEnd = min(totalSeq, max(params.qSeq, u32(seqlens_k[b]) + 1u));
{% else %}
  let activeEnd = totalSeq;
{% endif %}
  let absPos = activeEnd - params.qSeq + s;

  var q: array<f32, HEAD_DIM>;
  let qBase = (b * params.qSeq + s) * Q_HIDDEN + h * HEAD_DIM;
  for (var d = 0u; d < HEAD_DIM; d = d + 1u) { q[d] = f32(query[qBase + d]); }
{% if hasQNorm %}
  var ss = 0.0;
  for (var d = 0u; d < HEAD_DIM; d = d + 1u) { ss = ss + q[d] * q[d]; }
  let invRms = inverseSqrt(ss / f32(HEAD_DIM) + QK_EPS);
  for (var d = 0u; d < HEAD_DIM; d = d + 1u) { q[d] = q[d] * invRms * q_norm_weight[d]; }
{% endif %}
{% if hasRotary %}
  for (var d = 0u; d < HALF; d = d + 1u) {
    let cs = cos_cache[absPos * HALF + d];
    let sn = sin_cache[absPos * HALF + d];
    let x0 = q[d];
    let x1 = q[d + HALF];
    q[d] = x0 * cs - x1 * sn;
    q[d + HALF] = x1 * cs + x0 * sn;
  }
{% endif %}
{% if turboQuant %}
{{ emit_wht_private("q", headDim) }}
{% endif %}

  let scale = select(params.scale, inverseSqrt(f32(HEAD_DIM)), params.scale == 0.0);
  let maxKj = absPos + 1u;
  var minKj = 0u;
  if (params.windowSize > 0u && maxKj > params.windowSize) { minKj = maxKj - params.windowSize; }

  var acc: array<f32, HEAD_DIM>;
  for (var d = 0u; d < HEAD_DIM; d = d + 1u) { acc[d] = 0.0; }
  var m = NEG_INF;
  var l = 0.0;

  for (var j = minKj; j < maxKj; j = j + 1u) {
    let base = ((b * KV_HEADS + hk) * totalSeq + j) * PACKED;
    var dot = 0.0;
{% if turboQuant %}
{{ turbo_dot("kcache", "base", "q", "dot") }}
{% else %}
    for (var d = 0u; d < HEAD_DIM; d = d + 1u) { dot = dot + q[d] * read_k(base, d, hk); }
{% endif %}
    var score = dot * scale;
    if (params.softcap > 0.0) { score = params.softcap * tanh(clamp(score / params.softcap, -30.0, 30.0)); }
{% if hasBias %}
    let bb = select(b, 0u, params.biasBatch == 1u);
    let bh = select(h, 0u, params.biasHeads == 1u);
    score = score + attn_bias[((bb * params.biasHeads + bh) * params.qSeq + s) * totalSeq + j];
{% endif %}
    let newM = max(m, score);
    let corr = exp(m - newM);
    let p = exp(score - newM);
    l = l * corr + p;
{% if turboQuant %}
{{ turbo_accumulate("vcache", "base", "acc", "0u", "corr", "p") }}
{% else %}
    for (var d = 0u; d < HEAD_DIM; d = d + 1u) { acc[d] = acc[d] * corr + p * read_v(base, d, hk); }
{% endif %}
    m = newM;
  }

  var sink = 0.0;
{% if hasHeadSink %}
  sink = head_sink[h];
  let useSmooth = true;
{% else %}
  let useSmooth = params.smoothSoftmax != 0u;
{% endif %}
  var finalM = m;
  var smoothTerm = 0.0;
  if (useSmooth) {
    finalM = max(m, sink);
    smoothTerm = exp(sink - finalM);
  }
  let accScale = exp(m - finalM);
  let invDenom = accScale / (smoothTerm + l * accScale);

  let oBase = (b * params.qSeq + s) * Q_HIDDEN + h * HEAD_DIM;
{% if turboQuant %}

  for (var d = 0u; d < HEAD_DIM; d = d + 1u) { acc[d] = acc[d] * invDenom; }
{{ emit_wht_private("acc", headDim) }}
  for (var d = 0u; d < HEAD_DIM; d = d + 1u) { output[oBase + d] = {{ IO }}(acc[d]); }
{% else %}
  for (var d = 0u; d < HEAD_DIM; d = d + 1u) { output[oBase + d] = {{ IO }}(acc[d] * invDenom); }
{% endif %}
}
{% endif %}
`],["gqa-present.wgsl.jinja",`{% if source is defined and source.mode is defined %}
{% set mode = source.mode %}
{% elif mode is not defined %}
{% set mode = "transpose" %}
{% endif %}
{% if usesF16 is defined and usesF16 %}enable f16;
{% endif %}{{ env.wgsl.resourceDeclarations }}
{% if mode == "transpose" %}

const KV_HEADS: u32 = {{ kvNumHeads }}u;
const WG: u32 = {{ copyWorkgroupSize }}u;
{% if presentVec4 %}

const HEAD_DIM_V4: u32 = {{ headDimV4 }}u;
const KV_HIDDEN_V4: u32 = {{ kvHiddenV4 }}u;
{% else %}
const HEAD_DIM: u32 = {{ headDim }}u;
const KV_HIDDEN: u32 = {{ kvHidden }}u;
{% endif %}

@compute @workgroup_size(WG, 1, 1)
fn main(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(num_workgroups) nwg: vec3<u32>
) {

  let index = gid.x + gid.y * nwg.x * WG;
{% if presentVec4 %}
  let total = params.batchSize * KV_HEADS * params.kvSeq * HEAD_DIM_V4;
  if (index >= total) {
    return;
  }
  let d4 = index % HEAD_DIM_V4;
  let token = (index / HEAD_DIM_V4) % params.kvSeq;
  let head = (index / (HEAD_DIM_V4 * params.kvSeq)) % KV_HEADS;
  let batch = index / (HEAD_DIM_V4 * params.kvSeq * KV_HEADS);
  let packed = (batch * params.kvSeq + token) * KV_HIDDEN_V4 + head * HEAD_DIM_V4 + d4;
  present_key[index] = key[packed];
  present_value[index] = value[packed];
{% else %}
  let total = params.batchSize * KV_HEADS * params.kvSeq * HEAD_DIM;
  if (index >= total) {
    return;
  }
  let d = index % HEAD_DIM;
  let token = (index / HEAD_DIM) % params.kvSeq;
  let head = (index / (HEAD_DIM * params.kvSeq)) % KV_HEADS;
  let batch = index / (HEAD_DIM * params.kvSeq * KV_HEADS);
  let packed_index = (batch * params.kvSeq + token) * KV_HIDDEN + head * HEAD_DIM + d;
  present_key[index] = {{ outputScalar }}(key[packed_index]);
  present_value[index] = {{ outputScalar }}(value[packed_index]);
{% endif %}
}
{%- else %}

{% if copyRowWords is not defined %}{% set copyRowWords = "HEAD_DIM" %}{% endif %}
{% set shareAppend = mode == "merge_share" and shareRegion == "append" %}
{% if mode == "copy" %}

{% elif mode == "merge" %}

{% elif mode == "merge_share" %}

{% elif mode == "build" %}

{% elif mode == "window_shift" %}

{% elif mode == "append_quant" %}

{% else %}

{% endif %}
const HEAD_DIM: u32 = {{ headDim }}u;
const KV_HEADS: u32 = {{ kvHeads }}u;
const WG: u32 = {{ tunables.COPY_WORKGROUP_SIZE }}u;
{% if mode != "copy" %}
const KV_HIDDEN: u32 = {{ kvHeads }}u * {{ headDim }}u;
{% endif %}
const PACKED: u32 = {{ packed }}u;
{% if hasRotary and (mode != "merge_share" or shareAppend) %}const HALF: u32 = {{ half }}u;{% endif %}
{% if hasKNorm %}const QK_EPS: f32 = {{ qkEps }};{% endif %}
{% if mode == "build_quant" or mode == "append_quant" %}
const QMAX: f32 = {{ qmax }};
const QMIN: f32 = {{ qmin }};
fn kscale(d: u32, hk: u32) -> f32 { return k_scale[select(0u, hk * HEAD_DIM + d, params.perChannel != 0u)]; }
fn vscale(d: u32, hk: u32) -> f32 { return v_scale[select(0u, hk * HEAD_DIM + d, params.perChannel != 0u)]; }
{% endif %}

@compute @workgroup_size(WG)
fn main(@builtin(global_invocation_id) gid: vec3<u32>,
        @builtin(workgroup_id) wid: vec3<u32>,
        @builtin(local_invocation_id) lid: vec3<u32>,
        @builtin(num_workgroups) nwg: vec3<u32>) {
{% set cooperativeCopy = device.adapterInfo.vendor != "apple" %}
{% set cooperativeMerge = cooperativeCopy or shareAppend %}
{% macro appendCooperativeWalk() %}

  let wgEnd = min(elemBase + WG * HEAD_DIM, totalElems);
  for (var e = elemBase + lid.x; e < wgEnd; e = e + WG) {
    {
      let d = e % HEAD_DIM;
      let et = e / HEAD_DIM;
      let j = et % params.keySeq;
      let etmp = et / params.keySeq;
      let hk = etmp % KV_HEADS;
      let b = etmp / KV_HEADS;

      let activeEnd = min(params.seq, max(params.keySeq, u32(seqlens_k[b]) + 1u));
      let t = activeEnd - params.keySeq + j;
      let dst = ((b * KV_HEADS + hk) * params.seq + t) * HEAD_DIM + d;
      let nSrc = (b * params.keySeq + j) * KV_HIDDEN + hk * HEAD_DIM;
{% if hasKNorm %}

      var ms = 0.0;
      for (var dd = 0u; dd < HEAD_DIM; dd = dd + 1u) {
        let kv = f32(new_k[nSrc + dd]);
        ms = ms + kv * kv;
      }
      let invRms = inverseSqrt(ms / f32(HEAD_DIM) + QK_EPS);
{% endif %}
{% if hasRotary %}

      let dr = select(d - HALF, d, d < HALF);
      let cs = cos_cache[t * HALF + dr];
      let sn = sin_cache[t * HALF + dr];
      let x0 = new_k[nSrc + dr];
      let x1 = new_k[nSrc + dr + HALF];
      present_key[dst] = select(x1 * cs + x0 * sn, x0 * cs - x1 * sn, d < HALF);
{% elif hasKNorm %}

      present_key[dst] = {{ inputScalar }}(f32(new_k[nSrc + d]) * invRms * k_norm_weight[d]);
{% else %}
      present_key[dst] = new_k[nSrc + d];
{% endif %}
      present_value[dst] = new_v[nSrc + d];
    }
  }
{% endmacro %}
{% macro appendPerRowWalk() %}

  let i = gid.x + gid.y * nwg.x * WG;
  if (i >= params.count) { return; }
  let j = i % params.keySeq;
  let tmp = i / params.keySeq;
  let hk = tmp % KV_HEADS;
  let b = tmp / KV_HEADS;

  let activeEnd = min(params.seq, max(params.keySeq, u32(seqlens_k[b]) + 1u));
  let t = activeEnd - params.keySeq + j;
  let dstBase = ((b * KV_HEADS + hk) * params.seq + t) * HEAD_DIM;
  let nSrc = (b * params.keySeq + j) * KV_HIDDEN + hk * HEAD_DIM;
{% if hasKNorm %}

  var ms = 0.0;
  for (var d = 0u; d < HEAD_DIM; d = d + 1u) {
    let kv = f32(new_k[nSrc + d]);
    ms = ms + kv * kv;
  }
  let invRms = inverseSqrt(ms / f32(HEAD_DIM) + QK_EPS);
{% endif %}
{% if hasRotary %}

  var k: array<f32, HEAD_DIM>;
  for (var d = 0u; d < HEAD_DIM; d = d + 1u) { k[d] = f32(new_k[nSrc + d]); }

  for (var d = 0u; d < HALF; d = d + 1u) {
    let cs = cos_cache[t * HALF + d];
    let sn = sin_cache[t * HALF + d];
    let x0 = k[d];
    let x1 = k[d + HALF];
    k[d] = x0 * cs - x1 * sn;
    k[d + HALF] = x1 * cs + x0 * sn;
  }
  for (var d = 0u; d < HEAD_DIM; d = d + 1u) {
    present_key[dstBase + d] = k[d];
    present_value[dstBase + d] = new_v[nSrc + d];
  }
{% else %}
  for (var d = 0u; d < HEAD_DIM; d = d + 1u) {
{% if hasKNorm %}
    present_key[dstBase + d] = {{ inputScalar }}(f32(new_k[nSrc + d]) * invRms * k_norm_weight[d]);
{% else %}
    present_key[dstBase + d] = new_k[nSrc + d];
{% endif %}
    present_value[dstBase + d] = new_v[nSrc + d];
  }
{% endif %}
{% endmacro %}
{% if cooperativeMerge and (mode == "copy" or mode == "merge" or mode == "merge_share") %}

  let wgFlat = wid.x + wid.y * nwg.x;
  let elemBase = wgFlat * (WG * {{ copyRowWords }});
  let totalElems = params.count * {{ copyRowWords }};
{% endif %}
{% if mode == "copy" and cooperativeCopy %}

  for (var s = 0u; s < {{ copyRowWords }}; s = s + 1u) {
    let e = elemBase + s * WG + lid.x;
    if (e < totalElems) {
      present_key[e] = src_k[e];
      present_value[e] = src_v[e];
    }
  }
{% elif mode == "merge" and cooperativeCopy %}

  for (var s = 0u; s < HEAD_DIM; s = s + 1u) {
    let e = elemBase + s * WG + lid.x;
    if (e < totalElems) {
      let d = e % HEAD_DIM;
      let et = e / HEAD_DIM;
      let t = et % params.seq;
      let etmp = et / params.seq;
      let hk = etmp % KV_HEADS;
      let b = etmp / KV_HEADS;
      if (t < params.pastSeq) {
        let src = ((b * KV_HEADS + hk) * params.pastSeq + t) * HEAD_DIM + d;
        present_key[e] = past_k[src];
        present_value[e] = past_v[src];
      } else {
        let nSrc = (b * params.keySeq + (t - params.pastSeq)) * KV_HIDDEN + hk * HEAD_DIM + d;
        present_key[e] = new_k[nSrc];
        present_value[e] = new_v[nSrc];
      }
    }
  }
{% elif mode == "merge_share" and cooperativeMerge %}
{% if shareAppend %}
{% if cooperativeCopy %}
{{ appendCooperativeWalk() }}
{% else %}

  if (params.count < WG) {
{{ appendCooperativeWalk() }}
    return;
  }
{{ appendPerRowWalk() }}
{% endif %}
{% else %}

  for (var s = 0u; s < HEAD_DIM; s = s + 1u) {
    let e = elemBase + s * WG + lid.x;
    if (e < totalElems) {
      let d = e % HEAD_DIM;
      let et = e / HEAD_DIM;
      let t = et % params.seq;
      let etmp = et / params.seq;
      let hk = etmp % KV_HEADS;
      let b = etmp / KV_HEADS;

      let activeEnd = min(params.seq, max(params.keySeq, u32(seqlens_k[b]) + 1u));
      let appendStart = activeEnd - params.keySeq;

      if (t < appendStart || t >= activeEnd) {
        present_key[e] = past_k[e];
        present_value[e] = past_v[e];
      }
    }
  }
{% endif %}
{% elif mode == "copy" %}

  let i = gid.x + gid.y * nwg.x * WG;
  if (i >= params.count) { return; }
  let base = i * {{ copyRowWords }};
  for (var d = 0u; d < {{ copyRowWords }}; d = d + 1u) {
    present_key[base + d] = src_k[base + d];
    present_value[base + d] = src_v[base + d];
  }
{% elif mode == "merge" %}

  let i = gid.x + gid.y * nwg.x * WG;
  if (i >= params.count) { return; }
  let t = i % params.seq;
  let tmp = i / params.seq;
  let hk = tmp % KV_HEADS;
  let b = tmp / KV_HEADS;

  let dstBase = ((b * KV_HEADS + hk) * params.seq + t) * HEAD_DIM;
  if (t < params.pastSeq) {
    let srcBase = ((b * KV_HEADS + hk) * params.pastSeq + t) * HEAD_DIM;
    for (var d = 0u; d < HEAD_DIM; d = d + 1u) {
      present_key[dstBase + d] = past_k[srcBase + d];
      present_value[dstBase + d] = past_v[srcBase + d];
    }
  } else {
    let nSrc = (b * params.keySeq + (t - params.pastSeq)) * KV_HIDDEN + hk * HEAD_DIM;
    for (var d = 0u; d < HEAD_DIM; d = d + 1u) {
      present_key[dstBase + d] = new_k[nSrc + d];
      present_value[dstBase + d] = new_v[nSrc + d];
    }
  }
{% elif mode == "merge_share" %}
{% if shareAppend %}
{{ appendPerRowWalk() }}
{% else %}

  let i = gid.x + gid.y * nwg.x * WG;
  if (i >= params.count) { return; }
  let t = i % params.seq;
  let tmp = i / params.seq;
  let hk = tmp % KV_HEADS;
  let b = tmp / KV_HEADS;

  let activeEnd = min(params.seq, max(params.keySeq, u32(seqlens_k[b]) + 1u));
  let appendStart = activeEnd - params.keySeq;
  let dstBase = ((b * KV_HEADS + hk) * params.seq + t) * HEAD_DIM;

  if (t < appendStart || t >= activeEnd) {
    for (var d = 0u; d < HEAD_DIM; d = d + 1u) {
      present_key[dstBase + d] = past_k[dstBase + d];
      present_value[dstBase + d] = past_v[dstBase + d];
  }
  }
{% endif %}
{% elif mode == "window_shift" %}

  let i = gid.x + gid.y * nwg.x * WG;
  if (i >= params.count) { return; }
  let t = i % params.seq;
  let tmp = i / params.seq;
  let hk = tmp % KV_HEADS;
  let b = tmp / KV_HEADS;
  let absTotal = max(params.keySeq, u32(seqlens_k[b]) + 1u);
  let residentBefore = min(absTotal - params.keySeq, params.seq);

  let filled = residentBefore + params.keySeq;
  let evicted = select(0u, filled - params.seq, filled > params.seq);
  let appendStart = residentBefore - evicted;
  let dstBase = ((b * KV_HEADS + hk) * params.seq + t) * HEAD_DIM;
  if (t < appendStart) {

    let srcBase = ((b * KV_HEADS + hk) * params.seq + (t + evicted)) * HEAD_DIM;
    for (var d = 0u; d < HEAD_DIM; d = d + 1u) {
      present_key[dstBase + d] = past_k[srcBase + d];
      present_value[dstBase + d] = past_v[srcBase + d];
    }
  } else if (t < appendStart + params.keySeq) {
    let nSrc = (b * params.keySeq + (t - appendStart)) * KV_HIDDEN + hk * HEAD_DIM;
    for (var d = 0u; d < HEAD_DIM; d = d + 1u) {
      present_key[dstBase + d] = new_k[nSrc + d];
      present_value[dstBase + d] = new_v[nSrc + d];
    }
  } else {

    for (var d = 0u; d < HEAD_DIM; d = d + 1u) {
      present_key[dstBase + d] = {{ zeroScalar }}(0.0);
      present_value[dstBase + d] = {{ zeroScalar }}(0.0);
    }
  }
{% else %}

  let i = gid.x + gid.y * nwg.x * WG;
  if (i >= params.count) { return; }
  let t = i % params.seq;
  let tmp = i / params.seq;
  let hk = tmp % KV_HEADS;
  let b = tmp / KV_HEADS;
  let srcBase = (b * params.seq + t) * KV_HIDDEN + hk * HEAD_DIM;
  var k: array<f32, HEAD_DIM>;
  for (var d = 0u; d < HEAD_DIM; d = d + 1u) { k[d] = src_k[srcBase + d]; }
{% if hasKNorm %}
  var ms = 0.0;
  for (var d = 0u; d < HEAD_DIM; d = d + 1u) { ms = ms + k[d] * k[d]; }
  let invRms = inverseSqrt(ms / f32(HEAD_DIM) + QK_EPS);
  for (var d = 0u; d < HEAD_DIM; d = d + 1u) { k[d] = k[d] * invRms * k_norm_weight[d]; }
{% endif %}
{% if hasRotary %}
  let pos = params.pastSeq + t;
  for (var d = 0u; d < HALF; d = d + 1u) {
    let cs = cos_cache[pos * HALF + d];
    let sn = sin_cache[pos * HALF + d];
    let x0 = k[d];
    let x1 = k[d + HALF];
    k[d] = x0 * cs - x1 * sn;
    k[d + HALF] = x1 * cs + x0 * sn;
  }
{% endif %}
{% if mode == "build" %}
  let dstBase = ((b * KV_HEADS + hk) * params.seq + t) * HEAD_DIM;
  for (var d = 0u; d < HEAD_DIM; d = d + 1u) {
    present_key[dstBase + d] = k[d];
    present_value[dstBase + d] = src_v[srcBase + d];
  }
{% else %}
{% if mode == "append_quant" %}
  let activeEnd = u32(seqlens_k[b]) + 1u;
  let appendStart = activeEnd - params.seq;
  let dstBase = ((b * KV_HEADS + hk) * params.totalSeq + appendStart + t) * PACKED;
{% else %}
  let dstBase = ((b * KV_HEADS + hk) * params.seq + t) * PACKED;
{% endif %}
{% if bits == 8 %}
  for (var d = 0u; d < HEAD_DIM; d = d + 1u) {
    present_key[dstBase + d] = i32(clamp(round(k[d] / kscale(d, hk)), QMIN, QMAX));
    present_value[dstBase + d] = i32(clamp(round(src_v[srcBase + d] / vscale(d, hk)), QMIN, QMAX));
  }
{% else %}
  for (var dd = 0u; dd < PACKED; dd = dd + 1u) {
    let d0 = dd * 2u;
    let d1 = dd * 2u + 1u;
    let qk0 = i32(clamp(round(k[d0] / kscale(d0, hk)), QMIN, QMAX));
    let qk1 = i32(clamp(round(k[d1] / kscale(d1, hk)), QMIN, QMAX));
    let qv0 = i32(clamp(round(src_v[srcBase + d0] / vscale(d0, hk)), QMIN, QMAX));
    let qv1 = i32(clamp(round(src_v[srcBase + d1] / vscale(d1, hk)), QMIN, QMAX));
    present_key[dstBase + dd] = (u32(qk0) & 0xFu) | ((u32(qk1) & 0xFu) << 4u);
    present_value[dstBase + dd] = (u32(qv0) & 0xFu) | ((u32(qv1) & 0xFu) << 4u);
  }
{% endif %}
{% endif %}
{% endif %}
}
{%- endif %}
`]]}],["com.xenova.LlamaEmbed",{manifest:{domain:"com.xenova",name:"LlamaEmbed",sinceVersion:1,inputs:[{role:"InputToken",dtype:"uint32",rank:1},{role:"Weights",dtype:"W",rank:1,optional:!0},{role:"Bits",dtype:"uint32",rank:1,optional:!0},{role:"Scales",dtype:"S",rank:1,optional:!0}],outputs:[{role:"Hidden",dtype:"Y"}],typeConstraints:{W:["float32","float16"],S:["float32","float16","uint32"],Y:["float32","float16"]},args:{inputT:{kind:"tensor",semantic:"InputToken",role:"input"},weightsT:{kind:"tensor",semantic:"Weights",role:"weights",required:!1},hiddenT:{kind:"tensor",semantic:"Hidden",role:"output"},hiddenSize:{kind:"u32",semantic:"hidden_size"},vocabSize:{kind:"u32",semantic:"vocab_size"},embedOffset:{kind:"u32",semantic:"embed_offset",required:!1},tokenOffset:{kind:"u32",semantic:"token_offset",required:!1},pastLen:{kind:"u32",semantic:"past_len",required:!1},cacheLen:{kind:"u32",semantic:"cache_len",required:!1},seqLen:{kind:"u32",semantic:"seq_len",required:!1},bitsT:{kind:"tensor",semantic:"Bits",role:"weights",required:!1},scalesT:{kind:"tensor",semantic:"Scales",role:"weights",required:!1},format:{kind:"string",semantic:"packed_quant_format",required:!1,oneOf:["q1_0","q8_rows","q4_0","q4_k","q4_k_native","q4_k_native_compact","q6_k"]}},derive:{decodeMode:"args.seqLen is undefined",prefillMode:"args.seqLen is defined",denseMode:"present.weightsT and not present.bitsT",q1Mode:'present.bitsT and present.scalesT and args.format == "q1_0"',q8Mode:'present.bitsT and present.scalesT and args.format == "q8_rows"',decodeContract:'decodeMode and ranks.inputT == 1 and ranks.hiddenT == 1 and tensorDtypes.inputT == "uint32" and tensorDtypes.hiddenT == "float32" and args.hiddenSize > 0 and args.vocabSize > 0 and dim(shapes.hiddenT, 0) == args.hiddenSize and dim(shapes.inputT, 0) > (args.tokenOffset if args.tokenOffset else 0)',prefillContract:'prefillMode and ranks.inputT == 1 and ranks.hiddenT == 2 and tensorDtypes.inputT == "uint32" and args.hiddenSize > 0 and args.seqLen > 0 and args.vocabSize > 0 and dim(shapes.hiddenT, 0) == args.seqLen and dim(shapes.hiddenT, 1) == args.hiddenSize and numel(shapes.inputT) >= args.seqLen',prefillF16Ok:"f16Ok(dtypes.Y)",kq4Mode:'present.bitsT and present.scalesT and (args.format == "q4_0" or args.format == "q4_k")',kq4Blocks:"args.vocabSize * (args.hiddenSize / 32) if (args.vocabSize is defined and args.hiddenSize is defined) else 0",q6kMode:'present.bitsT and present.scalesT and args.format == "q6_k"',q6kBlocks:"args.vocabSize * (args.hiddenSize / 32) if (args.vocabSize is defined and args.hiddenSize is defined) else 0",q6kSupers:"q6kBlocks / 8"},constants:{hiddenSize:"args.hiddenSize"},bindingSets:{prefillQ6k:[{name:"tokens",arg:"inputT",semantic:"InputToken",buffer:{type:"read-only-storage"},elementType:"u32"},{name:"q6_bits",arg:"bitsT",semantic:"Bits",buffer:{type:"read-only-storage"},elementType:"u32"},{name:"q6_scales",arg:"scalesT",semantic:"Scales",buffer:{type:"read-only-storage"},elementType:"$scaleScalar"},{name:"hidden",arg:"hiddenT",semantic:"Hidden",buffer:{type:"storage"},elementType:"$outScalar"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"seq_len",type:"u32",value:"args.seqLen"}]}}]},variants:[{id:"prefill_q6k",priority:0,when:["prefillContract","q6kMode","ranks.bitsT == 1","ranks.scalesT == 1",'tensorDtypes.bitsT == "uint32"','(tensorDtypes.scalesT == "float32" or tensorDtypes.scalesT == "float16")',"args.hiddenSize % 256 == 0","dim(shapes.bitsT, 0) >= q6kSupers * 52","dim(shapes.scalesT, 0) >= q6kSupers","prefillF16Ok and f16Ok(dtypes.S)"],constants:{usesF16:'tensorDtypes.scalesT == "float16" or tensorDtypes.hiddenT == "float16"',scaleScalar:"dtypes.S",outScalar:"dtypes.Y",blocksPerRow:"args.hiddenSize / 32",isPrefill:!0},passes:[{id:"main",name:"LlamaPrefillEmbedQ6K",shader:"embed-q6k.wgsl.jinja",bindings:"prefillQ6k",dispatch:{threads:"args.seqLen * args.hiddenSize",workgroupSize:"64"}}]}]},assets:[["embed-q6k.wgsl.jinja",`{% if usesF16 %}
enable f16;
{% endif %}

{{ env.wgsl.resourceDeclarations }}

const HIDDEN_SIZE: u32 = {{ hiddenSize }}u;
const BLOCKS_PER_ROW: u32 = {{ blocksPerRow }}u;

fn q6_value(block: u32, element_in_block: u32) -> f32 {
  let superblock = block >> 3u;
  let j = block & 7u;
  let plane = element_in_block >> 4u;
  let e = element_in_block & 15u;
  let word = q6_bits[superblock * 52u + j * 4u + (e >> 2u)];
  let nibble = (word >> ((e & 3u) * 8u + plane * 4u)) & 15u;
  let hi_word = q6_bits[superblock * 52u + 32u + j * 2u + plane];
  let hi2 = (hi_word >> ((e & 3u) * 8u + (e >> 2u) * 2u)) & 3u;
  let scale_word = q6_bits[superblock * 52u + 48u + (j >> 1u)];
  let scale_byte = (scale_word >> (((j & 1u) * 2u + plane) * 8u)) & 255u;
  let sub_scale = select(i32(scale_byte), i32(scale_byte) - 256, scale_byte >= 128u);
  let code = i32(nibble | (hi2 << 4u)) - 32;
  let scale = f32(q6_scales[superblock]) * f32(sub_scale);
  return f32(code) * scale;
}

{% if isPrefill %}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let g = gid.x + gid.y * nwg.x * 64u;
  let total = params.seq_len * HIDDEN_SIZE;
  if (g >= total) {
    return;
  }
  let token_index = g / HIDDEN_SIZE;
  let dim = g % HIDDEN_SIZE;
  let block = tokens[token_index] * BLOCKS_PER_ROW + dim / 32u;
  hidden[g] = {{ outScalar }}(q6_value(block, dim & 31u));
}
{% else %}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = gid.x;
  if (dim >= HIDDEN_SIZE) {
    return;
  }
  let block = input_token[params.token_offset] * BLOCKS_PER_ROW + dim / 32u;
  hidden[dim] = q6_value(block, dim & 31u);
}
{% endif %}
`]]}],["com.xenova.LlamaPrefillMatmul",{manifest:{domain:"com.xenova",name:"LlamaPrefillMatmul",sinceVersion:1,inputs:[{role:"A",dtype:"A",rank:2},{role:"Weights",dtype:"W",rank:1,optional:!0},{role:"Bits",dtype:"uint32",rank:1,optional:!0},{role:"Scales",dtype:"S",rank:1,optional:!0},{role:"RealLen",dtype:"uint32",rank:1,optional:!0},{role:"Y",dtype:"Y",rank:2}],outputs:[{role:"Y",dtype:"Y",rank:2,shape:["args.M","args.outStride if args.outStride else args.outFeatures"]},{role:"Partials",dtype:"float32",rank:1,optional:!0}],tunables:{PORTABLE_LUT4_MVEC:4,SMALL_M_SPLIT_K:1,SMALL_M_N128_SPLIT_K:1,SMALL_M_SPLIT_K_VALUE:4,SMALL_M_DEEP_SPLIT_K:16,SMALL_M_N128_EXPAND_SPLIT_K:4,SMALL_M_N128_NARROW_SPLIT_K:16},typeConstraints:{A:["float32","float16"],W:["float32","float16"],S:["float32","float16","uint32"],Y:["float32","float16"]},args:{aT:{kind:"tensor",semantic:"A",role:"input"},weightsT:{kind:"tensor",semantic:"Weights",role:"weights",required:!1},bitsT:{kind:"tensor",semantic:"Bits",role:"weights",required:!1},scalesT:{kind:"tensor",semantic:"Scales",role:"weights",required:!1},realLenT:{kind:"tensor",semantic:"RealLen",role:"input",required:!1},yT:{kind:"tensor",semantic:"Y",role:"inout"},partialsT:{kind:"tensor",semantic:"Partials",role:"output",required:!1},M:{kind:"u32",semantic:"M"},inFeatures:{kind:"u32",semantic:"in_features"},outFeatures:{kind:"u32",semantic:"out_features"},weightOffset:{kind:"u32",semantic:"weight_offset",required:!1},blockOffset:{kind:"u32",semantic:"block_offset",required:!1},outStride:{kind:"u32",semantic:"out_stride",required:!1},dstColStart:{kind:"u32",semantic:"dst_col_start",required:!1},format:{kind:"string",semantic:"packed_quant_format",required:!1,oneOf:["q4_0","q4_k","q4_k_native","q4_k_native_compact","q8_0","iq","lut32","lut16","q5_0","q2_k","q3_k","q6_k","q5_k","q1_0"]},lut:{kind:"u32",semantic:"dequant_lut_id",required:!1},exact:{kind:"u32",semantic:"exact_f32_tiles",required:!1},kSplits:{kind:"u32",semantic:"k_splits",required:!1}},bindingSets:{denseQ4:[{name:"a",arg:"aT",semantic:"A",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"q4_bits",arg:"bitsT",semantic:"Bits",buffer:{type:"read-only-storage"},elementType:"u32"},{name:"q4_scales",arg:"scalesT",semantic:"Scales",buffer:{type:"read-only-storage"},elementType:"$scaleScalar"},{name:"y",arg:"yT",semantic:"Y",buffer:{type:"storage"},elementType:"f32"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"block_offset",type:"u32",value:"args.blockOffset"},{name:"m",type:"u32",value:"args.M"}]}}],decodeQ4:[{name:"a",arg:"aT",semantic:"A",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"q4_bits",arg:"bitsT",semantic:"Bits",buffer:{type:"read-only-storage"},elementType:"vec4<u32>"},{name:"q4_scales",arg:"scalesT",semantic:"Scales",buffer:{type:"read-only-storage"},elementType:"$scaleScalar"},{name:"y",arg:"yT",semantic:"Y",buffer:{type:"storage"},elementType:"f32"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"block_offset",type:"u32",value:"args.blockOffset"},{name:"m",type:"u32",value:"args.M"}]}}],denseQ4Compact:[{name:"a",arg:"aT",semantic:"A",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"q4_bits",arg:"bitsT",semantic:"Bits",buffer:{type:"read-only-storage"},elementType:"u32"},{name:"q4_metadata",arg:"scalesT",semantic:"Scales",buffer:{type:"read-only-storage"},elementType:"u32"},{name:"y",arg:"yT",semantic:"Y",buffer:{type:"storage"},elementType:"f32"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"block_offset",type:"u32",value:"args.blockOffset"},{name:"m",type:"u32",value:"args.M"}]}}],decodeQ4Compact:[{name:"a",arg:"aT",semantic:"A",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"q4_bits",arg:"bitsT",semantic:"Bits",buffer:{type:"read-only-storage"},elementType:"vec4<u32>"},{name:"q4_metadata",arg:"scalesT",semantic:"Scales",buffer:{type:"read-only-storage"},elementType:"u32"},{name:"y",arg:"yT",semantic:"Y",buffer:{type:"storage"},elementType:"f32"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"block_offset",type:"u32",value:"args.blockOffset"},{name:"m",type:"u32",value:"args.M"}]}}]},derive:{fmt:'args.format if args.format else "q4_0"',quantBits:'8 if (fmt == "q8_0" or fmt == "q8_0_pair" or fmt == "iq") else 4',q8Pair:'1 if fmt == "q8_0_pair" else 0',hasMin:'1 if fmt == "q4_k" else 0',iq:'1 if fmt == "iq" else 0',lut16:'1 if fmt == "lut16" else 0',q5:'1 if fmt == "q5_0" else 0',q2k:'1 if fmt == "q2_k" else 0',q3k:'1 if fmt == "q3_k" else 0',q6k:'1 if fmt == "q6_k" else 0',q5k:'1 if fmt == "q5_k" else 0',wave32Adapter:'has(device.adapterInfo, "subgroupMinSize") and has(device.adapterInfo, "subgroupMaxSize") and device.adapterInfo.subgroupMinSize == 32 and device.adapterInfo.subgroupMaxSize == 32',subgroupsWave32:'device.features.has("subgroups") and wave32Adapter',narrowSubgroupRange:'has(device.adapterInfo, "subgroupMinSize") and has(device.adapterInfo, "subgroupMaxSize") and device.adapterInfo.subgroupMinSize < device.adapterInfo.subgroupMaxSize and device.adapterInfo.subgroupMaxSize <= 16',subgroupsWide32:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize >= 32',reportedNonWave32Adapter:'not wave32Adapter and (has(device.adapterInfo, "subgroupMinSize") or has(device.adapterInfo, "subgroupMaxSize"))',q1Present:'present.bitsT and present.scalesT and fmt == "q1_0"',q4Present:'present.bitsT and present.scalesT and fmt != "q1_0" and fmt != "q4_k_native" and fmt != "q4_k_native_compact" and fmt != "q5_k"',q4knPresent:'present.bitsT and present.scalesT and fmt == "q4_k_native"',q4knCompactPresent:'present.bitsT and present.scalesT and fmt == "q4_k_native_compact"',q5kPresent:'present.bitsT and present.scalesT and fmt == "q5_k"',q1Blocks:"(args.blockOffset if q1Present else 0) + args.outFeatures * (args.inFeatures / 128)",q1BaseContract:'q1Present and ranks.aT == 2 and ranks.bitsT == 1 and ranks.scalesT == 1 and ranks.yT == 2 and tensorDtypes.bitsT == "uint32" and (tensorDtypes.scalesT == "float32" or tensorDtypes.scalesT == "float16") and (tensorDtypes.yT == "float32" or tensorDtypes.yT == "float16") and args.M > 0 and args.inFeatures > 0 and args.inFeatures % 128 == 0 and args.outFeatures > 0 and args.dstColStart + args.outFeatures <= args.outStride and numel(shapes.aT) >= args.M * args.inFeatures and numel(shapes.yT) >= args.M * args.outStride and numel(shapes.bitsT) >= q1Blocks * 4 and numel(shapes.scalesT) >= q1Blocks',q4Blocks:"(args.blockOffset if q4Present else 0) + args.outFeatures * (args.inFeatures / 32)",splitCount:"args.kSplits if args.kSplits else 1",q4BaseContract:'q4Present and ranks.aT == 2 and ranks.bitsT == 1 and ranks.scalesT == 1 and ranks.yT == 2 and tensorDtypes.bitsT == "uint32" and (tensorDtypes.scalesT == "float32" or tensorDtypes.scalesT == "float16") and f16Ok(tensorDtypes.scalesT) and (quantBits == 4 or quantBits == 8) and args.M > 0 and args.inFeatures > 0 and args.inFeatures % 32 == 0 and args.outFeatures > 0 and args.dstColStart + args.outFeatures <= args.outStride and numel(shapes.aT) >= args.M * args.inFeatures and numel(shapes.yT) >= args.M * args.outStride and numel(shapes.scalesT) >= (q4Blocks / 4 if q2k else (q4Blocks / 8 if (q6k or q3k) else q4Blocks * (2 if (hasMin or iq or lut16) else 1))) and numel(shapes.bitsT) >= q4Blocks * (2.5 if q2k else (3.5 if q3k else (6.5 if q6k else (5 if q5 else quantBits))))',decodeGemvContract:'q4BaseContract and args.M == 1 and splitCount == 1 and tensorDtypes.aT == "float32" and tensorDtypes.yT == "float32" and not q5 and numel(shapes.bitsT) % 4 == 0 and (not (q2k or q3k or q6k) or (args.blockOffset % 8 == 0 and args.inFeatures % 256 == 0))',q4knBlocks:"(args.blockOffset if q4knPresent else 0) + args.outFeatures * (args.inFeatures / 32)",q4knBaseContract:'q4knPresent and ranks.aT == 2 and ranks.bitsT == 1 and ranks.scalesT == 1 and ranks.yT == 2 and tensorDtypes.aT == "float32" and tensorDtypes.bitsT == "uint32" and tensorDtypes.scalesT == "float32" and tensorDtypes.yT == "float32" and args.M > 0 and args.inFeatures > 0 and args.inFeatures % 256 == 0 and args.outFeatures > 0 and args.blockOffset % 8 == 0 and args.dstColStart + args.outFeatures <= args.outStride and numel(shapes.aT) >= args.M * args.inFeatures and numel(shapes.yT) >= args.M * args.outStride and numel(shapes.bitsT) % 4 == 0 and numel(shapes.bitsT) >= q4knBlocks * 4 and numel(shapes.scalesT) >= (q4knBlocks / 8) * 6',q4knDecodeGemvContract:"q4knBaseContract and args.M == 1 and splitCount == 1",q4knCompactBlocks:"(args.blockOffset if q4knCompactPresent else 0) + args.outFeatures * (args.inFeatures / 32)",q4knCompactBaseContract:'q4knCompactPresent and ranks.aT == 2 and ranks.bitsT == 1 and ranks.scalesT == 1 and ranks.yT == 2 and tensorDtypes.aT == "float32" and tensorDtypes.bitsT == "uint32" and tensorDtypes.scalesT == "uint32" and tensorDtypes.yT == "float32" and args.M > 0 and args.inFeatures > 0 and args.inFeatures % 256 == 0 and args.outFeatures > 0 and args.blockOffset % 8 == 0 and args.dstColStart + args.outFeatures <= args.outStride and numel(shapes.aT) >= args.M * args.inFeatures and numel(shapes.yT) >= args.M * args.outStride and numel(shapes.bitsT) % 4 == 0 and numel(shapes.bitsT) >= q4knCompactBlocks * 4 and numel(shapes.scalesT) >= (q4knCompactBlocks / 8) * 5',q4knCompactDecodeGemvContract:"q4knCompactBaseContract and args.M == 1 and splitCount == 1",q5kBlocks:"(args.blockOffset if q5kPresent else 0) + args.outFeatures * (args.inFeatures / 32)",q5kBaseContract:'q5kPresent and ranks.aT == 2 and ranks.bitsT == 1 and ranks.scalesT == 1 and ranks.yT == 2 and tensorDtypes.aT == "float32" and tensorDtypes.bitsT == "uint32" and tensorDtypes.scalesT == "float32" and tensorDtypes.yT == "float32" and args.M > 0 and args.inFeatures > 0 and args.inFeatures % 256 == 0 and args.outFeatures > 0 and args.blockOffset % 8 == 0 and args.dstColStart + args.outFeatures <= args.outStride and numel(shapes.aT) >= args.M * args.inFeatures and numel(shapes.yT) >= args.M * args.outStride and numel(shapes.scalesT) >= q5kBlocks / 4 and numel(shapes.bitsT) >= q5kBlocks * 5.5',q5kDecodeGemvContract:'q5kBaseContract and args.M == 1 and splitCount == 1 and tensorDtypes.aT == "float32" and tensorDtypes.yT == "float32" and numel(shapes.bitsT) % 4 == 0'},variants:[{id:"tiled_f16",priority:50,when:["not args.exact","q4BaseContract",'tensorDtypes.aT == "float32"','tensorDtypes.yT == "float32"',"ceil(args.outFeatures / (16 if args.M <= 8 else 32)) <= device.limits.maxComputeWorkgroupsPerDimension","ceil(args.M / (8 if args.M <= 8 else (32 if (args.M > 16 and args.outFeatures >= 8192) else 16))) <= device.limits.maxComputeWorkgroupsPerDimension"],constants:{usesF16:'tensorDtypes.scalesT == "float16"',quantBits:"quantBits",hasMin:"hasMin",iq:"iq",lutId:"args.lut if args.lut else 0",lut16:"lut16",q5:"q5",q2k:"q2k",q3k:"q3k",q6k:"q6k",scaleScalar:"dtypes.S",inFeatures:"args.inFeatures",outFeatures:"args.outFeatures",outStride:"args.outStride",dstColStart:"args.dstColStart",f16Tiles:"1",kBlocks:"1",bn:"16 if args.M <= 8 else 32",bm:"8 if args.M <= 8 else (32 if (args.M > 16 and args.outFeatures >= 8192) else 16)",nTile:"16 if args.M <= 8 else (4 if (args.M > 16 and args.outFeatures >= 8192) else 8)",accs:"1 if args.M <= 8 else (8 if (args.M > 16 and args.outFeatures >= 8192) else 4)"},passes:[{id:"main",name:"LlamaPrefillMatmulQ4",shader:"prefill-matmul-q4.wgsl.jinja",bindings:"denseQ4",dispatch:{x:"min(ceil(args.outFeatures / (16 if args.M <= 8 else 32)), device.limits.maxComputeWorkgroupsPerDimension)",y:"min(ceil(args.M / (8 if args.M <= 8 else (32 if (args.M > 16 and args.outFeatures >= 8192) else 16))), device.limits.maxComputeWorkgroupsPerDimension)"}}],requires:{features:["shader-f16"]}},{id:"tiled_exact",priority:0,when:["q4BaseContract",'tensorDtypes.aT == "float32"','tensorDtypes.yT == "float32"',"ceil(args.outFeatures / (16 if args.M <= 8 else 32)) <= device.limits.maxComputeWorkgroupsPerDimension","ceil(args.M / (8 if args.M <= 8 else (32 if (args.M > 16 and args.outFeatures >= 8192) else 16))) <= device.limits.maxComputeWorkgroupsPerDimension"],constants:{usesF16:'tensorDtypes.scalesT == "float16"',f16Tiles:"0",quantBits:"quantBits",hasMin:"hasMin",iq:"iq",lutId:"args.lut if args.lut else 0",lut16:"lut16",q5:"q5",q2k:"q2k",q3k:"q3k",q6k:"q6k",scaleScalar:"dtypes.S",inFeatures:"args.inFeatures",outFeatures:"args.outFeatures",outStride:"args.outStride",dstColStart:"args.dstColStart",kBlocks:"1 if args.M <= 8 else 2",bn:"16 if args.M <= 8 else 32",bm:"8 if args.M <= 8 else (32 if (args.M > 16 and args.outFeatures >= 8192) else 16)",nTile:"16 if args.M <= 8 else (4 if (args.M > 16 and args.outFeatures >= 8192) else 8)",accs:"1 if args.M <= 8 else (8 if (args.M > 16 and args.outFeatures >= 8192) else 4)"},passes:[{id:"main",name:"LlamaPrefillMatmulQ4",shader:"prefill-matmul-q4.wgsl.jinja",bindings:"denseQ4",dispatch:{x:"min(ceil(args.outFeatures / (16 if args.M <= 8 else 32)), device.limits.maxComputeWorkgroupsPerDimension)",y:"min(ceil(args.M / (8 if args.M <= 8 else (32 if (args.M > 16 and args.outFeatures >= 8192) else 16))), device.limits.maxComputeWorkgroupsPerDimension)"}}]},{id:"q4_subgroup_matrix",priority:100,requires:{features:["shader-f16","subgroups","chromium-experimental-subgroup-matrix"],subgroupMatrixConfigs:[{componentType:"f16",M:8,N:8,K:8}]},when:["not args.exact","q4BaseContract","args.M > 8","ceil(args.outFeatures / 32) <= device.limits.maxComputeWorkgroupsPerDimension","ceil(args.M / 16) <= device.limits.maxComputeWorkgroupsPerDimension",'(tensorDtypes.yT == "float32" or tensorDtypes.yT == "float16")',"args.outFeatures % 64 == 0","not q5","(not (q2k or q6k) or (args.inFeatures % 256 == 0 and args.blockOffset % 8 == 0))","wave32Adapter"],constants:{quantBits:"quantBits",hasMin:"hasMin",iq:"iq",lutId:"args.lut if args.lut else 0",lut16:"lut16",q5:"q5",q2k:"q2k",q3k:"q3k",q6k:"q6k",scaleScalar:"dtypes.S",inFeatures:"args.inFeatures",outFeatures:"args.outFeatures",outStride:"args.outStride",dstColStart:"args.dstColStart if args.dstColStart else 0",yScalar:'"f16" if tensorDtypes.yT == "float16" else "f32"',aVec4:'"vec4<f16>" if tensorDtypes.aT == "float16" else "vec4<f32>"',smallM:"1 if (args.M <= 16 and args.outFeatures % 64 == 0) else 0"},passes:[{id:"main",name:"LlamaPrefillMatmulQ4Sg",shader:"prefill-matmul-q4-sg.wgsl.jinja",bindings:[{name:"a",arg:"aT",semantic:"A",buffer:{type:"read-only-storage"},elementType:"$aVec4"},{name:"q4_bits",arg:"bitsT",semantic:"Bits",buffer:{type:"read-only-storage"},elementType:"vec4<u32>"},{name:"q4_scales",arg:"scalesT",semantic:"Scales",buffer:{type:"read-only-storage"},elementType:"$scaleScalar"},{name:"y",arg:"yT",semantic:"Y",buffer:{type:"storage"},elementType:"$yScalar"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"block_offset",type:"u32",value:"args.blockOffset"},{name:"m",type:"u32",value:"args.M"}]}}],dispatch:{x:"ceil(args.outFeatures / (128 if (args.M <= 16 and args.outFeatures % 64 == 0) else 64))",y:"ceil(args.M / (16 if (args.M <= 16 and args.outFeatures % 64 == 0) else 32))"}}]},{id:"q4kn_compact_tiled_f16",priority:50,requires:{features:["shader-f16"]},when:["not args.exact","q4knCompactBaseContract","ceil(args.outFeatures / (16 if args.M <= 8 else 32)) <= device.limits.maxComputeWorkgroupsPerDimension","ceil(args.M / (8 if args.M <= 8 else (32 if (args.M > 16 and args.outFeatures >= 8192) else 16))) <= device.limits.maxComputeWorkgroupsPerDimension"],constants:{usesF16:!1,f16Tiles:1,quantBits:4,hasMin:!1,iq:!1,lutId:0,lut16:!1,q5:!1,q2k:!1,q3k:!1,q6k:!1,q5k:!1,q4kn:!1,q4knCompact:!0,inFeatures:"args.inFeatures",outFeatures:"args.outFeatures",outStride:"args.outStride",dstColStart:"args.dstColStart",kBlocks:1,bn:"16 if args.M <= 8 else 32",bm:"8 if args.M <= 8 else (32 if (args.M > 16 and args.outFeatures >= 8192) else 16)",nTile:"16 if args.M <= 8 else (4 if (args.M > 16 and args.outFeatures >= 8192) else 8)",accs:"1 if args.M <= 8 else (8 if (args.M > 16 and args.outFeatures >= 8192) else 4)"},passes:[{id:"main",name:"LlamaPrefillMatmulQ4KNativeCompact",shader:"prefill-matmul-q4.wgsl.jinja",bindings:"denseQ4Compact",dispatch:{x:"min(ceil(args.outFeatures / (16 if args.M <= 8 else 32)), device.limits.maxComputeWorkgroupsPerDimension)",y:"min(ceil(args.M / (8 if args.M <= 8 else (32 if (args.M > 16 and args.outFeatures >= 8192) else 16))), device.limits.maxComputeWorkgroupsPerDimension)"}}]},{id:"q4kn_compact_tiled_exact",priority:0,when:["q4knCompactBaseContract","ceil(args.outFeatures / (16 if args.M <= 8 else 32)) <= device.limits.maxComputeWorkgroupsPerDimension","ceil(args.M / (8 if args.M <= 8 else (32 if (args.M > 16 and args.outFeatures >= 8192) else 16))) <= device.limits.maxComputeWorkgroupsPerDimension"],constants:{usesF16:!1,f16Tiles:0,quantBits:4,hasMin:!1,iq:!1,lutId:0,lut16:!1,q5:!1,q2k:!1,q3k:!1,q6k:!1,q5k:!1,q4kn:!1,q4knCompact:!0,inFeatures:"args.inFeatures",outFeatures:"args.outFeatures",outStride:"args.outStride",dstColStart:"args.dstColStart",kBlocks:"1 if args.M <= 8 else 2",bn:"16 if args.M <= 8 else 32",bm:"8 if args.M <= 8 else (32 if (args.M > 16 and args.outFeatures >= 8192) else 16)",nTile:"16 if args.M <= 8 else (4 if (args.M > 16 and args.outFeatures >= 8192) else 8)",accs:"1 if args.M <= 8 else (8 if (args.M > 16 and args.outFeatures >= 8192) else 4)"},passes:[{id:"main",name:"LlamaPrefillMatmulQ4KNativeCompact",shader:"prefill-matmul-q4.wgsl.jinja",bindings:"denseQ4Compact",dispatch:{x:"min(ceil(args.outFeatures / (16 if args.M <= 8 else 32)), device.limits.maxComputeWorkgroupsPerDimension)",y:"min(ceil(args.M / (8 if args.M <= 8 else (32 if (args.M > 16 and args.outFeatures >= 8192) else 16))), device.limits.maxComputeWorkgroupsPerDimension)"}}]},{id:"q4kn_compact_subgroup_matrix",priority:100,requires:{features:["shader-f16","subgroups","chromium-experimental-subgroup-matrix"],subgroupMatrixConfigs:[{componentType:"f16",M:8,N:8,K:8}]},when:["not args.exact","q4knCompactBaseContract","args.M > 8","ceil(args.outFeatures / 32) <= device.limits.maxComputeWorkgroupsPerDimension","ceil(args.M / 16) <= device.limits.maxComputeWorkgroupsPerDimension","args.outFeatures % 64 == 0","wave32Adapter"],constants:{quantBits:4,hasMin:!1,iq:!1,lutId:0,lut16:!1,q5:!1,q2k:!1,q3k:!1,q6k:!1,q5k:!1,q4kn:!1,q4knCompact:!0,inFeatures:"args.inFeatures",outFeatures:"args.outFeatures",outStride:"args.outStride",dstColStart:"args.dstColStart if args.dstColStart else 0",yScalar:'"f32"',aVec4:'"vec4<f32>"',smallM:"1 if (args.M <= 16 and args.outFeatures % 64 == 0) else 0"},passes:[{id:"main",name:"LlamaPrefillMatmulQ4KNativeCompactSg",shader:"prefill-matmul-q4-sg.wgsl.jinja",bindings:[{name:"a",arg:"aT",semantic:"A",buffer:{type:"read-only-storage"},elementType:"$aVec4"},{name:"q4_bits",arg:"bitsT",semantic:"Bits",buffer:{type:"read-only-storage"},elementType:"vec4<u32>"},{name:"q4_metadata",arg:"scalesT",semantic:"Scales",buffer:{type:"read-only-storage"},elementType:"u32"},{name:"y",arg:"yT",semantic:"Y",buffer:{type:"storage"},elementType:"$yScalar"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"block_offset",type:"u32",value:"args.blockOffset"},{name:"m",type:"u32",value:"args.M"}]}}],dispatch:{x:"ceil(args.outFeatures / (128 if (args.M <= 16 and args.outFeatures % 64 == 0) else 64))",y:"ceil(args.M / (16 if (args.M <= 16 and args.outFeatures % 64 == 0) else 32))"}}]},{id:"q5k_tiled_f16",priority:50,requires:{features:["shader-f16"]},when:["not args.exact","q5kBaseContract",'tensorDtypes.aT == "float32"','tensorDtypes.yT == "float32"',"ceil(args.outFeatures / (16 if args.M <= 8 else 32)) <= device.limits.maxComputeWorkgroupsPerDimension","ceil(args.M / (8 if args.M <= 8 else (32 if (args.M > 16 and args.outFeatures >= 8192) else 16))) <= device.limits.maxComputeWorkgroupsPerDimension"],constants:{usesF16:!1,quantBits:4,hasMin:!1,iq:!1,lutId:0,lut16:!1,q5:!1,q2k:!1,q3k:!1,q6k:!1,q5k:!0,scaleScalar:'"f32"',inFeatures:"args.inFeatures",outFeatures:"args.outFeatures",outStride:"args.outStride",dstColStart:"args.dstColStart",f16Tiles:1,kBlocks:1,bn:"16 if args.M <= 8 else 32",bm:"8 if args.M <= 8 else (32 if (args.M > 16 and args.outFeatures >= 8192) else 16)",nTile:"16 if args.M <= 8 else (4 if (args.M > 16 and args.outFeatures >= 8192) else 8)",accs:"1 if args.M <= 8 else (8 if (args.M > 16 and args.outFeatures >= 8192) else 4)"},passes:[{id:"main",name:"LlamaPrefillMatmulQ5K",shader:"prefill-matmul-q4.wgsl.jinja",bindings:"denseQ4",dispatch:{x:"min(ceil(args.outFeatures / (16 if args.M <= 8 else 32)), device.limits.maxComputeWorkgroupsPerDimension)",y:"min(ceil(args.M / (8 if args.M <= 8 else (32 if (args.M > 16 and args.outFeatures >= 8192) else 16))), device.limits.maxComputeWorkgroupsPerDimension)"}}]},{id:"q5k_tiled_exact",priority:0,when:["q5kBaseContract",'tensorDtypes.aT == "float32"','tensorDtypes.yT == "float32"',"ceil(args.outFeatures / (16 if args.M <= 8 else 32)) <= device.limits.maxComputeWorkgroupsPerDimension","ceil(args.M / (8 if args.M <= 8 else (32 if (args.M > 16 and args.outFeatures >= 8192) else 16))) <= device.limits.maxComputeWorkgroupsPerDimension"],constants:{usesF16:!1,f16Tiles:0,quantBits:4,hasMin:!1,iq:!1,lutId:0,lut16:!1,q5:!1,q2k:!1,q3k:!1,q6k:!1,q5k:!0,scaleScalar:'"f32"',inFeatures:"args.inFeatures",outFeatures:"args.outFeatures",outStride:"args.outStride",dstColStart:"args.dstColStart",kBlocks:"1 if args.M <= 8 else 2",bn:"16 if args.M <= 8 else 32",bm:"8 if args.M <= 8 else (32 if (args.M > 16 and args.outFeatures >= 8192) else 16)",nTile:"16 if args.M <= 8 else (4 if (args.M > 16 and args.outFeatures >= 8192) else 8)",accs:"1 if args.M <= 8 else (8 if (args.M > 16 and args.outFeatures >= 8192) else 4)"},passes:[{id:"main",name:"LlamaPrefillMatmulQ5K",shader:"prefill-matmul-q4.wgsl.jinja",bindings:"denseQ4",dispatch:{x:"min(ceil(args.outFeatures / (16 if args.M <= 8 else 32)), device.limits.maxComputeWorkgroupsPerDimension)",y:"min(ceil(args.M / (8 if args.M <= 8 else (32 if (args.M > 16 and args.outFeatures >= 8192) else 16))), device.limits.maxComputeWorkgroupsPerDimension)"}}]},{id:"q5k_subgroup_matrix",priority:100,requires:{features:["shader-f16","subgroups","chromium-experimental-subgroup-matrix"],subgroupMatrixConfigs:[{componentType:"f16",M:8,N:8,K:8}]},when:["not args.exact","q5kBaseContract","args.M > 8","ceil(args.outFeatures / 32) <= device.limits.maxComputeWorkgroupsPerDimension","ceil(args.M / 16) <= device.limits.maxComputeWorkgroupsPerDimension","args.outFeatures % 64 == 0","wave32Adapter"],constants:{quantBits:4,hasMin:!1,iq:!1,lutId:0,lut16:!1,q5:!1,q2k:!1,q3k:!1,q6k:!1,q5k:!0,scaleScalar:'"f32"',inFeatures:"args.inFeatures",outFeatures:"args.outFeatures",outStride:"args.outStride",dstColStart:"args.dstColStart if args.dstColStart else 0",yScalar:'"f16" if tensorDtypes.yT == "float16" else "f32"',aVec4:'"vec4<f16>" if tensorDtypes.aT == "float16" else "vec4<f32>"',smallM:"1 if (args.M <= 16 and args.outFeatures % 64 == 0) else 0"},passes:[{id:"main",name:"LlamaPrefillMatmulQ5KSg",shader:"prefill-matmul-q4-sg.wgsl.jinja",bindings:[{name:"a",arg:"aT",semantic:"A",buffer:{type:"read-only-storage"},elementType:"$aVec4"},{name:"q4_bits",arg:"bitsT",semantic:"Bits",buffer:{type:"read-only-storage"},elementType:"vec4<u32>"},{name:"q4_scales",arg:"scalesT",semantic:"Scales",buffer:{type:"read-only-storage"},elementType:"$scaleScalar"},{name:"y",arg:"yT",semantic:"Y",buffer:{type:"storage"},elementType:"$yScalar"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"block_offset",type:"u32",value:"args.blockOffset"},{name:"m",type:"u32",value:"args.M"}]}}],dispatch:{x:"ceil(args.outFeatures / (128 if (args.M <= 16 and args.outFeatures % 64 == 0) else 64))",y:"ceil(args.M / (16 if (args.M <= 16 and args.outFeatures % 64 == 0) else 32))"}}]},{id:"q4kn_compact_decode_gemv_mr2",priority:110,when:["q4knCompactDecodeGemvContract","args.outFeatures % 8 == 0","128 <= device.limits.maxComputeInvocationsPerWorkgroup","512 <= device.limits.maxComputeWorkgroupStorageSize","ceilDiv(args.outFeatures, 8) <= device.limits.maxComputeWorkgroupsPerDimension"],constants:{useSubgroups:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize >= 32',sgExact32:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize == 32 and device.adapterInfo.subgroupMaxSize == 32',usesF16:!1,quantBits:4,hasMin:!1,iq:!1,lut16:!1,lutId:0,q5:!1,q2k:!1,q3k:!1,q6k:!1,q5k:!1,q4kn:!1,q4knCompact:!0,scalesPk2:0,outFeatures:"args.outFeatures",dstColStart:"args.dstColStart",blocksPerRow:"args.inFeatures / 32",clusters:4,regRows:2},passes:[{id:"main",name:"LlamaPrefillMatmulQ4KNativeCompactGemv",shader:"prefill-matmul-q4-decode-gemv.wgsl.jinja",bindings:"decodeQ4Compact",dispatch:{x:"ceilDiv(args.outFeatures, 8)"}}]},{id:"q4kn_compact_decode_gemv",priority:105,when:["q4knCompactDecodeGemvContract","args.outFeatures <= device.limits.maxComputeWorkgroupsPerDimension"],constants:{useSubgroups:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize >= 32',sgExact32:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize == 32 and device.adapterInfo.subgroupMaxSize == 32',usesF16:!1,quantBits:4,hasMin:!1,iq:!1,lut16:!1,lutId:0,q5:!1,q2k:!1,q3k:!1,q6k:!1,q5k:!1,q4kn:!1,q4knCompact:!0,scalesPk2:0,outFeatures:"args.outFeatures",dstColStart:"args.dstColStart",blocksPerRow:"args.inFeatures / 32",clusters:1,regRows:1},passes:[{id:"main",name:"LlamaPrefillMatmulQ4KNativeCompactGemv",shader:"prefill-matmul-q4-decode-gemv.wgsl.jinja",bindings:"decodeQ4Compact",dispatch:{x:"args.outFeatures"}}]},{id:"q5k_decode_gemv",priority:105,when:["q5kDecodeGemvContract","args.outFeatures <= device.limits.maxComputeWorkgroupsPerDimension"],constants:{useSubgroups:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize >= 32',sgExact32:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize == 32 and device.adapterInfo.subgroupMaxSize == 32',usesF16:!1,scaleScalar:'"f32"',quantBits:4,hasMin:!1,iq:!1,lut16:!1,lutId:0,q2k:!1,q3k:!1,q6k:!1,q5k:!0,scalesPk2:0,outFeatures:"args.outFeatures",dstColStart:"args.dstColStart",blocksPerRow:"args.inFeatures / 32",clusters:1,regRows:1},passes:[{id:"main",name:"LlamaPrefillMatmulQ5KGemv",shader:"prefill-matmul-q4-decode-gemv.wgsl.jinja",bindings:"decodeQ4",dispatch:{x:"args.outFeatures"}}]},{id:"q4_decode_gemv",priority:105,when:["decodeGemvContract","args.outFeatures <= device.limits.maxComputeWorkgroupsPerDimension"],constants:{useSubgroups:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize >= 32',sgExact32:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize == 32 and device.adapterInfo.subgroupMaxSize == 32',usesF16:'tensorDtypes.scalesT == "float16"',scaleScalar:"dtypes.S",quantBits:"quantBits",hasMin:"hasMin",iq:"iq",lut16:"lut16",lutId:"args.lut if args.lut else 0",q2k:"q2k",q3k:"q3k",q6k:"q6k",scalesPk2:"0",outFeatures:"args.outFeatures",dstColStart:"args.dstColStart",blocksPerRow:"args.inFeatures / 32",clusters:"1",regRows:"1"},passes:[{id:"main",name:"LlamaPrefillMatmulQ4Gemv",shader:"prefill-matmul-q4-decode-gemv.wgsl.jinja",bindings:"decodeQ4",dispatch:{x:"args.outFeatures"}}]},{id:"q4_decode_gemv_mr2",priority:110,when:["decodeGemvContract","args.outFeatures % 8 == 0","32 * 4 <= device.limits.maxComputeInvocationsPerWorkgroup","4 * 32 * 4 <= device.limits.maxComputeWorkgroupStorageSize","ceilDiv(args.outFeatures, 8) <= device.limits.maxComputeWorkgroupsPerDimension"],constants:{useSubgroups:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize >= 32',sgExact32:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize == 32 and device.adapterInfo.subgroupMaxSize == 32',usesF16:'tensorDtypes.scalesT == "float16"',scaleScalar:"dtypes.S",quantBits:"quantBits",hasMin:"hasMin",iq:"iq",lut16:"lut16",lutId:"args.lut if args.lut else 0",q2k:"q2k",q3k:"q3k",q6k:"q6k",scalesPk2:"0",outFeatures:"args.outFeatures",dstColStart:"args.dstColStart",blocksPerRow:"args.inFeatures / 32",clusters:4,regRows:2},passes:[{id:"main",name:"LlamaPrefillMatmulQ4Gemv",shader:"prefill-matmul-q4-decode-gemv.wgsl.jinja",bindings:"decodeQ4",dispatch:{x:"ceil(args.outFeatures / 8)"}}]},{id:"q4_decode_gemv_mr4",priority:109,when:["decodeGemvContract","args.outFeatures % 16 == 0","32 * 4 <= device.limits.maxComputeInvocationsPerWorkgroup","4 * 32 * 4 <= device.limits.maxComputeWorkgroupStorageSize","ceilDiv(args.outFeatures, 16) <= device.limits.maxComputeWorkgroupsPerDimension"],constants:{useSubgroups:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize >= 32',sgExact32:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize == 32 and device.adapterInfo.subgroupMaxSize == 32',usesF16:'tensorDtypes.scalesT == "float16"',scaleScalar:"dtypes.S",quantBits:"quantBits",hasMin:"hasMin",iq:"iq",lut16:"lut16",lutId:"args.lut if args.lut else 0",q2k:"q2k",q3k:"q3k",q6k:"q6k",scalesPk2:"0",outFeatures:"args.outFeatures",dstColStart:"args.dstColStart",blocksPerRow:"args.inFeatures / 32",clusters:4,regRows:4},passes:[{id:"main",name:"LlamaPrefillMatmulQ4Gemv",shader:"prefill-matmul-q4-decode-gemv.wgsl.jinja",bindings:"decodeQ4",dispatch:{x:"ceil(args.outFeatures / 16)"}}]},{id:"q5k_decode_gemv_mr2",priority:110,when:["q5kDecodeGemvContract","args.outFeatures % 8 == 0","32 * 4 <= device.limits.maxComputeInvocationsPerWorkgroup","4 * 32 * 4 <= device.limits.maxComputeWorkgroupStorageSize","ceilDiv(args.outFeatures, 8) <= device.limits.maxComputeWorkgroupsPerDimension"],constants:{useSubgroups:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize >= 32',sgExact32:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize == 32 and device.adapterInfo.subgroupMaxSize == 32',usesF16:!1,scaleScalar:'"f32"',quantBits:4,hasMin:!1,iq:!1,lut16:!1,lutId:0,q2k:!1,q3k:!1,q6k:!1,q5k:!0,scalesPk2:0,outFeatures:"args.outFeatures",dstColStart:"args.dstColStart",blocksPerRow:"args.inFeatures / 32",clusters:4,regRows:2},passes:[{id:"main",name:"LlamaPrefillMatmulQ5KGemv",shader:"prefill-matmul-q4-decode-gemv.wgsl.jinja",bindings:"decodeQ4",dispatch:{x:"ceil(args.outFeatures / 8)"}}]}]},assets:[["prefill-matmul-q4-decode-gemv.wgsl.jinja",`{%- if useSubgroups %}
enable subgroups;
{% endif -%}
{%- if usesF16 %}
enable f16;
{% endif -%}

{{ env.wgsl.resourceDeclarations }}

const BPR: u32 = {{ blocksPerRow }}u;

const DST_COL: u32 = {{ dstColStart }}u;

const CLUSTERS: u32 = {{ clusters }}u;

const REG_ROWS: u32 = {{ regRows }}u;

{% if not useSubgroups %}
var<workgroup> partials4: array<f32, {{ 32 * clusters }}>;
{% endif %}

{% if lutId %}
{% include "ops/_shared/q4nl-dequant-helpers.wgsl.jinja" %}
{% else %}
{% include "ops/_shared/q4-dequant-helpers.wgsl.jinja" %}
{% endif %}

{% if useSubgroups %}
{% include "ops/_shared/sg-sum.wgsl.jinja" %}
{% endif %}

@compute @workgroup_size({{ 32 * clusters }})
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid3: vec3<u32>) {
  let lid = lid3.x;
  let cluster = lid / 32u;
  let lane = lid % 32u;
  let dim0 = (wid.x * CLUSTERS + cluster) * REG_ROWS;
  let base0 = params.block_offset + dim0 * BPR;
{% for r in range(regRows) %}
  var acc{{ r }} = 0.0;
{% endfor %}
  for (var b = lane; b < BPR; b = b + 32u) {
    let hbase = b * 8u;
    let x0 = a[hbase];
    let x1 = a[hbase + 1u];
    let x2 = a[hbase + 2u];
    let x3 = a[hbase + 3u];
    let x4 = a[hbase + 4u];
    let x5 = a[hbase + 5u];
    let x6 = a[hbase + 6u];
    let x7 = a[hbase + 7u];
{% include "ops/_shared/q4-decode-row-block-accumulate.wgsl.jinja" %}
  }

{% include "ops/_shared/projection-multirow-reduce.wgsl.jinja" %}
  if (lane == 0u) {
{% for r in range(regRows) %}
    y[DST_COL + dim0 + {{ r }}u] = total{{ r }};
{% endfor %}
  }
}
`],["prefill-matmul-q4-sg.wgsl.jinja",`enable f16;
enable subgroups;
enable chromium_experimental_subgroup_matrix;
diagnostic(off, chromium.subgroup_matrix_uniformity);

{{ env.wgsl.resourceDeclarations }}

const K: u32 = {{ inFeatures }}u;
const K_V4: u32 = K / 4u;
const BPR: u32 = K / 32u;
const OUT_STRIDE: u32 = {{ outStride }}u;
const DST_COL: u32 = {{ dstColStart }}u;
{%- if sgSplitK is defined and sgSplitK %}

const N_OUT: u32 = {{ outFeatures }}u;
const SPLIT_BLOCKS: u32 = {{ splitBlocks }}u;
{%- endif %}
{%- if smallM %}

const TILE_ROWS: u32 = 16u;
const TILE_COLS: u32 = 128u;
{%- else %}
const TILE_ROWS: u32 = 32u;
const TILE_COLS: u32 = 64u;
{%- endif %}
const TILE_K: u32 = 32u;
const SUB_ROWS: u32 = 16u;
const SUB_COLS: u32 = 32u;

var<workgroup> tile_A: array<f16, {{ 16 * 32 if smallM else 32 * 32 }}>;
var<workgroup> tile_B: array<f16, {{ 128 * 32 if smallM else 64 * 32 }}>;

var<workgroup> scratch: array<array<f32, 64>, 32>;

{%- if lutId %}
{% include "ops/_shared/q4nl-dequant-helpers.wgsl.jinja" %}
{%- else %}
{% include "ops/_shared/q4-dequant-helpers.wgsl.jinja" %}
{%- endif %}

@compute @workgroup_size(128, 1, 1)
fn main(
  @builtin(workgroup_id) wid: vec3<u32>,
  @builtin(local_invocation_index) local_idx: u32,
  @builtin(subgroup_size) sg_size: u32
) {
  let m0 = wid.y * TILE_ROWS;
  let n0 = wid.x * TILE_COLS;

  let subtile_id = local_idx / sg_size;
{%- if smallM %}
  let subtile_idx = subtile_id;
  let subtile_idy = 0u;
{%- else %}
  let subtile_idx = subtile_id / 2u;
  let subtile_idy = subtile_id % 2u;
{%- endif %}
  let base_A = subtile_idy * SUB_ROWS;
  let base_B = subtile_idx * SUB_COLS;

{% include "ops/_shared/subgroup-matrix-8x8-accumulators.wgsl.jinja" %}
{%- if smallM %}

  let am = local_idx / 8u;
  let aq = local_idx % 8u;

  let l = min(local_idx, {{ outFeatures }}u - 1u - n0);
{%- else %}

  let am = local_idx / 4u;
  let aq = (local_idx % 4u) * 2u;

  let l = local_idx & 63u;
{%- endif %}
  let row_base = params.block_offset + (n0 + l) * BPR;
{% if q4knCompact is defined and q4knCompact %}

  var dSuper4nc = 0.0;
  var dmSuper4nc = 0.0;
{%- elif q4kn is defined and q4kn %}

  var dSuper4n = 0.0;
  var dmSuper4n = 0.0;
{%- endif %}

{%- if sgSplitK is defined and sgSplitK %}
  let kbEnd = min(wid.z * SPLIT_BLOCKS + SPLIT_BLOCKS, BPR);
  for (var kb = wid.z * SPLIT_BLOCKS; kb < kbEnd; kb = kb + 1u) {
{%- else %}
  for (var kb = 0u; kb < BPR; kb = kb + 1u) {
{%- endif %}
{% include "ops/_shared/prefill-quant-subgroup-stage-a.wgsl.jinja" %}

    if (local_idx < {{ 128 if smallM else 64 }}u) {
      let blk = row_base + kb;
{%- if q4knCompact is defined and q4knCompact %}

      let sb4nc = blk >> 3u;
      let j4nc = blk & 7u;
      let smBase4nc = sb4nc * 5u;
      let smCarrier4nc = q4_metadata[smBase4nc + 1u + (j4nc >> 1u)];
      let smPair4nc = smCarrier4nc >> ((j4nc & 1u) * 12u);
      let sc4nc = smPair4nc & 63u;
      let mn4nc = (smPair4nc >> 6u) & 63u;
      if (j4nc == 0u) {
        let dm4nc = unpack2x16float(q4_metadata[smBase4nc]);
        dSuper4nc = dm4nc.x;
        dmSuper4nc = dm4nc.y;
      }
      let dw4nc = q4_bits[blk];
      var w0 = vec4<f32>(unpack4xU8(dw4nc.x & 0x0F0F0F0Fu));
      var w1 = vec4<f32>(unpack4xU8(dw4nc.y & 0x0F0F0F0Fu));
      var w2 = vec4<f32>(unpack4xU8(dw4nc.z & 0x0F0F0F0Fu));
      var w3 = vec4<f32>(unpack4xU8(dw4nc.w & 0x0F0F0F0Fu));
      var w4 = vec4<f32>(unpack4xU8((dw4nc.x >> 4u) & 0x0F0F0F0Fu));
      var w5 = vec4<f32>(unpack4xU8((dw4nc.y >> 4u) & 0x0F0F0F0Fu));
      var w6 = vec4<f32>(unpack4xU8((dw4nc.z >> 4u) & 0x0F0F0F0Fu));
      var w7 = vec4<f32>(unpack4xU8((dw4nc.w >> 4u) & 0x0F0F0F0Fu));
{%- elif q4kn is defined and q4kn %}

      let sb4n = blk >> 3u;
      let j4n = blk & 7u;
      let smBase4n = sb4n * 6u;
      let smCarrier4n = u32(q4_scales[smBase4n + 2u + (j4n >> 1u)]);
      let smPair4n = smCarrier4n >> ((j4n & 1u) * 12u);
      let sc4n = smPair4n & 63u;
      let mn4n = (smPair4n >> 6u) & 63u;
      if (j4n == 0u) {
        dSuper4n = f32(q4_scales[smBase4n]);
        dmSuper4n = f32(q4_scales[smBase4n + 1u]);
      }
      let dw4n = q4_bits[blk];
      var w0 = vec4<f32>(unpack4xU8(dw4n.x & 0x0F0F0F0Fu));
      var w1 = vec4<f32>(unpack4xU8(dw4n.y & 0x0F0F0F0Fu));
      var w2 = vec4<f32>(unpack4xU8(dw4n.z & 0x0F0F0F0Fu));
      var w3 = vec4<f32>(unpack4xU8(dw4n.w & 0x0F0F0F0Fu));
      var w4 = vec4<f32>(unpack4xU8((dw4n.x >> 4u) & 0x0F0F0F0Fu));
      var w5 = vec4<f32>(unpack4xU8((dw4n.y >> 4u) & 0x0F0F0F0Fu));
      var w6 = vec4<f32>(unpack4xU8((dw4n.z >> 4u) & 0x0F0F0F0Fu));
      var w7 = vec4<f32>(unpack4xU8((dw4n.w >> 4u) & 0x0F0F0F0Fu));
{%- elif q5k is defined and q5k %}

      let sb5 = blk >> 3u;
      let j5 = blk & 7u;
      let g5 = sb5 * 11u;
      let dw5 = q4_bits[g5 + j5];
      let qh5 = q4_bits[g5 + 8u + (j5 >> 2u)][j5 & 3u];
      let sm5 = q4_bits[g5 + 10u];
      let sc5 = f32((sm5[j5 >> 2u] >> ((j5 & 3u) * 8u)) & 0xFFu);
      let mn5 = f32((sm5[2u + (j5 >> 2u)] >> ((j5 & 3u) * 8u)) & 0xFFu);
      var w0 = q5k_lo(dw5.x, qh5 & 15u);
      var w1 = q5k_lo(dw5.y, (qh5 >> 4u) & 15u);
      var w2 = q5k_lo(dw5.z, (qh5 >> 8u) & 15u);
      var w3 = q5k_lo(dw5.w, (qh5 >> 12u) & 15u);
      var w4 = q5k_hi(dw5.x, (qh5 >> 16u) & 15u);
      var w5 = q5k_hi(dw5.y, (qh5 >> 20u) & 15u);
      var w6 = q5k_hi(dw5.z, (qh5 >> 24u) & 15u);
      var w7 = q5k_hi(dw5.w, (qh5 >> 28u) & 15u);
{%- elif q2k %}

      let sb2 = blk >> 3u;
      let j2 = blk & 7u;
      let g2 = sb2 * 5u;
      let cv2 = q4_bits[g2 + (j2 >> 1u)];
      let cLo2 = cv2[(j2 & 1u) * 2u];
      let cHi2 = cv2[(j2 & 1u) * 2u + 1u];
      let sm2 = q4_bits[g2 + 4u][j2 >> 1u];
      let bLo2 = (sm2 >> ((j2 & 1u) * 16u)) & 0xFFu;
      let bHi2 = (sm2 >> ((j2 & 1u) * 16u + 8u)) & 0xFFu;
      var w0 = q2w(cLo2, 0u);
      var w1 = q2w(cLo2, 1u);
      var w2 = q2w(cLo2, 2u);
      var w3 = q2w(cLo2, 3u);
      var w4 = q2w(cHi2, 0u);
      var w5 = q2w(cHi2, 1u);
      var w6 = q2w(cHi2, 2u);
      var w7 = q2w(cHi2, 3u);
{%- elif q3k %}

      let sb3 = blk >> 3u;
      let j3 = blk & 7u;
      let g3 = sb3 * 7u;
      let cv3 = q4_bits[g3 + (j3 >> 1u)];
      let cLo3 = cv3[(j3 & 1u) * 2u];
      let cHi3 = cv3[(j3 & 1u) * 2u + 1u];
      let hw3 = q4_bits[g3 + 4u + (j3 >> 2u)][j3 & 3u];
      let s83 = unpack4xI8(q4_bits[g3 + 6u][j3 >> 1u]);
      var w0 = q3w_lo(cLo3, hw3, 0u);
      var w1 = q3w_lo(cLo3, hw3, 1u);
      var w2 = q3w_lo(cLo3, hw3, 2u);
      var w3 = q3w_lo(cLo3, hw3, 3u);
      var w4 = q3w_hi(cHi3, hw3, 0u);
      var w5 = q3w_hi(cHi3, hw3, 1u);
      var w6 = q3w_hi(cHi3, hw3, 2u);
      var w7 = q3w_hi(cHi3, hw3, 3u);
{%- elif q6k %}

      let sb6 = blk >> 3u;
      let j6 = blk & 7u;
      let g6 = sb6 * 13u;
      let dw6 = q4_bits[g6 + j6];
      let hv6 = q4_bits[g6 + 8u + (j6 >> 1u)];
      let hLo6 = hv6[(j6 & 1u) * 2u];
      let hHi6 = hv6[(j6 & 1u) * 2u + 1u];
      let s86 = unpack4xI8(q4_bits[g6 + 12u][j6 >> 1u]);
      var w0 = q6_lo(dw6.x, hLo6, 0u);
      var w1 = q6_lo(dw6.y, hLo6, 1u);
      var w2 = q6_lo(dw6.z, hLo6, 2u);
      var w3 = q6_lo(dw6.w, hLo6, 3u);
      var w4 = q6_hi(dw6.x, hHi6, 0u);
      var w5 = q6_hi(dw6.y, hHi6, 1u);
      var w6 = q6_hi(dw6.z, hHi6, 2u);
      var w7 = q6_hi(dw6.w, hHi6, 3u);
{%- elif quantBits == 8 %}

      let dw0 = q4_bits[blk * 2u];
      let dw1 = q4_bits[blk * 2u + 1u];
      var w0 = vec4<f32>(unpack4xI8(dw0.x));
      var w1 = vec4<f32>(unpack4xI8(dw0.y));
      var w2 = vec4<f32>(unpack4xI8(dw0.z));
      var w3 = vec4<f32>(unpack4xI8(dw0.w));
      var w4 = vec4<f32>(unpack4xI8(dw1.x));
      var w5 = vec4<f32>(unpack4xI8(dw1.y));
      var w6 = vec4<f32>(unpack4xI8(dw1.z));
      var w7 = vec4<f32>(unpack4xI8(dw1.w));
{%- else %}

      let dw = q4_bits[blk];
      var w0 = q4_lo(dw.x);
      var w1 = q4_lo(dw.y);
      var w2 = q4_lo(dw.z);
      var w3 = q4_lo(dw.w);
      var w4 = q4_hi(dw.x);
      var w5 = q4_hi(dw.y);
      var w6 = q4_hi(dw.z);
      var w7 = q4_hi(dw.w);
{%- endif %}
{%- if q4knCompact is defined and q4knCompact %}

      let dl4nc = dSuper4nc * f32(sc4nc);
      let ml4nc = dmSuper4nc * f32(mn4nc);
      let p0 = dl4nc * w0; let p1 = dl4nc * w1; let p2 = dl4nc * w2; let p3 = dl4nc * w3;
      let p4 = dl4nc * w4; let p5 = dl4nc * w5; let p6 = dl4nc * w6; let p7 = dl4nc * w7;
      w0 = p0 - ml4nc; w1 = p1 - ml4nc; w2 = p2 - ml4nc; w3 = p3 - ml4nc;
      w4 = p4 - ml4nc; w5 = p5 - ml4nc; w6 = p6 - ml4nc; w7 = p7 - ml4nc;
{%- elif q4kn is defined and q4kn %}

      let dl4n = dSuper4n * f32(sc4n);
      let ml4n = dmSuper4n * f32(mn4n);
      let p0 = dl4n * w0; let p1 = dl4n * w1; let p2 = dl4n * w2; let p3 = dl4n * w3;
      let p4 = dl4n * w4; let p5 = dl4n * w5; let p6 = dl4n * w6; let p7 = dl4n * w7;
      w0 = p0 - ml4n; w1 = p1 - ml4n; w2 = p2 - ml4n; w3 = p3 - ml4n;
      w4 = p4 - ml4n; w5 = p5 - ml4n; w6 = p6 - ml4n; w7 = p7 - ml4n;
{%- elif q5k is defined and q5k %}

      let scEff5 = f32(q4_scales[sb5 * 2u]) * sc5;
      let mEff5 = f32(q4_scales[sb5 * 2u + 1u]) * mn5;
      w0 = scEff5 * w0 - mEff5;
      w1 = scEff5 * w1 - mEff5;
      w2 = scEff5 * w2 - mEff5;
      w3 = scEff5 * w3 - mEff5;
      w4 = scEff5 * w4 - mEff5;
      w5 = scEff5 * w5 - mEff5;
      w6 = scEff5 * w6 - mEff5;
      w7 = scEff5 * w7 - mEff5;
{%- elif q2k %}

      let d2 = f32(q4_scales[sb2 * 2u]);
      let dm2 = f32(q4_scales[sb2 * 2u + 1u]);
      let sLo2 = d2 * f32(bLo2 & 15u);
      let mLo2 = dm2 * f32(bLo2 >> 4u);
      let sHi2 = d2 * f32(bHi2 & 15u);
      let mHi2 = dm2 * f32(bHi2 >> 4u);
      w0 = sLo2 * w0 - mLo2;
      w1 = sLo2 * w1 - mLo2;
      w2 = sLo2 * w2 - mLo2;
      w3 = sLo2 * w3 - mLo2;
      w4 = sHi2 * w4 - mHi2;
      w5 = sHi2 * w5 - mHi2;
      w6 = sHi2 * w6 - mHi2;
      w7 = sHi2 * w7 - mHi2;
{%- elif q3k %}

      let d3 = f32(q4_scales[sb3]);
      let sLo3 = d3 * f32(s83[(j3 & 1u) * 2u]);
      let sHi3 = d3 * f32(s83[(j3 & 1u) * 2u + 1u]);
      w0 = sLo3 * w0;
      w1 = sLo3 * w1;
      w2 = sLo3 * w2;
      w3 = sLo3 * w3;
      w4 = sHi3 * w4;
      w5 = sHi3 * w5;
      w6 = sHi3 * w6;
      w7 = sHi3 * w7;
{%- elif q6k %}

      let d6 = f32(q4_scales[sb6]);
      let sLo6 = d6 * f32(s86[(j6 & 1u) * 2u]);
      let sHi6 = d6 * f32(s86[(j6 & 1u) * 2u + 1u]);
      w0 = sLo6 * w0;
      w1 = sLo6 * w1;
      w2 = sLo6 * w2;
      w3 = sLo6 * w3;
      w4 = sHi6 * w4;
      w5 = sHi6 * w5;
      w6 = sHi6 * w6;
      w7 = sHi6 * w7;
{%- elif hasMin %}

      let ds = f32(q4_scales[blk * 2u]);
      let dbias = f32(q4_scales[blk * 2u + 1u]);
      w0 = ds * w0 + dbias;
      w1 = ds * w1 + dbias;
      w2 = ds * w2 + dbias;
      w3 = ds * w3 + dbias;
      w4 = ds * w4 + dbias;
      w5 = ds * w5 + dbias;
      w6 = ds * w6 + dbias;
      w7 = ds * w7 + dbias;
{%- elif iq or lut16 %}

      let ds_lo = f32(q4_scales[blk * 2u]);
      let ds_hi = f32(q4_scales[blk * 2u + 1u]);
      w0 = ds_lo * w0;
      w1 = ds_lo * w1;
      w2 = ds_lo * w2;
      w3 = ds_lo * w3;
      w4 = ds_hi * w4;
      w5 = ds_hi * w5;
      w6 = ds_hi * w6;
      w7 = ds_hi * w7;
{%- else %}

      let ds = f32(q4_scales[blk]);
      w0 = ds * w0;
      w1 = ds * w1;
      w2 = ds * w2;
      w3 = ds * w3;
      w4 = ds * w4;
      w5 = ds * w5;
      w6 = ds * w6;
      w7 = ds * w7;
{%- endif %}
      let bbase = l * TILE_K;
      tile_B[bbase] = f16(w0.x); tile_B[bbase + 1u] = f16(w0.y); tile_B[bbase + 2u] = f16(w0.z); tile_B[bbase + 3u] = f16(w0.w);
      tile_B[bbase + 4u] = f16(w1.x); tile_B[bbase + 5u] = f16(w1.y); tile_B[bbase + 6u] = f16(w1.z); tile_B[bbase + 7u] = f16(w1.w);
      tile_B[bbase + 8u] = f16(w2.x); tile_B[bbase + 9u] = f16(w2.y); tile_B[bbase + 10u] = f16(w2.z); tile_B[bbase + 11u] = f16(w2.w);
      tile_B[bbase + 12u] = f16(w3.x); tile_B[bbase + 13u] = f16(w3.y); tile_B[bbase + 14u] = f16(w3.z); tile_B[bbase + 15u] = f16(w3.w);
      tile_B[bbase + 16u] = f16(w4.x); tile_B[bbase + 17u] = f16(w4.y); tile_B[bbase + 18u] = f16(w4.z); tile_B[bbase + 19u] = f16(w4.w);
      tile_B[bbase + 20u] = f16(w5.x); tile_B[bbase + 21u] = f16(w5.y); tile_B[bbase + 22u] = f16(w5.z); tile_B[bbase + 23u] = f16(w5.w);
      tile_B[bbase + 24u] = f16(w6.x); tile_B[bbase + 25u] = f16(w6.y); tile_B[bbase + 26u] = f16(w6.z); tile_B[bbase + 27u] = f16(w6.w);
      tile_B[bbase + 28u] = f16(w7.x); tile_B[bbase + 29u] = f16(w7.y); tile_B[bbase + 30u] = f16(w7.z); tile_B[bbase + 31u] = f16(w7.w);
    }
    workgroupBarrier();

{% include "ops/_shared/prefill-subgroup-matmul-epilogue.wgsl.jinja" %}`],["prefill-matmul-q4.wgsl.jinja",`{%- if usesF16 or f16Tiles %}
enable f16;
{% endif -%}

{{ env.wgsl.resourceDeclarations }}

{%- if lutId %}
{% include "ops/_shared/q4nl-dequant-helpers.wgsl.jinja" %}
{%- endif %}

const K: u32 = {{ inFeatures }}u;
const N: u32 = {{ outFeatures }}u;
const OUT_STRIDE: u32 = {{ outStride }}u;
const DST_COL: u32 = {{ dstColStart }}u;
const BPR: u32 = K / 32u;
const K_V4: u32 = K / 4u;
const BM: u32 = {{ bm }}u;
const BN: u32 = {{ bn }}u;

const K_BLOCKS: u32 = {{ kBlocks }}u;
const BK_V4: u32 = K_BLOCKS * 8u;
const N_TILE: u32 = {{ nTile }}u;
const WG: u32 = 128u;
{%- if kSplits %}

const SPLIT_BLOCKS: u32 = {{ splitBlocks }}u;
{%- endif %}

{% if f16Tiles %}

alias TileVec = vec4<f16>;
{%- else %}

alias TileVec = vec4<f32>;
{%- endif %}
var<workgroup> aTile: array<TileVec, {{ bm * kBlocks * 8 }}>;
var<workgroup> bTile: array<TileVec, {{ bn * kBlocks * 8 }}>;

@compute @workgroup_size(WG, 1, 1)
fn main(
  @builtin(workgroup_id) wg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(num_workgroups) nwg: vec3<u32>
) {
  let tid = lid.x;
  let m_local = tid / N_TILE;
  let n_local = tid - m_local * N_TILE;
  let n_tiles = (N + BN - 1u) / BN;
  let m_tiles = (params.m + BM - 1u) / BM;
  for (var wgx: u32 = wg.x; wgx < n_tiles; wgx = wgx + nwg.x) {
    let nBase = wgx * BN;
    for (var wgy: u32 = wg.y; wgy < m_tiles; wgy = wgy + nwg.y) {
      let mBase = wgy * BM;
      let m = mBase + m_local;
{% for nn in range(accs) %}
      var acc{{ nn }}: f32 = 0.0;
{% endfor %}
{%- if kSplits %}
      let ktEnd = min((wg.z + 1u) * SPLIT_BLOCKS, BPR);
      for (var kt: u32 = wg.z * SPLIT_BLOCKS; kt < ktEnd; kt = kt + K_BLOCKS) {
{%- else %}
      let ktEnd = BPR;
      for (var kt: u32 = 0u; kt < ktEnd; kt = kt + K_BLOCKS) {
{%- endif %}
        let kv0 = kt * 8u;

        for (var i: u32 = tid; i < {{ bm * kBlocks * 8 }}u; i = i + WG) {
          let tm = i / BK_V4;
          let kv = i - tm * BK_V4;
          let gm = mBase + tm;
{%- if kBlocks == 1 %}
          if (gm < params.m) {
{%- else %}
          if (gm < params.m && kt + kv / 8u < ktEnd) {
{%- endif %}
            aTile[i] = TileVec(a[gm * K_V4 + kv0 + kv]);
          } else {
            aTile[i] = TileVec(0.0);
          }
        }

        for (var i: u32 = tid; i < {{ bn * kBlocks * 8 }}u; i = i + WG) {
          let tn = i / BK_V4;
          let kv = i - tn * BK_V4;
{%- if kBlocks == 1 %}
          let eib = kv * 4u;
{%- else %}
          let blockInTile = kv / 8u;
          let eib = (kv % 8u) * 4u;
{%- endif %}
          let r = nBase + tn;
          var v = vec4<f32>(0.0);
{%- if kBlocks == 1 %}
          if (r < N) {
            let blk = params.block_offset + r * BPR + kt;
{%- else %}
          if (r < N && kt + blockInTile < ktEnd) {
            let blk = params.block_offset + r * BPR + kt + blockInTile;
{%- endif %}
{%- if quantBits == 8 %}

            let word = q4_bits[blk * 8u + eib / 4u];
{%- if iq %}
            let scale = f32(q4_scales[blk * 2u + select(0u, 1u, eib >= 16u)]);
{%- else %}
            let scale = f32(q4_scales[blk]);
{%- endif %}
            v = vec4<f32>(unpack4xI8(word)) * scale;
{%- elif lutId %}

            let word = q4_bits[blk * 4u + (eib % 16u) / 4u];
{%- if lut16 %}
            let scale = f32(q4_scales[blk * 2u + select(0u, 1u, eib >= 16u)]);
{%- else %}
            let scale = f32(q4_scales[blk]);
{%- endif %}
            if (eib < 16u) {
              v = q4_lo(word) * scale;
            } else {
              v = q4_hi(word) * scale;
            }
{%- elif q5 %}

            let g5 = (blk >> 2u) * 20u; let l5 = blk & 3u;
            let word = q4_bits[g5 + l5 * 4u + (eib % 16u) / 4u];
            let qh = q4_bits[g5 + 16u + l5];
            let scale = f32(q4_scales[blk]);
            var q5n: vec4<u32>;
            if (eib < 16u) {
              q5n = (vec4<u32>(word) >> vec4<u32>(0u, 8u, 16u, 24u)) & vec4<u32>(15u);
            } else {
              q5n = (vec4<u32>(word) >> vec4<u32>(4u, 12u, 20u, 28u)) & vec4<u32>(15u);
            }
            q5n = q5n | (((vec4<u32>(qh) >> (vec4<u32>(0u, 1u, 2u, 3u) + vec4<u32>(eib))) & vec4<u32>(1u)) << vec4<u32>(4u));
            v = (vec4<f32>(q5n) - 16.0) * scale;
{%- elif q4knCompact is defined and q4knCompact %}

            let sb4nc = blk >> 3u; let j4nc = blk & 7u; let smBase4nc = sb4nc * 5u;
            let dm4nc = unpack2x16float(q4_metadata[smBase4nc]);
            let smCarrier4nc = q4_metadata[smBase4nc + 1u + (j4nc >> 1u)];
            let smPair4nc = smCarrier4nc >> ((j4nc & 1u) * 12u);
            let sc4nc = smPair4nc & 63u;
            let mn4nc = (smPair4nc >> 6u) & 63u;
            let word = q4_bits[blk * 4u + (eib % 16u) / 4u];
            var nib4nc: vec4<u32>;
            if (eib < 16u) {
              nib4nc = unpack4xU8(word & 0x0F0F0F0Fu);
            } else {
              nib4nc = unpack4xU8((word >> 4u) & 0x0F0F0F0Fu);
            }
            let dl4nc = dm4nc.x * f32(sc4nc);
            let ml4nc = dm4nc.y * f32(mn4nc);
            let product4nc = dl4nc * vec4<f32>(nib4nc);
            v = product4nc - vec4<f32>(ml4nc);
{%- elif q4kn is defined and q4kn %}

            let sb4n = blk >> 3u; let j4n = blk & 7u; let smBase4n = sb4n * 6u;
            let smCarrier4n = u32(q4_scales[smBase4n + 2u + (j4n >> 1u)]);
            let smPair4n = smCarrier4n >> ((j4n & 1u) * 12u);
            let sc4n = smPair4n & 63u;
            let mn4n = (smPair4n >> 6u) & 63u;
            let word = q4_bits[blk * 4u + (eib % 16u) / 4u];
            var nib4n: vec4<u32>;
            if (eib < 16u) {
              nib4n = unpack4xU8(word & 0x0F0F0F0Fu);
            } else {
              nib4n = unpack4xU8((word >> 4u) & 0x0F0F0F0Fu);
            }
            let dl4n = f32(q4_scales[smBase4n]) * f32(sc4n);
            let ml4n = f32(q4_scales[smBase4n + 1u]) * f32(mn4n);
            let product4n = dl4n * vec4<f32>(nib4n);
            v = product4n - vec4<f32>(ml4n);
{%- elif q5k is defined and q5k %}

            let sb5 = blk >> 3u; let j5 = blk & 7u; let g5k = sb5 * 44u;
            let word = q4_bits[g5k + 4u * j5 + (eib % 16u) / 4u];
            let qh = q4_bits[g5k + 32u + j5];
            let sc5 = f32((q4_bits[g5k + 40u + (j5 >> 2u)] >> ((j5 & 3u) * 8u)) & 0xFFu);
            let mn5 = f32((q4_bits[g5k + 42u + (j5 >> 2u)] >> ((j5 & 3u) * 8u)) & 0xFFu);
            let scEff5 = f32(q4_scales[sb5 * 2u]) * sc5;
            let mEff5 = f32(q4_scales[sb5 * 2u + 1u]) * mn5;
            var q5n: vec4<u32>;
            if (eib < 16u) {
              q5n = (vec4<u32>(word) >> vec4<u32>(0u, 8u, 16u, 24u)) & vec4<u32>(15u);
            } else {
              q5n = (vec4<u32>(word) >> vec4<u32>(4u, 12u, 20u, 28u)) & vec4<u32>(15u);
            }
            q5n = q5n | (((vec4<u32>(qh) >> (vec4<u32>(0u, 1u, 2u, 3u) + vec4<u32>(eib))) & vec4<u32>(1u)) << vec4<u32>(4u));
            v = vec4<f32>(q5n) * scEff5 - vec4<f32>(mEff5);
{%- elif q2k %}

            let sb = blk >> 3u; let j2 = blk & 7u; let g2 = sb * 20u;
            let cw = q4_bits[g2 + 2u * j2 + select(0u, 1u, eib >= 16u)];
            let scb = (q4_bits[g2 + 16u + (j2 >> 1u)] >> ((j2 & 1u) * 16u + select(0u, 8u, eib >= 16u))) & 0xFFu;
            let d2 = f32(q4_scales[sb * 2u]);
            let dm2 = f32(q4_scales[sb * 2u + 1u]);
            let w2 = (eib % 16u) / 4u;
            let q2 = (vec4<u32>(cw) >> (vec4<u32>(0u, 8u, 16u, 24u) + vec4<u32>(2u * w2))) & vec4<u32>(3u);
            v = vec4<f32>(q2) * (d2 * f32(scb & 15u)) - vec4<f32>(dm2 * f32(scb >> 4u));
{%- elif q3k %}

            let sb = blk >> 3u; let j3 = blk & 7u; let g3 = sb * 28u;
            let cw3 = q4_bits[g3 + 2u * j3 + select(0u, 1u, eib >= 16u)];
            let hw3 = q4_bits[g3 + 16u + j3];
            let sc83 = unpack4xI8(q4_bits[g3 + 24u + (j3 >> 1u)])[(j3 & 1u) * 2u + select(0u, 1u, eib >= 16u)];
            let scale3 = f32(q4_scales[sb]) * f32(sc83);
            let w3 = (eib % 16u) / 4u;
            let q3n = (vec4<u32>(cw3) >> (vec4<u32>(0u, 8u, 16u, 24u) + vec4<u32>(2u * w3))) & vec4<u32>(3u);
            let h3 = (vec4<u32>(hw3) >> (vec4<u32>(0u, 8u, 16u, 24u) + vec4<u32>(select(0u, 4u, eib >= 16u) + w3))) & vec4<u32>(1u);
            v = (vec4<f32>(q3n | (h3 << vec4<u32>(2u))) - 4.0) * scale3;
{%- elif q6k %}

            let sb = blk >> 3u; let j6 = blk & 7u; let g6 = sb * 52u;
            let w6 = (eib % 16u) / 4u;
            let word = q4_bits[g6 + 4u * j6 + w6];
            let hw = q4_bits[g6 + 32u + 2u * j6 + select(0u, 1u, eib >= 16u)];
            let sc8 = unpack4xI8(q4_bits[g6 + 48u + (j6 >> 1u)])[(j6 & 1u) * 2u + select(0u, 1u, eib >= 16u)];
            let scale = f32(q4_scales[sb]) * f32(sc8);
            var q6n: vec4<u32>;
            if (eib < 16u) {
              q6n = (vec4<u32>(word) >> vec4<u32>(0u, 8u, 16u, 24u)) & vec4<u32>(15u);
            } else {
              q6n = (vec4<u32>(word) >> vec4<u32>(4u, 12u, 20u, 28u)) & vec4<u32>(15u);
            }
            let hi2 = (vec4<u32>(hw) >> (vec4<u32>(0u, 8u, 16u, 24u) + vec4<u32>(2u * w6))) & vec4<u32>(3u);
            v = (vec4<f32>(q6n | (hi2 << vec4<u32>(4u))) - 32.0) * scale;
{%- else %}

            let word = q4_bits[blk * 4u + (eib % 16u) / 4u];
{%- if hasMin %}
            let scale = f32(q4_scales[blk * 2u]);
            let bias = f32(q4_scales[blk * 2u + 1u]);
{%- else %}
            let scale = f32(q4_scales[blk]);
{%- endif %}
            var nib: vec4<f32>;
            if (eib < 16u) {
              nib = vec4<f32>(unpack4xU8(word & 0x0F0F0F0Fu)) - 8.0;
            } else {
              nib = vec4<f32>(unpack4xU8((word >> 4u) & 0x0F0F0F0Fu)) - 8.0;
            }
{%- if hasMin %}
            v = nib * scale + bias;
{%- else %}
            v = nib * scale;
{%- endif %}
{%- endif %}
          }
          bTile[i] = TileVec(v);
        }
        workgroupBarrier();

        if (m < params.m) {
          for (var kv: u32 = 0u; kv < BK_V4; kv = kv + 1u) {
            let a_vec = vec4<f32>(aTile[m_local * BK_V4 + kv]);
{% for nn in range(accs) %}
            acc{{ nn }} = acc{{ nn }} + dot(a_vec, vec4<f32>(bTile[(n_local + {{ nn * nTile }}u) * BK_V4 + kv]));
{% endfor %}
          }
        }
        workgroupBarrier();
      }

      if (m < params.m) {
{%- if kSplits %}
{% for nn in range(accs) %}
        if (nBase + n_local + {{ nn * nTile }}u < N) {
          partials[(wg.z * params.m + m) * N + nBase + n_local + {{ nn * nTile }}u] = acc{{ nn }};
        }
{% endfor %}
{%- else %}
{% for nn in range(accs) %}
        if (nBase + n_local + {{ nn * nTile }}u < N) {
          y[m * OUT_STRIDE + DST_COL + nBase + n_local + {{ nn * nTile }}u] = acc{{ nn }};
        }
{% endfor %}
{%- endif %}
      }
    }
  }
}
`]]}],["com.xenova.MulBroadcast",{manifest:{domain:"com.xenova",name:"MulBroadcast",sinceVersion:1,inputs:[{role:"X",dtype:"X"},{role:"Factor",dtype:"F"}],outputs:[{role:"X",dtype:"X",shape:"shapes.xT"}],typeConstraints:{X:["float32","float16"],F:["float32","float16"]},args:{xT:{kind:"tensor",semantic:"X",role:"inout"},factorT:{kind:"tensor",semantic:"Factor",role:"input"},count:{kind:"u32",semantic:"count"},period:{kind:"u32",semantic:"period",required:!1}},constants:{xScalar:"dtypes.X",factorScalar:"dtypes.F",usesF16:'dtypes.X == "f16" or dtypes.F == "f16"'},variants:[{id:"vec4",when:["numel(shapes.xT) >= args.count","numel(shapes.factorT) >= (args.period if args.period else args.count)","f16Ok(dtypes.X) and f16Ok(dtypes.F)","args.count > 0","args.count % 4 == 0","args.period is not defined or args.period == 0 or args.period == 1 or args.period % 4 == 0"],constants:{broadcastScalar:"broadcastScalar",elementwiseFactor:"elementwiseFactor",xVecElem:'"vec4<" ~ dtypes.X ~ ">"',factorElem:'dtypes.F if broadcastScalar else ("vec4<" ~ dtypes.F ~ ">")'},passes:[{id:"main",name:"MulBroadcast",shader:"mul-broadcast-vec4.wgsl.jinja",bindings:[{name:"x",arg:"xT",semantic:"X",buffer:{type:"storage"},elementType:"$xVecElem"},{name:"factor",arg:"factorT",semantic:"Factor",buffer:{type:"read-only-storage"},elementType:"$factorElem"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"countV4",type:"u32",value:"args.count / 4"},{name:"periodV4",type:"u32",value:"(args.period / 4) if (args.period and args.period > 1) else 1"},{name:"wgY",type:"u32",value:"min(ceil(args.count / 4 / 64), device.limits.maxComputeWorkgroupsPerDimension)"}]}}],dispatch:{threads:"args.count / 4",workgroupSize:"64"}}],priority:10,derive:{broadcastScalar:"args.period == 1",elementwiseFactor:"not args.period"}},{id:"scalar",when:["numel(shapes.xT) >= args.count","numel(shapes.factorT) >= (args.period if args.period else args.count)","f16Ok(dtypes.X) and f16Ok(dtypes.F)"],passes:[{id:"main",name:"MulBroadcast",shader:"mul-broadcast.wgsl.jinja",bindings:[{name:"x",arg:"xT",semantic:"X",buffer:{type:"storage"},elementType:"$xScalar"},{name:"factor",arg:"factorT",semantic:"Factor",buffer:{type:"read-only-storage"},elementType:"$factorScalar"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"count",type:"u32",value:"args.count"},{name:"period",type:"u32",value:"args.period if args.period else 0"},{name:"wgY",type:"u32",value:"min(ceil(args.count / 64), device.limits.maxComputeWorkgroupsPerDimension)"}]}}],dispatch:{threads:"args.count",workgroupSize:"64"}}]}]},assets:[["mul-broadcast-vec4.wgsl.jinja",`{% if usesF16 %}
enable f16;
{% endif %}
{{ env.wgsl.resourceDeclarations }}
const WG: u32 = 64u;

@compute @workgroup_size(WG, 1, 1)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let wg_idx = wg.x + wg.y * params.wgY;
  let i = wg_idx * WG + lid.x;
  if (i >= params.countV4) {
    return;
  }
{%- if broadcastScalar %}
  let f = vec4<f32>(f32(factor[0]));
{%- elif elementwiseFactor %}
  let f = vec4<f32>(factor[i]);
{%- else %}
  let f = vec4<f32>(factor[i % params.periodV4]);
{%- endif %}
  x[i] = vec4<{{ xScalar }}>(vec4<f32>(x[i]) * f);
}
`],["mul-broadcast.wgsl.jinja",`{% if usesF16 %}
enable f16;
{% endif %}
{{ env.wgsl.resourceDeclarations }}
const WG: u32 = 64u;
@compute @workgroup_size(WG, 1, 1)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let wg_idx = wg.x + wg.y * params.wgY;
  let i = wg_idx * WG + lid.x;
  if (i >= params.count) {
    return;
  }
  var pIdx = i;
  if (params.period > 0u) {
    pIdx = i % params.period;
  }
  x[i] = {{ xScalar }}(f32(x[i]) * f32(factor[pIdx]));
}
`]]}],["com.xenova.NormedGatedGroupQueryAttention",{manifest:{domain:"com.xenova",name:"NormedGatedGroupQueryAttention",sinceVersion:1,inputs:[{role:"query",dtype:"T",rank:3},{role:"key",dtype:"T",rank:3},{role:"value",dtype:"T",rank:3},{role:"past_key",dtype:"T",rank:4},{role:"past_value",dtype:"T",rank:4},{role:"seqlens_k",dtype:"I",rank:1},{role:"q_norm_weight",dtype:"T",rank:1},{role:"k_norm_weight",dtype:"T",rank:1},{role:"gate",dtype:"T",rank:3},{role:"cos_cache",dtype:"T",rank:2,optional:!0},{role:"sin_cache",dtype:"T",rank:2,optional:!0}],outputs:[{role:"output",dtype:"T",rank:3,shape:"shapes.queryT"},{role:"present_key",dtype:"T",rank:4,shape:"shapes.pastKeyT"},{role:"present_value",dtype:"T",rank:4,shape:"shapes.pastValueT"}],typeConstraints:{T:["float32"],I:["int32"]},args:{queryT:{kind:"tensor",semantic:"query",role:"input"},keyT:{kind:"tensor",semantic:"key",role:"input"},valueT:{kind:"tensor",semantic:"value",role:"input"},pastKeyT:{kind:"tensor",semantic:"past_key",role:"input"},pastValueT:{kind:"tensor",semantic:"past_value",role:"input"},seqlensKT:{kind:"tensor",semantic:"seqlens_k",role:"input"},qNormWeightT:{kind:"tensor",semantic:"q_norm_weight",role:"input"},kNormWeightT:{kind:"tensor",semantic:"k_norm_weight",role:"input"},gateT:{kind:"tensor",semantic:"gate",role:"input"},cosCacheT:{kind:"tensor",semantic:"cos_cache",role:"input",required:!1},sinCacheT:{kind:"tensor",semantic:"sin_cache",role:"input",required:!1},outputT:{kind:"tensor",semantic:"output",role:"output"},presentKeyT:{kind:"tensor",semantic:"present_key",role:"output"},presentValueT:{kind:"tensor",semantic:"present_value",role:"output"},numHeads:{kind:"u32",semantic:"num_heads"},kvNumHeads:{kind:"u32",semantic:"kv_num_heads"},scale:{kind:"f32",semantic:"scale",required:!1},localWindowSize:{kind:"u32",semantic:"local_window_size",required:!1},qkNormEpsilon:{kind:"f32",semantic:"qk_norm_epsilon",required:!1},doRotary:{kind:"u32",semantic:"do_rotary",required:!1}},tunables:{WORKGROUP_SIZE:256,COPY_WORKGROUP_SIZE:64,MAX_SPLITS:16,SPLIT_TILE_K:256,MAX_HEAD_DIM:256,REQUIRED_SUBGROUP_SIZE:32},derive:{deviceWorkgroupCap:"min(device.limits.maxComputeInvocationsPerWorkgroup, device.limits.maxComputeWorkgroupSizeX)",wave32Adapter:'has(device.adapterInfo, "subgroupMinSize") and has(device.adapterInfo, "subgroupMaxSize") and device.adapterInfo.subgroupMinSize == 32 and device.adapterInfo.subgroupMaxSize == 32',subgroupsWave32:'device.features.has("subgroups") and wave32Adapter',narrowSubgroupRange:'has(device.adapterInfo, "subgroupMinSize") and has(device.adapterInfo, "subgroupMaxSize") and device.adapterInfo.subgroupMinSize < device.adapterInfo.subgroupMaxSize and device.adapterInfo.subgroupMaxSize <= 16',subgroupsWide32:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize >= 32',reportedNonWave32Adapter:'not wave32Adapter and (has(device.adapterInfo, "subgroupMinSize") or has(device.adapterInfo, "subgroupMaxSize"))',headDim:"dim(shapes.queryT, 2) / args.numHeads if (ranks.queryT == 3 and args.numHeads > 0) else 0",headDimV4:"headDim / 4",cacheCapacity:"dim(shapes.pastKeyT, 2)",numSplits:"min(tunables.MAX_SPLITS, ceilDiv(cacheCapacity, tunables.SPLIT_TILE_K))",scratchBytes:"dim(shapes.queryT, 0) * args.numHeads * numSplits * (headDim + 4) * 4",scratchFits:"scratchBytes <= device.limits.maxStorageBufferBindingSize and scratchBytes <= device.limits.maxBufferSize",workgroupsFit:"ceilDiv(dim(shapes.queryT, 0) * args.kvNumHeads, 2) <= device.limits.maxComputeWorkgroupsPerDimension and ceilDiv(dim(shapes.queryT, 0) * args.kvNumHeads * cacheCapacity, tunables.COPY_WORKGROUP_SIZE) <= device.limits.maxComputeWorkgroupsPerDimension and dim(shapes.queryT, 0) <= device.limits.maxComputeWorkgroupsPerDimension and args.numHeads <= device.limits.maxComputeWorkgroupsPerDimension and numSplits <= device.limits.maxComputeWorkgroupsPerDimension",workgroupsSupported:"tunables.WORKGROUP_SIZE <= deviceWorkgroupCap and tunables.COPY_WORKGROUP_SIZE <= deviceWorkgroupCap and headDimV4 <= deviceWorkgroupCap",sg32:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and has(device.adapterInfo, "subgroupMaxSize") and device.adapterInfo.subgroupMinSize == tunables.REQUIRED_SUBGROUP_SIZE and device.adapterInfo.subgroupMaxSize == tunables.REQUIRED_SUBGROUP_SIZE',baseContract:'ranks.queryT == 3 and ranks.keyT == 3 and ranks.valueT == 3 and ranks.pastKeyT == 4 and ranks.pastValueT == 4 and ranks.seqlensKT == 1 and ranks.qNormWeightT == 1 and ranks.kNormWeightT == 1 and ranks.gateT == 3 and ranks.outputT == 3 and ranks.presentKeyT == 4 and ranks.presentValueT == 4 and tensorDtypes.queryT == "float32" and tensorDtypes.keyT == "float32" and tensorDtypes.valueT == "float32" and tensorDtypes.pastKeyT == "float32" and tensorDtypes.pastValueT == "float32" and tensorDtypes.seqlensKT == "int32" and tensorDtypes.qNormWeightT == "float32" and tensorDtypes.kNormWeightT == "float32" and tensorDtypes.gateT == "float32" and tensorDtypes.outputT == "float32" and tensorDtypes.presentKeyT == "float32" and tensorDtypes.presentValueT == "float32" and args.numHeads > 0 and args.kvNumHeads > 0 and args.numHeads % args.kvNumHeads == 0 and dim(shapes.queryT, 1) == 1 and dim(shapes.keyT, 1) == 1 and dim(shapes.valueT, 1) == 1 and dim(shapes.queryT, 0) == dim(shapes.keyT, 0) and dim(shapes.queryT, 0) == dim(shapes.valueT, 0) and dim(shapes.queryT, 2) % args.numHeads == 0 and headDim % 4 == 0 and headDim >= 4 and headDim <= tunables.MAX_HEAD_DIM and dim(shapes.keyT, 2) == args.kvNumHeads * headDim and dim(shapes.valueT, 2) == dim(shapes.keyT, 2) and dim(shapes.pastKeyT, 0) == dim(shapes.queryT, 0) and dim(shapes.pastKeyT, 1) == args.kvNumHeads and cacheCapacity >= 1 and dim(shapes.pastKeyT, 3) == headDim and dim(shapes.pastValueT, 0) == dim(shapes.pastKeyT, 0) and dim(shapes.pastValueT, 1) == dim(shapes.pastKeyT, 1) and dim(shapes.pastValueT, 2) == cacheCapacity and dim(shapes.pastValueT, 3) == headDim and dim(shapes.seqlensKT, 0) == dim(shapes.queryT, 0) and dim(shapes.qNormWeightT, 0) == headDim and dim(shapes.kNormWeightT, 0) == headDim and dim(shapes.gateT, 0) == dim(shapes.queryT, 0) and dim(shapes.gateT, 1) == 1 and dim(shapes.gateT, 2) == dim(shapes.queryT, 2) and dim(shapes.outputT, 0) == dim(shapes.queryT, 0) and dim(shapes.outputT, 1) == 1 and dim(shapes.outputT, 2) == dim(shapes.queryT, 2) and dim(shapes.presentKeyT, 0) == dim(shapes.pastKeyT, 0) and dim(shapes.presentKeyT, 1) == dim(shapes.pastKeyT, 1) and dim(shapes.presentKeyT, 2) == dim(shapes.pastKeyT, 2) and dim(shapes.presentKeyT, 3) == dim(shapes.pastKeyT, 3) and dim(shapes.presentValueT, 0) == dim(shapes.pastValueT, 0) and dim(shapes.presentValueT, 1) == dim(shapes.pastValueT, 1) and dim(shapes.presentValueT, 2) == dim(shapes.pastValueT, 2) and dim(shapes.presentValueT, 3) == dim(shapes.pastValueT, 3) and workgroupsSupported and workgroupsFit and scratchFits',noRotaryOk:"baseContract and not args.doRotary and not present.cosCacheT and not present.sinCacheT",rotaryOk:'baseContract and args.doRotary == 1 and present.cosCacheT and present.sinCacheT and tensorDtypes.cosCacheT == "float32" and tensorDtypes.sinCacheT == "float32" and ranks.cosCacheT == 2 and ranks.sinCacheT == 2 and dim(shapes.cosCacheT, 0) == 1 and dim(shapes.sinCacheT, 0) == 1 and dim(shapes.cosCacheT, 1) == headDim / 2 and dim(shapes.sinCacheT, 1) == headDim / 2'},bindingSets:{retain:[{name:"past_key",arg:"pastKeyT",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"past_value",arg:"pastValueT",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"present_key",arg:"presentKeyT",buffer:{type:"storage"},elementType:"vec4<f32>"},{name:"present_value",arg:"presentValueT",buffer:{type:"storage"},elementType:"vec4<f32>"},{name:"seqlens_k",arg:"seqlensKT",buffer:{type:"read-only-storage"},elementType:"i32"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"count",type:"u32",value:"dim(shapes.queryT, 0) * args.kvNumHeads * cacheCapacity"},{name:"seq",type:"u32",value:"cacheCapacity"},{name:"keySeq",type:"u32",value:1}]}}],append:[{name:"new_k",arg:"keyT",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"new_v",arg:"valueT",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"k_norm_weight",arg:"kNormWeightT",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"present_key",arg:"presentKeyT",buffer:{type:"storage"},elementType:"vec4<f32>"},{name:"present_value",arg:"presentValueT",buffer:{type:"storage"},elementType:"vec4<f32>"},{name:"seqlens_k",arg:"seqlensKT",buffer:{type:"read-only-storage"},elementType:"i32"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"count",type:"u32",value:"dim(shapes.queryT, 0) * args.kvNumHeads"},{name:"seq",type:"u32",value:"cacheCapacity"},{name:"keySeq",type:"u32",value:1}]}}],appendRotary:[{name:"new_k",arg:"keyT",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"new_v",arg:"valueT",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"k_norm_weight",arg:"kNormWeightT",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"cos_cache",arg:"cosCacheT",buffer:{type:"read-only-storage"},elementType:"f32"},{name:"sin_cache",arg:"sinCacheT",buffer:{type:"read-only-storage"},elementType:"f32"},{name:"present_key",arg:"presentKeyT",buffer:{type:"storage"},elementType:"vec4<f32>"},{name:"present_value",arg:"presentValueT",buffer:{type:"storage"},elementType:"vec4<f32>"},{name:"seqlens_k",arg:"seqlensKT",buffer:{type:"read-only-storage"},elementType:"i32"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"count",type:"u32",value:"dim(shapes.queryT, 0) * args.kvNumHeads"},{name:"seq",type:"u32",value:"cacheCapacity"},{name:"keySeq",type:"u32",value:1}]}}],split:[{name:"query",arg:"queryT",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"key",arg:"presentKeyT",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"value",arg:"presentValueT",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"partial_out",semantic:"partial",buffer:{type:"storage"},elementType:"vec4<f32>"},{name:"q_norm_weight",arg:"qNormWeightT",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"seqlens_k",arg:"seqlensKT",buffer:{type:"read-only-storage"},elementType:"i32"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"qSeq",type:"u32",value:1},{name:"kvSeq",type:"u32",value:"cacheCapacity"},{name:"scale",type:"f32",value:"args.scale if args.scale else 0"},{name:"windowSize",type:"u32",value:"args.localWindowSize if args.localWindowSize else 0"}]}}],splitRotary:[{name:"query",arg:"queryT",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"key",arg:"presentKeyT",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"value",arg:"presentValueT",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"partial_out",semantic:"partial",buffer:{type:"storage"},elementType:"vec4<f32>"},{name:"q_norm_weight",arg:"qNormWeightT",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"cos_cache",arg:"cosCacheT",buffer:{type:"read-only-storage"},elementType:"f32"},{name:"sin_cache",arg:"sinCacheT",buffer:{type:"read-only-storage"},elementType:"f32"},{name:"seqlens_k",arg:"seqlensKT",buffer:{type:"read-only-storage"},elementType:"i32"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"qSeq",type:"u32",value:1},{name:"kvSeq",type:"u32",value:"cacheCapacity"},{name:"scale",type:"f32",value:"args.scale if args.scale else 0"},{name:"windowSize",type:"u32",value:"args.localWindowSize if args.localWindowSize else 0"}]}}],merge:[{name:"partial_out",semantic:"partial",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"gate",arg:"gateT",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"output",arg:"outputT",buffer:{type:"storage"},elementType:"vec4<f32>"}]},variants:[{id:"decode_splitk",priority:10,when:["noRotaryOk","sg32"],constants:{cacheSeqlens:!0,scalar:'"f32"',usesF16:!1,qNumHeads:"args.numHeads",kvNumHeads:"args.kvNumHeads",headDim:"headDim",headDimV4:"headDimV4",numSplits:"numSplits",hasWindow:"args.localWindowSize > 0 if args.localWindowSize else false",hasRotary:!1,hasGate:!0,normedGatedGqa:!0,qkEps:"args.qkNormEpsilon if args.qkNormEpsilon else 0.00001",inputVec4:'"vec4<f32>"',inputScalar:'"f32"',zeroScalar:'"f32"',useSubgroups:!0},intermediates:[{id:"partial",dtype:"float32",shape:"[dim(shapes.queryT, 0) * args.numHeads * numSplits * (headDim + 4)]"}],passes:[{id:"retain",name:"NormedGatedGroupQueryAttention.RetainCache",shader:"cache-retain.wgsl.jinja",bindings:"retain",dispatch:{threads:"dim(shapes.queryT, 0) * args.kvNumHeads * cacheCapacity",workgroupSize:"tunables.COPY_WORKGROUP_SIZE"},viewAlias:[{input:"past_key",output:"present_key"},{input:"past_value",output:"present_value"}]},{id:"append",name:"NormedGatedGroupQueryAttention.NormAppend",shader:"normed-cache-append.wgsl.jinja",bindings:"append",dispatch:{workgroups:"ceilDiv(dim(shapes.queryT, 0) * args.kvNumHeads, 2)"}},{id:"split_attention",name:"NormedGatedGroupQueryAttention.SplitK",source:{shader:"ops/_shared/attn-flash-decode-splitk.wgsl.jinja",inputs:{layout:'"bhsd"'}},bindings:"split",dispatch:{x:"numSplits",y:"args.numHeads",z:"dim(shapes.queryT, 0)"}},{id:"merge",name:"NormedGatedGroupQueryAttention.MergeGate",source:{shader:"ops/_shared/attn-flash-decode-splitk-merge.wgsl.jinja",inputs:{layout:'"bhsd"'}},bindings:"merge",dispatch:{x:1,y:"args.numHeads",z:"dim(shapes.queryT, 0)"}}]},{id:"decode_splitk_nosg",priority:10,when:["noRotaryOk","true"],constants:{cacheSeqlens:!0,scalar:'"f32"',usesF16:!1,qNumHeads:"args.numHeads",kvNumHeads:"args.kvNumHeads",headDim:"headDim",headDimV4:"headDimV4",numSplits:"numSplits",hasWindow:"args.localWindowSize > 0 if args.localWindowSize else false",hasRotary:!1,hasGate:!0,normedGatedGqa:!0,qkEps:"args.qkNormEpsilon if args.qkNormEpsilon else 0.00001",inputVec4:'"vec4<f32>"',inputScalar:'"f32"',zeroScalar:'"f32"',useSubgroups:!1},intermediates:[{id:"partial",dtype:"float32",shape:"[dim(shapes.queryT, 0) * args.numHeads * numSplits * (headDim + 4)]"}],passes:[{id:"retain",name:"NormedGatedGroupQueryAttention.RetainCache",shader:"cache-retain.wgsl.jinja",bindings:"retain",dispatch:{threads:"dim(shapes.queryT, 0) * args.kvNumHeads * cacheCapacity",workgroupSize:"tunables.COPY_WORKGROUP_SIZE"},viewAlias:[{input:"past_key",output:"present_key"},{input:"past_value",output:"present_value"}]},{id:"append",name:"NormedGatedGroupQueryAttention.NormAppend",shader:"normed-cache-append-nosg.wgsl.jinja",bindings:"append",dispatch:{workgroups:"ceilDiv(dim(shapes.queryT, 0) * args.kvNumHeads, 2)"}},{id:"split_attention",name:"NormedGatedGroupQueryAttention.SplitK",source:{shader:"ops/_shared/attn-flash-decode-splitk.wgsl.jinja",inputs:{layout:'"bhsd"'}},bindings:"split",dispatch:{x:"numSplits",y:"args.numHeads",z:"dim(shapes.queryT, 0)"}},{id:"merge",name:"NormedGatedGroupQueryAttention.MergeGate",source:{shader:"ops/_shared/attn-flash-decode-splitk-merge.wgsl.jinja",inputs:{layout:'"bhsd"'}},bindings:"merge",dispatch:{x:1,y:"args.numHeads",z:"dim(shapes.queryT, 0)"}}]},{id:"decode_splitk_rotary",priority:10,when:["rotaryOk","sg32"],constants:{cacheSeqlens:!0,scalar:'"f32"',usesF16:!1,qNumHeads:"args.numHeads",kvNumHeads:"args.kvNumHeads",headDim:"headDim",headDimV4:"headDimV4",numSplits:"numSplits",hasWindow:"args.localWindowSize > 0 if args.localWindowSize else false",hasRotary:!0,hasGate:!0,normedGatedGqa:!0,qkEps:"args.qkNormEpsilon if args.qkNormEpsilon else 0.00001",inputVec4:'"vec4<f32>"',inputScalar:'"f32"',zeroScalar:'"f32"',useSubgroups:!0},intermediates:[{id:"partial",dtype:"float32",shape:"[dim(shapes.queryT, 0) * args.numHeads * numSplits * (headDim + 4)]"}],passes:[{id:"retain",name:"NormedGatedGroupQueryAttention.RetainCache",shader:"cache-retain.wgsl.jinja",bindings:"retain",dispatch:{threads:"dim(shapes.queryT, 0) * args.kvNumHeads * cacheCapacity",workgroupSize:"tunables.COPY_WORKGROUP_SIZE"},viewAlias:[{input:"past_key",output:"present_key"},{input:"past_value",output:"present_value"}]},{id:"append",name:"NormedGatedGroupQueryAttention.NormAppend",shader:"normed-cache-append.wgsl.jinja",bindings:"appendRotary",dispatch:{workgroups:"ceilDiv(dim(shapes.queryT, 0) * args.kvNumHeads, 2)"}},{id:"split_attention",name:"NormedGatedGroupQueryAttention.SplitK",source:{shader:"ops/_shared/attn-flash-decode-splitk.wgsl.jinja",inputs:{layout:'"bhsd"'}},bindings:"splitRotary",dispatch:{x:"numSplits",y:"args.numHeads",z:"dim(shapes.queryT, 0)"}},{id:"merge",name:"NormedGatedGroupQueryAttention.MergeGate",source:{shader:"ops/_shared/attn-flash-decode-splitk-merge.wgsl.jinja",inputs:{layout:'"bhsd"'}},bindings:"merge",dispatch:{x:1,y:"args.numHeads",z:"dim(shapes.queryT, 0)"}}]},{id:"decode_splitk_rotary_nosg",priority:10,when:["rotaryOk","true"],constants:{cacheSeqlens:!0,scalar:'"f32"',usesF16:!1,qNumHeads:"args.numHeads",kvNumHeads:"args.kvNumHeads",headDim:"headDim",headDimV4:"headDimV4",numSplits:"numSplits",hasWindow:"args.localWindowSize > 0 if args.localWindowSize else false",hasRotary:!0,hasGate:!0,normedGatedGqa:!0,qkEps:"args.qkNormEpsilon if args.qkNormEpsilon else 0.00001",inputVec4:'"vec4<f32>"',inputScalar:'"f32"',zeroScalar:'"f32"',useSubgroups:!1},intermediates:[{id:"partial",dtype:"float32",shape:"[dim(shapes.queryT, 0) * args.numHeads * numSplits * (headDim + 4)]"}],passes:[{id:"retain",name:"NormedGatedGroupQueryAttention.RetainCache",shader:"cache-retain.wgsl.jinja",bindings:"retain",dispatch:{threads:"dim(shapes.queryT, 0) * args.kvNumHeads * cacheCapacity",workgroupSize:"tunables.COPY_WORKGROUP_SIZE"},viewAlias:[{input:"past_key",output:"present_key"},{input:"past_value",output:"present_value"}]},{id:"append",name:"NormedGatedGroupQueryAttention.NormAppend",shader:"normed-cache-append-nosg.wgsl.jinja",bindings:"appendRotary",dispatch:{workgroups:"ceilDiv(dim(shapes.queryT, 0) * args.kvNumHeads, 2)"}},{id:"split_attention",name:"NormedGatedGroupQueryAttention.SplitK",source:{shader:"ops/_shared/attn-flash-decode-splitk.wgsl.jinja",inputs:{layout:'"bhsd"'}},bindings:"splitRotary",dispatch:{x:"numSplits",y:"args.numHeads",z:"dim(shapes.queryT, 0)"}},{id:"merge",name:"NormedGatedGroupQueryAttention.MergeGate",source:{shader:"ops/_shared/attn-flash-decode-splitk-merge.wgsl.jinja",inputs:{layout:'"bhsd"'}},bindings:"merge",dispatch:{x:1,y:"args.numHeads",z:"dim(shapes.queryT, 0)"}}]}]},assets:[["cache-retain.wgsl.jinja",`{{ env.wgsl.resourceDeclarations }}

const HEAD_DIM_V4: u32 = {{ headDimV4 }}u;
const KV_HEADS: u32 = {{ kvNumHeads }}u;
const WG: u32 = {{ tunables.COPY_WORKGROUP_SIZE }}u;

@compute @workgroup_size(WG, 1, 1)
fn main(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(num_workgroups) nwg: vec3<u32>
) {
  let row = gid.x + gid.y * nwg.x * WG;
  if (row >= params.count) {
    return;
  }
  let t = row % params.seq;
  let tmp = row / params.seq;
  let b = tmp / KV_HEADS;
  let active_end = min(params.seq, max(params.keySeq, u32(seqlens_k[b]) + 1u));
  let append_start = active_end - params.keySeq;
  if (t >= append_start && t < active_end) {
    return;
  }
  let base = row * HEAD_DIM_V4;
  for (var d4 = 0u; d4 < HEAD_DIM_V4; d4 = d4 + 1u) {
    present_key[base + d4] = past_key[base + d4];
    present_value[base + d4] = past_value[base + d4];
  }
}
`],["normed-cache-append-nosg.wgsl.jinja",`{{ env.wgsl.resourceDeclarations }}

const HEAD_DIM: u32 = {{ headDim }}u;
const HEAD_DIM_V4: u32 = {{ headDimV4 }}u;
const HALF_DIM: u32 = HEAD_DIM / 2u;
{% if hasRotary and headDim % 8 == 0 %}const HALF_DIM_V4: u32 = HEAD_DIM_V4 / 2u;
{% endif %}
const KV_HEADS: u32 = {{ kvNumHeads }}u;
const QK_EPS: f32 = {{ qkEps }};
const WG: u32 = 64u;

var<workgroup> normalized_k: array<vec4<f32>, 2 * HEAD_DIM_V4>;
var<workgroup> norm_partials: array<f32, WG>;

@compute @workgroup_size(WG, 1, 1)
fn main(
  @builtin(workgroup_id) wg: vec3<u32>,
  @builtin(num_workgroups) nwg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>
) {
  let tid = lid.x;
  let lane = tid & 31u;
  let row_in_wg = tid >> 5u;
  let workgroup_index = wg.x + wg.y * nwg.x;
  let row = workgroup_index * 2u + row_in_wg;
  let rowActive = row < params.count;

  var row_vec4_base = 0u;
  var cache_vec4_base = 0u;
  if (rowActive) {
    let j = row % params.keySeq;
    let tmp = row / params.keySeq;
    let hk = tmp % KV_HEADS;
    let b = tmp / KV_HEADS;
    let active_end = min(params.seq, max(params.keySeq, u32(seqlens_k[b]) + 1u));
    let t = active_end - params.keySeq + j;
    row_vec4_base = (b * params.keySeq + j) * KV_HEADS * HEAD_DIM_V4 + hk * HEAD_DIM_V4;
    cache_vec4_base = ((b * KV_HEADS + hk) * params.seq + t) * HEAD_DIM_V4;
  }

  var acc = 0.0;
  for (var d4 = lane; d4 < HEAD_DIM_V4; d4 = d4 + 32u) {
    var k4 = vec4<f32>(0.0);
    if (rowActive) {
      k4 = new_k[row_vec4_base + d4];
    }
    acc = acc + dot(k4, k4);
  }
  norm_partials[tid] = acc;
  workgroupBarrier();
  var stride = 16u;
  loop {
    if (stride == 0u) { break; }
    if (lane < stride) {
      let base = row_in_wg * 32u;
      norm_partials[base + lane] = norm_partials[base + lane] + norm_partials[base + lane + stride];
    }
    workgroupBarrier();
    stride = stride >> 1u;
  }
  let total = norm_partials[row_in_wg * 32u];
  let inv_rms = inverseSqrt(total / f32(HEAD_DIM) + QK_EPS);
  for (var d4 = lane; d4 < HEAD_DIM_V4; d4 = d4 + 32u) {
    var normalized = vec4<f32>(0.0);
    if (rowActive) {
      normalized = fma(
        new_k[row_vec4_base + d4] * inv_rms * k_norm_weight[d4],
        vec4<f32>(1.0),
        vec4<f32>(0.0)
      );
    }
    normalized_k[row_in_wg * HEAD_DIM_V4 + d4] = normalized;
  }
  workgroupBarrier();

{% if hasRotary %}

{% if headDim % 8 == 0 %}

  for (var d4 = lane; d4 < HALF_DIM_V4; d4 = d4 + 32u) {
    if (rowActive) {
      let base = row_in_wg * HEAD_DIM_V4;
      let x0 = normalized_k[base + d4];
      let x1 = normalized_k[base + d4 + HALF_DIM_V4];
      let d = d4 * 4u;
      let c = vec4<f32>(cos_cache[d], cos_cache[d + 1u], cos_cache[d + 2u], cos_cache[d + 3u]);
      let s = vec4<f32>(sin_cache[d], sin_cache[d + 1u], sin_cache[d + 2u], sin_cache[d + 3u]);
      normalized_k[base + d4] = x0 * c - x1 * s;
      normalized_k[base + d4 + HALF_DIM_V4] = x1 * c + x0 * s;
    }
  }
{% else %}

  if (lane == 0u && rowActive) {
    for (var d = 0u; d < HALF_DIM; d = d + 1u) {
      let lo_index = row_in_wg * HEAD_DIM_V4 + d / 4u;
      let hi_d = d + HALF_DIM;
      let hi_index = row_in_wg * HEAD_DIM_V4 + hi_d / 4u;
      let lo_lane = d & 3u;
      let hi_lane = hi_d & 3u;
      let x0 = normalized_k[lo_index][lo_lane];
      let x1 = normalized_k[hi_index][hi_lane];
      let c = cos_cache[d];
      let s = sin_cache[d];
      normalized_k[lo_index][lo_lane] = x0 * c - x1 * s;
      normalized_k[hi_index][hi_lane] = x1 * c + x0 * s;
    }
  }
{% endif %}
  workgroupBarrier();
{% endif %}

  if (rowActive) {
    for (var d4 = lane; d4 < HEAD_DIM_V4; d4 = d4 + 32u) {
      present_key[cache_vec4_base + d4] = normalized_k[row_in_wg * HEAD_DIM_V4 + d4];
      present_value[cache_vec4_base + d4] = new_v[row_vec4_base + d4];
    }
  }
}
`],["normed-cache-append.wgsl.jinja",`{% if useSubgroups %}enable subgroups;
{% endif %}{{ env.wgsl.resourceDeclarations }}

const HEAD_DIM: u32 = {{ headDim }}u;
const HEAD_DIM_V4: u32 = {{ headDimV4 }}u;
const HALF_DIM: u32 = HEAD_DIM / 2u;
{% if hasRotary and headDim % 8 == 0 %}const HALF_DIM_V4: u32 = HEAD_DIM_V4 / 2u;
{% endif %}
const KV_HEADS: u32 = {{ kvNumHeads }}u;
const QK_EPS: f32 = {{ qkEps }};
const WG: u32 = 64u;

var<workgroup> normalized_k: array<vec4<f32>, 2 * HEAD_DIM_V4>;
{% if not useSubgroups %}var<workgroup> norm_partials: array<f32, WG>;
{% endif %}

@compute @workgroup_size(WG, 1, 1)
fn main(
  @builtin(workgroup_id) wg: vec3<u32>,
  @builtin(num_workgroups) nwg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>
) {
  let tid = lid.x;
  let lane = tid & 31u;
  let row_in_wg = tid >> 5u;
  let workgroup_index = wg.x + wg.y * nwg.x;
  let row = workgroup_index * 2u + row_in_wg;
  let rowActive = row < params.count;

  var row_vec4_base = 0u;
  var cache_vec4_base = 0u;
  if (rowActive) {
    let j = row % params.keySeq;
    let tmp = row / params.keySeq;
    let hk = tmp % KV_HEADS;
    let b = tmp / KV_HEADS;
    let active_end = min(params.seq, max(params.keySeq, u32(seqlens_k[b]) + 1u));
    let t = active_end - params.keySeq + j;
    row_vec4_base = (b * params.keySeq + j) * KV_HEADS * HEAD_DIM_V4 + hk * HEAD_DIM_V4;
    cache_vec4_base = ((b * KV_HEADS + hk) * params.seq + t) * HEAD_DIM_V4;
  }

  var acc = 0.0;
  for (var d4 = lane; d4 < HEAD_DIM_V4; d4 = d4 + 32u) {
    var k4 = vec4<f32>(0.0);
    if (rowActive) {
      k4 = new_k[row_vec4_base + d4];
    }
    acc = acc + dot(k4, k4);
  }
{% if useSubgroups %}
  let total = subgroupAdd(acc);
{% else %}
  norm_partials[tid] = acc;
  workgroupBarrier();
  var stride = 16u;
  loop {
    if (stride == 0u) { break; }
    if (lane < stride) {
      let base = row_in_wg * 32u;
      norm_partials[base + lane] = norm_partials[base + lane] + norm_partials[base + lane + stride];
    }
    workgroupBarrier();
    stride = stride >> 1u;
  }
  let total = norm_partials[row_in_wg * 32u];
{% endif %}
  let inv_rms = inverseSqrt(total / f32(HEAD_DIM) + QK_EPS);
  for (var d4 = lane; d4 < HEAD_DIM_V4; d4 = d4 + 32u) {
    var normalized = vec4<f32>(0.0);
    if (rowActive) {
      normalized = fma(
        new_k[row_vec4_base + d4] * inv_rms * k_norm_weight[d4],
        vec4<f32>(1.0),
        vec4<f32>(0.0)
      );
    }
    normalized_k[row_in_wg * HEAD_DIM_V4 + d4] = normalized;
  }
  workgroupBarrier();

{% if hasRotary %}

{% if headDim % 8 == 0 %}

  for (var d4 = lane; d4 < HALF_DIM_V4; d4 = d4 + 32u) {
    if (rowActive) {
      let base = row_in_wg * HEAD_DIM_V4;
      let x0 = normalized_k[base + d4];
      let x1 = normalized_k[base + d4 + HALF_DIM_V4];
      let d = d4 * 4u;
      let c = vec4<f32>(cos_cache[d], cos_cache[d + 1u], cos_cache[d + 2u], cos_cache[d + 3u]);
      let s = vec4<f32>(sin_cache[d], sin_cache[d + 1u], sin_cache[d + 2u], sin_cache[d + 3u]);
      normalized_k[base + d4] = x0 * c - x1 * s;
      normalized_k[base + d4 + HALF_DIM_V4] = x1 * c + x0 * s;
    }
  }
{% else %}

  if (lane == 0u && rowActive) {
    for (var d = 0u; d < HALF_DIM; d = d + 1u) {
      let lo_index = row_in_wg * HEAD_DIM_V4 + d / 4u;
      let hi_d = d + HALF_DIM;
      let hi_index = row_in_wg * HEAD_DIM_V4 + hi_d / 4u;
      let lo_lane = d & 3u;
      let hi_lane = hi_d & 3u;
      let x0 = normalized_k[lo_index][lo_lane];
      let x1 = normalized_k[hi_index][hi_lane];
      let c = cos_cache[d];
      let s = sin_cache[d];
      normalized_k[lo_index][lo_lane] = x0 * c - x1 * s;
      normalized_k[hi_index][hi_lane] = x1 * c + x0 * s;
    }
  }
{% endif %}
  workgroupBarrier();
{% endif %}

  if (rowActive) {
    for (var d4 = lane; d4 < HEAD_DIM_V4; d4 = d4 + 32u) {
      present_key[cache_vec4_base + d4] = normalized_k[row_in_wg * HEAD_DIM_V4 + d4];
      present_value[cache_vec4_base + d4] = new_v[row_vec4_base + d4];
    }
  }
}
`]]}],["com.xenova.RmsNormResidualAdd",{manifest:{domain:"com.xenova",name:"RmsNormResidualAdd",sinceVersion:1,inputs:[{role:"X",dtype:"X"},{role:"W",dtype:"W"},{role:"Y",dtype:"Y"},{role:"W2",dtype:"W"}],outputs:[{role:"Y",dtype:"Y",shape:"shapes.yT"},{role:"N2",dtype:"Y",optional:!0}],typeConstraints:{X:["float32"],W:["float32"],Y:["float32"]},tunables:{WG_CAP:256},args:{xT:{kind:"tensor",semantic:"X",role:"input"},wT:{kind:"tensor",semantic:"W",role:"weights"},yT:{kind:"tensor",semantic:"Y",role:"inout"},w2T:{kind:"tensor",semantic:"W2",role:"weights",required:!1},normed2T:{kind:"tensor",semantic:"N2",role:"output",required:!1},rows:{kind:"u32",semantic:"rows"},dim:{kind:"u32",semantic:"dim"},eps:{kind:"f32",semantic:"eps"},eps2:{kind:"f32",semantic:"eps2",required:!1}},derive:{wave32Adapter:'has(device.adapterInfo, "subgroupMinSize") and has(device.adapterInfo, "subgroupMaxSize") and device.adapterInfo.subgroupMinSize == 32 and device.adapterInfo.subgroupMaxSize == 32',subgroupsWave32:'device.features.has("subgroups") and wave32Adapter',narrowSubgroupRange:'has(device.adapterInfo, "subgroupMinSize") and has(device.adapterInfo, "subgroupMaxSize") and device.adapterInfo.subgroupMinSize < device.adapterInfo.subgroupMaxSize and device.adapterInfo.subgroupMaxSize <= 16',subgroupsWide32:'device.features.has("subgroups") and has(device.adapterInfo, "subgroupMinSize") and device.adapterInfo.subgroupMinSize >= 32',reportedNonWave32Adapter:'not wave32Adapter and (has(device.adapterInfo, "subgroupMinSize") or has(device.adapterInfo, "subgroupMaxSize"))',normWgCap:"tunables.WG_CAP if subgroupsWide32 else min(128, tunables.WG_CAP)",normWg:"min(normWgCap, max(32, pow2ceil(args.dim / 8)))",normMaxSubgroups:"max(1, normWg / 32)"},variants:[{id:"weighted_vec4_chained",when:["present.w2T","present.normed2T","args.eps2 is defined","ranks.wT == 1","ranks.w2T == 1","dim(shapes.wT, 0) == args.dim","dim(shapes.w2T, 0) == args.dim","args.rows >= 0","args.dim > 0","args.dim % 4 == 0","numel(shapes.xT) >= args.rows * args.dim","numel(shapes.yT) >= args.rows * args.dim","numel(shapes.normed2T) >= args.rows * args.dim",'tensorDtypes.xT == "float32"','tensorDtypes.wT == "float32"','tensorDtypes.w2T == "float32"','tensorDtypes.yT == "float32"','tensorDtypes.normed2T == "float32"'],passes:[{id:"main",name:"RmsNormResidualAddChained",source:{shader:"ops/_shared/norm-row-stats.wgsl.jinja",inputs:{mode:'"rms"',vec4:!0,scalar:"dtypes.Y",usesF16:!1,hidden:"args.dim",hiddenVec:"args.dim / 4",wg:"normWg",maxSubgroups:"normMaxSubgroups",epsilon:"args.eps",epsilon2:"args.eps2",vecType:'"vec4<" ~ dtypes.Y ~ ">"',combineSubgroups:"subgroupsWide32",rmsResidualAdd:!0,rmsChainNorm:!0}},bindings:[{name:"x",arg:"xT",semantic:"X",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"scale",arg:"wT",semantic:"W",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"scale2",arg:"w2T",semantic:"W2",buffer:{type:"read-only-storage"},elementType:"vec4<f32>"},{name:"y",arg:"yT",semantic:"Y",buffer:{type:"storage"},elementType:"vec4<f32>"},{name:"normed2",arg:"normed2T",semantic:"N2",buffer:{type:"storage"},elementType:"vec4<f32>"},{name:"params",semantic:"kernel.params",buffer:{type:"uniform"},struct:{name:"Params",fields:[{name:"rows",type:"u32",value:"args.rows"},{name:"rowStride",type:"u32",value:"max(1, min(args.rows, device.limits.maxComputeWorkgroupsPerDimension))"}]}}],dispatch:{workgroups:"args.rows"}}]}]},assets:[]}]]),dg="ops/_shared/";function r2(e){let t=new Set;for(let r of Ri(e,"<op-package>"))for(let a of fg(r))t.add(a);return t}function fg(e){let t=new Set;return mu(t,e.passes??[]),t}function mu(e,t){for(let r of t)r.repeat!==void 0?mu(e,r.passes??[]):pg(e,r)}function pg(e,t){if(t.source!==void 0){t.source.shader&&e.add(t.source.shader);return}t.shader&&e.add(t.shader)}function mg(e){return e.replaceAll("\\","/").startsWith(dg)}var hg=new Map,gg=new Map,a2=new Map,wg=new Map,s2=null,n2=null;function i2({opDir:e,repoRoot:t,loadManifestShaderPaths:r,access:a,sharedTextCache:s=new Map}){let n=new Map,i=new Map,u,o=l=>{let c=i.get(l);if(c!==void 0||i.has(l))return c??null;let d=new URL(l,e),f=_g(l)&&os(d,e),p=f?!1:(u??=r()).has(l);if(!f&&!p)return i.set(l,null),null;if((p||os(d,e))&&a.isFile(d)){let m={path:d,cache:n,cacheKey:l};return i.set(l,m),m}if(mg(l)){let m=new URL(l,t);if((p||os(m,t))&&a.isFile(m)){let h={path:m,cache:s,cacheKey:m.href};return i.set(l,h),h}}return i.set(l,null),null};return Object.freeze({readText(l){let c=o(l);if(!c)throw new Error(`WebGPU template asset is missing: ${l}`);let d=c.cache.get(c.cacheKey);if(d!==void 0)return d;let f=a.readText(c.path);return c.cache.set(c.cacheKey,f),f},has(l){return o(l)!==null}})}function hu(e,t={}){let r=bg(e);return new eg(r.manifest,{...t,assets:r.assets})}function bg(e){let t=gg.get(e);if(t){let a=new Map(hg);for(let[s,n]of t.assets)a.set(s,n);return{manifest:t.manifest,assets:Ya(a)}}let r=cg.get(e);if(r){let a=new Map(lg);for(let[s,n]of r.assets)a.set(s,n);return{manifest:r.manifest,assets:Ya(a)}}return vg(e)}function vg(e){let t=wg.get(e);if(t)return t;throw new Error(`WebGPU op package ${e} is not embedded in this runtime`)}function _g(e){return!e.endsWith(".wgsl")&&!e.endsWith(".wgsl.jinja")||e!==e.replaceAll("\\","/")||e.startsWith("/")?!1:e.split("/").every(t=>t.length>0&&t!=="."&&t!=="..")}function os(e,t){let r=t.href.endsWith("/")?t.href:`${t.href}/`;return e.href.startsWith(r)}ln();var yg=Fr;function kg(e,t=[]){let r=new Set(xg(t));return yg.filter(a=>e.features.has(a)&&!r.has(a)).map(a=>a)}function xg(e){return typeof e=="string"?e.split(",").map(t=>t.trim()).filter(Boolean):Array.isArray(e)?[...e]:e instanceof Set?[...e]:[]}function Sg(e,t,r,a){let s=t.info,n=r?.wgslLanguageFeatures??globalThis.navigator?.gpu?.wgslLanguageFeatures,i=a?a.min:s.subgroupMinSize,u=a?a.max:s.subgroupMaxSize,o=Fn(s.subgroupMatrixConfigs);return{adapterInfo:{vendor:s.vendor,architecture:s.architecture,device:s.device,description:s.description,isFallbackAdapter:s.isFallbackAdapter===!0,...typeof i=="number"?{subgroupMinSize:i}:{},...typeof u=="number"?{subgroupMaxSize:u}:{},...o!==null?{subgroupMatrixConfigs:o}:{}},features:Dn(e.features),wgslLanguageFeatures:$n(n),limits:Pn(e.limits)}}function qg(e){return{maxBufferSize:Number(e.limits.maxBufferSize),maxStorageBufferBindingSize:Number(e.limits.maxStorageBufferBindingSize),maxStorageBuffersPerShaderStage:Number(e.limits.maxStorageBuffersPerShaderStage),maxComputeWorkgroupStorageSize:Number(e.limits.maxComputeWorkgroupStorageSize)}}function gu(e){return e instanceof Error?e.message:String(e)}function Eg({adapter:e,device:t,deviceInfo:r,destroy:a,gpu:s,syncPipelineCreation:n,diagnosticSink:i}){let u=new WeakMap,o=p=>{if(i)try{i(p)}catch{}},l=n?async p=>{t.pushErrorScope("validation");let m;try{m=t.createComputePipeline(p)}catch(b){try{await t.popErrorScope()}catch{}throw b}let h=await t.popErrorScope();if(h)throw new Error(`createComputePipeline failed: ${h.message}`);return m}:p=>t.createComputePipelineAsync(p),c=async p=>{try{return await l(p)}catch(m){if(i){let h=p.compute.module,b=u.get(h),g=gu(m),v=h.getCompilationInfo;if(typeof v=="function")try{let w=await v.call(h);if(w.messages.length>0){let y=w.messages.map(q=>`${q.type} ${q.lineNum}:${q.linePos}: ${q.message}`);g=`${g}
${y.join(`
`)}`}}catch{}o({stage:"build",message:g,...p.label||b?.label?{label:p.label??b?.label}:{},...b?{shaderSource:b.source}:{}})}throw m}},d=0,f=0;return{gpu:s,adapter:e,device:t,deviceInfo:r,createShaderModule:(p,m)=>{try{let h=t.createShaderModule({code:p,label:m});return u.set(h,{source:p,...m?{label:m}:{}}),h}catch(h){throw o({stage:"build",message:gu(h),...m?{label:m}:{},shaderSource:p}),h}},createComputePipeline:c,createBuffer:p=>{let m=r.limits?.maxBufferSize,h=Number(p.size);if(typeof m=="number"&&h>m)throw new Error(`WebGPU buffer${p.label?` "${p.label}"`:""} of ${$i(h,1)} exceeds this device's maxBufferSize of ${$i(m,1)}. This model is too large to run on this GPU/browser.`);let b=t.createBuffer(p);d+=h,d>f&&(f=d);let g=b.destroy.bind(b),v=!0;return b.destroy=()=>{v&&(v=!1,d-=h),g()},b},memory:{get liveBytes(){return d},get peakBytes(){return f},markPeak(){f=d}},writeBuffer:(p,m,h)=>t.queue.writeBuffer(p,m,h),submit:async(p,m)=>{t.queue.submit(p),m.wait&&await t.queue.onSubmittedWorkDone()},mapRead:async(p,m,h)=>{await p.mapAsync(GPUMapMode.READ,m,h);let b=p.getMappedRange(m,h).slice(0);return p.unmap(),b},destroy:a}}function Tg(e){return Mi(e)}function wu(e,t){if(e)try{e(t)}catch{}}function Ig(e,t){e.addEventListener("uncapturederror",r=>{t?wu(t,{stage:"execute",message:`WebGPU uncaptured error: ${Tg(r.error)}`}):console.error("WebGPU uncaptured error:",r.error)}),t&&e.lost.then(r=>{r.reason!=="destroyed"&&wu(t,{stage:"execute",message:`WebGPU device lost (${r.reason}): ${r.message}`})})}async function Ag(e={}){let t=globalThis.navigator?.gpu;if(!t)throw new Error("WebGPU is not available in this browser context");let r=await t.requestAdapter({powerPreference:e.powerPreference??"high-performance"});if(!r)throw new Error("No WebGPU adapter was returned");let a=await r.requestDevice({requiredFeatures:kg(r,e.disabledFeatures),requiredLimits:e.requiredLimits??qg(r),label:e.label??"webgpu-ml-runtime"});return Ig(a,e.diagnosticSink),Eg({gpu:t,adapter:r,device:a,deviceInfo:Sg(a,r,t),diagnosticSink:e.diagnosticSink,destroy:()=>a.destroy()})}qe();function Bg(e){return e===null||typeof e!="object"?!1:"destroy"in e&&"mapAsync"in e&&"getMappedRange"in e&&!("buffer"in e)}function zt(e){return Bg(e)?e:e.buffer}function bu(e){return zt(e.type==="uniform"?e.buffer:e.tensor)}var jg=class{pipelines=new Map;#e=new Map;#t=new Map;physicalPipelines=new Map;pipelineLayouts=new Map;bindGroupLayouts=new Map;bindGroups=new Map;maxBindGroupEntries=4096;bufferIds=new WeakMap;#r=1;captureShaders=!1;capturedShaders=new Map;compileCount=0;compileTotalMs=0;#s=0;#a;constructor(e){this.#a=e}async buildPipeline(e){let t=this.pipelines.get(e.cacheKey);if(t)return t;let r=this.#e.get(e.cacheKey);if(r)return r.promise;let a=this.#s,s=this.#n(e,a),n={generation:a,promise:s};this.#e.set(e.cacheKey,n);try{return await s}finally{this.#e.get(e.cacheKey)===n&&this.#e.delete(e.cacheKey)}}async#n({cacheKey:e,name:t,entryPoint:r,layoutSignature:a,layoutFactory:s,sourceFactory:n},i){let u=await n();if(i!==this.#s)throw new Error(`Pipeline build ${e} was invalidated by clearPrograms()`);this.captureShaders&&!this.capturedShaders.has(t)&&this.capturedShaders.set(t,u);let o=(a?this.physicalPipeline(u,r,a):void 0)??(a?await this.#c({source:u,entryPoint:r,layoutSignature:a,generation:i,name:t,layoutFactory:s}):await this.#o({source:u,entryPoint:r,name:t,layoutFactory:s}));return i===this.#s&&this.pipelines.set(e,o),o}async#c({source:e,entryPoint:t,layoutSignature:r,generation:a,name:s,layoutFactory:n}){let i=this.#l(e,t,r,a);if(i)return i.promise;let u=this.#o({source:e,entryPoint:t,name:s,layoutFactory:n}),o={source:e,entryPoint:t,layoutSignature:r,generation:a,promise:u};this.#u(o);try{let l=await u;return a===this.#s&&this.setPhysicalPipeline(e,t,r,l),l}finally{this.#i(o)}}async#o({source:e,entryPoint:t,name:r,layoutFactory:a}){let s=performance.now(),n=this.#a.createShaderModule(e,r),i=a(),u=await this.#a.createComputePipeline({label:r,layout:i,compute:{module:n,entryPoint:t}});return this.compileCount+=1,this.compileTotalMs+=performance.now()-s,u}cachedBindGroups({name:e,cacheKey:t,pipeline:r,bindings:a}){return{bindGroup:this.buildGroupBindGroup(e,t,r,a)}}buildGroupBindGroup(e,t,r,a){let s=Lh(t,a,i=>this.bufferId(bu(i))),n=this.bindGroups.get(s);if(n===void 0){let i=a.map((u,o)=>{let l={buffer:bu(u),offset:u.offset??0};return u.size!==void 0&&u.size>0&&(l.size=u.size),{binding:u.binding??o,resource:l}});if(n=this.#a.device.createBindGroup({label:`${e}-bind-group`,layout:r.getBindGroupLayout(0),entries:i.map(({binding:u,resource:o})=>({binding:u,resource:o}))}),this.bindGroups.set(s,n),this.bindGroups.size>this.maxBindGroupEntries){let u=this.bindGroups.keys().next().value;u!==void 0&&this.bindGroups.delete(u)}}return n}bufferId(e){let t=this.bufferIds.get(e);return t===void 0&&(t=this.#r++,this.bufferIds.set(e,t)),t}pipelineLayout(e,t){let r=vu(e,t),a=this.pipelineLayouts.get(r.signature);if(a)return a;let s=this.#a.device.createPipelineLayout({label:`${e}-layout`,bindGroupLayouts:[this.bindGroupLayout(e,r.entries)]});return this.pipelineLayouts.set(r.signature,s),s}pipelineLayoutSignature(e,t){return vu(e,t).signature}bindGroupLayout(e,t){let r=t.map(i=>({binding:i.binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:i.type}})),a=r.map(i=>`${i.binding}:${i.buffer.type}`).sort().join("|"),s=this.bindGroupLayouts.get(a);if(s)return s;let n=this.#a.device.createBindGroupLayout({label:`${e}-bgl0`,entries:r});return this.bindGroupLayouts.set(a,n),n}clearBindGroups(){let e=this.bindGroups.size;return this.bindGroups.clear(),e}clearPrograms(){let e=this.pipelines.size;return this.#s+=1,this.#e.clear(),this.#t.clear(),this.bindGroups.clear(),this.pipelines.clear(),this.physicalPipelines.clear(),this.pipelineLayouts.clear(),this.bindGroupLayouts.clear(),this.captureShaders||this.capturedShaders.clear(),e}getRenderedShaders(){return[...this.capturedShaders].map(([e,t])=>({name:e,source:t}))}physicalPipeline(e,t,r){return this.physicalPipelines.get(hr(e,t,r))?.find(a=>a.entryPoint===t&&a.layoutSignature===r&&a.source===e)?.pipeline}#l(e,t,r,a){return this.#t.get(hr(e,t,r))?.find(s=>s.generation===a&&s.entryPoint===t&&s.layoutSignature===r&&s.source===e)}#u(e){let t=hr(e.source,e.entryPoint,e.layoutSignature),r=this.#t.get(t);r?r.push(e):this.#t.set(t,[e])}#i(e){let t=hr(e.source,e.entryPoint,e.layoutSignature),r=this.#t.get(t);if(!r)return;let a=r.indexOf(e);a<0||(r.splice(a,1),r.length===0&&this.#t.delete(t))}setPhysicalPipeline(e,t,r,a){let s=hr(e,t,r),n=this.physicalPipelines.get(s),i={source:e,entryPoint:t,layoutSignature:r,pipeline:a};n?n.push(i):this.physicalPipelines.set(s,[i])}};function vu(e,t){let r=t.map((s,n)=>typeof s=="string"?{binding:n,type:s}:{binding:s.binding??n,type:s.type}),a=new Set;for(let s of r){if(!Number.isInteger(s.binding)||s.binding<0)throw new Error(`pipeline layout ${e} has invalid binding index ${s.binding}`);if(a.has(s.binding))throw new Error(`pipeline layout ${e} has duplicate binding index ${s.binding}`);if(typeof s.type!="string"||s.type.length===0)throw new Error(`pipeline layout ${e} binding ${s.binding} is missing a buffer type`);a.add(s.binding)}return{signature:r.map(s=>`${s.binding}:${s.type}`).sort().join("|"),entries:r}}function hr(e,t,r){return`${Ch(e)}|entry=${t}|layout=${r}`}var Mg=class{pool=new Map;bytes=0;maxBytes;constructor(e=64*1024*1024){this.maxBytes=e}acquire(e,t){let r=this.pool.get(t);return r&&r.length>0?(this.bytes-=t,r.pop()):e.createBuffer({label:"tensor-readback",size:t,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})}release(e,t){if(this.bytes+e>this.maxBytes){t.destroy();return}let r=this.pool.get(e);r||(r=[],this.pool.set(e,r)),r.push(t),this.bytes+=e}discard(e){try{e.destroy()}catch{}}clear(){let e=0;for(let t of this.pool.values())for(let r of t)r.destroy(),e++;return this.pool.clear(),this.bytes=0,e}},ls=64*1024,Dg=4,_t=class{runtime;dtype;shape;byteOffset;buffer;size;byteLength;destroyed;constructor({runtime:e,dtype:t,shape:r,buffer:a,byteOffset:s=0}){this.runtime=e,this.dtype=t,this.shape=r,this.byteOffset=s,this.buffer=a,this.size=ke(r),this.byteLength=this.size*Oe(t),this.destroyed=!1}destroy(){this.destroyed||(this.buffer.destroy(),this.destroyed=!0)}},$g=class{host;pipelines;profileSession;pendingProfileRuns;readback;destroyed;mappedTensorUploadsAvailable;#e=new Map;#t=Promise.resolve();#r=!1;constructor({host:e}){this.host=e,this.pipelines=new jg(e),this.profileSession=null,this.pendingProfileRuns=[],this.readback=new Mg,this.destroyed=!1,this.mappedTensorUploadsAvailable=!0}get device(){return this.host.deviceInfo}get captureShaders(){return this.pipelines.captureShaders}set captureShaders(e){this.pipelines.captureShaders=e}getRenderedShaders(){return this.pipelines.getRenderedShaders()}async destroy(){this.destroyed||(this.destroyed=!0,this.clearBindGroupCache(),this.clearReadbackPool(),await this.#t,this.#i(),await this.host.destroy())}clearReadbackPool(){return this.readback.clear()}clearBindGroupCache(){return this.pipelines.clearBindGroups()}clearKernelCaches(){return this.pipelines.clearPrograms()}tensorFromTypedArray(e,t,r){if(!Fg(e,r))throw new Error("Only float16/Uint16Array, float32/Float32Array and uint32/Uint32Array tensors are supported");let a=ke(t);if(r.length!==a)throw new Error(`tensor data length ${r.length} does not match shape element count ${a}`);let s={label:"tensor",size:gt(r.byteLength),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC};if(this.mappedTensorUploadsAvailable&&r.byteLength>=ls){let i=null;try{i=this.host.createBuffer({...s,mappedAtCreation:!0});let u=i.getMappedRange();return r instanceof Float32Array?new Float32Array(u).set(r):r instanceof Uint16Array?new Uint16Array(u).set(r):r instanceof Int32Array?new Int32Array(u).set(r):new Uint32Array(u).set(r),i.unmap(),new _t({runtime:this,dtype:e,shape:t,buffer:i})}catch{try{i?.destroy()}catch{}this.mappedTensorUploadsAvailable=!1}}let n=this.host.createBuffer(s);try{let i=r;if(r.byteLength%4!==0){let u=new Uint8Array(gt(r.byteLength));u.set(new Uint8Array(r.buffer,r.byteOffset,r.byteLength)),i=u}return this.host.writeBuffer(n,0,i),new _t({runtime:this,dtype:e,shape:t,buffer:n})}catch(i){try{n.destroy()}catch{}throw i}}tensorFromWriter(e,t,r){let a=Fe[e];if(!a)throw new Error(`Unsupported dtype: ${e}`);let s=ke(t),n=s*a.storageByteSize,i={label:"tensor",size:gt(n),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC,mappedAtCreation:!0};if(this.mappedTensorUploadsAvailable&&n>=ls){let o=null;try{o=this.host.createBuffer(i)}catch{this.mappedTensorUploadsAvailable=!1}if(o){let l;try{l=new a.arrayCtor(o.getMappedRange(),0,s)}catch{this.mappedTensorUploadsAvailable=!1;try{o.destroy()}catch{}o=null}if(o){try{r(l)}catch(c){try{o.unmap()}catch{}try{o.destroy()}catch{}throw c}try{o.unmap()}catch(c){this.mappedTensorUploadsAvailable=!1;try{o.destroy()}catch{}throw c}return new _t({runtime:this,dtype:e,shape:t,buffer:o})}}}let u=new a.arrayCtor(s);return r(u),this.tensorFromTypedArray(e,t,u)}beginMappedTensorUpload(e,t,r="tensor"){let a=Fe[e];if(!a)throw new Error(`Unsupported dtype: ${e}`);let s=[...t],n=ke(s)*a.storageByteSize;if(!this.mappedTensorUploadsAvailable||n<ls)return null;let i;try{i=this.host.createBuffer({label:r,size:gt(n),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC,mappedAtCreation:!0})}catch{return this.mappedTensorUploadsAvailable=!1,null}let u;try{let p=i.getMappedRange();if(p.byteLength<n)throw new Error(`Mapped tensor range has ${p.byteLength} bytes; expected at least ${n}`);u=new Uint8Array(p,0,n)}catch{this.mappedTensorUploadsAvailable=!1;try{i.destroy()}catch{}return null}let o="open",l=null,c=!1,d=()=>{c||(c=!0,i.destroy())},f=p=>{if(o!=="open")throw new Error(`Cannot ${p} mapped tensor upload after it was ${o}`)};return{destination:u,commit:()=>{f("commit");try{i.unmap()}catch(p){o="aborted",this.mappedTensorUploadsAvailable=!1;try{d()}catch{}throw p}try{l=new _t({runtime:this,dtype:e,shape:s,buffer:i})}catch(p){o="aborted";try{d()}catch{}throw p}return o="committed",l},rollback:p=>{if(p!==l)throw new Error("Cannot roll back a tensor that was not returned by this mapped upload");if(o!=="rolled back"){if(o!=="committed")throw new Error(`Cannot roll back mapped tensor upload after it was ${o}`);l.destroy(),o="rolled back"}},abort:()=>{if(o==="aborted")return;f("abort"),o="aborted";let p;try{i.unmap()}catch(m){this.mappedTensorUploadsAvailable=!1,p=m}try{d()}catch(m){if(p===void 0)throw m}if(p!==void 0)throw p}}}allocateWeightsBuffer({byteLength:e,dtype:t,shape:r,label:a="weights"}){if(!_u(t))throw new Error(`Unsupported dtype: ${t}`);if(!Number.isInteger(e)||e<0)throw new Error(`byteLength must be a nonnegative integer, got ${e}`);let s=this.host.createBuffer({label:a,size:e,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});return new _t({runtime:this,dtype:t,shape:r,buffer:s})}writeWeightsRange(e,t,r){if(!(e instanceof _t))throw new Error("writeWeightsRange expects a WebGpuTensor");if(!Number.isInteger(t)||t<0)throw new Error(`byteOffset must be a nonnegative integer, got ${t}`);if(t+r.byteLength>e.byteLength)throw new Error(`write range [${t}, ${t+r.byteLength}] exceeds tensor byteLength ${e.byteLength}`);this.host.writeBuffer(e.buffer,t,r)}async copyBufferToBuffer({src:e,dst:t,srcOffset:r=0,dstOffset:a=0,byteLength:s,wait:n=!1}){if(s===0)return;let i=zt(e),u=zt(t),o=this.host.device.createCommandEncoder({label:"copyBufferToBuffer"});o.copyBufferToBuffer(i,r,u,a,s),await this.host.submit([o.finish()],{wait:n})}clearBuffers(e){let t=null;for(let{dst:r,dstOffset:a=0,byteLength:s}of e){if(!Number.isInteger(a)||a<0||a%4!==0)throw new Error(`clear buffer offset must be a non-negative multiple of 4, got ${a}`);if(!Number.isInteger(s)||s<0||s%4!==0)throw new Error(`clear buffer byteLength must be a non-negative multiple of 4, got ${s}`);s!==0&&(t??=this.host.device.createCommandEncoder({label:"clear-buffers"}),t.clearBuffer(zt(r),a,s))}t&&this.host.device.queue.submit([t.finish()])}async queueIdle(){await this.host.device.queue.onSubmittedWorkDone()}empty(e,t,r="tensor-output"){if(!_u(e))throw new Error(`Unsupported dtype: ${e}`);let a=ke(t)*Oe(e),s=this.host.createBuffer({label:r,size:gt(a),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});return new _t({runtime:this,dtype:e,shape:t,buffer:s})}readTensor(e){if(e.byteLength===0){let i=Fe[e.dtype]?.arrayCtor;return i?Promise.resolve(new i(0)):Promise.reject(new Error(`Unsupported dtype: ${e.dtype}`))}let t=gt(e.byteLength),r=this.readback.acquire(this.host,t),a=this.host.device.createCommandEncoder({label:"readTensor"});a.copyBufferToBuffer(e.buffer,e.byteOffset,r,0,t),this.host.device.queue.submit([a.finish()]);let{dtype:s,byteLength:n}=e;return(async()=>{let i;try{i=await this.host.mapRead(r,0,t)}catch(o){throw this.readback.discard(r),o}this.readback.release(t,r),t!==n&&(i=i.slice(0,n));let u=Fe[s]?.arrayCtor;if(!u)throw new Error(`Unsupported dtype: ${s}`);return new u(i)})()}async runProgram(e,t={}){await this.runProgramSequence([e],t)}async runProgramSequence(e,t={}){let r=await this.prepareProgramSequence(e);await this.executePreparedProgramSequence(r,t)}async prepareProgramSequence(e){if(!Array.isArray(e)||e.length===0)throw new Error("prepareProgramSequence requires at least one program");let t=new Array(e.length),r=0,a=!1,s=[],n=async()=>{for(;!a;){let i=r++;if(i>=e.length)return;try{t[i]=await this.#s(e[i])}catch(u){s.push({index:i,error:u}),a=!0}}};if(await Promise.all(Array.from({length:Math.min(Dg,e.length)},n)),s.length>0)throw s.sort((i,u)=>i.index-u.index),s[0].error;return t}async#s(e){if(Pg(e))return Cg(e);let{name:t,source:r,entryPoint:a="main",cacheKey:s=t,bindings:n,dispatchWorkgroups:i,profile:u,submitAfter:o}=e;if(typeof r!="string"||r.length===0)throw new Error("program requires WGSL source");if(!Array.isArray(n)||n.length===0)throw new Error("program requires bindings");if(!Array.isArray(i)||i.length!==3)throw new Error("program requires a 3D dispatchWorkgroups array");let l=this.pipelines.pipelineLayoutSignature(t,n),c=await this.pipelines.buildPipeline({name:t,entryPoint:a,cacheKey:s,layoutSignature:l,layoutFactory:()=>this.pipelines.pipelineLayout(t,n),sourceFactory:()=>r}),{bindGroup:d}=this.pipelines.cachedBindGroups({name:t,cacheKey:s,pipeline:c,bindings:n});return{pipeline:c,bindGroup:d,dispatchWorkgroups:i,name:t,cacheKey:s,profile:u,...o?{submitAfter:!0}:{}}}async executePreparedProgramSequence(e,t={}){if(!Array.isArray(e)||e.length===0)throw new Error("executePreparedProgramSequence requires at least one prepared step");let r=t.wait??!1;if(this.profileSession){await this.#c();try{await this._runSteps(e,{wait:r,mergePass:!1})}finally{this.#l()}return}await this._runSteps(e,{wait:r,mergePass:!0})}preparedProgramSequenceRequiresCompletionFences(e){return e.some(t=>t.kind!=="copy"&&t.submitAfter===!0&&!et(t.dispatchWorkgroups))}#a=8;#n=[];async#c(){for(;this.#a<=0;)await new Promise(e=>this.#n.push(e));this.#a-=1}#o(){return this.#a<=0?!1:(this.#a-=1,!0)}#l(){this.#a+=1,this.#n.shift()?.()}enqueuePreparedProgramSequence(e){if(!Array.isArray(e)||e.length===0)throw new Error("enqueuePreparedProgramSequence requires at least one prepared step");let t=cs(e);if(this.profileSession&&t.length===1&&this.#o()){let r=this._runSteps(e,{wait:!1,mergePass:!1});this.pendingProfileRuns.push(r.finally(()=>this.#l()));return}for(let r of t){let a=this.host.device.createCommandEncoder({label:"compute-dispatch"});ta(a,r),this.host.device.queue.submit([a.finish()])}}async flushDeferredProfile(){let e=this.pendingProfileRuns;this.pendingProfileRuns=[],await Promise.all(e)}async measurePreparedSequenceGpuMs(e,t=1,r){if(this.destroyed||!this.host.device.features.has("timestamp-query")||this.#r)return null;let a=this.#t,s;this.#t=new Promise(n=>{s=n}),await a;try{if(this.destroyed||this.#r)return null;let n=this.#e.get(2)??this.#d(2),i=cs(e);if(i.length>1)return await this.#u(i,t,n,r);let u=this.host.device.createCommandEncoder({label:"gpu-time-measure"});for(let m of e)m.kind==="copy"&&m.byteLength>0&&u.copyBufferToBuffer(m.src,m.srcOffset,m.dst,m.dstOffset,m.byteLength);let o=u.beginComputePass({label:"gpu-time-pass",timestampWrites:{querySet:n.querySet,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}}),l=!1,c=null,d=null;for(let m=0;m<t;++m)for(let h of e)h.kind==="copy"||et(h.dispatchWorkgroups)||(h.pipeline!==c&&(o.setPipeline(h.pipeline),c=h.pipeline),h.bindGroup!==d&&(o.setBindGroup(0,h.bindGroup),d=h.bindGroup),o.dispatchWorkgroups(h.dispatchWorkgroups[0],h.dispatchWorkgroups[1],h.dispatchWorkgroups[2]),l=!0);if(o.end(),!l)return null;u.resolveQuerySet(n.querySet,0,2,n.resolveBuffer,0),u.copyBufferToBuffer(n.resolveBuffer,0,n.readbackBuffer,0,16);let f=this.host.submit([u.finish()],{wait:!0});try{r?.()}catch{}await f;let p;try{p=await this.readTimestampBuffer(n.readbackBuffer,2)}catch{return this.#r=!0,this.#i(),null}return Number(p[1]-p[0])/1e6}finally{s()}}async measurePreparedSequenceGpuSamples(e,t,r){if(this.destroyed||!this.host.device.features.has("timestamp-query")||this.#r||!Number.isSafeInteger(t)||t<=0||!Number.isSafeInteger(r)||r<=1||this.preparedProgramSequenceRequiresCompletionFences(e)||!ds(e))return null;let a=this.#t,s;this.#t=new Promise(n=>{s=n}),await a;try{if(this.destroyed||this.#r)return null;let n=r*2,i=this.#e.get(n)??this.#d(n);for(let l=0;l<r;++l)for(let c=0;c<t;++c){let d=this.host.device.createCommandEncoder({label:"gpu-time-sample-batch"});ta(d,e,{querySet:i.querySet,...c===0?{beginningOfSequenceWriteIndex:l*2}:{},...c===t-1?{endOfSequenceWriteIndex:l*2+1}:{}}),this.host.device.queue.submit([d.finish()])}let u=this.host.device.createCommandEncoder({label:"gpu-time-sample-batch-resolve"});u.resolveQuerySet(i.querySet,0,n,i.resolveBuffer,0),u.copyBufferToBuffer(i.resolveBuffer,0,i.readbackBuffer,0,n*8),await this.host.submit([u.finish()],{wait:!1});let o;try{o=await this.readTimestampBuffer(i.readbackBuffer,n)}catch{return this.#r=!0,this.#i(),null}return Array.from({length:r},(l,c)=>Number(o[c*2+1]-o[c*2])/1e6)}finally{s()}}async#u(e,t,r,a){if(!Number.isInteger(t)||t<=0)return null;let s=e.findIndex(ds),n=-1;for(let o=e.length-1;o>=0;--o)if(ds(e[o])){n=o;break}if(s<0||n<0)return null;let i=[];for(let o=0;o<t;++o)for(let l=0;l<e.length;++l){let c=this.host.device.createCommandEncoder({label:"gpu-time-measure-boundary"}),d=o===0&&l===s,f=o===t-1&&l===n;ta(c,e[l],{querySet:r.querySet,...d?{beginningOfSequenceWriteIndex:0}:{},...f?{endOfSequenceWriteIndex:1}:{}}),o===t-1&&l===e.length-1&&(c.resolveQuerySet(r.querySet,0,2,r.resolveBuffer,0),c.copyBufferToBuffer(r.resolveBuffer,0,r.readbackBuffer,0,16)),i.push(c.finish())}for(let o=0;o<i.length;++o){let l=this.host.submit([i[o]],{wait:!0});if(o===i.length-1)try{a?.()}catch{}await l}let u;try{u=await this.readTimestampBuffer(r.readbackBuffer,2)}catch{return this.#r=!0,this.#i(),null}return Number(u[1]-u[0])/1e6}#i(){for(let e of this.#e.values())e.querySet.destroy(),e.resolveBuffer.destroy(),e.readbackBuffer.destroy();this.#e.clear()}#d(e){let t=this.createTimestampResources(e);return this.#e.set(e,t),t}pipelineCompileStats(){return{count:this.pipelines.compileCount,totalMs:this.pipelines.compileTotalMs}}memoryStats(){let e=this.host.memory;return e?{liveBytes:e.liveBytes,peakBytes:e.peakBytes}:null}markMemoryPeak(){this.host.memory?.markPeak()}createUniformU32(e,t){let r=new Uint32Array(e),a=this.host.createBuffer({label:t,size:r.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});return this.host.writeBuffer(a,0,r),a}async _runSteps(e,{wait:t=!1,mergePass:r}){let a=!!this.profileSession,s=cs(e);if(!a&&r){let c=s.map(d=>{let f=this.host.device.createCommandEncoder({label:"compute-dispatch"});return ta(f,d),f.finish()});for(let d=0;d+1<c.length;++d)await this.host.submit([c[d]],{wait:!0});await this.host.submit([c[c.length-1]],{wait:t||yu(s[s.length-1])});return}let n=e.map((c,d)=>c.kind==="copy"||et(c.dispatchWorkgroups)?-1:d).filter(c=>c>=0),i=a?n.length*2:0,u=a&&i>0?this.createTimestampResources(i):void 0,o=0,l=[];for(let c=0;c<s.length;++c){let d=this.host.device.createCommandEncoder({label:a?"profiled-compute-dispatch":"compute-dispatch"});for(let f of s[c]){if(f.kind==="copy"){f.byteLength>0&&d.copyBufferToBuffer(f.src,f.srcOffset,f.dst,f.dstOffset,f.byteLength);continue}if(et(f.dispatchWorkgroups))continue;let p=d.beginComputePass({label:a?`${f.name??"compute"}-profile-pass`:"compute-pass",...u?{timestampWrites:{querySet:u.querySet,beginningOfPassWriteIndex:o*2,endOfPassWriteIndex:o*2+1}}:{}});p.setPipeline(f.pipeline),p.setBindGroup(0,f.bindGroup),p.dispatchWorkgroups(f.dispatchWorkgroups[0],f.dispatchWorkgroups[1],f.dispatchWorkgroups[2]),p.end(),o+=1}c===s.length-1&&u!==void 0&&(d.resolveQuerySet(u.querySet,0,i,u.resolveBuffer,0),d.copyBufferToBuffer(u.resolveBuffer,0,u.readbackBuffer,0,i*8)),l.push(d.finish())}for(let c=0;c+1<l.length;++c)await this.host.submit([l[c]],{wait:!0});if(!a||u===void 0){await this.host.submit([l[l.length-1]],{wait:t||yu(s[s.length-1])});return}try{await this.host.submit([l[l.length-1]],{wait:t});let c=await this.readTimestampBuffer(u.readbackBuffer,i);for(let d=0;d<n.length;++d){let f=e[n[d]];!f||f.kind==="copy"||this.profileSession?.record(f,c[d*2],c[d*2+1])}}finally{u.querySet.destroy(),u.resolveBuffer.destroy(),u.readbackBuffer.destroy()}}createTimestampResources(e){let t=e*8,r=this.host.device.createQuerySet({type:"timestamp",count:e}),a=this.host.createBuffer({label:"timestamp-resolve",size:t,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC}),s=this.host.createBuffer({label:"timestamp-readback",size:t,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});return{querySet:r,resolveBuffer:a,readbackBuffer:s}}async readTimestampBuffer(e,t){let r=await this.host.mapRead(e,0,t*8),a=new BigUint64Array(r);return Array.from(a,s=>s)}};function Fg(e,t){let r=Fe[e]?.arrayCtor;return r!==void 0&&t instanceof r}function _u(e){return Fe[e]!==void 0}function Pg(e){return e.kind==="copy"}function Cg(e){if(!e.src||!e.dst)throw new Error("copy step requires src and dst (buffer or tensor)");let t=zt(e.src),r=zt(e.dst),a=e.srcOffset??0,s=e.dstOffset??0,n=e.byteLength;if(!Number.isInteger(n)||n<=0)throw new Error("copy step requires positive integer byteLength");return{kind:"copy",src:t,dst:r,srcOffset:a,dstOffset:s,byteLength:n,name:e.name??"copy"}}function cs(e){let t=[],r=0;for(let a=0;a<e.length;++a){let s=e[a];s.kind!=="copy"&&s.submitAfter&&!et(s.dispatchWorkgroups)&&(t.push(e.slice(r,a+1)),r=a+1)}return r<e.length&&t.push(e.slice(r)),t}function ds(e){return e.some(t=>t.kind!=="copy"&&!et(t.dispatchWorkgroups))}function yu(e){let t=e[e.length-1];return t?.kind!=="copy"&&t?.submitAfter===!0&&!et(t.dispatchWorkgroups)}function ta(e,t,r){let a=null,s=t.findIndex(c=>c.kind!=="copy"&&!et(c.dispatchWorkgroups)),n=s,i=!1;for(let c=s+1;c<t.length;++c){let d=t[c];d.kind==="copy"?i=!0:!et(d.dispatchWorkgroups)&&i&&(n=c,i=!1)}let u=null,o=null,l=()=>{a!==null&&(a.end(),a=null),u=null,o=null};for(let c=0;c<t.length;++c){let d=t[c];if(d.kind==="copy"){l(),d.byteLength>0&&e.copyBufferToBuffer(d.src,d.srcOffset,d.dst,d.dstOffset,d.byteLength);continue}if(!et(d.dispatchWorkgroups)){if(a===null){let f=c===s?r?.beginningOfSequenceWriteIndex:void 0,p=c===n?r?.endOfSequenceWriteIndex:void 0,m=f!==void 0||p!==void 0;a=e.beginComputePass({label:"compute-sequence-pass",...m?{timestampWrites:{querySet:r.querySet,...f!==void 0?{beginningOfPassWriteIndex:f}:{},...p!==void 0?{endOfPassWriteIndex:p}:{}}}:{}})}d.pipeline!==u&&(a.setPipeline(d.pipeline),u=d.pipeline),d.bindGroup!==o&&(a.setBindGroup(0,d.bindGroup),o=d.bindGroup),a.dispatchWorkgroups(d.dispatchWorkgroups[0],d.dispatchWorkgroups[1],d.dispatchWorkgroups[2])}}l()}function et(e){return e[0]===0||e[1]===0||e[2]===0}async function Lg(e={}){let t=e.host??await Ag(e);return new $g({host:t})}function gr(e){return e instanceof Error?e.message:String(e)}function ku(e){return e.byteOffset===0&&e.byteLength===e.buffer.byteLength&&e.buffer instanceof ArrayBuffer?e.buffer:e.slice().buffer}function xu(e,t){if(e.length===0)return new Uint8Array(0);if(e.length===1&&e[0].byteLength===t)return e[0];let r=new Uint8Array(t),a=0;for(let s of e)r.set(s,a),a+=s.byteLength;return r}function fe(e){let t=e&32768?-1:1,r=e>>>10&31,a=e&1023;return r===31?a===0?t*(1/0):NaN:r===0?t*2**-14*(a/1024):t*2**(r-15)*(1+a/1024)}var fs=null;function zg(){if(!fs){let e=new Float32Array(65536);for(let t=0;t<e.length;++t)e[t]=fe(t);fs=e}return fs}function Og(e){let t=new Uint16Array(e.length);if(e instanceof Float32Array){let r=new Uint32Array(e.buffer,e.byteOffset,e.length);for(let a=0;a<e.length;++a){let s=r[a],n=(s>>>23&255)-112;if(n>0&&n<31){let i=s&8388607,u=i&8191,o=i>>>13;(u>4096||u===4096&&(o&1)===1)&&(o+=1,o===1024&&(o=0,n+=1)),t[a]=n>=31?s>>>16&32768|31743:s>>>16&32768|n<<10|o}else t[a]=qu(s)}}else for(let r=0;r<e.length;++r)t[r]=Wg(e[r]);return t}var Su=new Float32Array(1),Ng=new Uint32Array(Su.buffer);function Wg(e){return Number.isNaN(e)?32256:(Su[0]=e,qu(Ng[0]))}function qu(e){let t=e>>>16&32768,r=e>>>23&255,a=e&8388607;if(r===255)return a!==0?32256:t|31744;let s=r-127+15;if(s>=31)return t|31743;if(s<=0){if(s<-10)return t;let l=a|8388608,c=14-s,d=1<<c-1,f=l&(1<<c)-1,p=l>>>c;return(f>d||f===d&&(p&1)===1)&&(p+=1),t|p}let n=4096,i=a&8191,u=a>>>13,o=s;return(i>n||i===n&&(u&1)===1)&&(u+=1,u===1024&&(u=0,o+=1)),o>=31?t|31743:t|o<<10|u}var Gg=(()=>{let e=new Uint16Array([258]);return new Uint8Array(e.buffer)[0]===2})();function Rg(e,t){if(e==="F32")return Hg(t);if(e==="BF16")return Vg(t);if(e==="F16")return Xg(t);throw new Error(`Unsupported source dtype for float32 copy: ${e}`)}function Hg(e){let t=e.byteLength/4;return e.byteOffset%4===0?new Float32Array(e.buffer,e.byteOffset,t):Ug(e,Float32Array,4)}function Ug(e,t,r){let a=new t(e.byteLength/r);return new Uint8Array(a.buffer).set(e),a}function Vg(e){let t=Eu(e),r=new Float32Array(t);return Qg(e,r)}function Qg(e,t,r=0){let a=Eu(e);Kg(t.length,r,a,"BF16 -> F32");let s=new Uint32Array(t.buffer,t.byteOffset,t.length);if(Gg&&e.byteOffset%2===0){let n=new Uint16Array(e.buffer,e.byteOffset,a);for(let i=0;i<a;++i)s[r+i]=n[i]<<16}else for(let n=0;n<a;++n){let i=e[n*2],u=e[n*2+1];s[r+n]=(u<<8|i)<<16}return t}function Eu(e){if(e.byteLength%2!==0)throw new Error(`BF16 byte length ${e.byteLength} is not divisible by 2`);return e.byteLength/2}function Kg(e,t,r,a){if(!Number.isSafeInteger(t)||t<0)throw new Error(`${a} destination offset must be a non-negative safe integer, got ${t}`);if(t>e||r>e-t)throw new Error(`${a} destination range [${t}, ${t+r}) exceeds length ${e}`)}function Xg(e){let t=e.byteLength/2,r=new Float32Array(t),a=zg();if(e.byteOffset%2===0){let s=new Uint16Array(e.buffer,e.byteOffset,t);for(let n=0;n<t;++n)r[n]=a[s[n]]}else{let s=new DataView(e.buffer,e.byteOffset,e.byteLength);for(let n=0;n<t;++n)r[n]=a[s.getUint16(n*2,!0)]}return r}var Yg=new Uint32Array(1),u2=new Float32Array(Yg.buffer),S=Object.freeze({F32:0,F16:1,Q4_0:2,Q4_1:3,Q5_0:6,Q5_1:7,Q8_0:8,Q8_1:9,Q2_K:10,Q3_K:11,Q4_K:12,Q5_K:13,Q6_K:14,Q8_K:15,IQ2_XXS:16,IQ2_XS:17,IQ3_XXS:18,IQ1_S:19,IQ4_NL:20,IQ3_S:21,IQ2_S:22,IQ4_XS:23,I8:24,I16:25,I32:26,I64:27,F64:28,IQ1_M:29,BF16:30,TQ1_0:34,TQ2_0:35,MXFP4:39,NVFP4:40,Q1_0:41,Q2_0:42}),Ot=Object.freeze(Object.fromEntries(Object.entries(S).map(([e,t])=>[t,e]))),ae=class extends Error{constructor(e){super(e),this.name="GGUFError"}},ve=256,ps=128,Zg=18,Jg=64,Tu=18,ra=32,ew=18,tw=32,rw=20,aw=32,sw=22,nw=32,iw=24,aa=32,wr=34,uw=32,ow=36,lw=292,ms=ve,br=210,hs=ve,vr=144,gs=ve,_r=176,cw=ve,dw=66,Iu=54,fw=32,pw=17,mw=64,hw=36,Au=50,Bu=56;function sa(e,t){if(!Number.isInteger(t)||t<0)throw new ae(`Invalid tensor element count: ${t}`);if(e===S.F32)return t*4;if(e===S.F16||e===S.BF16)return t*2;if(e===S.I8)return t;if(e===S.I16)return t*2;if(e===S.I32)return t*4;if(e===S.I64||e===S.F64)return t*8;if(e===S.Q1_0){if(t%ps!==0)throw new ae(`Q1_0 tensor element count must be divisible by ${ps}`);return t/ps*Zg}if(e===S.Q4_0)return ee(e,t,ra,ew);if(e===S.Q2_0)return ee(e,t,Jg,Tu);if(e===S.Q4_1)return ee(e,t,tw,rw);if(e===S.Q5_0)return ee(e,t,aw,sw);if(e===S.Q5_1)return ee(e,t,nw,iw);if(e===S.Q8_0)return ee(e,t,aa,wr);if(e===S.Q8_1)return ee(e,t,uw,ow);if(e===S.Q2_K)return ee(e,t,ve,84);if(e===S.Q3_K)return ee(e,t,ve,110);if(e===S.Q4_K)return ee(e,t,hs,vr);if(e===S.Q5_K)return ee(e,t,gs,_r);if(e===S.Q6_K)return ee(e,t,ms,br);if(e===S.Q8_K)return ee(e,t,ve,lw);if(e===S.IQ4_NL)return ee(e,t,32,18);if(e===S.IQ4_XS)return ee(e,t,ve,136);if(e===S.IQ2_XXS)return ee(e,t,ve,66);if(e===S.IQ2_XS)return ee(e,t,ve,74);if(e===S.IQ2_S)return ee(e,t,ve,82);if(e===S.IQ3_XXS)return ee(e,t,ve,98);if(e===S.IQ3_S)return ee(e,t,ve,110);if(e===S.TQ2_0)return ee(e,t,cw,dw);if(e===S.TQ1_0)return ee(e,t,ve,Iu);if(e===S.MXFP4)return ee(e,t,fw,pw);if(e===S.NVFP4)return ee(e,t,mw,hw);if(e===S.IQ1_S)return ee(e,t,ve,Au);if(e===S.IQ1_M)return ee(e,t,ve,Bu);throw new ae(`Unsupported GGML tensor type ${Ot[e]??e}`)}function ee(e,t,r,a){if(t%r!==0)throw new ae(`${Ot[e]??e} tensor element count ${t} must be divisible by ${r}`);return t/r*a}function gw(e){if(e.byteLength%br!==0)throw new ae(`Q6_K byte length ${e.byteLength} is not a multiple of ${br}`);let t=e.byteLength/br,r=new Float32Array(t*ms),a=new DataView(e.buffer,e.byteOffset,e.byteLength);for(let s=0;s<t;++s){let n=s*br,i=fe(a.getUint16(n+208,!0)),u=s*ms;for(let o=0;o<2;++o){let l=n+o*64,c=n+128+o*32,d=n+192+o*8,f=u+o*128;for(let p=0;p<32;++p){let m=p>>4,h=e[c+p],b=(e[l+p]&15|(h>>0&3)<<4)-32,g=(e[l+p+32]&15|(h>>2&3)<<4)-32,v=(e[l+p]>>4|(h>>4&3)<<4)-32,w=(e[l+p+32]>>4|(h>>6&3)<<4)-32;r[f+p]=i*a.getInt8(d+m+0)*b,r[f+p+32]=i*a.getInt8(d+m+2)*g,r[f+p+64]=i*a.getInt8(d+m+4)*v,r[f+p+96]=i*a.getInt8(d+m+6)*w}}}return r}function na(e,t,r){if(e<4)return[t[r+e]&63,t[r+e+4]&63];let a=t[r+e+4]&15|t[r+e-4]>>6<<4,s=t[r+e+4]>>4|t[r+e-0]>>6<<4;return[a,s]}function ww(e){if(e.byteLength%vr!==0)throw new ae(`Q4_K byte length ${e.byteLength} is not a multiple of ${vr}`);let t=e.byteLength/vr,r=new Float32Array(t*hs),a=new DataView(e.buffer,e.byteOffset,e.byteLength);for(let s=0;s<t;++s){let n=s*vr,i=fe(a.getUint16(n,!0)),u=fe(a.getUint16(n+2,!0)),o=n+4,l=n+16,c=s*hs,d=0;for(let f=0;f<256;f+=64){let[p,m]=na(d+0,e,o),h=i*p,b=u*m,[g,v]=na(d+1,e,o),w=i*g,y=u*v;for(let q=0;q<32;++q)r[c++]=h*(e[l+q]&15)-b;for(let q=0;q<32;++q)r[c++]=w*(e[l+q]>>4)-y;l+=32,d+=2}}return r}function bw(e){if(e.byteLength%_r!==0)throw new ae(`Q5_K byte length ${e.byteLength} is not a multiple of ${_r}`);let t=e.byteLength/_r,r=new Float32Array(t*gs),a=new DataView(e.buffer,e.byteOffset,e.byteLength);for(let s=0;s<t;++s){let n=s*_r,i=fe(a.getUint16(n,!0)),u=fe(a.getUint16(n+2,!0)),o=n+4,l=n+16,c=n+48,d=s*gs,f=0,p=1,m=2;for(let h=0;h<256;h+=64){let[b,g]=na(f+0,e,o),v=i*b,w=u*g,[y,q]=na(f+1,e,o),k=i*y,D=u*q;for(let I=0;I<32;++I){let B=e[l+I]&p?16:0;r[d++]=v*((e[c+I]&15)+B)-w}for(let I=0;I<32;++I){let B=e[l+I]&m?16:0;r[d++]=k*((e[c+I]>>4)+B)-D}c+=32,f+=2,p<<=2,m<<=2}}return r}function vw(e){if(e.byteLength%84!==0)throw new ae(`Q2_K byte length ${e.byteLength} is not a multiple of 84`);let t=e.byteLength/84,r=new Float32Array(t*256),a=new DataView(e.buffer,e.byteOffset,e.byteLength);for(let s=0;s<t;++s){let n=s*84,i=fe(a.getUint16(n+80,!0)),u=fe(a.getUint16(n+82,!0)),o=s*256,l=n+16,c=0;for(let d=0;d<256;d+=128){let f=0;for(let p=0;p<4;++p){let m=e[n+c];c+=1;let h=i*(m&15),b=u*(m>>4);for(let g=0;g<16;++g)r[o++]=h*(e[l+g]>>f&3)-b;m=e[n+c],c+=1,h=i*(m&15),b=u*(m>>4);for(let g=0;g<16;++g)r[o++]=h*(e[l+g+16]>>f&3)-b;f+=2}l+=32}}return r}function _w(e){if(e.byteLength%110!==0)throw new ae(`Q3_K byte length ${e.byteLength} is not a multiple of 110`);let t=50529027,r=252645135,a=e.byteLength/110,s=new Float32Array(a*256),n=new DataView(e.buffer,e.byteOffset,e.byteLength),i=new Int32Array(16);for(let u=0;u<a;++u){let o=u*110,l=o,c=o+32,d=fe(n.getUint16(o+108,!0)),f=n.getUint32(o+96,!0)>>>0,p=n.getUint32(o+100,!0)>>>0,m=n.getUint32(o+104,!0)>>>0,h=[(f&r|(m>>>0&t)<<4)>>>0,(p&r|(m>>>2&t)<<4)>>>0,(f>>>4&r|(m>>>4&t)<<4)>>>0,(p>>>4&r|(m>>>6&t)<<4)>>>0];for(let y=0;y<4;++y)for(let q=0;q<4;++q){let k=h[y]>>>q*8&255;k>127&&(k-=256),i[y*4+q]=k-32}let b=u*256,g=c,v=1,w=0;for(let y=0;y<256;y+=128){let q=0;for(let k=0;k<4;++k){let D=d*i[w++];for(let I=0;I<16;++I){let B=e[l+I]&v?0:4;s[b++]=D*((e[g+I]>>q&3)-B)}D=d*i[w++];for(let I=0;I<16;++I){let B=e[l+I+16]&v?0:4;s[b++]=D*((e[g+I+16]>>q&3)-B)}q+=2,v<<=1}g+=32}}return s}var o2=Int8Array.from([-127,-104,-83,-65,-49,-35,-22,-10,1,13,25,38,53,69,89,113]),l2=Int8Array.from([0,1,2,3,4,6,8,12,0,-1,-2,-3,-4,-6,-8,-12]),c2=new DataView(new ArrayBuffer(4)),yw=new Set([S.Q2_0,S.TQ1_0,S.IQ2_XXS,S.IQ2_XS,S.IQ2_S,S.IQ3_XXS,S.IQ3_S,S.TQ2_0,S.IQ1_S,S.IQ1_M]);function ju(e){return yw.has(e)}function kw(e,t){let r=new DataView(t.buffer,t.byteOffset,t.byteLength);switch(e){case S.Q2_0:return a=>{let s=fe(r.getUint16((a>>1)*Tu,!0));return[s,s]};case S.TQ1_0:return a=>{let s=fe(r.getUint16((a>>3)*Iu+52,!0));return[s,s]};case S.IQ2_XXS:return a=>{let s=a>>3,n=a&7,i=s*66,u=fe(r.getUint16(i,!0)),o=r.getUint32(i+2+8*n+4,!0)>>>0,l=u*(.5+(o>>>28))*.25;return[l,l]};case S.IQ2_XS:case S.IQ2_S:{let a=e===S.IQ2_XS?74:82,s=e===S.IQ2_XS?66:74;return n=>{let i=n>>3,u=n&7,o=i*a,l=fe(r.getUint16(o,!0)),c=t[o+s+u];return[l*(.5+(c&15))*.25,l*(.5+(c>>4))*.25]}}case S.IQ3_XXS:return a=>{let s=a>>3,n=a&7,i=s*98,u=fe(r.getUint16(i,!0)),o=r.getUint32(i+2+64+4*n,!0)>>>0,l=u*(.5+(o>>>28))*.5;return[l,l]};case S.IQ3_S:return a=>{let s=a>>3,n=a&7,i=s*110,u=fe(r.getUint16(i,!0)),o=t[i+106+(n>>1)],l=(n&1)===0?u*(1+2*(o&15)):u*(1+2*(o>>4));return[l,l]};case S.TQ2_0:return a=>{let s=fe(r.getUint16((a>>3)*66+64,!0));return[s,s]};case S.IQ1_S:return a=>{let s=a>>3,n=a&7,i=s*Au,u=fe(r.getUint16(i,!0)),o=r.getUint16(i+34+2*n,!0),l=u*(2*(o>>12&7)+1)/8;return[l,l]};case S.IQ1_M:return a=>{let s=a>>3,n=a&7,i=s*Bu+48,u=[r.getUint16(i,!0),r.getUint16(i+2,!0),r.getUint16(i+4,!0),r.getUint16(i+6,!0)],o=fe((u[0]>>12|u[1]>>8&240|u[2]>>4&3840|u[3]&61440)&65535),l=o*(2*(u[n>>1]>>6*(n%2)+0&7)+1),c=o*(2*(u[n>>1]>>6*(n%2)+3&7)+1);return[l/8,c/8]};default:throw new ae(`iqBlockScales: type ${e} is not an exact-repack IQ type`)}}var xw={10:vw,11:_w,12:ww,13:bw,14:gw},Mu=new Set([2,3,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,29,34,35,39,40,41,42]);qe();var Sw=1179993927,qw=32,Ew=new TextDecoder("utf-8",{fatal:!0}),Ee=Object.freeze({UINT8:0,INT8:1,UINT16:2,INT16:3,UINT32:4,INT32:5,FLOAT32:6,BOOL:7,STRING:8,ARRAY:9,UINT64:10,INT64:11,FLOAT64:12});function _e(e){return typeof e=="number"?e:void 0}function Tw(e){if(typeof e=="number"||Array.isArray(e)&&e.every(t=>typeof t=="number"))return e}function Du(e){let t=[];for(let r of["tokenizer.ggml.eos_token_id","tokenizer.ggml.eot_token_id"]){let a=Tw(e[r]);for(let s of typeof a=="number"?[a]:a??[])t.includes(s)||t.push(s)}return t}function Iw(e){if(e.has("token_embd.weight")){let r=e.info("token_embd.weight").shape[0];if(Number.isInteger(r)&&r>0)return r}let t=e.metadata["tokenizer.ggml.tokens"];if(Array.isArray(t)&&t.length>0)return t.length}var yr=class{#e;#t;version;tensorCount;metadataCount;metadata;alignment;dataStart;constructor(e,t={}){this.#e=Cw(e);let r=new Pw(this.#e);if(r.u32()!==Sw)throw new ae("Invalid GGUF magic");this.version=r.u32(),this.tensorCount=yt(r.u64(),"tensor count"),this.metadataCount=yt(r.u64(),"metadata count"),this.metadata={};for(let n=0;n<this.metadataCount;++n){let i=r.string();this.metadata[i]=r.metadataValue()}let a=new Map;for(let n=0;n<this.tensorCount;++n){let i=r.string(),u=Array.from({length:r.u32()},()=>yt(r.u64(),`${i} dimension`)),o=r.u32(),l=yt(r.u64(),`${i} offset`),c=u.reduce((d,f)=>d*f,1);a.set(i,{name:i,dims:u,shape:[...u].reverse(),type:o,typeName:Ot[o]??`UNKNOWN_${o}`,offset:l,elementCount:c,byteLength:sa(o,c),dataOffsets:[0,0]})}let s=this.metadata["general.alignment"]??qw;if(typeof s!="number"||!Number.isInteger(s)||s<=0)throw new ae(`Invalid general.alignment: ${s}`);if(this.alignment=s,this.dataStart=Tr(r.offset,s),!t.headerOnly){if(this.dataStart>this.#e.byteLength)throw new ae("GGUF header exceeds file size");for(let n of a.values()){let i=this.dataStart+n.offset,u=i+n.byteLength;if(u>this.#e.byteLength)throw new ae(`Tensor ${n.name} exceeds file size`);n.dataOffsets=[i,u]}}this.#t=a}names(){return[...this.#t.keys()]}has(e){return this.#t.has(e)}info(e){return $w(this.#r(e))}tensorBytes(e){let t=this.#r(e),[r,a]=t.dataOffsets;return this.#e.subarray(r,a)}tensorByteRange(e,t,r){let[a]=this.#r(e).dataOffsets;return this.#e.subarray(a+t,a+r)}async streamTensorRange(e,t,r,a,s={}){let n=this.#r(e);Fw(n,t,r),Fu(s.signal);let[i]=n.dataOffsets;await a(this.#e.subarray(i+t,i+r)),Fu(s.signal)}async streamTensors(e,t){for(let r of e)await t(r,this.tensorBytes(r))}#r(e){let t=this.#t.get(e);if(!t)throw new ae(`Unknown tensor: ${e}`);return t}};function Aw(e,t){if(!ju(e))throw new ae(`repackIQToExactInt8: type ${e} is not an exact-repack IQ type`);let r=ws(e,t),a=r.length/32,s=kw(e,t),n=new Uint32Array(a*8),i=new Float32Array(a*2);for(let u=0;u<a;++u){let[o,l]=s(u);i[u*2]=o,i[u*2+1]=l;for(let c=0;c<8;++c){let d=c<4?o:l,f=0;for(let p=0;p<4;++p){let m=u*32+c*4+p,h=d!==0?Math.round(r[m]/d):0;h>127?h=127:h<-127&&(h=-127),f|=(h&255)<<p*8}n[u*8+c]=f>>>0}}return{bits:n,scales:i}}function ws(e,t){let r=xw[e];if(r)return r(t);if(Mu.has(e))throw new ae(`CPU dequantizer for ${Ot[e]??e} is not in this bundle (built for the shipped model's weight formats — load that model's own GGUF, or rebuild)`);return Bw(e)?jw(e,t):null}function Bw(e){return e===S.I8||e===S.I16||e===S.I32||e===S.I64||e===S.F64}function jw(e,t){let r=e===S.I8?1:e===S.I16?2:e===S.I32?4:8;if(t.byteLength%r!==0)throw new ae(`${Ot[e]} byte length ${t.byteLength} is not divisible by ${r}`);let a=new Float32Array(t.byteLength/r),s=new DataView(t.buffer,t.byteOffset,t.byteLength);for(let n=0;n<a.length;++n){let i=n*r;e===S.I8?a[n]=s.getInt8(i):e===S.I16?a[n]=s.getInt16(i,!0):e===S.I32?a[n]=s.getInt32(i,!0):e===S.I64?a[n]=Number(s.getBigInt64(i,!0)):a[n]=s.getFloat64(i,!0)}return a}function Mw(e){return Mu.has(e)}function Dw(e){if(e===S.F32)return"F32";if(e===S.F16)return"F16";if(e===S.BF16)return"BF16";throw new ae(`Unsupported GGUF scalar type ${Ot[e]??e}; quantized types dequantize separately`)}function $u(e,t){return ws(e,t)??Rg(Dw(e),t)}function $w(e){return{name:e.name,dims:[...e.dims],shape:[...e.shape],type:e.type,typeName:e.typeName,offset:e.offset,elementCount:e.elementCount,byteLength:e.byteLength,dataOffsets:[...e.dataOffsets]}}function Fw(e,t,r){if(!Number.isSafeInteger(t)||!Number.isSafeInteger(r)||t<0||r<t)throw new RangeError(`Invalid byte range [${t}, ${r}) for tensor ${e.name}`);if(r>e.byteLength)throw new RangeError(`Byte range [${t}, ${r}) exceeds tensor ${e.name} size ${e.byteLength}`)}function Fu(e){if(e?.aborted)throw e.reason??new Error("aborted")}var Pw=class{bytes;view;offset;constructor(e){this.bytes=e,this.view=new DataView(e.buffer,e.byteOffset,e.byteLength),this.offset=0}u8(){this.#t(1);let e=this.view.getUint8(this.offset);return this.offset+=1,e}i8(){this.#t(1);let e=this.view.getInt8(this.offset);return this.offset+=1,e}u16(){this.#t(2);let e=this.view.getUint16(this.offset,!0);return this.offset+=2,e}i16(){this.#t(2);let e=this.view.getInt16(this.offset,!0);return this.offset+=2,e}u32(){this.#t(4);let e=this.view.getUint32(this.offset,!0);return this.offset+=4,e}i32(){this.#t(4);let e=this.view.getInt32(this.offset,!0);return this.offset+=4,e}u64(){this.#t(8);let e=this.view.getBigUint64(this.offset,!0);return this.offset+=8,e}i64(){this.#t(8);let e=this.view.getBigInt64(this.offset,!0);return this.offset+=8,e}f32(){this.#t(4);let e=this.view.getFloat32(this.offset,!0);return this.offset+=4,e}f64(){this.#t(8);let e=this.view.getFloat64(this.offset,!0);return this.offset+=8,e}string(){let e=yt(this.u64(),"string length");this.#t(e);let t=this.bytes.subarray(this.offset,this.offset+e);return this.offset+=e,Ew.decode(t)}metadataValue(){let e=this.u32();return this.#e(e)}#e(e){switch(e){case Ee.UINT8:return this.u8();case Ee.INT8:return this.i8();case Ee.UINT16:return this.u16();case Ee.INT16:return this.i16();case Ee.UINT32:return this.u32();case Ee.INT32:return this.i32();case Ee.FLOAT32:return this.f32();case Ee.BOOL:return!!this.u8();case Ee.STRING:return this.string();case Ee.UINT64:return yt(this.u64(),"metadata uint64");case Ee.INT64:return Lw(this.i64(),"metadata int64");case Ee.FLOAT64:return this.f64();case Ee.ARRAY:{let t=this.u32();if(t===Ee.ARRAY)throw new ae("Nested metadata arrays are not supported");let r=yt(this.u64(),"metadata array length");return Array.from({length:r},()=>this.#e(t))}default:throw new ae(`Unsupported GGUF metadata type ${e}`)}}#t(e){if(this.offset+e>this.bytes.byteLength)throw new ae("Unexpected end of GGUF file")}};function Cw(e){if(e instanceof Uint8Array)return e;if(ArrayBuffer.isView(e))return new Uint8Array(e.buffer,e.byteOffset,e.byteLength);if(e instanceof ArrayBuffer)return new Uint8Array(e);throw new ae("GGUF input must be an ArrayBuffer or Uint8Array")}function yt(e,t){if(e>BigInt(Number.MAX_SAFE_INTEGER))throw new ae(`${t} ${e} exceeds JavaScript safe integer range`);return Number(e)}function Lw(e,t){if(e>BigInt(Number.MAX_SAFE_INTEGER)||e<BigInt(Number.MIN_SAFE_INTEGER))throw new ae(`${t} ${e} exceeds JavaScript safe integer range`);return Number(e)}var Nt=class extends Error{constructor(e){super(e),this.name="DirectByteReadUnavailableError"}};async function Pu(e,t,r){let a=null;try{a=await t(e,{method:"HEAD",signal:r})}catch{}if(a?.ok){let n=a.headers.get("content-length"),i=n===null?null:Number(n);if(n!==null&&!Number.isFinite(i))throw new Error(`Invalid content-length header: ${n}`);return{size:i,acceptsRanges:(a.headers.get("accept-ranges")??"").toLowerCase().includes("bytes")}}let s=await t(e,{headers:{Range:"bytes=0-0"},signal:r});if(s.status===206){await s.arrayBuffer();let n=Number(s.headers.get("content-range")?.split("/").pop());return{size:Number.isFinite(n)?n:null,acceptsRanges:!0}}if(s.ok){await s.body?.cancel().catch(()=>{});let n=s.headers.get("content-length"),i=n===null?null:Number(n);return{size:Number.isFinite(i??NaN)?i:null,acceptsRanges:!1}}throw new Error(`HEAD ${e} failed${a?` (${a.status} ${a.statusText})`:""} and the range probe returned ${s.status}`)}async function Cu(e,t={}){let r=t.fetch??((n,i)=>fetch(n,i)),a=AbortSignal.timeout(t.timeoutMs??4e3),s=t.signal?AbortSignal.any([t.signal,a]):a;try{let{size:n}=await Pu(e,r,s);return n}catch{return null}}async function Lu(e,t,{requireRangeRequests:r=!1,knownSize:a=void 0,knownAcceptsRanges:s=void 0}={}){let n=t.fetch??globalThis.fetch;if(typeof n!="function")throw new Error("No fetch implementation available; pass options.fetch");let i=a,u=s;if(i===void 0){let c=await Pu(e,n,t.signal);i=c.size,u=c.acceptsRanges}else u=u!==!1;if(r&&!u)throw new Error(`Range requests are required for ${e}, but the server did not advertise Accept-Ranges: bytes`);let o=!0,l={url:e,size:i??null,acceptsRanges:u,writeTensorAcceptsEphemeralBytes:!0,async readRange(c,d,f={}){if(c===d)return new Uint8Array(0);Nu(c,d);let p=f.signal??t.signal,m=f.onByteProgress??null;if(u){let b=await n(e,{headers:{Range:`bytes=${c}-${d-1}`},signal:p});if(b.status!==206&&b.status!==200)throw new Error(`Range ${c}-${d-1} of ${e} failed: ${b.status}`);if(b.status===200&&r)throw new Error(`Range ${c}-${d-1} of ${e} returned 200 instead of 206; refusing full-response fallback`);let g=await bs(b,{expectedLength:b.status===206?d-c:null,onByteProgress:b.status===200?Ou(c,d,m):m});if(b.status===200)return g.subarray(c,d);if(g.byteLength!==d-c)throw new Error(`Range ${c}-${d-1} returned ${g.byteLength} bytes`);return g}let h=await n(e,{signal:p});if(!h.ok)throw new Error(`GET ${e} failed: ${h.status}`);return(await bs(h,{onByteProgress:Ou(c,d,m)})).subarray(c,d)},async readRangeInto(c,d,f,p={}){if(Ow(c,d,f),f.byteLength===0)return;let m=p.signal??t.signal,h=p.onByteProgress??null;if(pt(m),!o)throw new Nt("Direct response-body reads were disabled after a non-streaming response");try{if(u){let g=await n(e,{headers:{Range:`bytes=${c}-${d-1}`},signal:m});if(g.status!==206&&g.status!==200)throw new Error(`Range ${c}-${d-1} of ${e} failed: ${g.status}`);if(g.status===200){if(r)throw await vs(g),new Error(`Range ${c}-${d-1} of ${e} returned 200 instead of 206; refusing full-response fallback`);await zu(g,c,d,f,{signal:m,onByteProgress:h});return}await zw(g,f,{signal:m,onByteProgress:h});return}let b=await n(e,{signal:m});if(!b.ok)throw new Error(`GET ${e} failed: ${b.status}`);await zu(b,c,d,f,{signal:m,onByteProgress:h})}catch(b){throw b instanceof Nt&&(o=!1,delete l.readRangeInto),b}},async readAll(c={}){let d=c.signal??t.signal,f=c.onProgress??t.onProgress,p=await n(e,{signal:d});if(!p.ok)throw new Error(`GET ${e} failed: ${p.status}`);return bs(p,{expectedLength:Number.isFinite(i)?i:null,onProgress:f,progressTotal:Number.isFinite(i)?i:null,fromCache:!1})},async readTensor(){return null},async writeTensor(){},async close(){}};return l}async function bs(e,{expectedLength:t=null,onByteProgress:r=null,onProgress:a=null,progressTotal:s=null,fromCache:n=!1,yieldEveryBytes:i=null}={}){if(!e.body?.getReader){let f=await e.arrayBuffer(),p=new Uint8Array(f);return ys({onByteProgress:r,onProgress:a,loaded:p.byteLength,delta:p.byteLength,total:s??t,fromCache:n}),p}let u=e.body.getReader(),o=s??t??null,l=0;if(typeof t=="number"&&Number.isFinite(t)&&t>0){let f=new Uint8Array(t),p=[],m=0;for(;;){let{done:h,value:b}=await u.read();if(h)break;b&&(l+b.byteLength<=f.byteLength&&p.length===0?f.set(b,l):(p.length===0&&p.push(f.subarray(0,l)),p.push(b)),l+=b.byteLength,ys({onByteProgress:r,onProgress:a,loaded:l,delta:b.byteLength,total:o,fromCache:n}),i&&(m+=b.byteLength)>=i&&(m=0,await _s()))}return p.length===0?l===t?f:f.subarray(0,l):xu(p,l)}let c=[],d=0;for(;;){let{done:f,value:p}=await u.read();if(f)break;p&&(c.push(p),l+=p.byteLength,ys({onByteProgress:r,onProgress:a,loaded:l,delta:p.byteLength,total:o,fromCache:n}),i&&(d+=p.byteLength)>=i&&(d=0,await _s()))}return xu(c,l)}async function zw(e,t,{signal:r,onByteProgress:a=null}={}){if(pt(r),!e.body?.getReader)throw await vs(e),new Nt("Direct response-body reads require a streaming response body");let s=e.body.getReader(),n=0;try{for(;;){pt(r);let{done:i,value:u}=await s.read();if(pt(r),i)break;if(u){if(n+u.byteLength>t.byteLength)throw Wu(t.byteLength,n+u.byteLength);t.set(u,n),n+=u.byteLength,a?.(u.byteLength),pt(r)}}}catch(i){throw await s.cancel(i).catch(()=>{}),i}if(n!==t.byteLength)throw Wu(t.byteLength,n)}async function zu(e,t,r,a,{signal:s,onByteProgress:n=null}={}){if(pt(s),!e.body?.getReader)throw await vs(e),new Nt("Direct response-range reads require a streaming response body");let i=e.body.getReader(),u=0,o=0;try{for(;;){pt(s);let{done:l,value:c}=await i.read();if(pt(s),l)break;if(!c)continue;let d=u,f=u+c.byteLength,p=Math.max(t,d),m=Math.min(r,f);if(m>p){let h=p-d,b=m-p;a.set(c.subarray(h,h+b),p-t),o+=b,n?.(b)}u=f}}catch(l){throw await i.cancel(l).catch(()=>{}),l}if(o!==a.byteLength)throw new Error(`Full response has ${u} bytes; range [${t}, ${r}) is unavailable`)}function Ou(e,t,r){if(!r)return null;let a=0;return s=>{let n=a,i=a+s;a=i;let u=Math.max(0,Math.min(t,i)-Math.max(e,n));u>0&&r(u)}}async function vs(e){try{await e.body?.cancel()}catch{}}function _s(){return new Promise(e=>setTimeout(e,0))}function ys({onByteProgress:e,onProgress:t,loaded:r,delta:a,total:s,fromCache:n}){e?.(a),t?.({loaded:r,total:s??null,fromCache:n})}function Ow(e,t,r){Nu(e,t);let a=t-e;if(r.byteLength!==a)throw new RangeError(`Destination has ${r.byteLength} bytes; expected ${a} for range [${e}, ${t})`)}function Nu(e,t){if(!Number.isSafeInteger(e)||!Number.isSafeInteger(t)||e<0||t<e)throw new RangeError(`Invalid byte range [${e}, ${t})`)}function Wu(e,t){return new Error(`Response returned ${t} bytes; expected ${e}`)}function pt(e){if(e?.aborted)throw e.reason??new Error("aborted")}async function ks(e,t={},r={}){if(t.source)return t.source;if(typeof e=="string"&&/^https?:/i.test(e))return Lu(e,t,r);if(typeof e=="string"&&e.startsWith("file:"))return xs(new URL(e),t);if(e instanceof URL){if(e.protocol==="http:"||e.protocol==="https:")return Lu(e.toString(),t,r);if(e.protocol==="file:")return xs(e,t);throw new Error(`Unsupported URL protocol: ${e.protocol}`)}if(typeof e=="string")return xs(e,t);throw new Error("url must be a string or URL")}async function xs(e,t={}){let{open:r,stat:a}=await Promise.resolve().then(()=>(gn(),Ia)),s=e instanceof URL?(await Promise.resolve().then(()=>(nc(),wn))).fileURLToPath(e):e,n=await a(s),i=await r(s,"r"),u=async(o,l,c,d={})=>{Nw(o,l,c,n.size);let f=d.signal??t.signal,p=d.onProgress??t.onProgress,m=0;for(;m<c.byteLength;){Gu(f);let{bytesRead:h}=await i.read(c,m,c.byteLength-m,o+m);if(h===0)throw new Error(`Short read at ${o}: expected ${c.byteLength} bytes, got ${m}`);m+=h,d.onByteProgress?.(h),p?.({loaded:m,total:c.byteLength,fromCache:!1,range:[o,l],inFlight:m<c.byteLength})}Gu(f)};return{url:e.toString(),size:n.size,acceptsRanges:!0,writeTensorAcceptsEphemeralBytes:!0,async readRange(o,l,c={}){if(o===l)return new Uint8Array(0);let d=l-o,f=new Uint8Array(d);return await u(o,l,f,c),f},readRangeInto:u,async readAll(o={}){let l=o.onProgress??t.onProgress,c=new Uint8Array(n.size),d=0,f=1<<22;for(;d<n.size;){let p=Math.min(f,n.size-d),{bytesRead:m}=await i.read(c,d,p,d);if(m===0)break;d+=m,l?.({loaded:d,total:n.size,fromCache:!1})}if(d!==n.size)throw new Error(`Short read on ${s}: read ${d}/${n.size} bytes`);return c},async readTensor(){return null},async writeTensor(){},async close(){await i.close()}}}function Nw(e,t,r,a){if(!Number.isSafeInteger(e)||!Number.isSafeInteger(t)||e<0||t<e)throw new RangeError(`Invalid byte range [${e}, ${t})`);if(t>a)throw new RangeError(`Byte range [${e}, ${t}) exceeds source size ${a}`);let s=t-e;if(r.byteLength!==s)throw new RangeError(`Destination has ${r.byteLength} bytes; expected ${s} for range [${e}, ${t})`)}function Gu(e){if(e?.aborted)throw e.reason??new Error("aborted")}async function Ww(e,t,r=""){let a=e.cacheStorage??globalThis.caches;return a?.open?a.open((e.cacheName??t)+r):null}var Gw="gguf-v1";async function Rw(e,t={}){let r=Hw(e),a=await Vw(r,t);if(a)return a;let s=await ks(e,{fetch:t.fetch,signal:t.signal});try{let{gguf:n,bytes:i}=await Ru(s,t.signal);return await Qw(r,i,t,s.size??null),n}finally{await s.close()}}async function Ru(e,t){if(!e.acceptsRanges||!e.readRange){if(!e.readAll)throw new Error(`GGUF source ${e.url} supports neither ranges nor readAll()`);let i=await e.readAll({signal:t});return{gguf:new yr(i,{headerOnly:!0}),bytes:i}}let r=64*1024*1024,a=e.size,s=/^https?:/i.test(String(e.url)),n=!s&&a!=null&&a>=1024*1024*1024;for(let i=n?16*1024*1024:4*1024*1024;;i=s?i*2:r){let u=a!=null&&i>=a,o=a!=null?Math.min(i,a):i,l=await e.readRange(0,o,{signal:t});try{return{gguf:new yr(l,{headerOnly:!0}),bytes:l}}catch(c){if(u||l.byteLength<o||i>=r)throw c}}}function Hw(e){return e instanceof URL?e.toString():String(e)}var Uw="-headers";async function Hu(e){return Ww(e,Gw,Uw)}async function Vw(e,t){if(t.force||t.cache===!1)return null;let r=await Hu(t);if(!r)return null;let a=await r.match(e);if(!a)return null;let s=Number(a.headers.get("x-gguf-source-size")),n=Number.isFinite(s)?await Cu(e,{fetch:t.fetch,signal:t.signal}):void 0;if(n===void 0||n!==null&&n!==s)return await r.delete(e).catch(()=>{}),null;try{return new yr(new Uint8Array(await a.arrayBuffer()),{headerOnly:!0})}catch{return null}}async function Qw(e,t,r,a){if(r.cache===!1||t.byteLength>32*1024*1024)return;let s=await Hu(r);if(!s)return;let n=new Response(ku(t),{headers:{"content-type":"application/octet-stream","content-length":String(t.byteLength),...a!==null&&Number.isFinite(a)?{"x-gguf-source-size":String(a)}:{}}});try{await s.put(e,n)}catch(i){typeof console<"u"&&console.warn(`gguf header cache write failed: ${gr(i)}`)}}var tt="chunks",mt="meta";function Uu(e,{cache:t,cacheKey:r=e.url,force:a=!1}){let s={...e,writeTensorAcceptsEphemeralBytes:t.acceptsEphemeralBytes===!0?!0:void 0,async readTensor(n,i){if(a)return null;try{return await t.get(r,n,i)}catch(u){return typeof console<"u"&&console.warn(`byte-range cache read failed: ${gr(u)}`),null}},async writeTensor(n,i,u){try{let o=u.byteOffset===0&&u.byteLength===u.buffer.byteLength?u:new Uint8Array(u);await t.put(r,n,i,o)}catch(o){typeof console<"u"&&console.warn(`byte-range cache write failed: ${gr(o)}`)}}};return e.readRangeInto?s.readRangeInto=async(n,i,u,o)=>{let l=e.readRangeInto;if(!l)throw delete s.readRangeInto,new Nt("The wrapped source disabled direct response-body reads");try{await l.call(e,n,i,u,o)}finally{e.readRangeInto||delete s.readRangeInto}}:delete s.readRangeInto,s}async function Kw(e,t,r,a,s={}){let n=typeof r=="string"?r:r.toString();if(!/^https?:/i.test(n))return!1;let i=await Cu(n,s);if(i===null||i===a)return!1;try{await e.delete?.(t)}catch(u){typeof console<"u"&&console.warn(`stale byte-range cache purge failed: ${gr(u)}`)}return!0}var Vu=new Map;function Xw(e,t,r){let a=0,s=e.length-1,n=-1;for(;a<=s;){let i=a+s>>1;e[i][0]<=t?(n=i,a=i+1):s=i-1}return n>=0&&e[n][1]>=r?e[n]:null}function Yw(e){if(typeof indexedDB>"u")return null;let t=new Map,r=null,a=async(n,i,u,o)=>new Promise((l,c)=>{let d=n.transaction(tt,"readonly").objectStore(tt).get([i,u,o]);d.onsuccess=async()=>{let f=d.result;l(f?new Uint8Array(await f.arrayBuffer()):null)},d.onerror=()=>c(d.error)}),s=(n,i)=>{let u=t.get(i);return u||(u=new Promise((o,l)=>{let c=n.transaction(tt,"readonly").objectStore(tt).getAllKeys(IDBKeyRange.bound([i],[i,[],[]]));c.onsuccess=()=>o(c.result.map(([,d,f])=>[d,f]).sort((d,f)=>d[0]-f[0])),c.onerror=()=>l(c.error)}),t.set(i,u)),u};return{acceptsEphemeralBytes:!0,async get(n,i,u){let o=await kr(e),l=await a(o,n,i,u);if(l)return l;if(r&&r.key===n&&r.begin<=i&&u<=r.end)return r.bytes.subarray(i-r.begin,u-r.begin);let c=Xw(await s(o,n),i,u);if(!c)return null;let d=await a(o,n,c[0],c[1]);return d?(r={key:n,begin:c[0],end:c[1],bytes:d},d.subarray(i-c[0],u-c[0])):null},async put(n,i,u,o){let l=await kr(e);return t.delete(n),new Promise((c,d)=>{let f=l.transaction(tt,"readwrite").objectStore(tt).put(new Blob([ku(o)]),[n,i,u]);f.onsuccess=()=>c(),f.onerror=()=>d(f.error)})},async getMeta(n){let i=await kr(e);return new Promise((u,o)=>{let l=i.transaction(mt,"readonly").objectStore(mt).get(n);l.onsuccess=()=>u(l.result??null),l.onerror=()=>o(l.error)})},async putMeta(n,i){let u=await kr(e);return new Promise((o,l)=>{let c=u.transaction(mt,"readwrite").objectStore(mt).put(i,n);c.onsuccess=()=>o(),c.onerror=()=>l(c.error)})},async delete(n){let i=await kr(e);t.delete(n),r?.key===n&&(r=null);let u=IDBKeyRange.bound([n],[n,[],[]]);return await new Promise((o,l)=>{let c=i.transaction(tt,"readwrite").objectStore(tt).delete(u);c.onsuccess=()=>o(),c.onerror=()=>l(c.error)}),new Promise((o,l)=>{let c=i.transaction(mt,"readwrite").objectStore(mt).delete(n);c.onsuccess=()=>o(),c.onerror=()=>l(c.error)})}}}function kr(e){let t=Vu.get(e);if(t)return t;let r=new Promise((a,s)=>{let n=indexedDB.open(e,2);n.onupgradeneeded=()=>{let i=n.result;i.objectStoreNames.contains(tt)||i.createObjectStore(tt),i.objectStoreNames.contains(mt)||i.createObjectStore(mt)},n.onsuccess=()=>a(n.result),n.onerror=()=>s(n.error),n.onblocked=()=>s(new Error("indexedDB open blocked"))});return Vu.set(e,r),r}async function Zw(e,t,r,a,s={}){try{let n=a(await e.getMeta(t));return n?await Kw(e,t,r,n.size,s)?null:n:null}catch(n){return typeof console<"u"&&console.warn(`byte-range meta cache read failed: ${gr(n)}`),null}}function Qu(e,{maxBytes:t,maxGap:r}){let a=[...e].sort((i,u)=>i.begin-u.begin),s=[],n=null;for(let i of a){if(!n){n={begin:i.begin,end:i.end,tensors:[i]};continue}let u=i.begin-n.end,o=i.end-n.begin;u<=r&&o<=t?(n.end=Math.max(n.end,i.end),n.tensors.push(i)):(s.push(n),n={begin:i.begin,end:i.end,tensors:[i]})}return n&&s.push(n),s}var Jw=24<<20,eb=1<<20,tb=96<<20,rb=32;async function Ku(e,t,r,{concurrency:a=rb,chunkMaxBytes:s=Jw,chunkMaxGap:n=eb,byteBudget:i=tb,signal:u,onProgress:o,onByteProgress:l,directDestinations:c}={}){if(t.length===0)return;let d=e.readRangeInto&&e.writeTensorAcceptsEphemeralBytes===!0&&c?.size?c:void 0,f=ab(t,{maxBytes:s,maxGap:n},d),p=f.reduce((v,w)=>v+(w.end-w.begin),0),m=0,h=new Map,b=(v={})=>{if(!o)return;let w=m;for(let y of h.values())w+=y;o({loaded:w,total:p,...v})},g=async v=>{let{begin:w,end:y,tensors:q}=f[v],k=y-w,D=q.length===1?q[0]:void 0,I=e.readRangeInto,B=D?.begin===w&&D.end===y&&I&&e.writeTensorAcceptsEphemeralBytes===!0?c?.get(D.name):void 0;if(B){let x=B();if(x){if(x.bytes.byteLength!==k)throw await Xu(x),new Error(`Direct destination for ${D.name} has ${x.bytes.byteLength} bytes; expected ${k}`);let _=!1;try{let T=await e.readTensor(w,y),M=T?.byteLength===k;Yu(u),M?(x.bytes.set(T),l?.(k),_=!0):(h.set(v,0),await I.call(e,w,y,x.bytes,{signal:u,onByteProgress:ie=>{h.set(v,(h.get(v)??0)+ie),l?.(ie),b({fromCache:!1,range:[w,y],inFlight:!0})}}),_=!0,await Promise.resolve().then(()=>e.writeTensor(w,y,x.bytes)).catch(()=>{})),Yu(u),await r({begin:w,end:y,bytes:x.bytes,tensors:q,directDestination:x}),h.delete(v),m+=k,b({fromCache:M,range:[w,y]});return}catch(T){if(await Xu(x),T instanceof Nt&&!_)h.delete(v);else throw T}}}let F=await sb(q.map(x=>Promise.resolve().then(()=>e.readTensor(x.begin,x.end)))),z=F.every((x,_)=>x!=null&&x.byteLength===q[_].end-q[_].begin),W;if(z){let x=q.length===1?q[0]:void 0,_=x?F[0]:void 0;if(x?.begin===w&&x.end===y&&_?.byteLength===k)W=_;else{W=new Uint8Array(k);for(let T=0;T<q.length;++T)W.set(F[T],q[T].begin-w)}l?.(k)}else h.set(v,0),W=await e.readRange(w,y,{signal:u,onByteProgress:x=>{h.set(v,(h.get(v)??0)+x),l?.(x),b({fromCache:!1,range:[w,y],inFlight:!0})}});let Y=Promise.resolve().then(()=>r({begin:w,end:y,bytes:W,tensors:q})),L=z?Promise.resolve():Promise.resolve().then(()=>e.writeTensor(w,y,W)).catch(()=>{}),N=!1,R,$=Y.catch(x=>{N=!0,R=x});if(await Promise.all([$,L]),N)throw R;h.delete(v),m+=k,b({fromCache:z,range:[w,y]})};await new Promise((v,w)=>{let y=0,q=0,k=0,D=f.length,I=!1,B=!1,F,z=new Set,W=()=>{},Y=()=>{I||!B||z.size!==0||(I=!0,W(),w(F))},L=$=>{B||(B=!0,F=$),Y()},N=($,x,_,T)=>{if(z.delete($),q--,k-=x,_){L(T);return}if(B){Y();return}if(--D===0){I=!0,W(),v();return}R()},R=()=>{if(!(I||B)){if(u?.aborted){L(u.reason??new Error("aborted"));return}for(;y<f.length&&q<a;){let $=f[y].end-f[y].begin;if(q>0&&k+$>i)break;let x=y++;q++,k+=$;let _=g(x);z.add(_),_.then(()=>N(_,$,!1),T=>N(_,$,!0,T))}}};if(u){let $=()=>L(u.reason??new Error("aborted"));u.aborted?$():(u.addEventListener("abort",$,{once:!0}),W=()=>{u.removeEventListener("abort",$)})}R()})}function ab(e,t,r){if(!r)return Qu(e,t);let a=[...e].sort((u,o)=>u.begin-o.begin),s=[],n=[],i=()=>{n.length!==0&&(s.push(...Qu(n,t)),n=[])};for(let u of a){if(!r.has(u.name)){n.push(u);continue}i(),s.push({begin:u.begin,end:u.end,tensors:[u]})}return i(),s}async function Xu(e){try{await e.abort()}catch{}}function Yu(e){if(e?.aborted)throw e.reason??new Error("aborted")}async function sb(e){let t=new Array(e.length),r=!1,a;if(await Promise.all(e.map((s,n)=>s.then(i=>{t[n]=i},i=>{r||(r=!0,a=i)}))),r)throw a;return t}var nb="gguf-cache-v1",ib=32<<20;function ub(e){let t=e;return t?.headerBytes&&Number.isFinite(t.size)?t:null}var Zu=class Gs{#e;#t;onByteProgress=null;constructor(t,r){this.#e=t,this.#t=r}get supportsDirectDestinations(){return this.#t.readRangeInto&&this.#t.writeTensorAcceptsEphemeralBytes===!0?!0:void 0}static async open(t,r={}){let a=r.cacheKey??(typeof t=="string"?t:t.toString()),s=r.cache===!1||r.source?null:r.chunkCache??Yw(r.cacheName??nb),n=!!r.force,i={source:r.source,fetch:r.fetch,signal:r.signal},u=s&&!n?await Zw(s,a,t,ub,{fetch:r.fetch,signal:r.signal}):null;if(s&&u){let l=new yr(u.headerBytes,{headerOnly:!0}),c=await ks(t,i,{knownSize:u.size,knownAcceptsRanges:u.acceptsRanges??!0});return new Gs(l,Uu(c,{cache:s,cacheKey:a,force:n}))}let o=await ks(t,i);try{let{gguf:l,bytes:c}=await Ru(o,r.signal);return s&&o.size!=null&&o.acceptsRanges&&c.byteLength<=ib&&s.putMeta(a,{size:o.size,headerBytes:c,acceptsRanges:o.acceptsRanges}).catch(()=>{}),new Gs(l,s?Uu(o,{cache:s,cacheKey:a,force:n}):o)}catch(l){throw await o.close(),l}}get metadata(){return this.#e.metadata}names(){return this.#e.names()}has(t){return this.#e.has(t)}info(t){return this.#e.info(t)}async tensorBytes(t,r={}){let a=this.#e.info(t),s=this.#e.dataStart+a.offset;return this.#r(s,s+a.byteLength,r.signal)}async tensorByteRange(t,r,a,s={}){let n=this.#e.dataStart+this.#e.info(t).offset;return this.#r(n+r,n+a,s.signal)}async streamTensorRange(t,r,a,s,n={}){let i=this.#e.info(t);ob(i,r,a);let u=this.#e.dataStart+i.offset,o=u+r,l=u+a;if(!Number.isSafeInteger(o)||!Number.isSafeInteger(l))throw new RangeError(`Absolute byte range for tensor ${t} is outside the safe integer range`);await Ku(this.#t,[{name:t,begin:o,end:l}],({bytes:c,directDestination:d})=>s(c,d),{signal:n.signal,onByteProgress:this.onByteProgress??void 0,directDestinations:n.directDestination?new Map([[t,n.directDestination]]):void 0})}async#r(t,r,a){let s=await this.#t.readTensor(t,r);if(s)return this.onByteProgress?.(s.byteLength),s;let n=await this.#t.readRange(t,r,{signal:a,onByteProgress:this.onByteProgress??void 0});return await this.#t.writeTensor(t,r,n),n}async streamTensors(t,r,a={}){let s=t.map(n=>{let i=this.#e.info(n),u=this.#e.dataStart+i.offset;return{name:n,begin:u,end:u+i.byteLength}});await Ku(this.#t,s,async n=>{for(let i of n.tensors)await r(i.name,n.bytes.subarray(i.begin-n.begin,i.end-n.begin),n.directDestination)},{concurrency:a.concurrency,chunkMaxBytes:a.chunkMaxBytes,chunkMaxGap:a.chunkMaxGap,byteBudget:a.byteBudget,signal:a.signal,onByteProgress:this.onByteProgress??void 0,directDestinations:a.directDestinations})}async close(){await this.#t.close()}};function ob(e,t,r){if(!Number.isSafeInteger(t)||!Number.isSafeInteger(r)||t<0||r<t)throw new RangeError(`Invalid byte range [${t}, ${r}) for tensor ${e.name}`);if(r>e.byteLength)throw new RangeError(`Byte range [${t}, ${r}) exceeds tensor ${e.name} size ${e.byteLength}`)}var lb="(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+",cb="(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+",db="[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]*[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?|[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]+[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n/]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+",fb=new Set(["llama3","llama-v3","llama-bpe","falcon3","falcon-h1","pixtral","midm-2.0","lfm2","jina-v5-nano"]),pb=new Set(["gpt-4o","llama4","kanana2","talkie","minimax-m2"]);function Ju(e){let t=e["tokenizer.ggml.pre"];return typeof t=="string"&&fb.has(t)}function eo(e){let t=e["tokenizer.ggml.pre"];return typeof t=="string"&&pb.has(t)}function Ss(e){return{type:"Sequence",pretokenizers:[{type:"Split",pattern:{Regex:e},behavior:"Isolated",invert:!1},{type:"ByteLevel",add_prefix_space:!1,trim_offsets:!1,use_regex:!1}]}}var mb=`{% for message in messages %}<|im_start|>{{ message['role'] }}
{{ message['content'] }}<|im_end|>
{% endfor %}{% if add_generation_prompt %}<|im_start|>assistant
{% endif %}`;function hb(e){let t=ao(e,"tokenizer.ggml.tokens"),r=e["tokenizer.ggml.merges"]??[],a={};if(t.forEach((i,u)=>{a[i]=u}),gb(e))return{version:"1.0",truncation:null,padding:null,added_tokens:qs(e,t),normalizer:{type:"Replace",pattern:{String:" "},content:"▁"},pre_tokenizer:{type:"Split",pattern:{String:" "},behavior:"MergedWithPrevious",invert:!1},post_processor:null,decoder:{type:"Sequence",decoders:[{type:"Replace",pattern:{String:"▁"},content:" "},{type:"ByteFallback"},{type:"Fuse"}]},model:{type:"BPE",dropout:null,unk_token:Wt(t,e["tokenizer.ggml.unknown_token_id"])??null,continuing_subword_prefix:null,end_of_word_suffix:null,fuse_unk:!0,byte_fallback:!0,ignore_merges:!1,vocab:a,merges:ro(r)}};let s=Ju(e),n=eo(e);return{version:"1.0",truncation:null,padding:null,added_tokens:qs(e,t),normalizer:s||n?null:{type:"NFC"},pre_tokenizer:bb(e),post_processor:_b(),decoder:vb(),model:{type:"BPE",dropout:null,unk_token:Wt(t,e["tokenizer.ggml.unknown_token_id"])??null,continuing_subword_prefix:null,end_of_word_suffix:null,fuse_unk:!1,byte_fallback:!!e["tokenizer.ggml.byte_fallback"],ignore_merges:s,vocab:a,merges:ro(r)}}}function gb(e){let t=e["tokenizer.ggml.model"];return typeof t!="string"?!1:t==="llama"||t==="spm"||t.startsWith("gemma")||t.startsWith("llama")}function wb(e){let t=ao(e,"tokenizer.ggml.tokens"),r=e["tokenizer.ggml.bos_token_id"],a=e["tokenizer.ggml.eos_token_id"],s=e["tokenizer.ggml.unknown_token_id"],n=e["tokenizer.ggml.padding_token_id"],i=Object.fromEntries(qs(e,t).map(u=>[u.id,{content:u.content,single_word:u.single_word,lstrip:u.lstrip,rstrip:u.rstrip,normalized:u.normalized,special:u.special}]));return{tokenizer_class:"Qwen2Tokenizer",model_max_length:yb(e)??e["general.context_length"]??32768,bos_token:Wt(t,r),eos_token:Wt(t,a),unk_token:Wt(t,s),pad_token:Wt(t,n),bos_token_id:Number.isInteger(r)?r:void 0,eos_token_id:Number.isInteger(a)?a:void 0,eos_token_ids:Du(e),unk_token_id:Number.isInteger(s)?s:void 0,pad_token_id:Number.isInteger(n)?n:void 0,chat_template:to(e,t),added_tokens_decoder:i}}function to(e,t=xb(e)){let r=e["tokenizer.chat_template"];if(typeof r=="string")return r;let a=e["tokenizer.ggml.chat_template"];return typeof a=="string"?a:t.includes("<|im_start|>")&&t.includes("<|im_end|>")?mb:null}function bb(e){let t=e["tokenizer.ggml.pre"];return t==="qwen2"||t==="qwen3"||e["general.architecture"]==="qwen3"?Ss(lb):Ju(e)?Ss(cb):eo(e)?Ss(db):{type:"ByteLevel",add_prefix_space:!1,trim_offsets:!0,use_regex:!0}}function vb(){return{type:"ByteLevel",add_prefix_space:!1,trim_offsets:!1,use_regex:!1}}function _b(){return{type:"ByteLevel",add_prefix_space:!1,trim_offsets:!1,use_regex:!1}}function qs(e,t){let r=Array.isArray(e["tokenizer.ggml.token_type"])?e["tokenizer.ggml.token_type"]:[],a=new Set;for(let s of[e["tokenizer.ggml.bos_token_id"],e["tokenizer.ggml.eos_token_id"],e["tokenizer.ggml.unknown_token_id"],e["tokenizer.ggml.padding_token_id"]])Number.isInteger(s)&&a.add(s);for(let s=0;s<r.length;++s)kb(r[s])&&a.add(s);return[...a].filter(s=>s>=0&&s<t.length).sort((s,n)=>s-n).map(s=>({id:s,content:t[s],single_word:!1,lstrip:!1,rstrip:!1,normalized:!1,special:!0}))}function yb(e){let t=e["general.architecture"];return typeof t=="string"?e[`${t}.context_length`]:void 0}function kb(e){return Number.isInteger(e)&&e!==1&&e!==6}function ro(e){return Array.isArray(e)?e.map(t=>Array.isArray(t)?t.join(" "):String(t)):[]}function Wt(e,t){return typeof t=="number"&&Number.isInteger(t)&&t>=0&&t<e.length?e[t]:void 0}function ao(e,t){let r=e[t];if(!Array.isArray(r)||r.some(a=>typeof a!="string"))throw new Error(`GGUF metadata ${t} must be a string array`);return r}function xb(e){let t=e["tokenizer.ggml.tokens"];return Array.isArray(t)&&t.every(r=>typeof r=="string")?t:[]}function so(e,t,r,a="main"){let s=t??e.defaultModelId;return s.toLowerCase().endsWith(".gguf")?!/^https?:/i.test(s)&&typeof location<"u"?new URL(s,location.href).href:s:Ac(s,{revision:a,file:r??e.defaultFile(s)})}function Sb(e){let t=e.metadata,r=wb(t),a=hb(t),s=new Am(a,r),n=typeof r.chat_template=="string"?r.chat_template:to(t);if(!n)throw new Error("GGUF metadata is missing a chat_template");let i=qb(r,s);return{tokenizer:s,chatTemplate:new ai(n),tokenizerConfig:r,eosTokenIds:i}}function qb(e,t){let r=new Set,a=e.eos_token_id;Mr(a)&&r.add(a);let s=e.eos_token_ids;if(Array.isArray(s))for(let n of s)Mr(n)&&r.add(n);if(typeof e.eos_token=="string"){let n=t.token_to_id(e.eos_token);Mr(n)&&r.add(n)}if(r.size===0)throw new Error("GGUF metadata has no eos token id");return[...r]}function Es(){return typeof requestAnimationFrame=="function"?new Promise(e=>requestAnimationFrame(()=>e())):new Promise(e=>setTimeout(e,0))}function Eb(e,t=null,r={}){return Kc(async a=>{let s=so(e,t,r.file,r.revision??"main"),n=await Rw(s,{fetch:Ln(r),signal:r.signal});return e.unsupportedReason(n,a)})}async function Tb(e,t,r=null,a={}){let s=a.onProgress??(()=>{}),n=so(e,r,a.file,a.revision??"main"),i=Ln(a);s({status:"init",message:"Requesting WebGPU device"});let u=a.runtime??await Lg(a.runtimeOptions??{}),o=!a.runtime;u.captureShaders=!0;let l=async()=>{};try{s({status:"init",message:"Checking device support"});let c=await Zu.open(n,{fetch:i,signal:a.signal,cache:a.cache,force:a.force,cacheName:a.cacheName});l=()=>c.close();let d=await e.unsupportedReason(c,u.device);if(d)throw new Error(d);s({status:"tokenizer",message:"Loading tokenizer"}),await Es();let{tokenizer:f,chatTemplate:p,tokenizerConfig:m,eosTokenIds:h}=Sb(c);await Es();let b=c.names().reduce((q,k)=>q+c.info(k).byteLength,0),g=0;c.onByteProgress=q=>{g+=q,s({status:"weights",kind:"bytes",loaded:g,total:b||null,fraction:b?Math.min(1,g/b):void 0,message:"Streaming weights"})};let v=await e.loadModel(u,c,q=>{!Mr(q.total)||q.total<=0||s({status:"weights",kind:"tensors",loaded:q.processed,total:q.total,message:"Uploading to GPU"})});await l();let w=e.createGenerationState(v,a.maxLength),y=t({runtime:u,ownsRuntime:o,model:v,tokenizer:f,chatTemplate:p,tokenizerConfig:m,eosTokenIds:h,generationState:w,defaultMaxNewTokens:e.defaultMaxNewTokens});return s({status:"weights",kind:"tensors",message:"Compiling kernels (warmup)"}),await Es(),await v.warmup(w.cache),a.decodePipelineDepth===void 0&&s({status:"weights",kind:"tensors",message:"Tuning decode pipeline"}),await y.tuneDecodePipeline({decodePipelineDepth:a.decodePipelineDepth}),s({status:"ready",message:"Ready",fraction:1}),y}catch(c){throw await l().catch(()=>{}),o&&await u.destroy(),c}}function no(){let e=globalThis.process;return typeof e=="object"&&e!==null?e:void 0}function ge(e){return no()?.env?.[e]}function Ib(){return!!no()?.versions?.node}function kt(e,t,r="Config"){let a=e[t];if(typeof a!="number"||!Number.isInteger(a)||a<=0)throw new Error(`${r}.${t} must be a positive integer`);return a}function Ab(e,t){return Array.from({length:e},(r,a)=>(e-1-a)%t===0?"full_attention":"sliding_attention")}var io=class{vocab_size;hidden_size;intermediate_size;num_hidden_layers;num_attention_heads;num_key_value_heads;head_dim;hidden_activation;max_position_embeddings;rms_norm_eps;post_norm_eps;rope_theta;sliding_window;layer_types;final_logit_softcapping;output_multiplier;tie_word_embeddings;eos_token_id;bos_token_id;pad_token_id;model_type;qDim;kvDim;attnScale;layerSpecs;constructor(e={}){this.vocab_size=kt(e,"vocab_size","MuseGlimmerConfig"),this.hidden_size=kt(e,"hidden_size","MuseGlimmerConfig"),this.intermediate_size=kt(e,"intermediate_size","MuseGlimmerConfig"),this.num_hidden_layers=kt(e,"num_hidden_layers","MuseGlimmerConfig"),this.num_attention_heads=kt(e,"num_attention_heads","MuseGlimmerConfig"),this.num_key_value_heads=e.num_key_value_heads??this.num_attention_heads,this.head_dim=e.head_dim??Math.floor(this.hidden_size/this.num_attention_heads),this.hidden_activation=e.hidden_activation??"silu",this.max_position_embeddings=kt(e,"max_position_embeddings","MuseGlimmerConfig"),this.rms_norm_eps=Number(e.rms_norm_eps??1e-5),this.post_norm_eps=Number(e.post_norm_eps??1e-8),this.rope_theta=Number(e.rope_theta??5e5),this.sliding_window=kt(e,"sliding_window","MuseGlimmerConfig"),this.layer_types=e.layer_types??Ab(this.num_hidden_layers,e.sliding_window_pattern??4),this.final_logit_softcapping=e.final_logit_softcapping??null,this.output_multiplier=Number(e.output_multiplier??1),this.tie_word_embeddings=!!e.tie_word_embeddings,this.eos_token_id=e.eos_token_id??null,this.bos_token_id=e.bos_token_id??null,this.pad_token_id=e.pad_token_id??null,this.model_type="muse_glimmer",this.qDim=this.num_attention_heads*this.head_dim,this.kvDim=this.num_key_value_heads*this.head_dim,this.attnScale=1/Math.sqrt(this.head_dim),this.layerSpecs=this.layer_types.map((t,r)=>({index:r,isSliding:t==="sliding_attention"})),this.validate(e)}validate(e){let t=(r,a)=>{if(r)throw new Error(`MuseGlimmerConfig: unsupported -- ${a}`)};t(this.hidden_activation!=="silu",`hidden_activation ${this.hidden_activation} (only silu)`),t(this.tie_word_embeddings,"tied word embeddings (Muse Glimmer ships a separate output.weight)"),t(this.layer_types.length!==this.num_hidden_layers,"layer_types length != num_hidden_layers");for(let r of this.layer_types)t(r!=="sliding_attention"&&r!=="full_attention",`layer type ${r}`);t(this.num_attention_heads%this.num_key_value_heads!==0,"heads not divisible by kv heads"),t(this.head_dim%2!==0,`head_dim ${this.head_dim} must be even for RoPE`),t(this.head_dim%4!==0,`head_dim ${this.head_dim} must be a multiple of 4 for the vec4 attention paths`),t(this.sliding_window<=0,"non-positive sliding_window"),t(this.hidden_size%32!==0,"hidden_size must be a multiple of 32 (block-quant GEMM contract)"),t(this.intermediate_size%32!==0,"intermediate_size must be a multiple of 32 (block-quant GEMM contract)"),t(this.final_logit_softcapping!==null&&!(this.final_logit_softcapping>0),`final_logit_softcapping ${this.final_logit_softcapping} (must be positive or absent)`),t(!(this.output_multiplier>0),`output_multiplier ${this.output_multiplier} (must be positive — a non-positive scale would reorder logits)`),t(e.sliding_window_pattern!==void 0&&e.sliding_window_pattern<1,`sliding_window_pattern ${e.sliding_window_pattern}`)}eosTokenIds(){return ed(this.eos_token_id)}},uo=Object.freeze(["muse_glimmer","muse-glimmer"]);function oo(e){let t=e.metadata,r=t["general.architecture"];if(typeof r!="string"||!uo.includes(r))throw new Error(`Expected one of ${uo.join(", ")} GGUF architecture, got ${String(r)}`);let a=o=>t[`${r}.${o}`],s=_e(a("block_count")),n=Du(t),i=a("attention.sliding_window_pattern"),u=Array.isArray(i)?i.map(o=>o?"sliding_attention":"full_attention"):void 0;return new io({vocab_size:_e(a("vocab_size"))??Iw(e),hidden_size:_e(a("embedding_length")),intermediate_size:_e(a("feed_forward_length")),num_hidden_layers:s,num_attention_heads:_e(a("attention.head_count")),num_key_value_heads:_e(a("attention.head_count_kv")),head_dim:_e(a("attention.key_length")),max_position_embeddings:_e(a("context_length")),rms_norm_eps:_e(a("attention.layer_norm_rms_epsilon")),rope_theta:_e(a("rope.freq_base_swa"))??_e(a("rope.freq_base")),sliding_window:_e(a("attention.sliding_window")),...typeof i=="number"?{sliding_window_pattern:i}:{},...u?{layer_types:u}:{},final_logit_softcapping:_e(a("final_logit_softcapping"))??null,output_multiplier:_e(a("logit_scale"))??1,tie_word_embeddings:!1,eos_token_id:n.length>0?n:null,bos_token_id:_e(t["tokenizer.ggml.bos_token_id"])??null,pad_token_id:_e(t["tokenizer.ggml.padding_token_id"])??null})}function Gt(e,t){if(e.length===1)throw e[0];if(e.length>1)throw new AggregateError(e,t)}function Bb(e,t,r){for(let a=t.length-1;a>=0;--a)try{r(t[a])}catch{}throw e}function jb(e,t,r){if(!Number.isInteger(t)||t<0)throw new Error(`cache advance expects a non-negative integer, got ${t}`);let a=e+t;if(a>r)throw new Error(`cache advance overflows maxLength ${r}: ${e} + ${t}`);return a}function Mb(e,t,r){if(!Number.isInteger(t)||t<0||t>r)throw new Error(`cache truncate expects an integer in [0, ${r}], got ${t}`);if(t>e)throw new Error(`cache truncate cannot extend length from ${e} to ${t}; use advance()`);return t}var Db=1024,ia=class Rs{maxLength;key;value;#e=0;#t=!1;constructor(t){this.maxLength=t.maxLength,this.key=t.key,this.value=t.value}static defaultCapacity(t){return Math.min(8192,t.max_position_embeddings)}static resolveCapacity(t,r={}){let a=Rs.defaultCapacity(t),s=r.minimumCapacity,n=typeof s=="number"&&Number.isSafeInteger(s)&&s>0?Math.min(a,Math.max(s,Math.min(Db,a))):a;return Yc(r,n)}static allocate(t,r,a){if(!Number.isSafeInteger(a)||a<1)throw new Error(`Muse Glimmer cache maxLength must be a positive integer, got ${a}`);let s=r.num_key_value_heads,n=r.head_dim,i=[],u=[],o=[],l=c=>{let d=t.empty("float32",[1,s,a,n],c);return o.push(d),d};try{for(let c=0;c<r.num_hidden_layers;++c)i.push(l(`muse-glimmer-cache-k-${c}`)),u.push(l(`muse-glimmer-cache-v-${c}`));return new Rs({maxLength:a,key:i,value:u})}catch(c){Bb(c,o,d=>d.destroy())}}get_seq_length(){return this.#e}advance(t){this.#e=jb(this.#e,t,this.maxLength)}truncate(t){this.#e=Mb(this.#e,t,this.maxLength)}reset(){this.truncate(0)}dispose(){if(this.#t)return;this.#t=!0;let t=[];for(let r of[...this.key,...this.value])try{r.destroy()}catch(a){t.push(a)}Gt(t,"Muse Glimmer cache disposal failed")}},d2=64*1024;qe();function lo(e){return e.replace(/[ \t]*\/\/.*$/gm,"").replace(/\n{2,}/g,`
`).trim()}function co(e,t,r,a,s,n,i,u,o,l=[0,0]){if(u&&t.metadataStorage==="uint32")throw new Error(`transcode ${t.id} requires uint32 metadata storage`);if(u&&t.supportsF16Scales===!1)throw new Error(`transcode ${t.id} requires float32 scale storage`);let c=Math.ceil(i/t.workgroupSize),d=e.device.limits.maxComputeWorkgroupsPerDimension,f=e.createUniformU32([i,n,l[0],l[1]],`${t.id}-params`),p=[{tensor:r,type:"read-only-storage",binding:0},{tensor:a,type:"storage",binding:1},{tensor:s,type:"storage",binding:2},{buffer:f,type:"uniform",binding:3}];o&&p.push({tensor:o,type:"read-only-storage",binding:4});let m={name:`com.xenova.transcode.${t.id}`,source:t.buildWgsl(u),entryPoint:"main",cacheKey:`com.xenova.transcode:${t.id}:${t.metadataStorage==="uint32"?"u32":u?"f16":"f32"}`,bindings:p,dispatchWorkgroups:[Math.min(c,d),Math.ceil(c/d),1]},h=!1;return{program:m,release(){h||(h=!0,f.destroy?.())}}}async function $b(e,t){if(t.length!==0)try{await e.runProgramSequence(t.map(r=>r.program))}finally{for(let r of t)r.release()}}function fo(e,t,r){return t.grid?Fb(e,t.grid,r):void 0}function Fb(e,t,r){let a=r.get(t.name);if(!a){let s=new Uint8Array(Math.ceil(t.data.byteLength/4)*4);s.set(t.data),a=e.tensorFromTypedArray("uint32",[s.byteLength/4],new Uint32Array(s.buffer)),r.set(t.name,a)}return a}var Pb=class{#e=[];track(e){this.#e.push(e)}destroyAll(){for(let e of this.#e)e.destroy();this.#e.length=0}};function Cb(e,t,r,a,s,n,i,u,o,l,c=[0,0]){if(!t)throw new Error("transcode kernel for this weight format is not in this bundle (built for the shipped model's weight formats — load that model's own GGUF, or rebuild)");let d=r.byteLength%4===0&&r.byteOffset%4===0,f;if(d)f=new Uint32Array(r.buffer,r.byteOffset,r.byteLength/4);else{let h=new Uint8Array(Math.ceil(r.byteLength/4)*4);h.set(r),f=new Uint32Array(h.buffer)}let p=e.tensorFromTypedArray("uint32",[f.length],f);l?.track(p);let m=fo(e,t,o);return co(e,t,p,a,s,n,i,u,m,c)}var ce={Q2_KN:{id:"q2_k_to_q2k",workgroupSize:64,buildWgsl:e=>e?`enable f16;
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f16>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = f16(v); }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let base = (bi / 8u) * 84u;
  let j = bi % 8u;
  let og = (ob / 8u) * 20u;
  for (var p = 0u; p < 2u; p = p + 1u) {
    var cw = 0u;
    for (var k = 0u; k < 4u; k = k + 1u) {
      for (var w = 0u; w < 4u; w = w + 1u) {
        let e = 16u * (2u * j + p) + 4u * w + k;
        let q = (gbyte(base + 16u + 32u * (e >> 7u) + (e & 31u)) >> (2u * ((e >> 5u) & 3u))) & 3u;
        cw = cw | (q << (8u * k + 2u * w));
      }
    }
    out_bits[og + 2u * j + p] = cw;
  }
  if (j < 4u) { out_bits[og + 16u + j] = word32at(base + 4u * j); }
  if (j == 0u) { ss((ob / 8u) * 2u, f16at(base + 80u)); ss((ob / 8u) * 2u + 1u, f16at(base + 82u)); }
}`:`@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f32>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = v; }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let base = (bi / 8u) * 84u;
  let j = bi % 8u;
  let og = (ob / 8u) * 20u;
  for (var p = 0u; p < 2u; p = p + 1u) {
    var cw = 0u;
    for (var k = 0u; k < 4u; k = k + 1u) {
      for (var w = 0u; w < 4u; w = w + 1u) {
        let e = 16u * (2u * j + p) + 4u * w + k;
        let q = (gbyte(base + 16u + 32u * (e >> 7u) + (e & 31u)) >> (2u * ((e >> 5u) & 3u))) & 3u;
        cw = cw | (q << (8u * k + 2u * w));
      }
    }
    out_bits[og + 2u * j + p] = cw;
  }
  if (j < 4u) { out_bits[og + 16u + j] = word32at(base + 4u * j); }
  if (j == 0u) { ss((ob / 8u) * 2u, f16at(base + 80u)); ss((ob / 8u) * 2u + 1u, f16at(base + 82u)); }
}`},Q3_KN:{id:"q3_k_to_q3k",workgroupSize:64,buildWgsl:e=>e?`enable f16;
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f16>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = f16(v); }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let j = bi % 8u; let base = sb * 110u;
  let og = (ob / 8u) * 28u;
  var hw = 0u;
  for (var p = 0u; p < 2u; p = p + 1u) {
    var cw = 0u;
    for (var k = 0u; k < 4u; k = k + 1u) {
      for (var w = 0u; w < 4u; w = w + 1u) {
        let l = 16u * p + 4u * w + k;
        let q2 = (gbyte(base + 32u + (j / 4u) * 32u + l) >> (2u * (j & 3u))) & 3u;
        let hbit = (gbyte(base + l) >> j) & 1u;
        cw = cw | (q2 << (8u * k + 2u * w));
        hw = hw | (hbit << (8u * k + 4u * p + w));
      }
    }
    out_bits[og + 2u * j + p] = cw;
  }
  out_bits[og + 16u + j] = hw;
  if (j < 4u) {
    let a0 = word32at(base + 96u);
    let a1 = word32at(base + 100u);
    let tmp = word32at(base + 104u);
    var aux = array<u32, 4>(
      (a0 & 0x0f0f0f0fu) | ((tmp & 0x03030303u) << 4u),
      (a1 & 0x0f0f0f0fu) | (((tmp >> 2u) & 0x03030303u) << 4u),
      ((a0 >> 4u) & 0x0f0f0f0fu) | (((tmp >> 4u) & 0x03030303u) << 4u),
      ((a1 >> 4u) & 0x0f0f0f0fu) | (((tmp >> 6u) & 0x03030303u) << 4u));
    var sw = 0u;
    for (var t = 0u; t < 4u; t = t + 1u) {
      let i = 4u * j + t;
      let s6 = (aux[i >> 2u] >> (8u * (i & 3u))) & 0xFFu;
      sw = sw | (((s6 - 32u) & 0xFFu) << (8u * t));
    }
    out_bits[og + 24u + j] = sw;
  }
  if (j == 0u) { ss(ob / 8u, f16at(base + 108u)); }
}`:`@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f32>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = v; }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let j = bi % 8u; let base = sb * 110u;
  let og = (ob / 8u) * 28u;
  var hw = 0u;
  for (var p = 0u; p < 2u; p = p + 1u) {
    var cw = 0u;
    for (var k = 0u; k < 4u; k = k + 1u) {
      for (var w = 0u; w < 4u; w = w + 1u) {
        let l = 16u * p + 4u * w + k;
        let q2 = (gbyte(base + 32u + (j / 4u) * 32u + l) >> (2u * (j & 3u))) & 3u;
        let hbit = (gbyte(base + l) >> j) & 1u;
        cw = cw | (q2 << (8u * k + 2u * w));
        hw = hw | (hbit << (8u * k + 4u * p + w));
      }
    }
    out_bits[og + 2u * j + p] = cw;
  }
  out_bits[og + 16u + j] = hw;
  if (j < 4u) {
    let a0 = word32at(base + 96u);
    let a1 = word32at(base + 100u);
    let tmp = word32at(base + 104u);
    var aux = array<u32, 4>(
      (a0 & 0x0f0f0f0fu) | ((tmp & 0x03030303u) << 4u),
      (a1 & 0x0f0f0f0fu) | (((tmp >> 2u) & 0x03030303u) << 4u),
      ((a0 >> 4u) & 0x0f0f0f0fu) | (((tmp >> 4u) & 0x03030303u) << 4u),
      ((a1 >> 4u) & 0x0f0f0f0fu) | (((tmp >> 6u) & 0x03030303u) << 4u));
    var sw = 0u;
    for (var t = 0u; t < 4u; t = t + 1u) {
      let i = 4u * j + t;
      let s6 = (aux[i >> 2u] >> (8u * (i & 3u))) & 0xFFu;
      sw = sw | (((s6 - 32u) & 0xFFu) << (8u * t));
    }
    out_bits[og + 24u + j] = sw;
  }
  if (j == 0u) { ss(ob / 8u, f16at(base + 108u)); }
}`},Q4_KN:{id:"q4_k_to_q4kn",workgroupSize:64,supportsF16Scales:!1,buildWgsl:e=>{if(e)throw new Error("transcode q4_k_to_q4kn requires float32 scale storage");return`@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f32>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = v; }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn scByte(base: u32, j: u32) -> u32 { return gbyte(base + 4u + j); }
fn getSM(base: u32, j: u32) -> vec2<u32> {
  if (j < 4u) { return vec2<u32>(scByte(base, j) & 63u, scByte(base, j + 4u) & 63u); }
  let dd = (scByte(base, j + 4u) & 0x0Fu) | ((scByte(base, j - 4u) >> 6u) << 4u);
  let mm = (scByte(base, j + 4u) >> 4u) | ((scByte(base, j) >> 6u) << 4u);
  return vec2<u32>(dd, mm);
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let j = bi % 8u; let base = sb * 36u;
  let og = (ob / 8u) * 32u;
  let hi = (j & 1u) == 1u;
  let qsWordBase = base + 4u + (j >> 1u) * 8u;
  var qs: array<u32, 8>; load32(qsWordBase * 4u, &qs);
  for (var w = 0u; w < 4u; w = w + 1u) {
    var word = 0u;
    for (var k = 0u; k < 4u; k = k + 1u) {
      let loByte = b8(&qs, 4u * w + k); let hiByte = b8(&qs, 4u * w + k + 16u);
      let nLo = select(loByte & 0x0Fu, loByte >> 4u, hi);
      let nHi = select(hiByte & 0x0Fu, hiByte >> 4u, hi);
      word = word | (((nLo | (nHi << 4u)) & 0xFFu) << (8u * k));
    }
    out_bits[og + 4u * j + w] = word;
  }
  if (j == 0u) {
    let so = (ob / 8u) * 6u;
    let dd = unpack2x16float(src[base]);
    ss(so, dd.x); ss(so + 1u, dd.y);
  }
  if ((j & 1u) == 0u) {
    let c = j >> 1u;
    let sm0 = getSM(base * 4u, j);
    let sm1 = getSM(base * 4u, j + 1u);
    let carrier = sm0.x | (sm0.y << 6u) | (sm1.x << 12u) | (sm1.y << 18u);
    ss((ob / 8u) * 6u + 2u + c, f32(carrier));
  }
}`}},Q4_KNC:{id:"q4_k_to_q4knc",workgroupSize:64,metadataStorage:"uint32",supportsF16Scales:!1,buildWgsl:e=>{if(e)throw new Error("transcode q4_k_to_q4knc requires uint32 metadata storage");return`@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<u32>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = bitcast<u32>(v); }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn scByte(base: u32, j: u32) -> u32 { return gbyte(base + 4u + j); }
fn getSM(base: u32, j: u32) -> vec2<u32> {
  if (j < 4u) { return vec2<u32>(scByte(base, j) & 63u, scByte(base, j + 4u) & 63u); }
  let dd = (scByte(base, j + 4u) & 0x0Fu) | ((scByte(base, j - 4u) >> 6u) << 4u);
  let mm = (scByte(base, j + 4u) >> 4u) | ((scByte(base, j) >> 6u) << 4u);
  return vec2<u32>(dd, mm);
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let j = bi % 8u; let base = sb * 36u;
  let og = (ob / 8u) * 32u;
  let hi = (j & 1u) == 1u;
  let qsWordBase = base + 4u + (j >> 1u) * 8u;
  var qs: array<u32, 8>; load32(qsWordBase * 4u, &qs);
  for (var w = 0u; w < 4u; w = w + 1u) {
    var word = 0u;
    for (var k = 0u; k < 4u; k = k + 1u) {
      let loByte = b8(&qs, 4u * w + k); let hiByte = b8(&qs, 4u * w + k + 16u);
      let nLo = select(loByte & 0x0Fu, loByte >> 4u, hi);
      let nHi = select(hiByte & 0x0Fu, hiByte >> 4u, hi);
      word = word | (((nLo | (nHi << 4u)) & 0xFFu) << (8u * k));
    }
    out_bits[og + 4u * j + w] = word;
  }
  if (j == 0u) {
    out_scales[(ob / 8u) * 5u] = src[base];
  }
  if ((j & 1u) == 0u) {
    let c = j >> 1u;
    let sm0 = getSM(base * 4u, j);
    let sm1 = getSM(base * 4u, j + 1u);
    let carrier = sm0.x | (sm0.y << 6u) | (sm1.x << 12u) | (sm1.y << 18u);
    out_scales[(ob / 8u) * 5u + 1u + c] = carrier;
  }
}`}},Q6_KN:{id:"q6_k_to_q6k",workgroupSize:64,buildWgsl:e=>e?`enable f16;
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f16>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = f16(v); }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn q6code(base: u32, e: u32) -> u32 {
  let h = e >> 7u; let l = e & 127u;
  let r = l >> 5u; let n = l & 31u;
  let qlb = gbyte(base + 64u * h + n + 32u * (r & 1u));
  let nib = select(qlb >> 4u, qlb & 15u, r < 2u);
  let hi2 = (gbyte(base + 128u + 32u * h + n) >> (2u * r)) & 3u;
  return nib | (hi2 << 4u);
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let base = (bi / 8u) * 210u;
  let j = bi % 8u;
  let og = (ob / 8u) * 52u;
  var hiLo = 0u;
  var hiHi = 0u;
  for (var w = 0u; w < 4u; w = w + 1u) {
    var word = 0u;
    for (var k = 0u; k < 4u; k = k + 1u) {
      let cLo = q6code(base, 32u * j + 4u * w + k);
      let cHi = q6code(base, 32u * j + 16u + 4u * w + k);
      word = word | (((cLo & 15u) | ((cHi & 15u) << 4u)) << (8u * k));
      hiLo = hiLo | ((cLo >> 4u) << (8u * k + 2u * w));
      hiHi = hiHi | ((cHi >> 4u) << (8u * k + 2u * w));
    }
    out_bits[og + 4u * j + w] = word;
  }
  out_bits[og + 32u + 2u * j] = hiLo;
  out_bits[og + 32u + 2u * j + 1u] = hiHi;
  if (j < 4u) { out_bits[og + 48u + j] = word32at(base + 192u + 4u * j); }
  if (j == 0u) { ss(ob / 8u, f16at(base + 208u)); }
}`:`@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f32>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = v; }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn q6code(base: u32, e: u32) -> u32 {
  let h = e >> 7u; let l = e & 127u;
  let r = l >> 5u; let n = l & 31u;
  let qlb = gbyte(base + 64u * h + n + 32u * (r & 1u));
  let nib = select(qlb >> 4u, qlb & 15u, r < 2u);
  let hi2 = (gbyte(base + 128u + 32u * h + n) >> (2u * r)) & 3u;
  return nib | (hi2 << 4u);
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let base = (bi / 8u) * 210u;
  let j = bi % 8u;
  let og = (ob / 8u) * 52u;
  var hiLo = 0u;
  var hiHi = 0u;
  for (var w = 0u; w < 4u; w = w + 1u) {
    var word = 0u;
    for (var k = 0u; k < 4u; k = k + 1u) {
      let cLo = q6code(base, 32u * j + 4u * w + k);
      let cHi = q6code(base, 32u * j + 16u + 4u * w + k);
      word = word | (((cLo & 15u) | ((cHi & 15u) << 4u)) << (8u * k));
      hiLo = hiLo | ((cLo >> 4u) << (8u * k + 2u * w));
      hiHi = hiHi | ((cHi >> 4u) << (8u * k + 2u * w));
    }
    out_bits[og + 4u * j + w] = word;
  }
  out_bits[og + 32u + 2u * j] = hiLo;
  out_bits[og + 32u + 2u * j + 1u] = hiHi;
  if (j < 4u) { out_bits[og + 48u + j] = word32at(base + 192u + 4u * j); }
  if (j == 0u) { ss(ob / 8u, f16at(base + 208u)); }
}`},Q5_KN:{id:"q5_k_to_q5k",workgroupSize:64,buildWgsl:e=>e?`enable f16;
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f16>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = f16(v); }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn scByte(base: u32, j: u32) -> u32 { return gbyte(base + 4u + j); }
fn getSM(base: u32, j: u32) -> vec2<u32> {
  if (j < 4u) { return vec2<u32>(scByte(base, j) & 63u, scByte(base, j + 4u) & 63u); }
  let dd = (scByte(base, j + 4u) & 0x0Fu) | ((scByte(base, j - 4u) >> 6u) << 4u);
  let mm = (scByte(base, j + 4u) >> 4u) | ((scByte(base, j) >> 6u) << 4u);
  return vec2<u32>(dd, mm);
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let j = bi % 8u; let base = sb * 44u;
  let og = (ob / 8u) * 44u;
  let hi = (j & 1u) == 1u;
  let qsWordBase = base + 12u + (j >> 1u) * 8u;
  var qs: array<u32, 8>; load32(qsWordBase * 4u, &qs);
  var qh: array<u32, 8>; load32((base + 4u) * 4u, &qh);
  var qhw = 0u;
  for (var w = 0u; w < 4u; w = w + 1u) {
    var word = 0u;
    for (var k = 0u; k < 4u; k = k + 1u) {
      let lo_byte = b8(&qs, 4u * w + k); let hi_byte = b8(&qs, 4u * w + k + 16u);
      let nLo = select(lo_byte & 0x0Fu, lo_byte >> 4u, hi);
      let nHi = select(hi_byte & 0x0Fu, hi_byte >> 4u, hi);
      word = word | (((nLo | (nHi << 4u)) & 0xFFu) << (8u * k));
      let hLo = (b8(&qh, 4u * w + k) >> j) & 1u;
      let hHi = (b8(&qh, 4u * w + k + 16u) >> j) & 1u;
      qhw = qhw | (hLo << (4u * w + k)) | (hHi << (16u + 4u * w + k));
    }
    out_bits[og + 4u * j + w] = word;
  }
  out_bits[og + 32u + j] = qhw;
  if (j < 2u) {
    var sw = 0u; var mw = 0u;
    for (var k = 0u; k < 4u; k = k + 1u) {
      let sm = getSM(base * 4u, 4u * j + k);
      sw = sw | (sm.x << (8u * k)); mw = mw | (sm.y << (8u * k));
    }
    out_bits[og + 40u + j] = sw;
    out_bits[og + 42u + j] = mw;
  }
  if (j == 0u) {
    let dd = unpack2x16float(src[base]);
    ss((ob / 8u) * 2u, dd.x); ss((ob / 8u) * 2u + 1u, dd.y);
  }
}`:`@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f32>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = v; }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn scByte(base: u32, j: u32) -> u32 { return gbyte(base + 4u + j); }
fn getSM(base: u32, j: u32) -> vec2<u32> {
  if (j < 4u) { return vec2<u32>(scByte(base, j) & 63u, scByte(base, j + 4u) & 63u); }
  let dd = (scByte(base, j + 4u) & 0x0Fu) | ((scByte(base, j - 4u) >> 6u) << 4u);
  let mm = (scByte(base, j + 4u) >> 4u) | ((scByte(base, j) >> 6u) << 4u);
  return vec2<u32>(dd, mm);
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let j = bi % 8u; let base = sb * 44u;
  let og = (ob / 8u) * 44u;
  let hi = (j & 1u) == 1u;
  let qsWordBase = base + 12u + (j >> 1u) * 8u;
  var qs: array<u32, 8>; load32(qsWordBase * 4u, &qs);
  var qh: array<u32, 8>; load32((base + 4u) * 4u, &qh);
  var qhw = 0u;
  for (var w = 0u; w < 4u; w = w + 1u) {
    var word = 0u;
    for (var k = 0u; k < 4u; k = k + 1u) {
      let lo_byte = b8(&qs, 4u * w + k); let hi_byte = b8(&qs, 4u * w + k + 16u);
      let nLo = select(lo_byte & 0x0Fu, lo_byte >> 4u, hi);
      let nHi = select(hi_byte & 0x0Fu, hi_byte >> 4u, hi);
      word = word | (((nLo | (nHi << 4u)) & 0xFFu) << (8u * k));
      let hLo = (b8(&qh, 4u * w + k) >> j) & 1u;
      let hHi = (b8(&qh, 4u * w + k + 16u) >> j) & 1u;
      qhw = qhw | (hLo << (4u * w + k)) | (hHi << (16u + 4u * w + k));
    }
    out_bits[og + 4u * j + w] = word;
  }
  out_bits[og + 32u + j] = qhw;
  if (j < 2u) {
    var sw = 0u; var mw = 0u;
    for (var k = 0u; k < 4u; k = k + 1u) {
      let sm = getSM(base * 4u, 4u * j + k);
      sw = sw | (sm.x << (8u * k)); mw = mw | (sm.y << (8u * k));
    }
    out_bits[og + 40u + j] = sw;
    out_bits[og + 42u + j] = mw;
  }
  if (j == 0u) {
    let dd = unpack2x16float(src[base]);
    ss((ob / 8u) * 2u, dd.x); ss((ob / 8u) * 2u + 1u, dd.y);
  }
}`},Q4_K:{id:"q4_k_to_kq4",workgroupSize:64,buildWgsl:e=>e?`enable f16;
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f16>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = f16(v); }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn scByte(base: u32, j: u32) -> u32 { return gbyte(base + 4u + j); }
fn getSM(base: u32, j: u32) -> vec2<u32> {
  if (j < 4u) { return vec2<u32>(scByte(base, j) & 63u, scByte(base, j + 4u) & 63u); }
  let dd = (scByte(base, j + 4u) & 0x0Fu) | ((scByte(base, j - 4u) >> 6u) << 4u);
  let mm = (scByte(base, j + 4u) >> 4u) | ((scByte(base, j) >> 6u) << 4u);
  return vec2<u32>(dd, mm);
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let s = bi % 8u; let base = sb * 36u;
  let dd = unpack2x16float(src[base]);
  let scm = getSM(base * 4u, s);
  let d1 = dd.x * f32(scm.x); let m1 = dd.y * f32(scm.y);
  ss(ob * 2u, d1); ss(ob * 2u + 1u, 8.0 * d1 - m1);
  let qsWordBase = base + 4u + (s >> 1u) * 8u; let hi = (s & 1u) == 1u;
  var qs: array<u32, 8>; load32(qsWordBase * 4u, &qs);
  for (var w = 0u; w < 4u; w = w + 1u) {
    var word = 0u;
    for (var bb = 0u; bb < 4u; bb = bb + 1u) {
      let k = w * 4u + bb;
      let lo_byte = b8(&qs, k); let hi_byte = b8(&qs, k + 16u);
      let nLo = select(lo_byte & 0x0Fu, lo_byte >> 4u, hi);
      let nHi = select(hi_byte & 0x0Fu, hi_byte >> 4u, hi);
      word = word | (((nLo | (nHi << 4u)) & 0xFFu) << (bb * 8u));
    }
    out_bits[ob * 4u + w] = word;
  }
}`:`@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f32>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = v; }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn scByte(base: u32, j: u32) -> u32 { return gbyte(base + 4u + j); }
fn getSM(base: u32, j: u32) -> vec2<u32> {
  if (j < 4u) { return vec2<u32>(scByte(base, j) & 63u, scByte(base, j + 4u) & 63u); }
  let dd = (scByte(base, j + 4u) & 0x0Fu) | ((scByte(base, j - 4u) >> 6u) << 4u);
  let mm = (scByte(base, j + 4u) >> 4u) | ((scByte(base, j) >> 6u) << 4u);
  return vec2<u32>(dd, mm);
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let s = bi % 8u; let base = sb * 36u;
  let dd = unpack2x16float(src[base]);
  let scm = getSM(base * 4u, s);
  let d1 = dd.x * f32(scm.x); let m1 = dd.y * f32(scm.y);
  ss(ob * 2u, d1); ss(ob * 2u + 1u, 8.0 * d1 - m1);
  let qsWordBase = base + 4u + (s >> 1u) * 8u; let hi = (s & 1u) == 1u;
  var qs: array<u32, 8>; load32(qsWordBase * 4u, &qs);
  for (var w = 0u; w < 4u; w = w + 1u) {
    var word = 0u;
    for (var bb = 0u; bb < 4u; bb = bb + 1u) {
      let k = w * 4u + bb;
      let lo_byte = b8(&qs, k); let hi_byte = b8(&qs, k + 16u);
      let nLo = select(lo_byte & 0x0Fu, lo_byte >> 4u, hi);
      let nHi = select(hi_byte & 0x0Fu, hi_byte >> 4u, hi);
      word = word | (((nLo | (nHi << 4u)) & 0xFFu) << (bb * 8u));
    }
    out_bits[ob * 4u + w] = word;
  }
}`}},it={Q4_K:{id:"q4_k_to_q8",workgroupSize:64,buildWgsl:e=>e?`enable f16;
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f16>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = f16(v); }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn div_exact(x: f32, s: f32, t: f32) -> f32 { let q0 = x * t; let r = fma(-s, q0, x); return fma(r, t, q0); }
fn recip_exact(s: f32) -> f32 { let t0 = 1.0 / s; let t1 = fma(fma(-s, t0, 1.0), t0, t0); return fma(fma(-s, t1, 1.0), t1, t1); }
fn rqa(x: vec4<f32>) -> vec4<f32> { return sign(x) * floor(abs(x) + vec4<f32>(0.5)); }
fn packQ8(ob: u32, w: u32, q: vec4<i32>) {
  out_bits[ob * 8u + w] = (u32(q.x) & 0xFFu) | ((u32(q.y) & 0xFFu) << 8u) | ((u32(q.z) & 0xFFu) << 16u) | ((u32(q.w) & 0xFFu) << 24u);
}
fn writeQ8V(ob: u32, v: ptr<function, array<vec4<f32>, 8>>) {
  var am = vec4<f32>(0.0);
  for (var w = 0u; w < 8u; w = w + 1u) { am = max(am, abs((*v)[w])); }
  let amax = max(max(am.x, am.y), max(am.z, am.w));
  let scale = div_exact(amax, 127.0, recip_exact(127.0));
  let inv = select(0.0, recip_exact(scale), scale > 0.0);
  ss(ob, scale);
  for (var w = 0u; w < 8u; w = w + 1u) { packQ8(ob, w, clamp(vec4<i32>(rqa((*v)[w] * inv)), vec4<i32>(-127), vec4<i32>(127))); }
}
fn writeQ8(ob: u32, vals: ptr<function, array<f32, 32>>) {
  var am = vec4<f32>(0.0);
  for (var w = 0u; w < 8u; w = w + 1u) { let b = w * 4u; am = max(am, abs(vec4<f32>((*vals)[b], (*vals)[b + 1u], (*vals)[b + 2u], (*vals)[b + 3u]))); }
  let amax = max(max(am.x, am.y), max(am.z, am.w));
  let scale = div_exact(amax, 127.0, recip_exact(127.0));
  let inv = select(0.0, recip_exact(scale), scale > 0.0);
  ss(ob, scale);
  for (var w = 0u; w < 8u; w = w + 1u) { let b = w * 4u; let c = vec4<f32>((*vals)[b], (*vals)[b + 1u], (*vals)[b + 2u], (*vals)[b + 3u]) * inv; packQ8(ob, w, clamp(vec4<i32>(rqa(c)), vec4<i32>(-127), vec4<i32>(127))); }
}
fn scByte(base: u32, j: u32) -> u32 { return gbyte(base + 4u + j); }
fn getSM(base: u32, j: u32) -> vec2<u32> {
  if (j < 4u) { return vec2<u32>(scByte(base, j) & 63u, scByte(base, j + 4u) & 63u); }
  let dd = (scByte(base, j + 4u) & 0x0Fu) | ((scByte(base, j - 4u) >> 6u) << 4u);
  let mm = (scByte(base, j + 4u) >> 4u) | ((scByte(base, j) >> 6u) << 4u);
  return vec2<u32>(dd, mm);
}
fn q4kval(qlw: u32, m: u32, hi: bool, dl: f32, ml: f32) -> f32 {
  let q = (qlw >> (8u * m)) & 0xFFu;
  let nibble = select(q & 0x0Fu, q >> 4u, hi);
  let p = dl * f32(nibble);
  return p - ml;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let sbk = bi % 8u; let base = sb * 144u;
  let d = f16at(base); let dmin = f16at(base + 2u);
  let sm = getSM(base, sbk);
  let dl = d * f32(sm.x); let ml = dmin * f32(sm.y);
  let qlOff = base + 16u + (sbk >> 1u) * 32u; let hi = (sbk & 1u) == 1u;
  var ql: array<u32, 8>; load32(qlOff, &ql);
  var v: array<vec4<f32>, 8>;
  for (var w = 0u; w < 8u; w = w + 1u) {
    let qlw = ql[w];
    v[w] = vec4<f32>(q4kval(qlw, 0u, hi, dl, ml), q4kval(qlw, 1u, hi, dl, ml),
                     q4kval(qlw, 2u, hi, dl, ml), q4kval(qlw, 3u, hi, dl, ml));
  }
  writeQ8V(ob, &v);
}`:`@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f32>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = v; }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn div_exact(x: f32, s: f32, t: f32) -> f32 { let q0 = x * t; let r = fma(-s, q0, x); return fma(r, t, q0); }
fn recip_exact(s: f32) -> f32 { let t0 = 1.0 / s; let t1 = fma(fma(-s, t0, 1.0), t0, t0); return fma(fma(-s, t1, 1.0), t1, t1); }
fn rqa(x: vec4<f32>) -> vec4<f32> { return sign(x) * floor(abs(x) + vec4<f32>(0.5)); }
fn packQ8(ob: u32, w: u32, q: vec4<i32>) {
  out_bits[ob * 8u + w] = (u32(q.x) & 0xFFu) | ((u32(q.y) & 0xFFu) << 8u) | ((u32(q.z) & 0xFFu) << 16u) | ((u32(q.w) & 0xFFu) << 24u);
}
fn writeQ8V(ob: u32, v: ptr<function, array<vec4<f32>, 8>>) {
  var am = vec4<f32>(0.0);
  for (var w = 0u; w < 8u; w = w + 1u) { am = max(am, abs((*v)[w])); }
  let amax = max(max(am.x, am.y), max(am.z, am.w));
  let scale = div_exact(amax, 127.0, recip_exact(127.0));
  let inv = select(0.0, recip_exact(scale), scale > 0.0);
  ss(ob, scale);
  for (var w = 0u; w < 8u; w = w + 1u) { packQ8(ob, w, clamp(vec4<i32>(rqa((*v)[w] * inv)), vec4<i32>(-127), vec4<i32>(127))); }
}
fn writeQ8(ob: u32, vals: ptr<function, array<f32, 32>>) {
  var am = vec4<f32>(0.0);
  for (var w = 0u; w < 8u; w = w + 1u) { let b = w * 4u; am = max(am, abs(vec4<f32>((*vals)[b], (*vals)[b + 1u], (*vals)[b + 2u], (*vals)[b + 3u]))); }
  let amax = max(max(am.x, am.y), max(am.z, am.w));
  let scale = div_exact(amax, 127.0, recip_exact(127.0));
  let inv = select(0.0, recip_exact(scale), scale > 0.0);
  ss(ob, scale);
  for (var w = 0u; w < 8u; w = w + 1u) { let b = w * 4u; let c = vec4<f32>((*vals)[b], (*vals)[b + 1u], (*vals)[b + 2u], (*vals)[b + 3u]) * inv; packQ8(ob, w, clamp(vec4<i32>(rqa(c)), vec4<i32>(-127), vec4<i32>(127))); }
}
fn scByte(base: u32, j: u32) -> u32 { return gbyte(base + 4u + j); }
fn getSM(base: u32, j: u32) -> vec2<u32> {
  if (j < 4u) { return vec2<u32>(scByte(base, j) & 63u, scByte(base, j + 4u) & 63u); }
  let dd = (scByte(base, j + 4u) & 0x0Fu) | ((scByte(base, j - 4u) >> 6u) << 4u);
  let mm = (scByte(base, j + 4u) >> 4u) | ((scByte(base, j) >> 6u) << 4u);
  return vec2<u32>(dd, mm);
}
fn q4kval(qlw: u32, m: u32, hi: bool, dl: f32, ml: f32) -> f32 {
  let q = (qlw >> (8u * m)) & 0xFFu;
  let nibble = select(q & 0x0Fu, q >> 4u, hi);
  let p = dl * f32(nibble);
  return p - ml;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let sbk = bi % 8u; let base = sb * 144u;
  let d = f16at(base); let dmin = f16at(base + 2u);
  let sm = getSM(base, sbk);
  let dl = d * f32(sm.x); let ml = dmin * f32(sm.y);
  let qlOff = base + 16u + (sbk >> 1u) * 32u; let hi = (sbk & 1u) == 1u;
  var ql: array<u32, 8>; load32(qlOff, &ql);
  var v: array<vec4<f32>, 8>;
  for (var w = 0u; w < 8u; w = w + 1u) {
    let qlw = ql[w];
    v[w] = vec4<f32>(q4kval(qlw, 0u, hi, dl, ml), q4kval(qlw, 1u, hi, dl, ml),
                     q4kval(qlw, 2u, hi, dl, ml), q4kval(qlw, 3u, hi, dl, ml));
  }
  writeQ8V(ob, &v);
}`},Q6_K:{id:"q6_k_to_q8",workgroupSize:64,buildWgsl:e=>e?`enable f16;
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f16>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = f16(v); }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn div_exact(x: f32, s: f32, t: f32) -> f32 { let q0 = x * t; let r = fma(-s, q0, x); return fma(r, t, q0); }
fn recip_exact(s: f32) -> f32 { let t0 = 1.0 / s; let t1 = fma(fma(-s, t0, 1.0), t0, t0); return fma(fma(-s, t1, 1.0), t1, t1); }
fn rqa(x: vec4<f32>) -> vec4<f32> { return sign(x) * floor(abs(x) + vec4<f32>(0.5)); }
fn packQ8(ob: u32, w: u32, q: vec4<i32>) {
  out_bits[ob * 8u + w] = (u32(q.x) & 0xFFu) | ((u32(q.y) & 0xFFu) << 8u) | ((u32(q.z) & 0xFFu) << 16u) | ((u32(q.w) & 0xFFu) << 24u);
}
fn writeQ8V(ob: u32, v: ptr<function, array<vec4<f32>, 8>>) {
  var am = vec4<f32>(0.0);
  for (var w = 0u; w < 8u; w = w + 1u) { am = max(am, abs((*v)[w])); }
  let amax = max(max(am.x, am.y), max(am.z, am.w));
  let scale = div_exact(amax, 127.0, recip_exact(127.0));
  let inv = select(0.0, recip_exact(scale), scale > 0.0);
  ss(ob, scale);
  for (var w = 0u; w < 8u; w = w + 1u) { packQ8(ob, w, clamp(vec4<i32>(rqa((*v)[w] * inv)), vec4<i32>(-127), vec4<i32>(127))); }
}
fn writeQ8(ob: u32, vals: ptr<function, array<f32, 32>>) {
  var am = vec4<f32>(0.0);
  for (var w = 0u; w < 8u; w = w + 1u) { let b = w * 4u; am = max(am, abs(vec4<f32>((*vals)[b], (*vals)[b + 1u], (*vals)[b + 2u], (*vals)[b + 3u]))); }
  let amax = max(max(am.x, am.y), max(am.z, am.w));
  let scale = div_exact(amax, 127.0, recip_exact(127.0));
  let inv = select(0.0, recip_exact(scale), scale > 0.0);
  ss(ob, scale);
  for (var w = 0u; w < 8u; w = w + 1u) { let b = w * 4u; let c = vec4<f32>((*vals)[b], (*vals)[b + 1u], (*vals)[b + 2u], (*vals)[b + 3u]) * inv; packQ8(ob, w, clamp(vec4<i32>(rqa(c)), vec4<i32>(-127), vec4<i32>(127))); }
}
fn i8at(j: u32) -> i32 { return (i32(gbyte(j)) << 24u) >> 24u; }
fn q6val(qlw: u32, qhw: u32, m: u32, useHigh: bool, qhShift: u32, sc: f32) -> f32 {
  let qln = (qlw >> (8u * m)) & 0xFFu;
  let nib = select(qln & 0x0Fu, qln >> 4u, useHigh);
  let q6 = nib | (((((qhw >> (8u * m)) & 0xFFu) >> qhShift) & 3u) << 4u);
  return sc * f32(i32(q6) - 32);
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let q8blk = bi % 8u; let base = sb * 210u;
  let n = q8blk >> 2u; let sub = q8blk & 3u;
  let qlOff = base + n * 64u + (sub & 1u) * 32u;
  let qhBase = base + 128u + n * 32u;
  let scBase = base + 192u + n * 8u;
  let d = f16at(base + 208u);
  let useHigh = sub >= 2u; let qhShift = sub * 2u;
  let sc0 = d * f32(i8at(scBase + sub * 2u));
  let sc1 = d * f32(i8at(scBase + 1u + sub * 2u));
  var ql: array<u32, 8>; load32(qlOff, &ql);
  var qh: array<u32, 8>; load32(qhBase, &qh);
  var v: array<vec4<f32>, 8>;
  for (var w = 0u; w < 8u; w = w + 1u) {
    let qlw = ql[w]; let qhw = qh[w]; let sc = select(sc0, sc1, w >= 4u);
    v[w] = vec4<f32>(q6val(qlw, qhw, 0u, useHigh, qhShift, sc), q6val(qlw, qhw, 1u, useHigh, qhShift, sc),
                     q6val(qlw, qhw, 2u, useHigh, qhShift, sc), q6val(qlw, qhw, 3u, useHigh, qhShift, sc));
  }
  writeQ8V(ob, &v);
}`:`@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f32>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = v; }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn div_exact(x: f32, s: f32, t: f32) -> f32 { let q0 = x * t; let r = fma(-s, q0, x); return fma(r, t, q0); }
fn recip_exact(s: f32) -> f32 { let t0 = 1.0 / s; let t1 = fma(fma(-s, t0, 1.0), t0, t0); return fma(fma(-s, t1, 1.0), t1, t1); }
fn rqa(x: vec4<f32>) -> vec4<f32> { return sign(x) * floor(abs(x) + vec4<f32>(0.5)); }
fn packQ8(ob: u32, w: u32, q: vec4<i32>) {
  out_bits[ob * 8u + w] = (u32(q.x) & 0xFFu) | ((u32(q.y) & 0xFFu) << 8u) | ((u32(q.z) & 0xFFu) << 16u) | ((u32(q.w) & 0xFFu) << 24u);
}
fn writeQ8V(ob: u32, v: ptr<function, array<vec4<f32>, 8>>) {
  var am = vec4<f32>(0.0);
  for (var w = 0u; w < 8u; w = w + 1u) { am = max(am, abs((*v)[w])); }
  let amax = max(max(am.x, am.y), max(am.z, am.w));
  let scale = div_exact(amax, 127.0, recip_exact(127.0));
  let inv = select(0.0, recip_exact(scale), scale > 0.0);
  ss(ob, scale);
  for (var w = 0u; w < 8u; w = w + 1u) { packQ8(ob, w, clamp(vec4<i32>(rqa((*v)[w] * inv)), vec4<i32>(-127), vec4<i32>(127))); }
}
fn writeQ8(ob: u32, vals: ptr<function, array<f32, 32>>) {
  var am = vec4<f32>(0.0);
  for (var w = 0u; w < 8u; w = w + 1u) { let b = w * 4u; am = max(am, abs(vec4<f32>((*vals)[b], (*vals)[b + 1u], (*vals)[b + 2u], (*vals)[b + 3u]))); }
  let amax = max(max(am.x, am.y), max(am.z, am.w));
  let scale = div_exact(amax, 127.0, recip_exact(127.0));
  let inv = select(0.0, recip_exact(scale), scale > 0.0);
  ss(ob, scale);
  for (var w = 0u; w < 8u; w = w + 1u) { let b = w * 4u; let c = vec4<f32>((*vals)[b], (*vals)[b + 1u], (*vals)[b + 2u], (*vals)[b + 3u]) * inv; packQ8(ob, w, clamp(vec4<i32>(rqa(c)), vec4<i32>(-127), vec4<i32>(127))); }
}
fn i8at(j: u32) -> i32 { return (i32(gbyte(j)) << 24u) >> 24u; }
fn q6val(qlw: u32, qhw: u32, m: u32, useHigh: bool, qhShift: u32, sc: f32) -> f32 {
  let qln = (qlw >> (8u * m)) & 0xFFu;
  let nib = select(qln & 0x0Fu, qln >> 4u, useHigh);
  let q6 = nib | (((((qhw >> (8u * m)) & 0xFFu) >> qhShift) & 3u) << 4u);
  return sc * f32(i32(q6) - 32);
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let q8blk = bi % 8u; let base = sb * 210u;
  let n = q8blk >> 2u; let sub = q8blk & 3u;
  let qlOff = base + n * 64u + (sub & 1u) * 32u;
  let qhBase = base + 128u + n * 32u;
  let scBase = base + 192u + n * 8u;
  let d = f16at(base + 208u);
  let useHigh = sub >= 2u; let qhShift = sub * 2u;
  let sc0 = d * f32(i8at(scBase + sub * 2u));
  let sc1 = d * f32(i8at(scBase + 1u + sub * 2u));
  var ql: array<u32, 8>; load32(qlOff, &ql);
  var qh: array<u32, 8>; load32(qhBase, &qh);
  var v: array<vec4<f32>, 8>;
  for (var w = 0u; w < 8u; w = w + 1u) {
    let qlw = ql[w]; let qhw = qh[w]; let sc = select(sc0, sc1, w >= 4u);
    v[w] = vec4<f32>(q6val(qlw, qhw, 0u, useHigh, qhShift, sc), q6val(qlw, qhw, 1u, useHigh, qhShift, sc),
                     q6val(qlw, qhw, 2u, useHigh, qhShift, sc), q6val(qlw, qhw, 3u, useHigh, qhShift, sc));
  }
  writeQ8V(ob, &v);
}`},Q5_K:{id:"q5_k_to_q8",workgroupSize:64,buildWgsl:e=>e?`enable f16;
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f16>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = f16(v); }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn div_exact(x: f32, s: f32, t: f32) -> f32 { let q0 = x * t; let r = fma(-s, q0, x); return fma(r, t, q0); }
fn recip_exact(s: f32) -> f32 { let t0 = 1.0 / s; let t1 = fma(fma(-s, t0, 1.0), t0, t0); return fma(fma(-s, t1, 1.0), t1, t1); }
fn rqa(x: vec4<f32>) -> vec4<f32> { return sign(x) * floor(abs(x) + vec4<f32>(0.5)); }
fn packQ8(ob: u32, w: u32, q: vec4<i32>) {
  out_bits[ob * 8u + w] = (u32(q.x) & 0xFFu) | ((u32(q.y) & 0xFFu) << 8u) | ((u32(q.z) & 0xFFu) << 16u) | ((u32(q.w) & 0xFFu) << 24u);
}
fn writeQ8V(ob: u32, v: ptr<function, array<vec4<f32>, 8>>) {
  var am = vec4<f32>(0.0);
  for (var w = 0u; w < 8u; w = w + 1u) { am = max(am, abs((*v)[w])); }
  let amax = max(max(am.x, am.y), max(am.z, am.w));
  let scale = div_exact(amax, 127.0, recip_exact(127.0));
  let inv = select(0.0, recip_exact(scale), scale > 0.0);
  ss(ob, scale);
  for (var w = 0u; w < 8u; w = w + 1u) { packQ8(ob, w, clamp(vec4<i32>(rqa((*v)[w] * inv)), vec4<i32>(-127), vec4<i32>(127))); }
}
fn writeQ8(ob: u32, vals: ptr<function, array<f32, 32>>) {
  var am = vec4<f32>(0.0);
  for (var w = 0u; w < 8u; w = w + 1u) { let b = w * 4u; am = max(am, abs(vec4<f32>((*vals)[b], (*vals)[b + 1u], (*vals)[b + 2u], (*vals)[b + 3u]))); }
  let amax = max(max(am.x, am.y), max(am.z, am.w));
  let scale = div_exact(amax, 127.0, recip_exact(127.0));
  let inv = select(0.0, recip_exact(scale), scale > 0.0);
  ss(ob, scale);
  for (var w = 0u; w < 8u; w = w + 1u) { let b = w * 4u; let c = vec4<f32>((*vals)[b], (*vals)[b + 1u], (*vals)[b + 2u], (*vals)[b + 3u]) * inv; packQ8(ob, w, clamp(vec4<i32>(rqa(c)), vec4<i32>(-127), vec4<i32>(127))); }
}
fn scByte(base: u32, j: u32) -> u32 { return gbyte(base + 4u + j); }
fn getSM(base: u32, j: u32) -> vec2<u32> {
  if (j < 4u) { return vec2<u32>(scByte(base, j) & 63u, scByte(base, j + 4u) & 63u); }
  let dd = (scByte(base, j + 4u) & 0x0Fu) | ((scByte(base, j - 4u) >> 6u) << 4u);
  let mm = (scByte(base, j + 4u) >> 4u) | ((scByte(base, j) >> 6u) << 4u);
  return vec2<u32>(dd, mm);
}
fn q5val(qlw: u32, qhw: u32, m: u32, hi: bool, sbk: u32, dl: f32, ml: f32) -> f32 {
  let q = (qlw >> (8u * m)) & 0xFFu;
  let nibble = select(q & 0x0Fu, q >> 4u, hi);
  let hibit = ((((qhw >> (8u * m)) & 0xFFu) >> sbk) & 1u) * 16u;
  let p = dl * f32(nibble + hibit);
  return p - ml;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let sbk = bi % 8u; let base = sb * 176u;
  let d = f16at(base); let dmin = f16at(base + 2u);
  let sm = getSM(base, sbk);
  let dl = d * f32(sm.x); let ml = dmin * f32(sm.y);
  let qlOff = base + 48u + (sbk >> 1u) * 32u; let hi = (sbk & 1u) == 1u;
  var ql: array<u32, 8>; load32(qlOff, &ql);
  var qh: array<u32, 8>; load32(base + 16u, &qh);
  var v: array<vec4<f32>, 8>;
  for (var w = 0u; w < 8u; w = w + 1u) {
    let qlw = ql[w]; let qhw = qh[w];
    v[w] = vec4<f32>(q5val(qlw, qhw, 0u, hi, sbk, dl, ml), q5val(qlw, qhw, 1u, hi, sbk, dl, ml),
                     q5val(qlw, qhw, 2u, hi, sbk, dl, ml), q5val(qlw, qhw, 3u, hi, sbk, dl, ml));
  }
  writeQ8V(ob, &v);
}`:`@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f32>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = v; }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn div_exact(x: f32, s: f32, t: f32) -> f32 { let q0 = x * t; let r = fma(-s, q0, x); return fma(r, t, q0); }
fn recip_exact(s: f32) -> f32 { let t0 = 1.0 / s; let t1 = fma(fma(-s, t0, 1.0), t0, t0); return fma(fma(-s, t1, 1.0), t1, t1); }
fn rqa(x: vec4<f32>) -> vec4<f32> { return sign(x) * floor(abs(x) + vec4<f32>(0.5)); }
fn packQ8(ob: u32, w: u32, q: vec4<i32>) {
  out_bits[ob * 8u + w] = (u32(q.x) & 0xFFu) | ((u32(q.y) & 0xFFu) << 8u) | ((u32(q.z) & 0xFFu) << 16u) | ((u32(q.w) & 0xFFu) << 24u);
}
fn writeQ8V(ob: u32, v: ptr<function, array<vec4<f32>, 8>>) {
  var am = vec4<f32>(0.0);
  for (var w = 0u; w < 8u; w = w + 1u) { am = max(am, abs((*v)[w])); }
  let amax = max(max(am.x, am.y), max(am.z, am.w));
  let scale = div_exact(amax, 127.0, recip_exact(127.0));
  let inv = select(0.0, recip_exact(scale), scale > 0.0);
  ss(ob, scale);
  for (var w = 0u; w < 8u; w = w + 1u) { packQ8(ob, w, clamp(vec4<i32>(rqa((*v)[w] * inv)), vec4<i32>(-127), vec4<i32>(127))); }
}
fn writeQ8(ob: u32, vals: ptr<function, array<f32, 32>>) {
  var am = vec4<f32>(0.0);
  for (var w = 0u; w < 8u; w = w + 1u) { let b = w * 4u; am = max(am, abs(vec4<f32>((*vals)[b], (*vals)[b + 1u], (*vals)[b + 2u], (*vals)[b + 3u]))); }
  let amax = max(max(am.x, am.y), max(am.z, am.w));
  let scale = div_exact(amax, 127.0, recip_exact(127.0));
  let inv = select(0.0, recip_exact(scale), scale > 0.0);
  ss(ob, scale);
  for (var w = 0u; w < 8u; w = w + 1u) { let b = w * 4u; let c = vec4<f32>((*vals)[b], (*vals)[b + 1u], (*vals)[b + 2u], (*vals)[b + 3u]) * inv; packQ8(ob, w, clamp(vec4<i32>(rqa(c)), vec4<i32>(-127), vec4<i32>(127))); }
}
fn scByte(base: u32, j: u32) -> u32 { return gbyte(base + 4u + j); }
fn getSM(base: u32, j: u32) -> vec2<u32> {
  if (j < 4u) { return vec2<u32>(scByte(base, j) & 63u, scByte(base, j + 4u) & 63u); }
  let dd = (scByte(base, j + 4u) & 0x0Fu) | ((scByte(base, j - 4u) >> 6u) << 4u);
  let mm = (scByte(base, j + 4u) >> 4u) | ((scByte(base, j) >> 6u) << 4u);
  return vec2<u32>(dd, mm);
}
fn q5val(qlw: u32, qhw: u32, m: u32, hi: bool, sbk: u32, dl: f32, ml: f32) -> f32 {
  let q = (qlw >> (8u * m)) & 0xFFu;
  let nibble = select(q & 0x0Fu, q >> 4u, hi);
  let hibit = ((((qhw >> (8u * m)) & 0xFFu) >> sbk) & 1u) * 16u;
  let p = dl * f32(nibble + hibit);
  return p - ml;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let sbk = bi % 8u; let base = sb * 176u;
  let d = f16at(base); let dmin = f16at(base + 2u);
  let sm = getSM(base, sbk);
  let dl = d * f32(sm.x); let ml = dmin * f32(sm.y);
  let qlOff = base + 48u + (sbk >> 1u) * 32u; let hi = (sbk & 1u) == 1u;
  var ql: array<u32, 8>; load32(qlOff, &ql);
  var qh: array<u32, 8>; load32(base + 16u, &qh);
  var v: array<vec4<f32>, 8>;
  for (var w = 0u; w < 8u; w = w + 1u) {
    let qlw = ql[w]; let qhw = qh[w];
    v[w] = vec4<f32>(q5val(qlw, qhw, 0u, hi, sbk, dl, ml), q5val(qlw, qhw, 1u, hi, sbk, dl, ml),
                     q5val(qlw, qhw, 2u, hi, sbk, dl, ml), q5val(qlw, qhw, 3u, hi, sbk, dl, ml));
  }
  writeQ8V(ob, &v);
}`},Q3_K:{id:"q3_k_to_q8",workgroupSize:64,buildWgsl:e=>e?`enable f16;
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f16>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = f16(v); }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn div_exact(x: f32, s: f32, t: f32) -> f32 { let q0 = x * t; let r = fma(-s, q0, x); return fma(r, t, q0); }
fn recip_exact(s: f32) -> f32 { let t0 = 1.0 / s; let t1 = fma(fma(-s, t0, 1.0), t0, t0); return fma(fma(-s, t1, 1.0), t1, t1); }
fn rqa(x: vec4<f32>) -> vec4<f32> { return sign(x) * floor(abs(x) + vec4<f32>(0.5)); }
fn packQ8(ob: u32, w: u32, q: vec4<i32>) {
  out_bits[ob * 8u + w] = (u32(q.x) & 0xFFu) | ((u32(q.y) & 0xFFu) << 8u) | ((u32(q.z) & 0xFFu) << 16u) | ((u32(q.w) & 0xFFu) << 24u);
}
fn writeQ8V(ob: u32, v: ptr<function, array<vec4<f32>, 8>>) {
  var am = vec4<f32>(0.0);
  for (var w = 0u; w < 8u; w = w + 1u) { am = max(am, abs((*v)[w])); }
  let amax = max(max(am.x, am.y), max(am.z, am.w));
  let scale = div_exact(amax, 127.0, recip_exact(127.0));
  let inv = select(0.0, recip_exact(scale), scale > 0.0);
  ss(ob, scale);
  for (var w = 0u; w < 8u; w = w + 1u) { packQ8(ob, w, clamp(vec4<i32>(rqa((*v)[w] * inv)), vec4<i32>(-127), vec4<i32>(127))); }
}
fn writeQ8(ob: u32, vals: ptr<function, array<f32, 32>>) {
  var am = vec4<f32>(0.0);
  for (var w = 0u; w < 8u; w = w + 1u) { let b = w * 4u; am = max(am, abs(vec4<f32>((*vals)[b], (*vals)[b + 1u], (*vals)[b + 2u], (*vals)[b + 3u]))); }
  let amax = max(max(am.x, am.y), max(am.z, am.w));
  let scale = div_exact(amax, 127.0, recip_exact(127.0));
  let inv = select(0.0, recip_exact(scale), scale > 0.0);
  ss(ob, scale);
  for (var w = 0u; w < 8u; w = w + 1u) { let b = w * 4u; let c = vec4<f32>((*vals)[b], (*vals)[b + 1u], (*vals)[b + 2u], (*vals)[b + 3u]) * inv; packQ8(ob, w, clamp(vec4<i32>(rqa(c)), vec4<i32>(-127), vec4<i32>(127))); }
}
fn q3kScaleFrom(a0: u32, a1: u32, tmp: u32, si: u32) -> i32 {
  let w = si >> 2u; let bb = si & 3u;
  var aux: u32;
  if (w == 0u) { aux = (a0 & 0x0f0f0f0fu) | ((tmp & 0x03030303u) << 4u); }
  else if (w == 1u) { aux = (a1 & 0x0f0f0f0fu) | (((tmp >> 2u) & 0x03030303u) << 4u); }
  else if (w == 2u) { aux = ((a0 >> 4u) & 0x0f0f0f0fu) | (((tmp >> 4u) & 0x03030303u) << 4u); }
  else { aux = ((a1 >> 4u) & 0x0f0f0f0fu) | (((tmp >> 6u) & 0x03030303u) << 4u); }
  let s = (aux >> (bb * 8u)) & 0xFFu;
  return ((i32(s) << 24u) >> 24u) - 32;
}
fn q3val(qbw: u32, hbw: u32, m: u32, shift: u32, mask: u32, dl: f32) -> f32 {
  let q2 = (((qbw >> (8u * m)) & 0xFFu) >> shift) & 3u;
  let hbit = select(4u, 0u, (((hbw >> (8u * m)) & 0xFFu) & mask) != 0u);
  return dl * f32(i32(q2) - i32(hbit));
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let sbk = bi % 8u; let base = sb * 110u;
  let d = f16at(base + 108u);
  let shift = (sbk & 3u) * 2u; let m = 1u << sbk; let qOff = base + 32u + (sbk >> 2u) * 32u;
  let a0 = word32at(base + 96u); let a1 = word32at(base + 100u); let tmp = word32at(base + 104u);
  let dl0 = d * f32(q3kScaleFrom(a0, a1, tmp, sbk * 2u));
  let dl1 = d * f32(q3kScaleFrom(a0, a1, tmp, sbk * 2u + 1u));
  var qb: array<u32, 8>; load32(qOff, &qb);
  var hb: array<u32, 8>; load32(base, &hb);
  var v: array<vec4<f32>, 8>;
  for (var w = 0u; w < 8u; w = w + 1u) {
    let qbw = qb[w]; let hbw = hb[w]; let dl = select(dl0, dl1, w >= 4u);
    v[w] = vec4<f32>(q3val(qbw, hbw, 0u, shift, m, dl), q3val(qbw, hbw, 1u, shift, m, dl),
                     q3val(qbw, hbw, 2u, shift, m, dl), q3val(qbw, hbw, 3u, shift, m, dl));
  }
  writeQ8V(ob, &v);
}`:`@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f32>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = v; }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn div_exact(x: f32, s: f32, t: f32) -> f32 { let q0 = x * t; let r = fma(-s, q0, x); return fma(r, t, q0); }
fn recip_exact(s: f32) -> f32 { let t0 = 1.0 / s; let t1 = fma(fma(-s, t0, 1.0), t0, t0); return fma(fma(-s, t1, 1.0), t1, t1); }
fn rqa(x: vec4<f32>) -> vec4<f32> { return sign(x) * floor(abs(x) + vec4<f32>(0.5)); }
fn packQ8(ob: u32, w: u32, q: vec4<i32>) {
  out_bits[ob * 8u + w] = (u32(q.x) & 0xFFu) | ((u32(q.y) & 0xFFu) << 8u) | ((u32(q.z) & 0xFFu) << 16u) | ((u32(q.w) & 0xFFu) << 24u);
}
fn writeQ8V(ob: u32, v: ptr<function, array<vec4<f32>, 8>>) {
  var am = vec4<f32>(0.0);
  for (var w = 0u; w < 8u; w = w + 1u) { am = max(am, abs((*v)[w])); }
  let amax = max(max(am.x, am.y), max(am.z, am.w));
  let scale = div_exact(amax, 127.0, recip_exact(127.0));
  let inv = select(0.0, recip_exact(scale), scale > 0.0);
  ss(ob, scale);
  for (var w = 0u; w < 8u; w = w + 1u) { packQ8(ob, w, clamp(vec4<i32>(rqa((*v)[w] * inv)), vec4<i32>(-127), vec4<i32>(127))); }
}
fn writeQ8(ob: u32, vals: ptr<function, array<f32, 32>>) {
  var am = vec4<f32>(0.0);
  for (var w = 0u; w < 8u; w = w + 1u) { let b = w * 4u; am = max(am, abs(vec4<f32>((*vals)[b], (*vals)[b + 1u], (*vals)[b + 2u], (*vals)[b + 3u]))); }
  let amax = max(max(am.x, am.y), max(am.z, am.w));
  let scale = div_exact(amax, 127.0, recip_exact(127.0));
  let inv = select(0.0, recip_exact(scale), scale > 0.0);
  ss(ob, scale);
  for (var w = 0u; w < 8u; w = w + 1u) { let b = w * 4u; let c = vec4<f32>((*vals)[b], (*vals)[b + 1u], (*vals)[b + 2u], (*vals)[b + 3u]) * inv; packQ8(ob, w, clamp(vec4<i32>(rqa(c)), vec4<i32>(-127), vec4<i32>(127))); }
}
fn q3kScaleFrom(a0: u32, a1: u32, tmp: u32, si: u32) -> i32 {
  let w = si >> 2u; let bb = si & 3u;
  var aux: u32;
  if (w == 0u) { aux = (a0 & 0x0f0f0f0fu) | ((tmp & 0x03030303u) << 4u); }
  else if (w == 1u) { aux = (a1 & 0x0f0f0f0fu) | (((tmp >> 2u) & 0x03030303u) << 4u); }
  else if (w == 2u) { aux = ((a0 >> 4u) & 0x0f0f0f0fu) | (((tmp >> 4u) & 0x03030303u) << 4u); }
  else { aux = ((a1 >> 4u) & 0x0f0f0f0fu) | (((tmp >> 6u) & 0x03030303u) << 4u); }
  let s = (aux >> (bb * 8u)) & 0xFFu;
  return ((i32(s) << 24u) >> 24u) - 32;
}
fn q3val(qbw: u32, hbw: u32, m: u32, shift: u32, mask: u32, dl: f32) -> f32 {
  let q2 = (((qbw >> (8u * m)) & 0xFFu) >> shift) & 3u;
  let hbit = select(4u, 0u, (((hbw >> (8u * m)) & 0xFFu) & mask) != 0u);
  return dl * f32(i32(q2) - i32(hbit));
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let sbk = bi % 8u; let base = sb * 110u;
  let d = f16at(base + 108u);
  let shift = (sbk & 3u) * 2u; let m = 1u << sbk; let qOff = base + 32u + (sbk >> 2u) * 32u;
  let a0 = word32at(base + 96u); let a1 = word32at(base + 100u); let tmp = word32at(base + 104u);
  let dl0 = d * f32(q3kScaleFrom(a0, a1, tmp, sbk * 2u));
  let dl1 = d * f32(q3kScaleFrom(a0, a1, tmp, sbk * 2u + 1u));
  var qb: array<u32, 8>; load32(qOff, &qb);
  var hb: array<u32, 8>; load32(base, &hb);
  var v: array<vec4<f32>, 8>;
  for (var w = 0u; w < 8u; w = w + 1u) {
    let qbw = qb[w]; let hbw = hb[w]; let dl = select(dl0, dl1, w >= 4u);
    v[w] = vec4<f32>(q3val(qbw, hbw, 0u, shift, m, dl), q3val(qbw, hbw, 1u, shift, m, dl),
                     q3val(qbw, hbw, 2u, shift, m, dl), q3val(qbw, hbw, 3u, shift, m, dl));
  }
  writeQ8V(ob, &v);
}`},Q2_K:{id:"q2_k_to_q8",workgroupSize:64,buildWgsl:e=>e?`enable f16;
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f16>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = f16(v); }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn div_exact(x: f32, s: f32, t: f32) -> f32 { let q0 = x * t; let r = fma(-s, q0, x); return fma(r, t, q0); }
fn recip_exact(s: f32) -> f32 { let t0 = 1.0 / s; let t1 = fma(fma(-s, t0, 1.0), t0, t0); return fma(fma(-s, t1, 1.0), t1, t1); }
fn rqa(x: vec4<f32>) -> vec4<f32> { return sign(x) * floor(abs(x) + vec4<f32>(0.5)); }
fn packQ8(ob: u32, w: u32, q: vec4<i32>) {
  out_bits[ob * 8u + w] = (u32(q.x) & 0xFFu) | ((u32(q.y) & 0xFFu) << 8u) | ((u32(q.z) & 0xFFu) << 16u) | ((u32(q.w) & 0xFFu) << 24u);
}
fn writeQ8V(ob: u32, v: ptr<function, array<vec4<f32>, 8>>) {
  var am = vec4<f32>(0.0);
  for (var w = 0u; w < 8u; w = w + 1u) { am = max(am, abs((*v)[w])); }
  let amax = max(max(am.x, am.y), max(am.z, am.w));
  let scale = div_exact(amax, 127.0, recip_exact(127.0));
  let inv = select(0.0, recip_exact(scale), scale > 0.0);
  ss(ob, scale);
  for (var w = 0u; w < 8u; w = w + 1u) { packQ8(ob, w, clamp(vec4<i32>(rqa((*v)[w] * inv)), vec4<i32>(-127), vec4<i32>(127))); }
}
fn writeQ8(ob: u32, vals: ptr<function, array<f32, 32>>) {
  var am = vec4<f32>(0.0);
  for (var w = 0u; w < 8u; w = w + 1u) { let b = w * 4u; am = max(am, abs(vec4<f32>((*vals)[b], (*vals)[b + 1u], (*vals)[b + 2u], (*vals)[b + 3u]))); }
  let amax = max(max(am.x, am.y), max(am.z, am.w));
  let scale = div_exact(amax, 127.0, recip_exact(127.0));
  let inv = select(0.0, recip_exact(scale), scale > 0.0);
  ss(ob, scale);
  for (var w = 0u; w < 8u; w = w + 1u) { let b = w * 4u; let c = vec4<f32>((*vals)[b], (*vals)[b + 1u], (*vals)[b + 2u], (*vals)[b + 3u]) * inv; packQ8(ob, w, clamp(vec4<i32>(rqa(c)), vec4<i32>(-127), vec4<i32>(127))); }
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let sbk = bi % 8u; let base = sb * 84u;
  let d = f16at(base + 80u); let dmin = f16at(base + 82u);
  let shift = (sbk & 3u) * 2u; let qOff = base + 16u + (sbk >> 2u) * 32u;
  let sc0 = gbyte(base + sbk * 2u); let sc1 = gbyte(base + sbk * 2u + 1u);
  let dl0 = d * f32(sc0 & 0x0Fu); let ml0 = dmin * f32(sc0 >> 4u);
  let dl1 = d * f32(sc1 & 0x0Fu); let ml1 = dmin * f32(sc1 >> 4u);
  var qb: array<u32, 8>; load32(qOff, &qb);
  var vals = array<f32, 32>();
  for (var l = 0u; l < 32u; l = l + 1u) {
    let q2 = (b8(&qb, l) >> shift) & 3u;
    let dl = select(dl0, dl1, l >= 16u); let ml = select(ml0, ml1, l >= 16u);
    let p = dl * f32(q2); vals[l] = p - ml;
  }
  writeQ8(ob, &vals);
}`:`@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f32>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = v; }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn div_exact(x: f32, s: f32, t: f32) -> f32 { let q0 = x * t; let r = fma(-s, q0, x); return fma(r, t, q0); }
fn recip_exact(s: f32) -> f32 { let t0 = 1.0 / s; let t1 = fma(fma(-s, t0, 1.0), t0, t0); return fma(fma(-s, t1, 1.0), t1, t1); }
fn rqa(x: vec4<f32>) -> vec4<f32> { return sign(x) * floor(abs(x) + vec4<f32>(0.5)); }
fn packQ8(ob: u32, w: u32, q: vec4<i32>) {
  out_bits[ob * 8u + w] = (u32(q.x) & 0xFFu) | ((u32(q.y) & 0xFFu) << 8u) | ((u32(q.z) & 0xFFu) << 16u) | ((u32(q.w) & 0xFFu) << 24u);
}
fn writeQ8V(ob: u32, v: ptr<function, array<vec4<f32>, 8>>) {
  var am = vec4<f32>(0.0);
  for (var w = 0u; w < 8u; w = w + 1u) { am = max(am, abs((*v)[w])); }
  let amax = max(max(am.x, am.y), max(am.z, am.w));
  let scale = div_exact(amax, 127.0, recip_exact(127.0));
  let inv = select(0.0, recip_exact(scale), scale > 0.0);
  ss(ob, scale);
  for (var w = 0u; w < 8u; w = w + 1u) { packQ8(ob, w, clamp(vec4<i32>(rqa((*v)[w] * inv)), vec4<i32>(-127), vec4<i32>(127))); }
}
fn writeQ8(ob: u32, vals: ptr<function, array<f32, 32>>) {
  var am = vec4<f32>(0.0);
  for (var w = 0u; w < 8u; w = w + 1u) { let b = w * 4u; am = max(am, abs(vec4<f32>((*vals)[b], (*vals)[b + 1u], (*vals)[b + 2u], (*vals)[b + 3u]))); }
  let amax = max(max(am.x, am.y), max(am.z, am.w));
  let scale = div_exact(amax, 127.0, recip_exact(127.0));
  let inv = select(0.0, recip_exact(scale), scale > 0.0);
  ss(ob, scale);
  for (var w = 0u; w < 8u; w = w + 1u) { let b = w * 4u; let c = vec4<f32>((*vals)[b], (*vals)[b + 1u], (*vals)[b + 2u], (*vals)[b + 3u]) * inv; packQ8(ob, w, clamp(vec4<i32>(rqa(c)), vec4<i32>(-127), vec4<i32>(127))); }
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let sbk = bi % 8u; let base = sb * 84u;
  let d = f16at(base + 80u); let dmin = f16at(base + 82u);
  let shift = (sbk & 3u) * 2u; let qOff = base + 16u + (sbk >> 2u) * 32u;
  let sc0 = gbyte(base + sbk * 2u); let sc1 = gbyte(base + sbk * 2u + 1u);
  let dl0 = d * f32(sc0 & 0x0Fu); let ml0 = dmin * f32(sc0 >> 4u);
  let dl1 = d * f32(sc1 & 0x0Fu); let ml1 = dmin * f32(sc1 >> 4u);
  var qb: array<u32, 8>; load32(qOff, &qb);
  var vals = array<f32, 32>();
  for (var l = 0u; l < 32u; l = l + 1u) {
    let q2 = (b8(&qb, l) >> shift) & 3u;
    let dl = select(dl0, dl1, l >= 16u); let ml = select(ml0, ml1, l >= 16u);
    let p = dl * f32(q2); vals[l] = p - ml;
  }
  writeQ8(ob, &vals);
}`}},Lb={Q5_K_TO_KQ4:{id:"q5_k_to_kq4req",workgroupSize:64,buildWgsl:e=>e?`enable f16;
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f16>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = f16(v); }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn div_exact(x: f32, s: f32, t: f32) -> f32 { let q0 = x * t; let r = fma(-s, q0, x); return fma(r, t, q0); }
fn recip_exact(s: f32) -> f32 { let t0 = 1.0 / s; let t1 = fma(fma(-s, t0, 1.0), t0, t0); return fma(fma(-s, t1, 1.0), t1, t1); }
fn packNibbles(ob: u32, nib: ptr<function, array<u32, 32>>) {
  for (var w = 0u; w < 4u; w = w + 1u) {
    var word = 0u;
    for (var k = 0u; k < 4u; k = k + 1u) {
      let e = w * 4u + k;
      word = word | ((((*nib)[e] | ((*nib)[e + 16u] << 4u)) & 0xFFu) << (8u * k));
    }
    out_bits[ob * 4u + w] = word;
  }
}
fn writeQ4Sym(ob: u32, vals: ptr<function, array<f32, 32>>) {
  var amax = 0.0; var maxv = 0.0;
  for (var j = 0u; j < 32u; j = j + 1u) {
    let v = (*vals)[j];
    if (abs(v) > amax) { amax = abs(v); maxv = v; }
  }
  let d = maxv / -8.0;
  let id = select(0.0, recip_exact(d), d != 0.0);
  ss(ob, d);
  var q: array<u32, 32>;
  for (var j = 0u; j < 32u; j = j + 1u) {
    let x = (*vals)[j] * id + 8.5;
    q[j] = min(15u, u32(max(x, 0.0)));
  }
  packNibbles(ob, &q);
}
fn writeQ4Affine(ob: u32, vals: ptr<function, array<f32, 32>>) {
  var vmin = (*vals)[0]; var vmax = (*vals)[0];
  for (var j = 1u; j < 32u; j = j + 1u) {
    vmin = min(vmin, (*vals)[j]);
    vmax = max(vmax, (*vals)[j]);
  }
  let d1 = div_exact(vmax - vmin, 15.0, recip_exact(15.0));
  let id = select(0.0, recip_exact(d1), d1 != 0.0);
  ss(ob * 2u, d1);
  ss(ob * 2u + 1u, vmin + 8.0 * d1);
  var q: array<u32, 32>;
  for (var j = 0u; j < 32u; j = j + 1u) {
    let x = ((*vals)[j] - vmin) * id + 0.5;
    q[j] = min(15u, u32(max(x, 0.0)));
  }
  packNibbles(ob, &q);
}
fn scByte(base: u32, j: u32) -> u32 { return gbyte(base + 4u + j); }
fn getSM(base: u32, j: u32) -> vec2<u32> {
  if (j < 4u) { return vec2<u32>(scByte(base, j) & 63u, scByte(base, j + 4u) & 63u); }
  let dd = (scByte(base, j + 4u) & 0x0Fu) | ((scByte(base, j - 4u) >> 6u) << 4u);
  let mm = (scByte(base, j + 4u) >> 4u) | ((scByte(base, j) >> 6u) << 4u);
  return vec2<u32>(dd, mm);
}
fn q5val(qlw: u32, qhw: u32, m: u32, hi: bool, sbk: u32, dl: f32, ml: f32) -> f32 {
  let q = (qlw >> (8u * m)) & 0xFFu;
  let nibble = select(q & 0x0Fu, q >> 4u, hi);
  let hibit = ((((qhw >> (8u * m)) & 0xFFu) >> sbk) & 1u) * 16u;
  let p = dl * f32(nibble + hibit);
  return p - ml;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let sbk = bi % 8u; let base = sb * 176u;
  let d = f16at(base); let dmin = f16at(base + 2u);
  let sm = getSM(base, sbk);
  let dl = d * f32(sm.x); let ml = dmin * f32(sm.y);
  let qlOff = base + 48u + (sbk >> 1u) * 32u; let hi = (sbk & 1u) == 1u;
  var ql: array<u32, 8>; load32(qlOff, &ql);
  var qh: array<u32, 8>; load32(base + 16u, &qh);
  var vals: array<f32, 32>;
  for (var w = 0u; w < 8u; w = w + 1u) {
    let qlw = ql[w]; let qhw = qh[w];
    vals[w * 4u + 0u] = q5val(qlw, qhw, 0u, hi, sbk, dl, ml);
    vals[w * 4u + 1u] = q5val(qlw, qhw, 1u, hi, sbk, dl, ml);
    vals[w * 4u + 2u] = q5val(qlw, qhw, 2u, hi, sbk, dl, ml);
    vals[w * 4u + 3u] = q5val(qlw, qhw, 3u, hi, sbk, dl, ml);
  }
  writeQ4Affine(ob, &vals);
}`:`@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f32>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = v; }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn div_exact(x: f32, s: f32, t: f32) -> f32 { let q0 = x * t; let r = fma(-s, q0, x); return fma(r, t, q0); }
fn recip_exact(s: f32) -> f32 { let t0 = 1.0 / s; let t1 = fma(fma(-s, t0, 1.0), t0, t0); return fma(fma(-s, t1, 1.0), t1, t1); }
fn packNibbles(ob: u32, nib: ptr<function, array<u32, 32>>) {
  for (var w = 0u; w < 4u; w = w + 1u) {
    var word = 0u;
    for (var k = 0u; k < 4u; k = k + 1u) {
      let e = w * 4u + k;
      word = word | ((((*nib)[e] | ((*nib)[e + 16u] << 4u)) & 0xFFu) << (8u * k));
    }
    out_bits[ob * 4u + w] = word;
  }
}
fn writeQ4Sym(ob: u32, vals: ptr<function, array<f32, 32>>) {
  var amax = 0.0; var maxv = 0.0;
  for (var j = 0u; j < 32u; j = j + 1u) {
    let v = (*vals)[j];
    if (abs(v) > amax) { amax = abs(v); maxv = v; }
  }
  let d = maxv / -8.0;
  let id = select(0.0, recip_exact(d), d != 0.0);
  ss(ob, d);
  var q: array<u32, 32>;
  for (var j = 0u; j < 32u; j = j + 1u) {
    let x = (*vals)[j] * id + 8.5;
    q[j] = min(15u, u32(max(x, 0.0)));
  }
  packNibbles(ob, &q);
}
fn writeQ4Affine(ob: u32, vals: ptr<function, array<f32, 32>>) {
  var vmin = (*vals)[0]; var vmax = (*vals)[0];
  for (var j = 1u; j < 32u; j = j + 1u) {
    vmin = min(vmin, (*vals)[j]);
    vmax = max(vmax, (*vals)[j]);
  }
  let d1 = div_exact(vmax - vmin, 15.0, recip_exact(15.0));
  let id = select(0.0, recip_exact(d1), d1 != 0.0);
  ss(ob * 2u, d1);
  ss(ob * 2u + 1u, vmin + 8.0 * d1);
  var q: array<u32, 32>;
  for (var j = 0u; j < 32u; j = j + 1u) {
    let x = ((*vals)[j] - vmin) * id + 0.5;
    q[j] = min(15u, u32(max(x, 0.0)));
  }
  packNibbles(ob, &q);
}
fn scByte(base: u32, j: u32) -> u32 { return gbyte(base + 4u + j); }
fn getSM(base: u32, j: u32) -> vec2<u32> {
  if (j < 4u) { return vec2<u32>(scByte(base, j) & 63u, scByte(base, j + 4u) & 63u); }
  let dd = (scByte(base, j + 4u) & 0x0Fu) | ((scByte(base, j - 4u) >> 6u) << 4u);
  let mm = (scByte(base, j + 4u) >> 4u) | ((scByte(base, j) >> 6u) << 4u);
  return vec2<u32>(dd, mm);
}
fn q5val(qlw: u32, qhw: u32, m: u32, hi: bool, sbk: u32, dl: f32, ml: f32) -> f32 {
  let q = (qlw >> (8u * m)) & 0xFFu;
  let nibble = select(q & 0x0Fu, q >> 4u, hi);
  let hibit = ((((qhw >> (8u * m)) & 0xFFu) >> sbk) & 1u) * 16u;
  let p = dl * f32(nibble + hibit);
  return p - ml;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let sbk = bi % 8u; let base = sb * 176u;
  let d = f16at(base); let dmin = f16at(base + 2u);
  let sm = getSM(base, sbk);
  let dl = d * f32(sm.x); let ml = dmin * f32(sm.y);
  let qlOff = base + 48u + (sbk >> 1u) * 32u; let hi = (sbk & 1u) == 1u;
  var ql: array<u32, 8>; load32(qlOff, &ql);
  var qh: array<u32, 8>; load32(base + 16u, &qh);
  var vals: array<f32, 32>;
  for (var w = 0u; w < 8u; w = w + 1u) {
    let qlw = ql[w]; let qhw = qh[w];
    vals[w * 4u + 0u] = q5val(qlw, qhw, 0u, hi, sbk, dl, ml);
    vals[w * 4u + 1u] = q5val(qlw, qhw, 1u, hi, sbk, dl, ml);
    vals[w * 4u + 2u] = q5val(qlw, qhw, 2u, hi, sbk, dl, ml);
    vals[w * 4u + 3u] = q5val(qlw, qhw, 3u, hi, sbk, dl, ml);
  }
  writeQ4Affine(ob, &vals);
}`}},Ce={Q3_K:{spec:{id:"q3_k_to_lut",workgroupSize:64,buildWgsl:e=>e?`enable f16;
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f16>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = f16(v); }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn packNibbles(ob: u32, nib: ptr<function, array<u32, 32>>) {
  for (var w = 0u; w < 4u; w = w + 1u) {
    var word = 0u;
    for (var k = 0u; k < 4u; k = k + 1u) {
      let e = w * 4u + k;
      word = word | ((((*nib)[e] | ((*nib)[e + 16u] << 4u)) & 0xFFu) << (8u * k));
    }
    out_bits[ob * 4u + w] = word;
  }
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let k = bi % 8u; let base = sb * 110u;
  let d = f16at(base + 108u);
  let a0 = word32at(base + 96u);
  let a1 = word32at(base + 100u);
  let tmp = word32at(base + 104u);
  var aux = array<u32, 4>(
    (a0 & 0x0f0f0f0fu) | ((tmp & 0x03030303u) << 4u),
    (a1 & 0x0f0f0f0fu) | (((tmp >> 2u) & 0x03030303u) << 4u),
    ((a0 >> 4u) & 0x0f0f0f0fu) | (((tmp >> 4u) & 0x03030303u) << 4u),
    ((a1 >> 4u) & 0x0f0f0f0fu) | (((tmp >> 6u) & 0x03030303u) << 4u));
  let i0 = 2u * k; let i1 = 2u * k + 1u;
  let s0 = i32((aux[i0 >> 2u] >> (8u * (i0 & 3u))) & 0xFFu) - 32;
  let s1 = i32((aux[i1 >> 2u] >> (8u * (i1 & 3u))) & 0xFFu) - 32;
  ss(ob * 2u, d * f32(s0));
  ss(ob * 2u + 1u, d * f32(s1));
  let shift = 2u * (k & 3u);
  let qOff = base + 32u + (k / 4u) * 32u;
  let hm = 1u << k;
  var nib = array<u32, 32>();
  for (var l = 0u; l < 32u; l = l + 1u) {
    let q2 = (gbyte(qOff + l) >> shift) & 3u;
    nib[l] = q2 + select(0u, 4u, (gbyte(base + l) & hm) != 0u);
  }
  packNibbles(ob, &nib);
}`:`@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_scales: array<f32>;
struct Params { numBlocks: u32, blockOffset: u32, aux0: u32, aux1: u32 }
@group(0) @binding(3) var<uniform> params: Params;
fn ss(i: u32, v: f32) { out_scales[i] = v; }
fn sbyte(wordBase: u32, j: u32) -> u32 { return (src[wordBase + (j >> 2u)] >> (8u * (j & 3u))) & 0xFFu; }
fn gbyte(j: u32) -> u32 { return (src[j >> 2u] >> (8u * (j & 3u))) & 0xFFu; }
fn f16at(j: u32) -> f32 { return unpack2x16float(gbyte(j) | (gbyte(j + 1u) << 8u)).x; }
fn word32at(j: u32) -> u32 { return gbyte(j) | (gbyte(j + 1u) << 8u) | (gbyte(j + 2u) << 16u) | (gbyte(j + 3u) << 24u); }
fn load16(B: u32, out: ptr<function, array<u32, 4>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 4u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 4u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn load32(B: u32, out: ptr<function, array<u32, 8>>) {
  let wb = B >> 2u; let sh = (B & 3u) * 8u;
  if (sh == 0u) { for (var w = 0u; w < 8u; w = w + 1u) { (*out)[w] = src[wb + w]; } }
  else { let inv = 32u - sh; var prev = src[wb]; for (var w = 0u; w < 8u; w = w + 1u) { let cur = src[wb + 1u + w]; (*out)[w] = (prev >> sh) | (cur << inv); prev = cur; } }
}
fn b4(w: ptr<function, array<u32, 4>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn b8(w: ptr<function, array<u32, 8>>, k: u32) -> u32 { return ((*w)[k >> 2u] >> ((k & 3u) * 8u)) & 0xFFu; }
fn packNibbles(ob: u32, nib: ptr<function, array<u32, 32>>) {
  for (var w = 0u; w < 4u; w = w + 1u) {
    var word = 0u;
    for (var k = 0u; k < 4u; k = k + 1u) {
      let e = w * 4u + k;
      word = word | ((((*nib)[e] | ((*nib)[e + 16u] << 4u)) & 0xFFu) << (8u * k));
    }
    out_bits[ob * 4u + w] = word;
  }
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let bi = gid.x + gid.y * nwg.x * 64u;
  if (bi >= params.numBlocks) { return; }
  let ob = params.blockOffset + bi;
  let sb = bi / 8u; let k = bi % 8u; let base = sb * 110u;
  let d = f16at(base + 108u);
  let a0 = word32at(base + 96u);
  let a1 = word32at(base + 100u);
  let tmp = word32at(base + 104u);
  var aux = array<u32, 4>(
    (a0 & 0x0f0f0f0fu) | ((tmp & 0x03030303u) << 4u),
    (a1 & 0x0f0f0f0fu) | (((tmp >> 2u) & 0x03030303u) << 4u),
    ((a0 >> 4u) & 0x0f0f0f0fu) | (((tmp >> 4u) & 0x03030303u) << 4u),
    ((a1 >> 4u) & 0x0f0f0f0fu) | (((tmp >> 6u) & 0x03030303u) << 4u));
  let i0 = 2u * k; let i1 = 2u * k + 1u;
  let s0 = i32((aux[i0 >> 2u] >> (8u * (i0 & 3u))) & 0xFFu) - 32;
  let s1 = i32((aux[i1 >> 2u] >> (8u * (i1 & 3u))) & 0xFFu) - 32;
  ss(ob * 2u, d * f32(s0));
  ss(ob * 2u + 1u, d * f32(s1));
  let shift = 2u * (k & 3u);
  let qOff = base + 32u + (k / 4u) * 32u;
  let hm = 1u << k;
  var nib = array<u32, 32>();
  for (var l = 0u; l < 32u; l = l + 1u) {
    let q2 = (gbyte(qOff + l) >> shift) & 3u;
    nib[l] = q2 + select(0u, 4u, (gbyte(base + l) & hm) != 0u);
  }
  packNibbles(ob, &nib);
}`},lutId:4,per16:!0}},Ts={},zb=`
fn div_exact(x: f32, s: f32, t: f32) -> f32 { let q0 = x * t; let r = fma(-s, q0, x); return fma(r, t, q0); }
fn recip_exact(s: f32) -> f32 { let t0 = 1.0 / s; let t1 = fma(fma(-s, t0, 1.0), t0, t0); return fma(fma(-s, t1, 1.0), t1, t1); }`,po=`${zb}
fn r_half_up(x: f32) -> f32 { return floor(x + 0.5); }`;function Ob(e){return lo(`${e?`enable f16;
`:""}@group(0) @binding(0) var<storage, read> emb: array<f32>;
@group(0) @binding(1) var<storage, read_write> packed: array<u32>;
@group(0) @binding(2) var<storage, read_write> scales: array<${e?"f16":"f32"}>;
struct P { chunkRows: u32, cols: u32, rowOffset: u32 }
@group(0) @binding(3) var<uniform> params: P;
${po}
fn qi8(x: f32) -> i32 { return clamp(i32(r_half_up(x)), -127, 127); }
var<workgroup> wmax: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid3: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let localRow = wid.x + wid.y * nwg.x;
  if (localRow >= params.chunkRows) { return; }
  let row = params.rowOffset + localRow;
  let lid = lid3.x; let cols = params.cols; let rowOff = localRow * cols;
  var m = 0.0;
  for (var c = lid; c < cols; c = c + 256u) { m = max(m, abs(emb[rowOff + c])); }
  wmax[lid] = m; workgroupBarrier();
  for (var s = 128u; s > 0u; s = s >> 1u) { if (lid < s) { wmax[lid] = max(wmax[lid], wmax[lid + s]); } workgroupBarrier(); }
  let maxAbs = wmax[0];
  let scale = select(1.0, div_exact(maxAbs, 127.0, recip_exact(127.0)), maxAbs > 0.0);
  let inv = recip_exact(scale);
  if (lid == 0u) { scales[row] = ${e?"f16(scale)":"scale"}; }
  let cols4 = cols >> 2u;
  for (var c4 = lid; c4 < cols4; c4 = c4 + 256u) {
    let base = rowOff + c4 * 4u;
    let q0 = qi8(emb[base] * inv); let q1 = qi8(emb[base + 1u] * inv);
    let q2 = qi8(emb[base + 2u] * inv); let q3 = qi8(emb[base + 3u] * inv);
    packed[row * cols4 + c4] = (u32(q0) & 0xFFu) | ((u32(q1) & 0xFFu) << 8u) | ((u32(q2) & 0xFFu) << 16u) | ((u32(q3) & 0xFFu) << 24u);
  }
}`)}function Nb(e){return lo(`${e?`enable f16;
`:""}@group(0) @binding(0) var<storage, read> emb: array<f32>;
@group(0) @binding(1) var<storage, read_write> bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> scales: array<${e?"f16":"f32"}>;
struct P { chunkBlocks: u32, cols: u32, blkOffset: u32 }
@group(0) @binding(3) var<uniform> params: P;
${po}
fn nib(q: i32) -> u32 { return u32(clamp(q, 0, 15)); }
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let localBlk = gid.x + gid.y * nwg.x * 64u;
  if (localBlk >= params.chunkBlocks) { return; }
  let blk = params.blkOffset + localBlk;
  let blocksPerRow = params.cols >> 5u;
  let base = (localBlk / blocksPerRow) * params.cols + (localBlk % blocksPerRow) * 32u;
  var amax = 0.0; var vmax = 0.0;
  for (var j = 0u; j < 32u; j = j + 1u) { let v = emb[base + j]; let a = abs(v); if (a > amax) { amax = a; vmax = v; } }
  let d = vmax * -0.125;
  let id = select(0.0, recip_exact(d), d != 0.0);
  scales[blk] = ${e?"f16(d)":"d"};
  for (var w = 0u; w < 4u; w = w + 1u) {
    var word = 0u;
    for (var bb = 0u; bb < 4u; bb = bb + 1u) {
      let k = w * 4u + bb;
      let xlo = emb[base + k] * id; let xhi = emb[base + k + 16u] * id;
      let qlo = nib(i32(r_half_up(xlo)) + 8);
      let qhi = nib(i32(r_half_up(xhi)) + 8);
      word = word | (((qlo | (qhi << 4u)) & 0xFFu) << (bb * 8u));
    }
    bits[blk * 4u + w] = word;
  }
}`)}var Wb=32*1024*1024;async function Gb(e,t,r,a,s,n){let i=e.device.limits.maxComputeWorkgroupsPerDimension,u=a/4,o=a/32,l=e.empty("uint32",[r*u]),c=e.empty("float32",[r]),d=e.empty("uint32",[r*o*4]),f=e.empty(s?"float16":"float32",[r*o]),p=Math.max(1,Math.min(r,n??(Math.floor(Wb/(a*4))||1)));for(let m=0;m<r;m+=p){let h=Math.min(p,r-m),b=await t(m,h),g=b instanceof Float32Array?e.tensorFromTypedArray("float32",[h*a],b):b,v=e.createUniformU32([h,a,m,0],"embedQ8-params"),w=e.createUniformU32([h*o,a,m*o,0],"embedQ4-params");await e.runProgram({name:"com.xenova.transcode.embedQ8Rows",source:Ob(!1),entryPoint:"main",cacheKey:"com.xenova.transcode:embedQ8Rows:f32",bindings:[{tensor:g,type:"read-only-storage",binding:0},{tensor:l,type:"storage",binding:1},{tensor:c,type:"storage",binding:2},{buffer:v,type:"uniform",binding:3}],dispatchWorkgroups:[Math.min(h,i),Math.ceil(h/i),1]});let y=h*o,q=Math.ceil(y/64);await e.runProgram({name:"com.xenova.transcode.embedQ4Rows",source:Nb(s),entryPoint:"main",cacheKey:`com.xenova.transcode:embedQ4Rows:${s?"f16":"f32"}`,bindings:[{tensor:g,type:"read-only-storage",binding:0},{tensor:d,type:"storage",binding:1},{tensor:f,type:"storage",binding:2},{buffer:w,type:"uniform",binding:3}],dispatchWorkgroups:[Math.min(q,i),Math.ceil(q/i),1]}),await e.queueIdle(),g.destroy(),v.destroy?.(),w.destroy?.()}return{embedQ8:l,embedQ8Scales:c,lmHeadQ4:d,lmHeadQ4Scales:f}}function Rb(e=8*1024*1024){if(Ib())return()=>Promise.resolve();let t=0;return r=>(t+=r,t<e?Promise.resolve():(t=0,_s()))}function mo(){return{top:{},layers:[]}}function ho(e,t,r){let a=/^layers\.(\d+)\.(.+)$/.exec(t);if(!a){e.top[t]=r;return}let s=Number(a[1]);(e.layers[s]??={})[a[2]]=r}function go(e,t){let r=/^layers\.(\d+)\.(.+)$/.exec(t);return r?e.layers[Number(r[1])]?.[r[2]]:e.top[t]}function Hb(e,t,r){let a=null;return e.tensorByteRange?async(s,n)=>e.tensorByteRange(t,s*r,(s+n)*r):async(s,n)=>(a??=await e.tensorBytes(t),a.subarray(s*r,(s+n)*r))}var f2=4*Uint32Array.BYTES_PER_ELEMENT;function wo(e,t,r){let a=Number(e.device.limits.maxBufferSize),s=Number(e.device.limits.maxStorageBufferBindingSize);if(t%4!==0||t<=0||Number.isFinite(a)&&t>a||Number.isFinite(s)&&t>s)return null;let n=e.beginMappedTensorUpload("uint32",[t/4],`${r}.direct-source`);if(!n||n.destination.byteLength!==t){try{n?.abort()}catch{}return null}return{bytes:n.destination,commit:()=>n.commit(),rollback:i=>n.rollback(i),abort:()=>n.abort()}}function Ub(e){return e.slice(e.lastIndexOf(".")+1)}var Vb=new Set([S.Q1_0,S.Q2_0,S.TQ1_0,S.TQ2_0,S.IQ2_XXS,S.IQ2_XS,S.IQ2_S,S.IQ3_XXS,S.IQ3_S,S.IQ1_S,S.IQ1_M]);function Is(e){return e===S.Q4_0?4:Vb.has(e)?null:Mw(e)?8:null}var p2=new Set([S.Q4_K,S.Q4_1]);function bo(e,t,r,a,s,n){let i=Ub(e.id);if(!a.has(i)||s?.has(e.id)||n?.has(e.id))return!1;let u=r(e.name);return t.has(u)&&Is(t.info(u).type)!==null}function Qb(e,t,r,a,s,n){let i=!1,u=!0;for(let o of e)bo(o,t,r,a,s,n)&&(i=!0,Is(t.info(r(o.name)).type)!==4&&(u=!1));return i?u?4:8:null}function Kb(e,t,r,a){if(e.byteLength%wr!==0)throw new Error(`Q8_0 byte length ${e.byteLength} is not a multiple of ${wr}`);let s=e.byteLength/wr,n=new DataView(e.buffer,e.byteOffset,e.byteLength);for(let i=0;i<s;++i){let u=i*wr;r[a+i]=fe(n.getUint16(u,!0));let o=u+2;for(let l=0;l<8;++l){let c=0;for(let d=0;d<4;++d)c|=(e[o+l*4+d]&255)<<d*8;t[(a+i)*8+l]=c>>>0}}}function Xb(e){let t=e.length/aa,r=new Uint32Array(t*8),a=new Float32Array(t);for(let s=0;s<t;++s){let n=s*aa,i=0;for(let l=0;l<aa;++l){let c=Math.abs(e[n+l]);c>i&&(i=c)}let u=i/127,o=u>0?1/u:0;a[s]=u;for(let l=0;l<8;++l){let c=0;for(let d=0;d<4;++d){let f=Math.round(e[n+l*4+d]*o);f>127?f=127:f<-127&&(f=-127),c|=(f&255)<<d*8}r[s*8+l]=c>>>0}}return{bits:r,scales:a}}function Yb(e){switch(e){case S.Q4_K:return it.Q4_K;case S.Q6_K:return it.Q6_K;case S.Q5_K:return it.Q5_K;case S.Q3_K:return it.Q3_K;case S.Q2_K:return it.Q2_K;case S.IQ4_XS:return it.IQ4_XS;case S.IQ4_NL:return it.IQ4_NL;case S.Q5_0:return it.Q5_0;case S.Q5_1:return it.Q5_1;default:return null}}function Zb(e,t){return e===4?ce.Q4_0:t===S.Q8_0?ce.Q8_0:t===S.Q8_1?ce.Q8_1:t===S.Q8_K?ce.Q8_KQ8:Yb(t)}var Jb=8,xr=64*1024*1024;function ev(e,t){for(;t!==0;)[e,t]=[t,e%t];return e}function tv(e){for(let t=1;t<=8;++t){let r=t*ra;try{let a=sa(e,r);return{elementsPerSourceBlock:r,bytesPerSourceBlock:a,outputBlocksPerSourceBlock:t}}catch{}}throw new Error(`Cannot determine GGML source-block geometry for type ${e}`)}function rv(e,t,r,a=xr){if(!Number.isSafeInteger(t)||t<=0)throw new Error(`Invalid block-quant element count ${t}`);if(!Number.isSafeInteger(r)||r<=0)throw new Error(`Invalid block-quant byte length ${r}`);if(!Number.isSafeInteger(a)||a<=0)throw new Error(`Invalid block-quant chunk byte cap ${a}`);let s=Math.min(a,xr),n=tv(e);if(t%n.elementsPerSourceBlock!==0)throw new Error(`GGML type ${e} element count ${t} is not divisible by source block ${n.elementsPerSourceBlock}`);let i=t/n.elementsPerSourceBlock,u=i*n.bytesPerSourceBlock;if(u!==r)throw new Error(`GGML type ${e} byte length ${r} does not match expected ${u}`);let o=4/ev(n.bytesPerSourceBlock,4),l=Math.floor(s/n.bytesPerSourceBlock),c=l-l%o;if(c<=0&&i>l)throw new Error(`GGML type ${e} source block cannot form a 4-byte-aligned chunk within ${s} bytes`);let d=[],f=0;for(;f<i;){let p=i-f,m=p<=l?p:c,h=f*n.bytesPerSourceBlock,b=h+m*n.bytesPerSourceBlock;d.push({relBegin:h,relEnd:b,outputBlockBegin:f*n.outputBlocksPerSourceBlock,outputBlockCount:m*n.outputBlocksPerSourceBlock,directMappable:h%4===0&&b%4===0}),f+=m}return d}async function Sr({runtime:e,entries:t,gguf:r,nameToGGUF:a,signal:s,streamByteBudget:n},{routeName:i,include:u,guardElements:o=ra,bitsLength:l,scalesLength:c,scalesF16:d,metadataStorage:f="float",specForSlot:p,cpuFallback:m}){let h=mo(),b=mo(),g=new Set,v=[],w=0;for(let B of t){if(!u(B))continue;let F=a(B.name),z=r.info(F);if(z.elementCount%o!==0)throw new Error(`${i} tensor ${F} element count ${z.elementCount} not divisible by ${o}`);let W=z.elementCount/ra;ho(h,B.id,w),ho(b,B.id,W),g.add(B.id),v.push({gname:F,baseBlock:w,blocks:W,type:z.type}),w+=W}if(v.length===0)return null;let y=f==="float"&&d(v),q=new Map(v.map(B=>[B.gname,B])),k=Rb();if(v.every(B=>p(B)!==null)){let B=e.empty("uint32",[l(w)]),F=e.empty(f==="uint32"?"uint32":y?"float16":"float32",[c(w)]),z=new Map,W=new Pb,Y=[],L=[],N=0,R=async()=>{if(L.length===0)return;let C=L;L=[],N=0,await $b(e,C)},$=()=>{W.destroyAll();for(let{staging:C}of Y)C.destroy();Y=[]},x=async()=>{let C=Y;Y=[];for(let{destination:ue,staging:K}of C)try{await ue.rollback(K)}catch{}},_=async()=>{try{await e.queueIdle()}catch{}await x(),W.destroyAll()},T=async(C,ue,K,we,xe)=>{let Le=p(C);if(!K)return Cb(e,Le,ue,B,F,we,xe,y,z,W);let Ie=null;try{if(ue.buffer!==K.bytes.buffer||ue.byteOffset!==K.bytes.byteOffset||ue.byteLength!==K.bytes.byteLength)throw new Error(`Direct GGUF source bytes for ${C.gname} do not alias the destination`);let Ae=fo(e,Le,z);Ie=await K.commit();let Ve=co(e,Le,Ie,B,F,we,xe,y,Ae);return Y.push({destination:K,staging:Ie}),Ve}catch(Ae){if(Ie)try{await K.rollback(Ie)}catch{}else try{await K.abort()}catch{}throw Ae}},M=r.streamTensorRange?.bind(r),ie=M?v.filter(C=>r.info(C.gname).byteLength>xr):[],Te=new Set(ie.map(C=>C.gname)),Ue=ie.length===0?v:v.filter(C=>!Te.has(C.gname)),ut=r.supportsDirectDestinations===!0?new Map(Ue.flatMap(C=>{let ue=r.info(C.gname).byteLength;return ue%4!==0?[]:[[C.gname,()=>wo(e,ue,C.gname)]]})):void 0;try{Ue.length>0&&(await r.streamTensors(Ue.map(C=>C.gname),async(C,ue,K)=>{let we=q.get(C),xe=ue.byteLength;L.length>0&&N+xe>xr&&await R(),L.push(await T(we,ue,K,we.baseBlock,we.blocks)),N+=xe,(L.length>=Jb||N>=xr)&&await R(),await k(xe)},{signal:s,directDestinations:ut,byteBudget:n}),await R(),await e.queueIdle(),$());for(let C of ie){let ue=r.info(C.gname);for(let K of rv(C.type,ue.elementCount,ue.byteLength)){let we=!1,xe=r.supportsDirectDestinations===!0&&K.directMappable?()=>wo(e,K.relEnd-K.relBegin,`${C.gname}[${K.relBegin}:${K.relEnd}]`):void 0;if(await M(C.gname,K.relBegin,K.relEnd,async(Le,Ie)=>{if(we)throw new Error(`GGUF range stream delivered ${C.gname} chunk more than once`);we=!0;let Ae=Le.byteLength,Ve=K.relEnd-K.relBegin;if(Ae!==Ve)throw new Error(`GGUF range stream delivered ${Ae} bytes for ${C.gname}; expected ${Ve}`);try{L.push(await T(C,Le,Ie,C.baseBlock+K.outputBlockBegin,K.outputBlockCount)),await R(),await e.queueIdle()}catch(ht){for(let Me of L)Me.release();throw L=[],N=0,await _(),ht}$()},{signal:s,directDestination:xe}),!we)throw new Error(`GGUF range stream did not deliver ${C.gname} chunk`);await k(K.relEnd-K.relBegin)}}}catch(C){for(let ue of L)ue.release();throw L=[],N=0,await _(),B.destroy(),F.destroy(),C}return $(),{bits:B,scales:F,offsets:h,blockCounts:b,packedIds:g,layout:v}}if(!m){let B=v.find(F=>p(F)===null);throw new Error(`${i}: no transcode kernel for ${B.gname} (type ${B.type})`)}if(f==="uint32")throw new Error(`${i}: uint32 metadata routes require a GPU transcode kernel for every slot`);let D=new Uint32Array(l(w)),I=new Float32Array(c(w));return await r.streamTensors([...q.keys()],async(B,F)=>{m(q.get(B),F,D,I),await k(F.byteLength)},{signal:s}),{bits:e.tensorFromTypedArray("uint32",[D.length],D),scales:y?e.tensorFromTypedArray("float16",[I.length],Og(I)):e.tensorFromTypedArray("float32",[I.length],I),offsets:h,blockCounts:b,packedIds:g,layout:v}}async function av(e,{packSuffixes:t,excludeKq4Ids:r,forceDenseIds:a}){let{runtime:s,entries:n,gguf:i,nameToGGUF:u}=e,o=Qb(n,i,u,t,r,a);if(o===null)return null;let l=o,c=await Sr(e,{routeName:"packed",include:d=>bo(d,i,u,t,r,a),bitsLength:d=>d*l,scalesLength:d=>d,scalesF16:()=>s.device.features.has("shader-f16"),specForSlot:d=>Zb(o,d.type),cpuFallback:(d,f,p,m)=>{if(d.type===S.Q8_0)Kb(f,p,m,d.baseBlock);else{let h=ws(d.type,f);if(!h)throw new Error(`packQ4GGUFWeights: ${d.gname} type ${d.type} is not dequantizable`);let b=Xb(h);p.set(b.bits,d.baseBlock*8),m.set(b.scales,d.baseBlock)}}});return c&&{...c,packedQuantBits:o}}async function sv(e,{kq4Ids:t,scalesF16:r}){return await Sr(e,{routeName:"kq4",include:a=>t.has(a.id),bitsLength:a=>a*4,scalesLength:a=>a*2,scalesF16:()=>(r??!0)&&e.runtime.device.features.has("shader-f16"),specForSlot:a=>a.type===S.Q4_1?ce.Q4_1:a.type===S.Q5_K?Lb.Q5_K_TO_KQ4:ce.Q4_K})}var nv=new Set(["gate_proj","up_proj"]),m2=[{format:"q6_k",ggmlType:S.Q6_K,env:"Q6K_PACK",u32PerSuper:52,scalesPerSuper:1},{format:"q5_k",ggmlType:S.Q5_K,env:"Q5K_PACK",suffixes:nv,u32PerSuper:44,scalesPerSuper:2}];async function xt(e,{ids:t,spec:r,u32PerSuper:a,scalesPerSuper:s,scalesF16:n=!1,metadataStorage:i}){let u=r.metadataStorage??"float",o=i??u;if(o!==u)throw new Error(`k-super transcode ${r.id} declares ${u} metadata, not ${o}`);if(o==="uint32"&&n)throw new Error(`k-super transcode ${r.id} cannot combine uint32 metadata with f16 scale storage`);let l=await Sr(e,{routeName:"k-super",include:c=>t.has(c.id),guardElements:256,bitsLength:c=>c/8*a,scalesLength:c=>c/8*s,scalesF16:()=>n&&e.runtime.device.features.has("shader-f16"),metadataStorage:o,specForSlot:()=>r});return l&&{...l,u32PerSuper:a,scalesPerSuper:s,metadataStorage:o}}async function iv(e,{iqIds:t}){return await Sr(e,{routeName:"IQ",include:r=>t.has(r.id),bitsLength:r=>r*8,scalesLength:r=>r*2,scalesF16:()=>e.runtime.device.features.has("shader-f16"),specForSlot:r=>uv(r.type),cpuFallback:(r,a,s,n)=>{let i=Aw(r.type,a);s.set(i.bits,r.baseBlock*8),n.set(i.scales,r.baseBlock*2)}})}function uv(e){return e===S.Q2_0?ce.Q2_0IQ:e===S.TQ1_0?ce.TQ1_0IQ:e===S.TQ2_0?ce.TQ2_0IQ:e===S.IQ2_XXS?ce.IQ2_XXS:e===S.IQ2_XS?ce.IQ2_XS:e===S.IQ2_S?ce.IQ2_S:e===S.IQ3_S?ce.IQ3_S:e===S.IQ3_XXS?ce.IQ3_XXS:null}var ua=new Map([[S.IQ2_XXS,Ce.IQ2_XXS],[S.IQ2_XS,Ce.IQ2_XS],[S.IQ2_S,Ce.IQ2_S],[S.IQ3_XXS,Ce.IQ3_XXS],[S.IQ3_S,Ce.IQ3_S],[S.IQ4_NL,Ce.IQ4_NL],[S.IQ4_XS,Ce.IQ4_XS],[S.Q3_K,Ce.Q3_K],[S.MXFP4,Ce.MXFP4],[S.NVFP4,Ce.NVFP4],[S.IQ1_S,Ce.IQ1_S],[S.IQ1_M,Ce.IQ1_M]].filter(e=>e[1]!==void 0));function ov(e){if(ge("LUT_PACKS")==="0")return null;let t=ua.get(e);return t?{lutId:t.lutId,per16:t.per16}:null}async function vo(e,{lutIds:t,per16:r}){let{runtime:a,entries:s,gguf:n,nameToGGUF:i}=e,u=await Sr(e,{routeName:"LUT",include:l=>{if(!t.has(l.id))return!1;let c=i(l.name),d=n.info(c),f=ua.get(d.type);if(!f||f.per16!==r)throw new Error(`packLutGGUFWeights: ${c} type ${d.type} is not a per${r?16:32} LUT route`);return!0},bitsLength:l=>l*4,scalesLength:l=>l*(r?2:1),scalesF16:l=>a.device.features.has("shader-f16")&&l.every(c=>c.type===S.IQ4_NL),specForSlot:l=>ua.get(l.type).spec});if(u===null)return null;let o=new Map;for(let l of s)u.packedIds.has(l.id)&&o.set(l.id,ua.get(n.info(i(l.name)).type).lutId);return{...u,lutIds:o,lut16:r?1:0}}var h2=[{key:"iq1",iqRaw:1,ggmlType:S.IQ1_M,env:"IQ1_RAW",wordsPerBlock:2,pack:Ts.IQ1_M},{key:"iq2xxs",iqRaw:2,ggmlType:S.IQ2_XXS,env:"IQ2_RAW",wordsPerBlock:2,pack:Ts.IQ2_XXS},{key:"iq3xxs",iqRaw:3,ggmlType:S.IQ3_XXS,env:"IQ3_RAW",wordsPerBlock:3,pack:Ts.IQ3_XXS}];function lv(e,t,r=0){if(t%2!==0||t<=0||r<0||r+t>e)throw new Error(`interleaved rope needs an even rotaryDim with offset + rotaryDim <= headDim; got ${t} at ${r} of ${e}`);let a=t/2,s=new Uint32Array(e);for(let n=0;n<e;++n)s[n]=n;for(let n=0;n<a;++n)s[r+n]=r+2*n,s[r+n+a]=r+2*n+1;return s}var oa=/^blk\.\d+\.attn_(q|k)\.weight$/;function cv(e,t){let r=lv(t.head_dim,t.rotary_dim),a=o=>o.endsWith(".attn_q.weight")?t.num_attention_heads:t.num_key_value_heads,s=async(o,l)=>_o(await e.tensorBytes(o,l),e.info(o),a(o),t.head_dim,r),n=new Map,i=(o,l)=>{if(l?.signal)return s(o,l);let c=n.get(o);return c||(c=s(o),n.set(o,c)),c},u=async(o,l,c,d,f={})=>{let p=e.info(o);if(fv(p,l,c),!oa.test(o)){if(e.streamTensorRange){await e.streamTensorRange(o,l,c,d,f);return}Rt(f.signal);let h=await e.tensorByteRange(o,l,c,f);Rt(f.signal),await d(h),Rt(f.signal);return}la(p.byteLength,p,a(o),t.head_dim,r),Rt(f.signal);let m=(await i(o,f)).slice(l,c);Rt(f.signal),await d(m),Rt(f.signal)};return{get metadata(){return e.metadata},get supportsDirectDestinations(){return e.supportsDirectDestinations},names:()=>e.names(),has:o=>e.has(o),info:o=>e.info(o),tensorBytes:(o,l)=>oa.test(o)?i(o,l):e.tensorBytes(o,l),tensorByteRange:async(o,l,c,d)=>oa.test(o)?(await i(o,d)).subarray(l,c):e.tensorByteRange?e.tensorByteRange(o,l,c,d):(await e.tensorBytes(o,d)).subarray(l,c),...e.streamTensorRange||e.tensorByteRange?{streamTensorRange:u}:{},streamTensors:async(o,l,c)=>{let d=new Map;for(let p of o){if(!oa.test(p))continue;let m=e.info(p),h=a(p);la(m.byteLength,m,h,t.head_dim,r),d.set(p,{info:m,heads:h})}let f=o.filter(p=>!d.has(p));f.length>0&&await e.streamTensors(f,l,c),d.size>0&&await e.streamTensors([...d.keys()],async(p,m,h)=>{let b=d.get(p);if(!h){await l(p,_o(m,b.info,b.heads,t.head_dim,r));return}if(!dv(m,h.bytes))throw new Error(`${p}: direct rope destination does not exactly alias the streamed bytes`);mv(m,b.info,b.heads,t.head_dim,r),await l(p,m,h)},c)}}}function dv(e,t){return e.buffer===t.buffer&&e.byteOffset===t.byteOffset&&e.byteLength===t.byteLength}function fv(e,t,r){if(!Number.isSafeInteger(t)||!Number.isSafeInteger(r)||t<0||r<t)throw new RangeError(`Invalid byte range [${t}, ${r}) for tensor ${e.name}`);if(r>e.byteLength)throw new RangeError(`Byte range [${t}, ${r}) exceeds tensor ${e.name} size ${e.byteLength}`)}function Rt(e){if(e?.aborted)throw e.reason??new Error("aborted")}function la(e,t,r,a,s){if(t.shape.length!==2)throw new Error(`${t.name}: rope permutation needs a rank-2 tensor, got rank ${t.shape.length}`);if(!Number.isInteger(r)||r<=0||!Number.isInteger(a)||a<=0)throw new Error(`${t.name}: rope permutation needs positive integer heads/head_dim, got ${r}/${a}`);let[n,i]=t.shape;if(n!==r*a)throw new Error(`${t.name}: ${n} rows != ${r} heads * ${a} head_dim`);if(s.length!==a)throw new Error(`${t.name}: rope permutation has ${s.length} lanes, expected head_dim ${a}`);let u=new Uint8Array(a);for(let c=0;c<a;++c){let d=s[c];if(d>=a)throw new Error(`${t.name}: rope permutation source lane ${d} is outside head_dim ${a}`);if(u[d])throw new Error(`${t.name}: rope permutation source lane ${d} is duplicated`);u[d]=1}let o=sa(t.type,i),l=o*n;if(l!==t.byteLength)throw new Error(`${t.name}: metadata says ${t.byteLength} B, but ${n} rows x ${o} B = ${l} B`);if(e!==t.byteLength)throw new Error(`${t.name}: received ${e} B, expected ${t.byteLength} B`);return{rows:n,rowBytes:o}}function pv(e){let t=new Uint8Array(e.length),r=[];for(let a=0;a<e.length;++a){if(t[a])continue;let s=[],n=a;do t[n]=1,s.push(n),n=e[n];while(n!==a);s.length>1&&r.push(s)}return r}function _o(e,t,r,a,s){let{rowBytes:n}=la(e.byteLength,t,r,a,s),i=new Uint8Array(e.byteLength);for(let u=0;u<r;++u){let o=u*a*n;for(let l=0;l<a;++l){let c=o+s[l]*n;i.set(e.subarray(c,c+n),o+l*n)}}return i}function mv(e,t,r,a,s){let{rowBytes:n}=la(e.byteLength,t,r,a,s),i=pv(s),u=new Uint8Array(n);for(let o=0;o<r;++o){let l=o*a*n;for(let c of i){let d=l+c[0]*n;u.set(e.subarray(d,d+n));for(let f=0;f+1<c.length;++f){let p=l+c[f]*n,m=l+c[f+1]*n;e.copyWithin(p,m,m+n)}e.set(u,l+c[c.length-1]*n)}}return e}function hv(e){yo(e.owned)}function yo(e){for(let t of e)try{t.destroy()}catch{}}var ko=["attn_q","attn_gate","attn_k","attn_v","attn_output","ffn_gate","ffn_up","ffn_down"],gv=["attn_norm","attn_q_norm","attn_k_norm","post_attention_norm","ffn_norm","post_ffw_norm"];function wv(){return ge("MUSE_GLIMMER_Q2K")!=="0"}function bv(){return ge("MUSE_GLIMMER_Q3K")!=="0"}function As(){return ge("MUSE_GLIMMER_Q5K")!=="0"}function vv(){return ge("MUSE_GLIMMER_Q6K_EMBED")!=="0"}function Bs(){return ge("MUSE_GLIMMER_KQ4_F16")==="1"}function qr(){return ge("MUSE_GLIMMER_Q4KN")!=="0"&&!Bs()}function xo(){return qr()&&ge("MUSE_GLIMMER_Q4KN_COMPACT")!=="0"}async function _v(e,t,r,a={}){let s=ge("MUSE_GLIMMER_ROPE_PERMUTE")==="0"?t:cv(t,{head_dim:r.head_dim,rotary_dim:r.head_dim,num_attention_heads:r.num_attention_heads,num_key_value_heads:r.num_key_value_heads}),n=[],i=c=>(n.push(c),c),u=r.num_hidden_layers+2,o=0,l=c=>a.onProgress?.({processed:++o,total:u,name:c});try{let c=[];for(let m=0;m<r.num_hidden_layers;++m)c.push(await xv(e,s,r,m,i,a.signal)),l(`blk.${m}`);let d=await kv(e,s,r,i,a.signal);l("token_embd.weight");let f=i(await Eo(e,s,"output_norm.weight")),p=await js(e,s,i,[{id:"lm_head",name:"output.weight",length:r.vocab_size*r.hidden_size}],a.signal);return l("output.weight"),{embedBits:d.bits,embedScales:d.scales,embedFormat:d.format,layers:c,finalNorm:f,lmHead:p.get("lm_head"),owned:n}}catch(c){throw yo(n),c}}var yv={[S.Q4_1]:"q4_k",[S.Q4_0]:"q4_0"};function So(e,t){if(e===S.Q4_K){if(t%256!==0)throw new Error(`Muse Glimmer: Q4_K token_embd row width ${t} is not a multiple of 256`);return xo()?"q4_k_native_compact":qr()?"q4_k_native":"q4_k"}if(e===S.Q6_K){if(t%256!==0)throw new Error(`Muse Glimmer: Q6_K token_embd row width ${t} is not a multiple of 256`);return vv()?"q6_k":"q8_rows"}return yv[e]??"q8_rows"}async function kv(e,t,r,a,s){let n=t.info("token_embd.weight"),i=So(n.type,r.hidden_size);if(i==="q6_k"){let l={id:"token_embd",name:"token_embd.weight",length:r.vocab_size*r.hidden_size},c=await xt({runtime:e,entries:[l],gguf:t,nameToGGUF:m=>m,signal:s},{ids:new Set([l.id]),spec:ce.Q6_KN,u32PerSuper:52,scalesPerSuper:1,scalesF16:!1});if(!c)throw new Error("Muse Glimmer: token_embd.weight was not packed as q6_k");let d=a(c.bits),f=a(c.scales),p=go(c.offsets,l.id);if(p!==0)throw new Error(`Muse Glimmer: token_embd.weight must be packed at block 0, got ${String(p)}`);return{bits:d,scales:f,format:i}}if(i!=="q8_rows"){let l=(await js(e,t,a,[{id:"token_embd",name:"token_embd.weight",length:r.vocab_size*r.hidden_size}],s)).get("token_embd");if(!l)throw new Error("Muse Glimmer: token_embd.weight was not packed");if(l.blockOffset!==0)throw new Error(`Muse Glimmer: token_embd.weight must be packed at block 0, got ${l.blockOffset}`);return{bits:l.bits,scales:l.scales,format:i}}let u=Hb(t,"token_embd.weight",sa(n.type,r.hidden_size)),o=await Gb(e,async(l,c)=>$u(n.type,await u(l,c)),r.vocab_size,r.hidden_size,e.device.features.has("shader-f16"));return o.lmHeadQ4.destroy(),o.lmHeadQ4Scales.destroy(),{bits:a(o.embedQ8),scales:a(o.embedQ8Scales),format:"q8_rows"}}async function xv(e,t,r,a,s,n){let i=r.hidden_size,u={attn_q:[r.qDim,i],attn_gate:[r.qDim,i],attn_k:[r.kvDim,i],attn_v:[r.kvDim,i],attn_output:[i,r.qDim],ffn_gate:[r.intermediate_size,i],ffn_up:[r.intermediate_size,i],ffn_down:[i,r.intermediate_size]},o=ko.map(f=>({id:`layers.${a}.${f}`,name:`blk.${a}.${f}.weight`,length:u[f][0]*u[f][1]})),l=await js(e,t,s,o,n),c=f=>{let p=l.get(`layers.${a}.${f}`);if(!p)throw new Error(`Muse Glimmer: blk.${a}.${f}.weight was not packed`);return p},d=new Map;for(let f of gv)d.set(f,s(await Eo(e,t,`blk.${a}.${f}.weight`)));return{attnNorm:d.get("attn_norm"),qNorm:d.get("attn_q_norm"),kNorm:d.get("attn_k_norm"),postAttnNorm:d.get("post_attention_norm"),ffnNorm:d.get("ffn_norm"),postFfwNorm:d.get("post_ffw_norm"),q:c("attn_q"),gate:c("attn_gate"),k:c("attn_k"),v:c("attn_v"),o:c("attn_output"),ffnGate:c("ffn_gate"),ffnUp:c("ffn_up"),ffnDown:c("ffn_down")}}async function js(e,t,r,a,s){let n=[],i=[],u=[],o=[],l=[],c=[],d=[],f=[],p=[],m=[],h=[],b={kq4:n,q4kn:i,q4knc:u,q6k:o,q2k:l,q3k:c,q5k:d,lut32:f,lut16:p,iq:m,q8:h},g=e.device.features.has("shader-f16");for(let I of a){let B=t.info(I.name),F=B.type;if(F===S.Q4_K&&qr()&&B.shape[1]%256!==0)throw new Error(`Muse Glimmer: Q4_K linear ${I.name} row width ${B.shape[1]} is not a multiple of 256`);if(F===S.Q5_K&&As()&&B.shape[1]%256!==0)throw new Error(`Muse Glimmer: Q5_K linear ${I.name} row width ${B.shape[1]} is not a multiple of 256`);b[qo(Ms(F,g).format)].push(I)}let v=I=>I,w=I=>({runtime:e,entries:I,gguf:t,nameToGGUF:v,signal:s}),y=new Map,q=I=>{let[B,F]=t.info(I.name).shape;return[B,F]},k=(I,B,F)=>{if(I.length!==0){if(!B)throw new Error(`Muse Glimmer: ${F} pack produced no buffers for ${I.map(z=>z.name).join(", ")}`);r(B.bits),r(B.scales);for(let z of I){let W=go(B.offsets,z.id);if(W===void 0)throw new Error(`Muse Glimmer: ${z.name} missing from its ${F} pack`);let Y=B.lutIds?.get(z.id);if((F==="lut32"||F==="lut16")&&Y===void 0)throw new Error(`Muse Glimmer: ${z.name} missing its ${F} dequant table`);let[L,N]=q(z);y.set(z.id,{bits:B.bits,scales:B.scales,blockOffset:W,format:F,...Y===void 0?{}:{lut:Y},outFeatures:L,inFeatures:N})}}},D=new Set(a.map(I=>I.id.slice(I.id.lastIndexOf(".")+1)));if(h.length>0){let I=await av(w(h),{packSuffixes:D});k(h,I,I?.packedQuantBits===4?"q4_0":"q8_0")}return n.length>0&&k(n,await sv(w(n),{kq4Ids:new Set(n.map(I=>I.id)),scalesF16:Bs()}),"q4_k"),i.length>0&&k(i,await xt(w(i),{ids:new Set(i.map(I=>I.id)),spec:ce.Q4_KN,u32PerSuper:32,scalesPerSuper:6,scalesF16:!1}),"q4_k_native"),u.length>0&&k(u,await xt(w(u),{ids:new Set(u.map(I=>I.id)),spec:ce.Q4_KNC,u32PerSuper:32,scalesPerSuper:5,metadataStorage:"uint32"}),"q4_k_native_compact"),o.length>0&&k(o,await xt(w(o),{ids:new Set(o.map(I=>I.id)),spec:ce.Q6_KN,u32PerSuper:52,scalesPerSuper:1}),"q6_k"),l.length>0&&k(l,await xt(w(l),{ids:new Set(l.map(I=>I.id)),spec:ce.Q2_KN,u32PerSuper:20,scalesPerSuper:2,scalesF16:!0}),"q2_k"),c.length>0&&k(c,await xt(w(c),{ids:new Set(c.map(I=>I.id)),spec:ce.Q3_KN,u32PerSuper:28,scalesPerSuper:1,scalesF16:!1}),"q3_k"),d.length>0&&k(d,await xt(w(d),{ids:new Set(d.map(I=>I.id)),spec:ce.Q5_KN,u32PerSuper:44,scalesPerSuper:2,scalesF16:!1}),"q5_k"),f.length>0&&k(f,await vo(w(f),{lutIds:new Set(f.map(I=>I.id)),per16:!1}),"lut32"),p.length>0&&k(p,await vo(w(p),{lutIds:new Set(p.map(I=>I.id)),per16:!0}),"lut16"),m.length>0&&k(m,await iv(w(m),{iqIds:new Set(m.map(I=>I.id))}),"iq"),y}function qo(e){return e==="q4_k"?"kq4":e==="q4_k_native"?"q4kn":e==="q4_k_native_compact"?"q4knc":e==="q6_k"?"q6k":e==="q2_k"?"q2k":e==="q3_k"?"q3k":e==="q5_k"?"q5k":e==="lut32"||e==="lut16"||e==="iq"?e:"q8"}function Sv(e){let t=ov(e);return t?{format:t.per16?"lut16":"lut32",lut:t.lutId}:null}function Ms(e,t){if(e===S.Q4_K&&qr())return xo()?{format:"q4_k_native_compact",u32PerBlock:4,scalesPerBlock:5/8,scalesF16:!1,metadataStorage:"uint32"}:{format:"q4_k_native",u32PerBlock:4,scalesPerBlock:6/8,scalesF16:!1};if(e===S.Q4_K||e===S.Q4_1)return{format:"q4_k",u32PerBlock:4,scalesPerBlock:2,scalesF16:t&&Bs()};if(e===S.Q6_K)return{format:"q6_k",u32PerBlock:52/8,scalesPerBlock:1/8,scalesF16:!1};if(e===S.Q2_K&&wv())return{format:"q2_k",u32PerBlock:20/8,scalesPerBlock:2/8,scalesF16:t};if(e===S.Q3_K&&bv())return{format:"q3_k",u32PerBlock:28/8,scalesPerBlock:1/8,scalesF16:!1};if(e===S.Q5_K&&As())return{format:"q5_k",u32PerBlock:44/8,scalesPerBlock:2/8,scalesF16:!1};if(e===S.Q4_0)return{format:"q4_0",u32PerBlock:4,scalesPerBlock:1,scalesF16:t};let r=Sv(e);if(r)return{format:r.format,u32PerBlock:4,scalesPerBlock:r.format==="lut16"?2:1,scalesF16:!1,lut:r.lut};if(ju(e))return{format:"iq",u32PerBlock:8,scalesPerBlock:2,scalesF16:t};if(Is(e)!==null)return{format:"q8_0",u32PerBlock:8,scalesPerBlock:1,scalesF16:t};throw new Error(`Muse Glimmer: unsupported packed linear type ${e}`)}function qv(e,t,r){let a=e.device?.features?.has("shader-f16")??!1,s=[],n=b=>(s.push(b),b),i=(b,g)=>{let v=b.map(q=>{let k=r.info(q);if(k.type===S.Q4_K&&qr()&&k.shape[1]%256!==0)throw new Error(`Muse Glimmer: Q4_K linear ${q} row width ${k.shape[1]} is not a multiple of 256`);if(k.type===S.Q5_K&&As()&&k.shape[1]%256!==0)throw new Error(`Muse Glimmer: Q5_K linear ${q} row width ${k.shape[1]} is not a multiple of 256`);let D=Ms(k.type,a);return{name:q,info:k,geo:D,blocks:k.elementCount/32,route:qo(D.format)}}),w=new Map;for(let q of v){let k=w.get(q.route);k?k.push(q):w.set(q.route,[q])}let y=new Map;for(let[q,k]of w){let D=k.reduce((R,$)=>R+$.blocks,0),I=q==="q8"?k.every(R=>R.geo.format==="q4_0")?"q4_0":"q8_0":k[0].geo.format,B=I==="q8_0"?8:k[0].geo.u32PerBlock,F=k[0].geo.scalesPerBlock,z=k.every(R=>R.geo.scalesF16),W=k[0].geo.metadataStorage;if(!k.every(R=>R.geo.metadataStorage===W))throw new Error(`Muse Glimmer: mixed metadata storage in ${g}.${q}`);let Y=n(e.empty("uint32",[Math.ceil(D*B)],`${g}.${q}.bits`)),L=n(e.empty(W==="uint32"?"uint32":z?"float16":"float32",[Math.ceil(D*F)],`${g}.${q}.scales`)),N=0;for(let R of k){let[$,x]=R.info.shape;y.set(R.name,{bits:Y,scales:L,blockOffset:N,format:I,...R.geo.lut===void 0?{}:{lut:R.geo.lut},outFeatures:$,inFeatures:x}),N+=R.blocks}}return y},u=(b,g)=>n(e.empty("float32",[g],b)),o=[];for(let b=0;b<t.num_hidden_layers;++b){let g=`blk.${b}`,v=i(ko.map(y=>`${g}.${y}.weight`),g),w=y=>v.get(`${g}.${y}.weight`);o.push({attnNorm:u(`${g}.attn_norm.weight`,t.hidden_size),qNorm:u(`${g}.attn_q_norm.weight`,t.head_dim),kNorm:u(`${g}.attn_k_norm.weight`,t.head_dim),postAttnNorm:u(`${g}.post_attention_norm.weight`,t.hidden_size),ffnNorm:u(`${g}.ffn_norm.weight`,t.hidden_size),postFfwNorm:u(`${g}.post_ffw_norm.weight`,t.hidden_size),q:w("attn_q"),gate:w("attn_gate"),k:w("attn_k"),v:w("attn_v"),o:w("attn_output"),ffnGate:w("ffn_gate"),ffnUp:w("ffn_up"),ffnDown:w("ffn_down")})}let l=r.info("token_embd.weight").type,c=So(l,t.hidden_size),d=t.vocab_size*(t.hidden_size/32),f=c==="q8_rows"?t.vocab_size*(t.hidden_size/4):c==="q6_k"?d/8*52:d*4,p=c==="q8_rows"?t.vocab_size:c==="q6_k"?d/8:c==="q4_k_native"?d/8*6:c==="q4_k_native_compact"?d/8*5:d*(c==="q4_k"?2:1),m=c==="q4_k"&&Ms(l,a).scalesF16,h=c==="q4_k_native_compact"?"uint32":m?"float16":"float32";return{embedBits:n(e.empty("uint32",[f],"embed.bits")),embedScales:n(e.empty(h,[p],"embed.scales")),embedFormat:c,layers:o,finalNorm:u("output_norm.weight",t.hidden_size),lmHead:i(["output.weight"],"output.weight").get("output.weight"),owned:s}}async function Eo(e,t,r){let a=t.info(r),s=$u(a.type,await t.tensorBytes(r));return e.tensorFromTypedArray("float32",[s.length],s)}qe();var To=new Map;function Io(e){let t=To.get(e);if(t)return t;let r=hu(e);return To.set(e,r),r}var Ev=new Set;function Tv(e){Ev.add(e)}var Iv=new Set(["intermediate","output"]),Ao=class{tensors=[];nodes=[];aliases=[];boundNames=new Map;get nodeCount(){return this.nodes.length}input(e,t,r){return this.declareTensor("input",e,t,r)}weight(e,t,r){return this.declareTensor("weight",e,t,r)}state(e,t,r){return this.declareTensor("state",e,t,r)}stepInput(e,t,r){return this.declareTensor("stepInput",e,t,r)}uniform(e,t){if(t<=0||t%4!==0)throw new Error(`graph uniform "${e}" needs a positive multiple-of-4 byte length (got ${t})`);return this.declareTensor("uniform",e,"uint32",[t/4])}scratch(e,t,r){return this.declareTensor("intermediate",e,t,r)}view(e,t,r,a,s){if(e.view)throw new Error(`graph view "${e.name}" cannot itself be viewed (one level only)`);if(e.kind==="uniform")throw new Error(`graph uniform "${e.name}" cannot be viewed`);if(!Number.isInteger(t)||t<0)throw new Error(`graph view of "${e.name}" needs a non-negative integer elementOffset (got ${t})`);let n={id:this.tensors.length,kind:"intermediate",dtype:r,shape:[...a],name:s??`${e.name}.view@${t}`,view:{parent:e.id,elementOffset:t}};return this.tensors.push(n),n}op(e,t,r={}){let a=this.opFor(e),s={},n={};for(let[l,c]of Object.entries(t))if(c!==void 0){if(!Av(c))throw new Error(`${e}: binding "${l}" is not a graph tensor — scalars belong in options.args`);s[l]=c,n[l]=c.id}let i=a.inferOutputs(s,{args:r.args,attrs:r.attrs}),u={},o={};for(let[l,c]of Object.entries(i)){let d=t[l],f=Zt(c.dtype);if(d!==void 0){if(!Js(d.shape,c.shape))throw new Error(`${e}: output "${l}" bound to tensor "${d.name}" of shape [${d.shape}] but the manifest infers [${c.shape}]`);u[l]=d,o[l]=d.id;continue}let p=this.allocate("intermediate",`${e.split(".").pop()}.${l}#${this.nodes.length}`,f,c.shape);u[l]=p,o[l]=p.id}return this.nodes.push({op:e,inputs:n,outputs:o,...r.args?{args:{...r.args}}:{},...r.attrs?{attrs:{...r.attrs}}:{}}),u}alias(e,t){if(e.id===t.id)throw new Error(`alias: a tensor cannot alias itself ("${e.name}")`);for(let[s,n]of[["from",e],["to",t]])if(!Iv.has(n.kind))throw new Error(`alias: ${s} tensor "${n.name}" is ${n.kind}; only intermediate/output tensors can share a buffer`);if(e.dtype!==t.dtype)throw new Error(`alias("${e.name}","${t.name}"): dtype mismatch (${e.dtype} vs ${t.dtype})`);let r=ke(e.shape)*Oe(e.dtype),a=ke(t.shape)*Oe(t.dtype);if(r!==a)throw new Error(`alias("${e.name}","${t.name}"): byte-length mismatch (${r} vs ${a}); a shared buffer needs an exact-size fit`);this.aliases.push({from:e.id,to:t.id})}output(e,t){let r={...e,kind:"output",name:t??e.name};return this.tensors[e.id]=r,r}finish(e){return Object.freeze({name:e.name,params:Object.freeze({...e.params??{}}),tensors:Object.freeze([...this.tensors]),nodes:Object.freeze([...this.nodes]),...this.aliases.length>0?{aliases:Object.freeze([...this.aliases])}:{}})}opFor(e){return Io(e)}declareTensor(e,t,r,a){let s=this.boundNames.get(t);if(s)throw new Error(`graph tensor name "${t}" already declared (${s.kind})`);let n=this.allocate(e,t,r,a);return this.boundNames.set(t,n),n}allocate(e,t,r,a){if(!a.every(n=>Number.isInteger(n)&&n>=0))throw new Error(`graph tensor "${t}" has a non-integer shape [${a}]`);let s={id:this.tensors.length,kind:e,dtype:r,shape:[...a],name:t};return this.tensors.push(s),s}};function Av(e){return e!==null&&typeof e=="object"&&typeof e.id=="number"&&typeof e.dtype=="string"&&Array.isArray(e.shape)}qe(),qe();function Bv(e){let t=new Map;for(let h of e.tensors)t.set(h.id,h);let r=h=>t.get(h)?.view?.parent??h,a=new Map;for(let h of e.tensors)h.kind==="intermediate"&&!h.view&&a.set(h.id,h);let s=new Map,n=new Map,i=jv(e,t,s,n),u=new Map,o=new Map,l=new Map;e.nodes.forEach((h,b)=>{for(let g of Object.values(h.inputs)){let v=r(g);a.has(v)&&(o.has(v)||o.set(v,b),l.set(v,b))}for(let g of Object.values(h.outputs)){let v=r(g);a.has(v)&&(u.has(v)||u.set(v,b),l.set(v,b))}});let c=[],d=0,f=new Map;for(let h of a.values()){d+=St(h);let b=u.get(h.id),g=o.get(h.id);if(b===void 0&&g!==void 0)throw new Error(`graph "${e.name}": intermediate "${h.name}" (id ${h.id}) is read by node ${g} but no node produces it`);if(i.has(h.id))continue;if(b===void 0){c.push(h.name);continue}if(g!==void 0&&g<b)throw new Error(`graph "${e.name}": intermediate "${h.name}" (id ${h.id}) is read by node ${g} before it is produced by node ${b}; pooling cannot order that lifetime`);let v=l.get(h.id),w=f.get(v);w?w.push(h.id):f.set(v,[h.id])}let p=new Map;for(let h=0;h<e.nodes.length;++h){let b=f.get(h-1);if(b)for(let g of b){let v=s.get(g),w=n.get(v),y=p.get(w);y?y.push(v):p.set(w,[v])}for(let g of Object.values(e.nodes[h].outputs)){let v=r(g),w=a.get(v);if(!w||s.has(v))continue;let y=St(w),q=p.get(y)?.pop()??Bo(n,y);s.set(v,q)}}let m=0;for(let h of n.values())m+=h;return{slots:s,slotByteLengths:n,diagnostics:{intermediateCount:a.size,slotCount:n.size,naiveBytes:d,pooledBytes:m,deadTensors:c}}}function Bo(e,t){let r=e.size;return e.set(r,t),r}function jv(e,t,r,a){let s=new Set,n=e.aliases??[];if(n.length===0)return s;let i=new Map,u=c=>{let d=c;for(;i.get(d)!==d;)d=i.get(d);let f=c;for(;i.get(f)!==d;){let p=i.get(f);i.set(f,d),f=p}return d},o=c=>{i.has(c)||i.set(c,c)};for(let{from:c,to:d}of n){for(let[f,p]of[["from",c],["to",d]]){let m=t.get(p);if(!m)throw new Error(`graph "${e.name}": alias ${f} tensor id ${p} does not exist`);if(m.kind!=="intermediate"&&m.kind!=="output")throw new Error(`graph "${e.name}": alias ${f} tensor "${m.name}" is ${m.kind}; only intermediate/output tensors can share a buffer`)}o(c),o(d),i.set(u(c),u(d))}let l=new Map;for(let c of i.keys()){let d=u(c),f=l.get(d);f?f.push(c):l.set(d,[c])}for(let c of l.values()){let d=t.get(c[0]);for(let p of c){let m=t.get(p);if(m.dtype!==d.dtype)throw new Error(`graph "${e.name}": aliased tensors "${d.name}" (${d.dtype}) and "${m.name}" (${m.dtype}) must be the same dtype to share a buffer`);if(St(m)!==St(d))throw new Error(`graph "${e.name}": aliased tensors "${d.name}" (${St(d)} B) and "${m.name}" (${St(m)} B) must be the same byte length to share a buffer`)}let f=Bo(a,St(d));for(let p of c)r.set(p,f),s.add(p)}return s}function St(e){return ke(e.shape)*Oe(e.dtype)}qe();function jo(e,t,r){return Mo(e,t,r).selected!==null}function Mo(e,t,r){try{let a=e.explain({device:t},r);return{selected:a.selected,runnable:a.candidates.filter(s=>s.ok).map(s=>s.id)}}catch(a){return{selected:null,runnable:[],error:a instanceof Error?a.message:String(a)}}}function Do(e,t){return{...e,features:[...e.features,...t]}}function Mv(e,t,r){let a=new Set(t.features),s=Fr.filter(i=>!a.has(i));for(let i of s)if(jo(e,Do(t,[i]),r))return[i];let n=[];for(let i of s)if(n.push(i),jo(e,Do(t,n),r))return n;return[]}function ca(e){let t=e/1048576;return`${t.toFixed(t<1e4?1:0)} MB`}function $o(e,t){let r=Dt(t),a=rr(r),s=[],n=[...e.tensors??[]],i=new Set,u=new Set,o=new Set,l=new Set;for(let{op:f,request:p,id:m}of e.opRequests??[]){let h=m??f.manifest.id;o.add(h);let b=`${h}|${Zr(p)}`;if(i.has(b))continue;i.add(b);let{selected:g,runnable:v,error:w}=Mo(f,a,p);for(let D of v)l.add(`${h}#${D}`);if(g!==null)continue;if(w!==void 0){let D=`${h}|fault`;if(u.has(D))continue;u.add(D),s.push({kind:"feature",op:h,missingFeatures:[],message:`${h} could not be evaluated for this device: ${w}`});continue}let y=Mv(f,a,p),q=`${h}|${y.join(",")}`;if(u.has(q))continue;u.add(q);let k=y.map(D=>`"${D}"`).join(", ");s.push({kind:"feature",op:h,missingFeatures:y,message:y.length>0?`${h} needs WebGPU ${Hr(y.length,"feature")} ${k}, which this device lacks`:`${h} has no runnable variant on this device`})}let c=r.limits.maxBufferSize;if(typeof c=="number"){let f=new Set;for(let p of n){let m=ke(p.shape)*Oe(Zt(p.dtype));m<=c||f.has(m)||(f.add(m),s.push({kind:"buffer",tensor:p.name,bytes:m,limitBytes:c,message:`tensor ${p.name} needs a ${ca(m)} buffer, over this device's ${ca(c)} maxBufferSize`}))}}let d=r.limits.maxStorageBufferBindingSize;if(typeof d=="number"){let f=new Set;for(let p of n){if(!p.boundWhole)continue;let m=ke(p.shape)*Oe(Zt(p.dtype));m<=d||f.has(m)||typeof c=="number"&&m>c||(f.add(m),s.push({kind:"binding",tensor:p.name,bytes:m,limitBytes:d,message:`tensor ${p.name} needs a ${ca(m)} storage binding, over this device's ${ca(d)} maxStorageBufferBindingSize`}))}}return{ok:s.length===0,problems:s,reason:s.length>0?Dv(s):null,opIds:[...o],selectableVariants:[...l]}}function Dv(e){let t=[...new Set(e.flatMap(n=>n.missingFeatures??[]))],r=e.filter(n=>n.kind==="buffer"||n.kind==="binding"),a=t.length>0?`This GPU/browser is missing WebGPU ${Hr(t.length,"feature")} ${t.map(n=>`"${n}"`).join(", ")} that the model needs`:r[0]?.message??e[0].message,s=t.length>0&&r.length>0?" Some weights also exceed the device's buffer limits.":"";return`${a} — it can't run here.${s} Try Chrome or Edge with up-to-date GPU drivers.`}var g2=BigInt(1e8),w2=new TextDecoder("utf-8",{fatal:!0});qe();var $v=class{tensors=[];opRequests=[];#e=0;#t(e,t,r){return this.tensors.push({name:r??`buffer#${this.#e}`,dtype:e,shape:[...t],boundWhole:!0}),this.#e+=1,Sl(Zt(e),t)}recordSupportOp(e,t){this.opRequests.push({op:e,request:t})}asRuntime(e=null){let t=this;return{device:e,metadataOnly:!0,recordSupportOp:(r,a)=>t.recordSupportOp(r,a),empty:(r,a,s)=>t.#t(r,a,s),tensorFromTypedArray:(r,a)=>t.#t(r,a),allocateWeightsBuffer:({dtype:r,shape:a,label:s})=>t.#t(r,a,s),writeWeightsRange:()=>{},readTensor:async r=>new Float32Array(r.size??1),createUniformU32:()=>({destroy(){}}),host:{writeBuffer:()=>{}},runProgram:async()=>{},runProgramSequence:async()=>{},prepareProgramSequence:async()=>[],enqueuePreparedProgramSequence:()=>{},queueIdle:async()=>{},copyBufferToBuffer:()=>{},clearBuffers:()=>{}}}};function Fv(e,t,r){let a=e.recordSupportOp;return a?(a.call(e,t,r),!0):!1}async function Pv(e){let t=new $v,r=t.asRuntime(),a=await e.loadWeights(r);return await e.forward(r,a),{tensors:t.tensors,opRequests:t.opRequests}}function Cv(e){let t={tensors:e.flatMap(r=>r.tensors),opRequests:e.flatMap(r=>r.opRequests)};return r=>{let a=$o(t,r);if(a.ok||e.length<=1)return a;let s=e.map(u=>$o(u,r)),n=new Set,i=[];for(let u of s)for(let o of u.problems){let l=o.kind==="feature"?`feature:${o.op??""}:${(o.missingFeatures??[]).join(",")}`:`${o.kind}:${o.bytes??""}`;n.has(l)||(n.add(l),i.push(o))}return{...a,problems:i,reason:s.find(u=>u.reason)?.reason??a.reason}}}var Ds=new WeakMap;Tv(()=>{Ds=new WeakMap});var Lv=class{slots=new Map;rt;constructor(e){this.rt=e}resourcesForPlan(e){if(e.length===0)return{};let t=new Map,r={};for(let a of e){let s=JSON.stringify([a.dtype,a.shape]),n=t.get(s)??0;t.set(s,n+1);let i=this.slots.get(s);i||(i=[],this.slots.set(s,i));let u=i[n];u===void 0&&(u=this.rt.empty(a.dtype,a.shape,`webgpu-scratch-${a.id}`),i.push(u)),r[a.id]=u}return r}clear(){let e=[];for(let[t,r]of this.slots){for(let a=r.length-1;a>=0;--a){let s=r[a];try{s.destroy(),r.splice(a,1)}catch(n){e.push(n)}}r.length===0&&this.slots.delete(t)}Gt(e,"Collector scratch cleanup failed")}};function zv(e,t){let r=[e.manifest.id];for(let a of Object.keys(t.resources).sort()){let s=t.resources[a];if(s!==null&&typeof s=="object"&&"shape"in s&&"dtype"in s){let n=s;r.push(`${a}:[${n.shape.join(",")}]:${n.dtype}`)}else s==null?r.push(`${a}:-`):r.push(`${a}=${String(s)}`)}return r.push(`a:${JSON.stringify(t.args??{})}`),r.push(`t:${JSON.stringify(t.attrs??{})}`),r.push(`s:${JSON.stringify(t.sourceContext??{})}`),r.push(`u:${JSON.stringify(t.tunables??{})}`),r.join("|")}var Ov=class{programs=[];cleanups=[];scratchPool;rt;timing;preparedCache;collectMs=0;flushMs=0;constructor(e,t={}){if(this.rt=e,this.scratchPool=new Lv(e),this.timing=t.timing===!0,t.cachePrepared){let r=Ds.get(e);r||(r=new Map,Ds.set(e,r)),this.preparedCache=r}else this.preparedCache=null}add(e,t){if(Fv(this.rt,e,t))return;let r=this.timing?performance.now():0,a;if(this.preparedCache){let n=zv(e,t),i=this.preparedCache.get(n);i?a={program:i.program,plan:i.plan,request:t}:(a=e.prepare(this.rt,t),this.preparedCache.set(n,{program:a.program,plan:a.plan}))}else a=e.prepare(this.rt,t);let s=this.materialize(a);for(let n of s.programs)this.programs.push(n);return this.cleanups.push(s.cleanup),this.timing&&(this.collectMs+=performance.now()-r),a}get programCount(){return this.programs.length}programSlice(e,t){return this.programs.slice(e,t)}addPrepared(e,t,r){let a=this.materialize({program:e,plan:t,request:r});for(let s of a.programs)this.programs.push(s);this.cleanups.push(a.cleanup)}adoptMaterialized(e){for(let t of e)this.programs.push(t)}async buildSteps(){return this.rt.prepareProgramSequence(this.programs)}enqueue(e){this.rt.enqueuePreparedProgramSequence(e)}disposeBuild(){this.clearBuildResources()}async flush(e=!0){if(this.programs.length===0){this.clearBuildResources();return}let t=this.timing?performance.now():0;try{await this.rt.runProgramSequence(this.programs,{wait:e})}finally{this.timing&&(this.flushMs+=performance.now()-t),this.clearBuildResources()}}materialize(e){let t=this.scratchPool.resourcesForPlan(e.plan.scratches);return Ea(this.rt,e,{scratchResources:t})}clearBuildResources(){this.programs=[];let e=[],t=0;for(let r of this.cleanups)try{r()}catch(a){this.cleanups[t++]=r,e.push(a)}this.cleanups.length=t;try{this.scratchPool.clear()}catch(r){e.push(r)}Gt(e,"Program collector cleanup failed")}},$s=new WeakMap;function Nv(e,t){let r=Object.keys(e);if(r.length!==Object.keys(t).length)return!1;for(let a of r)if(e[a]!==t[a])return!1;return!0}function Wv(e,t){if(!e)return null;let r=$s.get(e);if(!r)throw new Error(`graph "${t.name}": sibling compile has no reusable plans (support-record compiles cannot seed siblings)`);if(r.graph!==t)throw new Error(`graph "${t.name}": sibling compiled a DIFFERENT graph object ("${r.graph.name}") — siblings must share one emitted graph`);return r}function Fo(e,t,r={},a={}){let s=a.pooling!==!1,n=Wv(a.sibling,e),i=n?.plan??Bv(e),u=s?{plan:i,slotTensors:new Map,shared:a.scratch??null}:null,o=new Map,l=new Map,c=new Map,d=new Map,f=[],p=[];try{for(let k of e.tensors){if(k.view){let I=o.get(k.view.parent);if(!I)throw new Error(`graph view "${k.name}" references unrealized parent id ${k.view.parent}`);let B=n&&n.realized.get(k.view.parent)===I?n.realized.get(k.id):Hv(I,k);o.set(k.id,B);continue}if(k.kind==="uniform"){let I=n?n.uniformById.get(k.id):t.createUniformU32(new Uint32Array(ke(k.shape)),`graph-uniform-${k.name}`);n||p.push(I),c.set(k.id,I),d.set(k.name,I);continue}let D=n&&k.kind!=="weight"&&k.kind!=="state"?n.realized.get(k.id)??null:Rv(k,e.name,t,r,f,u);D!==null&&(o.set(k.id,D),k.kind!=="intermediate"&&l.set(k.name,D))}}catch(k){Fs(k,null,f,p)}let m;try{m=new Ov(t,{cachePrepared:!0})}catch(k){Fs(k,null,f,p)}let h=new Map(e.tensors.map(k=>[k.id,k])),b=[],g=[],v=[],w=[];try{e.nodes.forEach((k,D)=>{let I=Io(k.op),B={};for(let[L,N]of Object.entries(k.inputs))B[L]=o.get(N)??c.get(N);for(let[L,N]of Object.entries(k.outputs))B[L]=o.get(N);let F={resources:B,...k.args?{args:{...k.args}}:{},...k.attrs?{attrs:{...k.attrs}}:{}},z=m.programCount;try{if(n){let L=n.nodePlans[D];Nv(n.nodeResources[D],B)?m.adoptMaterialized(n.nodePrograms[D]):m.addPrepared(L.program,L.plan,F),g.push(L),b.push(L.program.variant)}else{let L=m.add(I,F);g.push(L?{program:L.program,plan:L.plan}:null),b.push(L?.program.variant??null)}}catch(L){let N=Object.entries(B).map(([R,$])=>`${R}=[${$?.shape??"?"}]`).join(" ");throw new Error(`graph node ${k.op} (args ${JSON.stringify(k.args??{})}; ${N}): ${L.message}`,{cause:L})}v.push(B);let W=m.programSlice(z,m.programCount),Y=Gv(e.name,k.op,k,h,D);for(let L of W){if(!("source"in L))continue;let N=L;N.profile={...N.profile,...Y}}w.push(W)})}catch(k){Fs(k,m,f,p)}let y=s?i.diagnostics:{...i.diagnostics,slotCount:i.diagnostics.intermediateCount,pooledBytes:i.diagnostics.naiveBytes},q={collector:m,tensors:o,allocation:y,nodeVariants:b,tensor(k){let D=l.get(k);if(!D)throw new Error(`graph "${e.name}" has no bound tensor named "${k}"`);return D},uniformBuffer(k){let D=d.get(k);if(!D)throw new Error(`graph "${e.name}" has no uniform named "${k}"`);return D},async runEager(){await m.flush(!0)},buildSteps(k){if(!k)return m.buildSteps();let D=k.startNode??0,I=k.endNode??e.nodes.length;if(!Number.isInteger(D)||!Number.isInteger(I)||D<0||I<D||I>e.nodes.length)throw new Error(`graph "${e.name}": invalid node range [${D}, ${I}) for ${e.nodes.length} nodes`);let B=[];for(let F=D;F<I;++F)B.push(...w[F]);return B.length>0?t.prepareProgramSequence(B):Promise.resolve([])},dispose(){$s.delete(q),Po(m,f,p)}};return g.every(k=>k!==null)&&$s.set(q,{graph:e,plan:i,nodePlans:g,nodeResources:v,nodePrograms:w,realized:o,uniformById:c,uniformByName:d}),q}function Fs(e,t,r,a){try{Po(t,r,a)}catch(s){throw new AggregateError([e,s],"Model graph compilation and cleanup both failed")}throw e}function Po(e,t,r){let a=[];try{e?.disposeBuild()}catch(s){a.push(s)}Co(t,s=>s.destroy(),a),Co(r,s=>s.destroy?.(),a),Gt(a,"Model graph resource cleanup failed")}function Co(e,t,r){for(let a=e.length-1;a>=0;--a)try{t(e[a]),e.splice(a,1)}catch(s){r.push(s)}}function Gv(e,t,r,a,s){let n=null;for(let o of Object.values(r.inputs)){let l=a.get(o);if(l?.kind==="weight"){n=l.name.replace(/\.[^.]+$/,"");break}}if(!n){let o=Object.values(r.outputs)[0];n=o!==void 0?a.get(o)?.name??t:t}let i=n.match(/(?:^|\.)(\d+)(?:\.|$)/),u={phase:e,node:n,part:i?n.replace(/(^|\.)\d+(\.|$)/,(o,l,c)=>l&&c?".":""):n,graphNode:s};return i&&(u.layer=Number(i[1])),u}function Rv(e,t,r,a,s,n){if(n){let u=n.plan.slots.get(e.id);if(u!==void 0){let o=n.slotTensors.get(u);if(!o){let l=n.plan.slotByteLengths.get(u),c=()=>r.empty(e.dtype,e.shape,`graph-slot-${u}`);n.shared?o=n.shared.acquire(u,l,t,c):(o=c(),s.push(o)),n.slotTensors.set(u,o)}return Uv(o,e,n.plan.slotByteLengths.get(u))}if(e.kind==="intermediate")return null}switch(e.kind){case"weight":case"state":{let u=(e.kind==="weight"?a.weights:a.states)?.[e.name];if(!u)throw new Error(`graph ${e.kind} "${e.name}" has no binding`);return u}case"input":{let u=a.inputs?.[e.name];if(u===void 0)throw new Error(`graph input "${e.name}" has no binding`);if(Jt(u))return u;let o=r.tensorFromTypedArray(e.dtype,e.shape,u);return s.push(o),o}case"intermediate":case"stepInput":case"output":break}let i=r.empty(e.dtype,e.shape,`graph-${e.name}`);return s.push(i),i}function Hv(e,t){let r=ke(t.shape),a=Oe(t.dtype),s=(e.byteOffset??0)+t.view.elementOffset*a,n=r*a;if(s+n>(e.byteOffset??0)+e.byteLength)throw new Error(`graph view "${t.name}" exceeds its parent's range (${s}+${n} > ${e.byteLength})`);return{runtime:e.runtime,dtype:t.dtype,shape:t.shape,size:r,byteLength:n,byteOffset:s,buffer:e.buffer,destroy:en}}function Uv(e,t,r){let a=ke(t.shape),s=a*Oe(t.dtype);if(s!==r)throw new Error(`graph tensor "${t.name}" (${s} bytes) does not exactly fit slot of ${r} bytes`);return{runtime:e.runtime,dtype:t.dtype,shape:t.shape,size:a,byteLength:s,byteOffset:e.byteOffset??0,buffer:e.buffer,destroy:en}}function Vv(e,t,r){if(e!==1)return null;if(t.format==="q2_k"&&r.format==="q2_k")return{format:"q2_k",gateOffset:t.blockOffset,upOffset:r.blockOffset};let a=t.format==="q4_k_native"||t.format==="q4_k_native_compact"?t.format:null;if(ge("MUSE_GLIMMER_Q4KN_GATE_UP_FUSED")!=="0"&&a!==null&&r.format===a&&t.inFeatures===r.inFeatures&&t.outFeatures===r.outFeatures&&t.inFeatures%256===0&&t.blockOffset%8===0&&r.blockOffset%8===0&&t.bits===r.bits&&t.scales===r.scales)return{format:a,gateOffset:t.blockOffset,upOffset:r.blockOffset};let s=t.format==="q5_k"||t.format==="q6_k"?t.format:null;return ge("MUSE_GLIMMER_KSUPER_GATE_UP_FUSED")!=="0"&&s!==null&&r.format===s&&t.inFeatures===r.inFeatures&&t.outFeatures===r.outFeatures&&t.inFeatures%256===0&&t.blockOffset%8===0&&r.blockOffset%8===0&&t.bits===r.bits&&t.scales===r.scales?{format:s,gateOffset:t.blockOffset,upOffset:r.blockOffset}:ge("MUSE_GLIMMER_LUT_GATE_UP_FUSED")==="0"||t.format!=="lut32"||r.format!=="lut32"||t.lut===void 0||t.lut<1||t.lut>7||t.lut!==r.lut||t.inFeatures!==r.inFeatures||t.outFeatures!==r.outFeatures||t.bits!==r.bits||t.scales!==r.scales?null:{format:"lut32",gateOffset:t.blockOffset,upOffset:r.blockOffset,lut:t.lut}}var Qv=new Set(["q4_k_native","q4_k_native_compact","q2_k","q3_k","q5_k","q6_k"]);function Kv(e,t,r,a){if(ge("MUSE_GLIMMER_QKV_MERGED")==="0")return null;let s=[{role:"q",lin:e},{role:"gate",lin:t},{role:"k",lin:r},{role:"v",lin:a}],n=[],i=null;for(let{role:u,lin:o}of s)i!==null&&Qv.has(o.format)&&o.format===i.lead.format&&o.lut===i.lead.lut&&o.inFeatures===i.lead.inFeatures&&o.physical.bits===i.lead.physical.bits&&o.physical.scales===i.lead.physical.scales&&o.blockOffset===i.lead.blockOffset+i.outFeatures*(o.inFeatures/32)&&i?(i.members.push({role:u,colStart:i.outFeatures}),i.outFeatures+=o.outFeatures):(i&&n.push(i),i={lead:o,outFeatures:o.outFeatures,members:[{role:u,colStart:0}]});return i&&n.push(i),n.every(u=>u.members.length===1)?null:n}function Lo(e,t){let r={},a={},s=(l,c)=>(r[l]=c,e.weight(l,c.dtype,[...c.shape])),n=(l,c)=>({bits:s(`${l}.bits`,c.bits),scales:s(`${l}.scales`,c.scales),physical:c,blockOffset:c.blockOffset,format:c.format,...c.lut===void 0?{}:{lut:c.lut},outFeatures:c.outFeatures,inFeatures:c.inFeatures}),i=new Map,u=l=>{let c=i.get(l);if(c)return c;let d=`scalar.${i.size}`,f=e.input(d,"float32",[1]);return a[d]=new Float32Array([l]),i.set(l,f),f},o=t.layers.map((l,c)=>{let d=`L${c}`;return{attnNorm:s(`${d}.attn_norm`,l.attnNorm),qNorm:s(`${d}.q_norm`,l.qNorm),kNorm:s(`${d}.k_norm`,l.kNorm),postAttnNorm:s(`${d}.post_attn_norm`,l.postAttnNorm),ffnNorm:s(`${d}.ffn_norm`,l.ffnNorm),postFfwNorm:s(`${d}.post_ffw_norm`,l.postFfwNorm),q:n(`${d}.q`,l.q),k:n(`${d}.k`,l.k),v:n(`${d}.v`,l.v),gate:n(`${d}.gate`,l.gate),o:n(`${d}.o`,l.o),ffnGate:n(`${d}.ffn_gate`,l.ffnGate),ffnUp:n(`${d}.ffn_up`,l.ffnUp),ffnDown:n(`${d}.ffn_down`,l.ffnDown)}});return{graph:{embedBits:s("embed.bits",t.embedBits),embedScales:s("embed.scales",t.embedScales),embedFormat:t.embedFormat,layers:o,finalNorm:s("final_norm",t.finalNorm),lmHead:n("lm_head",t.lmHead),scalar:u},tensors:r,inputs:a}}function zo(e,t,r,a){let s=a.rows,n=a.tag,i=t.hidden_size,u=t.num_attention_heads,o=t.num_key_value_heads,l=t.head_dim,c=t.qDim,d=t.kvDim,f=t.intermediate_size,p=t.rms_norm_eps,m=t.post_norm_eps,h=($,x,_,T)=>{let M=e.scratch(T,"float32",[_,x.outFeatures]);return da(e,$,x,_,M,x.outFeatures,0),M},b=($,x,_,T,M,ie)=>e.op("co.huggingface.RMSNorm",{xT:$,...x?{wT:x}:{},yT:e.scratch(ie,"float32",[T,M])},{args:{rows:T,dim:M,eps:_}}).yT,g=($,x,_,T)=>{let M=e.scratch(T,"float32",[s,_*l]);return e.op("co.huggingface.RMSNorm",{xT:e.view($,0,"float32",[s*_,l],`${T}.in_head_rows`),wT:x,yT:e.view(M,0,"float32",[s*_,l],`${T}.out_head_rows`)},{args:{rows:s*_,dim:l,eps:p}}),M},v=e.scratch(`${n}.embed`,"float32",[s,i]);e.op("com.xenova.LlamaEmbed",{inputT:a.tokens,bitsT:r.embedBits,scalesT:r.embedScales,hiddenT:v},{args:{hiddenSize:i,vocabSize:t.vocab_size,seqLen:s,format:r.embedFormat}});let w=b(v,null,p,s,i,`${n}.embed_normed`),y=a.featureTaps,q=y?y.layers.length*i:0,k=new Map;y&&y.layers.forEach(($,x)=>{if(!Number.isInteger($)||$<0||$>=t.num_hidden_layers)throw new Error(`Muse Glimmer feature tap layer ${$} out of range [0, ${t.num_hidden_layers})`);let _=k.get($);_?_.push(x):k.set($,[x])});let D=ge("MUSE_GLIMMER_SANDWICH_FUSED")!=="0",I=D&&ge("MUSE_GLIMMER_SANDWICH_CHAIN")!=="0",B=null;for(let $=0;$<t.num_hidden_layers;++$){let x=y?k.get($):void 0;if(y&&x)for(let X of x)e.op("com.xenova.StridedCopy",{srcT:w,dstT:y.dstT},{args:{rows:s,srcStride:i,srcStart:0,dstStride:q,dstStart:X*i,copyCols:i}});let _=r.layers[$],T=t.layerSpecs[$],M=`${n}.L${$}`,ie=s===1&&ge("MUSE_GLIMMER_GQA_FUSED")!=="0",Te=B??b(w,_.attnNorm,p,s,i,`${M}.normed`);B=null;let Ue=ie?Kv(_.q,_.gate,_.k,_.v):null,ut={q:_.q,gate:_.gate,k:_.k,v:_.v},C={};if(Ue)for(let X of Ue)if(X.members.length===1){let be=X.members[0].role;C[be]={buf:h(Te,ut[be],s,`${M}.${be}`),off:0}}else{let be=`${M}.${X.members.map(Ke=>Ke.role).join("")}`,Vt=e.scratch(be,"float32",[s,X.outFeatures]);da(e,Te,{...X.lead,outFeatures:X.outFeatures},s,Vt,X.outFeatures,0);for(let Ke of X.members)C[Ke.role]={buf:Vt,off:Ke.colStart}}else C.q={buf:h(Te,_.q,s,`${M}.q`),off:0},C.k={buf:h(Te,_.k,s,`${M}.k`),off:0},C.v={buf:h(Te,_.v,s,`${M}.v`),off:0},C.gate={buf:h(Te,_.gate,s,`${M}.gate`),off:0};let ue=ie?C.q.buf:g(C.q.buf,_.qNorm,u,`${M}.q_normed`),K=ie?C.k.buf:g(C.k.buf,_.kNorm,o,`${M}.k_normed`);!ie&&T.isSliding&&(e.op("co.huggingface.RopeApply",{xT:ue,cosT:a.cos,sinT:a.sin},{args:{seq:s,heads:u,headDim:l,layout:"half"}}),e.op("co.huggingface.RopeApply",{xT:K,cosT:a.cos,sinT:a.sin},{args:{seq:s,heads:o,headDim:l,layout:"half"}}));let we=e.scratch(ie?`${M}.gated`:`${M}.attended`,"float32",[s,c]),xe=ie?e.view(C.q.buf,C.q.off,"float32",[1,s,c],`${M}.q_bsh`):e.view(ue,0,"float32",[1,s,c],`${M}.q_bsh`),Le=ie?e.view(C.k.buf,C.k.off,"float32",[1,s,d],`${M}.k_bsh`):e.view(K,0,"float32",[1,s,d],`${M}.k_bsh`),Ie=e.view(C.v.buf,C.v.off,"float32",[1,s,d],`${M}.v_bsh`),Ae=e.view(we,0,"float32",[1,s,c],`${M}.attended_bsh`);ie?e.op("com.xenova.NormedGatedGroupQueryAttention",{queryT:xe,keyT:Le,valueT:Ie,pastKeyT:a.caches[$].key,pastValueT:a.caches[$].value,presentKeyT:a.caches[$].key,presentValueT:a.caches[$].value,seqlensKT:a.seqlensK,qNormWeightT:_.qNorm,kNormWeightT:_.kNorm,gateT:e.view(C.gate.buf,C.gate.off,"float32",[1,s,c],`${M}.gate_bsh`),outputT:Ae,...T.isSliding?{cosCacheT:a.cos,sinCacheT:a.sin}:{}},{args:{numHeads:u,kvNumHeads:o,scale:t.attnScale,localWindowSize:T.isSliding?t.sliding_window:0,qkNormEpsilon:p,doRotary:T.isSliding?1:0}}):e.op("com.microsoft.GroupQueryAttention",{queryT:xe,keyT:Le,valueT:Ie,pastKeyT:a.caches[$].key,pastValueT:a.caches[$].value,presentKeyT:a.caches[$].key,presentValueT:a.caches[$].value,seqlensKT:a.seqlensK,totalSequenceLengthT:a.totalSequenceLength,outputT:Ae},{args:{numHeads:u,kvNumHeads:o,scale:t.attnScale,localWindowSize:T.isSliding?t.sliding_window:0}});let Ve=we;if(!ie){let X=e.op("ai.onnx.Sigmoid",{x:C.gate.buf,y:e.scratch(`${M}.gate_sig`,"float32",[s,c])}).y;Ve=e.op("ai.onnx.Mul",{a:we,b:X,c:e.scratch(`${M}.gated`,"float32",[s,c])}).c}let ht=h(Ve,_.o,s,`${M}.o`),Me;if(I)Me=e.scratch(`${M}.ffn_normed`,"float32",[s,i]),e.op("com.xenova.RmsNormResidualAdd",{xT:ht,wT:_.postAttnNorm,w2T:_.ffnNorm,yT:w,normed2T:Me},{args:{rows:s,dim:i,eps:m,eps2:p}});else if(D)e.op("com.xenova.RmsNormResidualAdd",{xT:ht,wT:_.postAttnNorm,yT:w},{args:{rows:s,dim:i,eps:m}}),Me=b(w,_.ffnNorm,p,s,i,`${M}.ffn_normed`);else{let X=b(ht,_.postAttnNorm,m,s,i,`${M}.o_normed`);e.op("com.xenova.Axpy",{xT:w,yT:X},{args:{count:s*i,alpha:1}}),Me=b(w,_.ffnNorm,p,s,i,`${M}.ffn_normed`)}let Qe,Be=Vv(s,_.ffnGate.physical,_.ffnUp.physical);if(Be){let X=e.scratch(`${M}.swiglu`,"float32",[f]),be=e.view(Me,0,"float32",[i],`${M}.ffn_normed_row`);e.op("com.xenova.LlamaDecodeGateUp",{normedT:be,bitsT:_.ffnGate.bits,scalesT:_.ffnGate.scales,...Be.format==="q2_k"?{upBitsT:_.ffnUp.bits,upScalesT:_.ffnUp.scales}:{},intermediateT:X},{args:{hiddenSize:i,intermediateSize:f,gateOffset:Be.gateOffset,upOffset:Be.upOffset,format:Be.format,...Be.lut===void 0?{}:{lut:Be.lut},...Be.format==="lut32"||Be.format==="q4_k_native"||Be.format==="q4_k_native_compact"?{strategy:"latency"}:{}}}),Qe=e.view(X,0,"float32",[1,f],`${M}.swiglu_row`)}else{let X=e.scratch(`${M}.gate_up`,"float32",[s,2*f]);da(e,Me,_.ffnGate,s,X,2*f,0),da(e,Me,_.ffnUp,s,X,2*f,f),Qe=e.op("co.huggingface.GatedMlpActivation",{xT:X,yT:e.scratch(`${M}.swiglu`,"float32",[s,f])},{args:{rows:s,mlpInner:f}}).yT}let Ut=h(Qe,_.ffnDown,s,`${M}.down`);if(I){let X=$===t.num_hidden_layers-1,be=e.scratch(X?`${n}.final_normed`:`${n}.L${$+1}.normed`,"float32",[s,i]);e.op("com.xenova.RmsNormResidualAdd",{xT:Ut,wT:_.postFfwNorm,w2T:X?r.finalNorm:r.layers[$+1].attnNorm,yT:w,normed2T:be},{args:{rows:s,dim:i,eps:m,eps2:p}}),B=be}else if(D)e.op("com.xenova.RmsNormResidualAdd",{xT:Ut,wT:_.postFfwNorm,yT:w},{args:{rows:s,dim:i,eps:m}});else{let X=b(Ut,_.postFfwNorm,m,s,i,`${M}.down_normed`);e.op("com.xenova.Axpy",{xT:w,yT:X},{args:{count:s*i,alpha:1}})}}let F=B??b(w,r.finalNorm,p,s,i,`${n}.final_normed`),z=a.head??"all";if(z==="none")return{logits:null,lastNormed:F};let W=z==="last"?1:s,Y=z==="last"&&s>1?e.view(F,(s-1)*i,"float32",[1,i],`${n}.last_row`):F,L=h(Y,r.lmHead,W,`${n}.logits_raw`),N=t.final_logit_softcapping;if(N===null)return t.output_multiplier!==1&&e.op("com.xenova.MulBroadcast",{xT:L,factorT:r.scalar(t.output_multiplier)},{args:{count:W*t.vocab_size,period:1}}),{logits:L,lastNormed:F};t.output_multiplier!==1&&e.op("com.xenova.MulBroadcast",{xT:L,factorT:r.scalar(t.output_multiplier)},{args:{count:W*t.vocab_size,period:1}}),e.op("com.xenova.MulBroadcast",{xT:L,factorT:r.scalar(1/N)},{args:{count:W*t.vocab_size,period:1}});let R=e.op("ai.onnx.Tanh",{x:L,y:e.scratch(`${n}.logits`,"float32",[W,t.vocab_size])}).y;return e.op("com.xenova.MulBroadcast",{xT:R,factorT:r.scalar(N)},{args:{count:W*t.vocab_size,period:1}}),{logits:R,lastNormed:F}}function Xv(e,t,r){if(e<=8||e>16)return 1;let a=Math.ceil(t/128),s=Math.min(8,Math.max(1,Math.ceil(120/a)));return Math.min(s,Math.max(1,Math.floor(r/32/8)))}function da(e,t,r,a,s,n,i){let u=Xv(a,r.outFeatures,r.inFeatures),o=u>1?{partialsT:e.scratch(`${s.name}.c${i}.partials`,"float32",[u*a*r.outFeatures])}:{};e.op("com.xenova.LlamaPrefillMatmul",{aT:t,bitsT:r.bits,scalesT:r.scales,yT:s,...o},{args:{M:a,inFeatures:r.inFeatures,outFeatures:r.outFeatures,blockOffset:r.blockOffset,format:r.format,...r.lut===void 0?{}:{lut:r.lut},...u>1?{kSplits:u}:{},outStride:n,dstColStart:i}})}var A=Math.fround,J=(e,t,r)=>A(e*t+r);function fa(e,t){let r=A(e+t),a=A(r-e);return{x:r,y:A(A(e-A(r-a))+A(t-a))}}function pa(e,t){let r=A(e.x+t),a=A(r-e.x);return{x:r,y:A(A(A(e.x-A(r-a))+A(t-a))+e.y)}}function Yv(e,t){let r=A(e.x+t.x),a=A(r-e.x),s=A(A(e.x-A(r-a))+A(t.x-a));return{x:r,y:A(s+A(e.y+t.y))}}function Oo(e,t){let r=A(e+t);return{x:r,y:A(A(e-r)+t)}}function Ps(e,t){let r=A(e+t.x);return{x:r,y:A(A(A(e-r)+t.x)+t.y)}}function Zv(e,t){let r=A(e.x+t);return{x:r,y:A(A(A(e.x-r)+t)+e.y)}}function Cs(e,t){let r=A(e.x+t.x);return{x:r,y:A(A(A(A(e.x-r)+t.x)+e.y)+t.y)}}function ma(e,t){let r=A(e.x*t);return{x:r,y:J(e.y,t,J(e.x,t,-r))}}function ha(e,t){let r=A(e.x*t.x);return{x:r,y:J(e.x,t.y,J(e.y,t.x,J(e.x,t.x,-r)))}}function No(e,t){return J(e.x,t.x,J(e.y,t.x,A(e.x*t.y)))}function ga(e){let t=A(e.x*e.x);return{x:t,y:J(A(e.x+e.x),e.y,J(e.x,e.x,-t))}}function Jv(e,t){let r=A(1/t.x),a=A(e.x*r),s=J(r,e.x,-a),n=J(-t.y,r,J(-t.x,r,1));return{x:a,y:J(a,n,J(e.y,r,s))}}function e_(e){let t=A(e.x+e.y);return{x:t,y:A(A(e.x-t)+e.y)}}function t_(e,t){return{x:A(e.x*t),y:A(e.y*t)}}var Ls=new Float32Array(1),Wo=new Uint32Array(Ls.buffer);function Go(e){return Ls[0]=e,Wo[0]}function zs(e){return Wo[0]=e>>>0,Ls[0]}function r_(e){let t=Go(e);return t=t>>>23&255,t-127}function a_(e,t){return zs(Go(e)+(t<<23)|0)}function s_(e,t){let r=t>>31;r=(r+t>>6)-r<<4,t=t-(r<<2),r+=127,r=r>0?r:0,r=r>255?255:r;let a=zs(r<<23>>>0);return e=A(A(A(A(e*a)*a)*a)*a),a=zs(t+127<<23>>>0),A(e*a)}function wa(e){let t=Math.floor(e),r=e-t;return r>.5?t+1:r<.5||t%2===0?t:t+1}var n_=A(1.4426950408889634),i_=A(.693145751953125),u_=A(1428606765330187e-21),Ro=A(.3183098861837907),Ho=A(3.1414794921875),Uo=A(.0001131594181060791),Vo=A(1984187258941006e-24),o_=11754943508222875e-54;function l_(e){let t=e<o_;t&&(e=A(e*A(2**32)*A(2**32)));let r=r_(A(e*A(1/.75))),a=a_(e,-r);t&&(r-=64);let s=Jv(fa(-1,a),fa(1,a)),n=ga(s),i=A(.2403203547000885);i=J(i,n.x,A(.2851126790046692)),i=J(i,n.x,A(.4000079929828644));let u={x:A(.6666666269302368),y:A(36918386125961433e-25)},o=ma({x:A(.6931471824645996),y:A(-1904654323148236e-24)},r);return o=Cs(o,t_(s,2)),o=Cs(o,ha(ha(n,s),Yv(ma(n,i),u))),o}function c_(e){let t=wa(A(A(e.x+e.y)*n_)),r=t|0,a=pa(e,A(t*-i_));a=pa(a,A(t*-u_)),a=e_(a);let s=A(.0013632464688271284);s=J(s,a.x,A(.00836596917361021)),s=J(s,a.x,A(.04167108237743378)),s=J(s,a.x,A(.16666552424430847)),s=J(s,a.x,A(.49999985098838806));let n=Cs(a,ma(ga(a),s));n=Ps(1,n);let i=A(n.x+n.y);return i=s_(i,r),e.x<-104&&(i=0),i}function d_(e,t){return t===0||e===1?1:c_(ma(l_(Math.abs(A(e))),A(t)))}function f_(e){if(e=A(e),!(Math.abs(e)<125))return A(Math.sin(e));let t=wa(A(e*Ro)),r=t|0,a=J(t,-Ho,e),s=fa(a,A(t*-Uo));s=Zv(s,A(t*-Vo));let n=s,i=ga(s),u=A(26083159809786594e-22);u=J(u,i.x,A(-.00019810690719168633)),u=J(u,i.x,A(.00833307858556509));let o=Ps(1,ha(Oo(A(-.16666659712791443),A(u*i.x)),i)),l=No(n,o);return(r&1)===1&&(l=-l),e===0&&1/e===-1/0&&(l=e),l}function p_(e){if(e=A(e),!(Math.abs(e)<125))return A(Math.cos(e));let t=J(wa(J(e,Ro,-.5)),2,1),r=wa(t)|0,a=fa(e,A(t*A(-Ho*.5)));a=pa(a,A(t*A(-Uo*.5))),a=pa(a,A(t*A(-Vo*.5)));let s=a,n=ga(a),i=A(26083159809786594e-22);i=J(i,n.x,A(-.00019810690719168633)),i=J(i,n.x,A(.00833307858556509));let u=Ps(1,ha(Oo(A(-.16666659712791443),A(i*n.x)),n)),o=No(s,u);return(r&2)===0&&(o=-o),o}var Qo=new Map;function m_(e){let t=Math.fround,r=e.head_dim,a=t(e.rope_theta),s=`${r}:${a}`,n=Qo.get(s);if(!n){let i=r>>1;n=new Float32Array(i);for(let u=0;u<i;++u){let o=t(t(2*u)/t(r));n[u]=t(1/d_(a,o))}Qo.set(s,n)}return n}function Ko(e,t,r=0){let a=Math.fround,s=e.head_dim>>1,n=new Float32Array(t*s),i=new Float32Array(t*s),u=m_(e);for(let o=0;o<t;++o){let l=a(r+o);for(let c=0;c<s;++c){let d=a(l*u[c]);n[o*s+c]=p_(d),i[o*s+c]=f_(d)}}return{cos:n,sin:i}}var Ht=512;async function Xo(e,t,r,a){let s=a.tokens.length;if(s<1)throw new Error("museGlimmerForward needs at least one token");if(s>Ht)throw new Error(`museGlimmerForward chunk cap is ${Ht} tokens, got ${s}`);let n=a.positionOffset,i=n+s;if(i>a.cache.maxLength)throw new Error(`Muse Glimmer cache holds ${a.cache.maxLength} positions, needs ${i}`);let{cos:u,sin:o}=Ko(t,s,n),l=t.head_dim/2,c=new Ao,d=c.input("tokens","uint32",[s]),f=c.input("rope.cos","float32",[s,l]),p=c.input("rope.sin","float32",[s,l]),m=c.input("seqlens_k","int32",[1]),h=c.input("total_seq","int32",[1]),b=Lo(c,r),g=Array.from({length:t.num_hidden_layers},(B,F)=>({key:c.state(`cache.${F}.k`,"float32",[1,t.num_key_value_heads,a.cache.maxLength,t.head_dim]),value:c.state(`cache.${F}.v`,"float32",[1,t.num_key_value_heads,a.cache.maxLength,t.head_dim])})),v=a.taps,w=v?c.scratch("taps.features","float32",[s,v.layers.length*t.hidden_size]):null,{logits:y}=zo(c,t,b.graph,{tokens:d,cos:f,sin:p,rows:s,caches:g,seqlensK:m,totalSequenceLength:h,head:a.head,...v&&w?{featureTaps:{layers:v.layers,dstT:w}}:{},tag:"S"});y!==null&&c.output(y,"logits");let q=v&&w?v.emit(c,{featuresT:w,cosT:f,sinT:p,rows:s,position:n}):null,k=c.finish({name:"muse-glimmer-forward",params:{T:s}}),D={};for(let B=0;B<t.num_hidden_layers;++B)D[`cache.${B}.k`]=a.cache.key[B],D[`cache.${B}.v`]=a.cache.value[B];let I=Fo(k,e,{weights:q?{...b.tensors,...q.weights}:b.tensors,states:q?{...D,...q.states}:D,inputs:{...b.inputs,tokens:Uint32Array.from(a.tokens),"rope.cos":u,"rope.sin":o,seqlens_k:Int32Array.from([i-1]),total_seq:Int32Array.from([i])}});try{return await I.runEager(),y===null?new Float32Array(0):Float32Array.from(await e.readTensor(I.tensor("logits")))}finally{I.dispose()}}function h_(e,t,r){let a=e.tensors.find(n=>n.kind==="uniform"&&n.name===t);if(!a)throw new Error(`graphUniformPacker: graph "${e.name}" has no uniform "${t}"`);let s=[];if(e.nodes.forEach((n,i)=>{for(let[u,o]of Object.entries(n.inputs))o===a.id&&s.push(...g_(n.op,u,r?.[i]??null))}),s.length===0)throw new Error(`graphUniformPacker: no op reads uniform "${t}" in graph "${e.name}"`);return w_(s,`${e.name}.${t}`,a.shape[0])}var Yo=new Map;function g_(e,t,r=null){let a=`${e}\0${t}\0${r??""}`,s=Yo.get(a);if(s)return s;let n=hu(e),i=[];for(let u of n.manifest.variants)if(!(r!==null&&u.id!==r))for(let o of u.passes)for(let l of o.bindings){if(l.buffer?.type!=="uniform"||!l.struct||l.arg!==t&&l.name!==t)continue;let c=l.struct.fields.map(d=>{if(d.type!=="u32"&&d.type!=="i32"&&d.type!=="f32")throw new Error(`${e}#${u.id}: uniform field ${d.name} has non-scalar type ${d.type} — step packers cover scalar structs only`);return{name:d.name,kind:d.type}});i.push({source:`${e}#${u.id}/${o.id}`,fields:c})}return Yo.set(a,i),i}function w_(e,t,r){let a=e[0];for(let f of e)f.fields.length>a.fields.length&&(a=f);for(let f of e)f.fields.forEach((p,m)=>{let h=a.fields[m];if(p.name!==h.name||p.kind!==h.kind)throw new Error(`stepUniformPacker(${t}): ${f.source} declares field ${m} "${p.name}: ${p.kind}" but ${a.source} declares "${h.name}: ${h.kind}" — ops sharing one override buffer must agree on a common field prefix`)});let s=Math.max(4,Math.ceil(a.fields.length/4)*4);if(r!==void 0&&r!==s)throw new Error(`stepUniformPacker(${t}): g.uniform declares ${r*4} bytes but the struct (${a.fields.map(f=>f.name).join(", ")}) packs to ${s*4}`);let n=new ArrayBuffer(s*4),i=new Uint32Array(n),u=new Int32Array(n),o=new Float32Array(n),l=new Map(a.fields.map((f,p)=>[f.name,{...f,index:p}])),c=a.fields.filter(f=>!f.name.startsWith("_")).length,d=()=>a.fields.map(f=>f.name).join(", ");return Object.assign(f=>{let p=0;for(let m of Object.keys(f)){let h=l.get(m);if(!h)throw new Error(`stepUniformPacker(${t}): unknown field "${m}" (struct: ${d()})`);h.kind==="f32"?o[h.index]=f[m]:h.kind==="i32"?u[h.index]=f[m]:i[h.index]=f[m],p+=1}if(p!==c){let m=a.fields.filter(h=>!h.name.startsWith("_")&&!(h.name in f)).map(h=>h.name);throw new Error(`stepUniformPacker(${t}): missing field(s) ${m.join(", ")} (struct: ${d()})`)}return i},{fields:new Set(a.fields.map(f=>f.name))})}var b_=class{steps=[];prefillSteps=null;chainedSteps=null;get stepCount(){return this.steps.length}get prefillStepCount(){return(this.prefillSteps??this.steps).length}get chainedStepCount(){return(this.chainedSteps??this.steps).length}async step(e,t){return this.writeStepInputs(e,t),this.collector.enqueue(this.steps),(await this.runtime.readTensor(this.idsTensor))[0]}submitStep(e,t){return this.writeStepInputs(e,t),this.collector.enqueue(e===null?this.chainedSteps??this.steps:this.steps),this.runtime.readTensor(this.idsTensor).then(r=>r[0])}enqueueStep(e,t,{full:r=!1}={}){this.writeStepInputs(e,t),this.collector.enqueue(r?this.steps:this.prefillSteps??this.steps)}async replayKnownInputs(e,t){for(let r=0;r<e.length;++r)this.enqueueStep(e[r],t+r);await this.runtime.queueIdle()}finish(){}measureGpuMs(){return this.runtime.measurePreparedSequenceGpuMs?this.runtime.measurePreparedSequenceGpuMs(this.chainedSteps??this.steps):Promise.resolve(null)}},v_=class extends b_{#e=null;get compiled(){if(!this.#e)throw new Error("Graph decode session is not built");return this.#e}set compiled(e){this.#e=e}detachCompiled(e){this.#e===e&&(this.#e=null)}get collector(){return this.compiled.collector}get idsTensor(){return this.compiled.tensor("input_ids")}dispose(){this.#e?.dispose(),this.#e=null}};function __(e,t){if(t===void 0)return null;let r=e.nodes.length-t;if(!Number.isInteger(t)||t<=0||r<=0)throw new Error(`graph "${e.name}": next-token tail must be a positive proper suffix (got ${t} of ${e.nodes.length} nodes)`);return r}function y_(e,t){try{t.dispose()}catch(r){throw new AggregateError([e,r],"Graph session build and cleanup both failed")}throw e}var k_=class extends v_{model;cache;emission;#e;#t=new Map;constructor(e,t){super(),this.model=e,this.cache=t}stepUniformPack(e){let t=this.#t.get(e);return t||(t=h_(this.#e,e,this.compiled.nodeVariants),this.#t.set(e,t)),t}get runtime(){return this.model.runtime}async prepareBuild(){}onCompiled(){}async build(e,{fuse:t=!1}={}){await this.prepareBuild();let{emission:r,graph:a}=this.buildGraph(e,t),s=r.nextTokenTailNodeCount,n=r.gpuChainedPrefixNodeCount,i=__(a,s);if(n!==void 0&&(!Number.isInteger(n)||n<=0||n>=(i??a.nodes.length)))throw new Error(`graph "${a.name}": GPU-chained prefix must be a positive proper prefix of the reusable body (got ${n} of ${i??a.nodes.length} body nodes)`);let u=Fo(a,this.runtime,{weights:r.weights,states:r.states,...r.inputs?{inputs:r.inputs}:{}});this.emission=r,this.#e=a,this.#t.clear(),this.compiled=u;try{if(i===null)this.prefillSteps=null,this.steps=await u.buildSteps(),this.chainedSteps=n===void 0?null:await u.buildSteps({startNode:n});else{let o=n===void 0?[]:await u.buildSteps({endNode:n}),l=await u.buildSteps({...n!==void 0?{startNode:n}:{},endNode:i}),c=await u.buildSteps({startNode:i});if(l.length===0||c.length===0||n!==void 0&&o.length===0)throw new Error(`graph "${a.name}": next-token tail split produced an empty prepared sequence`);this.prefillSteps=[...o,...l],this.steps=[...this.prefillSteps,...c],this.chainedSteps=n===void 0?null:[...l,...c]}this.onCompiled()}catch(o){this.steps=[],this.prefillSteps=null,this.chainedSteps=null,this.#t.clear(),this.detachCompiled(u),y_(o,u)}}writeStepInputs(e,t){e!==null&&this.runtime.host.writeBuffer(this.compiled.tensor("input_ids").buffer,0,new Uint32Array([e])),this.writeStepUniforms(t)}};function x_(e,t,r){let{config:a,weights:s}=e,n=a.head_dim/2,i=new Ao,u=i.stepInput("input_ids","uint32",[1]),o=i.stepInput("rope.cos","float32",[1,n]),l=i.stepInput("rope.sin","float32",[1,n]),c=i.stepInput("seqlens_k","int32",[1]),d=i.stepInput("total_seq","int32",[1]),f=Lo(i,s),p=Array.from({length:a.num_hidden_layers},(b,g)=>({key:i.state(`cache.${g}.k`,"float32",[1,a.num_key_value_heads,t.maxLength,a.head_dim]),value:i.state(`cache.${g}.v`,"float32",[1,a.num_key_value_heads,t.maxLength,a.head_dim])})),{logits:m}=zo(i,a,f.graph,{tokens:u,cos:o,sin:l,rows:1,caches:p,seqlensK:c,totalSequenceLength:d,tag:"D"});if(m===null)throw new Error("decode emission always keeps the lm_head");i.op("ai.onnx.ArgMax",{x:m,y:u},{attrs:{axis:-1,keepdims:0,select_last_index:0}}),i.output(m,"logits");let h={};for(let b=0;b<a.num_hidden_layers;++b)h[`cache.${b}.k`]=t.key[b],h[`cache.${b}.v`]=t.value[b];return{graph:i.finish({name:"muse-glimmer-decode",params:{T:1,positionOffset:r}}),weights:f.tensors,states:h,inputs:f.inputs}}var Zo=class extends k_{cosT;sinT;seqlensT;totalT;buildGraph(e){let t=x_(this.model,this.cache,e);return{emission:t,graph:t.graph}}onCompiled(){this.cosT=this.compiled.tensor("rope.cos"),this.sinT=this.compiled.tensor("rope.sin"),this.seqlensT=this.compiled.tensor("seqlens_k"),this.totalT=this.compiled.tensor("total_seq")}writeStepUniforms(e){let t=this.runtime.host,{cos:r,sin:a}=Ko(this.model.config,1,e);t.writeBuffer(this.cosT.buffer,0,r),t.writeBuffer(this.sinT.buffer,0,a),t.writeBuffer(this.seqlensT.buffer,0,Int32Array.from([e])),t.writeBuffer(this.totalT.buffer,0,Int32Array.from([e+1]))}};async function Jo(e,t){let r=await Pv({loadWeights:async a=>qv(a,e,t),forward:async(a,s)=>{let n={runtime:a,config:e,weights:s},i=ia.allocate(a,e,ia.defaultCapacity(e));await new Zo(n,i).build(0);for(let u of[Ht,2])await Xo(a,e,s,{tokens:new Array(u).fill(0),cache:i,positionOffset:0,head:"last"})}});return Cv([r])}var S_=()=>{throw new Error("This feature is not included in this bundle.")},q_=S_,E_=class{#e=!1;#t;constructor(e){this.#t=e}get config(){return this.#t.config}async checkDeviceSupport(e){return await this.#t.checkSupport(e)}async unsupportedReason(e){return(await this.#t.checkSupport(e)).reason}async load(e,t={}){if(this.#e)throw new Error("prepared model has already been loaded or closed");this.#e=!0;try{let r=this.#t.loadWeights(e,t),a=Promise.resolve(this.#t.checkSupport(e.device)),[s,n]=await Promise.allSettled([a,r]);if(s.status==="fulfilled"&&s.value.reason)throw n.status==="fulfilled"&&n.value?.dispose?.(),new Error(s.value.reason);if(n.status==="rejected")throw n.reason;if(s.status==="rejected")throw n.value?.dispose?.(),s.reason;return n.value}finally{await this.#t.closeSource()}}async close(){this.#e||(this.#e=!0,await this.#t.closeSource())}};function el(e,t,r,a){let s=t.configFromGGUF(e);return new E_({config:s,checkSupport:n=>t.checkSupport(s,n,e),loadWeights:(n,{signal:i})=>t.loadWeights(n,e,s,{onProgress:r,signal:i}),closeSource:a})}async function T_(e,t,r){let a=await Zu.open(e,t);try{return el(a,r,t.onProgress??null,()=>a.close())}catch(s){throw await a.close(),s}}function I_(e,t,r){return el(e,r,t.onProgress??null,async()=>{})}async function A_(e){let{readFile:t}=await Promise.resolve().then(()=>(gn(),Ia));return new yr(await t(e))}function B_(e){let t=(a,s={})=>T_(a,s,e(s)),r=(a,s)=>I_(s.gguf,{onProgress:s.onProgress},e(s)).load(a);return{prepare:t,async load(a,s,n={}){return(await t(s,n)).load(a,{signal:n.signal})},async loadGGUFFile(a,s,n={}){return r(a,{...n,gguf:await A_(s)})},loadGGUF:r}}function j_(e,t){if(!Number.isSafeInteger(e.maxLength)||e.maxLength<1)throw new Error(`generation cache maxLength must be a positive safe integer, got ${e.maxLength}`);if(e.maxLength<t)throw new Error(`generation requires ${t} cache tokens, but maxLength is ${e.maxLength}`)}function M_(e,...t){let r=[];for(let a of t)try{a.release(e)}catch(s){r.push(s)}try{e.dispose()}catch(a){r.push(a)}Gt(r,"Generation cache and bound sessions failed to dispose")}var D_=class{runtime;config;weights;constructor(e){this.runtime=e.runtime,this.config=e.config,this.weights=e.weights}releaseGenerationState(e){e.cache.dispose()}async*streamTokenIds(e){let t=Na(e.input_ids),r=On(t.length,e.max_new_tokens),a=this.createGenerationState({maxLength:e.generation_state?.maxLength,max_length:e.generation_state?.max_length,minimumCapacity:r}),s=[];try{yield*this.generateTokens(t,a.cache,e)}catch(n){throw s.push(n),n}finally{try{this.releaseGenerationState(a)}catch(n){throw s.length>0?new AggregateError([...s,n],"Causal generation and state cleanup both failed"):n}}}async*streamTokenIdsFromCache(e){let t=e.generation_state?.cache;if(!t)throw new Error(`${this.constructor.name} streamTokenIdsFromCache requires generation_state.cache`);let r=Na(e.input_ids),a=t.get_seq_length()+r.length,s=On(a,e.max_new_tokens);j_(t,s),yield*this.generateTokens(r,t,e)}async generate(e){let t=[];for await(let r of this.streamTokenIds(e))t.push(r);return[[...Na(e.input_ids),...t]]}},$_=class{#e=new Map;#t=!1;#r;constructor(e=t=>t.dispose()){this.#r=e}getOrBuild(e,t){if(this.#t)return Promise.reject(new Error("SessionPool is closed"));let r=this.#e.get(e);if(r?.state==="dispose-failed")return Promise.reject(new Error("SessionPool entry cannot be reused until its failed disposal is retried"));if(r)return r.promise;let a,s=Promise.resolve().then(()=>{if(a.invalidation)throw a.invalidation;return t()}).then(n=>{if(a.invalidation){let i=a.invalidation;try{this.#r(n)}catch(u){throw new AggregateError([i,u],"Invalidated session build and cleanup both failed")}throw i}return a.state="ready",a.session=n,n}).catch(n=>{throw this.#e.get(e)===a&&this.#e.delete(e),n});return a={state:"building",promise:s},this.#e.set(e,a),s}release(e){let t=this.#e.get(e);if(t){if(t.state==="building"){this.#e.delete(e),t.invalidation=new Error("SessionPool entry was released while its session was building");return}try{this.#r(t.session),this.#e.delete(e)}catch(r){throw t.state="dispose-failed",r}}}disposeAll(){this.#s("SessionPool was disposed while its session was building")}close(){this.#t=!0,this.#s("SessionPool was closed while its session was building")}#s(e){let t=[];for(let[r,a]of this.#e){if(a.state==="building"){this.#e.delete(r),a.invalidation=new Error(e);continue}try{this.#r(a.session),this.#e.delete(r)}catch(s){a.state="dispose-failed",t.push(s)}}Gt(t,"Multiple pooled sessions failed to dispose")}},F_=ge("MUSE_GLIMMER_PIPELINE")==="0"?1:4,ba=B_(()=>{let e=null;return{configFromGGUF:t=>oo(t),checkSupport:async(t,r,a)=>(e??=Jo(t,a)).then(s=>s(r)),loadWeights:async(t,r,a,s)=>new tl({runtime:t,config:a,weights:await _v(t,r,a,{...s.onProgress?{onProgress:s.onProgress}:{},...s.signal?{signal:s.signal}:{}})})}}),tl=class extends D_{static ConfigClass=io;static MODEL_NAME="Muse Glimmer";#e=new $_;#t=null;static prepare=ba.prepare;static load=ba.load;static loadGGUF=ba.loadGGUF;static loadGGUFFile=ba.loadGGUFFile;async attachMtpDraft(e){if(this.#t)throw new Error("Muse Glimmer: a draft model is already attached");this.#t=await q_(this,e)}createGenerationState(e={}){let t=ia.resolveCapacity(this.config,e);return{cache:ia.allocate(this.runtime,this.config,t)}}releaseGenerationState(e){M_(e.cache,this.#e,...this.#t?[this.#t]:[])}async*generateTokens(e,t,r){if(this.#t?.active){yield*this.#t.generate(e,t,r,s=>this.#r(s));return}let a=this.config.vocab_size;yield*sd({cache:t,eosTokenId:this.config.eosTokenIds(),pipelineDepth:Wa(r,F_,ar),prefill:async(s,n)=>{let i=null,u=n;for(let l=0;l<s.length;l+=Ht){let c=Array.from(s.slice(l,l+Ht)),d=l+Ht>=s.length;i=await Xo(this.runtime,this.config,this.weights,{tokens:c,cache:t,positionOffset:u,head:d?"last":"none"}),u+=c.length}let o=0;for(let l=1;l<a;++l)i[l]>i[o]&&(o=l);return o},beginDecode:()=>this.#r(t)},e,r)}#r(e){return this.#e.getOrBuild(e,async()=>{let t=new Zo(this,e);return await t.build(e.get_seq_length()),t})}async warmup(e){e.maxLength<3||await ad(this,e,[Math.min(8,e.maxLength-2)])}dispose(){this.#e.disposeAll(),this.#t?.dispose(),this.#t=null,hv(this.weights)}},P_={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"};function qt(e){return String(e).replace(/[&<>"']/g,t=>P_[t])}function rl(e){let t=["B","KB","MB","GB"],r=e,a=0;for(;r>=1024&&a<t.length-1;)r/=1024,a++;let s=a===3?2:r>=10||a===0?0:1;return`${r.toFixed(s)} ${t[a]}`}function C_(e){return e.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>").replace(/`([^`]+?)`/g,"<code>$1</code>")}function L_(e){let t=document.createElement("template");return t.innerHTML=e,t.content.querySelectorAll("script,style,iframe,object,embed,link,meta,form").forEach(r=>r.remove()),t.content.querySelectorAll("*").forEach(r=>{for(let a of[...r.attributes]){let s=a.name.toLowerCase();(s.startsWith("on")||(s==="href"||s==="src")&&/^\s*(javascript|data):/i.test(a.value))&&r.removeAttribute(a.name)}}),t.innerHTML}var z_=new Set(["fn","let","var","const","const_assert","struct","if","else","for","loop","return","break","continue","switch","case","default","while","override","enable","requires","discard","alias","true","false","workgroup","storage","uniform","function","private","read","write","read_write","bitcast"]),O_=new Set(["u32","i32","f32","f16","bool","vec2","vec3","vec4","mat2x2","mat3x3","mat4x4","mat2x3","mat3x2","mat2x4","mat4x2","mat3x4","mat4x3","array","atomic","ptr","sampler"]),al=/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(@[A-Za-z_]\w*)|([A-Za-z_]\w*)|(\d[\w.]*)|(\s+)|([\s\S])/g;function sl(e){let t="";al.lastIndex=0;let r;for(;r=al.exec(e);){let[a,s,n,i,u,o]=r;if(s)t+=`<span class="k-cm">${qt(s)}</span>`;else if(n)t+=`<span class="k-at">${qt(n)}</span>`;else if(i){let l=z_.has(i)?"k-kw":O_.has(i)?"k-ty":null;t+=l?`<span class="${l}">${i}</span>`:qt(i)}else u?t+=`<span class="k-nu">${qt(u)}</span>`:o?t+=o:t+=qt(a)}return t}var N_=/^(P|UL|OL|LI|BLOCKQUOTE|H[1-6]|PRE|CODE|EM|STRONG)$/;function nl(e={}){let t=e.caretClassName??"caret",r=null,a=null,s=new Map,n=null,i=null,u=!1,o=0;function l(g,v){let w=(v?"d:":"i:")+g,y=s.get(w);if(y===void 0){try{y=a.renderToString(g.trim(),{throwOnError:!1,displayMode:v})}catch{y=qt(g)}s.set(w,y)}return y}function c(g,v){let w=l(g,v);return n?`<\!--katex:${n.push(w)-1}-->`:w}function d(){let g={name:"katexInline",level:"inline",start(w){return w.match(/\\\(/)?.index},tokenizer(w){let y=/^\\\(([\s\S]+?)\\\)/.exec(w);if(y)return{type:"katexInline",raw:y[0],text:y[1]}},renderer(w){return c(w.text,!1)}},v={name:"katexBlock",level:"inline",start(w){return w.match(/\\\[/)?.index},tokenizer(w){let y=/^\\\[([\s\S]+?)\\\]/.exec(w);if(y)return{type:"katexBlock",raw:y[0],text:y[1]}},renderer(w){return c(w.text,!0)}};return e.dollarMath?{extensions:[{name:"katexDollarBlock",level:"inline",start(w){return w.match(/\$\$/)?.index},tokenizer(w){let y=/^\$\$([\s\S]+?)\$\$/.exec(w);if(y)return{type:"katexDollarBlock",raw:y[0],text:y[1]}},renderer(w){return c(w.text,!0)}},v,g,{name:"katexDollarInline",level:"inline",start(w){return w.match(/\$/)?.index},tokenizer(w){let y=/^\$(?!\s|\$)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/.exec(w);if(y)return{type:"katexDollarInline",raw:y[0],text:y[1]}},renderer(w){return c(w.text,!1)}}]}:{extensions:[g,v]}}function f(){if(document.querySelector("link[data-katex]"))return;let g=document.createElement("link");g.rel="stylesheet",g.href="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css",g.dataset.katex="1",document.head.appendChild(g)}function p(g){let v=-1;for(let[w,y]of[["\\[","\\]"],["\\(","\\)"]]){let q=g.lastIndexOf(w);q!==-1&&g.indexOf(y,q+w.length)===-1&&(v===-1||q<v)&&(v=q)}if(e.dollarMath){if((g.split("$$").length-1)%2===1){let q=g.lastIndexOf("$$");(v===-1||q<v)&&(v=q)}let w=v===-1?g:g.slice(0,v),y=/\$(?![\s\d$])[^$\n]*$/.exec(w);y&&w.split("$").length%2===0&&(v===-1||y.index<v)&&(v=y.index)}return v===-1?g:g.slice(0,v)}function m(g){let v=document.createElement("span");if(v.className=t,!e.caretDescend){(g.querySelector("p:last-of-type")??g).appendChild(v);return}let w=g;for(;;){let y=w.lastChild;for(;y&&y.nodeType===Node.TEXT_NODE&&!y.textContent?.trim();)y=y.previousSibling;if(!y||y.nodeType!==Node.ELEMENT_NODE||!N_.test(y.tagName))break;w=y}w.appendChild(v)}function h(g,v,w){let y=w&&a?p(v||""):v||"";if(r)try{n=[];let k=L_(r.parse(y));n.length&&(k=k.replace(/<\!--katex:(\d+)-->/g,(D,I)=>n?.[+I]??"")),g.innerHTML=k,w&&m(g);return}catch{}finally{n=null}let q=qt(y).split(/\n{2,}/).map(k=>k.trim()).filter(Boolean);g.innerHTML=q.map(k=>`<p>${C_(k).replace(/\n/g,"<br>")}</p>`).join(""),w&&m(g)}function b(g,v){if(i={el:g,raw:v},u)return;u=!0;let w=e.streamRenderMs??0,y=()=>{if(!i){u=!1;return}if(w>0&&performance.now()-o<w){requestAnimationFrame(y);return}u=!1,o=performance.now(),h(i.el,i.raw,!0),e.onRendered?.()};requestAnimationFrame(y)}return{useMarked(g){r=g.marked,r.use({gfm:!0,breaks:!0})},useKatex(g){a=g.default??g,r?.use(d()),e.injectKatexCss&&f()},render:h,schedule:b,cancel(){i=null}}}var Os="unsloth/Muse-Glimmer-30B-GGUF",Ns="Muse-Glimmer-30B-UD-Q2_K_XL.gguf",W_=4096,il=new WeakMap;async function G_(e,t){let r=il.get(e);return r||(r=Jo(oo(e),e),il.set(e,r)),(await r)(t).reason}var ul={defaultModelId:Os,defaultFile:()=>Ns,unsupportedReason:G_,loadModel:(e,t,r)=>tl.loadGGUF(e,{gguf:t,onProgress:r}),createGenerationState:(e,t)=>e.createGenerationState(t===void 0?{}:{maxLength:Math.max(1,Math.min(t,e.config.max_position_embeddings))}),defaultMaxNewTokens:W_},Ws=class pl extends id{static DEFAULT_MODEL_ID=Os;static checkAvailability(t=null,r={}){return Eb(ul,t,r)}static load(t=null,r={}){return Tb(ul,a=>new pl(a),t,r)}},R_=Ws;export{Ns as DEFAULT_GGUF_FILE,Os as DEFAULT_MODEL_ID,Ws as MuseGlimmer30B,nl as createAssistantMarkdown,R_ as default,rl as formatBytes,sl as highlightWgsl};
