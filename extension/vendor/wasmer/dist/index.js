import "./node-compat.js";
import init, { setSDKUrl, setWorkerUrl, WasmerCore, PackageLoadCancellation as CorePackageLoadCancellation, } from "../pkg/wasmer_sdk_js.js";
/** Managed HTTP host used by browser port exposure when no origin is supplied. */
export const DEFAULT_SERVICE_WORKER_ORIGIN = "https://default.local.wasmer.site/";
/** An SDK failure with a machine-readable, currently provisional `code`. */
export class WasmerError extends Error {
    code;
    constructor(message, code, options) {
        super(message, options);
        this.code = code;
        this.name = "WasmerError";
    }
    static is(error, code) {
        return (error instanceof WasmerError && (code === undefined || error.code === code));
    }
}
/** A checked command completed unsuccessfully; `output` holds the details. */
export class ProcessExitError extends Error {
    output;
    constructor(output) {
        super(describeExit(output));
        this.output = output;
        this.name = "ProcessExitError";
    }
    get code() {
        switch (this.output.reason) {
            case "terminated":
                return "PROCESS_TERMINATED";
            case "timeout":
                return "TIMEOUT";
            default:
                return "PROCESS_EXITED";
        }
    }
}
const STDERR_EXCERPT_BYTES = 512;
function describeExit(output) {
    let base;
    switch (output.reason) {
        case "terminated":
            base = "process was terminated before completing";
            break;
        case "timeout":
            base = "process timed out";
            break;
        default:
            base = `process exited unsuccessfully with status ${output.exitCode}`;
    }
    const stderr = output.stderr.bytes;
    const start = Math.max(0, stderr.length - STDERR_EXCERPT_BYTES);
    const excerpt = new TextDecoder().decode(stderr.subarray(start)).trim();
    if (!excerpt)
        return base;
    return `${base}\nstderr: ${start > 0 ? "…" : ""}${excerpt}`;
}
/** Rewrap errors thrown by the wasm core into `WasmerError`. */
async function rethrow(work) {
    try {
        return await work;
    }
    catch (error) {
        throw toWasmerError(error);
    }
}
function rethrowSync(work) {
    try {
        return work();
    }
    catch (error) {
        throw toWasmerError(error);
    }
}
function toWasmerError(error) {
    if (error instanceof Error &&
        !(error instanceof WasmerError) &&
        error.name === "WasmerError") {
        const code = error.code;
        if (typeof code === "string") {
            return new WasmerError(error.message, code, {
                cause: error,
            });
        }
    }
    return error;
}
const packageCores = new WeakMap();
const sandboxCores = new WeakMap();
let browserInitialization;
const MAX_WASM32_SIZE = 0xffff_ffff;
export class Wasmer {
    /** Package acquisition operations for this client. */
    packages;
    /** Sandbox creation operations for this client. */
    sandboxes;
    #options;
    #core;
    constructor(options = {}) {
        this.#options = {
            ...options,
            outputBytes: options.outputBytes === undefined
                ? undefined
                : validateOutputBytes(options.outputBytes),
            parallelism: options.parallelism === undefined
                ? undefined
                : validateParallelism(options.parallelism),
        };
        this.packages = new PackagesService((sources, options) => this.#loadPackages(sources, options), (definition) => this.#createPackage(definition));
        this.sandboxes = new SandboxesService((options) => this.#createSandbox(options));
    }
    /**
     * Compatibility factory for callers that want initialization errors before
     * receiving the client. New code should prefer `new Wasmer(options)`.
     */
    static async create(options = {}) {
        const wasmer = new this(options);
        await wasmer.ready();
        return wasmer;
    }
    /** Target-specific initialization; the Node entrypoint overrides this. */
    static async initializeCore(options) {
        browserInitialization ??= init(options.wasm === undefined
            ? undefined
            : { module_or_path: options.wasm })
            .then(() => undefined)
            .catch((error) => {
            browserInitialization = undefined;
            throw error;
        });
        await browserInitialization;
        setSDKUrl(new URL("../pkg/wasmer_sdk_js.js", import.meta.url).href);
        setWorkerUrl(new URL("./browser-worker.js", import.meta.url).href);
        return WasmerCore.create({
            outputBytes: options.outputBytes,
            parallelism: options.parallelism ?? 2,
            cache: browserCacheOptions(options.cache),
        });
    }
    /** Wait for the target runtime to finish initializing. */
    async ready() {
        await this.getCore();
        return this;
    }
    /**
     * Resolve a registry package, WEBC bytes, or raw WASI/WASIX bytes.
     * Raw modules must export `_start`; their command and entrypoint are `main`.
     * @deprecated Use `wasmer.packages.load(source)`.
     */
    async loadPackage(source) {
        return this.packages.load(source);
    }
    /** @deprecated Use `wasmer.sandboxes.create(options)`. */
    async createSandbox(options = {}) {
        return this.sandboxes.create(options);
    }
    async #createPackage(definition) {
        // Snapshot before runtime initialization can yield. In particular Buffer.slice()
        // would retain caller-owned storage, so construct fresh Uint8Arrays instead.
        let snapshot;
        try {
            const copy = (bytes) => {
                if (!(bytes instanceof Uint8Array)) {
                    throw new TypeError("module and binary file contents must be Uint8Array values");
                }
                return new Uint8Array(bytes);
            };
            snapshot = {
                ...definition,
                modules: Object.fromEntries(Object.entries(definition.modules).map(([name, bytes]) => [name, copy(bytes)])),
                commands: Object.fromEntries(Object.entries(definition.commands).map(([name, command]) => [name, { ...command }])),
                files: Object.fromEntries(Object.entries(definition.files ?? {}).map(([path, contents]) => [
                    path,
                    typeof contents === "string" ? encode(contents) : copy(contents),
                ])),
            };
        }
        catch (cause) {
            throw new WasmerError(`invalid package definition: ${String(cause)}`, "INVALID_ARGUMENT", { cause });
        }
        const client = await this.getCore();
        return new Package(await rethrow(client.createPackage(snapshot)));
    }
    async #loadPackages(sources, options) {
        options.signal?.throwIfAborted();
        // Snapshot caller-owned bytes before initialization yields.
        const reused = sources.filter((source) => source instanceof Package);
        const snapshots = sources.filter((source) => !(source instanceof Package))
            .map(source => typeof source === "string" ? source : new Uint8Array(source));
        const client = await this.getCore();
        options.signal?.throwIfAborted();
        const cancellation = new CorePackageLoadCancellation();
        const cancel = () => cancellation.cancel();
        options.signal?.addEventListener("abort", cancel, { once: true });
        let observer = options.onProgress;
        const onProgress = observer ? (progress) => {
            if (!observer || options.signal?.aborted)
                return;
            try {
                const entries = new Map(progress.packages.map(entry => [entry.id, entry]));
                for (const pkg of reused) {
                    if (!entries.has(pkg.id))
                        entries.set(pkg.id, {
                            id: pkg.id, phase: "ready", cached: true,
                            download: { downloadedBytes: 0, totalBytes: 0, percent: 100 },
                        });
                }
                observer({ ...progress, packages: [...entries.values()] });
            }
            catch (error) {
                observer = undefined;
                console.error("Package progress observer failed", error);
            }
        } : undefined;
        try {
            const packages = await rethrow(client.loadPackages(snapshots, onProgress, cancellation));
            options.signal?.throwIfAborted();
            let next = 0;
            return sources.map(source => source instanceof Package ? source : new Package(packages[next++]));
        }
        catch (error) {
            options.signal?.throwIfAborted();
            throw error;
        }
        finally {
            observer = undefined;
            options.signal?.removeEventListener("abort", cancel);
            cancellation.free();
        }
    }
    async #createSandbox(options) {
        const client = await this.getCore();
        const sources = options.packages ?? [];
        const loaded = await this.packages.loadMany(sources, { onProgress: options.onPackageProgress, signal: options.signal });
        const packages = loaded;
        options.signal?.throwIfAborted();
        const builder = client.sandbox();
        for (const pkg of packages) {
            builder.package(packageCores.get(pkg));
        }
        for (const [path, contents] of Object.entries(options.files ?? {})) {
            builder.file(path, encode(contents));
        }
        for (const [key, value] of Object.entries(options.env ?? {})) {
            builder.env(key, value);
        }
        const network = options.network ?? { mode: "disabled" };
        let networkBridge;
        if (network.mode === "wisp") {
            if (typeof window === "undefined") {
                throw new WasmerError("WISP networking is only available from the browser entrypoint", "CAPABILITY_UNAVAILABLE");
            }
            const wisp = await import("./wisp-network.js");
            wisp.installWispNetworkGlobals();
            const bridge = new wisp.WispNetworkBridge(network.url, network.dnsUrl, network.requestUrl);
            networkBridge = bridge;
            builder.networkWisp(bridge);
        }
        else {
            builder.network(network.mode);
        }
        try {
            if ((network.mode === "http" || network.mode === "wisp") && network.peers !== undefined) {
                builder.restrictNetworkPeers();
                for (const peer of new Set(network.peers)) {
                    if (peer.wasmer !== this) {
                        throw new WasmerError("network peers must belong to the same Wasmer client", "INVALID_ARGUMENT");
                    }
                    rethrowSync(() => builder.addNetworkPeer(sandboxCores.get(peer)));
                }
            }
            const core = await rethrow(builder.start());
            return new Sandbox(this, core, options.shell, networkBridge);
        }
        catch (error) {
            networkBridge?.close();
            throw error;
        }
    }
    /** Close the client and release its workers and runtime resources. */
    async close() {
        if (!this.#core)
            return;
        const client = await this.#core;
        await this.closeCore(client);
    }
    /** @deprecated Use {@link Wasmer.close}. */
    async shutdown() {
        await this.close();
    }
    async [Symbol.asyncDispose]() {
        await this.close();
    }
    async closeCore(client) {
        await rethrow(client.shutdown());
    }
    getCore() {
        const implementation = this.constructor;
        return rethrow((this.#core ??= implementation.initializeCore(this.#options)));
    }
}
function browserCacheOptions(cache) {
    if (cache === false)
        return { mode: "disabled" };
    if (cache === "memory")
        return { mode: "memory" };
    if (cache?.directory !== undefined) {
        throw new WasmerError("`cache.directory` is only available from the Node entrypoint", "INVALID_ARGUMENT");
    }
    return {
        mode: "browser",
        namespace: cache?.namespace,
        readOnly: cache?.readOnly,
    };
}
class PackagesService {
    loadPackages;
    createPackage;
    constructor(loadPackages, createPackage) {
        this.loadPackages = loadPackages;
        this.createPackage = createPackage;
    }
    create(definition) {
        return this.createPackage(definition);
    }
    async load(source, options = {}) {
        return (await this.loadMany([source], options))[0];
    }
    loadMany(sources, options = {}) {
        return this.loadPackages(sources, options);
    }
}
class SandboxesService {
    #create;
    constructor(create) {
        this.#create = create;
    }
    create(options = {}) {
        return this.#create(options);
    }
}
export class Package {
    constructor(core) {
        packageCores.set(this, core);
    }
    get id() {
        return packageCores.get(this).id;
    }
    get commands() {
        return packageCores.get(this).commands;
    }
    /** The command run when this package is used directly as a selector. */
    get entrypoint() {
        return packageCores.get(this).entrypoint ?? undefined;
    }
    /**
     * Select a named command from this package, resolving name collisions
     * between installed packages.
     */
    command(name) {
        if (!packageCores.get(this).hasCommand(name)) {
            throw new WasmerError(`package \`${this.id}\` does not export the command \`${name}\``, "COMMAND_NOT_FOUND");
        }
        return new CommandRef(this, name);
    }
}
/** A command explicitly qualified by its package. */
export class CommandRef {
    pkg;
    name;
    constructor(pkg, name) {
        this.pkg = pkg;
        this.name = name;
    }
}
export class Sandbox {
    wasmer;
    fs;
    ports;
    network;
    #core;
    #networkBridge;
    #shell;
    constructor(wasmer, core, shell, networkBridge) {
        this.wasmer = wasmer;
        this.#core = core;
        sandboxCores.set(this, core);
        this.fs = new SandboxFileSystem(core);
        this.ports = new Ports(core);
        this.network = new SandboxNetworkService(networkBridge);
        this.#shell = shell;
        this.#networkBridge = networkBridge;
    }
    command(selector, args = [], options = {}) {
        if (!Array.isArray(args)) {
            options = args;
            args = [];
        }
        const argv = [...args];
        const settings = { ...options };
        const core = this.#core;
        return new Command(() => {
            let command;
            if (selector instanceof CommandRef) {
                command = core.commandRef(packageCores.get(selector.pkg), selector.name);
            }
            else if (selector instanceof Package) {
                command = core.commandPackage(packageCores.get(selector));
            }
            else {
                command = core.command(selector);
            }
            command.args(argv);
            if (settings.cwd)
                command.currentDir(settings.cwd);
            for (const [key, value] of Object.entries(settings.env ?? {})) {
                command.env(key, value);
            }
            return command;
        });
    }
    /**
     * Build a command that runs `script` through the sandbox's configured
     * shell. Configure one with `SandboxOptions.shell` or
     * `installPackage(source, { asShell })`.
     */
    shell(script, options = {}) {
        return this.command(this.#requireShell(), ["-c", script], options);
    }
    /**
     * Tagged-template shell: interpolated values are escaped as argument data,
     * and an interpolated array expands to individually escaped arguments.
     */
    sh(strings, ...values) {
        let script = strings[0] ?? "";
        for (let index = 0; index < values.length; index += 1) {
            script += escapeShellValue(values[index]) + (strings[index + 1] ?? "");
        }
        return this.shell(script);
    }
    async installPackage(source, options = {}) {
        options.signal?.throwIfAborted();
        const loaded = await this.wasmer.packages.load(source, options);
        options.signal?.throwIfAborted();
        const core = await rethrow(this.#core.installPackageRef(packageCores.get(loaded)));
        const pkg = new Package(core);
        if (options.asShell !== undefined) {
            this.#shell = pkg.command(options.asShell);
        }
        return pkg;
    }
    async close() {
        try {
            await this.ports.close();
            await rethrow(this.#core.close());
        }
        finally {
            this.#networkBridge?.close();
        }
    }
    async [Symbol.asyncDispose]() {
        await this.close();
    }
    #requireShell() {
        if (this.#shell === undefined) {
            throw new WasmerError("no shell is configured for this sandbox; install a shell-providing " +
                "package and select it with `SandboxOptions.shell` or " +
                "`installPackage(source, { asShell })`", "SHELL_NOT_CONFIGURED");
        }
        return this.#shell;
    }
}
class SandboxNetworkService {
    #bridge;
    constructor(bridge) {
        this.#bridge = bridge;
    }
    setWispUrl(url) {
        if (!this.#bridge?.setUrl) {
            throw new WasmerError("this sandbox does not use browser WISP networking", "CAPABILITY_UNAVAILABLE");
        }
        this.#bridge.setUrl(url);
    }
}
/** Guest port facilities for one sandbox. */
export class Ports {
    #core;
    #servers = new Set();
    #watchers = new Set();
    constructor(core) {
        this.#core = core;
    }
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
    async wait(port, options = {}) {
        const validPort = validateInteger("port", port, 1, 65_535);
        const timeoutMs = validateTimeoutMs(options.timeoutMs ?? 30_000);
        let browserNetwork = false;
        try {
            this.#core.httpListeningPorts();
            browserNetwork = true;
        }
        catch (error) {
            if (!WasmerError.is(toWasmerError(error), "CAPABILITY_UNAVAILABLE"))
                throw error;
        }
        if (browserNetwork) {
            // Observing readiness must not consume a single-client server's connection.
            await waitForTcpListener(this.#core, validPort, timeoutMs);
        }
        else {
            await rethrow(this.#core.waitForPort(validPort, timeoutMs));
        }
    }
    /**
     * Expose a guest HTTP listener at the root of a standalone Wasmer HTTP host.
     * The sandbox must use `network: { mode: "http" }`.
     */
    async expose(port, options = {}) {
        if (typeof window === "undefined" || typeof MessageChannel === "undefined") {
            throw new WasmerError("ports.expose() is only available in a browser window", "CAPABILITY_UNAVAILABLE");
        }
        const validPort = validateInteger("port", port, 1, 65_535);
        const timeoutMs = validateTimeoutMs(options?.timeoutMs ?? 30_000);
        const target = await resolveServiceWorker(options?.serviceWorker ?? DEFAULT_SERVICE_WORKER_ORIGIN, timeoutMs);
        await waitForTcpListener(this.#core, validPort, timeoutMs);
        const id = createBrowserServerId();
        const channel = new MessageChannel();
        let server;
        const ready = deferred();
        channel.port1.addEventListener("message", (event) => {
            const message = asBridgeMessage(event.data);
            if (!message)
                return;
            if (message.type === "wasmer-sdk:http-ready" && message.serverId === id) {
                ready.resolve();
                return;
            }
            if (message.type === "wasmer-sdk:http-error" && message.serverId === id) {
                ready.reject(new WasmerError(message.error, "CAPABILITY_UNAVAILABLE"));
                return;
            }
            if (message.type !== "wasmer-sdk:http-request")
                return;
            void forwardHttpRequest(this.#core, validPort, channel.port1, message);
        });
        channel.port1.start();
        target.worker.postMessage({
            type: "wasmer-sdk:http-register",
            serverId: id,
        }, [channel.port2]);
        try {
            await withTimeout(ready.promise, timeoutMs, "the Wasmer service worker did not accept the HTTP route");
            server = new BrowserServer(new URL("/", target.origin), id, channel.port1, () => this.#servers.delete(server));
            this.#servers.add(server);
            return server;
        }
        catch (error) {
            channel.port1.close();
            throw error;
        }
    }
    /**
     * Observe TCP listeners opened by browser guests. The protocol may not be HTTP.
     *
     * Existing listeners are delivered immediately. A port is delivered again
     * if its listener closes and a later process binds it again.
     */
    onListen(listener, options = {}) {
        const intervalMs = validateInteger("intervalMs", options.intervalMs ?? 50, 10, 60_000);
        // Validate the network mode synchronously instead of failing later inside
        // an interval callback.
        rethrowSync(() => this.#core.httpListeningPorts());
        const observed = new Set();
        let timer;
        let active = true;
        const poll = () => {
            if (!active)
                return;
            try {
                const ports = this.#core.httpListeningPorts();
                if (ports === undefined) {
                    timer = setTimeout(poll, intervalMs);
                    return;
                }
                const current = new Set(ports);
                for (const port of current) {
                    if (!observed.has(port))
                        listener(port);
                }
                for (const port of observed) {
                    if (!current.has(port)) {
                        observed.delete(port);
                        options.onClose?.(port);
                    }
                }
                for (const port of current)
                    observed.add(port);
            }
            catch (error) {
                stop();
                queueMicrotask(() => {
                    throw toWasmerError(error);
                });
                return;
            }
            timer = setTimeout(poll, intervalMs);
        };
        const stop = () => {
            if (!active)
                return;
            active = false;
            if (timer !== undefined)
                clearTimeout(timer);
            this.#watchers.delete(stop);
        };
        this.#watchers.add(stop);
        poll();
        return stop;
    }
    /** Close every browser HTTP route owned by this sandbox. */
    async close() {
        for (const stop of [...this.#watchers])
            stop();
        await Promise.all([...this.#servers].map((server) => server.close()));
    }
}
/** A service-worker route to one HTTP listener inside a browser sandbox. */
export class BrowserServer {
    url;
    id;
    channel;
    onClose;
    #closed = false;
    constructor(url, id, channel, onClose) {
        this.url = url;
        this.id = id;
        this.channel = channel;
        this.onClose = onClose;
    }
    /** Create an iframe pointed at this server. */
    createIframe(options = {}) {
        if (typeof document === "undefined") {
            throw new WasmerError("createIframe() is only available in a browser document", "CAPABILITY_UNAVAILABLE");
        }
        const iframe = document.createElement("iframe");
        iframe.src = this.url.href;
        iframe.title = options.title ?? "Wasmer sandbox web server";
        if (options.className !== undefined)
            iframe.className = options.className;
        const capabilities = options.sandbox === undefined
            ? [
                "allow-downloads",
                "allow-forms",
                "allow-modals",
                "allow-popups",
                "allow-same-origin",
                "allow-scripts",
            ]
            : options.sandbox;
        if (capabilities !== false) {
            for (const capability of capabilities)
                iframe.sandbox.add(capability);
        }
        return iframe;
    }
    async close() {
        if (this.#closed)
            return;
        this.#closed = true;
        this.channel.postMessage({
            type: "wasmer-sdk:http-close",
            serverId: this.id,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        this.channel.close();
        this.onClose();
    }
    async [Symbol.asyncDispose]() {
        await this.close();
    }
}
function asBridgeMessage(value) {
    if (typeof value !== "object" || value === null || !("type" in value))
        return undefined;
    const type = value.type;
    if (type !== "wasmer-sdk:http-request" &&
        type !== "wasmer-sdk:http-ready" &&
        type !== "wasmer-sdk:http-error") {
        return undefined;
    }
    return value;
}
async function forwardHttpRequest(core, port, channel, request) {
    try {
        const response = await rethrow(core.handleHttpRequest(port, request.method, request.path, request.headers, request.body));
        const body = Uint8Array.from(response.body);
        channel.postMessage({
            type: "wasmer-sdk:http-response",
            serverId: request.serverId,
            requestId: request.requestId,
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            body,
        }, [body.buffer]);
    }
    catch (error) {
        channel.postMessage({
            type: "wasmer-sdk:http-response",
            serverId: request.serverId,
            requestId: request.requestId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
const remoteServiceWorkers = new Map();
async function resolveServiceWorker(serviceWorker, timeoutMs) {
    let host;
    try {
        host = new URL(serviceWorker, window.location.href);
    }
    catch {
        throw new WasmerError("the service worker origin must be a valid URL", "INVALID_ARGUMENT");
    }
    if (host.protocol !== "http:" && host.protocol !== "https:") {
        throw new WasmerError("the service worker origin must use HTTP or HTTPS", "INVALID_ARGUMENT");
    }
    const origin = host.origin;
    let connection = remoteServiceWorkers.get(origin);
    if (!connection) {
        connection = connectRemoteServiceWorker(origin, timeoutMs);
        remoteServiceWorkers.set(origin, connection);
        void connection.catch(() => remoteServiceWorkers.delete(origin));
    }
    return withTimeout(connection, timeoutMs, `the Wasmer HTTP host at ${origin} did not become ready`);
}
async function connectRemoteServiceWorker(origin, timeoutMs) {
    if (!document.body) {
        throw new WasmerError("the document body must exist before connecting to a Wasmer HTTP host", "INITIALIZATION_ERROR");
    }
    const iframe = document.createElement("iframe");
    const hostUrl = new URL("/.wasmer/host.html", origin);
    hostUrl.searchParams.set("parentOrigin", window.location.origin);
    iframe.src = hostUrl.href;
    iframe.hidden = true;
    iframe.tabIndex = -1;
    iframe.setAttribute("aria-hidden", "true");
    const loaded = new Promise((resolve, reject) => {
        iframe.addEventListener("load", () => resolve(), { once: true });
        iframe.addEventListener("error", () => reject(new Error(`failed to load the Wasmer HTTP host at ${origin}`)), { once: true });
    });
    document.body.append(iframe);
    try {
        await withTimeout(loaded, timeoutMs, `the Wasmer HTTP host at ${origin} did not load`);
        if (!iframe.contentWindow) {
            throw new Error("the Wasmer HTTP host iframe has no content window");
        }
        const channel = new MessageChannel();
        const ready = new Promise((resolve, reject) => {
            channel.port1.addEventListener("message", (event) => {
                const message = event.data;
                if (message?.type === "wasmer-sdk:http-host-ready") {
                    resolve();
                }
                else if (message?.type === "wasmer-sdk:http-host-error") {
                    reject(new Error(typeof message.error === "string"
                        ? message.error
                        : "the Wasmer HTTP host failed to initialize"));
                }
            });
            channel.port1.start();
        });
        iframe.contentWindow.postMessage({ type: "wasmer-sdk:http-host-connect" }, origin, [channel.port2]);
        await withTimeout(ready, timeoutMs, `the Wasmer HTTP host at ${origin} did not connect`);
        return {
            origin,
            worker: {
                postMessage(message, transfer = []) {
                    channel.port1.postMessage(message, transfer);
                },
            },
        };
    }
    catch (error) {
        iframe.remove();
        throw error;
    }
}
async function waitForTcpListener(core, port, timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    while (!rethrowSync(() => core.isHttpPortListening(port))) {
        if (performance.now() >= deadline) {
            throw new WasmerError(`timed out waiting for the guest TCP listener on port ${port}`, "TIMEOUT");
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}
function createBrowserServerId() {
    if (typeof crypto.randomUUID === "function")
        return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}
async function withTimeout(promise, timeoutMs, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new WasmerError(message, "TIMEOUT")), timeoutMs);
    });
    try {
        return await Promise.race([promise, timeout]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
/**
 * A reusable, immutable execution description. Each `run()` or `spawn()`
 * starts an independent process.
 */
export class Command {
    #build;
    constructor(build) {
        this.#build = build;
    }
    async run(options = {}) {
        const timeoutMs = options.timeoutMs === undefined
            ? undefined
            : validateTimeoutMs(options.timeoutMs);
        const outputBytes = options.outputBytes === undefined
            ? undefined
            : validateOutputBytes(options.outputBytes);
        const core = this.#build();
        if (timeoutMs !== undefined)
            core.timeoutMs(timeoutMs);
        if (outputBytes !== undefined)
            core.outputBytes(outputBytes);
        if (options.stdin !== undefined)
            core.input(encode(options.stdin));
        const output = Output.fromCore(await rethrow(core.run()));
        if (options.check !== false && !output.ok) {
            throw new ProcessExitError(output);
        }
        return output;
    }
    async spawn(options = {}) {
        const timeoutMs = options.timeoutMs === undefined
            ? undefined
            : validateTimeoutMs(options.timeoutMs);
        const outputBytes = options.outputBytes === undefined
            ? undefined
            : validateOutputBytes(options.outputBytes);
        const terminal = options.terminal;
        const stdin = terminal ? "pipe" : (options.stdin ?? "closed");
        const stdout = terminal ? "pipe" : (options.stdout ?? "pipe");
        const stderr = terminal ? "pipe" : (options.stderr ?? "pipe");
        const terminalDimensions = validateTerminalOptions(terminal);
        const core = this.#build();
        if (timeoutMs !== undefined)
            core.timeoutMs(timeoutMs);
        if (outputBytes !== undefined)
            core.outputBytes(outputBytes);
        if (terminalDimensions) {
            core.terminal(terminalDimensions.columns, terminalDimensions.rows);
        }
        core.stdinMode(stdin);
        core.stdoutMode(stdout);
        core.stderrMode(stderr);
        const process = await rethrow(core.spawn());
        return new Process(process, {
            stdin: stdin === "pipe",
            stdout: stdout === "pipe",
            stderr: stderr === "pipe",
        });
    }
}
export class CapturedOutput {
    bytes;
    truncated;
    constructor(bytes, truncated) {
        this.bytes = bytes;
        this.truncated = truncated;
    }
    text() {
        return new TextDecoder().decode(this.bytes);
    }
}
export class Output {
    exitCode;
    reason;
    stdout;
    stderr;
    constructor(exitCode, reason, stdout, stderr) {
        this.exitCode = exitCode;
        this.reason = reason;
        this.stdout = stdout;
        this.stderr = stderr;
    }
    static fromCore(core) {
        return new Output(core.exitCode, core.reason, new CapturedOutput(core.stdout, core.stdoutTruncated), new CapturedOutput(core.stderr, core.stderrTruncated));
    }
    /** True only when the guest exited on its own with a zero status. */
    get ok() {
        return this.reason === "exited" && this.exitCode === 0;
    }
    /** Check success and decode stdout. */
    text() {
        this.check();
        return this.stdout.text();
    }
    check() {
        if (!this.ok)
            throw new ProcessExitError(this);
        return this;
    }
}
export class Process {
    stdin;
    stdout;
    stderr;
    #core;
    constructor(core, streams) {
        this.#core = core;
        this.stdin = streams.stdin ? new WritableBytes(core) : null;
        this.stdout = streams.stdout
            ? new ReadableBytes((size) => core.readStdout(size))
            : null;
        this.stderr = streams.stderr
            ? new ReadableBytes((size) => core.readStderr(size))
            : null;
    }
    get id() {
        return this.#core.id;
    }
    async wait(options = {}) {
        const output = Output.fromCore(await rethrow(this.#core.wait()));
        if (options.check && !output.ok)
            throw new ProcessExitError(output);
        return output;
    }
    /** Ask the guest to exit; escalate to a forced kill after the grace period. */
    async terminate(options = {}) {
        const gracePeriodMs = validateTimeoutMs(options.gracePeriodMs ?? 1_000, "gracePeriodMs");
        await rethrow(this.#core.terminate(gracePeriodMs));
    }
    /** Immediate forced termination. */
    async kill() {
        this.#core.kill();
    }
    /** Resize the attached terminal. */
    resizeTerminal(columns, rows) {
        rethrowSync(() => this.#core.resizeTerminal(validateInteger("terminal.columns", columns, 1, 0xffff_ffff), validateInteger("terminal.rows", rows, 1, 0xffff_ffff)));
    }
}
/** Writable guest stdin. Closing it sends EOF; it does not kill the process. */
export class WritableBytes {
    #core;
    constructor(core) {
        this.#core = core;
    }
    async write(data) {
        await rethrow(this.#core.writeStdin(encode(data)));
    }
    async close() {
        await rethrow(this.#core.closeStdin());
    }
    toWritableStream() {
        return new WritableStream({
            write: (chunk) => this.write(chunk),
            close: () => this.close(),
            abort: () => this.close(),
        });
    }
}
/** A readable byte stream with guaranteed async iteration. */
export class ReadableBytes {
    #read;
    constructor(read) {
        this.#read = read;
    }
    async *[Symbol.asyncIterator]() {
        for (;;) {
            const chunk = await rethrow(this.#read(64 * 1024));
            if (chunk === null)
                return;
            yield chunk;
        }
    }
    /** Incrementally decoded lines; never assumes one chunk is one line. */
    async *lines() {
        const decoder = new TextDecoder();
        let pending = "";
        for await (const chunk of this) {
            pending += decoder.decode(chunk, { stream: true });
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() ?? "";
            yield* lines;
        }
        pending += decoder.decode();
        if (pending)
            yield pending;
    }
    toReadableStream() {
        const iterator = this[Symbol.asyncIterator]();
        return new ReadableStream({
            async pull(controller) {
                const next = await iterator.next();
                if (next.done)
                    controller.close();
                else
                    controller.enqueue(next.value);
            },
            async cancel() {
                await iterator.return?.(undefined);
            },
        });
    }
}
export class SandboxFileSystem {
    #core;
    constructor(core) {
        this.#core = core;
    }
    async writeFile(path, contents) {
        await rethrow(this.#core.writeFile(path, encode(contents)));
    }
    async writeText(path, text) {
        await this.writeFile(path, text);
    }
    async readFile(path) {
        return rethrow(this.#core.readFile(path));
    }
    async readText(path) {
        return new TextDecoder().decode(await this.readFile(path));
    }
    async mkdir(path, options = {}) {
        await rethrow(this.#core.mkdir(path, options.recursive ?? false));
    }
    async readDir(path) {
        return rethrow(this.#core.readDir(path));
    }
    async stat(path) {
        return rethrow(this.#core.stat(path));
    }
    async remove(path, options = {}) {
        await rethrow(this.#core.remove(path, options.recursive ?? false));
    }
    async rename(from, to) {
        await rethrow(this.#core.rename(from, to));
    }
}
function encode(value) {
    return typeof value === "string" ? new TextEncoder().encode(value) : value;
}
function validateTimeoutMs(value, name = "timeoutMs") {
    return validateInteger(name, value, 0, Number.MAX_SAFE_INTEGER);
}
function validateOutputBytes(value) {
    return validateInteger("outputBytes", value, 0, MAX_WASM32_SIZE);
}
function validateParallelism(value) {
    return validateInteger("parallelism", value, 1, MAX_WASM32_SIZE);
}
function validateTerminalOptions(terminal) {
    if (!terminal)
        return undefined;
    const dimensions = typeof terminal === "object" ? terminal : {};
    return {
        columns: validateInteger("terminal.columns", dimensions.columns ?? 80, 1, 0xffff_ffff),
        rows: validateInteger("terminal.rows", dimensions.rows ?? 24, 1, 0xffff_ffff),
    };
}
function validateInteger(name, value, minimum, maximum) {
    if (!Number.isFinite(value) ||
        !Number.isInteger(value) ||
        value < minimum ||
        value > maximum) {
        throw new WasmerError(`\`${name}\` must be an integer between ${minimum} and ${maximum}, inclusive`, "INVALID_ARGUMENT");
    }
    return value;
}
function escapeShellValue(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => escapeShellWord(String(entry))).join(" ");
    }
    return escapeShellWord(String(value));
}
function escapeShellWord(value) {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
//# sourceMappingURL=index.js.map