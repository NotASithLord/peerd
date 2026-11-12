/**
 * @license
 * The AssemblyScript frontend
 * Copyright 2026 Daniel Wirtz / The AssemblyScript Authors
 * SPDX-License-Identifier: Apache-2.0
 */
var se=Object.defineProperty;var Ne=Object.getOwnPropertyDescriptor;var Ue=Object.getOwnPropertyNames;var Me=Object.prototype.hasOwnProperty;var fn=(e,t,n)=>()=>{if(n)throw n[0];try{return e&&(t=e(e=0)),t}catch(i){throw n=[i],i}};var Q=(e,t)=>{for(var n in t)se(e,n,{get:t[n],enumerable:!0})},ae=(e,t,n,i)=>{if(t&&typeof t=="object"||typeof t=="function")for(let s of Ue(t))!Me.call(e,s)&&s!==n&&se(e,s,{get:()=>t[s],enumerable:!(i=Ne(t,s))||i.enumerable});return e},wn=(e,t,n)=>(ae(e,t,"default"),n&&ae(n,t,"default"));var le={};Q(le,{promises:()=>Pe});var Pe,ue=fn(()=>{"use strict";Pe={}});var fe={};Q(fe,{createRequire:()=>Ve});function Ve(){return function(t){throw new Error(`Cannot find module: '${t}'`)}}var ce=fn(()=>{"use strict"});var On={};Q(On,{argv:()=>Xe,cwd:()=>In,exit:()=>He,hrtime:()=>qe,platform:()=>je,umask:()=>Ge});function In(){return"."}function Ge(){return 0}function He(e=0){throw Error(`exit ${e}`)}function qe(e){var t=Ke.call(de),n=Math.floor(t*.001),i=Math.floor(t*1e6-n*1e9);return e&&(n-=e[0],i-=e[1],i<0&&(n--,i+=1e9)),[n,i]}var je,Xe,de,Ke,Ln=fn(()=>{"use strict";je="linux";Xe=[];de=globalThis.performance||{},Ke=de.now||function(){return new Date().getTime()}});var Rn={};Q(Rn,{basename:()=>Qe,delimiter:()=>it,dirname:()=>Je,extname:()=>nt,format:()=>et,isAbsolute:()=>Ye,join:()=>$e,normalize:()=>pe,parse:()=>tt,relative:()=>Ze,resolve:()=>cn,sep:()=>kn,win32:()=>rt});function V(e){if(typeof e!="string")throw new TypeError("Path must be a string. Received "+JSON.stringify(e))}function xe(e,t){for(var n="",i=0,s=-1,o=0,u,f=0;f<=e.length;++f){if(f<e.length)u=e.charCodeAt(f);else{if(u===47)break;u=47}if(u===47){if(!(s===f-1||o===1))if(s!==f-1&&o===2){if(n.length<2||i!==2||n.charCodeAt(n.length-1)!==46||n.charCodeAt(n.length-2)!==46){if(n.length>2){var p=n.lastIndexOf("/");if(p!==n.length-1){p===-1?(n="",i=0):(n=n.slice(0,p),i=n.length-1-n.lastIndexOf("/")),s=f,o=0;continue}}else if(n.length===2||n.length===1){n="",i=0,s=f,o=0;continue}}t&&(n.length>0?n+="/..":n="..",i=2)}else n.length>0?n+="/"+e.slice(s+1,f):n=e.slice(s+1,f),i=f-s-1;s=f,o=0}else u===46&&o!==-1?++o:o=-1}return n}function We(e,t){var n=t.dir||t.root,i=t.base||(t.name||"")+(t.ext||"");return n?n===t.root?n+i:n+e+i:i}function cn(){for(var e="",t=!1,n,i=arguments.length-1;i>=-1&&!t;i--){var s;i>=0?s=arguments[i]:(n===void 0&&(n=In()),s=n),V(s),s.length!==0&&(e=s+"/"+e,t=s.charCodeAt(0)===47)}return e=xe(e,!t),t?e.length>0?"/"+e:"/":e.length>0?e:"."}function pe(e){if(V(e),e.length===0)return".";var t=e.charCodeAt(0)===47,n=e.charCodeAt(e.length-1)===47;return e=xe(e,!t),e.length===0&&!t&&(e="."),e.length>0&&n&&(e+="/"),t?"/"+e:e}function Ye(e){return V(e),e.length>0&&e.charCodeAt(0)===47}function $e(){if(arguments.length===0)return".";for(var e,t=0;t<arguments.length;++t){var n=arguments[t];V(n),n.length>0&&(e===void 0?e=n:e+="/"+n)}return e===void 0?".":pe(e)}function Ze(e,t){if(V(e),V(t),e===t||(e=cn(e),t=cn(t),e===t))return"";if(e===".")return t;for(var n=1;n<e.length&&e.charCodeAt(n)===47;++n);for(var i=e.length,s=i-n,o=1;o<t.length&&t.charCodeAt(o)===47;++o);for(var u=t.length,f=u-o,p=s<f?s:f,b=-1,c=0;c<=p;++c){if(c===p){if(f>p){if(t.charCodeAt(o+c)===47)return t.slice(o+c+1);if(c===0)return t.slice(o+c)}else s>p&&(e.charCodeAt(n+c)===47?b=c:c===0&&(b=0));break}var h=e.charCodeAt(n+c),F=t.charCodeAt(o+c);if(h!==F)break;h===47&&(b=c)}var m="";for(c=n+b+1;c<=i;++c)(c===i||e.charCodeAt(c)===47)&&(m.length===0?m+="..":m+="/..");return m.length>0?m+t.slice(o+b):(o+=b,t.charCodeAt(o)===47&&++o,t.slice(o))}function Je(e){if(V(e),e.length===0)return".";for(var t=e.charCodeAt(0),n=t===47,i=-1,s=!0,o=e.length-1;o>=1;--o)if(t=e.charCodeAt(o),t===47){if(!s){i=o;break}}else s=!1;return i===-1?n?"/":".":n&&i===1?"//":e.slice(0,i)}function Qe(e,t){if(t!==void 0&&typeof t!="string")throw new TypeError('"ext" argument must be a string');V(e);var n=0,i=-1,s=!0,o;if(t!==void 0&&t.length>0&&t.length<=e.length){if(t.length===e.length&&t===e)return"";var u=t.length-1,f=-1;for(o=e.length-1;o>=0;--o){var p=e.charCodeAt(o);if(p===47){if(!s){n=o+1;break}}else f===-1&&(s=!1,f=o+1),u>=0&&(p===t.charCodeAt(u)?--u===-1&&(i=o):(u=-1,i=f))}return n===i?i=f:i===-1&&(i=e.length),e.slice(n,i)}else{for(o=e.length-1;o>=0;--o)if(e.charCodeAt(o)===47){if(!s){n=o+1;break}}else i===-1&&(s=!1,i=o+1);return i===-1?"":e.slice(n,i)}}function nt(e){V(e);for(var t=-1,n=0,i=-1,s=!0,o=0,u=e.length-1;u>=0;--u){var f=e.charCodeAt(u);if(f===47){if(!s){n=u+1;break}continue}i===-1&&(s=!1,i=u+1),f===46?t===-1?t=u:o!==1&&(o=1):t!==-1&&(o=-1)}return t===-1||i===-1||o===0||o===1&&t===i-1&&t===n+1?"":e.slice(t,i)}function et(e){if(e===null||typeof e!="object")throw new TypeError('The "pathObject" argument must be of type Object. Received type '+typeof e);return We("/",e)}function tt(e){V(e);var t={root:"",dir:"",base:"",ext:"",name:""};if(e.length===0)return t;var n=e.charCodeAt(0),i=n===47,s;i?(t.root="/",s=1):s=0;for(var o=-1,u=0,f=-1,p=!0,b=e.length-1,c=0;b>=s;--b){if(n=e.charCodeAt(b),n===47){if(!p){u=b+1;break}continue}f===-1&&(p=!1,f=b+1),n===46?o===-1?o=b:c!==1&&(c=1):o!==-1&&(c=-1)}return o===-1||f===-1||c===0||c===1&&o===f-1&&o===u+1?f!==-1&&(u===0&&i?t.base=t.name=e.slice(1,f):t.base=t.name=e.slice(u,f)):(u===0&&i?(t.name=e.slice(1,o),t.base=e.slice(1,f)):(t.name=e.slice(u,o),t.base=e.slice(u,f)),t.ext=e.slice(o,f)),u>0?t.dir=e.slice(0,u-1):i&&(t.dir="/"),t}var kn,it,rt,Nn=fn(()=>{"use strict";Ln();kn="/",it=":",rt=null});var ge={};Q(ge,{pathToFileURL:()=>at});function ot(e){return e.replace(/%/g,"%25").replace(/\\/g,"%5C").replace(/\n/g,"%0A").replace(/\r/g,"%0D").replace(/\t/g,"%09")}function at(e){let t=cn(e);e.charCodeAt(e.length-1)===47&&t[t.length-1]!==kn&&(t+="/");let n=new URL("file://");return n.pathname=ot(t),n}var he=fn(()=>{"use strict";Nn()});var Wn={};Q(Wn,{Stats:()=>Cn,checkDiagnostics:()=>Tn,compileString:()=>St,configToArguments:()=>qn,createMemoryStream:()=>Hn,default:()=>Wn,defaultOptimizeLevel:()=>Be,defaultShrinkLevel:()=>Se,definitionFiles:()=>Bt,libraryFiles:()=>G,libraryPrefix:()=>P,main:()=>De,options:()=>zt,tscOptions:()=>Dt,version:()=>Xn});var st=Object.prototype.toString.call(typeof globalThis.process<"u"?globalThis.process:0)==="[object process]",j,an,v,M,dn;st?(j=await import("fs"),an=await import("module"),v=await import("path"),M=globalThis.process,dn=await import("url")):(j=await Promise.resolve().then(()=>(ue(),le)),an=await Promise.resolve().then(()=>(ce(),fe)),v=await Promise.resolve().then(()=>(Nn(),Rn)),M=await Promise.resolve().then(()=>(Ln(),On)),dn=await Promise.resolve().then(()=>(he(),ge)));var En=typeof process<"u"&&process||{},lt=En.env&&"CI"in En.env,ut="\x1B[90m",ft="\x1B[91m",ct="\x1B[92m",dt="\x1B[93m",xt="\x1B[94m",pt="\x1B[95m",gt="\x1B[96m",ht="\x1B[97m",W="\x1B[0m",nn=class{constructor(t){this.stream=t,this.enabled=!!(this.stream&&this.stream.isTTY||lt)}gray(t){return this.enabled?ut+t+W:t}red(t){return this.enabled?ft+t+W:t}green(t){return this.enabled?ct+t+W:t}yellow(t){return this.enabled?dt+t+W:t}blue(t){return this.enabled?xt+t+W:t}magenta(t){return this.enabled?pt+t+W:t}cyan(t){return this.enabled?gt+t+W:t}white(t){return this.enabled?ht+t+W:t}},An=new nn(En.stdout),Ot=new nn(En.stderr);function mt(e){for(var t=0,n=0,i=e.length;n<i;++n){let s=e.charCodeAt(n);s<128?t+=1:s<2048?t+=2:(s&64512)===55296&&n+1<i&&(e.charCodeAt(n+1)&64512)===56320?(++n,t+=4):t+=3}return t}function bt(e,t,n){var i=n-t;if(i<1)return"";for(var s=null,o=[],u=0,f;t<n;)f=e[t++],f<128?o[u++]=f:f>191&&f<224?o[u++]=(f&31)<<6|e[t++]&63:f>239&&f<365?(f=((f&7)<<18|(e[t++]&63)<<12|(e[t++]&63)<<6|e[t++]&63)-65536,o[u++]=55296+(f>>10),o[u++]=56320+(f&1023)):o[u++]=(f&15)<<12|(e[t++]&63)<<6|e[t++]&63,u>=8192&&((s||(s=[])).push(String.fromCharCode(...o)),u=0);return s?(u&&s.push(String.fromCharCode(...o.slice(0,u))),s.join("")):String.fromCharCode(...o.slice(0,u))}function Ft(e,t,n){for(var i=n,s=0,o=e.length;s<o;++s){let u=e.charCodeAt(s),f;u<128?t[n++]=u:u<2048?(t[n++]=u>>6|192,t[n++]=u&63|128):(u&64512)===55296&&s+1<o&&((f=e.charCodeAt(s+1))&64512)===56320?(u=65536+((u&1023)<<10)+(f&1023),++s,t[n++]=u>>18|240,t[n++]=u>>12&63|128,t[n++]=u>>6&63|128,t[n++]=u&63|128):(t[n++]=u>>12|224,t[n++]=u>>6&63|128,t[n++]=u&63|128)}return n-i}var _n={length:mt,read:bt,write:Ft};var me=an.createRequire(import.meta.url);function Fe(e,t,n=!0){var i={},s=[],o=[],u=[],f={};Object.keys(t).forEach(c=>{if(!c.startsWith(" ")){var h=t[c];h.alias!=null&&(typeof h.alias=="string"?f[h.alias]=c:Array.isArray(h.alias)&&h.alias.forEach(F=>f[F]=c)),n&&h.default!=null&&(i[c]=h.default)}});for(var p=0,b=(e=e.slice()).length;p<b;++p){let c=e[p];if(c=="--"){++p;break}let h=/^(?:(-\w)(?:=(.*))?|(--\w{2,})(?:=(.*))?)$/.exec(c),F,m;if(h)t[c]?F=t[m=c]:h[1]!=null?(F=t[m=f[h[1].substring(1)]],F&&h[2]!=null&&(e[p--]=h[2])):h[3]!=null&&(F=t[m=h[3].substring(2)],F&&h[4]!=null&&(e[p--]=h[4]));else if(c.charCodeAt(0)==45)F=t[m=c];else{o.push(c);continue}if(F)if(F.value)Object.keys(F.value).forEach(r=>i[r]=F.value[r]);else if(F.type==null||F.type==="b")i[m]=!0;else if(p+1<e.length&&e[p+1].charCodeAt(0)!=45)switch(F.type){case"i":i[m]=parseInt(e[++p],10);break;case"I":i[m]=(i[m]||[]).concat(parseInt(e[++p],10));break;case"f":i[m]=parseFloat(e[++p]);break;case"F":i[m]=(i[m]||[]).concat(parseFloat(e[++p]));break;case"s":i[m]=String(e[++p]);break;case"S":i[m]=(i[m]||[]).concat(e[++p].split(","));break;default:s.push(c),--p}else switch(F.type){case"i":case"f":i[m]=F.default||0;break;case"s":i[m]=F.default||"";break;case"I":case"F":case"S":i[m]=F.default||[];break;default:s.push(c)}else s.push(c)}for(;p<b;)u.push(e[p++]);return n&&Mn(t,i),{options:i,unknown:s,arguments:o,trailing:u}}function ye(e,t){t||(t={});var n=t.indent||2,i=t.padding||24,s=t.eol||`
`,o={},u=[];Object.keys(e).forEach(b=>{var c=e[b];if(c.description!=null){for(var h="";h.length<n;)h+=" ";for(h+="--"+b,c.alias&&(h+=", -"+c.alias);h.length<i;)h+=" ";var F;!t.noCategories&&c.category?(F=o[c.category])||(o[c.category]=F=[]):F=u,Array.isArray(c.description)?F.push(h+c.description[0]+c.description.slice(1).map(m=>{for(let r=0;r<i;++r)m=" "+m;return s+m}).join("")):F.push(h+c.description)}});var f=[],p=!1;return Object.keys(o).forEach(b=>{p=!0,f.push(s+" "+An.gray(b)+s),f.push(o[b].join(s))}),p&&u.length&&f.push(s+" "+An.gray("Other")+s),f.push(u.join(s)),f.join(s)}function be(e,t){if(e!=null)switch(t){case void 0:case"b":return!!e;case"i":return Math.trunc(e)||0;case"f":return Number(e)||0;case"s":return e===!0?"":e===!1?null:String(e);case"I":return Array.isArray(e)||(e=[e]),e.map(n=>Math.trunc(n)||0);case"F":return Array.isArray(e)||(e=[e]),e.map(n=>Number(n)||0);case"S":return Array.isArray(e)||(e=[e]),e.map(String)}}function Un(e,t,n,i){let s={};for(let[o,{type:u,mutuallyExclusive:f,isPath:p,useNodeResolution:b,cliOnly:c}]of Object.entries(e)){let h=be(t[o],u),F=be(n[o],u);if(h==null){if(F!=null){if(c)continue;if(Array.isArray(F)){let m;p&&(F=F.map(r=>en(r,i,b))),f!=null&&(m=t[f])?s[o]=F.filter(r=>!m.includes(r)):s[o]=F.slice()}else p&&(F=en(F,i,b)),s[o]=F}}else if(F==null)Array.isArray(h)?s[o]=h.slice():s[o]=h;else if(Array.isArray(h)){if(c){s[o]=h.slice();continue}let m;p&&(F=F.map(r=>en(r,i,b))),f!=null&&(m=t[f])?s[o]=[...h,...F.filter(r=>!h.includes(r)&&!m.includes(r))]:s[o]=[...h,...F.filter(r=>!h.includes(r))]}else s[o]=h}return s}function yt(e){let t=v.parse(e);return t.root||(t.root="./"),v.format(t)}function en(e,t,n=!1){return v.isAbsolute(e)?e:n&&!e.startsWith(".")&&me.resolve?me.resolve(e,{paths:[t]}):yt(v.join(t,e))}function Mn(e,t){for(let[n,{default:i}]of Object.entries(e))t[n]==null&&i!=null&&(t[n]=i)}var ve="0.28.20",Y={version:{category:"General",description:"Prints just the compiler's version and exits.",type:"b",alias:"v"},help:{category:"General",description:"Prints this message and exits.",type:"b",alias:"h"},config:{category:"General",description:"Configuration file to apply. CLI arguments take precedence.",type:"s",cliOnly:!0},target:{category:"General",description:"Configuration file target to use. Defaults to 'release'.",type:"s",cliOnly:!0},optimize:{category:"Optimization",description:["Optimizes the module. Typical shorthands are:",""," Default optimizations   -O"," Make a release build    -O --noAssert"," Make a debug build      --debug"," Optimize for speed      -Ospeed"," Optimize for size       -Osize",""],type:"b",alias:"O"},optimizeLevel:{category:"Optimization",description:"How much to focus on optimizing code. [0-3]",type:"i"},shrinkLevel:{category:"Optimization",description:"How much to focus on shrinking code size. [0-2, s=1, z=2]",type:"i"},converge:{category:"Optimization",description:"Re-optimizes until no further improvements can be made.",type:"b",default:!1},noAssert:{category:"Optimization",description:"Replaces assertions with just their value without trapping.",type:"b",default:!1},outFile:{category:"Output",description:"Specifies the WebAssembly output file (.wasm).",type:"s",alias:"o",isPath:!0},textFile:{category:"Output",description:"Specifies the WebAssembly text output file (.wat).",type:"s",alias:"t",isPath:!0},bindings:{category:"Output",description:["Specifies the bindings to generate (.js + .d.ts).","","  esm  JavaScript bindings & typings for ESM integration.","  raw  Like esm, but exports just the instantiate function.","       Useful where modules are meant to be instantiated","       multiple times or non-ESM imports must be provided."],type:"S",alias:"b"},sourceMap:{category:"Debugging",description:["Enables source map generation. Optionally takes the URL","used to reference the source map from the binary file."],type:"s"},uncheckedBehavior:{category:"Debugging",description:["Changes the behavior of unchecked() expressions.","Using this option can potentially cause breakage.","","  default  The default behavior: unchecked operations are","           only used inside of unchecked().","  never    Unchecked operations are never used, even when","           inside of unchecked().","  always   Unchecked operations are always used if possible,","           whether or not unchecked() is used."],type:"s",default:"default"},debug:{category:"Debugging",description:"Enables debug information in emitted binaries.",type:"b",default:!1},importMemory:{category:"Features",description:"Imports the memory from 'env.memory'.",type:"b",default:!1},noExportMemory:{category:"Features",description:"Does not export the memory as 'memory'.",type:"b",default:!1},initialMemory:{category:"Features",description:"Sets the initial memory size in pages.",type:"i",default:0},maximumMemory:{category:"Features",description:"Sets the maximum memory size in pages.",type:"i",default:0},sharedMemory:{category:"Features",description:"Declare memory as shared. Requires maximumMemory.",type:"b",default:!1},zeroFilledMemory:{category:"Features",description:"Assume imported memory is zeroed. Requires importMemory.",type:"b",default:!1},importTable:{category:"Features",description:"Imports the function table from 'env.table'.",type:"b",default:!1},exportTable:{category:"Features",description:"Exports the function table as 'table'.",type:"b",default:!1},exportStart:{category:"Features",description:["Exports the start function using the specified name instead","of calling it implicitly. Useful to obtain the exported memory","before executing any code accessing it."],type:"s"},runtime:{category:"Features",description:["Specifies the runtime variant to include in the program.",""," incremental  TLSF + incremental GC (default)"," minimal      TLSF + lightweight GC invoked externally"," stub         Minimal runtime stub (never frees)"," ...          Path to a custom runtime implementation",""],type:"s",default:"incremental"},exportRuntime:{category:"Features",description:["Always exports the runtime helpers (__new, __collect, __pin etc.).","Automatically determined when generation of --bindings is enabled."],type:"b",default:!1},stackSize:{category:"Features",description:["Overrides the stack size. Only relevant for incremental GC","or when using a custom runtime that requires stack space.","Defaults to 0 without and to 32768 with incremental GC."],default:0,type:"i"},enable:{category:"Features",description:["Enables WebAssembly features being disabled by default.",""," threads             Threading and atomic operations."," simd                SIMD types and operations."," reference-types     Reference types and operations."," gc                  Garbage collection (WIP)."," stringref           String reference types."," relaxed-simd        Relaxed SIMD operations.",""],TODO_doesNothingYet:[" exception-handling  Exception handling."," tail-calls          Tail call operations."," multi-value         Multi value types."," memory64            Memory64 operations."," extended-const      Extended const expressions."],type:"S",mutuallyExclusive:"disable"},disable:{category:"Features",description:["Disables WebAssembly features being enabled by default.",""," mutable-globals     Mutable global imports and exports."," sign-extension      Sign-extension operations"," nontrapping-f2i     Non-trapping float to integer ops."," bulk-memory         Bulk memory operations.",""],type:"S",mutuallyExclusive:"enable"},use:{category:"Features",description:["Aliases a global object under another name, e.g., to switch","the default 'Math' implementation used: --use Math=JSMath","Can also be used to introduce an integer constant."],type:"S",alias:"u"},lowMemoryLimit:{category:"Features",description:"Enforces very low (<64k) memory constraints.",default:0,type:"i"},memoryBase:{category:"Linking",description:"Sets the start offset of emitted memory segments.",type:"i",default:0},tableBase:{category:"Linking",description:"Sets the start offset of emitted table elements.",type:"i",default:0},transform:{category:"API",description:"Specifies the path to a custom transform to load.",type:"S",isPath:!0,useNodeResolution:!0},trapMode:{category:"Binaryen",description:["Sets the trap mode to use.",""," allow  Allow trapping operations. This is the default."," clamp  Replace trapping operations with clamping semantics."," js     Replace trapping operations with JS semantics.",""],type:"s",default:"allow"},runPasses:{category:"Binaryen",description:["Specifies additional Binaryen passes to run after other","optimizations, if any. See: Binaryen/src/passes/pass.cpp"],type:"s"},noValidate:{category:"Binaryen",description:"Skips validating the module using Binaryen.",type:"b",default:!1},baseDir:{description:"Specifies the base directory of input and output files.",type:"s",default:"."},noColors:{description:"Disables terminal colors.",type:"b",default:!1},noUnsafe:{description:["Disallows the use of unsafe features in user code.","Does not affect library files and external modules."],type:"b",default:!1},disableWarning:{description:["Disables warnings matching the given diagnostic code.","If no diagnostic code is given, all warnings are disabled."],type:"I"},noEmit:{description:"Performs compilation as usual but does not emit code.",type:"b",default:!1},showConfig:{description:"Print computed compiler options and exit.",type:"b",default:!1},stats:{description:"Prints statistics on I/O and compile times.",type:"b",default:!1},pedantic:{description:"Make yourself sad for no good reason.",type:"b",default:!1},lib:{description:["Adds one or multiple paths to custom library components and","uses exports of all top-level files at this path as globals."],type:"S",isPath:!0},path:{description:["Adds one or multiple paths to package resolution, similar","to node_modules. Prefers an 'ascMain' entry in a package's","package.json and falls back to an inner 'assembly/' folder."],type:"S",isPath:!0},wasm:{description:"Uses the specified Wasm binary of the compiler.",type:"s"}," ...":{description:"Specifies node.js options (CLI only). See: node --help"},"-Os":{value:{optimizeLevel:0,shrinkLevel:1}},"-Oz":{value:{optimizeLevel:0,shrinkLevel:2}},"-O0":{value:{optimizeLevel:0,shrinkLevel:0}},"-O1":{value:{optimizeLevel:1,shrinkLevel:0}},"-O2":{value:{optimizeLevel:2,shrinkLevel:0}},"-O3":{value:{optimizeLevel:3,shrinkLevel:0}},"-O0s":{value:{optimizeLevel:0,shrinkLevel:1}},"-O1s":{value:{optimizeLevel:1,shrinkLevel:1}},"-O2s":{value:{optimizeLevel:2,shrinkLevel:1}},"-O3s":{value:{optimizeLevel:3,shrinkLevel:1}},"-O0z":{value:{optimizeLevel:0,shrinkLevel:2}},"-O1z":{value:{optimizeLevel:1,shrinkLevel:2}},"-O2z":{value:{optimizeLevel:2,shrinkLevel:2}},"-O3z":{value:{optimizeLevel:3,shrinkLevel:2}},"-Ospeed":{value:{optimizeLevel:3,shrinkLevel:0}},"-Osize":{value:{optimizeLevel:0,shrinkLevel:2,converge:!0}},"--measure":{value:{stats:!0}}},Ee="~lib/",Ae={array:`/// <reference path="./rt/index.d.ts" />

import { BLOCK_MAXSIZE } from "./rt/common";
import { Runtime } from "shared/runtime";
import { COMPARATOR, SORT } from "./util/sort";
import { REVERSE, FILL } from "./util/bytes";
import { joinBooleanArray, joinIntegerArray, joinFloatArray, joinStringArray, joinReferenceArray } from "./util/string";
import { idof, isArray as builtin_isArray } from "./builtins";
import { E_INDEXOUTOFRANGE, E_INVALIDLENGTH, E_EMPTYARRAY, E_HOLEYARRAY } from "./util/error";

// @ts-ignore: decorator
@inline @lazy const MIN_SIZE: usize = 8;

/** Ensures that the given array has _at least_ the specified backing size. */
function ensureCapacity(array: usize, newSize: usize, alignLog2: u32, canGrow: bool = true): void {
  // Depends on the fact that Arrays mimic ArrayBufferView
  let oldCapacity = <usize>changetype<ArrayBufferView>(array).byteLength;
  if (newSize > oldCapacity >>> alignLog2) {
    if (newSize > BLOCK_MAXSIZE >>> alignLog2) throw new RangeError(E_INVALIDLENGTH);
    let oldData = changetype<usize>(changetype<ArrayBufferView>(array).buffer);
    // Grows old capacity by factor of two.
    // Make sure we don't reach BLOCK_MAXSIZE for new growed capacity.
    let newCapacity = max(newSize, MIN_SIZE) << alignLog2;
    if (canGrow) newCapacity = max(min(oldCapacity << 1, BLOCK_MAXSIZE), newCapacity);
    let newData = __renew(oldData, newCapacity);
    // __new / __renew already init memory range as zeros in Incremental runtime.
    // So try to avoid this.
    if (ASC_RUNTIME != Runtime.Incremental) {
      memory.fill(newData + oldCapacity, 0, newCapacity - oldCapacity);
    }
    if (newData != oldData) { // oldData has been free'd
      store<usize>(array, newData, offsetof<ArrayBufferView>("buffer"));
      store<usize>(array, newData, offsetof<ArrayBufferView>("dataStart"));
      __link(array, changetype<usize>(newData), false);
    }
    store<u32>(array, <u32>newCapacity, offsetof<ArrayBufferView>("byteLength"));
  }
}

export class Array<T> {
  [key: number]: T;

  // Mimicking ArrayBufferView isn't strictly necessary here but is done to allow glue code
  // to work with typed and normal arrays interchangeably. Technically, normal arrays do not need
  // \`dataStart\` (equals \`buffer\`) and \`byteLength\` (equals computed \`buffer.byteLength\`), but the
  // block is 16 bytes anyway so it's fine to have a couple extra fields in there.

  private buffer: ArrayBuffer;
  @unsafe readonly dataStart: usize;
  private byteLength: i32; // Uses here as capacity

  // Also note that Array<T> with non-nullable T must guard against uninitialized null values
  // whenever an element is accessed. Otherwise, the compiler wouldn't be able to guarantee
  // type-safety anymore. For lack of a better word, such an array is "holey".

  private length_: i32;

  static isArray<U>(value: U): bool {
    return isReference<U>() ? changetype<usize>(value) != 0 && builtin_isArray(value) : false;
  }

  static create<T>(capacity: i32 = 0): Array<T> {
    WARNING("'Array.create' is deprecated. Use 'new Array' instead, making sure initial elements are initialized.");
    let array = new Array<T>(capacity);
    array.length = 0;
    return array;
  }

  constructor(length: i32 = 0) {
    if (<u32>length > <u32>BLOCK_MAXSIZE >>> alignof<T>()) throw new RangeError(E_INVALIDLENGTH);
    // reserve capacity for at least MIN_SIZE elements
    let bufferSize = max(<usize>length, MIN_SIZE) << alignof<T>();
    let buffer = changetype<ArrayBuffer>(__new(bufferSize, idof<ArrayBuffer>()));
    if (ASC_RUNTIME != Runtime.Incremental) {
      memory.fill(changetype<usize>(buffer), 0, bufferSize);
    }
    this.buffer = buffer; // links
    this.dataStart = changetype<usize>(buffer);
    this.byteLength = <i32>bufferSize;
    this.length_ = length;
  }

  get length(): i32 {
    return this.length_;
  }

  set length(newLength: i32) {
    ensureCapacity(changetype<usize>(this), newLength, alignof<T>(), false);
    this.length_ = newLength;
  }

  every(fn: (value: T, index: i32, array: Array<T>) => bool): bool {
    for (let i = 0, len = this.length_; i < min(len, this.length_); ++i) {
      if (!fn(load<T>(this.dataStart + (<usize>i << alignof<T>())), i, this)) return false;
    }
    return true;
  }

  findIndex(fn: (value: T, index: i32, array: Array<T>) => bool): i32 {
    for (let i = 0, len = this.length_; i < min(len, this.length_); ++i) {
      if (fn(load<T>(this.dataStart + (<usize>i << alignof<T>())), i, this)) return i;
    }
    return -1;
  }

  findLastIndex(fn: (value: T, index: i32, array: Array<T>) => bool): i32 {
    for (let i = this.length_ - 1; i >= 0; --i) {
      if (fn(load<T>(this.dataStart + (<usize>i << alignof<T>())), i, this)) return i;
    }
    return -1;
  }

  @operator("[]") private __get(index: i32): T {
    if (<u32>index >= <u32>this.length_) throw new RangeError(E_INDEXOUTOFRANGE);
    let value = load<T>(this.dataStart + (<usize>index << alignof<T>()));
    if (isReference<T>()) {
      if (!isNullable<T>()) {
        if (!changetype<usize>(value)) throw new Error(E_HOLEYARRAY);
      }
    }
    return value;
  }

  @unsafe @operator("{}") private __uget(index: i32): T {
    return load<T>(this.dataStart + (<usize>index << alignof<T>()));
  }

  @operator("[]=") private __set(index: i32, value: T): void {
    if (<u32>index >= <u32>this.length_) {
      if (index < 0) throw new RangeError(E_INDEXOUTOFRANGE);
      ensureCapacity(changetype<usize>(this), index + 1, alignof<T>());
      this.length_ = index + 1;
    }
    store<T>(this.dataStart + (<usize>index << alignof<T>()), value);
    if (isManaged<T>()) {
      __link(changetype<usize>(this), changetype<usize>(value), true);
    }
  }

  at(index: i32): T {
    let len = this.length_;
    index += select(0, len, index >= 0);
    if (<u32>index >= <u32>len) throw new RangeError(E_INDEXOUTOFRANGE);
    let value = load<T>(this.dataStart + (<usize>index << alignof<T>()));
    if (isReference<T>()) {
      if (!isNullable<T>()) {
        if (!changetype<usize>(value)) throw new Error(E_HOLEYARRAY);
      }
    }
    return value;
  }

  fill(value: T, start: i32 = 0, end: i32 = i32.MAX_VALUE): Array<T> {
    if (isManaged<T>()) {
      FILL<usize>(this.dataStart, this.length_, changetype<usize>(value), start, end);
      __link(changetype<usize>(this), changetype<usize>(value), false);
    } else {
      FILL<T>(this.dataStart, this.length_, value, start, end);
    }
    return this;
  }

  includes(value: T, fromIndex: i32 = 0): bool {
    if (isFloat<T>()) {
      let len = this.length_;
      if (len == 0 || fromIndex >= len) return false;
      if (fromIndex < 0) fromIndex = max(len + fromIndex, 0);
      let ptr = this.dataStart;
      while (fromIndex < len) {
        let elem = load<T>(ptr + (<usize>fromIndex << alignof<T>()));
        // @ts-ignore
        if (elem == value || isNaN(elem) & isNaN(value)) return true;
        ++fromIndex;
      }
      return false;
    } else {
      return this.indexOf(value, fromIndex) >= 0;
    }
  }

  indexOf(value: T, fromIndex: i32 = 0): i32 {
    let len = this.length_;
    if (len == 0 || fromIndex >= len) return -1;
    if (fromIndex < 0) fromIndex = max(len + fromIndex, 0);
    let ptr = this.dataStart;
    while (fromIndex < len) {
      if (load<T>(ptr + (<usize>fromIndex << alignof<T>())) == value) return fromIndex;
      ++fromIndex;
    }
    return -1;
  }

  lastIndexOf(value: T, fromIndex: i32 = this.length_): i32 {
    let len = this.length_;
    if (len == 0) return -1;
    if (fromIndex < 0) fromIndex = len + fromIndex;
    else if (fromIndex >= len) fromIndex = len - 1;
    let ptr = this.dataStart;
    while (fromIndex >= 0) {
      if (load<T>(ptr + (<usize>fromIndex << alignof<T>())) == value) return fromIndex;
      --fromIndex;
    }
    return -1;
  }

  push(value: T): i32 {
    let oldLen = this.length_;
    let len = oldLen + 1;
    ensureCapacity(changetype<usize>(this), len, alignof<T>());
    if (isManaged<T>()) {
      store<usize>(this.dataStart + (<usize>oldLen << alignof<T>()), changetype<usize>(value));
      __link(changetype<usize>(this), changetype<usize>(value), true);
    } else {
      store<T>(this.dataStart + (<usize>oldLen << alignof<T>()), value);
    }
    this.length_ = len;
    return len;
  }

  concat(other: Array<T>): Array<T> {
    let thisLen = this.length_;
    let otherLen = other.length_;
    let outLen = thisLen + otherLen;
    if (<u32>outLen > <u32>BLOCK_MAXSIZE >>> alignof<T>()) throw new Error(E_INVALIDLENGTH);
    let out = changetype<Array<T>>(__newArray(outLen, alignof<T>(), idof<Array<T>>()));
    let outStart = out.dataStart;
    let thisSize = <usize>thisLen << alignof<T>();
    if (isManaged<T>()) {
      let thisStart = this.dataStart;
      for (let offset: usize = 0; offset < thisSize; offset += sizeof<T>()) {
        let ref = load<usize>(thisStart + offset);
        store<usize>(outStart + offset, ref);
        __link(changetype<usize>(out), ref, true);
      }
      outStart += thisSize;
      let otherStart = other.dataStart;
      let otherSize = <usize>otherLen << alignof<T>();
      for (let offset: usize = 0; offset < otherSize; offset += sizeof<T>()) {
        let ref = load<usize>(otherStart + offset);
        store<usize>(outStart + offset, ref);
        __link(changetype<usize>(out), ref, true);
      }
    } else {
      memory.copy(outStart, this.dataStart, thisSize);
      memory.copy(outStart + thisSize, other.dataStart, <usize>otherLen << alignof<T>());
    }
    return out;
  }

  copyWithin(target: i32, start: i32, end: i32 = i32.MAX_VALUE): Array<T> {
    let ptr = this.dataStart;
    let len = this.length_;

    end = min<i32>(end, len);

    let to    = target < 0 ? max(len + target, 0) : min(target, len);
    let from  = start < 0 ? max(len + start, 0) : min(start, len);
    let last  = end < 0 ? max(len + end, 0) : min(end, len);
    let count = min(last - from, len - to);

    memory.copy( // is memmove
      ptr + (<usize>to << alignof<T>()),
      ptr + (<usize>from << alignof<T>()),
      <usize>count << alignof<T>()
    );
    return this;
  }

  pop(): T {
    let len = this.length_;
    if (len < 1) throw new RangeError(E_EMPTYARRAY);
    let val = load<T>(this.dataStart + (<usize>(--len) << alignof<T>()));
    this.length_ = len;
    return val;
  }

  forEach(fn: (value: T, index: i32, array: Array<T>) => void): void {
    for (let i = 0, len = this.length_; i < min(len, this.length_); ++i) {
      fn(load<T>(this.dataStart + (<usize>i << alignof<T>())), i, this);
    }
  }

  map<U>(fn: (value: T, index: i32, array: Array<T>) => U): Array<U> {
    let len = this.length_;
    let out = changetype<Array<U>>(__newArray(len, alignof<U>(), idof<Array<U>>()));
    let outStart = out.dataStart;
    for (let i = 0; i < min(len, this.length_); ++i) {
      let result = fn(load<T>(this.dataStart + (<usize>i << alignof<T>())), i, this);
      store<U>(outStart + (<usize>i << alignof<U>()), result);
      if (isManaged<U>()) {
        __link(changetype<usize>(out), changetype<usize>(result), true);
      }
    }
    return out;
  }

  filter(fn: (value: T, index: i32, array: Array<T>) => bool): Array<T> {
    let result = changetype<Array<T>>(__newArray(0, alignof<T>(), idof<Array<T>>()));
    for (let i = 0, len = this.length_; i < min(len, this.length_); ++i) {
      let value = load<T>(this.dataStart + (<usize>i << alignof<T>()));
      if (fn(value, i, this)) result.push(value);
    }
    return result;
  }

  reduce<U>(
    fn: (previousValue: U, currentValue: T, currentIndex: i32, array: Array<T>) => U,
    initialValue: U
  ): U {
    let acc = initialValue;
    for (let i = 0, len = this.length_; i < min(len, this.length_); ++i) {
      acc = fn(acc, load<T>(this.dataStart + (<usize>i << alignof<T>())), i, this);
    }
    return acc;
  }

  reduceRight<U>(
    fn: (previousValue: U, currentValue: T, currentIndex: i32, array: Array<T>) => U,
    initialValue: U
  ): U {
    let acc = initialValue;
    for (let i = this.length_ - 1; i >= 0; --i) {
      acc = fn(acc, load<T>(this.dataStart + (<usize>i << alignof<T>())), i, this);
    }
    return acc;
  }

  shift(): T {
    let len = this.length_;
    if (len < 1) throw new RangeError(E_EMPTYARRAY);
    let base = this.dataStart;
    let element = load<T>(base);
    let lastIndex = len - 1;
    memory.copy(
      base,
      base + sizeof<T>(),
      <usize>lastIndex << alignof<T>()
    );
    if (isReference<T>()) {
      store<usize>(base + (<usize>lastIndex << alignof<T>()), 0);
    } else {
      // @ts-ignore
      store<T>(base + (<usize>lastIndex << alignof<T>()), <T>0);
    }
    this.length_ = lastIndex;
    return element;
  }

  some(fn: (value: T, index: i32, array: Array<T>) => bool): bool {
    for (let i = 0, len = this.length_; i < min(len, this.length_); ++i) {
      if (fn(load<T>(this.dataStart + (<usize>i << alignof<T>())), i, this)) return true;
    }
    return false;
  }

  unshift(value: T): i32 {
    let len = this.length_ + 1;
    ensureCapacity(changetype<usize>(this), len, alignof<T>());
    let ptr = this.dataStart;
    memory.copy(
      ptr + sizeof<T>(),
      ptr,
      <usize>(len - 1) << alignof<T>()
    );
    store<T>(ptr, value);
    if (isManaged<T>()) {
      __link(changetype<usize>(this), changetype<usize>(value), true);
    }
    this.length_ = len;
    return len;
  }

  slice(start: i32 = 0, end: i32 = i32.MAX_VALUE): Array<T> {
    let len = this.length_;
    start = start < 0 ? max(start + len, 0) : min(start, len);
    end   = end   < 0 ? max(end   + len, 0) : min(end  , len);
    len = max(end - start, 0);
    let slice = changetype<Array<T>>(__newArray(len, alignof<T>(), idof<Array<T>>()));
    let sliceBase = slice.dataStart;
    let thisBase = this.dataStart + (<usize>start << alignof<T>());
    if (isManaged<T>()) {
      let off = <usize>0;
      let end = <usize>len << alignof<usize>();
      while (off < end) {
        let ref = load<usize>(thisBase + off);
        store<usize>(sliceBase + off, ref);
        __link(changetype<usize>(slice), ref, true);
        off += sizeof<usize>();
      }
    } else {
      memory.copy(sliceBase, thisBase, len << alignof<T>());
    }
    return slice;
  }

  splice(start: i32, deleteCount: i32 = i32.MAX_VALUE): Array<T> {
    let len = this.length_;
    start       = start < 0 ? max<i32>(len + start, 0) : min<i32>(start, len);
    deleteCount = max<i32>(min<i32>(deleteCount, len - start), 0);
    let result  = changetype<Array<T>>(__newArray(deleteCount, alignof<T>(), idof<Array<T>>()));
    let resultStart = result.dataStart;
    let thisStart = this.dataStart;
    let thisBase  = thisStart + (<usize>start << alignof<T>());
    memory.copy(
      resultStart,
      thisBase,
      <usize>deleteCount << alignof<T>()
    );
    let offset = start + deleteCount;
    if (len != offset) {
      memory.copy(
        thisBase,
        thisStart + (<usize>offset << alignof<T>()),
        <usize>(len - offset) << alignof<T>()
      );
    }
    this.length_ = len - deleteCount;
    return result;
  }

  reverse(): Array<T> {
    REVERSE<T>(this.dataStart, this.length_);
    return this;
  }

  sort(comparator: (a: T, b: T) => i32 = COMPARATOR<T>()): Array<T> {
    SORT<T>(this.dataStart, this.length_, comparator);
    return this;
  }

  join(separator: string = ","): string {
    let ptr = this.dataStart;
    let len = this.length_;
    if (isBoolean<T>())   return joinBooleanArray(ptr, len, separator);
    if (isInteger<T>())   return joinIntegerArray<T>(ptr, len, separator);
    if (isFloat<T>())     return joinFloatArray<T>(ptr, len, separator);

    if (ASC_SHRINK_LEVEL < 1) {
      if (isString<T>())  return joinStringArray(ptr, len, separator);
    }
    // For rest objects and arrays use general join routine
    if (isReference<T>()) return joinReferenceArray<T>(ptr, len, separator);
    ERROR("unspported element type");
    return <string>unreachable();
  }

  flat(): T {
    if (!isArray<T>()) {
      ERROR("Cannot call flat() on Array<T> where T is not an Array.");
    }
    // Get the length and data start values
    let ptr = this.dataStart;
    let len = this.length_;

    // calculate the end size with an initial pass
    let size = 0;
    for (let i = 0; i < len; ++i) {
      let child = load<usize>(ptr + (i << alignof<T>()));
      size += child == 0 ? 0 : load<i32>(child, offsetof<T>("length_"));
    }

    // calculate the byteLength of the resulting backing ArrayBuffer
    const align = alignof<valueof<T>>();
    let byteLength = <usize>size << align;
    let outBuffer = changetype<ArrayBuffer>(__new(byteLength, idof<ArrayBuffer>()));

    // create the return value and initialize it
    let outArray = changetype<T>(__new(offsetof<T>(), idof<T>()));
    store<i32>(changetype<usize>(outArray), size, offsetof<T>("length_"));

    // byteLength, dataStart, and buffer are all readonly
    store<i32>(changetype<usize>(outArray), byteLength, offsetof<T>("byteLength"));
    store<usize>(changetype<usize>(outArray), changetype<usize>(outBuffer), offsetof<T>("dataStart"));
    store<usize>(changetype<usize>(outArray), changetype<usize>(outBuffer), offsetof<T>("buffer"));
    __link(changetype<usize>(outArray), changetype<usize>(outBuffer), false);

    // set the elements
    let resultOffset: usize = 0;
    for (let i = 0; i < len; ++i) { // for each child
      let child = load<usize>(ptr + (<usize>i << alignof<T>()));

      // ignore null arrays
      if (!child) continue;

      // copy the underlying buffer data to the result buffer
      let childDataLength = <usize>load<i32>(child, offsetof<T>("length_")) << align;
      memory.copy(
        changetype<usize>(outBuffer) + resultOffset,
        load<usize>(child, offsetof<T>("dataStart")),
        childDataLength
      );

      // advance the result length
      resultOffset += childDataLength;
    }

    // if the \`valueof<T>\` type is managed, we must link each reference
    if (isManaged<valueof<T>>()) {
      for (let i = 0; i < size; ++i) {
        let ref = load<usize>(changetype<usize>(outBuffer) + (<usize>i << usize(alignof<valueof<T>>())));
        __link(changetype<usize>(outBuffer), ref, true);
      }
    }

    return outArray;
  }

  toString(): string {
    return this.join();
  }

  // RT integration

  @unsafe private __visit(cookie: u32): void {
    if (isManaged<T>()) {
      let cur = this.dataStart;
      let end = cur + (<usize>this.length_ << alignof<T>());
      while (cur < end) {
        let val = load<usize>(cur);
        if (val) __visit(val, cookie);
        cur += sizeof<usize>();
      }
    }
    __visit(changetype<usize>(this.buffer), cookie);
  }
}
`,arraybuffer:`/// <reference path="./rt/index.d.ts" />

import { OBJECT, BLOCK_MAXSIZE, TOTAL_OVERHEAD } from "./rt/common";
import { Runtime } from "shared/runtime";
import { idof } from "./builtins";
import { E_INVALIDLENGTH } from "./util/error";

export abstract class ArrayBufferView {

  readonly buffer: ArrayBuffer;
  @unsafe readonly dataStart: usize;
  readonly byteLength: i32;

  get byteOffset(): i32 {
    return <i32>(this.dataStart - changetype<usize>(this.buffer));
  }

  protected constructor(length: i32, alignLog2: i32) {
    if (<u32>length > <u32>BLOCK_MAXSIZE >>> alignLog2) throw new RangeError(E_INVALIDLENGTH);
    let buffer = changetype<ArrayBuffer>(__new(length = length << alignLog2, idof<ArrayBuffer>()));
    if (ASC_RUNTIME != Runtime.Incremental) {
      memory.fill(changetype<usize>(buffer), 0, <usize>length);
    }
    this.buffer = buffer; // links
    this.dataStart = changetype<usize>(buffer);
    this.byteLength = length;
  }
}

@final export class ArrayBuffer {

  static isView<T>(value: T): bool {
    if (isNullable<T>()) {
      if (changetype<usize>(value) == 0) return false;
    }
    if (value instanceof Int8Array) return true;
    if (value instanceof Uint8Array) return true;
    if (value instanceof Uint8ClampedArray) return true;
    if (value instanceof Int16Array) return true;
    if (value instanceof Uint16Array) return true;
    if (value instanceof Int32Array) return true;
    if (value instanceof Uint32Array) return true;
    if (value instanceof Int64Array) return true;
    if (value instanceof Uint64Array) return true;
    if (value instanceof Float32Array) return true;
    if (value instanceof Float64Array) return true;
    if (value instanceof DataView) return true;
    return false;
  }

  constructor(length: i32) {
    if (<u32>length > <u32>BLOCK_MAXSIZE) throw new RangeError(E_INVALIDLENGTH);
    let buffer = changetype<ArrayBuffer>(__new(<usize>length, idof<ArrayBuffer>()));
    if (ASC_RUNTIME != Runtime.Incremental) {
      memory.fill(changetype<usize>(buffer), 0, <usize>length);
    }
    return buffer;
  }

  get byteLength(): i32 {
    return changetype<OBJECT>(changetype<usize>(this) - TOTAL_OVERHEAD).rtSize;
  }

  slice(begin: i32 = 0, end: i32 = BLOCK_MAXSIZE): ArrayBuffer {
    let length = this.byteLength;
    begin = begin < 0 ? max(length + begin, 0) : min(begin, length);
    end   = end   < 0 ? max(length + end  , 0) : min(end  , length);
    let outSize = <usize>max(end - begin, 0);
    let out = changetype<ArrayBuffer>(__new(outSize, idof<ArrayBuffer>()));
    memory.copy(changetype<usize>(out), changetype<usize>(this) + <usize>begin, outSize);
    return out;
  }

  toString(): string {
    return "[object ArrayBuffer]";
  }
}
`,atomics:`import { ArrayBufferView } from "./arraybuffer";
import { E_INDEXOUTOFRANGE } from "./util/error";

export namespace Atomics {

  // @ts-ignore: decorator
  @inline
  export function load<T extends ArrayBufferView>(array: T, index: i32): valueof<T> {
    const align = alignof<valueof<T>>();
    if (index < 0 || (index << align) >= array.byteLength) throw new RangeError(E_INDEXOUTOFRANGE);
    return atomic.load<valueof<T>>(
      changetype<usize>(array.buffer) + (index << align) + array.byteOffset
    );
  }

  // @ts-ignore: decorator
  @inline
  export function store<T extends ArrayBufferView>(array: T, index: i32, value: valueof<T>): void {
    const align = alignof<valueof<T>>();
    if (index < 0 || (index << align) >= array.byteLength) throw new RangeError(E_INDEXOUTOFRANGE);
    atomic.store<valueof<T>>(
      changetype<usize>(array.buffer) + (index << align) + array.byteOffset,
      value
    );
  }

  // @ts-ignore: decorator
  @inline
  export function add<T extends ArrayBufferView>(array: T, index: i32, value: valueof<T>): valueof<T> {
    const align = alignof<valueof<T>>();
    if (index < 0 || (index << align) >= array.byteLength) throw new RangeError(E_INDEXOUTOFRANGE);
    return atomic.add<valueof<T>>(
      changetype<usize>(array.buffer) + (index << align) + array.byteOffset,
      value
    );
  }

  // @ts-ignore: decorator
  @inline
  export function sub<T extends ArrayBufferView>(array: T, index: i32, value: valueof<T>): valueof<T> {
    const align = alignof<valueof<T>>();
    if (index < 0 || (index << align) >= array.byteLength) throw new RangeError(E_INDEXOUTOFRANGE);
    return atomic.sub<valueof<T>>(
      changetype<usize>(array.buffer) + (index << align) + array.byteOffset,
      value
    );
  }

  // @ts-ignore: decorator
  @inline
  export function and<T extends ArrayBufferView>(array: T, index: i32, value: valueof<T>): valueof<T> {
    const align = alignof<valueof<T>>();
    if (index < 0 || (index << align) >= array.byteLength) throw new RangeError(E_INDEXOUTOFRANGE);
    return atomic.and<valueof<T>>(
      changetype<usize>(array.buffer) + (index << align) + array.byteOffset,
      value
    );
  }

  // @ts-ignore: decorator
  @inline
  export function or<T extends ArrayBufferView>(array: T, index: i32, value: valueof<T>): valueof<T> {
    const align = alignof<valueof<T>>();
    if (index < 0 || (index << align) >= array.byteLength) throw new RangeError(E_INDEXOUTOFRANGE);
    return atomic.or<valueof<T>>(
      changetype<usize>(array.buffer) + (index << align) + array.byteOffset,
      value
    );
  }

  // @ts-ignore: decorator
  @inline
  export function xor<T extends ArrayBufferView>(array: T, index: i32, value: valueof<T>): valueof<T> {
    const align = alignof<valueof<T>>();
    if (index < 0 || (index << align) >= array.byteLength) throw new RangeError(E_INDEXOUTOFRANGE);
    return atomic.xor<valueof<T>>(
      changetype<usize>(array.buffer) + (index << align) + array.byteOffset,
      value
    );
  }

  // @ts-ignore: decorator
  @inline
  export function exchange<T extends ArrayBufferView>(array: T, index: i32, value: valueof<T>): valueof<T> {
    const align = alignof<valueof<T>>();
    if (index < 0 || (index << align) >= array.byteLength) throw new RangeError(E_INDEXOUTOFRANGE);
    return atomic.xchg<valueof<T>>(
      changetype<usize>(array.buffer) + (index << align) + array.byteOffset,
      value
    );
  }

  // @ts-ignore: decorator
  @inline
  export function compareExchange<T extends ArrayBufferView>(
    array: T,
    index: i32,
    expectedValue: valueof<T>,
    replacementValue: valueof<T>
  ): valueof<T> {
    const align = alignof<valueof<T>>();
    if (index < 0 || (index << align) >= array.byteLength) throw new RangeError(E_INDEXOUTOFRANGE);
    return atomic.cmpxchg<valueof<T>>(
      changetype<usize>(array.buffer) + (index << align) + array.byteOffset,
      expectedValue,
      replacementValue
    );
  }

  // @ts-ignore: decorator
  @inline
  export function wait<T extends ArrayBufferView>(array: T, value: valueof<T>, timeout: i64 = -1): AtomicWaitResult {
    return atomic.wait<valueof<T>>(changetype<usize>(array.buffer) + array.byteOffset, value, timeout);
  }

  // @ts-ignore: decorator
  @inline
  export function notify<T extends ArrayBufferView>(array: T, index: i32, count: i32 = -1): i32 {
    const align = alignof<valueof<T>>();
    if (index < 0 || (index << align) >= array.byteLength) throw new RangeError(E_INDEXOUTOFRANGE);
    return atomic.notify(changetype<usize>(array.buffer) + (index << align) + array.byteOffset, count);
  }

  export function isLockFree(size: usize): bool {
    return size == 1 || size == 2 || size == 4;
  }
}
`,"bindings/asyncify":`@unmanaged
export class StackDescriptor {
  /** The index in linear memory of the start of the \u201Casyncify stack\u201D. */
  stackStart: usize;
  /** The index of the end of that stack region, which implies how big it is. */
  stackEnd: usize;
}

/** Starts to unwind the call stack. */
export declare function start_unwind(data: StackDescriptor): void;
/** Stops unwinding the call stack. */
export declare function stop_unwind(): void;
/** Starts to rewind the call stack. */
export declare function start_rewind(data: StackDescriptor): void;
/** Stops rewinding the call stack. */
export declare function stop_rewind(): void;
`,"bindings/dom":`@external("env", "globalThis")
export declare const globalThis: externref;

export declare namespace Math {
  @external("env", "Math.E")
  export const E: f64;
  @external("env", "Math.LN2")
  export const LN2: f64;
  @external("env", "Math.LN10")
  export const LN10: f64;
  @external("env", "Math.LOG2E")
  export const LOG2E: f64;
  @external("env", "Math.LOG10E")
  export const LOG10E: f64;
  @external("env", "Math.PI")
  export const PI: f64;
  @external("env", "Math.SQRT1_2")
  export const SQRT1_2: f64;
  @external("env", "Math.SQRT2")
  export const SQRT2: f64;
  @external("env", "Math.abs")
  export function abs(x: f64): f64;
  @external("env", "Math.acos")
  export function acos(x: f64): f64;
  @external("env", "Math.acosh")
  export function acosh(x: f64): f64;
  @external("env", "Math.asin")
  export function asin(x: f64): f64;
  @external("env", "Math.asinh")
  export function asinh(x: f64): f64;
  @external("env", "Math.atan")
  export function atan(x: f64): f64;
  @external("env", "Math.atan2")
  export function atan2(y: f64, x: f64): f64;
  @external("env", "Math.atanh")
  export function atanh(x: f64): f64;
  @external("env", "Math.cbrt")
  export function cbrt(x: f64): f64;
  @external("env", "Math.ceil")
  export function ceil(x: f64): f64;
  @external("env", "Math.clz32")
  export function clz32(x: f64): f64;
  @external("env", "Math.cos")
  export function cos(x: f64): f64;
  @external("env", "Math.cosh")
  export function cosh(x: f64): f64;
  @external("env", "Math.exp")
  export function exp(x: f64): f64;
  @external("env", "Math.expm1")
  export function expm1(x: f64): f64;
  @external("env", "Math.floor")
  export function floor(x: f64): f64;
  @external("env", "Math.fround")
  export function fround(x: f64): f32;
  @external("env", "Math.hypot")
  export function hypot(value1: f64, value2: f64): f64; // TODO: rest
  @external("env", "Math.imul")
  export function imul(a: f64, b: f64): f64;
  @external("env", "Math.log")
  export function log(x: f64): f64;
  @external("env", "Math.log10")
  export function log10(x: f64): f64;
  @external("env", "Math.log1p")
  export function log1p(x: f64): f64;
  @external("env", "Math.log2")
  export function log2(x: f64): f64;
  @external("env", "Math.max")
  export function max(value1: f64, value2: f64): f64; // TODO: rest
  @external("env", "Math.min")
  export function min(value1: f64, value2: f64): f64; // TODO: rest
  @external("env", "Math.pow")
  export function pow(base: f64, exponent: f64): f64;
  @external("env", "Math.random")
  export function random(): f64;
  @external("env", "Math.round")
  export function round(x: f64): f64;
  @external("env", "Math.sign")
  export function sign(x: f64): f64;
  @external("env", "Math.sin")
  export function sin(x: f64): f64;
  @external("env", "Math.sinh")
  export function sinh(x: f64): f64;
  @external("env", "Math.sqrt")
  export function sqrt(x: f64): f64;
  @external("env", "Math.tan")
  export function tan(x: f64): f64;
  @external("env", "Math.tanh")
  export function tanh(x: f64): f64;
  @external("env", "Math.trunc")
  export function trunc(x: f64): f64;
}

export declare namespace Reflect {
  @external("env", "Reflect.get")
  export function get(target: externref, propertyKey: string): externref;
  @external("env", "Reflect.getWithReceiver")
  @external.js("return Reflect.get(target, propertyKey, receiver);")
  export function getWithReceiver(target: externref, propertyKey: string, receiver: externref): externref;
  @external("env", "Reflect.has")
  export function has(target: externref, propertyKey: string): bool;
  @external("env", "Reflect.set")
  export function set(target: externref, propertyKey: string, value: externref): externref;
  @external("env", "Reflect.setWithReceiver")
  @external.js("return Reflect.set(target, propertyKey, value, receiver);")
  export function setWithReceiver(target: externref, propertyKey: string, value: externref , receiver: externref): externref;
  @external("env", "Reflect.apply")
  export function apply(target: externref, thisArgument: externref, argumentsList: externref): externref;
}

export declare namespace String {
  @external("env", "String.fromCodePoint")
  export function fromCodePoint(codepoint: i32): externref;
  @external("env", "String.fromCodePoints")
  @external.js("return String.fromCodePoint(...codepoints);")
  export function fromCodePoints(codepoints: i32[]): externref;
}

export declare namespace Object {
  @external("env", "Object.is")
  export function is(a: externref, b: externref): bool;
  @external("env", "Object.hasOwn")
  export function hasOwn(target: externref, propertyKey: string): bool;
  @external("env", "Object.assign")
  export function assign(target: externref, source: externref): externref;
  @external("env", "Object.keys")
  export function keys(target: externref): externref;
  @external("env", "Object.values")
  export function values(target: externref): externref;
  @external("env", "Object.entries")
  export function entries(target: externref): externref;
  @external("env", "Object.getOwnPropertyNames")
  export function getOwnPropertyNames(target: externref): externref;
}

export declare namespace Date {
  @external("env", "Date.now")
  export function now(): f64;
}

export declare namespace console {
  @external("env", "console.assert")
  export function assert(condition: bool, message: string): void;
  @external("env", "console.log")
  export function log(text: string): void;
  @external("env", "console.debug")
  export function debug(text: string): void;
  @external("env", "console.info")
  export function info(text: string): void;
  @external("env", "console.warn")
  export function warn(text: string): void;
  @external("env", "console.error")
  export function error(text: string): void;
  @external("env", "console.time")
  export function time(label: string): void;
  @external("env", "console.timeLog")
  export function timeLog(label: string): void;
  @external("env", "console.timeEnd")
  export function timeEnd(label: string): void;
}

export declare namespace document {
  /** Returns document's encoding. */
  @external("env", "document.characterSet")
  export const characterSet: string;
  /** Returns a value that indicates whether standards-compliant mode is switched on for the object. */
  @external("env", "document.compatMode")
  export const compatMode: string;
  /** Returns document's content type. */
  @external("env", "document.contentType")
  export const contentType: string;
  /** Returns a reference to the root node of the document. */
  @external("env", "document.documentElement")
  export const documentElement: externref;
  /** Returns document's URL. */
  @external("env", "document.documentURI")
  export const documentURI: string;
  /** Returns the URL of the location that referred the user to the current page. */
  @external("env", "document.referrer")
  export const referrer: string;
  /** Returns true if document has the ability of fullscreen mode, or false otherwise. */
  @external("env", "document.pictureInPictureEnabled")
  export const fullscreenEnabled: bool;
  /** Returns true if document has the ability of picture-in-picture mode, or false otherwise. */
  @external("env", "document.pictureInPictureEnabled")
  export const pictureInPictureEnabled: bool;

  /** Returns the number of child elements. */
  @external("env", "document.childElementCount")
  export const childElementCount: i32;
  /** Returns the child elements. */
  @external("env", "document.children")
  export const children: externref;
  /** Returns the first child that is an element, and null otherwise. */
  @external("env", "document.firstElementChild")
  export const firstElementChild: externref;
  /** Returns the last child that is an element, and null otherwise. */
  @external("env", "document.lastElementChild")
  export const lastElementChild: externref;

  /**
   * Returns the HTTP cookies that apply to the Document. If there are no cookies or cookies can't be applied
   * to this resource, the empty string will be returned.
   *
   * Can be set, to add a new cookie to the element's set of HTTP cookies.
   *
   * If the contents are sandboxed into a unique origin (e.g. in an iframe with the sandbox attribute),
   * a "SecurityError" DOMException will be thrown on getting and setting.
   */
  @external("env", "document.cookie")
  export let cookie: string;
  /** Represents the <body> or <frameset> node of the current document, or null if no such element exists. */
  @external("env", "document.body")
  export let body: externref;
  /** Sets or gets the security domain of the document. */
  @external("env", "document.domain")
  export let domain: string;
  /** Sets or gets the title of the document. */
  @external("env", "document.title")
  export let title: string;
  /** Sets or gets information about the current Location. */
  @external("env", "document.location")
  export let location: externref;
  /** Sets or gets the URL for the current document. */
  @external("env", "document.URL")
  export let URL: string;

  /**
   * Creates an instance of the element for the specified tag.
   * @param tagName The name of an element.
   */
  @external("env", "document.createElement")
  export function createElement(tagName: string /* , options?: ElementCreationOptions */): externref;
  /**
   * Returns a reference to the first HTMLElement object with the specified value of the ID attribute.
   * @param id String that specifies the ID value.
   */
  @external("env", "document.getElementById")
  export function getElementById(id: string): externref;
  /**
   * Returns a HTMLCollection of the elements in the object on which the method was invoked that have all the classes
   * given by classNames. The classNames argument is interpreted as a space-separated list of classes.
   * @param classNames Gets a collection of objects based on the value of the CLASS attribute.
   */
  @external("env", "document.getElementsByClassName")
  export function getElementsByClassName(classNames: string): externref;
  /**
   * Gets a collection of HTMLElement objects based on the value of the NAME or ID attribute.
   * @param elementName Gets a collection of objects based on the value of the NAME or ID attribute.
   */
  @external("env", "document.getElementsByName")
  export function getElementsByName(elementName: string): externref;
  /** Gets a value indicating whether the object currently has focus. */
  @external("env", "document.hasFocus")
  export function hasFocus(): bool;
  /** Inserts nodes after the last child of node, while replacing strings in nodes with equivalent Text nodes. */
  @external("env", "document.append")
  export function append(node: externref): void;
  /** Inserts nodes before the first child of node, while replacing strings in nodes with equivalent Text nodes. */
  @external("env", "document.prepend")
  export function prepend(node: externref): void;
  /** Replace all children of node with nodes, while replacing strings in nodes with equivalent Text nodes. */
  @external("env", "document.replaceChildren")
  export function replaceChildren(node: externref): void;
  /**
   * Writes one or more HTML expressions to a document in the specified window.
   * @param content Specifies the text and HTML tags to write.
   */
  @external("env", "document.write")
  export function write(content: string): void;
  /**
   * Writes one or more HTML expressions, followed by a carriage return, to a document in the specified window.
   * @param content Specifies the text and HTML tags to write.
   */
  @external("env", "document.writeln")
  export function writeln(content: string): void;
}

export declare namespace performance {
  @external("env", "performance.now")
  export function now(): f64;
}

export namespace crypto {
  export function getRandomValues(array: Uint8Array): void {
    let values = getRandomValuesN(array.length);
    array.set(values);
  }
  @external("env", "crypto.getRandomValuesN")
  @external.js("let a = new Uint8Array(n); crypto.getRandomValues(a); return a;")
  export declare function getRandomValuesN(n: u32): Uint8Array;
}
`,"bindings/node":`export declare namespace process {
  @external("env", "process.argv")
  export const argv: string[];
  @external("env", "process.exit")
  export function exit(code: i32): void;
}
`,builtins:`import { strtol, strtod, strtob } from "./util/string";

type auto = i32;

// @ts-ignore: decorator
@builtin
export declare function isBoolean<T>(value?: T): bool;

// @ts-ignore: decorator
@builtin
export declare function isInteger<T>(value?: T): bool;

// @ts-ignore: decorator
@builtin
export declare function isSigned<T>(value?: T): bool;

// @ts-ignore: decorator
@builtin
export declare function isFloat<T>(value?: T): bool;

// @ts-ignore: decorator
@builtin
export declare function isVector<T>(value?: T): bool;

// @ts-ignore: decorator
@builtin
export declare function isReference<T>(value?: T): bool;

// @ts-ignore: decorator
@builtin
export declare function isString<T>(value?: T): bool;

// @ts-ignore: decorator
@builtin
export declare function isArray<T>(value?: T): bool;

// @ts-ignore: decorator
@builtin
export declare function isArrayLike<T>(value?: T): bool;

// @ts-ignore: decorator
@builtin
export declare function isFunction<T>(value?: T): bool;

// @ts-ignore: decorator
@builtin
export declare function isNullable<T>(value?: T): bool;

// @ts-ignore: decorator
@builtin
export declare function isDefined(expression: auto): bool;

// @ts-ignore: decorator
@builtin
export declare function isConstant(expression: auto): bool;

// @ts-ignore: decorator
@builtin
export declare function isManaged<T>(value?: T): bool;

// @ts-ignore: decorator
@builtin
export declare function isVoid<T>(): bool;

// @ts-ignore
@builtin
export declare function lengthof<T>(func?: T): i32;

// @ts-ignore: decorator
@builtin
export declare function clz<T>(value: T): T;

// @ts-ignore: decorator
@builtin
export declare function ctz<T>(value: T): T;

// @ts-ignore: decorator
@builtin
export declare function popcnt<T>(value: T): T;

// @ts-ignore: decorator
@builtin
export declare function rotl<T>(value: T, shift: T): T;

// @ts-ignore: decorator
@builtin
export declare function rotr<T>(value: T, shift: T): T;

// @ts-ignore: decorator
@builtin
export declare function abs<T>(value: T): T;

// @ts-ignore: decorator
@builtin
export declare function max<T>(left: T, right: T): T;

// @ts-ignore: decorator
@builtin
export declare function min<T>(left: T, right: T): T;

// @ts-ignore: decorator
@builtin
export declare function ceil<T>(value: T): T;

// @ts-ignore: decorator
@builtin
export declare function floor<T>(value: T): T;

// @ts-ignore: decorator
@builtin
export declare function copysign<T>(left: T, right: T): T;

// @ts-ignore: decorator
@builtin
export declare function nearest<T>(value: T): T;

// @ts-ignore: decorator
@builtin
export declare function reinterpret<T>(value: number): T;

// @ts-ignore: decorator
@builtin
export declare function sqrt<T>(value: T): T;

// @ts-ignore: decorator
@builtin
export declare function trunc<T>(value: T): T;

// @ts-ignore: decorator
@builtin
export declare function add<T>(left: T, right: T): T;

// @ts-ignore: decorator
@builtin
export declare function sub<T>(left: T, right: T): T;

// @ts-ignore: decorator
@builtin
export declare function mul<T>(left: T, right: T): T;

// @ts-ignore: decorator
@builtin
export declare function div<T>(left: T, right: T): T;

// @ts-ignore: decorator
@builtin
export declare function eq<T>(left: T, right: T): i32;

// @ts-ignore: decorator
@builtin
export declare function ne<T>(left: T, right: T): i32;

// @ts-ignore: decorator
@builtin
export declare function rem<T>(left: T, right: T): T;

// @ts-ignore: decorator
@unsafe @builtin
export declare function load<T>(ptr: usize, immOffset?: usize, immAlign?: usize): T;

// @ts-ignore: decorator
@unsafe @builtin
export declare function store<T>(ptr: usize, value: auto, immOffset?: usize, immAlign?: usize): void;

// @ts-ignore: decorator
@builtin
export declare function sizeof<T>(): usize; // | u32 / u64

// @ts-ignore: decorator
@builtin
export declare function alignof<T>(): usize; // | u32 / u64

// @ts-ignore: decorator
@builtin
export declare function offsetof<T>(fieldName?: string): usize; // | u32 / u64

// @ts-ignore: decorator
@builtin
export declare function idof<T>(): u32;

// @ts-ignore
@builtin
export declare function nameof<T>(): string;

// @ts-ignore: decorator
@builtin
export declare function select<T>(ifTrue: T, ifFalse: T, condition: bool): T;

// @ts-ignore: decorator
@unsafe @builtin
export declare function unreachable(): auto;

// @ts-ignore: decorator
@builtin
export declare function changetype<T>(value: auto): T;

// @ts-ignore: decorator
@builtin
export declare function assert<T>(isTrueish: T, message?: string): T;

// @ts-ignore: decorator
@unsafe @builtin
export declare function unchecked<T>(expr: T): T;

export namespace inline {
  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function always<T>(expr: T): T;
}

// @ts-ignore: decorator
@unsafe @builtin
export declare function call_indirect<T>(index: u32, ...args: auto[]): T;

// @ts-ignore: decorator
@builtin
export declare function instantiate<T>(...args: auto[]): T;

export namespace atomic {
  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function load<T>(ptr: usize, immOffset?: usize): T;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function store<T>(ptr: usize, value: T, immOffset?: usize): void;

  // @ts-ignore: decorator
  @builtin
  export declare function add<T>(ptr: usize, value: T, immOffset?: usize): T;

  // @ts-ignore: decorator
  @builtin
  export declare function sub<T>(ptr: usize, value: T, immOffset?: usize): T;

  // @ts-ignore: decorator
  @builtin
  export declare function and<T>(ptr: usize, value: T, immOffset?: usize): T;

  // @ts-ignore: decorator
  @builtin
  export declare function or<T>(ptr: usize, value: T, immOffset?: usize): T;

  // @ts-ignore: decorator
  @builtin
  export declare function xor<T>(ptr: usize, value: T, immOffset?: usize): T;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function xchg<T>(ptr: usize, value: T, immOffset?: usize): T;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function cmpxchg<T>(ptr: usize, expected: T, replacement: T, immOffset?: usize): T;

  // @ts-ignore: decorator
  @builtin
  export declare function wait<T>(ptr: usize, expected: T, timeout: i64): AtomicWaitResult;

  // @ts-ignore: decorator
  @builtin
  export declare function notify(ptr: usize, count: i32): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function fence(): void;
}

// @ts-ignore: decorator
@lazy
export const enum AtomicWaitResult {
  OK = 0,
  NOT_EQUAL = 1,
  TIMED_OUT = 2
}

// @ts-ignore: decorator
@builtin
export declare function i8(value: auto): i8;

export namespace i8 {

  // @ts-ignore: decorator
  @lazy
  export const MIN_VALUE: i8 = -128;

  // @ts-ignore: decorator
  @lazy
  export const MAX_VALUE: i8 =  127;

  // @ts-ignore: decorator
  @inline
  export function parse(value: string, radix: i32 = 0): i8 {
    return <i8>strtol<i32>(value, radix);
  }
}

// @ts-ignore: decorator
@builtin
export declare function i16(value: auto): i16;

export namespace i16 {

  // @ts-ignore: decorator
  @lazy
  export const MIN_VALUE: i16 = -32768;

  // @ts-ignore: decorator
  @lazy
  export const MAX_VALUE: i16 =  32767;

  // @ts-ignore: decorator
  @inline
  export function parse(value: string, radix: i32 = 0): i16 {
    return <i16>strtol<i32>(value, radix);
  }
}

// @ts-ignore: decorator
@builtin
export declare function i32(value: auto): i32;

export namespace i32 {

  // @ts-ignore: decorator
  @lazy
  export const MIN_VALUE: i32 = -2147483648;

  // @ts-ignore: decorator
  @lazy
  export const MAX_VALUE: i32 =  2147483647;

  // @ts-ignore: decorator
  @inline
  export function parse(value: string, radix: i32 = 0): i32 {
    return strtol<i32>(value, radix);
  }

  // @ts-ignore: decorator
  @builtin
  export declare function clz(value: i32): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function ctz(value: i32): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function popcnt(value: i32): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function add(left: i32, right:i32): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function sub(left: i32, right:i32): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function mul(left: i32, right:i32): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function div_s(left: i32, right:i32): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function div_u(left: i32, right:i32): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function rotl(value: i32, shift: i32): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function rotr(value: i32, shift: i32): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function eq(left: i32, right:i32): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function ne(left: i32, right:i32): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function rem_s(left: i32, right: i32): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function rem_u(left: u32, right: u32): u32;

  // @ts-ignore: decorator
  @builtin
  export declare function reinterpret_f32(value: f32): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function load8_s(ptr: usize, immOffset?: usize, immAlign?: usize): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function load8_u(ptr: usize, immOffset?: usize, immAlign?: usize): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function load16_s(ptr: usize, immOffset?: usize, immAlign?: usize): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function load16_u(ptr: usize, immOffset?: usize, immAlign?: usize): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function load(ptr: usize, immOffset?: usize, immAlign?: usize): i32;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function store8(ptr: usize, value: i32, immOffset?: usize, immAlign?: usize): void;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function store16(ptr: usize, value: i32, immOffset?: usize, immAlign?: usize): void;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function store(ptr: usize, value: i32, immOffset?: usize, immAlign?: usize): void;

  export namespace atomic {

    // @ts-ignore: decorator
    @builtin
    export declare function load8_u(ptr: usize, immOffset?: usize): i32;

    // @ts-ignore: decorator
    @builtin
    export declare function load16_u(ptr: usize, immOffset?: usize): i32;

    // @ts-ignore: decorator
    @builtin
    export declare function load(ptr: usize, immOffset?: usize): i32;

    // @ts-ignore: decorator
    @unsafe @builtin
    export declare function store8(ptr: usize, value: i32, immOffset?: usize): void;

    // @ts-ignore: decorator
    @unsafe @builtin
    export declare function store16(ptr: usize, value: i32, immOffset?: usize): void;

    // @ts-ignore: decorator
    @unsafe @builtin
    export declare function store(ptr: usize, value: i32, immOffset?: usize): void;

    export namespace rmw8 {

      // @ts-ignore: decorator
      @builtin
      export declare function add_u(ptr: usize, value: i32, immOffset?: usize): i32;

      // @ts-ignore: decorator
      @builtin
      export declare function sub_u(ptr: usize, value: i32, immOffset?: usize): i32;

      // @ts-ignore: decorator
      @builtin
      export declare function and_u(ptr: usize, value: i32, immOffset?: usize): i32;

      // @ts-ignore: decorator
      @builtin
      export declare function or_u(ptr: usize, value: i32, immOffset?: usize): i32;

      // @ts-ignore: decorator
      @builtin
      export declare function xor_u(ptr: usize, value: i32, immOffset?: usize): i32;

      // @ts-ignore: decorator
      @unsafe @builtin
      export declare function xchg_u(ptr: usize, value: i32, immOffset?: usize): i32;

      // @ts-ignore: decorator
      @unsafe @builtin
      export declare function cmpxchg_u(ptr: usize, expected: i32, replacement: i32, immOffset?: usize): i32;
    }

    export namespace rmw16 {

      // @ts-ignore: decorator
      @builtin
      export declare function add_u(ptr: usize, value: i32, immOffset?: usize): i32;

      // @ts-ignore: decorator
      @builtin
      export declare function sub_u(ptr: usize, value: i32, immOffset?: usize): i32;

      // @ts-ignore: decorator
      @builtin
      export declare function and_u(ptr: usize, value: i32, immOffset?: usize): i32;

      // @ts-ignore: decorator
      @builtin
      export declare function or_u(ptr: usize, value: i32, immOffset?: usize): i32;

      // @ts-ignore: decorator
      @builtin
      export declare function xor_u(ptr: usize, value: i32, immOffset?: usize): i32;

      // @ts-ignore: decorator
      @unsafe @builtin
      export declare function xchg_u(ptr: usize, value: i32, immOffset?: usize): i32;

      // @ts-ignore: decorator
      @unsafe @builtin
      export declare function cmpxchg_u(ptr: usize, expected: i32, replacement: i32, immOffset?: usize): i32;
    }

    export namespace rmw {

      // @ts-ignore: decorator
      @builtin
      export declare function add(ptr: usize, value: i32, immOffset?: usize): i32;

      // @ts-ignore: decorator
      @builtin
      export declare function sub(ptr: usize, value: i32, immOffset?: usize): i32;

      // @ts-ignore: decorator
      @builtin
      export declare function and(ptr: usize, value: i32, immOffset?: usize): i32;

      // @ts-ignore: decorator
      @builtin
      export declare function or(ptr: usize, value: i32, immOffset?: usize): i32;

      // @ts-ignore: decorator
      @builtin
      export declare function xor(ptr: usize, value: i32, immOffset?: usize): i32;

      // @ts-ignore: decorator
      @unsafe @builtin
      export declare function xchg(ptr: usize, value: i32, immOffset?: usize): i32;

      // @ts-ignore: decorator
      @unsafe @builtin
      export declare function cmpxchg(ptr: usize, expected: i32, replacement: i32, immOffset?: usize): i32;
    }
  }
}

// @ts-ignore: decorator
@builtin
export declare function i64(value: auto): i64;

export namespace i64 {

  // @ts-ignore: decorator
  @lazy
  export const MIN_VALUE: i64 = -9223372036854775808;

  // @ts-ignore: decorator
  @lazy
  export const MAX_VALUE: i64 =  9223372036854775807;

  // @ts-ignore: decorator
  @inline
  export function parse(value: string, radix: i32 = 0): i64 {
    return strtol<i64>(value, radix);
  }

  // @ts-ignore: decorator
  @builtin
  export declare function clz(value: i64): i64;

  // @ts-ignore: decorator
  @builtin
  export declare function ctz(value: i64): i64;

  // @ts-ignore: decorator
  @builtin
  export declare function add(left: i64, right:i64): i64;

  // @ts-ignore: decorator
  @builtin
  export declare function sub(left: i64, right:i64): i64;

  // @ts-ignore: decorator
  @builtin
  export declare function mul(left: i64, right:i64): i64;

  // @ts-ignore: decorator
  @builtin
  export declare function div_s(left: i64, right:i64): i64;

  // @ts-ignore: decorator
  @builtin
  export declare function div_u(left: i64, right:i64): i64;

  // @ts-ignore: decorator
  @builtin
  export declare function load8_s(ptr: usize, immOffset?: usize, immAlign?: usize): i64;

  // @ts-ignore: decorator
  @builtin
  export declare function load8_u(ptr: usize, immOffset?: usize, immAlign?: usize): i64;

  // @ts-ignore: decorator
  @builtin
  export declare function load16_s(ptr: usize, immOffset?: usize, immAlign?: usize): i64;

  // @ts-ignore: decorator
  @builtin
  export declare function load16_u(ptr: usize, immOffset?: usize, immAlign?: usize): i64;

  // @ts-ignore: decorator
  @builtin
  export declare function load32_s(ptr: usize, immOffset?: usize, immAlign?: usize): i64;

  // @ts-ignore: decorator
  @builtin
  export declare function load32_u(ptr: usize, immOffset?: usize, immAlign?: usize): i64;

  // @ts-ignore: decorator
  @builtin
  export declare function load(ptr: usize, immOffset?: usize): i64;

  // @ts-ignore: decorator
  @builtin
  export declare function popcnt(value: i64): i64;

  // @ts-ignore: decorator
  @builtin
  export declare function rotl(value: i64, shift: i64): i64;

  // @ts-ignore: decorator
  @builtin
  export declare function rotr(value: i64, shift: i64): i64;

  // @ts-ignore: decorator
  @builtin
  export declare function eq(left: i64, right:i64): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function ne(left: i64, right:i64): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function rem_s(left: i64, right: i64): i64;

  // @ts-ignore: decorator
  @builtin
  export declare function rem_u(left: u64, right: u64): u64;

  // @ts-ignore: decorator
  @builtin
  export declare function reinterpret_f64(value: f64): i64;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function store8(ptr: usize, value: i64, immOffset?: usize, immAlign?: usize): void;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function store16(ptr: usize, value: i64, immOffset?: usize, immAlign?: usize): void;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function store32(ptr: usize, value: i64, immOffset?: usize, immAlign?: usize): void;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function store(ptr: usize, value: i64, immOffset?: usize, immAlign?: usize): void;

  export namespace atomic {

    // @ts-ignore: decorator
    @builtin
    export declare function load8_u(ptr: usize, immOffset?: usize): i64;

    // @ts-ignore: decorator
    @builtin
    export declare function load16_u(ptr: usize, immOffset?: usize): i64;

    // @ts-ignore: decorator
    @builtin
    export declare function load32_u(ptr: usize, immOffset?: usize): i64;

    // @ts-ignore: decorator
    @builtin
    export declare function load(ptr: usize, immOffset?: usize): i64;

    // @ts-ignore: decorator
    @unsafe @builtin
    export declare function store8(ptr: usize, value: i64, immOffset?: usize): void;

    // @ts-ignore: decorator
    @unsafe @builtin
    export declare function store16(ptr: usize, value: i64, immOffset?: usize): void;

    // @ts-ignore: decorator
    @unsafe @builtin
    export declare function store32(ptr: usize, value: i64, immOffset?: usize): void;

    // @ts-ignore: decorator
    @unsafe @builtin
    export declare function store(ptr: usize, value: i64, immOffset?: usize): void;

    export namespace rmw8 {

      // @ts-ignore: decorator
      @builtin
      export declare function add_u(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @builtin
      export declare function sub_u(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @builtin
      export declare function and_u(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @builtin
      export declare function or_u(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @builtin
      export declare function xor_u(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @unsafe @builtin
      export declare function xchg_u(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @unsafe @builtin
      export declare function cmpxchg_u(ptr: usize, expected: i64, replacement: i64, immOffset?: usize): i64;
    }

    export namespace rmw16 {

      // @ts-ignore: decorator
      @builtin
      export declare function add_u(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @builtin
      export declare function sub_u(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @builtin
      export declare function and_u(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @builtin
      export declare function or_u(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @builtin
      export declare function xor_u(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @unsafe @builtin
      export declare function xchg_u(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @unsafe @builtin
      export declare function cmpxchg_u(ptr: usize, expected: i64, replacement: i64, immOffset?: usize): i64;
    }

    export namespace rmw32 {

      // @ts-ignore: decorator
      @builtin
      export declare function add_u(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @builtin
      export declare function sub_u(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @builtin
      export declare function and_u(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @builtin
      export declare function or_u(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @builtin
      export declare function xor_u(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @unsafe @builtin
      export declare function xchg_u(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @unsafe @builtin
      export declare function cmpxchg_u(ptr: usize, expected: i64, replacement: i64, immOffset?: usize): i64;
    }

    export namespace rmw {

      // @ts-ignore: decorator
      @builtin
      export declare function add(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @builtin
      export declare function sub(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @builtin
      export declare function and(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @builtin
      export declare function or(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @builtin
      export declare function xor(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @unsafe @builtin
      export declare function xchg(ptr: usize, value: i64, immOffset?: usize): i64;

      // @ts-ignore: decorator
      @unsafe @builtin
      export declare function cmpxchg(ptr: usize, expected: i64, replacement: i64, immOffset?: usize): i64;
    }
  }
}

// @ts-ignore: decorator
@builtin
export declare function isize(value: auto): isize;

export namespace isize {

  // @ts-ignore: decorator
  @lazy
  export const MIN_VALUE: isize = sizeof<i32>() == sizeof<isize>()
    ? -2147483648
    : <isize>-9223372036854775808;

  // @ts-ignore: decorator
  @lazy
  export const MAX_VALUE: isize = sizeof<i32>() == sizeof<isize>()
    ? 2147483647
    : <isize>9223372036854775807;

  // @ts-ignore: decorator
  @inline
  export function parse(value: string, radix: i32 = 0): isize {
    return <isize>strtol<i64>(value, radix);
  }
}

// @ts-ignore: decorator
@builtin
export declare function u8(value: auto): u8;

export namespace u8 {

  // @ts-ignore: decorator
  @lazy
  export const MIN_VALUE: u8 = 0;

  // @ts-ignore: decorator
  @lazy
  export const MAX_VALUE: u8 = 255;

  // @ts-ignore: decorator
  @inline
  export function parse(value: string, radix: i32 = 0): u8 {
    return <u8>strtol<i32>(value, radix);
  }
}

// @ts-ignore: decorator
@builtin
export declare function u16(value: auto): u16;

export namespace u16 {

  // @ts-ignore: decorator
  @lazy
  export const MIN_VALUE: u16 = 0;

  // @ts-ignore: decorator
  @lazy
  export const MAX_VALUE: u16 = 65535;

  // @ts-ignore: decorator
  @inline
  export function parse(value: string, radix: i32 = 0): u16 {
    return <u16>strtol<i32>(value, radix);
  }
}

// @ts-ignore: decorator
@builtin
export declare function u32(value: auto): u32;

export namespace u32 {

  // @ts-ignore: decorator
  @lazy
  export const MIN_VALUE: u32 = 0;

  // @ts-ignore: decorator
  @lazy
  export const MAX_VALUE: u32 = 4294967295;

  // @ts-ignore: decorator
  @inline
  export function parse(value: string, radix: i32 = 0): u32 {
    return <u32>strtol<i32>(value, radix);
  }
}

// @ts-ignore: decorator
@builtin
export declare function u64(value: auto): u64;

export namespace u64 {

  // @ts-ignore: decorator
  @lazy
  export const MIN_VALUE: u64 = 0;

  // @ts-ignore: decorator
  @lazy
  export const MAX_VALUE: u64 = 18446744073709551615;

  // @ts-ignore: decorator
  @inline
  export function parse(value: string, radix: i32 = 0): u64 {
    return <u64>strtol<i64>(value, radix);
  }
}

// @ts-ignore: decorator
@builtin
export declare function usize(value: auto): usize;

export namespace usize {

  // @ts-ignore: decorator
  @lazy
  export const MIN_VALUE: usize = 0;

  // @ts-ignore: decorator
  @lazy
  export const MAX_VALUE: usize = sizeof<u32>() == sizeof<usize>()
    ? 4294967295
    : <usize>18446744073709551615;

  // @ts-ignore: decorator
  @inline
  export function parse(value: string, radix: i32 = 0): usize {
    return <usize>strtol<i64>(value, radix);
  }
}

// @ts-ignore: decorator
@builtin
export declare function bool(value: auto): bool;

export namespace bool {

  // @ts-ignore: decorator
  @lazy
  export const MIN_VALUE: bool = false;

  // @ts-ignore: decorator
  @lazy
  export const MAX_VALUE: bool = true;

  // @ts-ignore: decorator
  @inline
  export function parse(value: string): bool {
    return strtob(value);
  }
}

// @ts-ignore: decorator
@builtin
export declare function f32(value: auto): f32;

export namespace f32 {

  // @ts-ignore: decorator
  @lazy
  export const EPSILON = reinterpret<f32>(0x34000000); // 0x1p-23f

  // @ts-ignore: decorator
  @lazy
  export const MIN_VALUE = reinterpret<f32>(0x00000001); // 0x0.000001p+0f

  // @ts-ignore: decorator
  @lazy
  export const MAX_VALUE = reinterpret<f32>(0x7F7FFFFF); // 0x1.fffffep+127f

  // @ts-ignore: decorator
  @lazy
  export const MIN_NORMAL_VALUE = reinterpret<f32>(0x00800000); // 0x1p-126f

  // @ts-ignore: decorator
  @lazy
  export const MIN_SAFE_INTEGER: f32 = -16777215;

  // @ts-ignore: decorator
  @lazy
  export const MAX_SAFE_INTEGER: f32 =  16777215;

  // @ts-ignore: decorator
  @lazy
  export const POSITIVE_INFINITY: f32 =  Infinity;

  // @ts-ignore: decorator
  @lazy
  export const NEGATIVE_INFINITY: f32 = -Infinity;

  // @ts-ignore: decorator
  @lazy
  export const NaN: f32 = 0.0 / 0.0;

  // @ts-ignore: decorator
  @inline
  export function parse(value: string): f32 {
    return <f32>strtod(value);
  }

  // @ts-ignore: decorator
  @builtin
  export declare function abs(value: f32): f32;

  // @ts-ignore: decorator
  @builtin
  export declare function ceil(value: f32): f32;

  // @ts-ignore: decorator
  @builtin
  export declare function copysign(x: f32, y: f32): f32;

  // @ts-ignore: decorator
  @builtin
  export declare function floor(value: f32): f32;

  // @ts-ignore: decorator
  @builtin
  export declare function load(ptr: usize, immOffset?: usize, immAlign?: usize): f32;

  // @ts-ignore: decorator
  @builtin
  export declare function max(left: f32, right: f32): f32;

  // @ts-ignore: decorator
  @builtin
  export declare function min(left: f32, right: f32): f32;

  // @ts-ignore: decorator
  @builtin
  export declare function nearest(value: f32): f32;

  // @ts-ignore: decorator
  @builtin
  export declare function reinterpret_i32(value: i32): f32;

  // @ts-ignore: decorator
  @builtin
  export declare function sqrt(value: f32): f32;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function store(ptr: usize, value: f32, immOffset?: usize, immAlign?: usize): void;

  // @ts-ignore: decorator
  @builtin
  export declare function trunc(value: f32): f32;

  // @ts-ignore: decorator
  @builtin
  export declare function add(left: f32, right: f32): f32;

  // @ts-ignore: decorator
  @builtin
  export declare function sub(left: f32, right: f32): f32;

  // @ts-ignore: decorator
  @builtin
  export declare function mul(left: f32, right: f32): f32;

  // @ts-ignore: decorator
  @builtin
  export declare function div(left: f32, right: f32): f32;

  // @ts-ignore: decorator
  @builtin
  export declare function eq(left: f32, right: f32): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function ne(left: f32, right: f32): i32;
}

// @ts-ignore: decorator
@builtin
export declare function f64(value: auto): f64;

export namespace f64 {

  // @ts-ignore: decorator
  @lazy
  export const EPSILON = reinterpret<f64>(0x3CB0000000000000); // 0x1p-52

  // @ts-ignore: decorator
  @lazy
  export const MIN_VALUE = reinterpret<f64>(0x0000000000000001); // 0x0.0000000000001p+0

  // @ts-ignore: decorator
  @lazy
  export const MAX_VALUE = reinterpret<f64>(0x7FEFFFFFFFFFFFFF); // 0x1.fffffffffffffp+1023

  // @ts-ignore: decorator
  @lazy
  export const MIN_NORMAL_VALUE = reinterpret<f64>(0x0010000000000000); // 0x1p-1022

  // @ts-ignore: decorator
  @lazy
  export const MIN_SAFE_INTEGER: f64 = -9007199254740991;

  // @ts-ignore: decorator
  @lazy
  export const MAX_SAFE_INTEGER: f64 =  9007199254740991;

  // @ts-ignore: decorator
  @lazy
  export const POSITIVE_INFINITY: f64 =  Infinity;

  // @ts-ignore: decorator
  @lazy
  export const NEGATIVE_INFINITY: f64 = -Infinity;

  // @ts-ignore: decorator
  @lazy
  export const NaN: f64 = 0.0 / 0.0;

  // @ts-ignore: decorator
  @inline
  export function parse(value: string): f64 {
    return strtod(value);
  }

  // @ts-ignore: decorator
  @builtin
  export declare function abs(value: f64): f64;

  // @ts-ignore: decorator
  @builtin
  export declare function ceil(value: f64): f64;

  // @ts-ignore: decorator
  @builtin
  export declare function copysign(x: f64, y: f64): f64;

  // @ts-ignore: decorator
  @builtin
  export declare function floor(value: f64): f64;

  // @ts-ignore: decorator
  @builtin
  export declare function load(ptr: usize, immOffset?: usize, immAlign?: usize): f64;

  // @ts-ignore: decorator
  @builtin
  export declare function max(left: f64, right: f64): f64;

  // @ts-ignore: decorator
  @builtin
  export declare function min(left: f64, right: f64): f64;

  // @ts-ignore: decorator
  @builtin
  export declare function nearest(value: f64): f64;

  // @ts-ignore: decorator
  @builtin
  export declare function reinterpret_i64(value: i64): f64;

  // @ts-ignore: decorator
  @builtin
  export declare function sqrt(value: f64): f64;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function store(ptr: usize, value: f64, immOffset?: usize, immAlign?: usize): void;

  // @ts-ignore: decorator
  @builtin
  export declare function trunc(value: f64): f64;

  // @ts-ignore: decorator
  @builtin
  export declare function add(left: f64, right: f64): f64;

  // @ts-ignore: decorator
  @builtin
  export declare function sub(left: f64, right: f64): f64;

  // @ts-ignore: decorator
  @builtin
  export declare function mul(left: f64, right: f64): f64;

  // @ts-ignore: decorator
  @builtin
  export declare function div(left: f64, right: f64): f64;

  // @ts-ignore: decorator
  @builtin
  export declare function eq(left: f64, right: f64): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function ne(left: f64, right: f64): i32;
}

// @ts-ignore: decorator
@builtin
export declare function v128(
  a: i8, b: i8, c: i8, d: i8, e: i8, f: i8, g: i8, h: i8,
  i: i8, j: i8, k: i8, l: i8, m: i8, n: i8, o: i8, p: i8
): v128;

export namespace v128 {

  // @ts-ignore: decorator
  @builtin
  export declare function splat<T>(x: T): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extract_lane<T>(x: v128, idx: u8): T;

  // @ts-ignore: decorator
  @builtin
  export declare function replace_lane<T>(x: v128, idx: u8, value: T): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shuffle<T>(a: v128, b: v128, ...lanes: u8[]): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function swizzle(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function load(ptr: usize, immOffset?: usize, immAlign?: usize): v128;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function load_ext<TFrom>(ptr: usize, immOffset?: usize, immAlign?: usize): v128;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function load_zero<TFrom>(ptr: usize, immOffset?: usize, immAlign?: usize): v128;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function load_lane<TFrom>(ptr: usize, vec: v128, idx: u8, immOffset?: usize, immAlign?: usize): v128;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function store_lane<TFrom>(ptr: usize, vec: v128, idx: u8, immOffset?: usize, immAlign?: usize): void;

  // @ts-ignore: decorator
  @builtin
  export declare function load8x8_s(ptr: usize, immOffset?: u32, immAlign?: u32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function load8x8_u(ptr: usize, immOffset?: u32, immAlign?: u32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function load16x4_s(ptr: usize, immOffset?: u32, immAlign?: u32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function load16x4_u(ptr: usize, immOffset?: u32, immAlign?: u32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function load32x2_s(ptr: usize, immOffset?: u32, immAlign?: u32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function load32x2_u(ptr: usize, immOffset?: u32, immAlign?: u32): v128;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function load_splat<T>(ptr: usize, immOffset?: usize, immAlign?: usize): v128;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function load8_splat(ptr: usize, immOffset?: u32, immAlign?: u32): v128;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function load16_splat(ptr: usize, immOffset?: u32, immAlign?: u32): v128;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function load32_splat(ptr: usize, immOffset?: u32, immAlign?: u32): v128;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function load64_splat(ptr: usize, immOffset?: u32, immAlign?: u32): v128;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function load32_zero(ptr: usize, immOffset?: u32, immAlign?: u32): v128;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function load64_zero(ptr: usize, immOffset?: u32, immAlign?: u32): v128;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function load8_lane(ptr: usize, vec: v128, idx: u8, immOffset?: u32, immAlign?: u32): v128;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function load16_lane(ptr: usize, vec: v128, idx: u8, immOffset?: u32, immAlign?: u32): v128;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function load32_lane(ptr: usize, vec: v128, idx: u8, immOffset?: u32, immAlign?: u32): v128;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function load64_lane(ptr: usize, vec: v128, idx: u8, immOffset?: u32, immAlign?: u32): v128;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function store8_lane(ptr: usize, vec: v128, idx: u8, immOffset?: u32, immAlign?: u32): void;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function store16_lane(ptr: usize, vec: v128, idx: u8, immOffset?: u32, immAlign?: u32): void;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function store32_lane(ptr: usize, vec: v128, idx: u8, immOffset?: u32, immAlign?: u32): void;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function store64_lane(ptr: usize, vec: v128, idx: u8, immOffset?: u32, immAlign?: u32): void;

  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function store(ptr: usize, value: v128, immOffset?: usize, immAlign?: usize): void;

  // @ts-ignore: decorator
  @builtin
  export declare function add<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function sub<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function mul<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function div<T>(a: v128, b: v128): v128; // f32, f64 only

  // @ts-ignore: decorator
  @builtin
  export declare function neg<T>(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function add_sat<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function sub_sat<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shl<T>(a: v128, b: i32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shr<T>(a: v128, b: i32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function and(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function or(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function xor(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function andnot(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function not(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function bitselect(v1: v128, v2: v128, c: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function any_true(a: v128): bool;

  // @ts-ignore: decorator
  @builtin
  export declare function all_true<T>(a: v128): bool;

  // @ts-ignore: decorator
  @builtin
  export declare function bitmask<T>(a: v128): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function popcnt<T>(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function min<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function max<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function pmin<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function pmax<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function dot<T>(a: v128, b: v128): v128; // i16 only

  // @ts-ignore: decorator
  @builtin
  export declare function avgr<T>(a: v128, b: v128): v128; // u8, u16 only

  // @ts-ignore: decorator
  @builtin
  export declare function abs<T>(a: v128): v128; // f32, f64 only

  // @ts-ignore: decorator
  @builtin
  export declare function sqrt<T>(a: v128): v128; // f32, f64 only

  // @ts-ignore: decorator
  @builtin
  export declare function ceil<T>(a: v128): v128; // f32, f64 only

  // @ts-ignore: decorator
  @builtin
  export declare function floor<T>(a: v128): v128; // f32, f64 only

  // @ts-ignore: decorator
  @builtin
  export declare function trunc<T>(a: v128): v128; // f32, f64 only

  // @ts-ignore: decorator
  @builtin
  export declare function nearest<T>(a: v128): v128; // f32, f64 only

  // @ts-ignore: decorator
  @builtin
  export declare function eq<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function ne<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function lt<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function le<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function gt<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function ge<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function convert<T>(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function convert_low<T>(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function trunc_sat<T>(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function trunc_sat_zero<T>(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function narrow<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extend_low<T>(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extend_high<T>(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extadd_pairwise<T>(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function demote_zero<T = f64>(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function promote_low<T = f32>(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function q15mulr_sat<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extmul_low<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extmul_high<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_swizzle(a: v128, s: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_trunc<T>(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_trunc_zero<T>(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_madd<T>(a: v128, b: v128, c: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_nmadd<T>(a: v128, b: v128, c: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_laneselect<T>(a: v128, b: v128, m: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_min<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_max<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_q15mulr<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_dot<T>(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_dot_add<T>(a: v128, b: v128, c: v128): v128;
}

// @ts-ignore: decorator
@builtin
export declare function i8x16(
  a: i8, b: i8, c: i8, d: i8, e: i8, f: i8, g: i8, h: i8,
  i: i8, j: i8, k: i8, l: i8, m: i8, n: i8, o: i8, p: i8
): v128;

export namespace i8x16 {

  // @ts-ignore: decorator
  @builtin
  export declare function splat(x: i8): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extract_lane_s(x: v128, idx: u8): i8;

  // @ts-ignore: decorator
  @builtin
  export declare function extract_lane_u(x: v128, idx: u8): u8;

  // @ts-ignore: decorator
  @builtin
  export declare function replace_lane(x: v128, idx: u8, value: i8): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function add(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function sub(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function min_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function min_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function max_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function max_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function avgr_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function abs(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function neg(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function add_sat_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function add_sat_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function sub_sat_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function sub_sat_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shl(a: v128, b: i32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shr_s(a: v128, b: i32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shr_u(a: v128, b: i32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function all_true(a: v128): bool;

  // @ts-ignore: decorator
  @builtin
  export declare function bitmask(a: v128): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function popcnt(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function eq(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function ne(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function lt_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function lt_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function le_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function le_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function gt_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function gt_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function ge_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function ge_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function narrow_i16x8_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function narrow_i16x8_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shuffle(
    a: v128, b: v128,
    l0: u8, l1: u8, l2: u8, l3: u8, l4: u8, l5: u8, l6: u8, l7: u8,
    l8: u8, l9: u8, l10: u8, l11: u8, l12: u8, l13: u8, l14: u8, l15: u8
  ): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function swizzle(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_swizzle(a: v128, s: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_laneselect(a: v128, b: v128, m: v128): v128;
}

// @ts-ignore: decorator
@builtin
export declare function i16x8(a: i16, b: i16, c: i16, d: i16, e: i16, f: i16, g: i16, h: i16): v128;

export namespace i16x8 {

  // @ts-ignore: decorator
  @builtin
  export declare function splat(x: i16): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extract_lane_s(x: v128, idx: u8): i16;

  // @ts-ignore: decorator
  @builtin
  export declare function extract_lane_u(x: v128, idx: u8): u16;

  // @ts-ignore: decorator
  @builtin
  export declare function replace_lane(x: v128, idx: u8, value: i16): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function add(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function sub(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function mul(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function min_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function min_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function max_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function max_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function avgr_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function abs(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function neg(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function add_sat_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function add_sat_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function sub_sat_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function sub_sat_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shl(a: v128, b: i32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shr_s(a: v128, b: i32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shr_u(a: v128, b: i32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function all_true(a: v128): bool;

  // @ts-ignore: decorator
  @builtin
  export declare function bitmask(a: v128): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function eq(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function ne(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function lt_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function lt_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function le_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function le_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function gt_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function gt_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function ge_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function ge_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function narrow_i32x4_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function narrow_i32x4_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extend_low_i8x16_s(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extend_low_i8x16_u(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extend_high_i8x16_s(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extend_high_i8x16_u(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extadd_pairwise_i8x16_s(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extadd_pairwise_i8x16_u(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function q15mulr_sat_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extmul_low_i8x16_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extmul_low_i8x16_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extmul_high_i8x16_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extmul_high_i8x16_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shuffle(
    a: v128, b: v128,
    l0: u8, l1: u8, l2: u8, l3: u8, l4: u8, l5: u8, l6: u8, l7: u8
  ): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_laneselect(a: v128, b: v128, m: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_q15mulr_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_dot_i8x16_i7x16_s(a: v128, b: v128, c: v128): v128;
}

// @ts-ignore: decorator
@builtin
export declare function i32x4(a: i32, b: i32, c: i32, d: i32): v128;

export namespace i32x4 {

  // @ts-ignore: decorator
  @builtin
  export declare function splat(x: i32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extract_lane(x: v128, idx: u8): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function replace_lane(x: v128, idx: u8, value: i32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function add(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function sub(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function mul(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function min_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function min_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function max_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function max_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function dot_i16x8_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function abs(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function neg(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shl(a: v128, b: i32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shr_s(a: v128, b: i32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shr_u(a: v128, b: i32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function all_true(a: v128): bool;

  // @ts-ignore: decorator
  @builtin
  export declare function bitmask(a: v128): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function eq(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function ne(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function lt_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function lt_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function le_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function le_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function gt_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function gt_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function ge_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function ge_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function trunc_sat_f32x4_s(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function trunc_sat_f32x4_u(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function trunc_sat_f64x2_s_zero(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function trunc_sat_f64x2_u_zero(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extend_low_i16x8_s(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extend_low_i16x8_u(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extend_high_i16x8_s(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extend_high_i16x8_u(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extadd_pairwise_i16x8_s(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extadd_pairwise_i16x8_u(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extmul_low_i16x8_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extmul_low_i16x8_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extmul_high_i16x8_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extmul_high_i16x8_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shuffle(a: v128, b: v128, l0: u8, l1: u8, l2: u8, l3: u8): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_trunc_f32x4_s(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_trunc_f32x4_u(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_trunc_f64x2_s_zero(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_trunc_f64x2_u_zero(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_laneselect(a: v128, b: v128, m: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_dot_i8x16_i7x16_add_s(a: v128, b: v128, c: v128): v128;
}

// @ts-ignore: decorator
@builtin
export declare function i64x2(a: i64, b: i64): v128;

export namespace i64x2 {

  // @ts-ignore: decorator
  @builtin
  export declare function splat(x: i64): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extract_lane(x: v128, idx: u8): i64;

  // @ts-ignore: decorator
  @builtin
  export declare function replace_lane(x: v128, idx: u8, value: i64): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function add(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function sub(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function mul(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function abs(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function neg(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shl(a: v128, b: i32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shr_s(a: v128, b: i32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shr_u(a: v128, b: i32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function all_true(a: v128): bool;

  // @ts-ignore: decorator
  @builtin
  export declare function bitmask(a: v128): i32;

  // @ts-ignore: decorator
  @builtin
  export declare function eq(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function ne(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function lt_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function le_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function gt_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function ge_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extend_low_i32x4_s(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extend_low_i32x4_u(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extend_high_i32x4_s(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extend_high_i32x4_u(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extmul_low_i32x4_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extmul_low_i32x4_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extmul_high_i32x4_s(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extmul_high_i32x4_u(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shuffle(a: v128, b: v128, l0: u8, l1: u8): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_laneselect(a: v128, b: v128, m: v128): v128;
}

// @ts-ignore: decorator
@builtin
export declare function f32x4(a: f32, b: f32, c: f32, d: f32): v128;

export namespace f32x4 {

  // @ts-ignore: decorator
  @builtin
  export declare function splat(x: f32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extract_lane(x: v128, idx: u8): f32;

  // @ts-ignore: decorator
  @builtin
  export declare function replace_lane(x: v128, idx: u8, value: f32): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function add(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function sub(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function mul(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function div(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function neg(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function min(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function max(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function pmin(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function pmax(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function abs(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function sqrt(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function ceil(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function floor(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function trunc(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function nearest(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function eq(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function ne(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function lt(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function le(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function gt(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function ge(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function convert_i32x4_s(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function convert_i32x4_u(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function demote_f64x2_zero(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shuffle(a: v128, b: v128, l0: u8, l1: u8, l2: u8, l3: u8): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_madd(a: v128, b: v128, c: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_nmadd(a: v128, b: v128, c: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_min(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_max(a: v128, b: v128): v128;
}

// @ts-ignore: decorator
@builtin
export declare function f64x2(a: f64, b: f64): v128;

export namespace f64x2 {

  // @ts-ignore: decorator
  @builtin
  export declare function splat(x: f64): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function extract_lane(x: v128, idx: u8): f64;

  // @ts-ignore: decorator
  @builtin
  export declare function replace_lane(x: v128, idx: u8, value: f64): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function add(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function sub(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function mul(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function div(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function neg(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function min(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function max(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function pmin(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function pmax(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function abs(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function sqrt(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function ceil(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function floor(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function trunc(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function nearest(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function eq(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function ne(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function lt(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function le(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function gt(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function ge(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function convert_low_i32x4_s(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function convert_low_i32x4_u(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function promote_low_f32x4(a: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function shuffle(a: v128, b: v128, l0: u8, l1: u8): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_madd(a: v128, b: v128, c: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_nmadd(a: v128, b: v128, c: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_min(a: v128, b: v128): v128;

  // @ts-ignore: decorator
  @builtin
  export declare function relaxed_max(a: v128, b: v128): v128;
}

@final
export abstract class i31 { // FIXME: usage of 'new' requires a class :(

  // @ts-ignore: decorator
  @builtin
  static new(value: i32): i31ref { return changetype<i31ref>(unreachable()); }

  // @ts-ignore: decorator
  @builtin
  static get(i31expr: i31ref): i32 { return unreachable(); }
}

/* eslint-disable @typescript-eslint/no-unused-vars */

// @ts-ignore: decorator
@external("env", "abort")
@external.js("throw Error(\`\${message} in \${fileName}:\${lineNumber}:\${columnNumber}\`);")
declare function abort(
  message?: string | null,
  fileName?: string | null,
  lineNumber?: u32,
  columnNumber?: u32
): void;

// @ts-ignore: decorator
@external("env", "trace")
@external.js("console.log(message, ...[a0, a1, a2, a3, a4].slice(0, n));")
declare function trace(
  message: string,
  n?: i32,
  a0?: f64,
  a1?: f64,
  a2?: f64,
  a3?: f64,
  a4?: f64
): void;

// @ts-ignore: decorator
@external("env", "seed")
@external.js("return Date.now() * Math.random();")
declare function seed(): f64;

/* eslint-enable @typescript-eslint/no-unused-vars */
`,compat:`export type ReturnType<T> = returnof<T>;
export type NonNullable<T> = nonnull<T>;
`,console:`import {
  console as binding
} from "./bindings/dom";

export namespace console {

  export function assert<T>(condition: T, message: string = ""): void {
    binding.assert(!!condition, message);
  }

  export function log(message: string = ""): void {
    binding.log(message);
  }

  export function debug(message: string = ""): void {
    binding.debug(message);
  }

  export function info(message: string = ""): void {
    binding.info(message);
  }

  export function warn(message: string = ""): void {
    binding.warn(message);
  }

  export function error(message: string = ""): void {
    binding.error(message);
  }

  export function time(label: string = "default"): void {
    binding.time(label);
  }

  export function timeLog(label: string = "default"): void {
    binding.timeLog(label);
  }

  export function timeEnd(label: string = "default"): void {
    binding.timeEnd(label);
  }
}
`,crypto:`import {
  crypto as crypto_binding
} from "bindings/dom";

export namespace crypto {
  export function getRandomValues(array: Uint8Array): void {
    crypto_binding.getRandomValues(array);
  }
}
`,dataview:`import { BLOCK_MAXSIZE } from "./rt/common";
import { ArrayBuffer } from "./arraybuffer";
import { E_INDEXOUTOFRANGE, E_INVALIDLENGTH } from "./util/error";

// TODO: there is probably a smarter way to check byteOffset for accesses larger than 1 byte

export class DataView {

  readonly buffer: ArrayBuffer;
  @unsafe readonly dataStart: usize;
  readonly byteLength: i32;

  get byteOffset(): i32 {
    return <i32>(this.dataStart - changetype<usize>(this.buffer));
  }

  constructor(
    buffer: ArrayBuffer,
    byteOffset: i32 = 0,
    byteLength: i32 = buffer.byteLength
  ) {
    if (
      i32(<u32>byteLength > <u32>BLOCK_MAXSIZE) |
      i32(<u32>byteOffset + byteLength > <u32>buffer.byteLength)
    ) throw new RangeError(E_INVALIDLENGTH);
    this.buffer = buffer; // links
    let dataStart = changetype<usize>(buffer) + <usize>byteOffset;
    this.dataStart = dataStart;
    this.byteLength = byteLength;
  }

  getFloat32(byteOffset: i32, littleEndian: bool = false): f32 {
    if (
      (byteOffset >>> 31) | i32(byteOffset + 4 > this.byteLength)
    ) throw new RangeError(E_INDEXOUTOFRANGE);
    return littleEndian
      ? load<f32>(this.dataStart + <usize>byteOffset)
      : reinterpret<f32>(bswap<u32>(load<u32>(this.dataStart + <usize>byteOffset)));
  }

  getFloat64(byteOffset: i32, littleEndian: bool = false): f64 {
    if (
      (byteOffset >>> 31) | i32(byteOffset + 8 > this.byteLength)
    ) throw new RangeError(E_INDEXOUTOFRANGE);
    return littleEndian
      ? load<f64>(this.dataStart + <usize>byteOffset)
      : reinterpret<f64>(bswap<u64>(load<u64>(this.dataStart + <usize>byteOffset)));
  }

  getInt8(byteOffset: i32): i8 {
    if (<u32>byteOffset >= <u32>this.byteLength) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<i8>(this.dataStart + <usize>byteOffset);
  }

  getInt16(byteOffset: i32, littleEndian: bool = false): i16 {
    if (
      (byteOffset >>> 31) | i32(byteOffset + 2 > this.byteLength)
    ) throw new RangeError(E_INDEXOUTOFRANGE);
    let result: i16 = load<i16>(this.dataStart + <usize>byteOffset);
    return littleEndian ? result : bswap<u16>(result);
  }

  getInt32(byteOffset: i32, littleEndian: bool = false): i32 {
    if (
      (byteOffset >>> 31) | i32(byteOffset + 4 > this.byteLength)
    ) throw new RangeError(E_INDEXOUTOFRANGE);
    let result: i32 = load<i32>(this.dataStart + <usize>byteOffset);
    return littleEndian ? result : bswap<u32>(result);
  }

  getUint8(byteOffset: i32): u8 {
    if (<u32>byteOffset >= <u32>this.byteLength) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<u8>(this.dataStart + <usize>byteOffset);
  }

  getUint16(byteOffset: i32, littleEndian: bool = false): u16 {
    if (
      (byteOffset >>> 31) | i32(byteOffset + 2 > this.byteLength)
    ) throw new RangeError(E_INDEXOUTOFRANGE);
    let result: u16 = load<u16>(this.dataStart + <usize>byteOffset);
    return littleEndian ? result : bswap<u16>(result);
  }

  getUint32(byteOffset: i32, littleEndian: bool = false): u32 {
    if (
      (byteOffset >>> 31) | i32(byteOffset + 4 > this.byteLength)
    ) throw new RangeError(E_INDEXOUTOFRANGE);
    let result: u32 = load<u32>(this.dataStart + <usize>byteOffset);
    return littleEndian ? result : bswap<u32>(result);
  }

  setFloat32(byteOffset: i32, value: f32, littleEndian: bool = false): void {
    if (
      (byteOffset >>> 31) | i32(byteOffset + 4 > this.byteLength)
    ) throw new RangeError(E_INDEXOUTOFRANGE);
    if (littleEndian) store<f32>(this.dataStart + <usize>byteOffset, value);
    else store<u32>(this.dataStart + <usize>byteOffset, bswap<u32>(reinterpret<u32>(value)));
  }

  setFloat64(byteOffset: i32, value: f64, littleEndian: bool = false): void {
    if (
      (byteOffset >>> 31) | i32(byteOffset + 8 > this.byteLength)
    ) throw new RangeError(E_INDEXOUTOFRANGE);
    if (littleEndian) store<f64>(this.dataStart + <usize>byteOffset, value);
    else store<u64>(this.dataStart + <usize>byteOffset, bswap<u64>(reinterpret<u64>(value)));
  }

  setInt8(byteOffset: i32, value: i8): void {
    if (<u32>byteOffset >= <u32>this.byteLength) throw new RangeError(E_INDEXOUTOFRANGE);
    store<i8>(this.dataStart + <usize>byteOffset, value);
  }

  setInt16(byteOffset: i32, value: i16, littleEndian: bool = false): void {
    if (
      (byteOffset >>> 31) | i32(byteOffset + 2 > this.byteLength)
    ) throw new RangeError(E_INDEXOUTOFRANGE);
    store<i16>(this.dataStart + <usize>byteOffset, littleEndian ? value : bswap<u16>(value));
  }

  setInt32(byteOffset: i32, value: i32, littleEndian: bool = false): void {
    if (
      (byteOffset >>> 31) | i32(byteOffset + 4 > this.byteLength)
    ) throw new RangeError(E_INDEXOUTOFRANGE);
    store<i32>(this.dataStart + <usize>byteOffset, littleEndian ? value : bswap<u32>(value));
  }

  setUint8(byteOffset: i32, value: u8): void {
    if (<u32>byteOffset >= <u32>this.byteLength) throw new RangeError(E_INDEXOUTOFRANGE);
    store<u8>(this.dataStart + <usize>byteOffset, value);
  }

  setUint16(byteOffset: i32, value: u16, littleEndian: bool = false): void {
    if (
      (byteOffset >>> 31) | i32(byteOffset + 2 > this.byteLength)
    ) throw new RangeError(E_INDEXOUTOFRANGE);
    store<u16>(this.dataStart + <usize>byteOffset, littleEndian ? value : bswap<u16>(value));
  }

  setUint32(byteOffset: i32, value: u32, littleEndian: bool = false): void {
    if (
      (byteOffset >>> 31) | i32(byteOffset + 4 > this.byteLength)
    ) throw new RangeError(E_INDEXOUTOFRANGE);
    store<u32>(this.dataStart + <usize>byteOffset, littleEndian ? value : bswap<u32>(value));
  }

  // Non-standard additions that make sense in WebAssembly, but won't work in JS:

  getInt64(byteOffset: i32, littleEndian: bool = false): i64 {
    if (
      (byteOffset >>> 31) | i32(byteOffset + 8 > this.byteLength)
    ) throw new RangeError(E_INDEXOUTOFRANGE);
    let result: i64 = load<i64>(this.dataStart + <usize>byteOffset);
    return littleEndian ? result : bswap<u64>(result);
  }

  getUint64(byteOffset: i32, littleEndian: bool = false): u64 {
    if (
      (byteOffset >>> 31) | i32(byteOffset + 8 > this.byteLength)
    ) throw new RangeError(E_INDEXOUTOFRANGE);
    let result = load<u64>(this.dataStart + <usize>byteOffset);
    return littleEndian ? result : bswap<u64>(result);
  }

  setInt64(byteOffset: i32, value: i64, littleEndian: bool = false): void {
    if (
      (byteOffset >>> 31) | i32(byteOffset + 8 > this.byteLength)
    ) throw new RangeError(E_INDEXOUTOFRANGE);
    store<i64>(this.dataStart + <usize>byteOffset, littleEndian ? value : bswap<u64>(value));
  }

  setUint64(byteOffset: i32, value: u64, littleEndian: bool = false): void {
    if (
      (byteOffset >>> 31) | i32(byteOffset + 8 > this.byteLength)
    ) throw new RangeError(E_INDEXOUTOFRANGE);
    store<u64>(this.dataStart + <usize>byteOffset, littleEndian ? value : bswap<u64>(value));
  }

  toString(): string {
    return "[object DataView]";
  }
}
`,date:`import { E_INVALIDDATE } from "util/error";
import { Date as Date_binding } from "./bindings/dom";

// @ts-ignore: decorator
@inline const
  MILLIS_LIMIT      = 8640000000000000,
  MILLIS_PER_DAY    = 1000 * 60 * 60 * 24,
  MILLIS_PER_HOUR   = 1000 * 60 * 60,
  MILLIS_PER_MINUTE = 1000 * 60,
  MILLIS_PER_SECOND = 1000,
  YEARS_PER_EPOCH   = 400,
  DAYS_PER_EPOCH    = 146097, // 400 * 365 + 400 / 4 - 400 / 100 + 1
  EPOCH_OFFSET      = 719468; // Jan 1, 1970

// ymdFromEpochDays returns values via globals to avoid allocations
// @ts-ignore: decorator
@lazy let _month: i32, _day: i32;

export class Date {
  private year: i32 = 0;
  private month: i32 = 0;
  private day: i32 = 0;

  @inline static UTC(
    year: i32,
    month: i32 = 0,
    day: i32 = 1,
    hour: i32 = 0,
    minute: i32 = 0,
    second: i32 = 0,
    millisecond: i32 = 0
  ): i64 {
    if (year >= 0 && year <= 99) year += 1900;
    let ms = epochMillis(year, month + 1, day, hour, minute, second, millisecond);
    if (invalidDate(ms)) throw new RangeError(E_INVALIDDATE);
    return ms;
  }

  @inline static now(): i64 {
    return <i64>Date_binding.now();
  }

  // It can parse only ISO 8601 inputs like YYYY-MM-DDTHH:MM:SS.000Z
  @inline static parse(dateString: string): Date {
    return this.fromString(dateString);
  }

  static fromString(dateTimeString: string): Date {
    if (!dateTimeString.length) throw new RangeError(E_INVALIDDATE);
    var
      hour: i32 = 0,
      min: i32 = 0,
      sec: i32 = 0,
      ms: i32 = 0,
      offsetMs: i32 = 0;

    let dateString = dateTimeString;
    let posT = dateTimeString.indexOf("T");
    if (~posT) {
      // includes a time component
      let timeString: string;
      dateString = dateTimeString.substring(0, posT);
      timeString = dateTimeString.substring(posT + 1);

      // might end with an offset ("Z", "+05:30", "-08:00", etc.)
      for (let i = timeString.length - 1; i >= 0; i--) {
        let c = timeString.charCodeAt(i);
        if (c == 90) { // Z
          timeString = timeString.substring(0, i);
          break;
        } else if (c == 43 || c == 45) { // + or -
          if (i == timeString.length - 1) {
            throw new RangeError(E_INVALIDDATE);
          }

          let posColon = timeString.indexOf(":", i + 1);
          if (~posColon) {
            let offsetHours = i32.parse(timeString.substring(i + 1, posColon));
            let offsetMinutes = i32.parse(timeString.substring(posColon + 1));
            offsetMs = (offsetHours * 60 + offsetMinutes) * MILLIS_PER_MINUTE;
          } else {
            let offsetHours = i32.parse(timeString.substring(i + 1));
            offsetMs = offsetHours * MILLIS_PER_HOUR;
          }

          if (c == 45) offsetMs = -offsetMs; // negative offset
          timeString = timeString.substring(0, i);
          break;
        }
      }

      // parse the HH:MM:SS component
      let timeParts = timeString.split(":");
      let len = timeParts.length;
      if (len <= 1) throw new RangeError(E_INVALIDDATE);

      hour = i32.parse(timeParts[0]);
      min  = i32.parse(timeParts[1]);
      if (len >= 3) {
        let secAndFrac = timeParts[2];
        let posDot = secAndFrac.indexOf(".");
        if (~posDot) {
          // includes fractional seconds (truncate to milliseconds)
          sec = i32.parse(secAndFrac.substring(0, posDot));
          ms  = i32.parse(secAndFrac.substr(posDot + 1, 3).padEnd(3, "0"));
        } else {
          sec = i32.parse(secAndFrac);
        }
      }
    }

    // parse the YYYY-MM-DD component
    let parts = dateString.split("-");
    let year = i32.parse(parts[0]);
    let month = 1, day = 1;
    let len = parts.length;
    if (len >= 2) {
      month = i32.parse(parts[1]);
      if (len >= 3) {
        day = i32.parse(parts[2]);
      }
    }

    return new Date(epochMillis(year, month, day, hour, min, sec, ms) - offsetMs);
  }

  constructor(private epochMillis: i64) {
    // this differs from JavaScript which prefer return NaN or "Invalid Date" string
    // instead throwing exception.
    if (invalidDate(epochMillis)) throw new RangeError(E_INVALIDDATE);

    this.year = dateFromEpoch(epochMillis);
    this.month = _month;
    this.day = _day;
  }

  @inline getTime(): i64 {
    return this.epochMillis;
  }

  setTime(time: i64): i64 {
    if (invalidDate(time)) throw new RangeError(E_INVALIDDATE);

    this.epochMillis = time;
    this.year = dateFromEpoch(time);
    this.month = _month;
    this.day = _day;

    return time;
  }

  @inline getUTCFullYear(): i32 {
    return this.year;
  }

  @inline getUTCMonth(): i32 {
    return this.month - 1;
  }

  @inline getUTCDate(): i32 {
    return this.day;
  }

  @inline getUTCDay(): i32 {
    return dayOfWeek(this.year, this.month, this.day);
  }

  getUTCHours(): i32 {
    return i32(euclidRem(this.epochMillis, MILLIS_PER_DAY)) / MILLIS_PER_HOUR;
  }

  getUTCMinutes(): i32 {
    return i32(euclidRem(this.epochMillis, MILLIS_PER_HOUR)) / MILLIS_PER_MINUTE;
  }

  getUTCSeconds(): i32 {
    return i32(euclidRem(this.epochMillis, MILLIS_PER_MINUTE)) / MILLIS_PER_SECOND;
  }

  getUTCMilliseconds(): i32 {
    return i32(euclidRem(this.epochMillis, MILLIS_PER_SECOND));
  }

  setUTCMilliseconds(millis: i32): void {
    this.setTime(this.epochMillis + (millis - this.getUTCMilliseconds()));
  }

  setUTCSeconds(seconds: i32): void {
    this.setTime(this.epochMillis + (seconds - this.getUTCSeconds()) * MILLIS_PER_SECOND);
  }

  setUTCMinutes(minutes: i32): void {
    this.setTime(this.epochMillis + (minutes - this.getUTCMinutes()) * MILLIS_PER_MINUTE);
  }

  setUTCHours(hours: i32): void {
    this.setTime(this.epochMillis + (hours - this.getUTCHours()) * MILLIS_PER_HOUR);
  }

  setUTCDate(day: i32): void {
    if (this.day == day) return;
    this.setTime(join(this.year, this.month, day, this.epochMillis));
  }

  setUTCMonth(month: i32, day: i32 = this.day): void {
    if (this.month == month + 1) return;
    this.setTime(join(this.year, month + 1, day, this.epochMillis));
  }

  setUTCFullYear(year: i32): void {
    if (this.year == year) return;
    this.setTime(join(year, this.month, this.day, this.epochMillis));
  }

  toISOString(): string {
    // TODO: add more low-level helper which combine toString and padStart without extra allocation

    let yr = this.year;
    let isNeg = yr < 0;
    let year = (isNeg || yr >= 10000)
      ? (isNeg ? "-" : "+") + stringify(abs(yr), 6)
      : stringify(yr, 4);
    let month = stringify(this.month, 2);
    let day = stringify(this.day);
    let hours = stringify(this.getUTCHours());
    let mins = stringify(this.getUTCMinutes());
    let secs = stringify(this.getUTCSeconds());
    let ms = stringify(this.getUTCMilliseconds(), 3);

    return \`\${year}-\${month}-\${day}T\${hours}:\${mins}:\${secs}.\${ms}Z\`;
  }

  toUTCString(): string {
    const
      weeks: StaticArray<string> = [
        "Sun, ", "Mon, ", "Tue, ", "Wed, ", "Thu, ", "Fri, ", "Sat, "
      ],
      months: StaticArray<string> = [
        " Jan ", " Feb ", " Mar ", " Apr ", " May ", " Jun ",
        " Jul ", " Aug ", " Sep ", " Oct ", " Nov ", " Dec "
      ];

    let mo = this.month;
    let da = this.day;
    let yr = this.year;
    let wd = dayOfWeek(yr, mo, da);
    let year = stringify(abs(yr), 4);
    let month = unchecked(months[mo - 1]);
    let week = unchecked(weeks[wd]);
    let day = stringify(da);
    let hours = stringify(this.getUTCHours());
    let mins = stringify(this.getUTCMinutes());
    let secs = stringify(this.getUTCSeconds());

    return \`\${week}\${day}\${month}\${yr < 0 ? "-" : ""}\${year} \${hours}:\${mins}:\${secs} GMT\`;
  }

  toDateString(): string {
    // TODO: use u64 static data instead 4 chars
    // also use stream itoa variants.
    const
      weeks: StaticArray<string> = [
        "Sun ", "Mon ", "Tue ", "Wed ", "Thu ", "Fri ", "Sat "
      ],
      months: StaticArray<string> = [
        "Jan ", "Feb ", "Mar ", "Apr ", "May ", "Jun ",
        "Jul ", "Aug ", "Sep ", "Oct ", "Nov ", "Dec "
      ];

    let mo = this.month;
    let da = this.day;
    let yr = this.year;
    let wd = dayOfWeek(yr, mo, da);
    let year = stringify(abs(yr), 4);
    let month = unchecked(months[mo - 1]);
    let week = unchecked(weeks[wd]);
    let day = stringify(da);

    return \`\${week}\${month}\${day}\${yr < 0 ? " -" : " "}\${year}\`;
  }

  // Note: it uses UTC time instead local time (without timezone offset)
  toTimeString(): string {
    let hours = stringify(this.getUTCHours());
    let mins = stringify(this.getUTCMinutes());
    let secs = stringify(this.getUTCSeconds());
    // TODO: add timezone
    return \`\${hours}:\${mins}:\${secs}\`;
  }

  // Note: it uses UTC datetime instead local datetime (without timezone offset)
  toString(): string {
    return \`\${this.toDateString()} \${this.toTimeString()}\`;
  }
}

function epochMillis(
  year: i32,
  month: i32,
  day: i32,
  hour: i32,
  minute: i32,
  second: i32,
  milliseconds: i32
): i64 {
  return (
    daysSinceEpoch(year, month, day) * MILLIS_PER_DAY +
    hour * MILLIS_PER_HOUR +
    minute * MILLIS_PER_MINUTE +
    second * MILLIS_PER_SECOND +
    milliseconds
  );
}

// @ts-ignore: decorator
@inline function floorDiv<T extends number>(a: T, b: T): T {
  return (a - (a < 0 ? b - 1 : 0)) / b as T;
}

// @ts-ignore: decorator
@inline function euclidRem<T extends number>(a: T, b: T): T {
  let m = a % b;
  return m + (m < 0 ? b : 0) as T;
}

function invalidDate(millis: i64): bool {
  // @ts-ignore
  return (millis < -MILLIS_LIMIT) | (millis > MILLIS_LIMIT);
}

// Based on "Euclidean Affine Functions and Applications to Calendar Algorithms"
// Paper: https://arxiv.org/pdf/2102.06959.pdf
function dateFromEpoch(ms: i64): i32 {
  let da = (<i32>floorDiv(ms, MILLIS_PER_DAY) * 4 + EPOCH_OFFSET * 4) | 3;
  let q0 = floorDiv(da, DAYS_PER_EPOCH);  // [0, 146096]
  let r1 = <u32>da - q0 * DAYS_PER_EPOCH;
  let u1 = u64(r1 | 3) * 2939745;
  let dm1 = <u32>u1 / 11758980;
  let n1 = 2141 * dm1 + 197913;
  let year = 100 * q0 + i32(u1 >>> 32);
  _day = (n1 & 0xFFFF) / 2141 + 1;              // [1, 31]
  _month = (n1 >>> 16) - (dm1 >= 306 ? 12 : 0); // [1, 12]
  return year + (dm1 >= 306 ?  1 : 0);
}

// http://howardhinnant.github.io/date_algorithms.html#days_from_civil
function daysSinceEpoch(year: i32, month: i32, day: i32): i64 {
  year -= i32(month <= 2);
  let era = <u32>floorDiv(year, YEARS_PER_EPOCH);
  let yoe = <u32>year - era * YEARS_PER_EPOCH; // [0, 399]
  let doy = <u32>(153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1; // [0, 365]
  let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
  return <i64><i32>(era * 146097 + doe - EPOCH_OFFSET);
}

// TomohikoSakamoto algorithm from https://en.wikipedia.org/wiki/Determination_of_the_day_of_the_week
function dayOfWeek(year: i32, month: i32, day: i32): i32 {
  const tab = memory.data<u8>([0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]);

  year -= i32(month <= 2);
  const cent = floorDiv(year >> 2, 100 >> 2);
  year += (year >> 2) - cent + (cent >> 2);
  month = <i32>load<u8>(tab + month - 1);
  return euclidRem(year + month + day, 7);
}

function stringify(value: i32, padding: i32 = 2): string {
  return value.toString().padStart(padding, "0");
}

function join(year: i32, month: i32, day: i32, ms: i64): i64 {
  return daysSinceEpoch(year, month, day) * MILLIS_PER_DAY + euclidRem(ms, MILLIS_PER_DAY);
}
`,diagnostics:`// @ts-ignore: decorator
@builtin
export declare function ERROR(message?: string): void;

// @ts-ignore: decorator
@builtin
export declare function WARNING(message?: string): void;

// @ts-ignore: decorator
@builtin
export declare function INFO(message?: string): void;
`,error:`export class Error {

  name: string  = "Error";
  stack: string = ""; // TODO

  constructor(
    public message: string = ""
  ) {}

  toString(): string {
    let message = this.message;
    return message.length
      ? this.name + ": " + message
      : this.name;
  }
}

export class RangeError extends Error {
  constructor(message: string = "") {
    super(message);
    this.name = "RangeError";
  }
}

export class TypeError extends Error {
  constructor(message: string = "") {
    super(message);
    this.name = "TypeError";
  }
}

export class SyntaxError extends Error {
  constructor(message: string = "") {
    super(message);
    this.name = "SyntaxError";
  }
}

export class URIError extends Error {
  constructor(message: string = "") {
    super(message);
    this.name = "URIError";
  }
}
`,function:`type auto = i32;

@final export abstract class Function<T> {
  private _index: u32;
  private _env: usize;

  // @ts-ignore: this on getter
  get index(this: T): u32 {
    return load<u32>(changetype<usize>(this), offsetof<Function<T>>("_index"));
  }

  // @ts-ignore: this on getter
  get name(this: T): string {
    return "";
  }

  // @ts-ignore: this on getter
  get length(this: T): i32 {
    // @ts-ignore: T is function
    return lengthof<T>();
  }

  // @ts-ignore: T is function
  @builtin call(thisArg: thisof<T> | null, ...args: auto[]): returnof<T> {
    return unreachable();
  }

  toString(this: T): string {
    return "function() { [native code] }";
  }

  // RT integration

  @unsafe private __visit(cookie: u32): void {
    // Env is either \`null\` (nop) or compiler-generated
    __visit(this._env, cookie);
  }
}
`,iterator:`export abstract class Iterable<T> {
  // ?
}

@final
export abstract class Iterator<T> {

  // private constructor(iterable: Iterable<T>) {
  // }

  // TODO: these need to evaluate the classId at the respective reference in order to obtain the
  // next value, i.e. arrays work differently than maps. we'd then have:
  //
  // \u2552\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 Iterator layout (32-bit) \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2555
  //    3                   2                   1
  //  1 0 9 8 7 6 5 4 3 2 1 0 9 8 7 6 5 4 3 2 1 0 9 8 7 6 5 4 3 2 1 0  bits
  // \u251C\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2524
  // \u2502                             index                             \u2502
  // \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u252C\u2500\u2524
  // \u2502                           reference                     \u2502 0 \u2502D\u2502
  // \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2534\u2500\u2518
  // D: Done flag

  // get value(this: u64): T {
  //   ?
  // }

  // next(this: u64): Iterator<T> {
  //   ?
  // }

  done(this: u64): bool {
    return <bool>(this & 1);
  }
}
`,map:`/// <reference path="./rt/index.d.ts" />

import { HASH } from "./util/hash";
import { E_KEYNOTFOUND } from "./util/error";

// A deterministic hash map based on CloseTable from https://github.com/jorendorff/dht

// @ts-ignore: decorator
@inline const INITIAL_CAPACITY = 4;

// @ts-ignore: decorator
@inline const FILL_FACTOR_N = 8;

// @ts-ignore: decorator
@inline const FILL_FACTOR_D = 3;

// @ts-ignore: decorator
@inline const FREE_FACTOR_N = 3;

// @ts-ignore: decorator
@inline const FREE_FACTOR_D = 4;

/** Structure of a map entry. */
@unmanaged class MapEntry<K,V> {
  key: K;
  value: V;
  taggedNext: usize; // LSB=1 indicates EMPTY
}

/** Empty bit. */
// @ts-ignore: decorator
@inline const EMPTY: usize = 1 << 0;

/** Size of a bucket. */
// @ts-ignore: decorator
@inline const BUCKET_SIZE = sizeof<usize>();

/** Computes the alignment of an entry. */
// @ts-ignore: decorator
@inline
function ENTRY_ALIGN<K,V>(): usize {
  // can align to 4 instead of 8 if 32-bit and K/V is <= 32-bits
  const maxkv = sizeof<K>() > sizeof<V>() ? sizeof<K>() : sizeof<V>();
  const align = (maxkv > sizeof<usize>() ? maxkv : sizeof<usize>()) - 1;
  return align;
}

/** Computes the aligned size of an entry. */
// @ts-ignore: decorator
@inline
function ENTRY_SIZE<K,V>(): usize {
  const align = ENTRY_ALIGN<K,V>();
  const size = (offsetof<MapEntry<K,V>>() + align) & ~align;
  return size;
}

export class Map<K,V> {

  // buckets referencing their respective first entry, usize[bucketsMask + 1]
  private buckets: ArrayBuffer = new ArrayBuffer(INITIAL_CAPACITY * <i32>BUCKET_SIZE);
  private bucketsMask: u32 = INITIAL_CAPACITY - 1;

  // entries in insertion order, MapEntry<K,V>[entriesCapacity]
  private entries: ArrayBuffer = new ArrayBuffer(INITIAL_CAPACITY * <i32>ENTRY_SIZE<K,V>());
  private entriesCapacity: i32 = INITIAL_CAPACITY;
  private entriesOffset: i32 = 0;
  private entriesCount: i32 = 0;

  constructor() {
    /* nop */
  }

  get size(): i32 {
    return this.entriesCount;
  }

  clear(): void {
    this.buckets = new ArrayBuffer(INITIAL_CAPACITY * <i32>BUCKET_SIZE);
    this.bucketsMask = INITIAL_CAPACITY - 1;
    this.entries = new ArrayBuffer(INITIAL_CAPACITY * <i32>ENTRY_SIZE<K,V>());
    this.entriesCapacity = INITIAL_CAPACITY;
    this.entriesOffset = 0;
    this.entriesCount = 0;
  }

  private find(key: K, hashCode: u32): MapEntry<K,V> | null {
    let entry = load<MapEntry<K,V>>( // unmanaged!
      changetype<usize>(this.buckets) + <usize>(hashCode & this.bucketsMask) * BUCKET_SIZE
    );
    while (entry) {
      let taggedNext = entry.taggedNext;
      if (!(taggedNext & EMPTY) && entry.key == key) return entry;
      entry = changetype<MapEntry<K,V>>(taggedNext & ~EMPTY);
    }
    return null;
  }

  has(key: K): bool {
    return this.find(key, HASH<K>(key)) != null;
  }

  @operator("[]")
  get(key: K): V {
    let entry = this.find(key, HASH<K>(key));
    if (!entry) throw new Error(E_KEYNOTFOUND); // cannot represent \`undefined\`
    return entry.value;
  }

  @operator("[]=")
  set(key: K, value: V): this {
    let hashCode = HASH<K>(key);
    let entry = this.find(key, hashCode); // unmanaged!
    if (entry) {
      entry.value = value;
      if (isManaged<V>()) {
        __link(changetype<usize>(this), changetype<usize>(value), true);
      }
    } else {
      // check if rehashing is necessary
      if (this.entriesOffset == this.entriesCapacity) {
        this.rehash(
          this.entriesCount < this.entriesCapacity * FREE_FACTOR_N / FREE_FACTOR_D
            ?  this.bucketsMask           // just rehash if 1/4+ entries are empty
            : (this.bucketsMask << 1) | 1 // grow capacity to next 2^N
        );
      }
      // append new entry
      let entries = this.entries;
      entry = changetype<MapEntry<K,V>>(changetype<usize>(entries) + <usize>(this.entriesOffset++) * ENTRY_SIZE<K,V>());
      // link with the map
      entry.key = key;
      if (isManaged<K>()) {
        __link(changetype<usize>(this), changetype<usize>(key), true);
      }
      entry.value = value;
      if (isManaged<V>()) {
        __link(changetype<usize>(this), changetype<usize>(value), true);
      }
      ++this.entriesCount;
      // link with previous entry in bucket
      let bucketPtrBase = changetype<usize>(this.buckets) + <usize>(hashCode & this.bucketsMask) * BUCKET_SIZE;
      entry.taggedNext = load<usize>(bucketPtrBase);
      store<usize>(bucketPtrBase, changetype<usize>(entry));
    }
    return this;
  }

  delete(key: K): bool {
    let entry = this.find(key, HASH<K>(key));
    if (!entry) return false;
    entry.taggedNext |= EMPTY;
    --this.entriesCount;
    // check if rehashing is appropriate
    let halfBucketsMask = this.bucketsMask >> 1;
    if (
      halfBucketsMask + 1 >= max<u32>(INITIAL_CAPACITY, this.entriesCount) &&
      this.entriesCount < this.entriesCapacity * FREE_FACTOR_N / FREE_FACTOR_D
    ) this.rehash(halfBucketsMask);
    return true;
  }

  private rehash(newBucketsMask: u32): void {
    let newBucketsCapacity = <i32>(newBucketsMask + 1);
    let newBuckets = new ArrayBuffer(newBucketsCapacity * <i32>BUCKET_SIZE);
    let newEntriesCapacity = newBucketsCapacity * FILL_FACTOR_N / FILL_FACTOR_D;
    let newEntries = new ArrayBuffer(newEntriesCapacity * <i32>ENTRY_SIZE<K,V>());

    // copy old entries to new entries
    let oldPtr = changetype<usize>(this.entries);
    let oldEnd = oldPtr + <usize>this.entriesOffset * ENTRY_SIZE<K,V>();
    let newPtr = changetype<usize>(newEntries);
    while (oldPtr != oldEnd) {
      let oldEntry = changetype<MapEntry<K,V>>(oldPtr);
      if (!(oldEntry.taggedNext & EMPTY)) {
        let newEntry = changetype<MapEntry<K,V>>(newPtr);
        let oldEntryKey = oldEntry.key;
        newEntry.key = oldEntryKey;
        newEntry.value = oldEntry.value;
        let newBucketIndex = HASH<K>(oldEntryKey) & newBucketsMask;
        let newBucketPtrBase = changetype<usize>(newBuckets) + <usize>newBucketIndex * BUCKET_SIZE;
        newEntry.taggedNext = load<usize>(newBucketPtrBase);
        store<usize>(newBucketPtrBase, newPtr);
        newPtr += ENTRY_SIZE<K,V>();
      }
      oldPtr += ENTRY_SIZE<K,V>();
    }

    this.buckets = newBuckets;
    this.bucketsMask = newBucketsMask;
    this.entries = newEntries;
    this.entriesCapacity = newEntriesCapacity;
    this.entriesOffset = this.entriesCount;
  }

  keys(): K[] {
    // FIXME: this is preliminary, needs iterators/closures
    let start = changetype<usize>(this.entries);
    let size = this.entriesOffset;
    let keys = new Array<K>(size);
    let length = 0;
    for (let i = 0; i < size; ++i) {
      let entry = changetype<MapEntry<K,V>>(start + <usize>i * ENTRY_SIZE<K,V>());
      if (!(entry.taggedNext & EMPTY)) {
        unchecked(keys[length++] = entry.key);
      }
    }
    keys.length = length;
    return keys;
  }

  values(): V[] {
    // FIXME: this is preliminary, needs iterators/closures
    let start = changetype<usize>(this.entries);
    let size = this.entriesOffset;
    let values = new Array<V>(size);
    let length = 0;
    for (let i = 0; i < size; ++i) {
      let entry = changetype<MapEntry<K,V>>(start + <usize>i * ENTRY_SIZE<K,V>());
      if (!(entry.taggedNext & EMPTY)) {
        unchecked(values[length++] = entry.value);
      }
    }
    values.length = length;
    return values;
  }

  toString(): string {
    return "[object Map]";
  }

  // RT integration

  @unsafe private __visit(cookie: u32): void {
    __visit(changetype<usize>(this.buckets), cookie);
    let entries = changetype<usize>(this.entries);
    if (isManaged<K>() || isManaged<V>()) {
      let cur = entries;
      let end = cur + <usize>this.entriesOffset * ENTRY_SIZE<K,V>();
      while (cur < end) {
        let entry = changetype<MapEntry<K,V>>(cur);
        if (!(entry.taggedNext & EMPTY)) {
          if (isManaged<K>()) {
            let val = changetype<usize>(entry.key);
            if (isNullable<K>()) {
              if (val) __visit(val, cookie);
            } else __visit(val, cookie);
          }
          if (isManaged<V>()) {
            let val = changetype<usize>(entry.value);
            if (isNullable<V>()) {
              if (val) __visit(val, cookie);
            } else __visit(val, cookie);
          }
        }
        cur += ENTRY_SIZE<K,V>();
      }
    }
    __visit(entries, cookie);
  }
}
`,math:`import { Math as JSMath } from "./bindings/dom";
export { JSMath };

import {
  pow_lut, exp_lut, exp2_lut, log_lut, log2_lut,
  powf_lut, expf_lut, exp2f_lut, logf_lut, log2f_lut
} from "./util/math";

import {
  abs as builtin_abs,
  ceil as builtin_ceil,
  clz as builtin_clz,
  copysign as builtin_copysign,
  floor as builtin_floor,
  max as builtin_max,
  min as builtin_min,
  sqrt as builtin_sqrt,
  trunc as builtin_trunc
} from "./builtins";

// SUN COPYRIGHT NOTICE
//
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
// Developed at SunPro, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this software
// is freely granted, provided that this notice is preserved.
//
// Applies to all functions marked with a comment referring here.

/** @internal */
// @ts-ignore: decorator
@lazy let rempio2_y0: f64, rempio2_y1: f64, res128_hi: u64;

/** @internal */
// @ts-ignore: decorator
@lazy @inline const PIO2_TABLE = memory.data<u64>([
  0x00000000A2F9836E, 0x4E441529FC2757D1, 0xF534DDC0DB629599, 0x3C439041FE5163AB,
  0xDEBBC561B7246E3A, 0x424DD2E006492EEA, 0x09D1921CFE1DEB1C, 0xB129A73EE88235F5,
  0x2EBB4484E99C7026, 0xB45F7E413991D639, 0x835339F49C845F8B, 0xBDF9283B1FF897FF,
  0xDE05980FEF2F118B, 0x5A0A6D1F6D367ECF, 0x27CB09B74F463F66, 0x9E5FEA2D7527BAC7,
  0xEBE5F17B3D0739F7, 0x8A5292EA6BFB5FB1, 0x1F8D5D0856033046, 0xFC7B6BABF0CFBC20,
  0x9AF4361DA9E39161, 0x5EE61B086599855F, 0x14A068408DFFD880, 0x4D73273106061557
]);

/** @internal */
function R(z: f64): f64 { // Rational approximation of (asin(x)-x)/x^3
  const                   // see: musl/src/math/asin.c and SUN COPYRIGHT NOTICE above
    pS0 = reinterpret<f64>(0x3FC5555555555555), //  1.66666666666666657415e-01
    pS1 = reinterpret<f64>(0xBFD4D61203EB6F7D), // -3.25565818622400915405e-01
    pS2 = reinterpret<f64>(0x3FC9C1550E884455), //  2.01212532134862925881e-01
    pS3 = reinterpret<f64>(0xBFA48228B5688F3B), // -4.00555345006794114027e-02
    pS4 = reinterpret<f64>(0x3F49EFE07501B288), //  7.91534994289814532176e-04
    pS5 = reinterpret<f64>(0x3F023DE10DFDF709), //  3.47933107596021167570e-05
    qS1 = reinterpret<f64>(0xC0033A271C8A2D4B), // -2.40339491173441421878e+00
    qS2 = reinterpret<f64>(0x40002AE59C598AC8), //  2.02094576023350569471e+00
    qS3 = reinterpret<f64>(0xBFE6066C1B8D0159), // -6.88283971605453293030e-01
    qS4 = reinterpret<f64>(0x3FB3B8C5B12E9282); //  7.70381505559019352791e-02

  let p = z * (pS0 + z * (pS1 + z * (pS2 + z * (pS3 + z * (pS4 + z * pS5)))));
  let q = 1.0 + z * (qS1 + z * (qS2 + z * (qS3 + z * qS4)));
  return p / q;
}

/** @internal */
// @ts-ignore: decorator
@inline
function expo2(x: f64, sign: f64): f64 { // exp(x)/2 for x >= log(DBL_MAX)
  const                       // see: musl/src/math/__expo2.c
    k    = <u32>2043,
    kln2 = reinterpret<f64>(0x40962066151ADD8B); // 0x1.62066151add8bp+10
  let scale = reinterpret<f64>(<u64>((<u32>0x3FF + k / 2) << 20) << 32);
  // in directed rounding correct sign before rounding or overflow is important
  return NativeMath.exp(x - kln2) * (sign * scale) * scale;
}

/** @internal */
/* Helper function to eventually get bits of \u03C0/2 * |x|
 *
 * y = \u03C0/4 * (frac << clz(frac) >> 11)
 * return clz(frac)
 *
 * Right shift 11 bits to make upper half fit in \`double\`
 */
// @ts-ignore: decorator
@inline
function pio2_right(q0: u64, q1: u64): u64 { // see: jdh8/metallic/blob/master/src/math/double/rem_pio2.c
  // Bits of \u03C0/4
  const p0: u64 = 0xC4C6628B80DC1CD1;
  const p1: u64 = 0xC90FDAA22168C234;

  const Ox1p_64 = reinterpret<f64>(0x3BF0000000000000); // 0x1p-64
  const Ox1p_75 = reinterpret<f64>(0x3B40000000000000); // 0x1p-75

  let shift = clz(q1);

  q1 = q1 << shift | q0 >> (64 - shift);
  q0 <<= shift;

  let lo = umuldi(p1, q1);
  let hi = res128_hi;

  let ahi = hi >> 11;
  let alo = lo >> 11 | hi << 53;
  let blo = <u64>(Ox1p_75 * <f64>p0 * <f64>q1 + Ox1p_75 * <f64>p1 * <f64>q0);

  rempio2_y0 = <f64>(ahi + u64(lo < blo));
  rempio2_y1 = Ox1p_64 * <f64>(alo + blo);

  return shift;
}

/** @internal */
// @ts-ignore: decorator
@inline
function umuldi(u: u64, v: u64): u64 {
  let u1: u64 , v1: u64, w0: u64, w1: u64, t: u64;

  u1 = u & 0xFFFFFFFF;
  v1 = v & 0xFFFFFFFF;

  u >>= 32;
  v >>= 32;

  t  = u1 * v1;
  w0 = t & 0xFFFFFFFF;
  t  = u * v1 + (t >> 32);
  w1 = t >> 32;
  t  = u1 * v + (t & 0xFFFFFFFF);

  res128_hi = u * v + w1 + (t >> 32);
  return (t << 32) + w0;
}

/** @internal */
function pio2_large_quot(x: f64, u: i64): i32 { // see: jdh8/metallic/blob/master/src/math/double/rem_pio2.c
  let magnitude = u & 0x7FFFFFFFFFFFFFFF;
  let offset = (magnitude >> 52) - 1045;
  let shift  = offset & 63;
  let tblPtr = PIO2_TABLE + (<i32>(offset >> 6) << 3);
  let s0: u64, s1: u64, s2: u64;

  let b0 = load<u64>(tblPtr, 0 << 3);
  let b1 = load<u64>(tblPtr, 1 << 3);
  let b2 = load<u64>(tblPtr, 2 << 3);

  // Get 192 bits of 0x1p-31 / \u03C0 with \`offset\` bits skipped
  if (shift) {
    let rshift = 64 - shift;
    let b3 = load<u64>(tblPtr, 3 << 3);
    s0 = b1 >> rshift | b0 << shift;
    s1 = b2 >> rshift | b1 << shift;
    s2 = b3 >> rshift | b2 << shift;
  } else {
    s0 = b0;
    s1 = b1;
    s2 = b2;
  }

  let significand = (u & 0x000FFFFFFFFFFFFF) | 0x0010000000000000;

  // First 128 bits of fractional part of x/(2\u03C0)
  let blo = umuldi(s1, significand);
  let bhi = res128_hi;

  let ahi = s0 * significand;
  let clo = (s2 >> 32) * (significand >> 32);
  let plo = blo + clo;
  let phi = ahi + bhi + u64(plo < clo);

  // r: u128 = p << 2
  let rlo = plo << 2;
  let rhi = phi << 2 | plo >> 62;

  // s: i128 = r >> 127
  let slo = <i64>rhi >> 63;
  let shi = slo >> 1;
  let q   = (<i64>phi >> 62) - slo;

  let shifter = 0x3CB0000000000000 - (pio2_right(rlo ^ slo, rhi ^ shi) << 52);
  let signbit = (u ^ rhi) & 0x8000000000000000;
  let coeff   = reinterpret<f64>(shifter | signbit);

  rempio2_y0 *= coeff;
  rempio2_y1 *= coeff;

  return <i32>q;
}

/** @internal */
// @ts-ignore: decorator
@inline
function rempio2(x: f64, u: u64, sign: i32): i32 {
  const
    pio2_1  = reinterpret<f64>(0x3FF921FB54400000), // 1.57079632673412561417e+00
    pio2_1t = reinterpret<f64>(0x3DD0B4611A626331), // 6.07710050650619224932e-11
    pio2_2  = reinterpret<f64>(0x3DD0B4611A600000), // 6.07710050630396597660e-11
    pio2_2t = reinterpret<f64>(0x3BA3198A2E037073), // 2.02226624879595063154e-21
    pio2_3  = reinterpret<f64>(0x3BA3198A2E000000), // 2.02226624871116645580e-21
    pio2_3t = reinterpret<f64>(0x397B839A252049C1), // 8.47842766036889956997e-32
    invpio2 = reinterpret<f64>(0x3FE45F306DC9C883); // 0.63661977236758134308

  let ix = <u32>(u >> 32) & 0x7FFFFFFF;

  if (ASC_SHRINK_LEVEL < 1) {
    if (ix < 0x4002D97C) { // |x| < 3pi/4, special case with n=+-1
      let q = 1, z: f64, y0: f64, y1: f64;
      if (!sign) {
        z = x - pio2_1;
        if (ix != 0x3FF921FB) { // 33+53 bit pi is good enough
          y0 = z - pio2_1t;
          y1 = (z - y0) - pio2_1t;
        } else { // near pi/2, use 33+33+53 bit pi
          z -= pio2_2;
          y0 = z - pio2_2t;
          y1 = (z - y0) - pio2_2t;
        }
      } else { // negative x
        z = x + pio2_1;
        if (ix != 0x3FF921FB) { // 33+53 bit pi is good enough
          y0 = z + pio2_1t;
          y1 = (z - y0) + pio2_1t;
        } else { // near pi/2, use 33+33+53 bit pi
          z += pio2_2;
          y0 = z + pio2_2t;
          y1 = (z - y0) + pio2_2t;
        }
        q = -1;
      }
      rempio2_y0 = y0;
      rempio2_y1 = y1;
      return q;
    }
  }

  if (ix < 0x413921FB) { // |x| ~< 2^20*pi/2 (1647099)
    // Use precise Cody Waite scheme
    let q  = nearest(x * invpio2);
    let r  = x - q * pio2_1;
    let w  = q * pio2_1t; // 1st round good to 85 bit
    let j  = ix >> 20;
    let y0 = r - w;
    let hi = <u32>(reinterpret<u64>(y0) >> 32);
    let i  = j - ((hi >> 20) & 0x7FF);

    if (i > 16) { // 2nd iteration needed, good to 118
      let t = r;
      w  = q * pio2_2;
      r  = t - w;
      w  = q * pio2_2t - ((t - r) - w);
      y0 = r - w;
      hi = <u32>(reinterpret<u64>(y0) >> 32);
      i = j - ((hi >> 20) & 0x7FF);
      if (i > 49) { // 3rd iteration need, 151 bits acc
        let t = r;
        w  = q * pio2_3;
        r  = t - w;
        w  = q * pio2_3t - ((t - r) - w);
        y0 = r - w;
      }
    }
    let y1 = (r - y0) - w;
    rempio2_y0 = y0;
    rempio2_y1 = y1;
    return <i32>q;
  }
  let q = pio2_large_quot(x, u);
  return select(-q, q, sign);
}

/** @internal */
// @ts-ignore: decorator
@inline
function sin_kern(x: f64, y: f64, iy: i32): f64 { // see: musl/tree/src/math/__sin.c
  const
    S1 = reinterpret<f64>(0xBFC5555555555549), // -1.66666666666666324348e-01
    S2 = reinterpret<f64>(0x3F8111111110F8A6), //  8.33333333332248946124e-03
    S3 = reinterpret<f64>(0xBF2A01A019C161D5), // -1.98412698298579493134e-04
    S4 = reinterpret<f64>(0x3EC71DE357B1FE7D), //  2.75573137070700676789e-06
    S5 = reinterpret<f64>(0xBE5AE5E68A2B9CEB), // -2.50507602534068634195e-08
    S6 = reinterpret<f64>(0x3DE5D93A5ACFD57C); //  1.58969099521155010221e-10

  let z = x * x;
  let w = z * z;
  let r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  let v = z * x;
  if (!iy) {
    return x + v * (S1 + z * r);
  } else {
    return x - ((z * (0.5 * y - v * r) - y) - v * S1);
  }
}

/** @internal */
// @ts-ignore: decorator
@inline
function cos_kern(x: f64, y: f64): f64 { // see: musl/tree/src/math/__cos.c
  const
    C1 = reinterpret<f64>(0x3FA555555555554C), //  4.16666666666666019037e-02
    C2 = reinterpret<f64>(0xBF56C16C16C15177), // -1.38888888888741095749e-03
    C3 = reinterpret<f64>(0x3EFA01A019CB1590), //  2.48015872894767294178e-05
    C4 = reinterpret<f64>(0xBE927E4F809C52AD), // -2.75573143513906633035e-07
    C5 = reinterpret<f64>(0x3E21EE9EBDB4B1C4), //  2.08757232129817482790e-09
    C6 = reinterpret<f64>(0xBDA8FAE9BE8838D4); // -1.13596475577881948265e-11

  let z = x * x;
  let w = z * z;
  let r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  let hz = 0.5 * z;
  w = 1.0 - hz;
  return w + (((1.0 - w) - hz) + (z * r - x * y));
}

/** @internal */
function tan_kern(x: f64, y: f64, iy: i32): f64 { // see: src/lib/msun/src/k_tan.c
  const
    T0  = reinterpret<f64>(0x3FD5555555555563), //  3.33333333333334091986e-01
    T1  = reinterpret<f64>(0x3FC111111110FE7A), //  1.33333333333201242699e-01
    T2  = reinterpret<f64>(0x3FABA1BA1BB341FE), //  5.39682539762260521377e-02
    T3  = reinterpret<f64>(0x3F9664F48406D637), //  2.18694882948595424599e-02
    T4  = reinterpret<f64>(0x3F8226E3E96E8493), //  8.86323982359930005737e-03
    T5  = reinterpret<f64>(0x3F6D6D22C9560328), //  3.59207910759131235356e-03
    T6  = reinterpret<f64>(0x3F57DBC8FEE08315), //  1.45620945432529025516e-03
    T7  = reinterpret<f64>(0x3F4344D8F2F26501), //  5.88041240820264096874e-04
    T8  = reinterpret<f64>(0x3F3026F71A8D1068), //  2.46463134818469906812e-04
    T9  = reinterpret<f64>(0x3F147E88A03792A6), //  7.81794442939557092300e-05
    T10 = reinterpret<f64>(0x3F12B80F32F0A7E9), //  7.14072491382608190305e-05
    T11 = reinterpret<f64>(0xBEF375CBDB605373), // -1.85586374855275456654e-05
    T12 = reinterpret<f64>(0x3EFB2A7074BF7AD4); //  2.59073051863633712884e-05

  const
    one    = reinterpret<f64>(0x3FF0000000000000), // 1.00000000000000000000e+00
    pio4   = reinterpret<f64>(0x3FE921FB54442D18), // 7.85398163397448278999e-01
    pio4lo = reinterpret<f64>(0x3C81A62633145C07); // 3.06161699786838301793e-17

  let z: f64, r: f64, v: f64, w: f64, s: f64;
  let hx = <i32>(reinterpret<u64>(x) >> 32); // high word of x
  let ix = hx & 0x7FFFFFFF; // high word of |x|
  let big = ix >= 0x3FE59428;
  if (big) { // |x| >= 0.6744
    if (hx < 0) { x = -x, y = -y; }
    z = pio4 - x;
    w = pio4lo - y;
    x = z + w;
    y = 0.0;
  }
  z = x * x;
  w = z * z;
  r = T1 + w * (T3 + w * (T5 + w * (T7 + w * (T9 + w * T11))));
  v = z * (T2 + w * (T4 + w * (T6 + w * (T8 + w * (T10 + w * T12)))));
  s = z * x;
  r = y + z * (s * (r + v) + y);
  r += T0 * s;
  w = x + r;
  if (big) {
    v = iy;
    return (1 - ((hx >> 30) & 2)) * (v - 2.0 * (x - (w * w / (w + v) - r)));
  }
  if (iy == 1) return w;
  let a: f64, t: f64;
  z = w;
  z = reinterpret<f64>(reinterpret<u64>(z) & 0xFFFFFFFF00000000);
  v = r - (z - x);  // z + v = r + x
  t = a = -one / w; // a = -1.0 / w
  t = reinterpret<f64>(reinterpret<u64>(t) & 0xFFFFFFFF00000000);
  s = one + t * z;
  return t + a * (s + t * v);
}

/** @internal */
function dtoi32(x: f64): i32 {
  if (ASC_SHRINK_LEVEL > 0) {
    const inv32 = 1.0 / 4294967296;
    return <i32><i64>(x - 4294967296 * floor(x * inv32));
  } else {
    let result = 0;
    let u = reinterpret<u64>(x);
    let e = (u >> 52) & 0x7FF;
    if (e <= 1023 + 30) {
      result = <i32>x;
    } else if (e <= 1023 + 30 + 53) {
      let v = (u & ((<u64>1 << 52) - 1)) | (<u64>1 << 52);
      v = v << e - 1023 - 52 + 32;
      result = <i32>(v >> 32);
      result = select<i32>(-result, result, <i64>u < 0);
    }
    return result;
  }
}

// @ts-ignore: decorator
@lazy let random_seeded = false;

// @ts-ignore: decorator
@lazy let random_state0_64: u64, random_state1_64: u64;

// @ts-ignore: decorator
@lazy let random_state0_32: u32, random_state1_32: u32;

function murmurHash3(h: u64): u64 { // Force all bits of a hash block to avalanche
  h ^= h >> 33;                     // see: https://github.com/aappleby/smhasher
  h *= 0xFF51AFD7ED558CCD;
  h ^= h >> 33;
  h *= 0xC4CEB9FE1A85EC53;
  h ^= h >> 33;
  return h;
}

function splitMix32(h: u32): u32 {
  h += 0x6D2B79F5;
  h  = (h ^ (h >> 15)) * (h | 1);
  h ^= h + (h ^ (h >> 7)) * (h | 61);
  return h ^ (h >> 14);
}

export namespace NativeMath {

  // @ts-ignore: decorator
  @lazy
  export const E       = reinterpret<f64>(0x4005BF0A8B145769); // 2.7182818284590452354

  // @ts-ignore: decorator
  @lazy
  export const LN2     = reinterpret<f64>(0x3FE62E42FEFA39EF); // 0.69314718055994530942

  // @ts-ignore: decorator
  @lazy
  export const LN10    = reinterpret<f64>(0x40026BB1BBB55516); // 2.30258509299404568402

  // @ts-ignore: decorator
  @lazy
  export const LOG2E   = reinterpret<f64>(0x3FF71547652B82FE); // 1.4426950408889634074

  // @ts-ignore: decorator
  @lazy
  export const LOG10E  = reinterpret<f64>(0x3FDBCB7B1526E50E); // 0.43429448190325182765

  // @ts-ignore: decorator
  @lazy
  export const PI      = reinterpret<f64>(0x400921FB54442D18); // 3.14159265358979323846

  // @ts-ignore: decorator
  @lazy
  export const SQRT1_2 = reinterpret<f64>(0x3FE6A09E667F3BCD); // 0.70710678118654752440

  // @ts-ignore: decorator
  @lazy
  export const SQRT2   = reinterpret<f64>(0x3FF6A09E667F3BCD); // 1.41421356237309504880

  // @ts-ignore: decorator
  @lazy
  export let sincos_sin: f64 = 0;

  // @ts-ignore: decorator
  @lazy
  export let sincos_cos: f64 = 0;

  // @ts-ignore: decorator
  @inline export function abs(x: f64): f64 {
    return builtin_abs<f64>(x);
  }

  export function acos(x: f64): f64 { // see: musl/src/math/acos.c and SUN COPYRIGHT NOTICE above
    const
      pio2_hi   = reinterpret<f64>(0x3FF921FB54442D18), // 1.57079632679489655800e+00
      pio2_lo   = reinterpret<f64>(0x3C91A62633145C07), // 6.12323399573676603587e-17
      Ox1p_120f = reinterpret<f32>(0x03800000);

    let hx = <u32>(reinterpret<u64>(x) >> 32);
    let ix = hx & 0x7FFFFFFF;
    if (ix >= 0x3FF00000) {
      let lx = <u32>reinterpret<u64>(x);
      if ((ix - 0x3FF00000 | lx) == 0) {
        if (<i32>hx < 0) return 2 * pio2_hi + Ox1p_120f;
        return 0;
      }
      return 0 / (x - x);
    }
    if (ix < 0x3FE00000) {
      if (ix <= 0x3C600000) return pio2_hi + Ox1p_120f;
      return pio2_hi - (x - (pio2_lo - x * R(x * x)));
    }
    let s: f64, w: f64, z: f64;
    if (<i32>hx < 0) {
      // z = (1.0 + x) * 0.5;
      z = 0.5 + x * 0.5;
      s = builtin_sqrt<f64>(z);
      w = R(z) * s - pio2_lo;
      return 2 * (pio2_hi - (s + w));
    }
    // z = (1.0 - x) * 0.5;
    z = 0.5 - x * 0.5;
    s = builtin_sqrt<f64>(z);
    let df = reinterpret<f64>(reinterpret<u64>(s) & 0xFFFFFFFF00000000);
    let c = (z - df * df) / (s + df);
    w = R(z) * s + c;
    return 2 * (df + w);
  }

  export function acosh(x: f64): f64 { // see: musl/src/math/acosh.c
    const s = reinterpret<f64>(0x3FE62E42FEFA39EF);
    let u = reinterpret<u64>(x);
    // Prevent propagation for all input values less than 1.0.
    // Note musl lib didn't fix this yet.
    if (<i64>u < 0x3FF0000000000000) return (x - x) / 0.0;
    let e = u >> 52 & 0x7FF;
    if (e < 0x3FF + 1) return log1p(x - 1 + builtin_sqrt<f64>((x - 1) * (x - 1) + 2 * (x - 1)));
    if (e < 0x3FF + 26) return log(2 * x - 1 / (x + builtin_sqrt<f64>(x * x - 1)));
    return log(x) + s;
  }

  export function asin(x: f64): f64 { // see: musl/src/math/asin.c and SUN COPYRIGHT NOTICE above
    const
      pio2_hi   = reinterpret<f64>(0x3FF921FB54442D18), // 1.57079632679489655800e+00
      pio2_lo   = reinterpret<f64>(0x3C91A62633145C07), // 6.12323399573676603587e-17
      Ox1p_120f = reinterpret<f32>(0x03800000);

    let hx = <u32>(reinterpret<u64>(x) >> 32);
    let ix = hx & 0x7FFFFFFF;
    if (ix >= 0x3FF00000) {
      let lx = <u32>reinterpret<u64>(x);
      if ((ix - 0x3FF00000 | lx) == 0) return x * pio2_hi + Ox1p_120f;
      return 0 / (x - x);
    }
    if (ix < 0x3FE00000) {
      if (ix < 0x3E500000 && ix >= 0x00100000) return x;
      return x + x * R(x * x);
    }
    // let z = (1.0 - builtin_abs<f64>(x)) * 0.5;
    let z = 0.5 - builtin_abs<f64>(x) * 0.5;
    let s = builtin_sqrt<f64>(z);
    let r = R(z);
    if (ix >= 0x3FEF3333) x = pio2_hi - (2 * (s + s * r) - pio2_lo);
    else {
      let f = reinterpret<f64>(reinterpret<u64>(s) & 0xFFFFFFFF00000000);
      let c = (z - f * f) / (s + f);
      x = 0.5 * pio2_hi - (2 * s * r - (pio2_lo - 2 * c) - (0.5 * pio2_hi - 2 * f));
    }
    return select(-x, x, <i32>hx < 0);
  }

  export function asinh(x: f64): f64 { // see: musl/src/math/asinh.c
    const c = reinterpret<f64>(0x3FE62E42FEFA39EF); // 0.693147180559945309417232121458176568
    let u = reinterpret<u64>(x);
    let e = u >> 52 & 0x7FF;
    let y = reinterpret<f64>(u & 0x7FFFFFFFFFFFFFFF);
    if (e >= 0x3FF + 26) y = log(y) + c;
    else if (e >= 0x3FF + 1)  y =   log(2 * y + 1 / (builtin_sqrt<f64>(y * y + 1) + y));
    else if (e >= 0x3FF - 26) y = log1p(y + y * y / (builtin_sqrt<f64>(y * y + 1) + 1));
    return builtin_copysign(y, x);
  }

  export function atan(x: f64): f64 { // see musl/src/math/atan.c and SUN COPYRIGHT NOTICE above
    const
      atanhi0   = reinterpret<f64>(0x3FDDAC670561BB4F), //  4.63647609000806093515e-01
      atanhi1   = reinterpret<f64>(0x3FE921FB54442D18), //  7.85398163397448278999e-01
      atanhi2   = reinterpret<f64>(0x3FEF730BD281F69B), //  9.82793723247329054082e-01
      atanhi3   = reinterpret<f64>(0x3FF921FB54442D18), //  1.57079632679489655800e+00
      atanlo0   = reinterpret<f64>(0x3C7A2B7F222F65E2), //  2.26987774529616870924e-17
      atanlo1   = reinterpret<f64>(0x3C81A62633145C07), //  3.06161699786838301793e-17
      atanlo2   = reinterpret<f64>(0x3C7007887AF0CBBD), //  1.39033110312309984516e-17
      atanlo3   = reinterpret<f64>(0x3C91A62633145C07), //  6.12323399573676603587e-17
      aT0       = reinterpret<f64>(0x3FD555555555550D), //  3.33333333333329318027e-01
      aT1       = reinterpret<f64>(0xBFC999999998EBC4), // -1.99999999998764832476e-01
      aT2       = reinterpret<f64>(0x3FC24924920083FF), //  1.42857142725034663711e-01
      aT3       = reinterpret<f64>(0xBFBC71C6FE231671), // -1.11111104054623557880e-01,
      aT4       = reinterpret<f64>(0x3FB745CDC54C206E), //  9.09088713343650656196e-02
      aT5       = reinterpret<f64>(0xBFB3B0F2AF749A6D), // -7.69187620504482999495e-02
      aT6       = reinterpret<f64>(0x3FB10D66A0D03D51), //  6.66107313738753120669e-02
      aT7       = reinterpret<f64>(0xBFADDE2D52DEFD9A), // -5.83357013379057348645e-02
      aT8       = reinterpret<f64>(0x3FA97B4B24760DEB), //  4.97687799461593236017e-02
      aT9       = reinterpret<f64>(0xBFA2B4442C6A6C2F), // -3.65315727442169155270e-02
      aT10      = reinterpret<f64>(0x3F90AD3AE322DA11), //  1.62858201153657823623e-02
      Ox1p_120f = reinterpret<f32>(0x03800000);

    let ix = <u32>(reinterpret<u64>(x) >> 32);
    let sx = x;
    ix &= 0x7FFFFFFF;
    let z: f64;
    if (ix >= 0x44100000) {
      if (isNaN(x)) return x;
      z = atanhi3 + Ox1p_120f;
      return builtin_copysign<f64>(z, sx);
    }
    let id: i32;
    if (ix < 0x3FDC0000) {
      if (ix < 0x3E400000) return x;
      id = -1;
    } else {
      x = builtin_abs<f64>(x);
      if (ix < 0x3FF30000) {
        if (ix < 0x3FE60000) {
          id = 0;
          x = (2.0 * x - 1.0) / (2.0 + x);
        } else {
          id = 1;
          x = (x - 1.0) / (x + 1.0);
        }
      } else {
        if (ix < 0x40038000) {
          id = 2;
          x = (x - 1.5) / (1.0 + 1.5 * x);
        } else {
          id = 3;
          x = -1.0 / x;
        }
      }
    }
    z = x * x;
    let w = z * z;
    let s1 = z * (aT0 + w * (aT2 + w * (aT4 + w * (aT6 + w * (aT8 + w * aT10)))));
    let s2 = w * (aT1 + w * (aT3 + w * (aT5 + w * (aT7 + w * aT9))));
    let s3 = x * (s1 + s2);
    if (id < 0) return x - s3;
    switch (id) {
      case 0: { z = atanhi0 - ((s3 - atanlo0) - x); break; }
      case 1: { z = atanhi1 - ((s3 - atanlo1) - x); break; }
      case 2: { z = atanhi2 - ((s3 - atanlo2) - x); break; }
      case 3: { z = atanhi3 - ((s3 - atanlo3) - x); break; }
      default: unreachable();
    }
    return builtin_copysign<f64>(z, sx);
  }

  export function atanh(x: f64): f64 { // see: musl/src/math/atanh.c
    let u = reinterpret<u64>(x);
    let e = u >> 52 & 0x7FF;
    let y = builtin_abs(x);
    if (e < 0x3FF - 1) {
      if (e >= 0x3FF - 32) y = 0.5 * log1p(2 * y + 2 * y * y / (1 - y));
    } else {
      y = 0.5 * log1p(2 * (y / (1 - y)));
    }
    return builtin_copysign<f64>(y, x);
  }

  export function atan2(y: f64, x: f64): f64 { // see: musl/src/math/atan2.c and SUN COPYRIGHT NOTICE above
    const pi_lo = reinterpret<f64>(0x3CA1A62633145C07); // 1.2246467991473531772E-16
    if (isNaN(x) || isNaN(y)) return x + y;
    let u = reinterpret<u64>(x);
    let ix = <u32>(u >> 32);
    let lx = <u32>u;
    u = reinterpret<u64>(y);
    let iy = <u32>(u >> 32);
    let ly = <u32>u;
    if ((ix - 0x3FF00000 | lx) == 0) return atan(y);
    let m = ((iy >> 31) & 1) | ((ix >> 30) & 2);
    ix = ix & 0x7FFFFFFF;
    iy = iy & 0x7FFFFFFF;
    if ((iy | ly) == 0) {
      switch (m) {
        case 0:
        case 1: return  y;
        case 2: return  PI;
        case 3: return -PI;
      }
    }
    if ((ix | lx) == 0) return m & 1 ? -PI / 2 : PI / 2;
    if (ix == 0x7FF00000) {
      if (iy == 0x7FF00000) {
        let t = m & 2 ? 3 * PI / 4 : PI / 4;
        return m & 1 ? -t : t;
      } else {
        let t = m & 2 ? PI : 0;
        return m & 1 ? -t : t;
      }
    }
    let z: f64;
    if (ix + (64 << 20) < iy || iy == 0x7FF00000) return m & 1 ? -PI / 2 : PI / 2;
    if ((m & 2) && iy + (64 << 20) < ix) z = 0;
    else z = atan(builtin_abs<f64>(y / x));
    switch (m) {
      case 0: return  z;
      case 1: return -z;
      case 2: return PI - (z - pi_lo);
      case 3: return (z - pi_lo) - PI;
    }
    unreachable();
    return 0;
  }

  export function cbrt(x: f64): f64 { // see: musl/src/math/cbrt.c and SUN COPYRIGHT NOTICE above
    const
      B1     = <u32>715094163,
      B2     = <u32>696219795,
      P0     = reinterpret<f64>(0x3FFE03E60F61E692), //  1.87595182427177009643
      P1     = reinterpret<f64>(0xBFFE28E092F02420), // -1.88497979543377169875
      P2     = reinterpret<f64>(0x3FF9F1604A49D6C2), //  1.621429720105354466140
      P3     = reinterpret<f64>(0xBFE844CBBEE751D9), // -0.758397934778766047437
      P4     = reinterpret<f64>(0x3FC2B000D4E4EDD7), //  0.145996192886612446982
      Ox1p54 = reinterpret<f64>(0x4350000000000000); //  0x1p54

    let u = reinterpret<u64>(x);
    let hx = <u32>(u >> 32) & 0x7FFFFFFF;
    if (hx >= 0x7FF00000) return x + x;
    if (hx < 0x00100000) {
      u = reinterpret<u64>(x * Ox1p54);
      hx = <u32>(u >> 32) & 0x7FFFFFFF;
      if (hx == 0) return x;
      hx = hx / 3 + B2;
    } else {
      hx = hx / 3 + B1;
    }
    u &= 1 << 63;
    u |= <u64>hx << 32;
    let t = reinterpret<f64>(u);
    let r = (t * t) * (t / x);
    t = t * ((P0 + r * (P1 + r * P2)) + ((r * r) * r) * (P3 + r * P4));
    t = reinterpret<f64>((reinterpret<u64>(t) + 0x80000000) & 0xFFFFFFFFC0000000);
    let s = t * t;
    r = x / s;
    r = (r - t) / (2 * t + r);
    t = t + t * r;
    return t;
  }

  // @ts-ignore: decorator
  @inline
  export function ceil(x: f64): f64 {
    return builtin_ceil<f64>(x);
  }

  export function clz32(x: f64): f64 {
    if (!isFinite(x)) return 32;
    /*
     * Wasm (MVP) and JS have different approaches for double->int conversions.
     *
     * For emulate JS conversion behavior and avoid trapping from wasm we should modulate by MAX_INT
     * our float-point arguments before actual convertion to integers.
     */
    return builtin_clz(dtoi32(x));
  }

  export function cos(x: f64): f64 { // see: musl/src/math/cos.c
    let u  = reinterpret<u64>(x);
    let ux = u32(u >> 32);
    let sign = ux >> 31;

    ux &= 0x7FFFFFFF;

    // |x| ~< pi/4
    if (ux <= 0x3FE921FB) {
      if (ux < 0x3E46A09E) {  // |x| < 2**-27 * sqrt(2)
        return 1.0;
      }
      return cos_kern(x, 0);
    }

    // sin(Inf or NaN) is NaN
    if (ux >= 0x7FF00000) return x - x;

    // argument reduction needed
    let n  = rempio2(x, u, sign);
    let y0 = rempio2_y0;
    let y1 = rempio2_y1;

    x = n & 1 ? sin_kern(y0, y1, 1) : cos_kern(y0, y1);
    return (n + 1) & 2 ? -x : x;
  }

  export function cosh(x: f64): f64 { // see: musl/src/math/cosh.c
    let u = reinterpret<u64>(x);
    u &= 0x7FFFFFFFFFFFFFFF;
    x = reinterpret<f64>(u);
    let w = <u32>(u >> 32);
    let t: f64;
    if (w < 0x3FE62E42) {
      if (w < 0x3FF00000 - (26 << 20)) return 1;
      t = expm1(x);
      // return 1 + t * t / (2 * (1 + t));
      return 1 + t * t / (2 + 2 * t);
    }
    if (w < 0x40862E42) {
      t = exp(x);
      return 0.5 * (t + 1 / t);
    }
    t = expo2(x, 1);
    return t;
  }

  export function exp(x: f64): f64 { // see: musl/src/math/exp.c and SUN COPYRIGHT NOTICE above
    if (ASC_SHRINK_LEVEL < 1) {
      return exp_lut(x);
    } else {
      const
        ln2hi     = reinterpret<f64>(0x3FE62E42FEE00000), //  6.93147180369123816490e-01
        ln2lo     = reinterpret<f64>(0x3DEA39EF35793C76), //  1.90821492927058770002e-10
        invln2    = reinterpret<f64>(0x3FF71547652B82FE), //  1.44269504088896338700e+00
        P1        = reinterpret<f64>(0x3FC555555555553E), //  1.66666666666666019037e-01
        P2        = reinterpret<f64>(0xBF66C16C16BEBD93), // -2.77777777770155933842e-03
        P3        = reinterpret<f64>(0x3F11566AAF25DE2C), //  6.61375632143793436117e-05
        P4        = reinterpret<f64>(0xBEBBBD41C5D26BF1), // -1.65339022054652515390e-06
        P5        = reinterpret<f64>(0x3E66376972BEA4D0), //  4.13813679705723846039e-08
        overflow  = reinterpret<f64>(0x40862E42FEFA39EF), //  709.782712893383973096
        underflow = reinterpret<f64>(0xC0874910D52D3051), // -745.13321910194110842
        Ox1p1023  = reinterpret<f64>(0x7FE0000000000000); //  0x1p1023

      let hx = u32(reinterpret<u64>(x) >> 32);
      let sign = hx >> 31;
      hx &= 0x7FFFFFFF;
      if (hx >= 0x4086232B) {
        if (isNaN(x)) return x;
        if (x > overflow)  return x * Ox1p1023;
        if (x < underflow) return 0;
      }
      let hi: f64, lo: f64 = 0;
      let k = 0;
      if (hx > 0x3FD62E42) {
        if (hx >= 0x3FF0A2B2) {
          k = i32(invln2 * x + builtin_copysign<f64>(0.5, x));
        } else {
          k = 1 - (sign << 1);
        }
        hi = x - k * ln2hi;
        lo = k * ln2lo;
        x = hi - lo;
      } else if (hx > 0x3E300000) {
        hi = x;
      } else return 1.0 + x;
      let xs = x * x;
      // let c = x - xp2 * (P1 + xp2 * (P2 + xp2 * (P3 + xp2 * (P4 + xp2 * P5))));
      let xq = xs * xs;
      let c = x - (xs * P1 + xq * ((P2 + xs * P3) + xq * (P4 + xs * P5)));
      let y = 1.0 + (x * c / (2 - c) - lo + hi);
      return k == 0 ? y : scalbn(y, k);
    }
  }

  export function exp2(x: f64): f64 {
    return exp2_lut(x);
  }

  export function expm1(x: f64): f64 { // see: musl/src/math/expm1.c and SUN COPYRIGHT NOTICE above
    const
      o_threshold = reinterpret<f64>(0x40862E42FEFA39EF), //  7.09782712893383973096e+02
      ln2_hi      = reinterpret<f64>(0x3FE62E42FEE00000), //  6.93147180369123816490e-01
      ln2_lo      = reinterpret<f64>(0x3DEA39EF35793C76), //  1.90821492927058770002e-10
      invln2      = reinterpret<f64>(0x3FF71547652B82FE), //  1.44269504088896338700e+00
      Q1          = reinterpret<f64>(0xBFA11111111110F4), // -3.33333333333331316428e-02
      Q2          = reinterpret<f64>(0x3F5A01A019FE5585), //  1.58730158725481460165e-03
      Q3          = reinterpret<f64>(0xBF14CE199EAADBB7), // -7.93650757867487942473e-05
      Q4          = reinterpret<f64>(0x3ED0CFCA86E65239), //  4.00821782732936239552e-06
      Q5          = reinterpret<f64>(0xBE8AFDB76E09C32D), // -2.01099218183624371326e-07
      Ox1p1023    = reinterpret<f64>(0x7FE0000000000000); //  0x1p1023

    let u = reinterpret<u64>(x);
    let hx = u32(u >> 32) & 0x7FFFFFFF;
    let sign = u32(u >> 63);
    let k = 0;
    if (hx >= 0x4043687A) {
      if (isNaN(x)) return x;
      if (sign) return -1;
      if (x > o_threshold) return x * Ox1p1023;
    }
    let c = 0.0, t: f64;
    if (hx > 0x3FD62E42) {
      k = select<i32>(
        1 - (sign << 1),
        i32(invln2 * x + builtin_copysign<f64>(0.5, x)),
        hx < 0x3FF0A2B2
      );
      t = <f64>k;
      let hi = x - t * ln2_hi;
      let lo = t * ln2_lo;
      x = hi - lo;
      c = (hi - x) - lo;
    } else if (hx < 0x3C900000) return x;
    let hfx = 0.5 * x;
    let hxs = x * hfx;
    // let r1 = 1.0 + hxs * (Q1 + hxs * (Q2 + hxs * (Q3 + hxs * (Q4 + hxs * Q5))));
    let hxq = hxs * hxs;
    let r1 = (1.0 + hxs * Q1) + hxq * ((Q2 + hxs * Q3) + hxq * (Q4 + hxs * Q5));
    t = 3.0 - r1 * hfx;
    let e = hxs * ((r1 - t) / (6.0 - x * t));
    if (k == 0) return x - (x * e - hxs);
    e = x * (e - c) - c;
    e -= hxs;
    if (k == -1) return 0.5 * (x - e) - 0.5;
    if (k == 1) {
      if (x < -0.25) return -2.0 * (e - (x + 0.5));
      return 1.0 + 2.0 * (x - e);
    }
    u = (0x3FF + k) << 52;
    let twopk = reinterpret<f64>(u);
    let y: f64;
    if (k < 0 || k > 56) {
      y = x - e + 1.0;
      if (k == 1024) y = y * 2.0 * Ox1p1023;
      else y = y * twopk;
      return y - 1.0;
    }
    u = (0x3FF - k) << 52;
    y = reinterpret<f64>(u);
    if (k < 20) y = (1 - y) - e;
    else y = 1 - (e + y);
    return (x + y) * twopk;
  }

  // @ts-ignore: decorator
  @inline
  export function floor(x: f64): f64 {
    return builtin_floor<f64>(x);
  }

  // @ts-ignore: decorator
  @inline
  export function fround(x: f64): f64 {
    return <f32>x;
  }

  export function hypot(x: f64, y: f64): f64 { // see: musl/src/math/hypot.c
    const
      SPLIT    = reinterpret<f64>(0x41A0000000000000) + 1, // 0x1p27 + 1
      Ox1p700  = reinterpret<f64>(0x6BB0000000000000),
      Ox1p_700 = reinterpret<f64>(0x1430000000000000);

    let ux = reinterpret<u64>(x);
    let uy = reinterpret<u64>(y);
    ux &= 0x7FFFFFFFFFFFFFFF;
    uy &= 0x7FFFFFFFFFFFFFFF;
    if (ux < uy) {
      let ut = ux;
      ux = uy;
      uy = ut;
    }
    let ex = i32(ux >> 52);
    let ey = i32(uy >> 52);
    y = reinterpret<f64>(uy);
    if (ey == 0x7FF) return y;
    x = reinterpret<f64>(ux);
    if (ex == 0x7FF || uy == 0) return x;
    if (ex - ey > 64) return x + y;
    let z = 1.0;
    if (ex > 0x3FF + 510) {
      z  = Ox1p700;
      x *= Ox1p_700;
      y *= Ox1p_700;
    } else if (ey < 0x3FF - 450) {
      z  = Ox1p_700;
      x *= Ox1p700;
      y *= Ox1p700;
    }
    let c = x * SPLIT;
    let h = x - c + c;
    let l = x - h;
    let hx = x * x;
    let lx = h * h - hx + (2 * h + l) * l;
    c = y * SPLIT;
    h = y - c + c;
    l = y - h;
    let hy = y * y;
    let ly = h * h - hy + (2 * h + l) * l;
    return z * builtin_sqrt(ly + lx + hy + hx);
  }

  export function imul(x: f64, y: f64): f64 {
    /*
     * Wasm (MVP) and JS have different approaches for double->int conversions.
     *
     * For emulate JS conversion behavior and avoid trapping from wasm we should modulate by MAX_INT
     * our float-point arguments before actual convertion to integers.
     */
    if (!isFinite(x + y)) return 0;
    return dtoi32(x) * dtoi32(y);
  }

  export function log(x: f64): f64 { // see: musl/src/math/log.c and SUN COPYRIGHT NOTICE above
    if (ASC_SHRINK_LEVEL < 1) {
      return log_lut(x);
    } else {
      const
        ln2_hi = reinterpret<f64>(0x3FE62E42FEE00000), // 6.93147180369123816490e-01
        ln2_lo = reinterpret<f64>(0x3DEA39EF35793C76), // 1.90821492927058770002e-10
        Lg1    = reinterpret<f64>(0x3FE5555555555593), // 6.666666666666735130e-01
        Lg2    = reinterpret<f64>(0x3FD999999997FA04), // 3.999999999940941908e-01
        Lg3    = reinterpret<f64>(0x3FD2492494229359), // 2.857142874366239149e-01
        Lg4    = reinterpret<f64>(0x3FCC71C51D8E78AF), // 2.222219843214978396e-01
        Lg5    = reinterpret<f64>(0x3FC7466496CB03DE), // 1.818357216161805012e-01
        Lg6    = reinterpret<f64>(0x3FC39A09D078C69F), // 1.531383769920937332e-01
        Lg7    = reinterpret<f64>(0x3FC2F112DF3E5244), // 1.479819860511658591e-01
        Ox1p54 = reinterpret<f64>(0x4350000000000000); // 0x1p54

      let u = reinterpret<u64>(x);
      let hx = u32(u >> 32);
      let k = 0;
      let sign = hx >> 31;
      if (sign || hx < 0x00100000) {
        if (u << 1 == 0) return -1 / (x * x);
        if (sign) return (x - x) / 0.0;
        k -= 54;
        x *= Ox1p54;
        u = reinterpret<u64>(x);
        hx = u32(u >> 32);
      } else if (hx >= 0x7FF00000) {
        return x;
      } else if (hx == 0x3FF00000 && u << 32 == 0) {
        return 0;
      }
      hx += 0x3FF00000 - 0x3FE6A09E;
      k += (<i32>hx >> 20) - 0x3FF;
      hx = (hx & 0x000FFFFF) + 0x3FE6A09E;
      u = <u64>hx << 32 | (u & 0xFFFFFFFF);
      x = reinterpret<f64>(u);
      let f = x - 1.0;
      let hfsq = 0.5 * f * f;
      let s = f / (2.0 + f);
      let z = s * s;
      let w = z * z;
      let t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
      let t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
      let r = t2 + t1;
      let dk = <f64>k;
      return s * (hfsq + r) + dk * ln2_lo - hfsq + f + dk * ln2_hi;
    }
  }

  export function log10(x: f64): f64 { // see: musl/src/math/log10.c and SUN COPYRIGHT NOTICE above
    const
      ivln10hi  = reinterpret<f64>(0x3FDBCB7B15200000), // 4.34294481878168880939e-01
      ivln10lo  = reinterpret<f64>(0x3DBB9438CA9AADD5), // 2.50829467116452752298e-11
      log10_2hi = reinterpret<f64>(0x3FD34413509F6000), // 3.01029995663611771306e-01
      log10_2lo = reinterpret<f64>(0x3D59FEF311F12B36), // 3.69423907715893078616e-13
      Lg1       = reinterpret<f64>(0x3FE5555555555593), // 6.666666666666735130e-01
      Lg2       = reinterpret<f64>(0x3FD999999997FA04), // 3.999999999940941908e-01
      Lg3       = reinterpret<f64>(0x3FD2492494229359), // 2.857142874366239149e-01
      Lg4       = reinterpret<f64>(0x3FCC71C51D8E78AF), // 2.222219843214978396e-01
      Lg5       = reinterpret<f64>(0x3FC7466496CB03DE), // 1.818357216161805012e-01
      Lg6       = reinterpret<f64>(0x3FC39A09D078C69F), // 1.531383769920937332e-01
      Lg7       = reinterpret<f64>(0x3FC2F112DF3E5244), // 1.479819860511658591e-01
      Ox1p54    = reinterpret<f64>(0x4350000000000000); // 0x1p54

    let u = reinterpret<u64>(x);
    let hx = u32(u >> 32);
    let k = 0;
    let sign = hx >> 31;
    if (sign || hx < 0x00100000) {
      if (u << 1 == 0) return -1 / (x * x);
      if (sign) return (x - x) / 0.0;
      k -= 54;
      x *= Ox1p54;
      u = reinterpret<u64>(x);
      hx = u32(u >> 32);
    } else if (hx >= 0x7FF00000) {
      return x;
    } else if (hx == 0x3FF00000 && u << 32 == 0) {
      return 0;
    }
    hx += 0x3FF00000 - 0x3FE6A09E;
    k += i32(hx >> 20) - 0x3FF;
    hx = (hx & 0x000FFFFF) + 0x3FE6A09E;
    u = <u64>hx << 32 | (u & 0xFFFFFFFF);
    x = reinterpret<f64>(u);
    let f = x - 1.0;
    let hfsq = 0.5 * f * f;
    let s = f / (2.0 + f);
    let z = s * s;
    let w = z * z;
    let t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
    let t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
    let r = t2 + t1;
    let hi = f - hfsq;
    u = reinterpret<u64>(hi);
    u &= 0xFFFFFFFF00000000;
    hi = reinterpret<f64>(u);
    let lo = f - hi - hfsq + s * (hfsq + r);
    let val_hi = hi * ivln10hi;
    let dk = <f64>k;
    let y = dk * log10_2hi;
    let val_lo = dk * log10_2lo + (lo + hi) * ivln10lo + lo * ivln10hi;
    w = y + val_hi;
    val_lo += (y - w) + val_hi;
    return val_lo + w;
  }

  export function log1p(x: f64): f64 { // see: musl/src/math/log1p.c and SUN COPYRIGHT NOTICE above
    const
      ln2_hi = reinterpret<f64>(0x3FE62E42FEE00000), // 6.93147180369123816490e-01
      ln2_lo = reinterpret<f64>(0x3DEA39EF35793C76), // 1.90821492927058770002e-10
      Lg1    = reinterpret<f64>(0x3FE5555555555593), // 6.666666666666735130e-01
      Lg2    = reinterpret<f64>(0x3FD999999997FA04), // 3.999999999940941908e-01
      Lg3    = reinterpret<f64>(0x3FD2492494229359), // 2.857142874366239149e-01
      Lg4    = reinterpret<f64>(0x3FCC71C51D8E78AF), // 2.222219843214978396e-01
      Lg5    = reinterpret<f64>(0x3FC7466496CB03DE), // 1.818357216161805012e-01
      Lg6    = reinterpret<f64>(0x3FC39A09D078C69F), // 1.531383769920937332e-01
      Lg7    = reinterpret<f64>(0x3FC2F112DF3E5244); // 1.479819860511658591e-01

    let u = reinterpret<u64>(x);
    let hx = u32(u >> 32);
    let k = 1;
    let c = 0.0, f = 0.0;
    if (hx < 0x3FDA827A || bool(hx >> 31)) {
      if (hx >= 0xBFF00000) {
        if (x == -1) return x / 0.0;
        return (x - x) / 0.0;
      }
      if (hx << 1 < 0x3CA00000 << 1) return x;
      if (hx <= 0xBFD2BEC4) {
        k = 0;
        c = 0;
        f = x;
      }
    } else if (hx >= 0x7FF00000) return x;
    if (k) {
      u = reinterpret<u64>(1 + x);
      let hu = u32(u >> 32);
      hu += 0x3FF00000 - 0x3FE6A09E;
      k = i32(hu >> 20) - 0x3FF;
      if (k < 54) {
        let uf = reinterpret<f64>(u);
        c = k >= 2 ? 1 - (uf - x) : x - (uf - 1);
        c /= uf;
      } else c = 0;
      hu = (hu & 0x000FFFFF) + 0x3FE6A09E;
      u = <u64>hu << 32 | (u & 0xFFFFFFFF);
      f = reinterpret<f64>(u) - 1;
    }
    let hfsq = 0.5 * f * f;
    let s = f / (2.0 + f);
    let z = s * s;
    let w = z * z;
    let t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
    let t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
    let r = t2 + t1;
    let dk = <f64>k;
    return s * (hfsq + r) + (dk * ln2_lo + c) - hfsq + f + dk * ln2_hi;
  }

  export function log2(x: f64): f64 { // see: musl/src/math/log2.c and SUN COPYRIGHT NOTICE above
    if (ASC_SHRINK_LEVEL < 1) {
      return log2_lut(x);
    } else {
      const
        ivln2hi = reinterpret<f64>(0x3FF7154765200000), // 1.44269504072144627571e+00
        ivln2lo = reinterpret<f64>(0x3DE705FC2EEFA200), // 1.67517131648865118353e-10
        Lg1     = reinterpret<f64>(0x3FE5555555555593), // 6.666666666666735130e-01
        Lg2     = reinterpret<f64>(0x3FD999999997FA04), // 3.999999999940941908e-01
        Lg3     = reinterpret<f64>(0x3FD2492494229359), // 2.857142874366239149e-01
        Lg4     = reinterpret<f64>(0x3FCC71C51D8E78AF), // 2.222219843214978396e-01
        Lg5     = reinterpret<f64>(0x3FC7466496CB03DE), // 1.818357216161805012e-01
        Lg6     = reinterpret<f64>(0x3FC39A09D078C69F), // 1.531383769920937332e-01
        Lg7     = reinterpret<f64>(0x3FC2F112DF3E5244), // 1.479819860511658591e-01
        Ox1p54  = reinterpret<f64>(0x4350000000000000); // 1p54

      let u = reinterpret<u64>(x);
      let hx = u32(u >> 32);
      let k = 0;
      let sign = hx >> 31;
      if (sign || hx < 0x00100000) {
        if (u << 1 == 0) return -1 / (x * x);
        if (sign) return (x - x) / 0.0;
        k -= 54;
        x *= Ox1p54;
        u = reinterpret<u64>(x);
        hx = u32(u >> 32);
      } else if (hx >= 0x7FF00000) {
        return x;
      } else if (hx == 0x3FF00000 && u << 32 == 0) {
        return 0;
      }
      hx += 0x3FF00000 - 0x3FE6A09E;
      k += i32(hx >> 20) - 0x3FF;
      hx = (hx & 0x000FFFFF) + 0x3FE6A09E;
      u = <u64>hx << 32 | (u & 0xFFFFFFFF);
      x = reinterpret<f64>(u);
      let f = x - 1.0;
      let hfsq = 0.5 * f * f;
      let s = f / (2.0 + f);
      let z = s * s;
      let w = z * z;
      let t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
      let t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
      let r = t2 + t1;
      let hi = f - hfsq;
      u = reinterpret<u64>(hi);
      u &= 0xFFFFFFFF00000000;
      hi = reinterpret<f64>(u);
      let lo = f - hi - hfsq + s * (hfsq + r);
      let val_hi = hi * ivln2hi;
      let val_lo = (lo + hi) * ivln2lo + lo * ivln2hi;
      let y = <f64>k;
      w = y + val_hi;
      val_lo += (y - w) + val_hi;
      val_hi = w;
      return val_lo + val_hi;
    }
  }

  // @ts-ignore: decorator
  @inline
  export function max(value1: f64, value2: f64): f64 {
    return builtin_max<f64>(value1, value2);
  }

  // @ts-ignore: decorator
  @inline
  export function min(value1: f64, value2: f64): f64 {
    return builtin_min<f64>(value1, value2);
  }

  export function pow(x: f64, y: f64): f64 { // see: musl/src/math/pow.c and SUN COPYRIGHT NOTICE above
    // TODO: remove this fast pathes after introduced own mid-end IR with "stdlib call simplify" transforms
    if (builtin_abs<f64>(y) <= 2) {
      if (y == 2.0) return x * x;
      if (y == 0.5) {
        return select<f64>(
          builtin_abs<f64>(builtin_sqrt<f64>(x)),
          Infinity,
          x != -Infinity
        );
      }
      if (y == -1.0) return 1 / x;
      if (y == 1.0) return x;
      if (y == 0.0) return 1.0;
    }
    if (ASC_SHRINK_LEVEL < 1) {
      return pow_lut(x, y);
    } else {
      const
        dp_h1   = reinterpret<f64>(0x3FE2B80340000000), //  5.84962487220764160156e-01
        dp_l1   = reinterpret<f64>(0x3E4CFDEB43CFD006), //  1.35003920212974897128e-08
        two53   = reinterpret<f64>(0x4340000000000000), //  9007199254740992.0
        huge    = reinterpret<f64>(0x7E37E43C8800759C), //  1e+300
        tiny    = reinterpret<f64>(0x01A56E1FC2F8F359), //  1e-300
        L1      = reinterpret<f64>(0x3FE3333333333303), //  5.99999999999994648725e-01
        L2      = reinterpret<f64>(0x3FDB6DB6DB6FABFF), //  4.28571428578550184252e-01
        L3      = reinterpret<f64>(0x3FD55555518F264D), //  3.33333329818377432918e-01
        L4      = reinterpret<f64>(0x3FD17460A91D4101), //  2.72728123808534006489e-01
        L5      = reinterpret<f64>(0x3FCD864A93C9DB65), //  2.30660745775561754067e-01
        L6      = reinterpret<f64>(0x3FCA7E284A454EEF), //  2.06975017800338417784e-01
        P1      = reinterpret<f64>(0x3FC555555555553E), //  1.66666666666666019037e-01
        P2      = reinterpret<f64>(0xBF66C16C16BEBD93), // -2.77777777770155933842e-03
        P3      = reinterpret<f64>(0x3F11566AAF25DE2C), //  6.61375632143793436117e-05
        P4      = reinterpret<f64>(0xBEBBBD41C5D26BF1), // -1.65339022054652515390e-06
        P5      = reinterpret<f64>(0x3E66376972BEA4D0), //  4.13813679705723846039e-08
        lg2     = reinterpret<f64>(0x3FE62E42FEFA39EF), //  6.93147180559945286227e-01
        lg2_h   = reinterpret<f64>(0x3FE62E4300000000), //  6.93147182464599609375e-01
        lg2_l   = reinterpret<f64>(0xBE205C610CA86C39), // -1.90465429995776804525e-09
        ovt     = reinterpret<f64>(0x3C971547652B82FE), //  8.0085662595372944372e-017
        cp      = reinterpret<f64>(0x3FEEC709DC3A03FD), //  9.61796693925975554329e-01
        cp_h    = reinterpret<f64>(0x3FEEC709E0000000), //  9.61796700954437255859e-01
        cp_l    = reinterpret<f64>(0xBE3E2FE0145B01F5), // -7.02846165095275826516e-09
        ivln2   = reinterpret<f64>(0x3FF71547652B82FE), //  1.44269504088896338700e+00
        ivln2_h = reinterpret<f64>(0x3FF7154760000000), //  1.44269502162933349609e+00
        ivln2_l = reinterpret<f64>(0x3E54AE0BF85DDF44), //  1.92596299112661746887e-08
        inv3    = reinterpret<f64>(0x3FD5555555555555); //  0.3333333333333333333333

      let u_ = reinterpret<u64>(x);
      let hx = i32(u_ >> 32);
      let lx = <u32>u_;
      u_ = reinterpret<u64>(y);
      let hy = i32(u_ >> 32);
      let ly = <u32>u_;
      let ix = hx & 0x7FFFFFFF;
      let iy = hy & 0x7FFFFFFF;
      if ((iy | ly) == 0) return 1.0; // x**0 = 1, even if x is NaN
      // if (hx == 0x3FF00000 && lx == 0) return 1.0; // C: 1**y = 1, even if y is NaN, JS: NaN
      if ( // NaN if either arg is NaN
        ix > 0x7FF00000 || (ix == 0x7FF00000 && lx != 0) ||
        iy > 0x7FF00000 || (iy == 0x7FF00000 && ly != 0)
      ) return x + y;
      let yisint = 0, k: i32;
      if (hx < 0) {
        if (iy >= 0x43400000) yisint = 2;
        else if (iy >= 0x3FF00000) {
          k = (iy >> 20) - 0x3FF;
          let offset = select<u32>(52, 20, k > 20) - k;
          let Ly = select<u32>(ly, iy, k > 20);
          let jj = Ly >> offset;
          if ((jj << offset) == Ly) yisint = 2 - (jj & 1);
        }
      }
      if (ly == 0) {
        if (iy == 0x7FF00000) { // y is +-inf
          if (((ix - 0x3FF00000) | lx) == 0) return NaN; // C: (-1)**+-inf is 1, JS: NaN
          else if (ix >= 0x3FF00000) return hy >= 0 ? y : 0.0; // (|x|>1)**+-inf = inf,0
          else return hy >= 0 ? 0.0 : -y; // (|x|<1)**+-inf = 0,inf
        }
        if (iy == 0x3FF00000) {
          if (hy >= 0) return x;
          return 1 / x;
        }
        if (hy == 0x40000000) return x * x;
        if (hy == 0x3FE00000) {
          if (hx >= 0) return builtin_sqrt(x);
        }
      }
      let ax = builtin_abs<f64>(x), z: f64;
      if (lx == 0) {
        if (ix == 0 || ix == 0x7FF00000 || ix == 0x3FF00000) {
          z = ax;
          if (hy < 0) z = 1.0 / z;
          if (hx < 0) {
            if (((ix - 0x3FF00000) | yisint) == 0) {
              let d = z - z;
              z = d / d;
            } else if (yisint == 1) z = -z;
          }
          return z;
        }
      }
      let s = 1.0;
      if (hx < 0) {
        if (yisint == 0) {
          let d = x - x;
          return d / d;
        }
        if (yisint == 1) s = -1.0;
      }
      let t1: f64, t2: f64, p_h: f64, p_l: f64, r: f64, t: f64, u: f64, v: f64, w: f64;
      let j: i32, n: i32;
      if (iy > 0x41E00000) {
        if (iy > 0x43F00000) {
          if (ix <= 0x3FEFFFFF) return hy < 0 ? huge * huge : tiny * tiny;
          if (ix >= 0x3FF00000) return hy > 0 ? huge * huge : tiny * tiny;
        }
        if (ix < 0x3FEFFFFF) return hy < 0 ? s * huge * huge : s * tiny * tiny;
        if (ix > 0x3FF00000) return hy > 0 ? s * huge * huge : s * tiny * tiny;
        t = ax - 1.0;
        w = (t * t) * (0.5 - t * (inv3 - t * 0.25));
        u = ivln2_h * t;
        v = t * ivln2_l - w * ivln2;
        t1 = u + v;
        t1 = reinterpret<f64>(reinterpret<u64>(t1) & 0xFFFFFFFF00000000);
        t2 = v - (t1 - u);
      } else {
        let ss: f64, s2: f64, s_h: f64, s_l: f64, t_h: f64, t_l: f64;
        n = 0;
        if (ix < 0x00100000) {
          ax *= two53;
          n -= 53;
          ix = <u32>(reinterpret<u64>(ax) >> 32);
        }
        n += (ix >> 20) - 0x3FF;
        j = ix & 0x000FFFFF;
        ix = j | 0x3FF00000;
        if (j <= 0x3988E) k = 0;
        else if (j < 0xBB67A) k = 1;
        else {
          k = 0;
          n += 1;
          ix -= 0x00100000;
        }
        ax = reinterpret<f64>(reinterpret<u64>(ax) & 0xFFFFFFFF | (<u64>ix << 32));
        let bp = select<f64>(1.5, 1.0, k); // k ? 1.5 : 1.0
        u = ax - bp;
        v = 1.0 / (ax + bp);
        ss = u * v;
        s_h = ss;
        s_h = reinterpret<f64>(reinterpret<u64>(s_h) & 0xFFFFFFFF00000000);
        t_h = reinterpret<f64>(u64(((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18)) << 32);
        t_l = ax - (t_h - bp);
        s_l = v * ((u - s_h * t_h) - s_h * t_l);
        s2 = ss * ss;
        r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
        r += s_l * (s_h + ss);
        s2 = s_h * s_h;
        t_h = 3.0 + s2 + r;
        t_h = reinterpret<f64>(reinterpret<u64>(t_h) & 0xFFFFFFFF00000000);
        t_l = r - ((t_h - 3.0) - s2);
        u = s_h * t_h;
        v = s_l * t_h + t_l * ss;
        p_h = u + v;
        p_h = reinterpret<f64>(reinterpret<u64>(p_h) & 0xFFFFFFFF00000000);
        p_l = v - (p_h - u);
        let z_h = cp_h * p_h;
        let dp_l = select<f64>(dp_l1, 0.0, k);
        let z_l = cp_l * p_h + p_l * cp + dp_l;
        t = <f64>n;
        let dp_h = select<f64>(dp_h1, 0.0, k);
        t1 = ((z_h + z_l) + dp_h) + t;
        t1 = reinterpret<f64>(reinterpret<u64>(t1) & 0xFFFFFFFF00000000);
        t2 = z_l - (((t1 - t) - dp_h) - z_h);
      }
      let y1 = y;
      y1 = reinterpret<f64>(reinterpret<u64>(y1) & 0xFFFFFFFF00000000);
      p_l = (y - y1) * t1 + y * t2;
      p_h = y1 * t1;
      z = p_l + p_h;
      u_ = reinterpret<u64>(z);
      j = u32(u_ >> 32);
      let i = <i32>u_;
      if (j >= 0x40900000) {
        if (((j - 0x40900000) | i) != 0) return s * huge * huge;
        if (p_l + ovt > z - p_h) return s * huge * huge;
      } else if ((j & 0x7FFFFFFF) >= 0x4090CC00) {
        if (((j - 0xC090CC00) | i) != 0) return s * tiny * tiny;
        if (p_l <= z - p_h) return s * tiny * tiny;
      }
      i = j & 0x7FFFFFFF;
      k = (i >> 20) - 0x3FF;
      n = 0;
      if (i > 0x3FE00000) {
        n = j + (0x00100000 >> (k + 1));
        k = ((n & 0x7FFFFFFF) >> 20) - 0x3FF;
        t = 0.0;
        t = reinterpret<f64>(u64(n & ~(0x000FFFFF >> k)) << 32);
        n = ((n & 0x000FFFFF) | 0x00100000) >> (20 - k);
        if (j < 0) n = -n;
        p_h -= t;
      }
      t = p_l + p_h;
      t = reinterpret<f64>(reinterpret<u64>(t) & 0xFFFFFFFF00000000);
      u = t * lg2_h;
      v = (p_l - (t - p_h)) * lg2 + t * lg2_l;
      z = u + v;
      w = v - (z - u);
      t = z * z;
      t1 = z - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
      r = (z * t1) / (t1 - 2.0) - (w + z * w);
      z = 1.0 - (r - z);
      j = u32(reinterpret<u64>(z) >> 32);
      j += n << 20;
      if ((j >> 20) <= 0) z = scalbn(z, n);
      else z = reinterpret<f64>(reinterpret<u64>(z) & 0xFFFFFFFF | (<u64>j << 32));
      return s * z;
    }
  }

  export function seedRandom(value: i64): void {
    // Instead zero seed use golden ratio:
    // phi = (1 + sqrt(5)) / 2
    // trunc(2^64 / phi) = 0x9e3779b97f4a7c15
    if (value == 0) value = 0x9e3779b97f4a7c15;
    random_state0_64 = murmurHash3(value);
    random_state1_64 = murmurHash3(~random_state0_64);
    random_state0_32 = splitMix32(<u32>value);
    random_state1_32 = splitMix32(random_state0_32);
    random_seeded = true;
  }

  export function random(): f64 { // see: v8/src/base/utils/random-number-generator.cc
    if (!random_seeded) seedRandom(reinterpret<i64>(seed()));
    let s1 = random_state0_64;
    let s0 = random_state1_64;
    random_state0_64 = s0;
    s1 ^= s1 << 23;
    s1 ^= s1 >> 17;
    s1 ^= s0;
    s1 ^= s0 >> 26;
    random_state1_64 = s1;
    let r = (s0 >> 12) | 0x3FF0000000000000;
    return reinterpret<f64>(r) - 1;
  }

  export function round(x: f64): f64 {
    if (ASC_SHRINK_LEVEL > 0) {
      return builtin_ceil<f64>(x) - f64(builtin_ceil<f64>(x) - 0.5 > x);
    } else {
      let roundUp = builtin_ceil<f64>(x);
      return select<f64>(roundUp, roundUp - 1.0, roundUp - 0.5 <= x);
    }
  }

  export function sign(x: f64): f64 {
    if (ASC_SHRINK_LEVEL > 0) {
      return select<f64>(builtin_copysign<f64>(1, x), x, builtin_abs(x) > 0);
    } else {
      return select<f64>(1, select<f64>(-1, x, x < 0), x > 0);
    }
  }

  // @ts-ignore: decorator
  @inline
  export function signbit(x: f64): bool {
    return bool(reinterpret<u64>(x) >>> 63);
  }

  export function sin(x: f64): f64 { // see: musl/src/math/sin.c
    let u  = reinterpret<u64>(x);
    let ux = u32(u >> 32);
    let sign = ux >> 31;

    ux &= 0x7FFFFFFF;

    // |x| ~< pi/4
    if (ux <= 0x3FE921FB) {
      if (ux < 0x3E500000) { // |x| < 2**-26
        return x;
      }
      return sin_kern(x, 0.0, 0);
    }

    // sin(Inf or NaN) is NaN
    if (ux >= 0x7FF00000) return x - x;

    // argument reduction needed
    let n  = rempio2(x, u, sign);
    let y0 = rempio2_y0;
    let y1 = rempio2_y1;

    x = n & 1 ? cos_kern(y0, y1) : sin_kern(y0, y1, 1);
    return n & 2 ? -x : x;
  }

  export function sinh(x: f64): f64 { // see: musl/src/math/sinh.c
    let u = reinterpret<u64>(x) & 0x7FFFFFFFFFFFFFFF;
    let a = reinterpret<f64>(u);
    let w = u32(u >> 32);
    let h = builtin_copysign(0.5, x);
    if (w < 0x40862E42) {
      let t = expm1(a);
      if (w < 0x3FF00000) {
        if (w < 0x3FF00000 - (26 << 20)) return x;
        return h * (2 * t - t * t / (t + 1));
      }
      return h * (t + t / (t + 1));
    }
    return expo2(a, 2 * h);
  }

  // @ts-ignore: decorator
  @inline
  export function sqrt(x: f64): f64 {
    return builtin_sqrt<f64>(x);
  }

  export function tan(x: f64): f64 { // see: musl/src/math/tan.c
    let u = reinterpret<u64>(x);
    let ux = u32(u >> 32);
    let sign = ux >>> 31;

    ux &= 0x7FFFFFFF;

    // |x| ~< pi/4
    if (ux <= 0x3FE921FB) {
      if (ux < 0x3E400000) { // |x| < 2**-27
        return x;
      }
      return tan_kern(x, 0.0, 1);
    }

    // tan(Inf or NaN) is NaN
    if (ux >= 0x7FF00000) return x - x;

    let n = rempio2(x, u, sign);
    return tan_kern(rempio2_y0, rempio2_y1, 1 - ((n & 1) << 1));
  }

  export function tanh(x: f64): f64 { // see: musl/src/math/tanh.c
    let u = reinterpret<u64>(x);
    u &= 0x7FFFFFFFFFFFFFFF;
    let y = reinterpret<f64>(u);
    let w = u32(u >> 32);
    let t: f64;
    if (w > 0x3FE193EA) {
      if (w > 0x40340000) {
        t = 1 - 0 / y;
      } else {
        t = expm1(2 * y);
        t = 1 - 2 / (t + 2);
      }
    } else if (w > 0x3FD058AE) {
      t = expm1(2 * y);
      t = t / (t + 2);
    } else if (w >= 0x00100000) {
      t = expm1(-2 * y);
      t = -t / (t + 2);
    } else t = y;
    return builtin_copysign<f64>(t, x);
  }

  // @ts-ignore: decorator
  @inline
  export function trunc(x: f64): f64 {
    return builtin_trunc<f64>(x);
  }

  export function scalbn(x: f64, n: i32): f64 { // see: https://git.musl-libc.org/cgit/musl/tree/src/math/scalbn.c
    const
      Ox1p53    = reinterpret<f64>(0x4340000000000000),
      Ox1p1023  = reinterpret<f64>(0x7FE0000000000000),
      Ox1p_1022 = reinterpret<f64>(0x0010000000000000);

    let y = x;
    if (n > 1023) {
      y *= Ox1p1023;
      n -= 1023;
      if (n > 1023) {
        y *= Ox1p1023;
        n = builtin_min<i32>(n - 1023, 1023);
      }
    } else if (n < -1022) {
      // make sure final n < -53 to avoid double
      // rounding in the subnormal range
      y *= Ox1p_1022 * Ox1p53;
      n += 1022 - 53;
      if (n < -1022) {
        y *= Ox1p_1022 * Ox1p53;
        n = builtin_max<i32>(n + 1022 - 53, -1022);
      }
    }
    return y * reinterpret<f64>(<u64>(0x3FF + n) << 52);
  }

  export function mod(x: f64, y: f64): f64 { // see: musl/src/math/fmod.c
    if (builtin_abs<f64>(y) == 1.0) {
      // x % 1, x % -1  ==>  sign(x) * abs(x - 1.0 * trunc(x / 1.0))
      // TODO: move this rule to compiler's optimization pass.
      // It could be apply for any x % C_pot, where "C_pot" is pow of two const.
      return builtin_copysign<f64>(x - builtin_trunc<f64>(x), x);
    }
    let ux = reinterpret<u64>(x);
    let uy = reinterpret<u64>(y);
    let ex = i64(ux >> 52 & 0x7FF);
    let ey = i64(uy >> 52 & 0x7FF);
    let sx = ux >> 63;
    let uy1 = uy << 1;
    if (uy1 == 0 || ex == 0x7FF || isNaN<f64>(y)) {
      let m = x * y;
      return m / m;
    }
    let ux1 = ux << 1;
    if (ux1 <= uy1) {
      return x * f64(ux1 != uy1);
    }
    if (!ex) {
      ex -= builtin_clz<i64>(ux << 12);
      ux <<= 1 - ex;
    } else {
      ux &= u64(-1) >> 12;
      ux |= 1 << 52;
    }
    if (!ey) {
      ey -= builtin_clz<i64>(uy << 12);
      uy <<= 1 - ey;
    } else {
      uy &= u64(-1) >> 12;
      uy |= 1 << 52;
    }
    while (ex > ey) {
      if (ux >= uy) {
        if (ux == uy) return 0 * x;
        ux -= uy;
      }
      ux <<= 1;
      --ex;
    }
    if (ux >= uy) {
      if (ux == uy) return 0 * x;
      ux -= uy;
    }
    // for (; !(ux >> 52); ux <<= 1) --ex;
    let shift = builtin_clz<i64>(ux << 11);
    ex -= shift;
    ux <<= shift;
    if (ex > 0) {
      ux -= 1 << 52;
      ux |= ex << 52;
    } else {
      ux >>= -ex + 1;
    }
    return reinterpret<f64>(ux | (sx << 63));
  }

  export function rem(x: f64, y: f64): f64 { // see: musl/src/math/remquo.c
    let ux = reinterpret<u64>(x);
    let uy = reinterpret<u64>(y);
    let ex = i64(ux >> 52 & 0x7FF);
    let ey = i64(uy >> 52 & 0x7FF);
    if (uy << 1 == 0 || ex == 0x7FF || isNaN(y)) {
      let m = x * y;
      return m / m;
    }
    if (ux << 1 == 0) return x;
    let uxi = ux;
    if (!ex) {
      ex -= builtin_clz<i64>(uxi << 12);
      uxi <<= 1 - ex;
    } else {
      uxi &= u64(-1) >> 12;
      uxi |= 1 << 52;
    }
    if (!ey) {
      ey -= builtin_clz<i64>(uy << 12);
      uy <<= 1 - ey;
    } else {
      uy &= u64(-1) >> 12;
      uy |= 1 << 52;
    }
    let q: u32 = 0;
    do {
      if (ex < ey) {
        if (ex + 1 == ey) break; // goto end
        return x;
      }
      while (ex > ey) {
        if (uxi >= uy) {
          uxi -= uy;
          ++q;
        }
        uxi <<= 1;
        q <<= 1;
        --ex;
      }
      if (uxi >= uy) {
        uxi -= uy;
        ++q;
      }
      if (uxi == 0) ex = -60;
      else {
        let shift = builtin_clz<i64>(uxi << 11);
        ex -= shift;
        uxi <<= shift;
      }
      break;
    } while (false);
    // end:
    if (ex > 0) {
      uxi -= 1 << 52;
      uxi |= ex << 52;
    } else {
      uxi >>= -ex + 1;
    }
    x = reinterpret<f64>(uxi);
    y = builtin_abs<f64>(y);
    let x2 = x + x;
    if (ex == ey || (ex + 1 == ey && (x2 > y || (x2 == y && <bool>(q & 1))))) {
      x -= y;
      // ++q;
    }
    return <i64>ux < 0 ? -x : x;
  }

  export function sincos(x: f64): void { // see: musl/tree/src/math/sincos.c
    let u = reinterpret<u64>(x);
    let ux = u32(u >> 32);
    let sign = ux >> 31;
    ux &= 0x7FFFFFFF;

    if (ux <= 0x3FE921FB) {  // |x| ~<= \u03C0/4
      if (ux < 0x3E46A09E) { // if |x| < 2**-27 * sqrt(2)
        sincos_sin = x;
        sincos_cos = 1;
        return;
      }
      sincos_sin = sin_kern(x, 0, 0);
      sincos_cos = cos_kern(x, 0);
      return;
    }
    // sin(Inf or NaN) is NaN
    if (ux >= 0x7F800000) {
      let xx = x - x;
      sincos_sin = xx;
      sincos_cos = xx;
      return;
    }
    // general argument reduction needed
    let n = rempio2(x, u, sign);
    let y0 = rempio2_y0;
    let y1 = rempio2_y1;
    let s = sin_kern(y0, y1, 1);
    let c = cos_kern(y0, y1);
    let sin = s, cos = c;
    if (n & 1) {
      sin =  c;
      cos = -s;
    }
    if (n & 2) {
      sin = -sin;
      cos = -cos;
    }
    sincos_sin = sin;
    sincos_cos = cos;
  }
}

// @ts-ignore: decorator
@lazy let rempio2f_y: f64;

// @ts-ignore: decorator
@lazy @inline const PIO2F_TABLE = memory.data<u64>([
  0xA2F9836E4E441529,
  0xFC2757D1F534DDC0,
  0xDB6295993C439041,
  0xFE5163ABDEBBC561
]);

function Rf(z: f32): f32 { // Rational approximation of (asin(x)-x)/x^3
  const                    // see: musl/src/math/asinf.c and SUN COPYRIGHT NOTICE above
    pS0 = reinterpret<f32>(0x3E2AAA75), //  1.6666586697e-01f
    pS1 = reinterpret<f32>(0xBD2F13BA), // -4.2743422091e-02f
    pS2 = reinterpret<f32>(0xBC0DD36B), // -8.6563630030e-03f
    qS1 = reinterpret<f32>(0xBF34E5AE); // -7.0662963390e-01f

  let p = z * (pS0 + z * (pS1 + z * pS2));
  let q: f32 = 1 + z * qS1;
  return p / q;
}

// @ts-ignore: decorator
@inline
function expo2f(x: f32, sign: f32): f32 { // exp(x)/2 for x >= log(DBL_MAX)
  const                                // see: musl/src/math/__expo2f.c
    k    = <u32>235,
    kln2 = reinterpret<f32>(0x4322E3BC); // 0x1.45c778p+7f
  let scale = reinterpret<f32>(u32(0x7F + (k >> 1)) << 23);
  // in directed rounding correct sign before rounding or overflow is important
  return NativeMathf.exp(x - kln2) * (sign * scale) * scale;
}

// @ts-ignore: decorator
@inline
function pio2f_large_quot(x: f32, u: i32): i32 { // see: jdh8/metallic/blob/master/src/math/float/rem_pio2f.c
  const coeff = reinterpret<f64>(0x3BF921FB54442D18); // \u03C0 * 0x1p-65 = 8.51530395021638647334e-20

  let offset = (u >> 23) - 152;
  let shift  = u64(offset & 63);
  let tblPtr = PIO2F_TABLE + (offset >> 6 << 3);

  let b0 = load<u64>(tblPtr, 0 << 3);
  let b1 = load<u64>(tblPtr, 1 << 3);
  let lo: u64;

  if (shift > 32) {
    let b2 = load<u64>(tblPtr, 2 << 3);
    lo  = b2 >> (96 - shift);
    lo |= b1 << (shift - 32);
  } else {
    lo = b1 >> (32 - shift);
  }

  let hi = (b1 >> (64 - shift)) | (b0 << shift);
  let mantissa: u64 = (u & 0x007FFFFF) | 0x00800000;
  let product = mantissa * hi + (mantissa * lo >> 32);
  let r: i64 = product << 2;
  let q = i32((product >> 62) + (r >>> 63));
  rempio2f_y = copysign<f64>(coeff, x) * <f64>r;
  return q;
}

// @ts-ignore: decorator
@inline
function rempio2f(x: f32, u: u32, sign: i32): i32 { // see: jdh8/metallic/blob/master/src/math/float/rem_pio2f.c
  const
    pi2hi = reinterpret<f64>(0x3FF921FB50000000), // 1.57079631090164184570
    pi2lo = reinterpret<f64>(0x3E5110B4611A6263), // 1.58932547735281966916e-8
    _2_pi = reinterpret<f64>(0x3FE45F306DC9C883); // 0.63661977236758134308

  if (u < 0x4DC90FDB) { // \u03C0 * 0x1p28
    let q = nearest(x * _2_pi);
    rempio2f_y = x - q * pi2hi - q * pi2lo;
    return <i32>q;
  }

  let q = pio2f_large_quot(x, u);
  return select(-q, q, sign);
}

// |sin(x)/x - s(x)| < 2**-37.5 (~[-4.89e-12, 4.824e-12]).
// @ts-ignore: decorator
@inline
function sin_kernf(x: f64): f32 { // see: musl/tree/src/math/__sindf.c
  const
    S1 = reinterpret<f64>(0xBFC5555554CBAC77), // -0x15555554cbac77.0p-55
    S2 = reinterpret<f64>(0x3F811110896EFBB2), //  0x111110896efbb2.0p-59
    S3 = reinterpret<f64>(0xBF2A00F9E2CAE774), // -0x1a00f9e2cae774.0p-65
    S4 = reinterpret<f64>(0x3EC6CD878C3B46A7); //  0x16cd878c3b46a7.0p-71

  let z = x * x;
  let w = z * z;
  let r = S3 + z * S4;
  let s = z * x;
  return f32((x + s * (S1 + z * S2)) + s * w * r);
}

// |cos(x) - c(x)| < 2**-34.1 (~[-5.37e-11, 5.295e-11]).
// @ts-ignore: decorator
@inline
function cos_kernf(x: f64): f32 { // see: musl/tree/src/math/__cosdf.c
  const
    C0 = reinterpret<f64>(0xBFDFFFFFFD0C5E81), // -0x1ffffffd0c5e81.0p-54
    C1 = reinterpret<f64>(0x3FA55553E1053A42), //  0x155553e1053a42.0p-57
    C2 = reinterpret<f64>(0xBF56C087E80F1E27), // -0x16c087e80f1e27.0p-62
    C3 = reinterpret<f64>(0x3EF99342E0EE5069); //  0x199342e0ee5069.0p-68

  let z = x * x;
  let w = z * z;
  let r = C2 + z * C3;
  return f32(((1 + z * C0) + w * C1) + (w * z) * r);
}

// |tan(x)/x - t(x)| < 2**-25.5 (~[-2e-08, 2e-08]).
// @ts-ignore: decorator
@inline
function tan_kernf(x: f64, odd: i32): f32 { // see: musl/tree/src/math/__tandf.c
  const
    T0 = reinterpret<f64>(0x3FD5554D3418C99F), // 0x15554d3418c99f.0p-54
    T1 = reinterpret<f64>(0x3FC112FD38999F72), // 0x1112fd38999f72.0p-55
    T2 = reinterpret<f64>(0x3FAB54C91D865AFE), // 0x1b54c91d865afe.0p-57
    T3 = reinterpret<f64>(0x3F991DF3908C33CE), // 0x191df3908c33ce.0p-58
    T4 = reinterpret<f64>(0x3F685DADFCECF44E), // 0x185dadfcecf44e.0p-61
    T5 = reinterpret<f64>(0x3F8362B9BF971BCD); // 0x1362b9bf971bcd.0p-59

  let z = x * x;
  let r = T4 + z * T5;
  let t = T2 + z * T3;
  let w = z * z;
  let s = z * x;
  let u = T0 + z * T1;

  r = (x + s * u) + (s * w) * (t + w * r);
  return f32(odd ? -1 / r : r);
}

// See: jdh8/metallic/src/math/float/log2f.c and jdh8/metallic/src/math/float/kernel/atanh.h
// @ts-ignore: decorator
@inline
function log2f(x: f64): f64 {
  const
    log2e = reinterpret<f64>(0x3FF71547652B82FE), // 1.44269504088896340736
    c0 = reinterpret<f64>(0x3FD555554FD9CAEF),    // 0.33333332822728226129
    c1 = reinterpret<f64>(0x3FC999A7A8AF4132),    // 0.20000167595436263505
    c2 = reinterpret<f64>(0x3FC2438D79437030),    // 0.14268654271188685375
    c3 = reinterpret<f64>(0x3FBE2F663B001C97);    // 0.11791075649681414150

  let i = reinterpret<i64>(x);
  let exponent = (i - 0x3FE6A09E667F3BCD) >> 52;
  x = reinterpret<f64>(i - (exponent << 52));
  x = (x - 1) / (x + 1);
  let xx = x * x;
  let y = x + x * xx * (c0 + c1 * xx + (c2 + c3 * xx) * (xx * xx));
  return (2 * log2e) * y + <f64>exponent;
}

// See: jdh8/metallic/src/math/float/exp2f.h and jdh8/metallic/blob/master/src/math/float/kernel/exp2f.h
// @ts-ignore: decorator
@inline
function exp2f(x: f64): f64 {
  const
    c0 = reinterpret<f64>(0x3FE62E4302FCC24A), // 6.931471880289532425e-1
    c1 = reinterpret<f64>(0x3FCEBFBE07D97B91), // 2.402265108421173406e-1
    c2 = reinterpret<f64>(0x3FAC6AF6CCFC1A65), // 5.550357105498874537e-2
    c3 = reinterpret<f64>(0x3F83B29E3CE9AEF6), // 9.618030771171497658e-3
    c4 = reinterpret<f64>(0x3F55F0896145A89F), // 1.339086685300950937e-3
    c5 = reinterpret<f64>(0x3F2446C81E384864); // 1.546973499989028719e-4

  if (x < -1022) return 0;
  if (x >= 1024) return Infinity;

  let n = nearest(x);
  x -= n;
  let xx = x * x;
  let y = 1 + x * (c0 + c1 * x + (c2 + c3 * x) * xx + (c4 + c5 * x) * (xx * xx));
  return reinterpret<f64>(reinterpret<i64>(y) + (<i64>n << 52));
}

export namespace NativeMathf {

  // @ts-ignore: decorator
  @lazy
  export const E       = <f32>NativeMath.E;

  // @ts-ignore: decorator
  @lazy
  export const LN2     = <f32>NativeMath.LN2;

  // @ts-ignore: decorator
  @lazy
  export const LN10    = <f32>NativeMath.LN10;

  // @ts-ignore: decorator
  @lazy
  export const LOG2E   = <f32>NativeMath.LOG2E;

  // @ts-ignore: decorator
  @lazy
  export const LOG10E  = <f32>NativeMath.LOG10E;

  // @ts-ignore: decorator
  @lazy
  export const PI      = <f32>NativeMath.PI;

  // @ts-ignore: decorator
  @lazy
  export const SQRT1_2 = <f32>NativeMath.SQRT1_2;

  // @ts-ignore: decorator
  @lazy
  export const SQRT2   = <f32>NativeMath.SQRT2;

  // @ts-ignore: decorator
  @lazy
  export let sincos_sin: f32 = 0;

  // @ts-ignore: decorator
  @lazy
  export let sincos_cos: f32 = 0;

  // @ts-ignore: decorator
  @inline
  export function abs(x: f32): f32 {
    return builtin_abs<f32>(x);
  }

  export function acos(x: f32): f32 { // see: musl/src/math/acosf.c and SUN COPYRIGHT NOTICE above
    const
      pio2_hi   = reinterpret<f32>(0x3FC90FDA), // 1.5707962513e+00f
      pio2_lo   = reinterpret<f32>(0x33A22168), // 7.5497894159e-08f
      Ox1p_120f = reinterpret<f32>(0x03800000); // 0x1p-120f

    let hx = reinterpret<u32>(x);
    let ix = hx & 0x7FFFFFFF;
    if (ix >= 0x3F800000) {
      if (ix == 0x3F800000) {
        return select<f32>(2 * pio2_hi + Ox1p_120f, 0, <i32>hx < 0);
      }
      return 0 / (x - x);
    }
    if (ix < 0x3F000000) {
      if (ix <= 0x32800000) return pio2_hi + Ox1p_120f;
      return pio2_hi - (x - (pio2_lo - x * Rf(x * x)));
    }
    let z: f32, w: f32, s: f32;
    if (<i32>hx < 0) {
      // z = (1 + x) * 0.5;
      z = 0.5 + x * 0.5;
      s = builtin_sqrt<f32>(z);
      w = Rf(z) * s - pio2_lo;
      return 2 * (pio2_hi - (s + w));
    }
    // z = (1 - x) * 0.5;
    z = 0.5 - x * 0.5;
    s = builtin_sqrt<f32>(z);
    hx = reinterpret<u32>(s);
    let df = reinterpret<f32>(hx & 0xFFFFF000);
    let c = (z - df * df) / (s + df);
    w = Rf(z) * s + c;
    return 2 * (df + w);
  }

  export function acosh(x: f32): f32 { // see: musl/src/math/acoshf.c
    const s = reinterpret<f32>(0x3F317218); // 0.693147180559945309417232121458176568f
    let u = reinterpret<u32>(x);
    let a = u & 0x7FFFFFFF;
    if (a < 0x3F800000 + (1 << 23)) { // |x| < 2, invalid if x < 1
      let xm1 = x - 1;
      return log1p(xm1 + builtin_sqrt(xm1 * (xm1 + 2)));
    }
    if (u < 0x3F800000 + (12 << 23)) { // 2 <= x < 0x1p12
      return log(2 * x - 1 / (x + builtin_sqrt<f32>(x * x - 1)));
    }
    // x >= 0x1p12 or x <= -2 or NaN
    return log(x) + s;
  }

  export function asin(x: f32): f32 { // see: musl/src/math/asinf.c and SUN COPYRIGHT NOTICE above
    const
      pio2      = reinterpret<f32>(0x3FC90FDB), // 1.570796326794896558e+00f
      Ox1p_120f = reinterpret<f32>(0x03800000); // 0x1p-120f

    let sx = x;
    let hx = reinterpret<u32>(x) & 0x7FFFFFFF;
    if (hx >= 0x3F800000) {
      if (hx == 0x3F800000) return x * pio2 + Ox1p_120f;
      return 0 / (x - x);
    }
    if (hx < 0x3F000000) {
      if (hx < 0x39800000 && hx >= 0x00800000) return x;
      return x + x * Rf(x * x);
    }
    // let z: f32 = (1 - builtin_abs<f32>(x)) * 0.5;
    let z: f32 = 0.5 - builtin_abs<f32>(x) * 0.5;
    let s = builtin_sqrt<f64>(z); // sic
    x = f32(pio2 - 2 * (s + s * Rf(z)));
    return builtin_copysign(x, sx);
  }

  export function asinh(x: f32): f32 { // see: musl/src/math/asinhf.c
    const c = reinterpret<f32>(0x3F317218); // 0.693147180559945309417232121458176568f
    let u = reinterpret<u32>(x) & 0x7FFFFFFF;
    let y = reinterpret<f32>(u);
    if (u >= 0x3F800000 + (12 << 23)) y = log(y) + c;
    else if (u >= 0x3F800000 + (1 << 23))  y =   log(2 * y + 1 / (builtin_sqrt<f32>(y * y + 1) + y));
    else if (u >= 0x3F800000 - (12 << 23)) y = log1p(y + y * y / (builtin_sqrt<f32>(y * y + 1) + 1));
    return builtin_copysign(y, x);
  }

  export function atan(x: f32): f32 { // see: musl/src/math/atanf.c and SUN COPYRIGHT NOTICE above
    const
      atanhi0   = reinterpret<f32>(0x3EED6338), //  4.6364760399e-01f
      atanhi1   = reinterpret<f32>(0x3F490FDA), //  7.8539812565e-01f
      atanhi2   = reinterpret<f32>(0x3F7B985E), //  9.8279368877e-01f
      atanhi3   = reinterpret<f32>(0x3FC90FDA), //  1.5707962513e+00f
      atanlo0   = reinterpret<f32>(0x31AC3769), //  5.0121582440e-09f
      atanlo1   = reinterpret<f32>(0x33222168), //  3.7748947079e-08f
      atanlo2   = reinterpret<f32>(0x33140FB4), //  3.4473217170e-08f
      atanlo3   = reinterpret<f32>(0x33A22168), //  7.5497894159e-08f
      aT0       = reinterpret<f32>(0x3EAAAAA9), //  3.3333328366e-01f
      aT1       = reinterpret<f32>(0xBE4CCA98), // -1.9999158382e-01f
      aT2       = reinterpret<f32>(0x3E11F50D), //  1.4253635705e-01f
      aT3       = reinterpret<f32>(0xBDDA1247), // -1.0648017377e-01f
      aT4       = reinterpret<f32>(0x3D7CAC25), //  6.1687607318e-02f
      Ox1p_120f = reinterpret<f32>(0x03800000); //  0x1p-120f

    let ix = reinterpret<u32>(x);
    let sx = x;
    ix &= 0x7FFFFFFF;
    let z: f32;
    if (ix >= 0x4C800000) {
      if (isNaN(x)) return x;
      z = atanhi3 + Ox1p_120f;
      return builtin_copysign(z, sx);
    }
    let id: i32;
    if (ix < 0x3EE00000) {
      if (ix < 0x39800000) return x;
      id = -1;
    } else {
      x = builtin_abs<f32>(x);
      if (ix < 0x3F980000) {
        if (ix < 0x3F300000) {
          id = 0;
          x = (2.0 * x - 1.0) / (2.0 + x);
        } else {
          id = 1;
          x = (x - 1.0) / (x + 1.0);
        }
      } else {
        if (ix < 0x401C0000) {
          id = 2;
          x = (x - 1.5) / (1.0 + 1.5 * x);
        } else {
          id = 3;
          x = -1.0 / x;
        }
      }
    }
    z = x * x;
    let w = z * z;
    let s1 = z * (aT0 + w * (aT2 + w * aT4));
    let s2 = w * (aT1 + w * aT3);
    let s3 = x * (s1 + s2);
    if (id < 0) return x - s3;
    switch (id) {
      case 0: { z = atanhi0 - ((s3 - atanlo0) - x); break; }
      case 1: { z = atanhi1 - ((s3 - atanlo1) - x); break; }
      case 2: { z = atanhi2 - ((s3 - atanlo2) - x); break; }
      case 3: { z = atanhi3 - ((s3 - atanlo3) - x); break; }
      default: unreachable();
    }
    return builtin_copysign(z, sx);
  }

  export function atanh(x: f32): f32 { // see: musl/src/math/atanhf.c
    let u = reinterpret<u32>(x);
    let y = builtin_abs(x);
    if (u < 0x3F800000 - (1 << 23)) {
      if (u >= 0x3F800000 - (32 << 23)) y = 0.5 * log1p(2 * y * (1.0 + y / (1 - y)));
    } else y = 0.5 * log1p(2 * (y / (1 - y)));
    return builtin_copysign(y, x);
  }

  export function atan2(y: f32, x: f32): f32 { // see: musl/src/math/atan2f.c and SUN COPYRIGHT NOTICE above
    const
      pi    = reinterpret<f32>(0x40490FDB), //  3.1415927410e+00f
      pi_lo = reinterpret<f32>(0xB3BBBD2E); // -8.7422776573e-08f

    if (isNaN(x) || isNaN(y)) return x + y;
    let ix = reinterpret<u32>(x);
    let iy = reinterpret<u32>(y);
    if (ix == 0x3F800000) return atan(y);
    let m = u32(((iy >> 31) & 1) | ((ix >> 30) & 2));
    ix &= 0x7FFFFFFF;
    iy &= 0x7FFFFFFF;
    if (iy == 0) {
      switch (m) {
        case 0:
        case 1: return  y;
        case 2: return  pi;
        case 3: return -pi;
      }
    }
    if (ix == 0) return m & 1 ? -pi / 2 : pi / 2;
    if (ix == 0x7F800000) {
      if (iy == 0x7F800000) {
        let t: f32 = m & 2 ? 3 * pi / 4 : pi / 4;
        return m & 1 ? -t : t;
      } else {
        let t: f32 = m & 2 ? pi : 0.0;
        return m & 1 ? -t : t;
      }
    }
    if (ix + (26 << 23) < iy || iy == 0x7F800000) return m & 1 ? -pi / 2 : pi / 2;
    let z: f32;
    if ((m & 2) && iy + (26 << 23) < ix) z = 0.0;
    else z = atan(builtin_abs<f32>(y / x));
    switch (m) {
      case 0: return  z;
      case 1: return -z;
      case 2: return pi - (z - pi_lo);
      case 3: return (z - pi_lo) - pi;
    }
    unreachable();
    return 0;
  }

  export function cbrt(x: f32): f32 { // see: musl/src/math/cbrtf.c and SUN COPYRIGHT NOTICE above
    const
      B1      = <u32>709958130,
      B2      = <u32>642849266,
      Ox1p24f = reinterpret<f32>(0x4B800000);

    let u = reinterpret<u32>(x);
    let hx = u & 0x7FFFFFFF;
    if (hx >= 0x7F800000) return x + x;
    if (hx < 0x00800000) {
      if (hx == 0) return x;
      u = reinterpret<u32>(x * Ox1p24f);
      hx = u & 0x7FFFFFFF;
      hx = hx / 3 + B2;
    } else {
      hx = hx / 3 + B1;
    }
    u &= 0x80000000;
    u |= hx;
    let t = <f64>reinterpret<f32>(u);
    let r = t * t * t;
    t = t * (<f64>x + x + r) / (x + r + r);
    r = t * t * t;
    t = t * (<f64>x + x + r) / (x + r + r);
    return <f32>t;
  }

  // @ts-ignore: decorator
  @inline
  export function ceil(x: f32): f32 {
    return builtin_ceil<f32>(x);
  }

  export function clz32(x: f32): f32 {
    if (!isFinite(x)) return 32;
    return <f32>builtin_clz(dtoi32(x));
  }

  export function cos(x: f32): f32 { // see: musl/src/math/cosf.c
    const
      c1pio2 = reinterpret<f64>(0x3FF921FB54442D18), // M_PI_2 * 1
      c2pio2 = reinterpret<f64>(0x400921FB54442D18), // M_PI_2 * 2
      c3pio2 = reinterpret<f64>(0x4012D97C7F3321D2), // M_PI_2 * 3
      c4pio2 = reinterpret<f64>(0x401921FB54442D18); // M_PI_2 * 4

    let ux = reinterpret<u32>(x);
    let sign = ux >> 31;
    ux &= 0x7FFFFFFF;

    if (ux <= 0x3F490FDA) {  // |x| ~<= \u03C0/4
      if (ux < 0x39800000) { // |x| < 2**-12
        // raise inexact if x != 0
        return 1;
      }
      return cos_kernf(x);
    }

    if (ASC_SHRINK_LEVEL < 1) {
      if (ux <= 0x407B53D1) {  // |x| ~<= 5\u03C0/4
        if (ux > 0x4016CBE3) { // |x|  ~> 3\u03C0/4
          return -cos_kernf(sign ? x + c2pio2 : x - c2pio2);
        } else {
          return sign ? sin_kernf(x + c1pio2) : sin_kernf(c1pio2 - x);
        }
      }
      if (ux <= 0x40E231D5) {  // |x| ~<= 9\u03C0/4
        if (ux > 0x40AFEDDF) { // |x|  ~> 7\u03C0/4
          return cos_kernf(sign ? x + c4pio2 : x - c4pio2);
        } else {
          return sign ? sin_kernf(-x - c3pio2) : sin_kernf(x - c3pio2);
        }
      }
    }

    // cos(Inf or NaN) is NaN
    if (ux >= 0x7F800000) return x - x;

    // general argument reduction needed
    let n = rempio2f(x, ux, sign);
    let y = rempio2f_y;

    let t = n & 1 ? sin_kernf(y) : cos_kernf(y);
    return (n + 1) & 2 ? -t : t;
  }

  export function cosh(x: f32): f32 { // see: musl/src/math/coshf.c
    let u = reinterpret<u32>(x);
    u &= 0x7FFFFFFF;
    x = reinterpret<f32>(u);
    if (u < 0x3F317217) {
      if (u < 0x3F800000 - (12 << 23)) return 1;
      let t = expm1(x);
      // return 1 + t * t / (2 * (1 + t));
      return 1 + t * t / (2 + 2 * t);
    }
    if (u < 0x42B17217) {
      let t = exp(x);
      // return 0.5 * (t + 1 / t);
      return 0.5 * t + 0.5 / t;
    }
    return expo2f(x, 1);
  }

  // @ts-ignore: decorator
  @inline
  export function floor(x: f32): f32 {
    return builtin_floor<f32>(x);
  }

  export function exp(x: f32): f32 { // see: musl/src/math/expf.c and SUN COPYRIGHT NOTICE above
    if (ASC_SHRINK_LEVEL < 1) {
      return expf_lut(x);
    } else {
      const
        ln2hi    = reinterpret<f32>(0x3F317200), //  6.9314575195e-1f
        ln2lo    = reinterpret<f32>(0x35BFBE8E), //  1.4286067653e-6f
        invln2   = reinterpret<f32>(0x3FB8AA3B), //  1.4426950216e+0f
        P1       = reinterpret<f32>(0x3E2AAA8F), //  1.6666625440e-1f
        P2       = reinterpret<f32>(0xBB355215), // -2.7667332906e-3f
        Ox1p127f = reinterpret<f32>(0x7F000000); //  0x1p+127f

      let hx = reinterpret<u32>(x);
      let sign = hx >> 31;
      hx &= 0x7FFFFFFF;
      if (hx >= 0x42AEAC50) {
        if (hx > 0x7F800000) return x; // NaN
        if (hx >= 0x42B17218) {
          if (!sign) return x * Ox1p127f;
          else if (hx >= 0x42CFF1B5) return 0;
        }
      }
      let hi: f32, lo: f32;
      let k: i32;
      if (hx > 0x3EB17218) {
        if (hx > 0x3F851592) {
          k = i32(invln2 * x + builtin_copysign<f32>(0.5, x));
        } else {
          k = 1 - (sign << 1);
        }
        hi = x - <f32>k * ln2hi;
        lo = <f32>k * ln2lo;
        x = hi - lo;
      } else if (hx > 0x39000000) {
        k = 0;
        hi = x;
        lo = 0;
      } else {
        return 1 + x;
      }
      let xx = x * x;
      let c = x - xx * (P1 + xx * P2);
      let y: f32 = 1 + (x * c / (2 - c) - lo + hi);
      return k == 0 ? y : scalbn(y, k);
    }
  }

  export function exp2(x: f32): f32 {
    return exp2f_lut(x);
  }

  export function expm1(x: f32): f32 { // see: musl/src/math/expm1f.c and SUN COPYRIGHT NOTICE above
    const
      ln2_hi   = reinterpret<f32>(0x3F317180), //  6.9313812256e-01f
      ln2_lo   = reinterpret<f32>(0x3717F7D1), //  9.0580006145e-06f
      invln2   = reinterpret<f32>(0x3FB8AA3B), //  1.4426950216e+00f
      Q1       = reinterpret<f32>(0xBD088868), // -3.3333212137e-02f
      Q2       = reinterpret<f32>(0x3ACF3010), //  1.5807170421e-03f
      Ox1p127f = reinterpret<f32>(0x7F000000); //  0x1p+127f

    let u = reinterpret<u32>(x);
    let hx = u & 0x7FFFFFFF;
    let sign = u >> 31;
    if (hx >= 0x4195B844) {
      if (hx > 0x7F800000) return x;
      if (sign) return -1;
      if (hx > 0x42B17217) { // x > log(FLT_MAX)
        x *= Ox1p127f;
        return x;
      }
    }
    let c: f32 = 0.0, t: f32, k: i32;
    if (hx > 0x3EB17218) {
      k = select<i32>(
        1 - (sign << 1),
        i32(invln2 * x + builtin_copysign<f32>(0.5, x)),
        hx < 0x3F851592
      );
      t = <f32>k;
      let hi = x - t * ln2_hi;
      let lo = t * ln2_lo;
      x = hi - lo;
      c = (hi - x) - lo;
    } else if (hx < 0x33000000) {
      return x;
    } else k = 0;
    let hfx: f32 = 0.5 * x;
    let hxs: f32 = x * hfx;
    let r1: f32 = 1.0 + hxs * (Q1 + hxs * Q2);
    t  = 3.0 - r1 * hfx;
    let e = hxs * ((r1 - t) / (6.0 - x * t));
    if (k == 0) return x - (x * e - hxs);
    e  = x * (e - c) - c;
    e -= hxs;
    if (k == -1) return 0.5 * (x - e) - 0.5;
    if (k == 1) {
      if (x < -0.25) return -2.0 * (e - (x + 0.5));
      return 1.0 + 2.0 * (x - e);
    }
    u = (0x7F + k) << 23;
    let twopk = reinterpret<f32>(u);
    let y: f32;
    if (k < 0 || k > 56) {
      y = x - e + 1.0;
      if (k == 128) y = y * 2.0 * Ox1p127f;
      else y = y * twopk;
      return y - 1.0;
    }
    u = (0x7F - k) << 23;
    y = reinterpret<f32>(u);
    if (k < 20) y = (1 - y) - e;
    else y = 1 - (e + y);
    return (x + y) * twopk;
  }

  // @ts-ignore: decorator
  @inline
  export function fround(x: f32): f32 {
    return x;
  }

  export function hypot(x: f32, y: f32): f32 { // see: musl/src/math/hypotf.c
    const
      Ox1p90f  = reinterpret<f32>(0x6C800000),
      Ox1p_90f = reinterpret<f32>(0x12800000);

    let ux = reinterpret<u32>(x);
    let uy = reinterpret<u32>(y);
    ux &= 0x7FFFFFFF;
    uy &= 0x7FFFFFFF;
    if (ux < uy) {
      let ut = ux;
      ux = uy;
      uy = ut;
    }
    x = reinterpret<f32>(ux);
    y = reinterpret<f32>(uy);
    if (uy == 0xFF << 23) return y;
    if (ux >= 0xFF << 23 || uy == 0 || ux - uy >= 25 << 23) return x + y;
    let z: f32 = 1;
    if (ux >= (0x7F + 60) << 23) {
      z  = Ox1p90f;
      x *= Ox1p_90f;
      y *= Ox1p_90f;
    } else if (uy < (0x7F - 60) << 23) {
      z  = Ox1p_90f;
      x *= Ox1p90f;
      y *= Ox1p90f;
    }
    return z * builtin_sqrt<f32>(f32(<f64>x * x + <f64>y * y));
  }

  // @ts-ignore: decorator
  @inline
  export function imul(x: f32, y: f32): f32 {
    /*
     * Wasm (MVP) and JS have different approaches for double->int conversions.
     *
     * For emulate JS conversion behavior and avoid trapping from wasm we should modulate by MAX_INT
     * our float-point arguments before actual convertion to integers.
     */
    if (!isFinite(x + y)) return 0;
    return <f32>(dtoi32(x) * dtoi32(y));
  }

  export function log(x: f32): f32 { // see: musl/src/math/logf.c and SUN COPYRIGHT NOTICE above
    if (ASC_SHRINK_LEVEL < 1) {
      return logf_lut(x);
    } else {
      const
        ln2_hi  = reinterpret<f32>(0x3F317180), // 6.9313812256e-01f
        ln2_lo  = reinterpret<f32>(0x3717F7D1), // 9.0580006145e-06f
        Lg1     = reinterpret<f32>(0x3F2AAAAA), // 0xaaaaaa.0p-24f
        Lg2     = reinterpret<f32>(0x3ECCCE13), // 0xccce13.0p-25f
        Lg3     = reinterpret<f32>(0x3E91E9EE), // 0x91e9ee.0p-25f
        Lg4     = reinterpret<f32>(0x3E789E26), // 0xf89e26.0p-26f
        Ox1p25f = reinterpret<f32>(0x4C000000);

      let u = reinterpret<u32>(x);
      let k = 0;
      let sign = u >> 31;
      if (sign || u < 0x00800000) {
        if (u << 1 == 0) return -1 / (x * x);
        if (sign) return (x - x) / 0;
        k -= 25;
        x *= Ox1p25f;
        u = reinterpret<u32>(x);
      } else if (u >= 0x7F800000) {
        return x;
      } else if (u == 0x3F800000) {
        return 0;
      }
      u += 0x3F800000 - 0x3F3504F3;
      k += i32(u >> 23) - 0x7F;
      u = (u & 0x007FFFFF) + 0x3F3504F3;
      x = reinterpret<f32>(u);
      let f = x - 1.0;
      let s = f / (2.0 + f);
      let z = s * s;
      let w = z * z;
      let t1 = w * (Lg2 + w * Lg4);
      let t2 = z * (Lg1 + w * Lg3);
      let r = t2 + t1;
      let hfsq = <f32>0.5 * f * f;
      let dk = <f32>k;
      return s * (hfsq + r) + dk * ln2_lo - hfsq + f + dk * ln2_hi;
    }
  }

  export function log10(x: f32): f32 { // see: musl/src/math/log10f.c and SUN COPYRIGHT NOTICE above
    const
      ivln10hi  = reinterpret<f32>(0x3EDE6000), //  4.3432617188e-01f
      ivln10lo  = reinterpret<f32>(0xB804EAD9), // -3.1689971365e-05f
      log10_2hi = reinterpret<f32>(0x3E9A2080), //  3.0102920532e-01f
      log10_2lo = reinterpret<f32>(0x355427DB), //  7.9034151668e-07f
      Lg1       = reinterpret<f32>(0x3F2AAAAA), //  0xaaaaaa.0p-24f, 0.66666662693f
      Lg2       = reinterpret<f32>(0x3ECCCE13), //  0xccce13.0p-25f, 0.40000972152f
      Lg3       = reinterpret<f32>(0x3E91E9EE), //  0x91e9ee.0p-25f, 0.28498786688f
      Lg4       = reinterpret<f32>(0x3E789E26), //  0xf89e26.0p-26f, 0.24279078841f
      Ox1p25f   = reinterpret<f32>(0x4C000000); //  0x1p25f

    let ux = reinterpret<u32>(x);
    let k = 0;
    let sign = ux >> 31;
    if (sign || ux < 0x00800000) {
      if (ux << 1 == 0) return -1 / (x * x);
      if (sign) return (x - x) / 0.0;
      k -= 25;
      x *= Ox1p25f;
      ux = reinterpret<u32>(x);
    } else if (ux >= 0x7F800000) {
      return x;
    } else if (ux == 0x3F800000) {
      return 0;
    }
    ux += 0x3F800000 - 0x3F3504F3;
    k += i32(ux >> 23) - 0x7F;
    ux = (ux & 0x007FFFFF) + 0x3F3504F3;
    x = reinterpret<f32>(ux);
    let f = x - 1.0;
    let s = f / (2.0 + f);
    let z = s * s;
    let w = z * z;
    let t1 = w * (Lg2 + w * Lg4);
    let t2 = z * (Lg1 + w * Lg3);
    let r = t2 + t1;
    let hfsq: f32 = 0.5 * f * f;
    let hi = f - hfsq;
    ux = reinterpret<u32>(hi);
    ux &= 0xFFFFF000;
    hi = reinterpret<f32>(ux);
    let lo = f - hi - hfsq + s * (hfsq + r);
    let dk = <f32>k;
    return dk * log10_2lo + (lo + hi) * ivln10lo + lo * ivln10hi + hi * ivln10hi + dk * log10_2hi;
  }

  export function log1p(x: f32): f32 { // see: musl/src/math/log1pf.c and SUN COPYRIGHT NOTICE above
    const
      ln2_hi = reinterpret<f32>(0x3F317180), // 6.9313812256e-01
      ln2_lo = reinterpret<f32>(0x3717F7D1), // 9.0580006145e-06
      Lg1    = reinterpret<f32>(0x3F2AAAAA), // 0xaaaaaa.0p-24f, 0.66666662693f
      Lg2    = reinterpret<f32>(0x3ECCCE13), // 0xccce13.0p-25f, 0.40000972152f
      Lg3    = reinterpret<f32>(0x3E91E9EE), // 0x91e9ee.0p-25f, 0.28498786688f
      Lg4    = reinterpret<f32>(0x3E789E26); // 0xf89e26.0p-26f, 0.24279078841f

    let ix = reinterpret<u32>(x);
    let c: f32 = 0;
    let f: f32 = 0;
    let k = 1;
    if (ix < 0x3ED413D0 || bool(ix >> 31)) {
      if (ix >= 0xBF800000) {
        if (x == -1) return x / 0.0;
        return (x - x) / 0.0;
      }
      if (ix << 1 < 0x33800000 << 1) return x;
      if (ix <= 0xBE95F619) {
        k = 0;
        c = 0;
        f = x;
      }
    } else if (ix >= 0x7F800000) return x;
    if (k) {
      let uf: f32 = 1 + x;
      let iu = reinterpret<u32>(uf);
      iu += 0x3F800000 - 0x3F3504F3;
      k = i32(iu >> 23) - 0x7F;
      if (k < 25) {
        c = k >= 2 ? 1 - (uf - x) : x - (uf - 1);
        c /= uf;
      } else c = 0;
      iu = (iu & 0x007FFFFF) + 0x3F3504F3;
      f = reinterpret<f32>(iu) - 1;
    }
    let s = f / (2.0 + f);
    let z = s * s;
    let w = z * z;
    let t1 = w * (Lg2 + w * Lg4);
    let t2 = z * (Lg1 + w * Lg3);
    let r = t2 + t1;
    let hfsq: f32 = 0.5 * f * f;
    let dk = <f32>k;
    return s * (hfsq + r) + (dk * ln2_lo + c) - hfsq + f + dk * ln2_hi;
  }

  export function log2(x: f32): f32 { // see: musl/src/math/log2f.c and SUN COPYRIGHT NOTICE above
    if (ASC_SHRINK_LEVEL < 1) {
      return log2f_lut(x);
    } else {
      const
        ivln2hi = reinterpret<f32>(0x3FB8B000), //  1.4428710938e+00f
        ivln2lo = reinterpret<f32>(0xB9389AD4), // -1.7605285393e-04
        Lg1     = reinterpret<f32>(0x3F2AAAAA), //  0xaaaaaa.0p-24f, 0.66666662693f
        Lg2     = reinterpret<f32>(0x3ECCCE13), //  0xccce13.0p-25f, 0.40000972152f
        Lg3     = reinterpret<f32>(0x3E91E9EE), //  0x91e9ee.0p-25f, 0.28498786688f
        Lg4     = reinterpret<f32>(0x3E789E26), //  0xf89e26.0p-26f, 0.24279078841f
        Ox1p25f = reinterpret<f32>(0x4C000000); //  0x1p25f

      let ux = reinterpret<u32>(x);
      let k = 0;
      let sign = ux >> 31;
      if (sign || ux < 0x00800000) {
        if (ux << 1 == 0) return -1 / (x * x);
        if (sign) return (x - x) / 0.0;
        k -= 25;
        x *= Ox1p25f;
        ux = reinterpret<u32>(x);
      } else if (ux >= 0x7F800000) {
        return x;
      } else if (ux == 0x3F800000) {
        return 0;
      }
      ux += 0x3F800000 - 0x3F3504F3;
      k += i32(ux >> 23) - 0x7F;
      ux = (ux & 0x007FFFFF) + 0x3F3504F3;
      x = reinterpret<f32>(ux);
      let f = x - 1.0;
      let s = f / (2.0 + f);
      let z = s * s;
      let w = z * z;
      let t1 = w * (Lg2 + w * Lg4);
      let t2 = z * (Lg1 + w * Lg3);
      let r = t2 + t1;
      let hfsq: f32 = 0.5 * f * f;
      let hi = f - hfsq;
      let u = reinterpret<u32>(hi);
      u &= 0xFFFFF000;
      hi = reinterpret<f32>(u);
      let lo: f32 = f - hi - hfsq + s * (hfsq + r);
      let dk = <f32>k;
      return (lo + hi) * ivln2lo + lo * ivln2hi + hi * ivln2hi + dk;
    }
  }

  // @ts-ignore: decorator
  @inline
  export function max(value1: f32, value2: f32): f32 {
    return builtin_max<f32>(value1, value2);
  }

  // @ts-ignore: decorator
  @inline
  export function min(value1: f32, value2: f32): f32 {
    return builtin_min<f32>(value1, value2);
  }

  export function pow(x: f32, y: f32): f32 {
    // TODO: remove this fast pathes after introduced own mid-end IR with "stdlib call simplify" transforms
    if (builtin_abs<f32>(y) <= 2) {
      if (y == 2.0) return x * x;
      if (y == 0.5) {
        return select<f32>(
          builtin_abs<f32>(builtin_sqrt<f32>(x)),
          Infinity,
          x != -Infinity
        );
      }
      if (y == -1.0) return 1 / x;
      if (y == 1.0) return x;
      if (y == 0.0) return 1.0;
    }
    if (ASC_SHRINK_LEVEL < 1) {
      // see: musl/src/math/powf.c
      return powf_lut(x, y);
    } else {
      // based on:  jdh8/metallic/src/math/float/powf.c
      if (y == 0) return 1;
      // @ts-ignore: cast
      if (isNaN(x) | isNaN(y)) {
        return NaN;
      }
      let sign: u32 = 0;
      let uy = reinterpret<u32>(y);
      let ux = reinterpret<u32>(x);
      let sx = ux >> 31;
      ux &= 0x7FFFFFFF;
      if (sx && nearest(y) == y) {
        x = -x;
        sx = 0;
        sign = u32(nearest(y * 0.5) != y * 0.5) << 31;
      }
      let m: u32;
      if (ux == 0x3F800000) { // x == 1
        m = sx | u32((uy & 0x7FFFFFFF) == 0x7F800000) ? 0x7FC00000 : 0x3F800000;
      } else if (ux == 0) {
        m = <i32>uy < 0 ? 0x7F800000 : 0;
      } else if (ux == 0x7F800000) {
        m = <i32>uy < 0 ? 0 : 0x7F800000;
      } else if (sx) {
        m = 0x7FC00000;
      } else {
        m = reinterpret<u32>(<f32>exp2f(<f64>y * log2f(x)));
      }
      return reinterpret<f32>(m | sign);
    }
  }

  // @ts-ignore: decorator
  @inline
  export function seedRandom(value: i64): void {
    NativeMath.seedRandom(value);
  }

  // Using xoroshiro64starstar from http://xoshiro.di.unimi.it/xoroshiro64starstar.c
  export function random(): f32 {
    if (!random_seeded) seedRandom(reinterpret<i64>(seed()));

    let s0 = random_state0_32;
    let s1 = random_state1_32;
    let r  = rotl<u32>(s0 * 0x9E3779BB, 5) * 5;

    s1 ^= s0;
    random_state0_32 = rotl<u32>(s0, 26) ^ s1 ^ (s1 << 9);
    random_state1_32 = rotl<u32>(s1, 13);

    return reinterpret<f32>((r >> 9) | (127 << 23)) - 1.0;
  }

  export function round(x: f32): f32 {
    if (ASC_SHRINK_LEVEL > 0) {
      return builtin_ceil<f32>(x) - f32(builtin_ceil<f32>(x) - 0.5 > x);
    } else {
      let roundUp = builtin_ceil<f32>(x);
      return select<f32>(roundUp, roundUp - 1.0, roundUp - 0.5 <= x);
    }
  }

  export function sign(x: f32): f32 {
    if (ASC_SHRINK_LEVEL > 0) {
      return select<f32>(builtin_copysign<f32>(1, x), x, builtin_abs(x) > 0);
    } else {
      return select<f32>(1, select<f32>(-1, x, x < 0), x > 0);
    }
  }

  // @ts-ignore: decorator
  @inline
  export function signbit(x: f32): bool {
    return <bool>(reinterpret<u32>(x) >>> 31);
  }

  export function sin(x: f32): f32 { // see: musl/src/math/sinf.c
    const
      s1pio2 = reinterpret<f64>(0x3FF921FB54442D18), // M_PI_2 * 1
      s2pio2 = reinterpret<f64>(0x400921FB54442D18), // M_PI_2 * 2
      s3pio2 = reinterpret<f64>(0x4012D97C7F3321D2), // M_PI_2 * 3
      s4pio2 = reinterpret<f64>(0x401921FB54442D18); // M_PI_2 * 4

    let ux = reinterpret<u32>(x);
    let sign = ux >> 31;
    ux &= 0x7FFFFFFF;

    if (ux <= 0x3F490FDA) {  // |x| ~<= \u03C0/4
      if (ux < 0x39800000) { // |x| < 2**-12
        return x;
      }
      return sin_kernf(x);
    }

    if (ASC_SHRINK_LEVEL < 1) {
      if (ux <= 0x407B53D1) {   // |x| ~<= 5\u03C0/4
        if (ux <= 0x4016CBE3) { // |x| ~<= 3\u03C0/4
          return sign ? -cos_kernf(x + s1pio2) : cos_kernf(x - s1pio2);
        }
        return sin_kernf(-(sign ? x + s2pio2 : x - s2pio2));
      }

      if (ux <= 0x40E231D5) {   // |x| ~<= 9\u03C0/4
        if (ux <= 0x40AFEDDF) { // |x| ~<= 7\u03C0/4
          return sign ? cos_kernf(x + s3pio2) : -cos_kernf(x - s3pio2);
        }
        return sin_kernf(sign ? x + s4pio2 : x - s4pio2);
      }
    }

    // sin(Inf or NaN) is NaN
    if (ux >= 0x7F800000) return x - x;

    let n = rempio2f(x, ux, sign);
    let y = rempio2f_y;

    let t = n & 1 ? cos_kernf(y) : sin_kernf(y);
    return n & 2 ? -t : t;
  }

  export function sinh(x: f32): f32 { // see: musl/src/math/sinhf.c
    let u = reinterpret<u32>(x) & 0x7FFFFFFF;
    let a = reinterpret<f32>(u);
    let h = builtin_copysign<f32>(0.5, x);
    if (u < 0x42B17217) {
      let t = expm1(a);
      if (u < 0x3F800000) {
        if (u < 0x3F800000 - (12 << 23)) return x;
        return h * (2 * t - t * t / (t + 1));
      }
      return h * (t + t / (t + 1));
    }
    return expo2f(a, 2 * h);
  }

  // @ts-ignore: decorator
  @inline
  export function sqrt(x: f32): f32 {
    return builtin_sqrt<f32>(x);
  }

  export function tan(x: f32): f32 { // see: musl/src/math/tanf.c
    const
      t1pio2 = reinterpret<f64>(0x3FF921FB54442D18), // 1 * M_PI_2
      t2pio2 = reinterpret<f64>(0x400921FB54442D18), // 2 * M_PI_2
      t3pio2 = reinterpret<f64>(0x4012D97C7F3321D2), // 3 * M_PI_2
      t4pio2 = reinterpret<f64>(0x401921FB54442D18); // 4 * M_PI_2

    let ux = reinterpret<u32>(x);
    let sign = ux >> 31;
    ux &= 0x7FFFFFFF;

    if (ux <= 0x3F490FDA) {  // |x| ~<= \u03C0/4
      if (ux < 0x39800000) { // |x| < 2**-12
        return x;
      }
      return tan_kernf(x, 0);
    }

    if (ASC_SHRINK_LEVEL < 1) {
      if (ux <= 0x407B53D1) {   // |x| ~<= 5\u03C0/4
        if (ux <= 0x4016CBE3) { // |x| ~<= 3\u03C0/4
          return tan_kernf((sign ? x + t1pio2 : x - t1pio2), 1);
        } else {
          return tan_kernf((sign ? x + t2pio2 : x - t2pio2), 0);
        }
      }
      if (ux <= 0x40E231D5) {   // |x| ~<= 9\u03C0/4
        if (ux <= 0x40AFEDDF) { // |x| ~<= 7\u03C0/4
          return tan_kernf((sign ? x + t3pio2 : x - t3pio2), 1);
        } else {
          return tan_kernf((sign ? x + t4pio2 : x - t4pio2), 0);
        }
      }
    }

    // tan(Inf or NaN) is NaN
    if (ux >= 0x7F800000) return x - x;

    // argument reduction
    let n = rempio2f(x, ux, sign);
    let y = rempio2f_y;
    return tan_kernf(y, n & 1);
  }

  export function tanh(x: f32): f32 { // see: musl/src/math/tanhf.c
    let u = reinterpret<u32>(x);
    u &= 0x7FFFFFFF;
    let y = reinterpret<f32>(u);
    let t: f32;
    if (u > 0x3F0C9F54) {
      if (u > 0x41200000) t = 1 + 0 / y;
      else {
        t = expm1(2 * y);
        t = 1 - 2 / (t + 2);
      }
    } else if (u > 0x3E82C578) {
      t = expm1(2 * y);
      t = t / (t + 2);
    } else if (u >= 0x00800000) {
      t = expm1(-2 * y);
      t = -t / (t + 2);
    } else t = y;
    return builtin_copysign<f32>(t, x);
  }

  // @ts-ignore: decorator
  @inline
  export function trunc(x: f32): f32 {
    return builtin_trunc<f32>(x);
  }

  export function scalbn(x: f32, n: i32): f32 { // see: https://git.musl-libc.org/cgit/musl/tree/src/math/scalbnf.c
    const
      Ox1p24f   = reinterpret<f32>(0x4B800000),
      Ox1p127f  = reinterpret<f32>(0x7F000000),
      Ox1p_126f = reinterpret<f32>(0x00800000);

    let y = x;
    if (n > 127) {
      y *= Ox1p127f;
      n -= 127;
      if (n > 127) {
        y *= Ox1p127f;
        n = builtin_min<i32>(n - 127, 127);
      }
    } else if (n < -126) {
      y *= Ox1p_126f * Ox1p24f;
      n += 126 - 24;
      if (n < -126) {
        y *= Ox1p_126f * Ox1p24f;
        n = builtin_max<i32>(n + 126 - 24, -126);
      }
    }
    return y * reinterpret<f32>(<u32>(0x7F + n) << 23);
  }

  export function mod(x: f32, y: f32): f32 { // see: musl/src/math/fmodf.c
    if (builtin_abs<f32>(y) == 1.0) {
      // x % 1, x % -1  ==>  sign(x) * abs(x - 1.0 * trunc(x / 1.0))
      // TODO: move this rule to compiler's optimization pass.
      // It could be apply for any x % C_pot, where "C_pot" is pow of two const.
      return builtin_copysign<f32>(x - builtin_trunc<f32>(x), x);
    }
    let ux = reinterpret<u32>(x);
    let uy = reinterpret<u32>(y);
    let ex = i32(ux >> 23 & 0xFF);
    let ey = i32(uy >> 23 & 0xFF);
    let sm = ux & 0x80000000;
    let uy1 = uy << 1;
    if (uy1 == 0 || ex == 0xFF || isNaN<f32>(y)) {
      let m = x * y;
      return m / m;
    }
    let ux1 = ux << 1;
    if (ux1 <= uy1) {
      return x * f32(ux1 != uy1);
    }
    if (!ex) {
      ex -= builtin_clz<u32>(ux << 9);
      ux <<= 1 - ex;
    } else {
      ux &= <u32>-1 >> 9;
      ux |= 1 << 23;
    }
    if (!ey) {
      ey -= builtin_clz<u32>(uy << 9);
      uy <<= 1 - ey;
    } else {
      uy &= u32(-1) >> 9;
      uy |= 1 << 23;
    }
    while (ex > ey) {
      if (ux >= uy) {
        if (ux == uy) return 0 * x;
        ux -= uy;
      }
      ux <<= 1;
      --ex;
    }
    if (ux >= uy) {
      if (ux == uy) return 0 * x;
      ux -= uy;
    }
    // for (; !(ux >> 23); ux <<= 1) --ex;
    let shift = <i32>builtin_clz<u32>(ux << 8);
    ex -= shift;
    ux <<= shift;
    if (ex > 0) {
      ux -= 1 << 23;
      ux |= <u32>ex << 23;
    } else {
      ux >>= -ex + 1;
    }
    return reinterpret<f32>(ux | sm);
  }

  export function rem(x: f32, y: f32): f32 { // see: musl/src/math/remquof.c
    let ux = reinterpret<u32>(x);
    let uy = reinterpret<u32>(y);
    let ex = i32(ux >> 23 & 0xFF);
    let ey = i32(uy >> 23 & 0xFF);
    let uxi = ux;
    if (uy << 1 == 0 || ex == 0xFF || isNaN(y)) return (x * y) / (x * y);
    if (ux << 1 == 0) return x;
    if (!ex) {
      ex -= builtin_clz<u32>(uxi << 9);
      uxi <<= 1 - ex;
    } else {
      uxi &= u32(-1) >> 9;
      uxi |= 1 << 23;
    }
    if (!ey) {
      ey -= builtin_clz<u32>(uy << 9);
      uy <<= 1 - ey;
    } else {
      uy &= u32(-1) >> 9;
      uy |= 1 << 23;
    }
    let q = 0;
    do {
      if (ex < ey) {
        if (ex + 1 == ey) break; // goto end
        return x;
      }
      while (ex > ey) {
        if (uxi >= uy) {
          uxi -= uy;
          ++q;
        }
        uxi <<= 1;
        q <<= 1;
        --ex;
      }
      if (uxi >= uy) {
        uxi -= uy;
        ++q;
      }
      if (uxi == 0) ex = -30;
      else {
        let shift = builtin_clz<i32>(uxi << 8);
        ex -= shift;
        uxi <<= shift;
      }
      break;
    } while (false);
    // end:
    if (ex > 0) {
      uxi -= 1 << 23;
      uxi |= <u32>ex << 23;
    } else {
      uxi >>= -ex + 1;
    }
    x = reinterpret<f32>(uxi);
    y = builtin_abs<f32>(y);
    let x2 = x + x;
    if (ex == ey || (ex + 1 == ey && (<f32>x2 > y || (<f32>x2 == y && bool(q & 1))))) {
      x -= y;
      // q++;
    }
    return <i32>ux < 0 ? -x : x;
  }

  export function sincos(x: f32): void { // see: musl/tree/src/math/sincosf.c
    const
      s1pio2 = reinterpret<f64>(0x3FF921FB54442D18), // 1 * M_PI_2
      s2pio2 = reinterpret<f64>(0x400921FB54442D18), // 2 * M_PI_2
      s3pio2 = reinterpret<f64>(0x4012D97C7F3321D2), // 3 * M_PI_2
      s4pio2 = reinterpret<f64>(0x401921FB54442D18); // 4 * M_PI_2

    let ux = reinterpret<u32>(x);
    let sign = ux >> 31;
    ux &= 0x7FFFFFFF;

    if (ux <= 0x3F490FDA) {  // |x| ~<= \u03C0/4
      if (ux < 0x39800000) { // |x| < 2**-12
        sincos_sin = x;
        sincos_cos = 1;
        return;
      }
      sincos_sin = sin_kernf(x);
      sincos_cos = cos_kernf(x);
      return;
    }
    if (ASC_SHRINK_LEVEL < 1) {
      if (ux <= 0x407B53D1) {   // |x| ~<= 5\u03C0/4
        if (ux <= 0x4016CBE3) { // |x| ~<= 3\u03C0/4
          if (sign) {
            sincos_sin = -cos_kernf(x + s1pio2);
            sincos_cos =  sin_kernf(x + s1pio2);
          } else {
            sincos_sin = cos_kernf(s1pio2 - x);
            sincos_cos = sin_kernf(s1pio2 - x);
          }
          return;
        }
        // -sin(x + c) is not correct if x+c could be 0: -0 vs +0
        sincos_sin = -sin_kernf(sign ? x + s2pio2 : x - s2pio2);
        sincos_cos = -cos_kernf(sign ? x + s2pio2 : x - s2pio2);
        return;
      }
      if (ux <= 0x40E231D5) {   // |x| ~<= 9\u03C0/4
        if (ux <= 0x40AFEDDF) { // |x| ~<= 7\u03C0/4
          if (sign) {
            sincos_sin =  cos_kernf(x + s3pio2);
            sincos_cos = -sin_kernf(x + s3pio2);
          } else {
            sincos_sin = -cos_kernf(x - s3pio2);
            sincos_cos =  sin_kernf(x - s3pio2);
          }
          return;
        }
        sincos_sin = sin_kernf(sign ? x + s4pio2 : x - s4pio2);
        sincos_cos = cos_kernf(sign ? x + s4pio2 : x - s4pio2);
        return;
      }
    }
    // sin(Inf or NaN) is NaN
    if (ux >= 0x7F800000) {
      let xx = x - x;
      sincos_sin = xx;
      sincos_cos = xx;
      return;
    }
    // general argument reduction needed
    let n = rempio2f(x, ux, sign);
    let y = rempio2f_y;
    let s = sin_kernf(y);
    let c = cos_kernf(y);
    let sin = s, cos = c;
    if (n & 1) {
      sin =  c;
      cos = -s;
    }
    if (n & 2) {
      sin = -sin;
      cos = -cos;
    }
    sincos_sin = sin;
    sincos_cos = cos;
  }
}

export function ipow32(x: i32, e: i32): i32 {
  let out = 1;
  if (ASC_SHRINK_LEVEL < 1) {
    if (x == 2) {
      return select<i32>(1 << e, 0, <u32>e < 32);
    }
    if (e <= 0) {
      if (x == -1) return select<i32>(-1, 1, e & 1);
      return i32(e == 0) | i32(x == 1);
    }
    else if (e == 1) return x;
    else if (e == 2) return x * x;
    else if (e < 32) {
      let log = 32 - clz(e);
      // 32 = 2 ^ 5, so need only five cases.
      // But some extra cases needs for properly overflowing
      switch (log) {
        case 5: {
          if (e & 1) out *= x;
          e >>>= 1;
          x *= x;
        }
        case 4: {
          if (e & 1) out *= x;
          e >>>= 1;
          x *= x;
        }
        case 3: {
          if (e & 1) out *= x;
          e >>>= 1;
          x *= x;
        }
        case 2: {
          if (e & 1) out *= x;
          e >>>= 1;
          x *= x;
        }
        case 1: {
          if (e & 1) out *= x;
        }
      }
      return out;
    }
  }
  while (e) {
    if (e & 1) out *= x;
    e >>>= 1;
    x *= x;
  }
  return out;
}

export function ipow64(x: i64, e: i64): i64 {
  let out: i64 = 1;
  if (ASC_SHRINK_LEVEL < 1) {
    if (x == 2) {
      return select<i64>(1 << e, 0, <u64>e < 64);
    }
    if (e <= 0) {
      if (x == -1) return select<i64>(-1, 1, e & 1);
      return i64(e == 0) | i64(x == 1);
    }
    else if (e == 1) return x;
    else if (e == 2) return x * x;
    else if (e < 64) {
      let log = 64 - <i32>clz(e);
      // 64 = 2 ^ 6, so need only six cases.
      // But some extra cases needs for properly overflowing
      switch (log) {
        case 6: {
          if (e & 1) out *= x;
          e >>>= 1;
          x *= x;
        }
        case 5: {
          if (e & 1) out *= x;
          e >>>= 1;
          x *= x;
        }
        case 4: {
          if (e & 1) out *= x;
          e >>>= 1;
          x *= x;
        }
        case 3: {
          if (e & 1) out *= x;
          e >>>= 1;
          x *= x;
        }
        case 2: {
          if (e & 1) out *= x;
          e >>>= 1;
          x *= x;
        }
        case 1: {
          if (e & 1) out *= x;
        }
      }
      return out;
    }
  }
  while (e) {
    if (e & 1) out *= x;
    e >>>= 1;
    x *= x;
  }
  return out;
}

/*
TODO:
In compile time if only exponent is constant we could replace ipow32/ipow64 by shortest addition chains
which usually faster than exponentiation by squaring

for ipow32 and e < 32:

let b: i32, c: i32, d: i32, h: i32, k: i32, g: i32;
switch (e) {
  case  1: return x;
  case  2: return x * x;
  case  3: return x * x * x;
  case  4: return (b = x * x) * b;
  case  5: return (b = x * x) * b * x;
  case  6: return (b = x * x) * b * b;
  case  7: return (b = x * x) * b * b * x;
  case  8: return (d = (b = x * x) * b) * d;
  case  9: return (c = x * x * x) * c * c;
  case 10: return (d = (b = x * x) * b) * d * b;
  case 11: return (d = (b = x * x) * b) * d * b * x;
  case 12: return (d = (b = x * x) * b) * d * d;
  case 13: return (d = (b = x * x) * b) * d * d * x;
  case 14: return (d = (b = x * x) * b) * d * d * b;
  case 15: return (k = (b = x * x) * b * x) * k * k;
  case 16: return (h = (d = (b = x * x) * b) * d) * h;
  case 17: return (h = (d = (b = x * x) * b) * d) * h * x;
  case 18: return (h = (d = (b = x * x) * b) * d * x) * h;
  case 19: return (h = (d = (b = x * x) * b) * d * x) * h * x;
  case 20: return (h = (k = (b = x * x) * b * x) * k) * h;
  case 21: return (h = (k = (b = x * x) * b * x) * k) * h * x;
  case 22: return (g = (h = (k = (b = x * x) * b * x) * k) * x) * g;
  case 23: return (h = (d = (c = (b = x * x) * x) * b) * d) * h * c;
  case 24: return (h = (d = (c = x * x * x) * c) * d) * h;
  case 25: return (h = (d = (c = x * x * x) * c) * d) * h * x;
  case 26: return (g = (h = (d = (c = x * x * x) * c) * d) * x) * g;
  case 27: return (h = (d = (c = x * x * x) * c) * d) * h * c;
  case 28: return (h = (d = (c = x * x * x) * c * x) * d) * h;
  case 29: return (h = (d = (c = x * x * x) * c * x) * d) * h * x;
  case 30: return (h = (d = (c = x * x * x) * c) * d * c) * h;
  case 31: return (h = (d = (c = x * x * x) * c) * d * c) * h * x;
}

for ipow64: TODO
switch (e) {
  case 32:
  ...
  case 63:
}
*/
`,memory:`import { memcmp, memmove, memset } from "./util/memory";
import { E_NOTIMPLEMENTED } from "./util/error";

/** Memory manager interface. */
export namespace memory {

  /** Gets the size of the memory in pages. */
  // @ts-ignore: decorator
  @builtin
  export declare function size(): i32;

  /** Grows the memory by the given size in pages and returns the previous size in pages. */
  // @ts-ignore: decorator
  @unsafe @builtin
  export declare function grow(pages: i32): i32;

  /** Fills a section in memory with the specified byte value. */
  // @ts-ignore: decorator
  @unsafe @builtin
  export function fill(dst: usize, c: u8, n: usize): void {
    memset(dst, c, n); // fallback if "bulk-memory" isn't enabled
  }

  /** Copies a section of memory to another. Has move semantics. */
  // @ts-ignore: decorator
  @unsafe @builtin
  export function copy(dst: usize, src: usize, n: usize): void {
    memmove(dst, src, n); // fallback if "bulk-memory" isn't enabled
  }

  export namespace atomic {

    // @ts-ignore: decorator
    @unsafe @builtin
    export declare function wait32(ptr: usize, expected: i32, timeout: i64): AtomicWaitResult;

    // @ts-ignore: decorator
    @unsafe @builtin
    export declare function wait64(ptr: usize, expected: i64, timeout: i64): AtomicWaitResult;
  }

  /** Initializes a memory segment. */
  // @ts-ignore: decorator
  @unsafe
  export function init(segmentIndex: u32, srcOffset: usize, dstOffset: usize, n: usize): void {
    throw new Error(E_NOTIMPLEMENTED);
  }

  /** Drops a memory segment. */
  // @ts-ignore: decorator
  @unsafe
  export function drop(segmentIndex: u32): void {
    throw new Error(E_NOTIMPLEMENTED);
  }

  /** Repeats a section of memory at a specific address. */
  // @ts-ignore: decorator
  @unsafe
  export function repeat(dst: usize, src: usize, srcLength: usize, count: usize): void {
    let index: usize = 0;
    let total = srcLength * count;
    while (index < total) {
      memory.copy(dst + index, src, srcLength);
      index += srcLength;
    }
  }

  /** Compares a section of memory to another. */
  // @ts-ignore: decorator
  @inline
  export function compare(vl: usize, vr: usize, n: usize): i32 {
    return memcmp(vl, vr, n);
  }

  /** Gets a pointer to a static chunk of memory of the given size. */
  // @ts-ignore: decorator
  @builtin
  export declare function data<T>(size: T, align?: i32): usize;
}

// @ts-ignore: decorator
@builtin
export declare const __data_end: usize;

// @ts-ignore: decorator
@builtin
export declare let __stack_pointer: usize;

// @ts-ignore: decorator
@builtin
export declare const __heap_base: usize;

/** Heap memory interface. */
export namespace heap {

  /** Allocates a chunk of memory of at least the specified size. */
  // @ts-ignore: decorator
  @unsafe export function alloc(size: usize): usize {
    return __alloc(size);
  }

  /** Reallocates a chunk of memory to have at least the specified size. */
  // @ts-ignore: decorator
  @unsafe export function realloc(ptr: usize, size: usize): usize {
    return __realloc(ptr, size);
  }

  /** Frees a chunk of memory. Does hardly anything (most recent block only) with the stub runtime. */
  // @ts-ignore: decorator
  @unsafe export function free(ptr: usize): void {
    __free(ptr);
  }

  /** Dangerously resets the entire heap. Specific to the stub runtime. */
  // @ts-ignore: decorator
  @unsafe export function reset(): void {
    if (isDefined(__reset)) {
      __reset();
    } else {
      throw new Error(E_NOTIMPLEMENTED);
    }
  }
}
`,number:`import { itoa32, utoa32, itoa64, utoa64, dtoa } from "./util/number";
import { strtol, strtod } from "./util/string";

// @ts-ignore: decorator
@builtin @inline
export const NaN: f64 = 0 / 0; // context-aware

// @ts-ignore: decorator
@builtin @inline
export const Infinity: f64 = 1 / 0; // context-aware

// @ts-ignore: decorator
@builtin
export declare function isNaN<T extends number>(value: T): bool;

// @ts-ignore: decorator
@builtin
export declare function isFinite<T extends number>(value: T): bool;

@final @unmanaged
export abstract class I8 {

  // @ts-ignore: decorator
  @lazy
  static readonly MIN_VALUE: i8 = i8.MIN_VALUE;

  // @ts-ignore: decorator
  @lazy
  static readonly MAX_VALUE: i8 = i8.MAX_VALUE;

  /** @deprecated */
  static parseInt(value: string, radix: i32 = 0): i8 {
    return <i8>strtol<i32>(value, radix);
  }

  toString(this: i8, radix: i32 = 10): String {
    return itoa32(this, radix);
  }
}

@final @unmanaged
export abstract class I16 {

  // @ts-ignore: decorator
  @lazy
  static readonly MIN_VALUE: i16 = i16.MIN_VALUE;

  // @ts-ignore: decorator
  @lazy
  static readonly MAX_VALUE: i16 = i16.MAX_VALUE;

  /** @deprecated */
  static parseInt(value: string, radix: i32 = 0): i16 {
    return <i16>strtol<i32>(value, radix);
  }

  toString(this: i16, radix: i32 = 10): String {
    return itoa32(this, radix);
  }
}

@final @unmanaged
export abstract class I32 {

  // @ts-ignore: decorator
  @lazy
  static readonly MIN_VALUE: i32 = i32.MIN_VALUE;

  // @ts-ignore: decorator
  @lazy
  static readonly MAX_VALUE: i32 = i32.MAX_VALUE;

  /** @deprecated */
  static parseInt(value: string, radix: i32 = 0): i32 {
    return <i32>strtol<i32>(value, radix);
  }

  toString(this: i32, radix: i32 = 10): String {
    return itoa32(this, radix);
  }
}

@final @unmanaged
export abstract class I64 {

  // @ts-ignore: decorator
  @lazy
  static readonly MIN_VALUE: i64 = i64.MIN_VALUE;

  // @ts-ignore: decorator
  @lazy
  static readonly MAX_VALUE: i64 = i64.MAX_VALUE;

  /** @deprecated */
  static parseInt(value: string, radix: i32 = 0): i64 {
    return strtol<i64>(value, radix);
  }

  toString(this: i64, radix: i32 = 10): String {
    return itoa64(this, radix);
  }
}

@final @unmanaged
export abstract class Isize {

  // @ts-ignore: decorator
  @lazy
  static readonly MIN_VALUE: isize = isize.MIN_VALUE;

  // @ts-ignore: decorator
  @lazy
  static readonly MAX_VALUE: isize = isize.MAX_VALUE;

  /** @deprecated */
  static parseInt(value: string, radix: i32 = 0): isize {
    return <isize>strtol<i64>(value, radix);
  }

  toString(this: isize, radix: i32 = 10): String {
    if (sizeof<isize>() == 4) {
      return itoa32(<i32>this, radix);
    } else {
      return itoa64(<i64>this, radix);
    }
  }
}

@final @unmanaged
export abstract class U8 {

  // @ts-ignore: decorator
  @lazy
  static readonly MIN_VALUE: u8 = u8.MIN_VALUE;

  // @ts-ignore: decorator
  @lazy
  static readonly MAX_VALUE: u8 = u8.MAX_VALUE;

  /** @deprecated */
  static parseInt(value: string, radix: i32 = 0): u8 {
    return <u8>strtol<i32>(value, radix);
  }

  toString(this: u8, radix: i32 = 10): String {
    return utoa32(this, radix);
  }
}

@final @unmanaged
export abstract class U16 {

  // @ts-ignore: decorator
  @lazy
  static readonly MIN_VALUE: u16 = u16.MIN_VALUE;

  // @ts-ignore: decorator
  @lazy
  static readonly MAX_VALUE: u16 = u16.MAX_VALUE;

  /** @deprecated */
  static parseInt(value: string, radix: i32 = 0): u16 {
    return <u16>strtol<i32>(value, radix);
  }

  toString(this: u16, radix: i32 = 10): String {
    return utoa32(this, radix);
  }
}

@final @unmanaged
export abstract class U32 {

  // @ts-ignore: decorator
  @lazy
  static readonly MIN_VALUE: u32 = u32.MIN_VALUE;

  // @ts-ignore: decorator
  @lazy
  static readonly MAX_VALUE: u32 = u32.MAX_VALUE;

  /** @deprecated */
  static parseInt(value: string, radix: i32 = 0): u32 {
    return <u32>strtol<i32>(value, radix);
  }

  toString(this: u32, radix: i32 = 10): String {
    return utoa32(this, radix);
  }
}

@final @unmanaged
export abstract class U64 {

  // @ts-ignore: decorator
  @lazy
  static readonly MIN_VALUE: u64 = u64.MIN_VALUE;

  // @ts-ignore: decorator
  @lazy
  static readonly MAX_VALUE: u64 = u64.MAX_VALUE;

  /** @deprecated */
  static parseInt(value: string, radix: i32 = 0): u64 {
    return <u64>strtol<i64>(value, radix);
  }

  toString(this: u64, radix: i32 = 10): String {
    return utoa64(this, radix);
  }
}

@final @unmanaged
export abstract class Usize {

  // @ts-ignore: decorator
  @lazy
  static readonly MIN_VALUE: usize = usize.MIN_VALUE;

  // @ts-ignore: decorator
  @lazy
  static readonly MAX_VALUE: usize = usize.MAX_VALUE;

  /** @deprecated */
  static parseInt(value: string, radix: i32 = 0): usize {
    return <usize>strtol<i64>(value, radix);
  }

  toString(this: usize, radix: i32 = 10): String {
    if (sizeof<usize>() == 4) {
      return utoa32(<u32>this, radix);
    } else {
      return utoa64(<u64>this, radix);
    }
  }
}

@final @unmanaged
export abstract class Bool {

  // @ts-ignore: decorator
  @lazy
  static readonly MIN_VALUE: bool = bool.MIN_VALUE;

  // @ts-ignore: decorator
  @lazy
  static readonly MAX_VALUE: bool = bool.MAX_VALUE;

  toString(this: bool, radix: i32 = 0): String {
    return this ? "true" : "false";
  }
}

export { Bool as Boolean };

@final @unmanaged
export abstract class F32 {

  // @ts-ignore: decorator
  @lazy
  static readonly EPSILON: f32 = f32.EPSILON;

  // @ts-ignore: decorator
  @lazy
  static readonly MIN_VALUE: f32 = f32.MIN_VALUE;

  // @ts-ignore: decorator
  @lazy
  static readonly MAX_VALUE: f32 = f32.MAX_VALUE;

  // @ts-ignore: decorator
  @lazy
  static readonly MIN_SAFE_INTEGER: f32 = f32.MIN_SAFE_INTEGER;

  // @ts-ignore: decorator
  @lazy
  static readonly MAX_SAFE_INTEGER: f32 = f32.MAX_SAFE_INTEGER;

  // @ts-ignore: decorator
  @lazy
  static readonly POSITIVE_INFINITY: f32 = f32.POSITIVE_INFINITY;

  // @ts-ignore: decorator
  @lazy
  static readonly NEGATIVE_INFINITY: f32 = f32.NEGATIVE_INFINITY;

  // @ts-ignore: decorator
  @lazy
  static readonly NaN: f32 = f32.NaN;

  static isNaN(value: f32): bool {
    return isNaN<f32>(value);
  }

  static isFinite(value: f32): bool {
    return isFinite<f32>(value);
  }

  static isSafeInteger(value: f32): bool {
    return abs<f32>(value) <= f32.MAX_SAFE_INTEGER && trunc<f32>(value) == value;
  }

  static isInteger(value: f32): bool {
    return isFinite<f32>(value) && trunc<f32>(value) == value;
  }

  /** @deprecated */
  static parseInt(value: string, radix: i32 = 0): f32 {
    return <f32>strtol<f64>(value, radix);
  }

  /** @deprecated */
  static parseFloat(value: string): f32 {
    return <f32>strtod(value);
  }

  toString(this: f32, radix: i32 = 0): String {
    return dtoa(this);
  }
}

@final @unmanaged
export abstract class F64 {

  // @ts-ignore: decorator
  @lazy
  static readonly EPSILON: f64 = f64.EPSILON;

  // @ts-ignore: decorator
  @lazy
  static readonly MIN_VALUE: f64 = f64.MIN_VALUE;

  // @ts-ignore: decorator
  @lazy
  static readonly MAX_VALUE: f64 = f64.MAX_VALUE;

  // @ts-ignore: decorator
  @lazy
  static readonly MIN_SAFE_INTEGER: f64 = f64.MIN_SAFE_INTEGER;

  // @ts-ignore: decorator
  @lazy
  static readonly MAX_SAFE_INTEGER: f64 = f64.MAX_SAFE_INTEGER;

  // @ts-ignore: decorator
  @lazy
  static readonly POSITIVE_INFINITY: f64 = f64.POSITIVE_INFINITY;

  // @ts-ignore: decorator
  @lazy
  static readonly NEGATIVE_INFINITY: f64 = f64.NEGATIVE_INFINITY;

  // @ts-ignore: decorator
  @lazy
  static readonly NaN: f64 = f64.NaN;

  static isNaN(value: f64): bool {
    return isNaN<f64>(value);
  }

  static isFinite(value: f64): bool {
    return isFinite<f64>(value);
  }

  static isSafeInteger(value: f64): bool {
    return abs<f64>(value) <= f64.MAX_SAFE_INTEGER && trunc<f64>(value) == value;
  }

  static isInteger(value: f64): bool {
    return isFinite<f64>(value) && trunc<f64>(value) == value;
  }

  /** @deprecated */
  static parseInt(value: string, radix: i32 = 0): f64 {
    return strtol<f64>(value, radix);
  }

  /** @deprecated */
  static parseFloat(value: string): f64 {
    return strtod(value);
  }

  toString(this: f64, radix: i32 = 0): String {
    return dtoa(this);
  }
}

export { F64 as Number };
`,object:`export abstract class Object {
  static is<T>(x: T, y: T): bool {
    if (isFloat<T>()) {
      // Float pointing is special we shoulr presere following identities:
      // 0.0 !=-0.0
      // NaN == NaN
      if (sizeof<T>() == 8) {
        return (
          bool(u32(x != x) & u32(y != y) |
          u32(reinterpret<u64>(f64(x)) == reinterpret<u64>(f64(y))))
        );
      } else {
        return (
          bool(u32(x != x) & u32(y != y) |
          u32(reinterpret<u32>(f32(x)) == reinterpret<u32>(f32(y))))
        );
      }
    }
    // For references, strings, integers and booleans
    return x == y;
  }

  // TODO: Wrapper classes like \`Function<T>\` override the \`this\` type of
  // \`toString\`, which is covariant and hence fails to overload. Wrapper classes
  // might need a different mechanism to indicate such special \`this\` types.
  // toString(): string {
  //   return "[object Object]";
  // }
}

// TODO: The types \`Object\` and \`object\` differ in TypeScript, in that the
// latter indicates any non-primitive type, not including \`string\` for example.
// The \`object\` type hence remains reserved for now, also to potentially address
// the above \`toString\` TODO in alternative ways.
// @ts-ignore: nolib
// export type object = Object;
`,performance:`import {
  performance as performance_binding
} from "bindings/dom";

export namespace performance {
  export function now(): f64 {
    return performance_binding.now();
  }
}
`,polyfills:`export function bswap<T extends number>(value: T): T {
  if (isInteger<T>()) {
    if (sizeof<T>() == 1) {
      return value;
    }
    if (sizeof<T>() == 2) {
      return <T>(<u16>value << 8 | (<u16>value >> 8));
    }
    if (sizeof<T>() == 4) {
      return <T>(
        rotl(<u32>value & 0xFF00FF00, 8) |
        rotr(<u32>value & 0x00FF00FF, 8)
      );
    }
    if (sizeof<T>() == 8) {
      let a = (<u64>value >> 8) & 0x00FF00FF00FF00FF;
      let b = (<u64>value & 0x00FF00FF00FF00FF) << 8;
      let v = a | b;

      a = (v >>> 16) & 0x0000FFFF0000FFFF;
      b = (v & 0x0000FFFF0000FFFF) << 16;

      return <T>rotr(a | b, 32);
    }
  }
  ERROR("Unsupported generic type");
}
`,process:`import {
  Date as Date_binding,
  performance as performance_binding
} from "bindings/dom";

import {
  process as process_binding
} from "bindings/node";

export namespace process {

  // @ts-ignore: decorator
  @lazy export const arch = sizeof<usize>() == 4 ? "wasm32" : "wasm64";

  // @ts-ignore: decorator
  @lazy export const platform = "wasm";

  // @ts-ignore: decorator
  @lazy export const argv = lazyArgv();

  // @ts-ignore: decorator
  @lazy export const env = lazyEnv();

  // @ts-ignore: decorator
  @lazy export let exitCode = 0;

  export function exit(code: i32 = exitCode): void {
    process_binding.exit(code);
  }

  export function time(): i64 {
    return <i64>Date_binding.now();
  }

  export function hrtime(): u64 {
    let now = performance_binding.now();
    let millis = <u64>now;
    let fraction = now - <f64>millis;
    return millis * 1000000 + <u64>(fraction * 1000000);
  }
}

function lazyArgv(): string[] {
  return process_binding.argv;
}

function lazyEnv(): Map<string,string> {
  // TODO: What about Node?
  return new Map();
}
`,reference:`// Canonical aliases
export type funcref = ref_func | null;
export type externref = ref_extern | null;
export type anyref = ref_any | null;
export type eqref = ref_eq | null;
export type i31ref = ref_i31 | null;
export type structref = ref_struct | null;
export type arrayref = ref_array | null;
export type stringref = ref_string | null;
export type stringview_wtf8 = ref_stringview_wtf8 | null;
export type stringview_wtf16 = ref_stringview_wtf16 | null;
export type stringview_iter = ref_stringview_iter | null;

@unmanaged
abstract class Ref {
}

@final @unmanaged
export abstract class RefFunc extends Ref {
}

@final @unmanaged
export abstract class RefExtern extends Ref {
}

@final @unmanaged
export abstract class RefAny extends Ref {
}

@final @unmanaged
export abstract class RefEq extends Ref {
}

@final @unmanaged
export abstract class RefI31 extends Ref {
}

@final @unmanaged
export abstract class RefStruct extends Ref {
}

@final @unmanaged
export abstract class RefArray extends Ref {
}

@final @unmanaged
export abstract class RefString extends Ref {
}
`,regexp:`export class RegExp {

  // @binding(CALL_NEW, [ STRING, STRING], OBJECT_HANDLE)
  constructor(pattern: string, flags: string = "") { throw new Error("unreachable"); }

  // @binding(CALL_THIS, [ STRING ], PASS_THRU)
  test(search: string): bool { throw new Error("unreachable"); }

  // @binding(CALL_THIS, [], STRING)
  toString(): string { throw new Error("unreachable"); }

}
`,rt:`import { Typeinfo, TypeinfoFlags } from "./shared/typeinfo";
import { E_INDEXOUTOFRANGE } from "./util/error";
import { ArrayBufferView } from "./arraybuffer";

// @ts-ignore: decorator
@builtin
export declare const __rtti_base: usize;

// @ts-ignore: decorator
@builtin @unsafe
export declare function __visit_globals(cookie: u32): void;

// @ts-ignore: decorator
@builtin @unsafe
export declare function __visit_members(ref: usize, cookie: u32): void;

// @ts-ignore: decorator
@unsafe
export function __typeinfo(id: u32): TypeinfoFlags {
  let ptr = __rtti_base;
  if (id > load<u32>(ptr)) throw new Error(E_INDEXOUTOFRANGE);
  return changetype<Typeinfo>(ptr + sizeof<u32>() + id * offsetof<Typeinfo>()).flags;
}

// @ts-ignore: decorator
@unsafe
export function __newBuffer(size: usize, id: u32, data: usize = 0): usize {
  let buffer = __new(size, id);
  if (data) memory.copy(buffer, data, size);
  return buffer;
}

// @ts-ignore: decorator
@unsafe
export function __newArray(length: i32, alignLog2: usize, id: u32, data: usize = 0): usize {
  let bufferSize = <usize>length << alignLog2;
  // make sure \`buffer\` is tracked by the shadow stack
  let buffer = changetype<ArrayBuffer>(__newBuffer(bufferSize, idof<ArrayBuffer>(), data));
  // ...since allocating the array may trigger GC steps
  let array = __new(offsetof<i32[]>(), id);
  store<usize>(array, changetype<usize>(buffer), offsetof<ArrayBufferView>("buffer"));
  __link(array, changetype<usize>(buffer), false);
  store<usize>(array, changetype<usize>(buffer), offsetof<ArrayBufferView>("dataStart"));
  store<i32>(array, bufferSize, offsetof<ArrayBufferView>("byteLength"));
  store<i32>(array, length, offsetof<i32[]>("length_"));
  return array;
}

// @ts-ignore: decorator
@global @unsafe
function __tostack(ptr: usize): usize { // eslint-disable-line
  return ptr;
}

// These are provided by the respective implementation, included as another entry file by asc:

// // @ts-ignore: decorator
// @builtin @unsafe
// export declare function __alloc(size: usize): usize;

// // @ts-ignore: decorator
// @builtin @unsafe
// export declare function __realloc(ptr: usize, size: usize): usize;

// // @ts-ignore: decorator
// @builtin @unsafe
// export declare function __free(ptr: usize): void;

// // @ts-ignore: decorator
// @builtin @unsafe
// export declare function __new(size: usize, id: u32): usize;

// // @ts-ignore: decorator
// @builtin @unsafe
// export declare function __renew(ptr: usize, size: usize): usize;

// // @ts-ignore: decorator
// @builtin @unsafe
// export declare function __link(parentPtr: usize, childPtr: usize, expectMultiple: bool): void;

// // @ts-ignore: decorator
// @builtin @unsafe
// export declare function __collect(): void;

// // @ts-ignore: decorator
// @builtin @unsafe
// export declare function __visit(ptr: usize, cookie: u32): void;
`,"rt/common":`// Alignment guarantees

// @ts-ignore: decorator
@inline export const AL_BITS: u32 = 4; // 16 bytes to fit up to v128
// @ts-ignore: decorator
@inline export const AL_SIZE: usize = 1 << <usize>AL_BITS;
// @ts-ignore: decorator
@inline export const AL_MASK: usize = AL_SIZE - 1;

// Extra debugging

// @ts-ignore: decorator
@inline export const DEBUG = true;
// @ts-ignore: decorator
@inline export const TRACE = false;
// @ts-ignore: decorator
@inline export const RTRACE = isDefined(ASC_RTRACE);
// @ts-ignore: decorator
@inline export const PROFILE = isDefined(ASC_PROFILE);

// Memory manager

// \u2552\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 Memory manager block layout (32-bit) \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2555
//    3                   2                   1
//  1 0 9 8 7 6 5 4 3 2 1 0 9 8 7 6 5 4 3 2 1 0 9 8 7 6 5 4 3 2 1 0  bits
// \u251C\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2524
// \u2502                           MM info                             \u2502 -4
// \u255E>ptr\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2561
// \u2502                              ...                              \u2502
@unmanaged export class BLOCK {
  /** Memory manager info. */
  mmInfo: usize;
}

/** Overhead of a memory manager block. */
// @ts-ignore: decorator
@inline export const BLOCK_OVERHEAD: usize = offsetof<BLOCK>();

/** Maximum size of a memory manager block's payload. */
// @ts-ignore: decorator
@inline export const BLOCK_MAXSIZE: usize = (1 << 30) - BLOCK_OVERHEAD;

// Garbage collector

// \u2552\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 Garbage collector object layout (32-bit) \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2555
//    3                   2                   1
//  1 0 9 8 7 6 5 4 3 2 1 0 9 8 7 6 5 4 3 2 1 0 9 8 7 6 5 4 3 2 1 0  bits
// \u251C\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2524
// \u2502                     Memory manager block                      \u2502 -20
// \u255E\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2561
// \u2502                            GC info                            \u2502 -16
// \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
// \u2502                            GC info                            \u2502 -12
// \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
// \u2502                            RT id                              \u2502 -8
// \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
// \u2502                            RT size                            \u2502 -4
// \u255E>ptr\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2561
// \u2502                              ...                              \u2502
@unmanaged export class OBJECT extends BLOCK {
  /** Garbage collector info. */
  gcInfo: u32;
  /** Garbage collector info. */
  gcInfo2: u32;
  /** Runtime class id. */
  rtId: u32;
  /** Runtime object size. */
  rtSize: u32;
}

/** Overhead of a garbage collector object. Excludes memory manager block overhead. */
// @ts-ignore: decorator
@inline export const OBJECT_OVERHEAD: usize = (offsetof<OBJECT>() - BLOCK_OVERHEAD + AL_MASK) & ~AL_MASK;

/** Maximum size of a garbage collector object's payload. */
// @ts-ignore: decorator
@inline export const OBJECT_MAXSIZE: usize = BLOCK_MAXSIZE - OBJECT_OVERHEAD;

/** Total of memory manager and garbage collector overhead. */
// @ts-ignore: decorator
@inline export const TOTAL_OVERHEAD: usize = BLOCK_OVERHEAD + OBJECT_OVERHEAD;
`,"rt/index-incremental":`import "./tlsf";
import "./itcms";
`,"rt/index-minimal":`import "./tlsf";
import "./tcms";
`,"rt/index-stub":`import "./stub";
`,"rt/itcms":`import { BLOCK, BLOCK_OVERHEAD, OBJECT_OVERHEAD, OBJECT_MAXSIZE, TOTAL_OVERHEAD, DEBUG, TRACE, RTRACE, PROFILE } from "./common";
import { onvisit, oncollect, oninterrupt, onyield } from "./rtrace";
import { TypeinfoFlags } from "../shared/typeinfo";
import { E_ALLOCATION_TOO_LARGE, E_ALREADY_PINNED, E_NOT_PINNED } from "../util/error";

// === ITCMS: An incremental Tri-Color Mark & Sweep garbage collector ===
// Adapted from Bach Le's \u03BCgc, see: https://github.com/bullno1/ugc

// \u2552\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2564\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 Colors \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2555
// \u2502 Color       \u2502 Meaning                                         \u2502
// \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
// \u2502 WHITE*      \u2502 Unprocessed                                     \u2502
// \u2502 BLACK*      \u2502 Processed                                       \u2502
// \u2502 GRAY        \u2502 Processed with unprocessed children             \u2502
// \u2502 TRANSPARENT \u2502 Manually pinned (always reachable)              \u2502
// \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518
// * flipped between cycles

// @ts-ignore: decorator
@lazy let white = 0;
// @ts-ignore: decorator
@inline const gray = 2;
// @ts-ignore: decorator
@inline const transparent = 3;
// @ts-ignore: decorator
@inline const COLOR_MASK = 3;

/** Size in memory of all objects currently managed by the GC. */
// @ts-ignore: decorator
@lazy let total: usize = 0;

/** Currently transitioning from SWEEP to MARK state. */
// @ts-ignore: decorator
@inline const STATE_IDLE = 0;
/** Currently marking reachable objects. */
// @ts-ignore: decorator
@inline const STATE_MARK = 1;
/** Currently sweeping unreachable objects. */
// @ts-ignore: decorator
@inline const STATE_SWEEP = 2;
/** Current collector state. */
// @ts-ignore: decorator
@lazy let state = STATE_IDLE;

// @ts-ignore: decorator
@lazy let fromSpace = initLazy(changetype<Object>(memory.data(offsetof<Object>())));
// @ts-ignore: decorator
@lazy let toSpace = initLazy(changetype<Object>(memory.data(offsetof<Object>())));
// @ts-ignore: decorator
@lazy let pinSpace = initLazy(changetype<Object>(memory.data(offsetof<Object>())));
// @ts-ignore: decorator
@lazy let iter: Object = changetype<Object>(0); // unsafe initializion below

function initLazy(space: Object): Object {
  space.nextWithColor = changetype<usize>(space);
  space.prev = space;
  return space;
}

/** Visit cookie indicating scanning of an object. */
// @ts-ignore: decorator
@inline const VISIT_SCAN = 0;

// \u2552\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 Managed object layout (32-bit) \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2555
//    3                   2                   1
//  1 0 9 8 7 6 5 4 3 2 1 0 9 8 7 6 5 4 3 2 1 0 9 8 7 6 5 4 3 2 1 0  bits
// \u251C\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2524
// \u2502                      Memory manager block                     \u2502
// \u255E\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2564\u2550\u2550\u2550\u2561
// \u2502                              next                         \u2502 C \u2502 = nextWithColor
// \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2524
// \u2502                              prev                             \u2502
// \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
// \u2502                              rtId                             \u2502
// \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
// \u2502                              rtSize                           \u2502
// \u255E>ptr\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2561
// \u2502                               ...                             \u2502
// C: color

/** Represents a managed object in memory, consisting of a header followed by the object's data. */
@unmanaged class Object extends BLOCK {
  /** Pointer to the next object with color flags stored in the alignment bits. */
  nextWithColor: usize; // *u32
  /** Pointer to the previous object. */
  prev: Object; // *u32
  /** Runtime id. */
  rtId: u32;
  /** Runtime size. */
  rtSize: u32;

  /** Gets the pointer to the next object. */
  get next(): Object {
    return changetype<Object>(this.nextWithColor & ~COLOR_MASK);
  }

  /** Sets the pointer to the next object. */
  set next(obj: Object) {
    this.nextWithColor = changetype<usize>(obj) | (this.nextWithColor & COLOR_MASK);
  }

  /** Gets this object's color. */
  get color(): i32 {
    return i32(this.nextWithColor & COLOR_MASK);
  }

  /** Sets this object's color. */
  set color(color: i32) {
    this.nextWithColor = (this.nextWithColor & ~COLOR_MASK) | color;
  }

  /** Gets the size of this object in memory. */
  get size(): usize {
    return BLOCK_OVERHEAD + (this.mmInfo & ~3);
  }

  /** Tests if this object is pointerfree. */
  get isPointerfree(): bool {
    let rtId = this.rtId;
    // 0: Object, 1: ArrayBuffer, 2: String
    return rtId <= idof<string>() || (__typeinfo(rtId) & TypeinfoFlags.POINTERFREE) != 0;
  }

  /** Unlinks this object from its list. */
  unlink(): void {
    let next = this.next;
    if (next == null) {
      if (DEBUG) assert(this.prev == null && changetype<usize>(this) < __heap_base);
      return; // static data not yet linked
    }
    let prev = this.prev;
    if (DEBUG) assert(prev);
    next.prev = prev;
    prev.next = next;
  }

  /** Links this object to the specified list, with the given color. */
  linkTo(list: Object, withColor: i32): void {
    let prev = list.prev;
    this.nextWithColor = changetype<usize>(list) | withColor;
    this.prev = prev;
    prev.next = this;
    list.prev = this;
  }

  /** Marks this object as gray, that is reachable with unscanned children. */
  makeGray(): void {
    if (this == iter) iter = assert(this.prev);
    this.unlink();
    this.linkTo(toSpace, this.isPointerfree ? i32(!white) : gray);
  }
}

/** Visits all objects considered to be program roots. */
function visitRoots(cookie: u32): void {
  __visit_globals(cookie);
  let pn = pinSpace;
  let iter = pn.next;
  while (iter != pn) {
    if (DEBUG) assert(iter.color == transparent);
    __visit_members(changetype<usize>(iter) + TOTAL_OVERHEAD, cookie);
    iter = iter.next;
  }
}

/** Visits all objects on the stack. */
function visitStack(cookie: u32): void {
  let ptr = __stack_pointer;
  while (ptr < __heap_base) {
    __visit(load<usize>(ptr), cookie);
    ptr += sizeof<usize>();
  }
}

/** Performs a single step according to the current state. */
function step(): usize {
  // Magic constants responsible for pause times. Obtained experimentally
  // using the compiler compiling itself. 2048 budget pro run by default.
  const MARKCOST = isDefined(ASC_GC_MARKCOST) ? ASC_GC_MARKCOST : 1;
  const SWEEPCOST = isDefined(ASC_GC_SWEEPCOST) ? ASC_GC_SWEEPCOST : 10;
  let obj: Object;
  switch (state) {
    case STATE_IDLE: {
      state = STATE_MARK;
      visitCount = 0;
      visitRoots(VISIT_SCAN);
      iter = toSpace;
      return visitCount * MARKCOST;
    }
    case STATE_MARK: {
      let black = i32(!white);
      obj = iter.next;
      while (obj != toSpace) {
        iter = obj;
        if (obj.color != black) { // skip already-blacks (pointerfree)
          obj.color = black;
          visitCount = 0;
          __visit_members(changetype<usize>(obj) + TOTAL_OVERHEAD, VISIT_SCAN);
          return visitCount * MARKCOST;
        }
        obj = obj.next;
      }
      visitCount = 0;
      visitRoots(VISIT_SCAN);
      obj = iter.next;
      if (obj == toSpace) {
        visitStack(VISIT_SCAN);
        obj = iter.next;
        while (obj != toSpace) {
          if (obj.color != black) {
            obj.color = black;
            __visit_members(changetype<usize>(obj) + TOTAL_OVERHEAD, VISIT_SCAN);
          }
          obj = obj.next;
        }
        let from = fromSpace;
        fromSpace = toSpace;
        toSpace = from;
        white = black;
        iter = from.next;
        state = STATE_SWEEP;
      }
      return visitCount * MARKCOST;
    }
    case STATE_SWEEP: {
      obj = iter;
      if (obj != toSpace) {
        iter = obj.next;
        if (DEBUG) assert(obj.color == i32(!white)); // old white
        free(obj);
        return SWEEPCOST;
      }
      toSpace.nextWithColor = changetype<usize>(toSpace);
      toSpace.prev = toSpace;
      state = STATE_IDLE;
      break;
    }
  }
  return 0;
}

/** Frees an object. */
function free(obj: Object): void {
  if (changetype<usize>(obj) < __heap_base) {
    obj.nextWithColor = 0; // may become linked again
    obj.prev = changetype<Object>(0);
  } else {
    total -= obj.size;
    if (isDefined(__finalize)) {
      __finalize(changetype<usize>(obj) + TOTAL_OVERHEAD);
    }
    __free(changetype<usize>(obj) + BLOCK_OVERHEAD);
  }
}

// Garbage collector interface

// @ts-ignore: decorator
@global @unsafe
export function __new(size: usize, id: i32): usize {
  if (size >= OBJECT_MAXSIZE) throw new Error(E_ALLOCATION_TOO_LARGE);
  if (total >= threshold) interrupt();
  let obj = changetype<Object>(__alloc(OBJECT_OVERHEAD + size) - BLOCK_OVERHEAD);
  obj.rtId = id;
  obj.rtSize = <u32>size;
  obj.linkTo(fromSpace, white); // inits next/prev
  total += obj.size;
  let ptr = changetype<usize>(obj) + TOTAL_OVERHEAD;
  // may be visited before being fully initialized, so must fill
  memory.fill(ptr, 0, size);
  return ptr;
}

// @ts-ignore: decorator
@global @unsafe
export function __renew(oldPtr: usize, size: usize): usize {
  let oldObj = changetype<Object>(oldPtr - TOTAL_OVERHEAD);
  // Update object size if its block is large enough
  if (size <= (oldObj.mmInfo & ~3) - OBJECT_OVERHEAD) {
    oldObj.rtSize = <u32>size;
    return oldPtr;
  }
  // If not the same object anymore, we have to move it move it due to the
  // shadow stack potentially still referencing the old object
  let newPtr = __new(size, oldObj.rtId);
  memory.copy(newPtr, oldPtr, min(size, oldObj.rtSize));
  return newPtr;
}

// @ts-ignore: decorator
@global @unsafe
export function __link(parentPtr: usize, childPtr: usize, expectMultiple: bool): void {
  // Write barrier is unnecessary if non-incremental
  if (!childPtr) return;
  if (DEBUG) assert(parentPtr);
  let child = changetype<Object>(childPtr - TOTAL_OVERHEAD);
  if (child.color == white) {
    let parent = changetype<Object>(parentPtr - TOTAL_OVERHEAD);
    let parentColor = parent.color;
    if (parentColor == i32(!white)) {
      // Maintain the invariant that no black object may point to a white object.
      if (expectMultiple) {
        // Move the barrier "backward". Suitable for containers receiving multiple stores.
        // Avoids a barrier for subsequent objects stored into the same container.
        parent.makeGray();
      } else {
        // Move the barrier "forward". Suitable for objects receiving isolated stores.
        child.makeGray();
      }
    } else if (parentColor == transparent && state == STATE_MARK) {
      // Pinned objects are considered 'black' during the mark phase.
      child.makeGray();
    }
  }
}

// @ts-ignore: decorator
@lazy let visitCount = 0;

// @ts-ignore: decorator
@global @unsafe
export function __visit(ptr: usize, cookie: i32): void {
  if (!ptr) return;
  let obj = changetype<Object>(ptr - TOTAL_OVERHEAD);
  if (RTRACE) if (!onvisit(obj)) return;
  if (obj.color == white) {
    obj.makeGray();
    ++visitCount;
  }
}

// @ts-ignore: decorator
@global @unsafe
export function __pin(ptr: usize): usize {
  if (ptr) {
    let obj = changetype<Object>(ptr - TOTAL_OVERHEAD);
    if (obj.color == transparent) {
      throw new Error(E_ALREADY_PINNED);
    }
    obj.unlink(); // from fromSpace
    obj.linkTo(pinSpace, transparent);
  }
  return ptr;
}

// @ts-ignore: decorator
@global @unsafe
export function __unpin(ptr: usize): void {
  if (!ptr) return;
  let obj = changetype<Object>(ptr - TOTAL_OVERHEAD);
  if (obj.color != transparent) {
    throw new Error(E_NOT_PINNED);
  }
  if (state == STATE_MARK) {
    // We may be right at the point after marking roots for the second time and
    // entering the sweep phase, in which case the object would be missed if it
    // is not only pinned but also a root. Make sure it isn't missed.
    obj.makeGray();
  } else {
    obj.unlink();
    obj.linkTo(fromSpace, white);
  }
}

// @ts-ignore: decorator
@global @unsafe
export function __collect(): void {
  if (TRACE) trace("GC (full) at", 1, total);
  if (state > STATE_IDLE) {
    // finish current cycle
    while (state != STATE_IDLE) step();
  }
  // perform a full cycle
  step();
  while (state != STATE_IDLE) step();
  threshold = <usize>(<u64>total * IDLEFACTOR / 100) + GRANULARITY;
  if (TRACE) trace("GC (full) done at cur/max", 2, total, memory.size() << 16);
  if (RTRACE || PROFILE) oncollect(total);
}

// Garbage collector automation

/** How often to interrupt. The default of 1024 means "interrupt each 1024 bytes allocated". */
// @ts-ignore: decorator
@inline const GRANULARITY: usize = isDefined(ASC_GC_GRANULARITY) ? ASC_GC_GRANULARITY : 1024;
/** How long to interrupt. The default of 200% means "run at double the speed of allocations". */
// @ts-ignore: decorator
@inline const STEPFACTOR: usize = isDefined(ASC_GC_SWEEPFACTOR) ? ASC_GC_SWEEPFACTOR : 200;
/** How long to idle. The default of 200% means "wait for memory to double before kicking in again". */
// @ts-ignore: decorator
@inline const IDLEFACTOR: usize = isDefined(ASC_GC_IDLEFACTOR) ? ASC_GC_IDLEFACTOR : 200;

/** Threshold of memory used by objects to exceed before interrupting again. */
// @ts-ignore: decorator
@lazy let threshold: usize = ((<usize>memory.size() << 16) - __heap_base) >> 1;

/** Performs a reasonable amount of incremental GC steps. */
function interrupt(): void {
  if (PROFILE) oninterrupt(total);
  if (TRACE) trace("GC (auto) at", 1, total);
  let budget: isize = GRANULARITY * STEPFACTOR / 100;
  do {
    budget -= step();
    if (state == STATE_IDLE) {
      if (TRACE) trace("\u2514 GC (auto) done at cur/max", 2, total, memory.size() << 16);
      if (IDLEFACTOR % 100 == 0) {
        // optimization for the default GC parameters which idle factor is 200%
        threshold = total * (IDLEFACTOR / 100) + GRANULARITY;
      } else {
        threshold = <usize>((<u64>total * IDLEFACTOR) / 100) + GRANULARITY;
      }
      if (PROFILE) onyield(total);
      return;
    }
  } while (budget > 0);
  if (TRACE) trace("\u2514 GC (auto) ongoing at", 1, total);
  threshold = total + GRANULARITY * usize(total - threshold < GRANULARITY);
  if (PROFILE) onyield(total);
}
`,"rt/rtrace":`import { BLOCK } from "./common";

export declare function oninit(heapBase: usize): void;

// Memory Allocator
export declare function onalloc(block: BLOCK): void;
export declare function onresize(block: BLOCK, oldSizeInclOverhead: usize): void;
export declare function onmove(oldBlock: BLOCK, newBlock: BLOCK): void;
export declare function onfree(block: BLOCK): void;

// Garbage collector
export declare function onvisit(block: BLOCK): bool;
export declare function oncollect(total: usize): void;
export declare function oninterrupt(total: usize): void;
export declare function onyield(total: usize): void;
`,"rt/stub":`import { AL_MASK, OBJECT, OBJECT_OVERHEAD, BLOCK_MAXSIZE, BLOCK_OVERHEAD, BLOCK, OBJECT_MAXSIZE } from "./common";
import { E_ALLOCATION_TOO_LARGE } from "../util/error";

// === A minimal runtime stub ===

// @ts-ignore: decorator
@lazy let startOffset: usize = ((__heap_base + BLOCK_OVERHEAD + AL_MASK) & ~AL_MASK) - BLOCK_OVERHEAD;
// @ts-ignore: decorator
@lazy let offset: usize = startOffset;

function maybeGrowMemory(newOffset: usize): void {
  // assumes newOffset is aligned
  let pagesBefore = memory.size();
  let maxOffset = ((<usize>pagesBefore << 16) + AL_MASK) & ~AL_MASK;
  if (newOffset > maxOffset) {
    let pagesNeeded = <i32>(((newOffset - maxOffset + 0xffff) & ~0xffff) >>> 16);
    let pagesWanted = max(pagesBefore, pagesNeeded); // double memory
    if (memory.grow(pagesWanted) < 0) {
      if (memory.grow(pagesNeeded) < 0) unreachable(); // out of memory
    }
  }
  offset = newOffset;
}

// @ts-ignore: decorator
@inline function computeSize(size: usize): usize {
  return ((size + BLOCK_OVERHEAD + AL_MASK) & ~AL_MASK) - BLOCK_OVERHEAD;
}

// @ts-ignore: decorator
@unsafe @global
export function __alloc(size: usize): usize {
  if (size > BLOCK_MAXSIZE) throw new Error(E_ALLOCATION_TOO_LARGE);
  let block = changetype<BLOCK>(offset);
  let ptr = offset + BLOCK_OVERHEAD;
  let payloadSize = computeSize(size);
  maybeGrowMemory(ptr + payloadSize);
  block.mmInfo = payloadSize;
  return ptr;
}

// @ts-ignore: decorator
@unsafe @global
export function __realloc(ptr: usize, size: usize): usize {
  assert(ptr != 0 && !(ptr & AL_MASK)); // must exist and be aligned
  let block = changetype<BLOCK>(ptr - BLOCK_OVERHEAD);
  let actualSize = block.mmInfo;
  let isLast = ptr + actualSize == offset;
  let payloadSize = computeSize(size);
  if (size > actualSize) {
    if (isLast) { // last block: grow
      if (size > BLOCK_MAXSIZE) throw new Error(E_ALLOCATION_TOO_LARGE);
      maybeGrowMemory(ptr + payloadSize);
      block.mmInfo = payloadSize;
    } else { // copy to new block at least double the size
      let newPtr = __alloc(max<usize>(payloadSize, actualSize << 1));
      memory.copy(newPtr, ptr, actualSize);
      block = changetype<BLOCK>((ptr = newPtr) - BLOCK_OVERHEAD);
    }
  } else if (isLast) { // last block: shrink
    offset = ptr + payloadSize;
    block.mmInfo = payloadSize;
  }
  return ptr;
}

// @ts-ignore: decorator
@unsafe @global
export function __free(ptr: usize): void {
  assert(ptr != 0 && !(ptr & AL_MASK)); // must exist and be aligned
  let block = changetype<BLOCK>(ptr - BLOCK_OVERHEAD);
  if (ptr + block.mmInfo == offset) { // last block: discard
    offset = changetype<usize>(block);
  }
}

// @ts-ignore: decorator
@unsafe @global
export function __reset(): void { // special
  offset = startOffset;
}

// @ts-ignore: decorator
@unsafe @global
export function __new(size: usize, id: u32): usize {
  if (size > OBJECT_MAXSIZE) throw new Error(E_ALLOCATION_TOO_LARGE);
  let ptr = __alloc(OBJECT_OVERHEAD + size);
  let object = changetype<OBJECT>(ptr - BLOCK_OVERHEAD);
  object.gcInfo = 0;
  object.gcInfo2 = 0;
  object.rtId = id;
  object.rtSize = <u32>size;
  return ptr + OBJECT_OVERHEAD;
}

// @ts-ignore: decorator
@unsafe @global
export function __renew(oldPtr: usize, size: usize): usize {
  if (size > OBJECT_MAXSIZE) throw new Error(E_ALLOCATION_TOO_LARGE);
  let newPtr = __realloc(oldPtr - OBJECT_OVERHEAD, OBJECT_OVERHEAD + size);
  changetype<OBJECT>(newPtr - BLOCK_OVERHEAD).rtSize = <u32>size;
  return newPtr + OBJECT_OVERHEAD;
}

// @ts-ignore: decorator
@global @unsafe
export function __link(parentPtr: usize, childPtr: usize, expectMultiple: bool): void {
  // nop
}

// @ts-ignore: decorator
@global @unsafe
export function __pin(ptr: usize): usize {
  return ptr;
}

// @ts-ignore: decorator
@global @unsafe
export function __unpin(ptr: usize): void {
  // nop
}

// @ts-ignore: decorator
@global @unsafe
function __visit(ptr: usize, cookie: u32): void { // eslint-disable-line @typescript-eslint/no-unused-vars
  // nop
}

// @ts-ignore: decorator
@global @unsafe
export function __collect(): void {
  // nop
}
`,"rt/tcms":`import { BLOCK, BLOCK_OVERHEAD, OBJECT_OVERHEAD, OBJECT_MAXSIZE, TOTAL_OVERHEAD, DEBUG, TRACE, RTRACE } from "./common";
import { onvisit, oncollect } from "./rtrace";
import { E_ALLOCATION_TOO_LARGE, E_ALREADY_PINNED, E_NOT_PINNED } from "../util/error";

// === TCMS: A Two-Color Mark & Sweep garbage collector ===

// \u2552\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2564\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 Colors \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2555
// \u2502 Color       \u2502 Meaning                                         \u2502
// \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
// \u2502 WHITE*      \u2502 Unreachable                                     \u2502
// \u2502 BLACK*      \u2502 Reachable                                       \u2502
// \u2502 TRANSPARENT \u2502 Manually pinned (always reachable)              \u2502
// \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518
// * flipped between cycles

// @ts-ignore: decorator
@lazy let white = 0;
// @ts-ignore: decorator
@inline const transparent = 3;
// @ts-ignore: decorator
@inline const COLOR_MASK = 3;

/** Size in memory of all objects currently managed by the GC. */
// @ts-ignore: decorator
@lazy let total: usize = 0;

// @ts-ignore: decorator
@lazy let fromSpace = initLazy(changetype<Object>(memory.data(offsetof<Object>())));
// @ts-ignore: decorator
@lazy let toSpace = initLazy(changetype<Object>(memory.data(offsetof<Object>())));
// @ts-ignore: decorator
@lazy let pinSpace = initLazy(changetype<Object>(memory.data(offsetof<Object>())));

function initLazy(space: Object): Object {
  space.nextWithColor = changetype<usize>(space);
  space.prev = space;
  return space;
}

/** Visit cookie indicating scanning of an object. */
// @ts-ignore: decorator
@inline const VISIT_SCAN = 0;

// \u2552\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 Managed object layout (32-bit) \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2555
//    3                   2                   1
//  1 0 9 8 7 6 5 4 3 2 1 0 9 8 7 6 5 4 3 2 1 0 9 8 7 6 5 4 3 2 1 0  bits
// \u251C\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2524
// \u2502                      Memory manager block                     \u2502
// \u255E\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2564\u2550\u2550\u2550\u2561
// \u2502                              next                         \u2502 C \u2502 = nextWithColor
// \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2524
// \u2502                              prev                             \u2502
// \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
// \u2502                              rtId                             \u2502
// \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
// \u2502                              rtSize                           \u2502
// \u255E>ptr\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2561
// \u2502                               ...                             \u2502
// C: color

/** Represents a managed object in memory, consisting of a header followed by the object's data. */
@unmanaged class Object extends BLOCK {
  /** Pointer to the next object with color flags stored in the alignment bits. */
  nextWithColor: usize; // *u32
  /** Pointer to the previous object. */
  prev: Object; // *u32
  /** Runtime id. */
  rtId: u32;
  /** Runtime size. */
  rtSize: u32;

  /** Gets the pointer to the next object. */
  get next(): Object {
    return changetype<Object>(this.nextWithColor & ~COLOR_MASK);
  }

  /** Sets the pointer to the next object. */
  set next(obj: Object) {
    this.nextWithColor = changetype<usize>(obj) | (this.nextWithColor & COLOR_MASK);
  }

  /** Gets this object's color. */
  get color(): i32 {
    return i32(this.nextWithColor & COLOR_MASK);
  }

  /** Sets this object's color. */
  set color(color: i32) {
    this.nextWithColor = (this.nextWithColor & ~COLOR_MASK) | color;
  }

  /** Gets the size of this object in memory. */
  get size(): usize {
    return BLOCK_OVERHEAD + (this.mmInfo & ~3);
  }

  /** Unlinks this object from its list. */
  unlink(): void {
    let next = this.next;
    if (next == null) {
      if (DEBUG) assert(this.prev == null && changetype<usize>(this) < __heap_base);
      return; // static data not yet linked
    }
    let prev = this.prev;
    if (DEBUG) assert(prev);
    next.prev = prev;
    prev.next = next;
  }

  /** Links this object to the specified list, with the given color. */
  linkTo(list: Object, withColor: i32): void {
    let prev = list.prev;
    this.nextWithColor = changetype<usize>(list) | withColor;
    this.prev = prev;
    prev.next = this;
    list.prev = this;
  }
}

// Garbage collector interface

// @ts-ignore: decorator
@global @unsafe
export function __new(size: usize, id: i32): usize {
  if (size > OBJECT_MAXSIZE) throw new Error(E_ALLOCATION_TOO_LARGE);
  let obj = changetype<Object>(__alloc(OBJECT_OVERHEAD + size) - BLOCK_OVERHEAD);
  obj.rtId = id;
  obj.rtSize = <u32>size;
  obj.linkTo(fromSpace, white);
  total += obj.size;
  return changetype<usize>(obj) + TOTAL_OVERHEAD;
}

// @ts-ignore: decorator
@global @unsafe
export function __renew(oldPtr: usize, size: usize): usize {
  let oldObj = changetype<Object>(oldPtr - TOTAL_OVERHEAD);
  if (oldPtr < __heap_base) { // move to heap for simplicity
    let newPtr = __new(size, oldObj.rtId);
    memory.copy(newPtr, oldPtr, min(size, oldObj.rtSize));
    return newPtr;
  }
  if (size > OBJECT_MAXSIZE) throw new Error(E_ALLOCATION_TOO_LARGE);
  total -= oldObj.size;
  let newPtr = __realloc(oldPtr - OBJECT_OVERHEAD, OBJECT_OVERHEAD + size) + OBJECT_OVERHEAD;
  let newObj = changetype<Object>(newPtr - TOTAL_OVERHEAD);
  newObj.rtSize = <u32>size;

  // Replace with new object
  newObj.next.prev = newObj;
  newObj.prev.next = newObj;

  total += newObj.size;
  return newPtr;
}

// @ts-ignore: decorator
@global @unsafe
export function __link(parentPtr: usize, childPtr: usize, expectMultiple: bool): void {
  // nop
}

// @ts-ignore: decorator
@global @unsafe
export function __visit(ptr: usize, cookie: i32): void {
  if (!ptr) return;
  let obj = changetype<Object>(ptr - TOTAL_OVERHEAD);
  if (RTRACE) if (!onvisit(obj)) return;
  if (obj.color == white) {
    obj.unlink(); // from fromSpace
    obj.linkTo(toSpace, i32(!white));
  }
}

// @ts-ignore: decorator
@global @unsafe
export function __pin(ptr: usize): usize {
  if (ptr) {
    let obj = changetype<Object>(ptr - TOTAL_OVERHEAD);
    if (obj.color == transparent) {
      throw new Error(E_ALREADY_PINNED);
    }
    obj.unlink(); // from fromSpace
    obj.linkTo(pinSpace, transparent);
  }
  return ptr;
}

// @ts-ignore: decorator
@global @unsafe
export function __unpin(ptr: usize): void {
  if (!ptr) return;
  let obj = changetype<Object>(ptr - TOTAL_OVERHEAD);
  if (obj.color != transparent) {
    throw new Error(E_NOT_PINNED);
  }
  obj.unlink(); // from pinSpace
  obj.linkTo(fromSpace, white);
}

// @ts-ignore: decorator
@global @unsafe
export function __collect(): void {
  if (TRACE) trace("GC at", 1, total);

  // Mark roots (add to toSpace)
  __visit_globals(VISIT_SCAN);

  // Mark direct members of pinned objects (add to toSpace)
  let pn = pinSpace;
  let iter = pn.next;
  while (iter != pn) {
    if (DEBUG) assert(iter.color == transparent);
    __visit_members(changetype<usize>(iter) + TOTAL_OVERHEAD, VISIT_SCAN);
    iter = iter.next;
  }

  // Mark what's reachable from toSpace
  let black = i32(!white);
  let to = toSpace;
  iter = to.next;
  while (iter != to) {
    if (DEBUG) assert(iter.color == black);
    __visit_members(changetype<usize>(iter) + TOTAL_OVERHEAD, VISIT_SCAN);
    iter = iter.next;
  }

  // Sweep what's left in fromSpace
  let from = fromSpace;
  iter = from.next;
  while (iter != from) {
    if (DEBUG) assert(iter.color == white);
    let newNext = iter.next;
    if (changetype<usize>(iter) < __heap_base) {
      iter.nextWithColor = 0; // may become linked again
      iter.prev = changetype<Object>(0);
    } else {
      total -= iter.size;
      if (isDefined(__finalize)) __finalize(changetype<usize>(iter) + TOTAL_OVERHEAD);
      __free(changetype<usize>(iter) + BLOCK_OVERHEAD);
    }
    iter = newNext;
  }
  from.nextWithColor = changetype<usize>(from);
  from.prev = from;

  // Flip spaces and colors
  fromSpace = to;
  toSpace = from;
  white = black;

  if (TRACE) trace("GC done at", 1, total);
  if (RTRACE) oncollect(total);
}
`,"rt/tlsf":`import { AL_BITS, AL_SIZE, AL_MASK, DEBUG, BLOCK, BLOCK_OVERHEAD, BLOCK_MAXSIZE } from "./common";
import { oninit, onalloc, onresize, onmove, onfree } from "./rtrace";
import { E_ALLOCATION_TOO_LARGE } from "../util/error";

// === The TLSF (Two-Level Segregate Fit) memory allocator ===
// see: http://www.gii.upv.es/tlsf/

// - \`ffs(x)\` is equivalent to \`ctz(x)\` with x != 0
// - \`fls(x)\` is equivalent to \`sizeof(x) * 8 - clz(x) - 1\`

// \u2552\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 Block size interpretation (32-bit) \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2555
//    3                   2                   1
//  1 0 9 8 7 6 5 4 3 2 1 0 9 8 7 6 5 4 3 2 1 0 9 8 7 6 5 4 3 2 1 0  bits
// \u251C\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u253C\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u256B\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2524
// \u2502 |                    FL                       \u2502 SB = SL + AL  \u2502 \u25C4\u2500 usize
// \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2568\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518
// FL: first level, SL: second level, AL: alignment, SB: small block

// @ts-ignore: decorator
@inline const SL_BITS: u32 = 4;
// @ts-ignore: decorator
@inline const SL_SIZE: u32 = 1 << SL_BITS;

// @ts-ignore: decorator
@inline const SB_BITS: u32 = SL_BITS + AL_BITS;
// @ts-ignore: decorator
@inline const SB_SIZE: u32 = 1 << SB_BITS;

// @ts-ignore: decorator
@inline const FL_BITS: u32 = 31 - SB_BITS;

// [00]: < 256B (SB)  [12]: < 1M
// [01]: < 512B       [13]: < 2M
// [02]: < 1K         [14]: < 4M
// [03]: < 2K         [15]: < 8M
// [04]: < 4K         [16]: < 16M
// [05]: < 8K         [17]: < 32M
// [06]: < 16K        [18]: < 64M
// [07]: < 32K        [19]: < 128M
// [08]: < 64K        [20]: < 256M
// [09]: < 128K       [21]: < 512M
// [10]: < 256K       [22]: <= 1G - OVERHEAD
// [11]: < 512K
// VMs limit to 2GB total (currently), making one 1G block max (or three 512M etc.) due to block overhead

// Tags stored in otherwise unused alignment bits

// @ts-ignore: decorator
@inline const FREE: usize = 1 << 0;
// @ts-ignore: decorator
@inline const LEFTFREE: usize = 1 << 1;
// @ts-ignore: decorator
@inline const TAGS_MASK: usize = FREE | LEFTFREE; // <= AL_MASK

// \u2552\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 Block layout (32-bit) \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2555
//    3                   2                   1
//  1 0 9 8 7 6 5 4 3 2 1 0 9 8 7 6 5 4 3 2 1 0 9 8 7 6 5 4 3 2 1 0  bits
// \u251C\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u253C\u2500\u253C\u2500\u2524            \u2510
// \u2502                          size                             \u2502L\u2502F\u2502 \u25C4\u2500\u2510 info   overhead
// \u255E>ptr\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2567\u2550\u2567\u2550\u2561   \u2502        \u2518
// \u2502                        if free: \u25C4 prev                        \u2502 \u25C4\u2500\u2524 usize
// \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524   \u2502
// \u2502                        if free: next \u25BA                        \u2502 \u25C4\u2500\u2524
// \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524   \u2502
// \u2502                             ...                               \u2502   \u2502 >= 0
// \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524   \u2502
// \u2502                        if free: back \u25B2                        \u2502 \u25C4\u2500\u2518
// \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518 >= MIN SIZE
// F: FREE, L: LEFTFREE
@unmanaged export class Block extends BLOCK {

  /** Previous free block, if any. Only valid if free, otherwise part of payload. */
  prev: Block | null;
  /** Next free block, if any. Only valid if free, otherwise part of payload. */
  next: Block | null;

  // If the block is free, there is a 'back'reference at its end pointing at its start.
}

// Block constants. A block must have a minimum size of three pointers so it can hold \`prev\`,
// \`next\` and \`back\` if free.

// @ts-ignore: decorator
@inline const BLOCK_MINSIZE: usize = ((3 * sizeof<usize>() + BLOCK_OVERHEAD + AL_MASK) & ~AL_MASK) - BLOCK_OVERHEAD; // prev + next + back
// @ts-ignore: decorator
// @inline const BLOCK_MAXSIZE: usize = 1 << (FL_BITS + SB_BITS - 1); // exclusive, lives in common.ts

/** Gets the left block of a block. Only valid if the left block is free. */
// @ts-ignore: decorator
@inline function GETFREELEFT(block: Block): Block {
  return load<Block>(changetype<usize>(block) - sizeof<usize>());
}

/** Gets the right block of a block by advancing to the right by its size. */
// @ts-ignore: decorator
@inline function GETRIGHT(block: Block): Block {
  return changetype<Block>(changetype<usize>(block) + BLOCK_OVERHEAD + (block.mmInfo & ~TAGS_MASK));
}

// \u2552\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 Root layout (32-bit) \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2555
//    3                   2                   1
//  1 0 9 8 7 6 5 4 3 2 1 0 9 8 7 6 5 4 3 2 1 0 9 8 7 6 5 4 3 2 1 0  bits
// \u251C\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2524          \u2510
// \u2502        0        |           flMap                            S\u2502 \u25C4\u2500\u2500\u2500\u2500\u2510
// \u255E\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2561      \u2502
// \u2502                           slMap[0] S                          \u2502 \u25C4\u2500\u2510  \u2502
// \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524   \u2502  \u2502
// \u2502                           slMap[1]                            \u2502 \u25C4\u2500\u2524  \u2502
// \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524  u32 \u2502
// \u2502                           slMap[22]                           \u2502 \u25C4\u2500\u2518  \u2502
// \u255E\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2561    usize
// \u2502                            head[0]                            \u2502 \u25C4\u2500\u2500\u2500\u2500\u2524
// \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524      \u2502
// \u2502                              ...                              \u2502 \u25C4\u2500\u2500\u2500\u2500\u2524
// \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524      \u2502
// \u2502                           head[367]                           \u2502 \u25C4\u2500\u2500\u2500\u2500\u2524
// \u255E\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2561      \u2502
// \u2502                             tail                              \u2502 \u25C4\u2500\u2500\u2500\u2500\u2518
// \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518   SIZE   \u2518
// S: Small blocks map
@unmanaged class Root {
  /** First level bitmap. */
  flMap: usize;
}

// Root constants. Where stuff is stored inside of the root structure.

// @ts-ignore: decorator
@inline const SL_START: usize = sizeof<usize>();
// @ts-ignore: decorator
@inline const SL_END: usize = SL_START + (FL_BITS << alignof<u32>());
// @ts-ignore: decorator
@inline const HL_START: usize = (SL_END + AL_MASK) & ~AL_MASK;
// @ts-ignore: decorator
@inline const HL_END: usize = HL_START + FL_BITS * SL_SIZE * sizeof<usize>();
// @ts-ignore: decorator
@inline const ROOT_SIZE: usize = HL_END + sizeof<usize>();

// @ts-ignore: decorator
@lazy export let ROOT: Root = changetype<Root>(0); // unsafe initializion below

/** Gets the second level map of the specified first level. */
// @ts-ignore: decorator
@inline function GETSL(root: Root, fl: usize): u32 {
  return load<u32>(
    changetype<usize>(root) + (fl << alignof<u32>()),
    SL_START
  );
}

/** Sets the second level map of the specified first level. */
// @ts-ignore: decorator
@inline function SETSL(root: Root, fl: usize, slMap: u32): void {
  store<u32>(
    changetype<usize>(root) + (fl << alignof<u32>()),
    slMap,
    SL_START
  );
}

/** Gets the head of the free list for the specified combination of first and second level. */
// @ts-ignore: decorator
@inline function GETHEAD(root: Root, fl: usize, sl: u32): Block | null {
  return load<Block>(
    changetype<usize>(root) + (((fl << SL_BITS) + <usize>sl) << alignof<usize>()),
    HL_START
  );
}

/** Sets the head of the free list for the specified combination of first and second level. */
// @ts-ignore: decorator
@inline function SETHEAD(root: Root, fl: usize, sl: u32, head: Block | null): void {
  store<Block | null>(
    changetype<usize>(root) + (((fl << SL_BITS) + <usize>sl) << alignof<usize>()),
    head,
    HL_START
  );
}

/** Gets the tail block.. */
// @ts-ignore: decorator
@inline function GETTAIL(root: Root): Block {
  return load<Block>(
    changetype<usize>(root),
    HL_END
  );
}

/** Sets the tail block. */
// @ts-ignore: decorator
@inline function SETTAIL(root: Root, tail: Block): void {
  store<Block>(
    changetype<usize>(root),
    tail,
    HL_END
  );
}

/** Inserts a previously used block back into the free list. */
function insertBlock(root: Root, block: Block): void {
  if (DEBUG) assert(block); // cannot be null
  let blockInfo = block.mmInfo;
  if (DEBUG) assert(blockInfo & FREE); // must be free

  let right = GETRIGHT(block);
  let rightInfo = right.mmInfo;

  // merge with right block if also free
  if (rightInfo & FREE) {
    removeBlock(root, right);
    block.mmInfo = blockInfo = blockInfo + BLOCK_OVERHEAD + (rightInfo & ~TAGS_MASK); // keep block tags
    right = GETRIGHT(block);
    rightInfo = right.mmInfo;
    // 'back' is set below
  }

  // merge with left block if also free
  if (blockInfo & LEFTFREE) {
    let left = GETFREELEFT(block);
    let leftInfo = left.mmInfo;
    if (DEBUG) assert(leftInfo & FREE); // must be free according to right tags
    removeBlock(root, left);
    block = left;
    block.mmInfo = blockInfo = leftInfo + BLOCK_OVERHEAD + (blockInfo & ~TAGS_MASK); // keep left tags
    // 'back' is set below
  }

  right.mmInfo = rightInfo | LEFTFREE;
  // reference to right is no longer used now, hence rightInfo is not synced

  // we now know the size of the block
  let size = blockInfo & ~TAGS_MASK;
  if (DEBUG) assert(size >= BLOCK_MINSIZE); // must be a valid size
  if (DEBUG) assert(changetype<usize>(block) + BLOCK_OVERHEAD + size == changetype<usize>(right)); // must match

  // set 'back' to itself at the end of block
  store<Block>(changetype<usize>(right) - sizeof<usize>(), block);

  // mapping_insert
  let fl: usize, sl: u32;
  if (size < SB_SIZE) {
    fl = 0;
    sl = <u32>(size >> AL_BITS);
  } else {
    const inv: usize = sizeof<usize>() * 8 - 1;
    let boundedSize = min(size, BLOCK_MAXSIZE);
    fl = inv - clz<usize>(boundedSize);
    sl = <u32>((boundedSize >> (fl - SL_BITS)) ^ (1 << SL_BITS));
    fl -= SB_BITS - 1;
  }
  if (DEBUG) assert(fl < FL_BITS && sl < SL_SIZE); // fl/sl out of range

  // perform insertion
  let head = GETHEAD(root, fl, sl);
  block.prev = null;
  block.next = head;
  if (head) head.prev = block;
  SETHEAD(root, fl, sl, block);

  // update first and second level maps
  root.flMap |= (1 << fl);
  SETSL(root, fl, GETSL(root, fl) | (1 << sl));
}

/** Removes a free block from internal lists. */
function removeBlock(root: Root, block: Block): void {
  let blockInfo = block.mmInfo;
  if (DEBUG) assert(blockInfo & FREE); // must be free
  let size = blockInfo & ~TAGS_MASK;
  if (DEBUG) assert(size >= BLOCK_MINSIZE); // must be valid

  // mapping_insert
  let fl: usize, sl: u32;
  if (size < SB_SIZE) {
    fl = 0;
    sl = <u32>(size >> AL_BITS);
  } else {
    const inv: usize = sizeof<usize>() * 8 - 1;
    let boundedSize = min(size, BLOCK_MAXSIZE);
    fl = inv - clz<usize>(boundedSize);
    sl = <u32>((boundedSize >> (fl - SL_BITS)) ^ (1 << SL_BITS));
    fl -= SB_BITS - 1;
  }
  if (DEBUG) assert(fl < FL_BITS && sl < SL_SIZE); // fl/sl out of range

  // link previous and next free block
  let prev = block.prev;
  let next = block.next;
  if (prev) prev.next = next;
  if (next) next.prev = prev;

  // update head if we are removing it
  if (block == GETHEAD(root, fl, sl)) {
    SETHEAD(root, fl, sl, next);

    // clear second level map if head is empty now
    if (!next) {
      let slMap = GETSL(root, fl);
      SETSL(root, fl, slMap &= ~(1 << sl));

      // clear first level map if second level is empty now
      if (!slMap) root.flMap &= ~(1 << fl);
    }
  }
  // note: does not alter left/back because it is likely that splitting
  // is performed afterwards, invalidating those changes. so, the caller
  // must perform those updates.
}

function roundSize(size: usize): usize {
  const halfMaxSize = BLOCK_MAXSIZE >> 1; // don't round last fl
  const inv: usize = sizeof<usize>() * 8 - 1;
  const invRound = inv - SL_BITS;
  return size < halfMaxSize
    ? size + (1 << (invRound - clz<usize>(size))) - 1
    : size;
}

/** Searches for a free block of at least the specified size. */
function searchBlock(root: Root, size: usize): Block | null {
  // size was already asserted by caller

  // mapping_search
  let fl: usize, sl: u32;
  if (size < SB_SIZE) {
    fl = 0;
    sl = <u32>(size >> AL_BITS);
  } else {
    const requestSize = roundSize(size);
    fl = sizeof<usize>() * 8 - 1 - clz<usize>(requestSize);
    sl = <u32>((requestSize >> (fl - SL_BITS)) ^ (1 << SL_BITS));
    fl -= SB_BITS - 1;
  }
  if (DEBUG) assert(fl < FL_BITS && sl < SL_SIZE); // fl/sl out of range

  // search second level
  let slMap = GETSL(root, fl) & (~0 << sl);
  let head: Block | null = null;
  if (!slMap) {
    // search next larger first level
    let flMap = root.flMap & (~0 << (fl + 1));
    if (!flMap) {
      head = null;
    } else {
      fl = ctz<usize>(flMap);
      slMap = GETSL(root, fl);
      if (DEBUG) assert(slMap);  // can't be zero if fl points here
      head = GETHEAD(root, fl, ctz<u32>(slMap));
    }
  } else {
    head = GETHEAD(root, fl, ctz<u32>(slMap));
  }
  return head;
}

/** Prepares the specified block before (re-)use, possibly splitting it. */
function prepareBlock(root: Root, block: Block, size: usize): void {
  // size was already asserted by caller

  let blockInfo = block.mmInfo;
  if (DEBUG) assert(!((size + BLOCK_OVERHEAD) & AL_MASK)); // size must be aligned so the new block is

  // split if the block can hold another MINSIZE block incl. overhead
  let remaining = (blockInfo & ~TAGS_MASK) - size;
  if (remaining >= BLOCK_OVERHEAD + BLOCK_MINSIZE) {
    block.mmInfo = size | (blockInfo & LEFTFREE); // also discards FREE

    let spare = changetype<Block>(changetype<usize>(block) + BLOCK_OVERHEAD + size);
    spare.mmInfo = (remaining - BLOCK_OVERHEAD) | FREE; // not LEFTFREE
    insertBlock(root, spare); // also sets 'back'

  // otherwise tag block as no longer FREE and right as no longer LEFTFREE
  } else {
    block.mmInfo = blockInfo & ~FREE;
    GETRIGHT(block).mmInfo &= ~LEFTFREE;
  }
}

/** Adds more memory to the pool. */
function addMemory(root: Root, start: usize, endU64: u64): bool {
  let end = <usize>endU64;
  if (DEBUG) assert(<u64>start <= endU64); // must be valid
  start = ((start + BLOCK_OVERHEAD + AL_MASK) & ~AL_MASK) - BLOCK_OVERHEAD;
  end &= ~AL_MASK;

  let tail = GETTAIL(root);
  let tailInfo: usize = 0;
  if (tail) { // more memory
    if (DEBUG) assert(start >= changetype<usize>(tail) + BLOCK_OVERHEAD);

    // merge with current tail if adjacent
    const offsetToTail = AL_SIZE;
    if (start - offsetToTail == changetype<usize>(tail)) {
      start -= offsetToTail;
      tailInfo = tail.mmInfo;
    } else {
      // We don't do this, but a user might \`memory.grow\` manually
      // leading to non-adjacent pages managed by TLSF.
    }

  } else if (DEBUG) { // first memory
    assert(start >= changetype<usize>(root) + ROOT_SIZE); // starts after root
  }

  // check if size is large enough for a free block and the tail block
  let size = end - start;
  if (size < BLOCK_OVERHEAD + BLOCK_MINSIZE + BLOCK_OVERHEAD) {
    return false;
  }

  // left size is total minus its own and the zero-length tail's header
  let leftSize = size - 2 * BLOCK_OVERHEAD;
  let left = changetype<Block>(start);
  left.mmInfo = leftSize | FREE | (tailInfo & LEFTFREE);
  left.prev = null;
  left.next = null;

  // tail is a zero-length used block
  tail = changetype<Block>(start + BLOCK_OVERHEAD + leftSize);
  tail.mmInfo = 0 | LEFTFREE;
  SETTAIL(root, tail);

  insertBlock(root, left); // also merges with free left before tail / sets 'back'

  return true;
}

/** Grows memory to fit at least another block of the specified size. */
function growMemory(root: Root, size: usize): void {
  if (ASC_LOW_MEMORY_LIMIT) {
    unreachable();
    return;
  }
  // Here, both rounding performed in searchBlock ...
  if (size >= SB_SIZE) {
    size = roundSize(size);
  }
  // and additional BLOCK_OVERHEAD must be taken into account. If we are going
  // to merge with the tail block, that's one time, otherwise it's two times.
  let pagesBefore = memory.size();
  size += BLOCK_OVERHEAD << usize((<usize>pagesBefore << 16) - BLOCK_OVERHEAD != changetype<usize>(GETTAIL(root)));
  let pagesNeeded = <i32>(((size + 0xffff) & ~0xffff) >>> 16);
  let pagesWanted = max(pagesBefore, pagesNeeded); // double memory
  if (memory.grow(pagesWanted) < 0) {
    if (memory.grow(pagesNeeded) < 0) unreachable();
  }
  let pagesAfter = memory.size();
  addMemory(root, <usize>pagesBefore << 16, <u64>pagesAfter << 16);
}

/** Computes the size (excl. header) of a block. */
function computeSize(size: usize): usize {
  // Size must be large enough and aligned minus preceeding overhead
  return size <= BLOCK_MINSIZE
    ? BLOCK_MINSIZE
    : ((size + BLOCK_OVERHEAD + AL_MASK) & ~AL_MASK) - BLOCK_OVERHEAD;
}

/** Prepares and checks an allocation size. */
function prepareSize(size: usize): usize {
  if (size > BLOCK_MAXSIZE) throw new Error(E_ALLOCATION_TOO_LARGE);
  return computeSize(size);
}

/** Initializes the root structure. */
function initialize(): void {
  if (isDefined(ASC_RTRACE)) oninit(__heap_base);
  let rootOffset = (__heap_base + AL_MASK) & ~AL_MASK;
  let pagesBefore = memory.size();
  let pagesNeeded = <i32>((((rootOffset + ROOT_SIZE) + 0xffff) & ~0xffff) >>> 16);
  if (pagesNeeded > pagesBefore && memory.grow(pagesNeeded - pagesBefore) < 0) unreachable();
  let root = changetype<Root>(rootOffset);
  root.flMap = 0;
  SETTAIL(root, changetype<Block>(0));
  for (let fl: usize = 0; fl < FL_BITS; ++fl) {
    SETSL(root, fl, 0);
    for (let sl: u32 = 0; sl < SL_SIZE; ++sl) {
      SETHEAD(root, fl, sl, null);
    }
  }
  let memStart = rootOffset + ROOT_SIZE;
  if (ASC_LOW_MEMORY_LIMIT) {
    const memEnd = <u64>ASC_LOW_MEMORY_LIMIT & ~AL_MASK;
    if (memStart <= memEnd) addMemory(root, memStart, memEnd);
    else unreachable(); // low memory limit already exceeded
  } else {
    addMemory(root, memStart, <u64>memory.size() << 16);
  }
  ROOT = root;
}

/** Allocates a block of the specified size. */
export function allocateBlock(root: Root, size: usize): Block {
  let payloadSize = prepareSize(size);
  let block = searchBlock(root, payloadSize);
  if (!block) {
    growMemory(root, payloadSize);
    block = changetype<Block>(searchBlock(root, payloadSize));
    if (DEBUG) assert(block); // must be found now
  }
  if (DEBUG) assert((block.mmInfo & ~TAGS_MASK) >= payloadSize); // must fit
  removeBlock(root, block);
  prepareBlock(root, block, payloadSize);
  if (isDefined(ASC_RTRACE)) onalloc(block);
  return block;
}

/** Reallocates a block to the specified size. */
export function reallocateBlock(root: Root, block: Block, size: usize): Block {
  let payloadSize = prepareSize(size);
  let blockInfo = block.mmInfo;
  let blockSize = blockInfo & ~TAGS_MASK;

  // possibly split and update runtime size if it still fits
  if (payloadSize <= blockSize) {
    prepareBlock(root, block, payloadSize);
    if (isDefined(ASC_RTRACE)) {
      if (payloadSize != blockSize) onresize(block, BLOCK_OVERHEAD + blockSize);
    }
    return block;
  }

  // merge with right free block if merger is large enough
  let right = GETRIGHT(block);
  let rightInfo = right.mmInfo;
  if (rightInfo & FREE) {
    let mergeSize = blockSize + BLOCK_OVERHEAD + (rightInfo & ~TAGS_MASK);
    if (mergeSize >= payloadSize) {
      removeBlock(root, right);
      block.mmInfo = (blockInfo & TAGS_MASK) | mergeSize;
      prepareBlock(root, block, payloadSize);
      if (isDefined(ASC_RTRACE)) onresize(block, BLOCK_OVERHEAD + blockSize);
      return block;
    }
  }

  // otherwise move the block
  return moveBlock(root, block, size);
}

/** Moves a block to a new one of the specified size. */
function moveBlock(root: Root, block: Block, newSize: usize): Block {
  let newBlock = allocateBlock(root, newSize);
  memory.copy(changetype<usize>(newBlock) + BLOCK_OVERHEAD, changetype<usize>(block) + BLOCK_OVERHEAD, block.mmInfo & ~TAGS_MASK);
  if (changetype<usize>(block) >= __heap_base) {
    if (isDefined(ASC_RTRACE)) onmove(block, newBlock);
    freeBlock(root, block);
  }
  return newBlock;
}

/** Frees a block. */
export function freeBlock(root: Root, block: Block): void {
  if (isDefined(ASC_RTRACE)) onfree(block);
  block.mmInfo = block.mmInfo | FREE;
  insertBlock(root, block);
}

/** Checks that a used block is valid to be freed or reallocated. */
function checkUsedBlock(ptr: usize): Block {
  let block = changetype<Block>(ptr - BLOCK_OVERHEAD);
  assert(
    ptr != 0 && !(ptr & AL_MASK) &&  // must exist and be aligned
    !(block.mmInfo & FREE)           // must be used
  );
  return block;
}

// @ts-ignore: decorator
@global @unsafe
export function __alloc(size: usize): usize {
  if (!ROOT) initialize();
  return changetype<usize>(allocateBlock(ROOT, size)) + BLOCK_OVERHEAD;
}

// @ts-ignore: decorator
@global @unsafe
export function __realloc(ptr: usize, size: usize): usize {
  if (!ROOT) initialize();
  return (ptr < __heap_base
    ? changetype<usize>(moveBlock(ROOT, checkUsedBlock(ptr), size))
    : changetype<usize>(reallocateBlock(ROOT, checkUsedBlock(ptr), size))
  ) + BLOCK_OVERHEAD;
}

// @ts-ignore: decorator
@global @unsafe
export function __free(ptr: usize): void {
  if (ptr < __heap_base) return;
  if (!ROOT) initialize();
  freeBlock(ROOT, checkUsedBlock(ptr));
}
`,set:`/// <reference path="./rt/index.d.ts" />

import { HASH } from "./util/hash";

// A deterministic hash set based on CloseTable from https://github.com/jorendorff/dht

// @ts-ignore: decorator
@inline const INITIAL_CAPACITY = 4;

// @ts-ignore: decorator
@inline const FILL_FACTOR_N = 8;

// @ts-ignore: decorator
@inline const FILL_FACTOR_D = 3;

// @ts-ignore: decorator
@inline const FREE_FACTOR_N = 3;

// @ts-ignore: decorator
@inline const FREE_FACTOR_D = 4;

/** Structure of a set entry. */
@unmanaged class SetEntry<K> {
  key: K;
  taggedNext: usize; // LSB=1 indicates EMPTY
}

/** Empty bit. */
// @ts-ignore: decorator
@inline const EMPTY: usize = 1 << 0;

/** Size of a bucket. */
// @ts-ignore: decorator
@inline const BUCKET_SIZE = sizeof<usize>();

/** Computes the alignment of an entry. */
// @ts-ignore: decorator
@inline
function ENTRY_ALIGN<T>(): usize {
  // can align to 4 instead of 8 if 32-bit and K is <= 32-bits
  const align = (sizeof<T>() > sizeof<usize>() ? sizeof<T>() : sizeof<usize>()) - 1;
  return align;
}

/** Computes the aligned size of an entry. */
// @ts-ignore: decorator
@inline
function ENTRY_SIZE<T>(): usize {
  const align = ENTRY_ALIGN<T>();
  const size = (offsetof<SetEntry<T>>() + align) & ~align;
  return size;
}

export class Set<T> {

  // buckets referencing their respective first entry, usize[bucketsMask + 1]
  private buckets: ArrayBuffer = new ArrayBuffer(INITIAL_CAPACITY * <i32>BUCKET_SIZE);
  private bucketsMask: u32 = INITIAL_CAPACITY - 1;

  // entries in insertion order, SetEntry<K>[entriesCapacity]
  private entries: ArrayBuffer = new ArrayBuffer(INITIAL_CAPACITY * <i32>ENTRY_SIZE<T>());
  private entriesCapacity: i32 = INITIAL_CAPACITY;
  private entriesOffset: i32 = 0;
  private entriesCount: i32 = 0;

  constructor() {
    /* nop */
  }

  get size(): i32 {
    return this.entriesCount;
  }

  clear(): void {
    this.buckets = new ArrayBuffer(INITIAL_CAPACITY * <i32>BUCKET_SIZE);
    this.bucketsMask = INITIAL_CAPACITY - 1;
    this.entries = new ArrayBuffer(INITIAL_CAPACITY * <i32>ENTRY_SIZE<T>());
    this.entriesCapacity = INITIAL_CAPACITY;
    this.entriesOffset = 0;
    this.entriesCount = 0;
  }

  private find(key: T, hashCode: u32): SetEntry<T> | null {
    let entry = load<SetEntry<T>>( // unmanaged!
      changetype<usize>(this.buckets) + <usize>(hashCode & this.bucketsMask) * BUCKET_SIZE
    );
    while (entry) {
      let taggedNext = entry.taggedNext;
      if (!(taggedNext & EMPTY) && entry.key == key) return entry;
      entry = changetype<SetEntry<T>>(taggedNext & ~EMPTY);
    }
    return null;
  }

  @operator("[]")
  has(key: T): bool {
    return this.find(key, HASH<T>(key)) != null;
  }

  add(key: T): this {
    let hashCode = HASH<T>(key);
    let entry = this.find(key, hashCode); // unmanaged!
    if (!entry) {
      // check if rehashing is necessary
      if (this.entriesOffset == this.entriesCapacity) {
        this.rehash(
          this.entriesCount < this.entriesCapacity * FREE_FACTOR_N / FREE_FACTOR_D
            ?  this.bucketsMask           // just rehash if 1/4+ entries are empty
            : (this.bucketsMask << 1) | 1 // grow capacity to next 2^N
        );
      }
      // append new entry
      entry = changetype<SetEntry<T>>(changetype<usize>(this.entries) + <usize>(this.entriesOffset++) * ENTRY_SIZE<T>());
      entry.key = key;
      if (isManaged<T>()) {
        __link(changetype<usize>(this), changetype<usize>(key), true);
      }
      ++this.entriesCount;
      // link with previous entry in bucket
      let bucketPtrBase = changetype<usize>(this.buckets) + <usize>(hashCode & this.bucketsMask) * BUCKET_SIZE;
      entry.taggedNext = load<usize>(bucketPtrBase);
      store<usize>(bucketPtrBase, changetype<usize>(entry));
    }
    return this;
  }

  @operator("[]=")
  private __set(key: T, value: bool): void {
    if (value) this.add(key);
    else this.delete(key);
  }

  delete(key: T): bool {
    let entry = this.find(key, HASH<T>(key)); // unmanaged!
    if (!entry) return false;
    entry.taggedNext |= EMPTY;
    --this.entriesCount;
    // check if rehashing is appropriate
    let halfBucketsMask = this.bucketsMask >> 1;
    if (
      halfBucketsMask + 1 >= max<u32>(INITIAL_CAPACITY, this.entriesCount) &&
      this.entriesCount < this.entriesCapacity * FREE_FACTOR_N / FREE_FACTOR_D
    ) this.rehash(halfBucketsMask);
    return true;
  }

  private rehash(newBucketsMask: u32): void {
    let newBucketsCapacity = <i32>(newBucketsMask + 1);
    let newBuckets = new ArrayBuffer(newBucketsCapacity * <i32>BUCKET_SIZE);
    let newEntriesCapacity = newBucketsCapacity * FILL_FACTOR_N / FILL_FACTOR_D;
    let newEntries = new ArrayBuffer(newEntriesCapacity * <i32>ENTRY_SIZE<T>());

    // copy old entries to new entries
    let oldPtr = changetype<usize>(this.entries);
    let oldEnd = oldPtr + <usize>this.entriesOffset * ENTRY_SIZE<T>();
    let newPtr = changetype<usize>(newEntries);
    while (oldPtr != oldEnd) {
      let oldEntry = changetype<SetEntry<T>>(oldPtr); // unmanaged!
      if (!(oldEntry.taggedNext & EMPTY)) {
        let newEntry = changetype<SetEntry<T>>(newPtr); // unmanaged!
        let oldEntryKey = oldEntry.key;
        newEntry.key = oldEntryKey;
        let newBucketIndex = HASH<T>(oldEntryKey) & newBucketsMask;
        let newBucketPtrBase = changetype<usize>(newBuckets) + <usize>newBucketIndex * BUCKET_SIZE;
        newEntry.taggedNext = load<usize>(newBucketPtrBase);
        store<usize>(newBucketPtrBase, newPtr);
        newPtr += ENTRY_SIZE<T>();
      }
      oldPtr += ENTRY_SIZE<T>();
    }

    this.buckets = newBuckets;
    this.bucketsMask = newBucketsMask;
    this.entries = newEntries;
    this.entriesCapacity = newEntriesCapacity;
    this.entriesOffset = this.entriesCount;
  }

  values(): T[] {
    // FIXME: this is preliminary, needs iterators/closures
    let start = changetype<usize>(this.entries);
    let size = this.entriesOffset;
    let values = new Array<T>(size);
    let length = 0;
    for (let i = 0; i < size; ++i) {
      let entry = changetype<SetEntry<T>>(start + <usize>i * ENTRY_SIZE<T>());
      if (!(entry.taggedNext & EMPTY)) {
        unchecked(values[length++] = entry.key);
      }
    }
    values.length = length;
    return values;
  }

  toString(): string {
    return "[object Set]";
  }

  // RT integration

  @unsafe private __visit(cookie: u32): void {
    __visit(changetype<usize>(this.buckets), cookie);
    let entries = changetype<usize>(this.entries);
    if (isManaged<T>()) {
      let cur = entries;
      let end = cur + <usize>this.entriesOffset * ENTRY_SIZE<T>();
      while (cur < end) {
        let entry = changetype<SetEntry<T>>(cur);
        if (!(entry.taggedNext & EMPTY)) {
          let val = changetype<usize>(entry.key);
          if (isNullable<T>()) {
            if (val) __visit(val, cookie);
          } else __visit(val, cookie);
        }
        cur += ENTRY_SIZE<T>();
      }
    }
    __visit(entries, cookie);
  }
}
`,"shared/feature":`// This file is shared with the compiler and must remain portable

/** Indicates specific features to activate. */
export const enum Feature {
  /** No additional features. */
  None = 0,
  /** Sign extension operations. */
  SignExtension = 1 << 0, // see: https://github.com/WebAssembly/sign-extension-ops
  /** Mutable global imports and exports. */
  MutableGlobals = 1 << 1, // see: https://github.com/WebAssembly/mutable-global
  /** Non-trapping float to integer operations. */
  NontrappingF2I = 1 << 2, // see: https://github.com/WebAssembly/nontrapping-float-to-int-conversions
  /** Bulk memory operations. */
  BulkMemory = 1 << 3, // see: https://github.com/WebAssembly/bulk-memory-operations
  /** SIMD types and operations. */
  Simd = 1 << 4, // see: https://github.com/WebAssembly/simd
  /** Threading and atomic operations. */
  Threads = 1 << 5, // see: https://github.com/WebAssembly/threads
  /** Exception handling operations. */
  ExceptionHandling = 1 << 6, // see: https://github.com/WebAssembly/exception-handling
  /** Tail call operations. */
  TailCalls = 1 << 7, // see: https://github.com/WebAssembly/tail-call
  /** Reference types. */
  ReferenceTypes = 1 << 8, // see: https://github.com/WebAssembly/reference-types
  /** Multi value types. */
  MultiValue = 1 << 9, // see: https://github.com/WebAssembly/multi-value
  /** Garbage collection. */
  GC = 1 << 10, // see: https://github.com/WebAssembly/gc
  /** Memory64. */
  Memory64 = 1 << 11, // see: https://github.com/WebAssembly/memory64
  /** Relaxed SIMD. */
  RelaxedSimd = 1 << 12, // see: https://github.com/WebAssembly/relaxed-simd
  /** Extended const expressions. */
  ExtendedConst = 1 << 13, // see: https://github.com/WebAssembly/extended-const
  /** Reference typed strings. */
  Strings = 1 << 14, // see: https://github.com/WebAssembly/stringref
  /** Shared-everything threads. */
  SharedEverything = 1 << 15, // see: https://github.com/WebAssembly/shared-everything-threads
  /** All features. */
  All = (1 << 16) - 1
}

/** Gets the name of the specified feature one would specify on the command line. */
export function featureToString(feature: Feature): string {
  switch (feature) {
    case Feature.SignExtension: return "sign-extension";
    case Feature.MutableGlobals: return "mutable-globals";
    case Feature.NontrappingF2I: return "nontrapping-f2i";
    case Feature.BulkMemory: return "bulk-memory";
    case Feature.Simd: return "simd";
    case Feature.Threads: return "threads";
    case Feature.ExceptionHandling: return "exception-handling";
    case Feature.TailCalls: return "tail-calls";
    case Feature.ReferenceTypes: return "reference-types";
    case Feature.MultiValue: return "multi-value";
    case Feature.GC: return "gc";
    case Feature.Memory64: return "memory64";
    case Feature.RelaxedSimd: return "relaxed-simd";
    case Feature.ExtendedConst: return "extended-const";
    case Feature.Strings: return "stringref";
    case Feature.SharedEverything: return "shared-everything";
  }
  assert(false);
  return "";
}
`,"shared/runtime":`// This file is shared with the compiler and must remain portable

/** Runtime types. */
export enum Runtime {
  /** Simple bump allocator without GC. */
  Stub = 0,
  /** Stop the world semi-automatic GC. */
  Minimal = 1,
  /** incremental GC. */
  Incremental = 2,
}
`,"shared/target":`// This file is shared with the compiler and must remain portable

/** Compilation target. */
export enum Target {
  /** Portable. */
  Js = 0,
  /** WebAssembly with 32-bit pointers. */
  Wasm32 = 1,
  /** WebAssembly with 64-bit pointers. Experimental and not supported by any runtime yet. */
  Wasm64 = 2,
}
`,"shared/typeinfo":`// This file is shared with the compiler and must remain portable

// \u2552\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 Typeinfo interpretation \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2555
//    3                   2                   1
//  1 0 9 8 7 6 5 4 3 2 1 0 9 8 7 6 5 4 3 2 1 0 9 8 7 6 5 4 3 2 1 0  bits
// \u251C\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2534\u2500\u2524 \u25C4\u2500 __rtti_base
// \u2502                             count                             \u2502
// \u255E\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2561 \u2510
// \u2502                      Typeinfo#flags [id=0]                    \u2502 id < count
// \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
// \u2502                              ...                              \u2502

/** Runtime type information data structure. */
@unmanaged
export class Typeinfo {
  /** Flags describing the shape of this class type. */
  flags: TypeinfoFlags = TypeinfoFlags.NONE;
}

/** Runtime type information flags. */
export const enum TypeinfoFlags {
  /** No specific flags. */
  NONE = 0,
  /** Type is an \`ArrayBufferView\`. */
  ARRAYBUFFERVIEW = 1 << 0,
  /** Type is an \`Array\`. */
  ARRAY = 1 << 1,
  /** Type is a \`StaticArray\`. */
  STATICARRAY = 1 << 2,
  /** Type is a \`Set\`. */
  SET = 1 << 3,
  /** Type is a \`Map\`. */
  MAP = 1 << 4,
  /** Type has no outgoing pointers. */
  POINTERFREE = 1 << 5,
  /** Value alignment of 1 byte. */
  VALUE_ALIGN_0 = 1 << 6,
  /** Value alignment of 2 bytes. */
  VALUE_ALIGN_1 = 1 << 7,
  /** Value alignment of 4 bytes. */
  VALUE_ALIGN_2 = 1 << 8,
  /** Value alignment of 8 bytes. */
  VALUE_ALIGN_3 = 1 << 9,
  /** Value alignment of 16 bytes. */
  VALUE_ALIGN_4 = 1 << 10,
  /** Value is a signed type. */
  VALUE_SIGNED = 1 << 11,
  /** Value is a float type. */
  VALUE_FLOAT = 1 << 12,
  /** Value type is nullable. */
  VALUE_NULLABLE = 1 << 13,
  /** Value type is managed. */
  VALUE_MANAGED = 1 << 14,
  /** Key alignment of 1 byte. */
  KEY_ALIGN_0 = 1 << 15,
  /** Key alignment of 2 bytes. */
  KEY_ALIGN_1 = 1 << 16,
  /** Key alignment of 4 bytes. */
  KEY_ALIGN_2 = 1 << 17,
  /** Key alignment of 8 bytes. */
  KEY_ALIGN_3 = 1 << 18,
  /** Key alignment of 16 bytes. */
  KEY_ALIGN_4 = 1 << 19,
  /** Key is a signed type. */
  KEY_SIGNED = 1 << 20,
  /** Key is a float type. */
  KEY_FLOAT = 1 << 21,
  /** Key type is nullable. */
  KEY_NULLABLE = 1 << 22,
  /** Key type is managed. */
  KEY_MANAGED = 1 << 23
}
`,staticarray:`/// <reference path="./rt/index.d.ts" />

import { OBJECT, BLOCK_MAXSIZE, TOTAL_OVERHEAD } from "./rt/common";
import { Runtime } from "shared/runtime";
import { COMPARATOR, SORT } from "./util/sort";
import { REVERSE, FILL } from "./util/bytes";
import { idof } from "./builtins";
import { Array } from "./array";
import { E_INDEXOUTOFRANGE, E_INVALIDLENGTH, E_HOLEYARRAY } from "./util/error";
import { joinBooleanArray, joinIntegerArray, joinFloatArray, joinStringArray, joinReferenceArray } from "./util/string";

@final
export class StaticArray<T> {
  [key: number]: T;

  // Note that the interface of StaticArray instances must be a semantically
  // compatible subset of Array<T> in order for syntax highlighting to work
  // properly, for instance when creating static arrays from array literals.
  // The additionally provided static methods take care of dealing with static
  // arrays exclusively, without having to convert to Array<T> first.

  static fromArray<T>(source: Array<T>): StaticArray<T> {
    let length = source.length;
    let outSize = <usize>length << alignof<T>();
    let out = changetype<StaticArray<T>>(__new(outSize, idof<StaticArray<T>>()));
    if (isManaged<T>()) {
      let sourcePtr = source.dataStart;
      for (let i = 0; i < length; ++i) {
        let off = <usize>i << alignof<T>();
        let ref = load<usize>(sourcePtr + off);
        store<usize>(changetype<usize>(out) + off, ref);
        __link(changetype<usize>(out), ref, true);
      }
    } else {
      memory.copy(changetype<usize>(out), source.dataStart, outSize);
    }
    return out;
  }

  /** @deprecated Please use source.concat<StaticArray<T>> instead. */
  static concat<T>(source: StaticArray<T>, other: StaticArray<T>): StaticArray<T> {
    return source.concat<StaticArray<T>>(other);
  }

  /** @deprecated Please use source.slice<StaticArray<T>> instead. */
  static slice<T>(source: StaticArray<T>, start: i32 = 0, end: i32 = i32.MAX_VALUE): StaticArray<T> {
    return source.slice<StaticArray<T>>(start, end);
  }

  constructor(length: i32) {
    if (<u32>length > <u32>BLOCK_MAXSIZE >>> alignof<T>()) throw new RangeError(E_INVALIDLENGTH);
    let outSize = <usize>length << alignof<T>();
    let out = changetype<StaticArray<T>>(__new(outSize, idof<StaticArray<T>>()));
    if (ASC_RUNTIME != Runtime.Incremental) {
      memory.fill(changetype<usize>(out), 0, outSize);
    }
    return out;
  }

  get length(): i32 {
    return changetype<OBJECT>(changetype<usize>(this) - TOTAL_OVERHEAD).rtSize >>> alignof<T>();
  }

  at(index: i32): T {
    let len = this.length;
    index += select(0, len, index >= 0);
    if (<u32>index >= <u32>len) throw new RangeError(E_INDEXOUTOFRANGE);
    let value = load<T>(changetype<usize>(this) + (<usize>index << alignof<T>()));
    if (isReference<T>()) {
      if (!isNullable<T>()) {
        if (!changetype<usize>(value)) throw new Error(E_HOLEYARRAY);
      }
    }
    return value;
  }

  @operator("[]") private __get(index: i32): T {
    if (<u32>index >= <u32>this.length) throw new RangeError(E_INDEXOUTOFRANGE);
    let value = load<T>(changetype<usize>(this) + (<usize>index << alignof<T>()));
    if (isReference<T>()) {
      if (!isNullable<T>()) {
        if (!changetype<usize>(value)) throw new Error(E_HOLEYARRAY);
      }
    }
    return value;
  }

  @unsafe @operator("{}") private __uget(index: i32): T {
    return load<T>(changetype<usize>(this) + (<usize>index << alignof<T>()));
  }

  @operator("[]=") private __set(index: i32, value: T): void {
    if (<u32>index >= <u32>this.length) throw new RangeError(E_INDEXOUTOFRANGE);
    this.__uset(index, value);
  }

  @unsafe @operator("{}=") private __uset(index: i32, value: T): void {
    store<T>(changetype<usize>(this) + (<usize>index << alignof<T>()), value);
    if (isManaged<T>()) {
      __link(changetype<usize>(this), changetype<usize>(value), true);
    }
  }

  fill(value: T, start: i32 = 0, end: i32 = i32.MAX_VALUE): StaticArray<T> {
    if (isManaged<T>()) {
      FILL<usize>(changetype<usize>(this), this.length, changetype<usize>(value), start, end);
      __link(changetype<usize>(this), changetype<usize>(value), false);
    } else {
      FILL<T>(changetype<usize>(this), this.length, value, start, end);
    }
    return this;
  }

  copyWithin(target: i32, start: i32, end: i32 = i32.MAX_VALUE): StaticArray<T> {
    let ptr = changetype<usize>(this);
    let len = this.length;

    end = min<i32>(end, len);

    let to    = target < 0 ? max(len + target, 0) : min(target, len);
    let from  = start < 0 ? max(len + start, 0) : min(start, len);
    let last  = end < 0 ? max(len + end, 0) : min(end, len);
    let count = min(last - from, len - to);

    memory.copy( // is memmove
      ptr + (<usize>to << alignof<T>()),
      ptr + (<usize>from << alignof<T>()),
      <usize>count << alignof<T>()
    );
    return this;
  }

  includes(value: T, fromIndex: i32 = 0): bool {
    if (isFloat<T>()) {
      let length = this.length;
      if (length == 0 || fromIndex >= length) return false;
      if (fromIndex < 0) fromIndex = max(length + fromIndex, 0);
      while (fromIndex < length) {
        let elem = load<T>(changetype<usize>(this) + (<usize>fromIndex << alignof<T>()));
        // @ts-ignore
        if (elem == value || isNaN(elem) & isNaN(value)) return true;
        ++fromIndex;
      }
      return false;
    } else {
      return this.indexOf(value, fromIndex) >= 0;
    }
  }

  indexOf(value: T, fromIndex: i32 = 0): i32 {
    let length = this.length;
    if (length == 0 || fromIndex >= length) return -1;
    if (fromIndex < 0) fromIndex = max(length + fromIndex, 0);
    while (fromIndex < length) {
      if (load<T>(changetype<usize>(this) + (<usize>fromIndex << alignof<T>())) == value) return fromIndex;
      ++fromIndex;
    }
    return -1;
  }

  lastIndexOf(value: T, fromIndex: i32 = this.length): i32 {
    let length = this.length;
    if (length == 0) return -1;
    if (fromIndex < 0) fromIndex = length + fromIndex;
    else if (fromIndex >= length) fromIndex = length - 1;
    while (fromIndex >= 0) {
      if (load<T>(changetype<usize>(this) + (<usize>fromIndex << alignof<T>())) == value) return fromIndex;
      --fromIndex;
    }
    return -1;
  }

  concat<U extends ArrayLike<T> = Array<T>>(other: U): U {
    let sourceLen = this.length;
    let otherLen = other.length;
    let outLen = sourceLen + otherLen;
    if (<u32>outLen > <u32>BLOCK_MAXSIZE >>> alignof<T>()) {
      throw new Error(E_INVALIDLENGTH);
    }
    let sourceSize = <usize>sourceLen << alignof<T>();
    let out = changetype<U>(this); // FIXME: instanceof needs *some* value

    if (out instanceof Array<T>) {
      out = changetype<U>(__newArray(outLen, alignof<T>(), idof<Array<T>>()));
      // ^ FIXME: Function returns type U, but can't __newArray(U extends Array<T>)
      let outStart = changetype<Array<T>>(out).dataStart;
      let otherStart = changetype<Array<T>>(other).dataStart;
      let thisStart = changetype<usize>(this);

      if (isManaged<T>()) {
        for (let offset: usize = 0; offset < sourceSize; offset += sizeof<T>()) {
          let ref = load<usize>(thisStart + offset);
          store<usize>(outStart + offset, ref);
          __link(changetype<usize>(out), ref, true);
        }
        outStart += sourceSize;
        let otherSize = <usize>otherLen << alignof<T>();
        for (let offset: usize = 0; offset < otherSize; offset += sizeof<T>()) {
          let ref = load<usize>(otherStart + offset);
          store<usize>(outStart + offset, ref);
          __link(changetype<usize>(out), ref, true);
        }
      } else {
        memory.copy(outStart, thisStart, sourceSize);
        memory.copy(outStart + sourceSize, otherStart, <usize>otherLen << alignof<T>());
      }
    } else if (out instanceof StaticArray<T>) {
      out = changetype<U>(__new(<usize>outLen << alignof<T>(), idof<StaticArray<T>>()));
      let outStart = changetype<usize>(out);
      let otherStart = changetype<usize>(other);
      let thisStart = changetype<usize>(this);

      if (isManaged<T>()) {
        for (let offset: usize = 0; offset < sourceSize; offset += sizeof<T>()) {
          let ref = load<usize>(thisStart + offset);
          store<usize>(outStart + offset, ref);
          __link(changetype<usize>(out), ref, true);
        }
        outStart += sourceSize;
        let otherSize = <usize>otherLen << alignof<T>();
        for (let offset: usize = 0; offset < otherSize; offset += sizeof<T>()) {
          let ref = load<usize>(otherStart + offset);
          store<usize>(outStart + offset, ref);
          __link(changetype<usize>(out), ref, true);
        }
      } else {
        memory.copy(outStart, thisStart, sourceSize);
        memory.copy(outStart + sourceSize, otherStart, <usize>otherLen << alignof<T>());
      }
    } else {
      ERROR("Only Array<T> and StaticArray<T> accept for 'U' parameter");
    }
    return out;
  }

  slice<U extends ArrayLike<T> = Array<T>>(start: i32 = 0, end: i32 = i32.MAX_VALUE): U {
    let length = this.length;
    start = start < 0 ? max(start + length, 0) : min(start, length);
    end   = end   < 0 ? max(end   + length, 0) : min(end,   length);
    length = max(end - start, 0);

    let sourceStart = changetype<usize>(this) + (<usize>start << alignof<T>());
    let size = <usize>length << alignof<T>();
    let out = changetype<U>(this); // FIXME: instanceof needs *some* value

    if (out instanceof Array<T>) {
      // return Array
      out = changetype<U>(__newArray(length, alignof<T>(), idof<Array<T>>()));
      // ^ FIXME: Function returns type U, but can't __newArray(U extends Array<T>)
      let outStart = changetype<Array<T>>(out).dataStart;
      if (isManaged<T>()) {
        let off: usize = 0;
        while (off < size) {
          let ref = load<usize>(sourceStart + off);
          store<usize>(outStart + off, ref);
          __link(changetype<usize>(out), ref, true);
          off += sizeof<usize>();
        }
      } else {
        memory.copy(outStart, sourceStart, size);
      }
    } else if (out instanceof StaticArray<T>) {
      // return StaticArray
      out = changetype<U>(__new(size, idof<StaticArray<T>>()));
      let outStart = changetype<usize>(out);
      if (isManaged<T>()) {
        let off: usize = 0;
        while (off < size) {
          let ref = load<usize>(sourceStart + off);
          store<usize>(outStart + off, ref);
          __link(outStart, ref, true);
          off += sizeof<usize>();
        }
      } else {
        memory.copy(outStart, sourceStart, size);
      }
    } else {
      ERROR("Only Array<T> and StaticArray<T> accept for 'U' parameter");
    }
    return out;
  }

  findIndex(fn: (value: T, index: i32, array: StaticArray<T>) => bool): i32 {
    for (let i = 0, len = this.length; i < len; ++i) {
      if (fn(load<T>(changetype<usize>(this) + (<usize>i << alignof<T>())), i, this)) return i;
    }
    return -1;
  }

  findLastIndex(fn: (value: T, index: i32, array: StaticArray<T>) => bool): i32 {
    for (let i = this.length - 1; i >= 0; --i) {
      if (fn(load<T>(changetype<usize>(this) + (<usize>i << alignof<T>())), i, this)) return i;
    }
    return -1;
  }

  forEach(fn: (value: T, index: i32, array: StaticArray<T>) => void): void {
    for (let i = 0, len = this.length; i < len; ++i) {
      fn(load<T>(changetype<usize>(this) + (<usize>i << alignof<T>())), i, this);
    }
  }

  map<U>(fn: (value: T, index: i32, array: StaticArray<T>) => U): Array<U> {
    let len = this.length;
    let out = changetype<Array<U>>(__newArray(len, alignof<U>(), idof<Array<U>>()));
    let outStart = out.dataStart;
    for (let i = 0; i < len; ++i) {
      let result = fn(load<T>(changetype<usize>(this) + (<usize>i << alignof<T>())), i, this);
      store<U>(outStart + (<usize>i << alignof<U>()), result);
      if (isManaged<U>()) {
        __link(changetype<usize>(out), changetype<usize>(result), true);
      }
    }
    return out;
  }

  filter(fn: (value: T, index: i32, array: StaticArray<T>) => bool): Array<T> {
    let result = changetype<Array<T>>(__newArray(0, alignof<T>(), idof<Array<T>>()));
    for (let i = 0, len = this.length; i < len; ++i) {
      let value = load<T>(changetype<usize>(this) + (<usize>i << alignof<T>()));
      if (fn(value, i, this)) result.push(value);
    }
    return result;
  }

  reduce<U>(
    fn: (previousValue: U, currentValue: T, currentIndex: i32, array: StaticArray<T>) => U,
    initialValue: U
  ): U {
    let acc = initialValue;
    for (let i = 0, len = this.length; i < len; ++i) {
      acc = fn(acc, load<T>(changetype<usize>(this) + (<usize>i << alignof<T>())), i, this);
    }
    return acc;
  }

  reduceRight<U>(
    fn: (previousValue: U, currentValue: T, currentIndex: i32, array: StaticArray<T>) => U,
    initialValue: U
  ): U {
    let acc = initialValue;
    for (let i = this.length - 1; i >= 0; --i) {
      acc = fn(acc, load<T>(changetype<usize>(this) + (<usize>i << alignof<T>())), i, this);
    }
    return acc;
  }

  every(fn: (value: T, index: i32, array: StaticArray<T>) => bool): bool {
    for (let i = 0, len = this.length; i < len; ++i) {
      if (!fn(load<T>(changetype<usize>(this) + (<usize>i << alignof<T>())), i, this)) return false;
    }
    return true;
  }

  some(fn: (value: T, index: i32, array: StaticArray<T>) => bool): bool {
    for (let i = 0, len = this.length; i < len; ++i) {
      if (fn(load<T>(changetype<usize>(this) + (<usize>i << alignof<T>())), i, this)) return true;
    }
    return false;
  }

  sort(comparator: (a: T, b: T) => i32 = COMPARATOR<T>()): StaticArray<T> {
    SORT<T>(changetype<usize>(this), this.length, comparator);
    return this;
  }

  join(separator: string = ","): string {
    if (isBoolean<T>())   return joinBooleanArray(changetype<usize>(this), this.length, separator);
    if (isInteger<T>())   return joinIntegerArray<T>(changetype<usize>(this), this.length, separator);
    if (isFloat<T>())     return joinFloatArray<T>(changetype<usize>(this), this.length, separator);
    if (ASC_SHRINK_LEVEL < 1) {
      if (isString<T>())  return joinStringArray(changetype<usize>(this), this.length, separator);
    }
    if (isReference<T>()) return joinReferenceArray<T>(changetype<usize>(this), this.length, separator);
    ERROR("unspported element type");
    return <string>unreachable();
  }

  reverse(): StaticArray<T> {
    REVERSE<T>(changetype<usize>(this), this.length);
    return this;
  }

  toString(): string {
    return this.join();
  }

  // RT integration

  @unsafe private __visit(cookie: u32): void {
    if (isManaged<T>()) {
      let cur = changetype<usize>(this);
      let end = cur + changetype<OBJECT>(changetype<usize>(this) - TOTAL_OVERHEAD).rtSize;
      while (cur < end) {
        let val = load<usize>(cur);
        if (val) __visit(val, cookie);
        cur += sizeof<usize>();
      }
    }
  }
}
`,string:`/// <reference path="./rt/index.d.ts" />

import { OBJECT, BLOCK_MAXSIZE, TOTAL_OVERHEAD } from "./rt/common";
import { compareImpl, strtol, strtod, isSpace, isAscii, isFinalSigma, toLower8, toUpper8 } from "./util/string";
import { SPECIALS_UPPER, casemap, bsearch } from "./util/casemap";
import { E_INDEXOUTOFRANGE, E_INVALIDLENGTH, E_UNPAIRED_SURROGATE } from "./util/error";
import { idof } from "./builtins";
import { Array } from "./array";

@final export abstract class String {

  @lazy static readonly MAX_LENGTH: i32 = <i32>(BLOCK_MAXSIZE >>> alignof<u16>());

  static fromCharCode(unit: i32, surr: i32 = -1): String {
    let hasSur = surr > 0;
    let out = changetype<String>(__new(2 << i32(hasSur), idof<String>()));
    store<u16>(changetype<usize>(out), <u16>unit);
    if (hasSur) store<u16>(changetype<usize>(out), <u16>surr, 2);
    return out;
  }

  static fromCharCodes(units: Array<i32>): String {
    let length = units.length;
    let out = changetype<String>(__new(<usize>length << 1, idof<String>()));
    let ptr = units.dataStart;
    for (let i = 0; i < length; ++i) {
      store<u16>(changetype<usize>(out) + (<usize>i << 1), load<i32>(ptr + (<usize>i << 2)));
    }
    return out;
  }

  static fromCodePoint(code: i32): String {
    let hasSur = <u32>code > 0xFFFF;
    let out = changetype<String>(__new(2 << i32(hasSur), idof<String>()));
    if (!hasSur) {
      store<u16>(changetype<usize>(out), <u16>code);
    } else {
      // Checks valid code point range
      assert(<u32>code <= 0x10FFFF);
      code -= 0x10000;
      let hi = (code & 0x03FF) | 0xDC00;
      let lo = code >>> 10 | 0xD800;
      store<u32>(changetype<usize>(out), lo | hi << 16);
    }
    return out;
  }

  @builtin static raw(parts: TemplateStringsArray, ...args: unknown[]): string { return unreachable(); }

  get length(): i32 {
    return changetype<OBJECT>(changetype<usize>(this) - TOTAL_OVERHEAD).rtSize >> 1;
  }

  at(pos: i32): String {
    let len = this.length;
    pos += select(0, len, pos >= 0);
    if (<u32>pos >= <u32>len) throw new RangeError(E_INDEXOUTOFRANGE);
    let out = __new(2, idof<String>());
    store<u16>(out, load<u16>(changetype<usize>(this) + (<usize>pos << 1)));
    return changetype<String>(out); // retains
  }

  @operator("[]") charAt(pos: i32): String {
    if (<u32>pos >= <u32>this.length) return changetype<String>("");
    let out = changetype<String>(__new(2, idof<String>()));
    store<u16>(changetype<usize>(out), load<u16>(changetype<usize>(this) + (<usize>pos << 1)));
    return out;
  }

  charCodeAt(pos: i32): i32 {
    if (<u32>pos >= <u32>this.length) return -1; // (NaN)
    return load<u16>(changetype<usize>(this) + (<usize>pos << 1));
  }

  codePointAt(pos: i32): i32 {
    let len = this.length;
    if (<u32>pos >= <u32>len) return -1; // (undefined)
    let first = <i32>load<u16>(changetype<usize>(this) + (<usize>pos << 1));
    if ((first & 0xFC00) != 0xD800 || pos + 1 == len) return first;
    let second = <i32>load<u16>(changetype<usize>(this) + (<usize>pos << 1), 2);
    if ((second & 0xFC00) != 0xDC00) return first;
    return (first - 0xD800 << 10) + (second - 0xDC00) + 0x10000;
  }

  @operator("+") private static __concat(left: String, right: String): String {
    return left.concat(right);
  }

  concat(other: String): String {
    let thisSize: isize = this.length << 1;
    let otherSize: isize = other.length << 1;
    let outSize: usize = thisSize + otherSize;
    if (outSize == 0) return changetype<String>("");
    let out = changetype<String>(__new(outSize, idof<String>()));
    memory.copy(changetype<usize>(out), changetype<usize>(this), thisSize);
    memory.copy(changetype<usize>(out) + thisSize, changetype<usize>(other), otherSize);
    return out;
  }

  endsWith(search: String, end: i32 = String.MAX_LENGTH): bool {
    end = min(max(end, 0), this.length);
    let searchLength = <isize>search.length;
    let searchStart = <isize>end - searchLength;
    if (searchStart < 0) return false;
    // @ts-ignore: string <-> String
    return !compareImpl(this, searchStart, search, 0, searchLength);
  }

  @operator("==") private static __eq(left: String | null, right: String | null): bool {
    if (changetype<usize>(left) == changetype<usize>(right)) return true;
    if (changetype<usize>(left) == 0 || changetype<usize>(right) == 0) return false;
    let leftLength = changetype<string>(left).length;
    if (leftLength != changetype<string>(right).length) return false;
    // @ts-ignore: string <-> String
    return !compareImpl(left, 0, right, 0, leftLength);
  }

  @operator.prefix("!")
  private static __not(str: String | null): bool {
    return changetype<usize>(str) == 0 || !changetype<string>(str).length;
  }

  @operator("!=")
  private static __ne(left: String | null, right: String | null): bool {
    return !this.__eq(left, right);
  }

  @operator(">") private static __gt(left: String, right: String): bool {
    if (changetype<usize>(left) == changetype<usize>(right)) return false;
    let leftLength  = left.length;
    if (!leftLength) return false;
    let rightLength = right.length;
    if (!rightLength) return true;
    // @ts-ignore: string <-> String
    let res = compareImpl(left, 0, right, 0, min(leftLength, rightLength));
    return res ? res > 0 : leftLength > rightLength;
  }

  @operator(">=") private static __gte(left: String, right: String): bool {
    return !this.__lt(left, right);
  }

  @operator("<") private static __lt(left: String, right: String): bool {
    if (changetype<usize>(left) == changetype<usize>(right)) return false;
    let rightLength = right.length;
    if (!rightLength) return false;
    let leftLength  = left.length;
    if (!leftLength) return true;
    // @ts-ignore: string <-> String
    let res = compareImpl(left, 0, right, 0, min(leftLength, rightLength));
    return res ? res < 0 : leftLength < rightLength;
  }

  @operator("<=") private static __lte(left: String, right: String): bool {
    return !this.__gt(left, right);
  }

  includes(search: String, start: i32 = 0): bool {
    return this.indexOf(search, start) != -1;
  }

  indexOf(search: String, start: i32 = 0): i32 {
    let searchLen = <isize>search.length;
    if (!searchLen) return 0;
    let len = <isize>this.length;
    if (!len) return -1;
    let searchStart = min(max(<isize>start, 0), len);
    for (len -= searchLen; searchStart <= len; ++searchStart) {
      // @ts-ignore: string <-> String
      if (!compareImpl(this, searchStart, search, 0, searchLen)) return <i32>searchStart;
    }
    return -1;
  }

  lastIndexOf(search: String, start: i32 = i32.MAX_VALUE): i32 {
    let searchLen = <isize>search.length;
    if (!searchLen) return this.length;
    let len = this.length;
    if (!len) return -1;
    let searchStart = min(max(<isize>start, 0), <isize>len - searchLen);
    for (; searchStart >= 0; --searchStart) {
      // @ts-ignore: string <-> String
      if (!compareImpl(this, searchStart, search, 0, searchLen)) return <i32>searchStart;
    }
    return -1;
  }

  // TODO: implement full locale comparison with locales and Collator options
  localeCompare(other: String): i32 {
    if (changetype<usize>(other) == changetype<usize>(this)) return 0;
    let alen = this.length;
    let blen = other.length;
    // @ts-ignore: string <-> String
    let res = compareImpl(this, 0, other, 0, <usize>min(alen, blen));
    res = res ? res : alen - blen;
    // normalize to [-1, 1] range
    return i32(res > 0) - i32(res < 0);
  }

  startsWith(search: String, start: i32 = 0): bool {
    let len = <isize>this.length;
    let searchStart = min(max(<isize>start, 0), len);
    let searchLength = <isize>search.length;
    if (searchLength + searchStart > len) return false;
    // @ts-ignore: string <-> String
    return !compareImpl(this, searchStart, search, 0, searchLength);
  }

  substr(start: i32, length: i32 = i32.MAX_VALUE): String { // legacy
    let intStart: isize = start;
    let end: isize = length;
    let len: isize = this.length;
    if (intStart < 0) intStart = max(len + intStart, 0);
    let size = min(max(end, 0), len - intStart) << 1;
    if (size <= 0) return changetype<String>("");
    let out = changetype<String>(__new(size, idof<String>()));
    memory.copy(changetype<usize>(out), changetype<usize>(this) + (intStart << 1), size);
    return out;
  }

  substring(start: i32, end: i32 = i32.MAX_VALUE): String {
    let len: isize = this.length;
    let finalStart = min<isize>(max(start, 0), len);
    let finalEnd = min<isize>(max(end, 0), len);
    let fromPos = min<isize>(finalStart, finalEnd) << 1;
    let toPos = max<isize>(finalStart, finalEnd) << 1;
    let size = toPos - fromPos;
    if (!size) return changetype<String>("");
    if (!fromPos && toPos == len << 1) return this;
    let out = changetype<String>(__new(size, idof<String>()));
    memory.copy(changetype<usize>(out), changetype<usize>(this) + fromPos, size);
    return out;
  }

  trim(): String {
    let len = this.length;
    let size: usize = len << 1;
    while (size && isSpace(load<u16>(changetype<usize>(this) + size - 2))) {
      size -= 2;
    }
    let offset: usize = 0;
    while (offset < size && isSpace(load<u16>(changetype<usize>(this) + offset))) {
      offset += 2; size -= 2;
    }
    if (!size) return changetype<String>("");
    if (!offset && size == len << 1) return this;
    let out = changetype<String>(__new(size, idof<String>()));
    memory.copy(changetype<usize>(out), changetype<usize>(this) + offset, size);
    return out;
  }

  @inline
  trimLeft(): String {
    return this.trimStart();
  }

  @inline
  trimRight(): String {
    return this.trimEnd();
  }

  trimStart(): String {
    let size = <usize>this.length << 1;
    let offset: usize = 0;
    while (offset < size && isSpace(load<u16>(changetype<usize>(this) + offset))) {
      offset += 2;
    }
    if (!offset) return this;
    size -= offset;
    if (!size) return changetype<String>("");
    let out = changetype<String>(__new(size, idof<String>()));
    memory.copy(changetype<usize>(out), changetype<usize>(this) + offset, size);
    return out;
  }

  trimEnd(): String {
    let originalSize = <usize>this.length << 1;
    let size = originalSize;
    while (size && isSpace(load<u16>(changetype<usize>(this) + size - 2))) {
      size -= 2;
    }
    if (!size) return changetype<String>("");
    if (size == originalSize) return this;
    let out = changetype<String>(__new(size, idof<String>()));
    memory.copy(changetype<usize>(out), changetype<usize>(this), size);
    return out;
  }

  padStart(length: i32, pad: string = " "): String {
    let thisSize = <usize>this.length << 1;
    let targetSize = <usize>length << 1;
    let padSize = <usize>pad.length << 1;
    if (targetSize < thisSize || !padSize) return this;
    let prependSize = targetSize - thisSize;
    let out = changetype<String>(__new(targetSize, idof<String>()));
    if (prependSize > padSize) {
      let repeatCount = (prependSize - 2) / padSize;
      let restBase = repeatCount * padSize;
      let restSize = prependSize - restBase;
      memory.repeat(changetype<usize>(out), changetype<usize>(pad), padSize, repeatCount);
      memory.copy(changetype<usize>(out) + restBase, changetype<usize>(pad), restSize);
    } else {
      memory.copy(changetype<usize>(out), changetype<usize>(pad), prependSize);
    }
    memory.copy(changetype<usize>(out) + prependSize, changetype<usize>(this), thisSize);
    return out;
  }

  padEnd(length: i32, pad: string = " "): String {
    let thisSize = <usize>this.length << 1;
    let targetSize = <usize>length << 1;
    let padSize = <usize>pad.length << 1;
    if (targetSize < thisSize || !padSize) return this;
    let appendSize = targetSize - thisSize;
    let out = changetype<String>(__new(targetSize, idof<String>()));
    memory.copy(changetype<usize>(out), changetype<usize>(this), thisSize);
    if (appendSize > padSize) {
      let repeatCount = (appendSize - 2) / padSize;
      let restBase = repeatCount * padSize;
      let restSize = appendSize - restBase;
      memory.repeat(changetype<usize>(out) + thisSize, changetype<usize>(pad), padSize, repeatCount);
      memory.copy(changetype<usize>(out) + thisSize + restBase, changetype<usize>(pad), restSize);
    } else {
      memory.copy(changetype<usize>(out) + thisSize, changetype<usize>(pad), appendSize);
    }
    return out;
  }

  repeat(count: i32 = 0): String {
    let length = this.length;

    // Most browsers can't handle strings 1 << 28 chars or longer
    if (count < 0 || <u64>length * count > (1 << 28)) {
      throw new RangeError(E_INVALIDLENGTH);
    }

    if (count == 0 || !length) return changetype<String>("");
    if (count == 1) return this;
    let out = changetype<String>(__new((length * count) << 1, idof<String>()));
    memory.repeat(changetype<usize>(out), changetype<usize>(this), <usize>length << 1, count);
    return out;
  }

  replace(search: String, replacement: String): String {
    let len: usize = this.length;
    let slen: usize = search.length;
    if (len <= slen) {
      return len < slen ? this : select<String>(replacement, this, search == this);
    }
    let index: isize = this.indexOf(search);
    if (~index) {
      let rlen: usize = replacement.length;
      len -= slen;
      let olen = len + rlen;
      if (olen) {
        let out = changetype<String>(__new(olen << 1, idof<String>()));
        memory.copy(changetype<usize>(out), changetype<usize>(this), index << 1);
        memory.copy(
          changetype<usize>(out) + (index << 1),
          changetype<usize>(replacement),
          rlen << 1
        );
        memory.copy(
          changetype<usize>(out) + ((index + rlen) << 1),
          changetype<usize>(this) + ((index + slen) << 1),
          (len - index) << 1
        );
        return out;
      }
    }
    return this;
  }

  replaceAll(search: String, replacement: String): String {
    let thisLen: usize = this.length;
    let searchLen: usize = search.length;
    if (thisLen <= searchLen) {
      return thisLen < searchLen
        ? this
        : select<String>(replacement, this, search == this);
    }
    let replaceLen: usize = replacement.length;
    if (!searchLen) {
      if (!replaceLen) return this;
      // Special case: 'abc'.replaceAll('', '-') -> '-a-b-c-'
      let out = changetype<String>(__new((thisLen + (thisLen + 1) * replaceLen) << 1, idof<String>()));
      memory.copy(changetype<usize>(out), changetype<usize>(replacement), replaceLen << 1);
      let offset = replaceLen;
      for (let i: usize = 0; i < thisLen; ++i) {
        store<u16>(
          changetype<usize>(out) + (offset++ << 1),
          load<u16>(changetype<usize>(this) + (i << 1))
        );
        memory.copy(
          changetype<usize>(out) + (offset << 1),
          changetype<usize>(replacement),
          replaceLen << 1
        );
        offset += replaceLen;
      }
      return out;
    }
    let prev: isize = 0, next: isize = 0;
    if (searchLen == replaceLen) {
      // Fast path when search and replacement have same length
      let outSize = thisLen << 1;
      let out = changetype<String>(__new(outSize, idof<String>()));
      memory.copy(changetype<usize>(out), changetype<usize>(this), outSize);
      while (~(next = <isize>this.indexOf(search, <i32>prev))) {
        memory.copy(changetype<usize>(out) + (next << 1), changetype<usize>(replacement), replaceLen << 1);
        prev = next + searchLen;
      }
      return out;
    }
    let out: String | null = null, offset: usize = 0, outSize = thisLen;
    while (~(next = <isize>this.indexOf(search, <i32>prev))) {
      if (!out) out = changetype<String>(__new(thisLen << 1, idof<String>()));
      let chunk = next - prev;
      if (offset + chunk + replaceLen > outSize) {
        outSize <<= 1;
        out = changetype<String>(__renew(changetype<usize>(out), outSize << 1));
      }
      memory.copy(
        changetype<usize>(out) + (offset << 1),
        changetype<usize>(this) + (prev << 1),
        chunk << 1
      );
      offset += chunk;
      memory.copy(
        changetype<usize>(out) + (offset << 1),
        changetype<usize>(replacement),
        replaceLen << 1
      );
      offset += replaceLen;
      prev = next + searchLen;
    }
    if (out) {
      let rest = thisLen - prev;
      if (offset + rest > outSize) {
        outSize <<= 1;
        out = changetype<String>(__renew(changetype<usize>(out), outSize << 1));
      }
      if (rest) {
        memory.copy(
          changetype<usize>(out) + (offset << 1),
          changetype<usize>(this) + (prev << 1),
          rest << 1
        );
      }
      rest += offset;
      if (outSize > rest) {
        out = changetype<String>(__renew(changetype<usize>(out), rest << 1));
      }
      return out;
    }
    return this;
  }

  slice(start: i32, end: i32 = i32.MAX_VALUE): String {
    let len = this.length;
    start = start < 0 ? max(start + len, 0) : min(start, len);
    end   = end   < 0 ? max(end   + len, 0) : min(end,   len);
    len   = end - start;
    if (len <= 0) return changetype<String>("");
    let out = changetype<String>(__new(len << 1, idof<String>()));
    memory.copy(changetype<usize>(out), changetype<usize>(this) + (<usize>start << 1), <usize>len << 1);
    return out;
  }

  split(separator: String | null = null, limit: i32 = i32.MAX_VALUE): String[] {
    if (!limit) return changetype<String[]>(__newArray(0, alignof<String>(), idof<Array<String>>()));
    if (changetype<usize>(separator) == 0) return [ this ];
    let length: isize = this.length;
    let sepLen = changetype<string>(separator).length;
    if (limit < 0) limit = i32.MAX_VALUE;
    if (!sepLen) {
      if (!length) return changetype<String[]>(__newArray(0, alignof<String>(), idof<Array<String>>()));
      // split by chars
      length = min<isize>(length, <isize>limit);
      let result = changetype<String[]>(__newArray(<i32>length, alignof<String>(), idof<Array<String>>()));
      // @ts-ignore: cast
      let resultStart = result.dataStart as usize;
      for (let i: isize = 0; i < length; ++i) {
        let charStr = changetype<String>(__new(2, idof<String>()));
        store<u16>(changetype<usize>(charStr), load<u16>(changetype<usize>(this) + (<usize>i << 1)));
        store<usize>(resultStart + (<usize>i << alignof<usize>()), changetype<usize>(charStr)); // result[i] = charStr
        __link(changetype<usize>(result), changetype<usize>(charStr), true);
      }
      return result;
    } else if (!length) {
      let result = changetype<String[]>(__newArray(1, alignof<String>(), idof<Array<String>>()));
      // @ts-ignore: cast
      store<usize>(result.dataStart as usize, changetype<usize>("")); // static ""
      return result;
    }
    let result = changetype<String[]>(__newArray(0, alignof<String>(), idof<Array<String>>()));
    let end = 0, start = 0, i = 0;
    while (~(end = this.indexOf(changetype<string>(separator), start))) {
      let len = end - start;
      if (len > 0) {
        let out = changetype<String>(__new(<usize>len << 1, idof<String>()));
        memory.copy(changetype<usize>(out), changetype<usize>(this) + (<usize>start << 1), <usize>len << 1);
        result.push(out);
      } else {
        result.push(changetype<String>(""));
      }
      if (++i == limit) return result;
      start = end + sepLen;
    }
    if (!start) { // also means: loop above didn't do anything
      result.push(this);
      return result;
    }
    let len = length - start;
    if (len > 0) {
      let out = changetype<String>(__new(<usize>len << 1, idof<String>()));
      memory.copy(changetype<usize>(out), changetype<usize>(this) + (<usize>start << 1), <usize>len << 1);
      result.push(out);
    } else {
      result.push(changetype<String>("")); // static ""
    }
    return result;
  }

  toLowerCase(): String {
    let len = <usize>this.length;
    if (!len) return this;
    let codes = changetype<String>(__new(len * 2 * 2, idof<String>()));
    let j: usize = 0;
    for (let i: usize = 0; i < len; ++i, ++j) {
      let c = <u32>load<u16>(changetype<usize>(this) + (i << 1));
      if (isAscii(c)) {
        store<u16>(changetype<usize>(codes) + (j << 1), toLower8(c));
      } else {
        // check and read surrogate pair
        if ((c - 0xD7FF < 0xDC00 - 0xD7FF) && i < len - 1) {
          let c1 = <u32>load<u16>(changetype<usize>(this) + (i << 1), 2);
          if (c1 - 0xDBFF < 0xE000 - 0xDBFF) {
            let c0 = c;
            c = (((c & 0x03FF) << 10) | (c1 & 0x03FF)) + 0x10000;
            ++i;
            if (c >= 0x20000) {
              store<u32>(changetype<usize>(codes) + (j << 1), c0 | (c1 << 16));
              ++j;
              continue;
            }
          }
        }
        // check special casing for lower table. It has one ently so instead lookup we just inline this.
        if (c == 0x0130) {
          // 0x0130 -> [0x0069, 0x0307]
          store<u32>(changetype<usize>(codes) + (j << 1), (0x0307 << 16) | 0x0069);
          ++j;
        } else if (c == 0x03A3) { // '\u03A3'
          // \u03A3 maps to \u03C3 but except at the end of a word where it maps to \u03C2
          let sigma = 0x03C3; // \u03C3
          if (len > 1 && isFinalSigma(changetype<usize>(this), i, len)) {
            sigma = 0x03C2; // \u03C2
          }
          store<u16>(changetype<usize>(codes) + (j << 1), sigma);
        } else if (c - 0x24B6 <= 0x24CF - 0x24B6) {
          // Range 0x24B6 <= c <= 0x24CF not covered by casemap and require special early handling
          store<u16>(changetype<usize>(codes) + (j << 1), c + 26);
        } else {
          let code = casemap(c, 0) & 0x1FFFFF;
          if (code < 0x10000) {
            store<u16>(changetype<usize>(codes) + (j << 1), code);
          } else {
            // store as surrogare pair
            code -= 0x10000;
            let lo = (code >>> 10) | 0xD800;
            let hi = (code & 0x03FF) | 0xDC00;
            store<u32>(changetype<usize>(codes) + (j << 1), lo | (hi << 16));
            ++j;
          }
        }
      }
    }
    return changetype<String>(__renew(changetype<usize>(codes), j << 1));
  }

  toUpperCase(): String {
    let len = <usize>this.length;
    if (!len) return this;
    let codes = changetype<String>(__new(len * 3 * 2, idof<String>()));
    let specialsPtr = changetype<usize>(SPECIALS_UPPER);
    let specialsLen = SPECIALS_UPPER.length;
    let j: usize = 0;
    for (let i: usize = 0; i < len; ++i, ++j) {
      let c = <u32>load<u16>(changetype<usize>(this) + (i << 1));
      if (isAscii(c)) {
        store<u16>(changetype<usize>(codes) + (j << 1), toUpper8(c));
      } else {
        // check and read surrogate pair
        if ((c - 0xD7FF < 0xDC00 - 0xD7FF) && i < len - 1) {
          let c1 = <u32>load<u16>(changetype<usize>(this) + (i << 1), 2);
          if (c1 - 0xDBFF < 0xE000 - 0xDBFF) {
            let c0 = c;
            c = (((c & 0x03FF) << 10) | (c1 & 0x03FF)) + 0x10000;
            ++i;
            if (c >= 0x20000) {
              store<u32>(changetype<usize>(codes) + (j << 1), c0 | (c1 << 16));
              ++j;
              continue;
            }
          }
        }
        // Range 0x24D0 <= c <= 0x24E9 not covered by casemap and require special early handling
        if (c - 0x24D0 <= 0x24E9 - 0x24D0) {
          // monkey patch
          store<u16>(changetype<usize>(codes) + (j << 1), c - 26);
        } else {
          let index: usize = -1;
          // Fast range check. See first and last rows in specialsUpper table
          if (c - 0x00DF <= 0xFB17 - 0x00DF) {
            index = <usize>bsearch(c, specialsPtr, specialsLen);
          }
          if (~index) {
            // load next 3 code points from row with \`index\` offset for specialsUpper table
            let ab = load<u32>(specialsPtr + (index << 1), 2);
            let cc = load<u16>(specialsPtr + (index << 1), 6);
            store<u32>(changetype<usize>(codes) + (j << 1), ab, 0);
            store<u16>(changetype<usize>(codes) + (j << 1), cc, 4);
            j += 1 + usize(cc != 0);
          } else {
            let code = casemap(c, 1) & 0x1FFFFF;
            if (code < 0x10000) {
              store<u16>(changetype<usize>(codes) + (j << 1), code);
            } else {
              // store as surrogare pair
              code -= 0x10000;
              let lo = (code >>> 10) | 0xD800;
              let hi = (code & 0x03FF) | 0xDC00;
              store<u32>(changetype<usize>(codes) + (j << 1), lo | (hi << 16));
              ++j;
            }
          }
        }
      }
    }
    return changetype<String>(__renew(changetype<usize>(codes), j << 1));
  }

  toString(): String {
    return this;
  }
}

// @ts-ignore: nolib
export type string = String;

export function parseInt(str: string, radix: i32 = 0): f64 {
  return strtol<f64>(str, radix);
}

export function parseFloat(str: string): f64 {
  return strtod(str);
}

// Encoding helpers
export namespace String {

  export namespace UTF8 {

    export const enum ErrorMode {
      WTF8,
      REPLACE,
      ERROR
    }

    export function byteLength(str: string, nullTerminated: bool = false): i32 {
      let strOff = changetype<usize>(str);
      let strEnd = strOff + <usize>changetype<OBJECT>(changetype<usize>(str) - TOTAL_OVERHEAD).rtSize;
      let bufLen = i32(nullTerminated);
      while (strOff < strEnd) {
        let c1 = <u32>load<u16>(strOff);
        if (c1 < 128) {
          // @ts-ignore: cast
          if (nullTerminated & !c1) break;
          bufLen += 1;
        } else if (c1 < 2048) {
          bufLen += 2;
        } else {
          if ((c1 & 0xFC00) == 0xD800 && strOff + 2 < strEnd) {
            if ((<u32>load<u16>(strOff, 2) & 0xFC00) == 0xDC00) {
              bufLen += 4; strOff += 4;
              continue;
            }
          }
          bufLen += 3;
        }
        strOff += 2;
      }
      return bufLen;
    }

    export function encode(str: string, nullTerminated: bool = false, errorMode: ErrorMode = ErrorMode.WTF8): ArrayBuffer {
      let buf = changetype<ArrayBuffer>(__new(<usize>byteLength(str, nullTerminated), idof<ArrayBuffer>()));
      encodeUnsafe(changetype<usize>(str), str.length, changetype<usize>(buf), nullTerminated, errorMode);
      return buf;
    }

    // @ts-ignore: decorator
    @unsafe
    export function encodeUnsafe(str: usize, len: i32, buf: usize, nullTerminated: bool = false, errorMode: ErrorMode = ErrorMode.WTF8): usize {
      let strEnd = str + (<usize>len << 1);
      let bufOff = buf;
      while (str < strEnd) {
        let c1 = <u32>load<u16>(str);
        if (c1 < 128) {
          store<u8>(bufOff, c1);
          bufOff++;
          // @ts-ignore: cast
          if (nullTerminated & !c1) return bufOff - buf;
        } else if (c1 < 2048) {
          let b0 = c1 >> 6 | 192;
          let b1 = c1 & 63 | 128;
          store<u16>(bufOff, b1 << 8 | b0);
          bufOff += 2;
        } else {
          // D800: 11011 0 0000000000 Lead
          // DBFF: 11011 0 1111111111
          // DC00: 11011 1 0000000000 Trail
          // DFFF: 11011 1 1111111111
          // F800: 11111 0 0000000000 Mask
          // FC00: 11111 1 0000000000
          if ((c1 & 0xF800) == 0xD800) {
            if (c1 < 0xDC00 && str + 2 < strEnd) {
              let c2 = <u32>load<u16>(str, 2);
              if ((c2 & 0xFC00) == 0xDC00) {
                c1 = 0x10000 + ((c1 & 0x03FF) << 10) | (c2 & 0x03FF);
                let b0 = c1 >> 18 | 240;
                let b1 = c1 >> 12 & 63 | 128;
                let b2 = c1 >> 6  & 63 | 128;
                let b3 = c1       & 63 | 128;
                store<u32>(bufOff, b3 << 24 | b2 << 16 | b1 << 8 | b0);
                bufOff += 4; str += 4;
                continue;
              }
            }
            if (errorMode != ErrorMode.WTF8) { // unlikely
              if (errorMode == ErrorMode.ERROR) throw new Error(E_UNPAIRED_SURROGATE);
              c1 = 0xFFFD;
            }
          }
          let b0 = c1 >> 12 | 224;
          let b1 = c1 >> 6  & 63 | 128;
          let b2 = c1       & 63 | 128;
          store<u16>(bufOff, b1 << 8 | b0);
          store<u8>(bufOff, b2, 2);
          bufOff += 3;
        }
        str += 2;
      }
      if (nullTerminated) {
        store<u8>(bufOff++, 0);
      }
      return bufOff - buf;
    }

    export function decode(buf: ArrayBuffer, nullTerminated: bool = false): String {
      return decodeUnsafe(changetype<usize>(buf), buf.byteLength, nullTerminated);
    }

    // @ts-ignore: decorator
    @unsafe
    export function decodeUnsafe(buf: usize, len: usize, nullTerminated: bool = false): String {
      let bufOff = buf;
      let bufEnd = buf + len;
      assert(bufEnd >= bufOff); // guard wraparound
      let str = changetype<String>(__new(len << 1, idof<String>())); // max is one u16 char per u8 byte
      let strOff = changetype<usize>(str);
      while (bufOff < bufEnd) {
        let u0 = <u32>load<u8>(bufOff); ++bufOff;
        if (!(u0 & 128)) {
          // @ts-ignore: cast
          if (nullTerminated & !u0) break;
          store<u16>(strOff, u0);
        } else {
          if (bufEnd == bufOff) break;
          let u1 = <u32>load<u8>(bufOff) & 63; ++bufOff;
          if ((u0 & 224) == 192) {
            store<u16>(strOff, (u0 & 31) << 6 | u1);
          } else {
            if (bufEnd == bufOff) break;
            let u2 = <u32>load<u8>(bufOff) & 63; ++bufOff;
            if ((u0 & 240) == 224) {
              u0 = (u0 & 15) << 12 | u1 << 6 | u2;
            } else {
              if (bufEnd == bufOff) break;
              u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | <u32>load<u8>(bufOff) & 63;
              ++bufOff;
            }
            if (u0 < 0x10000) {
              store<u16>(strOff, u0);
            } else {
              u0 -= 0x10000;
              let lo = u0 >> 10 | 0xD800;
              let hi = (u0 & 0x03FF) | 0xDC00;
              store<u32>(strOff, lo | (hi << 16));
              strOff += 2;
            }
          }
        }
        strOff += 2;
      }
      return changetype<String>(__renew(changetype<usize>(str), strOff - changetype<usize>(str)));
    }
  }

  export namespace UTF16 {

    export function byteLength(str: string): i32 {
      return changetype<OBJECT>(changetype<usize>(str) - TOTAL_OVERHEAD).rtSize;
    }

    export function encode(str: string): ArrayBuffer {
      let buf = changetype<ArrayBuffer>(__new(<usize>byteLength(str), idof<ArrayBuffer>()));
      encodeUnsafe(changetype<usize>(str), str.length, changetype<usize>(buf));
      return buf;
    }

    // @ts-ignore: decorator
    @unsafe
    export function encodeUnsafe(str: usize, len: i32, buf: usize): usize {
      let size = <usize>len << 1;
      memory.copy(buf, changetype<usize>(str), size);
      return size;
    }

    export function decode(buf: ArrayBuffer): String {
      return decodeUnsafe(changetype<usize>(buf), buf.byteLength);
    }

    // @ts-ignore: decorator
    @unsafe
    export function decodeUnsafe(buf: usize, len: usize): String {
      let str = changetype<String>(__new(len &= ~1, idof<String>()));
      memory.copy(changetype<usize>(str), buf, len);
      return str;
    }
  }
}

export class TemplateStringsArray extends Array<string> {
  readonly raw: string[];
}
`,symbol:`import { Map } from "./map";

// @ts-ignore: decorator
@lazy let stringToId: Map<string, usize> = new Map();

// @ts-ignore: decorator
@lazy let idToString: Map<usize, string> = new Map();

// @ts-ignore: decorator
@lazy let nextId: usize = 12; // Symbol.unscopables + 1

@unmanaged @final abstract class _Symbol {

  // TODO: all of the following default symbols are unused currently yet add to
  // binary size if #toString becomes compiled. Ultimately we'll most likely want
  // to remove the unsupported ones and only keep what's actually supported.

  // @ts-ignore: decorator
  @lazy
  static readonly hasInstance: symbol = changetype<symbol>(1);

  // @ts-ignore: decorator
  @lazy
  static readonly isConcatSpreadable: symbol = changetype<symbol>(2);

  // @ts-ignore: decorator
  @lazy
  static readonly isRegExp: symbol = changetype<symbol>(3);

  // @ts-ignore: decorator
  @lazy
  static readonly iterator: symbol = changetype<symbol>(3);

  // @ts-ignore: decorator
  @lazy
  static readonly match: symbol = changetype<symbol>(4);

  // @ts-ignore: decorator
  @lazy
  static readonly replace: symbol = changetype<symbol>(5);

  // @ts-ignore: decorator
  @lazy
  static readonly search: symbol = changetype<symbol>(6);

  // @ts-ignore: decorator
  @lazy
  static readonly species: symbol = changetype<symbol>(7);

  // @ts-ignore: decorator
  @lazy
  static readonly split: symbol = changetype<symbol>(8);

  // @ts-ignore: decorator
  @lazy
  static readonly toPrimitive: symbol = changetype<symbol>(9);

  // @ts-ignore: decorator
  @lazy
  static readonly toStringTag: symbol = changetype<symbol>(10);

  // @ts-ignore: decorator
  @lazy
  static readonly unscopables: symbol = changetype<symbol>(11);

  static for(key: string): symbol {
    if (stringToId.has(key)) return changetype<symbol>(stringToId.get(key));
    let id = nextId++;
    if (!id) unreachable(); // out of ids
    stringToId.set(key, id);
    idToString.set(id, key);
    return changetype<symbol>(id);
  }

  static keyFor(sym: symbol): string | null {
    return idToString.has(changetype<usize>(sym))
      ? idToString.get(changetype<usize>(sym))
      : null;
  }

  toString(): string {
    let id = changetype<usize>(this);
    let str = "";
    switch (<u32>id) {
      case 1:  { str = "hasInstance"; break; }
      case 2:  { str = "isConcatSpreadable"; break; }
      case 3:  { str = "isRegExp"; break; }
      case 4:  { str = "match"; break; }
      case 5:  { str = "replace"; break; }
      case 6:  { str = "search"; break; }
      case 7:  { str = "species"; break; }
      case 8:  { str = "split"; break; }
      case 9:  { str = "toPrimitive"; break; }
      case 10: { str = "toStringTag"; break; }
      case 11: { str = "unscopables"; break; }
      default: {
        if (idToString != null && idToString.has(id)) str = idToString.get(id);
        break;
      }
    }
    return "Symbol(" + str + ")";
  }
}

export function Symbol(description: string | null = null): symbol {
  let id = nextId++;
  if (!id) unreachable(); // out of ids
  return changetype<symbol>(id);
}

export type Symbol = _Symbol;

// @ts-ignore: nolib
export type symbol = _Symbol;
`,table:`import { E_NOTIMPLEMENTED } from "./util/error";

export namespace table {

  export function copy(dst: u32, src: u32, n: u32): void {
    throw new Error(E_NOTIMPLEMENTED);
  }

  export function init(elementIndex: u32, srcOffset: u32, dstOffset: u32, n: u32): void {
    throw new Error(E_NOTIMPLEMENTED);
  }

  export function drop(elementIndex: u32): void {
    throw new Error(E_NOTIMPLEMENTED);
  }
}
`,typedarray:`import { COMPARATOR, SORT } from "./util/sort";
import { E_INDEXOUTOFRANGE, E_INVALIDLENGTH, E_NOTIMPLEMENTED } from "./util/error";
import { joinIntegerArray, joinFloatArray } from "./util/string";
import { REVERSE, FILL } from "./util/bytes";
import { idof } from "./builtins";
import { ArrayBufferView } from "./arraybuffer";

export class Int8Array extends ArrayBufferView {
  [key: number]: i8;

  // @ts-ignore: decorator
  @lazy
  static readonly BYTES_PER_ELEMENT: i32 = sizeof<i8>();

  constructor(length: i32) {
    super(length, alignof<i8>());
  }

  get length(): i32 {
    return this.byteLength;
  }

  @operator("[]")
  private __get(index: i32): i8 {
    if (<u32>index >= <u32>this.byteLength) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<i8>(this.dataStart + <usize>index);
  }

  @unsafe @operator("{}")
  private __uget(index: i32): i8 {
    return load<i8>(this.dataStart + <usize>index);
  }

  @operator("[]=")
  private __set(index: i32, value: native<i8>): void {
    if (<u32>index >= <u32>this.byteLength) throw new RangeError(E_INDEXOUTOFRANGE);
    store<i8>(this.dataStart + <usize>index, value);
  }

  @unsafe @operator("{}=")
  private __uset(index: i32, value: native<i8>): void {
    store<i8>(this.dataStart + <usize>index, value);
  }

  at(index: i32): i8 {
    let len = this.byteLength;
    index += select(0, len, index >= 0);
    if (<u32>index >= <u32>len) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<i8>(this.dataStart + <usize>index);
  }

  includes(searchElement: i8, fromIndex: i32 = 0): bool {
    return INCLUDES<Int8Array, i8>(this, searchElement, fromIndex);
  }

  indexOf(searchElement: i8, fromIndex: i32 = 0): i32 {
    return INDEX_OF<Int8Array, i8>(this, searchElement, fromIndex);
  }

  lastIndexOf(searchElement: i8, fromIndex: i32 = this.length): i32 {
    return LAST_INDEX_OF<Int8Array, i8>(this, searchElement, fromIndex);
  }

  fill(value: i32, start: i32 = 0, end: i32 = i32.MAX_VALUE): Int8Array {
    FILL<u8>(this.dataStart, this.length, u8(value), start, end);
    return this;
  }

  sort(comparator: (a: i8, b: i8) => i32 = COMPARATOR<i8>()): Int8Array {
    SORT<i8>(this.dataStart, this.length, comparator);
    return this;
  }

  slice(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Int8Array {
    return SLICE<Int8Array, i8>(this, begin, end);
  }

  subarray(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Int8Array {
    return SUBARRAY<Int8Array, i8>(this, begin, end);
  }

  copyWithin(target: i32, start: i32, end: i32 = i32.MAX_VALUE): Int8Array {
    return COPY_WITHIN<Int8Array, i8>(this, target, start, end);
  }

  reduce<T extends number>(
    fn: (accumulator: T, value: i8, index: i32, array: Int8Array) => T,
    initialValue: T,
  ): T {
    return REDUCE<Int8Array, i8, T>(this, fn, initialValue);
  }

  reduceRight<T extends number>(
    fn: (accumulator: T, value: i8, index: i32, array: Int8Array) => T,
    initialValue: T,
  ): T {
    return REDUCE_RIGHT<Int8Array, i8, T>(this, fn, initialValue);
  }

  map(fn: (value: i8, index: i32, self: Int8Array) => i8): Int8Array {
    return MAP<Int8Array, i8>(this, fn);
  }

  filter(fn: (value: i8, index: i32, self: Int8Array) => bool): Int8Array {
    return FILTER<Int8Array, i8>(this, fn);
  }

  findIndex(fn: (value: i8, index: i32, self: Int8Array) => bool): i32 {
    return FIND_INDEX<Int8Array, i8>(this, fn);
  }

  findLastIndex(fn: (value: i8, index: i32, self: Int8Array) => bool): i32 {
    return FIND_LAST_INDEX<Int8Array, i8>(this, fn);
  }

  some(fn: (value: i8, index: i32, self: Int8Array) => bool): bool {
    return SOME<Int8Array, i8>(this, fn);
  }

  every(fn: (value: i8, index: i32, self: Int8Array) => bool): bool {
    return EVERY<Int8Array, i8>(this, fn);
  }

  forEach(fn: (value: i8, index: i32, self: Int8Array) => void): void {
    FOREACH<Int8Array, i8>(this, fn);
  }

  reverse(): Int8Array {
    REVERSE<u8>(this.dataStart, this.length);
    return this;
  }

  join(separator: string = ","): string {
    return joinIntegerArray<i8>(this.dataStart, this.length, separator);
  }

  toString(): string {
    return this.join();
  }

  set<U extends ArrayLike<number>>(source: U, offset: i32 = 0): void {
    SET(this, source, offset);
  }

  static wrap(buffer: ArrayBuffer, byteOffset: i32 = 0, length: i32 = -1): Int8Array {
    return WRAP<Int8Array, i8>(buffer, byteOffset, length);
  }
}

export class Uint8Array extends ArrayBufferView {
  [key: number]: u8;

  // @ts-ignore: decorator
  @lazy
  static readonly BYTES_PER_ELEMENT: i32 = sizeof<u8>();

  constructor(length: i32) {
    super(length, alignof<u8>());
  }

  get length(): i32 {
    return this.byteLength;
  }

  @operator("[]")
  private __get(index: i32): u8 {
    if (<u32>index >= <u32>this.byteLength) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<u8>(this.dataStart + <usize>index);
  }

  @unsafe @operator("{}")
  private __uget(index: i32): u8 {
    return load<u8>(this.dataStart + <usize>index);
  }

  @operator("[]=")
  private __set(index: i32, value: native<u8>): void {
    if (<u32>index >= <u32>this.byteLength) throw new RangeError(E_INDEXOUTOFRANGE);
    store<u8>(this.dataStart + <usize>index, value);
  }

  @unsafe @operator("{}=")
  private __uset(index: i32, value: native<u8>): void {
    store<u8>(this.dataStart + <usize>index, value);
  }

  at(index: i32): u8 {
    let len = this.byteLength;
    index += select(0, len, index >= 0);
    if (<u32>index >= <u32>len) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<u8>(this.dataStart + <usize>index);
  }

  includes(searchElement: u8, fromIndex: i32 = 0): bool {
    return INCLUDES<Uint8Array, u8>(this, searchElement, fromIndex);
  }

  indexOf(searchElement: u8, fromIndex: i32 = 0): i32 {
    return INDEX_OF<Uint8Array, u8>(this, searchElement, fromIndex);
  }

  lastIndexOf(searchElement: u8, fromIndex: i32 = this.length): i32 {
    return LAST_INDEX_OF<Uint8Array, u8>(this, searchElement, fromIndex);
  }

  fill(value: u32, start: i32 = 0, end: i32 = i32.MAX_VALUE): Uint8Array {
    FILL<u8>(this.dataStart, this.length, u8(value), start, end);
    return this;
  }

  sort(comparator: (a: u8, b: u8) => i32 = COMPARATOR<u8>()): Uint8Array {
    SORT<u8>(this.dataStart, this.length, comparator);
    return this;
  }

  slice(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Uint8Array {
    return SLICE<Uint8Array, u8>(this, begin, end);
  }

  subarray(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Uint8Array {
    return SUBARRAY<Uint8Array, u8>(this, begin, end);
  }

  copyWithin(target: i32, start: i32, end: i32 = i32.MAX_VALUE): Uint8Array {
    return COPY_WITHIN<Uint8Array, u8>(this, target, start, end);
  }

  reduce<T extends number>(
    fn: (accumulator: T, value: u8, index: i32, array: Uint8Array) => T,
    initialValue: T,
  ): T {
    return REDUCE<Uint8Array, u8, T>(this, fn, initialValue);
  }

  reduceRight<T extends number>(
    fn: (accumulator: T, value: u8, index: i32, array: Uint8Array) => T,
    initialValue: T,
  ): T {
    return REDUCE_RIGHT<Uint8Array, u8, T>(this, fn, initialValue);
  }

  map(fn: (value: u8, index: i32, self: Uint8Array) => u8): Uint8Array {
    return MAP<Uint8Array, u8>(this, fn);
  }

  filter(fn: (value: u8, index: i32, self: Uint8Array) => bool): Uint8Array {
    return FILTER<Uint8Array, u8>(this, fn);
  }

  findIndex(fn: (value: u8, index: i32, self: Uint8Array) => bool): i32 {
    return FIND_INDEX<Uint8Array, u8>(this, fn);
  }

  findLastIndex(fn: (value: u8, index: i32, self: Uint8Array) => bool): i32 {
    return FIND_LAST_INDEX<Uint8Array, u8>(this, fn);
  }

  some(fn: (value: u8, index: i32, self: Uint8Array) => bool): bool {
    return SOME<Uint8Array, u8>(this, fn);
  }

  every(fn: (value: u8, index: i32, self: Uint8Array) => bool): bool {
    return EVERY<Uint8Array, u8>(this, fn);
  }

  forEach(fn: (value: u8, index: i32, self: Uint8Array) => void): void {
    FOREACH<Uint8Array, u8>(this, fn);
  }

  reverse(): Uint8Array {
    REVERSE<u8>(this.dataStart, this.length);
    return this;
  }

  join(separator: string = ","): string {
    return joinIntegerArray<u8>(this.dataStart, this.length, separator);
  }

  set<U extends ArrayLike<number>>(source: U, offset: i32 = 0): void {
    SET(this, source, offset);
  }

  toString(): string {
    return this.join();
  }

  static wrap(buffer: ArrayBuffer, byteOffset: i32 = 0, length: i32 = -1): Uint8Array {
    return WRAP<Uint8Array, u8>(buffer, byteOffset, length);
  }
}

export class Uint8ClampedArray extends ArrayBufferView {
  [key: number]: u8;

  // @ts-ignore: decorator
  @lazy
  static readonly BYTES_PER_ELEMENT: i32 = sizeof<u8>();

  constructor(length: i32) {
    super(length, alignof<u8>());
  }

  get length(): i32 {
    return this.byteLength;
  }

  @operator("[]")
  private __get(index: i32): u8 {
    if (<u32>index >= <u32>this.byteLength) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<u8>(this.dataStart + <usize>index);
  }

  @unsafe @operator("{}")
  private __uget(index: i32): u8 {
    return load<u8>(this.dataStart + <usize>index);
  }

  @operator("[]=")
  private __set(index: i32, value: native<u8>): void {
    if (<u32>index >= <u32>this.byteLength) throw new RangeError(E_INDEXOUTOFRANGE);
    store<u8>(this.dataStart + <usize>index, ~(<i32>value >> 31) & (((255 - value) >> 31) | value));
  }

  @unsafe @operator("{}=")
  private __uset(index: i32, value: native<u8>): void {
    store<u8>(this.dataStart + <usize>index, ~(<i32>value >> 31) & (((255 - value) >> 31) | value));
  }

  at(index: i32): u8 {
    let len = this.byteLength;
    index += select(0, len, index >= 0);
    if (<u32>index >= <u32>len) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<u8>(this.dataStart + <usize>index);
  }

  includes(searchElement: u8, fromIndex: i32 = 0): bool {
    return INCLUDES<Uint8ClampedArray, u8>(this, searchElement, fromIndex);
  }

  indexOf(searchElement: u8, fromIndex: i32 = 0): i32 {
    return INDEX_OF<Uint8ClampedArray, u8>(this, searchElement, fromIndex);
  }

  lastIndexOf(searchElement: u8, fromIndex: i32 = this.length): i32 {
    return LAST_INDEX_OF<Uint8ClampedArray, u8>(this, searchElement, fromIndex);
  }

  fill(value: i32, start: i32 = 0, end: i32 = i32.MAX_VALUE): Uint8ClampedArray {
    value = ~(value >> 31) & (((255 - value) >> 31) | value);
    FILL<u8>(this.dataStart, this.length, u8(value), start, end);
    return this;
  }

  sort(comparator: (a: u8, b: u8) => i32 = COMPARATOR<u8>()): Uint8ClampedArray {
    SORT<u8>(this.dataStart, this.length, comparator);
    return this;
  }

  slice(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Uint8ClampedArray {
    return SLICE<Uint8ClampedArray, u8>(this, begin, end);
  }

  subarray(start: i32 = 0, end: i32 = i32.MAX_VALUE): Uint8ClampedArray {
    return SUBARRAY<Uint8ClampedArray, u8>(this, start, end);
  }

  copyWithin(target: i32, start: i32, end: i32 = i32.MAX_VALUE): Uint8ClampedArray {
    return COPY_WITHIN<Uint8ClampedArray, u8>(this, target, start, end);
  }

  reduce<T extends number>(
    fn: (accumulator: T, value: u8, index: i32, array: Uint8ClampedArray) => T,
    initialValue: T,
  ): T {
    return REDUCE<Uint8ClampedArray, u8, T>(this, fn, initialValue);
  }

  reduceRight<T extends number>(
    fn: (accumulator: T, value: u8, index: i32, array: Uint8ClampedArray) => T,
    initialValue: T,
  ): T {
    return REDUCE_RIGHT<Uint8ClampedArray, u8, T>(this, fn, initialValue);
  }

  map(fn: (value: u8, index: i32, self: Uint8ClampedArray) => u8): Uint8ClampedArray {
    return MAP<Uint8ClampedArray, u8>(this, fn);
  }

  filter(fn: (value: u8, index: i32, self: Uint8ClampedArray) => bool): Uint8ClampedArray {
    return FILTER<Uint8ClampedArray, u8>(this, fn);
  }

  findIndex(fn: (value: u8, index: i32, self: Uint8ClampedArray) => bool): i32 {
    return FIND_INDEX<Uint8ClampedArray, u8>(this, fn);
  }

  findLastIndex(fn: (value: u8, index: i32, self: Uint8ClampedArray) => bool): i32 {
    return FIND_LAST_INDEX<Uint8ClampedArray, u8>(this, fn);
  }

  some(fn: (value: u8, index: i32, self: Uint8ClampedArray) => bool): bool {
    return SOME<Uint8ClampedArray, u8>(this, fn);
  }

  every(fn: (value: u8, index: i32, self: Uint8ClampedArray) => bool): bool {
    return EVERY<Uint8ClampedArray, u8>(this, fn);
  }

  forEach(fn: (value: u8, index: i32, self: Uint8ClampedArray) => void): void {
    FOREACH<Uint8ClampedArray, u8>(this, fn);
  }

  reverse(): Uint8ClampedArray {
    REVERSE<u8>(this.dataStart, this.length);
    return this;
  }

  join(separator: string = ","): string {
    return joinIntegerArray<u8>(this.dataStart, this.length, separator);
  }

  set<U extends ArrayLike<number>>(source: U, offset: i32 = 0): void {
    SET(this, source, offset);
  }

  toString(): string {
    return this.join();
  }

  static wrap(buffer: ArrayBuffer, byteOffset: i32 = 0, length: i32 = -1): Uint8ClampedArray {
    return WRAP<Uint8ClampedArray, u8>(buffer, byteOffset, length);
  }
}

export class Int16Array extends ArrayBufferView {
  [key: number]: i16;

  // @ts-ignore: decorator
  @lazy
  static readonly BYTES_PER_ELEMENT: i32 = sizeof<i16>();

  constructor(length: i32) {
    super(length, alignof<i16>());
  }

  get length(): i32 {
    return this.byteLength >>> alignof<i16>();
  }

  @operator("[]")
  private __get(index: i32): i16 {
    if (<u32>index >= <u32>this.byteLength >>> alignof<i16>()) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<i16>(this.dataStart + (<usize>index << alignof<i16>()));
  }

  @unsafe @operator("{}")
  private __uget(index: i32): i16 {
    return load<i16>(this.dataStart + (<usize>index << alignof<i16>()));
  }

  @operator("[]=")
  private __set(index: i32, value: native<i16>): void {
    if (<u32>index >= <u32>this.byteLength >>> alignof<i16>()) throw new RangeError(E_INDEXOUTOFRANGE);
    store<i16>(this.dataStart + (<usize>index << alignof<i16>()), value);
  }

  @unsafe @operator("{}=")
  private __uset(index: i32, value: native<i16>): void {
    store<i16>(this.dataStart + (<usize>index << alignof<i16>()), value);
  }

  at(index: i32): i16 {
    let len = this.byteLength >>> alignof<i16>();
    index += select(0, len, index >= 0);
    if (<u32>index >= <u32>len) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<i16>(this.dataStart + (<usize>index << alignof<i16>()));
  }

  includes(searchElement: i16, fromIndex: i32 = 0): bool {
    return INCLUDES<Int16Array, i16>(this, searchElement, fromIndex);
  }

  indexOf(searchElement: i16, fromIndex: i32 = 0): i32 {
    return INDEX_OF<Int16Array, i16>(this, searchElement, fromIndex);
  }

  lastIndexOf(searchElement: i16, fromIndex: i32 = this.length): i32 {
    return LAST_INDEX_OF<Int16Array, i16>(this, searchElement, fromIndex);
  }

  fill(value: i32, start: i32 = 0, end: i32 = i32.MAX_VALUE): Int16Array {
    FILL<u16>(this.dataStart, this.length, u16(value), start, end);
    return this;
  }

  sort(comparator: (a: i16, b: i16) => i32 = COMPARATOR<i16>()): Int16Array {
    SORT<i16>(this.dataStart, this.length, comparator);
    return this;
  }

  slice(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Int16Array {
    return SLICE<Int16Array, i16>(this, begin, end);
  }

  subarray(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Int16Array {
    return SUBARRAY<Int16Array, i16>(this, begin, end);
  }

  copyWithin(target: i32, start: i32, end: i32 = i32.MAX_VALUE): Int16Array {
    return COPY_WITHIN<Int16Array, i16>(this, target, start, end);
  }

  reduce<T extends number>(
    fn: (accumulator: T, value: i16, index: i32, array: Int16Array) => T,
    initialValue: T,
  ): T {
    return REDUCE<Int16Array, i16, T>(this, fn, initialValue);
  }

  reduceRight<T extends number>(
    fn: (accumulator: T, value: i16, index: i32, array: Int16Array) => T,
    initialValue: T,
  ): T {
    return REDUCE_RIGHT<Int16Array, i16, T>(this, fn, initialValue);
  }

  map(fn: (value: i16, index: i32, self: Int16Array) => i16): Int16Array {
    return MAP<Int16Array, i16>(this, fn);
  }

  filter(fn: (value: i16, index: i32, self: Int16Array) => bool): Int16Array {
    return FILTER<Int16Array, i16>(this, fn);
  }

  findIndex(fn: (value: i16, index: i32, self: Int16Array) => bool): i32 {
    return FIND_INDEX<Int16Array, i16>(this, fn);
  }

  findLastIndex(fn: (value: i16, index: i32, self: Int16Array) => bool): i32 {
    return FIND_LAST_INDEX<Int16Array, i16>(this, fn);
  }

  some(fn: (value: i16, index: i32, self: Int16Array) => bool): bool {
    return SOME<Int16Array, i16>(this, fn);
  }

  every(fn: (value: i16, index: i32, self: Int16Array) => bool): bool {
    return EVERY<Int16Array, i16>(this, fn);
  }

  forEach(fn: (value: i16, index: i32, self: Int16Array) => void): void {
    FOREACH<Int16Array, i16>(this, fn);
  }

  reverse(): Int16Array {
    REVERSE<u16>(this.dataStart, this.length);
    return this;
  }

  join(separator: string = ","): string {
    return joinIntegerArray<i16>(this.dataStart, this.length, separator);
  }

  set<U extends ArrayLike<number>>(source: U, offset: i32 = 0): void {
    SET(this, source, offset);
  }

  toString(): string {
    return this.join();
  }

  static wrap(buffer: ArrayBuffer, byteOffset: i32 = 0, length: i32 = -1): Int16Array {
    return WRAP<Int16Array, i16>(buffer, byteOffset, length);
  }
}

export class Uint16Array extends ArrayBufferView {
  [key: number]: u16;

  // @ts-ignore: decorator
  @lazy
  static readonly BYTES_PER_ELEMENT: i32 = sizeof<u16>();

  constructor(length: i32) {
    super(length, alignof<u16>());
  }

  get length(): i32 {
    return this.byteLength >>> alignof<u16>();
  }

  @operator("[]")
  private __get(index: i32): u16 {
    if (<u32>index >= <u32>this.byteLength >>> alignof<u16>()) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<u16>(this.dataStart + (<usize>index << alignof<u16>()));
  }

  @unsafe @operator("{}")
  private __uget(index: i32): u16 {
    return load<u16>(this.dataStart + (<usize>index << alignof<u16>()));
  }

  @operator("[]=")
  private __set(index: i32, value: native<u16>): void {
    if (<u32>index >= <u32>this.byteLength >>> alignof<u16>()) throw new RangeError(E_INDEXOUTOFRANGE);
    store<u16>(this.dataStart + (<usize>index << alignof<u16>()), value);
  }

  @unsafe @operator("{}=")
  private __uset(index: i32, value: native<u16>): void {
    store<u16>(this.dataStart + (<usize>index << alignof<u16>()), value);
  }

  at(index: i32): u16 {
    let len = this.byteLength >>> alignof<u16>();
    index += select(0, len, index >= 0);
    if (<u32>index >= <u32>len) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<u16>(this.dataStart + (<usize>index << alignof<u16>()));
  }

  includes(searchElement: u16, fromIndex: i32 = 0): bool {
    return INCLUDES<Uint16Array, u16>(this, searchElement, fromIndex);
  }

  indexOf(searchElement: u16, fromIndex: i32 = 0): i32 {
    return INDEX_OF<Uint16Array, u16>(this, searchElement, fromIndex);
  }

  lastIndexOf(searchElement: u16, fromIndex: i32 = this.length): i32 {
    return LAST_INDEX_OF<Uint16Array, u16>(this, searchElement, fromIndex);
  }

  fill(value: u32, start: i32 = 0, end: i32 = i32.MAX_VALUE): Uint16Array {
    FILL<u16>(this.dataStart, this.length, u16(value), start, end);
    return this;
  }

  sort(comparator: (a: u16, b: u16) => i32 = COMPARATOR<u16>()): Uint16Array {
    SORT<u16>(this.dataStart, this.length, comparator);
    return this;
  }

  slice(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Uint16Array {
    return SLICE<Uint16Array, u16>(this, begin, end);
  }

  subarray(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Uint16Array {
    return SUBARRAY<Uint16Array, u16>(this, begin, end);
  }

  copyWithin(target: i32, start: i32, end: i32 = i32.MAX_VALUE): Uint16Array {
    return COPY_WITHIN<Uint16Array, u16>(this, target, start, end);
  }

  reduce<T extends number>(
    fn: (accumulator: T, value: u16, index: i32, array: Uint16Array) => T,
    initialValue: T,
  ): T {
    return REDUCE<Uint16Array, u16, T>(this, fn, initialValue);
  }

  reduceRight<T extends number>(
    fn: (accumulator: T, value: u16, index: i32, array: Uint16Array) => T,
    initialValue: T,
  ): T {
    return REDUCE_RIGHT<Uint16Array, u16, T>(this, fn, initialValue);
  }

  map(fn: (value: u16, index: i32, self: Uint16Array) => u16): Uint16Array {
    return MAP<Uint16Array, u16>(this, fn);
  }

  filter(fn: (value: u16, index: i32, self: Uint16Array) => bool): Uint16Array {
    return FILTER<Uint16Array, u16>(this, fn);
  }

  findIndex(fn: (value: u16, index: i32, self: Uint16Array) => bool): i32 {
    return FIND_INDEX<Uint16Array, u16>(this, fn);
  }

  findLastIndex(fn: (value: u16, index: i32, self: Uint16Array) => bool): i32 {
    return FIND_LAST_INDEX<Uint16Array, u16>(this, fn);
  }

  some(fn: (value: u16, index: i32, self: Uint16Array) => bool): bool {
    return SOME<Uint16Array, u16>(this, fn);
  }

  every(fn: (value: u16, index: i32, self: Uint16Array) => bool): bool {
    return EVERY<Uint16Array, u16>(this, fn);
  }

  forEach(fn: (value: u16, index: i32, self: Uint16Array) => void): void {
    FOREACH<Uint16Array, u16>(this, fn);
  }

  reverse(): Uint16Array {
    REVERSE<u16>(this.dataStart, this.length);
    return this;
  }

  join(separator: string = ","): string {
    return joinIntegerArray<u16>(this.dataStart, this.length, separator);
  }

  set<U extends ArrayLike<number>>(source: U, offset: i32 = 0): void {
    SET(this, source, offset);
  }

  toString(): string {
    return this.join();
  }

  static wrap(buffer: ArrayBuffer, byteOffset: i32 = 0, length: i32 = -1): Uint16Array {
    return WRAP<Uint16Array, u16>(buffer, byteOffset, length);
  }
}

export class Int32Array extends ArrayBufferView {
  [key: number]: i32;

  // @ts-ignore: decorator
  @lazy
  static readonly BYTES_PER_ELEMENT: i32 = sizeof<i32>();

  constructor(length: i32) {
    super(length, alignof<i32>());
  }

  get length(): i32 {
    return this.byteLength >>> alignof<i32>();
  }

  @operator("[]")
  private __get(index: i32): i32 {
    if (<u32>index >= <u32>this.byteLength >>> alignof<i32>()) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<i32>(this.dataStart + (<usize>index << alignof<i32>()));
  }

  @unsafe @operator("{}")
  private __uget(index: i32): i32 {
    return load<i32>(this.dataStart + (<usize>index << alignof<i32>()));
  }

  @operator("[]=")
  private __set(index: i32, value: i32): void {
    if (<u32>index >= <u32>this.byteLength >>> alignof<i32>()) throw new RangeError(E_INDEXOUTOFRANGE);
    store<i32>(this.dataStart + (<usize>index << alignof<i32>()), value);
  }

  @unsafe @operator("{}=")
  private __uset(index: i32, value: i32): void {
    store<i32>(this.dataStart + (<usize>index << alignof<i32>()), value);
  }

  at(index: i32): i32 {
    let len = this.byteLength >>> alignof<i32>();
    index += select(0, len, index >= 0);
    if (<u32>index >= <u32>len) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<i32>(this.dataStart + (<usize>index << alignof<i32>()));
  }

  includes(searchElement: i32, fromIndex: i32 = 0): bool {
    return INCLUDES<Int32Array, i32>(this, searchElement, fromIndex);
  }

  indexOf(searchElement: i32, fromIndex: i32 = 0): i32 {
    return INDEX_OF<Int32Array, i32>(this, searchElement, fromIndex);
  }

  lastIndexOf(searchElement: i32, fromIndex: i32 = this.length): i32 {
    return LAST_INDEX_OF<Int32Array, i32>(this, searchElement, fromIndex);
  }

  fill(value: i32, start: i32 = 0, end: i32 = i32.MAX_VALUE): Int32Array {
    FILL<u32>(this.dataStart, this.length, u32(value), start, end);
    return this;
  }

  sort(comparator: (a: i32, b: i32) => i32 = COMPARATOR<i32>()): Int32Array {
    SORT<i32>(this.dataStart, this.length, comparator);
    return this;
  }

  slice(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Int32Array {
    return SLICE<Int32Array, i32>(this, begin, end);
  }

  subarray(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Int32Array {
    return SUBARRAY<Int32Array, i32>(this, begin, end);
  }

  copyWithin(target: i32, start: i32, end: i32 = i32.MAX_VALUE): Int32Array {
    return COPY_WITHIN<Int32Array, i32>(this, target, start, end);
  }

  reduce<T extends number>(
    fn: (accumulator: T, value: i32, index: i32, array: Int32Array) => T,
    initialValue: T,
  ): T {
    return REDUCE<Int32Array, i32, T>(this, fn, initialValue);
  }

  reduceRight<T extends number>(
    fn: (accumulator: T, value: i32, index: i32, array: Int32Array) => T,
    initialValue: T,
  ): T {
    return REDUCE_RIGHT<Int32Array, i32, T>(this, fn, initialValue);
  }

  map(fn: (value: i32, index: i32, self: Int32Array) => i32): Int32Array {
    return MAP<Int32Array, i32>(this, fn);
  }

  filter(fn: (value: i32, index: i32, self: Int32Array) => bool): Int32Array {
    return FILTER<Int32Array, i32>(this, fn);
  }

  findIndex(fn: (value: i32, index: i32, self: Int32Array) => bool): i32 {
    return FIND_INDEX<Int32Array, i32>(this, fn);
  }

  findLastIndex(fn: (value: i32, index: i32, self: Int32Array) => bool): i32 {
    return FIND_LAST_INDEX<Int32Array, i32>(this, fn);
  }

  some(fn: (value: i32, index: i32, self: Int32Array) => bool): bool {
    return SOME<Int32Array, i32>(this, fn);
  }

  every(fn: (value: i32, index: i32, self: Int32Array) => bool): bool {
    return EVERY<Int32Array, i32>(this, fn);
  }

  forEach(fn: (value: i32, index: i32, self: Int32Array) => void): void {
    FOREACH<Int32Array, i32>(this, fn);
  }

  reverse(): Int32Array {
    REVERSE<u32>(this.dataStart, this.length);
    return this;
  }

  join(separator: string = ","): string {
    return joinIntegerArray<i32>(this.dataStart, this.length, separator);
  }

  set<U extends ArrayLike<number>>(source: U, offset: i32 = 0): void {
    SET(this, source, offset);
  }

  toString(): string {
    return this.join();
  }

  static wrap(buffer: ArrayBuffer, byteOffset: i32 = 0, length: i32 = -1): Int32Array {
    return WRAP<Int32Array, i32>(buffer, byteOffset, length);
  }
}

export class Uint32Array extends ArrayBufferView {
  [key: number]: u32;

  // @ts-ignore: decorator
  @lazy
  static readonly BYTES_PER_ELEMENT: i32 = sizeof<u32>();

  constructor(length: i32) {
    super(length, alignof<u32>());
  }

  get length(): i32 {
    return this.byteLength >>> alignof<u32>();
  }

  @operator("[]")
  private __get(index: i32): u32 {
    if (<u32>index >= <u32>this.byteLength >>> alignof<u32>()) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<u32>(this.dataStart + (<usize>index << alignof<u32>()));
  }

  @unsafe @operator("{}")
  private __uget(index: i32): u32 {
    return load<u32>(this.dataStart + (<usize>index << alignof<u32>()));
  }

  @operator("[]=")
  private __set(index: i32, value: u32): void {
    if (<u32>index >= <u32>this.byteLength >>> alignof<u32>()) throw new RangeError(E_INDEXOUTOFRANGE);
    store<u32>(this.dataStart + (<usize>index << alignof<u32>()), value);
  }

  @unsafe @operator("{}=")
  private __uset(index: i32, value: u32): void {
    store<u32>(this.dataStart + (<usize>index << alignof<u32>()), value);
  }

  at(index: i32): u32 {
    let len = this.byteLength >>> alignof<u32>();
    index += select(0, len, index >= 0);
    if (<u32>index >= <u32>len) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<u32>(this.dataStart + (<usize>index << alignof<u32>()));
  }

  includes(searchElement: u32, fromIndex: i32 = 0): bool {
    return INCLUDES<Uint32Array, u32>(this, searchElement, fromIndex);
  }

  indexOf(searchElement: u32, fromIndex: i32 = 0): i32 {
    return INDEX_OF<Uint32Array, u32>(this, searchElement, fromIndex);
  }

  lastIndexOf(searchElement: u32, fromIndex: i32 = this.length): i32 {
    return LAST_INDEX_OF<Uint32Array, u32>(this, searchElement, fromIndex);
  }

  fill(value: u32, start: i32 = 0, end: i32 = i32.MAX_VALUE): Uint32Array {
    FILL<u32>(this.dataStart, this.length, value, start, end);
    return this;
  }

  sort(comparator: (a: u32, b: u32) => i32 = COMPARATOR<u32>()): Uint32Array {
    SORT<u32>(this.dataStart, this.length, comparator);
    return this;
  }

  slice(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Uint32Array {
    return SLICE<Uint32Array, u32>(this, begin, end);
  }

  subarray(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Uint32Array {
    return SUBARRAY<Uint32Array, u32>(this, begin, end);
  }

  copyWithin(target: i32, start: i32, end: i32 = i32.MAX_VALUE): Uint32Array {
    return COPY_WITHIN<Uint32Array, u32>(this, target, start, end);
  }

  reduce<T extends number>(
    fn: (accumulator: T, value: u32, index: i32, array: Uint32Array) => T,
    initialValue: T,
  ): T {
    return REDUCE<Uint32Array, u32, T>(this, fn, initialValue);
  }

  reduceRight<T extends number>(
    fn: (accumulator: T, value: u32, index: i32, array: Uint32Array) => T,
    initialValue: T,
  ): T {
    return REDUCE_RIGHT<Uint32Array, u32, T>(this, fn, initialValue);
  }

  map(fn: (value: u32, index: i32, self: Uint32Array) => u32): Uint32Array {
    return MAP<Uint32Array, u32>(this, fn);
  }

  filter(fn: (value: u32, index: i32, self: Uint32Array) => bool): Uint32Array {
    return FILTER<Uint32Array, u32>(this, fn);
  }

  findIndex(fn: (value: u32, index: i32, self: Uint32Array) => bool): i32 {
    return FIND_INDEX<Uint32Array, u32>(this, fn);
  }

  findLastIndex(fn: (value: u32, index: i32, self: Uint32Array) => bool): i32 {
    return FIND_LAST_INDEX<Uint32Array, u32>(this, fn);
  }

  some(fn: (value: u32, index: i32, self: Uint32Array) => bool): bool {
    return SOME<Uint32Array, u32>(this, fn);
  }

  every(fn: (value: u32, index: i32, self: Uint32Array) => bool): bool {
    return EVERY<Uint32Array, u32>(this, fn);
  }

  forEach(fn: (value: u32, index: i32, self: Uint32Array) => void): void {
    FOREACH<Uint32Array, u32>(this, fn);
  }

  reverse(): Uint32Array {
    REVERSE<u32>(this.dataStart, this.length);
    return this;
  }

  join(separator: string = ","): string {
    return joinIntegerArray<u32>(this.dataStart, this.length, separator);
  }

  set<U extends ArrayLike<number>>(source: U, offset: i32 = 0): void {
    SET(this, source, offset);
  }

  toString(): string {
    return this.join();
  }

  static wrap(buffer: ArrayBuffer, byteOffset: i32 = 0, length: i32 = -1): Uint32Array {
    return WRAP<Uint32Array, u32>(buffer, byteOffset, length);
  }
}

export class Int64Array extends ArrayBufferView {
  [key: number]: i64;

  // @ts-ignore: decorator
  @lazy
  static readonly BYTES_PER_ELEMENT: i32 = sizeof<i64>();

  constructor(length: i32) {
    super(length, alignof<i64>());
  }

  get length(): i32 {
    return this.byteLength >>> alignof<i64>();
  }

  @operator("[]")
  private __get(index: i32): i64 {
    if (<u32>index >= <u32>this.byteLength >>> alignof<i64>()) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<i64>(this.dataStart + (<usize>index << alignof<i64>()));
  }

  @unsafe @operator("{}")
  private __uget(index: i32): i64 {
    return load<i64>(this.dataStart + (<usize>index << alignof<i64>()));
  }

  @operator("[]=")
  private __set(index: i32, value: i64): void {
    if (<u32>index >= <u32>this.byteLength >>> alignof<i64>()) throw new RangeError(E_INDEXOUTOFRANGE);
    store<i64>(this.dataStart + (<usize>index << alignof<i64>()), value);
  }

  @unsafe @operator("{}=")
  private __uset(index: i32, value: i64): void {
    store<i64>(this.dataStart + (<usize>index << alignof<i64>()), value);
  }

  at(index: i32): i64 {
    let len = this.byteLength >>> alignof<i64>();
    index += select(0, len, index >= 0);
    if (<u32>index >= <u32>len) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<i64>(this.dataStart + (<usize>index << alignof<i64>()));
  }

  includes(searchElement: i64, fromIndex: i32 = 0): bool {
    return INCLUDES<Int64Array, i64>(this, searchElement, fromIndex);
  }

  indexOf(searchElement: i64, fromIndex: i32 = 0): i32 {
    return INDEX_OF<Int64Array, i64>(this, searchElement, fromIndex);
  }

  lastIndexOf(searchElement: i64, fromIndex: i32 = this.length): i32 {
    return LAST_INDEX_OF<Int64Array, i64>(this, searchElement, fromIndex);
  }

  fill(value: i64, start: i32 = 0, end: i32 = i32.MAX_VALUE): Int64Array {
    FILL<u64>(this.dataStart, this.length, u64(value), start, end);
    return this;
  }

  sort(comparator: (a: i64, b: i64) => i32 = COMPARATOR<i64>()): Int64Array {
    SORT<i64>(this.dataStart, this.length, comparator);
    return this;
  }

  slice(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Int64Array {
    return SLICE<Int64Array, i64>(this, begin, end);
  }

  subarray(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Int64Array {
    return SUBARRAY<Int64Array, i64>(this, begin, end);
  }

  copyWithin(target: i32, start: i32, end: i32 = i32.MAX_VALUE): Int64Array {
    return COPY_WITHIN<Int64Array, i64>(this, target, start, end);
  }

  reduce<T extends number>(
    fn: (accumulator: T, value: i64, index: i32, array: Int64Array) => T,
    initialValue: T,
  ): T {
    return REDUCE<Int64Array, i64, T>(this, fn, initialValue);
  }

  reduceRight<T extends number>(
    fn: (accumulator: T, value: i64, index: i32, array: Int64Array) => T,
    initialValue: T,
  ): T {
    return REDUCE_RIGHT<Int64Array, i64, T>(this, fn, initialValue);
  }

  map(fn: (value: i64, index: i32, self: Int64Array) => i64): Int64Array {
    return MAP<Int64Array, i64>(this, fn);
  }

  filter(fn: (value: i64, index: i32, self: Int64Array) => bool): Int64Array {
    return FILTER<Int64Array, i64>(this, fn);
  }

  findIndex(fn: (value: i64, index: i32, self: Int64Array) => bool): i32 {
    return FIND_INDEX<Int64Array, i64>(this, fn);
  }

  findLastIndex(fn: (value: i64, index: i32, self: Int64Array) => bool): i32 {
    return FIND_LAST_INDEX<Int64Array, i64>(this, fn);
  }

  some(fn: (value: i64, index: i32, self: Int64Array) => bool): bool {
    return SOME<Int64Array, i64>(this, fn);
  }

  every(fn: (value: i64, index: i32, self: Int64Array) => bool): bool {
    return EVERY<Int64Array, i64>(this, fn);
  }

  forEach(fn: (value: i64, index: i32, self: Int64Array) => void): void {
    FOREACH<Int64Array, i64>(this, fn);
  }

  reverse(): Int64Array {
    REVERSE<u64>(this.dataStart, this.length);
    return this;
  }

  join(separator: string = ","): string {
    return joinIntegerArray<i64>(this.dataStart, this.length, separator);
  }

  set<U extends ArrayLike<number>>(source: U, offset: i32 = 0): void {
    SET(this, source, offset);
  }

  toString(): string {
    return this.join();
  }

  static wrap(buffer: ArrayBuffer, byteOffset: i32 = 0, length: i32 = -1): Int64Array {
    return WRAP<Int64Array, i64>(buffer, byteOffset, length);
  }
}

export class Uint64Array extends ArrayBufferView {
  [key: number]: u64;

  // @ts-ignore: decorator
  @lazy
  static readonly BYTES_PER_ELEMENT: i32 = sizeof<u64>();

  constructor(length: i32) {
    super(length, alignof<u64>());
  }

  get length(): i32 {
    return this.byteLength >>> alignof<u64>();
  }

  @operator("[]")
  private __get(index: i32): u64 {
    if (<u32>index >= <u32>this.byteLength >>> alignof<u64>()) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<u64>(this.dataStart + (<usize>index << alignof<u64>()));
  }

  @unsafe @operator("{}")
  private __uget(index: i32): u64 {
    return load<u64>(this.dataStart + (<usize>index << alignof<u64>()));
  }

  @operator("[]=")
  private __set(index: i32, value: u64): void {
    if (<u32>index >= <u32>this.byteLength >>> alignof<u64>()) throw new RangeError(E_INDEXOUTOFRANGE);
    store<u64>(this.dataStart + (<usize>index << alignof<u64>()), value);
  }

  @unsafe @operator("{}=")
  private __uset(index: i32, value: u64): void {
    store<u64>(this.dataStart + (<usize>index << alignof<u64>()), value);
  }

  at(index: i32): u64 {
    let len = this.byteLength >>> alignof<u64>();
    index += select(0, len, index >= 0);
    if (<u32>index >= <u32>len) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<u64>(this.dataStart + (<usize>index << alignof<u64>()));
  }

  includes(searchElement: u64, fromIndex: i32 = 0): bool {
    return INCLUDES<Uint64Array, u64>(this, searchElement, fromIndex);
  }

  indexOf(searchElement: u64, fromIndex: i32 = 0): i32 {
    return INDEX_OF<Uint64Array, u64>(this, searchElement, fromIndex);
  }

  lastIndexOf(searchElement: u64, fromIndex: i32 = this.length): i32 {
    return LAST_INDEX_OF<Uint64Array, u64>(this, searchElement, fromIndex);
  }

  fill(value: u64, start: i32 = 0, end: i32 = i32.MAX_VALUE): Uint64Array {
    FILL<u64>(this.dataStart, this.length, value, start, end);
    return this;
  }

  sort(comparator: (a: u64, b: u64) => i32 = COMPARATOR<u64>()): Uint64Array {
    SORT<u64>(this.dataStart, this.length, comparator);
    return this;
  }

  slice(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Uint64Array {
    return SLICE<Uint64Array, u64>(this, begin, end);
  }

  subarray(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Uint64Array {
    return SUBARRAY<Uint64Array, u64>(this, begin, end);
  }

  copyWithin(target: i32, start: i32, end: i32 = i32.MAX_VALUE): Uint64Array {
    return COPY_WITHIN<Uint64Array, u64>(this, target, start, end);
  }

  reduce<T extends number>(
    fn: (accumulator: T, value: u64, index: i32, array: Uint64Array) => T,
    initialValue: T,
  ): T {
    return REDUCE<Uint64Array, u64, T>(this, fn, initialValue);
  }

  reduceRight<T extends number>(
    fn: (accumulator: T, value: u64, index: i32, array: Uint64Array) => T,
    initialValue: T,
  ): T {
    return REDUCE_RIGHT<Uint64Array, u64, T>(this, fn, initialValue);
  }

  map(fn: (value: u64, index: i32, self: Uint64Array) => u64): Uint64Array {
    return MAP<Uint64Array, u64>(this, fn);
  }

  filter(fn: (value: u64, index: i32, self: Uint64Array) => bool): Uint64Array {
    return FILTER<Uint64Array, u64>(this, fn);
  }

  findIndex(fn: (value: u64, index: i32, self: Uint64Array) => bool): i32 {
    return FIND_INDEX<Uint64Array, u64>(this, fn);
  }

  findLastIndex(fn: (value: u64, index: i32, self: Uint64Array) => bool): i32 {
    return FIND_LAST_INDEX<Uint64Array, u64>(this, fn);
  }

  some(fn: (value: u64, index: i32, self: Uint64Array) => bool): bool {
    return SOME<Uint64Array, u64>(this, fn);
  }

  every(fn: (value: u64, index: i32, self: Uint64Array) => bool): bool {
    return EVERY<Uint64Array, u64>(this, fn);
  }

  forEach(fn: (value: u64, index: i32, self: Uint64Array) => void): void {
    FOREACH<Uint64Array, u64>(this, fn);
  }

  reverse(): Uint64Array {
    REVERSE<u64>(this.dataStart, this.length);
    return this;
  }

  join(separator: string = ","): string {
    return joinIntegerArray<u64>(this.dataStart, this.length, separator);
  }

  set<U extends ArrayLike<number>>(source: U, offset: i32 = 0): void {
    SET(this, source, offset);
  }

  toString(): string {
    return this.join();
  }

  static wrap(buffer: ArrayBuffer, byteOffset: i32 = 0, length: i32 = -1): Uint64Array {
    return WRAP<Uint64Array, u64>(buffer, byteOffset, length);
  }
}

export class Float32Array extends ArrayBufferView {
  [key: number]: f32;

  // @ts-ignore: decorator
  @lazy
  static readonly BYTES_PER_ELEMENT: i32 = sizeof<f32>();

  constructor(length: i32) {
    super(length, alignof<f32>());
  }

  get length(): i32 {
    return this.byteLength >>> alignof<f32>();
  }

  @operator("[]")
  private __get(index: i32): f32 {
    if (<u32>index >= <u32>this.byteLength >>> alignof<f32>()) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<f32>(this.dataStart + (<usize>index << alignof<f32>()));
  }

  @unsafe @operator("{}")
  private __uget(index: i32): f32 {
    return load<f32>(this.dataStart + (<usize>index << alignof<f32>()));
  }

  @operator("[]=")
  private __set(index: i32, value: f32): void {
    if (<u32>index >= <u32>this.byteLength >>> alignof<f32>()) throw new RangeError(E_INDEXOUTOFRANGE);
    store<f32>(this.dataStart + (<usize>index << alignof<f32>()), value);
  }

  @unsafe @operator("{}=")
  private __uset(index: i32, value: f32): void {
    store<f32>(this.dataStart + (<usize>index << alignof<f32>()), value);
  }

  at(index: i32): f32 {
    let len = this.byteLength >>> alignof<f32>();
    index += select(0, len, index >= 0);
    if (<u32>index >= <u32>len) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<f32>(this.dataStart + (<usize>index << alignof<f32>()));
  }

  includes(searchElement: f32, fromIndex: i32 = 0): bool {
    return INCLUDES<Float32Array, f32>(this, searchElement, fromIndex);
  }

  indexOf(searchElement: f32, fromIndex: i32 = 0): i32 {
    return INDEX_OF<Float32Array, f32>(this, searchElement, fromIndex);
  }

  lastIndexOf(searchElement: f32, fromIndex: i32 = this.length): i32 {
    return LAST_INDEX_OF<Float32Array, f32>(this, searchElement, fromIndex);
  }

  fill(value: f32, start: i32 = 0, end: i32 = i32.MAX_VALUE): Float32Array {
    FILL<f32>(this.dataStart, this.length, value, start, end);
    return this;
  }

  sort(comparator: (a: f32, b: f32) => i32 = COMPARATOR<f32>()): Float32Array {
    SORT<f32>(this.dataStart, this.length, comparator);
    return this;
  }

  slice(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Float32Array {
    return SLICE<Float32Array, f32>(this, begin, end);
  }

  subarray(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Float32Array {
    return SUBARRAY<Float32Array, f32>(this, begin, end);
  }

  copyWithin(target: i32, start: i32, end: i32 = i32.MAX_VALUE): Float32Array {
    return COPY_WITHIN<Float32Array, f32>(this, target, start, end);
  }

  reduce<T extends number>(
    fn: (accumulator: T, value: f32, index: i32, array: Float32Array) => T,
    initialValue: T,
  ): T {
    return REDUCE<Float32Array, f32, T>(this, fn, initialValue);
  }

  reduceRight<T extends number>(
    fn: (accumulator: T, value: f32, index: i32, array: Float32Array) => T,
    initialValue: T,
  ): T {
    return REDUCE_RIGHT<Float32Array, f32, T>(this, fn, initialValue);
  }

  map(fn: (value: f32, index: i32, self: Float32Array) => f32): Float32Array {
    return MAP<Float32Array, f32>(this, fn);
  }

  filter(fn: (value: f32, index: i32, self: Float32Array) => bool): Float32Array {
    return FILTER<Float32Array, f32>(this, fn);
  }

  findIndex(fn: (value: f32, index: i32, self: Float32Array) => bool): i32 {
    return FIND_INDEX<Float32Array, f32>(this, fn);
  }

  findLastIndex(fn: (value: f32, index: i32, self: Float32Array) => bool): i32 {
    return FIND_LAST_INDEX<Float32Array, f32>(this, fn);
  }

  some(fn: (value: f32, index: i32, self: Float32Array) => bool): bool {
    return SOME<Float32Array, f32>(this, fn);
  }

  every(fn: (value: f32, index: i32, self: Float32Array) => bool): bool {
    return EVERY<Float32Array, f32>(this, fn);
  }

  forEach(fn: (value: f32, index: i32, self: Float32Array) => void): void {
    FOREACH<Float32Array, f32>(this, fn);
  }

  reverse(): Float32Array {
    REVERSE<f32>(this.dataStart, this.length);
    return this;
  }

  join(separator: string = ","): string {
    return joinFloatArray<f32>(this.dataStart, this.length, separator);
  }

  set<U extends ArrayLike<number>>(source: U, offset: i32 = 0): void {
    SET(this, source, offset);
  }

  toString(): string {
    return this.join();
  }

  static wrap(buffer: ArrayBuffer, byteOffset: i32 = 0, length: i32 = -1): Float32Array {
    return WRAP<Float32Array, f32>(buffer, byteOffset, length);
  }
}

export class Float64Array extends ArrayBufferView {
  [key: number]: f64;

  // @ts-ignore: decorator
  @lazy
  static readonly BYTES_PER_ELEMENT: i32 = sizeof<f64>();

  constructor(length: i32) {
    super(length, alignof<f64>());
  }

  get length(): i32 {
    return this.byteLength >>> alignof<f64>();
  }

  @operator("[]")
  private __get(index: i32): f64 {
    if (<u32>index >= <u32>this.byteLength >>> alignof<f64>()) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<f64>(this.dataStart + (<usize>index << alignof<f64>()));
  }

  @unsafe @operator("{}")
  private __uget(index: i32): f64 {
    return load<f64>(this.dataStart + (<usize>index << alignof<f64>()));
  }

  @operator("[]=")
  private __set(index: i32, value: f64): void {
    if (<u32>index >= <u32>this.byteLength >>> alignof<f64>()) throw new RangeError(E_INDEXOUTOFRANGE);
    store<f64>(this.dataStart + (<usize>index << alignof<f64>()), value);
  }

  @unsafe @operator("{}=")
  private __uset(index: i32, value: f64): void {
    store<f64>(this.dataStart + (<usize>index << alignof<f64>()), value);
  }

  at(index: i32): f64 {
    let len = this.byteLength >>> alignof<f64>();
    index += select(0, len, index >= 0);
    if (<u32>index >= <u32>len) throw new RangeError(E_INDEXOUTOFRANGE);
    return load<f64>(this.dataStart + (<usize>index << alignof<f64>()));
  }

  includes(searchElement: f64, fromIndex: i32 = 0): bool {
    return INCLUDES<Float64Array, f64>(this, searchElement, fromIndex);
  }

  indexOf(searchElement: f64, fromIndex: i32 = 0): i32 {
    return INDEX_OF<Float64Array, f64>(this, searchElement, fromIndex);
  }

  lastIndexOf(searchElement: f64, fromIndex: i32 = this.length): i32 {
    return LAST_INDEX_OF<Float64Array, f64>(this, searchElement, fromIndex);
  }

  fill(value: f64, start: i32 = 0, end: i32 = i32.MAX_VALUE): Float64Array {
    FILL<f64>(this.dataStart, this.length, value, start, end);
    return this;
  }

  sort(comparator: (a: f64, b: f64) => i32 = COMPARATOR<f64>()): Float64Array {
    SORT<f64>(this.dataStart, this.length, comparator);
    return this;
  }

  slice(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Float64Array {
    return SLICE<Float64Array, f64>(this, begin, end);
  }

  subarray(begin: i32 = 0, end: i32 = i32.MAX_VALUE): Float64Array {
    return SUBARRAY<Float64Array, f64>(this, begin, end);
  }

  copyWithin(target: i32, start: i32, end: i32 = i32.MAX_VALUE): Float64Array {
    return COPY_WITHIN<Float64Array, f64>(this, target, start, end);
  }

  reduce<T extends number>(
    fn: (accumulator: T, value: f64, index: i32, array: Float64Array) => T,
    initialValue: T,
  ): T {
    return REDUCE<Float64Array, f64, T>(this, fn, initialValue);
  }

  reduceRight<T extends number>(
    fn: (accumulator: T, value: f64, index: i32, array: Float64Array) => T,
    initialValue: T,
  ): T {
    return REDUCE_RIGHT<Float64Array, f64, T>(this, fn, initialValue);
  }

  map(fn: (value: f64, index: i32, self: Float64Array) => f64): Float64Array {
    return MAP<Float64Array, f64>(this, fn);
  }

  filter(fn: (value: f64, index: i32, self: Float64Array) => bool): Float64Array {
    return FILTER<Float64Array, f64>(this, fn);
  }

  findIndex(fn: (value: f64, index: i32, self: Float64Array) => bool): i32 {
    return FIND_INDEX<Float64Array, f64>(this, fn);
  }

  findLastIndex(fn: (value: f64, index: i32, self: Float64Array) => bool): i32 {
    return FIND_LAST_INDEX<Float64Array, f64>(this, fn);
  }

  some(fn: (value: f64, index: i32, self: Float64Array) => bool): bool {
    return SOME<Float64Array, f64>(this, fn);
  }

  every(fn: (value: f64, index: i32, self: Float64Array) => bool): bool {
    return EVERY<Float64Array, f64>(this, fn);
  }

  forEach(fn: (value: f64, index: i32, self: Float64Array) => void): void {
    FOREACH<Float64Array, f64>(this, fn);
  }

  reverse(): Float64Array {
    REVERSE<f64>(this.dataStart, this.length);
    return this;
  }

  join(separator: string = ","): string {
    return joinFloatArray<f64>(this.dataStart, this.length, separator);
  }

  set<U extends ArrayLike<number>>(source: U, offset: i32 = 0): void {
    SET(this, source, offset);
  }

  toString(): string {
    return this.join();
  }

  static wrap(buffer: ArrayBuffer, byteOffset: i32 = 0, length: i32 = -1): Float64Array {
    return WRAP<Float64Array, f64>(buffer, byteOffset, length);
  }
}

// @ts-ignore: decorator
@inline
function SLICE<TArray extends ArrayBufferView, T extends number>(
  array: TArray,
  start: i32,
  end: i32
): TArray {
  let len = array.length;
  start  = start < 0 ? max(start + len, 0) : min(start, len);
  end    = end   < 0 ? max(end   + len, 0) : min(end  , len);
  len = max(end - start, 0);
  let slice = instantiate<TArray>(len);
  memory.copy(
    slice.dataStart,
    array.dataStart + (<usize>start << alignof<T>()),
    <usize>len << alignof<T>()
  );
  return slice;
}

// @ts-ignore: decorator
@inline
function SUBARRAY<TArray extends ArrayBufferView, T extends number>(
  array: TArray,
  begin: i32,
  end: i32
): TArray {
  let len = array.length;
  begin = begin < 0 ? max(len + begin, 0) : min(begin, len);
  end   = end   < 0 ? max(len + end,   0) : min(end,   len);
  end   = max(end, begin);

  let out = changetype<TArray>(__new(offsetof<TArray>(), idof<TArray>()));
  let buf = changetype<usize>(array.buffer);
  store<usize>(changetype<usize>(out), buf, offsetof<TArray>("buffer"));
  __link(changetype<usize>(out), buf, false);
  store<usize>(changetype<usize>(out), array.dataStart + (<usize>begin << alignof<T>()), offsetof<TArray>("dataStart"));
  store<u32>(changetype<usize>(out), (end - begin) << alignof<T>(), offsetof<TArray>("byteLength"));
  return out;
}

// @ts-ignore: decorator
@inline
function COPY_WITHIN<TArray extends ArrayBufferView, T extends number>(
  array: TArray,
  target: i32,
  start: i32,
  end: i32
): TArray {
  let len = array.length;
  let ptr = array.dataStart;

  end   = min<i32>(end, len);
  let to    = target < 0 ? max(len + target, 0) : min(target, len);
  let from  = start < 0 ? max(len + start, 0) : min(start, len);
  let last  = end < 0 ? max(len + end, 0) : min(end, len);
  let count = min(last - from, len - to);

  memory.copy(
    ptr + (<usize>to << alignof<T>()),
    ptr + (<usize>from << alignof<T>()),
    <usize>count << alignof<T>()
  );
  return array;
}

// @ts-ignore: decorator
@inline
function REDUCE<TArray extends ArrayBufferView, T extends number, TRet extends number>(
  array: TArray,
  fn: (accumulator: TRet, value: T, index: i32, array: TArray) => TRet,
  initialValue: TRet
): TRet {
  let ptr = array.dataStart;
  for (let i = 0, k = array.length; i < k; i++) {
    initialValue = fn(initialValue, load<T>(ptr + (<usize>i << alignof<T>())), i, array);
  }
  return initialValue;
}

// @ts-ignore: decorator
@inline
function REDUCE_RIGHT<TArray extends ArrayBufferView, T extends number, TRet extends number>(
  array: TArray,
  fn: (accumulator: TRet, value: T, index: i32, array: TArray) => TRet,
  initialValue: TRet
): TRet {
  let ptr = array.dataStart;
  for (let i = array.length - 1; i >= 0; i--) {
    initialValue = fn(initialValue, load<T>(ptr + (<usize>i << alignof<T>())), i, array);
  }
  return initialValue;
}

// @ts-ignore: decorator
@inline
function MAP<TArray extends ArrayBufferView, T extends number>(
  array: TArray,
  fn: (value: T, index: i32, self: TArray) => T,
): TArray {
  let len = array.length;
  let ptr = array.dataStart;

  let byteLength = len << alignof<T>();
  let out = changetype<TArray>(__new(offsetof<TArray>(), idof<TArray>()));
  let buf = changetype<ArrayBuffer>(__new(byteLength, idof<ArrayBuffer>()));
  for (let i = 0; i < len; i++) {
    store<T>(
      changetype<usize>(buf) + (<usize>i << alignof<T>()),
      fn(load<T>(ptr + (<usize>i << alignof<T>())), i, array)
    );
  }
  store<usize>(changetype<usize>(out), changetype<usize>(buf), offsetof<TArray>("buffer"));
  __link(changetype<usize>(out), changetype<usize>(buf), false);
  store<usize>(changetype<usize>(out), changetype<usize>(buf), offsetof<TArray>("dataStart"));
  store<u32>(changetype<usize>(out), byteLength, offsetof<TArray>("byteLength"));
  return out;
}

// @ts-ignore: decorator
@inline
function FILTER<TArray extends ArrayBufferView, T extends number>(
  array: TArray,
  fn: (value: T, index: i32, self: TArray) => bool,
): TArray {
  let len = array.length;
  let out = changetype<TArray>(__new(offsetof<TArray>(), idof<TArray>()));
  let buf = changetype<ArrayBuffer>(__new(len << alignof<T>(), idof<ArrayBuffer>()));
  let dataStart  = array.dataStart;
  let j: usize = 0;
  for (let i = 0; i < len; i++) {
    let value = load<T>(dataStart + (<usize>i << alignof<T>()));
    if (fn(value, i, array)) {
      store<T>(
        changetype<usize>(buf) + (j++ << alignof<T>()),
        value
      );
    }
  }
  // shrink output buffer
  let byteLength = j << alignof<T>();
  let data = __renew(changetype<usize>(buf), byteLength);
  store<usize>(changetype<usize>(out), data, offsetof<TArray>("buffer"));
  __link(changetype<usize>(out), data, false);
  store<u32>(changetype<usize>(out), byteLength, offsetof<TArray>("byteLength"));
  store<usize>(changetype<usize>(out), data, offsetof<TArray>("dataStart"));
  return out;
}

// @ts-ignore: decorator
@inline
function FIND_INDEX<TArray extends ArrayBufferView, T extends number>(
  array: TArray,
  fn: (value: T, index: i32, array: TArray) => bool,
): i32 {
  let ptr = array.dataStart;
  for (let i = 0, k = array.length; i < k; i++) {
    if (fn(load<T>(ptr + (<usize>i << alignof<T>())), i, array)) return i;
  }
  return -1;
}

// @ts-ignore: decorator
@inline
function FIND_LAST_INDEX<TArray extends ArrayBufferView, T extends number>(
  array: TArray,
  fn: (value: T, index: i32, array: TArray) => bool,
): i32 {
  let ptr = array.dataStart;
  for (let i = array.length - 1; i >= 0; --i) {
    if (fn(load<T>(ptr + (<usize>i << alignof<T>())), i, array)) return i;
  }
  return -1;
}

// @ts-ignore: decorator
@inline
function INCLUDES<TArray extends ArrayBufferView, T extends number>(
  array: TArray,
  searchElement: T,
  fromIndex: i32,
): bool {
  if (isFloat<T>()) {
    let index: isize = fromIndex;
    let len: isize = array.length;
    if (len == 0 || index >= len) return false;
    if (index < 0) index = max(len + index, 0);
    let dataStart = array.dataStart;
    while (index < len) {
      let elem = load<T>(dataStart + (index << alignof<T>()));
      // @ts-ignore
      if (elem == searchElement || isNaN(elem) & isNaN(searchElement)) return true;
      ++index;
    }
    return false;
  } else {
    return INDEX_OF<TArray, T>(array, searchElement, fromIndex) >= 0;
  }
}

// @ts-ignore: decorator
@inline
function INDEX_OF<TArray extends ArrayBufferView, T extends number>(
  array: TArray,
  searchElement: T,
  fromIndex: i32,
): i32 {
  let index: isize = fromIndex;
  let len: isize = array.length;
  if (len == 0 || index >= len) return -1;
  if (index < 0) index = max(len + index, 0);
  let dataStart = array.dataStart;
  while (index < len) {
    if (load<T>(dataStart + (index << alignof<T>())) == searchElement) return <i32>index;
    ++index;
  }
  return -1;
}

// @ts-ignore: decorator
@inline
function LAST_INDEX_OF<TArray extends ArrayBufferView, T extends number>(
  array: TArray,
  searchElement: T,
  fromIndex: i32,
): i32 {
  let index: isize = fromIndex;
  let len: isize = array.length;
  if (len == 0) return -1;
  if (index < 0) index = len + index; // no need to clamp
  else if (index >= len) index = len - 1;
  let dataStart = array.dataStart;
  while (index >= 0) {
    if (load<T>(dataStart + (index << alignof<T>())) == searchElement) return <i32>index;
    --index;
  }
  return -1;
}

// @ts-ignore: decorator
@inline
function SOME<TArray extends ArrayBufferView, T extends number>(
  array: TArray,
  fn: (value: T, index: i32, array: TArray) => bool,
): bool {
  let ptr = array.dataStart;
  for (let i = 0, k = array.length; i < k; i++) {
    if (fn(load<T>(ptr + (<usize>i << alignof<T>())), i, array)) return true;
  }
  return false;
}

// @ts-ignore: decorator
@inline
function EVERY<TArray extends ArrayBufferView, T extends number>(
  array: TArray,
  fn: (value: T, index: i32, array: TArray) => bool,
): bool {
  let ptr = array.dataStart;
  for (let i = 0, k = array.length; i < k; i++) {
    if (fn(load<T>(ptr + (<usize>i << alignof<T>())), i, array)) continue;
    return false;
  }
  return true;
}

// @ts-ignore: decorator
@inline
function FOREACH<TArray extends ArrayBufferView, T extends number>(
  array: TArray,
  fn: (value: T, index: i32, array: TArray) => void,
): void {
  let ptr = array.dataStart;
  for (let i = 0, k = array.length; i < k; i++) {
    fn(load<T>(ptr + (<usize>i << alignof<T>())), i, array);
  }
}

// @ts-ignore: decorator
@inline
function WRAP<TArray extends ArrayBufferView, T>(
  buffer: ArrayBuffer,
  byteOffset: i32 = 0,
  len: i32 = -1
): TArray {
  let byteLength: i32;
  let bufferByteLength = buffer.byteLength;
  const mask: u32 = sizeof<T>() - 1;
  if (i32(<u32>byteOffset > <u32>bufferByteLength) | (byteOffset & mask)) {
    throw new RangeError(E_INDEXOUTOFRANGE);
  }
  if (len < 0) {
    if (len == -1) {
      if (bufferByteLength & mask) {
        throw new RangeError(E_INVALIDLENGTH);
      }
      byteLength = bufferByteLength - byteOffset;
    } else {
      throw new RangeError(E_INVALIDLENGTH);
    }
  } else {
    byteLength = len << alignof<T>();
    if (byteOffset + byteLength > bufferByteLength) {
      throw new RangeError(E_INVALIDLENGTH);
    }
  }
  let out = changetype<TArray>(__new(offsetof<TArray>(), idof<TArray>()));
  store<usize>(changetype<usize>(out), changetype<usize>(buffer), offsetof<TArray>("buffer"));
  __link(changetype<usize>(out), changetype<usize>(buffer), false);
  store<u32>(changetype<usize>(out), byteLength, offsetof<TArray>("byteLength"));
  store<usize>(changetype<usize>(out), changetype<usize>(buffer) + <usize>byteOffset, offsetof<TArray>("dataStart"));
  return out;
}

// @ts-ignore: decorator
@inline
function SET<
  TArray extends ArrayLike<number>,
  UArray extends ArrayLike<number>
>(
  target: TArray,
  source: UArray,
  offset: i32 = 0
): void {
  // need to assert at compile time that U is not a reference or a function
  if (isReference<valueof<UArray>>()) {
    ERROR(E_NOTIMPLEMENTED);
  }
  let sourceLen = source.length;
  if (offset < 0 || sourceLen + offset > target.length) {
    // offset is out of bounds
    throw new RangeError(E_INDEXOUTOFRANGE);
  }
  // @ts-ignore: dataStart
  let targetStart = target.dataStart + (<usize>offset << (alignof<valueof<TArray>>()));
  // @ts-ignore: dataStart
  let sourceStart = source.dataStart;
  // if the types align and match, use memory.copy() instead of manual loop
  if (
    isInteger<valueof<TArray>>() == isInteger<valueof<UArray>>() &&
    alignof<valueof<TArray>>() == alignof<valueof<UArray>>() &&
    !(isSigned<valueof<UArray>>() && target instanceof Uint8ClampedArray)
  ) {
    memory.copy(targetStart, sourceStart, <usize>sourceLen << (alignof<valueof<UArray>>()));
  } else {
    for (let i = 0; i < sourceLen; i++) {
      let ptr = targetStart + (<usize>i << (alignof<valueof<TArray>>()));
      let value = load<valueof<UArray>>(sourceStart + (<usize>i << (alignof<valueof<UArray>>())));
      // if TArray is Uint8ClampedArray, then values must be clamped
      if (target instanceof Uint8ClampedArray) {
        if (isFloat<valueof<UArray>>()) {
          store<valueof<TArray>>(ptr,
            isFinite<valueof<UArray>>(value)
              ? <valueof<TArray>>max<valueof<UArray>>(0, min<valueof<UArray>>(255, value))
              : 0
          );
        } else {
          if (!isSigned<valueof<UArray>>()) {
            store<valueof<TArray>>(ptr, min<valueof<UArray>>(255, value));
          } else if (sizeof<valueof<TArray>>() <= 4) {
            store<valueof<TArray>>(ptr, ~(<i32>value >> 31) & (((255 - <i32>value) >> 31) | value));
          } else {
            store<valueof<TArray>>(ptr, ~(<i64>value >> 63) & (((255 - <i64>value) >> 63) | value));
          }
        }
      } else {
        if (isFloat<valueof<UArray>>() && !isFloat<valueof<TArray>>()) {
          store<valueof<TArray>>(ptr, isFinite<valueof<UArray>>(value) ? <valueof<TArray>>value : 0);
        } else {
          store<valueof<TArray>>(ptr, <valueof<TArray>>value);
        }
      }
    }
  }
}
`,uri:`import { encode, decode, URI_UNSAFE, URL_UNSAFE } from "./util/uri";

export function encodeURI(str: string): string {
  return changetype<string>(encode(changetype<usize>(str), str.length, URI_UNSAFE));
}

export function decodeURI(str: string): string {
  return changetype<string>(decode(changetype<usize>(str), str.length, false));
}

export function encodeURIComponent(str: string): string {
  return changetype<string>(encode(changetype<usize>(str), str.length, URL_UNSAFE));
}

export function decodeURIComponent(str: string): string {
  return changetype<string>(decode(changetype<usize>(str), str.length, true));
}
`,"util/bytes":`export function REVERSE<T>(ptr: usize, len: usize): void {
  if (len > 1) {
    let
      i: usize = 0,
      tail: usize,
      hlen: usize = len >> 1;

    if (ASC_SHRINK_LEVEL < 1) {
      if (sizeof<T>() == 1) {
        // TODO: Decide later: Does we need this fast path cases?
        //
        // if (len == 4) {
        //   store<u32>(ptr, bswap(load<u32>(ptr)));
        //   return;
        // }
        // if (len == 8) {
        //   store<u64>(ptr, bswap(load<u64>(ptr)));
        //   return;
        // }
        tail = len - 8;
        while (i + 7 < hlen) {
          let front = ptr + i;
          let back  = ptr + tail - i;
          let temp  = bswap(load<u64>(front));
          store<u64>(front, bswap(load<u64>(back)));
          store<u64>(back, temp);
          i += 8;
        }
      }

      if (sizeof<T>() == 2) {
        tail = len - 2;
        while (i + 1 < hlen) {
          let front = ptr + (i << 1);
          let back  = ptr + (tail - i << 1);
          let temp  = rotr(load<u32>(back), 16);
          store<u32>(back, rotr(load<u32>(front), 16));
          store<u32>(front, temp);
          i += 2;
        }
      }
    }

    tail = len - 1;
    while (i < hlen) {
      let front = ptr + (i << alignof<T>());
      let back  = ptr + (tail - i << alignof<T>());
      let temp  = load<T>(front);
      store<T>(front, load<T>(back));
      store<T>(back, temp);
      i++;
    }
  }
}

export function FILL<T>(
  ptr: usize,
  len: usize,
  value: T,
  start: isize,
  end: isize
): void {
  start = start < 0 ? max(len + start, 0) : min(start, len);
  end   = end   < 0 ? max(len + end,   0) : min(end,   len);

  if (sizeof<T>() == 1) {
    if (start < end) {
      memory.fill(
        ptr + <usize>start,
        u8(value),
        <usize>(end - start)
      );
    }
  } else {
    if (ASC_SHRINK_LEVEL <= 1) {
      if (isInteger<T>()) {
        // @ts-ignore
        if (value == <T>0 | value == <T>-1) {
          if (start < end) {
            memory.fill(
              ptr + (<usize>start << alignof<T>()),
              u8(value),
              <usize>(end - start) << alignof<T>()
            );
          }
          return;
        }
      } else if (isFloat<T>()) {
        // for floating non-negative zeros we can use fast memory.fill
        if ((sizeof<T>() == 4 && reinterpret<u32>(f32(value)) == 0) ||
            (sizeof<T>() == 8 && reinterpret<u64>(f64(value)) == 0)) {
          if (start < end) {
            memory.fill(
              ptr + (<usize>start << alignof<T>()),
              0,
              <usize>(end - start) << alignof<T>()
            );
          }
          return;
        }
      }
    }
    for (; start < end; ++start) {
      store<T>(ptr + (<usize>start << alignof<T>()), value);
    }
  }
}
`,"util/casemap":`// Total tables size: ~5 kb (usually compressed to ~4 kb)
// See: https://git.musl-libc.org/cgit/musl/tree/src/ctype/casemap.h

// @ts-ignore: decorator
@lazy @inline const TAB = memory.data<u8>([
  7, 8, 9, 10, 11, 12, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  13, 6, 6, 14, 6, 6, 6, 6, 6, 6, 6, 6, 15, 16, 17, 18,
  6, 19, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 20, 21, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 22, 23, 6, 6, 6, 24, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 25,
  6, 6, 6, 6, 26, 6, 6, 6, 6, 6, 6, 6, 27, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 28, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 29, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 30, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 36,
  43, 43, 43, 43, 43, 43, 43, 43, 1, 0, 84, 86, 86, 86, 86, 86,
  86, 86, 86, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 24, 0, 0, 0, 43, 43, 43, 43, 43, 43,
  43, 7, 43, 43, 91, 86, 86, 86, 86, 86, 86, 86, 74, 86, 86, 5,
  49, 80, 49, 80, 49, 80, 49, 80, 49, 80, 49, 80, 49, 80, 49, 80,
  36, 80, 121, 49, 80, 49, 80, 49, 56, 80, 49, 80, 49, 80, 49, 80,
  49, 80, 49, 80, 49, 80, 49, 80, 78, 49, 2, 78, 13, 13, 78, 3,
  78, 0, 36, 110, 0, 78, 49, 38, 110, 81, 78, 36, 80, 78, 57, 20,
  129, 27, 29, 29, 83, 49, 80, 49, 80, 13, 49, 80, 49, 80, 49, 80,
  27, 83, 36, 80, 49, 2, 92, 123, 92, 123, 92, 123, 92, 123, 92, 123,
  20, 121, 92, 123, 92, 123, 92, 45, 43, 73, 3, 72, 3, 120, 92, 123,
  20, 0, 150, 10, 1, 43, 40, 6, 6, 0, 42, 6, 42, 42, 43, 7,
  187, 181, 43, 30, 0, 43, 7, 43, 43, 43, 1, 43, 43, 43, 43, 43,
  43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43,
  43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 1, 43, 43, 43, 43,
  43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43,
  43, 43, 43, 42, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43,
  43, 205, 70, 205, 43, 0, 37, 43, 7, 1, 6, 1, 85, 86, 86, 86,
  86, 86, 85, 86, 86, 2, 36, 129, 129, 129, 129, 129, 21, 129, 129, 129,
  0, 0, 43, 0, 178, 209, 178, 209, 178, 209, 178, 209, 0, 0, 205, 204,
  1, 0, 215, 215, 215, 215, 215, 131, 129, 129, 129, 129, 129, 129, 129, 129,
  129, 129, 172, 172, 172, 172, 172, 172, 172, 172, 172, 172, 28, 0, 0, 0,
  0, 0, 49, 80, 49, 80, 49, 80, 49, 80, 49, 80, 49, 2, 0, 0,
  49, 80, 49, 80, 49, 80, 49, 80, 49, 80, 49, 80, 49, 80, 49, 80,
  49, 80, 78, 49, 80, 49, 80, 78, 49, 80, 49, 80, 49, 80, 49, 80,
  49, 80, 49, 80, 49, 80, 49, 2, 135, 166, 135, 166, 135, 166, 135, 166,
  135, 166, 135, 166, 135, 166, 135, 166, 42, 43, 43, 43, 43, 43, 43, 43,
  43, 43, 43, 43, 43, 0, 0, 0, 84, 86, 86, 86, 86, 86, 86, 86,
  86, 86, 86, 86, 86, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 84, 86, 86, 86, 86, 86, 86, 86, 86, 86, 86, 86, 86,
  12, 0, 12, 42, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43,
  43, 7, 42, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 42, 43, 43, 43, 43, 43, 43,
  43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43,
  43, 43, 43, 43, 86, 86, 108, 129, 21, 0, 43, 43, 43, 43, 43, 43,
  43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43,
  43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43,
  43, 43, 43, 43, 7, 108, 3, 65, 43, 43, 86, 86, 86, 86, 86, 86,
  86, 86, 86, 86, 86, 86, 86, 86, 44, 86, 43, 43, 43, 43, 43, 43,
  43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 1,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 12, 108, 0, 0, 0, 0, 0, 6,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 6, 37, 6, 37, 6, 37, 6, 37, 6, 37,
  6, 37, 6, 37, 6, 37, 6, 37, 6, 37, 6, 37, 6, 37, 6, 37,
  6, 37, 6, 37, 6, 37, 6, 37, 6, 37, 6, 37, 6, 37, 6, 37,
  6, 37, 6, 37, 6, 37, 6, 37, 86, 122, 158, 38, 6, 37, 6, 37,
  6, 37, 6, 37, 6, 37, 6, 37, 6, 37, 6, 37, 6, 37, 6, 37,
  6, 37, 6, 37, 6, 37, 6, 37, 6, 37, 6, 1, 43, 43, 79, 86,
  86, 44, 43, 127, 86, 86, 57, 43, 43, 85, 86, 86, 43, 43, 79, 86,
  86, 44, 43, 127, 86, 86, 129, 55, 117, 91, 123, 92, 43, 43, 79, 86,
  86, 2, 172, 4, 0, 0, 57, 43, 43, 85, 86, 86, 43, 43, 79, 86,
  86, 44, 43, 43, 86, 86, 50, 19, 129, 87, 0, 111, 129, 126, 201, 215,
  126, 45, 129, 129, 14, 126, 57, 127, 111, 87, 0, 129, 129, 126, 21, 0,
  126, 3, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 7, 43,
  36, 43, 151, 43, 43, 43, 43, 43, 43, 43, 43, 43, 42, 43, 43, 43,
  43, 43, 86, 86, 86, 86, 86, 128, 129, 129, 129, 129, 57, 187, 42, 43,
  43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43,
  43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43,
  43, 43, 43, 43, 43, 43, 43, 1, 129, 129, 129, 129, 129, 129, 129, 129,
  129, 129, 129, 129, 129, 129, 129, 201, 172, 172, 172, 172, 172, 172, 172, 172,
  172, 172, 172, 172, 172, 172, 172, 208, 13, 0, 78, 49, 2, 180, 193, 193,
  215, 215, 36, 80, 49, 80, 49, 80, 49, 80, 49, 80, 49, 80, 49, 80,
  49, 80, 49, 80, 49, 80, 49, 80, 49, 80, 49, 80, 49, 80, 49, 80,
  49, 80, 49, 80, 215, 215, 83, 193, 71, 212, 215, 215, 215, 5, 43, 43,
  43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 7, 1, 0, 1, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 78, 49, 80, 49, 80, 49, 80,
  49, 80, 49, 80, 49, 80, 49, 80, 13, 0, 0, 0, 0, 0, 36, 80,
  49, 80, 49, 80, 49, 80, 49, 80, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 43, 43, 43, 43, 43, 43,
  43, 43, 43, 43, 43, 121, 92, 123, 92, 123, 79, 123, 92, 123, 92, 123,
  92, 123, 92, 123, 92, 123, 92, 123, 92, 123, 92, 123, 92, 123, 92, 45,
  43, 43, 121, 20, 92, 123, 92, 45, 121, 42, 92, 39, 92, 123, 92, 123,
  92, 123, 164, 0, 10, 180, 92, 123, 92, 123, 79, 3, 120, 56, 43, 43,
  43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 79, 45, 43, 43, 1,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 72, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 42, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43,
  43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 43, 43, 43, 43, 43, 43, 43, 43, 7, 0, 72, 86, 86, 86, 86,
  86, 86, 86, 86, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 43, 43, 43, 43,
  43, 43, 43, 43, 43, 43, 43, 43, 43, 85, 86, 86, 86, 86, 86, 86,
  86, 86, 86, 86, 86, 86, 14, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 36, 43, 43, 43, 43, 43, 43, 43, 43, 43,
  43, 43, 7, 0, 86, 86, 86, 86, 86, 86, 86, 86, 86, 86, 86, 86,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 36, 43, 43, 43,
  43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 7, 0, 0,
  0, 0, 86, 86, 86, 86, 86, 86, 86, 86, 86, 86, 86, 86, 86, 86,
  86, 86, 86, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 42, 43, 43,
  43, 43, 43, 43, 43, 43, 43, 43, 86, 86, 86, 86, 86, 86, 86, 86,
  86, 86, 14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 42, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 86, 86,
  86, 86, 86, 86, 86, 86, 86, 86, 14, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 43, 85,
  86, 86, 86, 86, 86, 86, 86, 86, 86, 86, 14, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0
]);

// @ts-ignore: decorator
@lazy @inline const RULES = memory.data<i32>([
  0x0, 0x2001, -0x2000, 0x1dbf00, 0x2e700, 0x7900,
  0x2402, 0x101, -0x100, 0x0, 0x201, -0x200,
  -0xc6ff, -0xe800, -0x78ff, -0x12c00, 0xc300, 0xd201,
  0xce01, 0xcd01, 0x4f01, 0xca01, 0xcb01, 0xcf01,
  0x6100, 0xd301, 0xd101, 0xa300, 0xd501, 0x8200,
  0xd601, 0xda01, 0xd901, 0xdb01, 0x3800, 0x3,
  -0x4f00, -0x60ff, -0x37ff, 0x242802, 0x0, 0x101,
  -0x100, -0xcd00, -0xda00, -0x81ff, 0x2a2b01, -0xa2ff,
  0x2a2801, 0x2a3f00, -0xc2ff, 0x4501, 0x4701, 0x2a1f00,
  0x2a1c00, 0x2a1e00, -0xd200, -0xce00, -0xca00, -0xcb00,
  0xa54f00, 0xa54b00, -0xcf00, 0xa52800, 0xa54400, -0xd100,
  -0xd300, 0x29f700, 0xa54100, 0x29fd00, -0xd500, -0xd600,
  0x29e700, 0xa54300, 0xa52a00, -0x4500, -0xd900, -0x4700,
  -0xdb00, 0xa51500, 0xa51200, 0x4c2402, 0x0, 0x2001,
  -0x2000, 0x101, -0x100, 0x5400, 0x7401, 0x2601,
  0x2501, 0x4001, 0x3f01, -0x2600, -0x2500, -0x1f00,
  -0x4000, -0x3f00, 0x801, -0x3e00, -0x3900, -0x2f00,
  -0x3600, -0x800, -0x5600, -0x5000, 0x700, -0x7400,
  -0x3bff, -0x6000, -0x6ff, 0x701a02, 0x101, -0x100,
  0x2001, -0x2000, 0x5001, 0xf01, -0xf00, 0x0,
  0x3001, -0x3000, 0x101, -0x100, 0x0, 0xbc000,
  0x1c6001, 0x0, 0x97d001, 0x801, -0x800, 0x8a0502,
  0x0, -0xbbfff, -0x186200, 0x89c200, -0x182500, -0x186e00,
  -0x186d00, -0x186400, -0x186300, -0x185c00, 0x0, 0x8a3800,
  0x8a0400, 0xee600, 0x101, -0x100, 0x0, -0x3b00,
  -0x1dbeff, 0x8f1d02, 0x800, -0x7ff, 0x0, 0x5600,
  -0x55ff, 0x4a00, 0x6400, 0x8000, 0x7000, 0x7e00,
  0x900, -0x49ff, -0x8ff, -0x1c2500, -0x63ff, -0x6fff,
  -0x7fff, -0x7dff, 0xac0502, 0x0, 0x1001, -0x1000,
  0x1c01, 0x101, -0x1d5cff, -0x20beff, -0x2045ff, -0x1c00,
  0xb10b02, 0x101, -0x100, 0x3001, -0x3000, 0x0,
  -0x29f6ff, -0xee5ff, -0x29e6ff, -0x2a2b00, -0x2a2800, -0x2a1bff,
  -0x29fcff, -0x2a1eff, -0x2a1dff, -0x2a3eff, 0x0, -0x1c6000,
  0x0, 0x101, -0x100, 0xbc0c02, 0x0, 0x101,
  -0x100, -0xa543ff, 0x3a001, -0x8a03ff, -0xa527ff, 0x3000,
  -0xa54eff, -0xa54aff, -0xa540ff, -0xa511ff, -0xa529ff, -0xa514ff,
  -0x2fff, -0xa542ff, -0x8a37ff, 0x0, -0x97d000, -0x3a000,
  0x0, 0x2001, -0x2000, 0x0, 0x2801, -0x2800,
  0x0, 0x4001, -0x4000, 0x0, 0x2001, -0x2000,
  0x0, 0x2001, -0x2000, 0x0, 0x2201, -0x2200
]);

// @ts-ignore: decorator
@lazy @inline const RULE_BASES = memory.data<u8>([
  0, 6, 39, 81, 111, 119, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  124, 0, 0, 127, 0, 0, 0, 0, 0, 0, 0, 0, 131, 142, 146, 151,
  0, 170, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 180, 196, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 198, 201, 0, 0, 0, 219, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 222,
  0, 0, 0, 0, 225, 0, 0, 0, 0, 0, 0, 0, 228, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 231, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 234, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 237, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
]);

// @ts-ignore: decorator
@lazy @inline const EXCEPTIONS = memory.data<u8>([
  48, 12,  49, 13,  120, 14,  127, 15,
  128, 16,  129, 17,  134, 18,  137, 19,
  138, 19,  142, 20,  143, 21,  144, 22,
  147, 19,  148, 23,  149, 24,  150, 25,
  151, 26,  154, 27,  156, 25,  157, 28,
  158, 29,  159, 30,  166, 31,  169, 31,
  174, 31,  177, 32,  178, 32,  183, 33,
  191, 34,  197, 35,  200, 35,  203, 35,
  221, 36,  242, 35,  246, 37,  247, 38,
  32, 45,  58, 46,  61, 47,  62, 48,
  63, 49,  64, 49,  67, 50,  68, 51,
  69, 52,  80, 53,  81, 54,  82, 55,
  83, 56,  84, 57,  89, 58,  91, 59,
  92, 60,  97, 61,  99, 62,  101, 63,
  102, 64,  104, 65,  105, 66,  106, 64,
  107, 67,  108, 68,  111, 66,  113, 69,
  114, 70,  117, 71,  125, 72,  130, 73,
  135, 74,  137, 75,  138, 76,  139, 76,
  140, 77,  146, 78,  157, 79,  158, 80,
  69, 87,  123, 29,  124, 29,  125, 29,
  127, 88,  134, 89,  136, 90,  137, 90,
  138, 90,  140, 91,  142, 92,  143, 92,
  172, 93,  173, 94,  174, 94,  175, 94,
  194, 95,  204, 96,  205, 97,  206, 97,
  207, 98,  208, 99,  209, 100,  213, 101,
  214, 102,  215, 103,  240, 104,  241, 105,
  242, 106,  243, 107,  244, 108,  245, 109,
  249, 110,  253, 45,  254, 45,  255, 45,
  80, 105,  81, 105,  82, 105,  83, 105,
  84, 105,  85, 105,  86, 105,  87, 105,
  88, 105,  89, 105,  90, 105,  91, 105,
  92, 105,  93, 105,  94, 105,  95, 105,
  130, 0,  131, 0,  132, 0,  133, 0,
  134, 0,  135, 0,  136, 0,  137, 0,
  192, 117,  207, 118,  128, 137,  129, 138,
  130, 139,  133, 140,  134, 141,  112, 157,
  113, 157,  118, 158,  119, 158,  120, 159,
  121, 159,  122, 160,  123, 160,  124, 161,
  125, 161,  179, 162,  186, 163,  187, 163,
  188, 164,  190, 165,  195, 162,  204, 164,
  218, 166,  219, 166,  229, 106,  234, 167,
  235, 167,  236, 110,  243, 162,  248, 168,
  249, 168,  250, 169,  251, 169,  252, 164,
  38, 176,  42, 177,  43, 178,  78,  179,
  132,  8,  98, 186,  99, 187,  100, 188,
  101, 189,  102, 190,  109, 191,  110, 192,
  111, 193,  112, 194,  126, 195,  127, 195,
  125, 207,  141, 208,  148, 209,  171, 210,
  172, 211,  173, 212,  176, 213,  177, 214,
  178, 215,  196, 216,  197, 217,  198, 218
]);

/* Special Case Mappings
 * See: https://unicode.org/Public/UNIDATA/SpecialCasing.txt
 */

/*
@lazy @inline
const SPECIALS_LOWER: StaticArray<u16> = [
  0x0130,  0x0069, 0x0307, 0x0000,
];
*/

// @ts-ignore: decorator
@lazy @inlne
export const SPECIALS_UPPER: StaticArray<u16> = [
  // String#toUpperCase needs .length
  0x00DF,  0x0053, 0x0053, 0x0000,
  0x0149,  0x02BC, 0x004E, 0x0000,
  0x01F0,  0x004A, 0x030C, 0x0000,
  0x0390,  0x0399, 0x0308, 0x0301,
  0x03B0,  0x03A5, 0x0308, 0x0301,
  0x0587,  0x0535, 0x0552, 0x0000,
  0x1E96,  0x0048, 0x0331, 0x0000,
  0x1E97,  0x0054, 0x0308, 0x0000,
  0x1E98,  0x0057, 0x030A, 0x0000,
  0x1E99,  0x0059, 0x030A, 0x0000,
  0x1E9A,  0x0041, 0x02BE, 0x0000,
  0x1F50,  0x03A5, 0x0313, 0x0000,
  0x1F52,  0x03A5, 0x0313, 0x0300,
  0x1F54,  0x03A5, 0x0313, 0x0301,
  0x1F56,  0x03A5, 0x0313, 0x0342,
  0x1F80,  0x1F08, 0x0399, 0x0000,
  0x1F81,  0x1F09, 0x0399, 0x0000,
  0x1F82,  0x1F0A, 0x0399, 0x0000,
  0x1F83,  0x1F0B, 0x0399, 0x0000,
  0x1F84,  0x1F0C, 0x0399, 0x0000,
  0x1F85,  0x1F0D, 0x0399, 0x0000,
  0x1F86,  0x1F0E, 0x0399, 0x0000,
  0x1F87,  0x1F0F, 0x0399, 0x0000,
  0x1F88,  0x1F08, 0x0399, 0x0000,
  0x1F89,  0x1F09, 0x0399, 0x0000,
  0x1F8A,  0x1F0A, 0x0399, 0x0000,
  0x1F8B,  0x1F0B, 0x0399, 0x0000,
  0x1F8C,  0x1F0C, 0x0399, 0x0000,
  0x1F8D,  0x1F0D, 0x0399, 0x0000,
  0x1F8E,  0x1F0E, 0x0399, 0x0000,
  0x1F8F,  0x1F0F, 0x0399, 0x0000,
  0x1F90,  0x1F28, 0x0399, 0x0000,
  0x1F91,  0x1F29, 0x0399, 0x0000,
  0x1F92,  0x1F2A, 0x0399, 0x0000,
  0x1F93,  0x1F2B, 0x0399, 0x0000,
  0x1F94,  0x1F2C, 0x0399, 0x0000,
  0x1F95,  0x1F2D, 0x0399, 0x0000,
  0x1F96,  0x1F2E, 0x0399, 0x0000,
  0x1F97,  0x1F2F, 0x0399, 0x0000,
  0x1F98,  0x1F28, 0x0399, 0x0000,
  0x1F99,  0x1F29, 0x0399, 0x0000,
  0x1F9A,  0x1F2A, 0x0399, 0x0000,
  0x1F9B,  0x1F2B, 0x0399, 0x0000,
  0x1F9C,  0x1F2C, 0x0399, 0x0000,
  0x1F9D,  0x1F2D, 0x0399, 0x0000,
  0x1F9E,  0x1F2E, 0x0399, 0x0000,
  0x1F9F,  0x1F2F, 0x0399, 0x0000,
  0x1FA0,  0x1F68, 0x0399, 0x0000,
  0x1FA1,  0x1F69, 0x0399, 0x0000,
  0x1FA2,  0x1F6A, 0x0399, 0x0000,
  0x1FA3,  0x1F6B, 0x0399, 0x0000,
  0x1FA4,  0x1F6C, 0x0399, 0x0000,
  0x1FA5,  0x1F6D, 0x0399, 0x0000,
  0x1FA6,  0x1F6E, 0x0399, 0x0000,
  0x1FA7,  0x1F6F, 0x0399, 0x0000,
  0x1FA8,  0x1F68, 0x0399, 0x0000,
  0x1FA9,  0x1F69, 0x0399, 0x0000,
  0x1FAA,  0x1F6A, 0x0399, 0x0000,
  0x1FAB,  0x1F6B, 0x0399, 0x0000,
  0x1FAC,  0x1F6C, 0x0399, 0x0000,
  0x1FAD,  0x1F6D, 0x0399, 0x0000,
  0x1FAE,  0x1F6E, 0x0399, 0x0000,
  0x1FAF,  0x1F6F, 0x0399, 0x0000,
  0x1FB2,  0x1FBA, 0x0399, 0x0000,
  0x1FB3,  0x0391, 0x0399, 0x0000,
  0x1FB4,  0x0386, 0x0399, 0x0000,
  0x1FB6,  0x0391, 0x0342, 0x0000,
  0x1FB7,  0x0391, 0x0342, 0x0399,
  0x1FBC,  0x0391, 0x0399, 0x0000,
  0x1FC2,  0x1FCA, 0x0399, 0x0000,
  0x1FC3,  0x0397, 0x0399, 0x0000,
  0x1FC4,  0x0389, 0x0399, 0x0000,
  0x1FC6,  0x0397, 0x0342, 0x0000,
  0x1FC7,  0x0397, 0x0342, 0x0399,
  0x1FCC,  0x0397, 0x0399, 0x0000,
  0x1FD2,  0x0399, 0x0308, 0x0300,
  0x1FD3,  0x0399, 0x0308, 0x0301,
  0x1FD6,  0x0399, 0x0342, 0x0000,
  0x1FD7,  0x0399, 0x0308, 0x0342,
  0x1FE2,  0x03A5, 0x0308, 0x0300,
  0x1FE3,  0x03A5, 0x0308, 0x0301,
  0x1FE4,  0x03A1, 0x0313, 0x0000,
  0x1FE6,  0x03A5, 0x0342, 0x0000,
  0x1FE7,  0x03A5, 0x0308, 0x0342,
  0x1FF2,  0x1FFA, 0x0399, 0x0000,
  0x1FF3,  0x03A9, 0x0399, 0x0000,
  0x1FF4,  0x038F, 0x0399, 0x0000,
  0x1FF6,  0x03A9, 0x0342, 0x0000,
  0x1FF7,  0x03A9, 0x0342, 0x0399,
  0x1FFC,  0x03A9, 0x0399, 0x0000,
  0xFB00,  0x0046, 0x0046, 0x0000,
  0xFB01,  0x0046, 0x0049, 0x0000,
  0xFB02,  0x0046, 0x004C, 0x0000,
  0xFB03,  0x0046, 0x0046, 0x0049,
  0xFB04,  0x0046, 0x0046, 0x004C,
  0xFB05,  0x0053, 0x0054, 0x0000,
  0xFB06,  0x0053, 0x0054, 0x0000,
  0xFB13,  0x0544, 0x0546, 0x0000,
  0xFB14,  0x0544, 0x0535, 0x0000,
  0xFB15,  0x0544, 0x053B, 0x0000,
  0xFB16,  0x054E, 0x0546, 0x0000,
  0xFB17,  0x0544, 0x053D, 0x0000
];

// @ts-ignore: decorator
@lazy @inline const MT = memory.data<i32>([
  2048, 342, 57
]);

// Special binary search routine for Special Casing Tables
// @ts-ignore: decorator
@inline
export function bsearch(key: u32, ptr: usize, max: i32): i32 {
  let min = 0;
  while (min <= max) {
    let mid = (min + max) >>> 3 << 2;
    let cmp = load<u16>(ptr + (mid << alignof<u16>())) - key;
    if (cmp == 0) return mid; // found
    else if (cmp >>> 31) min = mid + 4; // < 0
    else max = mid - 4; // > 0
  }
  return -1; // not found
}

// See: https://git.musl-libc.org/cgit/musl/tree/src/ctype/towctrans.c
export function casemap(c: u32, dir: i32): i32 {
  // if (c >= 0x20000) return c;
  let c0 = c as i32;
  let b = c >> 8;
  c &= 255;

  let x = c / 3;
  let y = c % 3;

  /* lookup entry in two-level base-6 table */
  // v = tab[(tab[b] as i32) * 86 + x] as u32;
  let v = <usize>load<u8>(TAB + <usize>load<u8>(TAB + b) * 86 + x);
  // v = (v * mt[y] >> 11) % 6;
  v = (v * load<i32>(MT + (y << alignof<i32>())) >> 11) % 6;
  /* use the bit vector out of the tables as an index into
   * a block-specific set of rules and decode the rule into
   * a type and a case-mapping delta. */
  // r = rules[(ruleBases[b] as u32) + v];
  let r = load<i32>(RULES + ((<usize>load<u8>(RULE_BASES + b) + v) << alignof<i32>()));
  let rt: u32 = r & 255;
  let rd: i32 = r >> 8;
  /* rules 0/1 are simple lower/upper case with a delta.
   * apply according to desired mapping direction. */
  if (rt < 2) return c0 + (rd & -(rt ^ dir));
  /* binary search. endpoints of the binary search for
   * this block are stored in the rule delta field. */
  let xn: u32 = rd & 0xff;
  let xb: u32 = rd >>> 8;
  while (xn) {
    let h = xn >> 1;
    // let t = exceptions[(xb + h) * 2 + 0] as u32;
    let t = <u32>load<u8>(EXCEPTIONS + (xb + h) * 2, 0);
    if (t == c) {
      // r = rules[exceptions[(xb + h) * 2 + 1]];
      r = load<i32>(RULES + <usize>(load<u8>(EXCEPTIONS + (xb + h) * 2, 1) << alignof<i32>()));
      rt = r & 255;
      rd = r >> 8;
      if (rt < 2) return c0 + (rd & -(rt ^ dir));
      /* Hard-coded for the four exceptional titlecase */
      return c0 + 1 - (dir << 1); // (dir ? -1 : 1);
    } else if (t > c) {
      xn = h;
    } else {
      xb += h;
      xn -= h;
    }
  }
  return c0;
}
`,"util/error":`// Common error messages for use across the standard library. Keeping error messages compact
// and reusing them where possible ensures minimal static data in binaries.

// @ts-ignore: decorator
@lazy @inline
export const E_INDEXOUTOFRANGE: string = "Index out of range";

// @ts-ignore: decorator
@lazy @inline
export const E_VALUEOUTOFRANGE: string = "Value out of range";

// @ts-ignore: decorator
@lazy @inline
export const E_INVALIDLENGTH: string = "Invalid length";

// @ts-ignore: decorator
@lazy @inline
export const E_EMPTYARRAY: string = "Array is empty";

// @ts-ignore: decorator
@lazy @inline
export const E_HOLEYARRAY: string = "Element type must be nullable if array is holey";

// @ts-ignore: decorator
@lazy @inline
export const E_NOTIMPLEMENTED: string = "Not implemented";

// @ts-ignore: decorator
@lazy @inline
export const E_KEYNOTFOUND: string = "Key does not exist";

// @ts-ignore: decorator
@lazy @inline
export const E_ALLOCATION_TOO_LARGE: string = "Allocation too large";

// @ts-ignore: decorator
@lazy @inline
export const E_ALREADY_PINNED: string = "Object already pinned";

// @ts-ignore: decorator
@lazy @inline
export const E_NOT_PINNED: string = "Object is not pinned";

// @ts-ignore: decorator
@lazy @inline
export const E_URI_MALFORMED: string = "URI malformed";

// @ts-ignore: decorator
@lazy @inline
export const E_INVALIDDATE: string = "Invalid Date";

// @ts-ignore: decorator
@lazy @inline
export const E_UNPAIRED_SURROGATE: string = "Unpaired surrogate";
`,"util/hash":`export function HASH<T>(key: T): u32 {
  if (isString<T>()) {
    return hashStr(changetype<string>(key));
  } else if (isReference<T>()) {
    if (sizeof<T>() == 4) return hash32(changetype<u32>(key));
    if (sizeof<T>() == 8) return hash64(changetype<u64>(key));
  } else if (isFloat<T>()) {
    if (sizeof<T>() == 4) return hash32(reinterpret<u32>(f32(key)));
    if (sizeof<T>() == 8) return hash64(reinterpret<u64>(f64(key)));
  } else {
    if (sizeof<T>() <= 4) return hash32(u32(key), sizeof<T>());
    if (sizeof<T>() == 8) return hash64(u64(key));
  }
  return unreachable();
}

// XXHash 32-bit as a starting point, see: https://cyan4973.github.io/xxHash

// primes
// @ts-ignore: decorator
@inline const XXH32_P1: u32 = 2654435761;
// @ts-ignore: decorator
@inline const XXH32_P2: u32 = 2246822519;
// @ts-ignore: decorator
@inline const XXH32_P3: u32 = 3266489917;
// @ts-ignore: decorator
@inline const XXH32_P4: u32 = 668265263;
// @ts-ignore: decorator
@inline const XXH32_P5: u32 = 374761393;
// @ts-ignore: decorator
@inline const XXH32_SEED: u32 = 0;

// @ts-ignore: decorator
@inline
function hash32(key: u32, len: u32 = 4): u32 {
  let h: u32 = XXH32_SEED + XXH32_P5 + len;
  h += key * XXH32_P3;
  h  = rotl(h, 17) * XXH32_P4;
  h ^= h >> 15;
  h *= XXH32_P2;
  h ^= h >> 13;
  h *= XXH32_P3;
  h ^= h >> 16;
  return h;
}

// @ts-ignore: decorator
@inline
function hash64(key: u64): u32 {
  let h: u32 = XXH32_SEED + XXH32_P5 + 8;
  h += <u32>key * XXH32_P3;
  h  = rotl(h, 17) * XXH32_P4;
  h += <u32>(key >> 32) * XXH32_P3;
  h  = rotl(h, 17) * XXH32_P4;
  h ^= h >> 15;
  h *= XXH32_P2;
  h ^= h >> 13;
  h *= XXH32_P3;
  h ^= h >> 16;
  return h;
}

// @ts-ignore: decorator
@inline
function mix(h: u32, key: u32): u32 {
  return rotl(h + key * XXH32_P2, 13) * XXH32_P1;
}

// @ts-ignore: decorator
@inline
function hashStr(key: string): u32 {
  if (changetype<usize>(key) == 0) return XXH32_SEED;

  let h: u32 = key.length << 1;
  let len: usize = h;
  let pos = changetype<usize>(key);

  if (len >= 16) {
    let s1 = XXH32_SEED + XXH32_P1 + XXH32_P2;
    let s2 = XXH32_SEED + XXH32_P2;
    let s3 = XXH32_SEED;
    let s4 = XXH32_SEED - XXH32_P1;

    let end = len + pos - 16;
    while (pos <= end) {
      s1 = mix(s1, load<u32>(pos    ));
      s2 = mix(s2, load<u32>(pos,  4));
      s3 = mix(s3, load<u32>(pos,  8));
      s4 = mix(s4, load<u32>(pos, 12));
      pos += 16;
    }
    h += rotl(s1, 1) + rotl(s2, 7) + rotl(s3, 12) + rotl(s4, 18);
  } else {
    h += XXH32_SEED + XXH32_P5;
  }

  let end = changetype<usize>(key) + len - 4;
  while (pos <= end) {
    h += load<u32>(pos) * XXH32_P3;
    h = rotl(h, 17) * XXH32_P4;
    pos += 4;
  }

  end = changetype<usize>(key) + len;
  while (pos < end) {
    h += <u32>load<u8>(pos) * XXH32_P5;
    h = rotl(h, 11) * XXH32_P1;
    pos++;
  }

  h ^= h >> 15;
  h *= XXH32_P2;
  h ^= h >> 13;
  h *= XXH32_P3;
  h ^= h >> 16;
  return h;
}
`,"util/math":`//
// Lookup data for exp2f
//

// @ts-ignore: decorator
@inline const EXP2F_TABLE_BITS = 5;

// @ts-ignore: decorator
@lazy @inline const EXP2F_DATA_TAB = memory.data<u64>([
  // exp2f_data_tab[i] = uint(2^(i/N)) - (i << 52-BITS)
  // used for computing 2^(k/N) for an int |k| < 150 N as
  // double(tab[k%N] + (k << 52-BITS))
  0x3FF0000000000000, 0x3FEFD9B0D3158574, 0x3FEFB5586CF9890F, 0x3FEF9301D0125B51,
  0x3FEF72B83C7D517B, 0x3FEF54873168B9AA, 0x3FEF387A6E756238, 0x3FEF1E9DF51FDEE1,
  0x3FEF06FE0A31B715, 0x3FEEF1A7373AA9CB, 0x3FEEDEA64C123422, 0x3FEECE086061892D,
  0x3FEEBFDAD5362A27, 0x3FEEB42B569D4F82, 0x3FEEAB07DD485429, 0x3FEEA47EB03A5585,
  0x3FEEA09E667F3BCD, 0x3FEE9F75E8EC5F74, 0x3FEEA11473EB0187, 0x3FEEA589994CCE13,
  0x3FEEACE5422AA0DB, 0x3FEEB737B0CDC5E5, 0x3FEEC49182A3F090, 0x3FEED503B23E255D,
  0x3FEEE89F995AD3AD, 0x3FEEFF76F2FB5E47, 0x3FEF199BDD85529C, 0x3FEF3720DCEF9069,
  0x3FEF5818DCFBA487, 0x3FEF7C97337B9B5F, 0x3FEFA4AFA2A490DA, 0x3FEFD0765B6E4540
]);

// ULP error: 0.502 (nearest rounding.)
// Relative error: 1.69 * 2^-34 in [-1/64, 1/64] (before rounding.)
// Wrong count: 168353 (all nearest rounding wrong results with fma.)
// @ts-ignore: decorator
@inline
export function exp2f_lut(x: f32): f32 {
  const
    N      = 1 << EXP2F_TABLE_BITS,
    N_MASK = N - 1,
    shift  = reinterpret<f64>(0x4338000000000000) / N, // 0x1.8p+52
    Ox127f = reinterpret<f32>(0x7F000000);

  const
    C0 = reinterpret<f64>(0x3FAC6AF84B912394), // 0x1.c6af84b912394p-5
    C1 = reinterpret<f64>(0x3FCEBFCE50FAC4F3), // 0x1.ebfce50fac4f3p-3
    C2 = reinterpret<f64>(0x3FE62E42FF0C52D6); // 0x1.62e42ff0c52d6p-1

  let xd = <f64>x;
  let ix = reinterpret<u32>(x);
  let ux = ix >> 20 & 0x7FF;
  if (ux >= 0x430) {
    // |x| >= 128 or x is nan.
    if (ix == 0xFF800000) return 0; // x == -Inf    -> 0
    if (ux >= 0x7F8) return x + x;  // x == Inf/NaN -> Inf/NaN
    if (x > 0) return x * Ox127f;   // x >     0    -> HugeVal (Owerflow)
    if (x <= -150) return 0;        // x <= -150    -> 0 (Underflow)
  }

  // x = k/N + r with r in [-1/(2N), 1/(2N)] and int k.
  let kd = xd + shift;
  let ki = reinterpret<u64>(kd);
  let r  = xd - (kd - shift);
  let t: u64, y: f64, s: f64;

  // exp2(x) = 2^(k/N) * 2^r ~= s * (C0*r^3 + C1*r^2 + C2*r + 1)
  t  = load<u64>(EXP2F_DATA_TAB + ((<usize>ki & N_MASK) << alignof<u64>()));
  t += ki << (52 - EXP2F_TABLE_BITS);
  s  = reinterpret<f64>(t);
  y  = C2 * r + 1;
  y += (C0 * r + C1) * (r  * r);
  y *= s;

  return <f32>y;
}

// ULP error: 0.502 (nearest rounding.)
// Relative error: 1.69 * 2^-34 in [-ln2/64, ln2/64] (before rounding.)
// Wrong count: 170635 (all nearest rounding wrong results with fma.)
// @ts-ignore: decorator
@inline
export function expf_lut(x: f32): f32 {
  const
    N        = 1 << EXP2F_TABLE_BITS,
    N_MASK   = N - 1,
    shift    = reinterpret<f64>(0x4338000000000000),        // 0x1.8p+52
    InvLn2N  = reinterpret<f64>(0x3FF71547652B82FE) * N,    // 0x1.71547652b82fep+0
    Ox1p127f = reinterpret<f32>(0x7F000000);

  const
    C0 = reinterpret<f64>(0x3FAC6AF84B912394) / N / N / N, // 0x1.c6af84b912394p-5
    C1 = reinterpret<f64>(0x3FCEBFCE50FAC4F3) / N / N,     // 0x1.ebfce50fac4f3p-3
    C2 = reinterpret<f64>(0x3FE62E42FF0C52D6) / N;         // 0x1.62e42ff0c52d6p-1

  let xd = <f64>x;
  let ix = reinterpret<u32>(x);
  let ux = ix >> 20 & 0x7FF;
  if (ux >= 0x42B) {
    // |x| >= 88 or x is nan.
    if (ix == 0xFF800000) return 0;                            // x == -Inf    -> 0
    if (ux >= 0x7F8) return x + x;                             // x == Inf/NaN -> Inf/NaN
    if (x > reinterpret<f32>(0x42B17217)) return x * Ox1p127f; // x > log(0x1p128)  ~=  88.72 -> HugeVal (Owerflow)
    if (x < reinterpret<f32>(0xC2CFF1B4)) return 0;            // x < log(0x1p-150) ~= -103.97 -> 0 (Underflow)
  }

  // x*N/Ln2 = k + r with r in [-1/2, 1/2] and int k.
  let z = InvLn2N * xd;

  // Round and convert z to int, the result is in [-150*N, 128*N] and
  // ideally ties-to-even rule is used, otherwise the magnitude of r
  // can be bigger which gives larger approximation error.
  let kd = <f64>(z + shift);
  let ki = reinterpret<u64>(kd);
  let r  = z - (kd - shift);
  let s: f64, y: f64, t: u64;

  // exp(x) = 2^(k/N) * 2^(r/N) ~= s * (C0*r^3 + C1*r^2 + C2*r + 1)
  t  = load<u64>(EXP2F_DATA_TAB + ((<usize>ki & N_MASK) << alignof<u64>()));
  t += ki << (52 - EXP2F_TABLE_BITS);
  s  = reinterpret<f64>(t);
  z  = C0 * r + C1;
  y  = C2 * r + 1;
  y += z * (r * r);
  y *= s;

  return <f32>y;
}

//
// Lookup data for log2f
//

// @ts-ignore: decorator
@inline const LOG2F_TABLE_BITS = 4;

// @ts-ignore: decorator
@lazy @inline const LOG2F_DATA_TAB = memory.data<u64>([
  0x3FF661EC79F8F3BE, 0xBFDEFEC65B963019, // 0x1.661ec79f8f3bep+0, -0x1.efec65b963019p-2,
  0x3FF571ED4AAF883D, 0xBFDB0B6832D4FCA4, // 0x1.571ed4aaf883dp+0, -0x1.b0b6832d4fca4p-2,
  0x3FF49539F0F010B0, 0xBFD7418B0A1FB77B, // 0x1.49539f0f010bp+0 , -0x1.7418b0a1fb77bp-2,
  0x3FF3C995B0B80385, 0xBFD39DE91A6DCF7B, // 0x1.3c995b0b80385p+0, -0x1.39de91a6dcf7bp-2,
  0x3FF30D190C8864A5, 0xBFD01D9BF3F2B631, // 0x1.30d190c8864a5p+0, -0x1.01d9bf3f2b631p-2,
  0x3FF25E227B0B8EA0, 0xBFC97C1D1B3B7AF0, // 0x1.25e227b0b8eap+0 , -0x1.97c1d1b3b7afp-3 ,
  0x3FF1BB4A4A1A343F, 0xBFC2F9E393AF3C9F, // 0x1.1bb4a4a1a343fp+0, -0x1.2f9e393af3c9fp-3,
  0x3FF12358F08AE5BA, 0xBFB960CBBF788D5C, // 0x1.12358f08ae5bap+0, -0x1.960cbbf788d5cp-4,
  0x3FF0953F419900A7, 0xBFAA6F9DB6475FCE, // 0x1.0953f419900a7p+0, -0x1.a6f9db6475fcep-5,
  0x3FF0000000000000, 0,                  // 0x1p+0,                0x0,
  0x3FEE608CFD9A47AC, 0x3FB338CA9F24F53D, // 0x1.e608cfd9a47acp-1,  0x1.338ca9f24f53dp-4,
  0x3FECA4B31F026AA0, 0x3FC476A9543891BA, // 0x1.ca4b31f026aap-1 ,  0x1.476a9543891bap-3,
  0x3FEB2036576AFCE6, 0x3FCE840B4AC4E4D2, // 0x1.b2036576afce6p-1,  0x1.e840b4ac4e4d2p-3,
  0x3FE9C2D163A1AA2D, 0x3FD40645F0C6651C, // 0x1.9c2d163a1aa2dp-1,  0x1.40645f0c6651cp-2,
  0x3FE886E6037841ED, 0x3FD88E9C2C1B9FF8, // 0x1.886e6037841edp-1,  0x1.88e9c2c1b9ff8p-2,
  0x3FE767DCF5534862, 0x3FDCE0A44EB17BCC  // 0x1.767dcf5534862p-1,  0x1.ce0a44eb17bccp-2
]);

// ULP error: 0.752 (nearest rounding.)
// Relative error: 1.9 * 2^-26 (before rounding.)
// @ts-ignore: decorator
@inline
export function log2f_lut(x: f32): f32 {
  const
    N_MASK  = (1 << LOG2F_TABLE_BITS) - 1,
    Ox1p23f = reinterpret<f32>(0x4B000000); // 0x1p23f

  const
    A0 = reinterpret<f64>(0xBFD712B6F70A7E4D), // -0x1.712b6f70a7e4dp-2
    A1 = reinterpret<f64>(0x3FDECABF496832E0), //  0x1.ecabf496832ep-2
    A2 = reinterpret<f64>(0xBFE715479FFAE3DE), // -0x1.715479ffae3dep-1
    A3 = reinterpret<f64>(0x3FF715475F35C8B8); //  0x1.715475f35c8b8p0

  let ux = reinterpret<u32>(x);
  // Fix sign of zero with downward rounding when x==1.
  // if (WANT_ROUNDING && predict_false(ix == 0x3f800000)) return 0;
  if (ux - 0x00800000 >= 0x7F800000 - 0x00800000) {
    // x < 0x1p-126 or inf or nan.
    if (ux * 2 == 0) return -Infinity;
    if (ux == 0x7F800000) return x; // log2(inf) == inf.
    if ((ux >> 31) || ux * 2 >= 0xFF000000) return (x - x) / (x - x);
    // x is subnormal, normalize it.
    ux = reinterpret<u32>(x * Ox1p23f);
    ux -= 23 << 23;
  }
  // x = 2^k z; where z is in range [OFF,2*OFF] and exact.
  // The range is split into N subintervals.
  // The ith subinterval contains z and c is near its center.
  let tmp  = ux - 0x3F330000;
  let i    = (tmp >> (23 - LOG2F_TABLE_BITS)) & N_MASK;
  let top  = tmp & 0xFF800000;
  let iz   = ux - top;
  let k    = <i32>tmp >> 23;

  let invc = load<f64>(LOG2F_DATA_TAB + (i << (1 + alignof<f64>())), 0 << alignof<f64>());
  let logc = load<f64>(LOG2F_DATA_TAB + (i << (1 + alignof<f64>())), 1 << alignof<f64>());
  let z    = <f64>reinterpret<f32>(iz);

  // log2(x) = log1p(z/c-1)/ln2 + log2(c) + k
  let r  = z * invc - 1;
  let y0 = logc + <f64>k;

  // Pipelined polynomial evaluation to approximate log1p(r)/ln2.
  let y  = A1 * r + A2;
  let p  = A3 * r + y0;
  let r2 = r * r;
  y += A0 * r2;
  y  = y * r2 + p;

  return <f32>y;
}

//
// Lookup data for logf. See: https://git.musl-libc.org/cgit/musl/tree/src/math/logf.c
//

// @ts-ignore: decorator
@inline const LOGF_TABLE_BITS = 4;

// @ts-ignore: decorator
@lazy @inline const LOGF_DATA_TAB = memory.data<u64>([
  0x3FF661EC79F8F3BE, 0xBFD57BF7808CAADE, // 0x1.661ec79f8f3bep+0, -0x1.57bf7808caadep-2,
  0x3FF571ED4AAF883D, 0xBFD2BEF0A7C06DDB, // 0x1.571ed4aaf883dp+0, -0x1.2bef0a7c06ddbp-2,
  0x3FF49539F0F010B0, 0xBFD01EAE7F513A67, // 0x1.49539f0f010bp+0 , -0x1.01eae7f513a67p-2,
  0x3FF3C995B0B80385, 0xBFCB31D8A68224E9, // 0x1.3c995b0b80385p+0, -0x1.b31d8a68224e9p-3,
  0x3FF30D190C8864A5, 0xBFC6574F0AC07758, // 0x1.30d190c8864a5p+0, -0x1.6574f0ac07758p-3,
  0x3FF25E227B0B8EA0, 0xBFC1AA2BC79C8100, // 0x1.25e227b0b8eap+0 , -0x1.1aa2bc79c81p-3  ,
  0x3FF1BB4A4A1A343F, 0xBFBA4E76CE8C0E5E, // 0x1.1bb4a4a1a343fp+0, -0x1.a4e76ce8c0e5ep-4,
  0x3FF12358F08AE5BA, 0xBFB1973C5A611CCC, // 0x1.12358f08ae5bap+0, -0x1.1973c5a611cccp-4,
  0x3FF0953F419900A7, 0xBFA252F438E10C1E, // 0x1.0953f419900a7p+0, -0x1.252f438e10c1ep-5,
  0x3FF0000000000000, 0,                  // 0x1p+0,                0,
  0x3FEE608CFD9A47AC, 0x3FAAA5AA5DF25984, // 0x1.e608cfd9a47acp-1,  0x1.aa5aa5df25984p-5,
  0x3FECA4B31F026AA0, 0x3FBC5E53AA362EB4, // 0x1.ca4b31f026aap-1 ,  0x1.c5e53aa362eb4p-4,
  0x3FEB2036576AFCE6, 0x3FC526E57720DB08, // 0x1.b2036576afce6p-1,  0x1.526e57720db08p-3,
  0x3FE9C2D163A1AA2D, 0x3FCBC2860D224770, // 0x1.9c2d163a1aa2dp-1,  0x1.bc2860d22477p-3 ,
  0x3FE886E6037841ED, 0x3FD1058BC8A07EE1, // 0x1.886e6037841edp-1,  0x1.1058bc8a07ee1p-2,
  0x3FE767DCF5534862, 0x3FD4043057B6EE09  // 0x1.767dcf5534862p-1,  0x1.4043057b6ee09p-2
]);

// ULP error: 0.818 (nearest rounding.)
// Relative error: 1.957 * 2^-26 (before rounding.)
// @ts-ignore: decorator
@inline
export function logf_lut(x: f32): f32 {
  const
    N_MASK  = (1 << LOGF_TABLE_BITS) - 1,
    Ox1p23f = reinterpret<f32>(0x4B000000); // 0x1p23f

  const
    Ln2 = reinterpret<f64>(0x3FE62E42FEFA39EF), // 0x1.62e42fefa39efp-1;
    A0  = reinterpret<f64>(0xBFD00EA348B88334), // -0x1.00ea348b88334p-2
    A1  = reinterpret<f64>(0x3FD5575B0BE00B6A), //  0x1.5575b0be00b6ap-2
    A2  = reinterpret<f64>(0xBFDFFFFEF20A4123); // -0x1.ffffef20a4123p-2

  let ux = reinterpret<u32>(x);
  // Fix sign of zero with downward rounding when x==1.
  // if (WANT_ROUNDING && ux == 0x3f800000) return 0;
  if (ux - 0x00800000 >= 0x7F800000 - 0x00800000) {
    // x < 0x1p-126 or inf or nan.
    if ((ux << 1) == 0) return -Infinity;
    if (ux == 0x7F800000) return x; // log(inf) == inf.
    if ((ux >> 31) || (ux << 1) >= 0xFF000000) return (x - x) / (x - x);
    // x is subnormal, normalize it.
    ux = reinterpret<u32>(x * Ox1p23f);
    ux -= 23 << 23;
  }
  // x = 2^k z; where z is in range [OFF,2*OFF] and exact.
  // The range is split into N subintervals.
  // The ith subinterval contains z and c is near its center.
  let tmp = ux - 0x3F330000;
  let i   = (tmp >> (23 - LOGF_TABLE_BITS)) & N_MASK;
  let k   = <i32>tmp >> 23;
  let iz  = ux - (tmp & 0x1FF << 23);

  let invc = load<f64>(LOGF_DATA_TAB + (i << (1 + alignof<f64>())), 0 << alignof<f64>());
  let logc = load<f64>(LOGF_DATA_TAB + (i << (1 + alignof<f64>())), 1 << alignof<f64>());

  let z = <f64>reinterpret<f32>(iz);

  // log(x) = log1p(z/c-1) + log(c) + k*Ln2
  let r = z * invc - 1;
  let y0 = logc + <f64>k * Ln2;

  // Pipelined polynomial evaluation to approximate log1p(r).
  let r2 = r * r;
  let y  = A1 * r + A2;
  y += A0 * r2;
  y = y * r2 + (y0 + r);

  return <f32>y;
}

//
// Lookup data for powf. See: https://git.musl-libc.org/cgit/musl/tree/src/math/powf.c
//

// @ts-ignore: decorator
@inline
function zeroinfnanf(ux: u32): bool {
  return (ux << 1) - 1 >= (<u32>0x7f800000 << 1) - 1;
}

// Returns 0 if not int, 1 if odd int, 2 if even int. The argument is
// the bit representation of a non-zero finite floating-point value.
// @ts-ignore: decorator
@inline
function checkintf(iy: u32): i32 {
  let e = iy >> 23 & 0xFF;
  if (e < 0x7F     ) return 0;
  if (e > 0x7F + 23) return 2;
  e = 1 << (0x7F + 23 - e);
  if (iy & (e - 1)) return 0;
  if (iy &  e     ) return 1;
  return 2;
}

// Subnormal input is normalized so ix has negative biased exponent.
// Output is multiplied by N (POWF_SCALE) if TOINT_INTRINICS is set.
// @ts-ignore: decorator
@inline
function log2f_inline(ux: u32): f64 {
  const N_MASK = (1 << LOG2F_TABLE_BITS) - 1;

  const
    A0 = reinterpret<f64>(0x3FD27616C9496E0B), //  0x1.27616c9496e0bp-2
    A1 = reinterpret<f64>(0xBFD71969A075C67A), // -0x1.71969a075c67ap-2
    A2 = reinterpret<f64>(0x3FDEC70A6CA7BADD), //  0x1.ec70a6ca7baddp-2
    A3 = reinterpret<f64>(0xBFE7154748BEF6C8), // -0x1.7154748bef6c8p-1
    A4 = reinterpret<f64>(0x3FF71547652AB82B); //  0x1.71547652ab82bp+0

  // x = 2^k z; where z is in range [OFF,2*OFF] and exact.
  // The range is split into N subintervals.
  // The ith subinterval contains z and c is near its center.
  let tmp  = ux - 0x3F330000;
  let i    = usize((tmp >> (23 - LOG2F_TABLE_BITS)) & N_MASK);
  let top  = tmp & 0xFF800000;
  let uz   = ux - top;
  let k    = <i32>top >> 23;

  let invc = load<f64>(LOG2F_DATA_TAB + (i << (1 + alignof<f64>())), 0 << alignof<f64>());
  let logc = load<f64>(LOG2F_DATA_TAB + (i << (1 + alignof<f64>())), 1 << alignof<f64>());
  let z    = <f64>reinterpret<f32>(uz);

  // log2(x) = log1p(z/c-1)/ln2 + log2(c) + k
  let r  = z * invc - 1;
  let y0 = logc + <f64>k;

  // Pipelined polynomial evaluation to approximate log1p(r)/ln2.
  let y = A0 * r + A1;
  let p = A2 * r + A3;
  let q = A4 * r + y0;

  r *= r;
  q += p * r;
  y  = y * (r * r) + q;

  return y;
}

// The output of log2 and thus the input of exp2 is either scaled by N
// (in case of fast toint intrinsics) or not.  The unscaled xd must be
// in [-1021,1023], sign_bias sets the sign of the result.
// @ts-ignore: decorator
@inline
function exp2f_inline(xd: f64, signBias: u32): f32 {
  const
    N      = 1 << EXP2F_TABLE_BITS,
    N_MASK = N - 1,
    shift  = reinterpret<f64>(0x4338000000000000) / N; // 0x1.8p+52

  const
    C0 = reinterpret<f64>(0x3FAC6AF84B912394), // 0x1.c6af84b912394p-5
    C1 = reinterpret<f64>(0x3FCEBFCE50FAC4F3), // 0x1.ebfce50fac4f3p-3
    C2 = reinterpret<f64>(0x3FE62E42FF0C52D6); // 0x1.62e42ff0c52d6p-1

  // x = k/N + r with r in [-1/(2N), 1/(2N)]
  let kd = <f64>(xd + shift);
  let ki = reinterpret<u64>(kd);
  let r  = xd - (kd - shift);
  let t: u64, z: f64, y: f64, s: f64;

  // exp2(x) = 2^(k/N) * 2^r ~= s * (C0*r^3 + C1*r^2 + C2*r + 1)
  t  = load<u64>(EXP2F_DATA_TAB + ((<usize>ki & N_MASK) << alignof<u64>()));
  t += (ki + signBias) << (52 - EXP2F_TABLE_BITS);
  s  = reinterpret<f64>(t);
  z  = C0 * r + C1;
  y  = C2 * r + 1;
  y += z * (r * r);
  y *= s;
  return <f32>y;
}

// @ts-ignore: decorator
@inline
function xflowf(sign: u32, y: f32): f32 {
  return select<f32>(-y, y, sign) * y;
}

// @ts-ignore: decorator
@inline
function oflowf(sign: u32): f32 {
  return xflowf(sign, reinterpret<f32>(0x70000000)); // 0x1p97f
}

// @ts-ignore: decorator
@inline
function uflowf(sign: u32): f32 {
  return xflowf(sign, reinterpret<f32>(0x10000000)); // 0x1p-95f
}

// @ts-ignore: decorator
@inline
export function powf_lut(x: f32, y: f32): f32 {
  const
    Ox1p23f     = reinterpret<f32>(0x4B000000), // 0x1p23f
    UPPER_LIMIT = reinterpret<f64>(0x405FFFFFFFD1D571), // 0x1.fffffffd1d571p+6
    LOWER_LIMIT = -150.0,
    SIGN_BIAS   = 1 << (EXP2F_TABLE_BITS + 11);

  let signBias: u32 = 0;
  let ix = reinterpret<u32>(x);
  let iy = reinterpret<u32>(y);
  let ny = 0;

  if (i32(ix - 0x00800000 >= 0x7f800000 - 0x00800000) | (ny = i32(zeroinfnanf(iy)))) {
    // Either (x < 0x1p-126 or inf or nan) or (y is 0 or inf or nan).
    if (ny) {
      if ((iy << 1) == 0) return 1.0;
      if (ix == 0x3F800000) return NaN; // original: 1.0
      if ((ix << 1) > (<u32>0x7F800000 << 1) || (iy << 1) > (<u32>0x7F800000 << 1)) return x + y;
      if ((ix << 1) == (0x3F800000 << 1)) return NaN; // original: 1.0
      if (((ix << 1) < (0x3F800000 << 1)) == !(iy >> 31)) return 0; // |x| < 1 && y==inf or |x| > 1 && y==-inf.
      return y * y;
    }
    if (zeroinfnanf(ix)) {
      let x2 = x * x;
      if ((ix >> 31) && checkintf(iy) == 1) x2 = -x2;
      return <i32>iy < 0 ? 1 / x2 : x2;
    }
    // x and y are non-zero finite.
    if (<i32>ix < 0) {
      // Finite x < 0.
      let yint = checkintf(iy);
      if (yint == 0) return (x - x) / (x - x);
      if (yint == 1) signBias = SIGN_BIAS;
      ix &= 0x7FFFFFFF;
    }
    if (ix < 0x00800000) {
      // Normalize subnormal x so exponent becomes negative.
      ix = reinterpret<u32>(x * Ox1p23f);
      ix &= 0x7FFFFFFF;
      ix -= 23 << 23;
    }
  }
  let logx = log2f_inline(ix);
  let ylogx = y * logx; // cannot overflow, y is single prec.
  if ((reinterpret<u64>(ylogx) >> 47 & 0xFFFF) >= 0x80BF) { // reinterpret<u64>(126.0) >> 47
    // |y * log(x)| >= 126
    if (ylogx  > UPPER_LIMIT) return oflowf(signBias); // overflow
    if (ylogx <= LOWER_LIMIT) return uflowf(signBias); // underflow
  }
  return exp2f_inline(ylogx, signBias);
}

//
// Lookup data for exp. See: https://git.musl-libc.org/cgit/musl/tree/src/math/exp.c
//

// @ts-ignore: decorator
@inline const EXP_TABLE_BITS = 7;

// @ts-ignore: decorator
@lazy @inline const EXP_DATA_TAB = memory.data<u64>([
  0x0000000000000000, 0x3FF0000000000000,
  0x3C9B3B4F1A88BF6E, 0x3FEFF63DA9FB3335,
  0xBC7160139CD8DC5D, 0x3FEFEC9A3E778061,
  0xBC905E7A108766D1, 0x3FEFE315E86E7F85,
  0x3C8CD2523567F613, 0x3FEFD9B0D3158574,
  0xBC8BCE8023F98EFA, 0x3FEFD06B29DDF6DE,
  0x3C60F74E61E6C861, 0x3FEFC74518759BC8,
  0x3C90A3E45B33D399, 0x3FEFBE3ECAC6F383,
  0x3C979AA65D837B6D, 0x3FEFB5586CF9890F,
  0x3C8EB51A92FDEFFC, 0x3FEFAC922B7247F7,
  0x3C3EBE3D702F9CD1, 0x3FEFA3EC32D3D1A2,
  0xBC6A033489906E0B, 0x3FEF9B66AFFED31B,
  0xBC9556522A2FBD0E, 0x3FEF9301D0125B51,
  0xBC5080EF8C4EEA55, 0x3FEF8ABDC06C31CC,
  0xBC91C923B9D5F416, 0x3FEF829AAEA92DE0,
  0x3C80D3E3E95C55AF, 0x3FEF7A98C8A58E51,
  0xBC801B15EAA59348, 0x3FEF72B83C7D517B,
  0xBC8F1FF055DE323D, 0x3FEF6AF9388C8DEA,
  0x3C8B898C3F1353BF, 0x3FEF635BEB6FCB75,
  0xBC96D99C7611EB26, 0x3FEF5BE084045CD4,
  0x3C9AECF73E3A2F60, 0x3FEF54873168B9AA,
  0xBC8FE782CB86389D, 0x3FEF4D5022FCD91D,
  0x3C8A6F4144A6C38D, 0x3FEF463B88628CD6,
  0x3C807A05B0E4047D, 0x3FEF3F49917DDC96,
  0x3C968EFDE3A8A894, 0x3FEF387A6E756238,
  0x3C875E18F274487D, 0x3FEF31CE4FB2A63F,
  0x3C80472B981FE7F2, 0x3FEF2B4565E27CDD,
  0xBC96B87B3F71085E, 0x3FEF24DFE1F56381,
  0x3C82F7E16D09AB31, 0x3FEF1E9DF51FDEE1,
  0xBC3D219B1A6FBFFA, 0x3FEF187FD0DAD990,
  0x3C8B3782720C0AB4, 0x3FEF1285A6E4030B,
  0x3C6E149289CECB8F, 0x3FEF0CAFA93E2F56,
  0x3C834D754DB0ABB6, 0x3FEF06FE0A31B715,
  0x3C864201E2AC744C, 0x3FEF0170FC4CD831,
  0x3C8FDD395DD3F84A, 0x3FEEFC08B26416FF,
  0xBC86A3803B8E5B04, 0x3FEEF6C55F929FF1,
  0xBC924AEDCC4B5068, 0x3FEEF1A7373AA9CB,
  0xBC9907F81B512D8E, 0x3FEEECAE6D05D866,
  0xBC71D1E83E9436D2, 0x3FEEE7DB34E59FF7,
  0xBC991919B3CE1B15, 0x3FEEE32DC313A8E5,
  0x3C859F48A72A4C6D, 0x3FEEDEA64C123422,
  0xBC9312607A28698A, 0x3FEEDA4504AC801C,
  0xBC58A78F4817895B, 0x3FEED60A21F72E2A,
  0xBC7C2C9B67499A1B, 0x3FEED1F5D950A897,
  0x3C4363ED60C2AC11, 0x3FEECE086061892D,
  0x3C9666093B0664EF, 0x3FEECA41ED1D0057,
  0x3C6ECCE1DAA10379, 0x3FEEC6A2B5C13CD0,
  0x3C93FF8E3F0F1230, 0x3FEEC32AF0D7D3DE,
  0x3C7690CEBB7AAFB0, 0x3FEEBFDAD5362A27,
  0x3C931DBDEB54E077, 0x3FEEBCB299FDDD0D,
  0xBC8F94340071A38E, 0x3FEEB9B2769D2CA7,
  0xBC87DECCDC93A349, 0x3FEEB6DAA2CF6642,
  0xBC78DEC6BD0F385F, 0x3FEEB42B569D4F82,
  0xBC861246EC7B5CF6, 0x3FEEB1A4CA5D920F,
  0x3C93350518FDD78E, 0x3FEEAF4736B527DA,
  0x3C7B98B72F8A9B05, 0x3FEEAD12D497C7FD,
  0x3C9063E1E21C5409, 0x3FEEAB07DD485429,
  0x3C34C7855019C6EA, 0x3FEEA9268A5946B7,
  0x3C9432E62B64C035, 0x3FEEA76F15AD2148,
  0xBC8CE44A6199769F, 0x3FEEA5E1B976DC09,
  0xBC8C33C53BEF4DA8, 0x3FEEA47EB03A5585,
  0xBC845378892BE9AE, 0x3FEEA34634CCC320,
  0xBC93CEDD78565858, 0x3FEEA23882552225,
  0x3C5710AA807E1964, 0x3FEEA155D44CA973,
  0xBC93B3EFBF5E2228, 0x3FEEA09E667F3BCD,
  0xBC6A12AD8734B982, 0x3FEEA012750BDABF,
  0xBC6367EFB86DA9EE, 0x3FEE9FB23C651A2F,
  0xBC80DC3D54E08851, 0x3FEE9F7DF9519484,
  0xBC781F647E5A3ECF, 0x3FEE9F75E8EC5F74,
  0xBC86EE4AC08B7DB0, 0x3FEE9F9A48A58174,
  0xBC8619321E55E68A, 0x3FEE9FEB564267C9,
  0x3C909CCB5E09D4D3, 0x3FEEA0694FDE5D3F,
  0xBC7B32DCB94DA51D, 0x3FEEA11473EB0187,
  0x3C94ECFD5467C06B, 0x3FEEA1ED0130C132,
  0x3C65EBE1ABD66C55, 0x3FEEA2F336CF4E62,
  0xBC88A1C52FB3CF42, 0x3FEEA427543E1A12,
  0xBC9369B6F13B3734, 0x3FEEA589994CCE13,
  0xBC805E843A19FF1E, 0x3FEEA71A4623C7AD,
  0xBC94D450D872576E, 0x3FEEA8D99B4492ED,
  0x3C90AD675B0E8A00, 0x3FEEAAC7D98A6699,
  0x3C8DB72FC1F0EAB4, 0x3FEEACE5422AA0DB,
  0xBC65B6609CC5E7FF, 0x3FEEAF3216B5448C,
  0x3C7BF68359F35F44, 0x3FEEB1AE99157736,
  0xBC93091FA71E3D83, 0x3FEEB45B0B91FFC6,
  0xBC5DA9B88B6C1E29, 0x3FEEB737B0CDC5E5,
  0xBC6C23F97C90B959, 0x3FEEBA44CBC8520F,
  0xBC92434322F4F9AA, 0x3FEEBD829FDE4E50,
  0xBC85CA6CD7668E4B, 0x3FEEC0F170CA07BA,
  0x3C71AFFC2B91CE27, 0x3FEEC49182A3F090,
  0x3C6DD235E10A73BB, 0x3FEEC86319E32323,
  0xBC87C50422622263, 0x3FEECC667B5DE565,
  0x3C8B1C86E3E231D5, 0x3FEED09BEC4A2D33,
  0xBC91BBD1D3BCBB15, 0x3FEED503B23E255D,
  0x3C90CC319CEE31D2, 0x3FEED99E1330B358,
  0x3C8469846E735AB3, 0x3FEEDE6B5579FDBF,
  0xBC82DFCD978E9DB4, 0x3FEEE36BBFD3F37A,
  0x3C8C1A7792CB3387, 0x3FEEE89F995AD3AD,
  0xBC907B8F4AD1D9FA, 0x3FEEEE07298DB666,
  0xBC55C3D956DCAEBA, 0x3FEEF3A2B84F15FB,
  0xBC90A40E3DA6F640, 0x3FEEF9728DE5593A,
  0xBC68D6F438AD9334, 0x3FEEFF76F2FB5E47,
  0xBC91EEE26B588A35, 0x3FEF05B030A1064A,
  0x3C74FFD70A5FDDCD, 0x3FEF0C1E904BC1D2,
  0xBC91BDFBFA9298AC, 0x3FEF12C25BD71E09,
  0x3C736EAE30AF0CB3, 0x3FEF199BDD85529C,
  0x3C8EE3325C9FFD94, 0x3FEF20AB5FFFD07A,
  0x3C84E08FD10959AC, 0x3FEF27F12E57D14B,
  0x3C63CDAF384E1A67, 0x3FEF2F6D9406E7B5,
  0x3C676B2C6C921968, 0x3FEF3720DCEF9069,
  0xBC808A1883CCB5D2, 0x3FEF3F0B555DC3FA,
  0xBC8FAD5D3FFFFA6F, 0x3FEF472D4A07897C,
  0xBC900DAE3875A949, 0x3FEF4F87080D89F2,
  0x3C74A385A63D07A7, 0x3FEF5818DCFBA487,
  0xBC82919E2040220F, 0x3FEF60E316C98398,
  0x3C8E5A50D5C192AC, 0x3FEF69E603DB3285,
  0x3C843A59AC016B4B, 0x3FEF7321F301B460,
  0xBC82D52107B43E1F, 0x3FEF7C97337B9B5F,
  0xBC892AB93B470DC9, 0x3FEF864614F5A129,
  0x3C74B604603A88D3, 0x3FEF902EE78B3FF6,
  0x3C83C5EC519D7271, 0x3FEF9A51FBC74C83,
  0xBC8FF7128FD391F0, 0x3FEFA4AFA2A490DA,
  0xBC8DAE98E223747D, 0x3FEFAF482D8E67F1,
  0x3C8EC3BC41AA2008, 0x3FEFBA1BEE615A27,
  0x3C842B94C3A9EB32, 0x3FEFC52B376BBA97,
  0x3C8A64A931D185EE, 0x3FEFD0765B6E4540,
  0xBC8E37BAE43BE3ED, 0x3FEFDBFDAD9CBE14,
  0x3C77893B4D91CD9D, 0x3FEFE7C1819E90D8,
  0x3C5305C14160CC89, 0x3FEFF3C22B8F71F1
]);

// Handle cases that may overflow or underflow when computing the result that
// is scale*(1+TMP) without intermediate rounding. The bit representation of
// scale is in SBITS, however it has a computed exponent that may have
// overflown into the sign bit so that needs to be adjusted before using it as
// a double.  (int32_t)KI is the k used in the argument reduction and exponent
// adjustment of scale, positive k here means the result may overflow and
// negative k means the result may underflow.
// @ts-ignore: decorator
@inline
function specialcase(tmp: f64, sbits: u64, ki: u64): f64 {
  const
    Ox1p_1022 = reinterpret<f64>(0x0010000000000000), // 0x1p-1022
    Ox1p1009  = reinterpret<f64>(0x7F00000000000000); // 0x1p1009

  let scale: f64;
  if (!(ki & 0x80000000)) {
    // k > 0, the exponent of scale might have overflowed by <= 460.
    sbits -= u64(1009) << 52;
    scale = reinterpret<f64>(sbits);
    return Ox1p1009 * (scale + scale * tmp); // 0x1p1009
  }
  // k < 0, need special care in the subnormal range.
  sbits += u64(1022) << 52;
  // Note: sbits is signed scale.
  scale = reinterpret<f64>(sbits);
  let y = scale + scale * tmp;
  if (abs(y) < 1.0) {
    // Round y to the right precision before scaling it into the subnormal
    // range to avoid double rounding that can cause 0.5+E/2 ulp error where
    // E is the worst-case ulp error outside the subnormal range.  So this
    // is only useful if the goal is better than 1 ulp worst-case error.
    let one = copysign(1.0, y);
    let lo = scale - y + scale * tmp;
    let hi = one + y;
    lo = one - hi + y + lo;
    y  = (hi + lo) - one;
    // Fix the sign of 0.
    if (y == 0.0) y = reinterpret<f64>(sbits & 0x8000000000000000);
  }
  return y * Ox1p_1022;
}

// @ts-ignore: decorator
@inline
export function exp_lut(x: f64): f64 {
  const
    N      = 1 << EXP_TABLE_BITS,
    N_MASK = N - 1;

  const
    InvLn2N   = reinterpret<f64>(0x3FF71547652B82FE) * N, // 0x1.71547652b82fep0
    NegLn2hiN = reinterpret<f64>(0xBF762E42FEFA0000),     // -0x1.62e42fefa0000p-8
    NegLn2loN = reinterpret<f64>(0xBD0CF79ABC9E3B3A),     // -0x1.cf79abc9e3b3ap-47
    shift     = reinterpret<f64>(0x4338000000000000);     // 0x1.8p52;

  const
    C2 = reinterpret<f64>(0x3FDFFFFFFFFFFDBD), // __exp_data.poly[0] (0x1.ffffffffffdbdp-2)
    C3 = reinterpret<f64>(0x3FC555555555543C), // __exp_data.poly[1] (0x1.555555555543cp-3)
    C4 = reinterpret<f64>(0x3FA55555CF172B91), // __exp_data.poly[2] (0x1.55555cf172b91p-5)
    C5 = reinterpret<f64>(0x3F81111167A4D017); // __exp_data.poly[3] (0x1.1111167a4d017p-7)

  let ux = reinterpret<u64>(x);
  let abstop = u32(ux >> 52) & 0x7FF;
  if (abstop - 0x3C9 >= 0x03F) {
    if (abstop - 0x3C9 >= 0x80000000) return 1;
    if (abstop >= 0x409) {
      if (ux == 0xFFF0000000000000) return 0;
      if (abstop >= 0x7FF) {
        return 1.0 + x;
      } else {
        return select<f64>(0, Infinity, <i64>ux < 0);
      }
    }
    // Large x is special cased below.
    abstop = 0;
  }

  // exp(x) = 2^(k/N) * exp(r), with exp(r) in [2^(-1/2N),2^(1/2N)]
  // x = ln2/N*k + r, with int k and r in [-ln2/2N, ln2/2N]
  let z = InvLn2N * x;
  // #if TOINT_INTRINSICS
  // 	kd = roundtoint(z);
  // 	ki = converttoint(z);
  // #elif EXP_USE_TOINT_NARROW
  // 	// z - kd is in [-0.5-2^-16, 0.5] in all rounding modes.
  // let kd = z + shift;
  // let ki = reinterpret<u64>(kd) >> 16;
  // let kd = <f64><i32>ki;
  // #else
  // z - kd is in [-1, 1] in non-nearest rounding modes.
  let kd = z + shift;
  let ki = reinterpret<u64>(kd);
  kd -= shift;
  // #endif
  let r = x + kd * NegLn2hiN + kd * NegLn2loN;
  // 2^(k/N) ~= scale * (1 + tail).
  let idx = usize((ki & N_MASK) << 1);
  let top = ki << (52 - EXP_TABLE_BITS);

  let tail = reinterpret<f64>(load<u64>(EXP_DATA_TAB + (idx << alignof<u64>()))); // T[idx]
  // This is only a valid scale when -1023*N < k < 1024*N
  let sbits = load<u64>(EXP_DATA_TAB + (idx << alignof<u64>()), 1 << alignof<u64>()) + top; // T[idx + 1]
  // exp(x) = 2^(k/N) * exp(r) ~= scale + scale * (tail + exp(r) - 1).
  // Evaluation is optimized assuming superscalar pipelined execution.
  let r2 = r * r;
  // Without fma the worst case error is 0.25/N ulp larger.
  // Worst case error is less than 0.5+1.11/N+(abs poly error * 2^53) ulp.
  let tmp = tail + r + r2 * (C2 + r * C3) + r2 * r2 * (C4 + r * C5);
  if (abstop == 0) return specialcase(tmp, sbits, ki);
  let scale = reinterpret<f64>(sbits);
  // Note: tmp == 0 or |tmp| > 2^-200 and scale > 2^-739, so there
  // is no spurious underflow here even without fma.
  return scale + scale * tmp;
}

//
// Lookup data for exp2. See: https://git.musl-libc.org/cgit/musl/tree/src/math/exp2.c
//

// Handle cases that may overflow or underflow when computing the result that
// is scale*(1+TMP) without intermediate rounding.  The bit representation of
// scale is in SBITS, however it has a computed exponent that may have
// overflown into the sign bit so that needs to be adjusted before using it as
// a double.  (int32_t)KI is the k used in the argument reduction and exponent
// adjustment of scale, positive k here means the result may overflow and
// negative k means the result may underflow.
// @ts-ignore: decorator
@inline
function specialcase2(tmp: f64, sbits: u64, ki: u64): f64 {
  const Ox1p_1022 = reinterpret<f64>(0x10000000000000); // 0x1p-1022
  let scale: f64;
  if ((ki & 0x80000000) == 0) {
    // k > 0, the exponent of scale might have overflowed by 1
    sbits -= u64(1) << 52;
    scale = reinterpret<f64>(sbits);
    return 2 * (scale * tmp + scale);
  }
  // k < 0, need special care in the subnormal range
  sbits += u64(1022) << 52;
  scale = reinterpret<f64>(sbits);
  let y = scale * tmp + scale;
  if (y < 1.0) {
    // Round y to the right precision before scaling it into the subnormal
    // range to avoid double rounding that can cause 0.5+E/2 ulp error where
    // E is the worst-case ulp error outside the subnormal range. So this
    // is only useful if the goal is better than 1 ulp worst-case error.
    let hi: f64, lo: f64;
    lo = scale - y + scale * tmp;
    hi = 1.0 + y;
    lo = 1.0 - hi + y + lo;
    y = (hi + lo) - 1.0;
  }
  return y * Ox1p_1022;
}

// @ts-ignore: decorator
@inline
export function exp2_lut(x: f64): f64 {
  const
    N      = 1 << EXP_TABLE_BITS,
    N_MASK = N - 1,
    shift  = reinterpret<f64>(0x4338000000000000) / N; // 0x1.8p52

  const
    C1 = reinterpret<f64>(0x3FE62E42FEFA39EF), // 0x1.62e42fefa39efp-1
    C2 = reinterpret<f64>(0x3FCEBFBDFF82C424), // 0x1.ebfbdff82c424p-3
    C3 = reinterpret<f64>(0x3FAC6B08D70CF4B5), // 0x1.c6b08d70cf4b5p-5
    C4 = reinterpret<f64>(0x3F83B2ABD24650CC), // 0x1.3b2abd24650ccp-7
    C5 = reinterpret<f64>(0x3F55D7E09B4E3A84); // 0x1.5d7e09b4e3a84p-10

  let ux = reinterpret<u64>(x);
  let abstop = u32(ux >> 52) & 0x7ff;
  if (abstop - 0x3C9 >= 0x03F) {
    if (abstop - 0x3C9 >= 0x80000000) return 1.0;
    if (abstop >= 0x409) {
      if (ux == 0xFFF0000000000000) return 0;
      if (abstop >= 0x7FF) return 1.0 + x;
      if (<i64>ux >= 0) return Infinity;
      else if (ux >= 0xC090CC0000000000) return 0;
    }
    if ((ux << 1) > 0x811A000000000000) abstop = 0; // Large x is special cased below.
  }

  // exp2(x) = 2^(k/N) * 2^r, with 2^r in [2^(-1/2N),2^(1/2N)].
  // x = k/N + r, with int k and r in [-1/2N, 1/2N]
  let kd = x + shift;
  let ki = reinterpret<u64>(kd);
  kd -= shift; // k/N for int k
  let r = x - kd;
  // 2^(k/N) ~= scale * (1 + tail)
  let idx = usize((ki & N_MASK) << 1);
  let top = ki << (52 - EXP_TABLE_BITS);

  let tail = reinterpret<f64>(load<u64>(EXP_DATA_TAB + (idx << alignof<u64>()), 0 << alignof<u64>())); // T[idx])
  // This is only a valid scale when -1023*N < k < 1024*N
  let sbits = load<u64>(EXP_DATA_TAB + (idx << alignof<u64>()), 1 << alignof<u64>()) + top; // T[idx + 1]
  // exp2(x) = 2^(k/N) * 2^r ~= scale + scale * (tail + 2^r - 1).
  // Evaluation is optimized assuming superscalar pipelined execution
  let r2 = r * r;
  // Without fma the worst case error is 0.5/N ulp larger.
  // Worst case error is less than 0.5+0.86/N+(abs poly error * 2^53) ulp.
  let tmp = tail + r * C1 + r2 * (C2 + r * C3) + r2 * r2 * (C4 + r * C5);
  if (abstop == 0) return specialcase2(tmp, sbits, ki);
  let scale = reinterpret<f64>(sbits);
  // Note: tmp == 0 or |tmp| > 2^-65 and scale > 2^-928, so there
  // is no spurious underflow here even without fma.
  return scale * tmp + scale;
}

//
// Lookup data for log2. See: https://git.musl-libc.org/cgit/musl/tree/src/math/log2.c
//

// @ts-ignore: decorator
@inline const LOG2_TABLE_BITS = 6;

/* Algorithm:

  x = 2^k z
  log2(x) = k + log2(c) + log2(z/c)
  log2(z/c) = poly(z/c - 1)

where z is in [1.6p-1; 1.6p0] which is split into N subintervals and z falls
into the ith one, then table entries are computed as

  tab[i].invc = 1/c
  tab[i].logc = (double)log2(c)
  tab2[i].chi = (double)c
  tab2[i].clo = (double)(c - (double)c)

where c is near the center of the subinterval and is chosen by trying +-2^29
floating point invc candidates around 1/center and selecting one for which

  1) the rounding error in 0x1.8p10 + logc is 0,
  2) the rounding error in z - chi - clo is < 0x1p-64 and
  3) the rounding error in (double)log2(c) is minimized (< 0x1p-68).

Note: 1) ensures that k + logc can be computed without rounding error, 2)
ensures that z/c - 1 can be computed as (z - chi - clo)*invc with close to a
single rounding error when there is no fast fma for z*invc - 1, 3) ensures
that logc + poly(z/c - 1) has small error, however near x == 1 when
|log2(x)| < 0x1p-4, this is not enough so that is special cased. */

// @ts-ignore: decorator
@lazy @inline const LOG2_DATA_TAB1 = memory.data<u64>([
  //     invc       ,        logc
  0x3FF724286BB1ACF8, 0xBFE1095FEECDB000,
  0x3FF6E1F766D2CCA1, 0xBFE08494BD76D000,
  0x3FF6A13D0E30D48A, 0xBFE00143AEE8F800,
  0x3FF661EC32D06C85, 0xBFDEFEC5360B4000,
  0x3FF623FA951198F8, 0xBFDDFDD91AB7E000,
  0x3FF5E75BA4CF026C, 0xBFDCFFAE0CC79000,
  0x3FF5AC055A214FB8, 0xBFDC043811FDA000,
  0x3FF571ED0F166E1E, 0xBFDB0B67323AE000,
  0x3FF53909590BF835, 0xBFDA152F5A2DB000,
  0x3FF5014FED61ADDD, 0xBFD9217F5AF86000,
  0x3FF4CAB88E487BD0, 0xBFD8304DB0719000,
  0x3FF49539B4334FEE, 0xBFD74189F9A9E000,
  0x3FF460CBDFAFD569, 0xBFD6552BB5199000,
  0x3FF42D664EE4B953, 0xBFD56B23A29B1000,
  0x3FF3FB01111DD8A6, 0xBFD483650F5FA000,
  0x3FF3C995B70C5836, 0xBFD39DE937F6A000,
  0x3FF3991C4AB6FD4A, 0xBFD2BAA1538D6000,
  0x3FF3698E0CE099B5, 0xBFD1D98340CA4000,
  0x3FF33AE48213E7B2, 0xBFD0FA853A40E000,
  0x3FF30D191985BDB1, 0xBFD01D9C32E73000,
  0x3FF2E025CAB271D7, 0xBFCE857DA2FA6000,
  0x3FF2B404CF13CD82, 0xBFCCD3C8633D8000,
  0x3FF288B02C7CCB50, 0xBFCB26034C14A000,
  0x3FF25E2263944DE5, 0xBFC97C1C2F4FE000,
  0x3FF234563D8615B1, 0xBFC7D6023F800000,
  0x3FF20B46E33EAF38, 0xBFC633A71A05E000,
  0x3FF1E2EEFDCDA3DD, 0xBFC494F5E9570000,
  0x3FF1BB4A580B3930, 0xBFC2F9E424E0A000,
  0x3FF19453847F2200, 0xBFC162595AFDC000,
  0x3FF16E06C0D5D73C, 0xBFBF9C9A75BD8000,
  0x3FF1485F47B7E4C2, 0xBFBC7B575BF9C000,
  0x3FF12358AD0085D1, 0xBFB960C60FF48000,
  0x3FF0FEF00F532227, 0xBFB64CE247B60000,
  0x3FF0DB2077D03A8F, 0xBFB33F78B2014000,
  0x3FF0B7E6D65980D9, 0xBFB0387D1A42C000,
  0x3FF0953EFE7B408D, 0xBFAA6F9208B50000,
  0x3FF07325CAC53B83, 0xBFA47A954F770000,
  0x3FF05197E40D1B5C, 0xBF9D23A8C50C0000,
  0x3FF03091C1208EA2, 0xBF916A2629780000,
  0x3FF0101025B37E21, 0xBF7720F8D8E80000,
  0x3FEFC07EF9CAA76B, 0x3F86FE53B1500000,
  0x3FEF4465D3F6F184, 0x3FA11CCCE10F8000,
  0x3FEECC079F84107F, 0x3FAC4DFC8C8B8000,
  0x3FEE573A99975AE8, 0x3FB3AA321E574000,
  0x3FEDE5D6F0BD3DE6, 0x3FB918A0D08B8000,
  0x3FED77B681FF38B3, 0x3FBE72E9DA044000,
  0x3FED0CB5724DE943, 0x3FC1DCD2507F6000,
  0x3FECA4B2DC0E7563, 0x3FC476AB03DEA000,
  0x3FEC3F8EE8D6CB51, 0x3FC7074377E22000,
  0x3FEBDD2B4F020C4C, 0x3FC98EDE8BA94000,
  0x3FEB7D6C006015CA, 0x3FCC0DB86AD2E000,
  0x3FEB20366E2E338F, 0x3FCE840AAFCEE000,
  0x3FEAC57026295039, 0x3FD0790AB4678000,
  0x3FEA6D01BC2731DD, 0x3FD1AC056801C000,
  0x3FEA16D3BC3FF18B, 0x3FD2DB11D4FEE000,
  0x3FE9C2D14967FEAD, 0x3FD406464EC58000,
  0x3FE970E4F47C9902, 0x3FD52DBE093AF000,
  0x3FE920FB3982BCF2, 0x3FD651902050D000,
  0x3FE8D30187F759F1, 0x3FD771D2CDEAF000,
  0x3FE886E5EBB9F66D, 0x3FD88E9C857D9000,
  0x3FE83C97B658B994, 0x3FD9A80155E16000,
  0x3FE7F405FFC61022, 0x3FDABE186ED3D000,
  0x3FE7AD22181415CA, 0x3FDBD0F2AEA0E000,
  0x3FE767DCF99EFF8C, 0x3FDCE0A43DBF4000
]);

// @ts-ignore: decorator
@lazy @inline const LOG2_DATA_TAB2 = memory.data<u64>([
  //      chi       ,         clo
  0x3FE6200012B90A8E, 0x3C8904AB0644B605,
  0x3FE66000045734A6, 0x3C61FF9BEA62F7A9,
  0x3FE69FFFC325F2C5, 0x3C827ECFCB3C90BA,
  0x3FE6E00038B95A04, 0x3C88FF8856739326,
  0x3FE71FFFE09994E3, 0x3C8AFD40275F82B1,
  0x3FE7600015590E10, 0xBC72FD75B4238341,
  0x3FE7A00012655BD5, 0x3C7808E67C242B76,
  0x3FE7E0003259E9A6, 0xBC6208E426F622B7,
  0x3FE81FFFEDB4B2D2, 0xBC8402461EA5C92F,
  0x3FE860002DFAFCC3, 0x3C6DF7F4A2F29A1F,
  0x3FE89FFFF78C6B50, 0xBC8E0453094995FD,
  0x3FE8E00039671566, 0xBC8A04F3BEC77B45,
  0x3FE91FFFE2BF1745, 0xBC77FA34400E203C,
  0x3FE95FFFCC5C9FD1, 0xBC76FF8005A0695D,
  0x3FE9A0003BBA4767, 0x3C70F8C4C4EC7E03,
  0x3FE9DFFFE7B92DA5, 0x3C8E7FD9478C4602,
  0x3FEA1FFFD72EFDAF, 0xBC6A0C554DCDAE7E,
  0x3FEA5FFFDE04FF95, 0x3C867DA98CE9B26B,
  0x3FEA9FFFCA5E8D2B, 0xBC8284C9B54C13DE,
  0x3FEADFFFDDAD03EA, 0x3C5812C8EA602E3C,
  0x3FEB1FFFF10D3D4D, 0xBC8EFADDAD27789C,
  0x3FEB5FFFCE21165A, 0x3C53CB1719C61237,
  0x3FEB9FFFD950E674, 0x3C73F7D94194CE00,
  0x3FEBE000139CA8AF, 0x3C750AC4215D9BC0,
  0x3FEC20005B46DF99, 0x3C6BEEA653E9C1C9,
  0x3FEC600040B9F7AE, 0xBC7C079F274A70D6,
  0x3FECA0006255FD8A, 0xBC7A0B4076E84C1F,
  0x3FECDFFFD94C095D, 0x3C88F933F99AB5D7,
  0x3FED1FFFF975D6CF, 0xBC582C08665FE1BE,
  0x3FED5FFFA2561C93, 0xBC7B04289BD295F3,
  0x3FED9FFF9D228B0C, 0x3C870251340FA236,
  0x3FEDE00065BC7E16, 0xBC75011E16A4D80C,
  0x3FEE200002F64791, 0x3C89802F09EF62E0,
  0x3FEE600057D7A6D8, 0xBC7E0B75580CF7FA,
  0x3FEEA00027EDC00C, 0xBC8C848309459811,
  0x3FEEE0006CF5CB7C, 0xBC8F8027951576F4,
  0x3FEF2000782B7DCC, 0xBC8F81D97274538F,
  0x3FEF6000260C450A, 0xBC4071002727FFDC,
  0x3FEF9FFFE88CD533, 0xBC581BDCE1FDA8B0,
  0x3FEFDFFFD50F8689, 0x3C87F91ACB918E6E,
  0x3FF0200004292367, 0x3C9B7FF365324681,
  0x3FF05FFFE3E3D668, 0x3C86FA08DDAE957B,
  0x3FF0A0000A85A757, 0xBC57E2DE80D3FB91,
  0x3FF0E0001A5F3FCC, 0xBC91823305C5F014,
  0x3FF11FFFF8AFBAF5, 0xBC8BFABB6680BAC2,
  0x3FF15FFFE54D91AD, 0xBC9D7F121737E7EF,
  0x3FF1A00011AC36E1, 0x3C9C000A0516F5FF,
  0x3FF1E00019C84248, 0xBC9082FBE4DA5DA0,
  0x3FF220000FFE5E6E, 0xBC88FDD04C9CFB43,
  0x3FF26000269FD891, 0x3C8CFE2A7994D182,
  0x3FF2A00029A6E6DA, 0xBC700273715E8BC5,
  0x3FF2DFFFE0293E39, 0x3C9B7C39DAB2A6F9,
  0x3FF31FFFF7DCF082, 0x3C7DF1336EDC5254,
  0x3FF35FFFF05A8B60, 0xBC9E03564CCD31EB,
  0x3FF3A0002E0EAECC, 0x3C75F0E74BD3A477,
  0x3FF3E000043BB236, 0x3C9C7DCB149D8833,
  0x3FF4200002D187FF, 0x3C7E08AFCF2D3D28,
  0x3FF460000D387CB1, 0x3C820837856599A6,
  0x3FF4A00004569F89, 0xBC89FA5C904FBCD2,
  0x3FF4E000043543F3, 0xBC781125ED175329,
  0x3FF51FFFCC027F0F, 0x3C9883D8847754DC,
  0x3FF55FFFFD87B36F, 0xBC8709E731D02807,
  0x3FF59FFFF21DF7BA, 0x3C87F79F68727B02,
  0x3FF5DFFFEBFC3481, 0xBC9180902E30E93E
]);

// @ts-ignore: decorator
@inline
export function log2_lut(x: f64): f64 {
  const N_MASK = (1 << LOG2_TABLE_BITS) - 1;

  const
    LO: u64 = 0x3FEEA4AF00000000, // reinterpret<u64>(1.0 - 0x1.5b51p-5)
    HI: u64 = 0x3FF0B55900000000; // reinterpret<u64>(1.0 + 0x1.6ab2p-5)

  const
    InvLn2hi = reinterpret<f64>(0x3FF7154765200000), // 0x1.7154765200000p+0
    InvLn2lo = reinterpret<f64>(0x3DE705FC2EEFA200), // 0x1.705fc2eefa200p-33
    Ox1p52   = reinterpret<f64>(0x4330000000000000); // 0x1p52

  const
    B0 = reinterpret<f64>(0xBFE71547652B82FE), // -0x1.71547652b82fep-1
    B1 = reinterpret<f64>(0x3FDEC709DC3A03F7), //  0x1.ec709dc3a03f7p-2
    B2 = reinterpret<f64>(0xBFD71547652B7C3F), // -0x1.71547652b7c3fp-2
    B3 = reinterpret<f64>(0x3FD2776C50F05BE4), //  0x1.2776c50f05be4p-2
    B4 = reinterpret<f64>(0xBFCEC709DD768FE5), // -0x1.ec709dd768fe5p-3
    B5 = reinterpret<f64>(0x3FCA61761EC4E736), //  0x1.a61761ec4e736p-3
    B6 = reinterpret<f64>(0xBFC7153FBC64A79B), // -0x1.7153fbc64a79bp-3
    B7 = reinterpret<f64>(0x3FC484D154F01B4A), //  0x1.484d154f01b4ap-3
    B8 = reinterpret<f64>(0xBFC289E4A72C383C), // -0x1.289e4a72c383cp-3
    B9 = reinterpret<f64>(0x3FC0B32F285AEE66); //  0x1.0b32f285aee66p-3

  const
    A0 = reinterpret<f64>(0xBFE71547652B8339), // -0x1.71547652b8339p-1
    A1 = reinterpret<f64>(0x3FDEC709DC3A04BE), //  0x1.ec709dc3a04bep-2
    A2 = reinterpret<f64>(0xBFD7154764702FFB), // -0x1.7154764702ffbp-2
    A3 = reinterpret<f64>(0x3FD2776C50034C48), //  0x1.2776c50034c48p-2
    A4 = reinterpret<f64>(0xBFCEC7B328EA92BC), // -0x1.ec7b328ea92bcp-3
    A5 = reinterpret<f64>(0x3FCA6225E117F92E); //  0x1.a6225e117f92ep-3

  let ix = reinterpret<u64>(x);
  if (ix - LO < HI - LO) {
    let r = x - 1.0;
    // #if __FP_FAST_FMA
    //     hi = r * InvLn2hi;
    //     lo = r * InvLn2lo + __builtin_fma(r, InvLn2hi, -hi);
    // #else
    let rhi = reinterpret<f64>(reinterpret<u64>(r) & 0xFFFFFFFF00000000);
    let rlo = r - rhi;
    let hi  = rhi * InvLn2hi;
    let lo  = rlo * InvLn2hi + r * InvLn2lo;
    // #endif
    let r2 = r * r; // rounding error: 0x1p-62
    let r4 = r2 * r2;
    // Worst-case error is less than 0.54 ULP (0.55 ULP without fma)
    let p = r2 * (B0 + r * B1);
    let y = hi + p;
    lo += hi - y + p;
    lo += r4 * (B2 + r * B3 + r2 * (B4 + r * B5) +
          r4 * (B6 + r * B7 + r2 * (B8 + r * B9)));
    return y + lo;
  }
  let top = u32(ix >> 48);
  if (top - 0x0010 >= 0x7ff0 - 0x0010) {
    // x < 0x1p-1022 or inf or nan.
    if ((ix << 1) == 0) return -1.0 / (x * x);
    if (ix == 0x7FF0000000000000) return x; // log(inf) == inf
    if ((top & 0x8000) || (top & 0x7FF0) == 0x7FF0) return (x - x) / (x - x);
    // x is subnormal, normalize it.
    ix = reinterpret<u64>(x * Ox1p52);
    ix -= u64(52) << 52;
  }

  // x = 2^k z; where z is in range [OFF,2*OFF) and exact.
  // The range is split into N subintervals.
  // The ith subinterval contains z and c is near its center.
  let tmp  = ix - 0x3FE6000000000000;
  let i    = <usize>((tmp >> (52 - LOG2_TABLE_BITS)) & N_MASK);
  let k    = <i64>tmp >> 52;
  let iz   = ix - (tmp & 0xFFF0000000000000);

  let invc = load<f64>(LOG2_DATA_TAB1  + (i << (1 + alignof<f64>())), 0 << alignof<f64>()); // T[i].invc;
  let logc = load<f64>(LOG2_DATA_TAB1  + (i << (1 + alignof<f64>())), 1 << alignof<f64>()); // T[i].logc;
  let z    = reinterpret<f64>(iz);
  let kd   = <f64>k;

  // log2(x) = log2(z/c) + log2(c) + k.
  // r ~= z/c - 1, |r| < 1/(2*N).
  // #if __FP_FAST_FMA
  // 	// rounding error: 0x1p-55/N.
  // 	r = __builtin_fma(z, invc, -1.0);
  // 	t1 = r * InvLn2hi;
  // 	t2 = r * InvLn2lo + __builtin_fma(r, InvLn2hi, -t1);
  // #else
  // rounding error: 0x1p-55/N + 0x1p-65.
  let chi = load<f64>(LOG2_DATA_TAB2 + (i << (1 + alignof<f64>())), 0 << alignof<f64>()); // T[i].chi;
  let clo = load<f64>(LOG2_DATA_TAB2 + (i << (1 + alignof<f64>())), 1 << alignof<f64>()); // T[i].clo;

  let r   = (z - chi - clo) * invc;
  let rhi = reinterpret<f64>(reinterpret<u64>(r) & 0xFFFFFFFF00000000);
  let rlo = r - rhi;
  let t1  = rhi * InvLn2hi;
  let t2  = rlo * InvLn2hi + r * InvLn2lo;
  // #endif

  // hi + lo = r/ln2 + log2(c) + k
  let t3 = kd + logc;
  let hi = t3 + t1;
  let lo = t3 - hi + t1 + t2;

  // log2(r+1) = r/ln2 + r^2*poly(r)
  // Evaluation is optimized assuming superscalar pipelined execution
  let r2 = r * r; // rounding error: 0x1p-54/N^2
  // Worst-case error if |y| > 0x1p-4: 0.547 ULP (0.550 ULP without fma).
  // ~ 0.5 + 2/N/ln2 + abs-poly-error*0x1p56 ULP (+ 0.003 ULP without fma).
  let p = A0 + r * A1 + r2 * (A2 + r * A3) + (r2 * r2) * (A4 + r * A5);
  return lo + r2 * p + hi;
}

//
// Lookup data for log. See: https://git.musl-libc.org/cgit/musl/tree/src/math/log.c
//

// @ts-ignore: decorator
@inline const LOG_TABLE_BITS = 7;

/* Algorithm:

  x = 2^k z
  log(x) = k ln2 + log(c) + log(z/c)
  log(z/c) = poly(z/c - 1)

where z is in [1.6p-1; 1.6p0] which is split into N subintervals and z falls
into the ith one, then table entries are computed as

  tab[i].invc = 1/c
  tab[i].logc = (double)log(c)
  tab2[i].chi = (double)c
  tab2[i].clo = (double)(c - (double)c)

where c is near the center of the subinterval and is chosen by trying +-2^29
floating point invc candidates around 1/center and selecting one for which

  1) the rounding error in 0x1.8p9 + logc is 0,
  2) the rounding error in z - chi - clo is < 0x1p-66 and
  3) the rounding error in (double)log(c) is minimized (< 0x1p-66).

Note: 1) ensures that k*ln2hi + logc can be computed without rounding error,
2) ensures that z/c - 1 can be computed as (z - chi - clo)*invc with close to
a single rounding error when there is no fast fma for z*invc - 1, 3) ensures
that logc + poly(z/c - 1) has small error, however near x == 1 when
|log(x)| < 0x1p-4, this is not enough so that is special cased.*/

// @ts-ignore: decorator
@lazy @inline const LOG_DATA_TAB1 = memory.data<u64>([
  //      invc      ,        logc
  0x3FF734F0C3E0DE9F, 0xBFD7CC7F79E69000,
  0x3FF713786A2CE91F, 0xBFD76FEEC20D0000,
  0x3FF6F26008FAB5A0, 0xBFD713E31351E000,
  0x3FF6D1A61F138C7D, 0xBFD6B85B38287800,
  0x3FF6B1490BC5B4D1, 0xBFD65D5590807800,
  0x3FF69147332F0CBA, 0xBFD602D076180000,
  0x3FF6719F18224223, 0xBFD5A8CA86909000,
  0x3FF6524F99A51ED9, 0xBFD54F4356035000,
  0x3FF63356AA8F24C4, 0xBFD4F637C36B4000,
  0x3FF614B36B9DDC14, 0xBFD49DA7FDA85000,
  0x3FF5F66452C65C4C, 0xBFD445923989A800,
  0x3FF5D867B5912C4F, 0xBFD3EDF439B0B800,
  0x3FF5BABCCB5B90DE, 0xBFD396CE448F7000,
  0x3FF59D61F2D91A78, 0xBFD3401E17BDA000,
  0x3FF5805612465687, 0xBFD2E9E2EF468000,
  0x3FF56397CEE76BD3, 0xBFD2941B3830E000,
  0x3FF54725E2A77F93, 0xBFD23EC58CDA8800,
  0x3FF52AFF42064583, 0xBFD1E9E129279000,
  0x3FF50F22DBB2BDDF, 0xBFD1956D2B48F800,
  0x3FF4F38F4734DED7, 0xBFD141679AB9F800,
  0x3FF4D843CFDE2840, 0xBFD0EDD094EF9800,
  0x3FF4BD3EC078A3C8, 0xBFD09AA518DB1000,
  0x3FF4A27FC3E0258A, 0xBFD047E65263B800,
  0x3FF4880524D48434, 0xBFCFEB224586F000,
  0x3FF46DCE1B192D0B, 0xBFCF474A7517B000,
  0x3FF453D9D3391854, 0xBFCEA4443D103000,
  0x3FF43A2744B4845A, 0xBFCE020D44E9B000,
  0x3FF420B54115F8FB, 0xBFCD60A22977F000,
  0x3FF40782DA3EF4B1, 0xBFCCC00104959000,
  0x3FF3EE8F5D57FE8F, 0xBFCC202956891000,
  0x3FF3D5D9A00B4CE9, 0xBFCB81178D811000,
  0x3FF3BD60C010C12B, 0xBFCAE2C9CCD3D000,
  0x3FF3A5242B75DAB8, 0xBFCA45402E129000,
  0x3FF38D22CD9FD002, 0xBFC9A877681DF000,
  0x3FF3755BC5847A1C, 0xBFC90C6D69483000,
  0x3FF35DCE49AD36E2, 0xBFC87120A645C000,
  0x3FF34679984DD440, 0xBFC7D68FB4143000,
  0x3FF32F5CCEFFCB24, 0xBFC73CB83C627000,
  0x3FF3187775A10D49, 0xBFC6A39A9B376000,
  0x3FF301C8373E3990, 0xBFC60B3154B7A000,
  0x3FF2EB4EBB95F841, 0xBFC5737D76243000,
  0x3FF2D50A0219A9D1, 0xBFC4DC7B8FC23000,
  0x3FF2BEF9A8B7FD2A, 0xBFC4462C51D20000,
  0x3FF2A91C7A0C1BAB, 0xBFC3B08ABC830000,
  0x3FF293726014B530, 0xBFC31B996B490000,
  0x3FF27DFA5757A1F5, 0xBFC2875490A44000,
  0x3FF268B39B1D3BBF, 0xBFC1F3B9F879A000,
  0x3FF2539D838FF5BD, 0xBFC160C8252CA000,
  0x3FF23EB7AAC9083B, 0xBFC0CE7F57F72000,
  0x3FF22A012BA940B6, 0xBFC03CDC49FEA000,
  0x3FF2157996CC4132, 0xBFBF57BDBC4B8000,
  0x3FF201201DD2FC9B, 0xBFBE370896404000,
  0x3FF1ECF4494D480B, 0xBFBD17983EF94000,
  0x3FF1D8F5528F6569, 0xBFBBF9674ED8A000,
  0x3FF1C52311577E7C, 0xBFBADC79202F6000,
  0x3FF1B17C74CB26E9, 0xBFB9C0C3E7288000,
  0x3FF19E010C2C1AB6, 0xBFB8A646B372C000,
  0x3FF18AB07BB670BD, 0xBFB78D01B3AC0000,
  0x3FF1778A25EFBCB6, 0xBFB674F145380000,
  0x3FF1648D354C31DA, 0xBFB55E0E6D878000,
  0x3FF151B990275FDD, 0xBFB4485CDEA1E000,
  0x3FF13F0EA432D24C, 0xBFB333D94D6AA000,
  0x3FF12C8B7210F9DA, 0xBFB22079F8C56000,
  0x3FF11A3028ECB531, 0xBFB10E4698622000,
  0x3FF107FBDA8434AF, 0xBFAFFA6C6AD20000,
  0x3FF0F5EE0F4E6BB3, 0xBFADDA8D4A774000,
  0x3FF0E4065D2A9FCE, 0xBFABBCECE4850000,
  0x3FF0D244632CA521, 0xBFA9A1894012C000,
  0x3FF0C0A77CE2981A, 0xBFA788583302C000,
  0x3FF0AF2F83C636D1, 0xBFA5715E67D68000,
  0x3FF09DDB98A01339, 0xBFA35C8A49658000,
  0x3FF08CABAF52E7DF, 0xBFA149E364154000,
  0x3FF07B9F2F4E28FB, 0xBF9E72C082EB8000,
  0x3FF06AB58C358F19, 0xBF9A55F152528000,
  0x3FF059EEA5ECF92C, 0xBF963D62CF818000,
  0x3FF04949CDD12C90, 0xBF9228FB8CAA0000,
  0x3FF038C6C6F0ADA9, 0xBF8C317B20F90000,
  0x3FF02865137932A9, 0xBF8419355DAA0000,
  0x3FF0182427EA7348, 0xBF781203C2EC0000,
  0x3FF008040614B195, 0xBF60040979240000,
  0x3FEFE01FF726FA1A, 0x3F6FEFF384900000,
  0x3FEFA11CC261EA74, 0x3F87DC41353D0000,
  0x3FEF6310B081992E, 0x3F93CEA3C4C28000,
  0x3FEF25F63CEEADCD, 0x3F9B9FC114890000,
  0x3FEEE9C8039113E7, 0x3FA1B0D8CE110000,
  0x3FEEAE8078CBB1AB, 0x3FA58A5BD001C000,
  0x3FEE741AA29D0C9B, 0x3FA95C8340D88000,
  0x3FEE3A91830A99B5, 0x3FAD276AEF578000,
  0x3FEE01E009609A56, 0x3FB07598E598C000,
  0x3FEDCA01E577BB98, 0x3FB253F5E30D2000,
  0x3FED92F20B7C9103, 0x3FB42EDD8B380000,
  0x3FED5CAC66FB5CCE, 0x3FB606598757C000,
  0x3FED272CAA5EDE9D, 0x3FB7DA76356A0000,
  0x3FECF26E3E6B2CCD, 0x3FB9AB434E1C6000,
  0x3FECBE6DA2A77902, 0x3FBB78C7BB0D6000,
  0x3FEC8B266D37086D, 0x3FBD431332E72000,
  0x3FEC5894BD5D5804, 0x3FBF0A3171DE6000,
  0x3FEC26B533BB9F8C, 0x3FC067152B914000,
  0x3FEBF583EEECE73F, 0x3FC147858292B000,
  0x3FEBC4FD75DB96C1, 0x3FC2266ECDCA3000,
  0x3FEB951E0C864A28, 0x3FC303D7A6C55000,
  0x3FEB65E2C5EF3E2C, 0x3FC3DFC33C331000,
  0x3FEB374867C9888B, 0x3FC4BA366B7A8000,
  0x3FEB094B211D304A, 0x3FC5933928D1F000,
  0x3FEADBE885F2EF7E, 0x3FC66ACD2418F000,
  0x3FEAAF1D31603DA2, 0x3FC740F8EC669000,
  0x3FEA82E63FD358A7, 0x3FC815C0F51AF000,
  0x3FEA5740EF09738B, 0x3FC8E92954F68000,
  0x3FEA2C2A90AB4B27, 0x3FC9BB3602F84000,
  0x3FEA01A01393F2D1, 0x3FCA8BED1C2C0000,
  0x3FE9D79F24DB3C1B, 0x3FCB5B515C01D000,
  0x3FE9AE2505C7B190, 0x3FCC2967CCBCC000,
  0x3FE9852EF297CE2F, 0x3FCCF635D5486000,
  0x3FE95CBAEEA44B75, 0x3FCDC1BD3446C000,
  0x3FE934C69DE74838, 0x3FCE8C01B8CFE000,
  0x3FE90D4F2F6752E6, 0x3FCF5509C0179000,
  0x3FE8E6528EFFD79D, 0x3FD00E6C121FB800,
  0x3FE8BFCE9FCC007C, 0x3FD071B80E93D000,
  0x3FE899C0DABEC30E, 0x3FD0D46B9E867000,
  0x3FE87427AA2317FB, 0x3FD13687334BD000,
  0x3FE84F00ACB39A08, 0x3FD1980D67234800,
  0x3FE82A49E8653E55, 0x3FD1F8FFE0CC8000,
  0x3FE8060195F40260, 0x3FD2595FD7636800,
  0x3FE7E22563E0A329, 0x3FD2B9300914A800,
  0x3FE7BEB377DCB5AD, 0x3FD3187210436000,
  0x3FE79BAA679725C2, 0x3FD377266DEC1800,
  0x3FE77907F2170657, 0x3FD3D54FFBAF3000,
  0x3FE756CADBD6130C, 0x3FD432EEE32FE000
]);

// @ts-ignore: decorator
@lazy @inline const LOG_DATA_TAB2 = memory.data<u64>([
  //      chi       ,         clo
  0x3FE61000014FB66B, 0x3C7E026C91425B3C,
  0x3FE63000034DB495, 0x3C8DBFEA48005D41,
  0x3FE650000D94D478, 0x3C8E7FA786D6A5B7,
  0x3FE67000074E6FAD, 0x3C61FCEA6B54254C,
  0x3FE68FFFFEDF0FAE, 0xBC7C7E274C590EFD,
  0x3FE6B0000763C5BC, 0xBC8AC16848DCDA01,
  0x3FE6D0001E5CC1F6, 0x3C833F1C9D499311,
  0x3FE6EFFFEB05F63E, 0xBC7E80041AE22D53,
  0x3FE710000E869780, 0x3C7BFF6671097952,
  0x3FE72FFFFC67E912, 0x3C8C00E226BD8724,
  0x3FE74FFFDF81116A, 0xBC6E02916EF101D2,
  0x3FE770000F679C90, 0xBC67FC71CD549C74,
  0x3FE78FFFFA7EC835, 0x3C81BEC19EF50483,
  0x3FE7AFFFFE20C2E6, 0xBC707E1729CC6465,
  0x3FE7CFFFED3FC900, 0xBC808072087B8B1C,
  0x3FE7EFFFE9261A76, 0x3C8DC0286D9DF9AE,
  0x3FE81000049CA3E8, 0x3C897FD251E54C33,
  0x3FE8300017932C8F, 0xBC8AFEE9B630F381,
  0x3FE850000633739C, 0x3C89BFBF6B6535BC,
  0x3FE87000204289C6, 0xBC8BBF65F3117B75,
  0x3FE88FFFEBF57904, 0xBC89006EA23DCB57,
  0x3FE8B00022BC04DF, 0xBC7D00DF38E04B0A,
  0x3FE8CFFFE50C1B8A, 0xBC88007146FF9F05,
  0x3FE8EFFFFC918E43, 0x3C83817BD07A7038,
  0x3FE910001EFA5FC7, 0x3C893E9176DFB403,
  0x3FE9300013467BB9, 0x3C7F804E4B980276,
  0x3FE94FFFE6EE076F, 0xBC8F7EF0D9FF622E,
  0x3FE96FFFDE3C12D1, 0xBC7082AA962638BA,
  0x3FE98FFFF4458A0D, 0xBC87801B9164A8EF,
  0x3FE9AFFFDD982E3E, 0xBC8740E08A5A9337,
  0x3FE9CFFFED49FB66, 0x3C3FCE08C19BE000,
  0x3FE9F00020F19C51, 0xBC8A3FAA27885B0A,
  0x3FEA10001145B006, 0x3C74FF489958DA56,
  0x3FEA300007BBF6FA, 0x3C8CBEAB8A2B6D18,
  0x3FEA500010971D79, 0x3C88FECADD787930,
  0x3FEA70001DF52E48, 0xBC8F41763DD8ABDB,
  0x3FEA90001C593352, 0xBC8EBF0284C27612,
  0x3FEAB0002A4F3E4B, 0xBC69FD043CFF3F5F,
  0x3FEACFFFD7AE1ED1, 0xBC823EE7129070B4,
  0x3FEAEFFFEE510478, 0x3C6A063EE00EDEA3,
  0x3FEB0FFFDB650D5B, 0x3C5A06C8381F0AB9,
  0x3FEB2FFFFEAACA57, 0xBC79011E74233C1D,
  0x3FEB4FFFD995BADC, 0xBC79FF1068862A9F,
  0x3FEB7000249E659C, 0x3C8AFF45D0864F3E,
  0x3FEB8FFFF9871640, 0x3C7CFE7796C2C3F9,
  0x3FEBAFFFD204CB4F, 0xBC63FF27EEF22BC4,
  0x3FEBCFFFD2415C45, 0xBC6CFFB7EE3BEA21,
  0x3FEBEFFFF86309DF, 0xBC814103972E0B5C,
  0x3FEC0FFFE1B57653, 0x3C8BC16494B76A19,
  0x3FEC2FFFF1FA57E3, 0xBC64FEEF8D30C6ED,
  0x3FEC4FFFDCBFE424, 0xBC843F68BCEC4775,
  0x3FEC6FFFED54B9F7, 0x3C847EA3F053E0EC,
  0x3FEC8FFFEB998FD5, 0x3C7383068DF992F1,
  0x3FECB0002125219A, 0xBC68FD8E64180E04,
  0x3FECCFFFDD94469C, 0x3C8E7EBE1CC7EA72,
  0x3FECEFFFEAFDC476, 0x3C8EBE39AD9F88FE,
  0x3FED1000169AF82B, 0x3C757D91A8B95A71,
  0x3FED30000D0FF71D, 0x3C89C1906970C7DA,
  0x3FED4FFFEA790FC4, 0xBC580E37C558FE0C,
  0x3FED70002EDC87E5, 0xBC7F80D64DC10F44,
  0x3FED900021DC82AA, 0xBC747C8F94FD5C5C,
  0x3FEDAFFFD86B0283, 0x3C8C7F1DC521617E,
  0x3FEDD000296C4739, 0x3C88019EB2FFB153,
  0x3FEDEFFFE54490F5, 0x3C6E00D2C652CC89,
  0x3FEE0FFFCDABF694, 0xBC7F8340202D69D2,
  0x3FEE2FFFDB52C8DD, 0x3C7B00C1CA1B0864,
  0x3FEE4FFFF24216EF, 0x3C72FFA8B094AB51,
  0x3FEE6FFFE88A5E11, 0xBC57F673B1EFBE59,
  0x3FEE9000119EFF0D, 0xBC84808D5E0BC801,
  0x3FEEAFFFDFA51744, 0x3C780006D54320B5,
  0x3FEED0001A127FA1, 0xBC5002F860565C92,
  0x3FEEF00007BABCC4, 0xBC8540445D35E611,
  0x3FEF0FFFF57A8D02, 0xBC4FFB3139EF9105,
  0x3FEF30001EE58AC7, 0x3C8A81ACF2731155,
  0x3FEF4FFFF5823494, 0x3C8A3F41D4D7C743,
  0x3FEF6FFFFCA94C6B, 0xBC6202F41C987875,
  0x3FEF8FFFE1F9C441, 0x3C777DD1F477E74B,
  0x3FEFAFFFD2E0E37E, 0xBC6F01199A7CA331,
  0x3FEFD0001C77E49E, 0x3C7181EE4BCEACB1,
  0x3FEFEFFFF7E0C331, 0xBC6E05370170875A,
  0x3FF00FFFF465606E, 0xBC8A7EAD491C0ADA,
  0x3FF02FFFF3867A58, 0xBC977F69C3FCB2E0,
  0x3FF04FFFFDFC0D17, 0x3C97BFFE34CB945B,
  0x3FF0700003CD4D82, 0x3C820083C0E456CB,
  0x3FF08FFFF9F2CBE8, 0xBC6DFFDFBE37751A,
  0x3FF0B000010CDA65, 0xBC913F7FAEE626EB,
  0x3FF0D00001A4D338, 0x3C807DFA79489FF7,
  0x3FF0EFFFFADAFDFD, 0xBC77040570D66BC0,
  0x3FF110000BBAFD96, 0x3C8E80D4846D0B62,
  0x3FF12FFFFAE5F45D, 0x3C9DBFFA64FD36EF,
  0x3FF150000DD59AD9, 0x3C9A0077701250AE,
  0x3FF170000F21559A, 0x3C8DFDF9E2E3DEEE,
  0x3FF18FFFFC275426, 0x3C910030DC3B7273,
  0x3FF1B000123D3C59, 0x3C997F7980030188,
  0x3FF1CFFFF8299EB7, 0xBC65F932AB9F8C67,
  0x3FF1EFFFF48AD400, 0x3C937FBF9DA75BEB,
  0x3FF210000C8B86A4, 0x3C9F806B91FD5B22,
  0x3FF2300003854303, 0x3C93FFC2EB9FBF33,
  0x3FF24FFFFFBCF684, 0x3C7601E77E2E2E72,
  0x3FF26FFFF52921D9, 0x3C7FFCBB767F0C61,
  0x3FF2900014933A3C, 0xBC7202CA3C02412B,
  0x3FF2B00014556313, 0xBC92808233F21F02,
  0x3FF2CFFFEBFE523B, 0xBC88FF7E384FDCF2,
  0x3FF2F0000BB8AD96, 0xBC85FF51503041C5,
  0x3FF30FFFFB7AE2AF, 0xBC810071885E289D,
  0x3FF32FFFFEAC5F7F, 0xBC91FF5D3FB7B715,
  0x3FF350000CA66756, 0x3C957F82228B82BD,
  0x3FF3700011FBF721, 0x3C8000BAC40DD5CC,
  0x3FF38FFFF9592FB9, 0xBC943F9D2DB2A751,
  0x3FF3B00004DDD242, 0x3C857F6B707638E1,
  0x3FF3CFFFF5B2C957, 0x3C7A023A10BF1231,
  0x3FF3EFFFEAB0B418, 0x3C987F6D66B152B0,
  0x3FF410001532AFF4, 0x3C67F8375F198524,
  0x3FF4300017478B29, 0x3C8301E672DC5143,
  0x3FF44FFFE795B463, 0x3C89FF69B8B2895A,
  0x3FF46FFFE80475E0, 0xBC95C0B19BC2F254,
  0x3FF48FFFEF6FC1E7, 0x3C9B4009F23A2A72,
  0x3FF4AFFFE5BEA704, 0xBC94FFB7BF0D7D45,
  0x3FF4D000171027DE, 0xBC99C06471DC6A3D,
  0x3FF4F0000FF03EE2, 0x3C977F890B85531C,
  0x3FF5100012DC4BD1, 0x3C6004657166A436,
  0x3FF530001605277A, 0xBC96BFCECE233209,
  0x3FF54FFFECDB704C, 0xBC8902720505A1D7,
  0x3FF56FFFEF5F54A9, 0x3C9BBFE60EC96412,
  0x3FF5900017E61012, 0x3C887EC581AFEF90,
  0x3FF5B00003C93E92, 0xBC9F41080ABF0CC0,
  0x3FF5D0001D4919BC, 0xBC98812AFB254729,
  0x3FF5EFFFE7B87A89, 0xBC947EB780ED6904
]);

// @ts-ignore: decorator
@inline
export function log_lut(x: f64): f64 {
  const N_MASK = (1 << LOG_TABLE_BITS) - 1;

  const
    B0  = reinterpret<f64>(0xBFE0000000000000), // -0x1p-1
    B1  = reinterpret<f64>(0x3FD5555555555577), //  0x1.5555555555577p-2
    B2  = reinterpret<f64>(0xBFCFFFFFFFFFFDCB), // -0x1.ffffffffffdcbp-3
    B3  = reinterpret<f64>(0x3FC999999995DD0C), //  0x1.999999995dd0cp-3
    B4  = reinterpret<f64>(0xBFC55555556745A7), // -0x1.55555556745a7p-3
    B5  = reinterpret<f64>(0x3FC24924A344DE30), //  0x1.24924a344de3p-3
    B6  = reinterpret<f64>(0xBFBFFFFFA4423D65), // -0x1.fffffa4423d65p-4
    B7  = reinterpret<f64>(0x3FBC7184282AD6CA), //  0x1.c7184282ad6cap-4
    B8  = reinterpret<f64>(0xBFB999EB43B068FF), // -0x1.999eb43b068ffp-4
    B9  = reinterpret<f64>(0x3FB78182F7AFD085), //  0x1.78182f7afd085p-4
    B10 = reinterpret<f64>(0xBFB5521375D145CD); // -0x1.5521375d145cdp-4

  const
    A0 = reinterpret<f64>(0xBFE0000000000001),  // -0x1.0000000000001p-1
    A1 = reinterpret<f64>(0x3FD555555551305B),  //  0x1.555555551305bp-2
    A2 = reinterpret<f64>(0xBFCFFFFFFFEB4590),  // -0x1.fffffffeb459p-3
    A3 = reinterpret<f64>(0x3FC999B324F10111),  //  0x1.999b324f10111p-3
    A4 = reinterpret<f64>(0xBFC55575E506C89F);  // -0x1.55575e506c89fp-3

  const
    LO: u64 = 0x3FEE000000000000,
    HI: u64 = 0x3FF1090000000000;

  const
    Ln2hi  = reinterpret<f64>(0x3FE62E42FEFA3800), // 0x1.62e42fefa3800p-1
    Ln2lo  = reinterpret<f64>(0x3D2EF35793C76730), // 0x1.ef35793c76730p-45
    Ox1p27 = reinterpret<f64>(0x41A0000000000000), // 0x1p27
    Ox1p52 = reinterpret<f64>(0x4330000000000000); // 0x1p52

  let ix = reinterpret<u64>(x);
  if (ix - LO < HI - LO) {
    let r  = x - 1.0;
    let r2 = r * r;
    let r3 = r2 * r;
    let y =
      r3 * (B1 + r * B2 + r2 * B3 +
      r3 * (B4 + r * B5 + r2 * B6 +
      r3 * (B7 + r * B8 + r2 * B9 + r3 * B10)));
    // Worst-case error is around 0.507 ULP
    let w   = r * Ox1p27;
    let rhi = r + w - w;
    let rlo = r - rhi;
    w = rhi * rhi * B0; // B[0] == -0.5
    let hi = r + w;
    let lo = r - hi + w;
    lo += B0 * rlo * (rhi + r);
    return y + lo + hi;
  }
  let top = u32(ix >> 48);
  if (top - 0x0010 >= 0x7FF0 - 0x0010) {
    // x < 0x1p-1022 or inf or nan
    if ((ix << 1) == 0) return -1.0 / (x * x);
    if (ix == reinterpret<u64>(Infinity)) return x; // log(inf) == inf
    if ((top & 0x8000) || (top & 0x7FF0) == 0x7FF0) return (x - x) / (x - x);
    // x is subnormal, normalize it
    ix = reinterpret<u64>(x * Ox1p52);
    ix -= u64(52) << 52;
  }

  // x = 2^k z; where z is in range [OFF,2*OFF) and exact.
  // The range is split into N subintervals.
  // The ith subinterval contains z and c is near its center.
  let tmp  = ix - 0x3FE6000000000000;
  let i    = <usize>((tmp >> (52 - LOG_TABLE_BITS)) & N_MASK);
  let k    = <i64>tmp >> 52;
  let iz   = ix - (tmp & (u64(0xFFF) << 52));

  let invc = load<f64>(LOG_DATA_TAB1 + (i << (1 + alignof<f64>())), 0 << alignof<f64>()); // T[i].invc;
  let logc = load<f64>(LOG_DATA_TAB1 + (i << (1 + alignof<f64>())), 1 << alignof<f64>()); // T[i].logc;
  let z    = reinterpret<f64>(iz);

  // log(x) = log1p(z/c-1) + log(c) + k*Ln2.
  // r ~= z/c - 1, |r| < 1/(2*N)
  // #if __FP_FAST_FMA
  // 	// rounding error: 0x1p-55/N
  // 	r = __builtin_fma(z, invc, -1.0);
  // #else
  // rounding error: 0x1p-55/N + 0x1p-66
  const chi = load<f64>(LOG_DATA_TAB2 + (i << (1 + alignof<f64>())), 0 << alignof<f64>()); // T2[i].chi
  const clo = load<f64>(LOG_DATA_TAB2 + (i << (1 + alignof<f64>())), 1 << alignof<f64>()); // T2[i].clo
  let r = (z - chi - clo) * invc;
  // #endif
  let kd = <f64>k;

  // hi + lo = r + log(c) + k*Ln2
  let w  = kd * Ln2hi + logc;
  let hi = w + r;
  let lo = w - hi + r + kd * Ln2lo;

  // log(x) = lo + (log1p(r) - r) + hi
  let r2 = r * r; // rounding error: 0x1p-54/N^2
  // Worst case error if |y| > 0x1p-5:
  // 0.5 + 4.13/N + abs-poly-error*2^57 ULP (+ 0.002 ULP without fma)
  // Worst case error if |y| > 0x1p-4:
  // 0.5 + 2.06/N + abs-poly-error*2^56 ULP (+ 0.001 ULP without fma).
  return lo + r2 * A0 + r * r2 * (A1 + r * A2 + r2 * (A3 + r * A4)) + hi;
}

//
// Lookup data for pow. See: https://git.musl-libc.org/cgit/musl/tree/src/math/pow.c
//

// @ts-ignore: decorator
@inline const POW_LOG_TABLE_BITS = 7;

/* Algorithm:

  x = 2^k z
  log(x) = k ln2 + log(c) + log(z/c)
  log(z/c) = poly(z/c - 1)

where z is in [0x1.69555p-1; 0x1.69555p0] which is split into N subintervals
and z falls into the ith one, then table entries are computed as

  tab[i].invc = 1/c
  tab[i].logc = round(0x1p43*log(c))/0x1p43
  tab[i].logctail = (double)(log(c) - logc)

where c is chosen near the center of the subinterval such that 1/c has only a
few precision bits so z/c - 1 is exactly representible as double:

  1/c = center < 1 ? round(N/center)/N : round(2*N/center)/N/2

Note: |z/c - 1| < 1/N for the chosen c, |log(c) - logc - logctail| < 0x1p-97,
the last few bits of logc are rounded away so k*ln2hi + logc has no rounding
error and the interval for z is selected such that near x == 1, where log(x)
is tiny, large cancellation error is avoided in logc + poly(z/c - 1). */

// @ts-ignore: decorator
@lazy @inline const POW_LOG_DATA_TAB = memory.data<u64>([
  //      invc      ,pad,       logc       ,       logctail
  0x3FF6A00000000000, 0, 0xBFD62C82F2B9C800, 0x3CFAB42428375680,
  0x3FF6800000000000, 0, 0xBFD5D1BDBF580800, 0xBD1CA508D8E0F720,
  0x3FF6600000000000, 0, 0xBFD5767717455800, 0xBD2362A4D5B6506D,
  0x3FF6400000000000, 0, 0xBFD51AAD872DF800, 0xBCE684E49EB067D5,
  0x3FF6200000000000, 0, 0xBFD4BE5F95777800, 0xBD041B6993293EE0,
  0x3FF6000000000000, 0, 0xBFD4618BC21C6000, 0x3D13D82F484C84CC,
  0x3FF5E00000000000, 0, 0xBFD404308686A800, 0x3CDC42F3ED820B3A,
  0x3FF5C00000000000, 0, 0xBFD3A64C55694800, 0x3D20B1C686519460,
  0x3FF5A00000000000, 0, 0xBFD347DD9A988000, 0x3D25594DD4C58092,
  0x3FF5800000000000, 0, 0xBFD2E8E2BAE12000, 0x3D267B1E99B72BD8,
  0x3FF5600000000000, 0, 0xBFD2895A13DE8800, 0x3D15CA14B6CFB03F,
  0x3FF5600000000000, 0, 0xBFD2895A13DE8800, 0x3D15CA14B6CFB03F,
  0x3FF5400000000000, 0, 0xBFD22941FBCF7800, 0xBD165A242853DA76,
  0x3FF5200000000000, 0, 0xBFD1C898C1699800, 0xBD1FAFBC68E75404,
  0x3FF5000000000000, 0, 0xBFD1675CABABA800, 0x3D1F1FC63382A8F0,
  0x3FF4E00000000000, 0, 0xBFD1058BF9AE4800, 0xBD26A8C4FD055A66,
  0x3FF4C00000000000, 0, 0xBFD0A324E2739000, 0xBD0C6BEE7EF4030E,
  0x3FF4A00000000000, 0, 0xBFD0402594B4D000, 0xBCF036B89EF42D7F,
  0x3FF4A00000000000, 0, 0xBFD0402594B4D000, 0xBCF036B89EF42D7F,
  0x3FF4800000000000, 0, 0xBFCFB9186D5E4000, 0x3D0D572AAB993C87,
  0x3FF4600000000000, 0, 0xBFCEF0ADCBDC6000, 0x3D2B26B79C86AF24,
  0x3FF4400000000000, 0, 0xBFCE27076E2AF000, 0xBD172F4F543FFF10,
  0x3FF4200000000000, 0, 0xBFCD5C216B4FC000, 0x3D21BA91BBCA681B,
  0x3FF4000000000000, 0, 0xBFCC8FF7C79AA000, 0x3D27794F689F8434,
  0x3FF4000000000000, 0, 0xBFCC8FF7C79AA000, 0x3D27794F689F8434,
  0x3FF3E00000000000, 0, 0xBFCBC286742D9000, 0x3D194EB0318BB78F,
  0x3FF3C00000000000, 0, 0xBFCAF3C94E80C000, 0x3CBA4E633FCD9066,
  0x3FF3A00000000000, 0, 0xBFCA23BC1FE2B000, 0xBD258C64DC46C1EA,
  0x3FF3A00000000000, 0, 0xBFCA23BC1FE2B000, 0xBD258C64DC46C1EA,
  0x3FF3800000000000, 0, 0xBFC9525A9CF45000, 0xBD2AD1D904C1D4E3,
  0x3FF3600000000000, 0, 0xBFC87FA06520D000, 0x3D2BBDBF7FDBFA09,
  0x3FF3400000000000, 0, 0xBFC7AB890210E000, 0x3D2BDB9072534A58,
  0x3FF3400000000000, 0, 0xBFC7AB890210E000, 0x3D2BDB9072534A58,
  0x3FF3200000000000, 0, 0xBFC6D60FE719D000, 0xBD10E46AA3B2E266,
  0x3FF3000000000000, 0, 0xBFC5FF3070A79000, 0xBD1E9E439F105039,
  0x3FF3000000000000, 0, 0xBFC5FF3070A79000, 0xBD1E9E439F105039,
  0x3FF2E00000000000, 0, 0xBFC526E5E3A1B000, 0xBD20DE8B90075B8F,
  0x3FF2C00000000000, 0, 0xBFC44D2B6CCB8000, 0x3D170CC16135783C,
  0x3FF2C00000000000, 0, 0xBFC44D2B6CCB8000, 0x3D170CC16135783C,
  0x3FF2A00000000000, 0, 0xBFC371FC201E9000, 0x3CF178864D27543A,
  0x3FF2800000000000, 0, 0xBFC29552F81FF000, 0xBD248D301771C408,
  0x3FF2600000000000, 0, 0xBFC1B72AD52F6000, 0xBD2E80A41811A396,
  0x3FF2600000000000, 0, 0xBFC1B72AD52F6000, 0xBD2E80A41811A396,
  0x3FF2400000000000, 0, 0xBFC0D77E7CD09000, 0x3D0A699688E85BF4,
  0x3FF2400000000000, 0, 0xBFC0D77E7CD09000, 0x3D0A699688E85BF4,
  0x3FF2200000000000, 0, 0xBFBFEC9131DBE000, 0xBD2575545CA333F2,
  0x3FF2000000000000, 0, 0xBFBE27076E2B0000, 0x3D2A342C2AF0003C,
  0x3FF2000000000000, 0, 0xBFBE27076E2B0000, 0x3D2A342C2AF0003C,
  0x3FF1E00000000000, 0, 0xBFBC5E548F5BC000, 0xBD1D0C57585FBE06,
  0x3FF1C00000000000, 0, 0xBFBA926D3A4AE000, 0x3D253935E85BAAC8,
  0x3FF1C00000000000, 0, 0xBFBA926D3A4AE000, 0x3D253935E85BAAC8,
  0x3FF1A00000000000, 0, 0xBFB8C345D631A000, 0x3D137C294D2F5668,
  0x3FF1A00000000000, 0, 0xBFB8C345D631A000, 0x3D137C294D2F5668,
  0x3FF1800000000000, 0, 0xBFB6F0D28AE56000, 0xBD269737C93373DA,
  0x3FF1600000000000, 0, 0xBFB51B073F062000, 0x3D1F025B61C65E57,
  0x3FF1600000000000, 0, 0xBFB51B073F062000, 0x3D1F025B61C65E57,
  0x3FF1400000000000, 0, 0xBFB341D7961BE000, 0x3D2C5EDACCF913DF,
  0x3FF1400000000000, 0, 0xBFB341D7961BE000, 0x3D2C5EDACCF913DF,
  0x3FF1200000000000, 0, 0xBFB16536EEA38000, 0x3D147C5E768FA309,
  0x3FF1000000000000, 0, 0xBFAF0A30C0118000, 0x3D2D599E83368E91,
  0x3FF1000000000000, 0, 0xBFAF0A30C0118000, 0x3D2D599E83368E91,
  0x3FF0E00000000000, 0, 0xBFAB42DD71198000, 0x3D1C827AE5D6704C,
  0x3FF0E00000000000, 0, 0xBFAB42DD71198000, 0x3D1C827AE5D6704C,
  0x3FF0C00000000000, 0, 0xBFA77458F632C000, 0xBD2CFC4634F2A1EE,
  0x3FF0C00000000000, 0, 0xBFA77458F632C000, 0xBD2CFC4634F2A1EE,
  0x3FF0A00000000000, 0, 0xBFA39E87B9FEC000, 0x3CF502B7F526FEAA,
  0x3FF0A00000000000, 0, 0xBFA39E87B9FEC000, 0x3CF502B7F526FEAA,
  0x3FF0800000000000, 0, 0xBF9F829B0E780000, 0xBD2980267C7E09E4,
  0x3FF0800000000000, 0, 0xBF9F829B0E780000, 0xBD2980267C7E09E4,
  0x3FF0600000000000, 0, 0xBF97B91B07D58000, 0xBD288D5493FAA639,
  0x3FF0400000000000, 0, 0xBF8FC0A8B0FC0000, 0xBCDF1E7CF6D3A69C,
  0x3FF0400000000000, 0, 0xBF8FC0A8B0FC0000, 0xBCDF1E7CF6D3A69C,
  0x3FF0200000000000, 0, 0xBF7FE02A6B100000, 0xBD19E23F0DDA40E4,
  0x3FF0200000000000, 0, 0xBF7FE02A6B100000, 0xBD19E23F0DDA40E4,
  0x3FF0000000000000, 0, 0, 0,
  0x3FF0000000000000, 0, 0, 0,
  0x3FEFC00000000000, 0, 0x3F80101575890000, 0xBD10C76B999D2BE8,
  0x3FEF800000000000, 0, 0x3F90205658938000, 0xBD23DC5B06E2F7D2,
  0x3FEF400000000000, 0, 0x3F98492528C90000, 0xBD2AA0BA325A0C34,
  0x3FEF000000000000, 0, 0x3FA0415D89E74000, 0x3D0111C05CF1D753,
  0x3FEEC00000000000, 0, 0x3FA466AED42E0000, 0xBD2C167375BDFD28,
  0x3FEE800000000000, 0, 0x3FA894AA149FC000, 0xBD197995D05A267D,
  0x3FEE400000000000, 0, 0x3FACCB73CDDDC000, 0xBD1A68F247D82807,
  0x3FEE200000000000, 0, 0x3FAEEA31C006C000, 0xBD0E113E4FC93B7B,
  0x3FEDE00000000000, 0, 0x3FB1973BD1466000, 0xBD25325D560D9E9B,
  0x3FEDA00000000000, 0, 0x3FB3BDF5A7D1E000, 0x3D2CC85EA5DB4ED7,
  0x3FED600000000000, 0, 0x3FB5E95A4D97A000, 0xBD2C69063C5D1D1E,
  0x3FED400000000000, 0, 0x3FB700D30AEAC000, 0x3CEC1E8DA99DED32,
  0x3FED000000000000, 0, 0x3FB9335E5D594000, 0x3D23115C3ABD47DA,
  0x3FECC00000000000, 0, 0x3FBB6AC88DAD6000, 0xBD1390802BF768E5,
  0x3FECA00000000000, 0, 0x3FBC885801BC4000, 0x3D2646D1C65AACD3,
  0x3FEC600000000000, 0, 0x3FBEC739830A2000, 0xBD2DC068AFE645E0,
  0x3FEC400000000000, 0, 0x3FBFE89139DBE000, 0xBD2534D64FA10AFD,
  0x3FEC000000000000, 0, 0x3FC1178E8227E000, 0x3D21EF78CE2D07F2,
  0x3FEBE00000000000, 0, 0x3FC1AA2B7E23F000, 0x3D2CA78E44389934,
  0x3FEBA00000000000, 0, 0x3FC2D1610C868000, 0x3D039D6CCB81B4A1,
  0x3FEB800000000000, 0, 0x3FC365FCB0159000, 0x3CC62FA8234B7289,
  0x3FEB400000000000, 0, 0x3FC4913D8333B000, 0x3D25837954FDB678,
  0x3FEB200000000000, 0, 0x3FC527E5E4A1B000, 0x3D2633E8E5697DC7,
  0x3FEAE00000000000, 0, 0x3FC6574EBE8C1000, 0x3D19CF8B2C3C2E78,
  0x3FEAC00000000000, 0, 0x3FC6F0128B757000, 0xBD25118DE59C21E1,
  0x3FEAA00000000000, 0, 0x3FC7898D85445000, 0xBD1C661070914305,
  0x3FEA600000000000, 0, 0x3FC8BEAFEB390000, 0xBD073D54AAE92CD1,
  0x3FEA400000000000, 0, 0x3FC95A5ADCF70000, 0x3D07F22858A0FF6F,
  0x3FEA000000000000, 0, 0x3FCA93ED3C8AE000, 0xBD28724350562169,
  0x3FE9E00000000000, 0, 0x3FCB31D8575BD000, 0xBD0C358D4EACE1AA,
  0x3FE9C00000000000, 0, 0x3FCBD087383BE000, 0xBD2D4BC4595412B6,
  0x3FE9A00000000000, 0, 0x3FCC6FFBC6F01000, 0xBCF1EC72C5962BD2,
  0x3FE9600000000000, 0, 0x3FCDB13DB0D49000, 0xBD2AFF2AF715B035,
  0x3FE9400000000000, 0, 0x3FCE530EFFE71000, 0x3CC212276041F430,
  0x3FE9200000000000, 0, 0x3FCEF5ADE4DD0000, 0xBCCA211565BB8E11,
  0x3FE9000000000000, 0, 0x3FCF991C6CB3B000, 0x3D1BCBECCA0CDF30,
  0x3FE8C00000000000, 0, 0x3FD07138604D5800, 0x3CF89CDB16ED4E91,
  0x3FE8A00000000000, 0, 0x3FD0C42D67616000, 0x3D27188B163CEAE9,
  0x3FE8800000000000, 0, 0x3FD1178E8227E800, 0xBD2C210E63A5F01C,
  0x3FE8600000000000, 0, 0x3FD16B5CCBACF800, 0x3D2B9ACDF7A51681,
  0x3FE8400000000000, 0, 0x3FD1BF99635A6800, 0x3D2CA6ED5147BDB7,
  0x3FE8200000000000, 0, 0x3FD214456D0EB800, 0x3D0A87DEBA46BAEA,
  0x3FE7E00000000000, 0, 0x3FD2BEF07CDC9000, 0x3D2A9CFA4A5004F4,
  0x3FE7C00000000000, 0, 0x3FD314F1E1D36000, 0xBD28E27AD3213CB8,
  0x3FE7A00000000000, 0, 0x3FD36B6776BE1000, 0x3D116ECDB0F177C8,
  0x3FE7800000000000, 0, 0x3FD3C25277333000, 0x3D183B54B606BD5C,
  0x3FE7600000000000, 0, 0x3FD419B423D5E800, 0x3D08E436EC90E09D,
  0x3FE7400000000000, 0, 0x3FD4718DC271C800, 0xBD2F27CE0967D675,
  0x3FE7200000000000, 0, 0x3FD4C9E09E173000, 0xBD2E20891B0AD8A4,
  0x3FE7000000000000, 0, 0x3FD522AE0738A000, 0x3D2EBE708164C759,
  0x3FE6E00000000000, 0, 0x3FD57BF753C8D000, 0x3D1FADEDEE5D40EF,
  0x3FE6C00000000000, 0, 0x3FD5D5BDDF596000, 0xBD0A0B2A08A465DC
]);

// Returns 0 if not int, 1 if odd int, 2 if even int. The argument is
// the bit representation of a non-zero finite floating-point value.
// @ts-ignore: decorator
@inline
function checkint(iy: u64): i32 {
  let e = iy >> 52 & 0x7FF;
  if (e < 0x3FF     ) return 0;
  if (e > 0x3FF + 52) return 2;
  e = u64(1) << (0x3FF + 52 - e);
  if (iy & (e - 1)) return 0;
  if (iy &  e     ) return 1;
  return 2;
}

// @ts-ignore: decorator
@inline
function xflow(sign: u32, y: f64): f64 {
  return select(-y, y, sign) * y;
}

// @ts-ignore: decorator
@inline
function uflow(sign: u32): f64 {
  return xflow(sign, reinterpret<f64>(0x1000000000000000)); // 0x1p-767
}

// @ts-ignore: decorator
@inline
function oflow(sign: u32): f64 {
  return xflow(sign, reinterpret<f64>(0x7000000000000000)); // 0x1p769
}

// Returns 1 if input is the bit representation of 0, infinity or nan.
// @ts-ignore: decorator
@inline
function zeroinfnan(u: u64): bool {
  return (u << 1) - 1 >= 0xFFE0000000000000 - 1;
}

// @ts-ignore: decorator
@lazy let log_tail: f64 = 0;

// Compute y+TAIL = log(x) where the rounded result is y and TAIL has about
// additional 15 bits precision. IX is the bit representation of x, but
// normalized in the subnormal range using the sign bit for the exponent.
// @ts-ignore: decorator
@inline
function log_inline(ix: u64): f64 {
  const N = 1 << POW_LOG_TABLE_BITS;
  const N_MASK = N - 1;

  const
    Ln2hi = reinterpret<f64>(0x3FE62E42FEFA3800),
    Ln2lo = reinterpret<f64>(0x3D2EF35793C76730);

  const
    A0 = reinterpret<f64>(0xBFE0000000000000),
    A1 = reinterpret<f64>(0xBFE5555555555560),
    A2 = reinterpret<f64>(0x3FE0000000000006),
    A3 = reinterpret<f64>(0x3FE999999959554E),
    A4 = reinterpret<f64>(0xBFE555555529A47A),
    A5 = reinterpret<f64>(0xBFF2495B9B4845E9),
    A6 = reinterpret<f64>(0x3FF0002B8B263FC3);

  // x = 2^k z; where z is in range [OFF,2*OFF) and exact.
  // The range is split into N subintervals.
  // The ith subinterval contains z and c is near its center.
  let tmp = ix - 0x3fE6955500000000;
  let i   = usize((tmp >> (52 - POW_LOG_TABLE_BITS)) & N_MASK);
  let k   = <i64>tmp >> 52;
  let iz  = ix - (tmp & u64(0xFFF) << 52);
  let z   = reinterpret<f64>(iz);
  let kd  = <f64>k;

  // log(x) = k*Ln2 + log(c) + log1p(z/c-1).
  let invc     = load<f64>(POW_LOG_DATA_TAB + (i << (2 + alignof<f64>())), 0 << alignof<f64>()); // tab[i].invc
  let logc     = load<f64>(POW_LOG_DATA_TAB + (i << (2 + alignof<f64>())), 2 << alignof<f64>()); // tab[i].logc
  let logctail = load<f64>(POW_LOG_DATA_TAB + (i << (2 + alignof<f64>())), 3 << alignof<f64>()); // tab[i].logctail

  // Note: 1/c is j/N or j/N/2 where j is an integer in [N,2N) and
  // |z/c - 1| < 1/N, so r = z/c - 1 is exactly representible.
  // Split z such that rhi, rlo and rhi*rhi are exact and |rlo| <= |r|.
  let zhi = reinterpret<f64>((iz + u64(0x80000000)) & 0xFFFFFFFF00000000);
  let zlo = z - zhi;
  let rhi = zhi * invc - 1.0;
  let rlo = zlo * invc;
  let r   = rhi + rlo;

  // k * Ln2 + log(c) + r.
  let t1  = kd * Ln2hi + logc;
  let t2  = t1 + r;
  let lo1 = kd * Ln2lo + logctail;
  let lo2 = t1 - t2 + r;

  // Evaluation is optimized assuming superscalar pipelined execution.
  let ar  = A0 * r; // A[0] = -0.5
  let ar2 = r * ar;
  let ar3 = r * ar2;
  // k * Ln2 + log(c) + r + A[0] * r * r.
  let arhi  = A0  * rhi;
  let arhi2 = rhi * arhi;
  let hi    = t2  + arhi2;
  let lo3   = rlo * (ar + arhi);
  let lo4   = t2 - hi + arhi2;

  // p = log1p(r) - r - A[0] * r * r.
  let p  = ar3 * (A1 + r * A2 + ar2 * (A3 + r * A4 + ar2 * (A5 + r * A6)));
  let lo = lo1 + lo2 + lo3 + lo4 + p;
  let y  = hi + lo;
  log_tail = hi - y + lo;

  return y;
}

// @ts-ignore: decorator
@inline const SIGN_BIAS = 0x800 << EXP_TABLE_BITS;

// Computes sign*exp(x+xtail) where |xtail| < 2^-8/N and |xtail| <= |x|.
// The sign_bias argument is SIGN_BIAS or 0 and sets the sign to -1 or 1.
// @ts-ignore: decorator
@inline
function exp_inline(x: f64, xtail: f64, sign_bias: u32): f64 {
  const N      = 1 << EXP_TABLE_BITS;
  const N_MASK = N - 1;

  const
    InvLn2N   = reinterpret<f64>(0x3FF71547652B82FE) * N, // 0x1.71547652b82fep0
    NegLn2hiN = reinterpret<f64>(0xBF762E42FEFA0000),     // -0x1.62e42fefa0000p-8
    NegLn2loN = reinterpret<f64>(0xBD0CF79ABC9E3B3A),     // -0x1.cf79abc9e3b3ap-47
    shift     = reinterpret<f64>(0x4338000000000000);     // 0x1.8p52

  const
    C2 = reinterpret<f64>(0x3FDFFFFFFFFFFDBD), // __exp_data.poly[0] (0x1.ffffffffffdbdp-2)
    C3 = reinterpret<f64>(0x3FC555555555543C), // __exp_data.poly[1] (0x1.555555555543cp-3)
    C4 = reinterpret<f64>(0x3FA55555CF172B91), // __exp_data.poly[2] (0x1.55555cf172b91p-5)
    C5 = reinterpret<f64>(0x3F81111167A4D017); // __exp_data.poly[3] (0x1.1111167a4d017p-7)

  let abstop: u32;
  let ki: u64, top: u64, sbits: u64;
  let idx: usize;
  // double_t for better performance on targets with FLT_EVAL_METHOD==2.
  let kd: f64, z: f64, r: f64, r2: f64, scale: f64, tail: f64, tmp: f64;

  let ux = reinterpret<u64>(x);
  abstop = u32(ux >> 52) & 0x7FF;
  if (abstop - 0x3C9 >= 0x03F) {
    if (abstop - 0x3C9 >= 0x80000000) {
      // Avoid spurious underflow for tiny x.
      // Note: 0 is common input.
      return select(-1.0, 1.0, sign_bias);
    }
    if (abstop >= 0x409) { // top12(1024.0)
      // Note: inf and nan are already handled.
      return <i64>ux < 0
        ? uflow(sign_bias)
        : oflow(sign_bias);
    }
    // Large x is special cased below.
    abstop = 0;
  }

  // exp(x) = 2^(k/N) * exp(r), with exp(r) in [2^(-1/2N),2^(1/2N)].
  // x = ln2/N*k + r, with int k and r in [-ln2/2N, ln2/2N].
  z = InvLn2N * x;

  // #if TOINT_INTRINSICS
  //   kd = roundtoint(z);
  //   ki = converttoint(z);
  // #elif EXP_USE_TOINT_NARROW
  //   // z - kd is in [-0.5-2^-16, 0.5] in all rounding modes.
  //   kd = eval_as_double(z + shift);
  //   ki = asuint64(kd) >> 16;
  //   kd = (double_t)(int32_t)ki;
  // #else
  // z - kd is in [-1, 1] in non-nearest rounding modes
  kd  = z + shift;
  ki  = reinterpret<u64>(kd);
  kd -= shift;
  // #endif
  r = x + kd * NegLn2hiN + kd * NegLn2loN;
  // The code assumes 2^-200 < |xtail| < 2^-8/N
  r += xtail;
  // 2^(k/N) ~= scale * (1 + tail)
  idx = usize((ki & N_MASK) << 1);
  top = (ki + sign_bias) << (52 - EXP_TABLE_BITS);

  tail = reinterpret<f64>(load<u64>(EXP_DATA_TAB + (idx << alignof<u64>())));
  // This is only a valid scale when -1023*N < k < 1024*N
  sbits = load<u64>(EXP_DATA_TAB + (idx << alignof<u64>()), 1 << alignof<u64>()) + top;
  // exp(x) = 2^(k/N) * exp(r) ~= scale + scale * (tail + exp(r) - 1).
  // Evaluation is optimized assuming superscalar pipelined execution.
  r2 = r * r;
  // Without fma the worst case error is 0.25/N ulp larger.
  // Worst case error is less than 0.5+1.11/N+(abs poly error * 2^53) ulp
  tmp = tail + r + r2 * (C2 + r * C3) + r2 * r2 * (C4 + r * C5);
  if (abstop == 0) return specialcase(tmp, sbits, ki);
  scale = reinterpret<f64>(sbits);
  // Note: tmp == 0 or |tmp| > 2^-200 and scale > 2^-739, so there
  // is no spurious underflow here even without fma.
  return scale + scale * tmp;
}

// @ts-ignore: decorator
@inline
export function pow_lut(x: f64, y: f64): f64 {
  const Ox1p52 = reinterpret<f64>(0x4330000000000000); // 0x1p52

  let sign_bias: u32 = 0;
  let ix = reinterpret<u64>(x);
  let iy = reinterpret<u64>(y);
  let topx = ix >> 52;
  let topy = iy >> 52;

  if (topx - 0x001 >= 0x7FF - 0x001 || (topy & 0x7FF) - 0x3BE >= 0x43e - 0x3BE) {
    // Note: if |y| > 1075 * ln2 * 2^53 ~= 0x1.749p62 then pow(x,y) = inf/0
    // and if |y| < 2^-54 / 1075 ~= 0x1.e7b6p-65 then pow(x,y) = +-1.
    // Special cases: (x < 0x1p-126 or inf or nan) or
    // (|y| < 0x1p-65 or |y| >= 0x1p63 or nan).
    if (zeroinfnan(iy)) {
      if ((iy << 1) == 0) return 1.0;
      if (ix == 0x3FF0000000000000) return NaN; // original: 1.0
      if ((ix << 1) > 0xFFE0000000000000 || (iy << 1) > 0xFFE0000000000000) return x + y;
      if ((ix << 1) == 0x7FE0000000000000) return NaN; // original: 1.0
      if (((ix << 1) < 0x7FE0000000000000) == !(iy >> 63)) return 0; // |x|<1 && y==inf or |x|>1 && y==-inf.
      return y * y;
    }
    if (zeroinfnan(ix)) {
      let x2 = x * x;
      if (i32(ix >> 63) && checkint(iy) == 1) x2 = -x2;
      return <i64>iy < 0 ? 1 / x2 : x2;
    }
    // Here x and y are non-zero finite
    if (<i64>ix < 0) {
      // Finite x < 0
      let yint = checkint(iy);
      if (yint == 0) return (x - x) / (x - x);
      if (yint == 1) sign_bias = SIGN_BIAS;
      ix   &= 0x7FFFFFFFFFFFFFFF;
      topx &= 0x7FF;
    }
    if ((topy & 0x7FF) - 0x3BE >= 0x43E - 0x3BE) {
      // Note: sign_bias == 0 here because y is not odd.
      if (ix == 0x3FF0000000000000) return 1;
      if ((topy & 0x7FF) < 0x3BE)   return 1; // |y| < 2^-65, x^y ~= 1 + y*log(x).
      return (ix > 0x3FF0000000000000) == (topy < 0x800) ? Infinity : 0;
    }
    if (topx == 0) {
      // Normalize subnormal x so exponent becomes negative.
      ix = reinterpret<u64>(x * Ox1p52);
      ix &= 0x7FFFFFFFFFFFFFFF;
      ix -= u64(52) << 52;
    }
  }

  let hi = log_inline(ix);
  let lo = log_tail;
  let ehi: f64, elo: f64;
  // #if __FP_FAST_FMA
  //   ehi = y * hi;
  //   elo = y * lo + __builtin_fma(y, hi, -ehi);
  // #else
  let yhi = reinterpret<f64>(iy & 0xFFFFFFFFF8000000);
  let ylo = y - yhi;
  let lhi = reinterpret<f64>(reinterpret<u64>(hi) & 0xFFFFFFFFF8000000);
  let llo = hi - lhi + lo;
  ehi = yhi * lhi;
  elo = ylo * lhi + y * llo; // |elo| < |ehi| * 2^-25.
  // #endif
  return exp_inline(ehi, elo, sign_bias);
}
`,"util/memory":`export function memcpy(dest: usize, src: usize, n: usize): void { // see: musl/src/string/memcpy.c
  let w: u32, x: u32;

  // copy 1 byte each until src is aligned to 4 bytes
  while (n && (src & 3)) {
    store<u8>(dest++, load<u8>(src++));
    n--;
  }

  // if dst is aligned to 4 bytes as well, copy 4 bytes each
  if ((dest & 3) == 0) {
    while (n >= 16) {
      store<u32>(dest     , load<u32>(src     ));
      store<u32>(dest +  4, load<u32>(src +  4));
      store<u32>(dest +  8, load<u32>(src +  8));
      store<u32>(dest + 12, load<u32>(src + 12));
      src += 16; dest += 16; n -= 16;
    }
    if (n & 8) {
      store<u32>(dest    , load<u32>(src    ));
      store<u32>(dest + 4, load<u32>(src + 4));
      dest += 8; src += 8;
    }
    if (n & 4) {
      store<u32>(dest, load<u32>(src));
      dest += 4; src += 4;
    }
    if (n & 2) { // drop to 2 bytes each
      store<u16>(dest, load<u16>(src));
      dest += 2; src += 2;
    }
    if (n & 1) { // drop to 1 byte
      store<u8>(dest++, load<u8>(src++));
    }
    return;
  }

  // if dst is not aligned to 4 bytes, use alternating shifts to copy 4 bytes each
  // doing shifts if faster when copying enough bytes (here: 32 or more)
  if (n >= 32) {
    switch (<u32>dest & 3) {
      // known to be != 0
      case 1: {
        w = load<u32>(src);
        store<u8>(dest++, load<u8>(src++));
        store<u8>(dest++, load<u8>(src++));
        store<u8>(dest++, load<u8>(src++));
        n -= 3;
        while (n >= 17) {
          x = load<u32>(src + 1);
          store<u32>(dest, w >> 24 | x << 8);
          w = load<u32>(src + 5);
          store<u32>(dest + 4, x >> 24 | w << 8);
          x = load<u32>(src + 9);
          store<u32>(dest + 8, w >> 24 | x << 8);
          w = load<u32>(src + 13);
          store<u32>(dest + 12, x >> 24 | w << 8);
          src += 16; dest += 16; n -= 16;
        }
        break;
      }
      case 2: {
        w = load<u32>(src);
        store<u8>(dest++, load<u8>(src++));
        store<u8>(dest++, load<u8>(src++));
        n -= 2;
        while (n >= 18) {
          x = load<u32>(src + 2);
          store<u32>(dest, w >> 16 | x << 16);
          w = load<u32>(src + 6);
          store<u32>(dest + 4, x >> 16 | w << 16);
          x = load<u32>(src + 10);
          store<u32>(dest + 8, w >> 16 | x << 16);
          w = load<u32>(src + 14);
          store<u32>(dest + 12, x >> 16 | w << 16);
          src += 16; dest += 16; n -= 16;
        }
        break;
      }
      case 3: {
        w = load<u32>(src);
        store<u8>(dest++, load<u8>(src++));
        n -= 1;
        while (n >= 19) {
          x = load<u32>(src + 3);
          store<u32>(dest, w >> 8 | x << 24);
          w = load<u32>(src + 7);
          store<u32>(dest + 4, x >> 8 | w << 24);
          x = load<u32>(src + 11);
          store<u32>(dest + 8, w >> 8 | x << 24);
          w = load<u32>(src + 15);
          store<u32>(dest + 12, x >> 8 | w << 24);
          src += 16; dest += 16; n -= 16;
        }
        break;
      }
    }
  }

  // copy remaining bytes one by one
  if (n & 16) {
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
  }
  if (n & 8) {
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
  }
  if (n & 4) {
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
  }
  if (n & 2) {
    store<u8>(dest++, load<u8>(src++));
    store<u8>(dest++, load<u8>(src++));
  }
  if (n & 1) {
    store<u8>(dest++, load<u8>(src++));
  }
}

// @ts-ignore: decorator
@inline
export function memmove(dest: usize, src: usize, n: usize): void { // see: musl/src/string/memmove.c
  if (dest == src) return;
  if (ASC_SHRINK_LEVEL < 1) {
    if (src - dest - n <= -(n << 1)) {
      memcpy(dest, src, n);
      return;
    }
  }
  if (dest < src) {
    if (ASC_SHRINK_LEVEL < 2) {
      if ((src & 7) == (dest & 7)) {
        while (dest & 7) {
          if (!n) return;
          --n;
          store<u8>(dest++, load<u8>(src++));
        }
        while (n >= 8) {
          store<u64>(dest, load<u64>(src));
          n    -= 8;
          dest += 8;
          src  += 8;
        }
      }
    }
    while (n) {
      store<u8>(dest++, load<u8>(src++));
      --n;
    }
  } else {
    if (ASC_SHRINK_LEVEL < 2) {
      if ((src & 7) == (dest & 7)) {
        while ((dest + n) & 7) {
          if (!n) return;
          store<u8>(dest + --n, load<u8>(src + n));
        }
        while (n >= 8) {
          n -= 8;
          store<u64>(dest + n, load<u64>(src + n));
        }
      }
    }
    while (n) {
      store<u8>(dest + --n, load<u8>(src + n));
    }
  }
}

// @ts-ignore: decorator
@inline
export function memset(dest: usize, c: u8, n: usize): void { // see: musl/src/string/memset
  if (ASC_SHRINK_LEVEL > 1) {
    while (n) {
      store<u8>(dest++, c);
      --n;
    }
  } else {
    // fill head and tail with minimal branching
    if (!n) return;
    let dend = dest + n;
    store<u8>(dest, c);
    store<u8>(dend - 1, c);
    if (n <= 2) return;
    store<u8>(dest, c, 1);
    store<u8>(dest, c, 2);
    store<u8>(dend - 2, c);
    store<u8>(dend - 3, c);
    if (n <= 6) return;
    store<u8>(dest, c, 3);
    store<u8>(dend - 4, c);
    if (n <= 8) return;

    // advance pointer to align it at 4-byte boundary
    let k: usize = -dest & 3;
    dest += k;
    n -= k;
    n &= -4;

    let c32: u32 = <u32>-1 / 255 * c;

    // fill head/tail up to 28 bytes each in preparation
    dend = dest + n;
    store<u32>(dest, c32);
    store<u32>(dend - 4, c32);
    if (n <= 8) return;
    store<u32>(dest, c32, 4);
    store<u32>(dest, c32, 8);
    store<u32>(dend - 12, c32);
    store<u32>(dend - 8, c32);
    if (n <= 24) return;
    store<u32>(dest, c32, 12);
    store<u32>(dest, c32, 16);
    store<u32>(dest, c32, 20);
    store<u32>(dest, c32, 24);
    store<u32>(dend - 28, c32);
    store<u32>(dend - 24, c32);
    store<u32>(dend - 20, c32);
    store<u32>(dend - 16, c32);

    // align to a multiple of 8
    k = 24 + (dest & 4);
    dest += k;
    n -= k;

    // copy 32 bytes each
    let c64: u64 = <u64>c32 | (<u64>c32 << 32);
    while (n >= 32) {
      store<u64>(dest, c64);
      store<u64>(dest, c64, 8);
      store<u64>(dest, c64, 16);
      store<u64>(dest, c64, 24);
      n -= 32;
      dest += 32;
    }
  }
}

// @ts-ignore: decorator
@inline
export function memcmp(vl: usize, vr: usize, n: usize): i32 {
  if (vl == vr) return 0;
  if (ASC_SHRINK_LEVEL < 2) {
    if ((vl & 7) == (vr & 7)) {
      while (vl & 7) {
        if (!n) return 0;
        let a = <i32>load<u8>(vl);
        let b = <i32>load<u8>(vr);
        if (a != b) return a - b;
        n--; vl++; vr++;
      }
      while (n >= 8) {
        if (load<u64>(vl) != load<u64>(vr)) break;
        vl += 8;
        vr += 8;
        n  -= 8;
      }
    }
  }
  while (n--) {
    let a = <i32>load<u8>(vl);
    let b = <i32>load<u8>(vr);
    if (a != b) return a - b;
    vl++; vr++;
  }
  return 0;
}
`,"util/number":`/// <reference path="../rt/index.d.ts" />

import { idof } from "../builtins";
import { CharCode } from "./string";

// @ts-ignore: decorator
@inline
export const MAX_DOUBLE_LENGTH = 28;

// @ts-ignore: decorator
@lazy @inline const POWERS10 = memory.data<u32>([
  1,
  10,
  100,
  1000,
  10000,
  100000,
  1000000,
  10000000,
  100000000,
  1000000000
]);

/*
  Lookup table for pairwise char codes in range [0-99]

  "00", "01", "02", "03", "04", "05", "06", "07", "08", "09",
  "10", "11", "12", "13", "14", "15", "16", "17", "18", "19",
  "20", "21", "22", "23", "24", "25", "26", "27", "28", "29",
  "30", "31", "32", "33", "34", "35", "36", "37", "38", "39",
  "40", "41", "42", "43", "44", "45", "46", "47", "48", "49",
  "50", "51", "52", "53", "54", "55", "56", "57", "58", "59",
  "60", "61", "62", "63", "64", "65", "66", "67", "68", "69",
  "70", "71", "72", "73", "74", "75", "76", "77", "78", "79",
  "80", "81", "82", "83", "84", "85", "86", "87", "88", "89",
  "90", "91", "92", "93", "94", "95", "96", "97", "98", "99"
*/
// @ts-ignore: decorator
@lazy @inline const DIGITS = memory.data<u32>([
  0x00300030, 0x00310030, 0x00320030, 0x00330030, 0x00340030,
  0x00350030, 0x00360030, 0x00370030, 0x00380030, 0x00390030,
  0x00300031, 0x00310031, 0x00320031, 0x00330031, 0x00340031,
  0x00350031, 0x00360031, 0x00370031, 0x00380031, 0x00390031,
  0x00300032, 0x00310032, 0x00320032, 0x00330032, 0x00340032,
  0x00350032, 0x00360032, 0x00370032, 0x00380032, 0x00390032,
  0x00300033, 0x00310033, 0x00320033, 0x00330033, 0x00340033,
  0x00350033, 0x00360033, 0x00370033, 0x00380033, 0x00390033,
  0x00300034, 0x00310034, 0x00320034, 0x00330034, 0x00340034,
  0x00350034, 0x00360034, 0x00370034, 0x00380034, 0x00390034,
  0x00300035, 0x00310035, 0x00320035, 0x00330035, 0x00340035,
  0x00350035, 0x00360035, 0x00370035, 0x00380035, 0x00390035,
  0x00300036, 0x00310036, 0x00320036, 0x00330036, 0x00340036,
  0x00350036, 0x00360036, 0x00370036, 0x00380036, 0x00390036,
  0x00300037, 0x00310037, 0x00320037, 0x00330037, 0x00340037,
  0x00350037, 0x00360037, 0x00370037, 0x00380037, 0x00390037,
  0x00300038, 0x00310038, 0x00320038, 0x00330038, 0x00340038,
  0x00350038, 0x00360038, 0x00370038, 0x00380038, 0x00390038,
  0x00300039, 0x00310039, 0x00320039, 0x00330039, 0x00340039,
  0x00350039, 0x00360039, 0x00370039, 0x00380039, 0x00390039
]);

// Lookup table for pairwise char codes in range [0x00-0xFF]
// @ts-ignore: decorator
@lazy @inline const HEX_DIGITS =
"000102030405060708090a0b0c0d0e0f\\
101112131415161718191a1b1c1d1e1f\\
202122232425262728292a2b2c2d2e2f\\
303132333435363738393a3b3c3d3e3f\\
404142434445464748494a4b4c4d4e4f\\
505152535455565758595a5b5c5d5e5f\\
606162636465666768696a6b6c6d6e6f\\
707172737475767778797a7b7c7d7e7f\\
808182838485868788898a8b8c8d8e8f\\
909192939495969798999a9b9c9d9e9f\\
a0a1a2a3a4a5a6a7a8a9aaabacadaeaf\\
b0b1b2b3b4b5b6b7b8b9babbbcbdbebf\\
c0c1c2c3c4c5c6c7c8c9cacbcccdcecf\\
d0d1d2d3d4d5d6d7d8d9dadbdcdddedf\\
e0e1e2e3e4e5e6e7e8e9eaebecedeeef\\
f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff";

// @ts-ignore: decorator
@lazy @inline const ANY_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

// @ts-ignore: decorator
@lazy @inline const EXP_POWERS = memory.data<i16>([/* eslint-disable indent */
  -1220, -1193, -1166, -1140, -1113, -1087, -1060, -1034, -1007,  -980,
   -954,  -927,  -901,  -874,  -847,  -821,  -794,  -768,  -741,  -715,
   -688,  -661,  -635,  -608,  -582,  -555,  -529,  -502,  -475,  -449,
   -422,  -396,  -369,  -343,  -316,  -289,  -263,  -236,  -210,  -183,
   -157,  -130,  -103,   -77,   -50,   -24,     3,    30,    56,    83,
    109,   136,   162,   189,   216,   242,   269,   295,   322,   348,
    375,   402,   428,   455,   481,   508,   534,   561,   588,   614,
    641,   667,   694,   720,   747,   774,   800,   827,   853,   880,
    907,   933,   960,   986,  1013,  1039,  1066
/* eslint-enable indent */]);

// 1e-348, 1e-340, ..., 1e340
// @ts-ignore: decorator
@lazy @inline const FRC_POWERS = memory.data<u64>([
  0xFA8FD5A0081C0288, 0xBAAEE17FA23EBF76, 0x8B16FB203055AC76, 0xCF42894A5DCE35EA,
  0x9A6BB0AA55653B2D, 0xE61ACF033D1A45DF, 0xAB70FE17C79AC6CA, 0xFF77B1FCBEBCDC4F,
  0xBE5691EF416BD60C, 0x8DD01FAD907FFC3C, 0xD3515C2831559A83, 0x9D71AC8FADA6C9B5,
  0xEA9C227723EE8BCB, 0xAECC49914078536D, 0x823C12795DB6CE57, 0xC21094364DFB5637,
  0x9096EA6F3848984F, 0xD77485CB25823AC7, 0xA086CFCD97BF97F4, 0xEF340A98172AACE5,
  0xB23867FB2A35B28E, 0x84C8D4DFD2C63F3B, 0xC5DD44271AD3CDBA, 0x936B9FCEBB25C996,
  0xDBAC6C247D62A584, 0xA3AB66580D5FDAF6, 0xF3E2F893DEC3F126, 0xB5B5ADA8AAFF80B8,
  0x87625F056C7C4A8B, 0xC9BCFF6034C13053, 0x964E858C91BA2655, 0xDFF9772470297EBD,
  0xA6DFBD9FB8E5B88F, 0xF8A95FCF88747D94, 0xB94470938FA89BCF, 0x8A08F0F8BF0F156B,
  0xCDB02555653131B6, 0x993FE2C6D07B7FAC, 0xE45C10C42A2B3B06, 0xAA242499697392D3,
  0xFD87B5F28300CA0E, 0xBCE5086492111AEB, 0x8CBCCC096F5088CC, 0xD1B71758E219652C,
  0x9C40000000000000, 0xE8D4A51000000000, 0xAD78EBC5AC620000, 0x813F3978F8940984,
  0xC097CE7BC90715B3, 0x8F7E32CE7BEA5C70, 0xD5D238A4ABE98068, 0x9F4F2726179A2245,
  0xED63A231D4C4FB27, 0xB0DE65388CC8ADA8, 0x83C7088E1AAB65DB, 0xC45D1DF942711D9A,
  0x924D692CA61BE758, 0xDA01EE641A708DEA, 0xA26DA3999AEF774A, 0xF209787BB47D6B85,
  0xB454E4A179DD1877, 0x865B86925B9BC5C2, 0xC83553C5C8965D3D, 0x952AB45CFA97A0B3,
  0xDE469FBD99A05FE3, 0xA59BC234DB398C25, 0xF6C69A72A3989F5C, 0xB7DCBF5354E9BECE,
  0x88FCF317F22241E2, 0xCC20CE9BD35C78A5, 0x98165AF37B2153DF, 0xE2A0B5DC971F303A,
  0xA8D9D1535CE3B396, 0xFB9B7CD9A4A7443C, 0xBB764C4CA7A44410, 0x8BAB8EEFB6409C1A,
  0xD01FEF10A657842C, 0x9B10A4E5E9913129, 0xE7109BFBA19C0C9D, 0xAC2820D9623BF429,
  0x80444B5E7AA7CF85, 0xBF21E44003ACDD2D, 0x8E679C2F5E44FF8F, 0xD433179D9C8CB841,
  0x9E19DB92B4E31BA9, 0xEB96BF6EBADF77D9, 0xAF87023B9BF0EE6B
]);

// @ts-ignore: decorator
@inline
export function isPowerOf2<T extends number>(value: T): bool {
  return popcnt<T>(value) == 1;
}

// Count number of decimals for u32 values
// In our case input value always non-zero so we can simplify some parts
export function decimalCount32(value: u32): u32 {
  if (value < 100000) {
    if (value < 100) {
      return 1 + u32(value >= 10);
    } else {
      return 3 + u32(value >= 10000) + u32(value >= 1000);
    }
  } else {
    if (value < 10000000) {
      return 6 + u32(value >= 1000000);
    } else {
      return 8 + u32(value >= 1000000000) + u32(value >= 100000000);
    }
  }
}

// Count number of decimals for u64 values
// In our case input value always greater than 2^32-1 so we can skip some parts
export function decimalCount64High(value: u64): u32 {
  if (value < 1000000000000000) {
    if (value < 1000000000000) {
      return 10 + u32(value >= 100000000000) + u32(value >= 10000000000);
    } else {
      return 13 + u32(value >= 100000000000000) + u32(value >= 10000000000000);
    }
  } else {
    if (value < 100000000000000000) {
      return 16 + u32(value >= 10000000000000000);
    } else {
      return 18 + u32(value >= 10000000000000000000) + u32(value >= 1000000000000000000);
    }
  }
}

function ulog_base(num: u64, base: i32): u32 {
  if (isPowerOf2(base)) {
    return (63 - <u32>clz(num)) / (31 - <u32>clz(base)) + 1;
  }
  let b64 = u64(base), b = b64, e: u32 = 1;
  while (num >= b) {
    num /= b;
    b *= b;
    e <<= 1;
  }
  while (num >= 1) {
    num /= b64;
    e++;
  }
  return e - 1;
}

function utoa32_dec_lut(buffer: usize, num: u32, offset: usize): void {
  while (num >= 10000) {
    // in most VMs i32/u32 div and modulo by constant can be shared and simplificate
    let t = num / 10000;
    let r = num % 10000;
    num = t;

    let d1 = r / 100;
    let d2 = r % 100;

    let digits1 = <u64>load<u32>(DIGITS + (<usize>d1 << alignof<u32>()));
    let digits2 = <u64>load<u32>(DIGITS + (<usize>d2 << alignof<u32>()));

    offset -= 4;
    store<u64>(buffer + (offset << 1), digits1 | (digits2 << 32));
  }

  if (num >= 100) {
    let t  = num / 100;
    let d1 = num % 100;
    num = t;
    offset -= 2;
    let digits = load<u32>(DIGITS + (<usize>d1 << alignof<u32>()));
    store<u32>(buffer + (offset << 1), digits);
  }

  if (num >= 10) {
    offset -= 2;
    let digits = load<u32>(DIGITS + (<usize>num << alignof<u32>()));
    store<u32>(buffer + (offset << 1), digits);
  } else {
    offset -= 1;
    let digit = CharCode._0 + num;
    store<u16>(buffer + (offset << 1), digit);
  }
}

function utoa64_dec_lut(buffer: usize, num: u64, offset: usize): void {
  while (num >= 100000000) {
    let t = num / 100000000;
    let r = <usize>(num - t * 100000000);
    num = t;

    let b = r / 10000;
    let c = r % 10000;

    let b1 = b / 100;
    let b2 = b % 100;
    let c1 = c / 100;
    let c2 = c % 100;

    let digits1 = <u64>load<u32>(DIGITS + (<usize>c1 << alignof<u32>()));
    let digits2 = <u64>load<u32>(DIGITS + (<usize>c2 << alignof<u32>()));

    offset -= 4;
    store<u64>(buffer + (offset << 1), digits1 | (digits2 << 32));

    digits1 = <u64>load<u32>(DIGITS + (<usize>b1 << alignof<u32>()));
    digits2 = <u64>load<u32>(DIGITS + (<usize>b2 << alignof<u32>()));

    offset -= 4;
    store<u64>(buffer + (offset << 1), digits1 | (digits2 << 32));
  }

  utoa32_dec_lut(buffer, <u32>num, offset);
}

function utoa_hex_lut(buffer: usize, num: u64, offset: usize): void {
  const lut = changetype<usize>(HEX_DIGITS);
  while (offset >= 2) {
    offset -= 2;
    store<u32>(
      buffer + (offset << 1),
      load<u32>(lut + ((<usize>num & 0xFF) << alignof<u32>()))
    );
    num >>= 8;
  }
  if (offset & 1) {
    store<u16>(buffer, load<u16>(lut + (<usize>num << 6)));
  }
}

function utoa_dec_simple<T extends number>(buffer: usize, num: T, offset: usize): void {
  do {
    let t = num / 10;
    let r = <u32>(num % 10);
    num = changetype<T>(t);
    offset--;
    store<u16>(buffer + (offset << 1), CharCode._0 + r);
  } while (num);
}

function utoa_hex_simple<T extends number>(buffer: usize, num: T, offset: usize): void {
  do {
    let d = num & 0x0F | CharCode._0;
    d += select<T>(<T>0x27, <T>0, d > <T>CharCode._9);
    offset--;
    store<u16>(buffer + (offset << 1), d);
    // @ts-ignore: type
    num >>= 4;
  } while (num);
}

// @ts-ignore: decorator
@inline
export function utoa32_dec_core(buffer: usize, num: u32, offset: usize): void {
  if (ASC_SHRINK_LEVEL >= 1) {
    utoa_dec_simple<u32>(buffer, num, offset);
  } else {
    utoa32_dec_lut(buffer, num, offset);
  }
}

// @ts-ignore: decorator
@inline
function utoa32_hex_core(buffer: usize, num: u32, offset: usize): void {
  if (ASC_SHRINK_LEVEL >= 1) {
    utoa_hex_simple<u32>(buffer, num, offset);
  } else {
    utoa_hex_lut(buffer, num, offset);
  }
}

// @ts-ignore: decorator
@inline
function utoa64_dec_core(buffer: usize, num: u64, offset: usize): void {
  if (ASC_SHRINK_LEVEL >= 1) {
    utoa_dec_simple<u64>(buffer, num, offset);
  } else {
    utoa64_dec_lut(buffer, num, offset);
  }
}

// @ts-ignore: decorator
@inline
function utoa64_hex_core(buffer: usize, num: u64, offset: usize): void {
  if (ASC_SHRINK_LEVEL >= 1) {
    utoa_hex_simple<u64>(buffer, num, offset);
  } else {
    utoa_hex_lut(buffer, num, offset);
  }
}

function utoa64_any_core(buffer: usize, num: u64, offset: usize, radix: i32): void {
  const lut = changetype<usize>(ANY_DIGITS);
  let base = u64(radix);
  if ((radix & (radix - 1)) == 0) { // for radix which pow of two
    let shift = u64(ctz(radix) & 7);
    let mask = base - 1;
    do {
      offset--;
      store<u16>(buffer + (offset << 1), load<u16>(lut + (usize(num & mask) << 1)));
      num >>= shift;
    } while (num);
  } else {
    do {
      offset--;
      let q = num / base;
      store<u16>(buffer + (offset << 1), load<u16>(lut + (usize(num - q * base) << 1)));
      num = q;
    } while (num);
  }
}

export function utoa32(value: u32, radix: i32): String {
  if (radix < 2 || radix > 36) {
    throw new RangeError("toString() radix argument must be between 2 and 36");
  }
  if (!value) return "0";
  let out: String;

  if (radix == 10) {
    let decimals = decimalCount32(value);
    out = changetype<String>(__new(decimals << 1, idof<String>()));
    utoa32_dec_core(changetype<usize>(out), value, decimals);
  } else if (radix == 16) {
    let decimals = (31 - clz(value) >> 2) + 1;
    out = changetype<String>(__new(decimals << 1, idof<String>()));
    utoa32_hex_core(changetype<usize>(out), value, decimals);
  } else {
    let decimals = ulog_base(value, radix);
    out = changetype<String>(__new(decimals << 1, idof<String>()));
    utoa64_any_core(changetype<usize>(out), value, decimals, radix);
  }
  return out;
}

export function itoa32(value: i32, radix: i32): String {
  if (radix < 2 || radix > 36) {
    throw new RangeError("toString() radix argument must be between 2 and 36");
  }
  if (!value) return "0";

  let sign = (value >>> 31) << 1;
  if (sign) value = -value;
  let out: String;

  if (radix == 10) {
    let decimals = decimalCount32(value);
    out = changetype<String>(__new((decimals << 1) + sign, idof<String>()));
    utoa32_dec_core(changetype<usize>(out) + sign, value, decimals);
  } else if (radix == 16) {
    let decimals = (31 - clz(value) >> 2) + 1;
    out = changetype<String>(__new((decimals << 1) + sign, idof<String>()));
    utoa32_hex_core(changetype<usize>(out) + sign, value, decimals);
  } else {
    let val32 = u32(value);
    let decimals = ulog_base(val32, radix);
    out = changetype<String>(__new((decimals << 1) + sign, idof<String>()));
    utoa64_any_core(changetype<usize>(out) + sign, val32, decimals, radix);
  }
  if (sign) store<u16>(changetype<usize>(out), CharCode.MINUS);
  return out;
}

export function utoa64(value: u64, radix: i32): String {
  if (radix < 2 || radix > 36) {
    throw new RangeError("toString() radix argument must be between 2 and 36");
  }
  if (!value) return "0";
  let out: String;

  if (radix == 10) {
    if (value <= u32.MAX_VALUE) {
      let val32    = <u32>value;
      let decimals = decimalCount32(val32);
      out = changetype<String>(__new(decimals << 1, idof<String>()));
      utoa32_dec_core(changetype<usize>(out), val32, decimals);
    } else {
      let decimals = decimalCount64High(value);
      out = changetype<String>(__new(decimals << 1, idof<String>()));
      utoa64_dec_core(changetype<usize>(out), value, decimals);
    }
  } else if (radix == 16) {
    let decimals = (63 - u32(clz(value)) >> 2) + 1;
    out = changetype<String>(__new(decimals << 1, idof<String>()));
    utoa64_hex_core(changetype<usize>(out), value, decimals);
  } else {
    let decimals = ulog_base(value, radix);
    out = changetype<String>(__new(decimals << 1, idof<String>()));
    utoa64_any_core(changetype<usize>(out), value, decimals, radix);
  }
  return out;
}

export function itoa64(value: i64, radix: i32): String {
  if (radix < 2 || radix > 36) {
    throw new RangeError("toString() radix argument must be between 2 and 36");
  }
  if (!value) return "0";

  let sign = u32(value >>> 63) << 1;
  if (sign) value = -value;
  let out: String;

  if (radix == 10) {
    if (<u64>value <= <u64>u32.MAX_VALUE) {
      let val32    = <u32>value;
      let decimals = decimalCount32(val32);
      out = changetype<String>(__new((decimals << 1) + sign, idof<String>()));
      utoa32_dec_core(changetype<usize>(out) + sign, val32, decimals);
    } else {
      let decimals = decimalCount64High(value);
      out = changetype<String>(__new((decimals << 1) + sign, idof<String>()));
      utoa64_dec_core(changetype<usize>(out) + sign, value, decimals);
    }
  } else if (radix == 16) {
    let decimals = (63 - u32(clz(value)) >> 2) + 1;
    out = changetype<String>(__new((decimals << 1) + sign, idof<String>()));
    utoa64_hex_core(changetype<usize>(out) + sign, value, decimals);
  } else {
    let decimals = ulog_base(value, radix);
    out = changetype<String>(__new((decimals << 1) + sign, idof<String>()));
    utoa64_any_core(changetype<usize>(out) + sign, value, decimals, radix);
  }
  if (sign) store<u16>(changetype<usize>(out), CharCode.MINUS);
  return out;
}

// @ts-ignore: decorator
@lazy let _K: i32 = 0;

// // @ts-ignore: decorator
// @lazy
// let _frc: u64 = 0;

// @ts-ignore: decorator
@lazy let _exp: i32 = 0;

// @ts-ignore: decorator
@lazy let _frc_minus: u64 = 0;

// @ts-ignore: decorator
@lazy let _frc_plus: u64 = 0;

// @ts-ignore: decorator
@lazy let _frc_pow: u64 = 0;

// @ts-ignore: decorator
@lazy let _exp_pow: i32 = 0;

// @ts-ignore: decorator
@inline
function umul64f(u: u64, v: u64): u64 {
  let u0 = u & 0xFFFFFFFF;
  let v0 = v & 0xFFFFFFFF;

  let u1 = u >> 32;
  let v1 = v >> 32;

  let l = u0 * v0;
  let t = u1 * v0 + (l >> 32);
  let w = u0 * v1 + (t & 0xFFFFFFFF);

  w += 0x7FFFFFFF; // rounding

  t >>= 32;
  w >>= 32;

  return u1 * v1 + t + w;
}

// @ts-ignore: decorator
@inline
function umul64e(e1: i32, e2: i32): i32 {
  return e1 + e2 + 64; // where 64 is significand size
}

// @ts-ignore: decorator
@inline
function normalizedBoundaries(f: u64, e: i32, isSingle: bool): void {
  let frc = (f << 1) + 1;
  let exp = e - 1;
  let off = <i32>clz<u64>(frc);
  frc <<= off;
  exp  -= off;

  let m = 1 + i32(f == (isSingle ? 0x00800000 : 0x0010000000000000));

  _frc_plus  = frc;
  _frc_minus = ((f << m) - 1) << e - m - exp;
  _exp = exp;
}

// @ts-ignore: decorator
@inline
function grisuRound(buffer: usize, len: i32, delta: u64, rest: u64, ten_kappa: u64, wp_w: u64): void {
  let lastp = buffer + ((len - 1) << 1);
  let digit = load<u16>(lastp);
  while (
    rest < wp_w &&
    delta - rest >= ten_kappa && (
      rest + ten_kappa < wp_w ||
      wp_w - rest > rest + ten_kappa - wp_w
    )
  ) {
    --digit;
    rest += ten_kappa;
  }
  store<u16>(lastp, digit);
}

// @ts-ignore: decorator
@inline
function getCachedPower(minExp: i32): void {
  const c = reinterpret<f64>(0x3FD34413509F79FE); // 1 / lg(10) = 0.30102999566398114
  let dk = (-61 - minExp) * c + 347;	            // dk must be positive, so can do ceiling in positive
  let k = <i32>dk;
  k += i32(k != dk); // conversion with ceil

  let index = (k >> 3) + 1;
  _K = 348 - (index << 3);	// decimal exponent no need lookup table
  _frc_pow = load<u64>(FRC_POWERS + (<usize>index << alignof<u64>()));
  _exp_pow = load<i16>(EXP_POWERS + (<usize>index << alignof<i16>()));
}

// @ts-ignore: decorator
@inline
function grisu2(value: f64, buffer: usize, sign: i32, isSingle: bool): i32 {
  let frc: u64;
  let exp: i32;

  // frexp routine
  if (isSingle) {
    let uv = reinterpret<u32>(<f32>value);
    exp = (uv & 0x7F800000) >>> 23;
    let sid = uv & 0x007FFFFF;
    frc = (u64(exp != 0) << 23) + sid;
    exp = (exp || 1) - (0x7F + 23);
  } else {
    let uv = reinterpret<u64>(value);
    exp = i32((uv & 0x7FF0000000000000) >>> 52);
    let sid = uv & 0x000FFFFFFFFFFFFF;
    frc = (u64(exp != 0) << 52) + sid;
    exp = (exp || 1) - (0x3FF + 52);
  }

  normalizedBoundaries(frc, exp, isSingle);
  getCachedPower(_exp);

  // normalize
  let off = <i32>clz<u64>(frc);
  frc <<= off;
  exp  -= off;

  let frc_pow = _frc_pow;
  let exp_pow = _exp_pow;

  let w_frc = umul64f(frc, frc_pow);
  let w_exp = umul64e(exp, exp_pow);

  let wp_frc = umul64f(_frc_plus, frc_pow) - 1;
  let wp_exp = umul64e(_exp, exp_pow);

  let wm_frc = umul64f(_frc_minus, frc_pow) + 1;
  let delta  = wp_frc - wm_frc;

  return genDigits(buffer, w_frc, w_exp, wp_frc, wp_exp, delta, sign);
}

function genDigits(buffer: usize, w_frc: u64, w_exp: i32, mp_frc: u64, mp_exp: i32, delta: u64, sign: i32): i32 {
  let one_exp = -mp_exp;
  let one_frc = (<u64>1) << one_exp;
  let mask    = one_frc - 1;

  let wp_w_frc = mp_frc - w_frc;

  let p1 = u32(mp_frc >> one_exp);
  let p2 = mp_frc & mask;

  let kappa = <i32>decimalCount32(p1);
  let len = sign;

  while (kappa > 0) {
    let d: u32;
    switch (kappa) {
      case 10: { d = p1 / 1000000000; p1 %= 1000000000; break; }
      case  9: { d = p1 /  100000000; p1 %=  100000000; break; }
      case  8: { d = p1 /   10000000; p1 %=   10000000; break; }
      case  7: { d = p1 /    1000000; p1 %=    1000000; break; }
      case  6: { d = p1 /     100000; p1 %=     100000; break; }
      case  5: { d = p1 /      10000; p1 %=      10000; break; }
      case  4: { d = p1 /       1000; p1 %=       1000; break; }
      case  3: { d = p1 /        100; p1 %=        100; break; }
      case  2: { d = p1 /         10; p1 %=         10; break; }
      case  1: { d = p1;              p1 =           0; break; }
      default: { d = 0; break; }
    }

    if (d | len) store<u16>(buffer + (len++ << 1), CharCode._0 + <u16>d);

    --kappa;
    let tmp = ((<u64>p1) << one_exp) + p2;
    if (tmp <= delta) {
      _K += kappa;
      grisuRound(buffer, len, delta, tmp, <u64>load<u32>(POWERS10 + (<usize>kappa << alignof<u32>())) << one_exp, wp_w_frc);
      return len;
    }
  }

  while (true) {
    p2    *= 10;
    delta *= 10;

    let d = p2 >> one_exp;
    if (d | len) store<u16>(buffer + (len++ << 1), CharCode._0 + <u16>d);

    p2 &= mask;
    --kappa;
    if (p2 < delta) {
      _K += kappa;
      wp_w_frc *= <u64>load<u32>(POWERS10 + (<usize>-kappa << alignof<u32>()));
      grisuRound(buffer, len, delta, p2, one_frc, wp_w_frc);
      return len;
    }
  }
}

// @ts-ignore: decorator
@inline
function genExponent(buffer: usize, k: i32): i32 {
  let sign = k < 0;
  if (sign) k = -k;
  let decimals = decimalCount32(k) + 1;
  utoa32_dec_core(buffer, k, decimals);
  store<u16>(buffer, <u16>select<u32>(CharCode.MINUS, CharCode.PLUS, sign));
  return decimals;
}

function prettify(buffer: usize, length: i32, k: i32): i32 {
  if (!k) {
    store<u32>(buffer + (length << 1), CharCode.DOT | (CharCode._0 << 16));
    return length + 2;
  }

  let kk = length + k;
  if (length <= kk && kk <= 21) {
    // 1234e7 -> 12340000000
    for (let i = length; i < kk; ++i) {
      store<u16>(buffer + (i << 1), CharCode._0);
    }
    store<u32>(buffer + (kk << 1), CharCode.DOT | (CharCode._0 << 16));
    return kk + 2;
  } else if (kk > 0 && kk <= 21) {
    // 1234e-2 -> 12.34
    let ptr = buffer + (kk << 1);
    memory.copy(
      ptr + 2,
      ptr,
      -k << 1
    );
    store<u16>(buffer + (kk << 1), CharCode.DOT);
    return length + 1;
  } else if (-6 < kk && kk <= 0) {
    // 1234e-6 -> 0.001234
    let offset = 2 - kk;
    memory.copy(
      buffer + (offset << 1),
      buffer,
      length << 1
    );
    store<u32>(buffer, CharCode._0 | (CharCode.DOT << 16));
    for (let i = 2; i < offset; ++i) {
      store<u16>(buffer + (i << 1), CharCode._0);
    }
    return length + offset;
  } else if (length == 1) {
    // 1e30
    store<u16>(buffer, CharCode.e, 2);
    length = genExponent(buffer + 4, kk - 1);
    return length + 2;
  } else {
    let len = length << 1;
    memory.copy(
      buffer + 4,
      buffer + 2,
      len - 2
    );
    store<u16>(buffer,       CharCode.DOT, 2);
    store<u16>(buffer + len, CharCode.e,   2);
    length += genExponent(buffer + len + 4, kk - 1);
    return length + 2;
  }
}

function dtoa_core(buffer: usize, value: f64, isSingle: bool): i32 {
  let sign = i32(value < 0);
  if (sign) {
    value = -value;
    store<u16>(buffer, CharCode.MINUS);
  }
  // assert(value > 0 && value <= (isSingle ? f32.MAX_VALUE : f64.MAX_VALUE));
  let len = grisu2(value, buffer, sign, isSingle);
  len = prettify(buffer + (sign << 1), len - sign, _K);
  return len + sign;
}

// @ts-ignore: decorator
@lazy @inline const dtoa_buf = memory.data(MAX_DOUBLE_LENGTH << 1);

export function dtoa<T extends number>(value: T): String {
  const isSingle = isFloat<T>() && sizeof<T>() == 4;
  return dtoa_impl(value, isSingle);
}

// @ts-ignore: decorator
@inline
function dtoa_impl(value: f64, isSingle: bool): String {
  if (value == 0) return "0.0";
  if (!isFinite(value)) {
    if (isNaN(value)) return "NaN";
    return select<String>("-Infinity", "Infinity", value < 0);
  }
  let size = dtoa_core(dtoa_buf, value, isSingle) << 1;
  let result = changetype<String>(__new(size, idof<String>()));
  memory.copy(changetype<usize>(result), dtoa_buf, size);
  return result;
}

export function itoa_buffered<T extends number>(buffer: usize, value: T): u32 {
  let sign: u32 = 0;
  if (isSigned<T>()) {
    sign = u32(value < 0);
    if (sign) {
      if (sizeof<T>() == 1) {
        if (value == -0x80) {
          // -0x80  ->  -128
          store<u64>(buffer,
            <u64>CharCode.MINUS |
            <u64>(CharCode._0 + 1) << 16 |
            <u64>(CharCode._0 + 2) << 32 |
            <u64>(CharCode._0 + 8) << 48
          );
          return 4;
        }
      }
      if (sizeof<T>() == 2) {
        if (value == -0x8000) {
          // -0x8000  ->  -32768
          store<u64>(buffer,
            <u64>CharCode.MINUS |
            <u64>(CharCode._0 + 3) << 16 |
            <u64>(CharCode._0 + 2) << 32 |
            <u64>(CharCode._0 + 7) << 48
          ); // -327
          store<u32>(buffer + 8,
            (CharCode._0 + 6) << 0 |
            (CharCode._0 + 8) << 16
          ); // 68
          return 6;
        }
      }
      store<u16>(buffer, CharCode.MINUS);
      // @ts-ignore
      value = -value;
    }
  }
  let dest = buffer + (sign << 1);
  if (ASC_SHRINK_LEVEL <= 1) {
    if (isSigned<T>()) {
      if (sizeof<T>() <= 4) {
        if (<u32>value < 10) {
          store<u16>(dest, value | CharCode._0);
          return 1 + sign;
        }
      } else {
        if (<u64>value < 10) {
          store<u16>(dest, value | CharCode._0);
          return 1 + sign;
        }
      }
    } else {
      if (value < 10) {
        store<u16>(buffer, value | CharCode._0);
        return 1;
      }
    }
  }
  let decimals: u32 = 0;
  if (sizeof<T>() <= 4) {
    let val32 = <u32>value;
    decimals = decimalCount32(val32);
    utoa32_dec_core(dest, val32, decimals);
  } else {
    if (<u64>value <= <u64>u32.MAX_VALUE) {
      let val32 = <u32>value;
      decimals = decimalCount32(val32);
      utoa32_dec_core(dest, val32, decimals);
    } else {
      let val64 = <u64>value;
      decimals = decimalCount64High(val64);
      utoa64_dec_core(dest, val64, decimals);
    }
  }
  return sign + decimals;
}

export function dtoa_buffered<T extends number>(buffer: usize, value: T): u32 {
  const isSingle = isFloat<T>() && sizeof<T>() == 4;
  return dtoa_buffered_impl(buffer, value, isSingle);
}

// @ts-ignore: decorator
@inline
function dtoa_buffered_impl(buffer: usize, value: f64, isSingle: bool): u32 {
  if (value == 0) {
    store<u16>(buffer, CharCode._0);
    store<u16>(buffer, CharCode.DOT, 2);
    store<u16>(buffer, CharCode._0,  4);
    return 3;
  }
  if (!isFinite(value)) {
    if (isNaN(value)) {
      store<u16>(buffer, CharCode.N);
      store<u16>(buffer, CharCode.a, 2);
      store<u16>(buffer, CharCode.N, 4);
      return 3;
    } else {
      let sign = value < 0;
      if (sign) {
        store<u16>(buffer, CharCode.MINUS); // -
        buffer += 2;
      }
      store<u64>(buffer, 0x690066006E0049, 0); // ifnI
      store<u64>(buffer, 0x7900740069006E, 8); // ytin
      return 8 + u32(sign);
    }
  }
  return dtoa_core(buffer, value, isSingle);
}
`,"util/sort":`import { compareImpl } from "./string";

type Comparator<T> = (a: T, b: T) => i32;

// @ts-ignore: decorator
@lazy @inline const EMPTY = u32.MAX_VALUE;
// @ts-ignore: decorator
@inline const INSERTION_SORT_THRESHOLD = 48;
// @ts-ignore: decorator
@inline const MIN_RUN_LENGTH = 32;

// @ts-ignore: decorator
@inline
function log2u(n: u32): u32 {
  return 31 - clz(n);
}

// @ts-ignore: decorator
@inline
export function COMPARATOR<T>(): Comparator<T> {
  if (isInteger<T>()) {
    if (isSigned<T>() && sizeof<T>() <= 4) {
      return (a, b) => i32(a) - i32(b);
    } else {
      return (a, b) => i32(a > b) - i32(a < b);
    }
  } else if (isFloat<T>()) {
    if (sizeof<T>() == 4) {
      return (a, b) => {
        let ia = reinterpret<i32>(f32(a));
        let ib = reinterpret<i32>(f32(b));
        ia ^= ia >> 31 >>> 1;
        ib ^= ib >> 31 >>> 1;
        return i32(ia > ib) - i32(ia < ib);
      };
    } else {
      return (a, b) => {
        let ia = reinterpret<i64>(f64(a));
        let ib = reinterpret<i64>(f64(b));
        ia ^= ia >> 63 >>> 1;
        ib ^= ib >> 63 >>> 1;
        return i32(ia > ib) - i32(ia < ib);
      };
    }
  } else if (isString<T>()) {
    return (a, b) => {
      if (
        changetype<usize>(a) == changetype<usize>(b) ||
        changetype<usize>(a) == 0 ||
        changetype<usize>(b) == 0
      ) return 0;
      let alen = changetype<string>(a).length;
      let blen = changetype<string>(b).length;
      if (!(alen | blen)) return 0;
      if (!alen) return -1;
      if (!blen) return  1;
      let res = compareImpl(
        changetype<string>(a), 0,
        changetype<string>(b), 0,
        <usize>min(alen, blen)
      );
      return res ? res : alen - blen;
    };
  } else {
    return (a, b) => i32(a > b) - i32(a < b);
  }
}

// Power Sort implementation (stable) from paper "Nearly-Optimal Mergesorts"
// https://arxiv.org/pdf/1805.04154.pdf
// This method usually outperform TimSort.
// TODO: refactor c >>> 31 to c < 0 when binaryen will support this opt
export function SORT<T>(
  ptr: usize,
  len: i32,
  comparator: Comparator<T>
): void {
  if (len <= INSERTION_SORT_THRESHOLD) {
    if (len <= 1) return;
    if (ASC_SHRINK_LEVEL < 1) {
      switch (len) {
        case 3: {
          let a = load<T>(ptr, 0);
          let b = load<T>(ptr, 1 << alignof<T>());
          let c = comparator(a, b) > 0;
          store<T>(ptr, select<T>(b, a, c), 0);
          a = select<T>(a, b, c);
          b = load<T>(ptr, 2 << alignof<T>());
          c = comparator(a, b) > 0;
          store<T>(ptr, select<T>(b, a, c), 1 << alignof<T>());
          store<T>(ptr, select<T>(a, b, c), 2 << alignof<T>());
        }
        case 2: {
          let a = load<T>(ptr, 0);
          let b = load<T>(ptr, 1 << alignof<T>());
          let c = comparator(a, b) > 0;
          store<T>(ptr, select<T>(b, a, c), 0);
          store<T>(ptr, select<T>(a, b, c), 1 << alignof<T>());
          return;
        }
      }
    }
    insertionSort<T>(ptr, 0, len - 1, 0, comparator);
    return;
  }

  let lgPlus2         = log2u(len) + 2;
  let lgPlus2Size     = lgPlus2 << alignof<u32>();
  let leftRunStartBuf = __alloc(lgPlus2Size << 1);
  let leftRunEndBuf   = leftRunStartBuf + lgPlus2Size;

  for (let i: u32 = 0; i < lgPlus2; ++i) {
    store<u32>(leftRunStartBuf + (<usize>i << alignof<u32>()), EMPTY);
  }

  let buffer = __alloc(len << alignof<T>());

  let hi   = len - 1;
  let endA = extendRunRight<T>(ptr, 0, hi, comparator);
  let lenA = endA + 1;

  if (lenA < MIN_RUN_LENGTH) {
    endA = min(hi, MIN_RUN_LENGTH - 1);
    insertionSort<T>(ptr, 0, endA, lenA, comparator);
  }

  let top: u32 = 0, startA = 0;
  while (endA < hi) {
    let startB = endA + 1;
    let endB = extendRunRight<T>(ptr, startB, hi, comparator);
    let lenB = endB - startB + 1;

    if (lenB < MIN_RUN_LENGTH) {
      endB = min(hi, startB + MIN_RUN_LENGTH - 1);
      insertionSort<T>(ptr, startB, endB, lenB, comparator);
    }

    let k = nodePower(0, hi, startA, startB, endB);

    for (let i = top; i > k; --i) {
      let start = load<u32>(leftRunStartBuf + (<usize>i << alignof<u32>()));
      if (start != EMPTY) {
        mergeRuns<T>(
          ptr,
          start,
          load<u32>(leftRunEndBuf + (<usize>i << alignof<u32>())) + 1,
          endA,
          buffer,
          comparator
        );
        startA = start;
        store<u32>(leftRunStartBuf + (<usize>i << alignof<u32>()), EMPTY);
      }
    }

    store<u32>(leftRunStartBuf + (<usize>k << alignof<u32>()), startA);
    store<u32>(leftRunEndBuf   + (<usize>k << alignof<u32>()), endA);
    startA = startB;
    endA = endB;
    top = k;
  }

  for (let i = top; i != 0; --i) {
    let start = load<u32>(leftRunStartBuf + (<usize>i << alignof<u32>()));
    if (start != EMPTY) {
      mergeRuns<T>(
        ptr,
        start,
        load<u32>(leftRunEndBuf + (<usize>i << alignof<u32>())) + 1,
        hi,
        buffer,
        comparator
      );
    }
  }
  // dealloc aux buffers
  __free(buffer);
  __free(leftRunStartBuf);
}

function insertionSort<T>(
  ptr: usize,
  left: i32,
  right: i32,
  presorted: i32,
  comparator: Comparator<T>
): void {
  if (ASC_SHRINK_LEVEL >= 1) {
    // slightly improved original insertion sort
    for (let i = left + presorted; i <= right; ++i) {
      let j = i - 1;
      let a = load<T>(ptr + (<usize>i << alignof<T>()));
      while (j >= left) {
        let b = load<T>(ptr + (<usize>j << alignof<T>()));
        if (comparator(a, b) < 0) {
          store<T>(ptr + (<usize>j << alignof<T>()), b, 1 << alignof<T>()); --j;
        } else break;
      }
      store<T>(ptr + (<usize>j << alignof<T>()), a, 1 << alignof<T>());
    }
  } else {
    // even-odd two-way insertion sort which allow increase minRunLen
    let range = right - left + 1;
    let i = left + select(range & 1, presorted - ((range - presorted) & 1), presorted == 0);
    for (; i <= right; i += 2) {
      let a = load<T>(ptr + (<usize>i << alignof<T>()), 0);
      let b = load<T>(ptr + (<usize>i << alignof<T>()), 1 << alignof<T>());
      let min = b, max = a;
      if (comparator(a, b) <= 0) {
        min = a, max = b;
      }
      let j = i - 1;
      while (j >= left) {
        a = load<T>(ptr + (<usize>j << alignof<T>()));
        if (comparator(a, max) > 0) {
          store<T>(ptr + (<usize>j << alignof<T>()), a, 2 << alignof<T>()); --j;
        } else break;
      }
      store<T>(ptr + (<usize>j << alignof<T>()), max, 2 << alignof<T>());
      while (j >= left) {
        a = load<T>(ptr + (<usize>j << alignof<T>()));
        if (comparator(a, min) > 0) {
          store<T>(ptr + (<usize>j << alignof<T>()), a, 1 << alignof<T>()); --j;
        } else break;
      }
      store<T>(ptr + (<usize>j << alignof<T>()), min, 1 << alignof<T>());
    }
  }
}

function nodePower(left: u32, right: u32, startA: u32, startB: u32, endB: u32): u32 {
  let n: u64 = right - left + 1;
  let s = startB - (left << 1);
  let l = startA + s;
  let r = endB   + s + 1;
  let a = (<u64>l << 30) / n;
  let b = (<u64>r << 30) / n;
  return clz(<u32>(a ^ b));
}

function extendRunRight<T>(
  ptr: usize,
  i: i32,
  right: i32,
  comparator: Comparator<T>
): i32 {
  if (i == right) return i;
  let j = i;
  if (comparator(
    load<T>(ptr + (<usize>  j << alignof<T>())),
    load<T>(ptr + (<usize>++j << alignof<T>()))
  ) > 0) {
    while (
      j < right &&
      (comparator(
        load<T>(ptr + (<usize>j << alignof<T>()), 1 << alignof<T>()),
        load<T>(ptr + (<usize>j << alignof<T>()))
      ) >>> 31) // < 0
    ) ++j;
    // reverse
    let k = j;
    while (i < k) {
      let tmp = load<T>(ptr + (<usize>i << alignof<T>()));
      store<T>(ptr + (<usize>i << alignof<T>()), load<T>(ptr + (<usize>k << alignof<T>()))); ++i;
      store<T>(ptr + (<usize>k << alignof<T>()), tmp); --k;
    }
  } else {
    while (
      j < right &&
      comparator(
        load<T>(ptr + (<usize>j << alignof<T>()), 1 << alignof<T>()),
        load<T>(ptr + (<usize>j << alignof<T>()))
      ) >= 0
    ) ++j;
  }
  return j;
}

// Merges arr[l..m - 1] and arr[m..r]
function mergeRuns<T>(
  ptr: usize,
  l: i32,
  m: i32,
  r: i32,
  buffer: usize,
  comparator: Comparator<T>
): void {
  --m;
  let i: i32, j: i32, t = r + m;
  for (i = m + 1; i > l; --i) {
    store<T>(
      buffer + (<usize>(i - 1) << alignof<T>()),
      load<T>(ptr + (<usize>(i - 1) << alignof<T>()))
    );
  }
  for (j = m; j < r; ++j) {
    store<T>(
      buffer + (<usize>(t - j) << alignof<T>()),
      load<T>(ptr + (<usize>j << alignof<T>()), 1 << alignof<T>())
    );
  }
  for (let k = l; k <= r; ++k) {
    let a = load<T>(buffer + (<usize>j << alignof<T>()));
    let b = load<T>(buffer + (<usize>i << alignof<T>()));
    if (comparator(a, b) < 0) {
      store<T>(ptr + (<usize>k << alignof<T>()), a);
      --j;
    } else {
      store<T>(ptr + (<usize>k << alignof<T>()), b);
      ++i;
    }
  }
}
`,"util/string":`import {
  itoa32,
  utoa32,
  itoa64,
  utoa64,
  dtoa,
  itoa_buffered,
  dtoa_buffered,
  MAX_DOUBLE_LENGTH
} from "./number";

import {
  ipow32
} from "../math";

// All tables are stored as two staged lookup tables (static tries)
// because the full range of Unicode symbols can't be efficiently
// represented as-is in memory (see Unicode spec ch 5, p.196):
// https://www.unicode.org/versions/Unicode12.0.0/ch05.pdf
// Tables have been generated using these forked musl tools:
// https://github.com/MaxGraey/musl-chartable-tools/tree/case-ignorable

// Lookup table to check if a character is alphanumeric or not
// See: https://git.musl-libc.org/cgit/musl/tree/src/ctype/alpha.h
// size: 3904 bytes
// @ts-ignore
@inline @lazy const ALPHA_TABLE = memory.data<u8>([
  18,17,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,17,34,35,36,17,37,38,39,40,
  41,42,43,44,17,45,46,47,16,16,48,16,16,16,16,16,16,16,49,50,51,16,52,53,16,16,
  17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,54,
  17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,
  17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,
  17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,
  17,17,17,55,17,17,17,17,56,17,57,58,59,60,61,62,17,17,17,17,17,17,17,17,17,17,
  17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,
  17,17,17,17,17,17,17,63,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,17,64,65,17,66,67,
  68,69,70,71,72,73,74,17,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,
  93,94,16,95,96,97,98,17,17,17,99,100,101,16,16,16,16,16,16,16,16,16,16,17,17,
  17,17,102,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,17,17,103,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,17,17,104,105,16,16,106,107,17,17,17,17,17,17,17,17,17,17,17,17,17,
  17,17,17,17,17,17,17,17,17,17,108,17,17,17,17,109,110,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  17,111,112,16,16,16,16,16,16,16,16,16,113,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,114,115,116,117,16,16,16,16,16,16,16,16,118,
  119,120,16,16,16,16,16,121,122,16,16,16,16,123,16,16,124,16,16,16,16,16,16,16,
  16,16,125,16,16,16,
  16,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,255,
  255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255,0,0,0,0,0,0,0,0,254,255,255,7,254,
  255,255,7,0,0,0,0,0,4,32,4,255,255,127,255,255,255,127,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  255,195,255,3,0,31,80,0,0,0,0,0,0,0,0,0,0,32,0,0,0,0,0,223,188,64,215,255,255,
  251,255,255,255,255,255,255,255,255,255,191,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,3,252,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255,254,255,255,255,127,2,255,255,255,
  255,255,1,0,0,0,0,255,191,182,0,255,255,255,135,7,0,0,0,255,7,255,255,255,255,
  255,255,255,254,255,195,255,255,255,255,255,255,255,255,255,255,255,255,239,
  31,254,225,255,
  159,0,0,255,255,255,255,255,255,0,224,255,255,255,255,255,255,255,255,255,255,
  255,255,3,0,255,255,255,255,255,7,48,4,255,255,255,252,255,31,0,0,255,255,255,
  1,255,7,0,0,0,0,0,0,255,255,223,255,255,0,240,255,248,3,255,255,255,255,255,
  255,255,255,255,239,255,223,225,255,207,255,254,255,239,159,249,255,255,253,
  197,227,159,89,128,176,207,255,3,16,238,135,249,255,255,253,109,195,135,25,2,
  94,192,255,63,0,238,191,251,255,255,253,237,227,191,27,1,0,207,255,0,30,238,
  159,249,255,255,253,237,227,159,25,192,176,207,255,2,0,236,199,61,214,24,199,
  255,195,199,29,129,0,192,255,0,0,239,223,253,255,255,253,255,227,223,29,96,7,
  207,255,0,0,239,223,253,255,255,253,239,227,223,29,96,64,207,255,6,0,255,223,
  253,255,255,255,255,231,223,93,240,128,207,255,0,252,238,255,127,252,255,255,
  251,47,127,128,95,255,192,255,12,0,254,255,255,255,255,127,255,7,63,32,255,3,
  0,0,0,0,214,247,255,255,175,255,255,59,95,32,255,243,0,0,0,
  0,1,0,0,0,255,3,0,0,255,254,255,255,255,31,254,255,3,255,255,254,255,255,255,
  31,0,0,0,0,0,0,0,0,255,255,255,255,255,255,127,249,255,3,255,255,255,255,255,
  255,255,255,255,63,255,255,255,255,191,32,255,255,255,255,255,247,255,255,255,
  255,255,255,255,255,255,61,127,61,255,255,255,255,255,61,255,255,255,255,61,
  127,61,255,127,255,255,255,255,255,255,255,61,255,255,255,255,255,255,255,255,
  7,0,0,0,0,255,255,0,0,255,255,255,255,255,255,255,255,255,255,63,63,254,255,
  255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,159,255,255,254,255,255,7,255,255,255,255,255,255,255,255,
  255,199,255,1,255,223,15,0,255,255,15,0,255,255,15,0,255,223,13,0,255,255,255,
  255,255,255,207,255,255,1,128,16,255,3,0,0,0,0,255,3,255,255,255,255,255,255,
  255,255,255,255,255,1,255,255,255,255,255,7,255,255,255,255,255,255,255,255,
  63,
  0,255,255,255,127,255,15,255,1,192,255,255,255,255,63,31,0,255,255,255,255,
  255,15,255,255,255,3,255,3,0,0,0,0,255,255,255,15,255,255,255,255,255,255,255,
  127,254,255,31,0,255,3,255,3,128,0,0,128,1,0,0,0,0,0,0,0,255,255,255,255,255,
  255,239,255,239,15,255,3,0,0,0,0,255,255,255,255,255,243,255,255,255,255,255,
  255,191,255,3,0,255,255,255,255,255,255,127,0,255,227,255,255,255,255,255,63,
  255,1,255,255,255,255,255,231,0,0,0,0,0,222,111,4,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,0,0,0,0,
  128,255,31,0,255,255,63,63,255,255,255,255,63,63,255,170,255,255,255,63,255,
  255,255,255,255,255,223,95,220,31,207,15,255,31,220,31,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,2,128,0,0,255,31,0,0,0,0,0,0,0,0,0,0,0,0,132,252,47,62,80,189,255,243,
  224,67,0,0,255,255,255,255,255,1,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,192,255,255,255,255,255,255,3,0,
  0,255,255,255,255,255,127,255,255,255,255,255,127,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,31,120,12,0,255,255,255,255,191,32,255,
  255,255,255,255,255,255,128,0,0,255,255,127,0,127,127,127,127,127,127,127,127,
  255,255,255,255,0,0,0,0,0,128,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,224,0,0,0,254,3,62,31,254,255,255,255,255,255,255,255,255,255,127,224,254,
  255,255,255,255,255,255,255,255,255,255,247,224,255,255,255,255,255,254,255,
  255,255,255,255,255,255,255,255,255,127,0,0,255,255,255,255,0,0,0,0,0,0,255,
  255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,0,0,0,0,0,0,0,0,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,
  31,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,31,0,0,
  0,0,0,0,0,0,255,255,255,255,255,63,255,31,255,255,255,15,0,0,255,255,255,255,
  255,127,240,143,255,255,255,255,255,255,255,255,255,255,255,255,255,255,0,0,0,
  0,128,255,252,255,255,255,255,255,255,255,255,255,255,255,255,249,255,255,255,
  255,255,255,252,7,0,0,0,0,224,255,191,255,255,255,255,0,0,0,255,255,255,255,
  255,255,15,0,255,255,255,255,255,255,255,255,47,0,255,3,0,0,252,232,255,255,
  255,255,255,7,255,255,255,255,7,0,255,255,255,31,255,255,255,255,255,255,247,
  255,0,128,255,3,255,255,255,127,255,255,255,255,255,255,127,0,255,63,255,3,
  255,255,127,252,255,255,255,255,255,255,255,127,5,0,0,56,255,255,60,0,126,126,
  126,0,127,127,255,255,255,255,255,247,255,3,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,7,255,3,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,15,0,255,255,127,248,255,255,255,255,
  255,
  15,255,255,255,255,255,255,255,255,255,255,255,255,255,63,255,255,255,255,255,
  255,255,255,255,255,255,255,255,3,0,0,0,0,127,0,248,224,255,253,127,95,219,
  255,255,255,255,255,255,255,255,255,255,255,255,255,3,0,0,0,248,255,255,255,
  255,255,255,255,255,255,255,255,255,63,0,0,255,255,255,255,255,255,255,255,
  252,255,255,255,255,255,255,0,0,0,0,0,255,15,0,0,0,0,0,0,0,0,0,0,0,0,0,0,223,
  255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,31,0,0,255,3,
  254,255,255,7,254,255,255,7,192,255,255,255,255,255,255,255,255,255,255,127,
  252,252,252,28,0,0,0,0,255,239,255,255,127,255,255,183,255,63,255,63,0,0,0,0,
  255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,7,0,0,0,0,0,0,0,0,
  255,255,255,255,255,255,31,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,255,255,255,31,255,255,255,255,255,255,1,0,0,0,0,
  0,255,255,255,255,0,224,255,255,255,7,255,255,255,255,255,7,255,255,255,63,
  255,255,255,255,15,255,62,0,0,0,0,0,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,63,255,3,255,255,255,255,15,255,255,255,
  255,15,255,255,255,255,255,0,255,255,255,255,255,255,15,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,255,255,255,255,255,255,127,0,255,255,63,0,255,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,63,253,255,255,255,255,191,145,255,255,63,0,255,255,
  127,0,255,255,255,127,0,0,0,0,0,0,0,0,255,255,55,0,255,255,63,0,255,255,255,3,
  0,0,0,0,0,0,0,0,255,255,255,255,255,255,255,192,0,0,0,0,0,0,0,0,111,240,239,
  254,255,255,63,0,0,0,0,0,255,255,255,31,255,255,255,31,0,0,0,0,255,254,255,
  255,31,0,0,0,255,255,255,255,255,255,63,0,255,255,63,0,255,255,7,0,255,255,3,
  0,0,0,0,0,0,0,0,0,0,0,0,
  0,255,255,255,255,255,255,255,255,255,1,0,0,0,0,0,0,255,255,255,255,255,255,7,
  0,255,255,255,255,255,255,7,0,255,255,255,255,255,0,255,3,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,255,255,255,
  255,27,3,0,0,0,0,0,0,0,0,0,255,255,255,31,128,0,255,255,63,0,0,0,0,0,0,0,0,0,
  0,0,0,0,255,255,31,0,0,0,255,255,127,0,255,255,255,255,255,255,255,255,63,0,0,
  0,192,255,0,0,252,255,255,255,255,255,255,1,0,0,255,255,255,1,255,3,255,255,
  255,255,255,255,199,255,240,0,255,255,255,255,71,0,255,255,255,255,255,255,
  255,255,30,192,255,23,0,0,0,0,255,255,251,255,255,255,159,64,0,0,0,0,0,0,0,0,
  127,189,255,191,255,1,255,255,255,255,255,255,255,1,255,3,239,159,249,255,255,
  253,237,227,159,25,129,224,15,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,255,255,255,255,255,255,255,255,187,7,255,131,3,0,0,0,255,255,255,255,255,
  255,255,255,179,0,255,3,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,255,255,
  255,255,255,63,127,0,0,0,63,0,0,0,0,255,255,255,255,255,255,255,127,17,0,255,
  3,0,0,0,0,255,255,255,255,255,255,63,1,255,3,0,0,0,0,0,0,255,255,255,231,255,
  7,255,3,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,255,255,255,255,
  255,255,1,0,0,0,0,0,0,0,0,0,0,0,0,255,255,255,255,255,255,255,255,255,3,0,128,
  127,242,111,255,255,255,191,153,7,0,255,3,0,0,0,0,0,0,0,0,255,252,255,255,255,
  255,255,252,26,0,0,0,255,255,255,255,255,255,231,127,0,0,255,255,255,255,255,
  255,255,255,255,32,0,0,0,0,255,255,255,255,255,255,255,1,255,253,255,255,255,
  255,127,127,1,0,255,3,0,0,252,255,255,255,252,255,255,254,127,0,0,0,0,0,0,0,0,
  0,127,251,255,255,255,255,127,180,203,0,255,3,191,253,255,255,255,127,123,1,
  255,3,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,255,255,127,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,
  0,0,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  255,3,0,0,0,0,0,0,0,0,0,0,0,0,255,255,255,255,255,255,255,255,255,255,255,255,
  255,127,0,0,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,15,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,255,255,255,255,255,127,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,255,255,255,255,255,255,255,255,127,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,
  0,255,255,255,255,255,255,255,1,255,255,255,127,255,3,0,0,0,0,0,0,0,0,0,0,0,0,
  255,255,255,63,0,0,255,255,255,255,255,255,0,0,15,0,255,3,248,255,255,224,255,
  255,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,255,255,255,255,255,255,
  255,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,255,255,255,255,255,255,255,255,135,
  255,255,255,255,255,255,255,128,255,255,0,0,0,0,0,0,0,0,11,0,3,0,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,0,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,63,0,0,0,0,0,
  255,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,255,255,
  127,0,0,0,0,0,0,7,0,240,0,255,255,255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255,255,255,15,255,255,255,255,255,
  255,255,255,255,255,255,255,255,7,255,31,255,1,255,67,0,0,0,0,0,0,0,0,0,0,0,0,
  255,255,255,255,255,255,255,255,255,255,223,255,255,255,255,255,255,255,255,
  223,100,222,255,235,239,255,255,255,255,255,255,255,191,231,223,223,255,255,
  255,123,95,252,253,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,63,255,255,255,253,255,255,247,255,255,255,
  247,255,255,223,255,255,255,223,255,255,127,255,255,255,127,255,255,255,253,
  255,255,255,253,255,255,247,207,255,255,255,255,255,255,127,255,255,249,219,7,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,255,255,255,255,31,
  128,63,255,67,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,255,255,255,255,15,255,
  3,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,31,0,0,0,0,0,0,0,255,255,255,255,255,255,255,255,143,8,
  255,3,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,239,255,255,255,150,254,247,10,
  132,234,150,170,150,247,247,94,255,251,255,15,238,251,255,15,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,255,255,255,3,255,255,255,3,255,255,255,3,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,3
]);

// size: 1568 bytes (compressed to ~1380 bytes after binaryen)
// @ts-ignore: decorator
@lazy @inline const CASED = memory.data<u8>([
  18,19,20,21,22,23,16,16,16,16,16,16,16,16,16,16,
  24,16,16,25,16,16,16,16,16,16,16,16,26,27,17,28,
  29,30,16,16,31,16,16,16,16,16,16,16,32,33,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,34,35,16,16,16,36,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,37,16,16,16,38,
  16,16,16,16,39,16,16,16,16,16,16,16,40,16,16,16,
  16,16,16,16,16,16,16,16,41,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,42,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,43,44,45,46,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,47,16,16,16,16,16,16,
  16,48,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  0,0,0,0,0,0,0,0,254,255,255,7,254,255,255,7,0,0,0,0,0,4,32,4,
  255,255,127,255,255,255,127,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,247,240,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,239,255,255,255,255,1,3,0,0,0,31,0,0,0,
  0,0,0,0,0,0,0,0,32,0,0,0,0,0,207,188,64,215,255,255,251,255,255,255,
  255,255,255,255,255,255,191,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  3,252,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,254,255,
  255,255,127,0,255,255,255,255,255,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,255,255,255,
  191,32,255,255,255,255,255,231,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,255,255,255,255,255,255,255,255,255,255,63,63,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,255,1,255,255,255,255,255,231,0,0,0,0,0,0,0,0,
  255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  0,0,0,0,0,0,0,0,255,255,63,63,255,255,255,255,63,63,255,170,255,255,255,63,
  255,255,255,255,255,255,223,95,220,31,207,15,255,31,220,31,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,2,128,0,0,255,31,0,0,0,0,0,0,0,0,0,0,0,0,
  132,252,47,62,80,189,31,242,224,67,0,0,255,255,255,255,24,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,192,255,255,255,255,255,255,3,0,0,255,255,255,255,255,127,255,255,
  255,255,255,127,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,31,120,12,0,
  255,255,255,255,191,32,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,255,255,255,255,63,0,0,
  255,255,255,63,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,252,255,255,255,
  255,255,255,255,255,255,255,255,255,120,255,255,255,255,255,255,252,7,0,0,0,0,96,7,
  0,0,0,0,0,0,255,255,255,255,255,247,255,1,255,255,255,255,255,255,255,255,255,255,
  0,0,0,0,0,0,0,0,127,0,248,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,254,255,255,7,
  254,255,255,7,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  255,255,255,255,255,255,255,255,255,255,0,0,0,0,0,0,0,0,0,0,0,0,255,255,
  255,255,15,255,255,255,255,15,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  255,255,255,255,255,255,7,0,255,255,255,255,255,255,7,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,255,255,255,255,255,255,255,255,0,0,0,0,
  0,0,0,0,0,0,0,0,255,255,255,255,255,255,255,255,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,255,255,255,255,255,255,255,255,255,255,223,255,255,255,255,255,
  255,255,255,223,100,222,255,235,239,255,255,255,255,255,255,255,191,231,223,223,255,255,255,123,
  95,252,253,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,63,255,255,255,
  253,255,255,247,255,255,255,247,255,255,223,255,255,255,223,255,255,127,255,255,255,127,255,255,
  255,253,255,255,255,253,255,255,247,15,0,0,0,0,0,0,255,255,255,255,255,255,255,255,
  15,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,255,255,255,3,255,255,255,3,255,255,255,3,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0
]);

// size: 2976 bytes (compressed to ~2050 bytes after binaryen)
// @ts-ignore: decorator
@lazy @inline const CASE_IGNORABLES = memory.data<u8>([
  18,16,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
  33,16,16,34,16,16,16,35,36,37,38,39,40,41,16,42,
  43,16,16,16,16,16,16,16,16,16,16,16,44,45,46,16,
  47,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  48,16,16,16,49,16,50,51,52,53,54,55,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,56,16,16,57,58,
  16,59,60,61,16,16,16,16,16,16,62,16,16,63,64,65,
  66,67,68,69,70,71,72,73,74,75,76,16,77,78,79,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,80,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,81,82,16,16,16,83,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,84,16,16,16,
  16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
  16,85,86,16,16,16,16,16,16,16,87,16,16,16,16,16,
  88,89,90,16,16,16,16,16,91,92,16,16,16,16,16,16,
  16,16,16,93,16,16,16,16,16,16,16,16,16,16,16,16,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  0,0,0,0,128,64,0,4,0,0,0,64,1,0,0,0,0,0,0,0,0,161,144,1,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,48,4,176,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,248,3,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,130,0,0,0,0,
  0,0,254,255,255,255,255,191,182,0,0,0,0,0,16,0,63,0,255,23,0,0,0,0,
  1,248,255,255,0,0,1,0,0,0,0,0,0,0,0,0,0,0,192,191,255,61,0,0,
  0,128,2,0,0,0,255,255,255,7,0,0,0,0,0,0,0,0,0,0,192,255,1,0,
  0,0,0,0,0,248,63,36,0,0,192,255,255,63,0,0,0,0,0,14,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,248,255,255,255,255,255,7,0,0,0,0,0,0,20,
  254,33,254,0,12,0,2,0,2,0,0,0,0,0,0,16,30,32,0,0,12,0,0,64,
  6,0,0,0,0,0,0,16,134,57,2,0,0,0,35,0,6,0,0,0,0,0,0,16,
  190,33,0,0,12,0,0,252,2,0,0,0,0,0,0,144,30,32,96,0,12,0,0,0,
  4,0,0,0,0,0,0,0,1,32,0,0,0,0,0,0,17,0,0,0,0,0,0,192,
  193,61,96,0,12,0,0,0,2,0,0,0,0,0,0,144,64,48,0,0,12,0,0,0,
  3,0,0,0,0,0,0,24,30,32,0,0,12,0,0,0,2,0,0,0,0,0,0,0,
  0,4,92,0,0,0,0,0,0,0,0,0,0,0,242,7,192,127,0,0,0,0,0,0,
  0,0,0,0,0,0,242,31,64,63,0,0,0,0,0,0,0,0,0,3,0,0,160,2,
  0,0,0,0,0,0,254,127,223,224,255,254,255,255,255,31,64,0,0,0,0,0,0,0,
  0,0,0,0,0,224,253,102,0,0,0,195,1,0,30,0,100,32,0,32,0,0,0,0,
  0,0,0,0,0,0,0,16,0,0,0,0,0,0,0,0,0,0,0,224,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,28,0,0,0,28,0,
  0,0,12,0,0,0,12,0,0,0,0,0,0,0,176,63,64,254,143,32,0,0,0,0,
  0,120,0,0,0,0,0,0,8,0,0,0,0,0,0,0,96,0,0,0,0,2,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,135,1,4,14,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,128,9,0,0,0,0,
  0,0,64,127,229,31,248,159,0,0,0,0,128,0,255,255,1,0,0,0,0,0,0,0,
  15,0,0,0,0,0,208,23,4,0,0,0,0,248,15,0,3,0,0,0,60,59,0,0,
  0,0,0,0,64,163,3,0,0,0,0,0,0,240,207,0,0,0,0,0,0,0,0,63,
  0,0,0,0,0,0,0,0,0,0,247,255,253,33,16,3,0,0,0,0,0,240,255,255,
  255,255,255,255,255,7,0,1,0,0,0,248,255,255,255,255,255,255,255,255,255,255,255,251,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,160,
  3,224,0,224,0,224,0,96,0,248,0,3,144,124,0,0,0,0,0,0,223,255,2,128,
  0,0,255,31,0,0,0,0,0,0,255,255,255,255,1,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,48,0,0,0,0,0,0,0,0,0,0,0,0,0,128,3,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,128,0,128,0,0,0,0,0,0,0,0,
  0,0,0,0,255,255,255,255,0,0,0,0,0,128,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,32,0,0,0,0,60,62,8,
  0,0,0,0,0,0,0,0,0,0,0,126,0,0,0,0,0,0,0,0,0,0,0,112,
  0,0,32,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,63,0,16,0,0,0,0,0,0,
  0,0,0,0,0,128,247,191,0,0,0,240,0,0,0,0,0,0,0,0,0,0,3,0,
  255,255,255,255,3,0,0,0,0,0,0,0,0,0,1,0,0,7,0,0,0,0,0,0,
  0,0,0,0,0,0,0,3,68,8,0,0,96,16,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,48,0,0,0,255,255,3,128,0,0,0,0,192,63,0,0,
  128,255,3,0,0,0,0,0,7,0,0,0,0,0,200,51,0,128,0,0,96,0,0,0,
  0,0,0,0,0,126,102,0,8,16,0,0,0,0,1,16,0,0,0,0,0,0,157,193,
  2,0,0,32,0,48,88,0,0,0,0,0,0,0,0,0,0,0,0,248,0,14,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,32,33,0,0,0,0,0,64,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,252,255,3,0,0,0,0,0,0,0,
  255,255,8,0,255,255,0,0,0,0,36,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,128,128,64,0,4,0,0,0,64,1,0,0,0,0,0,1,0,
  0,0,0,192,0,0,0,0,0,0,0,0,8,0,0,14,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,32,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,192,7,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,110,240,0,0,0,0,0,135,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,96,0,0,0,
  0,0,0,0,240,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,24,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  192,255,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  2,0,0,0,0,0,0,255,127,0,0,0,0,0,0,128,3,0,0,0,0,0,120,38,
  0,32,0,0,0,0,0,0,7,0,0,0,128,239,31,0,0,0,0,0,0,0,8,0,
  3,0,0,0,0,0,192,127,0,158,0,0,0,0,0,0,0,0,0,0,0,128,211,64,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,128,248,7,0,0,
  3,0,0,0,0,0,0,24,1,0,0,0,192,31,31,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,92,0,0,64,0,0,0,0,
  0,0,0,0,0,0,248,133,13,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,60,176,1,0,0,48,0,0,0,0,
  0,0,0,0,0,0,248,167,1,0,0,0,0,0,0,0,0,0,0,0,0,40,191,0,
  0,0,0,0,0,0,0,0,0,0,0,224,188,15,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,128,255,6,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,88,8,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,240,12,1,0,0,0,254,7,0,0,0,0,248,121,128,0,126,14,0,0,0,0,
  0,252,127,3,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,127,191,
  0,0,0,0,0,0,0,0,0,0,252,255,255,252,109,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,126,180,191,0,0,0,0,0,0,0,0,0,163,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,24,0,0,0,0,0,0,0,255,1,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,31,0,0,0,0,0,0,0,127,0,15,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,128,0,0,0,0,0,0,0,128,255,255,0,0,0,0,0,0,0,0,27,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,96,15,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,128,3,248,255,
  231,15,0,0,0,60,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  28,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  255,255,255,255,255,255,127,248,255,255,255,255,255,31,32,0,16,0,0,248,254,255,0,0,
  0,0,0,0,0,0,0,0,127,255,255,249,219,7,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,63,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,240,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,127,0,0,0,0,0,0,0,0,0,0,0,0,0,
  240,15,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,248
]);

// @ts-ignore: decorator
@lazy @inline const LOWER127 = memory.data<u8>([
  0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,
  16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,
  32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,
  48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,
  64,
  97,98,99,100,101,102,103,104,105,106,107,108,109,
  110,111,112,113,114,115,116,117,118,119,120,121,122,
  91,92,93,94,95,96,
  97,98,99,100,101,102,103,104,105,106,107,108,109,
  110,111,112,113,114,115,116,117,118,119,120,121,122,
  123,124,125,126,127
]);

// @ts-ignore: decorator
@lazy @inline const UPPER127 = memory.data<u8>([
  0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,
  16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,
  32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,
  48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,
  64,
  65,66,67,68,69,70,71,72,73,74,75,76,77,
  78,79,80,81,82,83,84,85,86,87,88,89,90,
  91,92,93,94,95,96,
  65,66,67,68,69,70,71,72,73,74,75,76,77,
  78,79,80,81,82,83,84,85,86,87,88,89,90,
  123,124,125,126,127
]);

// 23 * 8 = 184 bytes
// @ts-ignore: decorator
@lazy @inline const POWERS10 = memory.data<f64>([
  1e00, 1e01, 1e02, 1e03, 1e04, 1e05, 1e06, 1e07, 1e08, 1e09,
  1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19,
  1e20, 1e21, 1e22
]);

// @ts-ignore: decorator
@inline
export const enum CharCode {
  PERCENT = 0x25,
  PLUS = 0x2B,
  MINUS = 0x2D,
  DOT = 0x2E,
  _0 = 0x30,
  _1 = 0x31,
  _2 = 0x32,
  _3 = 0x33,
  _4 = 0x34,
  _5 = 0x35,
  _6 = 0x36,
  _7 = 0x37,
  _8 = 0x38,
  _9 = 0x39,
  A = 0x41,
  B = 0x42,
  E = 0x45,
  I = 0x49,
  N = 0x4E,
  O = 0x4F,
  X = 0x58,
  Z = 0x5A,
  a = 0x61,
  b = 0x62,
  e = 0x65,
  n = 0x6E,
  o = 0x6F,
  u = 0x75,
  x = 0x78,
  z = 0x7A
}

// @ts-ignore: decorator
@inline
export function isAscii(c: u32): bool {
  return !(c >> 7);
}

// @ts-ignore: decorator
@inline
export function isLower8(c: u32): bool {
  return c - CharCode.a < 26;
}

// @ts-ignore: decorator
@inline
export function isUpper8(c: u32): bool {
  return c - CharCode.A < 26;
}

export function isSpace(c: u32): bool {
  if (c < 0x1680) { // < <LS> (1)
    // <SP>, <TAB>, <LF>, <VT>, <FF>, <CR> and <NBSP>
    // (c == 0x20 || c == 0xA0) was optimized to (c | 0x80) == 0xA0
    return ((c | 0x80) == 0xA0) || (c - 0x09 <= 0x0D - 0x09);
  }
  if (c - 0x2000 <= 0x200A - 0x2000) return true;
  switch (c) {
    case 0x1680: // <LS> (1)
    case 0x2028: // <LS> (2)
    case 0x2029: // <PS>
    case 0x202F: // <NNS>
    case 0x205F: // <MMSP>
    case 0x3000: // <IS>
    case 0xFEFF: return true; // <ZWNBSP>
  }
  return false;
}

export function isAlpha(c: u32): bool {
  if (isAscii(c)) return (c | 32) - CharCode.a < 26;
  if (c < 0x20000) {
    // @ts-ignore: cast
    return stagedBinaryLookup(ALPHA_TABLE, c);
  }
  return c < 0x2FFFE;
}

// @ts-ignore: decorator
@inline
export function isCased(c: u32): bool {
  // @ts-ignore: cast
  return c < 0x1F18A && stagedBinaryLookup(CASED, c);
}

// @ts-ignore: decorator
@inline
export function isCaseIgnorable(c: u32): bool {
  // @ts-ignore: cast
  return c < 0xE01F0 && stagedBinaryLookup(CASE_IGNORABLES, c);
}

// @ts-ignore: decorator
@inline
export function isFinalSigma(buffer: usize, index: isize, len: isize): bool {
  const lookaheadLimit = 30; // max lookahead limit
  let found = false;
  let pos = index;
  let minPos = max(0, pos - lookaheadLimit);
  while (pos > minPos) {
    let c = codePointBefore(buffer, pos);
    if (!isCaseIgnorable(c)) {
      if (isCased(c)) {
        found = true;
      } else {
        return false;
      }
    }
    pos -= isize(c >= 0x10000) + 1;
  }
  if (!found) return false;
  pos = index + 1;
  let maxPos = min(pos + lookaheadLimit, len);
  while (pos < maxPos) {
    let c = <u32>load<u16>(buffer + (pos << 1));
    if (u32((c & 0xFC00) == 0xD800) & u32(pos + 1 != len)) {
      let c1 = <u32>load<u16>(buffer + (pos << 1), 2);
      if ((c1 & 0xFC00) == 0xDC00) {
        c = (c - 0xD800 << 10) + (c1 - 0xDC00) + 0x10000;
      }
    }
    if (!isCaseIgnorable(c)) {
      return !isCased(c);
    }
    pos += isize(c >= 0x10000) + 1;
  }
  return true;
}

// @ts-ignore: decorator
@inline
function codePointBefore(buffer: usize, index: isize): i32 {
  if (index <= 0) return -1;
  let c = <u32>load<u16>(buffer + (index - 1 << 1));
  if (u32((c & 0xFC00) == 0xDC00) & u32(index - 2 >= 0)) {
    let c1 = <u32>load<u16>(buffer + (index - 2 << 1));
    if ((c1 & 0xFC00) == 0xD800) {
      return ((c1 & 0x3FF) << 10) + (c & 0x3FF) + 0x10000;
    }
  }
  return (c & 0xF800) == 0xD800 ? 0xFFFD : c;
}

// Search routine for two-staged lookup tables
function stagedBinaryLookup(table: usize, c: u32): bool {
  return <bool>((load<u8>(table + (<u32>load<u8>(table + (c >>> 8)) << 5) + ((c & 255) >> 3)) >>> (c & 7)) & 1);
}

export function compareImpl(str1: string, index1: usize, str2: string, index2: usize, len: usize): i32 {
  let ptr1 = changetype<usize>(str1) + (index1 << 1);
  let ptr2 = changetype<usize>(str2) + (index2 << 1);
  if (ASC_SHRINK_LEVEL < 2) {
    if (len >= 4 && !((ptr1 & 7) | (ptr2 & 7))) {
      do {
        if (load<u64>(ptr1) != load<u64>(ptr2)) break;
        ptr1 += 8;
        ptr2 += 8;
        len  -= 4;
      } while (len >= 4);
    }
  }
  while (len--) {
    let a = <i32>load<u16>(ptr1);
    let b = <i32>load<u16>(ptr2);
    if (a != b) return a - b;
    ptr1 += 2;
    ptr2 += 2;
  }
  return 0;
}

// @ts-ignore: decorator
@inline
export function toLower8(c: u32): u32 {
  if (ASC_SHRINK_LEVEL > 0) {
    return c | u32(isUpper8(c)) << 5;
  } else {
    return <u32>load<u8>(LOWER127 + c);
  }
}

// @ts-ignore: decorator
@inline
export function toUpper8(c: u32): u32 {
  if (ASC_SHRINK_LEVEL > 0) {
    return c & ~(u32(isLower8(c)) << 5);
  } else {
    return <u32>load<u8>(UPPER127 + c);
  }
}

/** Parses a string to an integer (usually), using the specified radix. */
export function strtol<T>(str: string, radix: i32 = 0): T {
  let len = str.length;
  if (!len) {
    if (isFloat<T>()) {
      // @ts-ignore: cast
      return <T>NaN;
    } else {
      // @ts-ignore: cast
      return <T>0;
    }
  }

  let ptr = changetype<usize>(str) /* + HEAD -> offset */;
  let code = <u32>load<u16>(ptr);

  // trim white spaces
  while (isSpace(code)) {
    code = <u32>load<u16>(ptr += 2);
    --len;
  }
  // determine sign
  // @ts-ignore
  let sign: T = 1;
  if (code == CharCode.MINUS || code == CharCode.PLUS) {
    if (!--len) {
      if (isFloat<T>()) {
        // @ts-ignore: cast
        return <T>NaN;
      } else {
        // @ts-ignore: cast
        return <T>0;
      }
    }
    if (code == CharCode.MINUS) {
      // @ts-ignore: type
      sign = -1;
    }
    code = <u32>load<u16>(ptr += 2);
  }

  // See https://tc39.es/ecma262/#sec-parseint-string-radix
  if (radix) {
    if (radix < 2 || radix > 36) {
      if (isFloat<T>()) {
        // @ts-ignore: cast
        return <T>NaN;
      } else {
        // @ts-ignore: cast
        return <T>0;
      }
    }
    // handle case as parseInt("0xFF", 16) by spec
    if (radix == 16) {
      if (
        len > 2 &&
        code == CharCode._0 &&
        (<u32>load<u16>(ptr, 2) | 32) == CharCode.x
      ) {
        ptr += 4; len -= 2;
      }
    }
  } else {
    // determine radix by literal prefix
    if (code == CharCode._0 && len > 2) {
      switch (<u32>load<u16>(ptr, 2) | 32) {
        case CharCode.b: {
          ptr += 4; len -= 2;
          radix = 2;
          break;
        }
        case CharCode.o: {
          ptr += 4; len -= 2;
          radix = 8;
          break;
        }
        case CharCode.x: {
          ptr += 4; len -= 2;
          radix = 16;
          break;
        }
      }
    }
    if (!radix) radix = 10;
  }

  // calculate value
  // @ts-ignore: type
  let num: T = 0;
  let initial = len - 1;
  while (len--) {
    code = <u32>load<u16>(ptr);
    if (code - CharCode._0 < 10) {
      code -= CharCode._0;
    } else if (code - CharCode.A <= <u32>(CharCode.Z - CharCode.A)) {
      code -= CharCode.A - 10;
    } else if (code - CharCode.a <= <u32>(CharCode.z - CharCode.a)) {
      code -= CharCode.a - 10;
    }
    if (code >= <u32>radix) {
      if (initial == len) {
        if (isFloat<T>()) {
          // @ts-ignore: cast
          return <T>NaN;
        } else {
          // @ts-ignore: cast
          return <T>0;
        }
      }
      break;
    }
    // @ts-ignore: type
    num = num * radix + code;
    ptr += 2;
  }
  // @ts-ignore: type
  return sign * num;
}

export function strtod(str: string): f64 {
  let len = str.length;
  if (!len) return NaN;

  let ptr  = changetype<usize>(str);
  let code = <u32>load<u16>(ptr);

  let sign = 1.0;
  // skip white spaces
  while (len && isSpace(code)) {
    code = <u32>load<u16>(ptr += 2);
    --len;
  }
  if (!len) return NaN;

  // try parse '-' or '+'
  if (code == CharCode.MINUS) {
    if (!--len) return NaN;
    code = <u32>load<u16>(ptr += 2);
    sign = -1;
  } else if (code == CharCode.PLUS) {
    if (!--len) return NaN;
    code = <u32>load<u16>(ptr += 2);
  }

  // try parse Infinity
  if (len >= 8 && code == CharCode.I) {
    if (
      load<u64>(ptr, 0) == 0x690066006E0049 && // ifnI
      load<u64>(ptr, 8) == 0x7900740069006E    // ytin
    ) {
      return Infinity * sign;
    }
    return NaN;
  }
  // validate next symbol
  if (code != CharCode.DOT && <u32>(code - CharCode._0) >= 10) {
    return NaN;
  }
  let savedPtr = ptr;
  // skip zeros
  while (code == CharCode._0) {
    code = <u32>load<u16>(ptr += 2);
    --len;
  }
  if (len <= 0) return 0.0 * sign;
  const capacity = 19; // int(64 * 0.3010)
  let pointed = false;
  let consumed = 0;
  let position = 0;
  let x: u64 = 0;
  if (code == CharCode.DOT) {
    let noDigits = !(savedPtr - ptr);
    ptr += 2; --len;
    if (!len && noDigits) return NaN;
    for (pointed = true; (code = <u32>load<u16>(ptr)) == CharCode._0; --position, ptr += 2) --len;
    if (len <= 0) return 0.0 * sign;
    if (!position && noDigits && code - CharCode._0 >= 10) return NaN;
  }
  for (let digit = code - CharCode._0; digit < 10 || (code == CharCode.DOT && !pointed); digit = code - CharCode._0) {
    if (digit < 10) {
      x = consumed < capacity ? 10 * x + digit : x | u64(!!digit);
      ++consumed;
    } else {
      position = consumed;
      pointed = true;
    }
    if (!--len) break;
    code = <u32>load<u16>(ptr += 2);
  }

  if (!pointed) position = consumed;
  return copysign<f64>(scientific(x, position - min(capacity, consumed) + parseExp(ptr, len)), sign);
}

export function strtob(str: string): bool {
  let size: usize = str.length << 1;
  let offset: usize = 0;
  if (size > 8) {
    // try trim end whitespaces first
    while (size && isSpace(load<u16>(changetype<usize>(str) + size - 2))) size -= 2;
    if (size > 8) {
      // trim start whitespaces
      while (offset < size && isSpace(load<u16>(changetype<usize>(str) + offset))) offset += 2;
      size -= offset;
    }
  }
  if (size != 8) return false;
  // "true" represents as \\00\\e\\00\\u\\00\\e\\00\\t (00 65 00 75 00 72 00 74)
  return load<u64>(changetype<usize>(str) + offset) == 0x0065_0075_0072_0074;
}

export function joinBooleanArray(dataStart: usize, length: i32, separator: string): string {
  let lastIndex = length - 1;
  if (lastIndex < 0) return "";
  if (!lastIndex) return select("true", "false", load<bool>(dataStart));

  let sepLen = separator.length;
  let valueLen = 5; // max possible length of element len("false")
  let estLen = (valueLen + sepLen) * lastIndex + valueLen;
  let result = changetype<string>(__new(estLen << 1, idof<string>()));
  let offset = 0;
  let value: bool;
  for (let i = 0; i < lastIndex; ++i) {
    value = load<bool>(dataStart + i);
    valueLen = 4 + i32(!value);
    memory.copy(
      changetype<usize>(result) + (<usize>offset << 1),
      changetype<usize>(select("true", "false", value)),
      <usize>valueLen << 1
    );
    offset += valueLen;
    if (sepLen) {
      memory.copy(
        changetype<usize>(result) + (<usize>offset << 1),
        changetype<usize>(separator),
        <usize>sepLen << 1
      );
      offset += sepLen;
    }
  }
  value = load<bool>(dataStart + <usize>lastIndex);
  valueLen = 4 + i32(!value);
  memory.copy(
    changetype<usize>(result) + (<usize>offset << 1),
    changetype<usize>(select("true", "false", value)),
    valueLen << 1
  );
  offset += valueLen;

  if (estLen > offset) return result.substring(0, offset);
  return result;
}

export function joinIntegerArray<T>(dataStart: usize, length: i32, separator: string): string {
  let lastIndex = length - 1;
  if (lastIndex < 0) return "";
  if (!lastIndex) {
    let value = load<T>(dataStart);
    if (isSigned<T>()) {
      if (sizeof<T>() <= 4) {
        // @ts-ignore: type
        return changetype<string>(itoa32(<i32>value, 10));
      } else {
        // @ts-ignore: type
        return changetype<string>(itoa64(<i32>value, 10));
      }
    } else {
      if (sizeof<T>() <= 4) {
        // @ts-ignore: type
        return changetype<string>(utoa32(<u32>value, 10));
      } else {
        // @ts-ignore: type
        return changetype<string>(utoa64(<u64>value, 10));
      }
    }
  }

  let sepLen = separator.length;
  const valueLen = (sizeof<T>() <= 4 ? 10 : 20) + i32(isSigned<T>());
  let estLen = (valueLen + sepLen) * lastIndex + valueLen;
  let result = changetype<string>(__new(estLen << 1, idof<string>()));
  let offset = 0;
  let value: T;
  for (let i = 0; i < lastIndex; ++i) {
    value = load<T>(dataStart + (<usize>i << alignof<T>()));
    // @ts-ignore: type
    offset += itoa_buffered<T>(changetype<usize>(result) + (<usize>offset << 1), value);
    if (sepLen) {
      memory.copy(
        changetype<usize>(result) + (<usize>offset << 1),
        changetype<usize>(separator),
        <usize>sepLen << 1
      );
      offset += sepLen;
    }
  }
  value = load<T>(dataStart + (<usize>lastIndex << alignof<T>()));
  // @ts-ignore: type
  offset += itoa_buffered<T>(changetype<usize>(result) + (<usize>offset << 1), value);
  if (estLen > offset) return result.substring(0, offset);
  return result;
}

export function joinFloatArray<T>(dataStart: usize, length: i32, separator: string): string {
  let lastIndex = length - 1;
  if (lastIndex < 0) return "";
  if (!lastIndex) {
    return changetype<string>(dtoa(
      // @ts-ignore: type
      load<T>(dataStart))
    );
  }

  const valueLen = MAX_DOUBLE_LENGTH;
  let sepLen = separator.length;
  let estLen = (valueLen + sepLen) * lastIndex + valueLen;
  let result = changetype<string>(__new(estLen << 1, idof<string>()));
  let offset = 0;
  let value: T;
  for (let i = 0; i < lastIndex; ++i) {
    value = load<T>(dataStart + (<usize>i << alignof<T>()));
    // @ts-ignore: type
    offset += dtoa_buffered(changetype<usize>(result) + (<usize>offset << 1), value);
    if (sepLen) {
      memory.copy(
        changetype<usize>(result) + (<usize>offset << 1),
        changetype<usize>(separator),
        <usize>sepLen << 1
      );
      offset += sepLen;
    }
  }
  value = load<T>(dataStart + (<usize>lastIndex << alignof<T>()));
  // @ts-ignore: type
  offset += dtoa_buffered(changetype<usize>(result) + (<usize>offset << 1), value);
  if (estLen > offset) return result.substring(0, offset);
  return result;
}

export function joinStringArray(dataStart: usize, length: i32, separator: string): string {
  let lastIndex = length - 1;
  if (lastIndex < 0) return "";
  if (!lastIndex) {
    // @ts-ignore: type
    return load<string>(dataStart) || "";
  }
  let estLen = 0;
  let value: string;
  for (let i = 0; i < length; ++i) {
    value = load<string>(dataStart + (<usize>i << alignof<string>()));
    if (changetype<usize>(value) != 0) estLen += value.length;
  }
  let offset = 0;
  let sepLen = separator.length;
  let result = changetype<string>(__new((estLen + sepLen * lastIndex) << 1, idof<string>()));
  for (let i = 0; i < lastIndex; ++i) {
    value = load<string>(dataStart + (<usize>i << alignof<string>()));
    if (changetype<usize>(value) != 0) {
      let valueLen = value.length;
      memory.copy(
        changetype<usize>(result) + (<usize>offset << 1),
        changetype<usize>(value),
        <usize>valueLen << 1
      );
      offset += valueLen;
    }
    if (sepLen) {
      memory.copy(
        changetype<usize>(result) + (<usize>offset << 1),
        changetype<usize>(separator),
        <usize>sepLen << 1
      );
      offset += sepLen;
    }
  }
  value = load<string>(dataStart + (<usize>lastIndex << alignof<string>()));
  if (changetype<usize>(value) != 0) {
    memory.copy(
      changetype<usize>(result) + (<usize>offset << 1),
      changetype<usize>(value),
      <usize>value.length << 1
    );
  }
  return result;
}

export function joinReferenceArray<T>(dataStart: usize, length: i32, separator: string): string {
  let lastIndex = length - 1;
  if (lastIndex < 0) return "";
  let value: T;
  if (!lastIndex) {
    value = load<T>(dataStart);
    // @ts-ignore: type
    return value != null ? value.toString() : "";
  }
  let result = "";
  let sepLen = separator.length;
  for (let i = 0; i < lastIndex; ++i) {
    value = load<T>(dataStart + (<usize>i << alignof<T>()));
    // @ts-ignore: type
    if (value != null) result += value.toString();
    if (sepLen) result += separator;
  }
  value = load<T>(dataStart + (<usize>lastIndex << alignof<T>()));
  // @ts-ignore: type
  if (value != null) result += value.toString();
  return result;
}

// @ts-ignore: decorator
@inline
function scientific(significand: u64, exp: i32): f64 {
  if (!significand || exp < -342) return 0;
  if (exp > 308) return Infinity;
  // Try use fast path
  // Use fast path for string-to-double conversion if possible
  // see http://www.exploringbinary.com/fast-path-decimal-to-floating-point-conversion
  // Simple integer
  let significandf = <f64>significand;
  if (!exp) return significandf;
  if (exp > 22 && exp <= 22 + 15) {
    significandf *= pow10(exp - 22);
    exp = 22;
  }
  if (significand <= 9007199254740991 && abs(exp) <= 22) {
    if (exp > 0) return significandf * pow10(exp);
    return significandf / pow10(-exp);
  } else if (exp < 0) {
    return scaledown(significand, exp);
  } else {
    return scaleup(significand, exp);
  }
}

// Adopted from metallic lib:
// https://github.com/jdh8/metallic/blob/master/src/stdlib/parse/scientific.h
// @ts-ignore: decorator
@inline
function scaledown(significand: u64, exp: i32): f64 {
  const denom: u64 = 6103515625; // 1e14 * 0x1p-14
  const scale = reinterpret<f64>(0x3F06849B86A12B9B); // 1e-14 * 0x1p32

  let shift = clz(significand);
  significand <<= shift;
  shift = exp - shift;

  for (; exp <= -14; exp += 14) {
    let q = significand / denom;
    let r = significand % denom;
    let s = clz(q);
    significand = (q << s) + <u64>nearest(scale * <f64>(r << (s - 18)));
    shift -= s;
  }
  let b = <u64>ipow32(5, -exp);
  let q = significand / b;
  let r = significand % b;
  let s = clz(q);
  significand = (q << s) + <u64>(reinterpret<f64>(reinterpret<u64>(<f64>r) + (s << 52)) / <f64>b);
  shift -= s;

  return NativeMath.scalbn(<f64>significand, <i32>shift);
}

// Adopted from metallic lib:
// https://github.com/jdh8/metallic/blob/master/src/stdlib/parse/scientific.h
// @ts-ignore: decorator
@inline
function scaleup(significand: u64, exp: i32): f64 {
  const coeff: u32 = 1220703125; // 1e13 * 0x1p-13;
  let shift = ctz(significand);
  significand >>= shift;
  shift += exp;

  __fixmulShift = shift;
  for (; exp >= 13; exp -= 13) {
    significand = fixmul(significand, coeff);
  }
  significand = fixmul(significand, <u32>ipow32(5, exp));
  shift = __fixmulShift;
  return NativeMath.scalbn(<f64>significand, <i32>shift);
}

// Adopted from metallic lib:
// https://github.com/jdh8/metallic/blob/master/src/stdlib/parse/scientific.h
// @ts-ignore: decorator
@inline
function parseExp(ptr: usize, len: i32): i32 {
  let sign = 1, magnitude = 0;
  let code = <u32>load<u16>(ptr);
  // check code is 'e' or 'E'
  if ((code | 32) != CharCode.e) return 0;

  if (!--len) return 0;
  code = <u32>load<u16>(ptr += 2);
  if (code == CharCode.MINUS) {
    if (!--len) return 0;
    code = <u32>load<u16>(ptr += 2);
    sign = -1;
  } else if (code == CharCode.PLUS) {
    if (!--len) return 0;
    code = <u32>load<u16>(ptr += 2);
  }
  // skip zeros
  while (code == CharCode._0) {
    if (!--len) return 0;
    code = <u32>load<u16>(ptr += 2);
  }
  for (let digit: u32 = code - CharCode._0; len && digit < 10; digit = code - CharCode._0) {
    if (magnitude >= 3200) return sign * 3200;
    magnitude = 10 * magnitude + digit;
    code = <u32>load<u16>(ptr += 2);
    --len;
  }
  return sign * magnitude;
}

// @ts-ignore: decorator
@lazy let __fixmulShift: u64 = 0;

// Adopted from metallic lib:
// https://github.com/jdh8/metallic/blob/master/src/stdlib/parse/scientific.h
// @ts-ignore: decorator
@inline
function fixmul(a: u64, b: u32): u64 {
  let low  = (a & 0xFFFFFFFF) * b;
  let high = (a >> 32) * b + (low >> 32);
  let overflow = <u32>(high >> 32);
  let space = clz(overflow);
  let revspace: u64 = 32 - space;
  __fixmulShift += revspace;
  return (high << space | (low & 0xFFFFFFFF) >> revspace) + (low << space >> 31 & 1);
}

// @ts-ignore: decorator
@inline
function pow10(n: i32): f64 {
  // argument \`n\` should bounds in [0, 22] range
  return load<f64>(POWERS10 + (n << alignof<f64>()));
}
`,"util/uri":`import { E_URI_MALFORMED } from "./error";
import { CharCode } from "./string";

// Truncated lookup boolean table that helps us quickly determine
// if a char needs to be escaped for URIs (RFC 2396).
// @ts-ignore: decorator
@lazy export const URI_UNSAFE = memory.data<u8>([
/* skip 32 + 1 always set to '1' head slots
  */ 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0,
  1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, /*
  skip 128 + 1 always set to '1' tail slots */
]);

// Truncated lookup boolean table that helps us quickly determine
// if a char needs to be escaped for URLs (RFC 3986).
// @ts-ignore: decorator
@lazy export const URL_UNSAFE = memory.data<u8>([
/* skip 32 + 1 always set to '1' head slots
  */ 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1,
  1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0,
  1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, /*
  skip 128 + 1 always set to '1' tail slots */
]);

// Truncated lookup boolean table for determine reserved chars: ;/?:@&=+$,#
// @ts-ignore: decorator
@lazy export const URI_RESERVED = memory.data<u8>([
  /*  skip 32 + 3 always set to '0' head slots
        */ 1, 1, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1,
  1, /* skip 191 always set to '0' tail slots */
]);

export function encode(src: usize, len: usize, table: usize): usize {
  if (!len) return src;

  let i: usize = 0, offset: usize = 0, outSize = len << 1;
  let dst = __new(outSize, idof<String>());

  while (i < len) {
    let org = i;
    let c: u32, c1: u32;
    // fast scan a check chars until it valid ASCII
    // and safe for copying withoud escaping.
    do {
      c = <u32>load<u16>(src + (i << 1));
      // is it valid ASII and safe?
      if (c - 33 < 94) { // 127 - 33
        if (load<u8>(table + (c - 33))) break;
      } else break;
    } while (++i < len);

    // if we have some safe range of sequence just copy it without encoding
    if (i > org) {
      let size = i - org << 1;
      if (offset + size > outSize) {
        outSize = offset + size;
        dst = __renew(dst, outSize);
      }
      // TODO: should we optimize for short cases like 2 byte size?
      memory.copy(
        dst + offset,
        src + (org << 1),
        size
      );
      offset += size;
      // return if we reach end on input string
      if (i >= len) break;
    }

    // decode UTF16 with checking for unpaired surrogates
    if (c >= 0xD800) {
      if (c >= 0xDC00 && c <= 0xDFFF) {
        throw new URIError(E_URI_MALFORMED);
      }
      if (c <= 0xDBFF) {
        if (i >= len) {
          throw new URIError(E_URI_MALFORMED);
        }
        c1 = <u32>load<u16>(src + (++i << 1));
        if (c1 < 0xDC00 || c1 > 0xDFFF) {
          throw new URIError(E_URI_MALFORMED);
        }
        c = (((c & 0x3FF) << 10) | (c1 & 0x3FF)) + 0x10000;
      }
    }

    let estSize = offset + (c < 0x80 ? 1 * 6 : 4 * 6);
    if (estSize > outSize) {
      // doubling estimated size but only for greater than one
      // input lenght due to we already estemated it for worst case
      outSize = len > 1 ? estSize << 1 : estSize;
      dst = __renew(dst, outSize);
    }

    if (c < 0x80) {
      // encode ASCII unsafe code point
      storeHex(dst, offset, c);
      offset += 6;
    } else {
      // encode UTF-8 unsafe code point
      if (c < 0x800) {
        storeHex(dst, offset, (c >> 6) | 0xC0);
        offset += 6;
      } else {
        if (c < 0x10000) {
          storeHex(dst, offset, (c >> 12) | 0xE0);
          offset += 6;
        } else {
          storeHex(dst, offset, (c >> 18) | 0xF0);
          offset += 6;
          storeHex(dst, offset, (c >> 12 & 0x3F) | 0x80);
          offset += 6;
        }
        storeHex(dst, offset, (c >> 6 & 0x3F) | 0x80);
        offset += 6;
      }
      storeHex(dst, offset, (c & 0x3F) | 0x80);
      offset += 6;
    }
    ++i;
  }
  // shink output string buffer if necessary
  if (outSize > offset) {
    dst = __renew(dst, offset);
  }
  return dst;
}

export function decode(src: usize, len: usize, component: bool): usize {
  if (!len) return src;

  let i: usize = 0, offset: usize = 0, ch: u32 = 0;
  let dst = __new(len << 1, idof<String>());

  while (i < len) {
    let org = i;
    while (i < len && (ch = load<u16>(src + (i << 1))) != CharCode.PERCENT) i++;

    if (i > org) {
      let size = i - org << 1;
      // TODO: should we optimize for short cases like 2 byte size?
      memory.copy(
        dst + offset,
        src + (org << 1),
        size
      );
      offset += size;
      if (i >= len) break;
    }

    // decode hex
    if (
      i + 2 >= len ||
      ch != CharCode.PERCENT ||
      (ch = loadHex(src, i + 1 << 1)) == -1
    ) throw new URIError(E_URI_MALFORMED);

    i += 3;
    if (ch < 0x80) {
      if (!component && isReserved(ch)) {
        ch = CharCode.PERCENT;
        i -= 2;
      }
    } else {
      // decode UTF-8 sequence
      let nb = utf8LenFromUpperByte(ch);
      // minimal surrogate: 2 => 0x80, 3 => 0x800, 4 => 0x10000, _ => -1
      let lo: u32 = 1 << (17 * nb >> 2) - 1;
      // mask: 2 => 31, 3 => 15, 4 => 7, _ =>  0
      ch &= nb ? (0x80 >> nb) - 1 : 0;

      while (--nb != 0) {
        let c1: u32;
        // decode hex
        if (
          i + 2 >= len ||
          load<u16>(src + (i << 1)) != CharCode.PERCENT ||
          (c1 = loadHex(src, i + 1 << 1)) == -1
        ) throw new URIError(E_URI_MALFORMED);

        i += 3;
        if ((c1 & 0xC0) != 0x80) {
          ch = 0;
          break;
        }
        ch = (ch << 6) | (c1 & 0x3F);
      }

      // check if UTF8 code point properly fit into invalid UTF16 encoding
      if (ch < lo || lo == -1 || ch > 0x10FFFF || (ch >= 0xD800 && ch < 0xE000)) {
        throw new URIError(E_URI_MALFORMED);
      }

      // encode UTF16
      if (ch >= 0x10000) {
        ch -= 0x10000;
        let lo = ch >> 10 | 0xD800;
        let hi = (ch & 0x03FF) | 0xDC00;
        store<u32>(dst + offset, lo | (hi << 16));
        offset += 4;
        continue;
      }
    }
    store<u16>(dst + offset, ch);
    offset += 2;
  }

  assert(offset <= (len << 1));
  // shink output string buffer if necessary
  if ((len << 1) > offset) {
    dst = __renew(dst, offset);
  }
  return dst;
}

function storeHex(dst: usize, offset: usize, ch: u32): void {
  // @ts-ignore: decorator
  const HEX_CHARS = memory.data<u8>([
    0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
    0x38, 0x39, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46
  ]);

  store<u16>(dst + offset, CharCode.PERCENT, 0); // %
  store<u32>(
    dst + offset,
    <u32>load<u8>(HEX_CHARS + (ch >> 4 & 0x0F)) |
    <u32>load<u8>(HEX_CHARS + (ch      & 0x0F)) << 16,
    2
  ); // XX
}

function loadHex(src: usize, offset: usize): u32 {
  let c0 = <u32>load<u16>(src + offset, 0);
  let c1 = <u32>load<u16>(src + offset, 2);
  return isHex(c0) && isHex(c1)
    ? fromHex(c0) << 4 | fromHex(c1)
    : -1;
}

// @ts-ignore: decorator
@inline function fromHex(ch: u32): u32 {
  return (ch | 32) % 39 - 9;
}

// @ts-ignore: decorator
@inline function utf8LenFromUpperByte(c0: u32): u32 {
  // same as
  // if (c0 - 0xC0 <= 0xDF - 0xC0) return 2;
  // if (c0 - 0xE0 <= 0xEF - 0xE0) return 3;
  // if (c0 - 0xF0 <= 0xF7 - 0xF0) return 4;
  // return 0;
  return c0 - 0xC0 < 56
    ? clz(~(c0 << 24))
    : 0;
}

// @ts-ignore: decorator
@inline function isReserved(ch: u32): bool {
  return ch - 35 < 30
    ? <bool>load<u8>(URI_RESERVED + (ch - 35))
    : false;
}

// @ts-ignore: decorator
@inline function isHex(ch: u32): bool {
  return (ch - CharCode._0 < 10) || ((ch | 32) - CharCode.a < 6);
}
`,vector:`/** Vector abstraction. */
@final @unmanaged
export abstract class V128 {
}
`},_e={assembly:`/**
 * Environment definitions for compiling AssemblyScript to WebAssembly using asc.
 * @module std/assembly
 *//***/

/// <reference no-default-lib="true"/>

// Types

/** An 8-bit signed integer. */
declare type i8 = number;
/** A 16-bit signed integer. */
declare type i16 = number;
/** A 32-bit signed integer. */
declare type i32 = number;
/** A 64-bit signed integer. */
declare type i64 = number;
/** A 32-bit signed integer when targeting 32-bit WebAssembly or a 64-bit signed integer when targeting 64-bit WebAssembly. */
declare type isize = number;
/** An 8-bit unsigned integer. */
declare type u8 = number;
/** A 16-bit unsigned integer. */
declare type u16 = number;
/** A 32-bit unsigned integer. */
declare type u32 = number;
/** A 64-bit unsigned integer. */
declare type u64 = number;
/** A 32-bit unsigned integer when targeting 32-bit WebAssembly or a 64-bit unsigned integer when targeting 64-bit WebAssembly. */
declare type usize = number;
/** A 1-bit unsigned integer. */
declare type bool = boolean | number;
/** A 32-bit float. */
declare type f32 = number;
/** A 64-bit float. */
declare type f64 = number;
/** A 128-bit vector. */
declare type v128 = object;
/** Non-nullable function reference. */
declare type ref_func = object;
/** Canonical nullable function reference. */
declare type funcref = ref_func | null;
/** Non-nullable external reference. */
declare type ref_extern = object;
/** Canonical nullable external reference. */
declare type externref = ref_extern | null;
/** Non-nullable any reference. */
declare type ref_any = object;
/** Canonical nullable any reference. */
declare type anyref = ref_any | null;
/** Non-nullable equatable reference. */
declare type ref_eq = object;
/** Canonical nullable equatable reference. */
declare type eqref = ref_eq | null;
/** Non-nullable struct reference. */
declare type ref_struct = object;
/** Canonical nullable struct reference. */
declare type structref = ref_struct | null;
/** Non-nullable array reference. */
declare type ref_array = object;
/** Canonical nullable array reference. */
declare type arrayref = ref_array | null;
/** Non-nullable 31-bit integer reference. */
declare type ref_i31 = object;
/** Canonical nullable 31-bit integer reference. */
declare type i31ref = ref_i31 | null;
/** Non-nullable string reference. */
declare type ref_string = object;
/** Canonical nullable string reference. */
declare type stringref = ref_string | null;
/** Non-nullable WTF-8 string view. */
declare type ref_stringview_wtf8 = object;
/** Canonical nullable WTF-8 string view. */
declare type stringview_wtf8 = ref_stringview_wtf8 | null;
/** Non-nullable WTF-16 string view. */
declare type ref_stringview_wtf16 = object;
/** Canonical nullable WTF-16 string view. */
declare type stringview_wtf16 = ref_stringview_wtf16 | null;
/** Non-nullable string iterator. */
declare type ref_stringview_iter = object;
/** Canonical nullable string iterator. */
declare type stringview_iter = ref_stringview_iter | null;

// Compiler hints

/** Compiler target. 0 = JS, 1 = WASM32, 2 = WASM64. */
declare const ASC_TARGET: i32;
/** Runtime type. 0 = Stub, 1 = Minimal, 2 = Incremental. */
declare const ASC_RUNTIME: i32;
/** Provided noAssert option. */
declare const ASC_NO_ASSERT: bool;
/** Provided memoryBase option. */
declare const ASC_MEMORY_BASE: i32;
/** Provided tableBase option. */
declare const ASC_TABLE_BASE: i32;
/** Provided optimizeLevel option. */
declare const ASC_OPTIMIZE_LEVEL: i32;
/** Provided shrinkLevel option. */
declare const ASC_SHRINK_LEVEL: i32;
/** Provided lowMemoryLimit option. */
declare const ASC_LOW_MEMORY_LIMIT: i32;
/** Provided noExportRuntime option. */
declare const ASC_NO_EXPORT_RUNTIME: i32;
/** Whether the sign extension feature is enabled. */
declare const ASC_FEATURE_SIGN_EXTENSION: bool;
/** Whether the mutable globals feature is enabled. */
declare const ASC_FEATURE_MUTABLE_GLOBALS: bool;
/** Whether the non-trapping float-to-int feature is enabled. */
declare const ASC_FEATURE_NONTRAPPING_F2I: bool;
/** Whether the bulk memory feature is enabled. */
declare const ASC_FEATURE_BULK_MEMORY: bool;
/** Whether the SIMD feature is enabled. */
declare const ASC_FEATURE_SIMD: bool;
/** Whether the threads feature is enabled. */
declare const ASC_FEATURE_THREADS: bool;
/** Whether the exception handling feature is enabled. */
declare const ASC_FEATURE_EXCEPTION_HANDLING: bool;
/** Whether the tail calls feature is enabled. */
declare const ASC_FEATURE_TAIL_CALLS: bool;
/** Whether the reference types feature is enabled. */
declare const ASC_FEATURE_REFERENCE_TYPES: bool;
/** Whether the multi value types feature is enabled. */
declare const ASC_FEATURE_MULTI_VALUE: bool;
/** Whether the garbage collection feature is enabled. */
declare const ASC_FEATURE_GC: bool;
/** Whether the memory64 feature is enabled. */
declare const ASC_FEATURE_MEMORY64: bool;
/** Whether the relaxed SIMD feature is enabled. */
declare const ASC_FEATURE_RELAXED_SIMD: bool;
/** Whether the extended const expression feature is enabled. */
declare const ASC_FEATURE_EXTENDED_CONST: bool;
/** Whether the string references feature is enabled. */
declare const ASC_FEATURE_STRINGREF: bool;
/** Major version of the compiler. */
declare const ASC_VERSION_MAJOR: i32;
/** Minor version of the compiler. */
declare const ASC_VERSION_MINOR: i32;
/** Patch version of the compiler. */
declare const ASC_VERSION_PATCH: i32;

// Builtins

/** Performs the sign-agnostic reverse bytes **/
declare function bswap<T extends i8 | u8 | i16 | u16 | i32 | u32 | i64 | u64 | isize | usize>(value: T): T;
/** Performs the sign-agnostic count leading zero bits operation on a 32-bit or 64-bit integer. All zero bits are considered leading if the value is zero. */
declare function clz<T extends i32 | i64>(value: T): T;
/** Performs the sign-agnostic count tailing zero bits operation on a 32-bit or 64-bit integer. All zero bits are considered trailing if the value is zero. */
declare function ctz<T extends i32 | i64>(value: T): T;
/** Performs the sign-agnostic count number of one bits operation on a 32-bit or 64-bit integer. */
declare function popcnt<T extends i32 | i64>(value: T): T;
/** Performs the sign-agnostic rotate left operation on a 32-bit or 64-bit integer. */
declare function rotl<T extends i32 | i64>(value: T, shift: T): T;
/** Performs the sign-agnostic rotate right operation on a 32-bit or 64-bit integer. */
declare function rotr<T extends i32 | i64>(value: T, shift: T): T;
/** Computes the absolute value of an integer or float. */
declare function abs<T extends i32 | i64 | f32 | f64>(value: T): T;
/** Determines the maximum of two integers or floats. If either operand is \`NaN\`, returns \`NaN\`. */
declare function max<T extends i32 | i64 | f32 | f64>(left: T, right: T): T;
/** Determines the minimum of two integers or floats. If either operand is \`NaN\`, returns \`NaN\`. */
declare function min<T extends i32 | i64 | f32 | f64>(left: T, right: T): T;
/** Performs the ceiling operation on a 32-bit or 64-bit float. */
declare function ceil<T extends f32 | f64>(value: T): T;
/** Composes a 32-bit or 64-bit float from the magnitude of \`x\` and the sign of \`y\`. */
declare function copysign<T extends f32 | f64>(x: T, y: T): T;
/** Performs the floor operation on a 32-bit or 64-bit float. */
declare function floor<T extends f32 | f64>(value: T): T;
/** Rounds to the nearest integer tied to even of a 32-bit or 64-bit float. */
declare function nearest<T extends f32 | f64>(value: T): T;
/** Reinterprets the bits of the specified value as type \`T\`. Valid reinterpretations are u32/i32 to/from f32 and u64/i64 to/from f64. */
declare function reinterpret<T extends i32 | i64 | f32 | f64>(value: number): T;
/** Selects one of two pre-evaluated values depending on the condition. */
declare function select<T>(ifTrue: T, ifFalse: T, condition: bool): T;
/** Calculates the square root of a 32-bit or 64-bit float. */
declare function sqrt<T extends f32 | f64>(value: T): T;
/** Rounds to the nearest integer towards zero of a 32-bit or 64-bit float. */
declare function trunc<T extends f32 | f64>(value: T): T;
/** Computes the sum of two integers or floats. */
declare function add<T extends i32 | i64 | f32 | f64>(left: T, right: T): T;
/** Computes the difference of two integers or floats. */
declare function sub<T extends i32 | i64 | f32 | f64>(left: T, right: T): T;
/** Computes the product of two integers or floats. */
declare function mul<T extends i32 | i64 | f32 | f64>(left: T, right: T): T;
/** Computes the quotient of two integers or floats. */
declare function div<T extends i32 | i64 | f32 | f64>(left: T, right: T): T;
/** Return 1 if two numbers are equal to each other, 0 otherwise. */
declare function eq<T extends i32 | i64 | f32 | f64>(left: T, right: T): i32;
/** Return 0 if two numbers are equal to each other, 1 otherwise. */
declare function ne<T extends i32 | i64 | f32 | f64>(left: T, right: T): i32;
/** Computes the remainder of two integers. */
declare function rem<T extends i32 | i64>(left: T, right: T): T;
/** Loads a value of the specified type from memory. Equivalent to dereferncing a pointer in other languages. */
declare function load<T>(ptr: usize, immOffset?: usize, immAlign?: usize): T;
/** Stores a value of the specified type to memory. Equivalent to dereferencing a pointer in other languages when assigning a value. */
declare function store<T>(ptr: usize, value: T, immOffset?: usize, immAlign?: usize): void;
/** Emits an unreachable operation that results in a runtime error when executed. Both a statement and an expression. */
declare function unreachable(): never;

/** NaN (not a number) as a 32-bit or 64-bit float depending on context. */
declare const NaN: f32 | f64;
/** Positive infinity as a 32-bit or 64-bit float depending on context. */
declare const Infinity: f32 | f64;
/** Data end offset. */
declare const __data_end: usize;
/** Stack pointer offset. */
declare let __stack_pointer: usize;
/** Heap base offset. */
declare const __heap_base: usize;
/** Determines the byte size of the specified underlying core type. Compiles to a constant. */
declare function sizeof<T>(): usize;
/** Determines the alignment (log2) of the specified underlying core type. Compiles to a constant. */
declare function alignof<T>(): usize;
/** Determines the end offset of the given class type. Compiles to a constant. */
declare function offsetof<T>(): usize;
/** Determines the offset of the specified field within the given class type. Compiles to a constant. */
declare function offsetof<T>(fieldName: keyof T | string): usize;
/** Determines the offset of the specified field within the given class type. Returns the class type's end offset if field name has been omitted. Compiles to a constant. */
declare function offsetof<T>(fieldName?: string): usize;
/** Determines the name of a given type. */
declare function nameof<T>(value?: T): string;
/** Determines the unique runtime id of a class type. Compiles to a constant. */
declare function idof<T>(): u32;
/** Changes the type of any value of \`usize\` kind to another one of \`usize\` kind. Useful for casting class instances to their pointer values and vice-versa. Beware that this is unsafe.*/
declare function changetype<T>(value: any): T;
/** Explicitly requests no bounds checks on the provided expression. Useful for array accesses. */
declare function unchecked<T>(value: T): T;
/** Emits a \`call_indirect\` instruction, calling the specified function in the function table by index with the specified arguments. Does result in a runtime error if the arguments do not match the called function. */
declare function call_indirect<T>(index: u32, ...args: unknown[]): T;
/** Instantiates a new instance of \`T\` using the specified constructor arguments. */
declare function instantiate<T>(...args: any[]): T;
/** Tests if a 32-bit or 64-bit float is \`NaN\`. */
declare function isNaN<T extends f32 | f64>(value: T): bool;
/** Tests if a 32-bit or 64-bit float is finite, that is not \`NaN\` or +/-\`Infinity\`. */
declare function isFinite<T extends f32 | f64>(value: T): bool;
/** Tests if the specified type *or* expression is of a boolean type. */
declare function isBoolean<T>(value?: any): value is number;
/** Tests if the specified type *or* expression is of an integer type and not a reference. Compiles to a constant. */
declare function isInteger<T>(value?: any): value is number;
/** Tests if the specified type *or* expression can represent negative numbers. Compiles to a constant. */
declare function isSigned<T>(value?: any): value is number;
/** Tests if the specified type *or* expression is of a float type. Compiles to a constant. */
declare function isFloat<T>(value?: any): value is number;
/** Tests if the specified type *or* expression is of a v128 type. Compiles to a constant. */
declare function isVector<T>(value?: any): value is v128;
/** Tests if the specified type *or* expression is of a reference type. Compiles to a constant. */
declare function isReference<T>(value?: any): value is object | string;
/** Tests if the specified type *or* expression can be used as a string. Compiles to a constant. */
declare function isString<T>(value?: any): value is string | String;
/** Tests if the specified type *or* expression can be used as an array. Compiles to a constant. */
declare function isArray<T>(value?: any): value is Array<any>;
/** Tests if the specified type *or* expression can be used as an array like object. Compiles to a constant. */
declare function isArrayLike<T>(value?: any): value is ArrayLike<any>;
/** Tests if the specified type *or* expression is of a function type. Compiles to a constant. */
declare function isFunction<T>(value?: any): value is (...args: any) => any;
/** Tests if the specified type *or* expression is of a nullable reference type. Compiles to a constant. */
declare function isNullable<T>(value?: any): bool;
/** Tests if the specified expression resolves to a defined element. Compiles to a constant. */
declare function isDefined(expression: any): bool;
/** Tests if the specified expression evaluates to a constant value. Compiles to a constant. */
declare function isConstant(expression: any): bool;
/** Tests if the specified type *or* expression is of a managed type. Compiles to a constant. */
declare function isManaged<T>(value?: any): bool;
/** Tests if the specified type is void. Compiles to a constant. */
declare function isVoid<T>(): bool;
/** Traps if the specified value is not true-ish, otherwise returns the (non-nullable) value. */
declare function assert<T>(isTrueish: T, message?: string): T & (object | string | number); // any better way to model \`: T != null\`?
/** Parses an integer string to a 64-bit float. */
declare function parseInt(str: string, radix?: i32): f64;
/** Parses a string to a 64-bit float. */
declare function parseFloat(str: string): f64;
/** Returns the 64-bit floating-point remainder of \`x/y\`. */
declare function fmod(x: f64, y: f64): f64;
/** Returns the 32-bit floating-point remainder of \`x/y\`. */
declare function fmodf(x: f32, y: f32): f32;
/** Returns the number of parameters in the given function signature type. */
declare function lengthof<T extends (...args: any[]) => any>(func?: T): i32;
/** Encodes a text string as a valid Uniform Resource Identifier (URI). */
declare function encodeURI(str: string): string;
/** Encodes a text string as a valid component of a Uniform Resource Identifier (URI). */
declare function encodeURIComponent(str: string): string;
/** Decodes a Uniform Resource Identifier (URI) previously created by encodeURI. */
declare function decodeURI(str: string): string;
/** Decodes a Uniform Resource Identifier (URI) component previously created by encodeURIComponent. */
declare function decodeURIComponent(str: string): string;

/** Atomic operations. */
declare namespace atomic {
  /** Atomically loads an integer value from memory and returns it. */
  export function load<T>(ptr: usize, immOffset?: usize): T;
  /** Atomically stores an integer value to memory. */
  export function store<T>(ptr: usize, value: T, immOffset?: usize): void;
  /** Atomically adds an integer value in memory. */
  export function add<T>(ptr: usize, value: T, immOffset?: usize): T;
  /** Atomically subtracts an integer value in memory. */
  export function sub<T>(ptr: usize, value: T, immOffset?: usize): T;
  /** Atomically performs a bitwise AND operation on an integer value in memory. */
  export function and<T>(ptr: usize, value: T, immOffset?: usize): T;
  /** Atomically performs a bitwise OR operation on an integer value in memory. */
  export function or<T>(ptr: usize, value: T, immOffset?: usize): T;
  /** Atomically performs a bitwise XOR operation on an integer value in memory. */
  export function xor<T>(ptr: usize, value: T, immOffset?: usize): T;
  /** Atomically exchanges an integer value in memory. */
  export function xchg<T>(ptr: usize, value: T, immOffset?: usize): T;
  /** Atomically compares and exchanges an integer value in memory if the condition is met. */
  export function cmpxchg<T>(ptr: usize, expected: T, replacement: T, immOffset?: usize): T;
  /** Performs a wait operation on an address in memory suspending this agent if the integer condition is met. */
  export function wait<T>(ptr: usize, expected: T, timeout?: i64): AtomicWaitResult;
  /** Performs a notify operation on an address in memory waking up suspended agents. */
  export function notify(ptr: usize, count?: i32): i32;
  /** Performs a fence operation, preserving synchronization guarantees of higher level languages. */
  export function fence(): void;
}

/** Describes the result of an atomic wait operation. */
declare enum AtomicWaitResult {
  /** Woken by another agent. */
  OK,
  /** Loaded value did not match the expected value. */
  NOT_EQUAL,
  /** Not woken before the timeout expired. */
  TIMED_OUT
}

/** Converts any other numeric value to an 8-bit signed integer. */
declare function i8(value: any): i8;
declare namespace i8 {
  /** Smallest representable value. */
  export const MIN_VALUE: i8;
  /** Largest representable value. */
  export const MAX_VALUE: i8;
  /** Parses a string as an i8. */
  export function parse(value: string, radix?: i32): i8;
}
/** Converts any other numeric value to a 16-bit signed integer. */
declare function i16(value: any): i16;
declare namespace i16 {
  /** Smallest representable value. */
  export const MIN_VALUE: i16;
  /** Largest representable value. */
  export const MAX_VALUE: i16;
  /** Parses a string as an i16. */
  export function parse(value: string, radix?: i32): i16;
}
/** Converts any other numeric value to a 32-bit signed integer. */
declare function i32(value: any): i32;
declare namespace i32 {
  /** Smallest representable value. */
  export const MIN_VALUE: i32;
  /** Largest representable value. */
  export const MAX_VALUE: i32;
  /** Parses a string as an i32. */
  export function parse(value: string, radix?: i32): i32;
  /** Loads an 8-bit signed integer value from memory and returns it as a 32-bit integer. */
  export function load8_s(ptr: usize, immOffset?: usize, immAlign?: usize): i32;
  /** Loads an 8-bit unsigned integer value from memory and returns it as a 32-bit integer. */
  export function load8_u(ptr: usize, immOffset?: usize, immAlign?: usize): i32;
  /** Loads a 16-bit signed integer value from memory and returns it as a 32-bit integer. */
  export function load16_s(ptr: usize, immOffset?: usize, immAlign?: usize): i32;
  /** Loads a 16-bit unsigned integer value from memory and returns it as a 32-bit integer. */
  export function load16_u(ptr: usize, immOffset?: usize, immAlign?: usize): i32;
  /** Loads a 32-bit integer value from memory. */
  export function load(ptr: usize, immOffset?: usize, immAlign?: usize): i32;
  /** Stores a 32-bit integer value to memory as an 8-bit integer. */
  export function store8(ptr: usize, value: i32, immOffset?: usize, immAlign?: usize): void;
  /** Stores a 32-bit integer value to memory as a 16-bit integer. */
  export function store16(ptr: usize, value: i32, immOffset?: usize, immAlign?: usize): void;
  /** Stores a 32-bit integer value to memory. */
  export function store(ptr: usize, value: i32, immOffset?: usize, immAlign?: usize): void;
  /** Performs the sign-agnostic count leading zero bits operation on a 32-bit integer. All zero bits are considered leading if the value is zero. */
  export function clz(value: i32): i32;
  /** Performs the sign-agnostic count tailing zero bits operation on a 32-bit integer. All zero bits are considered trailing if the value is zero. */
  export function ctz(value: i32): i32;
  /** Performs the sign-agnostic count number of one bits operation on a 32-bit integer. */
  export function popcnt(value: i32): i32;
  /** Performs the sign-agnostic rotate left operation on a 32-bit integer. */
  export function rotl(value: i32, shift: i32): i32;
  /** Performs the sign-agnostic rotate right operation on a 32-bit integer. */
  export function rotr(value: i32, shift: i32): i32;
  /** Reinterprets the bits of the specified 32-bit float as a 32-bit integer. */
  export function reinterpret_f32(value: f32): i32;
  /** Computes the sum of two 32-bit integers. */
  export function add(left: i32, right: i32): i32;
  /** Computes the difference of two 32-bit integers. */
  export function sub(left: i32, right: i32): i32;
  /** Computes the product of two 32-bit integers. */
  export function mul(left: i32, right: i32): i32;
  /** Computes the signed quotient of two 32-bit integers. */
  export function div_s(left: i32, right: i32): i32;
  /** Computes the unsigned quotient of two 32-bit integers. */
  export function div_u(left: i32, right: i32): i32;
  /** Return 1 if two 32-bit integers are equal to each other, 0 otherwise. */
  export function eq(left: i32, right: i32): i32;
  /** Return 0 if two 32-bit integers are equal to each other, 1 otherwise. */
  export function ne(left: i32, right: i32): i32;
  /** Computes the signed remainder of two 32-bit integers. */
  export function rem_s(left: i32, right: i32): i32;
  /** Computes the unsigned remainder of two 32-bit integers. */
  export function rem_u(left: u32, right: u32): u32;

  /** Atomic 32-bit integer operations. */
  export namespace atomic {
    /** Atomically loads an 8-bit unsigned integer value from memory and returns it as a 32-bit integer. */
    export function load8_u(ptr: usize, immOffset?: usize): i32;
    /** Atomically loads a 16-bit unsigned integer value from memory and returns it as a 32-bit integer. */
    export function load16_u(ptr: usize, immOffset?: usize): i32;
    /** Atomically loads a 32-bit integer value from memory and returns it. */
    export function load(ptr: usize, immOffset?: usize): i32;
    /** Atomically stores a 32-bit integer value to memory as an 8-bit integer. */
    export function store8(ptr: usize, value: i32, immOffset?: usize): void;
    /** Atomically stores a 32-bit integer value to memory as a 16-bit integer. */
    export function store16(ptr: usize, value: i32, immOffset?: usize): void;
    /** Atomically stores a 32-bit integer value to memory. */
    export function store(ptr: usize, value: i32, immOffset?: usize): void;
    /** Atomic 32-bit integer read-modify-write operations on 8-bit values. */
    export namespace rmw8 {
      /** Atomically adds an 8-bit unsigned integer value in memory. */
      export function add_u(ptr: usize, value: i32, immOffset?: usize): i32;
      /** Atomically subtracts an 8-bit unsigned integer value in memory. */
      export function sub_u(ptr: usize, value: i32, immOffset?: usize): i32;
      /** Atomically performs a bitwise AND operation an 8-bit unsigned integer value in memory. */
      export function and_u(ptr: usize, value: i32, immOffset?: usize): i32;
      /** Atomically performs a bitwise OR operation an 8-bit unsigned integer value in memory. */
      export function or_u(ptr: usize, value: i32, immOffset?: usize): i32;
      /** Atomically performs a bitwise XOR operation an 8-bit unsigned integer value in memory. */
      export function xor_u(ptr: usize, value: i32, immOffset?: usize): i32;
      /** Atomically exchanges an 8-bit unsigned integer value in memory. */
      export function xchg_u(ptr: usize, value: i32, immOffset?: usize): i32;
      /** Atomically compares and exchanges an 8-bit unsigned integer value in memory if the condition is met. */
      export function cmpxchg_u(ptr: usize, expected: i32, replacement: i32, immOffset?: usize): i32;
    }
    /** Atomic 32-bit integer read-modify-write operations on 16-bit values. */
    export namespace rmw16 {
      /** Atomically adds a 16-bit unsigned integer value in memory. */
      export function add_u(ptr: usize, value: i32, immOffset?: usize): i32;
      /** Atomically adds a 16-bit unsigned integer value in memory. */
      export function sub_u(ptr: usize, value: i32, immOffset?: usize): i32;
      /** Atomically performs a bitwise AND operation a 16-bit unsigned integer value in memory. */
      export function and_u(ptr: usize, value: i32, immOffset?: usize): i32;
      /** Atomically performs a bitwise OR operation a 16-bit unsigned integer value in memory. */
      export function or_u(ptr: usize, value: i32, immOffset?: usize): i32;
      /** Atomically performs a bitwise XOR operation a 16-bit unsigned integer value in memory. */
      export function xor_u(ptr: usize, value: i32, immOffset?: usize): i32;
      /** Atomically exchanges a 16-bit unsigned integer value in memory. */
      export function xchg_u(ptr: usize, value: i32, immOffset?: usize): i32;
      /** Atomically compares and exchanges a 16-bit unsigned integer value in memory if the condition is met. */
      export function cmpxchg_u(ptr: usize, expected: i32, replacement: i32, immOffset?: usize): i32;
    }
    /** Atomic 32-bit integer read-modify-write operations. */
    export namespace rmw {
      /** Atomically adds a 32-bit integer value in memory. */
      export function add(ptr: usize, value: i32, immOffset?: usize): i32;
      /** Atomically subtracts a 32-bit integer value in memory. */
      export function sub(ptr: usize, value: i32, immOffset?: usize): i32;
      /** Atomically performs a bitwise AND operation a 32-bit integer value in memory. */
      export function and(ptr: usize, value: i32, immOffset?: usize): i32;
      /** Atomically performs a bitwise OR operation a 32-bit integer value in memory. */
      export function or(ptr: usize, value: i32, immOffset?: usize): i32;
      /** Atomically performs a bitwise XOR operation a 32-bit integer value in memory. */
      export function xor(ptr: usize, value: i32, immOffset?: usize): i32;
      /** Atomically exchanges a 32-bit integer value in memory. */
      export function xchg(ptr: usize, value: i32, immOffset?: usize): i32;
      /** Atomically compares and exchanges a 32-bit integer value in memory if the condition is met. */
      export function cmpxchg(ptr: usize, expected: i32, replacement: i32, immOffset?: usize): i32;
    }
  }
}
/** Converts any other numeric value to a 64-bit signed integer. */
declare function i64(value: any): i64;
declare namespace i64 {
  /** Smallest representable value. */
  export const MIN_VALUE: i64;
  /** Largest representable value. */
  export const MAX_VALUE: i64;
  /** Parses a string as an i64. */
  export function parse(value: string, radix?: i32): i64;
  /** Loads an 8-bit signed integer value from memory and returns it as a 64-bit integer. */
  export function load8_s(ptr: usize, immOffset?: usize, immAlign?: usize): i64;
  /** Loads an 8-bit unsigned integer value from memory and returns it as a 64-bit integer. */
  export function load8_u(ptr: usize, immOffset?: usize, immAlign?: usize): i64;
  /** Loads a 16-bit signed integer value from memory and returns it as a 64-bit integer. */
  export function load16_s(ptr: usize, immOffset?: usize, immAlign?: usize): i64;
  /** Loads a 16-bit unsigned integer value from memory and returns it as a 64-bit integer. */
  export function load16_u(ptr: usize, immOffset?: usize, immAlign?: usize): i64;
  /** Loads a 32-bit signed integer value from memory and returns it as a 64-bit integer. */
  export function load32_s(ptr: usize, immOffset?: usize, immAlign?: usize): i64;
  /** Loads a 32-bit unsigned integer value from memory and returns it as a 64-bit integer. */
  export function load32_u(ptr: usize, immOffset?: usize, immAlign?: usize): i64;
  /** Loads a 64-bit unsigned integer value from memory. */
  export function load(ptr: usize, immOffset?: usize, immAlign?: usize): i64;
  /** Stores a 64-bit integer value to memory as an 8-bit integer. */
  export function store8(ptr: usize, value: i64, immOffset?: usize, immAlign?: usize): void;
  /** Stores a 64-bit integer value to memory as a 16-bit integer. */
  export function store16(ptr: usize, value: i64, immOffset?: usize, immAlign?: usize): void;
  /** Stores a 64-bit integer value to memory as a 32-bit integer. */
  export function store32(ptr: usize, value: i64, immOffset?: usize, immAlign?: usize): void;
  /** Stores a 64-bit integer value to memory. */
  export function store(ptr: usize, value: i64, immOffset?: usize, immAlign?: usize): void;
  /** Performs the sign-agnostic count leading zero bits operation on a 64-bit integer. All zero bits are considered leading if the value is zero. */
  export function clz(value: i64): i64;
  /** Performs the sign-agnostic count tailing zero bits operation on a 64-bit integer. All zero bits are considered trailing if the value is zero. */
  export function ctz(value: i64): i64;
  /** Performs the sign-agnostic count number of one bits operation on a 64-bit integer. */
  export function popcnt(value: i64): i64;
  /** Performs the sign-agnostic rotate left operation on a 64-bit integer. */
  export function rotl(value: i64, shift: i64): i64;
  /** Performs the sign-agnostic rotate right operation on a 64-bit integer. */
  export function rotr(value: i64, shift: i64): i64;
  /** Reinterprets the bits of the specified 64-bit float as a 64-bit integer. */
  export function reinterpret_f64(value: f64): i64;
  /** Computes the sum of two 64-bit integers. */
  export function add(left: i64, right: i64): i64;
  /** Computes the difference of two 64-bit integers. */
  export function sub(left: i64, right: i64): i64;
  /** Computes the product of two 64-bit integers. */
  export function mul(left: i64, right: i64): i64;
  /** Computes the signed quotient of two 64-bit integers. */
  export function div_s(left: i64, right: i64): i64;
  /** Computes the unsigned quotient of two 64-bit integers. */
  export function div_u(left: i64, right: i64): i64;
  /** Return 1 if two 64-bit integers are equal to each other, 0 otherwise. */
  export function eq(left: i64, right: i64): i32;
  /** Return 0 if two 64-bit integers are equal to each other, 1 otherwise. */
  export function ne(left: i64, right: i64): i32;
  /** Computes the signed remainder of two 64-bit integers. */
  export function rem_s(left: i64, right: i64): i64;
  /** Computes the unsigned remainder of two 64-bit integers. */
  export function rem_u(left: u64, right: u64): u64;

  /** Atomic 64-bit integer operations. */
  export namespace atomic {
    /** Atomically loads an 8-bit unsigned integer value from memory and returns it as a 64-bit integer. */
    export function load8_u(ptr: usize, immOffset?: usize): i64;
    /** Atomically loads a 16-bit unsigned integer value from memory and returns it as a 64-bit integer. */
    export function load16_u(ptr: usize, immOffset?: usize): i64;
    /** Atomically loads a 32-bit unsigned integer value from memory and returns it as a 64-bit integer. */
    export function load32_u(ptr: usize, immOffset?: usize): i64;
    /** Atomically loads a 64-bit integer value from memory and returns it. */
    export function load(ptr: usize, immOffset?: usize): i64;
    /** Atomically stores a 64-bit integer value to memory as an 8-bit integer. */
    export function store8(ptr: usize, value: i64, immOffset?: usize): void;
    /** Atomically stores a 64-bit integer value to memory as a 16-bit integer. */
    export function store16(ptr: usize, value: i64, immOffset?: usize): void;
    /** Atomically stores a 64-bit integer value to memory as a 32-bit integer. */
    export function store32(ptr: usize, value: i64, immOffset?: usize): void;
    /** Atomically stores a 64-bit integer value to memory. */
    export function store(ptr: usize, value: i64, immOffset?: usize): void;
    /** Atomic 64-bit integer read-modify-write operations on 8-bit values. */
    export namespace rmw8 {
      /** Atomically adds an 8-bit unsigned integer value in memory. */
      export function add_u(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically subtracts an 8-bit unsigned integer value in memory. */
      export function sub_u(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically performs a bitwise AND operation on an 8-bit unsigned integer value in memory. */
      export function and_u(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically performs a bitwise OR operation on an 8-bit unsigned integer value in memory. */
      export function or_u(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically performs a bitwise XOR operation on an 8-bit unsigned integer value in memory. */
      export function xor_u(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically exchanges an 8-bit unsigned integer value in memory. */
      export function xchg_u(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically compares and exchanges an 8-bit unsigned integer value in memory if the condition is met. */
      export function cmpxchg_u(ptr: usize, expected: i64, replacement: i64, immOffset?: usize): i64;
    }
    /** Atomic 64-bit integer read-modify-write operations on 16-bit values. */
    export namespace rmw16 {
      /** Atomically adds a 16-bit unsigned integer value in memory. */
      export function add_u(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically subtracts a 16-bit unsigned integer value in memory. */
      export function sub_u(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically performs a bitwise AND operation on a 16-bit unsigned integer value in memory. */
      export function and_u(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically performs a bitwise OR operation on a 16-bit unsigned integer value in memory. */
      export function or_u(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically performs a bitwise XOR operation on a 16-bit unsigned integer value in memory. */
      export function xor_u(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically exchanges a 16-bit unsigned integer value in memory. */
      export function xchg_u(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically compares and exchanges a 16-bit unsigned integer value in memory if the condition is met. */
      export function cmpxchg_u(ptr: usize, expected: i64, replacement: i64, immOffset?: usize): i64;
    }
    /** Atomic 64-bit integer read-modify-write operations on 32-bit values. */
    export namespace rmw32 {
      /** Atomically adds a 32-bit unsigned integer value in memory. */
      export function add_u(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically subtracts a 32-bit unsigned integer value in memory. */
      export function sub_u(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically performs a bitwise AND operation on a 32-bit unsigned integer value in memory. */
      export function and_u(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically performs a bitwise OR operation on a 32-bit unsigned integer value in memory. */
      export function or_u(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically performs a bitwise XOR operation on a 32-bit unsigned integer value in memory. */
      export function xor_u(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically exchanges a 32-bit unsigned integer value in memory. */
      export function xchg_u(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically compares and exchanges a 32-bit unsigned integer value in memory if the condition is met. */
      export function cmpxchg_u(ptr: usize, expected: i64, replacement: i64, immOffset?: usize): i64;
    }
    /** Atomic 64-bit integer read-modify-write operations. */
    export namespace rmw {
      /** Atomically adds a 64-bit integer value in memory. */
      export function add(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically subtracts a 64-bit integer value in memory. */
      export function sub(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically performs a bitwise AND operation on a 64-bit integer value in memory. */
      export function and(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically performs a bitwise OR operation on a 64-bit integer value in memory. */
      export function or(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically performs a bitwise XOR operation on a 64-bit integer value in memory. */
      export function xor(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically exchanges a 64-bit integer value in memory. */
      export function xchg(ptr: usize, value: i64, immOffset?: usize): i64;
      /** Atomically compares and exchanges a 64-bit integer value in memory if the condition is met. */
      export function cmpxchg(ptr: usize, expected: i64, replacement: i64, immOffset?: usize): i64;
    }
  }
}
/** Converts any other numeric value to a 32-bit (in WASM32) respectivel 64-bit (in WASM64) signed integer. */
declare let isize: typeof i32 | typeof i64;
/** Converts any other numeric value to an 8-bit unsigned integer. */
declare function u8(value: any): u8;
declare namespace u8 {
  /** Smallest representable value. */
  export const MIN_VALUE: u8;
  /** Largest representable value. */
  export const MAX_VALUE: u8;
  /** Parses a string as an u8. */
  export function parse(value: string, radix?: i32): u8;
}
/** Converts any other numeric value to a 16-bit unsigned integer. */
declare function u16(value: any): u16;
declare namespace u16 {
  /** Smallest representable value. */
  export const MIN_VALUE: u16;
  /** Largest representable value. */
  export const MAX_VALUE: u16;
  /** Parses a string as an u16. */
  export function parse(value: string, radix?: i32): u16;
}
/** Converts any other numeric value to a 32-bit unsigned integer. */
declare function u32(value: any): u32;
declare namespace u32 {
  /** Smallest representable value. */
  export const MIN_VALUE: u32;
  /** Largest representable value. */
  export const MAX_VALUE: u32;
  /** Parses a string as an u32. */
  export function parse(value: string, radix?: i32): u32;
}
/** Converts any other numeric value to a 64-bit unsigned integer. */
declare function u64(value: any): u64;
declare namespace u64 {
  /** Smallest representable value. */
  export const MIN_VALUE: u64;
  /** Largest representable value. */
  export const MAX_VALUE: u64;
  /** Parses a string as an u64. */
  export function parse(value: string, radix?: i32): u64;
}
/** Converts any other numeric value to a 32-bit (in WASM32) respectivel 64-bit (in WASM64) unsigned integer. */
declare let usize: typeof u32 | typeof u64;
/** Converts any other numeric value to a 1-bit unsigned integer. */
declare function bool(value: any): bool;
declare namespace bool {
  /** Smallest representable value. */
  export const MIN_VALUE: bool;
  /** Largest representable value. */
  export const MAX_VALUE: bool;
  /** Parses a string as a bool. */
  export function parse(value: string): bool;
}
/** Converts any other numeric value to a 32-bit float. */
declare function f32(value: any): f32;
declare namespace f32 {
  /** Smallest representable value. */
  export const MIN_VALUE: f32;
  /** Largest representable value. */
  export const MAX_VALUE: f32;
  /** Smallest normalized positive value. */
  export const MIN_NORMAL_VALUE: f32;
  /** Smallest safely representable integer value. */
  export const MIN_SAFE_INTEGER: f32;
  /** Largest safely representable integer value. */
  export const MAX_SAFE_INTEGER: f32;
  /** Positive infinity value. */
  export const POSITIVE_INFINITY: f32;
  /** Negative infinity value. */
  export const NEGATIVE_INFINITY: f32;
  /** Not a number value. */
  export const NaN: f32;
  /** Difference between 1 and the smallest representable value greater than 1. */
  export const EPSILON: f32;
  /** Parses a string as an f32. */
  export function parse(value: string): f32;
  /** Loads a 32-bit float from memory. */
  export function load(ptr: usize, immOffset?: usize, immAlign?: usize): f32;
  /** Stores a 32-bit float to memory. */
  export function store(ptr: usize, value: f32, immOffset?: usize, immAlign?: usize): void;
  /** Computes the sum of two 32-bit floats. */
  export function add(left: f32, right: f32): f32;
  /** Computes the difference of two 32-bit floats. */
  export function sub(left: f32, right: f32): f32;
  /** Computes the product of two 32-bit floats. */
  export function mul(left: f32, right: f32): f32;
  /** Computes the quotient of two 32-bit floats. */
  export function div(left: f32, right: f32): f32;
  /** Return 1 two 32-bit floats are equal to each other, 0 otherwise. */
  export function eq(left: f32, right: f32): i32;
  /** Return 0 two 32-bit floats are equal to each other, 1 otherwise. */
  export function ne(left: f32, right: f32): i32;
  /** Computes the absolute value of a 32-bit float. */
  export function abs(value: f32): f32;
  /** Determines the maximum of two 32-bit floats. If either operand is \`NaN\`, returns \`NaN\`. */
  export function max(left: f32, right: f32): f32;
  /** Determines the minimum of two 32-bit floats. If either operand is \`NaN\`, returns \`NaN\`. */
  export function min(left: f32, right: f32): f32;
  /** Performs the ceiling operation on a 32-bit float. */
  export function ceil(value: f32): f32;
  /** Composes a 32-bit float from the magnitude of \`x\` and the sign of \`y\`. */
  export function copysign(x: f32, y: f32): f32;
  /** Performs the floor operation on a 32-bit float. */
  export function floor(value: f32): f32;
  /** Rounds to the nearest integer tied to even of a 32-bit float. */
  export function nearest(value: f32): f32;
  /** Reinterprets the bits of the specified 32-bit integer as a 32-bit float. */
  export function reinterpret_i32(value: i32): f32;
  /** Calculates the square root of a 32-bit float. */
  export function sqrt(value: f32): f32;
  /** Rounds to the nearest integer towards zero of a 32-bit float. */
  export function trunc(value: f32): f32;
}
/** Converts any other numeric value to a 64-bit float. */
declare function f64(value: any): f64;
declare namespace f64 {
  /** Smallest representable value. */
  export const MIN_VALUE: f64;
  /** Largest representable value. */
  export const MAX_VALUE: f64;
  /** Smallest normalized positive value. */
  export const MIN_NORMAL_VALUE: f64;
  /** Smallest safely representable integer value. */
  export const MIN_SAFE_INTEGER: f64;
  /** Largest safely representable integer value. */
  export const MAX_SAFE_INTEGER: f64;
  /** Positive infinity value. */
  export const POSITIVE_INFINITY: f64;
  /** Negative infinity value. */
  export const NEGATIVE_INFINITY: f64;
  /** Not a number value. */
  export const NaN: f64;
  /** Difference between 1 and the smallest representable value greater than 1. */
  export const EPSILON: f64;
  /** Parses a string as an f64. */
  export function parse(value: string): f64;
  /** Loads a 64-bit float from memory. */
  export function load(ptr: usize, immOffset?: usize, immAlign?: usize): f64;
  /** Stores a 64-bit float to memory. */
  export function store(ptr: usize, value: f64, immOffset?: usize, immAlign?: usize): void;
  /** Computes the sum of two 64-bit floats. */
  export function add(left: f64, right: f64): f64;
  /** Computes the difference of two 64-bit floats. */
  export function sub(left: f64, right: f64): f64;
  /** Computes the product of two 64-bit floats. */
  export function mul(left: f64, right: f64): f64;
  /** Computes the quotient of two 64-bit floats. */
  export function div(left: f64, right: f64): f64;
  /** Return 1 two 64-bit floats are equal to each other, 0 otherwise. */
  export function eq(left: f64, right: f64): i32;
  /** Return 0 two 32-bit floats are equal to each other, 1 otherwise. */
  export function ne(left: f64, right: f64): i32;
  /** Computes the absolute value of a 64-bit float. */
  export function abs(value: f64): f64;
  /** Determines the maximum of two 64-bit floats. If either operand is \`NaN\`, returns \`NaN\`. */
  export function max(left: f64, right: f64): f64;
  /** Determines the minimum of two 64-bit floats. If either operand is \`NaN\`, returns \`NaN\`. */
  export function min(left: f64, right: f64): f64;
  /** Performs the ceiling operation on a 64-bit float. */
  export function ceil(value: f64): f64;
  /** Composes a 64-bit float from the magnitude of \`x\` and the sign of \`y\`. */
  export function copysign(x: f64, y: f64): f64;
  /** Performs the floor operation on a 64-bit float. */
  export function floor(value: f64): f64;
  /** Rounds to the nearest integer tied to even of a 64-bit float. */
  export function nearest(value: f64): f64;
  /** Reinterprets the bits of the specified 64-bit integer as a 64-bit float. */
  export function reinterpret_i64(value: i64): f64;
  /** Calculates the square root of a 64-bit float. */
  export function sqrt(value: f64): f64;
  /** Rounds to the nearest integer towards zero of a 64-bit float. */
  export function trunc(value: f64): f64;
}
/** Initializes a 128-bit vector from sixteen 8-bit integer values. Arguments must be compile-time constants. */
declare function v128(a: i8, b: i8, c: i8, d: i8, e: i8, f: i8, g: i8, h: i8, i: i8, j: i8, k: i8, l: i8, m: i8, n: i8, o: i8, p: i8): v128;
declare namespace v128 {
  /** Creates a vector with identical lanes. */
  export function splat<T>(x: T): v128;
  /** Extracts one lane as a scalar. idx argument needs to be compile time constant. */
  export function extract_lane<T>(x: v128, idx: u8): T;
  /** Replaces one lane. idx argument needs to be compile time constant.*/
  export function replace_lane<T>(x: v128, idx: u8, value: T): v128;
  /** Selects lanes from either vector according to the specified lane indexes. */
  export function shuffle<T>(a: v128, b: v128, ...lanes: u8[]): v128;
  /** Selects 8-bit lanes from the first vector according to the indexes [0-15] specified by the 8-bit lanes of the second vector. */
  export function swizzle(a: v128, s: v128): v128;
  /** Loads a vector from memory. */
  export function load(ptr: usize, immOffset?: usize, immAlign?: usize): v128;
  /** Creates a vector by loading the lanes of the specified type and extending each to the next larger type. */
  export function load_ext<TFrom>(ptr: usize, immOffset?: usize, immAlign?: usize): v128;
  /** Creates a vector by loading a value of the specified type into the lowest bits and initializing all other bits of the vector to zero. */
  export function load_zero<TFrom>(ptr: usize, immOffset?: usize, immAlign?: usize): v128;
  /** Loads a single lane from memory into the specified lane of the given vector. Other lanes are bypassed as is. */
  export function load_lane<T>(ptr: usize, vec: v128, idx: u8, immOffset?: usize, immAlign?: usize): v128;
  /** Stores the single lane at the specified index of the given vector to memory. */
  export function store_lane<T>(ptr: usize, vec: v128, idx: u8, immOffset?: usize, immAlign?: usize): void;
  /** Creates a vector with eight 16-bit integer lanes by loading and sign extending eight 8-bit integers. */
  export function load8x8_s(ptr: usize, immOffset?: u32, immAlign?: u32): v128;
  /** Creates a vector with eight 16-bit integer lanes by loading and zero extending eight 8-bit integers. */
  export function load8x8_u(ptr: usize, immOffset?: u32, immAlign?: u32): v128;
  /** Creates a vector with four 32-bit integer lanes by loading and sign extending four 16-bit integers. */
  export function load16x4_s(ptr: usize, immOffset?: u32, immAlign?: u32): v128;
  /** Creates a vector with four 32-bit integer lanes by loading and zero extending four 16-bit integers. */
  export function load16x4_u(ptr: usize, immOffset?: u32, immAlign?: u32): v128;
  /** Creates a vector with two 64-bit integer lanes by loading and sign extending two 32-bit integers. */
  export function load32x2_s(ptr: usize, immOffset?: u32, immAlign?: u32): v128;
  /** Creates a vector with two 64-bit integer lanes by loading and zero extending two 32-bit integers. */
  export function load32x2_u(ptr: usize, immOffset?: u32, immAlign?: u32): v128;
  /** Creates a vector with identical lanes by loading the splatted value. */
  export function load_splat<T>(ptr: usize, immOffset?: usize, immAlign?: usize): v128;
  /** Loads an 8-bit integer and splats it sixteen times forming a new vector. */
  export function load8_splat(ptr: usize, immOffset?: usize, immAlign?: usize): v128;
  /** Loads a 16-bit integer and splats it eight times forming a new vector. */
  export function load16_splat(ptr: usize, immOffset?: usize, immAlign?: usize): v128;
  /** Loads a 32-bit integer and splats it four times forming a new vector. */
  export function load32_splat(ptr: usize, immOffset?: usize, immAlign?: usize): v128;
  /** Loads a 64-bit integer and splats it two times forming a new vector. */
  export function load64_splat(ptr: usize, immOffset?: usize, immAlign?: usize): v128;
  /** Creates a vector by loading a 32-bit value into the lowest bits and initializing all other bits of the vector to zero. */
  export function load32_zero(ptr: usize, immOffset?: usize, immAlign?: usize): v128;
  /** Creates a vector by loading a 64-bit value into the lowest bits and initializing all other bits of the vector to zero. */
  export function load64_zero(ptr: usize, immOffset?: usize, immAlign?: usize): v128;
  /** Loads a single 8-bit lane from memory into the specified lane of the given vector. Other lanes are bypassed as is. */
  export function load8_lane(ptr: usize, vec: v128, idx: u8, immOffset?: usize, immAlign?: usize): v128;
  /** Loads a single 16-bit lane from memory into the specified lane of the given vector. Other lanes are bypassed as is. */
  export function load16_lane(ptr: usize, vec: v128, idx: u8, immOffset?: usize, immAlign?: usize): v128;
  /** Loads a single 32-bit lane from memory into the specified lane of the given vector. Other lanes are bypassed as is. */
  export function load32_lane(ptr: usize, vec: v128, idx: u8, immOffset?: usize, immAlign?: usize): v128;
  /** Loads a single 64-bit lane from memory into the specified lane of the given vector. Other lanes are bypassed as is. */
  export function load64_lane(ptr: usize, vec: v128, idx: u8, immOffset?: usize, immAlign?: usize): v128;
  /** Stores the 8-bit lane at the specified lane of the given vector to memory. */
  export function store8_lane(ptr: usize, vec: v128, idx: u8, immOffset?: usize, immAlign?: usize): void;
  /** Stores the 16-bit lane at the specified lane of the given vector to memory. */
  export function store16_lane(ptr: usize, vec: v128, idx: u8, immOffset?: usize, immAlign?: usize): void;
  /** Stores the 32-bit lane at the specified lane of the given vector to memory. */
  export function store32_lane(ptr: usize, vec: v128, idx: u8, immOffset?: usize, immAlign?: usize): void;
  /** Stores the 64-bit lane at the specified lane of the given vector to memory. */
  export function store64_lane(ptr: usize, vec: v128, idx: u8, immOffset?: usize, immAlign?: usize): void;
  /** Stores a vector to memory. */
  export function store(ptr: usize, value: v128, immOffset?: usize, immAlign?: usize): void;
  /** Adds each lane. */
  export function add<T>(a: v128, b: v128): v128;
  /** Subtracts each lane. */
  export function sub<T>(a: v128, b: v128): v128;
  /** Multiplies each lane. */
  export function mul<T>(a: v128, b: v128): v128; // except i64
  /** Divides each lane. */
  export function div<T extends f32 | f64>(a: v128, b: v128): v128;
  /** Negates each lane of a vector. */
  export function neg<T>(a: v128): v128;
  /** Adds each lane using saturation. */
  export function add_sat<T>(a: v128, b: v128): v128;
  /** Subtracts each lane using saturation. */
  export function sub_sat<T>(a: v128, b: v128): v128;
  /** Performs a bitwise left shift on each lane of a vector by a scalar. */
  export function shl<T>(a: v128, b: i32): v128;
  /** Performs a bitwise right shift on each lane of a vector by a scalar. */
  export function shr<T>(a: v128, b: i32): v128;
  /** Performs the bitwise AND operation on two vectors. */
  export function and(a: v128, b: v128): v128;
  /** Performs the bitwise OR operation on two vectors. */
  export function or(a: v128, b: v128): v128;
  /** Performs the bitwise XOR operation on two vectors. */
  export function xor(a: v128, b: v128): v128;
  /** Performs the bitwise ANDNOT operation on two vectors. */
  export function andnot(a: v128, b: v128): v128;
  /** Performs the bitwise NOT operation on a vector. */
  export function not(a: v128): v128;
  /** Selects bits of either vector according to the specified mask. Selects from \`v1\` if the bit in \`mask\` is \`1\`, otherwise from \`v2\`. */
  export function bitselect(v1: v128, v2: v128, mask: v128): v128;
  /** Reduces a vector to a scalar indicating whether any lane is considered \`true\`. */
  export function any_true(a: v128): bool;
  /** Reduces a vector to a scalar indicating whether all lanes are considered \`true\`. */
  export function all_true<T>(a: v128): bool;
  /** Extracts the high bit of each lane and produces a scalar mask with all bits concatenated. */
  export function bitmask<T>(a: v128): i32;
  /** Counts the number of bits set to one within each lane. */
  export function popcnt<T>(a: v128): v128;
  /** Computes the minimum of each lane. */
  export function min<T>(a: v128, b: v128): v128;
  /** Computes the maximum of each lane. */
  export function max<T>(a: v128, b: v128): v128;
  /** Computes the pseudo-minimum of each lane. */
  export function pmin<T extends f32 | f64>(a: v128, b: v128): v128;
  /** Computes the pseudo-maximum of each lane. */
  export function pmax<T extends f32 | f64>(a: v128, b: v128): v128;
  /** Computes the dot product of two lanes each, yielding lanes one size wider than the input. */
  export function dot<T extends i16>(a: v128, b: v128): v128;
  /** Computes the average of each lane. */
  export function avgr<T extends u8 | u16>(a: v128, b: v128): v128;
  /** Computes the absolute value of each lane. */
  export function abs<T extends f32 | f64>(a: v128): v128;
  /** Computes the square root of each lane. */
  export function sqrt<T extends f32 | f64>(a: v128): v128;
  /** Performs the ceiling operation on each lane. */
  export function ceil<T extends f32 | f64>(a: v128): v128;
  /** Performs the floor operation on each lane. */
  export function floor<T extends f32 | f64>(a: v128): v128;
  /** Rounds to the nearest integer towards zero of each lane. */
  export function trunc<T extends f32 | f64>(a: v128): v128;
  /** Rounds to the nearest integer tied to even of each lane. */
  export function nearest<T extends f32 | f64>(a: v128): v128;
  /** Computes which lanes are equal. */
  export function eq<T>(a: v128, b: v128): v128;
  /** Computes which lanes are not equal. */
  export function ne<T>(a: v128, b: v128): v128;
  /** Computes which lanes of the first vector are less than those of the second. */
  export function lt<T>(a: v128, b: v128): v128;
  /** Computes which lanes of the first vector are less than or equal those of the second. */
  export function le<T>(a: v128, b: v128): v128;
  /** Computes which lanes of the first vector are greater than those of the second. */
  export function gt<T>(a: v128, b: v128): v128;
  /** Computes which lanes of the first vector are greater than or equal those of the second. */
  export function ge<T>(a: v128, b: v128): v128;
  /** Converts each lane of a vector from integer to single-precision floating point. */
  export function convert<TFrom extends i32 | u32>(a: v128): v128;
  /** Converts the low lanes of a vector from integer to double-precision floating point. */
  export function convert_low<TFrom extends i32 | u32>(a: v128): v128;
  /** Truncates each lane of a vector from single-precision floating point to integer with saturation. Takes the target type. */
  export function trunc_sat<TTo extends i32 | u32>(a: v128): v128;
  /** Truncates each lane of a vector from double-precision floating point to integer with saturation. Takes the target type. */
  export function trunc_sat_zero<TTo extends i32 | u32>(a: v128): v128;
  /** Narrows each lane to their respective narrower lanes. */
  export function narrow<TFrom extends i16 | i32>(a: v128, b: v128): v128;
  /** Extends the low lanes of a vector to their respective wider lanes. */
  export function extend_low<TFrom extends i8 | u8 | i16 | u16 | i32 | u32>(a: v128): v128;
  /** Extends the high lanes of a vector to their respective wider lanes. */
  export function extend_high<TFrom extends i8 | u8 | i16 | u16 | i32 | u32>(a: v128): v128;
  /** Adds lanes pairwise producing twice wider extended results. */
  export function extadd_pairwise<TFrom extends i8 | u8 | i16 | u16>(a: v128): v128;
  /** Demotes each float lane to lower precision. The higher lanes of the result are initialized to zero. */
  export function demote_zero<T extends f64 = f64>(a: v128): v128;
  /** Promotes the lower float lanes to higher precision. */
  export function promote_low<T extends f32 = f32>(a: v128): v128;
  /** Performs the line-wise saturating rounding multiplication in Q15 format (\`(a[i] * b[i] + (1 << (Q - 1))) >> Q\` where \`Q=15\`). */
  export function q15mulr_sat<T extends i16>(a: v128, b: v128): v128;
  /** Performs the lane-wise integer extended multiplication of the lower lanes producing a twice wider result than the inputs. */
  export function extmul_low<T extends i8 | u8 | i16 | u16 | i32 | u32>(a: v128, b: v128): v128;
  /** Performs the lane-wise integer extended multiplication of the higher lanes producing a twice wider result than the inputs. */
  export function extmul_high<T extends i8 | u8 | i16 | u16 | i32 | u32>(a: v128, b: v128): v128;
  /**
   * Selects 8-bit lanes from \`a\` using indices in \`s\`. Indices in the range [0-15] select the i-th element of \`a\`.
   * 
   * Unlike {@link v128.swizzle}, the result of an out of bounds index is implementation-defined, depending on hardware
   * capabilities: Either \`0\` or \`a[s[i]%16]\`.
   */
  export function relaxed_swizzle(a: v128, s: v128): v128;
  /**
   * Truncates each lane of a vector from 32-bit floating point to a 32-bit signed or unsigned integer as indicated by
   * \`T\`.
   *
   * Unlike {@link v128.trunc_sat}, the result of lanes out of bounds of the target type is implementation defined,
   * depending on hardware capabilities:
   * - If the input lane contains \`NaN\`, the result is either \`0\` or the respective maximum integer value.
   * - If the input lane contains a value otherwise out of bounds of the target type, the result is either the
   *   saturatated result or maximum integer value.
   */
  export function relaxed_trunc<T extends i32 | u32>(a: v128): v128;
  /**
   * Truncates each lane of a vector from 64-bit floating point to a 32-bit signed or unsigned integer as indicated by
   * \`T\`. Unused higher integer lanes of the result are initialized to zero.
   * 
   * Unlike {@link v128.trunc_sat_zero}, the result of lanes out of bounds of the target type is implementation defined,
   * depending on hardware capabilities:
   * - If the input lane contains \`NaN\`, the result is either \`0\` or the respective maximum integer value.
   * - If the input lane contains a value otherwise out of bounds of the target type, the result is either the
   *   saturatated result or maximum integer value.
   */
  export function relaxed_trunc_zero<T extends i32 | u32>(a: v128): v128;
  /**
   * Performs the fused multiply-add operation (\`a * b + c\`) on 32- or 64-bit floating point lanes as indicated by
   * \`T\`.
   * 
   * The result is implementation defined, depending on hardware capabilities:
   * - Either \`a * b\` is rounded once and the final result rounded again, or
   * - The expression is evaluated with higher precision and only rounded once
   */
  export function relaxed_madd<T>(a: v128, b: v128, c: v128): v128;
  /**
   * Performs the fused negative multiply-add operation (\`-(a * b) + c\`) on 32- or 64-bit floating point lanes as
   * indicated by \`T\`.
   * 
   * The result is implementation defined, depending on hardware capabilities:
   * - Either \`a * b\` is rounded once and the final result rounded again, or
   * - The expression is evaluated with higher precision and only rounded once
   */
  export function relaxed_nmadd<T>(a: v128, b: v128, c: v128): v128;
  /**
   * Selects 8-, 16-, 32- or 64-bit integer lanes as indicated by \`T\` from \`a\` or \`b\` based on masks in \`m\`.
   * 
   * Behaves like {@link v128.bitselect} if masks in \`m\` do have all bits either set (result is \`a[i]\`) or unset (result
   * is \`b[i]\`). Otherwise the result is implementation-defined, depending on hardware capabilities: If the most
   * significant bit of \`m\` is set, the result is either \`bitselect(a[i], b[i], mask)\` or \`a[i]\`, otherwise the result
   * is \`b[i]\`.
   */
  export function relaxed_laneselect<T>(a: v128, b: v128, m: v128): v128;
  /**
   * Computes the minimum of each 32- or 64-bit floating point lane as indicated by \`T\`.
   * 
   * Unlike {@link v128.min}, the result is implementation-defined if either value is \`NaN\` or both are \`-0.0\` and
   * \`+0.0\`, depending on hardware capabilities: Either \`a[i]\` or \`b[i]\`.
   */
  export function relaxed_min<T>(a: v128, b: v128): v128;
  /**
   * Computes the maximum of each 32- or 64-bit floating point lane as indicated by \`T\`.
   * 
   * Unlike {@link v128.max}, the result is implementation-defined if either value is \`NaN\` or both are \`-0.0\` and
   * \`+0.0\`, depending on hardware capabilities: Either \`a[i]\` or \`b[i]\`.
   */
  export function relaxed_max<T>(a: v128, b: v128): v128;
  /**
   * Performs the lane-wise rounding multiplication in Q15 format (\`(a[i] * b[i] + (1 << (Q - 1))) >> Q\` where \`Q=15\`).
   * 
   * Unlike {@link v128.q15mulr_sat}, the result is implementation-defined if both inputs are the minimum signed value:
   * Either the minimum or maximum signed value.
   */
  export function relaxed_q15mulr<T>(a: v128, b: v128): v128;
  /**
   * Computes the dot product of two 8-bit integer lanes each, yielding lanes one size wider than the input.
   * 
   * Unlike {@link v128.dot}, if the most significant bit of \`b[i]\` is set, whether \`b[i]\` is interpreted as signed or
   * unsigned is implementation-defined.
   */
  export function relaxed_dot<T>(a: v128, b: v128): v128;
  /**
   * Computes the dot product of two 8-bit integer lanes each, yielding lanes two sizes wider than the input with the
   * lanes of \`c\` accumulated into the result.
   * 
   * Unlike {@link v128.dot}, if the most significant bit of \`b[i]\` is set, whether \`b[i]\` is interpreted as signed or
   * unsigned by the intermediate multiplication is implementation-defined.
   */
  export function relaxed_dot_add<T>(a: v128, b: v128, c: v128): v128;
}
/** Initializes a 128-bit vector from sixteen 8-bit integer values. Arguments must be compile-time constants. */
declare function i8x16(a: i8, b: i8, c: i8, d: i8, e: i8, f: i8, g: i8, h: i8, i: i8, j: i8, k: i8, l: i8, m: i8, n: i8, o: i8, p: i8): v128;
declare namespace i8x16 {
  /** Creates a vector with sixteen identical 8-bit integer lanes. */
  export function splat(x: i8): v128;
  /** Extracts one 8-bit integer lane as a signed scalar. idx argument needs to be compile time constant. */
  export function extract_lane_s(x: v128, idx: u8): i8;
  /** Extracts one 8-bit integer lane as an unsigned scalar. idx argument needs to be compile time constant. */
  export function extract_lane_u(x: v128, idx: u8): u8;
  /** Replaces one 8-bit integer lane. idx argument needs to be compile time constant. */
  export function replace_lane(x: v128, idx: u8, value: i8): v128;
  /** Adds each 8-bit integer lane. */
  export function add(a: v128, b: v128): v128;
  /** Subtracts each 8-bit integer lane. */
  export function sub(a: v128, b: v128): v128;
  /** Computes the signed minimum of each 8-bit integer lane. */
  export function min_s(a: v128, b: v128): v128;
  /** Computes the unsigned minimum of each 8-bit integer lane. */
  export function min_u(a: v128, b: v128): v128;
  /** Computes the signed maximum of each 8-bit integer lane. */
  export function max_s(a: v128, b: v128): v128;
  /** Computes the unsigned maximum of each 8-bit integer lane. */
  export function max_u(a: v128, b: v128): v128;
  /** Computes the unsigned average of each 8-bit integer lane. */
  export function avgr_u(a: v128, b: v128): v128;
  /** Computes the absolute value of each 8-bit integer lane. */
  export function abs(a: v128): v128;
  /** Negates each 8-bit integer lane. */
  export function neg(a: v128): v128;
  /** Adds each 8-bit integer lane using signed saturation. */
  export function add_sat_s(a: v128, b: v128): v128;
  /** Adds each 8-bit integer lane using unsigned saturation. */
  export function add_sat_u(a: v128, b: v128): v128;
  /** Subtracts each 8-bit integer lane using signed saturation. */
  export function sub_sat_s(a: v128, b: v128): v128;
  /** Subtracts each 8-bit integer lane using unsigned saturation. */
  export function sub_sat_u(a: v128, b: v128): v128;
  /** Performs a bitwise left shift on each 8-bit integer lane by a scalar. */
  export function shl(a: v128, b: i32): v128;
  /** Performs a bitwise arithmetic right shift on each 8-bit integer lane by a scalar. */
  export function shr_s(a: v128, b: i32): v128;
  /** Performs a bitwise logical right shift on each 8-bit integer lane by a scalar. */
  export function shr_u(a: v128, b: i32): v128;
  /** Reduces a vector to a scalar indicating whether all 8-bit integer lanes are considered \`true\`. */
  export function all_true(a: v128): bool;
  /** Extracts the high bit of each 8-bit integer lane and produces a scalar mask with all bits concatenated. */
  export function bitmask(a: v128): i32;
  /** Counts the number of bits set to one within each 8-bit integer lane. */
  export function popcnt(a: v128): v128;
  /** Computes which 8-bit integer lanes are equal. */
  export function eq(a: v128, b: v128): v128;
  /** Computes which 8-bit integer lanes are not equal. */
  export function ne(a: v128, b: v128): v128;
  /** Computes which 8-bit signed integer lanes of the first vector are less than those of the second. */
  export function lt_s(a: v128, b: v128): v128;
  /** Computes which 8-bit unsigned integer lanes of the first vector are less than those of the second. */
  export function lt_u(a: v128, b: v128): v128;
  /** Computes which 8-bit signed integer lanes of the first vector are less than or equal those of the second. */
  export function le_s(a: v128, b: v128): v128;
  /** Computes which 8-bit unsigned integer lanes of the first vector are less than or equal those of the second. */
  export function le_u(a: v128, b: v128): v128;
  /** Computes which 8-bit signed integer lanes of the first vector are greater than those of the second. */
  export function gt_s(a: v128, b: v128): v128;
  /** Computes which 8-bit unsigned integer lanes of the first vector are greater than those of the second. */
  export function gt_u(a: v128, b: v128): v128;
  /** Computes which 8-bit signed integer lanes of the first vector are greater than or equal those of the second. */
  export function ge_s(a: v128, b: v128): v128;
  /** Computes which 8-bit unsigned integer lanes of the first vector are greater than or equal those of the second. */
  export function ge_u(a: v128, b: v128): v128;
  /** Narrows each 16-bit signed integer lane to 8-bit signed integer lanes. */
  export function narrow_i16x8_s(a: v128, b: v128): v128;
  /** Narrows each 16-bit signed integer lane to 8-bit unsigned integer lanes. */
  export function narrow_i16x8_u(a: v128, b: v128): v128;
  /** Selects 8-bit lanes from either vector according to the specified [0-15] respectively [16-31] lane indexes. */
  export function shuffle(a: v128, b: v128, l0: u8, l1: u8, l2: u8, l3: u8, l4: u8, l5: u8, l6: u8, l7: u8, l8: u8, l9: u8, l10: u8, l11: u8, l12: u8, l13: u8, l14: u8, l15: u8): v128;
  /** Selects 8-bit lanes from the first vector according to the indexes [0-15] specified by the 8-bit lanes of the second vector. */
  export function swizzle(a: v128, s: v128): v128;
  /**
   * Selects 8-bit integer lanes from \`a\` using indices in \`s\`. Indices in the range [0-15] select the i-th element of
   * \`a\`.
   * 
   * Unlike {@link i8x16.swizzle}, the result of an out of bounds index is implementation-defined, depending on hardware
   * capabilities: Either \`0\` or \`a[s[i]%16]\`.
   */
  export function relaxed_swizzle(a: v128, s: v128): v128;
  /**
   * Selects 8-bit integer lanes from \`a\` or \`b\` based on masks in \`m\`.
   * 
   * Behaves like {@link v128.bitselect} if masks in \`m\` do have all bits either set (result is \`a[i]\`) or unset (result
   * is \`b[i]\`). Otherwise the result is implementation-defined, depending on hardware capabilities: If the most
   * significant bit of \`m\` is set, the result is either \`bitselect(a[i], b[i], mask)\` or \`a[i]\`, otherwise the result
   * is \`b[i]\`.
   */
  export function relaxed_laneselect(a: v128, b: v128, m: v128): v128;
}
/** Initializes a 128-bit vector from eight 16-bit integer values. Arguments must be compile-time constants. */
declare function i16x8(a: i16, b: i16, c: i16, d: i16, e: i16, f: i16, g: i16, h: i16): v128;
declare namespace i16x8 {
  /** Creates a vector with eight identical 16-bit integer lanes. */
  export function splat(x: i16): v128;
  /** Extracts one 16-bit integer lane as a signed scalar. idx argument needs to be compile time constant. */
  export function extract_lane_s(x: v128, idx: u8): i16;
  /** Extracts one 16-bit integer lane as an unsigned scalar. idx argument needs to be compile time constant. */
  export function extract_lane_u(x: v128, idx: u8): u16;
  /** Replaces one 16-bit integer lane. idx argument needs to be compile time constant. */
  export function replace_lane(x: v128, idx: u8, value: i16): v128;
  /** Adds each 16-bit integer lane. */
  export function add(a: v128, b: v128): v128;
  /** Subtracts each 16-bit integer lane. */
  export function sub(a: v128, b: v128): v128;
  /** Multiplies each 16-bit integer lane. */
  export function mul(a: v128, b: v128): v128;
  /** Computes the signed minimum of each 16-bit integer lane. */
  export function min_s(a: v128, b: v128): v128;
  /** Computes the unsigned minimum of each 16-bit integer lane. */
  export function min_u(a: v128, b: v128): v128;
  /** Computes the signed maximum of each 16-bit integer lane. */
  export function max_s(a: v128, b: v128): v128;
  /** Computes the unsigned maximum of each 16-bit integer lane. */
  export function max_u(a: v128, b: v128): v128;
  /** Computes the unsigned average of each 16-bit integer lane. */
  export function avgr_u(a: v128, b: v128): v128;
  /** Computes the absolute value of each 16-bit integer lane. */
  export function abs(a: v128): v128;
  /** Negates each 16-bit integer lane. */
  export function neg(a: v128): v128;
  /** Adds each 16-bit integer lane using signed saturation. */
  export function add_sat_s(a: v128, b: v128): v128;
  /** Adds each 16-bit integer lane using unsigned saturation. */
  export function add_sat_u(a: v128, b: v128): v128;
  /** Subtracts each 16-bit integer lane using signed saturation. */
  export function sub_sat_s(a: v128, b: v128): v128;
  /** Subtracts each 16-bit integer lane using unsigned saturation. */
  export function sub_sat_u(a: v128, b: v128): v128;
  /** Performs a bitwise left shift on each 16-bit integer lane by a scalar. */
  export function shl(a: v128, b: i32): v128;
  /** Performs a bitwise arithmetic right shift each 16-bit integer lane by a scalar. */
  export function shr_s(a: v128, b: i32): v128;
  /** Performs a bitwise logical right shift on each 16-bit integer lane by a scalar. */
  export function shr_u(a: v128, b: i32): v128;
  /** Reduces a vector to a scalar indicating whether all 16-bit integer lanes are considered \`true\`. */
  export function all_true(a: v128): bool;
  /** Extracts the high bit of each 16-bit integer lane and produces a scalar mask with all bits concatenated. */
  export function bitmask(a: v128): i32;
  /** Computes which 16-bit integer lanes are equal. */
  export function eq(a: v128, b: v128): v128;
  /** Computes which 16-bit integer lanes are not equal. */
  export function ne(a: v128, b: v128): v128;
  /** Computes which 16-bit signed integer lanes of the first vector are less than those of the second. */
  export function lt_s(a: v128, b: v128): v128;
  /** Computes which 16-bit unsigned integer lanes of the first vector are less than those of the second. */
  export function lt_u(a: v128, b: v128): v128;
  /** Computes which 16-bit signed integer lanes of the first vector are less than or equal those of the second. */
  export function le_s(a: v128, b: v128): v128;
  /** Computes which 16-bit unsigned integer lanes of the first vector are less than or equal those of the second. */
  export function le_u(a: v128, b: v128): v128;
  /** Computes which 16-bit signed integer lanes of the first vector are greater than those of the second. */
  export function gt_s(a: v128, b: v128): v128;
  /** Computes which 16-bit unsigned integer lanes of the first vector are greater than those of the second. */
  export function gt_u(a: v128, b: v128): v128;
  /** Computes which 16-bit signed integer lanes of the first vector are greater than or equal those of the second. */
  export function ge_s(a: v128, b: v128): v128;
  /** Computes which 16-bit unsigned integer lanes of the first vector are greater than or equal those of the second. */
  export function ge_u(a: v128, b: v128): v128;
  /** Narrows each 32-bit signed integer lane to 16-bit signed integer lanes. */
  export function narrow_i32x4_s(a: v128, b: v128): v128;
  /** Narrows each 32-bit signed integer lane to 16-bit unsigned integer lanes. */
  export function narrow_i32x4_u(a: v128, b: v128): v128;
  /** Extends the low 8-bit signed integer lanes to 16-bit signed integer lanes. */
  export function extend_low_i8x16_s(a: v128): v128;
  /** Extends the low 8-bit unsigned integer lanes to 16-bit unsigned integer lanes. */
  export function extend_low_i8x16_u(a: v128): v128;
  /** Extends the high 8-bit signed integer lanes to 16-bit signed integer lanes. */
  export function extend_high_i8x16_s(a: v128): v128;
  /** Extends the high 8-bit unsigned integer lanes to 16-bit unsigned integer lanes. */
  export function extend_high_i8x16_u(a: v128): v128;
  /** Adds the sixteen 8-bit signed integer lanes pairwise producing eight 16-bit signed integer results. */
  export function extadd_pairwise_i8x16_s(a: v128): v128;
  /** Adds the sixteen 8-bit unsigned integer lanes pairwise producing eight 16-bit unsigned integer results. */
  export function extadd_pairwise_i8x16_u(a: v128): v128;
  /** Performs the line-wise 16-bit signed integer saturating rounding multiplication in Q15 format. */
  export function q15mulr_sat_s(a: v128, b: v128): v128;
  /** Performs the lane-wise 8-bit signed integer extended multiplication of the eight lower lanes producing twice wider 16-bit integer results. */
  export function extmul_low_i8x16_s(a: v128, b: v128): v128;
  /** Performs the lane-wise 8-bit unsigned integer extended multiplication of the eight lower lanes producing twice wider 16-bit integer results. */
  export function extmul_low_i8x16_u(a: v128, b: v128): v128;
  /** Performs the lane-wise 8-bit signed integer extended multiplication of the eight higher lanes producing twice wider 16-bit integer results. */
  export function extmul_high_i8x16_s(a: v128, b: v128): v128;
  /** Performs the lane-wise 8-bit unsigned integer extended multiplication of the eight higher lanes producing twice wider 16-bit integer results. */
  export function extmul_high_i8x16_u(a: v128, b: v128): v128;
  /** Selects 16-bit lanes from either vector according to the specified [0-7] respectively [8-15] lane indexes. */
  export function shuffle(a: v128, b: v128, l0: u8, l1: u8, l2: u8, l3: u8, l4: u8, l5: u8, l6: u8, l7: u8): v128;
  /**
   * Selects 16-bit integer lanes from \`a\` or \`b\` based on masks in \`m\`.
   *
   * Behaves like {@link v128.bitselect} if masks in \`m\` do have all bits either set (result is \`a[i]\`) or unset (result
   * is \`b[i]\`). Otherwise the result is implementation-defined, depending on hardware capabilities: If the most
   * significant bit of \`m\` is set, the result is either \`bitselect(a[i], b[i], mask)\` or \`a[i]\`, otherwise the result
   * is \`b[i]\`.
   */
  export function relaxed_laneselect(a: v128, b: v128, m: v128): v128;
  /**
   * Performs the line-wise rounding multiplication in Q15 format (\`(a[i] * b[i] + (1 << (Q - 1))) >> Q\` where \`Q=15\`).
   *
   * Some results are implementation-defined: If both inputs are \`i16.MIN_VALUE\`, the value of the respective
   * resulting lane may be either \`i16.MIN_VALUE\` or \`i16.MAX_VALUE\`.
   */
  export function relaxed_q15mulr_s(a: v128, b: v128): v128;
  /**
   * Computes the dot product of two 8-bit integer lanes each, yielding lanes one size wider than the input.
   * 
   * Some results are implementation-defined: If the most significant bit of \`b[i]\` is set, the intermediate
   * multiplication may interpret \`b[i]\` as either signed or unsigned.
   */
  export function relaxed_dot_i8x16_i7x16_s(a: v128, b: v128): v128;
}
/** Initializes a 128-bit vector from four 32-bit integer values. Arguments must be compile-time constants. */
declare function i32x4(a: i32, b: i32, c: i32, d: i32): v128;
declare namespace i32x4 {
  /** Creates a vector with four identical 32-bit integer lanes. */
  export function splat(x: i32): v128;
  /** Extracts one 32-bit integer lane as a scalar. idx argument needs to be compile time constant. */
  export function extract_lane(x: v128, idx: u8): i32;
  /** Replaces one 32-bit integer lane. idx argument needs to be compile time constant. */
  export function replace_lane(x: v128, idx: u8, value: i32): v128;
  /** Adds each 32-bit integer lane. */
  export function add(a: v128, b: v128): v128;
  /** Subtracts each 32-bit integer lane. */
  export function sub(a: v128, b: v128): v128;
  /** Multiplies each 32-bit integer lane. */
  export function mul(a: v128, b: v128): v128;
  /** Computes the signed minimum of each 32-bit integer lane. */
  export function min_s(a: v128, b: v128): v128;
  /** Computes the unsigned minimum of each 32-bit integer lane. */
  export function min_u(a: v128, b: v128): v128;
  /** Computes the signed maximum of each 32-bit integer lane. */
  export function max_s(a: v128, b: v128): v128;
  /** Computes the unsigned maximum of each 32-bit integer lane. */
  export function max_u(a: v128, b: v128): v128;
  /** Computes the dot product of two 16-bit integer lanes each, yielding 32-bit integer lanes. */
  export function dot_i16x8_s(a: v128, b: v128): v128;
  /** Computes the absolute value of each 32-bit integer lane. */
  export function abs(a: v128): v128;
  /** Negates each 32-bit integer lane. */
  export function neg(a: v128): v128;
  /** Performs a bitwise left shift on each 32-bit integer lane by a scalar. */
  export function shl(a: v128, b: i32): v128;
  /** Performs a bitwise arithmetic right shift on each 32-bit integer lane by a scalar. */
  export function shr_s(a: v128, b: i32): v128;
  /** Performs a bitwise logical right shift on each 32-bit integer lane by a scalar. */
  export function shr_u(a: v128, b: i32): v128;
  /** Reduces a vector to a scalar indicating whether all 32-bit integer lanes are considered \`true\`. */
  export function all_true(a: v128): bool;
  /** Extracts the high bit of each 32-bit integer lane and produces a scalar mask with all bits concatenated. */
  export function bitmask(a: v128): i32;
  /** Computes which 32-bit integer lanes are equal. */
  export function eq(a: v128, b: v128): v128;
  /** Computes which 32-bit integer lanes are not equal. */
  export function ne(a: v128, b: v128): v128;
  /** Computes which 32-bit signed integer lanes of the first vector are less than those of the second. */
  export function lt_s(a: v128, b: v128): v128;
  /** Computes which 32-bit unsigned integer lanes of the first vector are less than those of the second. */
  export function lt_u(a: v128, b: v128): v128;
  /** Computes which 32-bit signed integer lanes of the first vector are less than or equal those of the second. */
  export function le_s(a: v128, b: v128): v128;
  /** Computes which 32-bit unsigned integer lanes of the first vector are less than or equal those of the second. */
  export function le_u(a: v128, b: v128): v128;
  /** Computes which 32-bit signed integer lanes of the first vector are greater than those of the second. */
  export function gt_s(a: v128, b: v128): v128;
  /** Computes which 32-bit unsigned integer lanes of the first vector are greater than those of the second. */
  export function gt_u(a: v128, b: v128): v128;
  /** Computes which 32-bit signed integer lanes of the first vector are greater than or equal those of the second. */
  export function ge_s(a: v128, b: v128): v128;
  /** Computes which 32-bit unsigned integer lanes of the first vector are greater than or equal those of the second. */
  export function ge_u(a: v128, b: v128): v128;
  /** Truncates each 32-bit float lane to a signed integer with saturation. */
  export function trunc_sat_f32x4_s(a: v128): v128;
  /** Truncates each 32-bit float lane to an unsigned integer with saturation. */
  export function trunc_sat_f32x4_u(a: v128): v128;
  /** Truncates the two 64-bit float lanes to the two lower signed integer lanes with saturation. The two higher integer lanes of the result are initialized to zero. */
  export function trunc_sat_f64x2_s_zero(a: v128): v128;
  /** Truncates the two 64-bit float lanes to the two lower unsigned integer lanes with saturation. The two higher integer lanes of the result are initialized to zero. */
  export function trunc_sat_f64x2_u_zero(a: v128): v128;
  /** Extends the low 16-bit signed integer lanes to 32-bit signed integer lanes. */
  export function extend_low_i16x8_s(a: v128): v128;
  /** Extends the low 16-bit unsigned integer lane to 32-bit unsigned integer lanes. */
  export function extend_low_i16x8_u(a: v128): v128;
  /** Extends the high 16-bit signed integer lanes to 32-bit signed integer lanes. */
  export function extend_high_i16x8_s(a: v128): v128;
  /** Extends the high 16-bit unsigned integer lanes to 32-bit unsigned integer lanes. */
  export function extend_high_i16x8_u(a: v128): v128;
  /** Adds the eight 16-bit signed integer lanes pairwise producing four 32-bit signed integer results. */
  export function extadd_pairwise_i16x8_s(a: v128): v128;
  /** Adds the eight 16-bit unsigned integer lanes pairwise producing four 32-bit unsigned integer results. */
  export function extadd_pairwise_i16x8_u(a: v128): v128;
  /** Performs the lane-wise 16-bit signed integer extended multiplication of the four lower lanes producing twice wider 32-bit integer results. */
  export function extmul_low_i16x8_s(a: v128, b: v128): v128;
  /** Performs the lane-wise 16-bit unsigned integer extended multiplication of the four lower lanes producing twice wider 32-bit integer results. */
  export function extmul_low_i16x8_u(a: v128, b: v128): v128;
  /** Performs the lane-wise 16-bit signed integer extended multiplication of the four higher lanes producing twice wider 32-bit integer results. */
  export function extmul_high_i16x8_s(a: v128, b: v128): v128;
  /** Performs the lane-wise 16-bit unsigned integer extended multiplication of the four higher lanes producing twice wider 32-bit integer results. */
  export function extmul_high_i16x8_u(a: v128, b: v128): v128;
  /** Selects 32-bit lanes from either vector according to the specified [0-3] respectively [4-7] lane indexes. */
  export function shuffle(a: v128, b: v128, l0: u8, l1: u8, l2: u8, l3: u8): v128;
  /**
   * Truncates each lane of a vector from 32-bit floating point to a signed 32-bit integer.
   *
   * Unlike {@link i32x4.trunc_sat_f32x4_s}, the result of lanes out of bounds of the target type is implementation
   * defined, depending on hardware capabilities:
   * - If the input lane contains \`NaN\`, the result is either \`0\` or the respective maximum integer value.
   * - If the input lane contains a value otherwise out of bounds of the target type, the result is either the
   *   saturatated result or maximum integer value.
   */
  export function relaxed_trunc_f32x4_s(a: v128): v128;
  /**
   * Truncates each lane of a vector from 32-bit floating point to an unsigned 32-bit integer.
   *
   * Unlike {@link i32x4.trunc_sat_f32x4_u}, the result of lanes out of bounds of the target type is implementation
   * defined, depending on hardware capabilities:
   * - If the input lane contains \`NaN\`, the result is either \`0\` or the respective maximum integer value.
   * - If the input lane contains a value otherwise out of bounds of the target type, the result is either the
   *   saturatated result or maximum integer value.
   */
  export function relaxed_trunc_f32x4_u(a: v128): v128;
  /**
   * Truncates each lane of a vector from 64-bit floating point to a signed 32-bit integer. The two higher
   * integer lanes of the result are initialized to zero.
   * 
   * Unlike {@link i32x4.trunc_sat_f64x2_s_zero}, the result of lanes out of bounds of the target type is implementation
   * defined, depending on hardware capabilities:
   * - If the input lane contains \`NaN\`, the result is either \`0\` or the respective maximum integer value.
   * - If the input lane contains a value otherwise out of bounds of the target type, the result is either the
   *   saturatated result or maximum integer value.
   */
  export function relaxed_trunc_f64x2_s_zero(a: v128): v128;
  /**
   * Truncates each lane of a vector from 64-bit floating point to an unsigned 32-bit integer. The two higher
   * integer lanes of the result are initialized to zero.
   * 
   * Unlike {@link i32x4.trunc_sat_f64x2_u_zero}, the result of lanes out of bounds of the target type is implementation
   * defined, depending on hardware capabilities:
   * - If the input lane contains \`NaN\`, the result is either \`0\` or the respective maximum integer value.
   * - If the input lane contains a value otherwise out of bounds of the target type, the result is either the
   *   saturatated result or maximum integer value.
   */
  export function relaxed_trunc_f64x2_u_zero(a: v128): v128;
  /**
   * Selects 32-bit integer lanes from \`a\` or \`b\` based on masks in \`m\`.
   *
   * Behaves like {@link v128.bitselect} if masks in \`m\` do have all bits either set (result is \`a[i]\`) or unset (result
   * is \`b[i]\`). Otherwise the result is implementation-defined, depending on hardware capabilities: If the most
   * significant bit of \`m\` is set, the result is either \`bitselect(a[i], b[i], mask)\` or \`a[i]\`, otherwise the result
   * is \`b[i]\`.
   */
  export function relaxed_laneselect(a: v128, b: v128, m: v128): v128;
  /**
   * Computes the dot product of two 8-bit lanes each, yielding lanes two sizes wider than the input with the lanes of
   * \`c\` accumulated into the result.
   * 
   * Unlike {@link v128.dot}, if the most significant bit of \`b[i]\` is set, whether \`b[i]\` is interpreted as signed or
   * unsigned by the intermediate multiplication is implementation-defined.
   */
  export function relaxed_dot_i8x16_i7x16_add_s(a: v128, b: v128, c: v128): v128;
}
/** Initializes a 128-bit vector from two 64-bit integer values. Arguments must be compile-time constants. */
declare function i64x2(a: i64, b: i64): v128;
declare namespace i64x2 {
  /** Creates a vector with two identical 64-bit integer lanes. */
  export function splat(x: i64): v128;
  /** Extracts one 64-bit integer lane as a scalar. \`idx\` argument need to be compile time constant */
  export function extract_lane(x: v128, idx: u8): i64;
  /** Replaces one 64-bit integer lane. idx argument needs to be compile time constant. */
  export function replace_lane(x: v128, idx: u8, value: i64): v128;
  /** Adds each 64-bit integer lane. */
  export function add(a: v128, b: v128): v128;
  /** Subtracts each 64-bit integer lane. */
  export function sub(a: v128, b: v128): v128;
  /** Multiplies each 64-bit integer lane. */
  export function mul(a: v128, b: v128): v128;
  /** Computes the absolute value of each 64-bit integer lane. */
  export function abs(a: v128): v128;
  /** Negates each 64-bit integer lane. */
  export function neg(a: v128): v128;
  /** Performs a bitwise left shift on each 64-bit integer lane by a scalar. */
  export function shl(a: v128, b: i32): v128;
  /** Performs a bitwise arithmetic right shift on each 64-bit integer lane by a scalar. */
  export function shr_s(a: v128, b: i32): v128;
  /** Performs a bitwise logical right shift on each 64-bit integer lane by a scalar. */
  export function shr_u(a: v128, b: i32): v128;
  /** Reduces a vector to a scalar indicating whether all 64-bit integer lanes are considered \`true\`. */
  export function all_true(a: v128): bool;
  /** Extracts the high bit of each 64-bit integer lane and produces a scalar mask with all bits concatenated. */
  export function bitmask(a: v128): i32;
  /** Computes which 64-bit integer lanes are equal. */
  export function eq(a: v128, b: v128): v128;
  /** Computes which 64-bit integer lanes are not equal. */
  export function ne(a: v128, b: v128): v128;
  /** Computes which 64-bit signed integer lanes of the first vector are less than those of the second. */
  export function lt_s(a: v128, b: v128): v128;
  /** Computes which 64-bit signed integer lanes of the first vector are less than or equal those of the second. */
  export function le_s(a: v128, b: v128): v128;
  /** Computes which 64-bit signed integer lanes of the first vector are greater than those of the second. */
  export function gt_s(a: v128, b: v128): v128;
  /** Computes which 64-bit signed integer lanes of the first vector are greater than or equal those of the second. */
  export function ge_s(a: v128, b: v128): v128;
  /** Extends the low 32-bit signed integer lanes to 64-bit signed integer lanes. */
  export function extend_low_i32x4_s(a: v128): v128;
  /** Extends the low 32-bit unsigned integer lane to 64-bit unsigned integer lanes. */
  export function extend_low_i32x4_u(a: v128): v128;
  /** Extends the high 32-bit signed integer lanes to 64-bit signed integer lanes. */
  export function extend_high_i32x4_s(a: v128): v128;
  /** Extends the high 32-bit unsigned integer lanes to 64-bit unsigned integer lanes. */
  export function extend_high_i32x4_u(a: v128): v128;
  /** Performs the lane-wise 32-bit signed integer extended multiplication of the two lower lanes producing twice wider 64-bit integer results. */
  export function extmul_low_i32x4_s(a: v128, b: v128): v128;
  /** Performs the lane-wise 32-bit unsigned integer extended multiplication of the two lower lanes producing twice wider 64-bit integer results. */
  export function extmul_low_i32x4_u(a: v128, b: v128): v128;
  /** Performs the lane-wise 32-bit signed integer extended multiplication of the two higher lanes producing twice wider 64-bit integer results. */
  export function extmul_high_i32x4_s(a: v128, b: v128): v128;
  /** Performs the lane-wise 32-bit unsigned integer extended multiplication of the two higher lanes producing twice wider 64-bit integer results. */
  export function extmul_high_i32x4_u(a: v128, b: v128): v128;
  /** Selects 64-bit lanes from either vector according to the specified [0-1] respectively [2-3] lane indexes. */
  export function shuffle(a: v128, b: v128, l0: u8, l1: u8): v128;
  /**
   * Selects 64-bit integer lanes from \`a\` or \`b\` based on masks in \`m\`.
   *
   * Behaves like {@link v128.bitselect} if masks in \`m\` do have all bits either set (result is \`a[i]\`) or unset (result
   * is \`b[i]\`). Otherwise the result is implementation-defined, depending on hardware capabilities: If the most
   * significant bit of \`m\` is set, the result is either \`bitselect(a[i], b[i], mask)\` or \`a[i]\`, otherwise the result
   * is \`b[i]\`.
   */
  export function relaxed_laneselect(a: v128, b: v128, m: v128): v128;
}
/** Initializes a 128-bit vector from four 32-bit float values. Arguments must be compile-time constants. */
declare function f32x4(a: f32, b: f32, c: f32, d: f32): v128;
declare namespace f32x4 {
  /** Creates a vector with four identical 32-bit float lanes. */
  export function splat(x: f32): v128;
  /** Extracts one 32-bit float lane as a scalar. idx argument needs to be compile time constant. */
  export function extract_lane(x: v128, idx: u8): f32;
  /** Replaces one 32-bit float lane. idx argument needs to be compile time constant. */
  export function replace_lane(x: v128, idx: u8, value: f32): v128;
  /** Adds each 32-bit float lane. */
  export function add(a: v128, b: v128): v128;
  /** Subtracts each 32-bit float lane. */
  export function sub(a: v128, b: v128): v128;
  /** Multiplies each 32-bit float lane. */
  export function mul(a: v128, b: v128): v128;
  /** Divides each 32-bit float lane. */
  export function div(a: v128, b: v128): v128;
  /** Negates each 32-bit float lane. */
  export function neg(a: v128): v128;
  /** Computes the minimum of each 32-bit float lane. */
  export function min(a: v128, b: v128): v128;
  /** Computes the maximum of each 32-bit float lane. */
  export function max(a: v128, b: v128): v128;
  /** Computes the pseudo-minimum of each 32-bit float lane. */
  export function pmin(a: v128, b: v128): v128;
  /** Computes the pseudo-maximum of each 32-bit float lane. */
  export function pmax(a: v128, b: v128): v128;
  /** Computes the absolute value of each 32-bit float lane. */
  export function abs(a: v128): v128;
  /** Computes the square root of each 32-bit float lane. */
  export function sqrt(a: v128): v128;
  /** Performs the ceiling operation on each 32-bit float lane. */
  export function ceil(a: v128): v128;
  /** Performs the floor operation on each each 32-bit float lane. */
  export function floor(a: v128): v128;
  /** Rounds to the nearest integer towards zero of each 32-bit float lane. */
  export function trunc(a: v128): v128;
  /** Rounds to the nearest integer tied to even of each 32-bit float lane. */
  export function nearest(a: v128): v128;
  /** Computes which 32-bit float lanes are equal. */
  export function eq(a: v128, b: v128): v128;
  /** Computes which 32-bit float lanes are not equal. */
  export function ne(a: v128, b: v128): v128;
  /** Computes which 32-bit float lanes of the first vector are less than those of the second. */
  export function lt(a: v128, b: v128): v128;
  /** Computes which 32-bit float lanes of the first vector are less than or equal those of the second. */
  export function le(a: v128, b: v128): v128;
  /** Computes which 32-bit float lanes of the first vector are greater than those of the second. */
  export function gt(a: v128, b: v128): v128;
  /** Computes which 32-bit float lanes of the first vector are greater than or equal those of the second. */
  export function ge(a: v128, b: v128): v128;
  /** Converts each 32-bit signed integer lane of a vector to single-precision floating point. */
  export function convert_i32x4_s(a: v128): v128;
  /** Converts each 32-bit unsigned integer lane of a vector to single-precision floating point. */
  export function convert_i32x4_u(a: v128): v128;
  /** Demotes each 64-bit float lane of a vector to single-precision. The higher lanes of the result are initialized to zero. */
  export function demote_f64x2_zero(a: v128): v128;
  /** Selects 32-bit lanes from either vector according to the specified [0-3] respectively [4-7] lane indexes. */
  export function shuffle(a: v128, b: v128, l0: u8, l1: u8, l2: u8, l3: u8): v128;
  /**
   * Performs the fused multiply-add operation (\`a * b + c\`) on all 32-bit floating point lanes.
   * 
   * The result is implementation defined, depending on hardware capabilities:
   * - Either \`a * b\` is rounded once and the final result rounded again, or
   * - The expression is evaluated with higher precision and only rounded once
   */
  export function relaxed_madd(a: v128, b: v128, c: v128): v128;
  /**
   * Performs the fused negative multiply-add operation (\`-(a * b) + c\`) on all 32-bit floating point lanes.
   * 
   * The result is implementation defined, depending on hardware capabilities:
   * - Either \`a * b\` is rounded once and the final result rounded again, or
   * - The expression is evaluated with higher precision and only rounded once
   */
  export function relaxed_nmadd(a: v128, b: v128, c: v128): v128;
  /**
   * Computes the minimum of each 32-bit floating point lane.
   * 
   * Unlike {@link f32x4.min}, the result is implementation-defined if either value is \`NaN\`, \`-0.0\` or \`+0.0\`,
   * depending on hardware capabilities: Either \`a[i]\` or \`b[i]\`.
   */
  export function relaxed_min(a: v128, b: v128): v128;
  /**
   * Computes the maximum of each 32-bit floating point lane.
   * 
   * Unlike {@link f32x4.max}, the result is implementation-defined if either value is \`NaN\`, \`-0.0\` or \`+0.0\`,
   * depending on hardware capabilities: Either \`a[i]\` or \`b[i]\`.
   */
  export function relaxed_max(a: v128, b: v128): v128;
}
/** Initializes a 128-bit vector from two 64-bit float values. Arguments must be compile-time constants. */
declare function f64x2(a: f64, b: f64): v128;
declare namespace f64x2 {
  /** Creates a vector with two identical 64-bit float lanes. */
  export function splat(x: f64): v128;
  /** Extracts one 64-bit float lane as a scalar. idx argument needs to be compile time constant. */
  export function extract_lane(x: v128, idx: u8): f64;
  /** Replaces one 64-bit float lane. idx argument needs to be compile time constant. */
  export function replace_lane(x: v128, idx: u8, value: f64): v128;
  /** Adds each 64-bit float lane. */
  export function add(a: v128, b: v128): v128;
  /** Subtracts each 64-bit float lane. */
  export function sub(a: v128, b: v128): v128;
  /** Multiplies each 64-bit float lane. */
  export function mul(a: v128, b: v128): v128;
  /** Divides each 64-bit float lane. */
  export function div(a: v128, b: v128): v128;
  /** Negates each 64-bit float lane. */
  export function neg(a: v128): v128;
  /** Computes the minimum of each 64-bit float lane. */
  export function min(a: v128, b: v128): v128;
  /** Computes the maximum of each 64-bit float lane. */
  export function max(a: v128, b: v128): v128;
  /** Computes the pseudo-minimum of each 64-bit float lane. */
  export function pmin(a: v128, b: v128): v128;
  /** Computes the pseudo-maximum of each 64-bit float lane. */
  export function pmax(a: v128, b: v128): v128;
  /** Computes the absolute value of each 64-bit float lane. */
  export function abs(a: v128): v128;
  /** Computes the square root of each 64-bit float lane. */
  export function sqrt(a: v128): v128;
  /** Performs the ceiling operation on each 64-bit float lane. */
  export function ceil(a: v128): v128;
  /** Performs the floor operation on each each 64-bit float lane. */
  export function floor(a: v128): v128;
  /** Rounds to the nearest integer towards zero of each 64-bit float lane. */
  export function trunc(a: v128): v128;
  /** Rounds to the nearest integer tied to even of each 64-bit float lane. */
  export function nearest(a: v128): v128;
  /** Computes which 64-bit float lanes are equal. */
  export function eq(a: v128, b: v128): v128;
  /** Computes which 64-bit float lanes are not equal. */
  export function ne(a: v128, b: v128): v128;
  /** Computes which 64-bit float lanes of the first vector are less than those of the second. */
  export function lt(a: v128, b: v128): v128;
  /** Computes which 64-bit float lanes of the first vector are less than or equal those of the second. */
  export function le(a: v128, b: v128): v128;
  /** Computes which 64-bit float lanes of the first vector are greater than those of the second. */
  export function gt(a: v128, b: v128): v128;
  /** Computes which 64-bit float lanes of the first vector are greater than or equal those of the second. */
  export function ge(a: v128, b: v128): v128;
  /** Converts the low 32-bit signed integer lanes of a vector to double-precision floating point. */
  export function convert_low_i32x4_s(a: v128): v128;
  /** Converts the low 32-bit unsigned integer lanes of a vector to double-precision floating point. */
  export function convert_low_i32x4_u(a: v128): v128;
  /** Promotes the low 32-bit float lanes of a vector to double-precision. */
  export function promote_low_f32x4(a: v128): v128;
  /** Selects 64-bit lanes from either vector according to the specified [0-1] respectively [2-3] lane indexes. */
  export function shuffle(a: v128, b: v128, l0: u8, l1: u8): v128;
  /**
   * Performs the fused multiply-add operation (\`a * b + c\`) on all 64-bit floating point lanes.
   * 
   * The result is implementation defined, depending on hardware capabilities:
   * - Either \`a * b\` is rounded once and the final result rounded again, or
   * - The expression is evaluated with higher precision and only rounded once
   */
  export function relaxed_madd(a: v128, b: v128, c: v128): v128;
  /**
   * Performs the fused negative multiply-add operation (\`-(a * b) + c\`) on all 64-bit floating point lanes.
   * 
   * The result is implementation defined, depending on hardware capabilities:
   * - Either \`a * b\` is rounded once and the final result rounded again, or
   * - The expression is evaluated with higher precision and only rounded once
   */
  export function relaxed_nmadd(a: v128, b: v128, c: v128): v128;
  /**
   * Computes the minimum of each 64-bit floating point lane.
   * 
   * Unlike {@link f64x2.min}, the result is implementation-defined if either value is \`NaN\`, \`-0.0\` or \`+0.0\`,
   * depending on hardware capabilities: Either \`a[i]\` or \`b[i]\`.
   */
  export function relaxed_min(a: v128, b: v128): v128;
  /**
   * Computes the maximum of each 64-bit floating point lane.
   * 
   * Unlike {@link f64x2.max}, the result is implementation-defined if either value is \`NaN\`, \`-0.0\` or \`+0.0\`,
   * depending on hardware capabilities: Either \`a[i]\` or \`b[i]\`.
   */
  export function relaxed_max(a: v128, b: v128): v128;
}

declare abstract class i31 {
  /** Creates a new 31-bit integer reference from the specified integer value. */
  static new(value: i32): ref_i31;
  /** Gets the integer value of an 31-bit integer reference. */
  static get(i31expr: ref_i31 | null): i32;
}

/** Macro type evaluating to the underlying native WebAssembly type. */
declare type native<T> = T;
/** Special type evaluating the indexed access index type. */
declare type indexof<T extends ArrayLike<unknown>> = keyof T;
/** Special type evaluating the indexed access value type. */
declare type valueof<T extends ArrayLike<unknown>> = T[0];
/** A special type evaluated to the return type of T if T is a callable function. */
declare type ReturnType<T extends (...args: any) => any> = T extends (...args: any) => infer R ? R : any;
/** A special type evaluated to the return type of T if T is a callable function. */
declare type returnof<T extends (...args: any) => any> = ReturnType<T>;
/** A special type that excludes null and undefined from T. */
declare type NonNullable<T> = T extends null | undefined ? never : T;
/** A special type that excludes null and undefined from T. */
declare type nonnull<T> = NonNullable<T>;

/** Pseudo-class representing the backing class of integer types. */
/** @internal */
declare class _Integer {
  /** Smallest representable value. */
  static readonly MIN_VALUE: number;
  /** Largest representable value. */
  static readonly MAX_VALUE: number;
  /** @deprecated Converts a string to an integer of this type. Please use "i32.parse" method. */
  static parseInt(value: string, radix?: number): number;
  /** Converts this integer to a string. */
  toString(radix?: number): string;
}

/** Pseudo-class representing the backing class of floating-point types. */
/** @internal */
declare class _Float {
  /** Difference between 1 and the smallest representable value greater than 1. */
  static readonly EPSILON: f32 | f64;
  /** Smallest representable value. */
  static readonly MIN_VALUE: f32 | f64;
  /** Largest representable value. */
  static readonly MAX_VALUE: f32 | f64;
  /** Smallest safely representable integer value. */
  static readonly MIN_SAFE_INTEGER: f32 | f64;
  /** Largest safely representable integer value. */
  static readonly MAX_SAFE_INTEGER: f32 | f64;
  /** Value representing positive infinity. */
  static readonly POSITIVE_INFINITY: f32 | f64;
  /** Value representing negative infinity. */
  static readonly NEGATIVE_INFINITY: f32 | f64;
  /** Value representing 'not a number'. */
  static readonly NaN: f32 | f64;
  /** Returns a boolean value that indicates whether a value is the reserved value NaN (not a number). */
  static isNaN(value: f32 | f64): bool;
  /** Returns true if passed value is finite. */
  static isFinite(value: f32 | f64): bool;
  /** Returns true if the value passed is a safe integer. */
  static isSafeInteger(value: f32 | f64): bool;
  /** Returns true if the value passed is an integer, false otherwise. */
  static isInteger(value: f32 | f64): bool;
  /** @deprecated Converts a string to an integer. Please use "i32.parse" / "i64.parse" methods. */
  static parseInt(value: string, radix?: i32): f32 | f64;
  /** @deprecated Converts a string to a floating-point number. Please use "f32.parse" / "f64.parse" methods. */
  static parseFloat(value: string): f32 | f64;
  /** Converts this floating-point number to a string. */
  toString(radix?: number): string;
}

declare class Boolean {
  toString(radix?: number): string;
}

/** Backing class of signed 8-bit integers. */
declare const I8: typeof _Integer;
/** Backing class of signed 16-bit integers. */
declare const I16: typeof _Integer;
/** Backing class of signed 32-bit integers. */
declare const I32: typeof _Integer;
/** Backing class of signed 64-bit integers. */
declare const I64: typeof _Integer;
/** Backing class of signed size integers. */
declare const Isize: typeof _Integer;
/** Backing class of unsigned 8-bit integers. */
declare const U8: typeof _Integer;
/** Backing class of unsigned 16-bit integers. */
declare const U16: typeof _Integer;
/** Backing class of unsigned 32-bit integers. */
declare const U32: typeof _Integer;
/** Backing class of unsigned 64-bit integers. */
declare const U64: typeof _Integer;
/** Backing class of unsigned size integers. */
declare const Usize: typeof _Integer;
/** Backing class of 32-bit floating-point values. */
declare const F32: typeof _Float;
/** Backing class of 64-bit floating-point values. */
declare const F64: typeof _Float;
/** Alias of F64. */
declare const Number: typeof F64;
declare type Number = _Float;

// User-defined diagnostic macros

/** Emits a user-defined diagnostic error when encountered. */
declare function ERROR(message?: any): never;
/** Emits a user-defined diagnostic warning when encountered. */
declare function WARNING(message?: any): void;
/** Emits a user-defined diagnostic info when encountered. */
declare function INFO(message?: any): void;

// Standard library

/** Memory operations. */
declare namespace memory {
  /** Whether the memory managed interface is implemented. */
  export const implemented: bool;
  /** Returns the current memory size in units of pages. One page is 64kb. */
  export function size(): i32;
  /** Grows linear memory by a given unsigned delta of pages. One page is 64kb. Returns the previous memory size in units of pages or \`-1\` on failure. */
  export function grow(value: i32): i32;
  /** Sets n bytes beginning at the specified destination in memory to the specified byte value. */
  export function fill(dst: usize, value: u8, count: usize): void;
  /** Copies n bytes from the specified source to the specified destination in memory. These regions may overlap. */
  export function copy(dst: usize, src: usize, n: usize): void;
  /** Repeats \`src\` of length \`srcLength\` \`count\` times at \`dst\`. */
  export function repeat(dst: usize, src: usize, srcLength: usize, count: usize): void;
  /** Copies elements from a passive element segment to a table. */
  export function init(segmentIndex: u32, srcOffset: usize, dstOffset: usize, n: usize): void;
  /** Prevents further use of a passive element segment. */
  export function drop(segmentIndex: u32): void;
  /** Compares two chunks of memory. Returns \`0\` if equal, otherwise the difference of the first differing bytes. */
  export function compare(vl: usize, vr: usize, n: usize): i32;
  /** Gets a pointer to a zeroed static chunk of memory of the given size. Alignment defaults to \`16\`. Arguments must be compile-time constants. */
  export function data(size: i32, align?: i32): usize;
  /** Gets a pointer to a pre-initialized static chunk of memory. Alignment defaults to the size of \`T\`. Arguments must be compile-time constants. */
  export function data<T>(values: T[], align?: i32): usize;

  export namespace atomic {
    /** Performs a wait operation on a 32-bit integer value in memory suspending this agent if the condition is met. */
    export function wait32(ptr: usize, expected: i32, timeout?: i64): AtomicWaitResult;
    /** Performs a wait operation on a 64-bit integer value in memory suspending this agent if the condition is met. */
    export function wait64(ptr: usize, expected: i64, timeout?: i64): AtomicWaitResult;
  }
}

/** Heap memory interface. */
declare namespace heap {
  /** Allocates a chunk of memory of at least the specified size. */
  export function alloc(size: usize): usize;
  /** Reallocates a chunk of memory to have at least the specified size. */
  export function realloc(ptr: usize, size: usize): usize;
  /** Frees a chunk of memory. Does hardly anything (most recent block only) with the stub/none runtime. */
  export function free(ptr: usize): void;
}

/** Table operations. */
declare namespace table {
  /** Copies elements from a passive element segment to a table. */
  export function init(elementIndex: u32, srcOffset: u32, dstOffset: u32, n: u32): void;
  /** Prevents further use of a passive element segment. */
  export function drop(elementIndex: u32): void;
  /** Copies elements from one region of a table to another region. */
  export function copy(dest: u32, src: u32, n: u32): void;
}

declare namespace Atomics {
  export function load<T extends i8 | u8 | i16 | u16 | i32 | u32 | i64 | u64>(array: TypedArray<T>, index: i32): T;
  export function store<T extends i8 | u8 | i16 | u16 | i32 | u32 | i64 | u64>(array: TypedArray<T>, index: i32, value: T): void;
  export function add<T extends i8 | u8 | i16 | u16 | i32 | u32 | i64 | u64>(array: TypedArray<T>, index: i32, value: T): T;
  export function sub<T extends i8 | u8 | i16 | u16 | i32 | u32 | i64 | u64>(array: TypedArray<T>, index: i32, value: T): T;
  export function and<T extends i8 | u8 | i16 | u16 | i32 | u32 | i64 | u64>(array: TypedArray<T>, index: i32, value: T): T;
  export function or<T extends i8 | u8 | i16 | u16 | i32 | u32 | i64 | u64>(array: TypedArray<T>, index: i32, value: T): T;
  export function xor<T extends i8 | u8 | i16 | u16 | i32 | u32 | i64 | u64>(array: TypedArray<T>, index: i32, value: T): T;
  export function exchange<T extends i8 | u8 | i16 | u16 | i32 | u32 | i64 | u64>(array: TypedArray<T>, index: i32, value: T): T;
  export function compareExchange<T extends i8 | u8 | i16 | u16 | i32 | u32 | i64 | u64>(array: TypedArray<T>, index: i32, expectedValue: T, replacementValue: T): T;
  export function wait<T extends i8 | u8 | i16 | u16 | i32 | u32 | i64 | u64>(array: TypedArray<T>, value: T, timeout?: i64): AtomicWaitResult;
  export function notify<T extends i8 | u8 | i16 | u16 | i32 | u32 | i64 | u64>(array: TypedArray<T>, index: i32, count?: i32): i32;
  /** The static Atomics.isLockFree() method is used to determine whether to use locks or atomic operations. It returns true, if the given size is one of the BYTES_PER_ELEMENT */
  export function isLockFree(size: usize): bool;
}

/** Class representing a generic, fixed-length raw binary data buffer. */
declare class ArrayBuffer {
  /** The size, in bytes, of the array. */
  readonly byteLength: i32;
  /** Returns true if value is one of the ArrayBuffer views, such as typed array or a DataView **/
  static isView<T>(value: T): bool;
  /** Constructs a new array buffer of the given length in bytes. */
  constructor(length: i32);
  /** Returns a copy of this array buffer's bytes from begin, inclusive, up to end, exclusive. */
  slice(begin?: i32, end?: i32): ArrayBuffer;
  /** Returns a string representation of ArrayBuffer. */
  toString(): string;
}

/** The \`DataView\` view provides a low-level interface for reading and writing multiple number types in a binary \`ArrayBuffer\`, without having to care about the platform's endianness. */
declare class DataView {
  /** The \`buffer\` accessor property represents the \`ArrayBuffer\` or \`SharedArrayBuffer\` referenced by the \`DataView\` at construction time. */
  readonly buffer: ArrayBuffer;
  /** Returns raw pointer to data storage including offset (unsafe). */
  readonly dataStart: usize;
  /** The \`byteLength\` accessor property represents the length (in bytes) of this view from the start of its \`ArrayBuffer\` or \`SharedArrayBuffer\`. */
  readonly byteLength: i32;
  /** The \`byteOffset\` accessor property represents the offset (in bytes) of this view from the start of its \`ArrayBuffer\` or \`SharedArrayBuffer\`. */
  readonly byteOffset: i32;
  /** Constructs a new \`DataView\` with the given properties */
  constructor(buffer: ArrayBuffer, byteOffset?: i32, byteLength?: i32);
  /** The \`getFloat32()\` method gets a signed 32-bit float (float) at the specified byte offset from the start of the \`DataView\`. */
  getFloat32(byteOffset: i32, littleEndian?: bool): f32;
  /** The \`getFloat64()\` method gets a signed 64-bit float (double) at the specified byte offset from the start of the \`DataView\`. */
  getFloat64(byteOffset: i32, littleEndian?: bool): f64;
  /** The \`getInt8()\` method gets a signed 8-bit integer (byte) at the specified byte offset from the start of the \`DataView\`. */
  getInt8(byteOffset: i32): i8;
  /** The \`getInt16()\` method gets a signed 16-bit integer (short) at the specified byte offset from the start of the \`DataView\`. */
  getInt16(byteOffset: i32, littleEndian?: bool): i16;
  /** The \`getInt32()\` method gets a signed 32-bit integer (long) at the specified byte offset from the start of the \`DataView\`. */
  getInt32(byteOffset: i32, littleEndian?: bool): i32;
  /** The \`getInt64()\` method gets a signed 64-bit integer (long long) at the specified byte offset from the start of the \`DataView\`. */
  getInt64(byteOffset: i32, littleEndian?: bool): i64;
  /** The \`getUint8()\` method gets an unsigned 8-bit integer (unsigned byte) at the specified byte offset from the start of the \`DataView\`. */
  getUint8(byteOffset: i32): u8;
  /** The \`getUint16()\` method gets an unsigned 16-bit integer (unsigned short) at the specified byte offset from the start of the \`DataView\`. */
  getUint16(byteOffset: i32, littleEndian?: bool): u16;
  /** The \`getUint32()\` method gets an unsigned 32-bit integer (unsigned long) at the specified byte offset from the start of the \`DataView\`. */
  getUint32(byteOffset: i32, littleEndian?: bool): u32;
  /** The \`getUint64()\` method gets an unsigned 64-bit integer (unsigned long long) at the specified byte offset from the start of the \`DataView\`. */
  getUint64(byteOffset: i32, littleEndian?: bool): u64;
  /** The \`setFloat32()\` method stores a signed 32-bit float (float) value at the specified byte offset from the start of the \`DataView\`. */
  setFloat32(byteOffset: i32, value: f32, littleEndian?: bool): void;
  /** The \`setFloat64()\` method stores a signed 64-bit float (double) value at the specified byte offset from the start of the \`DataView\`. */
  setFloat64(byteOffset: i32, value: f64, littleEndian?: bool): void;
  /** The \`setInt8()\` method stores a signed 8-bit integer (byte) value at the specified byte offset from the start of the \`DataView\`. */
  setInt8(byteOffset: i32, value: i8): void;
  /** The \`setInt16()\` method stores a signed 16-bit integer (short) value at the specified byte offset from the start of the \`DataView\`. */
  setInt16(byteOffset: i32, value: i16, littleEndian?: bool): void;
  /** The \`setInt32()\` method stores a signed 32-bit integer (long) value at the specified byte offset from the start of the \`DataView\`. */
  setInt32(byteOffset: i32, value: i32, littleEndian?: bool): void;
  /** The \`setInt64()\` method stores a signed 64-bit integer (long long) value at the specified byte offset from the start of the \`DataView\`. */
  setInt64(byteOffset: i32, value: i64, littleEndian?: bool): void;
  /** The \`setUint8()\` method stores an unsigned 8-bit integer (byte) value at the specified byte offset from the start of the \`DataView\`. */
  setUint8(byteOffset: i32, value: u8): void;
  /** The \`setUint16()\` method stores an unsigned 16-bit integer (unsigned short) value at the specified byte offset from the start of the \`DataView\`. */
  setUint16(byteOffset: i32, value: u16, littleEndian?: bool): void;
  /** The \`setUint32()\` method stores an unsigned 32-bit integer (unsigned long) value at the specified byte offset from the start of the \`DataView\`. */
  setUint32(byteOffset: i32, value: u32, littleEndian?: bool): void;
  /** The \`setUint64()\` method stores an unsigned 64-bit integer (unsigned long long) value at the specified byte offset from the start of the \`DataView\`. */
  setUint64(byteOffset: i32, value: u64, littleEndian?: bool): void;
  /** Returns a string representation of DataView. */
  toString(): string;
}

interface ArrayLike<T> {
  [key: number]: T;
  length: i32;
}

/** Interface for a typed view on an array buffer. */
interface ArrayBufferView {
  /** The {@link ArrayBuffer} referenced by this view. */
  readonly buffer: ArrayBuffer;
  /** The offset in bytes from the start of the referenced {@link ArrayBuffer}. */
  readonly byteOffset: i32;
  /** The length in bytes from the start of the referenced {@link ArrayBuffer}. */
  readonly byteLength: i32;
  /** Returns raw pointer to data storage including offset (unsafe). */
  readonly dataStart: usize;
}

/** @internal */
declare abstract class TypedArray<T> implements ArrayBufferView {
  [key: number]: T;
  /** Number of bytes per element. */
  static readonly BYTES_PER_ELEMENT: usize;
  /** Constructs a new typed array. */
  constructor(length: i32);
  /** The {@link ArrayBuffer} referenced by this view. */
  readonly buffer: ArrayBuffer;
  /** The offset in bytes from the start of the referenced {@link ArrayBuffer}. */
  readonly byteOffset: i32;
  /** The length in bytes from the start of the referenced {@link ArrayBuffer}. */
  readonly byteLength: i32;
  /** Returns raw pointer to data storage including offset (unsafe). */
  readonly dataStart: usize;
  /** The length (in elements). */
  readonly length: i32;
  /** Returns value using relative indexing. Index may be negative */
  at(index: i32): T;
  /** The includes() method determines whether a typed array includes a certain element, returning true or false as appropriate. */
  includes(searchElement: T, fromIndex?: i32): bool;
  /** The indexOf() method returns the first index at which a given element can be found in the typed array, or -1 if it is not present. */
  indexOf(searchElement: T, fromIndex?: i32): i32;
  /** The lastIndexOf() method returns the last index at which a given element can be found in the typed array, or -1 if it is not present. The typed array is searched backwards, starting at fromIndex. */
  lastIndexOf(searchElement: T, fromIndex?: i32): i32;
  /** Returns copied section of an TypedArray from begin inclusive to end exclusive */
  slice(begin?: i32, end?: i32): TypedArray<T>;
  /** Returns a new TypedArray of this type on the same ArrayBuffer from begin inclusive to end exclusive. */
  subarray(begin?: i32, end?: i32): TypedArray<T>;
  /** The copyWithin() method copies the sequence of array elements within the array to the position starting at target. The copy is taken from the index positions of the second and third arguments start and end. The end argument is optional and defaults to the length of the array. */
  copyWithin(target: i32, start: i32, end?: i32): this;
  /**  The reduce() method applies a function against an accumulator and each value of the typed array (from left-to-right) has to reduce it to a single value. This method has the same algorithm as Array.prototype.reduce(). */
  reduce<U>(callbackfn: (accumulator: U, value: T, index: i32, self: this) => U, initialValue: U): U;
  /**  The reduceRight() method applies a function against an accumulator and each value of the typed array (from left-to-right) has to reduce it to a single value, starting from the end of the array. This method has the same algorithm as Array.prototype.reduceRight(). */
  reduceRight<U>(callbackfn: (accumulator: U, value: T, index: i32, self: this) => U, initialValue: U): U;
  /** The some() method tests whether some element in the typed array passes the test implemented by the provided function. This method has the same algorithm as Array.prototype.some().*/
  some(callbackfn: (value: T, index: i32, self: this) => bool): bool;
  /** The map() method creates a new typed array with the results of calling a provided function on every element in this typed array. This method has the same algorithm as Array.prototype.map().*/
  map(callbackfn: (value: T, index: i32, self: this) => T): TypedArray<T>;
  /** The filter() method creates a new typed array with all elements that pass the test implemented by the provided function. This method has the same algorithm as Array.prototype.filter(). */
  filter(callbackfn: (value: T, index: i32, self: this) => bool): TypedArray<T>;
  /** The sort() method sorts the elements of a typed array numerically in place and returns the typed array. This method has the same algorithm as Array.prototype.sort(), except that sorts the values numerically instead of as strings. TypedArray is one of the typed array types here. */
  sort(callback?: (a: T, b: T) => i32): this;
  /** The fill() method fills all the elements of a typed array from a start index to an end index with a static value. This method has the same algorithm as Array.prototype.fill(). */
  fill(value: T, start?: i32, end?: i32): this;
  /** The findIndex() method returns an index in the typed array, if an element in the typed array satisfies the provided testing function. Otherwise -1 is returned. See also the find() [not implemented] method, which returns the value of a found element in the typed array instead of its index. */
  findIndex(callbackfn: (value: T, index: i32, self: this) => bool): i32;
  /** The findLastIndex() method returns an index start searching from the end in the typed array, if an element in the typed array satisfies the provided testing function. Otherwise -1 is returned. See also the find() [not implemented] method, which returns the value of a found element in the typed array instead of its index. */
  findLastIndex(callbackfn: (value: T, index: i32, self: this) => bool): i32;
  /** The every() method tests whether all elements in the typed array pass the test implemented by the provided function. This method has the same algorithm as Array.prototype.every(). */
  every(callbackfn: (value: T, index: i32, self: this) => bool): bool;
  /** The forEach() method executes a provided function once per array element. This method has the same algorithm as Array.prototype.forEach().*/
  forEach(callbackfn: (value: T, index: i32, self: this) => void): void;
  /** The reverse() method reverses a typed array in place. The first typed array element becomes the last and the last becomes the first. This method has the same algorithm as Array.prototype.reverse(). */
  reverse(): this;
  /** The join() method joins all elements of an array into a string. This method has the same algorithm as Array.prototype.join(). */
  join(separator?: string): string;
  /** The set() method stores multiple values in the typed array, reading input values from a specified array. */
  set<U extends ArrayLike<number>>(source: U, offset?: i32): void
  /** The toString() method returns a string representing the specified array and its elements. This method has the same algorithm as Array.prototype.toString() */
  toString(): string;
}

/** An array of twos-complement 8-bit signed integers. */
declare class Int8Array extends TypedArray<i8> {
  /** Wrap an ArrayBuffer */
  static wrap(buffer: ArrayBuffer, byteOffset?: i32, length?: i32): Int8Array;
}
/** An array of 8-bit unsigned integers. */
declare class Uint8Array extends TypedArray<u8> {
  /** Wrap an ArrayBuffer */
  static wrap(buffer: ArrayBuffer, byteOffset?: i32, length?: i32): Uint8Array;
}
/** A clamped array of 8-bit unsigned integers. */
declare class Uint8ClampedArray extends TypedArray<u8> {
  /** Wrap an ArrayBuffer */
  static wrap(buffer: ArrayBuffer, byteOffset?: i32, length?: i32): Uint8ClampedArray;
}
/** An array of twos-complement 16-bit signed integers. */
declare class Int16Array extends TypedArray<i16> {
  /** Wrap an ArrayBuffer */
  static wrap(buffer: ArrayBuffer, byteOffset?: i32, length?: i32): Int16Array;
}
/** An array of 16-bit unsigned integers. */
declare class Uint16Array extends TypedArray<u16> {
  /** Wrap an ArrayBuffer */
  static wrap(buffer: ArrayBuffer, byteOffset?: i32, length?: i32): Uint16Array;
}
/** An array of twos-complement 32-bit signed integers. */
declare class Int32Array extends TypedArray<i32> {
  /** Wrap an ArrayBuffer */
  static wrap(buffer: ArrayBuffer, byteOffset?: i32, length?: i32): Int32Array;
}
/** An array of 32-bit unsigned integers. */
declare class Uint32Array extends TypedArray<u32> {
  /** Wrap an ArrayBuffer */
  static wrap(buffer: ArrayBuffer, byteOffset?: i32, length?: i32): Uint32Array;
}
/** An array of twos-complement 64-bit signed integers. */
declare class Int64Array extends TypedArray<i64> {
  /** Wrap an ArrayBuffer */
  static wrap(buffer: ArrayBuffer, byteOffset?: i32, length?: i32): Int64Array;
}
/** An array of 64-bit unsigned integers. */
declare class Uint64Array extends TypedArray<u64> {
  /** Wrap an ArrayBuffer */
  static wrap(buffer: ArrayBuffer, byteOffset?: i32, length?: i32): Uint64Array;
}
/** An array of 32-bit floating point numbers. */
declare class Float32Array extends TypedArray<f32> {
  /** Wrap an ArrayBuffer */
  static wrap(buffer: ArrayBuffer, byteOffset?: i32, length?: i32): Float32Array;
}
/** An array of 64-bit floating point numbers. */
declare class Float64Array extends TypedArray<f64> {
  /** Wrap an ArrayBuffer */
  static wrap(buffer: ArrayBuffer, byteOffset?: i32, length?: i32): Float64Array;
}

/** Class representing a sequence of values of type \`T\`. */
declare class Array<T> {

  /** Tests if a value is an array. */
  static isArray<U>(value: any): value is Array<any>;

  [key: number]: T;
  /** Current length of the array. */
  length: i32;
  /** Returns raw pointer to data storage (unsafe). */
  readonly dataStart: usize;
  /** Constructs a new array. */
  constructor(length?: i32);
  at(index: i32): T;
  fill(value: T, start?: i32, end?: i32): this;
  findIndex(callbackfn: (value: T, index: i32, array: Array<T>) => bool): i32;
  findLastIndex(callbackfn: (value: T, index: i32, array: Array<T>) => bool): i32;
  includes(searchElement: T, fromIndex?: i32): bool;
  indexOf(searchElement: T, fromIndex?: i32): i32;
  lastIndexOf(searchElement: T, fromIndex?: i32): i32;
  push(element: T): i32;
  concat(items: T[]): T[];
  copyWithin(target: i32, start: i32, end?: i32): this;
  pop(): T;
  forEach(callbackfn: (value: T, index: i32, array: Array<T>) => void): void;
  map<U>(callbackfn: (value: T, index: i32, array: Array<T>) => U): Array<U>;
  filter(callbackfn: (value: T, index: i32, array: Array<T>) => bool): Array<T>;
  reduce<U>(callbackfn: (previousValue: U, currentValue: T, currentIndex: i32, array: Array<T>) => U, initialValue: U): U;
  reduceRight<U>(callbackfn: (previousValue: U, currentValue: T, currentIndex: i32, array: Array<T>) => U, initialValue: U): U;
  every(callbackfn: (value: T, index: i32, array: Array<T>) => bool): bool;
  some(callbackfn: (value: T, index: i32, array: Array<T>) => bool): bool;
  shift(): T;
  unshift(element: T): i32;
  slice(from?: i32, to?: i32): Array<T>;
  splice(start: i32, deleteCount?: i32): Array<T>;
  sort(comparator?: (a: T, b: T) => i32): this;
  join(separator?: string): string;
  reverse(): this;
  /** Flattens an array of arrays. If any null entries exist in the array, they are ignored, unlike JavaScript's version of Array#flat(). */
  flat(): T extends unknown[] ? T : never;
  toString(): string;
}

/** Class representing a static (not resizable) sequence of values of type \`T\`. This class is @final. */
declare class StaticArray<T> {
  [key: number]: T;
  static fromArray<T>(source: Array<T>): StaticArray<T>;
  /** @deprecated */
  static concat<T>(source: StaticArray<T>, other: StaticArray<T>): StaticArray<T>;
  /** @deprecated */
  static slice<T>(source: StaticArray<T>, start?: i32, end?: i32): StaticArray<T>;
  readonly length: i32;
  constructor(length?: i32);
  at(index: i32): T;
  fill(value: T, start?: i32, end?: i32): this;
  findIndex(callbackfn: (value: T, index: i32, array: StaticArray<T>) => bool): i32;
  findLastIndex(callbackfn: (value: T, index: i32, array: StaticArray<T>) => bool): i32;
  copyWithin(target: i32, start: i32, end?: i32): this;
  includes(searchElement: T, fromIndex?: i32): bool;
  indexOf(searchElement: T, fromIndex?: i32): i32;
  lastIndexOf(searchElement: T, fromIndex?: i32): i32;
  forEach(callbackfn: (value: T, index: i32, array: StaticArray<T>) => void): void;
  map<U>(callbackfn: (value: T, index: i32, array: StaticArray<T>) => U): Array<U>;
  filter(callbackfn: (value: T, index: i32, array: StaticArray<T>) => bool): Array<T>;
  reduce<U>(callbackfn: (previousValue: U, currentValue: T, currentIndex: i32, array: StaticArray<T>) => U, initialValue: U): U;
  reduceRight<U>(callbackfn: (previousValue: U, currentValue: T, currentIndex: i32, array: StaticArray<T>) => U, initialValue: U): U;
  every(callbackfn: (value: T, index: i32, array: StaticArray<T>) => bool): bool;
  some(callbackfn: (value: T, index: i32, array: StaticArray<T>) => bool): bool;
  concat(items: Array<T>): Array<T>;
  concat<U extends ArrayLike<T>>(other: U): U;
  slice(from?: i32, to?: i32): Array<T>;
  slice<U extends ArrayLike<T>>(from?: i32, to?: i32): U;
  sort(comparator?: (a: T, b: T) => i32): this;
  join(separator?: string): string;
  reverse(): this;
  toString(): string;
}

/** Class representing a sequence of characters. */
declare class String {
  [key: i32]: string;
  static fromCharCode(ls: i32, hs?: i32): string;
  static fromCharCodes(arr: i32[]): string;
  static fromCodePoint(code: i32): string;
  static fromCodePoints(arr: i32[]): string;
  static raw(parts: TemplateStringsArray, ...args: any[]): string;
  readonly length: i32;
  at(index: i32): string;
  charAt(index: i32): string;
  charCodeAt(index: i32): i32;
  codePointAt(index: i32): i32;
  concat(other: string): string;
  endsWith(other: string): bool;
  indexOf(other: string, fromIndex?: i32): i32;
  lastIndexOf(other: string, fromIndex?: i32): i32;
  localeCompare(other: string): i32;
  includes(other: string): bool;
  startsWith(other: string): bool;
  substr(start: i32, length?: i32): string;
  substring(start: i32, end?: i32): string;
  trim(): string;
  trimLeft(): string;
  trimRight(): string;
  trimStart(): string;
  trimEnd(): string;
  padStart(targetLength: i32, padString?: string): string;
  padEnd(targetLength: i32, padString?: string): string;
  repeat(count?: i32): string;
  replace(search: string, replacement: string): string;
  replaceAll(search: string, replacement: string): string;
  slice(beginIndex: i32, endIndex?: i32): string;
  split(separator?: string, limit?: i32): string[];
  toLowerCase(): string;
  toUpperCase(): string;
  toString(): string;
}

declare namespace String {
  /** Encoding helpers for UTF-8. */
  export namespace UTF8 {
    /** UTF-8 encoding error modes. */
    export const enum ErrorMode {
      /** Keeps unpaired surrogates as of WTF-8. This is the default. */
      WTF8,
      /** Replaces unpaired surrogates with the replacement character (U+FFFD). */
      REPLACE,
      /** Throws an error on unpaired surrogates. */
      ERROR
    }
    /** Calculates the byte length of the specified string when encoded as UTF-8, optionally null terminated. */
    export function byteLength(str: string, nullTerminated?: bool): i32;
    /** Encodes the specified string to UTF-8 bytes, optionally null terminated. ErrorMode defaults to WTF-8. */
    export function encode(str: string, nullTerminated?: bool, errorMode?: ErrorMode): ArrayBuffer;
    /** Encodes the specified raw string to UTF-8 bytes, opionally null terminated. ErrorMode defaults to WTF-8. Returns the number of bytes written. */
    export function encodeUnsafe(str: usize, len: i32, buf: usize, nullTerminated?: bool, errorMode?: ErrorMode): usize;
    /** Decodes the specified buffer from UTF-8 bytes to a string, optionally null terminated. */
    export function decode(buf: ArrayBuffer, nullTerminated?: bool): string;
    /** Decodes raw UTF-8 bytes to a string, optionally null terminated. */
    export function decodeUnsafe(buf: usize, len: usize, nullTerminated?: bool): string;
  }
  /** Encoding helpers for UTF-16. */
  export namespace UTF16 {
    /** Calculates the byte length of the specified string when encoded as UTF-16. */
    export function byteLength(str: string): i32;
    /** Encodes the specified string to UTF-16 bytes. */
    export function encode(str: string): ArrayBuffer;
    /** Encodes the specified raw string to UTF-16 bytes. Returns the number of bytes written. */
    export function encodeUnsafe(str: usize, len: i32, buf: usize): usize;
    /** Decodes the specified buffer from UTF-16 bytes to a string. */
    export function decode(buf: ArrayBuffer): string;
    /** Decodes raw UTF-16 bytes to a string. */
    export function decodeUnsafe(buf: usize, len: usize): string;
  }
}

declare class TemplateStringsArray extends Array<string> {
  readonly raw: string[];
}

declare class Object {
  /** The Object.is() method determines whether two values are the same value. */
  static is<T>(value1: T, value2: T): bool;
}

declare namespace performance {
  /** Gets a high resolution timestamp measured in milliseconds. */
  export function now(): f64;
}

declare class Date {
  /** Returns the UTC timestamp in milliseconds of the specified date. */
  static UTC(
    year: i32,
    month: i32,
    day: i32,
    hour: i32,
    minute: i32,
    second: i32,
    millisecond: i32
  ): i64;
  /** Returns the current UTC timestamp in milliseconds. */
  static now(): i64;
  /** Parses a string representation of a date, and returns the number of milliseconds since January 1, 1970, 00:00:00 UTC. */
  static parse(dateString: string): Date;
  static fromString(dateString: string): Date;
  /** Constructs a new date object from an UTC timestamp in milliseconds. */
  constructor(value: i64);
  /** Returns the UTC timestamp of this date in milliseconds. */
  getTime(): i64;
  /** Sets the UTC timestamp of this date in milliseconds. */
  setTime(value: i64): i64;

  getUTCFullYear(): i32;
  getUTCMonth(): i32;
  getUTCDate(): i32;
  getUTCDay(): i32;
  getUTCHours(): i32;
  getUTCMinutes(): i32;
  getUTCSeconds(): i32;
  getUTCMilliseconds(): i32;

  setUTCFullYear(value: i32): void;
  setUTCMonth(value: i32, day?: i32): void;
  setUTCDate(value: i32): void;
  setUTCHours(value: i32): void;
  setUTCMinutes(value: i32): void;
  setUTCSeconds(value: i32): void;
  setUTCMilliseconds(value: i32): void;

  toString(): string;
  toISOString(): string;
  toUTCString(): string;
  toDateString(): string;
  toTimeString(): string;
}

/** Class for representing a runtime error. Base class of all errors. */
declare class Error {

  /** Error name. */
  name: string;

  /** Message provided on construction. */
  message: string;

  /** Stack trace. */
  stack?: string;

  /** Constructs a new error, optionally with a message. */
  constructor(message?: string);

  /** Method returns a string representing the specified Error class. */
  toString(): string;
}

/** Class for indicating an error when a value is not in the set or range of allowed values. */
declare class RangeError extends Error { }

/** Class for indicating an error when a value is not of the expected type. */
declare class TypeError extends Error { }

/** Class for indicating an error when trying to interpret syntactically invalid code. */
declare class SyntaxError extends Error { }

/** Class for indicating an error when a global URI handling function was used in a wrong way. */
declare class URIError extends Error { }

interface Function {
  /** Function table index. */
  readonly index: u32;
  /** Function name. Always an empty string. */
  readonly name: string;
  /** Number of expected parameters. */
  readonly length: u32;
  /** Calls this function indirectly with the specified arguments. */
  call(thisArg: unknown, ...args: unknown[]): any;
  /** Returns a string representation of this function. */
  toString(): string;
}

/**
 * Extracts the type of the 'this' parameter of a function type, or 'unknown' if the function type has no 'this' parameter.
 */
type ThisParameterType<T> = T extends (this: infer U, ...args: never) => any ? U : unknown;

/**
 * Removes the 'this' parameter from a function type.
 */
type OmitThisParameter<T> = unknown extends ThisParameterType<T> ? T : T extends (...args: infer A) => infer R ? (...args: A) => R : T;

interface CallableFunction extends Function {
  /**
   * Calls the function with the specified object as the this value and the elements of specified array as the arguments.
   * @param thisArg The object to be used as the this object.
   */
  apply<T, R>(this: (this: T) => R, thisArg: T): R;

  /**
   * Calls the function with the specified object as the this value and the elements of specified array as the arguments.
   * @param thisArg The object to be used as the this object.
   * @param args An array of argument values to be passed to the function.
   */
  apply<T, A extends any[], R>(this: (this: T, ...args: A) => R, thisArg: T, args: A): R;

  /**
   * Calls the function with the specified object as the this value and the specified rest arguments as the arguments.
   * @param thisArg The object to be used as the this object.
   * @param args Argument values to be passed to the function.
   */
  call<T, A extends any[], R>(this: (this: T, ...args: A) => R, thisArg: T, ...args: A): R;

  /**
   * For a given function, creates a bound function that has the same body as the original function.
   * The this object of the bound function is associated with the specified object, and has the specified initial parameters.
   * @param thisArg The object to be used as the this object.
   */
  bind<T>(this: T, thisArg: ThisParameterType<T>): OmitThisParameter<T>;

  /**
   * For a given function, creates a bound function that has the same body as the original function.
   * The this object of the bound function is associated with the specified object, and has the specified initial parameters.
   * @param thisArg The object to be used as the this object.
   * @param args Arguments to bind to the parameters of the function.
   */
  bind<T, A extends any[], B extends any[], R>(this: (this: T, ...args: [...A, ...B]) => R, thisArg: T, ...args: A): (...args: B) => R;
}

interface NewableFunction extends Function {
  /**
   * Calls the function with the specified object as the this value and the elements of specified array as the arguments.
   * @param thisArg The object to be used as the this object.
   */
  apply<T>(this: new () => T, thisArg: T): void;
  /**
   * Calls the function with the specified object as the this value and the elements of specified array as the arguments.
   * @param thisArg The object to be used as the this object.
   * @param args An array of argument values to be passed to the function.
   */
  apply<T, A extends any[]>(this: new (...args: A) => T, thisArg: T, args: A): void;

  /**
   * Calls the function with the specified object as the this value and the specified rest arguments as the arguments.
   * @param thisArg The object to be used as the this object.
   * @param args Argument values to be passed to the function.
   */
  call<T, A extends any[]>(this: new (...args: A) => T, thisArg: T, ...args: A): void;

  /**
   * For a given function, creates a bound function that has the same body as the original function.
   * The this object of the bound function is associated with the specified object, and has the specified initial parameters.
   * @param thisArg The object to be used as the this object.
   */
  bind<T>(this: T, thisArg: any): T;

  /**
   * For a given function, creates a bound function that has the same body as the original function.
   * The this object of the bound function is associated with the specified object, and has the specified initial parameters.
   * @param thisArg The object to be used as the this object.
   * @param args Arguments to bind to the parameters of the function.
   */
  bind<A extends any[], B extends any[], R>(this: new (...args: [...A, ...B]) => R, thisArg: any, ...args: A): new (...args: B) => R;
}

interface IArguments {}
interface RegExp {}

declare class Map<K,V> {
  readonly size: i32;
  has(key: K): bool;
  set(key: K, value: V): this;
  get(key: K): V;
  delete(key: K): bool;
  clear(): void;
  keys(): K[]; // preliminary
  values(): V[]; // preliminary
  toString(): string;
}

declare class Set<K> {
  readonly size: i32;
  has(value: K): bool;
  add(value: K): this;
  delete(value: K): bool;
  clear(): void;
  values(): K[]; // preliminary
  toString(): string;
}

interface SymbolConstructor {
  readonly hasInstance: symbol;
  readonly isConcatSpreadable: symbol;
  readonly isRegExp: symbol;
  readonly iterator: symbol;
  readonly match: symbol;
  readonly replace: symbol;
  readonly search: symbol;
  readonly species: symbol;
  readonly split: symbol;
  readonly toPrimitive: symbol;
  readonly toStringTag: symbol;
  readonly unscopables: symbol;
  (description?: string | null): symbol;
  for(key: string): symbol;
  keyFor(sym: symbol): string | null;
}

declare const Symbol: SymbolConstructor;

/** @internal */
interface IMath<T> {
  /** The base of natural logarithms, e, approximately 2.718. */
  readonly E: T;
  /** The natural logarithm of 2, approximately 0.693. */
  readonly LN2: T;
  /** The natural logarithm of 10, approximately 2.302. */
  readonly LN10: T;
  /** The base 2 logarithm of e, approximately 1.442. */
  readonly LOG2E: T;
  /** The base 10 logarithm of e, approximately 0.434. */
  readonly LOG10E: T;
  /** The ratio of the circumference of a circle to its diameter, approximately 3.14159. */
  readonly PI: T;
  /** The square root of 1/2, approximately 0.707. */
  readonly SQRT1_2: T;
  /** The square root of 2, approximately 1.414. */
  readonly SQRT2: T;
  /** Returns the absolute value of \`x\`. */
  abs(x: T): T;
  /** Returns the arccosine (in radians) of \`x\`. */
  acos(x: T): T;
  /** Returns the hyperbolic arc-cosine of \`x\`. */
  acosh(x: T): T;
  /** Returns the arcsine (in radians) of \`x\`. */
  asin(x: T): T;
  /** Returns the hyperbolic arcsine of \`x\`. */
  asinh(x: T): T;
  /** Returns the arctangent (in radians) of \`x\`. */
  atan(x: T): T;
  /** Returns the arctangent of the quotient of its arguments. */
  atan2(y: T, x: T): T;
  /** Returns the hyperbolic arctangent of \`x\`. */
  atanh(x: T): T;
  /** Returns the cube root of \`x\`. */
  cbrt(x: T): T;
  /** Returns the smallest integer greater than or equal to \`x\`. */
  ceil(x: T): T;
  /** Returns the number of leading zero bits in the 32-bit binary representation of \`x\`. */
  clz32(x: T): T;
  /** Returns the cosine (in radians) of \`x\`. */
  cos(x: T): T;
  /** Returns the hyperbolic cosine of \`x\`. */
  cosh(x: T): T;
  /** Returns e to the power of \`x\`. */
  exp(x: T): T;
  /** Returns e to the power of \`x\`, minus 1. */
  expm1(x: T): T;
  /** Returns the largest integer less than or equal to \`x\`. */
  floor(x: T): T;
  /** Returns the nearest 32-bit single precision float representation of \`x\`. */
  fround(x: T): T;
  /** Returns the square root of the sum of squares of its arguments. */
  hypot(value1: T, value2: T): T; // TODO: rest
  /** Returns the result of the C-like 32-bit multiplication of \`a\` and \`b\`. */
  imul(a: T, b: T): T;
  /** Returns the natural logarithm (base e) of \`x\`. */
  log(x: T): T;
  /** Returns the base 10 logarithm of \`x\`. */
  log10(x: T): T;
  /** Returns the natural logarithm (base e) of 1 + \`x\`. */
  log1p(x: T): T;
  /** Returns the base 2 logarithm of \`x\`. */
  log2(x: T): T;
  /** Returns the largest-valued number of its arguments. */
  max(value1: T, value2: T): T; // TODO: rest
  /** Returns the lowest-valued number of its arguments. */
  min(value1: T, value2: T): T; // TODO: rest
  /** Returns \`base\` to the power of \`exponent\`. */
  pow(base: T, exponent: T): T;
  /** Returns a pseudo-random number in the range from 0.0 inclusive up to but not including 1.0. */
  random(): T;
  /** Returns the value of \`x\` rounded to the nearest integer. */
  round(x: T): T;
  /** Returns the sign of \`x\`, indicating whether the number is positive, negative or zero. */
  sign(x: T): T;
  /** Returns whether the sign bit of \`x\` is set. */
  signbit(x: T): bool;
  /** Returns the sine of \`x\`. */
  sin(x: T): T;
  /** Returns the hyperbolic sine of \`x\`. */
  sinh(x: T): T;
  /** Returns the square root of \`x\`. */
  sqrt(x: T): T;
  /** Returns the tangent of \`x\`. */
  tan(x: T): T;
  /** Returns the hyperbolic tangent of \`x\`. */
  tanh(x: T): T;
  /** Returns the integer part of \`x\` by removing any fractional digits. */
  trunc(x: T): T;
}

/** @internal */
interface INativeMath<T> extends IMath<T> {
  /** Contains sin value produced after Math/Mathf.sincos */
  sincos_sin: T;
  /** Contains cos value produced after Math/Mathf.sincos */
  sincos_cos: T;
  /** Seeds the random number generator. */
  seedRandom(value: i64): void;
  /** Multiplies a floating point \`x\` by 2 raised to power exp \`n\`. */
  scalbn(x: T, n: i32): T;
  /** Returns the floating-point remainder of \`x / y\` (rounded towards zero). */
  mod(x: T, y: T): T;
  /** Returns the floating-point remainder of \`x / y\` (rounded to nearest). */
  rem(x: T, y: T): T;
  /** Returns sin and cos simultaneously for same angle. Results stored to \`sincos_s32/64\` and \`sincos_c32/64\` globals */
  sincos(x: T): void;
  /** Returns 2 raised to the given power x. Equivalent to 2 ** x. */
  exp2(x: T): T;
}

/** Double precision math imported from JavaScript. */
declare const JSMath: IMath<f64>;
/** Double precision math implemented natively. */
declare const NativeMath: INativeMath<f64>;
/** Single precision math implemented natively. */
declare const NativeMathf: INativeMath<f32>;
/** Alias of {@link NativeMath} or {@link JSMath} respectively. Defaults to \`NativeMath\`. */
declare const Math: IMath<f64>;
/** Alias of {@link NativeMathf} or {@link JSMath} respectively. Defaults to \`NativeMathf\`. */
declare const Mathf: IMath<f32>;

/** Environmental abort function. */
declare function abort(msg?: string | null, fileName?: string | null, lineNumber?: i32, columnNumber?: i32): never;
/** Environmental tracing function. */
declare function trace(msg: string, n?: i32, a0?: f64, a1?: f64, a2?: f64, a3?: f64, a4?: f64): void;
/** Environmental seeding function. */
declare function seed(): f64;

/** Node-like process. */
declare namespace process {
  /** String representing the CPU architecture for which the binary was compiled. Either \`wasm32\` or \`wasm64\`. */
  export const arch: string;
  /** String representing the operating system platform for which the binary was compiled. Always \`wasm\`. */
  export const platform: string;
  /** Array of command line arguments passed to the binary upon instantiation. */
  export const argv: string[];
  /** Map of variables in the binary's user environment. */
  export const env: Map<string,string>;
  /** Terminates the process with either the given exit code, or \`process.exitCode\` if omitted. */
  export function exit(code?: i32): void;
  /** \`exit()\`\u2019s default value. Defaults to \`0\`. */
  export let exitCode: i32;
  /** Stream connected to \`stdin\` (fd \`0\`). */
  export const stdin: ReadableStream;
  /** Stream connected to \`stdout\` (fd \`1\`). */
  export const stdout: WritableStream;
  /** Stream connected to \`stderr\` (fd \`2\`). */
  export const stderr: WritableStream;
  /** Obtains the system's current time of day, in milliseconds since Unix epoch. */
  export function time(): i64;
  /** Obtains the system's monotonic high resolution time, in nanoseconds since an arbitrary time in the past. */
  export function hrtime(): u64;

  interface Stream {
    /** Closes the stream. Throws if already closed or if the stream cannot be closed. */
    close(): void;
  }
  interface ReadableStream extends Stream {
    /** Reads available data from the stream, into \`buffer\` at offset \`offset\`, returning the number of bytes read. */
    read(buffer: ArrayBuffer, offset?: isize): i32;
  }
  interface WritableStream extends Stream {
    /** Writes string or buffer to the stream. */
    write<T extends string | ArrayBuffer>(data: T): void;
  }
}

/** Browser-like console. */
declare namespace console {
  /** Logs \`message\` to console if \`assertion\` is false-ish. */
  export function assert<T>(assertion: T, message?: string): void;
  /** Outputs \`message\` to the console. */
  export function log(message?: string): void;
  /** Outputs \`message\` to the console, prefixed with "Debug:". */
  export function debug(message?: string): void;
  /** Outputs \`message\` to the console, prefixed with "Info:". */
  export function info(message?: string): void;
  /** Outputs \`message\` to the console, prefixed with "Warning:". */
  export function warn(message?: string): void;
  /** Outputs \`message\` to the console, prefixed with "Error:". */
  export function error(message?: string): void;
  /** Starts a new timer using the specified \`label\`. */
  export function time(label?: string): void;
  /** Logs the current value of a timer previously started with \`console.time\`. */
  export function timeLog(label?: string): void;
  /** Logs the current value of a timer previously started with \`console.time\` and discards the timer. */
  export function timeEnd(label?: string): void;
}

/** Browser-like crypto utilities. */
declare namespace crypto {
  /** Fills \`array\` with cryptographically strong random values. */
  export function getRandomValues(array: Uint8Array): void;
}

// Decorators

interface TypedPropertyDescriptor<T> {
  configurable?: boolean;
  enumerable?: boolean;
  writable?: boolean;
  value?: T;
  get?(): T;
  set?(value: T): void;
}

type Constructor =
  (new (...args: any[]) => unknown)
  | (abstract new (...args: any[]) => unknown);

/** Annotates a method as a binary operator overload for the specified \`token\`. */
declare function operator(token:
  "[]" | "[]=" | "{}" | "{}=" | "==" | "!=" | ">" | "<" | "<=" | ">=" |
  ">>" | ">>>" | "<<" |  "&"  | "|"  | "^"  | "+" | "-" | "*"  | "**" | "/"  | "%"
): (
  target: any,
  propertyKey: string,
  descriptor: TypedPropertyDescriptor<any>
) => TypedPropertyDescriptor<any> | void;

declare namespace operator {
  /** Annotates a method as a binary operator overload for the specified \`token\`. */
  export function binary(token:
    "[]" | "[]=" | "{}" | "{}=" | "==" | "!=" | ">" | "<" | "<=" | ">=" |
    ">>" | ">>>" | "<<" |  "&"  | "|"  | "^"  | "+" | "-" | "*"  | "**" | "/"  | "%"
  ): (
    target: any,
    propertyKey: string,
    descriptor: TypedPropertyDescriptor<any>
  ) => TypedPropertyDescriptor<any> | void;
  /** Annotates a method as an unary prefix operator overload for the specified \`token\`. */
  export function prefix(token: "!" | "~" | "+" | "-" | "++" | "--"): (
    target: any,
    propertyKey: string,
    descriptor: TypedPropertyDescriptor<any>
  ) => TypedPropertyDescriptor<any> | void;
  /** Annotates a method as an unary postfix operator overload for the specified \`token\`. */
  export function postfix(token: "++" | "--"): (
    target: any,
    propertyKey: string,
    descriptor: TypedPropertyDescriptor<any>
  ) => TypedPropertyDescriptor<any> | void;
}

/** Annotates an element as a program global. */
declare function global(...args: any[]): any;

/** Annotates a class as being unmanaged with limited capabilities. */
declare function unmanaged(constructor: Constructor): void;

/** Annotates a class as being final / non-derivable. */
declare function final(constructor: Constructor): void;

/** Annotates a method, function or constant global as always inlined. */
declare function inline(...args: any[]): any;
declare namespace inline {
  /** Explicitly requests inlined function calls on the provided expression wherever possible. */
  export function always<T>(value: T): T;
}

/** Annotates a method, function or constant global as unsafe. */
declare function unsafe(...args: any[]): any;

/** Annotates an explicit external name of a function or global. */
declare function external(name: string): any;
declare function external(moduleName: string, name: string): any;
declare namespace external {
  function js(code: string): any;
}

/** Annotates a global for lazy compilation. */
declare function lazy(...args: any[]): any;
`,portable:`/**
 * Environment definitions for compiling AssemblyScript to JavaScript using tsc.
 *
 * Note that semantic differences require additional explicit conversions for full compatibility.
 * For example, when casting an i32 to an u8, doing \`<u8>(someI32 & 0xff)\` will yield the same
 * result when compiling to WebAssembly or JS while \`<u8>someI32\` alone does nothing in JS.
 *
 * Note that i64's are not portable (JS numbers are IEEE754 doubles with a maximum safe integer
 * value of 2^53-1) and instead require a compatibility layer to work in JS as well, as for example
 * {@link glue/js/i64} respectively {@link glue/wasm/i64}.
 *
 * @module std/portable
 *//***/

// Types

declare type bool = boolean;
declare type i8 = number;
declare type i16 = number;
declare type i32 = number;
declare type isize = number;
declare type u8 = number;
declare type u16 = number;
declare type u32 = number;
declare type usize = number;
declare type f32 = number;
declare type f64 = number;

/** Special type evaluating the indexed access index type. */
declare type indexof<T extends unknown[]> = keyof T;
/** Special type evaluating the indexed access value type. */
declare type valueof<T extends unknown[]> = T[0];

// Compiler hints

/** Compiler target. 0 = JS, 1 = WASM32, 2 = WASM64. */
declare const ASC_TARGET: i32;
/** Runtime type. 0 = Stub, 1 = Minimal, 2 = Incremental. */
declare const ASC_RUNTIME: i32;
/** Provided noAssert option. */
declare const ASC_NO_ASSERT: bool;
/** Provided memoryBase option. */
declare const ASC_MEMORY_BASE: i32;
/** Provided optimizeLevel option. */
declare const ASC_OPTIMIZE_LEVEL: i32;
/** Provided shrinkLevel option. */
declare const ASC_SHRINK_LEVEL: i32;
/** Whether the mutable global feature is enabled. */
declare const ASC_FEATURE_MUTABLE_GLOBAL: bool;
/** Whether the sign extension feature is enabled. */
declare const ASC_FEATURE_SIGN_EXTENSION: bool;

// Builtins

/** Performs the sign-agnostic reverse bytes **/
declare function bswap<T = i32 | u32 | isize | usize>(value: T): T;
/** Performs the sign-agnostic count leading zero bits operation on a 32-bit integer. All zero bits are considered leading if the value is zero. */
declare function clz<T = i32>(value: T): T;
/** Performs the sign-agnostic count tailing zero bits operation on a 32-bit integer. All zero bits are considered trailing if the value is zero. */
declare function ctz<T = i32>(value: T): T;
/** Performs the sign-agnostic count number of one bits operation on a 32-bit integer. */
declare function popcnt<T = i32>(value: T): T;
/** Performs the sign-agnostic rotate left operation on a 32-bit integer. */
declare function rotl<T = i32>(value: T, shift: T): T;
/** Performs the sign-agnostic rotate right operation on a 32-bit integer. */
declare function rotr<T = i32>(value: T, shift: T): T;
/** Computes the absolute value of an integer or float. */
declare function abs<T = i32 | f32 | f64>(value: T): T;
/** Determines the maximum of two integers or floats. If either operand is \`NaN\`, returns \`NaN\`. */
declare function max<T = i32 | f32 | f64>(left: T, right: T): T;
/** Determines the minimum of two integers or floats. If either operand is \`NaN\`, returns \`NaN\`. */
declare function min<T = i32 | f32 | f64>(left: T, right: T): T;
/** Composes a 32-bit or 64-bit float from the magnitude of \`x\` and the sign of \`y\`. */
declare function copysign<T = f32 | f64>(x: T, y: T): T;
/** Performs the ceiling operation on a 32-bit or 64-bit float. */
declare function ceil<T = f32 | f64>(value: T): T;
/** Performs the floor operation on a 32-bit or 64-bit float. */
declare function floor<T = f32 | f64>(value: T): T;
/** Rounds to the nearest integer tied to even of a 32-bit or 64-bit float. */
declare function nearest<T = f32 | f64>(value: T): T;
/** Selects one of two pre-evaluated values depending on the condition. */
declare function select<T>(ifTrue: T, ifFalse: T, condition: bool): T;
/** Calculates the square root of a 32-bit or 64-bit float. */
declare function sqrt<T = f32 | f64>(value: T): T;
/** Rounds to the nearest integer towards zero of a 32-bit or 64-bit float. */
declare function trunc<T = f32 | f64>(value: T): T;
/** Emits an unreachable operation that results in a runtime error when executed. */
declare function unreachable(): any; // sic

/** Changes the type of any value of \`usize\` kind to another one of \`usize\` kind. Useful for casting class instances to their pointer values and vice-versa. Beware that this is unsafe.*/
declare function changetype<T>(value: any): T;
/** Explicitly requests no bounds checks on the provided expression. Useful for array accesses. */
declare function unchecked<T>(value: T): T;
/** Tests if the specified value is a valid integer. Can't distinguish an integer from an integral float. */
declare function isInteger(value: any): value is number;
/** Tests if the specified value is a valid float. Can't distinguish a float from an integer. */
declare function isFloat(value: any): value is number;
/** Tests if the specified value is of a nullable reference type. */
declare function isNullable(value: any): bool;
/** Tests if the specified value is of a reference type. */
declare function isReference(value: any): value is object | string;
/** Tests if the specified value is of a function type */
declare function isFunction(value: any): value is Function;
/** Tests if the specified value can be used as a string. */
declare function isString(value: any): value is string | String;
/** Tests if the specified value can be used as an array. */
declare function isArray(value: any): value is Array<any>;
/** Tests if the specified type *or* expression can be used as an array like object. */
declare function isArrayLike(value: any): value is ArrayLike<any>;
/** Tests if the specified expression resolves to a defined element. */
declare function isDefined(expression: any): bool;
/** Tests if the specified expression evaluates to a constant value. */
declare function isConstant(expression: any): bool;
/** Traps if the specified value is not true-ish, otherwise returns the value. */
declare function assert<T>(isTrueish: T, message?: string): T & (object | string | number); // any better way to model \`: T != null\`?
/** Parses an integer string to a 64-bit float. */
declare function parseInt(str: string, radix?: i32): f64;
/** Parses a floating point string to a 64-bit float. */
declare function parseFloat(str: string): f64;
/** Returns the 64-bit floating-point remainder of \`x/y\`. */
declare function fmod(x: f64, y: f64): f64;
/** Returns the 32-bit floating-point remainder of \`x/y\`. */
declare function fmodf(x: f32, y: f32): f32;

/** Converts any other numeric value to an 8-bit signed integer. */
declare function i8(value: any): i8;
declare namespace i8 {
  /** Smallest representable value. */
  export const MIN_VALUE: i8;
  /** Largest representable value. */
  export const MAX_VALUE: i8;
  /** Converts a string to a floating-point number and cast to target integer after. */
  export function parseFloat(string: string): i8;
  /** Parses a string as an integer. */
  export function parseInt(string: string, radix?: i32): i8;
  /** Parses a string as an i8. */
  export function parse(value: string, radix?: i32): i8;
}
/** Converts any other numeric value to a 16-bit signed integer. */
declare function i16(value: any): i16;
declare namespace i16 {
  /** Smallest representable value. */
  export const MIN_VALUE: i16;
  /** Largest representable value. */
  export const MAX_VALUE: i16;
  /** Converts a string to a floating-point number and cast to target integer after. */
  export function parseFloat(string: string): i16;
  /** Parses a string as an integer. */
  export function parseInt(string: string, radix?: i32): i16;
  /** Parses a string as an i16. */
  export function parse(value: string, radix?: i32): i16;
}
/** Converts any other numeric value to a 32-bit signed integer. */
declare function i32(value: any): i32;
declare namespace i32 {
  /** Smallest representable value. */
  export const MIN_VALUE: i32;
  /** Largest representable value. */
  export const MAX_VALUE: i32;
  /** Converts a string to a floating-point number and cast to target integer after. */
  export function parseFloat(string: string): i32;
  /** Parses a string as an integer. */
  export function parseInt(string: string, radix?: i32): i32;
  /** Parses a string as an i32. */
  export function parse(value: string, radix?: i32): i32;
}
/** Converts any other numeric value to a 32-bit (in WASM32) respectivel 64-bit (in WASM64) signed integer. */
declare function isize(value: any): isize;
declare namespace isize {
  /** Smallest representable value. */
  export const MIN_VALUE: isize;
  /** Largest representable value. */
  export const MAX_VALUE: isize;
  /** Converts a string to a floating-point number and cast to target integer after. */
  export function parseFloat(string: string): isize;
  /** Parses a string as an integer. */
  export function parseInt(string: string, radix?: i32): isize;
  /** Parses a string as an iszie. */
  export function parse(value: string, radix?: i32): isize;
}
/** Converts any other numeric value to an 8-bit unsigned integer. */
declare function u8(value: any): u8;
declare namespace u8 {
  /** Smallest representable value. */
  export const MIN_VALUE: u8;
  /** Largest representable value. */
  export const MAX_VALUE: u8;
  /** Converts a string to a floating-point number and cast to target integer after. */
  export function parseFloat(string: string): u8;
  /** Parses a string as an integer. */
  export function parseInt(string: string, radix?: i32): u8;
  /** Parses a string as an u8. */
  export function parse(value: string, radix?: i32): u8;
}
/** Converts any other numeric value to a 16-bit unsigned integer. */
declare function u16(value: any): u16;
declare namespace u16 {
  /** Smallest representable value. */
  export const MIN_VALUE: u16;
  /** Largest representable value. */
  export const MAX_VALUE: u16;
  /** Converts a string to a floating-point number and cast to target integer after. */
  export function parseFloat(string: string): u16;
  /** Parses a string as an integer. */
  export function parseInt(string: string, radix?: i32): u16;
  /** Parses a string as an u16. */
  export function parse(value: string, radix?: i32): u16;
}
/** Converts any other numeric value to a 32-bit unsigned integer. */
declare function u32(value: any): u32;
declare namespace u32 {
  /** Smallest representable value. */
  export const MIN_VALUE: u32;
  /** Largest representable value. */
  export const MAX_VALUE: u32;
  /** Converts a string to a floating-point number and cast to target integer after. */
  export function parseFloat(string: string): u32;
  /** Parses a string as an integer. */
  export function parseInt(string: string, radix?: i32): u32;
  /** Parses a string as an u32. */
  export function parse(value: string, radix?: i32): u32;
}
/** Converts any other numeric value to a 32-bit (in WASM32) respectivel 64-bit (in WASM64) unsigned integer. */
declare function usize(value: any): isize;
declare namespace usize {
  /** Smallest representable value. */
  export const MIN_VALUE: usize;
  /** Largest representable value. */
  export const MAX_VALUE: usize;
  /** Converts a string to a floating-point number and cast to target integer after. */
  export function parseFloat(string: string): usize;
  /** Parses a string as an integer. */
  export function parseInt(string: string, radix?: i32): usize;
  /** Parses a string as an usize. */
  export function parse(value: string, radix?: i32): usize;
}
/** Converts any other numeric value to a 1-bit unsigned integer. */
declare function bool(value: any): bool;
declare namespace bool {
  /** Smallest representable value. */
  export const MIN_VALUE: bool;
  /** Largest representable value. */
  export const MAX_VALUE: bool;
  /** Parses a string as a bool. */
  export function parse(value: string): bool;
}
/** Converts any other numeric value to a 32-bit float. */
declare function f32(value: any): f32;
declare namespace f32 {
  /** Smallest representable value. */
  export const MIN_VALUE: f32;
  /** Largest representable value. */
  export const MAX_VALUE: f32;
  /** Smallest normalized positive value. */
  export const MIN_NORMAL_VALUE: f32;
  /** Smallest safely representable integer value. */
  export const MIN_SAFE_INTEGER: f32;
  /** Largest safely representable integer value. */
  export const MAX_SAFE_INTEGER: f32;
  /** Positive infinity value. */
  export const POSITIVE_INFINITY: f32;
  /** Negative infinity value. */
  export const NEGATIVE_INFINITY: f32;
  /** Not a number value. */
  /* eslint no-shadow-restricted-names: "off" */
  export const NaN: f32;
  /** Difference between 1 and the smallest representable value greater than 1. */
  export const EPSILON: f32;
  /** Returns a boolean value that indicates whether a value is the reserved value NaN (not a number). */
  export function isNaN(value: f32): bool;
  /** Returns true if passed value is finite. */
  export function isFinite(value: f32): bool;
  /** Returns true if the value passed is a safe integer. */
  export function isSafeInteger(value: f32): bool;
  /** Returns true if the value passed is an integer, false otherwise. */
  export function isInteger(value: f32): bool;
  /** Converts a string to a floating-point number. */
  export function parseFloat(string: string): f32;
  /** Parses a string as an integer and convert to an f32. */
  export function parseInt(string: string, radix?: i32): f32;
  /** Parses a string as an f32. */
  export function parse(value: string): f32;
}
/** Converts any other numeric value to a 64-bit float. */
declare function f64(value: any): f64;
declare namespace f64 {
  /** Smallest representable value. */
  export const MIN_VALUE: f64;
  /** Largest representable value. */
  export const MAX_VALUE: f64;
  /** Smallest normalized positive value. */
  export const MIN_NORMAL_VALUE: f64;
  /** Smallest safely representable integer value. */
  export const MIN_SAFE_INTEGER: f64;
  /** Largest safely representable integer value. */
  export const MAX_SAFE_INTEGER: f64;
  /** Positive infinity value. */
  export const POSITIVE_INFINITY: f64;
  /** Negative infinity value. */
  export const NEGATIVE_INFINITY: f64;
  /** Not a number value. */
  /* eslint no-shadow-restricted-names: "off" */
  export const NaN: f64;
  /** Difference between 1 and the smallest representable value greater than 1. */
  export const EPSILON: f64;
  /** Returns a boolean value that indicates whether a value is the reserved value NaN (not a number). */
  export function isNaN(value: f32): bool;
  /** Returns true if passed value is finite. */
  export function isFinite(value: f32): bool;
  /** Returns true if the value passed is a safe integer. */
  export function isSafeInteger(value: f64): bool;
  /** Returns true if the value passed is an integer, false otherwise. */
  export function isInteger(value: f64): bool;
  /** Converts a string to a floating-point number. */
  export function parseFloat(string: string): f64;
  /** Parses a string as an integer and convert to an f64. */
  export function parseInt(string: string, radix?: i32): f64;
  /** Parses a string as an f64. */
  export function parse(value: string): f64;
}

// Standard library

declare const Mathf: typeof Math;
declare const JSMath: typeof Math;

declare interface StringConstructor {
  /** Equivalent to calling \`String.fromCharCode\` with multiple arguments. */
  fromCharCodes(arr: i32[]): string;
  /** Equivalent to calling \`String.fromCodePoint\` with multiple arguments. */
  fromCodePoints(arr: i32[]): string;
}

declare interface String {
  /** Returns value using relative indexing. Index may be negative */
  at(index: i32): string;
}

/** Annotates a class as being unmanaged with limited capabilities. */
declare function unmanaged(constructor: Function): void;

/** Environmental tracing function. */
declare function trace(msg: string, n?: i32, a0?: f64, a1?: f64, a2?: f64, a3?: f64, a4?: f64): void;

declare interface Array<T> {
  /** Returns value using relative indexing. Index may be negative */
  at(index: i32): T;
  /** Returns an index start searching from the end in the array */
  findLastIndex(callbackfn: (value: T, index: i32, self: Array<T>) => bool): i32;
}

declare interface Int8ArrayConstructor {
  /** Equivalent to calling \`new Int8Array\` with multiple arguments. */
  wrap(buffer: ArrayBuffer, byteOffset?: i32, length?: i32): Int8Array;
}

declare interface Int8Array {
  /** Returns value using relative indexing. Index may be negative */
  at(index: i32): i8;
  /** Returns an index start searching from the end in the typedarray */
  findLastIndex(callbackfn: (value: i8, index: i32, self: Int8Array) => bool): i32;
}

declare interface Uint8ArrayConstructor {
  /** Equivalent to calling \`new Uint8Array\` with multiple arguments. */
  wrap(buffer: ArrayBuffer, byteOffset?: i32, length?: i32): Uint8Array;
}

declare interface Uint8Array {
  /** Returns value using relative indexing. Index may be negative */
  at(index: i32): u8;
  /** Returns an index start searching from the end in the typedarray */
  findLastIndex(callbackfn: (value: u8, index: i32, self: Uint8Array) => bool): i32;
}

declare interface Uint8ClampedArrayConstructor {
  /** Equivalent to calling \`new Uint8ClampedArray\` with multiple arguments. */
  wrap(buffer: ArrayBuffer, byteOffset?: i32, length?: i32): Uint8ClampedArray;
}

declare interface Uint8ClampedArray {
  /** Returns value using relative indexing. Index may be negative */
  at(index: i32): u8;
  /** Returns an index start searching from the end in the typedarray */
  findLastIndex(callbackfn: (value: u8, index: i32, self: Uint8ClampedArray) => bool): i32;
}

declare interface Int16ArrayConstructor {
  /** Equivalent to calling \`new Int16Array\` with multiple arguments. */
  wrap(buffer: ArrayBuffer, byteOffset?: i32, length?: i32): Int16Array;
}

declare interface Int16Array {
  /** Returns value using relative indexing. Index may be negative */
  at(index: i32): i16;
  /** Returns an index start searching from the end in the typedarray */
  findLastIndex(callbackfn: (value: i16, index: i32, self: Int16Array) => bool): i32;
}

declare interface Uint16ArrayConstructor {
  /** Equivalent to calling \`new Uint16Array\` with multiple arguments. */
  wrap(buffer: ArrayBuffer, byteOffset?: i32, length?: i32): Uint16Array;
}

declare interface Uint16Array {
  /** Returns value using relative indexing. Index may be negative */
  at(index: i32): u16;
  /** Returns an index start searching from the end in the typedarray */
  findLastIndex(callbackfn: (value: u16, index: i32, self: Uint16Array) => bool): i32;
}

declare interface Int32ArrayConstructor {
  /** Equivalent to calling \`new Int32Array\` with multiple arguments. */
  wrap(buffer: ArrayBuffer, byteOffset?: i32, length?: i32): Int32Array;
}

declare interface Int32Array {
  /** Returns value using relative indexing. Index may be negative */
  at(index: i32): i32;
  /** Returns an index start searching from the end in the typedarray */
  findLastIndex(callbackfn: (value: i32, index: i32, self: Int32Array) => bool): i32;
}

declare interface Uint32ArrayConstructor {
  /** Equivalent to calling \`new Uint32Array\` with multiple arguments. */
  wrap(buffer: ArrayBuffer, byteOffset?: i32, length?: i32): Uint32Array;
}

declare interface Uint32Array {
  /** Returns value using relative indexing. Index may be negative */
  at(index: i32): u32;
  /** Returns an index start searching from the end in the typedarray */
  findLastIndex(callbackfn: (value: u32, index: i32, self: Uint32Array) => bool): i32;
}

declare interface Float32ArrayConstructor {
  /** Equivalent to calling \`new Float32Array\` with multiple arguments. */
  wrap(buffer: ArrayBuffer, byteOffset?: i32, length?: i32): Float32Array;
}

declare interface Float32Array {
  /** Returns value using relative indexing. Index may be negative */
  at(index: i32): f32;
  /** Returns an index start searching from the end in the typedarray */
  findLastIndex(callbackfn: (value: f32, index: i32, self: Float32Array) => bool): i32;
}

declare interface Float64ArrayConstructor {
  /** Equivalent to calling \`new Float64Array\` with multiple arguments. */
  wrap(buffer: ArrayBuffer, byteOffset?: i32, length?: i32): Float64Array;
}

declare interface Float64Array {
  /** Returns value using relative indexing. Index may be negative */
  at(index: i32): f64;
  /** Returns an index start searching from the end in the typedarray */
  findLastIndex(callbackfn: (value: f64, index: i32, self: Float64Array) => bool): i32;
}

// FIXME: remove
declare function offsetof<T>(fieldName?: string): usize;
declare function idof<T>(): u32;
`};var xn={};Q(xn,{default:()=>pn});wn(xn,Mt);import*as Mt from"./binaryen/index.js";import{default as pn}from"./binaryen/index.js";import*as At from"./assemblyscript.js";var g=At,Pn=M.argv.indexOf("--wasm");if(~Pn){let e=String(M.argv[Pn+1]);M.argv.splice(Pn,2),g=await import(new URL(e,dn.pathToFileURL(M.cwd()+"/")))}var Vn=an.createRequire(import.meta.url),Kn=M.platform==="win32",E=Kn?`\r
`:`
`,jn=Kn?"\\":"/",_=".ts",_t=`.d${_}`,gn=new RegExp("\\"+_+"$"),Tt=new RegExp("^(?!.*\\.d\\"+_+"$).*\\"+_+"$");function Te(e){return e.replace(/-/g,"_").toUpperCase()}function Ct(e){return typeof e=="string"&&e!==""}var Xn=ve,zt=Y,P=Ee,G=Ae,Bt=_e,Be=3,Se=0;function qn(e,t=[]){return Object.keys(e||{}).forEach(n=>{let i=e[n],s=Y[n];s&&s.type==="b"?i&&t.push(`--${n}`):Array.isArray(i)?i.forEach(o=>{t.push(`--${n}`,String(o))}):t.push(`--${n}`,String(i))}),t}async function St(e,t={}){typeof e=="string"&&(e={[`input${_}`]:e});let n=["--outFile","binary","--textFile","text"];qn(t,n);let i={},s=await De(n.concat(Object.keys(e)),{readFile:o=>Object.prototype.hasOwnProperty.call(e,o)?e[o]:null,writeFile:(o,u)=>{i[o]=u},listFiles:()=>[]});return Object.assign(s,i)}async function De(e,t){Array.isArray(e)||(e=qn(e)),t||(t={});let n=t.stats||new Cn,i=n.begin(),s=0,o=0,u=0,f=(Xn||"").split(".");f.length===3&&(o=parseInt(f[0])|0,s=parseInt(f[1])|0,u=parseInt(f[2])|0);let p=t.stdout||Hn(),b=t.stderr||Hn(),c=t.readFile||ee,h=t.writeFile||te,F=t.listFiles||ie,m=Fe(e,Y,!1),r=m.options;e=m.arguments;let zn=new nn(p),X=new nn(b);r.noColors&&(zn.enabled=!1,X.enabled=!1);let Yn=m.unknown;Yn.length&&Yn.forEach(a=>{b.write(`${X.yellow("WARNING ")}Unknown option '${a}'${E}`)});let $n=m.trailing;$n.length&&b.write(`${X.yellow("WARNING ")}Unsupported trailing arguments: ${$n.join(" ")}${E}`);let H=null,k=null,z=(a,l={})=>(a&&b.write(`${X.red("FAILURE ")}${a.stack.replace(/^ERROR: /i,"")}${E}`),k&&k.dispose(),n.total||(n.total=n.end(i)),Object.assign({error:a,stdout:p,stderr:b,stats:n},l));if(r.version)return p.write(`Version ${Xn}${E}`),z(null);let B=v.normalize(r.baseDir||"."),K=en(r.config||"asconfig.json",B),Bn=v.basename(K),$=v.dirname(K),R=await Ce(Bn,$,c),we=R!=null&&Array.isArray(R.entries)&&R.entries.length;if(r.help||!e.length&&!we){let a=r.help?p:b,l=r.help?zn:X;return a.write([l.white("SYNTAX"),"  "+l.cyan("asc")+" [entryFile ...] [options]","",l.white("EXAMPLES"),"  "+l.cyan("asc")+" hello"+_,"  "+l.cyan("asc")+" hello"+_+" -o hello.wasm -t hello.wat","  "+l.cyan("asc")+" hello1"+_+" hello2"+_+" -o -O > hello.wasm","  "+l.cyan("asc")+" --config asconfig.json --target release","",l.white("OPTIONS")].concat(ye(Y,24,E)).join(E)+E),z(null)}if(!(j.promises&&j.promises.readFile)){if(c===ee)throw Error("'options.readFile' must be specified");if(h===te)throw Error("'options.writeFile' must be specified");if(F===ie)throw Error("'options.listFiles' must be specified")}let Sn=new Set;Sn.add(K);let Ie=r.target||"release";for(;R;){if(R.targets){let l=R.targets[Ie];l&&(r=Un(Y,r,l,$))}let a=R.options;if(a&&(r=Un(Y,r,a,$)),R.entries)for(let l of R.entries)e.push(en(l,$));if(R.extends){if(K=en(R.extends,$,!0),Bn=v.basename(K),$=v.dirname(K),Sn.has(K))break;Sn.add(K),R=await Ce(Bn,$,c)}else break}if(Mn(Y,r),r.showConfig)return b.write(JSON.stringify({options:r,entries:e},null,2)),z(null);function Zn(a){return[...new Set(a)]}let D,sn,hn,T=g.newOptions();switch(r.runtime){case"stub":sn=0;break;case"minimal":sn=1;break;default:sn=2;break}switch(r.uncheckedBehavior){default:hn=0;break;case"never":hn=1;break;case"always":hn=2;break}if(g.setTarget(T,0),g.setDebugInfo(T,!!r.debug),g.setRuntime(T,sn),g.setNoAssert(T,r.noAssert),g.setExportMemory(T,!r.noExportMemory),g.setImportMemory(T,r.importMemory),g.setInitialMemory(T,r.initialMemory>>>0),g.setMaximumMemory(T,r.maximumMemory>>>0),g.setSharedMemory(T,r.sharedMemory),g.setImportTable(T,r.importTable),g.setExportTable(T,r.exportTable),r.exportStart!=null&&g.setExportStart(T,Ct(r.exportStart)?r.exportStart:"_start"),g.setMemoryBase(T,r.memoryBase>>>0),g.setTableBase(T,r.tableBase>>>0),g.setSourceMap(T,r.sourceMap!=null),g.setUncheckedBehavior(T,hn),g.setNoUnsafe(T,r.noUnsafe),g.setPedantic(T,r.pedantic),g.setLowMemoryLimit(T,r.lowMemoryLimit>>>0),g.setExportRuntime(T,r.exportRuntime),g.setBundleVersion(T,o,s,u),!r.stackSize&&sn===2&&(r.stackSize=g.DEFAULT_STACK_SIZE),g.setStackSize(T,r.stackSize),g.setBindingsHint(T,r.bindings&&r.bindings.length>0),r.use){let a=r.use;for(let l=0,d=a.length;l<d;++l){let x=a[l],A=x.indexOf("=");if(A<0)return z(Error(`Global alias '${x}' is invalid.`));let y=x.substring(0,A).trim(),C=x.substring(A+1).trim();if(!y.length)return z(Error(`Global alias '${x}' is invalid.`));g.addGlobalAlias(T,y,C)}}let N;if((N=r.disable)!=null){typeof N=="string"&&(N=N.split(","));for(let a=0,l=N.length;a<l;++a){let d=N[a].trim(),x=g[`FEATURE_${Te(d)}`];if(!x)return z(Error(`Feature '${d}' is unknown.`));g.setFeature(T,x,!1)}}if((N=r.enable)!=null){typeof N=="string"&&(N=N.split(","));for(let a=0,l=N.length;a<l;++a){let d=N[a].trim(),x=g[`FEATURE_${Te(d)}`];if(!x)return z(Error(`Feature '${d}' is unknown.`));g.setFeature(T,x,!0)}}let Z=0,J=0;r.optimize&&(Z=Be,J=Se),typeof r.optimizeLevel=="number"&&(Z=r.optimizeLevel),typeof r.shrinkLevel=="number"&&(J=r.shrinkLevel),Z=Math.min(Math.max(Z,0),3),J=Math.min(Math.max(J,0),2),g.setOptimizeLevelHints(T,Z,J),D=g.newProgram(T);let tn=[];if(Array.isArray(t.transforms)&&tn.push(...t.transforms),r.transform){let a=Zn(r.transform);for(let l=0,d=a.length;l<d;++l){let x=a[l].trim(),A,y;if(Vn.resolve)try{A=Vn.resolve(x,{paths:[M.cwd(),B]}),y=await import(dn.pathToFileURL(A)),y.default&&(y=y.default)}catch(C){try{y=Vn(A)}catch{return z(C)}}else try{y=await import(new URL(x,import.meta.url)),y.default&&(y=y.default)}catch(C){return z(C)}if(!y||typeof y!="function"&&typeof y!="object")return z(Error("not a transform: "+a[l]));tn.push(y)}}try{tn=tn.map(a=>(typeof a=="function"&&(Object.assign(a.prototype,{program:D,binaryen:pn,baseDir:B,stdout:p,stderr:b,log:console.error,readFile:c,writeFile:h,listFiles:F}),a=new a),a))}catch(a){return z(a)}async function Dn(a,...l){for(let d=0,x=tn.length;d<x;++d){let A=tn[d];if(typeof A[a]=="function")try{let y=n.begin();n.transformCount++,await A[a](...l),n.transformTime+=n.end(y)}catch(y){return y}}}Object.keys(G).forEach(a=>{if(a.includes("/"))return;let l=n.begin();n.parseCount++,g.parse(D,G[a],P+a+_,!1),n.parseTime+=n.end(l)});let rn=[];if(r.lib){let a=r.lib;typeof a=="string"&&(a=a.split(",")),rn.push(...a.map(l=>l.trim())),rn=Zn(rn);for(let l=0,d=rn.length;l<d;++l){let x=rn[l],A;x.endsWith(_)?(A=[v.basename(x)],x=v.dirname(x)):A=await F(x,B)||[];for(let y of A){let C=await c(y,x);if(C==null)return z(Error(`Library file '${y}' not found.`));G[y.replace(gn,"")]=C;let I=n.begin();n.parseCount++,g.parse(D,C,P+y,!1),n.parseTime+=n.end(I)}}}r.path=r.path||[];let mn=new Map;async function Oe(a,l){let d=null,x=null;if(!a.startsWith(P))(d=await c(x=a+_,B))==null&&(d=await c(x=a+"/index"+_,B))==null&&(x=a+_,d=await c(a+_t,B));else{let A=a.substring(P.length),y=`${A}/index`;if(Object.prototype.hasOwnProperty.call(G,A))d=G[A],x=P+A+_;else if(Object.prototype.hasOwnProperty.call(G,y))d=G[y],x=P+y+_;else{for(let C of rn)if((d=await c(A+_,C))!=null){x=P+A+_;break}else if((d=await c(y+_,C))!=null){x=P+y+_;break}if(d==null){let C=a.match(/^~lib\/((?:@[^/]+\/)?[^/]+)(?:\/(.+))?/);if(C){let I=C[1],q=C[2]||"index",yn=mn.has(l)?mn.get(l):".",U=[],w=v.resolve(B,yn).split(jn);for(let S=w.length,O=Kn?1:0;S>=O;--S)w[S-1]!=="node_modules"&&U.push(`${w.slice(0,S).join(jn)}${jn}node_modules`);U.push(...r.path);for(let S of U.map(O=>v.relative(B,O))){let O=q;if((d=await c(v.join(S,I,O+_),B))!=null){x=`${P}${I}/${O}${_}`,mn.set(x.replace(gn,""),v.join(S,I));break}let un=`${q}/index`;if((d=await c(v.join(S,I,un+_),B))!=null){x=`${P}${I}/${un}${_}`,mn.set(x.replace(gn,""),v.join(S,I));break}}}}}}return d==null?null:{sourceText:d,sourcePath:x}}function Le(a=[]){do{let l=g.nextFile(D);if(l==null)break;a.push(l)}while(!0);return a}async function Jn(){let a;for(;(a=Le()).length;){let d=[];for(let x of a){let A=g.getDependee(D,x);d.push(Oe(x,A))}d=await Promise.all(d);for(let x=0,A=a.length;x<A;++x){let y=a[x],C=d[x],I=n.begin();n.parseCount++,C?g.parse(D,C.sourceText,C.sourcePath,!1):g.parse(D,null,y+_,!1),n.parseTime+=n.end(I)}}let l=Tn(D,b,r.disableWarning,t.reportDiagnostic,X.enabled);if(l){let d=Error(`${l} parse error(s)`);return d.stack=d.message,z(d)}}{let a=String(r.runtime),l=`rt/index-${a}`,d=G[l];if(d==null){if(l=a,d=await c(l+_,B),d==null)return z(Error(`Runtime '${v.resolve(B,l+_)}' is not found.`))}else l=`~lib/${l}`;let x=n.begin();n.parseCount++,g.parse(D,d,l+_,!0),n.parseTime+=n.end(x)}for(let a=0,l=e.length;a<l;++a){let d=String(e[a]),x=v.isAbsolute(d)?v.relative(B,d):v.normalize(d);x=x.replace(/\\/g,"/").replace(gn,"").replace(/\/$/,"");let A=await c(x+_,B);if(A==null){let C=`${x}/index${_}`;A=await c(C,B),A!=null?x=C:x+=_}else x+=_;let y=n.begin();n.parseCount++,g.parse(D,A,x,!0),n.parseTime+=n.end(y)}{let a=await Jn();if(a)return a}{let a=await Dn("afterParse",D.parser);if(a)return z(a)}{let a=await Jn();if(a)return a}{let a=n.begin();n.initializeCount++;try{g.initializeProgram(D)}catch(l){L("initialize",l)}n.initializeTime+=n.end(a)}{let a=await Dn("afterInitialize",D);if(a)return z(a)}{let a=n.begin();n.compileCount++;try{H=g.compile(D)}catch(l){L("compile",l)}n.compileTime+=n.end(a)}k=pn.wrapModule(typeof H=="number"||H instanceof Number?g.getBinaryenModuleRef(H):H.ref);let ln=Tn(D,b,r.disableWarning,t.reportDiagnostic,X.enabled);if(ln){let a=Error(`${ln} compile error(s)`);return a.stack=a.message,z(a)}{let a=await Dn("afterCompile",k);if(a)return z(a)}if(ln=Tn(D,b,r.disableWarning,t.reportDiagnostic,X.enabled),ln){let a=Error(`${ln} afterCompile error(s)`);return a.stack=a.message,z(a)}if(!r.noValidate){let a=n.begin();n.validateCount++;let l=g.validate(H);if(n.validateTime+=n.end(a),!l)return z(Error("validate error"))}if(r.trapMode==="clamp"||r.trapMode==="js"){let a=n.begin();try{k.runPasses([`trap-mode-${r.trapMode}`])}catch(l){L("runPasses",l)}n.compileTime+=n.end(a)}else if(r.trapMode!=="allow")return z(Error("Unsupported trap mode"));let Qn=r.debug,ke=r.converge,ne=r.importMemory?r.zeroFilledMemory:!1,bn=[];r.runPasses&&(typeof r.runPasses=="string"&&(r.runPasses=r.runPasses.split(",")),r.runPasses.length&&r.runPasses.forEach(a=>{bn.includes(a=a.trim())||bn.push(a)}));{let a=n.begin();try{n.optimizeCount++,g.optimize(H,Z,J,Qn,ne)}catch(l){L("optimize",l)}try{k.runPasses(bn)}catch(l){L("runPasses",l)}if(ke){let l;try{let d=n.begin();n.emitCount++,l=k.emitBinary(),n.emitTime+=n.end(d)}catch(d){L("emitBinary (converge)",d)}do{try{n.optimizeCount++,g.optimize(H,Z,J,Qn,ne)}catch(x){L("optimize (converge)",x)}try{k.runPasses(bn)}catch(x){L("runPasses (converge)",x)}let d;try{let x=n.begin();n.emitCount++,d=k.emitBinary(),n.emitTime+=n.end(x)}catch(x){L("emitBinary (converge)",x)}if(d.length>=l.length){d.length>l.length&&b.write(`Last converge was suboptimal.${E}`);break}l=d}while(!0)}n.optimizeTime+=n.end(a)}let on=[];if(!r.noEmit){if(r.binaryFile)return z(Error("Usage of the --binaryFile compiler option is no longer supported. Use --outFile instead."));let a=r.bindings||[],l=!1,d=r.outFile!=null,x=r.textFile!=null,A=d||x,y=d&&r.outFile.length>0||x&&r.textFile.length>0,C=y?(r.outFile||r.textFile).replace(/\.\w+$/,""):null,I=y?v.basename(C):"output";if(g.setBasenameHint(T,I),r.outFile!=null){let U=r.sourceMap!=null?r.sourceMap.length?r.sourceMap:`./${I}.wasm.map`:null,w=n.begin();n.emitCount++;let S;try{S=k.emitBinary(U)}catch(O){L("emitBinary",O)}if(n.emitTime+=n.end(w),r.outFile.length?on.push(h(r.outFile,S.binary,B)):(l=!0,Fn(S.binary)),S.sourceMap!="")if(r.outFile.length){let O=JSON.parse(S.sourceMap);O.sourceRoot=`./${I}`;let un=[];for(let vn=0,Re=O.sources.length;vn<Re;++vn){let re=O.sources[vn],oe=g.getSource(D,re.replace(gn,""));if(oe==null)return z(Error(`Source of file '${re}' not found.`));un[vn]=oe}O.sourcesContent=un,on.push(h(v.join(v.dirname(r.outFile),v.basename(U)).replace(/^\.\//,""),JSON.stringify(O),B))}else b.write(`Skipped source map (no output path)${E}`)}if(r.textFile!=null||!A){let U=n.begin();n.emitCount++;let w;try{pn.setOptimizeStackIR(!0),w=r.textFile?.endsWith(".wast")?k.emitText():k.emitStackIR()}catch(S){L("emitText",S)}n.emitTime+=n.end(U),r.textFile!=null&&r.textFile.length?on.push(h(r.textFile,w,B)):l||Fn(w)}let q=a.includes("esm"),yn=!q&&a.includes("raw");if(q||yn)if(C){let U=n.begin();n.emitCount++;let w;try{w=g.buildTSD(D,q)}catch(S){L("buildTSD",S)}n.emitTime+=n.end(U),on.push(h(C+".d.ts",w,B))}else b.write(`Skipped TypeScript binding (no output path)${E}`);if(q||yn)if(C){let U=n.begin();n.emitCount++;let w;try{w=g.buildJS(D,q)}catch(S){L("buildJS",S)}n.emitTime+=n.end(U),on.push(h(C+".js",w,B))}else b.write(`Skipped JavaScript binding (no output path)${E}`)}try{await Promise.all(on)}catch(a){return z(a)}return n.total=n.end(i),r.stats&&b.write(n.toString()),z(null);async function ee(a,l){let d=v.resolve(l,a);try{return n.readCount++,await j.promises.readFile(d,"utf8")}catch{return null}}async function te(a,l,d){try{n.writeCount++;let x=v.resolve(d,v.dirname(a)),A=v.join(x,v.basename(a));return await j.promises.mkdir(x,{recursive:!0}),await j.promises.writeFile(A,l),!0}catch{return!1}}async function ie(a,l){try{return n.readCount++,(await j.promises.readdir(v.join(l,a))).filter(d=>Tt.test(d))}catch{return null}}function Fn(a){Fn.used||(Fn.used=!0,n.writeCount++),p.write(a)}function L(a,l){let d=zn.red("\u258C ");console.error([E,d,"Whoops, the AssemblyScript compiler has crashed during ",a," :-(",E,d,E,(typeof l.stack=="string"?[d,"Here is the stack trace hinting at the problem, perhaps it's useful?",E,d,E,l.stack.replace(/^/mg,d),E]:[d,"There is no stack trace. Perhaps a Binaryen exception above / in console?",E,d,E,d,"> "+l.stack,E]).join(""),d,E,d,"If you see where the error is, feel free to send us a pull request. If not,",E,d,"please let us know: https://github.com/AssemblyScript/assemblyscript/issues",E,d,E,d,"Thank you!",E].join("")),M.exit(1)}}function Gn(e){return Object.prototype.toString.call(e)==="[object Object]"}async function Ce(e,t,n){let i=await n(e,t),s=v.join(t,e);if(!i)return null;let o;try{o=JSON.parse(i)}catch(u){throw new Error(`Asconfig is not valid json: ${s}`,{cause:u})}if(o.options&&!Gn(o.options))throw new Error(`Asconfig.options is not an object: ${s}`);if(o.include&&!Array.isArray(o.include))throw new Error(`Asconfig.include is not an array: ${s}`);if(o.targets){if(!Gn(o.targets))throw new Error(`Asconfig.targets is not an object: ${s}`);let u=Object.keys(o.targets);for(let f=0;f<u.length;f++){let p=u[f];if(!Gn(o.targets[p]))throw new Error(`Asconfig.targets.${p} is not an object: ${s}`)}}if(o.extends&&typeof o.extends!="string")throw new Error(`Asconfig.extends is not a string: ${s}`);return o}function Tn(e,t,n,i,s){typeof s>"u"&&t&&(s=t.isTTY);let o=0;do{let p=g.nextDiagnostic(e);if(!p)break;if(t){let b=c=>{if(n==null)return!1;if(!n.length)return!0;let h=g.getDiagnosticCode(c);return n.includes(h)};(g.isError(p)||!b(p))&&t.write(g.formatDiagnostic(p,s,!0)+E+E)}if(i){let b=function(h){return h&&{start:g.getRangeStart(h),end:g.getRangeEnd(h),source:c(g.getRangeSource(h))}||null},c=function(h){return h&&{normalizedPath:g.getSourceNormalizedPath(h)}||null};var u=b,f=c;i({message:g.getDiagnosticMessage(p),code:g.getDiagnosticCode(p),category:g.getDiagnosticCategory(p),range:b(g.getDiagnosticRange(p)),relatedRange:b(g.getDiagnosticRelatedRange(p))})}g.isError(p)&&++o}while(!0);return o}var Cn=class{readCount=0;writeCount=0;parseTime=0;parseCount=0;initializeTime=0;initializeCount=0;compileTime=0;compileCount=0;emitTime=0;emitCount=0;validateTime=0;validateCount=0;optimizeTime=0;optimizeCount=0;transformTime=0;transformCount=0;begin(){return M.hrtime()}end(t){let n=M.hrtime(t);return n[0]*1e9+n[1]}toString(){let t=m=>m?`${(m/1e6).toFixed(3)} ms`:"n/a",n=Object.keys(this).filter(m=>m.endsWith("Time")).map(m=>m.substring(0,m.length-4)),i=n.map(m=>t(this[`${m}Time`])),s=n.map(m=>this[`${m}Count`].toString()),o=n.reduce((m,r)=>Math.max(r.length,m),0),u=i.reduce((m,r)=>Math.max(r.length,m),0),f=s.reduce((m,r)=>Math.max(r.length,m),0),p=o+u+f+6,b=[];b.push(`\u256D\u2500${"\u2500".repeat(p)}\u2500\u256E${E}`);let c="Stats";b.push(`\u2502 ${c}${" ".repeat(p-c.length)} \u2502${E}`),b.push(`\u255E\u2550${"\u2550".repeat(o)}\u2550\u2564\u2550${"\u2550".repeat(u)}\u2550\u2564\u2550${"\u2550".repeat(f)}\u2550\u2561${E}`);for(let m=0,r=n.length;m<r;++m)b.push(`\u2502 ${n[m].padEnd(o)} \u2502 ${i[m].padStart(u)} \u2502 ${s[m].padStart(f)} \u2502${E}`);b.push(`\u251C\u2500${"\u2500".repeat(o)}\u2500\u2534\u2500${"\u2500".repeat(u)}\u2500\u2534\u2500${"\u2500".repeat(f)}\u2500\u2524${E}`);let h=`Took ${t(this.total)}`;b.push(`\u2502 ${h}${" ".repeat(p-h.length)} \u2502${E}`);let F=`${this.readCount} reads, ${this.writeCount} writes`;return b.push(`\u2502 ${F}${" ".repeat(p-F.length)} \u2502${E}`),b.push(`\u2570\u2500${"\u2500".repeat(p)}\u2500\u256F${E}`),b.join("")}},ze=typeof global<"u"&&global.Buffer?global.Buffer.allocUnsafe||(e=>new global.Buffer(e)):e=>new Uint8Array(e);function Hn(e){let t=[];return t.write=function(n){if(e&&e(n),typeof n=="string"){let i=ze(_n.length(n));_n.write(n,i,0),n=i}this.push(n)},t.reset=function(){t.length=0},t.toBuffer=function(){let n=0,i=0,s=this.length;for(;i<s;)n+=this[i++].length;let o=ze(n);for(n=i=0;i<s;)o.set(this[i],n),n+=this[i].length,++i;return o},t.toString=function(){let n=this.toBuffer();return _n.read(n,0,n.length)},t}var Dt={alwaysStrict:!0,strictNullChecks:!0,noImplicitAny:!0,noImplicitReturns:!0,noImplicitThis:!0,noEmitOnError:!0,noPropertyAccessFromIndexSignature:!0,experimentalDecorators:!0,target:"esnext",noLib:!0,types:[],allowJs:!1};export{Cn as Stats,Tn as checkDiagnostics,St as compileString,qn as configToArguments,Hn as createMemoryStream,Wn as default,Be as defaultOptimizeLevel,Se as defaultShrinkLevel,Bt as definitionFiles,G as libraryFiles,P as libraryPrefix,De as main,zt as options,Dt as tscOptions,Xn as version};
//# sourceMappingURL=asc.js.map
