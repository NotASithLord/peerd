/** Install the synchronous bridge used by a nested WebAssembly C API guest. */
export declare function installCapiObjectBridge(send: (message: unknown) => void): void;
/**
 * Give guest-defined opaque message handles a scheduler-wide namespace.
 *
 * Each worker instantiates its own copy of a guest WebAssembly module, so a
 * module-local counter alone is not unique. Scope zero is reserved for hosts
 * which execute without the SDK worker pool; worker N uses scope N + 1.
 */
export declare function setCapiMessageWorkerId(workerId: number): void;
/** Install attached host objects before dispatching a worker task. */
export declare function receiveCapiDispatch(data: unknown): unknown;
export declare function isCapiDispatchHandled(value: unknown): boolean;
//# sourceMappingURL=capi-worker-bridge.d.ts.map