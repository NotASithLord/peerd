// @ts-check

import {
  createKernelEngineLive,
  createKernelExecutableLive,
} from './kernel-executable-live.js';
import { createKernelTransferLive } from './kernel-executable-transfer-live.js';
import { createKernelTurnProductionRuntime } from './kernel-turn-production-runtime.js';

/** @param {Record<string,any>} deps */
export const createKernelRichRuntime = async (deps) => {
  if (!deps?.engine || !deps.turn || !deps.transfer
      || typeof deps.createTurnFactories !== 'function') {
    throw new TypeError('kernel-rich-runtime-config-invalid');
  }
  const makeEngine = deps.makeEngine ?? createKernelEngineLive;
  const makeTurn = deps.makeTurn ?? createKernelTurnProductionRuntime;
  const makeExecutable = deps.makeExecutable ?? createKernelExecutableLive;
  const makeTransfer = deps.makeTransfer ?? createKernelTransferLive;
  const engine = await makeEngine(deps.engine);
  const factories = await deps.createTurnFactories({ engine });
  const turnRuntime = await makeTurn({
    ...deps.turn, factories,
  });
  try {
    const relays = turnRuntime.relays;
    const [executableLive, transferLive] = await Promise.all([
      makeExecutable({ ...deps.engine, engine, relays }),
      makeTransfer(deps.transfer),
    ]);
    const dwebOwner = typeof deps.createDwebOwner === 'function'
      ? await deps.createDwebOwner({ engine, relays, transferLive }) : null;
    const dwebRoutes = dwebOwner?.routes ?? Object.freeze({});
    return Object.freeze({
      turnRuntime, executableLive, transferLive, relays,
      relayRoutes: relays.relayRoutes,
      dwebRoutes,
      reseedDwebShares: dwebOwner?.reseed?.onHostGeneration,
      close: () => turnRuntime.close(),
    });
  } catch (cause) {
    await turnRuntime.close();
    throw cause;
  }
};
