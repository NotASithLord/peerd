// @ts-check
// Closed, host-owned human projection of exact authority-operation arguments.

import { structuredClonePayloadBytes } from './structured-clone-size.js';

const OPERATION_LABELS = Object.freeze({
  'turn.actor.spawn-sync': 'Run a delegated actor task',
  'turn.actor.spawn-async': 'Start a delegated actor task',
  'turn.actor.cancel': 'Cancel a delegated actor task',
  'turn.actor.message': 'Send a message to an actor',
  'turn.pod.confirm-git': 'Approve a Pod Git operation',
  'turn.pod.exec': 'Run a Pod command',
  'turn.pod.cancel': 'Cancel a Pod job',
  'turn.pod.write-file': 'Write a Pod file',
  'turn.repository.destroy-pod': 'Destroy a repository Pod',
  'turn.repository.confirm-restore': 'Approve a repository restore',
  'turn.repository.checkpoint': 'Create a repository checkpoint',
  'turn.repository.branch': 'Create a repository branch',
  'turn.repository.checkout': 'Check out a repository branch',
  'turn.repository.restore': 'Restore repository state',
  'turn.repository.confirm-remote': 'Approve a remote repository operation',
  'turn.repository.link': 'Link a repository remote',
  'turn.repository.fetch': 'Fetch a repository remote',
  'turn.repository.push': 'Push repository changes',
  'turn.vm.set-default': 'Set the default WebVM',
  'turn.vm.run': 'Run a WebVM command',
  'turn.vm.import-file': 'Import a file into a WebVM',
  'turn.vm.write-text-file': 'Write a WebVM file',
  'turn.vm.destroy': 'Destroy a WebVM',
  'turn.notebook.set-default': 'Set the default Notebook',
  'turn.notebook.run': 'Run code in a Notebook',
  'turn.notebook.write-file': 'Write a Notebook file',
  'turn.notebook.destroy': 'Destroy a Notebook',
  'turn.app.update': 'Update an App',
  'turn.app.open': 'Open an App',
  'turn.app.delete': 'Delete an App',
  'turn.app.write-file': 'Write an App file',
  'turn.app.delete-file': 'Delete an App file',
  'turn.app.act': 'Perform an App action',
  'turn.app.run-code': 'Run code against an App',
  'turn.memory.write': 'Update durable memory',
  'turn.todo.replace': 'Replace the session todo list',
  'turn.page.open-tab': 'Open a browser tab',
  'turn.page.navigate': 'Navigate the owned browser tab',
  'turn.page.fill': 'Enter text in the owned browser tab',
  'turn.page.click': 'Click in the owned browser tab',
  'turn.page.login': 'Start a login in the owned browser tab',
  'turn.page.run-program': 'Run a page program',
  'turn.resource.confirm-web-write': 'Approve an external web request',
  'turn.resource.request-web-text': 'Send an external web request',
  'turn.resource.spill-result': 'Store a large fetched result',
  'turn.site-client.run': 'Run a stored site client',
  'turn.site-client.commit': 'Save a site client',
  'turn.site-client.capture-start': 'Start site-client capture',
  'turn.site-client.capture-stop': 'Stop site-client capture',
  'turn.execution.create-webvm': 'Create a WebVM',
  'turn.execution.create-notebook': 'Create a Notebook',
  'turn.execution.create-pod': 'Create a Pod',
  'turn.execution.create-app': 'Create an App',
  'turn.execution.run-script': 'Run a headless script with durable workspace access',
  'turn.execution.spill-script': 'Store a large script result',
  'turn.editing.write-target': 'Write an edit target',
  'turn.schedule.arm-confirmed-routine': 'Schedule a background routine',
  'turn.schedule.cancel-routine': 'Cancel a background routine',
  'turn.dweb.publish-confirmed-app': 'Publish an App to the dweb',
  'turn.dweb.install-confirmed-app': 'Install an App from the dweb',
  'turn.dweb.set-peer-blocked': 'Change a dweb peer block',
  'turn.dweb.set-discovery-enabled': 'Change dweb discovery',
  'turn.dweb.run-mesh-program': 'Run a dweb mesh program',
});

const clean = (/** @type {unknown} */ value, max = 120) => {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};

const safeUrl = (/** @type {unknown} */ value) => {
  try {
    const url = new URL(String(value));
    const queryNames = [...new Set([...url.searchParams.keys()])].slice(0, 8)
      .map((name) => clean(name, 32));
    return `${url.origin}${clean(url.pathname, 240)}${url.search
      ? ` (query fields: ${queryNames.join(', ') || 'unnamed'})` : ''}`;
  } catch { return clean(value, 240); }
};

const bytesOf = (/** @type {unknown} */ value) => {
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  const bytes = structuredClonePayloadBytes(value, { maxDepth: 16, maxNodes: 10_000 });
  return Number.isFinite(bytes) ? bytes : null;
};

/**
 * @param {string} operation
 * @param {unknown} inputArgs
 * @param {string} lifecycleTarget
 * @returns {{summary:string,origins:readonly string[]}|null}
 */
export const authorityEffectConfirmationPresentation = (
  operation,
  inputArgs,
  lifecycleTarget,
) => {
  const label = OPERATION_LABELS[/** @type {keyof typeof OPERATION_LABELS} */ (operation)];
  if (!label || !inputArgs || typeof inputArgs !== 'object' || Array.isArray(inputArgs)) return null;
  const outer = /** @type {Record<string,any>} */ (inputArgs);
  const args = outer.args && typeof outer.args === 'object' && !Array.isArray(outer.args)
    ? /** @type {Record<string,any>} */ (outer.args) : outer;
  /** @type {string[]} */
  const details = [];
  /** @type {string[]} */
  const origins = [];
  for (const key of [
    'vmId', 'notebookId', 'appId', 'podId', 'jobId', 'taskId', 'id', 'to',
    'kind', 'targetId', 'path', 'name', 'target', 'branch', 'origin', 'did',
  ]) {
    if (args[key] !== undefined && args[key] !== null && args[key] !== '') {
      details.push(`${key}: ${clean(args[key])}`);
    }
  }
  if (args.url !== undefined) {
    const shown = safeUrl(args.url);
    details.push(`url: ${shown}`);
    try { origins.push(new URL(String(args.url)).origin); } catch { /* binder rejects later */ }
  }
  if (typeof args.command === 'string') {
    const commandName = clean(args.command.split(/\s+/)[0] ?? '', 48);
    details.push(`command: ${commandName || '(empty)'} (${args.command.length} chars; arguments hidden)`);
  }
  for (const key of ['task', 'message', 'prompt', 'summary', 'action', 'op']) {
    if (typeof args[key] === 'string' && args[key]) details.push(`${key}: ${clean(args[key])}`);
  }
  for (const key of ['code', 'content', 'body', 'text']) {
    if (args[key] !== undefined) {
      const bytes = bytesOf(args[key]);
      details.push(`${key}: ${bytes === null ? 'invalid payload' : `${bytes} bytes; contents hidden`}`);
    }
  }
  for (const key of ['plan', 'params', 'todos', 'actors', 'tools', 'grantedOperations']) {
    if (args[key] !== undefined) {
      const bytes = bytesOf(args[key]);
      details.push(`${key}: ${bytes === null ? 'invalid payload' : `${bytes} structured bytes`}`);
    }
  }
  for (const key of ['block', 'enabled', 'workspace', 'allowRecursion', 'oneShot', 'awaitReply']) {
    if (typeof args[key] === 'boolean') details.push(`${key}: ${args[key]}`);
  }
  for (const key of ['mode', 'every', 'dailyAt', 'timeoutMs', 'maxBytes']) {
    if (args[key] !== undefined && args[key] !== null && args[key] !== '') {
      details.push(`${key}: ${clean(args[key], 64)}`);
    }
  }
  const fingerprint = /^[^:]+(?::[^:]+)*:([a-f0-9]{64})$/.exec(lifecycleTarget)?.[1];
  if (fingerprint) details.push(`intent fingerprint: ${fingerprint.slice(0, 12)}`);
  return Object.freeze({
    summary: `${label}?${details.length > 0 ? `\n${details.slice(0, 12).join('\n')}` : ''}`,
    origins: Object.freeze([...new Set(origins)]),
  });
};
