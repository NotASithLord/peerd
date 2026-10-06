import "./node-compat.js";
import init, { WasmerCore, type CommandCore, type PackageCore, type ProcessCore, type SandboxCore } from "../pkg/wasmer_sdk_js.js";
export interface WasmerOptions {
    outputBytes?: number;
    /**
     * Parallelism advertised to WASIX guests. Browser workers carry a complete
     * WebAssembly runtime, so browsers default to 2 instead of exposing the
     * host's raw logical CPU count. Node defaults to the host-reported value.
     */
    parallelism?: number;
    wasm?: Parameters<typeof init>[0];
    /**
     * Persistent package and registry caching. Browsers use an origin-scoped
     * cache namespace; Node uses `directory`, which defaults to `.wasmer`.
     */
    cache?: false | "memory" | CacheOptions;
}
export interface CacheOptions {
    /** Node-only cache root, resolved when the client is created. */
    directory?: string;
    /** Logical browser cache namespace. */
    namespace?: string;
    /** Read existing entries without writing new ones. */
    readOnly?: boolean;
}
export type PackageSource = string | Uint8Array | Package;
export type CommandSelector = string | Package | CommandRef;
export type FileContents = string | Uint8Array;
/** A WASI/WASIX command referencing a named module in its package. */
export interface PackageCommandDefinition {
    module: string;
}
/** Executable content used to create a package without a WEBC archive. */
export interface PackageDefinition {
    modules: Readonly<Record<string, Uint8Array>>;
    commands: Readonly<Record<string, PackageCommandDefinition>>;
    /** Command name; inferred when there is exactly one command. */
    entrypoint?: string;
    /** Bundled files at canonical absolute guest paths, e.g. /data/config.json. */
    files?: Readonly<Record<string, FileContents>>;
}
export interface WispConnectionRequest {
    /** The endpoint that failed, when retrying a configured WISP server. */
    url?: string;
    /** The connection error that caused the SDK to request another endpoint. */
    error?: Error;
}
export type WispUrlProvider = (request: WispConnectionRequest) => string | Promise<string>;
export type NetworkPolicy = {
    mode: "disabled";
} | {
    mode: "host";
}
/** Browser virtual TCP and HTTP ingress, with no external egress. */
 | {
    mode: "http";
    /** Omit to share localhost with this client; [] isolates, [sandbox] links explicitly. */
    peers?: readonly Sandbox[];
}
/** Browser TCP/DNS egress over WISP, plus browser HTTP ingress. */
 | {
    mode: "wisp";
    /** Omit to share localhost with this client; [] isolates, [sandbox] links explicitly. */
    peers?: readonly Sandbox[];
    /** Initial endpoint. The connection is opened lazily on first network egress. */
    url?: string;
    dnsUrl?: string;
    /** Supplies an endpoint when one is missing or the current endpoint fails. */
    requestUrl?: WispUrlProvider;
};
export type PackageLoadPhase = "resolving" | "downloading" | "loading" | "ready";
/** Decoded package bytes; cache hits and local sources add zero download bytes. */
export interface DownloadProgress {
    readonly downloadedBytes: number;
    readonly totalBytes: number | null;
    /** Download completion from 0–100, or null while indeterminate. */
    readonly percent: number | null;
}
export interface PackageProgress {
    readonly id: string;
    readonly phase: PackageLoadPhase;
    readonly cached: boolean;
    readonly download: DownloadProgress;
}
/** A snapshot, not a delta. Download completion does not imply load readiness. */
export interface PackageLoadProgress {
    readonly phase: PackageLoadPhase;
    readonly download: DownloadProgress;
    readonly packages: readonly PackageProgress[];
}
export interface PackageLoadOptions {
    /** Short synchronous observer. Exceptions detach it without failing the load. */
    onProgress?: (progress: PackageLoadProgress) => void;
    signal?: AbortSignal;
}
export interface SandboxOptions {
    /** Package acquisition only, before the remaining sandbox setup. */
    onPackageProgress?: (progress: PackageLoadProgress) => void;
    signal?: AbortSignal;
    packages?: readonly PackageSource[];
    files?: Readonly<Record<string, FileContents>>;
    env?: Readonly<Record<string, string>>;
    network?: NetworkPolicy;
    /** The command used by `sandbox.shell()` and `sandbox.sh`. */
    shell?: CommandSelector;
}
export interface Packages {
    /** Create an in-memory package. Module and file bytes are copied. */
    create(definition: PackageDefinition): Promise<Package>;
    /**
     * Resolve a registry package, WEBC bytes, or raw WASI/WASIX bytes.
     * Raw modules must export `_start`; their command and entrypoint are `main`.
     */
    load(source: PackageSource, options?: PackageLoadOptions): Promise<Package>;
    /** Load concurrently, sharing downloads and preserving input order. */
    loadMany(sources: readonly PackageSource[], options?: PackageLoadOptions): Promise<Package[]>;
}
export interface Sandboxes {
    create(options?: SandboxOptions): Promise<Sandbox>;
}
export interface InstallPackageOptions extends PackageLoadOptions {
    /** Select one command exported by this package as the sandbox's shell. */
    asShell?: string;
}
export interface CommandOptions {
    cwd?: string;
    env?: Readonly<Record<string, string>>;
}
export interface RunOptions {
    stdin?: string | Uint8Array;
    timeoutMs?: number;
    outputBytes?: number;
    /** Throw a ProcessExitError when the process is unsuccessful. Defaults to true. */
    check?: boolean;
}
export type OutputMode = "pipe" | "capture" | "discard";
export interface SpawnOptions {
    timeoutMs?: number;
    outputBytes?: number;
    stdin?: "pipe" | "closed";
    stdout?: OutputMode;
    stderr?: OutputMode;
    /** Attach a process-tree terminal. This implies piped stdin/stdout/stderr. */
    terminal?: boolean | TerminalOptions;
}
export interface TerminalOptions {
    columns?: number;
    rows?: number;
}
export type ExitReason = "exited" | "terminated" | "timeout";
export interface FileStat {
    kind: "file" | "directory";
    size: number;
}
export interface DirectoryEntry extends FileStat {
    name: string;
}
/** Managed HTTP host used by browser port exposure when no origin is supplied. */
export declare const DEFAULT_SERVICE_WORKER_ORIGIN = "https://default.local.wasmer.site/";
export interface ExposePortOptions {
    /**
     * The origin of a standalone Wasmer HTTP host. Defaults to
     * {@link DEFAULT_SERVICE_WORKER_ORIGIN}.
     */
    serviceWorker?: string | URL;
    /** Time allowed for the guest to begin listening. Defaults to 30 seconds. */
    timeoutMs?: number;
}
export interface PortListenerOptions {
    /** Listener discovery interval. Defaults to 50 milliseconds. */
    intervalMs?: number;
    /** Called when a previously observed listener closes. */
    onClose?: (port: number) => void;
}
export interface BrowserIframeOptions {
    title?: string;
    className?: string;
    /**
     * Sandbox capabilities granted to guest content. Browser service workers
     * require `allow-same-origin`; use a dedicated preview origin when running
     * untrusted HTML with scripts.
     */
    sandbox?: readonly string[] | false;
}
export type WasmerErrorCode = "CLIENT_CLOSED" | "SANDBOX_CLOSED" | "INVALID_ARGUMENT" | "INVALID_PACKAGE_SOURCE" | "PACKAGE_NOT_FOUND" | "PACKAGE_LOAD_FAILED" | "PACKAGE_NOT_INSTALLED" | "PACKAGE_HAS_NO_ENTRYPOINT" | "COMMAND_NOT_FOUND" | "COMMAND_AMBIGUOUS" | "SHELL_NOT_CONFIGURED" | "CAPABILITY_UNAVAILABLE" | "INVALID_PATH" | "FILESYSTEM_ERROR" | "TIMEOUT" | "PROCESS_EXITED" | "PROCESS_TERMINATED" | "INVALID_UTF8" | "EXECUTION_ERROR" | "TASK_ERROR" | "INTERNAL_ERROR" | "IO_ERROR" | "INITIALIZATION_ERROR" | "TARGET_ERROR";
/** An SDK failure with a machine-readable, currently provisional `code`. */
export declare class WasmerError extends Error {
    readonly code: WasmerErrorCode;
    constructor(message: string, code: WasmerErrorCode, options?: {
        cause?: unknown;
    });
    static is(error: unknown, code?: WasmerErrorCode): error is WasmerError;
}
/** A checked command completed unsuccessfully; `output` holds the details. */
export declare class ProcessExitError extends Error {
    readonly output: Output;
    constructor(output: Output);
    get code(): "PROCESS_EXITED" | "PROCESS_TERMINATED" | "TIMEOUT";
}
export declare class Wasmer {
    #private;
    /** Package acquisition operations for this client. */
    readonly packages: Packages;
    /** Sandbox creation operations for this client. */
    readonly sandboxes: Sandboxes;
    constructor(options?: WasmerOptions);
    /**
     * Compatibility factory for callers that want initialization errors before
     * receiving the client. New code should prefer `new Wasmer(options)`.
     */
    static create<T extends Wasmer>(this: new (options?: WasmerOptions) => T, options?: WasmerOptions): Promise<T>;
    /** Target-specific initialization; the Node entrypoint overrides this. */
    protected static initializeCore(options: WasmerOptions): Promise<WasmerCore>;
    /** Wait for the target runtime to finish initializing. */
    ready(): Promise<this>;
    /**
     * Resolve a registry package, WEBC bytes, or raw WASI/WASIX bytes.
     * Raw modules must export `_start`; their command and entrypoint are `main`.
     * @deprecated Use `wasmer.packages.load(source)`.
     */
    loadPackage(source: string | Uint8Array): Promise<Package>;
    /** @deprecated Use `wasmer.sandboxes.create(options)`. */
    createSandbox(options?: SandboxOptions): Promise<Sandbox>;
    /** Close the client and release its workers and runtime resources. */
    close(): Promise<void>;
    /** @deprecated Use {@link Wasmer.close}. */
    shutdown(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
    protected closeCore(client: WasmerCore): Promise<void>;
    private getCore;
}
export declare class Package {
    constructor(core: PackageCore);
    get id(): string;
    get commands(): readonly string[];
    /** The command run when this package is used directly as a selector. */
    get entrypoint(): string | undefined;
    /**
     * Select a named command from this package, resolving name collisions
     * between installed packages.
     */
    command(name: string): CommandRef;
}
/** A command explicitly qualified by its package. */
export declare class CommandRef {
    readonly pkg: Package;
    readonly name: string;
    constructor(pkg: Package, name: string);
}
export type ShellValue = string | number | URL | readonly (string | number | URL)[];
export declare class Sandbox {
    #private;
    readonly wasmer: Wasmer;
    readonly fs: SandboxFileSystem;
    readonly ports: Ports;
    readonly network: SandboxNetwork;
    constructor(wasmer: Wasmer, core: SandboxCore, shell?: CommandSelector, networkBridge?: NetworkBridge);
    command(selector: CommandSelector, args?: readonly string[] | CommandOptions, options?: CommandOptions): Command;
    /**
     * Build a command that runs `script` through the sandbox's configured
     * shell. Configure one with `SandboxOptions.shell` or
     * `installPackage(source, { asShell })`.
     */
    shell(script: string, options?: CommandOptions): Command;
    /**
     * Tagged-template shell: interpolated values are escaped as argument data,
     * and an interpolated array expands to individually escaped arguments.
     */
    sh(strings: TemplateStringsArray, ...values: readonly ShellValue[]): Command;
    installPackage(source: PackageSource, options?: InstallPackageOptions): Promise<Package>;
    close(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
}
interface NetworkBridge {
    close(): void;
    setUrl?(url: string): void;
}
/** Runtime controls for a sandbox's configured network provider. */
export interface SandboxNetwork {
    /** Replace the browser WISP endpoint and close existing WISP connections. */
    setWispUrl(url: string): void;
}
/** Guest port facilities for one sandbox. */
export declare class Ports {
    #private;
    constructor(core: SandboxCore);
    /**
     * Wait until a guest TCP listener accepts connections on `port`.
     *
     * The probe uses the sandbox's own network policy: it observes exactly
     * what the guest exposed, and fails with `CAPABILITY_UNAVAILABLE` when
     * networking is disabled.
     *
     * Browser virtual networks observe the listener without connecting. Other
     * targets open and immediately close a real TCP connection; use an
     * application readiness signal there for single-client servers.
     */
    wait(port: number, options?: {
        timeoutMs?: number;
    }): Promise<void>;
    /**
     * Expose a guest HTTP listener at the root of a standalone Wasmer HTTP host.
     * The sandbox must use `network: { mode: "http" }`.
     */
    expose(port: number, options?: ExposePortOptions): Promise<BrowserServer>;
    /**
     * Observe TCP listeners opened by browser guests. The protocol may not be HTTP.
     *
     * Existing listeners are delivered immediately. A port is delivered again
     * if its listener closes and a later process binds it again.
     */
    onListen(listener: (port: number) => void, options?: PortListenerOptions): () => void;
    /** Close every browser HTTP route owned by this sandbox. */
    close(): Promise<void>;
}
/** A service-worker route to one HTTP listener inside a browser sandbox. */
export declare class BrowserServer {
    #private;
    readonly url: URL;
    private readonly id;
    private readonly channel;
    private readonly onClose;
    constructor(url: URL, id: string, channel: MessagePort, onClose: () => void);
    /** Create an iframe pointed at this server. */
    createIframe(options?: BrowserIframeOptions): HTMLIFrameElement;
    close(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
}
/**
 * A reusable, immutable execution description. Each `run()` or `spawn()`
 * starts an independent process.
 */
export declare class Command {
    #private;
    constructor(build: () => CommandCore);
    run(options?: RunOptions): Promise<Output>;
    spawn(options?: SpawnOptions): Promise<Process>;
}
export declare class CapturedOutput {
    readonly bytes: Uint8Array;
    readonly truncated: boolean;
    constructor(bytes: Uint8Array, truncated: boolean);
    text(): string;
}
export declare class Output {
    readonly exitCode: number;
    readonly reason: ExitReason;
    readonly stdout: CapturedOutput;
    readonly stderr: CapturedOutput;
    constructor(exitCode: number, reason: ExitReason, stdout: CapturedOutput, stderr: CapturedOutput);
    static fromCore(core: {
        exitCode: number;
        reason: string;
        stdout: Uint8Array;
        stderr: Uint8Array;
        stdoutTruncated: boolean;
        stderrTruncated: boolean;
    }): Output;
    /** True only when the guest exited on its own with a zero status. */
    get ok(): boolean;
    /** Check success and decode stdout. */
    text(): string;
    check(): this;
}
export declare class Process {
    #private;
    readonly stdin: WritableBytes | null;
    readonly stdout: ReadableBytes | null;
    readonly stderr: ReadableBytes | null;
    constructor(core: ProcessCore, streams: {
        stdin: boolean;
        stdout: boolean;
        stderr: boolean;
    });
    get id(): number;
    wait(options?: {
        check?: boolean;
    }): Promise<Output>;
    /** Ask the guest to exit; escalate to a forced kill after the grace period. */
    terminate(options?: {
        gracePeriodMs?: number;
    }): Promise<void>;
    /** Immediate forced termination. */
    kill(): Promise<void>;
    /** Resize the attached terminal. */
    resizeTerminal(columns: number, rows: number): void;
}
/** Writable guest stdin. Closing it sends EOF; it does not kill the process. */
export declare class WritableBytes {
    #private;
    constructor(core: ProcessCore);
    write(data: string | Uint8Array): Promise<void>;
    close(): Promise<void>;
    toWritableStream(): WritableStream<Uint8Array>;
}
/** A readable byte stream with guaranteed async iteration. */
export declare class ReadableBytes implements AsyncIterable<Uint8Array> {
    #private;
    constructor(read: (size: number) => Promise<Uint8Array | null>);
    [Symbol.asyncIterator](): AsyncGenerator<Uint8Array>;
    /** Incrementally decoded lines; never assumes one chunk is one line. */
    lines(): AsyncGenerator<string>;
    toReadableStream(): ReadableStream<Uint8Array>;
}
export declare class SandboxFileSystem {
    #private;
    constructor(core: SandboxCore);
    writeFile(path: string, contents: FileContents): Promise<void>;
    writeText(path: string, text: string): Promise<void>;
    readFile(path: string): Promise<Uint8Array>;
    readText(path: string): Promise<string>;
    mkdir(path: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    readDir(path: string): Promise<readonly DirectoryEntry[]>;
    stat(path: string): Promise<FileStat>;
    remove(path: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    rename(from: string, to: string): Promise<void>;
}
export {};
//# sourceMappingURL=index.d.ts.map