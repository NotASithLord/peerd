// @ts-check
// Provider registry.
//
// In-memory table of provider adapters: Anthropic + OpenRouter (cloud,
// BYOK) and Ollama (local, keyless). OpenAI may land later on this same
// surface.
//
// The registry is intentionally a tiny data structure with side-effecting
// helpers. The shipped adapters pre-register at module load; future
// configuration UIs may add or hide providers per profile.

import { anthropicAdapter } from './adapters/anthropic.js';
import { openrouterAdapter } from './adapters/openrouter.js';
import { ollamaAdapter } from './adapters/ollama.js';
import { localWebgpuAdapter } from './adapters/local-webgpu.js';
import { asWindow } from './model-window.js';
import { UnknownProviderError } from './errors.js';

/** @typedef {import('./types.js').InternalMessage} InternalMessage */
/** @typedef {import('./format/from-anthropic.js').ProviderEvent} ProviderEvent */

/**
 * The arguments a provider's streaming `call` receives. The superset across
 * adapters — local adapters ignore `getSecret`/`reasoning`, the cloud ones
 * use them; the registry's callModel just threads the caller's args through.
 * @typedef {Object} CallArgs
 * @property {string} provider
 * @property {readonly InternalMessage[]} messages
 * @property {string} system
 * @property {string} [model]
 * @property {number} [maxTokens]
 * @property {ReadonlyArray<{ name: string, description: string, schema: object }>} [tools]
 * @property {{ enabled?: boolean, budgetTokens?: number, effort?: string }} [reasoning]
 * @property {AbortSignal} [signal]
 * @property {(name: string) => Promise<string | null>} [getSecret]
 * @property {(resource: string | URL | Request, init?: RequestInit) => Promise<Response>} [safeFetch]
 */

/**
 * The provider-descriptor shape the registry stores. Common across every
 * adapter; the optional members mark capabilities only some adapters carry
 * (keyless local inference, a live model inventory, a live context window).
 * @typedef {Object} Adapter
 * @property {string} name
 * @property {string} label
 * @property {string | null} [endpoint]
 * @property {string} defaultModel
 * @property {string} [defaultRunnerModel]
 * @property {string | null} [vaultSecretName]
 * @property {boolean} [keyless]
 * @property {(args: any) => AsyncGenerator<ProviderEvent>} call
 * @property {(deps: any) => Promise<Array<{ model: string, label: string }>>} [listModels]
 * @property {(args: any) => Promise<number | null>} [contextWindow]
 */

/** @type {Map<string, Adapter>} */
const adapters = new Map();

// Pre-registration. Done at module load so the SW doesn't need to know
// about specific adapter modules — it just imports peerd-provider and
// the registry is ready. Anthropic + OpenRouter ship in the box
// (OpenRouter is an OpenAI-compatible gateway to many vendors' models);
// Ollama is the keyless local-inference path.
adapters.set(anthropicAdapter.name, anthropicAdapter);
adapters.set(openrouterAdapter.name, openrouterAdapter);
adapters.set(ollamaAdapter.name, ollamaAdapter);
// local-webgpu: the on-device runner endpoint (FEATURE-LOCAL-WEBGPU B). Keyless;
// the call path errors cleanly until the offscreen engine is loaded + wired
// (setLocalGenerate). The ~25MB engine's store-packaging gate is a §3.4 concern,
// like the dweb prune.
adapters.set(localWebgpuAdapter.name, localWebgpuAdapter);

/**
 * Register an adapter. Returns true if newly added, false if the name
 * was already present (existing entry is kept; caller should `unregister`
 * first if they want to replace).
 * @param {Adapter} adapter
 * @returns {boolean}
 */
export const registerProvider = (adapter) => {
  if (adapters.has(adapter.name)) return false;
  adapters.set(adapter.name, adapter);
  return true;
};

/** @param {string} name */
export const unregisterProvider = (name) => adapters.delete(name);

/** @param {string} name */
export const getProvider = (name) => adapters.get(name) ?? null;

export const listProviders = () =>
  [...adapters.values()].map((a) => ({
    name: a.name,
    label: a.label,
    defaultModel: a.defaultModel,
    // why: the per-provider fast default for the page-reader runner
    // (do/get/check). resolveRunnerModel uses it when the user hasn't pinned
    // an override; the Settings placeholder shows it so "blank" is honest
    // about what actually runs. Falls back to defaultModel if an adapter
    // somehow omits it (every shipped adapter sets one).
    defaultRunnerModel: a.defaultRunnerModel ?? a.defaultModel,
    vaultSecretName: a.vaultSecretName,
    // keyless: local providers have no API key — the chassis skips vault
    // checks instead of storing a placeholder secret.
    keyless: !!a.keyless,
    // liveModels: the adapter can enumerate its real model inventory
    // (Ollama /api/tags) — a static catalog would lie for these.
    liveModels: typeof a.listModels === 'function',
  }));

/**
 * Live model inventory for a provider, when its adapter exposes one
 * (Ollama /api/tags). Returns null for static-catalog providers; throws
 * the adapter's typed errors (e.g. OllamaNotRunningError) on failure so
 * callers can surface the legible message.
 *
 * @param {string} name
 * @param {{ safeFetch: Function, signal?: AbortSignal, ollamaHost?: string }} deps
 *   ollamaHost (issue #104) routes the live inventory to a remote daemon; other
 *   adapters ignore it.
 * @returns {Promise<Array<{ model: string, label: string }> | null>}
 */
export const listProviderModels = async (name, deps) => {
  const adapter = adapters.get(name);
  if (!adapter) throw new UnknownProviderError(name);
  if (typeof adapter.listModels !== 'function') return null;
  return adapter.listModels(deps);
};

/**
 * Live context window (tokens) for a provider's model, when the adapter
 * can report one (Anthropic's Models API `max_input_tokens`). Returns null
 * for adapters without the capability and swallows every failure — the
 * caller falls back to the static context-window table. Best-effort by
 * construction: the trim trigger must never break on a window lookup.
 *
 * @param {string} name
 * @param {string} model
 * @param {{ getSecret: Function, safeFetch: Function, signal?: AbortSignal, ollamaHost?: string }} deps
 *   ollamaHost (issue #104) routes the live /api/show window to a remote daemon.
 * @returns {Promise<number | null>}
 */
export const providerModelContextWindow = async (name, model, deps) => {
  const adapter = adapters.get(name);
  if (!adapter || typeof adapter.contextWindow !== 'function') return null;
  try {
    return asWindow(await adapter.contextWindow({ model, ...deps }));
  } catch {
    return null;
  }
};

/**
 * Call a provider by name. The runtime layer uses this as its single
 * entry into the provider module — it never imports adapter modules
 * directly. That keeps the runtime independent of the adapter set.
 *
 * @param {Object} args
 * @param {string} args.provider
 * @param {readonly import('./types.js').InternalMessage[]} args.messages
 * @param {string} args.system
 * @param {string} [args.model]
 * @param {number} [args.maxTokens]
 * @param {ReadonlyArray<{ name: string, description: string, schema: object }>} [args.tools]
 *   Tool descriptors the model may call; omitted/empty → text-only turn.
 * @param {{ enabled?: boolean, budgetTokens?: number, effort?: 'low'|'medium'|'high'|'xhigh'|'max' }} [args.reasoning]
 *   Extended-thinking control, passed through to the adapter (adapters
 *   that don't support reasoning accept and ignore it).
 * @param {AbortSignal} [args.signal]
 *   User-driven cancellation; cuts the stream and any retry backoff wait.
 * @param {(name: string) => Promise<string | null>} args.getSecret
 * @param {(resource: string | URL | Request, init?: RequestInit) => Promise<Response>} args.safeFetch
 */
export const callModel = (args) => {
  const adapter = adapters.get(args.provider);
  if (!adapter) throw new UnknownProviderError(args.provider);
  return adapter.call(args);
};
