// @ts-check

/** @param {any} message @returns {any} */
export const wasmerThreadPayload = (message) => message !== null && typeof message === 'object'
  && message.type === 'wasmer-dispatch'
  && Array.isArray(message.capiObjects) ? message.payload : message;

/**
 * why: The trusted Pod host owns every native Worker and can stop the full tree.
 * @param {(message:object)=>void} send
 * @param {string} workerUrl
 */
export const createWasmerWorkerProxy = (send, workerUrl) => {
  let sequence = 0;
  /** @type {Map<number, WasmerWorker>} */
  const workers = new Map();

  class WasmerWorker extends EventTarget {
    /** @type {((event:MessageEvent)=>void)|null} */ onmessage = null;
    /** @type {((event:ErrorEvent)=>void)|null} */ onerror = null;
    /** @type {number} */ #id;

    /** @param {string|URL} url @param {WorkerOptions} options */
    constructor(url, options = {}) {
      super();
      if (String(url) !== workerUrl || options.type !== 'module') {
        throw new TypeError('Wasmer can create only sealed SDK threads');
      }
      this.#id = ++sequence;
      workers.set(this.#id, this);
      send({ type: 'wasmer-thread-create', id: this.#id, url: workerUrl, options: { type: 'module' } });
    }

    /** @param {unknown} data */
    postMessage(data) {
      if (workers.has(this.#id)) send({ type: 'wasmer-thread-post', id: this.#id, data });
    }

    terminate() {
      if (!workers.delete(this.#id)) return;
      send({ type: 'wasmer-thread-terminate', id: this.#id });
    }

    /** @param {{event:string,data?:unknown,message?:string}} message */
    receive(message) {
      if (message.event === 'message') {
        const event = new MessageEvent('message', { data: message.data });
        this.onmessage?.(event);
        this.dispatchEvent(event);
      } else if (message.event === 'error') {
        const event = new ErrorEvent('error', { message: message.message || 'Wasmer thread failed' });
        this.onerror?.(event);
        this.dispatchEvent(event);
      }
    }
  }

  return {
    Worker: WasmerWorker,
    /** @param {{type?:string,id?:number,event?:string,data?:unknown,message?:string}} message */
    receive(message) {
      if (message?.type !== 'wasmer-thread-event' || typeof message.id !== 'number') return;
      if (message.event !== 'message' && message.event !== 'error') return;
      workers.get(message.id)?.receive({ ...message, event: message.event });
    },
    close() { for (const worker of workers.values()) worker.terminate(); },
  };
};
