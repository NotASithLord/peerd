import type { NodeNetworkMethod } from "./node-network.js";
export declare const NETWORK_RPC_CONTROL_BYTES = 16;
/** Size one synchronous worker response without a blanket payload reserve. */
export declare function networkResponseBufferBytes(method: NodeNetworkMethod, args: readonly unknown[]): number;
//# sourceMappingURL=node-network-rpc.d.ts.map