import { describe, expect, test } from 'bun:test';
import { createKernelRichRuntime } from '../../extension/background/kernel-rich-runtime.js';

describe('kernel rich runtime', () => {
  test('constructs engine before turn and shares exact instances with executable ownership', async () => {
    const sequence: string[] = [];
    const engine = { appRegistry: {}, appTabTracker: {} };
    const relays = {
      sessions: {}, scriptRuns: {},
      relayRoutes: { 'actors/list': () => {}, 'actors/call': () => {} },
    };
    let executableInput: any;
    let factoriesInput: any;
    let closed = 0;
    const rich = await createKernelRichRuntime({
      engine: { source: 'engine' }, turn: { source: 'turn' }, transfer: { source: 'transfer' },
      makeEngine: async () => { sequence.push('engine'); return engine; },
      createTurnFactories: async (input: any) => {
        sequence.push('factories');
        factoriesInput = input;
        return { exact: true };
      },
      makeTurn: (input: any) => {
        sequence.push('turn');
        expect(input.factories).toEqual({ exact: true });
        return { relays, close: async () => { closed += 1; } };
      },
      makeExecutable: async (input: any) => {
        sequence.push('executable');
        executableInput = input;
        return { routes: {} };
      },
      makeTransfer: async () => { sequence.push('transfer'); return { routes: {} }; },
      createDwebOwner: async (input: any) => {
        expect(input.engine).toBe(engine);
        expect(input.relays).toBe(relays);
        expect(input.transferLive).toEqual({ routes: {} });
        return {
          routes: { 'dweb/peers': () => ({ ok: true }) },
          reseed: { onHostGeneration: () => ({ ok: true }) },
        };
      },
    });

    expect(sequence.slice(0, 3)).toEqual(['engine', 'factories', 'turn']);
    expect(new Set(sequence.slice(3))).toEqual(new Set(['executable', 'transfer']));
    expect(factoriesInput.engine).toBe(engine);
    expect(executableInput.engine).toBe(engine);
    expect(executableInput.relays).toBe(relays);
    expect(rich.relays).toBe(relays);
    expect(rich.relayRoutes).toBe(relays.relayRoutes);
    expect(rich.dwebRoutes['dweb/peers']()).toEqual({ ok: true });
    expect(rich.reseedDwebShares()).toEqual({ ok: true });
    await rich.close();
    expect(closed).toBe(1);
  });

  test('closes the turn owner if dependent live assembly fails', async () => {
    let closed = 0;
    await expect(createKernelRichRuntime({
      engine: {}, turn: {}, transfer: {}, createTurnFactories: async () => ({}),
      makeEngine: async () => ({}),
      makeTurn: () => ({ relays: {}, close: async () => { closed += 1; } }),
      makeExecutable: async () => { throw new Error('failed'); },
      makeTransfer: async () => ({}),
    })).rejects.toThrow('failed');
    expect(closed).toBe(1);
  });
});
