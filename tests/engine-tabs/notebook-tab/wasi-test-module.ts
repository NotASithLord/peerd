// wasi-test-module.ts — hand-assembled wasm32-wasi COMMAND modules for the
// peerd:wasi tests.
//
// why hand-assembled: the repo has no wasm toolchain (and must not grow one for
// a test fixture — no build step is the house rule). These builders emit the
// binary format directly — magic, LEB128, sections — so the fixtures are
// readable source, deterministic, and regenerated fresh on every test run
// instead of living as opaque committed blobs. Each builder returns bytes that
// `WebAssembly.compile` accepts and that import ONLY WASI preview1 syscalls.

// --- binary-format primitives ---------------------------------------------

const uleb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
  return out;
};

const sleb = (n: number): number[] => {
  const out: number[] = [];
  let more = true;
  while (more) {
    let byte = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (byte & 0x40) === 0) || (n === -1 && (byte & 0x40) !== 0)) more = false;
    else byte |= 0x80;
    out.push(byte);
  }
  return out;
};

const str = (s: string): number[] => {
  const bytes = [...new TextEncoder().encode(s)];
  return [...uleb(bytes.length), ...bytes];
};

const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];
const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];

// opcodes used below
const i32c = (n: number): number[] => [0x41, ...sleb(n)];
const I32_STORE = [0x36, 0x02, 0x00]; // align=4, offset=0
const I32_LOAD = [0x28, 0x02, 0x00];
const call = (funcIndex: number): number[] => [0x10, ...uleb(funcIndex)];
const DROP = 0x1a;
const END = 0x0b;

const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

// Shared type table: t0 = (i32,i32,i32,i32)→i32 (fd_read/fd_write),
// t1 = (i32)→() (proc_exit), t2 = ()→() (_start).
const TYPES = vec([
  [0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f],
  [0x60, 0x01, 0x7f, 0x00],
  [0x60, 0x00, 0x00],
]);

const wasiImport = (field: string, typeIndex: number): number[] =>
  [...str('wasi_snapshot_preview1'), ...str(field), 0x00, ...uleb(typeIndex)];

/** Assemble a one-function command module: the given imports, one page of
 * memory, exports `memory` + `_start`, optional active data segment. */
const commandModule = (opts: {
  imports: number[][];
  body: number[];           // instruction bytes, WITHOUT the trailing end
  locals?: number[][];      // locals vec entries, e.g. [[1, 0x7f]] = one i32
  data?: { offset: number; bytes: Uint8Array };
}): Uint8Array => {
  const startFuncIndex = opts.imports.length;
  const codeBody = [...vec(opts.locals ?? []), ...opts.body, END];
  const bytes = [
    ...MAGIC,
    ...section(1, TYPES),
    ...section(2, vec(opts.imports)),
    ...section(3, vec([uleb(2)])),                       // one local func of type t2
    ...section(5, vec([[0x00, 0x01]])),                  // memory: min 1 page
    ...section(7, vec([
      [...str('memory'), 0x02, 0x00],
      [...str('_start'), 0x00, ...uleb(startFuncIndex)],
    ])),
    ...section(10, vec([[...uleb(codeBody.length), ...codeBody]])),
    ...(opts.data
      ? section(11, vec([[0x00, ...i32c(opts.data.offset), END, ...uleb(opts.data.bytes.length), ...opts.data.bytes]]))
      : []),
  ];
  return new Uint8Array(bytes);
};

// --- fixtures ---------------------------------------------------------------

/** fd_write(1, message) then proc_exit(exitCode). Memory map: iovec at 0,
 * nwritten at 12, message at 16. */
export const buildHelloModule = (message: string, exitCode = 0): Uint8Array => {
  const msg = new TextEncoder().encode(message);
  return commandModule({
    imports: [wasiImport('fd_write', 0), wasiImport('proc_exit', 1)],
    data: { offset: 16, bytes: msg },
    body: [
      ...i32c(0), ...i32c(16), ...I32_STORE,             // iovec.ptr = 16
      ...i32c(4), ...i32c(msg.length), ...I32_STORE,     // iovec.len
      ...i32c(1), ...i32c(0), ...i32c(1), ...i32c(12), ...call(0), DROP, // fd_write(1, iovs, 1, &nwritten)
      ...i32c(exitCode), ...call(1),                     // proc_exit
    ],
  });
};

/** Read up to 4096 bytes from stdin, write them to stdout, return (exit 0).
 * Memory map: read iovec at 0 (buf at 4096), nread at 8, nwritten at 12. */
export const buildEchoModule = (): Uint8Array => commandModule({
  imports: [wasiImport('fd_read', 0), wasiImport('fd_write', 0)],
  body: [
    ...i32c(0), ...i32c(4096), ...I32_STORE,             // iovec.ptr = 4096
    ...i32c(4), ...i32c(4096), ...I32_STORE,             // iovec.len = 4096
    ...i32c(0), ...i32c(0), ...i32c(1), ...i32c(8), ...call(0), DROP,  // fd_read(0, iovs, 1, &nread)
    ...i32c(4),                                          // iovec.len = nread
    ...i32c(8), ...I32_LOAD,
    ...I32_STORE,
    ...i32c(1), ...i32c(0), ...i32c(1), ...i32c(12), ...call(1), DROP, // fd_write(1, …)
  ],
});

/** Write `pages` × 4096 zero-bytes to stdout in a loop — exercises the output
 * cap. Locals: one i32 loop counter. */
export const buildFloodModule = (iterations: number): Uint8Array => commandModule({
  imports: [wasiImport('fd_write', 0)],
  locals: [[0x01, 0x7f]],
  body: [
    ...i32c(0), ...i32c(16), ...I32_STORE,               // iovec.ptr = 16 (zero page)
    ...i32c(4), ...i32c(4096), ...I32_STORE,             // iovec.len = 4096
    0x03, 0x40,                                          // loop (void)
    ...i32c(1), ...i32c(0), ...i32c(1), ...i32c(8), ...call(0), DROP,
    0x20, 0x00,                                          // local.get 0
    ...i32c(1), 0x6a,                                    // i32.add 1
    0x22, 0x00,                                          // local.tee 0
    ...i32c(iterations), 0x49,                           // i32.lt_u
    0x0d, 0x00,                                          // br_if loop
    END,                                                 // end loop
  ],
});

/** The 8-byte empty module — valid wasm, no imports, no _start. */
export const buildEmptyModule = (): Uint8Array => new Uint8Array(MAGIC);

/** A module importing a NON-WASI symbol (env.mystery) — must fail to link. */
export const buildNonWasiModule = (): Uint8Array => commandModule({
  imports: [[...str('env'), ...str('mystery'), 0x00, ...uleb(1)]],
  body: [...i32c(0), ...call(0)],
});
