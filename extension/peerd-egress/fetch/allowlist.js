// @ts-check
// The non-negotiable provider-endpoint allowlist.
//
// To add an entry here, open a PR. The user-added endpoint set is
// separate and lives in chrome.storage.local — see the registry in
// peerd-provider/registry.js (the add flow is a documented
// follow-up). Keeping the hardcoded list in its own tiny file
// makes the diff for any change to it stand out in code review.
//
// Frozen so feature code can't accidentally `.push()` to it.

export const HARDCODED_ALLOWLIST = Object.freeze([
  'https://api.anthropic.com',
  'https://api.openai.com',
  'https://openrouter.ai',      // OpenRouter (OpenAI-compatible gateway)
  'http://localhost:11434',     // Ollama default
  'http://127.0.0.1:11434',
]);
