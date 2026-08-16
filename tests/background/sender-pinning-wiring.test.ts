import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';

describe('exact sender pins are wired at privileged runtime edges', () => {
  const sw = readFileSync(join(EXTENSION_DIR, 'background', 'service-worker.js'), 'utf8');
  const offscreen = readFileSync(join(EXTENSION_DIR, 'offscreen', 'offscreen.js'), 'utf8');
  const toolboxParse = readFileSync(join(EXTENSION_DIR, 'offscreen', 'toolbox-parse.js'), 'utf8');

  test('state-bearing UI names are checked before a port enters the registry', () => {
    const branch = sw.indexOf("if (port.name === 'sidepanel' || port.name === 'home' || port.name === 'eval')");
    const guard = sw.indexOf('if (!isAuthorizedUiPortSender(port.name, port.sender', branch);
    const admission = sw.indexOf('uiPorts.add(port)', branch);
    expect(branch).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(branch);
    expect(admission).toBeGreaterThan(guard);
  });

  test('the keepalive port is pinned to the offscreen document', () => {
    const branch = sw.indexOf("if (port.name === 'sw-keepalive')");
    const guard = sw.indexOf('if (!isOffscreenSender(port.sender))', branch);
    const admission = sw.indexOf('keepalivePorts.add', branch);
    expect(branch).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(branch);
    expect(admission).toBeGreaterThan(guard);
  });

  test('local-model pushes are offscreen-only and commands are worker-only', () => {
    const pushTypes = sw.indexOf("msg?.type === 'local-model/delta' || msg?.type === 'local-model/done'");
    const pushGuard = sw.indexOf('if (!isOffscreenSender(sender)) return undefined;', pushTypes);
    const deltaMutation = sw.indexOf("if (msg?.type === 'local-model/delta')", pushTypes + 1);
    expect(pushTypes).toBeGreaterThan(-1);
    expect(pushGuard).toBeGreaterThan(pushTypes);
    expect(deltaMutation).toBeGreaterThan(pushGuard);

    const commandHandler = offscreen.indexOf('const onLocalModelMessage =');
    const commandGuard = offscreen.indexOf('if (!isServiceWorkerSender(sender))', commandHandler);
    const commandSwitch = offscreen.indexOf('switch (msg.type)', commandHandler);
    expect(commandHandler).toBeGreaterThan(-1);
    expect(commandGuard).toBeGreaterThan(commandHandler);
    expect(commandSwitch).toBeGreaterThan(commandGuard);
  });

  test('toolbox parser commands are service-worker-only', () => {
    const handler = toolboxParse.indexOf('const onToolboxParseCheck =');
    const branch = toolboxParse.indexOf("message?.type !== 'toolbox/parse-check'", handler);
    const guard = toolboxParse.indexOf('if (!isServiceWorkerSender(sender))', branch);
    const parse = toolboxParse.indexOf('parseCheck(message.name, message.body)', guard);
    expect(handler).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(handler);
    expect(guard).toBeGreaterThan(branch);
    expect(parse).toBeGreaterThan(guard);
  });
});
