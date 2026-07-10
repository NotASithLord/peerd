// web/gemma-worker.js — the whole transformers.js + ORT WebGPU engine, off the
// page main thread. This is a module worker; web/gemma.js drives it by postMessage.
//
// why a worker (not the main thread): ORT-Web's WebGPU EP creates its session via
// JSEP + Emscripten asyncify. On the page main thread, a big external-data q4f16
// model + multi-threaded WASM session-create deadlocks during compile — silently,
// no error (ORT #26858), and Apple Silicon/Metal turns the latent threading race
// into a hard hang (ORT #27592). The official transformers.js demo avoids all of it
// by running the engine in a dedicated worker. The WebGPU proxy can't help us off
// the main thread either (a GPU buffer isn't transferable), so the engine lives here.
//
// Two more things the demo does that we copy: force numThreads=1 (kills the
// external-data session-create hang outright) and a 1-token warm-up generate right
// after load so shader compilation happens once during "loading", not on the user's
// first real prompt.

const GIB = 2 ** 30;

// The host (gemma.js initGemma) always merges its DEFAULT_CFG before posting —
// the cfg that arrives here is complete and authoritative.
let tx = null, tokenizer = null, model = null, ready = false, loading = false, modelCfg = null;
const post = (msg) => self.postMessage(msg);

const loadTransformers = async () => {
  if (tx) return tx;
  tx = await import('/vendor/transformers/transformers.js');
  tx.env.backends.onnx.wasm.wasmPaths = '/vendor/transformers/';
  // why 1: external-data weights + numThreads>1 hangs InferenceSession.create()
  // (ORT #26858); WebGPU does the heavy math on the GPU, so WASM threads cost little.
  tx.env.backends.onnx.wasm.numThreads = 1;
  tx.env.allowRemoteModels = true;
  tx.env.allowLocalModels = false;
  return tx;
};

// Aggregate per-file byte progress into a monotonic `overall` %, so the host's bar
// never jumps backward as transformers.js fetches the many weight shards.
const fileBytes = new Map();
const withOverall = (p) => {
  if (p && p.file) {
    if (p.status === 'done') {
      const prev = fileBytes.get(p.file);
      const total = typeof p.total === 'number' ? p.total : prev?.total;
      if (typeof total === 'number' && total > 0) fileBytes.set(p.file, { loaded: total, total });
    } else if (typeof p.total === 'number' && p.total > 0) {
      fileBytes.set(p.file, { loaded: typeof p.loaded === 'number' ? p.loaded : 0, total: p.total });
    }
  }
  if (fileBytes.size === 0) return p;
  let overallLoaded = 0, overallTotal = 0;
  for (const { loaded, total } of fileBytes.values()) { overallLoaded += loaded; overallTotal += total; }
  const overall = overallTotal > 0 ? Math.min(100, (overallLoaded / overallTotal) * 100) : undefined;
  return { ...p, overall, overallLoaded, overallTotal };
};

const load = async (cfg) => {
  if (ready) { post({ type: 'ready' }); return; }
  if (loading) return;
  loading = true;
  modelCfg = cfg;
  const { id, modelClass, dtype, minBindingGiB } = modelCfg;
  try {
    post({ type: 'phase', phase: 'probing WebGPU' });
    if (!navigator.gpu) throw new Error('WebGPU is unavailable in this browser.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter (GPU blocked or unavailable).');
    if (!adapter.features.has('shader-f16')) throw new Error('GPU lacks shader-f16 (needed for q4f16).');
    // Gate on the storage-buffer binding BEFORE fetching GB of weights: the
    // model's largest tensor must fit one binding or ORT OOMs at session-create.
    const bindingGiB = (Number(adapter.limits?.maxStorageBufferBindingSize) || 0) / GIB;
    if (minBindingGiB && bindingGiB && bindingGiB < minBindingGiB) {
      throw new Error(`${modelCfg.label} needs a ~${minBindingGiB} GB GPU storage-buffer binding; this GPU caps a binding at ${bindingGiB.toFixed(1)} GB.`);
    }

    post({ type: 'phase', phase: 'loading transformers.js (vendored)' });
    const t = await loadTransformers();
    const onProg = (p) => post({ type: 'progress', p: withOverall(p) });
    const CausalLM = t[modelClass] || t.AutoModelForCausalLM;

    post({ type: 'phase', phase: 'loading tokenizer + config' });
    tokenizer = await t.AutoTokenizer.from_pretrained(id, { progress_callback: onProg });

    post({ type: 'phase', phase: 'streaming model weights (first run downloads, then cached)' });
    model = await CausalLM.from_pretrained(id, { dtype, device: 'webgpu', progress_callback: onProg });

    // warm-up: compile shaders once here (off the user's first prompt). This is the
    // step that hangs on the main thread; in the worker it completes normally.
    post({ type: 'phase', phase: 'compiling' });
    const warm = await tokenizer('a');
    await model.generate({ ...warm, max_new_tokens: 1 });

    ready = true;
    post({ type: 'ready' });
  } catch (e) {
    tokenizer = null; model = null;
    post({ type: 'error', message: e?.message || String(e) });
  } finally {
    loading = false;
  }
};

// Content blocks render to text exactly as the extension does. System handling is
// model-aware: Gemma has NO system role (fold into the first user turn); Qwen and
// most others take a real system message — driven by modelCfg.foldSystemIntoUser.
const toChat = (messages, system) => {
  const flat = (content) => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((b) => {
      if (b?.type === 'text') return b.text ?? '';
      if (b?.type === 'tool_use') return `<tool_call>${JSON.stringify({ name: b.name, arguments: b.input })}</tool_call>`;
      if (b?.type === 'tool_result') return `<tool_result>${typeof b.content === 'string' ? b.content : JSON.stringify(b.content)}</tool_result>`;
      return '';
    }).join('\n');
  };
  const out = messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: flat(m.content) }));
  if (!system) return out;
  if (modelCfg.foldSystemIntoUser) {
    if (out.length && out[0].role === 'user') out[0].content = `${system}\n\n${out[0].content}`;
    else out.unshift({ role: 'user', content: system });
  } else {
    out.unshift({ role: 'system', content: system });
  }
  return out;
};

const generate = async (req, id) => {
  try {
    if (!model || !tokenizer) throw new Error('Gemma not loaded');
    const messages = toChat(req.messages ?? [], req.system ?? '');
    const prompt = tokenizer.apply_chat_template(messages, {
      add_generation_prompt: true, tokenize: false,
      tools: req.tools && req.tools.length ? req.tools : undefined,
    });
    const inputs = await tokenizer(prompt);
    const streamer = new tx.TextStreamer(tokenizer, {
      skip_prompt: true, skip_special_tokens: true,
      callback_function: (text) => { if (text) post({ type: 'token', id, text }); },
    });
    await model.generate({ ...inputs, max_new_tokens: req.maxTokens ?? 512, do_sample: false, streamer });
    post({ type: 'genDone', id });
  } catch (e) {
    post({ type: 'genError', id, message: e?.message || String(e) });
  }
};

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'load') load(m.cfg);
  else if (m.type === 'generate') generate(m.req, m.id);
};
