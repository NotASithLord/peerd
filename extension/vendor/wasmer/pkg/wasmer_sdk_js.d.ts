/* tslint:disable */
/* eslint-disable */

export class CommandCore {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    args(args: string[]): void;
    currentDir(path: string): void;
    env(key: string, value: string): void;
    input(bytes: Uint8Array): void;
    outputBytes(bytes: number): void;
    run(): Promise<OutputCore>;
    spawn(): Promise<ProcessCore>;
    /**
     * Live stderr mode for `spawn()`: `"pipe"`, `"capture"`, or `"discard"`.
     */
    stderrMode(mode: string): void;
    /**
     * Live stdin mode for `spawn()`: `"pipe"` or `"closed"`.
     */
    stdinMode(mode: string): void;
    /**
     * Live stdout mode for `spawn()`: `"pipe"`, `"capture"`, or `"discard"`.
     */
    stdoutMode(mode: string): void;
    /**
     * Attach an interactive terminal with the given character dimensions.
     */
    terminal(columns: number, rows: number): void;
    timeoutMs(milliseconds: number): void;
}

export class HttpResponseCore {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly body: Uint8Array;
    readonly headers: any;
    readonly status: number;
    readonly statusText: string;
}

export class OutputCore {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly exitCode: number;
    readonly ok: boolean;
    /**
     * Why the process stopped: `"exited"`, `"terminated"`, or `"timeout"`.
     */
    readonly reason: string;
    readonly stderr: Uint8Array;
    readonly stderrTruncated: boolean;
    readonly stdout: Uint8Array;
    readonly stdoutTruncated: boolean;
}

export class PackageCore {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    hasCommand(name: string): boolean;
    readonly commands: string[];
    readonly entrypoint: string | undefined;
    readonly id: string;
}

export class PackageLoadCancellation {
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    constructor();
}

export class ProcessCore {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    closeStdin(): Promise<void>;
    kill(): void;
    readStderr(max_bytes: number): Promise<any>;
    readStdout(max_bytes: number): Promise<any>;
    resizeTerminal(columns: number, rows: number): void;
    terminate(grace_ms: number): Promise<void>;
    wait(): Promise<OutputCore>;
    writeStdin(bytes: Uint8Array): Promise<void>;
    readonly id: number;
}

export class SandboxBuilderCore {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    addNetworkPeer(peer: SandboxCore): void;
    env(key: string, value: string): void;
    file(path: string, bytes: Uint8Array): void;
    /**
     * Experimental worker-only native directory mount. The embedder installs
     * the synchronous `__wasmerHostFileSystem` bridge on every SDK worker.
     */
    mountHost(path: string, mount_id: number, read_only: boolean): void;
    /**
     * Configure guest networking from a stable mode string.
     */
    network(mode: string): void;
    /**
     * Configure browser HTTP ingress and WISP-backed TCP/DNS egress.
     */
    networkWisp(bridge: any): void;
    package(_package: PackageCore): void;
    /**
     * Disable automatic localhost discovery before adding explicit peers.
     */
    restrictNetworkPeers(): void;
    start(): Promise<SandboxCore>;
    /**
     * Use an embedder filesystem as `/workspace`, including the SDK file API.
     */
    storageHost(mount_id: number): void;
}

export class SandboxCore {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    close(): Promise<void>;
    command(name: string): CommandCore;
    commandPackage(_package: PackageCore): CommandCore;
    /**
     * A command explicitly qualified by its package, resolving name
     * collisions between installed packages.
     */
    commandRef(_package: PackageCore, name: string): CommandCore;
    /**
     * Open a protocol-independent byte stream to a guest listener.
     */
    connectTcp(port: number): TcpConnectionCore;
    /**
     * Forward one structured HTTP request into a guest TCP listener.
     */
    handleHttpRequest(port: number, method: string, path: string, headers: any, body: Uint8Array): Promise<HttpResponseCore>;
    /**
     * Browser HTTP ingress ports currently owned by guest listeners.
     */
    httpListeningPorts(): Uint16Array | undefined;
    installPackage(specifier: string): Promise<PackageCore>;
    installPackageBytes(bytes: Uint8Array): Promise<PackageCore>;
    installPackageRef(_package: PackageCore): Promise<PackageCore>;
    /**
     * Whether a browser HTTP ingress listener exists on `port`.
     */
    isHttpPortListening(port: number): boolean;
    mkdir(path: string, recursive: boolean): void;
    readDir(path: string): any;
    readFile(path: string): Promise<Uint8Array>;
    remove(path: string, recursive: boolean): void;
    rename(from: string, to: string): Promise<void>;
    stat(path: string): any;
    /**
     * Wait until a guest TCP listener accepts connections on `port`.
     */
    waitForPort(port: number, timeout_ms: number): Promise<void>;
    writeFile(path: string, bytes: Uint8Array): Promise<void>;
}

export class TcpConnectionCore {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Wakes pending reads/writes. Free only after their promises settle.
     */
    close(): void;
    /**
     * Empty bytes indicate EOF. The caller must have only one read in flight.
     */
    read(): Promise<Uint8Array>;
    shutdownWrite(): void;
    /**
     * Writes apply backpressure; submit chunks no larger than 64 KiB.
     */
    write(bytes: Uint8Array): Promise<void>;
}

export class WasmerCore {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static create(options: any, node_network?: any | null, node_cache?: any | null): WasmerCore;
    createPackage(definition: any): Promise<PackageCore>;
    loadPackage(specifier: string): Promise<PackageCore>;
    loadPackageBytes(bytes: Uint8Array): Promise<PackageCore>;
    loadPackages(sources: Array<any>, callback: Function | null | undefined, cancellation: PackageLoadCancellation): Promise<Array<any>>;
    sandbox(): SandboxBuilderCore;
    shutdown(): Promise<void>;
}

export function initialize(): void;

export function setSDKUrl(url: string): void;

export function setWorkerUrl(url: string): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly __wbg_commandcore_free: (a: number, b: number) => void;
    readonly __wbg_httpresponsecore_free: (a: number, b: number) => void;
    readonly __wbg_outputcore_free: (a: number, b: number) => void;
    readonly __wbg_packagecore_free: (a: number, b: number) => void;
    readonly __wbg_packageloadcancellation_free: (a: number, b: number) => void;
    readonly __wbg_processcore_free: (a: number, b: number) => void;
    readonly __wbg_sandboxbuildercore_free: (a: number, b: number) => void;
    readonly __wbg_sandboxcore_free: (a: number, b: number) => void;
    readonly __wbg_tcpconnectioncore_free: (a: number, b: number) => void;
    readonly __wbg_threadpoolworker_free: (a: number, b: number) => void;
    readonly __wbg_wasmercore_free: (a: number, b: number) => void;
    readonly commandcore_args: (a: number, b: number, c: number) => [number, number];
    readonly commandcore_currentDir: (a: number, b: number, c: number) => [number, number];
    readonly commandcore_env: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly commandcore_input: (a: number, b: any) => [number, number];
    readonly commandcore_outputBytes: (a: number, b: number) => [number, number];
    readonly commandcore_run: (a: number) => any;
    readonly commandcore_spawn: (a: number) => any;
    readonly commandcore_stderrMode: (a: number, b: number, c: number) => [number, number];
    readonly commandcore_stdinMode: (a: number, b: number, c: number) => [number, number];
    readonly commandcore_stdoutMode: (a: number, b: number, c: number) => [number, number];
    readonly commandcore_terminal: (a: number, b: number, c: number) => [number, number];
    readonly commandcore_timeoutMs: (a: number, b: number) => [number, number];
    readonly httpresponsecore_body: (a: number) => any;
    readonly httpresponsecore_headers: (a: number) => [number, number, number];
    readonly httpresponsecore_status: (a: number) => number;
    readonly httpresponsecore_statusText: (a: number) => [number, number];
    readonly initialize: () => void;
    readonly outputcore_exitCode: (a: number) => number;
    readonly outputcore_ok: (a: number) => number;
    readonly outputcore_reason: (a: number) => [number, number];
    readonly outputcore_stderr: (a: number) => any;
    readonly outputcore_stderrTruncated: (a: number) => number;
    readonly outputcore_stdout: (a: number) => any;
    readonly outputcore_stdoutTruncated: (a: number) => number;
    readonly packagecore_commands: (a: number) => [number, number];
    readonly packagecore_entrypoint: (a: number) => [number, number];
    readonly packagecore_hasCommand: (a: number, b: number, c: number) => number;
    readonly packagecore_id: (a: number) => [number, number];
    readonly packageloadcancellation_cancel: (a: number) => void;
    readonly packageloadcancellation_new: () => number;
    readonly processcore_closeStdin: (a: number) => any;
    readonly processcore_id: (a: number) => number;
    readonly processcore_kill: (a: number) => void;
    readonly processcore_readStderr: (a: number, b: number) => any;
    readonly processcore_readStdout: (a: number, b: number) => any;
    readonly processcore_resizeTerminal: (a: number, b: number, c: number) => [number, number];
    readonly processcore_terminate: (a: number, b: number) => any;
    readonly processcore_wait: (a: number) => any;
    readonly processcore_writeStdin: (a: number, b: any) => any;
    readonly sandboxbuildercore_addNetworkPeer: (a: number, b: number) => [number, number];
    readonly sandboxbuildercore_env: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly sandboxbuildercore_file: (a: number, b: number, c: number, d: any) => [number, number];
    readonly sandboxbuildercore_mountHost: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly sandboxbuildercore_network: (a: number, b: number, c: number) => [number, number];
    readonly sandboxbuildercore_networkWisp: (a: number, b: any) => [number, number];
    readonly sandboxbuildercore_package: (a: number, b: number) => [number, number];
    readonly sandboxbuildercore_restrictNetworkPeers: (a: number) => [number, number];
    readonly sandboxbuildercore_start: (a: number) => any;
    readonly sandboxbuildercore_storageHost: (a: number, b: number) => [number, number];
    readonly sandboxcore_close: (a: number) => any;
    readonly sandboxcore_command: (a: number, b: number, c: number) => number;
    readonly sandboxcore_commandPackage: (a: number, b: number) => number;
    readonly sandboxcore_commandRef: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly sandboxcore_connectTcp: (a: number, b: number) => [number, number, number];
    readonly sandboxcore_handleHttpRequest: (a: number, b: number, c: number, d: number, e: number, f: number, g: any, h: any) => any;
    readonly sandboxcore_httpListeningPorts: (a: number) => [number, number, number, number];
    readonly sandboxcore_installPackage: (a: number, b: number, c: number) => any;
    readonly sandboxcore_installPackageBytes: (a: number, b: any) => any;
    readonly sandboxcore_installPackageRef: (a: number, b: number) => any;
    readonly sandboxcore_isHttpPortListening: (a: number, b: number) => [number, number, number];
    readonly sandboxcore_mkdir: (a: number, b: number, c: number, d: number) => [number, number];
    readonly sandboxcore_readDir: (a: number, b: number, c: number) => [number, number, number];
    readonly sandboxcore_readFile: (a: number, b: number, c: number) => any;
    readonly sandboxcore_remove: (a: number, b: number, c: number, d: number) => [number, number];
    readonly sandboxcore_rename: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly sandboxcore_stat: (a: number, b: number, c: number) => [number, number, number];
    readonly sandboxcore_waitForPort: (a: number, b: number, c: number) => any;
    readonly sandboxcore_writeFile: (a: number, b: number, c: number, d: any) => any;
    readonly setSDKUrl: (a: number, b: number) => void;
    readonly setWorkerUrl: (a: number, b: number) => void;
    readonly tcpconnectioncore_close: (a: number) => [number, number];
    readonly tcpconnectioncore_read: (a: number) => any;
    readonly tcpconnectioncore_shutdownWrite: (a: number) => [number, number];
    readonly tcpconnectioncore_write: (a: number, b: any) => any;
    readonly threadpoolworker_collectSharedObjects: (a: number) => void;
    readonly threadpoolworker_handle: (a: number, b: any) => any;
    readonly threadpoolworker_new: (a: number) => number;
    readonly wasmercore_create: (a: any, b: number, c: number) => [number, number, number];
    readonly wasmercore_createPackage: (a: number, b: any) => any;
    readonly wasmercore_loadPackage: (a: number, b: number, c: number) => any;
    readonly wasmercore_loadPackageBytes: (a: number, b: any) => any;
    readonly wasmercore_loadPackages: (a: number, b: any, c: number, d: number) => any;
    readonly wasmercore_sandbox: (a: number) => number;
    readonly wasmercore_shutdown: (a: number) => any;
    readonly snapi_bridge_unofficial_create_env: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_unofficial_configure_runtime: (a: number, b: number) => number;
    readonly snapi_bridge_delete_reference: (a: number, b: number) => number;
    readonly snapi_bridge_unofficial_release_env: (a: number) => number;
    readonly snapi_bridge_unofficial_module_wrap_destroy: (a: number, b: number) => number;
    readonly snapi_bridge_unofficial_module_wrap_instantiate: (a: number, b: number) => number;
    readonly snapi_bridge_typeof: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_unwrap: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_run_script: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_remove_wrap: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_create_symbol: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_reference_ref: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_create_promise: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_reference_unref: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_coerce_to_number: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_coerce_to_object: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_coerce_to_string: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_node_api_set_prototype: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_get_property_names: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_get_value_external: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_get_reference_value: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_unofficial_bytecode_open: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => number;
    readonly snapi_bridge_unofficial_message_create: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_unofficial_bytecode_serialize: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_unofficial_module_wrap_create: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => number;
    readonly snapi_bridge_get_element: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_has_element: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_set_element: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_get_property: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_has_property: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_set_property: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_escape_handle: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_delete_element: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_delete_property: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_create_reference: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_has_own_property: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_get_named_property: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_has_named_property: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_set_named_property: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_create_string_utf16: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_snapshot_value_bytes: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_free_buffer: (a: number) => void;
    readonly snapi_bridge_check_object_type_tag: (a: number, b: number, c: bigint, d: bigint, e: number) => number;
    readonly snapi_bridge_unofficial_module_wrap_link: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_unofficial_structured_clone: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_unofficial_create_private_symbol: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_unofficial_module_wrap_set_export: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_unofficial_get_own_non_index_properties: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_unofficial_module_wrap_check_unsettled_top_level_await: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_new_instance: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly snapi_bridge_get_value_string_utf16: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly snapi_bridge_unofficial_get_promise_details: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly snapi_bridge_unofficial_module_wrap_get_state: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly snapi_bridge_unofficial_module_wrap_evaluate_sync: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly snapi_bridge_wrap_finalized: (a: number, b: number, c: bigint, d: number, e: number, f: number, g: number, h: number) => number;
    readonly snapi_bridge_get_cb_info: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly snapi_bridge_call_function: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly snapi_bridge_create_function: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly snapi_bridge_create_typedarray: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly snapi_bridge_get_all_property_names: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly snapi_bridge_overwrite_value_bytes: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_unofficial_contextify_contains_module_syntax: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly snapi_bridge_get_typedarray_info: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly snapi_bridge_define_class: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => number;
    readonly snapi_bridge_unofficial_contextify_make_context: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly snapi_bridge_unofficial_contextify_compile_function: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => number;
    readonly snapi_bridge_unofficial_contextify_run_script: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint, i: number, j: number, k: number, l: number, m: number) => number;
    readonly snapi_bridge_unofficial_message_take: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_drain_pending_callbacks: (a: number) => number;
    readonly snapi_host_invoke_wasm_callback: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_host_invoke_wasm_finalizer: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly snapi_bridge_take_ready_guest_buffer_finalizer: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly snapi_bridge_register_guest_buffer_finalizer: (a: number, b: number, c: number, d: number) => number;
    readonly napi_host_near_heap_limit_grant: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_add_finalizer: (a: number, b: number, c: bigint, d: number) => number;
    readonly snapi_bridge_add_finalizer_cb: (a: number, b: number, c: bigint, d: number, e: number, f: number, g: number, h: number) => number;
    readonly snapi_bridge_adjust_external_memory: (a: number, b: bigint, c: number) => number;
    readonly snapi_bridge_alloc_cb_reg_id: (a: number) => number;
    readonly snapi_bridge_close_escapable_handle_scope: (a: number, b: number) => number;
    readonly snapi_bridge_coerce_to_bool: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_create_array: (a: number, b: number) => number;
    readonly snapi_bridge_create_array_with_length: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_create_arraybuffer: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_create_bigint_words: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly snapi_bridge_create_buffer: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_create_buffer_copy: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly snapi_bridge_create_dataview: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly snapi_bridge_create_date: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_create_double: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_create_error: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_create_external: (a: number, b: bigint, c: number) => number;
    readonly snapi_bridge_create_external_arraybuffer: (a: number, b: bigint, c: number, d: number, e: number) => number;
    readonly snapi_bridge_create_external_buffer: (a: number, b: bigint, c: number, d: number, e: number) => number;
    readonly snapi_bridge_create_int32: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_create_int64: (a: number, b: bigint, c: number) => number;
    readonly snapi_bridge_create_object: (a: number, b: number) => number;
    readonly snapi_bridge_create_range_error: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_create_sharedarraybuffer: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_create_string_latin1: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_create_string_utf8: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_create_type_error: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_create_uint32: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_define_properties: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => number;
    readonly snapi_bridge_detach_arraybuffer: (a: number, b: number) => number;
    readonly snapi_bridge_dispose: () => void;
    readonly snapi_bridge_drain_all_guest_finalizers: (a: number) => number;
    readonly snapi_bridge_get_and_clear_last_exception: (a: number, b: number) => number;
    readonly snapi_bridge_get_array_length: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_get_arraybuffer_info: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly snapi_bridge_get_backing_store_token: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_get_boolean: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_get_dataview_info: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly snapi_bridge_get_date_value: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_get_global: (a: number, b: number) => number;
    readonly snapi_bridge_get_instance_data: (a: number, b: number) => number;
    readonly snapi_bridge_get_new_target: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_get_node_version: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_get_null: (a: number, b: number) => number;
    readonly snapi_bridge_get_prototype: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_get_undefined: (a: number, b: number) => number;
    readonly snapi_bridge_get_value_bigint_int64: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_get_value_bigint_words: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly snapi_bridge_get_value_bool: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_get_value_double: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_get_value_int32: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_get_value_int64: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_get_value_string_latin1: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly snapi_bridge_get_value_string_utf8: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly snapi_bridge_get_value_uint32: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_init: () => number;
    readonly snapi_bridge_instanceof: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_is_array: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_is_arraybuffer: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_is_buffer: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_is_dataview: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_is_date: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_is_error: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_is_exception_pending: (a: number, b: number) => number;
    readonly snapi_bridge_is_promise: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_is_sharedarraybuffer: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_is_typedarray: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_object_freeze: (a: number, b: number) => number;
    readonly snapi_bridge_object_seal: (a: number, b: number) => number;
    readonly snapi_bridge_open_escapable_handle_scope: (a: number, b: number) => number;
    readonly snapi_bridge_overwrite_reference_bytes: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_register_callback: (a: number, b: number, c: number, d: number, e: bigint) => void;
    readonly snapi_bridge_register_callback_pair: (a: number, b: number, c: number, d: number, e: number, f: bigint) => void;
    readonly snapi_bridge_reject_deferred: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_resolve_deferred: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_set_instance_data: (a: number, b: bigint) => number;
    readonly snapi_bridge_strict_equals: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_swap_active_callback_ctx: (a: number, b: number) => number;
    readonly snapi_bridge_throw: (a: number, b: number) => number;
    readonly snapi_bridge_throw_error: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_throw_range_error: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_throw_type_error: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_type_tag_object: (a: number, b: number, c: bigint, d: bigint) => number;
    readonly snapi_bridge_unofficial_attach_env: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_unofficial_bytecode_release: (a: number, b: number) => number;
    readonly snapi_bridge_unofficial_cancel_terminate_execution: (a: number) => number;
    readonly snapi_bridge_unofficial_configure_source_maps: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_unofficial_create_env_with_options: (a: number, b: bigint, c: bigint, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly snapi_bridge_unofficial_create_serdes_binding: (a: number, b: number) => number;
    readonly snapi_bridge_unofficial_enqueue_microtask: (a: number, b: number) => number;
    readonly snapi_bridge_unofficial_event_loop_checkpoint: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_unofficial_get_continuation_preserved_embedder_data: (a: number, b: number) => number;
    readonly snapi_bridge_unofficial_get_error_metadata: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => number;
    readonly snapi_bridge_unofficial_get_heap_code_statistics: (a: number, b: number) => number;
    readonly snapi_bridge_unofficial_get_heap_space_statistics: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_unofficial_get_heap_statistics: (a: number, b: number) => number;
    readonly snapi_bridge_unofficial_message_drop: (a: number) => void;
    readonly snapi_bridge_unofficial_module_wrap_create_required_module_facade: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_unofficial_module_wrap_evaluate: (a: number, b: number, c: bigint, d: number, e: number) => number;
    readonly snapi_bridge_unofficial_module_wrap_set_hooks: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_unofficial_release_env_with_loop: (a: number, b: number) => number;
    readonly snapi_bridge_unofficial_request_interrupt: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_unofficial_set_promise_hooks: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly snapi_bridge_unofficial_take_heap_snapshot: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_wrap: (a: number, b: number, c: bigint, d: number) => number;
    readonly snapi_bridge_close_handle_scope: (a: number, b: number) => number;
    readonly snapi_bridge_unofficial_collect_garbage: (a: number) => number;
    readonly snapi_bridge_unofficial_notify_datetime_configuration_change: (a: number) => number;
    readonly snapi_bridge_unofficial_terminate_execution: (a: number) => number;
    readonly snapi_bridge_unofficial_get_hash_seed: (a: number, b: number) => number;
    readonly snapi_bridge_unofficial_mark_promise_as_handled: (a: number, b: number) => number;
    readonly snapi_bridge_unofficial_preserve_error_source_message: (a: number, b: number) => number;
    readonly snapi_bridge_unofficial_set_continuation_preserved_embedder_data: (a: number, b: number) => number;
    readonly snapi_bridge_unofficial_set_prepare_stack_trace_callback: (a: number, b: number) => number;
    readonly snapi_bridge_unofficial_set_promise_reject_callback: (a: number, b: number) => number;
    readonly snapi_bridge_open_handle_scope: (a: number, b: number) => number;
    readonly snapi_bridge_create_bigint_int64: (a: number, b: bigint, c: number) => number;
    readonly snapi_bridge_create_bigint_uint64: (a: number, b: bigint, c: number) => number;
    readonly snapi_bridge_is_detached_arraybuffer: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_unofficial_arraybuffer_view_has_buffer: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_unofficial_get_call_sites: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_unofficial_get_constructor_name: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_unofficial_module_wrap_create_cached_data: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_unofficial_module_wrap_get_module_source_object: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_unofficial_module_wrap_set_module_source_object: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_unofficial_profile_stop: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_get_value_bigint_uint64: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_unofficial_get_proxy_details: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_unofficial_preview_entries: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_unofficial_profile_start: (a: number, b: number, c: number, d: number) => number;
    readonly snapi_bridge_unofficial_module_wrap_get_namespace: (a: number, b: number, c: number) => number;
    readonly snapi_bridge_get_buffer_info: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly canonical_abi_free: (a: number, b: number, c: number) => void;
    readonly canonical_abi_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbg_trap_free: (a: number, b: number) => void;
    readonly trap___wbg_wasmer_trap: () => void;
    readonly wasm_bindgen_569eb95f3a8fb3d6___convert__closures_____invoke___u32__alloc_377de6d7feb3cdcc___string__String__bool__true_: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly wasm_bindgen_569eb95f3a8fb3d6___convert__closures_____invoke___wasm_bindgen_569eb95f3a8fb3d6___JsValue__js_sys_72863d65baa37214___Array__wasm_bindgen_569eb95f3a8fb3d6___JsValue__true_: (a: number, b: number, c: any, d: any) => any;
    readonly wasm_bindgen_569eb95f3a8fb3d6___convert__closures_____invoke___wasm_bindgen_569eb95f3a8fb3d6___JsValue__core_d7559254c0ef046e___result__Result_____wasm_bindgen_569eb95f3a8fb3d6___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_569eb95f3a8fb3d6___convert__closures________invoke___js_sys_72863d65baa37214___Array__core_d7559254c0ef046e___result__Result_js_sys_72863d65baa37214___Array__wasm_bindgen_569eb95f3a8fb3d6___JsValue___true_: (a: number, b: number, c: any) => [number, number, number];
    readonly wasm_bindgen_569eb95f3a8fb3d6___convert__closures________invoke___js_sys_72863d65baa37214___Array__core_d7559254c0ef046e___result__Result_js_sys_72863d65baa37214___Array__wasm_bindgen_569eb95f3a8fb3d6___JsValue___true__7: (a: number, b: number, c: any) => [number, number, number];
    readonly wasm_bindgen_569eb95f3a8fb3d6___convert__closures________invoke___js_sys_72863d65baa37214___Array__core_d7559254c0ef046e___result__Result_____wasm_bindgen_569eb95f3a8fb3d6___JsValue___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_569eb95f3a8fb3d6___convert__closures_____invoke___js_sys_72863d65baa37214___Function_fn_wasm_bindgen_569eb95f3a8fb3d6___JsValue_____wasm_bindgen_569eb95f3a8fb3d6___sys__Undefined___js_sys_72863d65baa37214___Function_fn_wasm_bindgen_569eb95f3a8fb3d6___JsValue_____wasm_bindgen_569eb95f3a8fb3d6___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_569eb95f3a8fb3d6___convert__closures________invoke___js_sys_72863d65baa37214___Array__js_sys_72863d65baa37214___Promise__true_: (a: number, b: number, c: any) => any;
    readonly wasm_bindgen_569eb95f3a8fb3d6___convert__closures_____invoke___wasm_bindgen_569eb95f3a8fb3d6___JsValue______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_569eb95f3a8fb3d6___convert__closures_____invoke___js_sys_72863d65baa37214___futures__task__wait_async_polyfill__MessageEvent______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_569eb95f3a8fb3d6___convert__closures_____invoke___web_sys_12de4b57bfa6e78a___features__gen_MessageEvent__MessageEvent______true_: (a: number, b: number, c: any) => void;
    readonly memory: WebAssembly.Memory;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_export: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_thread_destroy: (a?: number, b?: number, c?: number) => void;
    readonly __wbindgen_start: (a: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number }} module - Passing `SyncInitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number } | SyncInitInput, memory?: WebAssembly.Memory): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number }} module_or_path - Passing `InitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number } | InitInput | Promise<InitInput>, memory?: WebAssembly.Memory): Promise<InitOutput>;
