/** Experimental worker-to-native filesystem protocol used by the iOS prototype. */
export declare const HOST_FS_MESSAGE = "wasmer-filesystem-rpc";
export interface HostFileSystemRequest {
    type: typeof HOST_FS_MESSAGE;
    mount: number;
    method: string;
    args: unknown[];
    response: SharedArrayBuffer;
    /** Worker accepts raw byte replies; older embedders can still reply with JSON. */
    binary?: boolean;
}
export declare function isHostFileSystemRequest(value: unknown): value is HostFileSystemRequest;
export declare function installHostFileSystemWorkerBridge(route?: (request: HostFileSystemRequest) => boolean): void;
/** Always wake a waiting worker, including for bridge errors and oversized replies. */
export declare function respondToHostFileSystem(request: HostFileSystemRequest, result: unknown): void;
//# sourceMappingURL=host-filesystem.d.ts.map