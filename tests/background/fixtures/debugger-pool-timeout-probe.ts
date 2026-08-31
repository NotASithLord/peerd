type Listener = (...args: any[]) => void;

const makeEvent = () => {
  const listeners = new Set<Listener>();
  return {
    addListener: (listener: Listener) => { listeners.add(listener); },
    removeListener: (listener: Listener) => { listeners.delete(listener); },
    emit: (...args: any[]) => { for (const listener of listeners) listener(...args); },
  };
};

const expectedDocument = {
  origin: 'https://example.com',
  href: 'https://example.com/',
  documentId: 'document-1',
  timeOrigin: 123,
};
const debuggerEvents = makeEvent();
const debuggerDetachEvents = makeEvent();
const mode = process.argv[2] ?? 'timeout';
const api = {
  runtime: { id: 'peerd-test' },
  tabs: { onRemoved: makeEvent(), onUpdated: makeEvent() },
  scripting: {
    executeScript: async () => [{
      documentId: expectedDocument.documentId,
      result: {
        origin: expectedDocument.origin,
        href: expectedDocument.href,
        timeOrigin: expectedDocument.timeOrigin,
      },
    }],
  },
  debugger: {
    onEvent: debuggerEvents,
    onDetach: debuggerDetachEvents,
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (
      target: { tabId: number },
      method: string,
      params?: { expression?: string },
    ): Promise<any> => {
      if (method === 'Runtime.enable') {
        debuggerEvents.emit(target, 'Runtime.executionContextCreated', {
          context: {
            id: 7,
            origin: expectedDocument.origin,
            auxData: { frameId: 'frame-1', isDefault: true },
          },
        });
        return {};
      }
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: {
          id: 'frame-1', loaderId: 'loader-1', url: expectedDocument.href,
        } } };
      }
      if (method === 'Runtime.evaluate'
          && params?.expression?.startsWith('({ origin:')) {
        return { result: { value: {
          origin: expectedDocument.origin,
          href: expectedDocument.href,
          timeOrigin: expectedDocument.timeOrigin,
        } } };
      }
      if (method === 'Runtime.evaluate') {
        if (mode === 'detach') {
          setTimeout(() => debuggerDetachEvents.emit(target, 'target_closed'), 0);
        }
        return new Promise(() => {});
      }
      return {};
    },
  },
};

(globalThis as unknown as { chrome: unknown }).chrome = api;
(globalThis as unknown as { browser: unknown }).browser = api;

const { createDebuggerPool } = await import('../../../extension/background/debugger-pool.js');
const pool = createDebuggerPool() as {
  evaluate: (tabId: number, expression: string, options: unknown) => Promise<unknown>;
};
const error = await pool.evaluate(1, 'await new Promise(() => {})', {
  expectedDocument,
  timeoutMs: mode === 'timeout' ? 1 : 100,
}).then(() => null, (value: unknown) => value);

process.stdout.write(`${JSON.stringify({
  outcomeKind: (error as { outcomeKind?: string } | null)?.outcomeKind ?? null,
})}\n`);

export {};
