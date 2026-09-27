type SymbolHost = ((description?: string) => symbol) & {
    dispose?: symbol;
    asyncDispose?: symbol;
};
interface ErrorHost {
    new (): {
        stack?: string;
    };
    captureStackTrace?: (target: object, constructorOpt?: Function) => void;
    prepareStackTrace?: Function;
    stackTraceLimit?: number;
}
export declare function installNodeSymbols(symbol?: SymbolHost): string[];
export declare function installNodeStackTrace(error?: ErrorHost): boolean;
export {};
//# sourceMappingURL=node-compat.d.ts.map