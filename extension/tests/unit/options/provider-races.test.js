// @ts-check

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { ProvidersSection } from '/options/sections/providers.js';

const deferred = () => {
  /** @type {(value: any) => void} */ let resolve = () => {};
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve: /** @type {(value: any) => void} */ (resolve) };
};
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  m.redraw.sync?.();
};

describe('provider settings request ordering', () => {
  it('shows Retry when the initial provider status request fails', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let attempts = 0;
    const state = {
      providers: { current: 'anthropic', hasKey: false, model: 'claude' },
      settings: { providerName: '', providerModel: '' },
      capabilities: { localWebGpuHost: { status: 'unsupported' } },
    };
    const send = async (/** @type {any} */ msg) => {
      if (msg.type === 'provider/status') {
        attempts += 1;
        if (attempts === 1) return { ok: false, error: 'worker-unavailable' };
        return {
          ok: true,
          providers: [{
            name: 'anthropic', label: 'Anthropic', defaultModel: 'claude',
            hasKey: false, keyless: false,
          }],
        };
      }
      if (msg.type === 'models/options') return { ok: true, options: [] };
      return { ok: false };
    };
    m.mount(root, { view: () => m(ProvidersSection, { state, send }) });
    try {
      await settle();
      expect(root.textContent).toContain('could not refresh provider status');
      expect(root.textContent?.includes('worker-unavailable')).toBe(false);
      const retry = [...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Retry provider status');
      if (!(retry instanceof HTMLButtonElement)) throw new Error('provider status retry missing');
      retry.click();
      await settle();
      expect(attempts).toBe(2);
      expect(root.textContent?.includes('could not refresh provider status')).toBe(false);
      expect(root.textContent).toContain('No key set');
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  // why both directions: `localWebGpuHost` is available on EVERY Chrome (it only
  // reports that an offscreen document can be created), so gating selection on it
  // would name a default that ensureActiveProvider then refuses to bind. Settings
  // would read "Local WebGPU" while the composer still demanded an Anthropic key.
  // Residency, reported through models/options, is the signal that matters.
  /** @param {any[]} options models/options reply for a host-available Chrome */
  const mountLocalWebGpu = (options) => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const state = {
      providers: { current: 'anthropic', hasKey: false, model: 'claude-sonnet' },
      settings: { providerName: '', providerModel: '' },
      capabilities: { localWebGpuHost: { status: 'available' } },
    };
    const send = async (/** @type {{ type: string }} */ msg) => {
      if (msg.type === 'provider/status') return {
        ok: true,
        providers: [
          { name: 'anthropic', label: 'Anthropic', defaultModel: 'claude-sonnet', hasKey: false, keyless: false },
          { name: 'local-webgpu', label: 'Local WebGPU', defaultModel: 'gemma-4-e2b', hasKey: true, keyless: true },
        ],
      };
      if (msg.type === 'local-model/status') return { ok: true, model: 'gemma-4-e2b', downloaded: options.length > 0 };
      if (msg.type === 'local-model/catalog') return { ok: true, models: [{ model: 'gemma-4-e2b', downloaded: options.length > 0, supported: true }] };
      if (msg.type === 'models/options') return { ok: true, options };
      return { ok: false };
    };
    m.mount(root, { view: () => m(ProvidersSection, { state, send }) });
    return root;
  };

  it('does not select Local WebGPU while the on-device model is not resident', async () => {
    const root = mountLocalWebGpu([]);
    try {
      await settle();
      await settle();
      // The host exists but the model was never downloaded, so nothing is usable:
      // the honest empty state, not a default the first turn could not serve.
      expect(root.querySelector('#provider')).toBe(null);
      expect(root.textContent).toContain('Nothing is assumed');
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('auto-selects Local WebGPU once the on-device model is resident', async () => {
    const root = mountLocalWebGpu([
      { provider: 'local-webgpu', model: 'gemma-4-e2b', label: 'gemma-4-e2b' },
    ]);
    try {
      await settle();
      await settle();
      const providerSelect = root.querySelector('#provider');
      if (!(providerSelect instanceof HTMLSelectElement)) throw new Error('provider select missing');
      expect(providerSelect.value).toBe('local-webgpu');
      expect(root.textContent).toContain('Default model for new chats');
      expect(root.textContent?.includes('Nothing is assumed')).toBe(false);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('keeps a configured Ollama default editable when its daemon is unreachable', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const state = {
      providers: { current: 'ollama', hasKey: true, model: 'qwen3:8b' },
      settings: { providerName: 'ollama', providerModel: '', ollamaHost: 'http://localhost:11434' },
      capabilities: { localWebGpuHost: { status: 'unsupported' } },
    };
    const probe = deferred();
    const send = async (/** @type {{ type: string, activate?: boolean }} */ msg) => {
      if (msg.type === 'provider/status') return {
        ok: true,
        providers: [{
          name: 'ollama', label: 'Ollama', defaultModel: 'qwen3:8b',
          hasKey: true, keyless: true, liveModels: true,
        }],
      };
      if (msg.type === 'provider/test') { expect(msg.activate).toBe(false); return probe.promise; }
      if (msg.type === 'models/options') return { ok: true, options: [] };
      return { ok: false };
    };
    m.mount(root, { view: () => m(ProvidersSection, { state, send }) });
    try {
      await settle();
      let providerSelect = root.querySelector('#provider');
      if (!(providerSelect instanceof HTMLSelectElement)) throw new Error('provider select missing');
      expect(providerSelect.value).toBe('ollama');
      expect(root.textContent).toContain('Checking…');
      expect(root.textContent?.includes('Nothing is assumed')).toBe(false);

      probe.resolve({ ok: false, error: 'unreachable' });
      await settle();
      providerSelect = root.querySelector('#provider');
      if (!(providerSelect instanceof HTMLSelectElement)) throw new Error('provider select missing after probe');
      expect(providerSelect.value).toBe('ollama');
      expect(root.textContent).toContain('Not reachable');
      expect(root.textContent?.includes('Nothing is assumed')).toBe(false);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('describes the blank web-actor model as local-first Automatic policy', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const state = {
      providers: { current: 'anthropic', hasKey: true, model: 'claude-sonnet', defaultRunnerModel: 'claude-haiku' },
      settings: { providerName: 'anthropic', providerModel: '', runnerModel: '' },
      capabilities: { localWebGpuHost: { status: 'available' } },
    };
    const send = async (/** @type {any} */ msg) => {
      if (msg.type === 'provider/status') return {
        ok: true,
        providers: [{
          name: 'anthropic', label: 'Anthropic', defaultModel: 'claude-sonnet',
          defaultRunnerModel: 'claude-haiku', hasKey: true, keyless: false,
        }],
      };
      if (msg.type === 'models/options') return { ok: true, options: [] };
      return { ok: false };
    };
    m.mount(root, { view: () => m(ProvidersSection, { state, send }) });
    try {
      await settle();
      const runner = root.querySelector('#runner-model');
      if (!(runner instanceof HTMLInputElement)) throw new Error('runner model input missing');
      expect(runner.placeholder).toBe('Automatic');
      expect(root.textContent).toContain('use Local WebGPU when its model is installed');
      expect(root.textContent).toContain('otherwise use claude-haiku on Anthropic');
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('keeps the new Ollama host models and status when old-host requests finish last', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const state = {
      providers: { current: 'ollama', hasKey: true, model: 'qwen3:8b' },
      settings: { providerName: 'ollama', providerModel: '', ollamaHost: 'http://a:11434' },
      capabilities: { localWebGpuHost: { status: 'unsupported' } },
    };
    const aModels = deferred();
    const bModels = deferred();
    const aProbe = deferred();
    const bProbe = deferred();
    /** @type {Array<{type: string, host: string}>} */
    const seen = [];
    const send = async (/** @type {any} */ msg) => {
      seen.push({ type: msg.type, host: state.settings.ollamaHost });
      if (msg.type === 'provider/status') return {
        ok: true,
        providers: [{
          name: 'ollama', label: 'Ollama', defaultModel: 'qwen3:8b',
          hasKey: true, keyless: true, liveModels: true,
        }],
      };
      if (msg.type === 'settings/update') {
        state.settings = { ...state.settings, ...msg.patch };
        return { ok: true, settings: state.settings };
      }
      if (msg.type === 'settings/reset') {
        state.settings = { ...state.settings, ollamaHost: '' };
        return { ok: true, settings: state.settings };
      }
      if (msg.type === 'models/options') {
        return state.settings.ollamaHost.includes('b:') ? bModels.promise : aModels.promise;
      }
      if (msg.type === 'provider/test') {
        return state.settings.ollamaHost.includes('b:') ? bProbe.promise : aProbe.promise;
      }
      return { ok: false };
    };
    m.mount(root, { view: () => m(ProvidersSection, { state, send }) });
    try {
      await settle();
      const hostInput = root.querySelector('#ollama-host');
      if (!(hostInput instanceof HTMLInputElement)) throw new Error('Ollama host input missing');
      hostInput.value = 'http://b:11434';
      hostInput.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();

      bModels.resolve({
        ok: true,
        options: [{ provider: 'ollama', model: 'b-model', label: 'B Model', value: 'ollama::b-model' }],
      });
      bProbe.resolve({ ok: true, reachable: true, models: 1 });
      await settle();
      await settle();

      aModels.resolve({
        ok: true,
        options: [{ provider: 'ollama', model: 'a-model', label: 'A Model', value: 'ollama::a-model' }],
      });
      aProbe.resolve({ ok: false, error: 'unreachable' });
      await settle();

      expect(root.textContent).toContain('Connected');
      expect(root.textContent).toContain('B Model');
      expect(root.textContent?.includes('A Model')).toBe(false);
      expect(seen.some((call) => call.type === 'models/options' && call.host === 'http://b:11434')).toBe(true);
      expect(seen.some((call) => call.type === 'provider/test' && call.host === 'http://b:11434')).toBe(true);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('does not let an old explicit Ollama test overwrite the new host probe', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const state = {
      providers: { current: 'ollama', hasKey: true, model: 'qwen3:8b' },
      settings: { providerName: 'ollama', providerModel: '', ollamaHost: 'http://a:11434' },
      capabilities: { localWebGpuHost: { status: 'unsupported' } },
    };
    const oldExplicit = deferred();
    const newProbe = deferred();
    let aTests = 0;
    const send = async (/** @type {any} */ msg) => {
      if (msg.type === 'provider/status') return {
        ok: true,
        providers: [{ name: 'ollama', label: 'Ollama', defaultModel: 'qwen3:8b', hasKey: true, keyless: true, liveModels: true }],
      };
      if (msg.type === 'provider/test') {
        if (state.settings.ollamaHost.includes('b:')) return newProbe.promise;
        aTests += 1;
        return aTests === 1 ? { ok: true, reachable: true, models: 1 } : oldExplicit.promise;
      }
      if (msg.type === 'settings/update') {
        state.settings = { ...state.settings, ...msg.patch };
        return { ok: true, settings: state.settings };
      }
      if (msg.type === 'models/options') return { ok: true, options: [] };
      return { ok: false };
    };
    m.mount(root, { view: () => m(ProvidersSection, { state, send }) });
    try {
      await settle();
      await settle();
      const testButton = Array.from(root.querySelectorAll('button')).find((button) => button.textContent === 'Test');
      if (!(testButton instanceof HTMLButtonElement)) throw new Error('Test button missing');
      testButton.click();
      await settle();
      const hostInput = root.querySelector('#ollama-host');
      if (!(hostInput instanceof HTMLInputElement)) throw new Error('Ollama host input missing');
      hostInput.value = 'http://b:11434';
      hostInput.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      newProbe.resolve({ ok: true, reachable: true, models: 2 });
      await settle();
      oldExplicit.resolve({ ok: false, error: 'unreachable' });
      await settle();
      expect(root.textContent).toContain('Connected');
      expect(root.textContent?.includes('Couldn’t reach')).toBe(false);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('does not test the old Ollama host when blur and Test happen together', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const state = {
      providers: { current: 'ollama', hasKey: true, model: 'qwen3:8b' },
      settings: { providerName: 'ollama', providerModel: '', ollamaHost: 'http://a:11434' },
      capabilities: { localWebGpuHost: { status: 'unsupported' } },
    };
    const hostSave = deferred();
    /** @type {string[]} */
    const testedHosts = [];
    let initialProbeDone = false;
    const send = async (/** @type {any} */ msg) => {
      if (msg.type === 'provider/status') return {
        ok: true,
        providers: [{ name: 'ollama', label: 'Ollama', defaultModel: 'qwen3:8b', hasKey: true, keyless: true, liveModels: true }],
      };
      if (msg.type === 'provider/test') {
        testedHosts.push(state.settings.ollamaHost);
        initialProbeDone = true;
        return { ok: true, reachable: true, models: 1 };
      }
      if (msg.type === 'settings/update') {
        await hostSave.promise;
        state.settings = { ...state.settings, ...msg.patch };
        return { ok: true, settings: state.settings };
      }
      if (msg.type === 'models/options') return { ok: true, options: [] };
      return { ok: false };
    };
    m.mount(root, { view: () => m(ProvidersSection, { state, send }) });
    try {
      await settle();
      expect(initialProbeDone).toBe(true);
      testedHosts.length = 0;
      const hostInput = root.querySelector('#ollama-host');
      const testButton = Array.from(root.querySelectorAll('button')).find((button) => button.textContent === 'Test');
      if (!(hostInput instanceof HTMLInputElement) || !(testButton instanceof HTMLButtonElement)) {
        throw new Error('Ollama controls missing');
      }
      hostInput.value = 'http://b:11434';
      hostInput.dispatchEvent(new Event('change', { bubbles: true }));
      testButton.click();
      await settle();
      expect(testedHosts).toEqual([]);

      hostSave.resolve({});
      await settle();
      await settle();
      expect(testedHosts.length).toBeGreaterThan(0);
      expect(testedHosts.every((host) => host === 'http://b:11434')).toBe(true);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('does not let the mount provider status overwrite a post-save refresh', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const oldStatus = deferred();
    const freshStatus = deferred();
    let statusCalls = 0;
    const state = {
      providers: { current: 'anthropic', hasKey: false, model: 'claude' },
      settings: { providerName: 'anthropic', providerModel: '' },
      capabilities: { localWebGpuHost: { status: 'unsupported' } },
    };
    const send = async (/** @type {any} */ msg) => {
      if (msg.type === 'provider/status') return (++statusCalls === 1 ? oldStatus.promise : freshStatus.promise);
      if (msg.type === 'provider/setKey') return { ok: true };
      if (msg.type === 'provider/test') return { ok: true };
      if (msg.type === 'models/options') return { ok: true, options: [] };
      return { ok: false };
    };
    m.mount(root, { view: () => m(ProvidersSection, { state, send }) });
    try {
      await settle();
      const input = root.querySelector('.provider-card-form input');
      if (!(input instanceof HTMLInputElement)) throw new Error('key input missing');
      input.value = 'sk-ant-abcdefgh';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      root.querySelector('.provider-card-form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await settle();
      freshStatus.resolve({
        ok: true,
        providers: [{ name: 'anthropic', label: 'Anthropic', defaultModel: 'claude', hasKey: true, keyless: false }],
      });
      await settle();
      oldStatus.resolve({
        ok: true,
        providers: [{ name: 'anthropic', label: 'Anthropic', defaultModel: 'claude', hasKey: false, keyless: false }],
      });
      await settle();
      expect(root.textContent).toContain('Key saved');
      expect(root.textContent?.includes('No key set')).toBe(false);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('does not clear an unconfirmed key save from a causally stale status read', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let statusCalls = 0;
    /** @type {any[]} */ const saves = [];
    const state = {
      providers: { current: 'anthropic', hasKey: false, model: 'claude' },
      settings: { providerName: 'anthropic', providerModel: '' },
      capabilities: { localWebGpuHost: { status: 'unsupported' } },
    };
    const send = async (/** @type {any} */ msg) => {
      if (msg.type === 'provider/status') {
        statusCalls += 1;
        return { ok: true, providers: [{
          name: 'anthropic', label: 'Anthropic', defaultModel: 'claude',
          hasKey: saves.length > 1, keyless: false,
        }] };
      }
      if (msg.type === 'provider/setKey') {
        saves.push(msg);
        return saves.length === 1 ? { ok: false, outcomeKnown: false } : { ok: true };
      }
      if (msg.type === 'provider/test') return { ok: true };
      if (msg.type === 'models/options') return { ok: true, options: [] };
      return { ok: false };
    };
    m.mount(root, { view: () => m(ProvidersSection, { state, send }) });
    try {
      await settle();
      const input = root.querySelector('.provider-card-form input');
      if (!(input instanceof HTMLInputElement)) throw new Error('key input missing');
      input.value = 'sk-ant-abcdefgh';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      root.querySelector('.provider-card-form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await settle();
      expect(statusCalls).toBe(1);
      expect(root.textContent).toContain('could not confirm');
      expect(input.disabled).toBe(true);
      const finish = Array.from(root.querySelectorAll('button'))
        .find((button) => button.textContent === 'Finish the same save');
      if (!(finish instanceof HTMLButtonElement)) throw new Error('finish-save control missing');
      finish.click();
      await settle(); await settle();
      expect(saves.length).toBe(2);
      expect(saves[1]).toEqual(saves[0]);
      expect(statusCalls).toBe(2);
      expect(root.textContent).toContain('Key saved');
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  // why: the kernel admits one provider/test at a time (kernel-feature-policy
  // gives the route concurrent: 1) and refuses a second call with a retryable
  // feature-route-concurrency-exhausted. The stub models that gate, so the
  // post-save auto-test proves it does not race a keyless daemon re-probe.
  it('auto-tests a saved key without spending the test slot on a daemon re-probe', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const state = {
      providers: { current: 'anthropic', hasKey: false, model: 'claude' },
      settings: { providerName: '', providerModel: '' },
      capabilities: { localWebGpuHost: { status: 'unsupported' } },
    };
    let hasKey = false;
    let probes = 0;
    let inFlight = 0;
    /** @type {string[]} */ const tested = [];
    const send = async (/** @type {any} */ msg) => {
      if (msg.type === 'provider/status') return { ok: true, providers: [
        { name: 'anthropic', label: 'Anthropic', defaultModel: 'claude', hasKey, keyless: false },
        { name: 'ollama', label: 'Ollama', defaultModel: 'qwen3:8b', hasKey: true, keyless: true, liveModels: true },
      ] };
      if (msg.type === 'provider/setKey') { hasKey = true; return { ok: true }; }
      if (msg.type === 'provider/test') {
        if (inFlight > 0) {
          return { ok: false, code: 'feature-route-concurrency-exhausted', retryable: true, outcomeKnown: true };
        }
        tested.push(msg.provider);
        if (msg.provider !== 'ollama') return { ok: true };
        // The mount probe answers at once; a later re-probe stays in flight.
        probes += 1;
        if (probes === 1) return { ok: false, error: 'unreachable' };
        inFlight += 1;
        return new Promise(() => {});
      }
      if (msg.type === 'models/options') return { ok: true, options: [] };
      return { ok: false };
    };
    m.mount(root, { view: () => m(ProvidersSection, { state, send }) });
    try {
      await settle();
      expect(tested).toEqual(['ollama']);
      const input = root.querySelector('.provider-card-form input');
      if (!(input instanceof HTMLInputElement)) throw new Error('key input missing');
      input.value = 'sk-ant-abcdefgh';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      root.querySelector('.provider-card-form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await settle(); await settle();
      expect(tested).toContain('anthropic');
      expect(root.textContent).toContain('the key works');
      expect(root.textContent?.includes('reach the provider')).toBe(false);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('names a busy provider test slot instead of a reachability failure', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const state = {
      providers: { current: 'anthropic', hasKey: true, model: 'claude' },
      settings: { providerName: 'anthropic', providerModel: '' },
      capabilities: { localWebGpuHost: { status: 'unsupported' } },
    };
    const send = async (/** @type {any} */ msg) => {
      if (msg.type === 'provider/status') return { ok: true, providers: [
        { name: 'anthropic', label: 'Anthropic', defaultModel: 'claude', hasKey: true, keyless: false },
      ] };
      if (msg.type === 'provider/test') {
        return { ok: false, code: 'feature-route-concurrency-exhausted', retryable: true, outcomeKnown: true };
      }
      if (msg.type === 'models/options') return { ok: true, options: [] };
      return { ok: false };
    };
    m.mount(root, { view: () => m(ProvidersSection, { state, send }) });
    try {
      await settle();
      const testButton = Array.from(root.querySelectorAll('button')).find((button) => button.textContent === 'Test');
      if (!(testButton instanceof HTMLButtonElement)) throw new Error('Test button missing');
      testButton.click();
      await settle();
      expect(root.textContent).toContain('Another provider check is running. Test again in a moment.');
      expect(root.textContent?.includes('reach the provider')).toBe(false);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  // why: the test route reports an answered request as http-<status>. Only a
  // transport failure may read as "could not reach"; an answer names its status.
  it('names the provider answer status instead of a reachability failure', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const state = {
      providers: { current: 'anthropic', hasKey: true, model: 'claude' },
      settings: { providerName: 'anthropic', providerModel: '' },
      capabilities: { localWebGpuHost: { status: 'unsupported' } },
    };
    let error = '';
    const send = async (/** @type {any} */ msg) => {
      if (msg.type === 'provider/status') return { ok: true, providers: [
        { name: 'anthropic', label: 'Anthropic', defaultModel: 'claude', hasKey: true, keyless: false },
      ] };
      if (msg.type === 'provider/test') return { ok: false, error };
      if (msg.type === 'models/options') return { ok: true, options: [] };
      return { ok: false };
    };
    const clickTest = async () => {
      const testButton = Array.from(root.querySelectorAll('button')).find((button) => button.textContent === 'Test');
      if (!(testButton instanceof HTMLButtonElement)) throw new Error(`Test button missing before ${error}`);
      testButton.click();
      await settle();
    };
    m.mount(root, { view: () => m(ProvidersSection, { state, send }) });
    try {
      await settle();
      const answers = [
        ['http-429', 'The provider refused the request (429). Check your plan, credit or rate limit, then test again.'],
        ['http-402', 'The provider refused the request (402).'],
        ['http-403', 'The provider refused this key (403). Check its permissions and model access.'],
        ['http-529', 'The provider is having problems (529). Try again later.'],
        ['http-400', 'The provider rejected the test request (400). Check your account on the provider’s site, then test again.'],
      ];
      for (const [code, text] of answers) {
        error = code;
        await clickTest();
        expect(root.textContent).toContain(text);
        expect(root.textContent?.includes('reach the provider')).toBe(false);
      }
      error = 'model-egress-connect-failed';
      await clickTest();
      expect(root.textContent).toContain('Couldn’t reach the provider.');
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  // why: OpenRouter's catalog is public (200 for any key), so only the one-token
  // provider/test can tell a rejected key apart from a working one.
  it('verifies an OpenRouter key with the provider test after a save', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const state = {
      providers: { current: 'openrouter', hasKey: false, model: 'openrouter/auto' },
      settings: { providerName: '', providerModel: '', openrouterModels: [] },
      capabilities: { localWebGpuHost: { status: 'unsupported' } },
    };
    let hasKey = false;
    /** @type {string[]} */ const tested = [];
    const send = async (/** @type {any} */ msg) => {
      if (msg.type === 'provider/status') return { ok: true, providers: [
        { name: 'openrouter', label: 'OpenRouter', defaultModel: 'openrouter/auto', hasKey, keyless: false },
      ] };
      if (msg.type === 'provider/setKey') { hasKey = true; return { ok: true }; }
      if (msg.type === 'provider/test') { tested.push(msg.provider); return { ok: false, error: 'invalid-key' }; }
      if (msg.type === 'openrouter/models') {
        return { ok: true, models: [{ model: 'z-ai/glm-5.1', label: 'GLM 5.1' }], popular: ['z-ai/glm-5.1'] };
      }
      if (msg.type === 'models/options') return { ok: true, options: [] };
      return { ok: false };
    };
    m.mount(root, { view: () => m(ProvidersSection, { state, send }) });
    try {
      await settle();
      const input = root.querySelector('.provider-card-form input');
      if (!(input instanceof HTMLInputElement)) throw new Error('key input missing');
      input.value = 'sk-or-v1-abcdefgh';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      root.querySelector('.provider-card-form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await settle(); await settle();
      expect(tested).toEqual(['openrouter']);
      expect(root.textContent).toContain('Provider rejected the key (401). Double-check it.');
      expect(root.textContent?.includes('Verifying key')).toBe(false);
      expect(root.textContent).toContain('available on OpenRouter');
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });
});
