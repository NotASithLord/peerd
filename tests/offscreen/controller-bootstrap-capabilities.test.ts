import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(
  `../../extension/${path}`, import.meta.url,
), 'utf8');

const literalKeys = (text: string) => [...text.matchAll(/^  '([^']+)':/gm)]
  .map((match) => match[1]);
const computedKeys = (text: string) => [...text.matchAll(/^  \[([A-Z][A-Z0-9_]+)\]:/gm)]
  .map((match) => match[1]);

describe('production controller bootstrap capabilities', () => {
  test('advertises every negotiated capability implemented by the runtime', () => {
    const runtime = source('offscreen/controller-runtime.js');
    const handlers = runtime.slice(
      runtime.indexOf('const makeDefaultHandlers'),
      runtime.indexOf('/**\n * @param {{ handlers?'),
    );
    const supported = source('offscreen/controller-bootstrap.js').match(
      /supportedCaps:\s*\[([\s\S]*?)\],\s*loadController/,
    )?.[1];
    expect(supported).toBeDefined();

    // why health.ping is excluded: it is an injected protocol diagnostic,
    // not a capability the production authority client negotiates.
    const runtimeCapabilities = [
      ...literalKeys(handlers).filter((capability) => capability !== 'health.ping'),
      ...computedKeys(handlers),
      'RUNTIME_DISPATCH_CAPABILITY',
    ].sort();
    const bootstrapCapabilities = [
      ...[...supported!.matchAll(/'([^']+)'/g)].map((match) => match[1]),
      ...[...supported!.matchAll(/\b([A-Z][A-Z0-9_]+)\b/g)].map((match) => match[1]),
    ].sort();

    expect(bootstrapCapabilities).toEqual(runtimeCapabilities);
    expect(bootstrapCapabilities).toContain('TURN_COMPOSE_CAPABILITY');
    expect(bootstrapCapabilities).toContain('turn.tools.command');
  });
});
