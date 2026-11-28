const OUTPUT_BACKLOG = 1 << 20;
var ConsoleOutput = class {
	#listeners = /* @__PURE__ */ new Set();
	#backlog = [];
	#backlogHead = 0;
	#backlogBytes = 0;
	#stream;
	#controller;
	#closed = false;
	#ended;
	constructor(ended = () => false) {
		this.#ended = ended;
	}
	emit(bytes) {
		for (const l of this.#listeners) l(bytes);
		if (this.#controller) this.#controller.enqueue(bytes);
		else if (this.#backlog) {
			const b = this.#backlog;
			b.push(bytes);
			this.#backlogBytes += bytes.length;
			while (this.#backlogBytes > OUTPUT_BACKLOG && b.length - this.#backlogHead > 1) {
				this.#backlogBytes -= b[this.#backlogHead].length;
				b[this.#backlogHead++] = void 0;
			}
			if (this.#backlogHead > 1024 && this.#backlogHead * 2 > b.length) {
				b.splice(0, this.#backlogHead);
				this.#backlogHead = 0;
			}
		}
	}
	close() {
		this.#closed = true;
		try {
			this.#controller?.close();
		} catch {}
		this.#backlog = null;
	}
	get stream() {
		if (!this.#stream) {
			const backlog = this.#backlog?.slice(this.#backlogHead) ?? [];
			this.#backlog = null;
			this.#stream = new ReadableStream({ start: (c) => {
				for (const b of backlog) c.enqueue(b);
				if (this.#closed || this.#ended()) c.close();
				else this.#controller = c;
			} });
		}
		return this.#stream;
	}
	listen(listener) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
};
function errorText(e) {
	const err = e;
	if (err === null || typeof err !== "object") return String(e);
	const head = `${typeof err.name === "string" && err.name ? err.name : "Error"}: ${typeof err.message === "string" ? err.message : ""}`;
	const stack = typeof err.stack === "string" ? err.stack : "";
	if (!stack) return head;
	return typeof err.message === "string" && err.message && stack.includes(err.message) ? stack : `${head}\n${stack}`;
}
const VSOCK_HOST_CID = 2;
const VSOCK_GUEST_CID = 3;
const VSOCK_HEADER_SIZE = 44;
const FIRST_HOST_PORT = 49152;
const CLOSE_TIMEOUT_MS = 8e3;
const CREDIT_RETRY_MS = 500;
const BACKLOG = 128;
function decodeVsockHeader(pkt) {
	const dv = new DataView(pkt.buffer, pkt.byteOffset, 44);
	return {
		srcCid: dv.getUint32(0, true) + dv.getUint32(4, true) * 2 ** 32,
		dstCid: dv.getUint32(8, true) + dv.getUint32(12, true) * 2 ** 32,
		srcPort: dv.getUint32(16, true),
		dstPort: dv.getUint32(20, true),
		len: dv.getUint32(24, true),
		type: dv.getUint16(28, true),
		op: dv.getUint16(30, true),
		flags: dv.getUint32(32, true),
		bufAlloc: dv.getUint32(36, true),
		fwdCnt: dv.getUint32(40, true)
	};
}
function encodeVsockPacket(h, payload) {
	const n = payload?.length ?? 0;
	const pkt = new Uint8Array(44 + n);
	const dv = new DataView(pkt.buffer);
	dv.setUint32(0, h.srcCid >>> 0, true);
	dv.setUint32(4, Math.floor(h.srcCid / 2 ** 32), true);
	dv.setUint32(8, h.dstCid >>> 0, true);
	dv.setUint32(12, Math.floor(h.dstCid / 2 ** 32), true);
	dv.setUint32(16, h.srcPort, true);
	dv.setUint32(20, h.dstPort, true);
	dv.setUint32(24, n, true);
	dv.setUint16(28, h.type, true);
	dv.setUint16(30, h.op, true);
	dv.setUint32(32, h.flags, true);
	dv.setUint32(36, h.bufAlloc, true);
	dv.setUint32(40, h.fwdCnt, true);
	if (payload) pkt.set(payload, 44);
	return pkt;
}
var VsockDevice = class {
	enabled;
	probed = false;
	guestCid = 0;
	rxMax = 0;
	onPacket;
	onInit;
	refuse;
	keep;
	onSave;
	hostBusy;
	stats = {
		fromGuest: 0,
		fromGuestBytes: 0,
		toGuest: 0,
		toGuestBytes: 0,
		refused: 0
	};
	#queue = [];
	#head = 0;
	#memory;
	#raise;
	#retry;
	#closed = false;
	constructor(opts) {
		this.enabled = !!opts.enabled;
		this.#memory = opts.memory;
		this.#raise = opts.raise;
		this.onPacket = opts.onPacket;
		this.onInit = opts.onInit;
	}
	get queued() {
		return this.#queue.length - this.#head;
	}
	blocker() {
		if (this.queued) return "vsock packets";
		return this.hostBusy?.() ?? "";
	}
	deliver(pkt) {
		if (!this.enabled || this.#closed) return;
		this.#queue.push(pkt);
		this.#raise();
	}
	imports() {
		return {
			wasm_driver_vsock_init: (guestCid, rxMax) => {
				this.probed = true;
				if (!this.enabled) return -19;
				this.guestCid = guestCid >>> 0;
				this.rxMax = rxMax >>> 0;
				try {
					this.onInit?.(this.guestCid, this.rxMax);
				} catch {}
				return 0;
			},
			wasm_driver_vsock_send: (hdr, data, len) => {
				if (this.refuse?.()) {
					this.stats.refused++;
					this.#retry ??= setTimeout(() => {
						this.#retry = void 0;
						this.#raise();
					}, 0);
					return -11;
				}
				const n = len >>> 0;
				const u8 = new Uint8Array(this.#memory().buffer);
				const pkt = new Uint8Array(44 + n);
				pkt.set(u8.subarray(Number(hdr), Number(hdr) + 44));
				if (n) pkt.set(u8.subarray(Number(data), Number(data) + n), 44);
				this.stats.fromGuest++;
				this.stats.fromGuestBytes += pkt.length;
				this.onPacket?.(pkt);
				return 0;
			},
			wasm_driver_vsock_keep: (guestPort, hostPort) => this.keep?.has(`${guestPort >>> 0}:${hostPort >>> 0}`) ? 1 : 0,
			wasm_driver_vsock_rx_len: () => this.#head < this.#queue.length ? this.#queue[this.#head].length : 0,
			wasm_driver_vsock_recv: (buf, max) => {
				if (this.#head >= this.#queue.length) return 0;
				const pkt = this.#queue[this.#head];
				this.#queue[this.#head++] = void 0;
				if (this.#head > 64 && this.#head * 2 > this.#queue.length) {
					this.#queue = this.#queue.slice(this.#head);
					this.#head = 0;
				}
				if (buf) {
					new Uint8Array(this.#memory().buffer).set(pkt.subarray(0, max >>> 0), Number(buf));
					this.stats.toGuest++;
					this.stats.toGuestBytes += pkt.length;
				}
				return pkt.length;
			}
		};
	}
	saveState() {
		const mounts = this.onSave?.();
		return {
			guestCid: this.guestCid,
			rxMax: this.rxMax,
			...mounts ? { mounts } : {}
		};
	}
	restoreState(s) {
		this.probed = true;
		this.guestCid = s.guestCid >>> 0;
		this.rxMax = s.rxMax >>> 0;
		try {
			this.onInit?.(this.guestCid, this.rxMax);
		} catch {}
	}
	close() {
		this.#closed = true;
		this.#queue = [];
		this.#head = 0;
		clearTimeout(this.#retry);
		this.#retry = void 0;
	}
};
function saveVsockConnection(c) {
	return c instanceof Connection$1 ? c.saveState() : "not a connection of this host";
}
var VsockError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.name = "VsockError";
		this.code = code;
	}
};
var Connection$1 = class {
	localPort;
	remotePort;
	readable;
	writable;
	closed;
	state;
	#rx = [];
	#rxBytes = 0;
	#rxCnt = 0;
	#fwdCnt = 0;
	#sentFwd = 0;
	#rc;
	#wantRead = false;
	#readDone = false;
	#readCancelled = false;
	#peerShutSend = false;
	#peerBufAlloc = 0;
	#peerFwdCnt = 0;
	#txCnt = 0;
	#tx = [];
	#peerShutRcv = false;
	#shutSent = 0;
	#closeWanted = false;
	#creditAsked = false;
	#creditTimer;
	#resetErr;
	#closeTimer;
	#resolveClosed;
	#host;
	#encoder;
	onEstablished;
	constructor(host, localPort, remotePort, state) {
		this.#host = host;
		this.localPort = localPort;
		this.remotePort = remotePort;
		this.state = state;
		this.closed = new Promise((r) => this.#resolveClosed = r);
		this.readable = new ReadableStream({
			start: (c) => {
				this.#rc = c;
			},
			pull: () => {
				this.#wantRead = true;
				this.#pump();
			},
			cancel: () => {
				this.#readCancelled = true;
				this.#readDone = true;
				this.#consume(this.#rxBytes);
				this.#rx = [];
				this.#rxBytes = 0;
				this.#shutdown(1);
			}
		}, { highWaterMark: 0 });
		this.writable = new WritableStream({
			write: (chunk) => this.#write(typeof chunk === "string" ? (this.#encoder ??= new TextEncoder()).encode(chunk) : chunk),
			close: () => this.#shutdown(2),
			abort: () => this.reset()
		});
	}
	get key() {
		return `${this.localPort}:${this.remotePort}`;
	}
	saveState() {
		if (this.state !== "established") return `the connection is ${this.state}`;
		if (this.#rx.length || this.#tx.length) return "data on the way";
		if (this.#shutSent || this.#peerShutSend || this.#peerShutRcv || this.#closeWanted) return "a shutdown on the way";
		return {
			localPort: this.localPort,
			remotePort: this.remotePort,
			rxCnt: this.#rxCnt,
			fwdCnt: this.#fwdCnt,
			sentFwd: this.#sentFwd,
			peerBufAlloc: this.#peerBufAlloc,
			peerFwdCnt: this.#peerFwdCnt,
			txCnt: this.#txCnt
		};
	}
	loadState(s) {
		this.#rxCnt = s.rxCnt >>> 0;
		this.#fwdCnt = s.fwdCnt >>> 0;
		this.#sentFwd = s.sentFwd >>> 0;
		this.#peerBufAlloc = s.peerBufAlloc >>> 0;
		this.#peerFwdCnt = s.peerFwdCnt >>> 0;
		this.#txCnt = s.txCnt >>> 0;
	}
	header(op, flags = 0) {
		this.#sentFwd = this.#fwdCnt;
		return {
			srcCid: 2,
			dstCid: this.#host.guestCid,
			srcPort: this.localPort,
			dstPort: this.remotePort,
			type: 1,
			op,
			flags,
			bufAlloc: this.#host.bufferSize,
			fwdCnt: this.#fwdCnt
		};
	}
	#send(op, flags = 0, payload) {
		this.#host.sendPacket(encodeVsockPacket(this.header(op, flags), payload));
	}
	receive(h, pkt) {
		const before = this.#credit();
		this.#peerBufAlloc = h.bufAlloc;
		this.#peerFwdCnt = h.fwdCnt;
		switch (h.op) {
			case 2:
				if (this.state === "connecting") {
					this.state = "established";
					this.onEstablished?.();
					this.onEstablished = void 0;
				} else this.#violation("an unexpected RESPONSE");
				break;
			case 5:
				if (h.len) this.#data(pkt.subarray(44, 44 + h.len));
				break;
			case 4:
				if (h.flags & 2) {
					this.#peerShutSend = true;
					this.#pump();
				}
				if (h.flags & 1 && !this.#peerShutRcv) {
					this.#peerShutRcv = true;
					this.#failWrites(new VsockError("EPIPE", "the guest shut down its receiving side"));
				}
				if (this.#peerShutSend && this.#peerShutRcv) {
					this.#send(3);
					this.#end(false);
				}
				break;
			case 3:
				if (this.state === "connecting") {
					this.onEstablished?.(new VsockError("ECONNREFUSED", `vsock connect to port ${this.remotePort}: refused by the guest`));
					this.onEstablished = void 0;
					this.#end(true, true);
				} else this.#end(!(this.#peerShutSend && this.#shutSent & 2 || this.state === "closing"), true);
				return;
			case 7:
				this.#send(6);
				break;
			case 6: break;
			default:
				this.#violation(`op ${h.op}`);
				return;
		}
		if (this.#credit() > before) this.#stallDone();
		this.#flush();
	}
	#credit() {
		return this.#peerBufAlloc - (this.#txCnt - this.#peerFwdCnt >>> 0);
	}
	#stallDone() {
		this.#creditAsked = false;
		clearTimeout(this.#creditTimer);
		this.#creditTimer = void 0;
	}
	#violation(what) {
		this.#host.stats.violations++;
		this.#host.log(`[vsock] port ${this.localPort}<-${this.remotePort}: ${what}; resetting`);
		this.reset();
	}
	#data(bytes) {
		if (this.state !== "established" && this.state !== "closing") return;
		if (this.#rxBytes + bytes.length > this.#host.bufferSize) {
			this.#violation(`${bytes.length} bytes beyond the credit given`);
			return;
		}
		this.#rxCnt = this.#rxCnt + bytes.length >>> 0;
		this.#host.stats.bytesIn += bytes.length;
		if (this.#readCancelled || this.#readDone) {
			this.#consume(bytes.length);
			return;
		}
		this.#rx.push(bytes.slice());
		this.#rxBytes += bytes.length;
		this.#pump();
	}
	#pump() {
		if (this.#readDone || !this.#wantRead) return;
		const chunk = this.#rx.shift();
		if (chunk) {
			this.#wantRead = false;
			this.#rxBytes -= chunk.length;
			this.#rc.enqueue(chunk);
			this.#consume(chunk.length);
			return;
		}
		if (this.#peerShutSend || this.state === "closed") {
			this.#readDone = true;
			if (this.#resetErr && !this.#peerShutSend) this.#rc.error(this.#resetErr);
			else this.#rc.close();
			this.#maybeFinish();
		}
	}
	#consume(n) {
		this.#fwdCnt = this.#fwdCnt + n >>> 0;
		if (this.state !== "established") return;
		const buf = Math.min(this.#host.bufferSize, this.#peerBufAlloc || this.#host.bufferSize);
		if (buf - (this.#rxCnt - this.#sentFwd >>> 0) < buf / 2 && this.#fwdCnt !== this.#sentFwd) this.#send(6);
	}
	#write(data) {
		if (this.#resetErr) return Promise.reject(this.#resetErr);
		if (this.#peerShutRcv) return Promise.reject(new VsockError("EPIPE", "the guest shut down its receiving side"));
		if (this.state === "closed" || this.#shutSent & 2 || this.#closeWanted) return Promise.reject(new VsockError("EPIPE", "the connection is closed"));
		if (!data.length) return Promise.resolve();
		return new Promise((resolve, reject) => {
			this.#tx.push({
				data: data.slice(),
				at: 0,
				resolve,
				reject
			});
			this.#flush();
		});
	}
	#flush() {
		if (this.state !== "established") return;
		while (this.#tx.length) {
			const credit = this.#credit();
			if (credit <= 0) {
				if (!this.#creditAsked) {
					this.#creditAsked = true;
					this.#send(7);
					this.#creditTimer = setTimeout(() => {
						this.#creditAsked = false;
						this.#creditTimer = void 0;
						this.#flush();
					}, CREDIT_RETRY_MS);
				}
				return;
			}
			const item = this.#tx[0];
			const n = Math.min(credit, this.#host.maxPayload, item.data.length - item.at);
			this.#send(5, 0, item.data.subarray(item.at, item.at + n));
			this.#txCnt = this.#txCnt + n >>> 0;
			this.#host.stats.bytesOut += n;
			item.at += n;
			if (item.at === item.data.length) {
				this.#tx.shift();
				item.resolve();
			}
		}
		if (this.#closeWanted) this.#shutdown(3);
	}
	#failWrites(e) {
		const tx = this.#tx;
		this.#tx = [];
		for (const t of tx) t.reject(e);
	}
	#shutdown(flags) {
		if (this.state === "closed") return;
		if (this.state === "connecting") {
			this.reset();
			return;
		}
		if (flags & 2 && this.#tx.length) {
			this.#closeWanted = true;
			return;
		}
		const add = flags & ~this.#shutSent;
		if (!add) return;
		this.#shutSent |= add;
		this.#send(4, this.#shutSent);
		this.#maybeFinish();
	}
	#maybeFinish() {
		if (this.state !== "established") return;
		if (!(this.#shutSent & 2) && !this.#peerShutRcv || !this.#readDone) return;
		if (this.#shutSent !== 3) {
			this.#shutSent = 3;
			this.#send(4, this.#shutSent);
		}
		this.state = "closing";
		this.#closeTimer = setTimeout(() => {
			if (this.state === "closing") this.reset();
		}, CLOSE_TIMEOUT_MS);
	}
	close() {
		if (this.state === "closed") return;
		if (!this.#readDone) {
			this.#readDone = true;
			this.#readCancelled = true;
			this.#consume(this.#rxBytes);
			this.#rx = [];
			this.#rxBytes = 0;
			try {
				this.#rc.close();
			} catch {}
		}
		this.#closeWanted = true;
		this.#flush();
		if (!this.#tx.length) this.#shutdown(3);
	}
	reset() {
		if (this.state === "closed") return;
		this.#send(3);
		if (this.state === "connecting") {
			this.onEstablished?.(new VsockError("ECONNABORTED", "connect aborted"));
			this.onEstablished = void 0;
		}
		this.#end(true);
	}
	abort() {
		if (this.state === "closed") return;
		if (this.state === "connecting") {
			this.onEstablished?.(new VsockError("ECONNABORTED", "the kernel exited"));
			this.onEstablished = void 0;
		}
		this.#end(true, true, new VsockError("ECONNABORTED", "the kernel exited"));
	}
	#end(reset, byPeer = false, err) {
		if (this.state === "closed") return;
		const wasEstablished = this.state !== "connecting";
		this.state = "closed";
		clearTimeout(this.#closeTimer);
		this.#stallDone();
		this.#host.forget(this);
		if (reset && wasEstablished) this.#host.stats.resets++;
		if (reset) this.#resetErr = err ?? new VsockError("ECONNRESET", byPeer ? "the guest reset the connection" : "the connection was reset");
		this.#failWrites(this.#resetErr ?? new VsockError("EPIPE", "the connection is closed"));
		if (!this.#peerShutSend && !reset) this.#peerShutSend = true;
		if (reset && !byPeer) {
			this.#rx = [];
			this.#rxBytes = 0;
			if (!this.#readDone) {
				this.#readDone = true;
				try {
					this.#rc.error(this.#resetErr);
				} catch {}
			}
		} else this.#pump();
		try {
			this.writable.abort?.(this.#resetErr).catch(() => {});
		} catch {}
		this.#resolveClosed(reset ? "reset" : "closed");
	}
};
var Listener = class {
	port;
	#host;
	#queue = [];
	#waiters = [];
	#handler;
	closed = false;
	constructor(host, port, handler) {
		this.#host = host;
		this.port = port;
		this.#handler = handler;
	}
	get full() {
		return !this.#handler && !this.#waiters.length && this.#queue.length >= BACKLOG;
	}
	offer(conn) {
		if (this.#handler) {
			const h = this.#handler;
			queueMicrotask(() => {
				try {
					h(conn);
				} catch (e) {
					this.#host.log(`[vsock] listener on port ${this.port} threw: ${errorText(e)}`);
				}
			});
			return;
		}
		const w = this.#waiters.shift();
		if (w) w(conn);
		else this.#queue.push(conn);
	}
	accept() {
		const c = this.#queue.shift();
		if (c) return Promise.resolve(c);
		if (this.closed) return Promise.resolve(null);
		return new Promise((r) => this.#waiters.push(r));
	}
	async *[Symbol.asyncIterator]() {
		for (;;) {
			const c = await this.accept();
			if (!c) return;
			yield c;
		}
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		this.#host.unlisten(this);
		for (const c of this.#queue) c.reset();
		this.#queue = [];
		for (const w of this.#waiters) w(null);
		this.#waiters = [];
	}
};
var VsockHost = class {
	guestCid = 3;
	bufferSize;
	maxPayload = 16384;
	stats = {
		open: 0,
		accepted: 0,
		connected: 0,
		refused: 0,
		resets: 0,
		bytesIn: 0,
		bytesOut: 0,
		violations: 0
	};
	log;
	#send;
	#conns = /* @__PURE__ */ new Map();
	#listeners = /* @__PURE__ */ new Map();
	#nextPort = FIRST_HOST_PORT;
	#down;
	constructor(opts) {
		this.#send = opts.send;
		this.bufferSize = Math.max(4096, Math.min(opts.bufferSize ?? 262144, 2147483647)) >>> 0;
		this.log = opts.log ?? (() => {});
	}
	deviceReady(guestCid, rxMax) {
		this.guestCid = guestCid;
		if (rxMax > 44) this.maxPayload = Math.min(rxMax - 44, 65536);
	}
	sendPacket(pkt) {
		if (!this.#down) this.#send(pkt);
	}
	forget(conn) {
		if (this.#conns.get(conn.key) === conn) {
			this.#conns.delete(conn.key);
			this.stats.open = this.#conns.size;
		}
	}
	unlisten(l) {
		if (this.#listeners.get(l.port) === l) this.#listeners.delete(l.port);
	}
	#check(port) {
		if (!Number.isInteger(port) || port < 0 || port >= 4294967295) throw new VsockError("EINVAL", `vsock port ${port}: not a port (0 to 2^32 - 2)`);
	}
	listen(port, onConnection) {
		this.#check(port);
		if (this.#down) throw new VsockError("ECONNABORTED", this.#down);
		if (this.#listeners.has(port)) throw new VsockError("EADDRINUSE", `vsock port ${port} is already listening`);
		const l = new Listener(this, port, onConnection);
		this.#listeners.set(port, l);
		return l;
	}
	connect(port, opts = {}) {
		this.#check(port);
		if (this.#down) return Promise.reject(new VsockError("ECONNABORTED", this.#down));
		let local = this.#nextPort;
		while (this.#listeners.has(local) || this.#conns.has(`${local}:${port}`)) local = local >= 4294967294 ? FIRST_HOST_PORT : local + 1;
		this.#nextPort = local >= 4294967294 ? FIRST_HOST_PORT : local + 1;
		const conn = new Connection$1(this, local, port, "connecting");
		this.#conns.set(conn.key, conn);
		this.stats.open = this.#conns.size;
		const timeout = opts.timeout ?? 1e4;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (conn.state !== "connecting") return;
				conn.onEstablished = void 0;
				conn.reset();
				reject(new VsockError("ETIMEDOUT", `vsock connect to port ${port}: no answer from the guest in ${timeout} ms`));
			}, timeout);
			conn.onEstablished = (err) => {
				clearTimeout(timer);
				if (err) {
					if (err.code === "ECONNREFUSED") this.stats.refused++;
					reject(err);
				} else {
					this.stats.connected++;
					resolve(conn);
				}
			};
			this.sendPacket(encodeVsockPacket(conn.header(1)));
		});
	}
	adopt(s) {
		if (this.#down) throw new VsockError("ECONNABORTED", this.#down);
		const c = new Connection$1(this, s.localPort >>> 0, s.remotePort >>> 0, "established");
		if (this.#conns.has(c.key)) throw new VsockError("EADDRINUSE", `vsock connection ${c.key} exists`);
		c.loadState(s);
		this.#conns.set(c.key, c);
		this.stats.open = this.#conns.size;
		return c;
	}
	#refuse(h) {
		if (h.op === 3) return;
		this.sendPacket(encodeVsockPacket({
			srcCid: 2,
			dstCid: h.srcCid,
			srcPort: h.dstPort,
			dstPort: h.srcPort,
			type: h.type,
			op: 3,
			flags: 0,
			bufAlloc: 0,
			fwdCnt: 0
		}));
	}
	receive(pkt) {
		if (this.#down || pkt.length < 44) return;
		const h = decodeVsockHeader(pkt);
		if (h.dstCid !== 2 || h.len !== pkt.length - 44) {
			this.stats.violations++;
			return;
		}
		if (h.type !== 1) {
			this.stats.violations++;
			this.#refuse(h);
			return;
		}
		const conn = this.#conns.get(`${h.dstPort}:${h.srcPort}`);
		if (conn) {
			if (h.op === 1) conn.reset();
			else conn.receive(h, pkt);
			return;
		}
		if (h.op !== 1) {
			this.#refuse(h);
			return;
		}
		const l = this.#listeners.get(h.dstPort);
		if (!l || l.full) {
			this.stats.refused++;
			this.#refuse(h);
			return;
		}
		const c = new Connection$1(this, h.dstPort, h.srcPort, "established");
		this.#conns.set(c.key, c);
		this.stats.open = this.#conns.size;
		this.stats.accepted++;
		c.receive({
			...h,
			op: 6
		}, pkt);
		this.sendPacket(encodeVsockPacket(c.header(2)));
		l.offer(c);
	}
	shutdown(reason = "the kernel exited") {
		if (this.#down) return;
		this.#down = reason;
		for (const c of [...this.#conns.values()]) c.abort();
		this.#conns.clear();
		this.stats.open = 0;
		for (const l of [...this.#listeners.values()]) l.close();
	}
};
const SHM_PAGE_SIZE = 4096;
const REQ_SIZE = 280;
const NAME_MAX = 255;
const OP_OPEN = 1;
const OP_CREATE = 2;
const OP_REFRESH = 3;
const OP_CHECK = 4;
const OP_CLOSE = 5;
const REFRESH_FORCE = 1;
const FLAG_WRITABLE = 1;
const FLAG_GUEST = 2;
const DEFAULT_TIMEOUT_MS$3 = 1e4;
const ERRNO_NAMES = {
	1: "EPERM",
	2: "ENOENT",
	5: "EIO",
	9: "EBADF",
	11: "EAGAIN",
	12: "ENOMEM",
	13: "EACCES",
	16: "EBUSY",
	17: "EEXIST",
	19: "ENODEV",
	20: "ENOTDIR",
	21: "EISDIR",
	22: "EINVAL",
	27: "EFBIG",
	28: "ENOSPC",
	30: "EROFS",
	36: "ENAMETOOLONG",
	40: "ELOOP",
	95: "EOPNOTSUPP"
};
var ShmError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.name = "ShmError";
		this.code = code;
	}
};
function errnoError(errno, what) {
	const code = ERRNO_NAMES[errno] ?? `E${errno}`;
	return new ShmError(code, `${what}: ${code}`);
}
function eachRun(r, offset, length, fn) {
	const off = r.runOff;
	let lo = 0, hi = off.length - 1;
	while (lo < hi) {
		const mid = lo + hi + 1 >> 1;
		if (off[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	for (let i = lo, pos = 0; pos < length; i++) {
		const inRun = offset + pos - off[i];
		const n = Math.min(r.runLen[i] - inRun, length - pos);
		fn(r.runAddr[i] + inRun, pos, n);
		pos += n;
	}
}
function checkRange(id, size, offset, length, what) {
	if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > size) throw new ShmError("EINVAL", `${what}: ${offset}+${length} is outside export ${id} (${size} bytes)`);
}
function copyOut(mem, r, offset, length, out, what) {
	const dst = out ?? new Uint8Array(length);
	if (dst.length < length) throw new ShmError("EINVAL", `${what}: the buffer is smaller than ${length} bytes`);
	eachRun(r, offset, length, (a, pos, n) => dst.set(mem.subarray(a, a + n), pos));
	return dst;
}
function toRuns(pages) {
	let n = 0;
	for (let i = 0; i < pages.length; i++) if (!i || pages[i] !== pages[i - 1] + 4096) n++;
	const runOff = new Float64Array(n), runAddr = new Uint32Array(n), runLen = new Float64Array(n);
	let r = -1;
	for (let i = 0; i < pages.length; i++) {
		if (!i || pages[i] !== pages[i - 1] + 4096) {
			r++;
			runOff[r] = i * SHM_PAGE_SIZE;
			runAddr[r] = pages[i];
		}
		runLen[r] = runLen[r] + SHM_PAGE_SIZE;
	}
	return {
		runOff,
		runAddr,
		runLen
	};
}
var ShmDevice = class {
	enabled;
	driver;
	probed = false;
	onAttach;
	onDetach;
	onRetire;
	stats = {
		requests: 0,
		failed: 0,
		attaches: 0,
		detaches: 0,
		exports: 0,
		bytesRead: 0,
		bytesWritten: 0
	};
	#recs = /* @__PURE__ */ new Map();
	#queue = [];
	#pending = /* @__PURE__ */ new Map();
	#nextTag = 1;
	#memory;
	#raise;
	#closed = false;
	#encoder = new TextEncoder();
	constructor(opts) {
		this.enabled = !!opts.enabled;
		this.driver = opts.driver ?? true;
		this.#memory = opts.memory;
		this.#raise = opts.raise;
	}
	imports() {
		return {
			wasm_driver_shm_init: (reqSize) => {
				this.probed = true;
				if (!this.enabled) return -19;
				if (reqSize >>> 0 !== REQ_SIZE) return -22;
				return 0;
			},
			wasm_driver_shm_request: (buf, max) => {
				const req = this.#queue.shift();
				if (!req) return 0;
				const n = Math.min(req.length, max >>> 0);
				new Uint8Array(this.#memory().buffer).set(req.subarray(0, n), Number(buf));
				return n;
			},
			wasm_driver_shm_attach: (id, flags, gen, size, pages, npages) => {
				const n = npages >>> 0;
				const list = n ? new Uint32Array(this.#memory().buffer, Number(pages), n).slice() : /* @__PURE__ */ new Uint32Array(0);
				const info = {
					id: id >>> 0,
					size: Number(size),
					pages: n,
					generation: gen >>> 0,
					writable: !!(flags & FLAG_WRITABLE),
					guest: !!(flags & FLAG_GUEST)
				};
				if (!this.#recs.has(info.id)) this.stats.exports++;
				else this.#retire(info.id);
				this.#recs.set(info.id, {
					info,
					...toRuns(list)
				});
				this.stats.attaches++;
				try {
					this.onAttach?.({ ...info });
				} catch {}
			},
			wasm_driver_shm_detach: (id) => {
				if (!this.#recs.has(id >>> 0)) return;
				this.#retire(id >>> 0);
				this.#recs.delete(id >>> 0);
				this.stats.exports--;
				this.stats.detaches++;
				try {
					this.onDetach?.(id >>> 0);
				} catch {}
			},
			wasm_driver_shm_reply: (tag, result) => {
				const p = this.#pending.get(tag >>> 0);
				if (!p) return;
				this.#pending.delete(tag >>> 0);
				clearTimeout(p.timer);
				if (result < 0) {
					this.stats.failed++;
					p.reject(errnoError(-result, p.what));
				} else p.resolve(result);
			}
		};
	}
	#retire(id) {
		try {
			this.onRetire?.(id);
		} catch {}
	}
	has(id) {
		return this.#recs.has(id);
	}
	runs(id) {
		const r = this.#recs.get(id);
		return r && {
			runOff: r.runOff,
			runAddr: r.runAddr,
			runLen: r.runLen,
			size: r.info.size,
			writable: r.info.writable
		};
	}
	get busy() {
		return this.#queue.length + this.#pending.size;
	}
	saveState() {
		return {
			exports: [...this.#recs.values()].map((r) => ({
				info: { ...r.info },
				runOff: [...r.runOff],
				runAddr: [...r.runAddr],
				runLen: [...r.runLen]
			})),
			nextTag: this.#nextTag
		};
	}
	restoreState(s) {
		this.probed = true;
		for (const id of this.#recs.keys()) this.#retire(id);
		this.#recs.clear();
		for (const e of s.exports) this.#recs.set(e.info.id, {
			info: { ...e.info },
			runOff: Float64Array.from(e.runOff),
			runAddr: Uint32Array.from(e.runAddr),
			runLen: Float64Array.from(e.runLen)
		});
		this.stats.exports = this.#recs.size;
		this.#nextTag = s.nextTag || 1;
	}
	info(id) {
		const r = this.#recs.get(id);
		return r && { ...r.info };
	}
	request(op, what, f) {
		if (this.#closed) return Promise.reject(new ShmError("ECONNABORTED", `${what}: the kernel exited`));
		if (!this.enabled || !this.driver) return Promise.reject(new ShmError("ENODEV", `${what}: the kernel has no kwshm`));
		const req = new Uint8Array(REQ_SIZE);
		const dv = new DataView(req.buffer);
		if (f.name !== void 0) {
			const name = this.#encoder.encode(f.name);
			if (name.length > NAME_MAX) return Promise.reject(new ShmError("ENAMETOOLONG", `${what}: name longer than ${NAME_MAX} bytes`));
			if (name.includes(0)) return Promise.reject(new ShmError("EINVAL", `${what}: name contains NUL`));
			req.set(name, 24);
		}
		const tag = this.#nextTag;
		this.#nextTag = this.#nextTag % 4294967295 + 1;
		dv.setUint32(0, op, true);
		dv.setUint32(4, tag, true);
		dv.setUint32(8, f.id ?? 0, true);
		dv.setUint32(12, f.flags ?? 0, true);
		dv.setBigUint64(16, BigInt(f.size ?? 0), true);
		this.stats.requests++;
		return new Promise((resolve, reject) => {
			const timeout = f.timeout ?? DEFAULT_TIMEOUT_MS$3;
			const timer = timeout > 0 && Number.isFinite(timeout) ? setTimeout(() => {
				this.#pending.delete(tag);
				const i = this.#queue.indexOf(req);
				if (i >= 0) this.#queue.splice(i, 1);
				reject(new ShmError("ETIMEDOUT", `${what}: no answer from the kernel within ${timeout} ms`));
			}, timeout) : void 0;
			this.#pending.set(tag, {
				resolve,
				reject,
				timer,
				what
			});
			this.#queue.push(req);
			this.#raise();
		});
	}
	#rec(id, what) {
		const r = this.#recs.get(id);
		if (!r) throw new ShmError("ENOENT", `${what}: no export ${id}`);
		return r;
	}
	read(id, offset, length, out) {
		const r = this.#rec(id, "read");
		checkRange(id, r.info.size, offset, length, "read");
		const dst = copyOut(new Uint8Array(this.#memory().buffer), r, offset, length, out, "read");
		this.stats.bytesRead += length;
		return dst;
	}
	write(id, offset, data) {
		const r = this.#rec(id, "write");
		if (!r.info.writable) throw new ShmError("EACCES", `write: export ${id} is read-only for the host`);
		checkRange(id, r.info.size, offset, data.length, "write");
		const mem = new Uint8Array(this.#memory().buffer);
		eachRun(r, offset, data.length, (a, pos, n) => mem.set(data.subarray(pos, pos + n), a));
		this.stats.bytesWritten += data.length;
	}
	views(id, offset, length) {
		const r = this.#rec(id, "views");
		checkRange(id, r.info.size, offset, length, "views");
		const buf = this.#memory().buffer;
		const out = [];
		eachRun(r, offset, length, (a, _pos, n) => out.push(new Uint8Array(buf, a, n)));
		return out;
	}
	async run(call) {
		switch (call.op) {
			case "open":
			case "create": {
				const create = call.op === "create";
				if (create && (!Number.isSafeInteger(call.size) || call.size < 0)) throw new ShmError("EINVAL", `create: bad size ${call.size}`);
				const id = await this.request(create ? OP_CREATE : OP_OPEN, `${call.op} ${JSON.stringify(call.name)}`, {
					name: call.name,
					timeout: call.timeout,
					size: create ? call.size : 0,
					flags: create ? (call.mode ?? 384) & 511 : 0
				});
				return this.#infoOr(id, call.op);
			}
			case "openId": return this.#infoOr(call.id, "openId");
			case "refresh":
				this.#rec(call.id, "refresh");
				await this.request(OP_REFRESH, `refresh ${call.id}`, {
					id: call.id,
					flags: call.force ? REFRESH_FORCE : 0,
					timeout: call.timeout
				});
				return this.#infoOr(call.id, "refresh");
			case "check":
				this.#rec(call.id, "isStale");
				return await this.request(OP_CHECK, `isStale ${call.id}`, {
					id: call.id,
					timeout: call.timeout
				}) === 1;
			case "close":
				if (!this.#recs.has(call.id)) return void 0;
				await this.request(OP_CLOSE, `close ${call.id}`, {
					id: call.id,
					timeout: call.timeout
				});
				return;
			case "read": return this.read(call.id, call.offset, call.length);
			case "write":
				this.write(call.id, call.offset, call.data);
				return;
		}
	}
	#infoOr(id, what) {
		const info = this.info(id);
		if (!info) throw new ShmError("ENOENT", `${what}: no export ${id}`);
		return info;
	}
	close() {
		if (this.#closed) return;
		this.#closed = true;
		for (const p of this.#pending.values()) {
			clearTimeout(p.timer);
			p.reject(new ShmError("ECONNABORTED", `${p.what}: the kernel exited`));
		}
		this.#pending.clear();
		this.#queue = [];
		for (const id of this.#recs.keys()) this.#retire(id);
		this.#recs.clear();
		this.stats.exports = 0;
	}
};
const SHARE_SLOTS = 4096;
const PIN_WAIT_MS = 1e3;
var ShmShareServer = class {
	table = new SharedArrayBuffer(SHARE_SLOTS * 8);
	stats = {
		waits: 0,
		timeouts: 0
	};
	#tok = new Int32Array(this.table, 0, SHARE_SLOTS);
	#pin = new Int32Array(this.table, SHARE_SLOTS * 4, SHARE_SLOTS);
	#slots = /* @__PURE__ */ new Map();
	#free = [];
	#next = 0;
	#token = 0;
	#dev;
	#log;
	constructor(dev, log) {
		this.#dev = dev;
		this.#log = log;
		dev.onRetire = (id) => this.#retire(id);
	}
	place(id) {
		const r = this.#dev.runs(id);
		if (!r) return void 0;
		let slot = this.#slots.get(id);
		if (slot === void 0) {
			slot = this.#free.pop() ?? (this.#next < SHARE_SLOTS ? this.#next++ : void 0);
			if (slot === void 0) return void 0;
			this.#token = this.#token % 2147483647 + 1;
			Atomics.store(this.#tok, slot, this.#token);
			this.#slots.set(id, slot);
		}
		return {
			slot,
			token: Atomics.load(this.#tok, slot),
			size: r.size,
			writable: r.writable,
			runOff: r.runOff,
			runAddr: r.runAddr,
			runLen: r.runLen
		};
	}
	#retire(id) {
		const slot = this.#slots.get(id);
		if (slot === void 0) return;
		this.#slots.delete(id);
		Atomics.store(this.#tok, slot, 0);
		if (Atomics.load(this.#pin, slot)) {
			this.stats.waits++;
			const end = performance.now() + PIN_WAIT_MS;
			for (let left = PIN_WAIT_MS; Atomics.load(this.#pin, slot) && left > 0; left = end - performance.now()) Atomics.wait(this.#pin, slot, 1, left);
			if (Atomics.load(this.#pin, slot)) {
				this.stats.timeouts++;
				this.#log(`[host] shm: export ${id} retired while the owner still had it pinned after ${PIN_WAIT_MS} ms`);
			}
		}
		this.#free.push(slot);
	}
};
var ShmInPlace = class {
	#mem;
	#tok;
	#pin;
	#places = /* @__PURE__ */ new Map();
	#held = /* @__PURE__ */ new Set();
	#closed = false;
	constructor(memory, table) {
		this.#mem = new Uint8Array(memory);
		this.#tok = new Int32Array(table, 0, SHARE_SLOTS);
		this.#pin = new Int32Array(table, SHARE_SLOTS * 4, SHARE_SLOTS);
	}
	set(id, place) {
		if (!this.#closed) this.#places.set(id, place);
	}
	drop(id) {
		this.#places.delete(id);
	}
	ready(id) {
		const p = this.#places.get(id);
		return !!p && Atomics.load(this.#tok, p.slot) === p.token;
	}
	read(id, offset, length, out) {
		const p = this.#place(id, offset, length, "read");
		const held = this.#held.has(p.slot);
		if (!held) Atomics.store(this.#pin, p.slot, 1);
		try {
			this.#current(id, p, "read");
			return copyOut(this.#mem, p, offset, length, out, "read");
		} finally {
			if (!held) this.#unpin(p.slot);
		}
	}
	write(id, offset, data) {
		const p = this.#place(id, offset, data.length, "write");
		if (!p.writable) throw new ShmError("EACCES", `write: export ${id} is read-only for the host`);
		const held = this.#held.has(p.slot);
		if (!held) Atomics.store(this.#pin, p.slot, 1);
		try {
			this.#current(id, p, "write");
			eachRun(p, offset, data.length, (a, pos, n) => this.#mem.set(data.subarray(pos, pos + n), a));
		} finally {
			if (!held) this.#unpin(p.slot);
		}
	}
	views(id, offset, length) {
		const p = this.#place(id, offset, length, "views");
		if (!this.#held.has(p.slot)) {
			Atomics.store(this.#pin, p.slot, 1);
			if (!this.#held.size) queueMicrotask(() => this.#release());
			this.#held.add(p.slot);
		}
		this.#current(id, p, "views");
		const out = [];
		eachRun(p, offset, length, (a, _pos, n) => out.push(this.#mem.subarray(a, a + n)));
		return out;
	}
	close() {
		this.#closed = true;
		this.#places.clear();
		this.#release();
	}
	#place(id, offset, length, what) {
		const p = this.#places.get(id);
		if (!p) throw new ShmError("EAGAIN", `${what}: export ${id} has no page list on this thread`);
		checkRange(id, p.size, offset, length, what);
		return p;
	}
	#current(id, p, what) {
		if (Atomics.load(this.#tok, p.slot) === p.token) return;
		if (this.#places.get(id) === p) this.#places.delete(id);
		throw new ShmError("EAGAIN", `${what}: export ${id}'s page list changed or went away`);
	}
	#unpin(slot) {
		Atomics.store(this.#pin, slot, 0);
		Atomics.notify(this.#pin, slot);
	}
	#release() {
		for (const s of this.#held) this.#unpin(s);
		this.#held.clear();
	}
};
var Handle = class {
	id;
	name;
	origin;
	closed;
	info;
	done;
	closing = false;
	#client;
	#resolve;
	constructor(client, info, name) {
		this.#client = client;
		this.id = info.id;
		this.info = info;
		this.name = name;
		this.origin = info.guest ? "guest" : "host";
		this.closed = new Promise((r) => this.#resolve = r);
	}
	get size() {
		return this.info.size;
	}
	get pages() {
		return this.info.pages;
	}
	get writable() {
		return this.info.writable;
	}
	get generation() {
		return this.info.generation;
	}
	end(reason) {
		if (this.done) return;
		this.done = reason;
		this.#client.forget(this);
		this.#resolve(reason);
	}
	#live(what) {
		if (this.done) throw new ShmError("EBADF", `${what}: the handle is closed (${this.done})`);
	}
	async read(offset = 0, length) {
		this.#live("read");
		const n = length ?? Math.max(0, this.info.size - offset);
		const local = this.#client.backend.local;
		if (local?.ready(this.id)) try {
			const data = local.read(this.id, offset, n);
			this.#client.count(true, data.length, true);
			return data;
		} catch (e) {
			if (e.code !== "EAGAIN") throw e;
		}
		const data = await this.#client.backend.run({
			op: "read",
			id: this.id,
			offset,
			length: n
		});
		this.#client.count(true, data.length);
		return data;
	}
	get inPlace() {
		return !this.done && !!this.#client.backend.local?.ready(this.id);
	}
	#local(what) {
		this.#live(what);
		const local = this.#client.backend.local;
		if (!local) throw new ShmError("EOPNOTSUPP", `${what}: this thread cannot see the kernel's memory (worker mode without a shared memory: use read())`);
		return local;
	}
	readSync(offset = 0, length, out) {
		const local = this.#local("readSync");
		const n = length ?? Math.max(0, this.info.size - offset);
		const data = local.read(this.id, offset, n, out);
		this.#client.count(true, n, true);
		return data;
	}
	async write(offset, data) {
		this.#live("write");
		const local = this.#client.backend.local;
		if (local?.ready(this.id)) try {
			local.write(this.id, offset, data);
			this.#client.count(false, data.length);
			return;
		} catch (e) {
			if (e.code !== "EAGAIN") throw e;
		}
		await this.#client.backend.run({
			op: "write",
			id: this.id,
			offset,
			data
		});
		this.#client.count(false, data.length);
	}
	async refresh(opts = {}) {
		this.#live("refresh");
		const gen = this.info.generation;
		const info = await this.#client.backend.run({
			op: "refresh",
			id: this.id,
			force: opts.force,
			timeout: opts.timeout
		});
		this.#client.update(info);
		return info.generation !== gen;
	}
	async isStale(opts = {}) {
		this.#live("isStale");
		return await this.#client.backend.run({
			op: "check",
			id: this.id,
			timeout: opts.timeout
		});
	}
	async close() {
		if (this.done) return;
		if (this.origin === "host") {
			this.closing = true;
			try {
				await this.#client.backend.run({
					op: "close",
					id: this.id
				});
			} finally {
				this.closing = false;
			}
		}
		this.end("closed");
	}
	views(offset = 0, length) {
		return this.#local("views").views(this.id, offset, length ?? Math.max(0, this.info.size - offset));
	}
};
var ShmClient = class {
	backend;
	#handles = /* @__PURE__ */ new Map();
	#exited = false;
	#stats = {
		open: 0,
		reads: 0,
		bytesRead: 0,
		inPlaceReads: 0,
		writes: 0,
		bytesWritten: 0
	};
	constructor(backend) {
		this.backend = backend;
	}
	get stats() {
		return { ...this.#stats };
	}
	get inPlace() {
		return !this.#exited && !!this.backend.local;
	}
	async open(name, opts = {}) {
		return this.#add(await this.backend.run({
			op: "open",
			name,
			timeout: opts.timeout
		}), name);
	}
	async create(name, size, opts = {}) {
		return this.#add(await this.backend.run({
			op: "create",
			name,
			size,
			mode: opts.mode,
			timeout: opts.timeout
		}), name);
	}
	async openId(id) {
		return this.#add(await this.backend.run({
			op: "openId",
			id
		}), void 0);
	}
	#add(info, name) {
		if (this.#exited) throw new ShmError("ECONNABORTED", "the kernel exited");
		const h = new Handle(this, info, name);
		let set = this.#handles.get(info.id);
		if (!set) this.#handles.set(info.id, set = /* @__PURE__ */ new Set());
		set.add(h);
		this.#stats.open++;
		return h;
	}
	forget(h) {
		const set = this.#handles.get(h.id);
		if (set?.delete(h)) this.#stats.open--;
		if (set && !set.size) this.#handles.delete(h.id);
	}
	count(read, bytes, inPlace = false) {
		if (read) {
			this.#stats.reads++;
			this.#stats.bytesRead += bytes;
			if (inPlace) this.#stats.inPlaceReads++;
		} else {
			this.#stats.writes++;
			this.#stats.bytesWritten += bytes;
		}
	}
	update(info) {
		for (const h of this.#handles.get(info.id) ?? []) if (info.generation >= h.info.generation) h.info = { ...info };
	}
	detached(id) {
		for (const h of [...this.#handles.get(id) ?? []]) h.end(h.closing ? "closed" : "released");
	}
	shutdown() {
		this.#exited = true;
		for (const set of [...this.#handles.values()]) for (const h of [...set]) h.end("exit");
	}
};
function inlineShm(dev) {
	const client = new ShmClient({
		run: (call) => dev.run(call),
		local: {
			ready: (id) => dev.has(id),
			read: (id, offset, length, out) => dev.read(id, offset, length, out),
			write: (id, offset, data) => dev.write(id, offset, data),
			views: (id, offset, length) => dev.views(id, offset, length)
		}
	});
	dev.onAttach = (info) => client.update(info);
	dev.onDetach = (id) => client.detached(id);
	return client;
}
const TTY_PORT = 1022;
const TTY_VERSION = 1;
const TTY_MAX_WRITE = 4096;
const TTY_MAX_PAYLOAD = 65535;
const TTY_FEATURE_PIPES = 1;
const TTY_FEATURE_CONNECT = 2;
const TTY_FEATURE_USER = 4;
const TTY_FEATURE_DETACH = 8;
const TTY_DETACH_TIMEOUT = 6e4;
const TTY_SIGNALS = [
	"HUP",
	"INT",
	"QUIT",
	"ILL",
	"TRAP",
	"ABRT",
	"BUS",
	"FPE",
	"KILL",
	"USR1",
	"SEGV",
	"USR2",
	"PIPE",
	"ALRM",
	"TERM",
	"CHLD",
	"CONT",
	"STOP",
	"TSTP",
	"TTIN",
	"TTOU",
	"URG",
	"XCPU",
	"XFSZ",
	"VTALRM",
	"PROF",
	"WINCH",
	"IO",
	"PWR",
	"SYS"
];
const DEFAULT_TERM = "xterm-256color";
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_TIMEOUT_MS$2 = 3e4;
const DEFAULT_MAX_BUFFER = 64 << 20;
const RETRY_MS$2 = 100;
const OPENED_SIZE = 14;
const EMPTY$2 = /* @__PURE__ */ new Uint8Array(0);
var PtyError = class extends Error {
	code;
	constructor(code, message, cause) {
		super(message, cause === void 0 ? void 0 : { cause });
		this.name = "PtyError";
		this.code = code;
	}
};
function u16(v, what) {
	const n = v ?? 0;
	if (!Number.isInteger(n) || n < 0 || n > 65535) throw new RangeError(`kwtty: ${what} ${v} is not an integer from 0 to 65535`);
	return n;
}
function encodeTtyFrame(type, payload = EMPTY$2, flags = 0) {
	const n = payload.length;
	if (n > 65535) throw new RangeError(`kwtty: a frame payload of ${n} bytes (at most ${TTY_MAX_PAYLOAD})`);
	const f = new Uint8Array(4 + n);
	f[0] = type;
	f[1] = flags;
	f[2] = n & 255;
	f[3] = n >> 8;
	f.set(payload, 4);
	return f;
}
function sizeBytes(s) {
	const b = /* @__PURE__ */ new Uint8Array(8);
	const dv = new DataView(b.buffer);
	dv.setUint16(0, u16(s.rows, "rows"), true);
	dv.setUint16(2, u16(s.cols, "cols"), true);
	dv.setUint16(4, u16(s.xpixel, "xpixel"), true);
	dv.setUint16(6, u16(s.ypixel, "ypixel"), true);
	return b;
}
function encodeTtyResize(s) {
	return sizeBytes(s);
}
function encodeTtyOpen(opts) {
	const enc = new TextEncoder();
	const { parts, opt } = openParts(opts);
	const term = opts.term ?? (opts.pipes || opts.connect !== void 0 ? void 0 : DEFAULT_TERM);
	if (term !== void 0) {
		if (!/^[\x20-\x7e]{1,64}$/.test(term)) throw new RangeError(`kwtty: TERM ${JSON.stringify(term)} is not 1 to 64 printable ASCII characters`);
		opt(1, enc.encode(term));
	}
	for (const [k, v] of Object.entries(opts.env ?? {})) {
		if (!k || k.includes("=") || k.includes("\0") || String(v).includes("\0")) throw new RangeError(`kwtty: environment variable ${JSON.stringify(k)}: a name must be non-empty without "=", and neither may contain NUL`);
		const kv = enc.encode(`${k}=${v}`);
		if (kv.length > 65535) throw new RangeError(`kwtty: environment variable ${k} is too long`);
		opt(2, kv);
	}
	if (opts.file !== void 0) {
		for (const a of [opts.file, ...opts.args ?? []]) {
			if (a.includes("\0")) throw new RangeError(`kwtty: argument ${JSON.stringify(a)} contains NUL`);
			opt(131, enc.encode(a));
		}
		if (!opts.file) throw new RangeError("kwtty: the program name is empty");
	} else if (opts.args?.length) throw new RangeError("kwtty: args without a program (file)");
	if (opts.cwd !== void 0) {
		if (!opts.cwd || opts.cwd.includes("\0")) throw new RangeError(`kwtty: cwd ${JSON.stringify(opts.cwd)} is empty or contains NUL`);
		opt(132, enc.encode(opts.cwd));
	}
	if (opts.pipes) opt(133, EMPTY$2);
	if (opts.connect !== void 0) {
		const port = opts.connect;
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError(`kwtty: TCP port ${port} is not an integer from 1 to 65535`);
		opt(134, Uint8Array.of(port & 255, port >> 8));
	} else {
		const u = opts.user === void 0 ? "" : String(opts.user);
		if (typeof opts.user === "number" ? !Number.isInteger(opts.user) || opts.user < 0 || opts.user > 4294967295 : !/^[^\0:\n]{0,64}$/.test(u) || opts.user !== void 0 && !u) throw new RangeError(`kwtty: user ${JSON.stringify(opts.user)} is not a uid or a name of 1 to 64 characters without ":", newline or NUL`);
		opt(7 | (u === "" || u === "root" || u === "0" ? 0 : 128), enc.encode(u));
	}
	if (opts.detach) {
		if (opts.pipes || opts.connect !== void 0) throw new RangeError("kwtty: only a session on a pty can be detachable");
		const t = opts.detach.timeout ?? 0;
		if (!Number.isInteger(t) || t < 0 || t > 4294967295) throw new RangeError(`kwtty: detachTimeout ${t} is not an integer number of ms from 0 to 2^32 - 1`);
		const id = sessionIdBytes(opts.detach.id);
		const v = new Uint8Array(4 + id.length);
		new DataView(v.buffer).setUint32(0, t, true);
		v.set(id, 4);
		opt(8, v);
	}
	return joinParts(parts);
}
function encodeTtyAttach(opts) {
	const { parts, opt } = openParts(opts);
	opt(137, sessionIdBytes(opts.id));
	if (opts.replay) opt(10, EMPTY$2);
	return joinParts(parts);
}
function sessionIdBytes(id) {
	if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new RangeError(`kwtty: session id ${JSON.stringify(id)} is not 1 to 64 of A-Z a-z 0-9 . _ -`);
	return new TextEncoder().encode(id);
}
function openParts(size) {
	const parts = [];
	const head = /* @__PURE__ */ new Uint8Array(2);
	new DataView(head.buffer).setUint16(0, 1, true);
	parts.push(head, sizeBytes(size));
	const opt = (tag, value) => {
		const h = /* @__PURE__ */ new Uint8Array(3);
		h[0] = tag;
		h[1] = value.length & 255;
		h[2] = value.length >> 8;
		parts.push(h, value);
	};
	return {
		parts,
		opt
	};
}
function joinParts(parts) {
	let n = 0;
	for (const p of parts) n += p.length;
	if (n > 65535) throw new RangeError(`kwtty: the OPEN frame would be ${n} bytes (at most ${TTY_MAX_PAYLOAD}); pass less environment`);
	const out = new Uint8Array(n);
	n = 0;
	for (const p of parts) {
		out.set(p, n);
		n += p.length;
	}
	return out;
}
var TtyFrameParser = class {
	#chunks = [];
	#head = 0;
	#len = 0;
	#frames = [];
	get buffered() {
		return this.#len;
	}
	push(chunk) {
		if (!chunk.length) return;
		this.#chunks.push(chunk);
		this.#len += chunk.length;
		while (this.#len >= 4) {
			const h = this.#read(4, false);
			const n = h[2] | h[3] << 8;
			if (this.#len < 4 + n) break;
			this.#read(4, true);
			this.#frames.push({
				type: h[0],
				flags: h[1],
				payload: this.#read(n, true)
			});
		}
	}
	peek() {
		return this.#frames[0];
	}
	next() {
		return this.#frames.shift();
	}
	rest() {
		const parts = [];
		for (const f of this.#frames) parts.push(encodeTtyFrame(f.type, f.payload, f.flags));
		if (this.#len) parts.push(this.#read(this.#len, true));
		this.#frames = [];
		this.#chunks = [];
		this.#head = 0;
		this.#len = 0;
		let n = 0;
		for (const p of parts) n += p.length;
		if (parts.length === 1) return parts[0].slice();
		const out = new Uint8Array(n);
		n = 0;
		for (const p of parts) {
			out.set(p, n);
			n += p.length;
		}
		return out;
	}
	#read(n, consume) {
		if (!n) return EMPTY$2;
		const first = this.#chunks[0];
		let out;
		if (first.length - this.#head >= n) {
			out = first.subarray(this.#head, this.#head + n);
			if (consume) {
				this.#head += n;
				if (this.#head === first.length) {
					this.#chunks.shift();
					this.#head = 0;
				}
			}
		} else {
			out = new Uint8Array(n);
			let at = 0, i = 0, off = this.#head;
			while (at < n) {
				const c = this.#chunks[i];
				const k = Math.min(n - at, c.length - off);
				out.set(c.subarray(off, off + k), at);
				at += k;
				off += k;
				if (off === c.length) {
					i++;
					off = 0;
				}
			}
			if (consume) {
				this.#chunks.splice(0, i);
				this.#head = off;
			}
		}
		if (consume) this.#len -= n;
		return out;
	}
};
var Session$1 = class {
	pid;
	version;
	features;
	exitCode = null;
	ended;
	#conn;
	#reader;
	#writer;
	#parser;
	#outputs = /* @__PURE__ */ new Map();
	#resolve;
	#reject;
	#done = false;
	#running = false;
	#pumping = Promise.resolve();
	#encoder;
	constructor(conn, reader, writer, parser, opened) {
		this.#conn = conn;
		this.#reader = reader;
		this.#writer = writer;
		this.#parser = parser;
		this.pid = opened.pid;
		this.version = opened.version;
		this.features = opened.features;
		this.ended = new Promise((resolve, reject) => {
			this.#resolve = resolve;
			this.#reject = reject;
		});
		this.ended.catch(() => {});
	}
	get done() {
		return this.#done;
	}
	stream(type) {
		let out;
		return new ReadableStream({
			start: (rc) => {
				out = {
					rc,
					discard: false,
					want: false
				};
				this.#outputs.set(type, out);
			},
			pull: () => {
				out.want = true;
				return this.#pull();
			},
			cancel: () => {
				out.discard = out.want = true;
				this.#pull();
			}
		}, { highWaterMark: 0 });
	}
	#pull() {
		if (!this.#running) {
			this.#running = true;
			this.#pumping = this.#pump();
		}
		return this.#pumping;
	}
	#wanted() {
		for (const o of this.#outputs.values()) if (o.want) return true;
		return false;
	}
	async #pump() {
		try {
			for (;;) {
				let queued = false;
				for (let f = this.#parser.peek(); f && !this.#done; f = this.#parser.peek()) {
					const out = this.#outputs.get(f.type);
					if (out) {
						this.#parser.next();
						if (f.payload.length && !out.discard) {
							out.rc.enqueue(f.payload);
							out.want = false;
							queued = true;
						}
						continue;
					}
					if (queued && !this.#wanted()) break;
					this.#parser.next();
					this.#frame(f);
				}
				if (this.#done || !this.#wanted()) break;
				let r;
				try {
					r = await this.#reader.read();
				} catch {
					this.#finish({ type: "lost" });
					break;
				}
				if (this.#done) break;
				if (r.done) {
					this.#finish({ type: "lost" });
					break;
				}
				this.#parser.push(r.value);
			}
		} catch (e) {
			this.#finish(new PtyError("EPROTO", `kwtty: ${e?.message ?? e}`, e));
		}
		this.#running = false;
	}
	#frame(f) {
		switch (f.type) {
			case 4: {
				if (f.payload.length < 3) throw new Error(`an EXIT frame of ${f.payload.length} bytes`);
				const [how, code, core] = f.payload;
				if (how === 0) this.#finish({
					type: "exit",
					code
				});
				else if (how === 1) this.#finish({
					type: "signal",
					signal: code,
					coreDumped: core === 1
				});
				else throw new Error(`EXIT with how ${how}`);
				return;
			}
			case 5:
				this.#finish(new PtyError("EREMOTE", `kwtty: ${new TextDecoder().decode(f.payload)}`));
				return;
			case 1: throw new Error("a second OPENED");
			default: if (f.flags & 1) throw new Error(`an unknown critical frame (type ${f.type})`);
		}
	}
	#finish(end) {
		if (this.#done) return;
		this.#done = true;
		if (!(end instanceof PtyError) && end.type === "exit") this.exitCode = end.code;
		if (end instanceof PtyError) this.#reject(end);
		else this.#resolve(end);
		for (const o of this.#outputs.values()) try {
			if (end instanceof PtyError) o.rc.error(end);
			else o.rc.close();
		} catch {}
		this.#conn.close();
	}
	send(frame) {
		return this.#writer.write(frame).catch((e) => {
			throw new PtyError("EPIPE", `kwtty: ${this.#done ? "the session has ended" : "the connection failed"}`, e);
		});
	}
	sendData(data) {
		const bytes = typeof data === "string" ? (this.#encoder ??= new TextEncoder()).encode(data) : data;
		if (this.#done) return Promise.reject(new PtyError("EPIPE", "kwtty: the session has ended"));
		const sent = [];
		for (let i = 0; i < bytes.length; i += TTY_MAX_WRITE) sent.push(this.send(encodeTtyFrame(2, bytes.subarray(i, i + TTY_MAX_WRITE))));
		return Promise.all(sent).then(() => {});
	}
	sendSignal(signal) {
		const name = signal.startsWith("SIG") ? signal.slice(3) : signal;
		if (!TTY_SIGNALS.includes(name)) throw new RangeError(`kwtty: unknown signal ${JSON.stringify(signal)}`);
		if (!this.#done) this.send(encodeTtyFrame(6, new TextEncoder().encode(name), 1)).catch(() => {});
	}
	async close() {
		this.#finish({ type: "closed" });
		this.#conn.close();
		await this.#conn.closed;
	}
	[Symbol.asyncDispose]() {
		return this.close();
	}
};
const detachables = /* @__PURE__ */ new WeakMap();
function ttySessions(vsock) {
	const set = vsock && detachables.get(vsock);
	if (!set) return [];
	return [...set].filter((s) => s.live).map((s) => ({
		id: s.sessionId,
		pid: s.pid,
		pts: s.pts,
		cols: s.cols,
		rows: s.rows
	}));
}
var PtySession = class extends Session$1 {
	pts;
	cols;
	rows;
	output;
	sessionId;
	live = true;
	constructor(conn, reader, writer, parser, opened, size, vsock, sessionId) {
		super(conn, reader, writer, parser, opened);
		this.pts = opened.pts;
		this.cols = size.cols;
		this.rows = size.rows;
		this.output = this.stream(2);
		this.sessionId = sessionId;
		if (sessionId !== void 0) {
			let set = detachables.get(vsock);
			if (!set) detachables.set(vsock, set = /* @__PURE__ */ new Set());
			set.add(this);
			const gone = () => {
				this.live = false;
				set.delete(this);
			};
			this.ended.then(gone, gone);
		}
	}
	write(data) {
		return this.sendData(data);
	}
	resize(cols, rows, xpixel, ypixel) {
		const frame = encodeTtyFrame(3, encodeTtyResize({
			cols,
			rows,
			xpixel,
			ypixel
		}));
		this.cols = cols;
		this.rows = rows;
		if (!this.done) this.send(frame).catch(() => {});
	}
	kill(signal = "SIGHUP") {
		this.sendSignal(signal);
	}
};
var PipeSession = class extends Session$1 {
	stdin;
	stdout;
	stderr;
	constructor(conn, reader, writer, parser, opened) {
		super(conn, reader, writer, parser, opened);
		this.stdout = this.stream(2);
		this.stderr = this.stream(8);
		const eof = () => this.done ? Promise.resolve() : this.send(encodeTtyFrame(7)).catch(() => {});
		this.stdin = new WritableStream({
			write: (chunk) => this.sendData(chunk),
			close: eof,
			abort: eof
		});
	}
	kill(signal = "SIGTERM") {
		this.sendSignal(signal);
	}
};
function guard(p, deadline, timedOut, signal, late) {
	return new Promise((resolve, reject) => {
		let over = false;
		const stop = () => {
			over = true;
			if (timer !== void 0) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			stop();
			reject(aborted());
		};
		const timer = deadline === 1e400 ? void 0 : setTimeout(() => {
			stop();
			reject(timedOut());
		}, Math.max(0, deadline - performance.now()));
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort);
		p.then((v) => {
			if (over) late?.(v);
			else {
				stop();
				resolve(v);
			}
		}, (e) => {
			if (!over) {
				stop();
				reject(e);
			}
		});
	});
}
const aborted = () => new PtyError("ABORTED", "kwtty: aborted while opening the session");
const errCode = (e) => e?.code;
async function connectRetry(vsock, port, deadline, timedOut, signal) {
	for (;;) {
		if (signal?.aborted) throw aborted();
		const left = deadline - performance.now();
		if (left <= 0) throw timedOut();
		try {
			return await guard(vsock.connect(port, { timeout: Math.max(1, Math.ceil(left)) }), deadline, timedOut, signal, (c) => c.reset());
		} catch (e) {
			if (e instanceof PtyError) throw e;
			const code = errCode(e);
			if (code === "ECONNREFUSED") {
				const wait = Math.min(RETRY_MS$2, deadline - performance.now());
				if (wait > 0) await guard(new Promise((r) => setTimeout(r, wait)), 1e400, timedOut, signal);
				continue;
			}
			if (code === "ETIMEDOUT") throw timedOut();
			if (code === "ECONNABORTED") throw new PtyError("ECONNABORTED", "kwtty: the kernel exited", e);
			throw e;
		}
	}
}
async function readOpened(reader, parser) {
	for (;;) {
		for (let f = parser.next(); f; f = parser.next()) {
			if (f.type === 1) {
				if (f.payload.length < OPENED_SIZE) throw new PtyError("EPROTO", `kwtty: an OPENED frame of ${f.payload.length} bytes`);
				const dv = new DataView(f.payload.buffer, f.payload.byteOffset, f.payload.length);
				const version = dv.getUint16(0, true);
				if (version < 1 || version > 1) throw new PtyError("EPROTO", `kwtty: the guest chose version ${version} (this client speaks 1 to 1)`);
				return {
					version,
					features: dv.getUint32(2, true),
					pid: dv.getUint32(6, true),
					pts: dv.getUint32(10, true)
				};
			}
			if (f.type === 5) throw new PtyError("EREMOTE", `kwtty: ${new TextDecoder().decode(f.payload)}`);
			if (f.type === 2 || f.type === 4 || f.flags & 1) throw new PtyError("EPROTO", `kwtty: frame type ${f.type} before OPENED`);
		}
		let r;
		try {
			r = await reader.read();
		} catch (e) {
			throw new PtyError("ECONNRESET", "kwtty: the connection was reset before OPENED", e);
		}
		if (r.done) throw new PtyError("ECONNRESET", "kwtty: the guest closed the connection before OPENED");
		parser.push(r.value);
	}
}
async function openSession(vsock, payload, opts) {
	const open = encodeTtyFrame(1, payload);
	const port = opts.port ?? 1022;
	const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS$2;
	const signal = opts.signal;
	const deadline = performance.now() + timeout;
	const timedOut = () => new PtyError("ETIMEDOUT", `kwtty: no terminal server on vsock port ${port} within ${timeout} ms (is "kwbox tty serve" running in the guest?)`);
	const conn = await connectRetry(vsock, port, deadline, timedOut, signal);
	try {
		const reader = conn.readable.getReader();
		const writer = conn.writable.getWriter();
		const parser = new TtyFrameParser();
		writer.write(open).catch(() => {});
		const opened = readOpened(reader, parser);
		opened.catch(() => {});
		return {
			conn,
			reader,
			writer,
			parser,
			opened: await guard(opened, deadline, timedOut, signal)
		};
	} catch (e) {
		conn.reset();
		throw e;
	}
}
async function spawnPty(vsock, file, args = [], opts = {}) {
	const size = {
		cols: opts.cols ?? DEFAULT_COLS,
		rows: opts.rows ?? DEFAULT_ROWS,
		xpixel: opts.xpixel,
		ypixel: opts.ypixel
	};
	const { detachable, detachTimeout, ...rest } = opts;
	const detach = detachable ? {
		id: newSessionId(),
		timeout: detachTimeout
	} : void 0;
	const s = await openSession(vsock, encodeTtyOpen({
		...rest,
		...size,
		file,
		args,
		detach
	}), opts);
	const id = detach && s.opened.features & 8 ? detach.id : void 0;
	return new PtySession(s.conn, s.reader, s.writer, s.parser, s.opened, size, vsock, id);
}
function newSessionId() {
	const b = crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(16));
	let id = "";
	for (const x of b) id += x.toString(16).padStart(2, "0");
	return id;
}
async function attachPty(vsock, session, opts = {}) {
	const saved = typeof session === "string" ? void 0 : session;
	const id = typeof session === "string" ? session : session.id;
	const size = {
		cols: opts.cols ?? saved?.cols ?? DEFAULT_COLS,
		rows: opts.rows ?? saved?.rows ?? DEFAULT_ROWS,
		xpixel: opts.xpixel,
		ypixel: opts.ypixel
	};
	const payload = encodeTtyAttach({
		...size,
		id,
		replay: opts.replay ?? true
	});
	let s;
	try {
		s = await openSession(vsock, payload, {
			port: opts.port,
			timeout: opts.timeout,
			signal: opts.signal
		});
	} catch (e) {
		if (e instanceof PtyError && e.code === "EREMOTE") {
			if (e.message.startsWith("kwtty: ENOENT:")) throw new PtyError("ENOENT", e.message);
			if (e.message === "kwtty: unknown critical OPEN option") throw new PtyError("ENOENT", "kwtty: the guest's kwtty cannot reattach sessions (it is older than ATTACH)", e);
		}
		throw e;
	}
	return new PtySession(s.conn, s.reader, s.writer, s.parser, s.opened, size, vsock, id);
}
async function spawnSubprocess(vsock, file, args = [], opts = {}) {
	const s = await openSession(vsock, encodeTtyOpen({
		...opts,
		cols: 0,
		rows: 0,
		file,
		args,
		pipes: true
	}), opts);
	return new PipeSession(s.conn, s.reader, s.writer, s.parser, s.opened);
}
async function execSubprocess(vsock, file, args = [], opts = {}) {
	const { input, encoding = "utf8", maxBuffer = DEFAULT_MAX_BUFFER, ...spawnOpts } = opts;
	if (!file) throw new RangeError("kwtty: exec() needs a program (file)");
	const p = await spawnSubprocess(vsock, file, args, spawnOpts);
	const signal = opts.signal;
	let failure;
	const fail = (e) => {
		if (failure) return;
		failure = e;
		p.kill("KILL");
	};
	const onAbort = () => fail(new PtyError("ABORTED", "kwtty: exec() was aborted; the program got SIGKILL"));
	signal?.addEventListener("abort", onAbort);
	if (signal?.aborted) onAbort();
	const collect = async (stream, name) => {
		const reader = stream.getReader();
		const chunks = [];
		let n = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (failure) continue;
			n += value.length;
			if (n > maxBuffer) fail(new PtyError("ENOBUFS", `kwtty: ${name} went over maxBuffer (${maxBuffer} bytes); the program got SIGKILL`));
			else chunks.push(value);
		}
		const out = new Uint8Array(failure ? 0 : n);
		if (!failure) {
			let at = 0;
			for (const c of chunks) {
				out.set(c, at);
				at += c.length;
			}
		}
		return out;
	};
	const feed = async () => {
		const w = p.stdin.getWriter();
		if (input !== void 0 && input.length) await w.write(input).catch(() => {});
		await w.close().catch(() => {});
	};
	try {
		const [stdout, stderr] = await Promise.all([
			collect(p.stdout, "stdout"),
			collect(p.stderr, "stderr"),
			feed()
		]);
		const end = await p.ended;
		if (failure) throw failure;
		if (end.type === "exit" || end.type === "signal") {
			const decode = (b) => encoding === "buffer" ? b : new TextDecoder().decode(b);
			return {
				stdout: decode(stdout),
				stderr: decode(stderr),
				exitCode: end.type === "exit" ? end.code : null,
				signal: end.type === "signal" ? end.signal : null
			};
		}
		throw new PtyError("ECONNRESET", "kwtty: the session was lost before the program exited (did the kernel exit?)");
	} catch (e) {
		await p.close().catch(() => {});
		throw failure ?? e;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}
async function connectGuest(vsock, port, opts = {}) {
	const payload = encodeTtyOpen({
		cols: 0,
		rows: 0,
		connect: port
	});
	let s;
	try {
		s = await openSession(vsock, payload, {
			port: opts.ttyPort,
			timeout: opts.timeout,
			signal: opts.signal
		});
	} catch (e) {
		if (e instanceof PtyError && e.code === "EREMOTE" && e.message.startsWith("kwtty: ECONNREFUSED:")) throw new PtyError("ECONNREFUSED", e.message);
		throw e;
	}
	const { conn, reader, writer, parser, opened } = s;
	if (!(opened.features & 2)) {
		conn.reset();
		throw new PtyError("EPROTO", "kwtty: the guest opened a session without the CONNECT feature");
	}
	let rest = parser.rest();
	if (!rest.length) rest = void 0;
	writer.releaseLock();
	const readable = new ReadableStream({
		pull: async (c) => {
			if (rest) {
				c.enqueue(rest);
				rest = void 0;
				return;
			}
			const r = await reader.read();
			if (r.done) c.close();
			else c.enqueue(r.value);
		},
		cancel: (reason) => reader.cancel(reason)
	}, { highWaterMark: 0 });
	const close = async () => {
		conn.close();
		await conn.closed;
	};
	return {
		port,
		readable,
		writable: conn.writable,
		closed: conn.closed,
		close,
		[Symbol.asyncDispose]: close
	};
}
const noDevice = (what) => new PtyError("ENODEV", `${what} needs the vsock device, which this instance has not: it was created with vsock: false (or vsock.raw)`);
function spawnOn(vsock, file, args, opts) {
	if (!vsock) return Promise.reject(noDevice("spawn()"));
	if (opts?.pty === false) {
		const { pty: _, ...rest } = opts;
		return spawnSubprocess(vsock, file, args, rest);
	}
	return spawnPty(vsock, file, args, opts);
}
function attachOn(vsock, session, opts) {
	if (!vsock) return Promise.reject(noDevice("attach()"));
	return attachPty(vsock, session, opts);
}
function execOn(vsock, file, args, opts) {
	if (!vsock) return Promise.reject(noDevice("exec()"));
	return execSubprocess(vsock, file, args, opts);
}
function connectOn(vsock, port, opts) {
	if (!vsock) return Promise.reject(noDevice("connect()"));
	return connectGuest(vsock, port, opts);
}
const HTTP_MAX_HEADER_BYTES = 65536;
const MAX_CHUNK_LINE = 4096;
const NO_BODY_STATUS = /* @__PURE__ */ new Set([
	204,
	205,
	304
]);
const SKIP_REQUEST = /* @__PURE__ */ new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"content-length",
	"upgrade",
	"te",
	"trailer"
]);
const SKIP_RESPONSE = /* @__PURE__ */ new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"trailer",
	"upgrade"
]);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const REASON = /^[\t\x20-\x7e\x80-\xff]*$/;
const EMPTY$1 = /* @__PURE__ */ new Uint8Array(0);
const noop = () => {};
const malformed = (what) => /* @__PURE__ */ new TypeError(`fetchOver: malformed response: ${what}`);
function latin1$1(b) {
	let s = "";
	for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
	return s;
}
function latin1Bytes(s) {
	const b = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
	return b;
}
function concat$2(a, b) {
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}
var Input = class {
	#reader;
	#buf = EMPTY$1;
	eof = false;
	lineBytes = 0;
	constructor(reader) {
		this.#reader = reader;
	}
	get buffered() {
		return this.#buf.length;
	}
	async more() {
		while (!this.eof) {
			const { done, value } = await this.#reader.read();
			if (done) {
				this.eof = true;
				break;
			}
			if (!value.length) continue;
			this.#buf = this.#buf.length ? concat$2(this.#buf, value) : value;
			return true;
		}
		return false;
	}
	take(n) {
		const b = this.#buf;
		if (n >= b.length) {
			this.#buf = EMPTY$1;
			return b;
		}
		this.#buf = b.subarray(n);
		return b.subarray(0, n);
	}
	async readLine(max) {
		let from = 0;
		for (;;) {
			const i = this.#buf.indexOf(10, from);
			if (i > max || i < 0 && this.#buf.length > max) throw new TypeError(`fetchOver: response header block over ${HTTP_MAX_HEADER_BYTES} bytes, or a line too long`);
			if (i >= 0) {
				const line = this.take(i + 1);
				this.lineBytes += line.length;
				const end = line.length >= 2 && line[line.length - 2] === 13 ? line.length - 2 : line.length - 1;
				return latin1$1(line.subarray(0, end));
			}
			from = this.#buf.length;
			if (!await this.more()) return null;
		}
	}
};
async function readHead(input) {
	const left = () => HTTP_MAX_HEADER_BYTES - input.lineBytes;
	let line = await input.readLine(left());
	while (line === "") line = await input.readLine(left());
	if (line === null) throw new TypeError("fetchOver: the connection closed before a response");
	const m = /^HTTP\/1\.[01] ([1-9]\d\d)(?: (.*))?$/.exec(line);
	if (!m) throw malformed(`status line ${JSON.stringify(line.slice(0, 80))}`);
	const status = Number(m[1]);
	const reason = m[2] ?? "";
	const head = {
		status,
		statusText: REASON.test(reason) ? reason : "",
		headers: []
	};
	for (;;) {
		line = await input.readLine(left());
		if (line === null) throw new TypeError("fetchOver: the connection closed inside the response headers");
		if (line === "") return head;
		const colon = line.indexOf(":");
		const name = colon > 0 ? line.slice(0, colon) : "";
		if (!TOKEN.test(name)) throw malformed(`header line ${JSON.stringify(line.slice(0, 80))}`);
		head.headers.push([name.toLowerCase(), line.slice(colon + 1).replace(/^[\t ]+|[\t ]+$/g, "")]);
	}
}
function knownLength(body) {
	return typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof URLSearchParams || typeof Blob !== "undefined" && body instanceof Blob || typeof FormData !== "undefined" && body instanceof FormData;
}
function framing(method, status, headers) {
	if (method === "HEAD" || NO_BODY_STATUS.has(status)) return { kind: "none" };
	const te = headers.filter(([n]) => n === "transfer-encoding").map(([, v]) => v).join(",");
	if (te) {
		const codings = te.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
		return codings[codings.length - 1] === "chunked" ? { kind: "chunked" } : { kind: "eof" };
	}
	const cl = headers.filter(([n]) => n === "content-length").flatMap(([, v]) => v.split(",").map((x) => x.trim()));
	if (cl.length) {
		if (!cl.every((v) => /^\d{1,15}$/.test(v) && v === cl[0])) throw malformed(`Content-Length ${JSON.stringify(cl.join(", "))}`);
		return {
			kind: "length",
			length: Number(cl[0])
		};
	}
	return { kind: "eof" };
}
function signalReason(signal) {
	return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}
async function fetchOver(connect, input, init) {
	const streaming = init?.body != null && !knownLength(init.body);
	const req = new Request(input, streaming && !("duplex" in init) ? {
		...init,
		duplex: "half"
	} : init);
	const url = new URL(req.url);
	if (url.protocol !== "http:") throw new TypeError(`fetchOver: only http: URLs are supported, not ${url.protocol}`);
	const port = url.port ? Number(url.port) : 80;
	const method = req.method;
	const signal = req.signal;
	if (signal.aborted) throw signalReason(signal);
	let bodyBytes = null;
	let bodyStream = null;
	if (req.body) {
		if (streaming) bodyStream = req.body;
		else bodyBytes = new Uint8Array(await req.arrayBuffer());
	}
	let head = `${method} ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${req.headers.get("host") ?? url.host}\r\n`;
	for (const [name, value] of req.headers) {
		if (name === "host" || SKIP_REQUEST.has(name)) continue;
		head += `${name}: ${value}\r\n`;
	}
	if (!req.headers.has("accept-encoding")) head += "Accept-Encoding: identity\r\n";
	if (bodyStream) head += "Transfer-Encoding: chunked\r\n";
	else if (bodyBytes) head += `Content-Length: ${bodyBytes.length}\r\n`;
	else if (method === "POST" || method === "PUT" || method === "PATCH") head += "Content-Length: 0\r\n";
	head += "Connection: close\r\n\r\n";
	const headBytes = latin1Bytes(head);
	if (signal.aborted) throw signalReason(signal);
	let onConnectAbort = noop;
	const aborted = new Promise((_, reject) => {
		onConnectAbort = () => reject(signalReason(signal));
		signal.addEventListener("abort", onConnectAbort, { once: true });
	});
	const pending = connect(port, { signal });
	let duplex;
	try {
		duplex = await Promise.race([pending, aborted]);
	} catch (e) {
		pending.then((d) => {
			d.writable.abort(e).catch(noop);
			d.readable.cancel(e).catch(noop);
		}, noop);
		throw e;
	} finally {
		signal.removeEventListener("abort", onConnectAbort);
	}
	const writer = duplex.writable.getWriter();
	const reader = duplex.readable.getReader();
	const conn = new Input(reader);
	let failure;
	let finished = false;
	let uploadDone = false;
	let source;
	let failBody = noop;
	const finish = (error) => {
		if (finished) return;
		finished = true;
		signal.removeEventListener("abort", onAbort);
		source?.cancel(error).catch(noop);
		if (error === void 0 && uploadDone) writer.close().catch(noop);
		else writer.abort(error).catch(noop);
		reader.cancel(error).catch(noop);
	};
	const fail = (e) => {
		if (finished) return;
		failure ??= e;
		failBody(e);
		finish(e);
	};
	const onAbort = () => fail(signalReason(signal));
	signal.addEventListener("abort", onAbort, { once: true });
	(async () => {
		try {
			if (bodyBytes && bodyBytes.length <= 65536) await writer.write(concat$2(headBytes, bodyBytes));
			else {
				await writer.write(headBytes);
				if (bodyBytes) await writer.write(bodyBytes);
			}
			if (bodyStream) {
				source = bodyStream.getReader();
				if (finished) source.cancel(failure).catch(noop);
				for (;;) {
					let r;
					try {
						r = await source.read();
					} catch (e) {
						fail(e);
						return;
					}
					if (r.done) break;
					if (!r.value.length) continue;
					const size = latin1Bytes(`${r.value.length.toString(16)}\r\n`);
					const frame = new Uint8Array(size.length + r.value.length + 2);
					frame.set(size);
					frame.set(r.value, size.length);
					frame.set([13, 10], frame.length - 2);
					await writer.write(frame);
				}
				await writer.write(latin1Bytes("0\r\n\r\n"));
			}
			uploadDone = true;
		} catch {}
	})();
	let res;
	let body;
	try {
		for (;;) {
			res = await readHead(conn);
			if (res.status === 101) throw new TypeError("fetchOver: 101 Switching Protocols (an upgrade) is not supported");
			if (res.status >= 200) break;
		}
		if (res.status > 599) throw malformed(`status ${res.status}`);
		body = framing(method, res.status, res.headers);
	} catch (e) {
		fail(e);
		throw failure;
	}
	if (finished) throw failure;
	const headers = new Headers();
	const connectionTokens = new Set(res.headers.filter(([n]) => n === "connection").flatMap(([, v]) => v.split(",").map((t) => t.trim().toLowerCase())));
	try {
		for (const [name, value] of res.headers) {
			if (SKIP_RESPONSE.has(name) || connectionTokens.has(name)) continue;
			if (name === "content-length" && body.kind !== "length") continue;
			headers.append(name, value);
		}
	} catch {
		const e = malformed("a header value Headers does not accept");
		fail(e);
		throw e;
	}
	if (body.kind === "none") {
		finish();
		return new Response(null, {
			status: res.status,
			statusText: res.statusText,
			headers
		});
	}
	let left = body.kind === "length" ? body.length : 0;
	let chunkState = "size";
	let controller;
	const truncated = () => /* @__PURE__ */ new TypeError("fetchOver: the connection closed before the end of the response body");
	const done = () => {
		finish();
		try {
			controller.close();
		} catch {}
	};
	const pull = async () => {
		for (;;) {
			if (finished) return;
			switch (body.kind) {
				case "eof":
					if (!conn.buffered && !await conn.more()) return done();
					return controller.enqueue(conn.take(1e400));
				case "length":
					if (!left) return done();
					if (!conn.buffered && !await conn.more()) throw truncated();
					{
						const piece = conn.take(left);
						left -= piece.length;
						controller.enqueue(piece);
					}
					if (!left) done();
					return;
				case "chunked":
					if (chunkState === "size") {
						const line = await conn.readLine(MAX_CHUNK_LINE);
						if (line === null) throw truncated();
						const m = /^([0-9a-fA-F]{1,13})[\t ]*(?:;.*)?$/.exec(line);
						if (!m) throw malformed(`chunk size line ${JSON.stringify(line.slice(0, 80))}`);
						left = parseInt(m[1], 16);
						chunkState = left ? "data" : "trailers";
						continue;
					}
					if (chunkState === "data") {
						if (!conn.buffered && !await conn.more()) throw truncated();
						const piece = conn.take(left);
						left -= piece.length;
						if (!left) chunkState = "crlf";
						return controller.enqueue(piece);
					}
					if (chunkState === "crlf") {
						const line = await conn.readLine(2);
						if (line === null) throw truncated();
						if (line !== "") throw malformed("no CRLF after a chunk");
						chunkState = "size";
						continue;
					}
					{
						const line = await conn.readLine(HTTP_MAX_HEADER_BYTES);
						if (line === null || line === "") return done();
						continue;
					}
			}
		}
	};
	const stream = new ReadableStream({
		start: (c) => {
			controller = c;
			failBody = (e) => {
				try {
					c.error(e);
				} catch {}
			};
		},
		pull: async () => {
			try {
				await pull();
			} catch (e) {
				fail(e);
			}
		},
		cancel: (reason) => {
			failBody = noop;
			finish(reason ?? new DOMException("The response body was cancelled", "AbortError"));
		}
	}, { highWaterMark: 0 });
	return new Response(stream, {
		status: res.status,
		statusText: res.statusText,
		headers
	});
}
const ERRNO$1 = {
	EPERM: 1,
	ENOENT: 2,
	EINTR: 4,
	EIO: 5,
	ENXIO: 6,
	E2BIG: 7,
	ENOEXEC: 8,
	EBADF: 9,
	EAGAIN: 11,
	EWOULDBLOCK: 11,
	ENOMEM: 12,
	EACCES: 13,
	EFAULT: 14,
	EBUSY: 16,
	EEXIST: 17,
	EXDEV: 18,
	ENODEV: 19,
	ENOTDIR: 20,
	EISDIR: 21,
	EINVAL: 22,
	ENFILE: 23,
	EMFILE: 24,
	ENOTTY: 25,
	ETXTBSY: 26,
	EFBIG: 27,
	ENOSPC: 28,
	ESPIPE: 29,
	EROFS: 30,
	EMLINK: 31,
	EPIPE: 32,
	ERANGE: 34,
	EDEADLK: 35,
	ENAMETOOLONG: 36,
	ENOLCK: 37,
	ENOSYS: 38,
	ENOTEMPTY: 39,
	ELOOP: 40,
	ENODATA: 61,
	EPROTO: 71,
	EOVERFLOW: 75,
	EILSEQ: 84,
	EOPNOTSUPP: 95,
	ENOTSUP: 95,
	ECONNABORTED: 103,
	ECONNRESET: 104,
	ENOTCONN: 107,
	ETIMEDOUT: 110,
	ESTALE: 116,
	EDQUOT: 122,
	ECANCELED: 125
};
var FsError = class extends Error {
	code;
	errno;
	constructor(code, message) {
		super(message === void 0 || message === code ? code : `${code}: ${message}`);
		this.name = "FsError";
		this.code = code;
		this.errno = ERRNO$1[code] ?? ERRNO$1.EIO;
	}
};
const FS_DEFAULT_OWNER = 1e3;
const MSIZE = 131072;
const DEFAULT_TIMEOUT = 3e4;
const P9_VERSION = "9P2000.L";
const HDR$2 = 7;
const WINDOW = 16;
const QUEUE = 16;
const Rlerror = 7;
const Tstatfs = 8;
const Tlopen = 12;
const Tlcreate = 14;
const Tsymlink = 16;
const Tmknod = 18;
const Trename = 20;
const Treadlink = 22;
const Tgetattr = 24;
const Tsetattr = 26;
const Txattrwalk = 30;
const Txattrcreate = 32;
const Treaddir = 40;
const Tfsync = 50;
const Tlock = 52;
const Tgetlock = 54;
const Tlink = 70;
const Tmkdir = 72;
const Trenameat = 74;
const Tunlinkat = 76;
const Tversion = 100;
const Tauth = 102;
const Tattach = 104;
const Tflush = 108;
const Twalk = 110;
const Tread = 116;
const Twrite = 118;
const Tclunk = 120;
const Tremove = 122;
const QTDIR = 128;
const QTSYMLINK = 2;
const QTFILE = 0;
const S_IFDIR = 16384;
const S_IFREG = 32768;
const S_IFLNK = 40960;
const DT_DIR = 4;
const DT_REG = 8;
const DT_LNK = 10;
const AT_REMOVEDIR = 512;
const O_ACCMODE = 3;
const O_EXCL = 128;
const O_TRUNC = 512;
const O_APPEND = 1024;
const P9_STATS_BASIC = 2047;
const V9FS_MAGIC = 16914839;
function knownErrno(e) {
	if (e instanceof FsError) return e.errno;
	const code = e?.code;
	return typeof code === "string" && ERRNO$1[code] || 0;
}
function serve9p(vsock, log = () => {}) {
	return new Server(vsock, log);
}
const enc$4 = new TextEncoder();
const lenient = new TextDecoder();
const strict = new TextDecoder("utf-8", { fatal: true });
var Writer = class {
	buf;
	dv;
	n = HDR$2;
	constructor(size = 64) {
		this.buf = new Uint8Array(Math.max(size, HDR$2));
		this.dv = new DataView(this.buf.buffer);
	}
	room(k) {
		if (this.n + k <= this.buf.length) return;
		const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
		b.set(this.buf.subarray(0, this.n));
		this.buf = b;
		this.dv = new DataView(b.buffer);
	}
	u8(v) {
		this.room(1);
		this.dv.setUint8(this.n, v);
		this.n += 1;
		return this;
	}
	u16(v) {
		this.room(2);
		this.dv.setUint16(this.n, v, true);
		this.n += 2;
		return this;
	}
	u32(v) {
		this.room(4);
		this.dv.setUint32(this.n, v >>> 0, true);
		this.n += 4;
		return this;
	}
	u64(v) {
		this.room(8);
		this.dv.setBigUint64(this.n, typeof v === "bigint" ? BigInt.asUintN(64, v) : BigInt(Math.max(0, Math.floor(v))), true);
		this.n += 8;
		return this;
	}
	str(s) {
		const b = enc$4.encode(s);
		this.u16(b.length);
		return this.bytes(b);
	}
	bytes(b) {
		this.room(b.length);
		this.buf.set(b, this.n);
		this.n += b.length;
		return this;
	}
	qid(q) {
		return this.u8(q.type).u32(q.version).u64(q.path);
	}
	finish(type, tag) {
		this.dv.setUint32(0, this.n, true);
		this.dv.setUint8(4, type);
		this.dv.setUint16(5, tag, true);
		return this.buf.subarray(0, this.n);
	}
};
var Reader$1 = class {
	at = HDR$2;
	dv;
	buf;
	constructor(buf) {
		this.buf = buf;
		this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	}
	u8() {
		const v = this.dv.getUint8(this.at);
		this.at += 1;
		return v;
	}
	u16() {
		const v = this.dv.getUint16(this.at, true);
		this.at += 2;
		return v;
	}
	u32() {
		const v = this.dv.getUint32(this.at, true);
		this.at += 4;
		return v;
	}
	u64() {
		const v = this.dv.getBigUint64(this.at, true);
		this.at += 8;
		return Number(v);
	}
	str() {
		return lenient.decode(this.bytes(this.u16()));
	}
	name() {
		try {
			return strict.decode(this.bytes(this.u16()));
		} catch (e) {
			if (e instanceof FsError) throw e;
			throw new FsError("EILSEQ", "a name that is not UTF-8");
		}
	}
	bytes(n) {
		if (this.at + n > this.buf.length) throw new FsError("EPROTO", "a message shorter than its fields");
		const b = this.buf.subarray(this.at, this.at + n);
		this.at += n;
		return b;
	}
};
const typeOf = (frame) => frame[4];
const tagOf = (frame) => frame[5] | frame[6] << 8;
const errorReply = (tag, errno) => new Writer(11).u32(errno).finish(Rlerror, tag);
var P9FrameAssembler = class {
	#chunks = [];
	#head = 0;
	#len = 0;
	maxSize;
	constructor(maxSize) {
		this.maxSize = maxSize;
	}
	get buffered() {
		return this.#len;
	}
	push(chunk) {
		if (chunk.length) {
			this.#chunks.push(chunk);
			this.#len += chunk.length;
		}
	}
	next() {
		if (this.#len < 4) return void 0;
		let size = 0;
		for (let i = 0, c = 0, off = this.#head; i < 4;) {
			const chunk = this.#chunks[c];
			if (off >= chunk.length) {
				c++;
				off = 0;
				continue;
			}
			size |= chunk[off++] << 8 * i++;
		}
		size >>>= 0;
		if (size < HDR$2 || size > this.maxSize) throw new Error(`a 9p message of ${size} bytes (at most ${this.maxSize})`);
		if (this.#len < size) return void 0;
		const first = this.#chunks[0];
		let out;
		if (first.length - this.#head >= size) {
			out = first.subarray(this.#head, this.#head + size);
			this.#head += size;
		} else {
			out = new Uint8Array(size);
			for (let at = 0; at < size;) {
				const c = this.#chunks[0];
				const k = Math.min(size - at, c.length - this.#head);
				out.set(c.subarray(this.#head, this.#head + k), at);
				at += k;
				this.#head += k;
				if (this.#head === c.length) {
					this.#chunks.shift();
					this.#head = 0;
				}
			}
		}
		if (this.#chunks.length && this.#head === this.#chunks[0].length) {
			this.#chunks.shift();
			this.#head = 0;
		}
		this.#len -= size;
		return out;
	}
};
function join(dir, name) {
	return dir === "/" ? `/${name}` : `${dir}/${name}`;
}
function parent(path) {
	const i = path.lastIndexOf("/");
	return i <= 0 ? "/" : path.slice(0, i);
}
function checkName$1(name) {
	if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) throw new FsError("EINVAL", `bad name ${JSON.stringify(name)}`);
	if (enc$4.encode(name).length > 255) throw new FsError("ENAMETOOLONG");
}
function under(path, prefix) {
	return prefix === "/" || path === prefix || path.startsWith(prefix) && path[prefix.length] === "/";
}
function inode(path, ino, dev) {
	if (ino !== void 0) return dev !== void 0 && dev !== 0 && dev !== 0n ? BigInt.asUintN(64, BigInt(dev) << 40n ^ BigInt(ino)) : ino;
	let a = 2166136261, b = 84696351;
	for (let i = 0; i < path.length; i++) {
		const c = path.charCodeAt(i);
		a = Math.imul(a ^ c, 16777619);
		b = Math.imul(b ^ c, 16777619) ^ b >>> 15;
	}
	return 1n << 63n | BigInt(a >>> 1 | 1073741824) << 32n | BigInt(b >>> 0);
}
const qidType = (t) => t === "dir" ? QTDIR : t === "symlink" ? QTSYMLINK : QTFILE;
function qidOf(path, a) {
	let version = a.version;
	if (version === void 0) version = (Math.floor((a.mtimeMs ?? 0) * 1e3) % 4294967296 ^ Math.imul((a.size ?? 0) % 4294967296, 2654435761)) >>> 0 || 1;
	return {
		type: qidType(a.type),
		version: version >>> 0,
		path: inode(path, a.ino, a.dev)
	};
}
const MSG_NAMES = {
	[Tstatfs]: "statfs",
	[Tlopen]: "lopen",
	[Tlcreate]: "lcreate",
	[Tsymlink]: "symlink",
	[Tmknod]: "mknod",
	[Trename]: "rename",
	[Treadlink]: "readlink",
	[Tgetattr]: "getattr",
	[Tsetattr]: "setattr",
	[Treaddir]: "readdir",
	[Tfsync]: "fsync",
	[Tlink]: "link",
	[Tmkdir]: "mkdir",
	[Trenameat]: "renameat",
	[Tunlinkat]: "unlinkat",
	[Tattach]: "attach",
	[Twalk]: "walk",
	[Tread]: "read",
	[Twrite]: "write",
	[Tclunk]: "clunk",
	[Tremove]: "remove"
};
const MUTATING = /* @__PURE__ */ new Set([
	Tlcreate,
	Tsymlink,
	Tmknod,
	Trename,
	Tsetattr,
	Txattrcreate,
	Tlink,
	Tmkdir,
	Trenameat,
	Tunlinkat,
	Twrite
]);
var Export = class {
	name;
	fs;
	readOnly;
	timeout;
	stats = {
		requests: 0,
		errors: 0,
		bytesRead: 0,
		bytesWritten: 0
	};
	conn;
	connected = false;
	onConnection;
	server;
	removed = false;
	constructor(server, name, fs, readOnly, timeout) {
		this.server = server;
		this.name = name;
		this.fs = fs;
		this.readOnly = readOnly;
		this.timeout = timeout;
	}
	opened(c, open) {
		if (open) this.conn = c;
		else if (this.conn !== c || !this.connected) return;
		this.connected = open;
		try {
			this.onConnection?.(open);
		} catch (e) {
			this.server.log(`[9p] ${this.name}: onConnection threw: ${errorText(e)}`);
		}
	}
	remove() {
		if (this.removed) return;
		this.removed = true;
		this.onConnection = void 0;
		this.server.forget(this);
		if (this.connected) this.conn.reset();
	}
};
var Server = class {
	log;
	#listener;
	#exports = /* @__PURE__ */ new Map();
	#users = /* @__PURE__ */ new Map();
	#conns = /* @__PURE__ */ new Set();
	next = 1;
	#closed = false;
	constructor(vsock, log) {
		this.log = log;
		this.#listener = vsock.listen(564, (conn) => {
			const c = new Connection(this, conn);
			this.#conns.add(c);
			c.run().finally(() => this.#conns.delete(c));
		});
	}
	add(fs, opts = {}) {
		if (this.#closed) throw new FsError("ECONNABORTED", "the 9p server is closed");
		const e = new Export(this, `fs${this.next++}`, fs, !!opts.readOnly, opts.timeout ?? DEFAULT_TIMEOUT);
		this.#exports.set(e.name, e);
		this.#users.set(fs, (this.#users.get(fs) ?? 0) + 1);
		return e;
	}
	exportBusy(p) {
		const e = p;
		if (e.removed || !e.connected || !e.conn) return "not attached";
		return e.conn.busy();
	}
	saveExport(p) {
		const e = p;
		return {
			name: e.name,
			...e.conn.save()
		};
	}
	async restoreExport(fs, opts, saved, conn) {
		if (this.#closed) throw new FsError("ECONNABORTED", "the 9p server is closed");
		if (this.#exports.has(saved.name)) throw new FsError("EEXIST", `export ${saved.name} exists`);
		const e = new Export(this, saved.name, fs, !!opts.readOnly, opts.timeout ?? DEFAULT_TIMEOUT);
		this.#exports.set(e.name, e);
		this.#users.set(fs, (this.#users.get(fs) ?? 0) + 1);
		const n = /^fs(\d+)$/.exec(saved.name);
		if (n) this.next = Math.max(this.next, Number(n[1]) + 1);
		const session = new Session(e, Math.max(4096, Math.min(saved.msize, MSIZE)));
		await session.restore(saved.fids);
		const c = new Connection(this, conn, session);
		this.#conns.add(c);
		e.opened(c, true);
		c.run().finally(() => this.#conns.delete(c));
		return e;
	}
	get(name) {
		return this.#exports.get(name);
	}
	forget(e) {
		if (this.#exports.get(e.name) !== e) return;
		this.#exports.delete(e.name);
		const n = (this.#users.get(e.fs) ?? 1) - 1;
		if (n > 0) {
			this.#users.set(e.fs, n);
			return;
		}
		this.#users.delete(e.fs);
		Promise.resolve().then(() => e.fs.close?.()).catch((err) => this.log(`[9p] close: ${err?.message ?? err}`));
	}
	close() {
		if (this.#closed) return;
		this.#closed = true;
		this.#listener.close();
		for (const e of [...this.#exports.values()]) e.remove();
		for (const c of [...this.#conns]) c.reset();
	}
};
var Connection = class {
	#server;
	#conn;
	#writer;
	#asm;
	#msize;
	#session;
	#queue = [];
	#inFlight = 0;
	#wake;
	#done = false;
	#gone = false;
	constructor(server, conn, session) {
		this.#server = server;
		this.#conn = conn;
		this.#writer = conn.writable.getWriter();
		this.#msize = session?.msize ?? MSIZE;
		this.#asm = new P9FrameAssembler(MSIZE);
		this.#session = session;
		conn.closed.then(() => {
			this.#gone = true;
		});
	}
	busy() {
		if (this.#done || this.#gone) return "its connection ended";
		if (this.#inFlight || this.#queue.length || this.#asm.buffered || this.#session?.busy) return "a request in flight";
		const v = saveVsockConnection(this.#conn);
		return typeof v === "string" ? `its connection: ${v}` : void 0;
	}
	save() {
		const conn = saveVsockConnection(this.#conn);
		if (typeof conn === "string" || !this.#session) throw new Error(`9p: cannot save the connection (${conn})`);
		return {
			conn,
			msize: this.#session.msize,
			fids: this.#session.save()
		};
	}
	reset() {
		this.#conn.reset();
	}
	async run() {
		const reader = this.#conn.readable.getReader();
		try {
			for (;;) {
				while (this.#queue.length >= QUEUE && !this.#gone) await Promise.race([new Promise((r) => this.#wake = r), this.#conn.closed]);
				if (this.#gone) break;
				let chunk;
				try {
					chunk = await reader.read();
				} catch {
					break;
				}
				if (chunk.done || this.#done) break;
				this.#asm.push(chunk.value);
				for (let f = this.#asm.next(); f; f = this.#asm.next()) this.#frame(f);
			}
		} catch (e) {
			this.#server.log(`[9p] ${this.#session?.exp.name ?? "connection"}: ${e?.message ?? e}; resetting`);
			this.#conn.reset();
		} finally {
			this.#done = true;
			try {
				reader.releaseLock();
			} catch {}
			this.#conn.close();
			this.#queue = [];
			this.#session?.destroy();
			this.#session?.exp.opened(this, false);
		}
	}
	#send(frame) {
		if (this.#done) return;
		const s = this.#session?.exp.stats;
		if (s) {
			const t = typeOf(frame);
			if (t === Rlerror) s.errors++;
			else if (t === 117) s.bytesRead += frame.length - HDR$2 - 4;
		}
		this.#writer.write(frame).catch(() => {});
	}
	#frame(frame) {
		const type = typeOf(frame), tag = tagOf(frame);
		const session = this.#session;
		if (session) session.exp.stats.requests++;
		if (type === Tflush) {
			const old = frame.length >= 9 ? frame[HDR$2] | frame[8] << 8 : -1;
			const i = this.#queue.findIndex((q) => q.tag === old);
			if (i >= 0) this.#queue.splice(i, 1);
			if (i < 0 && session) session.flush(old);
			this.#send(new Writer(HDR$2).finish(109, tag));
			this.#pump();
			return;
		}
		if (!session && type === Tversion) {
			try {
				const r = new Reader$1(frame);
				this.#msize = Math.max(4096, Math.min(r.u32(), MSIZE));
				const version = r.str();
				this.#send(new Writer(32).u32(this.#msize).str(version.startsWith(P9_VERSION) ? P9_VERSION : "unknown").finish(101, tag));
			} catch {
				this.#send(errorReply(tag, ERRNO$1.EPROTO));
			}
			return;
		}
		if (!session && type === Tattach) {
			let exp;
			try {
				const r = new Reader$1(frame);
				r.u32(), r.u32(), r.str();
				exp = this.#server.get(r.str());
			} catch {}
			if (!exp || exp.removed) {
				this.#server.log("[9p] attach to a file system that is not served");
				this.#send(errorReply(tag, ERRNO$1.ENOENT));
				return;
			}
			if (exp.conn) {
				this.#server.log(`[9p] ${exp.name}: attach from a second connection refused`);
				this.#send(errorReply(tag, ERRNO$1.EBUSY));
				return;
			}
			this.#session = new Session(exp, this.#msize);
			exp.opened(this, true);
			exp.stats.requests++;
		} else if (!session) {
			this.#send(errorReply(tag, type === Tauth ? ERRNO$1.EOPNOTSUPP : ERRNO$1.EBADF));
			return;
		}
		this.#queue.push({
			frame,
			tag
		});
		this.#pump();
	}
	#pump() {
		while (this.#session && this.#inFlight < WINDOW && this.#queue.length) {
			const q = this.#queue.shift();
			this.#inFlight++;
			this.#session.call(q.frame).then((reply) => {
				if (reply) this.#send(reply);
			}).finally(() => {
				this.#inFlight--;
				this.#pump();
			});
		}
		if (this.#queue.length < QUEUE) {
			const w = this.#wake;
			this.#wake = void 0;
			w?.();
		}
	}
};
function fileOf(f) {
	if (f.stale) throw new FsError("ESTALE", `${f.path}: the file open before the snapshot is gone`);
	return f.file;
}
const big = (v) => v === void 0 ? void 0 : String(v);
const unbig = (v) => v === void 0 ? void 0 : BigInt(v);
var Session = class {
	exp;
	#fs;
	#fids = /* @__PURE__ */ new Map();
	#msize;
	#pending = /* @__PURE__ */ new Map();
	#destroyed = false;
	constructor(exp, msize) {
		this.exp = exp;
		this.#fs = exp.fs;
		this.#msize = msize;
	}
	get msize() {
		return this.#msize;
	}
	get busy() {
		return this.#pending.size > 0;
	}
	save() {
		return [...this.#fids].map(([fid, f]) => ({
			fid,
			path: f.path,
			type: f.type,
			...f.file && f.open && !f.orphan ? { open: {
				read: f.open.read,
				write: f.open.write,
				append: f.open.append,
				ino: String(f.open.ino)
			} } : {},
			...f.file && (f.orphan || !f.open) || f.stale ? { orphan: true } : {},
			...f.dir ? { dir: f.dir.map((e) => ({
				name: e.name,
				type: e.type,
				ino: big(e.ino),
				dev: big(e.dev)
			})) } : {}
		}));
	}
	async restore(saved) {
		await Promise.all(saved.map(async (s) => {
			const f = {
				path: s.path,
				type: s.type,
				chain: Promise.resolve(),
				...s.dir ? { dir: s.dir.map((e) => ({
					name: e.name,
					type: e.type,
					ino: unbig(e.ino),
					dev: unbig(e.dev)
				})) } : {}
			};
			this.#fids.set(s.fid, f);
			if (s.orphan) f.stale = true;
			if (!s.open) return;
			const o = s.open;
			let file;
			let late = false;
			let timer;
			try {
				const t = this.exp.timeout;
				const opening = (async () => {
					const opened = await this.#fs.open(s.path, {
						read: o.read,
						write: o.write,
						truncate: false,
						append: o.append
					});
					if (late) {
						await opened.close?.();
						return false;
					}
					file = opened;
					const a = opened.getattr ? await opened.getattr() : await this.#fs.getattr(s.path);
					return a.type === "file" && String(inode(s.path, a.ino, a.dev)) === o.ino && (!o.write || !!opened.write);
				})();
				if (await (t > 0 ? Promise.race([opening, new Promise((r) => timer = setTimeout(() => r(false), t))]) : opening)) {
					f.file = file;
					f.open = {
						read: o.read,
						write: o.write,
						append: o.append,
						ino: BigInt(o.ino)
					};
					return;
				}
			} catch {} finally {
				clearTimeout(timer);
			}
			late = true;
			f.stale = true;
			if (file) Promise.resolve(file.close?.()).catch(() => {});
		}));
	}
	#orphan(path) {
		for (const f of this.#fids.values()) if (f.file && f.path === path) f.orphan = true;
	}
	#log(msg) {
		this.exp.server.log(`[9p] ${this.exp.name}: ${msg}`);
	}
	destroy() {
		if (this.#destroyed) return;
		this.#destroyed = true;
		for (const p of this.#pending.values()) {
			clearTimeout(p.timer);
			p.resolve(null);
		}
		this.#pending.clear();
		for (const f of this.#fids.values()) this.#closeFile(f);
		this.#fids.clear();
	}
	flush(tag) {
		const p = this.#pending.get(tag);
		if (!p) return;
		p.dead = true;
		clearTimeout(p.timer);
		this.#pending.delete(tag);
		p.resolve(null);
	}
	#closeFile(f) {
		const file = f.file;
		f.file = void 0;
		f.open = void 0;
		if (file?.close) this.#ordered(f, () => file.close()).catch((e) => this.#failed("close", e));
	}
	#failed(what, e) {
		const n = knownErrno(e);
		if (!n) this.#log(`${what}: ${errorText(e)}`);
		return n || ERRNO$1.EIO;
	}
	call(frame) {
		const type = typeOf(frame), tag = tagOf(frame);
		if (this.#destroyed) return Promise.resolve(null);
		return new Promise((resolve) => {
			const state = {
				dead: false,
				resolve
			};
			this.#pending.set(tag, state);
			const timeout = this.exp.timeout;
			if (timeout > 0) state.timer = setTimeout(() => {
				if (state.dead) return;
				state.dead = true;
				this.#pending.delete(tag);
				this.#log(`${MSG_NAMES[type] ?? type}: the handler did not answer within ${timeout} ms; the guest gets ETIMEDOUT`);
				resolve(errorReply(tag, ERRNO$1.ETIMEDOUT));
			}, timeout);
			let run;
			try {
				run = this.#handle(type, new Reader$1(frame), state);
			} catch (e) {
				run = Promise.reject(e);
			}
			run.then((w) => w.finish(type + 1, tag), (e) => errorReply(tag, this.#failed(MSG_NAMES[type] ?? String(type), e))).then((reply) => {
				clearTimeout(state.timer);
				if (this.#pending.get(tag) === state) this.#pending.delete(tag);
				if (!state.dead) resolve(reply);
			});
		});
	}
	#fid(n) {
		const f = this.#fids.get(n);
		if (!f) throw new FsError("EBADF", `unknown fid ${n}`);
		return f;
	}
	#dir(n) {
		const f = this.#fid(n);
		if (f.type !== "dir") throw new FsError("ENOTDIR");
		return f;
	}
	#ordered(f, op) {
		const p = f.chain.then(op);
		const t = this.exp.timeout;
		let timer;
		f.chain = (t > 0 ? Promise.race([p, new Promise((r) => timer = setTimeout(r, t))]) : p).catch(() => {}).finally(() => clearTimeout(timer));
		return p;
	}
	#need(k, code = "EROFS") {
		const fn = this.#fs[k];
		if (typeof fn !== "function") throw new FsError(code);
		return fn.bind(this.#fs);
	}
	async #open(f, state, file, write) {
		const opened = await file;
		if (state.dead || write && !opened.write) {
			await opened.close?.();
			if (!state.dead) throw new FsError("EACCES", `${f.path}: not writable`);
		} else {
			if (f.file) this.#closeFile(f);
			f.file = opened;
		}
		return opened;
	}
	#renamed(from, to) {
		for (const f of this.#fids.values()) if (under(f.path, from)) f.path = to + f.path.slice(from.length);
	}
	async #handle(type, r, state) {
		const fs = this.#fs;
		if (this.exp.readOnly) {
			const flags = type === Tlopen ? new DataView(r.buf.buffer, r.buf.byteOffset).getUint32(11, true) : 0;
			if (MUTATING.has(type) || type === Tlopen && (flags & O_ACCMODE || flags & O_TRUNC)) throw new FsError("EROFS");
			if (type === Tremove) {
				const n = r.u32();
				const f = this.#fid(n);
				this.#fids.delete(n);
				this.#closeFile(f);
				throw new FsError("EROFS");
			}
		}
		switch (type) {
			case Tversion: {
				const msize = r.u32();
				const version = r.str();
				this.#msize = Math.max(4096, Math.min(msize, this.#msize));
				for (const f of this.#fids.values()) this.#closeFile(f);
				this.#fids.clear();
				return new Writer(32).u32(this.#msize).str(version.startsWith(P9_VERSION) ? P9_VERSION : "unknown");
			}
			case Tauth: throw new FsError("EOPNOTSUPP");
			case Tattach: {
				const fid = r.u32();
				r.u32(), r.str();
				if (r.str() !== this.exp.name) throw new FsError("ENOENT", "an attach to another file system on this connection");
				const a = await fs.getattr("/");
				if (a.type !== "dir") throw new FsError("ENOTDIR", "the file system's root is not a directory");
				if (!state.dead) this.#fids.set(fid, {
					path: "/",
					type: "dir",
					chain: Promise.resolve()
				});
				return new Writer(20).qid(qidOf("/", a));
			}
			case Twalk: {
				const fid = r.u32(), newfid = r.u32(), n = r.u16();
				const f = this.#fid(fid);
				let path = f.path, ftype = f.type;
				const qids = [];
				for (let i = 0; i < n; i++) {
					let a;
					try {
						const name = r.name();
						if (ftype !== "dir") throw new FsError("ENOTDIR");
						const next = name === ".." ? parent(path) : (checkName$1(name), join(path, name));
						a = await fs.getattr(next);
						path = next;
					} catch (e) {
						if (i === 0) throw e;
						break;
					}
					qids.push(qidOf(path, a));
					ftype = a.type;
				}
				if (qids.length === n && !state.dead) {
					const old = this.#fids.get(newfid);
					if (old) this.#closeFile(old);
					this.#fids.set(newfid, {
						path,
						type: ftype,
						chain: old?.chain ?? Promise.resolve()
					});
				}
				const w = new Writer(9 + 13 * qids.length).u16(qids.length);
				for (const q of qids) w.qid(q);
				return w;
			}
			case Tclunk:
			case Tremove: {
				const n = r.u32();
				const f = this.#fid(n);
				this.#fids.delete(n);
				const file = f.file;
				f.file = void 0;
				await this.#ordered(f, () => file?.close?.());
				if (type === Tremove) {
					if (f.path === "/") throw new FsError("EBUSY");
					await this.#need("remove")(f.path, f.type === "dir");
					this.#orphan(f.path);
				}
				return new Writer(HDR$2);
			}
			case Tstatfs: {
				this.#fid(r.u32());
				const s = await fs.statfs?.() ?? {};
				return new Writer(67).u32(V9FS_MAGIC).u32(s.bsize ?? 4096).u64(s.blocks ?? 0).u64(s.bfree ?? 0).u64(s.bavail ?? s.bfree ?? 0).u64(s.files ?? 0).u64(s.ffree ?? 0).u64(0).u32(s.namelen ?? 255);
			}
			case Tlopen: {
				const f = this.#fid(r.u32());
				const flags = r.u32();
				const write = (flags & O_ACCMODE) !== 0;
				let a = await fs.getattr(f.path);
				f.type = a.type;
				if (a.type === "file") {
					const truncate = (flags & O_TRUNC) !== 0;
					const read = (flags & O_ACCMODE) !== 1, append = (flags & O_APPEND) !== 0;
					const file = await this.#open(f, state, fs.open(f.path, {
						read,
						write,
						truncate,
						append
					}), write);
					if (truncate) a = await file.getattr?.() ?? await fs.getattr(f.path);
					if (!state.dead && f.file === file) f.open = {
						read,
						write,
						append,
						ino: inode(f.path, a.ino, a.dev)
					};
				}
				f.dir = void 0;
				return new Writer(24).qid(qidOf(f.path, a)).u32(0);
			}
			case Tlcreate: {
				const f = this.#dir(r.u32());
				const name = r.name();
				const flags = r.u32(), mode = r.u32();
				checkName$1(name);
				const path = join(f.path, name);
				let file;
				let how = {
					read: true,
					write: true,
					append: false
				};
				try {
					file = await this.#open(f, state, this.#need("create")(path, mode & 4095), false);
				} catch (e) {
					if (flags & O_EXCL || e?.code !== "EEXIST") throw e;
					const a = await fs.getattr(path);
					if (a.type !== "file") throw new FsError(a.type === "dir" ? "EISDIR" : "EEXIST");
					how = {
						read: (flags & O_ACCMODE) !== 1,
						write: true,
						append: (flags & O_APPEND) !== 0
					};
					file = await this.#open(f, state, fs.open(path, {
						...how,
						truncate: (flags & O_TRUNC) !== 0
					}), true);
				}
				const a = await file.getattr?.() ?? await fs.getattr(path);
				if (!state.dead) {
					f.path = path;
					f.type = "file";
					if (f.file === file) f.open = {
						...how,
						ino: inode(path, a.ino, a.dev)
					};
				}
				return new Writer(24).qid(qidOf(path, a)).u32(0);
			}
			case Tmkdir:
			case Tsymlink: {
				const f = this.#dir(r.u32());
				const name = r.name();
				checkName$1(name);
				const path = join(f.path, name);
				if (type === Tmkdir) await this.#need("mkdir")(path, r.u32() & 4095);
				else await this.#need("symlink", "EOPNOTSUPP")(path, r.name());
				return new Writer(20).qid(qidOf(path, await fs.getattr(path)));
			}
			case Tlink: throw new FsError("EPERM", "no hard links");
			case Tmknod: throw new FsError("EOPNOTSUPP");
			case Tunlinkat: {
				const f = this.#dir(r.u32());
				const name = r.name();
				const flags = r.u32();
				checkName$1(name);
				await this.#need("remove")(join(f.path, name), !!(flags & AT_REMOVEDIR));
				this.#orphan(join(f.path, name));
				return new Writer(HDR$2);
			}
			case Trenameat:
			case Trename: {
				let from, to;
				if (type === Trenameat) {
					const od = this.#dir(r.u32()), oname = r.name(), nd = this.#dir(r.u32()), nname = r.name();
					checkName$1(oname);
					checkName$1(nname);
					from = join(od.path, oname);
					to = join(nd.path, nname);
				} else {
					const f = this.#fid(r.u32()), d = this.#dir(r.u32()), name = r.name();
					checkName$1(name);
					from = f.path;
					to = join(d.path, name);
				}
				if (from === "/" || under(to, from) && to !== from) throw new FsError(from === "/" ? "EBUSY" : "EINVAL");
				if (from !== to) {
					await this.#need("rename")(from, to);
					this.#orphan(to);
					this.#renamed(from, to);
				}
				return new Writer(HDR$2);
			}
			case Treadlink: {
				const f = this.#fid(r.u32());
				return new Writer().str(await this.#need("readlink", "EINVAL")(f.path));
			}
			case Tgetattr: {
				const f = this.#fid(r.u32());
				const file = fileOf(f);
				const a = file?.getattr ? await file.getattr() : await fs.getattr(f.path);
				const size = a.size ?? 0;
				const perm = a.mode ?? (a.type === "dir" ? 493 : a.type === "symlink" ? 511 : 420);
				const fmt = a.type === "dir" ? S_IFDIR : a.type === "symlink" ? S_IFLNK : S_IFREG;
				const w = new Writer(160).u64(P9_STATS_BASIC).qid(qidOf(f.path, a)).u32(fmt | perm & 4095).u32(a.uid ?? 1e3).u32(a.gid ?? 1e3).u64(a.nlink ?? (a.type === "dir" ? 2 : 1)).u64(0).u64(size).u64(4096).u64(Math.ceil(size / 512));
				const m = a.mtimeMs ?? Date.now();
				for (const t of [
					a.atimeMs ?? m,
					m,
					a.ctimeMs ?? m,
					0
				]) {
					const s = Math.floor(t / 1e3);
					w.u64(s).u64(Math.min(999999999, Math.round((t - s * 1e3) * 1e6)));
				}
				return w.u64(0).u64(0);
			}
			case Tsetattr: {
				const f = this.#fid(r.u32());
				const valid = r.u32(), mode = r.u32(), uid = r.u32(), gid = r.u32(), size = r.u64();
				const as = r.u64(), an = r.u64(), ms = r.u64(), mn = r.u64();
				const attr = {};
				if (valid & 1) attr.mode = mode & 4095;
				if (valid & 2) attr.uid = uid;
				if (valid & 4) attr.gid = gid;
				if (valid & 8) attr.size = size;
				if (valid & 16) attr.atimeMs = valid & 128 ? as * 1e3 + an / 1e6 : Date.now();
				if (valid & 32) attr.mtimeMs = valid & 256 ? ms * 1e3 + mn / 1e6 : Date.now();
				const file = fileOf(f);
				if (Object.keys(attr).length) await this.#ordered(f, () => file?.setattr ? file.setattr(attr) : this.#need("setattr")(f.path, attr));
				return new Writer(HDR$2);
			}
			case Treaddir: {
				const f = this.#fid(r.u32());
				const offset = r.u64(), count = r.u32();
				if (f.type !== "dir") throw new FsError("ENOTDIR");
				if (offset === 0 || !f.dir) f.dir = [
					{
						name: ".",
						type: "dir"
					},
					{
						name: "..",
						type: "dir"
					},
					...await fs.readdir(f.path)
				];
				const max = Math.min(count, this.#msize - HDR$2 - 4);
				const w = new Writer(Math.min(max, 65536) + HDR$2 + 4);
				w.u32(0);
				const start = w.n;
				for (let i = offset; i < f.dir.length; i++) {
					const e = f.dir[i];
					const name = enc$4.encode(e.name);
					if (w.n - start + 24 + name.length > max) break;
					const path = e.name === "." ? f.path : e.name === ".." ? parent(f.path) : join(f.path, e.name);
					w.u8(qidType(e.type)).u32(0).u64(inode(path, e.ino, e.dev));
					w.u64(i + 1).u8(e.type === "dir" ? DT_DIR : e.type === "symlink" ? DT_LNK : DT_REG);
					w.u16(name.length).bytes(name);
				}
				w.dv.setUint32(HDR$2, w.n - start, true);
				return w;
			}
			case Tread: {
				const f = this.#fid(r.u32());
				const offset = r.u64(), count = Math.min(r.u32(), this.#msize - HDR$2 - 4);
				const file = fileOf(f);
				if (!file) throw new FsError(f.type === "dir" ? "EISDIR" : "EBADF");
				const data = await file.read(offset, count);
				const n = Math.min(data.length, count);
				return new Writer(11 + n).u32(n).bytes(n === data.length ? data : data.subarray(0, n));
			}
			case Twrite: {
				const f = this.#fid(r.u32());
				const offset = r.u64(), count = r.u32();
				const data = r.bytes(count);
				const file = fileOf(f);
				if (!file?.write) throw new FsError(f.type === "dir" ? "EISDIR" : "EBADF");
				this.exp.stats.bytesWritten += count;
				return new Writer(11).u32(await this.#ordered(f, () => file.write(offset, data)));
			}
			case Tfsync: {
				const f = this.#fid(r.u32());
				const file = fileOf(f);
				await this.#ordered(f, () => file?.fsync?.());
				return new Writer(HDR$2);
			}
			case Tlock:
				this.#fid(r.u32());
				return new Writer(8).u8(0);
			case Tgetlock: {
				this.#fid(r.u32());
				r.u8();
				const start = r.u64(), length = r.u64(), procId = r.u32(), client = r.str();
				return new Writer().u8(2).u64(start).u64(length).u32(procId).str(client);
			}
			case Txattrwalk:
			case Txattrcreate: throw new FsError("EOPNOTSUPP");
			default: throw new FsError("EOPNOTSUPP", `unknown message type ${type}`);
		}
	}
};
const enc$3 = new TextEncoder();
const dec$1 = new TextDecoder();
const EMPTY = /* @__PURE__ */ new Uint8Array(0);
function parts(path) {
	return path.split("/").filter((p) => p && p !== ".");
}
function checkName(name, path) {
	if (!name || name === ".." || name.includes("\0")) throw new FsError("EINVAL", `bad name in ${JSON.stringify(path)}`);
}
var MemoryFs = class {
	#root;
	#nextIno = 2;
	#listeners = /* @__PURE__ */ new Set();
	constructor(tree) {
		const now = Date.now();
		this.#root = {
			ino: 1,
			type: "dir",
			mode: 493,
			uid: FS_DEFAULT_OWNER,
			gid: FS_DEFAULT_OWNER,
			atimeMs: now,
			mtimeMs: now,
			ctimeMs: now,
			version: 1,
			nlink: 2,
			children: /* @__PURE__ */ new Map()
		};
		if (tree) this.#fill("", tree);
	}
	#fill(dir, tree) {
		for (const [name, v] of Object.entries(tree)) {
			const path = `${dir}/${name}`;
			if (typeof v === "string" || v instanceof Uint8Array || typeof v === "function") this.writeFile(path, v);
			else if (v && typeof v === "object") {
				this.mkdirp(path);
				this.#fill(path, v);
			} else throw new TypeError(`MemoryFs: ${path}: a file is a string, a Uint8Array or a function, a directory an object`);
		}
	}
	onChange(listener) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	#emit(type, path, to) {
		for (const l of this.#listeners) try {
			l(to === void 0 ? {
				type,
				path
			} : {
				type,
				path,
				to
			});
		} catch {}
	}
	#lookup(path) {
		let n = this.#root;
		for (const part of parts(path)) {
			if (!n.children) throw new FsError("ENOTDIR", path);
			const c = n.children.get(part);
			if (!c) throw new FsError("ENOENT", path);
			n = c;
		}
		return n;
	}
	#find(path) {
		try {
			return this.#lookup(path);
		} catch {
			return;
		}
	}
	#dirOf(path) {
		const p = parts(path);
		const name = p.pop();
		if (name === void 0) throw new FsError("EBUSY", "the root");
		checkName(name, path);
		const dir = this.#lookup(p.join("/"));
		if (!dir.children) throw new FsError("ENOTDIR", path);
		return {
			dir,
			name
		};
	}
	#node(type, mode, extra = {}) {
		const now = Date.now();
		return {
			ino: this.#nextIno++,
			type,
			mode,
			uid: FS_DEFAULT_OWNER,
			gid: FS_DEFAULT_OWNER,
			atimeMs: now,
			mtimeMs: now,
			ctimeMs: now,
			version: 1,
			nlink: type === "dir" ? 2 : 1,
			...extra
		};
	}
	#touchDir(dir) {
		dir.mtimeMs = dir.ctimeMs = Date.now();
		dir.version++;
	}
	#bytes(n) {
		if (n.dynamic) {
			const v = n.dynamic();
			return typeof v === "string" ? enc$3.encode(v) : v;
		}
		return n.data ? n.data.subarray(0, n.size ?? n.data.length) : EMPTY;
	}
	#changed(n) {
		n.mtimeMs = n.ctimeMs = Date.now();
		n.version++;
	}
	#ensure(n, size) {
		const cur = n.data ?? EMPTY;
		if (size <= cur.length) return;
		const b = new Uint8Array(Math.max(size, cur.length * 2, 4096));
		b.set(cur.subarray(0, n.size ?? cur.length));
		n.data = b;
	}
	#writeNode(n, offset, data) {
		if (n.type !== "file") throw new FsError("EISDIR");
		if (n.dynamic) throw new FsError("EACCES");
		this.#ensure(n, offset + data.length);
		n.data.set(data, offset);
		const size = n.size ?? 0;
		if (offset > size) n.data.fill(0, size, offset);
		n.size = Math.max(size, offset + data.length);
		this.#changed(n);
		return data.length;
	}
	#truncate(n, size) {
		if (n.type !== "file") throw new FsError(n.type === "dir" ? "EISDIR" : "EINVAL");
		if (n.dynamic) throw new FsError("EACCES");
		const old = n.size ?? 0;
		if (size > old) {
			this.#ensure(n, size);
			n.data.fill(0, old, size);
		}
		n.size = size;
		this.#changed(n);
	}
	#attr(n, size) {
		size ??= n.type === "file" ? n.dynamic ? this.#bytes(n).length : n.size ?? 0 : n.type === "symlink" ? enc$3.encode(n.target).length : 4096;
		return {
			type: n.type,
			mode: n.mode,
			size,
			uid: n.uid,
			gid: n.gid,
			nlink: n.nlink,
			ino: n.ino,
			atimeMs: n.atimeMs,
			mtimeMs: n.mtimeMs,
			ctimeMs: n.ctimeMs,
			version: n.dynamic ? 0 : n.version
		};
	}
	#setattr(n, attr) {
		if (attr.size !== void 0) this.#truncate(n, attr.size);
		if (attr.mode !== void 0) n.mode = attr.mode & 4095;
		if (attr.uid !== void 0) n.uid = attr.uid;
		if (attr.gid !== void 0) n.gid = attr.gid;
		if (attr.atimeMs !== void 0) n.atimeMs = attr.atimeMs;
		if (attr.mtimeMs !== void 0) {
			n.mtimeMs = attr.mtimeMs;
			n.version++;
		}
		n.ctimeMs = Date.now();
	}
	#unlinkNode(dir, name, n) {
		dir.children.delete(name);
		if (n.type === "dir") dir.nlink--;
		n.nlink--;
		n.ctimeMs = Date.now();
		this.#touchDir(dir);
	}
	writeFile(path, content, opts = {}) {
		const p = parts(path);
		if (p.length > 1) this.mkdirp(p.slice(0, -1).join("/"));
		const { dir, name } = this.#dirOf(path);
		const old = dir.children.get(name);
		if (old?.type === "dir") throw new FsError("EISDIR", path);
		const mode = opts.mode ?? old?.mode ?? 420;
		if (old && old.type === "file") {
			old.mode = mode;
			if (typeof content === "function") {
				old.dynamic = content;
				old.data = void 0;
				old.size = 0;
			} else {
				const data = typeof content === "string" ? enc$3.encode(content) : content.slice();
				old.dynamic = void 0;
				old.data = data;
				old.size = data.length;
			}
			this.#changed(old);
			return;
		}
		const n = typeof content === "function" ? this.#node("file", mode, { dynamic: content }) : (() => {
			const data = typeof content === "string" ? enc$3.encode(content) : content.slice();
			return this.#node("file", mode, {
				data,
				size: data.length
			});
		})();
		if (old) this.#unlinkNode(dir, name, old);
		dir.children.set(name, n);
		this.#touchDir(dir);
	}
	readFile(path) {
		const n = this.#lookup(path);
		if (n.type !== "file") throw new FsError(n.type === "dir" ? "EISDIR" : "EINVAL", path);
		return this.#bytes(n).slice();
	}
	readText(path) {
		return dec$1.decode(this.readFile(path));
	}
	mkdirp(path, opts = {}) {
		let n = this.#root;
		let cur = "";
		for (const part of parts(path)) {
			checkName(part, path);
			cur += `/${part}`;
			let c = n.children.get(part);
			if (!c) {
				c = this.#node("dir", opts.mode ?? 493, { children: /* @__PURE__ */ new Map() });
				n.children.set(part, c);
				n.nlink++;
				this.#touchDir(n);
			} else if (c.type !== "dir") throw new FsError("ENOTDIR", cur);
			n = c;
		}
	}
	writeLink(path, target) {
		const p = parts(path);
		if (p.length > 1) this.mkdirp(p.slice(0, -1).join("/"));
		const { dir, name } = this.#dirOf(path);
		const old = dir.children.get(name);
		if (old?.type === "dir") throw new FsError("EISDIR", path);
		if (old) this.#unlinkNode(dir, name, old);
		dir.children.set(name, this.#node("symlink", 511, { target }));
		this.#touchDir(dir);
	}
	rm(path, opts = {}) {
		let d;
		try {
			d = this.#dirOf(path);
		} catch (e) {
			if (opts.force && e.code === "ENOENT") return;
			throw e;
		}
		const n = d.dir.children.get(d.name);
		if (!n) {
			if (opts.force) return;
			throw new FsError("ENOENT", path);
		}
		if (n.children?.size && !opts.recursive) throw new FsError("ENOTEMPTY", path);
		this.#unlinkNode(d.dir, d.name, n);
	}
	move(from, to) {
		this.#rename(from, to);
	}
	list(path = "/") {
		const n = this.#lookup(path);
		if (!n.children) throw new FsError("ENOTDIR", path);
		return [...n.children.keys()];
	}
	stat(path) {
		const n = this.#find(path);
		return n && this.#attr(n);
	}
	exists(path) {
		return this.#find(path) !== void 0;
	}
	getattr(path) {
		return this.#attr(this.#lookup(path));
	}
	readdir(path) {
		const n = this.#lookup(path);
		if (!n.children) throw new FsError("ENOTDIR", path);
		return [...n.children].map(([name, c]) => ({
			name,
			type: c.type,
			ino: c.ino
		}));
	}
	readlink(path) {
		const n = this.#lookup(path);
		if (n.type !== "symlink") throw new FsError("EINVAL", path);
		return n.target;
	}
	open(path, flags) {
		const n = this.#lookup(path);
		if (n.type !== "file") throw new FsError("EISDIR", path);
		if (flags.write && n.dynamic) throw new FsError("EACCES", path);
		if (flags.truncate) {
			this.#truncate(n, 0);
			this.#emit("truncate", path);
		}
		return this.#file(n, path);
	}
	#file(n, path) {
		if (n.dynamic) {
			const b = this.#bytes(n);
			return {
				read: (offset, length) => b.subarray(Math.min(offset, b.length), Math.min(offset + length, b.length)),
				getattr: () => this.#attr(n, b.length),
				setattr: (attr) => {
					this.#setattr(n, attr);
					this.#emit("setattr", path);
				}
			};
		}
		return {
			read: (offset, length) => {
				const b = this.#bytes(n);
				return b.subarray(Math.min(offset, b.length), Math.min(offset + length, b.length));
			},
			write: (offset, data) => {
				const r = this.#writeNode(n, offset, data);
				this.#emit("write", path);
				return r;
			},
			getattr: () => this.#attr(n),
			setattr: (attr) => {
				this.#setattr(n, attr);
				this.#emit(attr.size !== void 0 ? "truncate" : "setattr", path);
			}
		};
	}
	create(path, mode) {
		const { dir, name } = this.#dirOf(path);
		if (dir.children.has(name)) throw new FsError("EEXIST", path);
		const n = this.#node("file", mode & 4095, {
			data: EMPTY,
			size: 0
		});
		dir.children.set(name, n);
		this.#touchDir(dir);
		this.#emit("create", path);
		return this.#file(n, path);
	}
	mkdir(path, mode) {
		const { dir, name } = this.#dirOf(path);
		if (dir.children.has(name)) throw new FsError("EEXIST", path);
		dir.children.set(name, this.#node("dir", mode & 4095, { children: /* @__PURE__ */ new Map() }));
		dir.nlink++;
		this.#touchDir(dir);
		this.#emit("mkdir", path);
	}
	symlink(path, target) {
		const { dir, name } = this.#dirOf(path);
		if (dir.children.has(name)) throw new FsError("EEXIST", path);
		dir.children.set(name, this.#node("symlink", 511, { target }));
		this.#touchDir(dir);
		this.#emit("symlink", path, target);
	}
	remove(path, dir) {
		const d = this.#dirOf(path);
		const n = d.dir.children.get(d.name);
		if (!n) throw new FsError("ENOENT", path);
		if (dir && n.type !== "dir") throw new FsError("ENOTDIR", path);
		if (!dir && n.type === "dir") throw new FsError("EISDIR", path);
		if (n.children?.size) throw new FsError("ENOTEMPTY", path);
		this.#unlinkNode(d.dir, d.name, n);
		this.#emit("remove", path);
	}
	rename(from, to) {
		this.#rename(from, to);
		this.#emit("rename", from, to);
	}
	#rename(from, to) {
		const a = this.#dirOf(from), b = this.#dirOf(to);
		const n = a.dir.children.get(a.name);
		if (!n) throw new FsError("ENOENT", from);
		if (n.type === "dir") {
			let p = this.#root;
			for (const part of parts(to).slice(0, -1)) {
				if (p === n) break;
				p = p.children.get(part);
			}
			if (p === n) throw new FsError("EINVAL", `${from} into itself`);
		}
		const old = b.dir.children.get(b.name);
		if (old === n) return;
		if (old) {
			if (old.type === "dir" && n.type !== "dir") throw new FsError("EISDIR", to);
			if (old.type !== "dir" && n.type === "dir") throw new FsError("ENOTDIR", to);
			if (old.children?.size) throw new FsError("ENOTEMPTY", to);
			this.#unlinkNode(b.dir, b.name, old);
		}
		a.dir.children.delete(a.name);
		b.dir.children.set(b.name, n);
		if (n.type === "dir" && a.dir !== b.dir) {
			a.dir.nlink--;
			b.dir.nlink++;
		}
		n.ctimeMs = Date.now();
		this.#touchDir(a.dir);
		if (b.dir !== a.dir) this.#touchDir(b.dir);
	}
	setattr(path, attr) {
		this.#setattr(this.#lookup(path), attr);
		this.#emit(attr.size !== void 0 ? "truncate" : "setattr", path);
	}
	statfs() {
		let files = 0, bytes = 0;
		const walk = (n) => {
			files++;
			bytes += n.data?.length ?? 0;
			if (n.children) for (const c of n.children.values()) walk(c);
		};
		walk(this.#root);
		const blocks = Math.max(1 << 18, Math.ceil(bytes / 4096) * 2);
		return {
			bsize: 4096,
			blocks,
			bfree: blocks - Math.ceil(bytes / 4096),
			files: Math.max(65536, files * 2),
			ffree: Math.max(65536, files * 2) - files
		};
	}
};
var MountError = class extends Error {
	code;
	constructor(code, message, cause) {
		super(message, cause === void 0 ? void 0 : { cause });
		this.name = "MountError";
		this.code = code;
	}
};
function snapshotMountMismatch(saved, given) {
	for (const m of saved?.mounts ?? []) {
		const g = given.find((x) => x.path === m.path);
		if (!g) return `the snapshot has a host file system at ${m.path}, which this machine is not given (mounts)`;
		if (!!g.opts.readOnly !== m.readOnly) return `the host file system at ${m.path} is ${m.readOnly ? "" : "not "}read-only in the snapshot`;
	}
	return null;
}
const BOOT_TIMEOUT_MS$1 = 12e4;
const DEFAULT_TIMEOUT_MS$1 = 3e4;
const SPEC_KEYS = /* @__PURE__ */ new Set([
	"fs",
	"readOnly",
	"timeout",
	"requestTimeout"
]);
const isFs = (v) => !!v && typeof v === "object" && typeof v.getattr === "function";
function isSpec(v) {
	if (!v || typeof v !== "object" || isFs(v) || !("fs" in v)) return false;
	const fs = v.fs;
	return !!fs && typeof fs === "object" && Object.keys(v).every((k) => SPEC_KEYS.has(k));
}
function toFs(src) {
	if (isFs(src)) return src;
	if (src && typeof src === "object" && !(src instanceof Uint8Array)) return new MemoryFs(src);
	throw new MountError("EINVAL", "a file system is an Fs (MemoryFs, nodeFs(), your own) or an object tree of files");
}
function normalizeMountPath(path) {
	if (typeof path !== "string" || !path.startsWith("/") || /[\0,]/.test(path)) throw new MountError("EINVAL", `mount path ${JSON.stringify(path)}: an absolute guest path`);
	const parts = path.split("/").filter((p) => p && p !== ".");
	if (parts.includes("..")) throw new MountError("EINVAL", `mount path ${JSON.stringify(path)}: no ".." parts`);
	if (!parts.length) throw new MountError("EINVAL", "mount path \"/\": not over the root");
	return `/${parts.join("/")}`;
}
function parseMounts(mounts, vsock) {
	if (!mounts) return [];
	const list = Object.entries(mounts).map(([path, v]) => {
		const { fs, ...opts } = isSpec(v) ? v : { fs: v };
		toFs(fs);
		return {
			path: normalizeMountPath(path),
			fs,
			opts
		};
	});
	if (list.length && !vsock) throw new MountError("ENODEV", "createKernel({ mounts }) needs the vsock device (the 9p server and kwtty run over it); it was turned off (vsock: false)");
	return list;
}
var MountHandle = class {
	path;
	exp;
	readOnly;
	state = "mounting";
	#table;
	constructor(table, exp, path, readOnly) {
		this.#table = table;
		this.exp = exp;
		this.path = path;
		this.readOnly = readOnly;
	}
	get mounted() {
		return this.state === "mounted" || this.state === "unmounting";
	}
	get stats() {
		return { ...this.exp.stats };
	}
	gone() {
		this.state = "gone";
		this.#table.release(this);
		this.exp.remove();
	}
	unmount(opts = {}) {
		return this.#table.unmount(this, opts);
	}
};
const KWBOX = "/usr/bin/kwbox";
const noKwbox = (msg) => msg.includes(`exec ${KWBOX}: No such file`);
async function guestRun(vsock, file, args, timeout) {
	const ac = new AbortController();
	let timer;
	try {
		return await Promise.race([execSubprocess(vsock, file, args, {
			timeout,
			signal: ac.signal,
			user: "root"
		}), new Promise((_, rej) => timer = setTimeout(() => {
			ac.abort();
			rej(new PtyError("ETIMEDOUT", `${file} did not finish within ${timeout} ms (it was killed)`));
		}, timeout))]);
	} finally {
		clearTimeout(timer);
	}
}
var MountTable = class {
	#vsock;
	#log;
	#server;
	#mounts = /* @__PURE__ */ new Map();
	#boot;
	#down = false;
	constructor(vsock, log) {
		this.#vsock = vsock;
		this.#log = log;
	}
	get mounts() {
		return this.#mounts;
	}
	snapshotBlocker(keep = false) {
		if (this.#boot) return "createKernel's mounts are still being mounted";
		if (!keep && this.#mounts.size) return `host file systems are mounted (${[...this.#mounts.keys()].join(", ")}); unmount them first (only an inline instance's snapshot keeps them)`;
		for (const h of this.#mounts.values()) if (h.state !== "mounted") return `${h.path} is being ${h.state === "mounting" ? "mounted" : "unmounted"}`;
	}
	snapshotBusy() {
		const why = this.snapshotBlocker(true);
		if (why) return why;
		for (const h of this.#mounts.values()) {
			const b = this.#server.exportBusy(h.exp);
			if (b) return `host file system ${h.path}: ${b}`;
		}
		return "";
	}
	save() {
		if (!this.#mounts.size || !this.#server) return void 0;
		return {
			next: this.#server.next,
			mounts: [...this.#mounts.values()].map((h) => ({
				path: h.path,
				readOnly: h.readOnly,
				export: this.#server.saveExport(h.exp)
			}))
		};
	}
	async restore(saved, given) {
		const keep = /* @__PURE__ */ new Set();
		if (!saved?.mounts.length) return {
			keep,
			rest: given
		};
		const vsock = this.#vsock;
		if (!(vsock instanceof VsockHost)) throw new MountError("ENODEV", "host file systems in a snapshot need this instance's vsock host");
		this.#server ??= serve9p(vsock, this.#log);
		this.#server.next = Math.max(this.#server.next, saved.next);
		for (const m of saved.mounts) {
			const g = given.find((x) => x.path === m.path);
			const conn = vsock.adopt(m.export.conn);
			keep.add(`${m.export.conn.remotePort}:${m.export.conn.localPort}`);
			const exp = await this.#server.restoreExport(toFs(g.fs), {
				readOnly: m.readOnly,
				timeout: g.opts.requestTimeout
			}, m.export, conn);
			const h = new MountHandle(this, exp, m.path, m.readOnly);
			h.state = "mounted";
			this.#mounts.set(m.path, h);
			this.#watch(h);
		}
		return {
			keep,
			rest: given.filter((g) => !saved.mounts.some((m) => m.path === g.path))
		};
	}
	#watch(h) {
		h.exp.onConnection = (connected) => {
			if (!connected && h.state === "mounted") {
				this.#log(`[host] ${h.path} was unmounted in the guest`);
				h.gone();
			}
		};
	}
	gate(fn) {
		return this.#boot ? this.#boot.then(fn) : fn();
	}
	mountAll(list) {
		if (!list.length) return;
		const boot = Promise.allSettled(list.map((m) => this.mount(m.path, m.fs, {
			timeout: BOOT_TIMEOUT_MS$1,
			...m.opts
		}))).then((rs) => {
			if (this.#boot === boot) this.#boot = void 0;
			const failed = rs.flatMap((r) => r.status === "rejected" ? [r.reason] : []);
			for (const e of failed) this.#log(`[host] ${e?.message ?? e}`);
			if (failed.length) throw failed[0];
		});
		boot.catch(() => {});
		this.#boot = boot;
	}
	async mount(path, src, opts = {}) {
		const vsock = this.#vsock;
		if (!vsock) throw new MountError("ENODEV", "host file systems need the vsock device, which this instance has not: it was created with vsock: false");
		if (this.#down) throw new MountError("ECONNABORTED", "the kernel exited");
		const p = normalizeMountPath(path);
		const fs = toFs(src);
		if (this.#mounts.has(p)) throw new MountError("EBUSY", `${p}: already mounted by this SDK`);
		if (!this.#server) try {
			this.#server = serve9p(vsock, this.#log);
		} catch (e) {
			throw new MountError("EBUSY", `cannot serve 9p on vsock port 564: ${e?.message ?? e}`, e);
		}
		const exp = this.#server.add(fs, {
			readOnly: opts.readOnly,
			timeout: opts.requestTimeout
		});
		const h = new MountHandle(this, exp, p, !!opts.readOnly);
		this.#mounts.set(p, h);
		this.#watch(h);
		const fail = (e) => {
			h.gone();
			throw e;
		};
		const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS$1;
		let r;
		try {
			r = await guestRun(vsock, KWBOX, [
				"9p",
				exp.name,
				p,
				...opts.readOnly ? ["ro"] : []
			], timeout);
		} catch (e) {
			const code = e instanceof PtyError ? e.code : "";
			const msg = e?.message ?? String(e);
			if (this.#down || code === "ECONNABORTED" || code === "ECONNRESET") fail(new MountError("ECONNABORTED", `mount ${p}: the kernel exited`, e));
			if (code === "ETIMEDOUT") fail(new MountError("ETIMEDOUT", `mount ${p}: ${/killed/.test(msg) ? msg : `no answer from the guest's kwtty within ${timeout} ms (an image without kwtty, or still booting?)`}`, e));
			if (code === "EREMOTE" && noKwbox(msg)) fail(new MountError("ENOENT", `mount ${p}: the guest has no ${KWBOX} (a base from before kwbox)`, e));
			fail(new MountError("EREMOTE", `mount ${p}: ${msg}`, e));
		}
		if (r.exitCode !== 0) {
			const text = (r.stderr || r.stdout).trim().split("\n").pop() ?? "";
			const errno = Number(/\(errno (\d+)\)\s*$/.exec(text)?.[1] ?? 0);
			const why = `mount ${p}: ${text.replace(/^kw9p: /, "").replace(/\s*\(errno \d+\)\s*$/, "") || `kw9p exited with ${r.exitCode ?? `signal ${r.signal}`}`}`;
			if (errno === 19) fail(new MountError("ENODEV", `${why} (the guest's kernel has no 9p file system, CONFIG_9P_FS)`));
			if (errno === 16) fail(new MountError("EBUSY", why));
			if (errno === 20) fail(new MountError("ENOTDIR", why));
			fail(new MountError("EREMOTE", why));
		}
		if (this.#down) fail(new MountError("ECONNABORTED", `mount ${p}: the kernel exited`));
		if (h.state === "mounting") h.state = "mounted";
		return h;
	}
	release(h) {
		if (this.#mounts.get(h.path) === h) this.#mounts.delete(h.path);
	}
	async unmount(h, opts) {
		const vsock = this.#vsock;
		if (h.state === "gone" || h.state === "mounting" || !vsock || this.#down) return h.gone();
		if (h.state === "unmounting") throw new MountError("EBUSY", `${h.path}: an unmount is already running`);
		h.state = "unmounting";
		let r;
		try {
			r = await guestRun(vsock, "umount", [h.path], opts.timeout ?? DEFAULT_TIMEOUT_MS$1);
		} catch (e) {
			if (this.#down || e.code === "ECONNABORTED") return h.gone();
			h.state = "mounted";
			throw new MountError(e.code === "ETIMEDOUT" ? "ETIMEDOUT" : "EREMOTE", `unmount ${h.path}: ${e?.message ?? e}`, e);
		}
		const text = (r.stderr || r.stdout).trim();
		if (r.exitCode !== 0 && !/not mounted|Invalid argument|No such file/i.test(text)) {
			h.state = "mounted";
			throw new MountError(/busy/i.test(text) ? "EBUSY" : "EREMOTE", `unmount ${h.path}: ${text || `umount exited with ${r.exitCode}`}`);
		}
		const end = performance.now() + 2e3;
		while (h.exp.connected && performance.now() < end && !this.#down) await new Promise((res) => setTimeout(res, 10));
		h.gone();
	}
	shutdown() {
		if (this.#down) return;
		this.#down = true;
		for (const h of [...this.#mounts.values()]) h.state = "gone";
		this.#mounts.clear();
		this.#server?.close();
	}
};
const CMD_PORT = 1020;
const CMD_START = 1;
const CMD_DATA = 2;
const CMD_EXIT = 4;
const CMD_ERROR = 5;
const CMD_EOF = 7;
const CMD_STDERR = 8;
const CMD_STDIN = 9;
const CMD_ARG = 10;
const CMD_ENV = 11;
const START_SIZE = 20;
const MAX_WRITE = 16384;
const BOOT_TIMEOUT_MS = 12e4;
const DEFAULT_TIMEOUT_MS = 3e4;
var CommandError = class extends Error {
	code;
	constructor(code, message, cause) {
		super(message, cause === void 0 ? void 0 : { cause });
		this.name = "CommandError";
		this.code = code;
	}
};
function checkCommandName(name) {
	if (typeof name !== "string" || !/^[A-Za-z0-9_+][A-Za-z0-9._+-]{0,63}$/.test(name) || name === "kwcmd" || name === "kwbox") throw new CommandError("EINVAL", `command name ${JSON.stringify(name)}: 1 to 64 letters, digits, ".", "_", "+" or "-", not starting with "." or "-", and not "kwcmd" or "kwbox"`);
	return name;
}
function parseCommands(commands, vsock) {
	const list = Object.entries(commands ?? {});
	for (const [name, fn] of list) {
		checkCommandName(name);
		if (typeof fn !== "function") throw new CommandError("EINVAL", `command ${name}: the handler is not a function`);
	}
	if (list.length && !vsock) throw new CommandError("ENODEV", "createKernel({ commands }) needs the vsock device (kwcmd and kwtty run over it); it was turned off (vsock: false)");
	return list;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function serve(conn, commands, log) {
	const reader = conn.readable.getReader();
	const writer = conn.writable.getWriter();
	const parser = new TtyFrameParser();
	const dec = new TextDecoder();
	const enc = new TextEncoder();
	let gone = false;
	let tail = Promise.resolve();
	const send = (frame) => {
		const p = tail.then(() => writer.write(frame));
		tail = p.catch(() => {});
		return p;
	};
	const next = async () => {
		for (;;) {
			const f = parser.next();
			if (f) return f;
			let r;
			try {
				r = await reader.read();
			} catch {
				return;
			}
			if (r.done) return void 0;
			parser.push(r.value);
		}
	};
	const argv = [];
	const env = {};
	let start;
	for (let f = await next(); f; f = await next()) if (f.type === CMD_ARG) argv.push(dec.decode(f.payload));
	else if (f.type === CMD_ENV) {
		const kv = dec.decode(f.payload);
		const eq = kv.indexOf("=");
		if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
	} else if (f.type === CMD_START) {
		start = f.payload;
		break;
	} else if (f.flags & 1) break;
	const refuse = async (msg) => {
		await send(encodeTtyFrame(CMD_ERROR, enc.encode(msg))).catch(() => {});
		conn.close();
	};
	if (!start || start.length < START_SIZE || !argv.length) {
		conn.reset();
		return;
	}
	const dv = new DataView(start.buffer, start.byteOffset, start.length);
	if (dv.getUint16(0, true) < 1) return refuse("kwcmd speaks no protocol version of this host");
	const name = argv[0];
	const handler = commands.get(name);
	if (!handler) return refuse("the host does not provide this command");
	const ttys = dv.getUint16(2, true);
	const ac = new AbortController();
	conn.closed.then(() => {
		gone = true;
		ac.abort(/* @__PURE__ */ new Error(`${name}: the guest process is gone`));
	});
	let ended = false;
	const stdin = new ReadableStream({ pull: async (c) => {
		if (!ended) send(encodeTtyFrame(CMD_STDIN)).catch(() => {});
		while (!ended) {
			const f = await next();
			if (!f || f.type === CMD_EOF) ended = true;
			else if (f.type === CMD_DATA && f.payload.length) {
				c.enqueue(f.payload);
				return;
			}
		}
		c.close();
	} }, { highWaterMark: 0 });
	const output = (type) => new WritableStream({ write: (chunk) => {
		const bytes = typeof chunk === "string" ? enc.encode(chunk) : chunk;
		if (gone) throw new Error(`${name}: the guest process is gone`);
		let last = Promise.resolve();
		for (let i = 0; i < bytes.length; i += MAX_WRITE) last = send(encodeTtyFrame(type, bytes.subarray(i, i + MAX_WRITE)));
		return last;
	} });
	const stdout = output(CMD_DATA), stderr = output(CMD_STDERR);
	const ctx = {
		name,
		args: argv.slice(1),
		env,
		cwd: dec.decode(start.subarray(START_SIZE)) || "/",
		pid: dv.getUint32(8, true),
		uid: dv.getUint32(12, true),
		gid: dv.getUint32(16, true),
		isTTY: {
			stdin: !!(ttys & 1),
			stdout: !!(ttys & 2),
			stderr: !!(ttys & 4)
		},
		rows: dv.getUint16(4, true),
		cols: dv.getUint16(6, true),
		stdin,
		stdout,
		stderr,
		signal: ac.signal
	};
	const direct = (type, data) => {
		const bytes = typeof data === "string" ? enc.encode(data) : data;
		for (let i = 0; i < bytes.length; i += MAX_WRITE) send(encodeTtyFrame(type, bytes.subarray(i, i + MAX_WRITE))).catch(() => {});
	};
	let code = 0, signal = "";
	try {
		const r = await handler(ctx);
		if (typeof r === "number") code = r & 255;
		else if (r && typeof r === "object" && !(r instanceof Uint8Array)) {
			if (r.signal !== void 0) {
				const sig = String(r.signal).replace(/^SIG/, "");
				if (!TTY_SIGNALS.includes(sig)) throw new RangeError(`unknown signal ${JSON.stringify(r.signal)}`);
				signal = sig;
			} else code = (r.exitCode ?? 0) & 255;
		} else if (typeof r === "string" || r instanceof Uint8Array) {
			await drain();
			direct(CMD_DATA, r);
		}
	} catch (e) {
		code = 1;
		if (!gone) {
			await drain();
			direct(CMD_STDERR, `${name}: ${e?.message ?? e}\n`);
			log(`[host] command ${name} failed: ${errorText(e)}`);
		}
	}
	await drain();
	await send(encodeTtyFrame(CMD_EXIT, signal ? Uint8Array.of(1, 0, ...enc.encode(signal)) : Uint8Array.of(0, code))).catch(() => {});
	conn.close();
	async function drain() {
		for (;;) {
			const t = tail;
			await t;
			await tick();
			if (t === tail || gone) return;
		}
	}
}
var CommandTable = class {
	#vsock;
	#log;
	#commands = /* @__PURE__ */ new Map();
	#listener;
	#syncing = Promise.resolve();
	#boot;
	#down = false;
	constructor(vsock, log) {
		this.#vsock = vsock;
		this.#log = log;
	}
	get commands() {
		return this.#commands;
	}
	gate(fn) {
		return this.#boot ? this.#boot.then(fn) : fn();
	}
	addAll(list) {
		if (!list.length) return;
		const boot = (async () => {
			this.#listen();
			for (const [name, fn] of list) this.#commands.set(name, fn);
			await this.#sync(BOOT_TIMEOUT_MS);
		})().finally(() => {
			if (this.#boot === boot) this.#boot = void 0;
		});
		boot.catch((e) => this.#log(`[host] ${e?.message ?? e}`));
		this.#boot = boot;
	}
	async add(name, handler, opts = {}) {
		checkCommandName(name);
		if (typeof handler !== "function") throw new CommandError("EINVAL", `command ${name}: the handler is not a function`);
		this.#listen();
		const had = this.#commands.get(name);
		this.#commands.set(name, handler);
		if (had) return;
		try {
			await this.#sync(opts.timeout ?? DEFAULT_TIMEOUT_MS);
		} catch (e) {
			if (this.#commands.get(name) === handler) this.#commands.delete(name);
			throw e;
		}
	}
	async remove(name, opts = {}) {
		if (!this.#commands.delete(name) || this.#down) return;
		await this.#sync(opts.timeout ?? DEFAULT_TIMEOUT_MS);
	}
	#listen() {
		const vsock = this.#vsock;
		if (!vsock) throw new CommandError("ENODEV", "host commands need the vsock device, which this instance has not: it was created with vsock: false");
		if (this.#down) throw new CommandError("ECONNABORTED", "the kernel exited");
		if (this.#listener) return;
		try {
			this.#listener = vsock.listen(CMD_PORT, (conn) => {
				serve(conn, this.#commands, this.#log).catch((e) => {
					this.#log(`[host] host command: ${errorText(e)}`);
					conn.reset();
				});
			});
		} catch (e) {
			throw new CommandError("EADDRINUSE", `cannot serve host commands on vsock port ${CMD_PORT}: ${e?.message ?? e}`, e);
		}
	}
	#sync(timeout) {
		const run = this.#syncing.then(async () => {
			const vsock = this.#vsock;
			if (this.#down) throw new CommandError("ECONNABORTED", "the kernel exited");
			let r;
			try {
				r = await guestRun(vsock, KWBOX, [
					"cmd",
					"sync",
					...this.#commands.keys()
				], timeout);
			} catch (e) {
				const code = e instanceof PtyError ? e.code : "";
				const msg = e?.message ?? String(e);
				if (this.#down || code === "ECONNABORTED" || code === "ECONNRESET") throw new CommandError("ECONNABORTED", "host commands: the kernel exited", e);
				if (code === "ETIMEDOUT") throw new CommandError("ETIMEDOUT", `host commands: ${/killed/.test(msg) ? msg : `no answer from the guest's kwtty within ${timeout} ms (an image without kwtty, or still booting?)`}`, e);
				if (code === "EREMOTE" && noKwbox(msg)) throw new CommandError("ENOENT", `host commands: the guest has no ${KWBOX} (a base from before kwbox)`, e);
				throw new CommandError("EREMOTE", `host commands: ${msg}`, e);
			}
			if (r.exitCode !== 0) throw new CommandError("EREMOTE", `host commands: ${((r.stderr || r.stdout).trim().split("\n").pop() ?? "").replace(/^kwcmd: /, "").replace(/\s*\(errno \d+\)\s*$/, "") || `kwbox cmd sync exited with ${r.exitCode ?? `signal ${r.signal}`}`}`);
		});
		this.#syncing = run.catch(() => {});
		return run;
	}
	shutdown() {
		if (this.#down) return;
		this.#down = true;
		this.#listener?.close();
		this.#commands.clear();
	}
};
const MUX = {
	OPEN: 1,
	DATA: 2,
	CLOSE: 3,
	READY: 4,
	LOG: 5
};
const MAX = 512 << 20;
function frame$1(type, id, payload) {
	const n = 5 + (payload ? payload.length : 0);
	const f = new Uint8Array(4 + n);
	const v = new DataView(f.buffer);
	v.setUint32(0, n, true);
	v.setUint32(4, id, true);
	f[8] = type;
	if (payload) f.set(payload, 9);
	return f;
}
var Deframer = class {
	#b = /* @__PURE__ */ new Uint8Array(65536);
	#r = 0;
	#w = 0;
	push(chunk) {
		if (this.#w + chunk.length > this.#b.length) {
			this.#b.copyWithin(0, this.#r, this.#w);
			this.#w -= this.#r;
			this.#r = 0;
			if (this.#w + chunk.length > this.#b.length) {
				const b = new Uint8Array(Math.max(this.#b.length * 2, this.#w + chunk.length));
				b.set(this.#b.subarray(0, this.#w));
				this.#b = b;
			}
		}
		this.#b.set(chunk, this.#w);
		this.#w += chunk.length;
	}
	next() {
		if (this.#w - this.#r < 4) return null;
		const n = new DataView(this.#b.buffer, this.#r, 4).getUint32(0, true);
		if (n < 5 || n > MAX) throw new Error(`stream frame of ${n} bytes`);
		if (this.#w - this.#r - 4 < n) return null;
		const m = this.#b.slice(this.#r + 4, this.#r + 4 + n);
		this.#r += 4 + n;
		if (this.#r === this.#w) this.#r = this.#w = 0;
		return m;
	}
};
var StreamHost = class {
	#renderer;
	#routes = /* @__PURE__ */ new Map();
	#nextId = 1;
	#streams = 0;
	#opened = 0;
	constructor(renderer) {
		this.#renderer = renderer;
		renderer.onreply = (rid, bytes) => {
			const r = this.#routes.get(rid);
			if (r) r.send(MUX.DATA, r.id, bytes);
		};
		renderer.onclose = (rid) => {
			const r = this.#routes.get(rid);
			if (!r) return;
			this.#routes.delete(rid);
			r.mine.delete(r.id);
			r.send(MUX.CLOSE, r.id);
		};
	}
	get stats() {
		const renderer = this.#renderer.totals?.();
		return {
			streams: this.#streams,
			clients: this.#routes.size,
			opened: this.#opened,
			...renderer && { renderer }
		};
	}
	async serve(readable, writable, { log = (_) => {} } = {}) {
		const writer = writable.getWriter();
		const reader = readable.getReader();
		const send = (type, id, payload) => void writer.write(frame$1(type, id, payload)).catch(() => {});
		const mine = /* @__PURE__ */ new Map();
		const deframer = new Deframer();
		const text = new TextDecoder();
		this.#streams++;
		send(MUX.READY, 0);
		try {
			for (;;) {
				let m;
				while (m = deframer.next()) {
					const id = new DataView(m.buffer, m.byteOffset, m.byteLength).getUint32(0, true), type = m[4], payload = m.subarray(5);
					const rid = mine.get(id);
					if (type === MUX.OPEN && rid === void 0) {
						const r = this.#nextId++;
						mine.set(id, r);
						this.#routes.set(r, {
							id,
							send,
							mine
						});
						this.#opened++;
						this.#renderer.open(r);
					} else if (type === MUX.DATA && rid !== void 0) {
						const busy = this.#renderer.feed(rid, payload);
						if (busy) await busy;
					} else if (type === MUX.CLOSE && rid !== void 0) {
						mine.delete(id);
						this.#routes.delete(rid);
						this.#renderer.close(rid);
					} else if (type === MUX.LOG) log(text.decode(payload));
				}
				const { value, done } = await reader.read();
				if (done) break;
				deframer.push(value);
			}
			writer.close().catch(() => {});
		} catch (e) {
			reader.cancel(e).catch(() => {});
			writer.abort(e).catch(() => {});
			throw e;
		} finally {
			this.#streams--;
			for (const rid of mine.values()) {
				this.#routes.delete(rid);
				this.#renderer.close(rid);
			}
			mine.clear();
		}
	}
};
const FOURCC_XRGB8888 = 875713112;
const ENODEV$2 = 19;
const DEFAULT_DISPLAY_SIZE = {
	width: 640,
	height: 480
};
var DisplayHost = class {
	enabled;
	#size;
	#offered = null;
	addr = 0;
	#fbMode = null;
	#source = null;
	probed = false;
	stats = {
		attaches: 0,
		detaches: 0
	};
	#memory;
	#onChange;
	#log;
	constructor(opts) {
		this.enabled = !!opts.enabled;
		this.#size = opts.enabled ?? false;
		this.#memory = opts.memory;
		this.#onChange = opts.onChange;
		this.#log = opts.log ?? (() => {});
	}
	#physical(mode) {
		const o = this.#offered;
		if (!o?.dpi || !(o.dpi > 0) || !mode.width || !mode.height) return 0;
		const scale = Math.min(o.width / mode.width, o.height / mode.height);
		const mm = (px) => Math.min(65535, Math.max(1, Math.round(px * scale * 25.4 / o.dpi)));
		return (mm(mode.width) << 16 | mm(mode.height)) >>> 0;
	}
	get mode() {
		return this.#source?.mode ?? this.#fbMode;
	}
	wantedSize() {
		let s = DEFAULT_DISPLAY_SIZE;
		try {
			const o = this.#size;
			if (typeof o === "function") s = o();
			else if (typeof o === "object") s = o;
		} catch (e) {
			this.#log(`[display] size callback failed: ${e}`);
		}
		return s;
	}
	setSize(size) {
		if (this.enabled) this.#size = size;
	}
	setScanout(src) {
		if (!src && !this.#source) return;
		this.#source = src;
		if (src) this.stats.attaches++;
		else this.stats.detaches++;
		try {
			this.#onChange?.(this.mode);
		} catch {}
	}
	imports() {
		return {
			wasm_driver_fb_init: () => {
				this.probed = true;
				return this.enabled ? 0n : -BigInt(ENODEV$2);
			},
			wasm_driver_fb_mode: () => {
				const s = this.wantedSize();
				this.#offered = s;
				const w = Math.min(65535, Math.max(1, Math.round(s.width) || DEFAULT_DISPLAY_SIZE.width));
				const h = Math.min(65535, Math.max(1, Math.round(s.height) || DEFAULT_DISPLAY_SIZE.height));
				return (w << 16 | h) >>> 0;
			},
			wasm_driver_fb_attach: (pixels, width, height, stride, format) => {
				const addr = Number(pixels);
				if (addr) {
					const mode = {
						width: width >>> 0,
						height: height >>> 0,
						stride: stride >>> 0,
						format: format >>> 0
					};
					if (mode.format !== 875713112 || mode.stride < mode.width * 4 || addr % 4 || addr + mode.stride * mode.height > this.#memory().buffer.byteLength) {
						this.#log(`[display] unusable framebuffer at 0x${addr.toString(16)}: ${JSON.stringify(mode)}`);
						return 0;
					}
					this.addr = addr;
					this.#fbMode = mode;
					this.stats.attaches++;
				} else {
					this.addr = 0;
					this.#fbMode = null;
					this.stats.detaches++;
				}
				if (!this.#source) try {
					this.#onChange?.(this.mode);
				} catch {}
				return this.#fbMode ? this.#physical(this.#fbMode) : 0;
			}
		};
	}
	saveState() {
		const o = this.#offered;
		const m = this.#fbMode;
		return {
			addr: this.addr,
			mode: m && { ...m },
			offered: o && {
				width: o.width,
				height: o.height,
				dpi: o.dpi
			}
		};
	}
	restoreState(s) {
		this.probed = true;
		this.#offered = s.offered;
		this.addr = s.mode ? s.addr : 0;
		this.#fbMode = s.mode && this.addr ? { ...s.mode } : null;
		if (this.#fbMode) try {
			this.#onChange?.(this.#fbMode);
		} catch {}
	}
	pixels() {
		if (this.#source) return this.#source.pixels();
		const m = this.#fbMode;
		if (!m || !this.addr) return null;
		return new Uint8Array(this.#memory().buffer, this.addr, m.stride * m.height);
	}
	readRGBA(out) {
		const m = this.mode;
		const px = this.pixels();
		if (!m || !px) return null;
		const { width, height, stride } = m;
		const data = out && out.length === width * height * 4 ? out : new Uint8ClampedArray(width * height * 4);
		const dst = new Uint32Array(data.buffer, data.byteOffset, width * height);
		for (let y = 0; y < height; y++) {
			const src = new Uint32Array(px.buffer, px.byteOffset + y * stride, width);
			const o = y * width;
			for (let x = 0; x < width; x++) {
				const p = src[x];
				dst[o + x] = 4278190080 | (p & 255) << 16 | p & 65280 | p >>> 16 & 255;
			}
		}
		return {
			width,
			height,
			data
		};
	}
};
function xrgbToRgba(src, width, height, out) {
	const n = width * height;
	const data = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
	const dst = new Uint32Array(data.buffer, data.byteOffset, n);
	const s = new Uint32Array(src.buffer, src.byteOffset, n);
	for (let i = 0; i < n; i++) {
		const p = s[i];
		dst[i] = 4278190080 | (p & 255) << 16 | p & 65280 | p >>> 16 & 255;
	}
	return data;
}
function frameToPpm(frame) {
	const header = new TextEncoder().encode(`P6\n${frame.width} ${frame.height}\n255\n`);
	const n = frame.width * frame.height;
	const out = new Uint8Array(header.length + n * 3);
	out.set(header);
	for (let i = 0, o = header.length; i < n; i++, o += 3) {
		out[o] = frame.data[i * 4];
		out[o + 1] = frame.data[i * 4 + 1];
		out[o + 2] = frame.data[i * 4 + 2];
	}
	return out;
}
const VIRTIO_GPU_F_VIRGL = 1n << 0n;
const VIRTIO_GPU_F_EDID = 1n << 1n;
const GPU_CMD = {
	GET_DISPLAY_INFO: 256,
	RESOURCE_CREATE_2D: 257,
	RESOURCE_UNREF: 258,
	SET_SCANOUT: 259,
	RESOURCE_FLUSH: 260,
	TRANSFER_TO_HOST_2D: 261,
	RESOURCE_ATTACH_BACKING: 262,
	RESOURCE_DETACH_BACKING: 263,
	GET_CAPSET_INFO: 264,
	GET_CAPSET: 265,
	GET_EDID: 266,
	RESOURCE_ASSIGN_UUID: 267,
	RESOURCE_CREATE_BLOB: 268,
	SET_SCANOUT_BLOB: 269,
	CTX_CREATE: 512,
	CTX_DESTROY: 513,
	CTX_ATTACH_RESOURCE: 514,
	CTX_DETACH_RESOURCE: 515,
	RESOURCE_CREATE_3D: 516,
	TRANSFER_TO_HOST_3D: 517,
	TRANSFER_FROM_HOST_3D: 518,
	SUBMIT_3D: 519,
	RESOURCE_MAP_BLOB: 520,
	RESOURCE_UNMAP_BLOB: 521,
	UPDATE_CURSOR: 768,
	MOVE_CURSOR: 769
};
const GPU_RESP = {
	OK_NODATA: 4352,
	OK_DISPLAY_INFO: 4353,
	OK_CAPSET_INFO: 4354,
	OK_CAPSET: 4355,
	OK_EDID: 4356,
	OK_RESOURCE_UUID: 4357,
	OK_MAP_INFO: 4358,
	ERR_UNSPEC: 4608,
	ERR_OUT_OF_MEMORY: 4609,
	ERR_INVALID_SCANOUT_ID: 4610,
	ERR_INVALID_RESOURCE_ID: 4611,
	ERR_INVALID_CONTEXT_ID: 4612,
	ERR_INVALID_PARAMETER: 4613
};
const FLAG_FENCE$1 = 1;
const EVENT_DISPLAY = 1;
const HDR$1 = 24;
const FORMATS = {
	1: [
		0,
		1,
		2
	],
	2: [
		0,
		1,
		2
	],
	3: [
		3,
		2,
		1
	],
	4: [
		3,
		2,
		1
	],
	67: [
		2,
		1,
		0
	],
	68: [
		1,
		2,
		3
	],
	121: [
		1,
		2,
		3
	],
	134: [
		2,
		1,
		0
	]
};
var GpuError = class extends Error {
	code;
	constructor(code, msg) {
		super(msg);
		this.code = code;
	}
};
var VirtioGpu = class {
	deviceId = 16;
	queueSizes = [256, 16];
	stats = {
		commands: 0,
		errors: 0,
		transfers: 0,
		transferBytes: 0,
		flushes: 0,
		cursor: 0,
		backend: 0
	};
	#memory;
	#display;
	#backend;
	#onFlush;
	#log;
	#resources = /* @__PURE__ */ new Map();
	#scanout = null;
	#scanout3d = null;
	#eventsRead = 0;
	#told = null;
	#stalled = false;
	#fenceTail = null;
	#pending = 0;
	#epoch = 0;
	#notifyFn = null;
	constructor(opts) {
		this.#memory = opts.memory;
		this.#display = opts.display;
		this.#backend = opts.backend;
		this.#onFlush = opts.onFlush;
		this.#log = opts.log ?? (() => {});
	}
	features() {
		return VIRTIO_GPU_F_EDID | (this.#backend?.features ?? 0n);
	}
	config() {
		const b = /* @__PURE__ */ new Uint8Array(16);
		const dv = new DataView(b.buffer);
		dv.setUint32(0, this.#eventsRead, true);
		dv.setUint32(4, 0, true);
		dv.setUint32(8, 1, true);
		dv.setUint32(12, this.#backend?.capsetCount ?? 0, true);
		return b;
	}
	configWrite(offset, data) {
		if (offset === 4 && data.length >= 4) this.#eventsRead &= ~new DataView(data.buffer, data.byteOffset).getUint32(0, true);
	}
	set configNotifier(fn) {
		this.#notifyFn = fn;
	}
	displayChanged(force = false) {
		const s = this.#size(), t = this.#told;
		if (!force && (!t || t.width === s.width && t.height === s.height && t.dpi === s.dpi)) return false;
		this.#eventsRead |= EVENT_DISPLAY;
		this.#notifyFn?.();
		return true;
	}
	get displaySize() {
		return this.#told && { ...this.#told };
	}
	reset() {
		this.#epoch++;
		this.#resources.clear();
		this.#setScanout(null);
		this.#scanout3d = null;
		this.#eventsRead = 0;
		this.#stalled = false;
		this.#fenceTail = null;
		this.#pending = 0;
		this.#backend?.reset?.();
	}
	blocker() {
		return [this.#pending ? "virtio-gpu commands" : "", this.held()].filter(Boolean).join(", ");
	}
	held() {
		const back = this.#backend?.blocker?.() ?? "";
		return this.#resources.size && !back.includes("virtio-gpu resources") ? ["virtio-gpu resources", back].filter(Boolean).join(", ") : back;
	}
	get resourceCount() {
		return this.#resources.size;
	}
	get scanoutMode() {
		const s = this.#scanout, t = this.#scanout3d;
		if (t) return {
			width: t.rect.width,
			height: t.rect.height,
			stride: t.rect.width * 4,
			format: FOURCC_XRGB8888
		};
		return s ? {
			width: s.rect.width,
			height: s.rect.height,
			stride: s.res.width * 4,
			format: FOURCC_XRGB8888
		} : null;
	}
	notify(q) {
		if (q.index === 1) {
			for (let c = q.pop(); c; c = q.pop()) {
				this.stats.cursor++;
				q.push(c, 0);
			}
			return;
		}
		this.#drain(q);
	}
	#drain(q) {
		while (!this.#stalled) {
			const chain = q.pop();
			if (!chain) return;
			const req = q.read(chain);
			this.stats.commands++;
			let res;
			try {
				res = this.#command(req);
			} catch (e) {
				res = this.#error(e);
			}
			const fenced = req.length >= HDR$1 && (new DataView(req.buffer).getUint32(4, true) & FLAG_FENCE$1) !== 0;
			if (!(res instanceof Promise)) {
				if (fenced && this.#fenceTail) this.#later(q, chain, req, Promise.resolve(res), true);
				else this.#answer(q, chain, req, res);
				continue;
			}
			this.#later(q, chain, req, res, fenced);
		}
	}
	#later(q, chain, req, res, fenced) {
		const epoch = this.#epoch;
		this.#pending++;
		const safe = res.catch((e) => this.#error(e));
		const done = (r) => {
			if (epoch !== this.#epoch) return;
			this.#pending--;
			this.#answer(q, chain, req, r);
		};
		if (fenced) {
			const tail = (this.#fenceTail ?? Promise.resolve()).then(() => safe).then(done);
			this.#fenceTail = tail;
			tail.then(() => {
				if (this.#fenceTail === tail) this.#fenceTail = null;
			});
			return;
		}
		this.#stalled = true;
		safe.then((r) => {
			if (epoch !== this.#epoch) return;
			done(r);
			this.#stalled = false;
			this.#drain(q);
		});
	}
	#error(e) {
		const code = e instanceof GpuError ? e.code : GPU_RESP.ERR_UNSPEC;
		this.stats.errors++;
		if (!(e instanceof GpuError)) this.#log(`[virtio-gpu] ${e?.message ?? e}`);
		return resp$1(code);
	}
	#answer(q, chain, req, res) {
		const out = res ?? resp$1(GPU_RESP.ERR_UNSPEC);
		if (out.length >= HDR$1 && req.length >= HDR$1) {
			const i = new DataView(req.buffer, req.byteOffset);
			const o = new DataView(out.buffer, out.byteOffset);
			const flags = i.getUint32(4, true);
			if (flags & FLAG_FENCE$1) {
				o.setUint32(4, o.getUint32(4, true) | flags & 3, true);
				o.setBigUint64(8, i.getBigUint64(8, true), true);
				o.setUint32(16, i.getUint32(16, true), true);
				o.setUint8(20, i.getUint8(20));
			}
		}
		q.push(chain, q.write(chain, out));
	}
	#command(req) {
		if (req.length < HDR$1) throw new GpuError(GPU_RESP.ERR_INVALID_PARAMETER, "short command");
		const dv = new DataView(req.buffer, req.byteOffset, req.byteLength);
		const type = dv.getUint32(0, true);
		const need = (n) => {
			if (req.length < n) throw new GpuError(GPU_RESP.ERR_INVALID_PARAMETER, `command 0x${type.toString(16)}: ${req.length} bytes`);
		};
		const rect = (at) => ({
			x: dv.getUint32(at, true),
			y: dv.getUint32(at + 4, true),
			width: dv.getUint32(at + 8, true),
			height: dv.getUint32(at + 12, true)
		});
		switch (type) {
			case GPU_CMD.GET_DISPLAY_INFO: return this.#displayInfo();
			case GPU_CMD.GET_EDID: {
				need(32);
				if (dv.getUint32(HDR$1, true) !== 0) throw new GpuError(GPU_RESP.ERR_INVALID_SCANOUT_ID, "edid");
				const out = resp$1(GPU_RESP.OK_EDID, 1056);
				const edid = makeEdid(this.#size());
				new DataView(out.buffer).setUint32(HDR$1, edid.length, true);
				out.set(edid, 32);
				return out;
			}
			case GPU_CMD.GET_CAPSET_INFO:
				need(28);
				if (dv.getUint32(HDR$1, true) >= (this.#backend?.capsetCount ?? 0)) throw new GpuError(GPU_RESP.ERR_INVALID_PARAMETER, "capset index");
				return this.#toBackend(req, GPU_RESP.ERR_INVALID_PARAMETER);
			case GPU_CMD.RESOURCE_CREATE_2D: {
				need(40);
				const id = dv.getUint32(HDR$1, true), format = dv.getUint32(28, true);
				const width = dv.getUint32(32, true), height = dv.getUint32(36, true);
				if (!id || this.#resources.has(id)) throw new GpuError(GPU_RESP.ERR_INVALID_RESOURCE_ID, "create_2d");
				if (!FORMATS[format] || !width || !height || width > 16384 || height > 16384) throw new GpuError(GPU_RESP.ERR_INVALID_PARAMETER, "create_2d");
				this.#resources.set(id, {
					id,
					format,
					width,
					height,
					backing: null,
					starts: [],
					host: null
				});
				return resp$1(GPU_RESP.OK_NODATA);
			}
			case GPU_CMD.RESOURCE_UNREF: {
				need(32);
				const res = this.#resources.get(dv.getUint32(HDR$1, true));
				if (!res) {
					if (this.#scanout3d?.id === dv.getUint32(HDR$1, true)) this.#setScanout(null);
					return this.#toBackend(req, GPU_RESP.ERR_INVALID_RESOURCE_ID);
				}
				if (this.#scanout?.res === res) this.#setScanout(null);
				this.#resources.delete(res.id);
				return resp$1(GPU_RESP.OK_NODATA);
			}
			case GPU_CMD.RESOURCE_ATTACH_BACKING: {
				need(32);
				const res = this.#resources.get(dv.getUint32(HDR$1, true));
				if (!res) return this.#toBackend(req, GPU_RESP.ERR_INVALID_RESOURCE_ID);
				const n = dv.getUint32(28, true);
				need(32 + 16 * n);
				const size = this.#memory().buffer.byteLength;
				const backing = [], starts = [];
				let total = 0;
				for (let i = 0; i < n; i++) {
					const at = 32 + 16 * i;
					const addr = Number(dv.getBigUint64(at, true)), len = dv.getUint32(at + 8, true);
					if (addr + len > size) throw new GpuError(GPU_RESP.ERR_INVALID_PARAMETER, "backing outside memory");
					backing.push({
						addr,
						len
					});
					starts.push(total);
					total += len;
				}
				res.backing = backing;
				res.starts = starts;
				return resp$1(GPU_RESP.OK_NODATA);
			}
			case GPU_CMD.RESOURCE_DETACH_BACKING: {
				need(32);
				const res = this.#resources.get(dv.getUint32(HDR$1, true));
				if (!res) return this.#toBackend(req, GPU_RESP.ERR_INVALID_RESOURCE_ID);
				res.backing = null;
				res.starts = [];
				return resp$1(GPU_RESP.OK_NODATA);
			}
			case GPU_CMD.SET_SCANOUT: {
				need(48);
				const r = rect(HDR$1), scanout = dv.getUint32(40, true), id = dv.getUint32(44, true);
				if (scanout !== 0) throw new GpuError(GPU_RESP.ERR_INVALID_SCANOUT_ID, "set_scanout");
				if (!id || !r.width || !r.height) {
					this.#setScanout(null);
					return this.#backend ? this.#toBackend(req, GPU_RESP.OK_NODATA) : resp$1(GPU_RESP.OK_NODATA);
				}
				const res = this.#resources.get(id);
				if (!res) {
					const size = this.#backend?.resource(id);
					if (!size) throw new GpuError(GPU_RESP.ERR_INVALID_RESOURCE_ID, "set_scanout");
					if (r.x + r.width > size.width || r.y + r.height > size.height) throw new GpuError(GPU_RESP.ERR_INVALID_PARAMETER, "set_scanout rect");
					this.#setScanout3d({
						id,
						rect: r
					});
					return this.#toBackend(req, GPU_RESP.ERR_INVALID_RESOURCE_ID);
				}
				if (r.x + r.width > res.width || r.y + r.height > res.height) throw new GpuError(GPU_RESP.ERR_INVALID_PARAMETER, "set_scanout rect");
				if (!res.host) {
					res.host = new Uint8Array(res.width * res.height * 4);
					this.#transfer(res, {
						x: 0,
						y: 0,
						width: res.width,
						height: res.height
					}, 0);
				}
				this.#setScanout({
					res,
					rect: r
				});
				return resp$1(GPU_RESP.OK_NODATA);
			}
			case GPU_CMD.TRANSFER_TO_HOST_2D: {
				need(56);
				const r = rect(HDR$1), offset = Number(dv.getBigUint64(40, true));
				const res = this.#resources.get(dv.getUint32(48, true));
				if (!res) return this.#toBackend(req, GPU_RESP.ERR_INVALID_RESOURCE_ID);
				if (r.x + r.width > res.width || r.y + r.height > res.height) throw new GpuError(GPU_RESP.ERR_INVALID_PARAMETER, "transfer rect");
				this.stats.transfers++;
				if (res.host) this.#transfer(res, r, offset);
				return resp$1(GPU_RESP.OK_NODATA);
			}
			case GPU_CMD.RESOURCE_FLUSH: {
				need(48);
				const r = rect(HDR$1);
				const res = this.#resources.get(dv.getUint32(40, true));
				if (!res) {
					if (this.#scanout3d?.id === dv.getUint32(40, true)) {
						this.stats.flushes++;
						try {
							this.#onFlush?.(r);
						} catch {}
					}
					return this.#toBackend(req, GPU_RESP.ERR_INVALID_RESOURCE_ID);
				}
				if (this.#scanout?.res === res) {
					this.stats.flushes++;
					try {
						this.#onFlush?.(r);
					} catch {}
				}
				return resp$1(GPU_RESP.OK_NODATA);
			}
			default: return this.#toBackend(req, GPU_RESP.ERR_UNSPEC);
		}
	}
	#toBackend(req, code) {
		const b = this.#backend;
		if (!b) throw new GpuError(code, "no backend");
		this.stats.backend++;
		return b.command(req, {
			memory: this.#memory,
			backing: (id) => this.#resources.get(id)?.backing ?? null
		});
	}
	#size() {
		return fitGpuSize(this.#display.wantedSize());
	}
	#displayInfo() {
		const out = resp$1(GPU_RESP.OK_DISPLAY_INFO, 408);
		const dv = new DataView(out.buffer);
		const s = this.#size();
		this.#told = s;
		dv.setUint32(32, s.width, true);
		dv.setUint32(36, s.height, true);
		dv.setUint32(40, 1, true);
		return out;
	}
	#setScanout(s) {
		const was = this.#scanout;
		this.#scanout = s;
		if (this.#scanout3d) {
			this.#scanout3d = null;
			if (!s) this.#display.setScanout(null);
		}
		if (!s) {
			if (was) this.#display.setScanout(null);
			return;
		}
		const { res, rect } = s;
		if (was?.res === res && was.rect.x === rect.x && was.rect.y === rect.y && was.rect.width === rect.width && was.rect.height === rect.height) return;
		const stride = res.width * 4;
		const start = rect.y * stride + rect.x * 4;
		this.#display.setScanout({
			mode: {
				width: rect.width,
				height: rect.height,
				stride,
				format: FOURCC_XRGB8888
			},
			pixels: () => res.host.subarray(start)
		});
	}
	#setScanout3d(s) {
		const was = this.#scanout3d;
		this.#scanout = null;
		this.#scanout3d = s;
		if (was?.id === s.id && was.rect.x === s.rect.x && was.rect.y === s.rect.y && was.rect.width === s.rect.width && was.rect.height === s.rect.height) return;
		this.#display.setScanout({
			mode: {
				width: s.rect.width,
				height: s.rect.height,
				stride: s.rect.width * 4,
				format: FOURCC_XRGB8888
			},
			pixels: () => null
		});
	}
	#transfer(res, r, offset) {
		const host = res.host;
		if (!res.backing?.length) return;
		const mem = new Uint8Array(this.#memory().buffer);
		const stride = res.width * 4, row = r.width * 4;
		const order = FORMATS[res.format];
		const direct = order[0] === 0 && order[1] === 1 && order[2] === 2;
		const tmp = direct ? null : new Uint8Array(row);
		for (let h = 0; h < r.height; h++) {
			const dst = (r.y + h) * stride + r.x * 4;
			if (direct) this.#gather(res, mem, offset + h * stride, host, dst, row);
			else {
				this.#gather(res, mem, offset + h * stride, tmp, 0, row);
				for (let i = 0; i < row; i += 4) {
					host[dst + i] = tmp[i + order[0]];
					host[dst + i + 1] = tmp[i + order[1]];
					host[dst + i + 2] = tmp[i + order[2]];
					host[dst + i + 3] = 255;
				}
			}
		}
		this.stats.transferBytes += row * r.height;
	}
	#gather(res, mem, off, dst, at, n) {
		const back = res.backing, starts = res.starts;
		let lo = 0, hi = starts.length - 1;
		while (lo < hi) {
			const mid = lo + hi + 1 >> 1;
			if (starts[mid] <= off) lo = mid;
			else hi = mid - 1;
		}
		for (let i = lo; n > 0 && i < back.length; i++) {
			const b = back[i], skip = off - starts[i];
			if (skip >= b.len) continue;
			const k = Math.min(n, b.len - skip);
			dst.set(mem.subarray(b.addr + skip, b.addr + skip + k), at);
			at += k;
			off += k;
			n -= k;
		}
	}
};
function resp$1(type, size = HDR$1) {
	const b = new Uint8Array(size);
	new DataView(b.buffer).setUint32(0, type, true);
	return b;
}
const cvtVblank = (h) => Math.max(15, Math.ceil(.0276 * (h + 3) / .9724));
const edidClock = (w, h) => Math.round((w + 160) * (h + cvtVblank(h)) * 60 / 1e4);
function fitGpuSize(s) {
	let w = Math.round(s.width) || 640, h = Math.round(s.height) || 480;
	if (w > 4095 || h > 4095) {
		const k = Math.min(4095 / w, 4095 / h);
		w = Math.min(4095, Math.round(w * k));
		h = Math.min(4095, Math.round(h * k));
	}
	w = Math.max(64, w);
	h = Math.max(64, h);
	while (edidClock(w, h) > 65535) {
		w = Math.max(64, Math.floor(w * .99));
		h = Math.max(64, Math.floor(h * .99));
	}
	return {
		width: w,
		height: h,
		dpi: s.dpi
	};
}
function makeEdid(s) {
	const e = /* @__PURE__ */ new Uint8Array(128);
	e.set([
		0,
		255,
		255,
		255,
		255,
		255,
		255,
		0
	]);
	e[8] = 85;
	e[9] = 203;
	e[10] = 1;
	e[16] = 1;
	e[17] = 36;
	e[18] = 1;
	e[19] = 4;
	e[20] = 165;
	const w = Math.min(4095, s.width), h = Math.min(4095, s.height);
	const mmW = s.dpi ? Math.round(s.width * 25.4 / s.dpi) : 0, mmH = s.dpi ? Math.round(s.height * 25.4 / s.dpi) : 0;
	e[21] = Math.min(255, Math.round(mmW / 10));
	e[22] = Math.min(255, Math.round(mmH / 10));
	e[23] = 120;
	e[24] = 6;
	e.set([
		238,
		145,
		163,
		84,
		76,
		153,
		38,
		15,
		80,
		84
	], 25);
	for (let i = 38; i < 54; i++) e[i] = 1;
	const hfp = 48, hs = 32;
	const vb = cvtVblank(h);
	const clock = Math.min(65535, edidClock(w, h));
	const d = 54;
	e[d] = clock & 255;
	e[55] = clock >> 8;
	e[56] = w & 255;
	e[57] = 160;
	e[58] = w >> 8 << 4 | 0;
	e[59] = h & 255;
	e[60] = vb & 255;
	e[61] = h >> 8 << 4 | vb >> 8;
	e[62] = hfp;
	e[63] = hs;
	e[64] = 54;
	e[65] = 0;
	const dw = Math.min(4095, mmW), dh = Math.min(4095, mmH);
	e[66] = dw & 255;
	e[67] = dh & 255;
	e[68] = dw >> 8 << 4 | dh >> 8;
	e[71] = 26;
	e.set([
		0,
		0,
		0,
		252,
		0
	], 72);
	const name = "unkernel\n   ";
	for (let i = 0; i < 13; i++) e[77 + i] = name.charCodeAt(i);
	e.set([
		0,
		0,
		0,
		16,
		0
	], 90);
	e.set([
		0,
		0,
		0,
		16,
		0
	], 108);
	let sum = 0;
	for (let i = 0; i < 127; i++) sum += e[i];
	e[127] = 256 - (sum & 255) & 255;
	return e;
}
const HDR = 24;
const FLAG_FENCE = 1;
const TARGET_BUFFER = 0;
const VIRGL_CAPSETS = Object.freeze([Object.freeze({
	id: 1,
	version: 1,
	size: 308
}), Object.freeze({
	id: 2,
	version: 2,
	size: 1408
})]);
const minify = (v, level) => Math.max(1, v >>> level);
function resp(type, size = HDR) {
	const b = new Uint8Array(size);
	new DataView(b.buffer).setUint32(0, type, true);
	return b;
}
function hdr(type, ctx, id) {
	const b = new Uint8Array(HDR + (type === GPU_CMD.CTX_CREATE ? 72 : 8));
	const dv = new DataView(b.buffer);
	dv.setUint32(0, type, true);
	dv.setUint32(16, ctx, true);
	if (id !== void 0) dv.setUint32(HDR, id, true);
	return b;
}
function resourceOf(dv) {
	switch (dv.getUint32(0, true)) {
		case GPU_CMD.TRANSFER_TO_HOST_3D:
		case GPU_CMD.TRANSFER_FROM_HOST_3D: return dv.byteLength >= 60 ? dv.getUint32(56, true) : 0;
		case GPU_CMD.SET_SCANOUT: return dv.byteLength >= 48 ? dv.getUint32(44, true) : 0;
		case GPU_CMD.RESOURCE_FLUSH: return dv.byteLength >= 44 ? dv.getUint32(40, true) : 0;
		case GPU_CMD.RESOURCE_CREATE_3D:
		case GPU_CMD.RESOURCE_UNREF:
		case GPU_CMD.CTX_ATTACH_RESOURCE:
		case GPU_CMD.CTX_DETACH_RESOURCE: return dv.byteLength >= 28 ? dv.getUint32(HDR, true) : 0;
		default: return 0;
	}
}
var VirglGpuBackend = class {
	features = VIRTIO_GPU_F_VIRGL;
	capsetCount = VIRGL_CAPSETS.length;
	#link;
	#log;
	#init = null;
	#failed = false;
	#started = false;
	#tail = null;
	#resources = /* @__PURE__ */ new Map();
	#contexts = /* @__PURE__ */ new Set();
	#pending = /* @__PURE__ */ new Map();
	#submitted = /* @__PURE__ */ new Set();
	constructor(link, log = () => {}) {
		this.#link = link;
		this.#log = log;
		link.init.then((i) => this.#init = i, (e) => {
			this.#failed = true;
			log(`[virtio-gpu] no 3D renderer: ${e?.message ?? e}; capsets and 3D commands fail, so the guest's Mesa gets no virgl screen (it falls back to software rendering)`);
		});
	}
	resource(id) {
		const r = this.#resources.get(id);
		return r && r.target !== TARGET_BUFFER ? {
			width: r.width,
			height: r.height
		} : null;
	}
	reset() {
		this.#resources.clear();
		this.#contexts.clear();
		this.#pending.clear();
		this.#submitted.clear();
		this.#tail = null;
		this.#link.reset();
	}
	blocker() {
		if (this.#resources.size) return "virtio-gpu resources";
		if (this.#submitted.size) return "virtio-gpu contexts";
		return "";
	}
	#adopt(ctx) {
		if (!ctx || this.#contexts.has(ctx)) return;
		this.#contexts.add(ctx);
		let b = this.#pending.get(ctx);
		if (b) this.#pending.delete(ctx);
		else {
			this.#log(`[virtio-gpu] context ${ctx} is from before a restore: made again in the renderer`);
			b = hdr(GPU_CMD.CTX_CREATE, ctx);
		}
		this.#start();
		this.#send({ cmd: b }, false);
	}
	#start() {
		if (this.#started) return;
		this.#started = true;
		this.#link.start();
		for (const id of [...this.#pending.keys()]) this.#adopt(id);
	}
	command(cmd, ctx) {
		const dv = new DataView(cmd.buffer, cmd.byteOffset, cmd.byteLength);
		const type = dv.getUint32(0, true);
		const fenced = (dv.getUint32(4, true) & FLAG_FENCE) !== 0;
		const need = (n) => {
			if (cmd.length < HDR + n) throw new Error(`virtio-gpu command 0x${type.toString(16)}: ${cmd.length} bytes`);
		};
		switch (type) {
			case GPU_CMD.GET_CAPSET_INFO: {
				need(4);
				const c = VIRGL_CAPSETS[dv.getUint32(HDR, true)];
				const out = resp(GPU_RESP.OK_CAPSET_INFO, 40);
				const o = new DataView(out.buffer);
				if (c) {
					o.setUint32(HDR, c.id, true);
					o.setUint32(28, c.version, true);
					o.setUint32(32, c.size, true);
				}
				return out;
			}
			case GPU_CMD.GET_CAPSET:
				need(8);
				this.#start();
				return this.#withInit((init) => {
					const c = init.capsets.find((x) => x.id === dv.getUint32(HDR, true));
					if (!c) return resp(GPU_RESP.ERR_INVALID_PARAMETER);
					const out = resp(GPU_RESP.OK_CAPSET, HDR + c.data.length);
					out.set(c.data, HDR);
					return out;
				});
			case GPU_CMD.RESOURCE_CREATE_3D: {
				need(44);
				const id = dv.getUint32(HDR, true);
				if (!id || this.#resources.has(id)) return resp(GPU_RESP.ERR_INVALID_RESOURCE_ID);
				this.#resources.set(id, {
					target: dv.getUint32(28, true),
					format: dv.getUint32(32, true),
					width: dv.getUint32(40, true),
					height: dv.getUint32(44, true),
					backing: null,
					starts: []
				});
				this.#start();
				return this.#send({ cmd }, fenced);
			}
			case GPU_CMD.RESOURCE_UNREF:
				need(8);
				if (!this.#resources.delete(dv.getUint32(HDR, true))) return resp(GPU_RESP.ERR_INVALID_RESOURCE_ID);
				return this.#send({ cmd }, fenced);
			case GPU_CMD.RESOURCE_ATTACH_BACKING: {
				need(8);
				const res = this.#resources.get(dv.getUint32(HDR, true));
				if (!res) return resp(GPU_RESP.ERR_INVALID_RESOURCE_ID);
				const n = dv.getUint32(28, true);
				need(8 + 16 * n);
				const size = ctx.memory().buffer.byteLength;
				const backing = [], starts = [];
				let total = 0;
				for (let i = 0; i < n; i++) {
					const at = 32 + 16 * i;
					const addr = Number(dv.getBigUint64(at, true)), len = dv.getUint32(at + 8, true);
					if (addr + len > size) return resp(GPU_RESP.ERR_INVALID_PARAMETER);
					backing.push({
						addr,
						len
					});
					starts.push(total);
					total += len;
				}
				res.backing = backing;
				res.starts = starts;
				return resp(GPU_RESP.OK_NODATA);
			}
			case GPU_CMD.RESOURCE_DETACH_BACKING: {
				need(8);
				const res = this.#resources.get(dv.getUint32(HDR, true));
				if (!res) return resp(GPU_RESP.ERR_INVALID_RESOURCE_ID);
				res.backing = null;
				res.starts = [];
				return resp(GPU_RESP.OK_NODATA);
			}
			case GPU_CMD.TRANSFER_TO_HOST_3D:
			case GPU_CMD.TRANSFER_FROM_HOST_3D: {
				need(48);
				const res = this.#resources.get(dv.getUint32(56, true));
				if (!res) return resp(GPU_RESP.ERR_INVALID_RESOURCE_ID);
				this.#adopt(dv.getUint32(16, true));
				const toHost = type === GPU_CMD.TRANSFER_TO_HOST_3D;
				const run = () => this.#transferNow(cmd, dv, res, ctx, toHost, fenced);
				return this.#tail || !this.#init && !this.#failed ? this.#after(run) : run();
			}
			case GPU_CMD.CTX_CREATE: {
				need(8);
				const id = dv.getUint32(16, true);
				if (!this.#started && !this.#contexts.has(id)) {
					this.#pending.set(id, cmd.slice());
					return resp(GPU_RESP.OK_NODATA);
				}
				this.#contexts.add(id);
				return this.#send({ cmd }, fenced);
			}
			case GPU_CMD.CTX_DESTROY: {
				const id = dv.getUint32(16, true);
				this.#submitted.delete(id);
				if (this.#pending.delete(id) || !this.#contexts.delete(id)) return resp(GPU_RESP.OK_NODATA);
				return this.#send({ cmd }, fenced);
			}
			case GPU_CMD.CTX_ATTACH_RESOURCE:
			case GPU_CMD.CTX_DETACH_RESOURCE:
				if (!this.#resources.has(dv.getUint32(HDR, true))) return resp(GPU_RESP.OK_NODATA);
				this.#adopt(dv.getUint32(16, true));
				return this.#send({ cmd }, fenced);
			case GPU_CMD.SUBMIT_3D:
				this.#submitted.add(dv.getUint32(16, true));
				this.#adopt(dv.getUint32(16, true));
				this.#start();
				return this.#send({ cmd }, fenced);
			case GPU_CMD.SET_SCANOUT:
			case GPU_CMD.RESOURCE_FLUSH:
				if (!this.#started) return resp(GPU_RESP.OK_NODATA);
				return this.#send({ cmd }, fenced);
			default:
				this.#log(`[virtio-gpu] command 0x${type.toString(16)} is not supported with the 3D renderer`);
				return resp(type === GPU_CMD.TRANSFER_TO_HOST_2D ? GPU_RESP.ERR_INVALID_RESOURCE_ID : GPU_RESP.ERR_UNSPEC);
		}
	}
	#withInit(f) {
		if (this.#init) return f(this.#init);
		if (this.#failed) return resp(GPU_RESP.ERR_UNSPEC);
		return this.#link.init.then(f, () => resp(GPU_RESP.ERR_UNSPEC));
	}
	#after(f) {
		const p = (this.#tail ?? this.#link.init.catch(() => {})).then(() => f());
		const tail = p.catch(() => {});
		this.#tail = tail;
		tail.then(() => {
			if (this.#tail === tail) this.#tail = null;
		});
		return p;
	}
	#send(req, fenced) {
		return this.#tail ? this.#after(() => this.#sendNow(req, fenced)) : this.#sendNow(req, fenced);
	}
	#sendNow(req, fenced) {
		if (this.#failed) return resp(GPU_RESP.ERR_UNSPEC);
		if (!fenced) {
			this.#link.post(req);
			return resp(GPU_RESP.OK_NODATA);
		}
		const r = this.#link.call(req);
		return r instanceof Promise ? r.then((x) => resp(x.code || GPU_RESP.OK_NODATA)) : resp(r.code || GPU_RESP.OK_NODATA);
	}
	#packing(res, dv) {
		const w = dv.getUint32(36, true), h = dv.getUint32(40, true), d = Math.max(1, dv.getUint32(44, true));
		const offset = Number(dv.getBigUint64(48, true));
		const level = dv.getUint32(60, true), stride = dv.getUint32(64, true), layerStride = dv.getUint32(68, true);
		if (res.target === TARGET_BUFFER) return {
			row: w,
			rows: 1,
			layers: 1,
			srcStride: 0,
			srcLayer: 0,
			offset,
			len: w
		};
		const f = this.#init?.formats[res.format] ?? 0;
		const bw = f & 255, bh = f >> 8 & 255, bs = f >>> 16;
		if (!bw || !bh || !bs) return null;
		const nbx = Math.ceil(Math.max(1, w) / bw), nby = Math.ceil(Math.max(1, h) / bh);
		const srcStride = stride || Math.ceil(minify(res.width, level) / bw) * bs;
		const srcLayer = layerStride || Math.ceil(minify(res.height, level) / bh) * srcStride;
		const row = nbx * bs;
		return {
			row,
			rows: nby,
			layers: d,
			srcStride,
			srcLayer,
			offset,
			len: row * nby * d
		};
	}
	#transferNow(cmd, dv, res, ctx, toHost, fenced) {
		if (this.#failed) return resp(GPU_RESP.ERR_UNSPEC);
		const p = this.#packing(res, dv);
		if (!p) {
			this.#log(`[virtio-gpu] transfer of a resource in format ${res.format}: no layout for it`);
			return resp(GPU_RESP.ERR_INVALID_PARAMETER);
		}
		const out = cmd.slice();
		const o = new DataView(out.buffer);
		o.setBigUint64(48, 0n, true);
		o.setUint32(64, res.target === TARGET_BUFFER ? 0 : p.row, true);
		o.setUint32(68, res.target === TARGET_BUFFER ? 0 : p.row * p.rows, true);
		const mem = new Uint8Array(ctx.memory().buffer);
		if (toHost) {
			const data = this.#link.buffer?.(p.len) ?? new Uint8Array(p.len);
			this.#rows(res, p, (src, at, n) => gather$1(res, mem, src, data, at, n));
			const req = {
				cmd: out,
				data
			};
			if (!fenced) {
				this.#link.post(req);
				return resp(GPU_RESP.OK_NODATA);
			}
			const r = this.#link.call(req);
			return r instanceof Promise ? r.then((x) => resp(x.code || GPU_RESP.OK_NODATA)) : resp(r.code || GPU_RESP.OK_NODATA);
		}
		const done = (x) => {
			if (!x.code && x.data) {
				const m = new Uint8Array(ctx.memory().buffer);
				const data = x.data;
				this.#rows(res, p, (dst, at, n) => scatter$1(res, m, dst, data, at, n));
			}
			return resp(x.code || GPU_RESP.OK_NODATA);
		};
		const r = this.#link.call({
			cmd: out,
			readLen: p.len
		});
		return r instanceof Promise ? r.then(done) : done(r);
	}
	#rows(res, p, f) {
		if (!res.backing?.length) return;
		let at = 0;
		for (let l = 0; l < p.layers; l++) for (let r = 0; r < p.rows; r++, at += p.row) f(p.offset + l * p.srcLayer + r * p.srcStride, at, p.row);
	}
};
function entryAt(starts, off) {
	let lo = 0, hi = starts.length - 1;
	while (lo < hi) {
		const mid = lo + hi + 1 >> 1;
		if (starts[mid] <= off) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}
function gather$1(res, mem, off, dst, at, n) {
	const back = res.backing, starts = res.starts;
	for (let i = entryAt(starts, off); n > 0 && i < back.length; i++) {
		const b = back[i], skip = off - starts[i];
		if (skip >= b.len) continue;
		const k = Math.min(n, b.len - skip);
		dst.set(mem.subarray(b.addr + skip, b.addr + skip + k), at);
		at += k;
		off += k;
		n -= k;
	}
	if (n > 0) dst.fill(0, at, at + n);
}
function scatter$1(res, mem, off, src, at, n) {
	const back = res.backing, starts = res.starts;
	for (let i = entryAt(starts, off); n > 0 && i < back.length; i++) {
		const b = back[i], skip = off - starts[i];
		if (skip >= b.len) continue;
		const k = Math.min(n, b.len - skip);
		mem.set(src.subarray(at, at + k), b.addr + skip);
		at += k;
		off += k;
		n -= k;
	}
}
const CMD_NAMES = new Map(Object.entries(GPU_CMD).map(([k, v]) => [v, k]));
const BLIT_OPAQUE = 1;
const BLIT_FLIP_Y = 2;
const RGBA8_TEXELS = /* @__PURE__ */ new Set([
	1,
	2,
	67,
	134
]);
const RENEW_RETRY_MS = 1e3;
var GpuRenderer = class {
	init;
	stats = {
		commands: 0,
		fenced: 0,
		parks: 0,
		parkedMs: 0,
		presents: 0,
		reads: 0,
		images: 0,
		errors: 0,
		glErrors: 0,
		lastError: "",
		contextLost: false,
		losses: 0,
		renewals: 0
	};
	onFrame;
	#load;
	#renew;
	#started = false;
	#failed = false;
	#lost = false;
	#capsets = [];
	#listening = null;
	#staleContexts = /* @__PURE__ */ new Set();
	#staleResources = /* @__PURE__ */ new Set();
	#idle = /* @__PURE__ */ new Set();
	#submitted = /* @__PURE__ */ new Set();
	#glErrorsSeen = 0;
	#renewFailedAt = -1e400;
	#errorLogAt = -1e400;
	#errorsUnlogged = 0;
	#settle;
	#core = null;
	#queue = [];
	#strict;
	#log;
	#contexts = /* @__PURE__ */ new Set();
	#resources = /* @__PURE__ */ new Set();
	#scanout = null;
	#bitmap = null;
	#drawn = -1;
	#hold = 0;
	#floor = 0;
	#waits = [];
	#polling = false;
	#rounds = 0;
	#wake = null;
	constructor(load, opts = {}) {
		this.#load = load;
		this.#renew = opts.renew;
		this.#strict = !!opts.strictWaits;
		this.#log = opts.log ?? (() => {});
		const core = new Promise((resolve, reject) => this.#settle = {
			resolve,
			reject
		});
		this.init = core.then((c) => {
			const capsets = [];
			for (const { id, version, size } of VIRGL_CAPSETS) {
				const cs = c.gpu.capset(id);
				if (!cs || cs.version !== version || cs.data.length !== size) throw new Error(`the renderer's capset ${id} is ${cs ? `version ${cs.version}, ${cs.data.length} bytes` : "missing"}, not version ${version}, ${size} bytes as offered (VIRGL_CAPSETS in js/core/gl-gpu.ts and KW_VGPU_CAPSET* in gl/wasm/kw_virgl.h must match the module's virglrenderer)`);
				capsets.push({
					id,
					version,
					data: cs.data
				});
			}
			const formats = /* @__PURE__ */ new Uint32Array(512);
			for (let f = 0; f < formats.length; f++) formats[f] = c.gpu.format(f);
			this.#capsets = capsets;
			this.#attach(c);
			const q = this.#queue ?? [];
			this.#queue = null;
			for (const { req, done } of q) {
				const r = this.#run(req);
				done?.(r);
			}
			return {
				capsets,
				formats
			};
		});
		this.init.catch((e) => {
			this.#failed = true;
			const q = this.#queue ?? [];
			this.#queue = null;
			for (const { done } of q) done?.({ code: GPU_RESP.ERR_UNSPEC });
			this.stats.lastError = `no renderer, every 3D command fails: ${e?.message ?? e}`;
			this.#log(`[gl] virtio-gpu: no renderer: ${e?.message ?? e}`);
		});
	}
	start() {
		if (this.#started) return;
		this.#started = true;
		let p;
		try {
			p = this.#load();
		} catch (e) {
			p = Promise.reject(e);
		}
		p.then(this.#settle.resolve, this.#settle.reject);
	}
	get started() {
		return this.#started;
	}
	call(req) {
		this.start();
		this.#maybeRenew(req);
		if (this.#queue) {
			const q = this.#queue;
			return new Promise((resolve) => q.push({
				req,
				done: (r) => void Promise.resolve(r).then(resolve)
			}));
		}
		if (!this.#core) return { code: GPU_RESP.ERR_UNSPEC };
		return this.#run(req);
	}
	post(req) {
		this.start();
		this.#maybeRenew(req);
		if (this.#queue) this.#queue.push({ req });
		else if (this.#core) this.#run(req);
	}
	buffer(n) {
		return this.#core ? this.#core.gpu.buffer(n) : new Uint8Array(n);
	}
	reset() {
		const c = this.#core;
		if (this.#queue) this.#queue.length = 0;
		this.#setScanout(null);
		for (const w of this.#waits) w.resolve();
		this.#waits = [];
		this.#hold = 0;
		this.#staleContexts.clear();
		this.#staleResources.clear();
		this.#idle.clear();
		this.#submitted.clear();
		if (c && !this.#lost) {
			for (const id of this.#resources) c.gpu.command(hdr(GPU_CMD.RESOURCE_UNREF, 0, id));
			for (const ctx of this.#contexts) c.gpu.command(hdr(GPU_CMD.CTX_DESTROY, ctx));
		}
		this.#resources.clear();
		this.#contexts.clear();
	}
	get scanout() {
		return this.#scanout && { ...this.#scanout };
	}
	drawFrame(ctx, force = false) {
		const s = this.#scanout;
		if (!s) return null;
		if (!this.#bitmap || !force && this.#drawn === s.seq) return false;
		ctx.drawImage(this.#bitmap, 0, 0);
		this.#drawn = s.seq;
		return true;
	}
	frame(out) {
		const s = this.#scanout, c = this.#core;
		if (!s || !c) return null;
		const info = c.gpu.info(s.resource);
		const order = info && FORMATS[info.format];
		if (!order) return null;
		const px = c.gpu.read(s.resource, s.x, s.y, s.width, s.height, 4);
		if (!px) return null;
		const n = s.width * s.height;
		const data = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
		for (let i = 0, o = 0; i < n * 4; i += 4, o += 4) {
			data[o] = px[i + order[2]];
			data[o + 1] = px[i + order[1]];
			data[o + 2] = px[i + order[0]];
			data[o + 3] = 255;
		}
		return {
			width: s.width,
			height: s.height,
			data
		};
	}
	texture(resource) {
		const c = this.#lost ? null : this.#core;
		const i = c?.gpu.info(resource);
		return c && i ? {
			gl: c.gl,
			...i,
			alpha: i.alpha ?? false
		} : null;
	}
	image(resource, opts = {}) {
		if (this.#core) return this.#image(this.#core, resource, opts);
		if (!this.#started || this.#failed) return null;
		return this.init.then(() => this.#image(this.#core, resource, opts), () => null);
	}
	write(resource, box, fill) {
		const c = this.#core;
		if (!c || this.#lost || this.#queue) return false;
		const i = c.gpu.info(resource);
		const blk = i?.texture ? c.gpu.format(i.format) : 0;
		if (!i || (blk & 65535) !== 257 || box.x < 0 || box.y < 0 || !(box.width > 0 && box.height > 0) || box.x + box.width > i.width || box.y + box.height > i.height) return false;
		const stride = box.width * (blk >>> 16), n = stride * box.height;
		const cmd = /* @__PURE__ */ new Uint8Array(72), dv = new DataView(cmd.buffer);
		dv.setUint32(0, GPU_CMD.TRANSFER_TO_HOST_3D, true);
		dv.setUint32(HDR, box.x, true);
		dv.setUint32(28, box.y, true);
		dv.setUint32(36, box.width, true);
		dv.setUint32(40, box.height, true);
		dv.setUint32(44, 1, true);
		dv.setUint32(56, resource, true);
		dv.setUint32(64, stride, true);
		dv.setUint32(68, n, true);
		const buf = c.gpu.buffer(n);
		fill(buf);
		const r = this.#run({
			cmd,
			data: buf
		});
		return !(r instanceof Promise) && r.code === 0;
	}
	#videos = 0;
	video(resource, frame, width, height) {
		const c = this.#core;
		if (!c || this.#lost || this.#queue) return "no renderer";
		const gl = c.gl;
		if (gl.isContextLost()) {
			this.#loseContext();
			return "the WebGL2 context is lost";
		}
		const i = c.gpu.info(resource);
		if (!i?.texture) return "no such texture";
		if (!RGBA8_TEXELS.has(i.format)) return `format ${i.format}`;
		const w = Math.min(width, i.width), h = Math.min(height, i.height);
		if (!(w > 0 && h > 0)) return "empty";
		const P = gl;
		const saved = [
			P.UNPACK_FLIP_Y_WEBGL,
			P.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
			P.UNPACK_COLORSPACE_CONVERSION_WEBGL,
			P.UNPACK_ROW_LENGTH,
			P.UNPACK_SKIP_PIXELS,
			P.UNPACK_SKIP_ROWS,
			P.UNPACK_ALIGNMENT
		].map((k) => [k, gl.getParameter(k)]);
		const tex = gl.getParameter(gl.TEXTURE_BINDING_2D), pbo = gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING);
		let err = null;
		try {
			if (pbo) gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
			gl.bindTexture(gl.TEXTURE_2D, i.texture);
			gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, i.yTop);
			gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
			gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
			gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
			gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
			gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
			gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
			gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, i.yTop ? i.height - h : 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, frame);
			const n = this.#videos++;
			if (n < 8 || n % 64 === 0) {
				const e = gl.getError();
				if (e) err = `GL error 0x${e.toString(16)}`;
			}
		} catch (e) {
			err = `texSubImage2D: ${e?.name ?? "Error"}: ${e?.message ?? e}`;
		} finally {
			for (const [k, v] of saved) gl.pixelStorei(k, v);
			gl.bindTexture(gl.TEXTURE_2D, tex);
			if (pbo) gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, pbo);
		}
		return err;
	}
	read(resource, box) {
		const c = this.#core;
		if (!c || this.#lost || this.#queue) return null;
		const i = c.gpu.info(resource);
		const blk = i?.texture ? c.gpu.format(i.format) : 0;
		if (!i || (blk & 65535) !== 257 || box.x < 0 || box.y < 0 || !(box.width > 0 && box.height > 0) || box.x + box.width > i.width || box.y + box.height > i.height) return null;
		this.stats.reads++;
		return c.gpu.read(resource, box.x, box.y, box.width, box.height, blk >>> 16);
	}
	#image(c, resource, opts) {
		if (this.#lost) return null;
		const i = c.gpu.info(resource);
		const canvas = c.gl.canvas;
		if (!i?.texture || !c.gpu.blit || typeof canvas.transferToImageBitmap !== "function") return null;
		const x = Math.max(0, Math.floor(opts.x ?? 0)), y = Math.max(0, Math.floor(opts.y ?? 0));
		const w = Math.min(Math.floor(opts.width ?? i.width), i.width - x), h = Math.min(Math.floor(opts.height ?? i.height), i.height - y);
		if (!(w > 0 && h > 0)) return null;
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		if (c.gl.drawingBufferWidth !== w || c.gl.drawingBufferHeight !== h) {
			this.#log(`[gl] virtio-gpu: no ${w}x${h} drawing buffer for resource ${resource} (got ${c.gl.drawingBufferWidth}x${c.gl.drawingBufferHeight})`);
			return null;
		}
		const flags = (opts.opaque ?? !i.alpha ? BLIT_OPAQUE : 0) | (opts.flipY ? BLIT_FLIP_Y : 0);
		if (c.gpu.blit(resource, x, y, w, h, flags) < 0) return null;
		this.stats.images++;
		return canvas.transferToImageBitmap();
	}
	#run(req) {
		const c = this.#core;
		const dv = new DataView(req.cmd.buffer, req.cmd.byteOffset, req.cmd.byteLength);
		const type = dv.getUint32(0, true);
		const fenced = (dv.getUint32(4, true) & FLAG_FENCE) !== 0;
		this.stats.commands++;
		if (!this.#lost && c.gl.isContextLost()) this.#loseContext();
		if (this.#lost || this.#staleContexts.size || this.#staleResources.size || this.#idle.size) {
			const r = this.#stale(dv, type);
			if (r) return r;
		}
		let code = 0, data;
		switch (type) {
			case GPU_CMD.SET_SCANOUT: {
				const id = dv.getUint32(44, true);
				const w = dv.getUint32(32, true), h = dv.getUint32(36, true);
				this.#setScanout(id && w && h ? {
					resource: id,
					x: dv.getUint32(HDR, true),
					y: dv.getUint32(28, true),
					width: w,
					height: h
				} : null);
				break;
			}
			case GPU_CMD.RESOURCE_FLUSH:
				if (this.#scanout?.resource === dv.getUint32(40, true)) this.#present();
				break;
			case GPU_CMD.TRANSFER_FROM_HOST_3D: {
				const n = req.readLen ?? 0;
				code = c.gpu.command(req.cmd, c.gpu.buffer(n));
				if (!code) data = c.gpu.buffer(n).slice();
				this.stats.reads++;
				break;
			}
			default:
				if (type === GPU_CMD.SUBMIT_3D) this.#submitted.add(dv.getUint32(16, true));
				code = c.gpu.command(req.cmd, req.data);
				if (type === GPU_CMD.SUBMIT_3D && c.gpu.glErrors) {
					const n = c.gpu.glErrors();
					this.stats.glErrors += n - this.#glErrorsSeen >>> 0;
					this.#glErrorsSeen = n;
				}
				if (!code) {
					if (type === GPU_CMD.RESOURCE_CREATE_3D) this.#resources.add(dv.getUint32(HDR, true));
					else if (type === GPU_CMD.RESOURCE_UNREF) {
						this.#resources.delete(dv.getUint32(HDR, true));
						if (this.#scanout?.resource === dv.getUint32(HDR, true)) this.#setScanout(null);
					} else if (type === GPU_CMD.CTX_CREATE) this.#contexts.add(dv.getUint32(16, true));
					else if (type === GPU_CMD.CTX_DESTROY) {
						this.#contexts.delete(dv.getUint32(16, true));
						this.#submitted.delete(dv.getUint32(16, true));
					}
				}
		}
		if (code) return this.#refused(dv, code, "the renderer refused it (the [gl] virgl: lines before this one have its reason)", true);
		if (!fenced) return {
			code,
			data
		};
		return this.#fence(type, {
			code,
			data
		});
	}
	#fence(type, reply) {
		const c = this.#core;
		this.stats.fenced++;
		const seq = c.gpu.fence();
		if (type === GPU_CMD.TRANSFER_FROM_HOST_3D) {
			this.#floor = seq;
			if (!this.#strict) return reply;
		}
		const need = this.#strict ? seq : this.#hold;
		if (!need || !this.#waits.length && this.#done(need)) return reply;
		this.stats.parks++;
		return new Promise((resolve) => {
			this.#waits.push({
				need,
				since: performance.now(),
				resolve: () => resolve(reply)
			});
			if (!this.#polling) {
				this.#polling = true;
				this.#rounds = 0;
				this.#later();
			}
		});
	}
	#refused(dv, code, why, log) {
		const type = dv.getUint32(0, true), ctx = dv.getUint32(16, true);
		const res = type === GPU_CMD.TRANSFER_TO_HOST_3D || type === GPU_CMD.TRANSFER_FROM_HOST_3D ? dv.getUint32(56, true) : type !== GPU_CMD.SUBMIT_3D && type !== GPU_CMD.CTX_CREATE && type !== GPU_CMD.CTX_DESTROY && dv.byteLength >= 28 ? dv.getUint32(HDR, true) : 0;
		const name = CMD_NAMES.get(type) ?? `command 0x${type.toString(16)}`;
		this.stats.errors++;
		this.stats.lastError = `${name}${ctx ? ` ctx ${ctx}` : ""}${res ? ` resource ${res}` : ""}: 0x${code.toString(16)}, ${why}`;
		if (log) {
			const now = performance.now();
			if (now - this.#errorLogAt >= 1e3) {
				this.#log(`[gl] virtio-gpu: ${this.stats.lastError}${this.#errorsUnlogged ? ` (${this.#errorsUnlogged} more failed since the last line)` : ""}`);
				this.#errorLogAt = now;
				this.#errorsUnlogged = 0;
			} else this.#errorsUnlogged++;
		}
		return { code };
	}
	#attach(c) {
		this.#core = c;
		this.#glErrorsSeen = c.gpu.glErrors?.() ?? 0;
		this.#listening?.abort();
		const ac = new AbortController();
		this.#listening = ac;
		c.gl.canvas.addEventListener?.("webglcontextlost", (e) => {
			e.preventDefault();
			if (this.#core === c) this.#loseContext();
		}, { signal: ac.signal });
	}
	#loseContext() {
		if (this.#lost) return;
		this.#lost = true;
		this.stats.contextLost = true;
		this.stats.losses++;
		this.#log("[gl] virtio-gpu: the WebGL2 context was lost (the browser dropped it: memory pressure, a GPU reset, the GPU process ended); every GL object of the guest went with it, so the GL programs running now fail (the guest's kernel logs \"response 0x1200\") and must be restarted; " + (this.#renew ? "the next GL program gets a new renderer" : "reload the page for a new renderer"));
		this.stats.lastError = "the WebGL2 context was lost";
		this.#hold = 0;
		for (const w of this.#waits) w.resolve();
		this.#waits = [];
		this.#setScanout(null);
		for (const ctx of this.#contexts) (this.#submitted.has(ctx) ? this.#staleContexts : this.#idle).add(ctx);
		for (const id of this.#resources) this.#staleResources.add(id);
		this.#contexts.clear();
		this.#resources.clear();
		this.#submitted.clear();
	}
	#stale(dv, type) {
		const lost = this.#lost;
		const ctx = dv.byteLength >= HDR ? dv.getUint32(16, true) : 0, res = resourceOf(dv);
		const sc = !!ctx && this.#staleContexts.has(ctx), sr = !!res && this.#staleResources.has(res);
		const ok = { code: 0 };
		switch (type) {
			case GPU_CMD.CTX_CREATE:
				this.#staleContexts.delete(ctx);
				this.#idle.delete(ctx);
				if (!lost) return null;
				this.#staleContexts.add(ctx);
				break;
			case GPU_CMD.CTX_DESTROY:
				if (!lost && !sc && !this.#idle.has(ctx)) return null;
				this.#staleContexts.delete(ctx);
				this.#idle.delete(ctx);
				return ok;
			case GPU_CMD.RESOURCE_CREATE_3D:
				this.#staleResources.delete(res);
				if (!lost) return null;
				this.#staleResources.add(res);
				break;
			case GPU_CMD.RESOURCE_UNREF:
				if (!lost && !sr) return null;
				this.#staleResources.delete(res);
				if (this.#scanout?.resource === res) this.#setScanout(null);
				return ok;
			case GPU_CMD.CTX_DETACH_RESOURCE: return lost || sc || sr ? ok : null;
			case GPU_CMD.SET_SCANOUT:
			case GPU_CMD.RESOURCE_FLUSH:
				if (!lost && !sr) return null;
				if (type === GPU_CMD.SET_SCANOUT) this.#setScanout(null);
				return ok;
			case GPU_CMD.SUBMIT_3D:
				if (lost && this.#idle.delete(ctx)) this.#staleContexts.add(ctx);
				if (!lost && !sc && !sr) return null;
				break;
			default: if (!lost && !sc && !sr) return null;
		}
		if (lost) {
			this.stats.errors++;
			return { code: GPU_RESP.ERR_UNSPEC };
		}
		return this.#refused(dv, GPU_RESP.ERR_UNSPEC, `its ${sc ? "context" : "resource"} was in a WebGL2 context that was lost: restart the program`, true);
	}
	#maybeRenew(req) {
		const c = this.#core;
		if (this.#queue || !c || !this.#renew) return;
		if (!this.#lost && c.gl.isContextLost()) this.#loseContext();
		if (!this.#lost) return;
		const dv = new DataView(req.cmd.buffer, req.cmd.byteOffset, req.cmd.byteLength);
		if (dv.byteLength < HDR || dv.getUint32(0, true) !== GPU_CMD.CTX_CREATE || this.#staleContexts.has(dv.getUint32(16, true))) return;
		if (performance.now() - this.#renewFailedAt < RENEW_RETRY_MS) return;
		this.#queue = [];
		this.#log("[gl] virtio-gpu: a new GL context after the WebGL2 context was lost: making a new renderer");
		let p;
		try {
			p = this.#renew();
		} catch (e) {
			p = Promise.reject(e);
		}
		p.then((c2) => this.#renewed(c2), (e) => this.#renewFailed(e));
	}
	#renewed(c) {
		if (c === this.#core || c.gl.isContextLost()) return this.#renewFailed(/* @__PURE__ */ new Error("the new WebGL2 context is lost too"));
		for (const { id, version, data } of this.#capsets) {
			const cs = c.gpu.capset(id);
			if (!cs || cs.version !== version || cs.data.length !== data.length) return this.#renewFailed(/* @__PURE__ */ new Error(`the new renderer's capset ${id} differs in version or size from the one the guest has`));
			if (cs.data.some((b, i) => b !== data[i])) this.#log(`[gl] virtio-gpu: the new WebGL2 context's capset ${id} differs from the one the guest's kernel cached (another GPU?): programs may use features it lacks`);
		}
		this.#attach(c);
		this.#lost = false;
		this.stats.contextLost = false;
		this.stats.renewals++;
		this.stats.lastError = "";
		this.#floor = 0;
		this.#hold = 0;
		for (const ctx of this.#idle) if (!c.gpu.command(hdr(GPU_CMD.CTX_CREATE, ctx))) this.#contexts.add(ctx);
		this.#idle.clear();
		this.#log(`[gl] virtio-gpu: a new renderer is up after the loss (${this.stats.renewals} so far); ${this.#staleContexts.size} stale contexts and ${this.#staleResources.size} stale resources remain until their programs end`);
		this.#flushQueue();
	}
	#renewFailed(e) {
		this.#renewFailedAt = performance.now();
		const why = e?.message ?? String(e);
		this.stats.lastError = `the WebGL2 context was lost, and no new renderer could be made: ${why}`;
		this.#log(`[gl] virtio-gpu: no new renderer after the loss: ${why}; the next GL program tries again`);
		this.#flushQueue();
	}
	#flushQueue() {
		const q = this.#queue ?? [];
		this.#queue = null;
		for (const { req, done } of q) {
			const r = this.#run(req);
			done?.(r);
		}
	}
	#done(seq) {
		if (this.#lost) return true;
		return (this.#core.gpu.fencesDone() - seq | 0) >= 0 || (this.#floor - seq | 0) >= 0;
	}
	#later() {
		if (this.#rounds++ < 16) {
			if (!this.#wake) {
				const ch = new MessageChannel();
				ch.port1.onmessage = () => this.#poll();
				this.#wake = ch.port2;
			}
			this.#wake.postMessage(0);
		} else setTimeout(() => this.#poll(), 1);
	}
	#poll() {
		while (this.#waits.length && this.#done(this.#waits[0].need)) {
			const w = this.#waits.shift();
			this.stats.parkedMs += performance.now() - w.since;
			w.resolve();
		}
		this.#polling = this.#waits.length > 0;
		if (this.#polling) this.#later();
	}
	#setScanout(s) {
		const was = this.#scanout;
		if (!s) {
			if (!was) return;
			this.#scanout = null;
			this.#bitmap?.close();
			this.#bitmap = null;
			this.#drawn = -1;
		} else {
			if (was && was.resource === s.resource && was.x === s.x && was.y === s.y && was.width === s.width && was.height === s.height) return;
			this.#scanout = {
				...s,
				seq: was?.seq ?? 0
			};
		}
		try {
			this.onFrame?.();
		} catch {}
	}
	#present() {
		const s = this.#scanout, c = this.#core;
		if (this.#lost) return;
		const canvas = c.gl.canvas;
		if (canvas.width !== s.width || canvas.height !== s.height) {
			canvas.width = s.width;
			canvas.height = s.height;
		}
		if (c.gpu.present(s.resource, s.x, s.y, s.width, s.height) < 0) {
			this.#log(`[gl] virtio-gpu: cannot present resource ${s.resource}`);
			return;
		}
		this.#hold = c.gpu.fence();
		this.#bitmap?.close();
		this.#bitmap = typeof canvas.transferToImageBitmap === "function" ? canvas.transferToImageBitmap() : null;
		s.seq++;
		this.stats.presents++;
		try {
			this.onFrame?.();
		} catch {}
	}
};
function inlineGpuLink(r) {
	return {
		init: r.init,
		start: () => r.start(),
		call: (req) => r.call(req),
		post: (req) => r.post(req),
		reset: () => r.reset(),
		buffer: (n) => r.buffer(n)
	};
}
const GL_PORT = 1019;
const GL_FORWARDER = [KWBOX, "vtest"];
const FORWARDER_TIMEOUT_MS = 12e4;
const LINK_TIMEOUT_MS = 3e4;
var GlHost = class {
	ready;
	loaded;
	#vsock;
	#gpu;
	#loader;
	#custom;
	#log;
	#host;
	#listener;
	#conns = /* @__PURE__ */ new Set();
	#down = false;
	#linked;
	constructor(vsock, prep, log) {
		this.#vsock = vsock;
		this.#gpu = prep.gpu;
		this.#loader = prep.loader;
		this.#custom = prep.opts.renderer;
		this.#log = log;
		this.loaded = this.#loader ? this.#loader.loaded.then((c) => describe(c)) : this.#custom ? Promise.resolve("custom renderer") : Promise.reject(/* @__PURE__ */ new Error("no renderer"));
		this.loaded.catch(() => {});
		this.ready = this.#start(prep.opts);
		this.ready.catch((e) => log(`[host] gl: ${e?.message ?? e}; the guest gets no GL renderer`));
	}
	get stats() {
		const s = this.#host?.stats ?? {
			streams: 0,
			clients: 0,
			opened: 0
		};
		return this.#gpu ? {
			...s,
			gpu: { ...this.#gpu.stats }
		} : s;
	}
	get status() {
		if (this.#loader) return { ...this.#loader.status };
		return {
			state: "ready",
			eager: true,
			startedAt: null,
			loadMs: null,
			error: null,
			what: "custom renderer (gl.renderer)",
			webgl: null,
			losses: 0,
			renewals: 0
		};
	}
	load() {
		this.#loader?.load().catch(() => {});
		return this.loaded;
	}
	get gpu() {
		return this.#gpu;
	}
	async #start(opts) {
		const loader = this.#loader;
		if (loader?.status.state === "failed") throw new Error(loader.status.error ?? "no renderer");
		const core = loader && (opts.eager ? await loader.load() : null);
		if (!this.#vsock) return core ? `${describe(core)}; virtio-gpu only` : "virglrenderer (wasm), loaded on first use; virtio-gpu only";
		let renderer;
		let what;
		if (this.#custom) {
			renderer = this.#custom;
			what = await renderer.init();
		} else {
			renderer = new LazyVtestRenderer(loader, opts.strictWaits ?? false);
			what = core ? describe(core) : "virglrenderer (wasm), loaded on the guest's first GL use";
			await renderer.init();
		}
		if (this.#gpu) what += "; virtio-gpu 3D";
		if (this.#down) throw new Error("the kernel exited");
		this.#host = new StreamHost(renderer);
		this.#listener = this.#vsock.listen(GL_PORT, (conn) => this.#serve(conn));
		this.#log(`[host] gl: ${what}, on vsock port ${GL_PORT}`);
		if (opts.forwarder ?? true) {
			const linked = new Promise((r) => this.#linked = r);
			await this.#startForwarder();
			let timer;
			await Promise.race([linked, new Promise((_, rej) => timer = setTimeout(() => rej(/* @__PURE__ */ new Error(`the guest's forwarder did not link within ${LINK_TIMEOUT_MS / 1e3} s`)), LINK_TIMEOUT_MS))]).finally(() => clearTimeout(timer));
		}
		return what;
	}
	#serve(conn) {
		this.#conns.add(conn);
		const log = (s) => {
			this.#log(`[gl] ${s}`);
			if (s.startsWith("ready: vtest clients on ")) this.#linked?.();
		};
		this.#host.serve(conn.readable, conn.writable, { log }).catch((e) => {
			if (!this.#down) this.#log(`[host] gl: the forwarder's link broke: ${e?.message ?? e}`);
			conn.reset();
		}).finally(() => this.#conns.delete(conn));
	}
	async #startForwarder() {
		let r;
		try {
			r = await guestRun(this.#vsock, GL_FORWARDER[0], [
				...GL_FORWARDER.slice(1),
				"bridge",
				"--link",
				`vsock:2:${GL_PORT}`,
				"--daemon"
			], FORWARDER_TIMEOUT_MS);
		} catch (e) {
			const msg = e?.message ?? String(e);
			if (e instanceof PtyError && e.code === "EREMOTE" && noKwbox(msg)) throw new Error(`the guest has no ${KWBOX} (a base from before kwbox); start a forwarder yourself`, { cause: e });
			throw new Error(`cannot start the guest's forwarder: ${msg}`, { cause: e });
		}
		if (r.exitCode !== 0) throw new Error(`the guest's forwarder failed: ${r.stderr.trim() || `exit ${r.exitCode ?? `signal ${r.signal}`}`}`);
	}
	shutdown() {
		this.#down = true;
		this.#listener?.close();
		for (const c of this.#conns) c.reset();
		this.#gpu?.reset();
	}
};
function describe(c) {
	return `virglrenderer (wasm) on ${c.gl.getParameter(c.gl.VERSION)}; ${webglName(c.gl)}`;
}
const WEBGL_ATTRS = {
	alpha: false,
	depth: false,
	stencil: false,
	antialias: false,
	powerPreference: "high-performance"
};
function rendererAttrs(module) {
	return module.virgl.gpu.blit ? {
		...WEBGL_ATTRS,
		alpha: true,
		premultipliedAlpha: true,
		preserveDrawingBuffer: false
	} : WEBGL_ATTRS;
}
async function loadGlCore(url, log) {
	if (typeof OffscreenCanvas !== "function") throw new Error("no OffscreenCanvas here, so no WebGL2");
	const mod = await import(
		/* @vite-ignore */
		url
);
	const say = (s) => log(`[gl] virgl: ${s}`);
	const Module = await mod.default({
		print: say,
		printErr: say
	});
	const gl = new OffscreenCanvas(1, 1).getContext("webgl2", rendererAttrs(Module));
	if (!gl) throw new Error("no WebGL2 context (OffscreenCanvas.getContext(\"webgl2\") gave none)");
	if (gl.isContextLost() && !await restored(gl, RESTORE_WAIT_MS)) throw new Error(`the new WebGL2 context was lost from the start and not restored within ${RESTORE_WAIT_MS / 1e3} s`);
	Module.virgl.init(gl);
	return {
		module: Module,
		gl,
		gpu: Module.virgl.gpu
	};
}
const RESTORE_WAIT_MS = 5e3;
function restored(gl, ms) {
	const canvas = gl.canvas;
	return new Promise((resolve) => {
		const ac = new AbortController();
		const end = (ok) => {
			ac.abort();
			clearTimeout(timer);
			resolve(ok);
		};
		const timer = setTimeout(() => end(!gl.isContextLost()), ms);
		canvas.addEventListener("webglcontextlost", (e) => e.preventDefault(), { signal: ac.signal });
		canvas.addEventListener("webglcontextrestored", () => end(true), { signal: ac.signal });
	});
}
function probeWebGl2() {
	if (typeof OffscreenCanvas !== "function") return "no WebGL2 on this thread (no OffscreenCanvas)";
	try {
		const gl = new OffscreenCanvas(1, 1).getContext("webgl2", WEBGL_ATTRS);
		if (!gl) return "no WebGL2 context (OffscreenCanvas.getContext(\"webgl2\") gave none: WebGL is off or the GPU is blocklisted)";
		gl.getExtension("WEBGL_lose_context")?.loseContext();
		return "";
	} catch (e) {
		return `no WebGL2 context (${e?.message ?? e})`;
	}
}
var GlLoader = class {
	status;
	loaded;
	#url;
	#log;
	#settle;
	#started = false;
	#core = null;
	#lost = /* @__PURE__ */ new WeakSet();
	#renewing = null;
	#renewFailedAt = -1e400;
	#onLost = /* @__PURE__ */ new Set();
	constructor(url, log, eager, failed) {
		this.#url = url;
		this.#log = log;
		this.status = {
			state: failed ? "failed" : "idle",
			eager,
			startedAt: null,
			loadMs: null,
			error: failed || null,
			what: null,
			webgl: null,
			losses: 0,
			renewals: 0
		};
		this.loaded = new Promise((resolve, reject) => this.#settle = {
			resolve,
			reject
		});
		this.loaded.catch(() => {});
		if (failed) {
			this.#started = true;
			this.#settle.reject(new Error(failed));
		}
	}
	load() {
		if (this.#started) return this.loaded;
		this.#started = true;
		const st = this.status, t0 = performance.now();
		st.state = "loading";
		st.startedAt = t0;
		if (!st.eager) this.#log("[host] gl: the guest's first GL use: loading the renderer (virgl.mjs, virgl.wasm, a WebGL2 context)");
		loadGlCore(this.#url, this.#log).then((c) => {
			st.loadMs = performance.now() - t0;
			this.#up(c);
			this.#log(`[host] gl: renderer loaded in ${(st.loadMs / 1e3).toFixed(2)} s: ${st.what}; ${st.webgl}`);
			this.#settle.resolve(c);
		}, (e) => {
			st.loadMs = performance.now() - t0;
			st.state = "failed";
			st.error = e?.message ?? String(e);
			this.#log(`[host] gl: the renderer did not load: ${st.error}`);
			this.#settle.reject(e instanceof Error ? e : new Error(st.error));
		});
		return this.loaded;
	}
	get() {
		if (!this.#started) return this.load();
		const c = this.#core;
		if (!c) return this.loaded;
		if (c.gl.isContextLost()) this.#lose(c);
		if (!this.#lost.has(c)) return Promise.resolve(c);
		if (this.#renewing) return this.#renewing;
		if (performance.now() - this.#renewFailedAt < 1e3) return Promise.reject(new Error(this.status.error ?? "no renderer"));
		const st = this.status, t0 = performance.now();
		st.state = "loading";
		st.startedAt = t0;
		this.#log("[host] gl: a GL program after the WebGL2 context was lost: making a new renderer (a new module instance on a new WebGL2 context)");
		const p = loadGlCore(this.#url, this.#log).then((n) => {
			st.loadMs = performance.now() - t0;
			st.renewals++;
			this.#up(n);
			this.#log(`[host] gl: a new renderer in ${(st.loadMs / 1e3).toFixed(2)} s (${st.renewals} after ${st.losses} losses): ${st.what}; ${st.webgl}`);
			return n;
		}, (e) => {
			this.#renewFailedAt = performance.now();
			st.state = "lost";
			st.error = e?.message ?? String(e);
			this.#log(`[host] gl: no new renderer after the loss: ${st.error}; the guest's next GL use tries again`);
			throw e instanceof Error ? e : new Error(st.error);
		}).finally(() => {
			if (this.#renewing === p) this.#renewing = null;
		});
		this.#renewing = p;
		return p;
	}
	onLost(fn) {
		this.#onLost.add(fn);
	}
	#up(c) {
		const st = this.status;
		this.#core = c;
		st.state = "ready";
		st.error = null;
		st.webgl = webglName(c.gl);
		st.what = `virglrenderer (wasm) on ${c.gl.getParameter(c.gl.VERSION)}`;
		const canvas = c.gl.canvas;
		const ac = new AbortController();
		canvas.addEventListener("webglcontextlost", (e) => {
			e.preventDefault();
			this.#lose(c);
		}, { signal: ac.signal });
		canvas.addEventListener("webglcontextrestored", () => {
			ac.abort();
			this.#log("[host] gl: the browser restored the lost WebGL2 context: released (a new renderer is made on the guest's next GL use)");
			try {
				c.gl.getExtension("WEBGL_lose_context")?.loseContext();
			} catch {}
		}, { signal: ac.signal });
	}
	#lose(c) {
		if (this.#lost.has(c)) return;
		this.#lost.add(c);
		const st = this.status;
		st.losses++;
		if (c === this.#core) {
			st.state = "lost";
			this.#log("[host] gl: the WebGL2 context was lost (the browser dropped it: memory pressure, a GPU reset, the GPU process ended): GL programs that were running fail and must be restarted; the guest's next GL use makes a new renderer");
		}
		for (const fn of this.#onLost) try {
			fn(c);
		} catch {}
	}
};
var LazyVtestRenderer = class {
	onreply = () => {};
	onclose = () => {};
	#loader;
	#strict;
	#real = null;
	#core = null;
	#ids = /* @__PURE__ */ new Set();
	#ready = null;
	#opened = /* @__PURE__ */ new Set();
	constructor(loader, strictWaits) {
		this.#loader = loader;
		this.#strict = strictWaits;
		loader.loaded.then(() => void this.#start().catch(() => {}), () => {});
		loader.onLost((c) => {
			if (c !== this.#core) return;
			const r = this.#real, ids = [...this.#ids];
			this.#real = this.#core = this.#ready = null;
			this.#ids.clear();
			for (const id of ids) {
				try {
					r.close(id);
				} catch {}
				this.onclose(id, "the WebGL2 context was lost");
			}
		});
	}
	async init() {
		return "virglrenderer (wasm), loaded on first use";
	}
	#start() {
		const p = this.#ready ??= this.#loader.get().then(async (c) => {
			const r = new c.module.virgl.Renderer(c.gl, { strictWaits: this.#strict });
			await r.init();
			r.onreply = (id, b) => this.onreply(id, b);
			r.onclose = (id, why) => {
				this.#ids.delete(id);
				this.onclose(id, why);
			};
			this.#real = r;
			this.#core = c;
			for (const id of this.#opened) {
				r.open(id);
				this.#ids.add(id);
			}
			this.#opened.clear();
			return r;
		}, (e) => {
			if (this.#ready === p) this.#ready = null;
			const why = e?.message ?? String(e);
			const ids = [...this.#opened];
			this.#opened.clear();
			for (const id of ids) this.onclose(id, `no renderer: ${why}`);
			throw e;
		});
		return p;
	}
	open(id) {
		if (this.#real) {
			this.#ids.add(id);
			return this.#real.open(id);
		}
		this.#opened.add(id);
		this.#start().catch(() => {});
	}
	feed(id, bytes) {
		if (this.#real) return this.#real.feed(id, bytes);
		if (!this.#ready || !this.#opened.has(id)) return void 0;
		return this.#ready.then((r) => r.feed(id, bytes), () => {});
	}
	close(id) {
		this.#opened.delete(id);
		if (this.#ids.delete(id)) this.#real?.close(id);
	}
	stats(id) {
		return this.#real?.stats?.(id);
	}
	totals() {
		return this.#real?.totals?.();
	}
};
function webglName(gl) {
	const info = gl.getExtension("WEBGL_debug_renderer_info");
	return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
}
function prepareGl(opt, gpu, vsock, defaultModule, log, restoring = false) {
	if (!opt) return void 0;
	const opts = opt === true ? {} : opt;
	const module = opts.module ?? defaultModule;
	if (opts.renderer) {
		if (gpu) log("[host] gpu: 2D only: gl.renderer is a vtest renderer, which virtio-gpu cannot use");
		if (!vsock) {
			log("[host] gl: needs the vsock device (vsock: false was given, or vsock.raw); the guest gets no GL renderer");
			return;
		}
		return { opts };
	}
	const why = typeof OffscreenCanvas !== "function" ? "no WebGL2 on this thread (no OffscreenCanvas; Node has none)" : !module ? "no renderer module (this entry bundles none; pass gl.module, the URL of virgl.mjs)" : "";
	if (why) {
		if (gpu) log(`[host] gpu: 2D only: ${why}`);
		log(`[host] gl: ${why}, so it is ignored${typeof OffscreenCanvas !== "function" ? "; pass gl.renderer to use a renderer of your own" : ""}`);
		return;
	}
	if (!vsock && !gpu) {
		log("[host] gl: needs the vsock device (vsock: false was given, or vsock.raw); the guest gets no GL renderer");
		return;
	}
	const eager = !!opts.eager;
	let failed = "";
	if (!eager && !restoring) {
		const t0 = performance.now();
		failed = probeWebGl2();
		const ms = (performance.now() - t0).toFixed(1);
		log(failed ? `[host] gl: ${failed} (probed in ${ms} ms): no renderer` : `[host] gl: WebGL2 is there (probed in ${ms} ms); the renderer loads on the guest's first GL use`);
	}
	const loader = new GlLoader(String(module), log, eager, failed || void 0);
	if (eager) loader.load().catch(() => {});
	if (!gpu) return {
		opts,
		loader
	};
	if (failed) {
		log(`[host] gpu: 2D only: ${failed}`);
		return {
			opts,
			loader
		};
	}
	const renderer = new GpuRenderer(() => loader.load(), {
		strictWaits: opts.strictWaits,
		log,
		renew: () => loader.get()
	});
	if (eager) renderer.start();
	return {
		opts,
		loader,
		gpu: renderer
	};
}
function startGl(prep, vsock, log) {
	if (!prep) return void 0;
	return new GlHost(vsock, prep, log);
}
const VK_PORT = 1018;
function prepareVk(opt, vsock, platform, log) {
	if (!opt) return void 0;
	const opts = opt === true ? {} : opt;
	if (!vsock) {
		log("[host] vk: needs the vsock device (vsock: false was given, or vsock.raw); the guest gets no Vulkan renderer");
		return;
	}
	const gpu = globalThis.navigator?.gpu;
	if (!opts.device && !gpu) {
		log("[host] vk: no WebGPU on this thread (no navigator.gpu), so it is ignored");
		return;
	}
	if (!platform) {
		log("[host] vk: this entry bundles no Vulkan renderer (the web entry does), so it is ignored");
		return;
	}
	return {
		opts,
		shaderWasm: opts.shaderWasm ?? platform.shaderWasm,
		load: () => platform.load()
	};
}
async function probeCanvas(gpu) {
	const OC = globalThis.OffscreenCanvas;
	if (!OC) return null;
	let dev;
	try {
		const adapter = await gpu.requestAdapter();
		if (!adapter) return "no adapter for the probe";
		dev = await adapter.requestDevice();
		let lost = null;
		dev.lost.then((i) => lost = `${i?.reason ?? "?"}: ${i?.message ?? ""}`);
		const tex = dev.createTexture({
			size: [4, 4],
			format: "bgra8unorm",
			usage: 5
		});
		const cv = new OC(4, 4);
		const ctx = cv.getContext("webgpu");
		if (!ctx) return "no WebGPU context for an OffscreenCanvas";
		ctx.configure({
			device: dev,
			format: "bgra8unorm",
			usage: 18,
			alphaMode: "premultiplied"
		});
		const e = dev.createCommandEncoder();
		e.copyTextureToTexture({ texture: tex }, { texture: ctx.getCurrentTexture() }, [
			4,
			4,
			1
		]);
		dev.queue.submit([e.finish()]);
		cv.transferToImageBitmap().close();
		const timeout = new Promise((r) => setTimeout(() => r("timeout"), 2e3));
		const done = await Promise.race([dev.queue.onSubmittedWorkDone().then(() => "done"), timeout]).catch((err) => `failed (${err?.message ?? err})`);
		await new Promise((r) => setTimeout(r, 20));
		if (lost) return `the WebGPU canvas path destroyed its device (${lost})`;
		return done === "done" ? null : `the WebGPU canvas path ${done}`;
	} catch (err) {
		return `the WebGPU canvas path threw (${err?.message ?? err})`;
	} finally {
		try {
			dev?.destroy();
		} catch {}
	}
}
function startVk(prep, vsock, log) {
	if (!prep || !vsock) return void 0;
	return new VkHost(vsock, prep, log);
}
var VkHost = class {
	ready;
	loaded;
	#prep;
	#log;
	#listener;
	#conns = /* @__PURE__ */ new Set();
	#renderer;
	#current;
	#device;
	#loadedResolve;
	#loadedReject;
	#status = {
		state: "idle",
		startedAt: null,
		loadMs: null,
		error: null,
		adapter: null
	};
	#stats = {
		connections: 0,
		opened: 0,
		bytesIn: 0,
		bytesOut: 0,
		losses: 0
	};
	#down = false;
	constructor(vsock, prep, log) {
		this.#prep = prep;
		this.#log = log;
		this.loaded = new Promise((res, rej) => (this.#loadedResolve = res, this.#loadedReject = rej));
		this.loaded.catch(() => {});
		this.#listener = vsock.listen(VK_PORT, (conn) => this.#serve(conn));
		const what = `WebGPU renderer, loaded on the guest's first Vulkan instance, on vsock port ${VK_PORT}`;
		log(`[host] vk: ${what}`);
		this.ready = Promise.resolve(what);
	}
	get status() {
		return { ...this.#status };
	}
	get stats() {
		const r = this.#current?.stats;
		return {
			...this.#stats,
			renderer: r ? { ...r } : null
		};
	}
	get device() {
		return this.#current ? this.#device : void 0;
	}
	externalImage(ref) {
		const r = this.#current;
		if (!r?.external) return null;
		try {
			return r.external(ref);
		} catch (e) {
			this.#log(`[host] vk: externalImage: ${e?.message ?? e}`);
			return null;
		}
	}
	load() {
		this.#load().catch(() => {});
		return this.loaded;
	}
	#load() {
		if (!this.#renderer) {
			this.#renderer = this.#make();
			this.#renderer.catch(() => {});
		}
		return this.#renderer;
	}
	async #make() {
		const t0 = performance.now();
		this.#status = {
			...this.#status,
			state: "loading",
			startedAt: t0
		};
		try {
			const { opts } = this.#prep;
			let adapter = opts.adapter, device = opts.device;
			let canvas = Promise.resolve(null);
			if (!device) {
				const gpu = globalThis.navigator.gpu;
				if (!gpu) throw new Error("no navigator.gpu");
				canvas = probeCanvas(gpu);
				adapter = await gpu.requestAdapter(opts.powerPreference ? { powerPreference: opts.powerPreference } : void 0) ?? void 0;
				if (!adapter) throw new Error("navigator.gpu.requestAdapter() gave no adapter");
				const requiredLimits = {};
				const limits = adapter.limits;
				for (const k in limits) if (typeof limits[k] === "number") requiredLimits[k] = limits[k];
				device = await adapter.requestDevice({
					requiredFeatures: [...adapter.features],
					requiredLimits
				});
			}
			const { VkRenderer, loadVkShader } = await this.#prep.load();
			const shaders = await loadVkShader(this.#prep.shaderWasm);
			const verbose = opts.log ?? true;
			const fixed = !!opts.device;
			let renderer;
			const onLost = (info) => {
				if (this.#down || !renderer || this.#current !== renderer) return;
				this.#stats.losses++;
				this.#current = void 0;
				this.#renderer = fixed ? Promise.reject(/* @__PURE__ */ new Error("the WebGPU device (vk.device) was lost")) : void 0;
				this.#renderer?.catch(() => {});
				const why = `${info?.reason ?? "?"}: ${info?.message ?? ""}`;
				this.#status = {
					...this.#status,
					state: fixed ? "failed" : "lost",
					error: `device lost (${why})`
				};
				this.#log(`[host] vk: the WebGPU device was lost (${why}); its programs were cut off${fixed ? "; vk.device cannot be replaced" : ", the next one gets a new device"}`);
			};
			const broken = await canvas;
			if (broken) this.#log(`[host] vk: no external present (Wayland windows by readback): ${broken}`);
			renderer = new VkRenderer({
				device,
				adapter,
				shaders,
				onLost,
				...broken ? { external: false } : {},
				log: (line) => verbose && this.#log(`[vk] ${line}`)
			});
			this.#current = renderer;
			this.#device = device;
			const info = adapter?.info;
			const name = info ? [
				info.vendor,
				info.architecture,
				info.description || info.device
			].filter(Boolean).join(" ") || "WebGPU" : "WebGPU (vk.device)";
			const loadMs = performance.now() - t0;
			this.#status = {
				...this.#status,
				state: "ready",
				loadMs,
				adapter: name
			};
			this.#log(`[host] vk: renderer ready on ${name} (${loadMs.toFixed(0)} ms)`);
			this.#loadedResolve(name);
			return renderer;
		} catch (e) {
			const msg = e?.message ?? String(e);
			this.#status = {
				...this.#status,
				state: "failed",
				error: msg,
				loadMs: performance.now() - t0
			};
			this.#log(`[host] vk: no renderer: ${msg}`);
			this.#loadedReject(new Error(msg));
			throw e;
		}
	}
	#serve(conn) {
		if (this.#down) {
			conn.reset();
			return;
		}
		this.#conns.add(conn);
		this.#stats.connections++;
		this.#stats.opened++;
		const writer = conn.writable.getWriter();
		const stats = this.#stats;
		let link;
		let broken = false;
		const fail = (what, e) => {
			if (broken) return;
			broken = true;
			if (!this.#down) this.#log(`[host] vk: ${what}: ${e?.message ?? e}`);
			conn.reset();
		};
		let inflight = 0;
		let drained;
		const send = (bytes) => {
			stats.bytesOut += bytes.length;
			inflight++;
			writer.write(bytes).catch((e) => fail("a write to the guest failed", e)).finally(() => {
				if (--inflight === 0) drained?.();
			});
		};
		const closeAfterWrites = () => {
			if (!inflight) conn.close();
			else drained = () => conn.close();
		};
		const run = async () => {
			const reader = conn.readable.getReader();
			let renderer;
			try {
				renderer = await this.#load();
			} catch (e) {
				fail("the guest's Vulkan instance gets no renderer", e);
				return;
			}
			link = renderer.connect(send, closeAfterWrites);
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				stats.bytesIn += value.length;
				link.feed(value);
			}
		};
		run().catch((e) => fail("the link broke", e)).finally(() => {
			try {
				link?.close();
			} catch (e) {
				this.#log(`[host] vk: closing a connection threw: ${e?.message ?? e}`);
			}
			if (!broken) writer.close().catch(() => {});
			this.#conns.delete(conn);
			this.#stats.connections--;
		});
	}
	shutdown() {
		this.#down = true;
		this.#listener?.close();
		for (const c of this.#conns) c.reset();
	}
};
const VA_BUF = {
	picture: 0,
	iqMatrix: 1,
	bitPlane: 2,
	sliceParameter: 4,
	sliceData: 5,
	huffmanTable: 12,
	probability: 13
};
function sliceRanges(p) {
	const out = [];
	let params = null;
	for (const b of p.bufs) if (b.type === VA_BUF.sliceParameter) {
		if (b.size < 12) throw new Error(`slice parameters of ${b.size} bytes (VASliceParameterBufferBase is 12)`);
		params = b;
	} else if (b.type === VA_BUF.sliceData) {
		if (!params) {
			out.push(b.data);
			continue;
		}
		const dv = new DataView(params.data.buffer, params.data.byteOffset, params.data.byteLength);
		let total = 0;
		for (let i = 0; i < params.num; i++) {
			const size = dv.getUint32(i * params.size, true), off = dv.getUint32(i * params.size + 4, true);
			if (off + size > b.data.length) throw new Error(`slice ${i}: bytes ${off} to ${off + size} of a slice data buffer of ${b.data.length}`);
			if ((total += size) > b.data.length) throw new Error(`slices of more bytes than their slice data buffer's ${b.data.length}`);
			out.push(b.data.subarray(off, off + size));
		}
		params = null;
	}
	return out;
}
function concat$1(parts) {
	if (parts.length === 1) return parts[0];
	let n = 0;
	for (const p of parts) n += p.length;
	const out = new Uint8Array(n);
	n = 0;
	for (const p of parts) out.set(p, n), n += p.length;
	return out;
}
var BitWriter = class {
	#out = [];
	#acc = 0;
	#n = 0;
	bit(b) {
		this.#acc = this.#acc << 1 | b & 1;
		if (++this.#n === 8) {
			this.#out.push(this.#acc);
			this.#acc = 0;
			this.#n = 0;
		}
	}
	u(bits, v) {
		if (!Number.isInteger(v) || v < 0 || v >= 2 ** bits) throw new RangeError(`u(${bits}) of ${v}`);
		for (let i = bits - 1; i >= 0; i--) this.bit(Math.floor(v / 2 ** i) & 1);
	}
	ue(v) {
		if (!Number.isInteger(v) || v < 0 || v > 4294967294) throw new RangeError(`ue(v) of ${v}`);
		const x = v + 1, len = 31 - Math.clz32(x);
		this.u(len, 0);
		this.u(len + 1, x);
	}
	se(v) {
		this.ue(v > 0 ? 2 * v - 1 : -2 * v);
	}
	su(n, v) {
		if (!Number.isInteger(v) || v < -(2 ** (n - 1)) || v >= 2 ** (n - 1)) throw new RangeError(`su(${n}) of ${v}`);
		this.u(n, v < 0 ? v + 2 ** n : v);
	}
	ns(n, v) {
		if (!Number.isInteger(v) || v < 0 || v >= n) throw new RangeError(`ns(${n}) of ${v}`);
		const w = 32 - Math.clz32(n), m = 2 ** w - n;
		if (v < m) return this.u(w - 1, v);
		const t = v + m;
		this.u(w - 1, t >>> 1);
		this.bit(t & 1);
	}
	trailing() {
		this.bit(1);
		while (this.#n) this.bit(0);
	}
	align() {
		while (this.#n) this.bit(0);
	}
	bytes8(d) {
		if (this.#n) throw new Error("not byte aligned");
		for (const b of d) this.#out.push(b);
	}
	get bits() {
		return this.#out.length * 8 + this.#n;
	}
	bytes() {
		if (this.#n) throw new Error("RBSP not byte aligned");
		return Uint8Array.from(this.#out);
	}
};
var BitReader = class {
	#d;
	#pos = 0;
	#end;
	constructor(d) {
		this.#d = d;
		let e = d.length * 8;
		while (e > 0 && !(d[e - 1 >> 3] >> 7 - (e - 1 & 7) & 1)) e--;
		this.#end = e > 0 ? e - 1 : 0;
	}
	get pos() {
		return this.#pos;
	}
	bit() {
		if (this.#pos >= this.#d.length * 8) throw new Error(`cut short (${this.#d.length} bytes)`);
		const b = this.#d[this.#pos >> 3] >> 7 - (this.#pos & 7) & 1;
		this.#pos++;
		return b;
	}
	u(n) {
		let v = 0;
		while (n--) v = v * 2 + this.bit();
		return v;
	}
	skip(n) {
		if (!(n >= 0) || this.#pos + n > this.#d.length * 8) throw new Error(`cut short (${this.#d.length} bytes)`);
		this.#pos += n;
	}
	ue() {
		let z = 0;
		while (!this.bit()) if (++z > 31) throw new Error("an exp-Golomb code longer than 32 bits");
		return 2 ** z - 1 + this.u(z);
	}
	se() {
		const k = this.ue();
		return k % 2 ? (k + 1) / 2 : -(k / 2);
	}
	su(n) {
		const v = this.u(n);
		return v >= 2 ** (n - 1) ? v - 2 ** n : v;
	}
	ns(n) {
		const w = 32 - Math.clz32(n), m = 2 ** w - n, v = this.u(w - 1);
		return v < m ? v : (v << 1) - m + this.bit();
	}
	align() {
		while (this.#pos & 7) this.bit();
	}
	more() {
		return this.#pos < this.#end;
	}
};
function leb128(v) {
	const out = [];
	do {
		let b = v % 128;
		v = Math.floor(v / 128);
		if (v) b |= 128;
		out.push(b);
	} while (v);
	return out;
}
const VA_AV1_PIC_SIZE = 1160;
const KEY = 0;
const INTER = 1;
const INTRA_ONLY = 2;
const SWITCH = 3;
const NONE = 7;
const IDENTITY$1 = 0;
const TRANSLATION = 1;
const ROTZOOM = 2;
const AFFINE = 3;
function parseVaAv1PicParams(d) {
	if (d.length < 1124) throw new Error(`picture parameters of ${d.length} bytes (VADecPictureParameterBufferAV1 is ${VA_AV1_PIC_SIZE})`);
	const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
	const u8 = (o) => d[o], s8 = (o) => dv.getInt8(o), u16 = (o) => dv.getUint16(o, true), u32 = (o) => dv.getUint32(o, true);
	const bit = (v, at, n = 1) => v >>> at & (1 << n) - 1;
	const seq = u32(4), pic = u32(676), lf = u8(686), qm = u16(704), mc = u32(708), lr = u16(730), segf = u32(84), fg = u32(240);
	const points = (n, vo, so) => Array.from({ length: n }, (_, i) => [u8(vo + i), u8(so + i)]);
	return {
		profile: u8(0),
		orderHintBits: u8(1) + 1,
		bitDepthIdx: u8(2),
		stillPicture: !!bit(seq, 0),
		sb128: !!bit(seq, 1),
		enableFilterIntra: !!bit(seq, 2),
		enableIntraEdge: !!bit(seq, 3),
		enableInterintra: !!bit(seq, 4),
		enableMasked: !!bit(seq, 5),
		enableDualFilter: !!bit(seq, 6),
		enableOrderHint: !!bit(seq, 7),
		enableJntComp: !!bit(seq, 8),
		enableCdef: !!bit(seq, 9),
		mono: !!bit(seq, 10),
		colorRange: !!bit(seq, 11),
		ssx: bit(seq, 12),
		ssy: bit(seq, 13),
		chromaSamplePosition: bit(seq, 14),
		filmGrainPresent: !!bit(seq, 15),
		currentFrame: u32(8),
		displayPicture: u32(12),
		width: u16(32) + 1,
		height: u16(34) + 1,
		refFrameMap: Array.from({ length: 8 }, (_, i) => u32(40 + 4 * i)),
		refFrameIdx: Array.from({ length: 7 }, (_, i) => u8(72 + i)),
		primaryRefFrame: u8(79),
		orderHint: u8(80),
		seg: {
			enabled: !!bit(segf, 0),
			updateMap: !!bit(segf, 1),
			temporalUpdate: !!bit(segf, 2),
			updateData: !!bit(segf, 3),
			data: Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) => dv.getInt16(88 + 16 * i + 2 * j, true))),
			mask: Array.from({ length: 8 }, (_, i) => u8(216 + i))
		},
		grain: {
			apply: !!bit(fg, 0),
			chromaScalingFromLuma: !!bit(fg, 1),
			scalingMinus8: bit(fg, 2, 2),
			arLag: bit(fg, 4, 2),
			arShiftMinus6: bit(fg, 6, 2),
			scaleShift: bit(fg, 8, 2),
			overlap: !!bit(fg, 10),
			clip: !!bit(fg, 11),
			seed: u16(244),
			y: points(Math.min(14, u8(246)), 247, 261),
			cb: points(Math.min(10, u8(275)), 276, 286),
			cr: points(Math.min(10, u8(296)), 297, 307),
			arY: Array.from({ length: 24 }, (_, i) => s8(317 + i)),
			arCb: Array.from({ length: 25 }, (_, i) => s8(341 + i)),
			arCr: Array.from({ length: 25 }, (_, i) => s8(366 + i)),
			cbMult: u8(391),
			cbLumaMult: u8(392),
			cbOffset: u16(394),
			crMult: u8(396),
			crLumaMult: u8(397),
			crOffset: u16(398)
		},
		tileCols: u8(416),
		tileRows: u8(417),
		widthSbs: Array.from({ length: 63 }, (_, i) => u16(418 + 2 * i) + 1),
		heightSbs: Array.from({ length: 63 }, (_, i) => u16(544 + 2 * i) + 1),
		contextUpdateTileId: u16(672),
		frameType: bit(pic, 0, 2),
		showFrame: !!bit(pic, 2),
		showableFrame: !!bit(pic, 3),
		errorRes: !!bit(pic, 4),
		disableCdfUpdate: !!bit(pic, 5),
		screenContent: !!bit(pic, 6),
		forceIntegerMv: !!bit(pic, 7),
		intrabc: !!bit(pic, 8),
		superres: !!bit(pic, 9),
		hpMv: !!bit(pic, 10),
		motionSwitchable: !!bit(pic, 11),
		refFrameMvs: !!bit(pic, 12),
		disableFrameEndUpdateCdf: !!bit(pic, 13),
		uniformTiles: !!bit(pic, 14),
		warpedMotion: !!bit(pic, 15),
		largeScaleTile: !!bit(pic, 16),
		superresDenom: u8(680),
		interpFilter: u8(681),
		lfLevel: [
			u8(682),
			u8(683),
			u8(684),
			u8(685)
		],
		sharpness: bit(lf, 0, 3),
		deltaEnabled: !!bit(lf, 3),
		deltaUpdate: !!bit(lf, 4),
		refDeltas: Array.from({ length: 8 }, (_, i) => s8(687 + i)),
		modeDeltas: [s8(695), s8(696)],
		baseQ: u8(697),
		dq: {
			ydc: s8(698),
			udc: s8(699),
			uac: s8(700),
			vdc: s8(701),
			vac: s8(702)
		},
		qm: {
			using: !!bit(qm, 0),
			y: bit(qm, 1, 4),
			u: bit(qm, 5, 4),
			v: bit(qm, 9, 4)
		},
		deltaQPresent: !!bit(mc, 0),
		deltaQRes: bit(mc, 1, 2),
		deltaLfPresent: !!bit(mc, 3),
		deltaLfRes: bit(mc, 4, 2),
		deltaLfMulti: !!bit(mc, 6),
		txMode: bit(mc, 7, 2),
		referenceSelect: !!bit(mc, 9),
		reducedTxSet: !!bit(mc, 10),
		skipModePresent: !!bit(mc, 11),
		cdefDampingMinus3: u8(712),
		cdefBits: u8(713),
		cdefY: Array.from({ length: 8 }, (_, i) => u8(714 + i)),
		cdefUv: Array.from({ length: 8 }, (_, i) => u8(722 + i)),
		lrType: [
			bit(lr, 0, 2),
			bit(lr, 2, 2),
			bit(lr, 4, 2)
		],
		lrUnitShift: bit(lr, 6, 2),
		lrUvShift: bit(lr, 8),
		gm: Array.from({ length: 7 }, (_, i) => ({
			type: u32(732 + 56 * i),
			mat: Array.from({ length: 6 }, (_, j) => dv.getInt32(732 + 56 * i + 4 + 4 * j, true))
		}))
	};
}
function av1TileGroups(p, tileCols) {
	const out = [];
	let count = 0;
	const group = (all, b) => {
		const tiles = [];
		let total = 0;
		for (const params of all) {
			const dv = new DataView(params.data.buffer, params.data.byteOffset, params.data.byteLength);
			const whole = params.num === 1 && params.size > 40 && params.size % 40 === 0;
			const stride = whole ? 40 : params.size, num = whole ? params.size / 40 : params.num;
			if (num * stride > params.data.byteLength) throw new Error(`slice parameters of ${params.data.byteLength} bytes for ${num} tiles`);
			if ((count += num) > 4096) throw new Error("more than 4096 tiles");
			for (let i = 0; i < num; i++) {
				const o = i * stride, size = dv.getUint32(o, true), off = dv.getUint32(o + 4, true);
				if (off + size > b.data.length) throw new Error(`tile ${tiles.length}: bytes ${off} to ${off + size} of a tile data buffer of ${b.data.length}`);
				if ((total += size) > b.data.length) throw new Error(`tiles of more bytes than their tile data buffer's ${b.data.length}`);
				tiles.push({
					idx: dv.getUint16(o + 12, true) * tileCols + dv.getUint16(o + 14, true),
					data: b.data.subarray(off, off + size)
				});
			}
		}
		tiles.sort((a, c) => a.idx - c.idx);
		if (tiles.some((t, i) => t.idx !== tiles[0].idx + i)) throw new Error("a tile group whose tiles are not consecutive");
		if (tiles.length) out.push({
			start: tiles[0].idx,
			end: tiles[tiles.length - 1].idx,
			tiles: tiles.map((t) => t.data)
		});
	};
	const allParams = p.bufs.filter((b) => b.type === VA_BUF.sliceParameter), allData = p.bufs.filter((b) => b.type === VA_BUF.sliceData);
	for (const b of allParams) if (b.size < 24) throw new Error(`slice parameters of ${b.size} bytes`);
	if (allData.length === 1) {
		if (!allParams.length) throw new Error("tile data without slice parameters");
		group(allParams, allData[0]);
	} else {
		let params = null, data = null;
		for (const b of p.bufs) if (b.type === VA_BUF.sliceParameter) {
			if (data) group([b], data), data = null;
			else params = b;
		} else if (b.type === VA_BUF.sliceData) {
			if (params) group([params], b), params = null;
			else if (data) throw new Error("tile data without slice parameters");
			else data = b;
		}
		if (data) throw new Error("tile data without slice parameters");
	}
	out.sort((a, b) => a.start - b.start);
	return out;
}
function obu(type, payload) {
	const size = leb128(payload.length), out = new Uint8Array(1 + size.length + payload.length);
	out[0] = type << 3 | 2;
	out.set(size, 1);
	out.set(payload, 1 + size.length);
	return out;
}
function writeSequenceHeader(s) {
	const w = new BitWriter();
	w.u(3, 0);
	w.u(1, s.stillPicture ? 1 : 0);
	w.u(1, 0);
	w.u(1, 0);
	w.u(1, 0);
	w.u(5, 0);
	w.u(12, 0);
	w.u(5, s.level);
	if (s.level > 7) w.u(1, 0);
	w.u(4, 15);
	w.u(4, 15);
	w.u(16, s.maxWidth - 1);
	w.u(16, s.maxHeight - 1);
	w.u(1, 0);
	w.u(1, s.sb128 ? 1 : 0);
	w.u(1, s.enableFilterIntra ? 1 : 0);
	w.u(1, s.enableIntraEdge ? 1 : 0);
	w.u(1, s.enableInterintra ? 1 : 0);
	w.u(1, s.enableMasked ? 1 : 0);
	w.u(1, 1);
	w.u(1, s.enableDualFilter ? 1 : 0);
	w.u(1, s.enableOrderHint ? 1 : 0);
	if (s.enableOrderHint) {
		w.u(1, s.enableJntComp ? 1 : 0);
		w.u(1, 1);
	}
	w.u(1, 1);
	w.u(1, 1);
	if (s.enableOrderHint) w.u(3, s.orderHintBits - 1);
	w.u(1, 1);
	w.u(1, s.enableCdef ? 1 : 0);
	w.u(1, 1);
	w.u(1, 0);
	w.u(1, 0);
	w.u(1, 0);
	w.u(1, s.colorRange ? 1 : 0);
	w.u(2, s.chromaSamplePosition);
	w.u(1, 1);
	w.u(1, s.filmGrainPresent ? 1 : 0);
	w.trailing();
	return w.bytes();
}
function av1Level(w, h) {
	for (const [idx, size, hs, vs] of [
		[
			0,
			147456,
			2048,
			1152
		],
		[
			1,
			278784,
			2816,
			1584
		],
		[
			4,
			665856,
			4352,
			2448
		],
		[
			5,
			1065024,
			5504,
			3096
		],
		[
			8,
			2359296,
			6144,
			3456
		],
		[
			12,
			8912896,
			8192,
			4352
		],
		[
			16,
			35651584,
			16384,
			8704
		]
	]) if (w * h <= size && w <= hs && h <= vs) return idx;
	return 31;
}
function av1CodecString(level) {
	return `av01.0.${String(level).padStart(2, "0")}M.08`;
}
const tileLog2 = (blk, target) => {
	let k = 0;
	while (blk << k < target) k++;
	return k;
};
function writeSignedSubexpWithRef(w, v, low, high, r) {
	const x = v - low, mx = high - low, rr = r - low;
	if (x < 0 || x >= mx) throw new RangeError(`a global motion parameter ${v} outside [${low}, ${high})`);
	const recenter = (r, v) => v > 2 * r ? v : v >= r ? v - r << 1 : (r - v << 1) - 1;
	const sub = rr << 1 <= mx ? recenter(rr, x) : recenter(mx - 1 - rr, mx - 1 - x);
	let i = 0, mk = 0;
	const k = 3;
	for (;;) {
		const b2 = i ? k + i - 1 : k, a = 1 << b2;
		if (mx <= mk + 3 * a) return w.ns(mx - mk, sub - mk);
		if (sub >= mk + a) {
			w.u(1, 1);
			i++;
			mk += a;
		} else {
			w.u(1, 0);
			return w.u(b2, sub - mk);
		}
	}
}
const DEFAULT_GM = () => Array.from({ length: 7 }, () => [
	0,
	0,
	65536,
	0,
	0,
	65536
]);
function writeFrameHeader(pp, env) {
	const w = new BitWriter(), seq = env.seq;
	const ft = pp.frameType, intra = ft === KEY || ft === INTRA_ONLY;
	const ohBits = seq.enableOrderHint ? seq.orderHintBits : 0;
	w.u(1, 0);
	w.u(2, ft);
	w.u(1, env.show ? 1 : 0);
	if (!env.show) w.u(1, env.showable ? 1 : 0);
	const errorRes = ft === SWITCH || ft === KEY && env.show ? true : pp.errorRes;
	if (!(ft === SWITCH || ft === KEY && env.show)) w.u(1, errorRes ? 1 : 0);
	w.u(1, pp.disableCdfUpdate ? 1 : 0);
	w.u(1, pp.screenContent ? 1 : 0);
	const forceIntegerMv = intra ? true : pp.screenContent ? pp.forceIntegerMv : false;
	if (pp.screenContent) w.u(1, pp.forceIntegerMv ? 1 : 0);
	const override = ft === SWITCH || pp.width !== seq.maxWidth || pp.height !== seq.maxHeight;
	if (ft !== SWITCH) w.u(1, override ? 1 : 0);
	if (ohBits) w.u(ohBits, pp.orderHint);
	const primary = intra || errorRes ? NONE : pp.primaryRefFrame;
	if (!(intra || errorRes)) w.u(3, primary);
	const refresh = ft === SWITCH || ft === KEY && env.show ? 255 : env.refresh;
	if (!(ft === SWITCH || ft === KEY && env.show)) w.u(8, refresh);
	if ((!intra || refresh !== 255) && errorRes && seq.enableOrderHint) for (let i = 0; i < 8; i++) w.u(ohBits, env.slots[i]?.orderHint ?? 0);
	const upscaledWidth = pp.width;
	const frameWidth = pp.superres ? Math.floor((upscaledWidth * 8 + (pp.superresDenom >> 1)) / pp.superresDenom) : upscaledWidth;
	const frameSize = () => {
		if (override) {
			w.u(16, pp.width - 1);
			w.u(16, pp.height - 1);
		}
		w.u(1, pp.superres ? 1 : 0);
		if (pp.superres) w.u(3, pp.superresDenom - 9);
		w.u(1, 0);
	};
	let hpMv = false;
	if (intra) {
		frameSize();
		if (pp.screenContent && upscaledWidth === frameWidth) w.u(1, pp.intrabc ? 1 : 0);
	} else {
		if (seq.enableOrderHint) w.u(1, 0);
		for (let i = 0; i < 7; i++) w.u(3, env.refIdx[i]);
		if (override && !errorRes) for (let i = 0; i < 7; i++) w.u(1, 0);
		frameSize();
		if (!forceIntegerMv) {
			hpMv = pp.hpMv;
			w.u(1, hpMv ? 1 : 0);
		}
		w.u(1, pp.interpFilter === 4 ? 1 : 0);
		if (pp.interpFilter !== 4) w.u(2, pp.interpFilter);
		w.u(1, pp.motionSwitchable ? 1 : 0);
		if (!errorRes && seq.enableOrderHint) w.u(1, pp.refFrameMvs ? 1 : 0);
	}
	if (!pp.disableCdfUpdate) w.u(1, pp.disableFrameEndUpdateCdf ? 1 : 0);
	const intrabc = intra && pp.screenContent && upscaledWidth === frameWidth && pp.intrabc;
	const miCols = 2 * (frameWidth + 7 >> 3), miRows = 2 * (pp.height + 7 >> 3);
	const sbSize = (seq.sb128 ? 5 : 4) + 2;
	const sbCols = seq.sb128 ? miCols + 31 >> 5 : miCols + 15 >> 4, sbRows = seq.sb128 ? miRows + 31 >> 5 : miRows + 15 >> 4;
	const maxTileWidthSb = 4096 >> sbSize, maxTileAreaSbAll = 9437184 >> 2 * sbSize;
	const minLog2TileCols = tileLog2(maxTileWidthSb, sbCols), maxLog2TileCols = tileLog2(1, Math.min(sbCols, 64)), maxLog2TileRows = tileLog2(1, Math.min(sbRows, 64));
	const minLog2Tiles = Math.max(minLog2TileCols, tileLog2(maxTileAreaSbAll, sbRows * sbCols));
	w.u(1, pp.uniformTiles ? 1 : 0);
	let colsLog2, rowsLog2;
	if (pp.uniformTiles) {
		const count = (sb, k) => {
			const t = sb + (1 << k) - 1 >> k;
			return Math.ceil(sb / t);
		};
		const pick = (min, max, sb, want, what) => {
			for (let k = min; k <= max; k++) if (count(sb, k) === want) return k;
			throw new Error(`${want} uniform tile ${what} do not fit ${sb} superblocks`);
		};
		colsLog2 = pick(minLog2TileCols, maxLog2TileCols, sbCols, pp.tileCols, "columns");
		for (let k = minLog2TileCols; k < maxLog2TileCols; k++) {
			w.u(1, k < colsLog2 ? 1 : 0);
			if (k >= colsLog2) break;
		}
		const minLog2TileRows = Math.max(minLog2Tiles - colsLog2, 0);
		rowsLog2 = pick(minLog2TileRows, maxLog2TileRows, sbRows, pp.tileRows, "rows");
		for (let k = minLog2TileRows; k < maxLog2TileRows; k++) {
			w.u(1, k < rowsLog2 ? 1 : 0);
			if (k >= rowsLog2) break;
		}
	} else {
		let widest = 0, start = 0;
		for (let i = 0; i < pp.tileCols; i++) {
			const size = pp.widthSbs[i];
			w.ns(Math.min(sbCols - start, maxTileWidthSb), size - 1);
			widest = Math.max(widest, size);
			start += size;
		}
		if (start !== sbCols) throw new Error(`tile columns of ${start} superblocks in a frame of ${sbCols}`);
		colsLog2 = tileLog2(1, pp.tileCols);
		const maxTileAreaSb = minLog2Tiles > 0 ? sbRows * sbCols >> minLog2Tiles + 1 : sbRows * sbCols;
		const maxTileHeightSb = Math.max(Math.floor(maxTileAreaSb / widest), 1);
		start = 0;
		for (let i = 0; i < pp.tileRows; i++) {
			const size = pp.heightSbs[i];
			w.ns(Math.min(sbRows - start, maxTileHeightSb), size - 1);
			start += size;
		}
		if (start !== sbRows) throw new Error(`tile rows of ${start} superblocks in a frame of ${sbRows}`);
		rowsLog2 = tileLog2(1, pp.tileRows);
	}
	if (colsLog2 > 0 || rowsLog2 > 0) {
		w.u(rowsLog2 + colsLog2, pp.contextUpdateTileId);
		w.u(2, 3);
	}
	const deltaQ = (v) => {
		w.u(1, v ? 1 : 0);
		if (v) w.su(7, v);
	};
	w.u(8, pp.baseQ);
	deltaQ(pp.dq.ydc);
	const diffUv = pp.dq.udc !== pp.dq.vdc || pp.dq.uac !== pp.dq.vac;
	w.u(1, diffUv ? 1 : 0);
	deltaQ(pp.dq.udc);
	deltaQ(pp.dq.uac);
	if (diffUv) {
		deltaQ(pp.dq.vdc);
		deltaQ(pp.dq.vac);
	}
	w.u(1, pp.qm.using ? 1 : 0);
	if (pp.qm.using) {
		w.u(4, pp.qm.y);
		w.u(4, pp.qm.u);
		w.u(4, pp.qm.v);
	}
	const SEG_BITS = [
		8,
		6,
		6,
		6,
		6,
		3,
		0,
		0
	], SEG_SIGNED = [
		1,
		1,
		1,
		1,
		1,
		0,
		0,
		0
	], SEG_MAX = [
		255,
		63,
		63,
		63,
		63,
		7,
		0,
		0
	];
	w.u(1, pp.seg.enabled ? 1 : 0);
	if (pp.seg.enabled) {
		let updateData = true;
		if (primary !== NONE) {
			w.u(1, pp.seg.updateMap ? 1 : 0);
			if (pp.seg.updateMap) w.u(1, pp.seg.temporalUpdate ? 1 : 0);
			w.u(1, pp.seg.updateData ? 1 : 0);
			updateData = pp.seg.updateData;
		}
		if (updateData) for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
			const en = pp.seg.mask[i] >> j & 1;
			w.u(1, en);
			if (!en || !SEG_BITS[j]) continue;
			const v = Math.max(SEG_SIGNED[j] ? -SEG_MAX[j] : 0, Math.min(SEG_MAX[j], pp.seg.data[i][j]));
			if (SEG_SIGNED[j]) w.su(1 + SEG_BITS[j], v);
			else w.u(SEG_BITS[j], v);
		}
	}
	if (pp.baseQ > 0) {
		w.u(1, pp.deltaQPresent ? 1 : 0);
		if (pp.deltaQPresent) w.u(2, pp.deltaQRes);
	}
	if (pp.baseQ > 0 && pp.deltaQPresent) {
		if (!intrabc) {
			w.u(1, pp.deltaLfPresent ? 1 : 0);
			if (pp.deltaLfPresent) {
				w.u(2, pp.deltaLfRes);
				w.u(1, pp.deltaLfMulti ? 1 : 0);
			}
		}
	}
	let codedLossless = true;
	for (let s = 0; s < 8; s++) {
		let q = pp.baseQ;
		if (pp.seg.enabled && pp.seg.mask[s] & 1) q = Math.max(0, Math.min(255, q + pp.seg.data[s][0]));
		if (!(q === 0 && !pp.dq.ydc && !pp.dq.uac && !pp.dq.udc && !pp.dq.vac && !pp.dq.vdc)) codedLossless = false;
	}
	const allLossless = codedLossless && frameWidth === upscaledWidth;
	if (!codedLossless && !intrabc) {
		w.u(6, pp.lfLevel[0]);
		w.u(6, pp.lfLevel[1]);
		if (pp.lfLevel[0] || pp.lfLevel[1]) {
			w.u(6, pp.lfLevel[2]);
			w.u(6, pp.lfLevel[3]);
		}
		w.u(3, pp.sharpness);
		w.u(1, pp.deltaEnabled ? 1 : 0);
		if (pp.deltaEnabled) {
			w.u(1, pp.deltaUpdate ? 1 : 0);
			if (pp.deltaUpdate) {
				for (let i = 0; i < 8; i++) w.u(1, 1), w.su(7, pp.refDeltas[i]);
				for (let i = 0; i < 2; i++) w.u(1, 1), w.su(7, pp.modeDeltas[i]);
			}
		}
	}
	if (!codedLossless && !intrabc && seq.enableCdef) {
		w.u(2, pp.cdefDampingMinus3);
		w.u(2, pp.cdefBits);
		for (let i = 0; i < 1 << pp.cdefBits; i++) {
			w.u(4, pp.cdefY[i] >> 2);
			w.u(2, pp.cdefY[i] & 3);
			w.u(4, pp.cdefUv[i] >> 2);
			w.u(2, pp.cdefUv[i] & 3);
		}
	}
	if (!allLossless && !intrabc) {
		const CODED = [
			0,
			2,
			3,
			1
		];
		let usesLr = false, usesChromaLr = false;
		for (let i = 0; i < 3; i++) {
			w.u(2, CODED[pp.lrType[i]]);
			if (pp.lrType[i]) usesLr = true, usesChromaLr ||= i > 0;
		}
		if (usesLr) {
			if (seq.sb128) {
				if (pp.lrUnitShift < 1) throw new Error("lr_unit_shift 0 with 128x128 superblocks");
				w.u(1, pp.lrUnitShift - 1);
			} else {
				w.u(1, pp.lrUnitShift ? 1 : 0);
				if (pp.lrUnitShift) w.u(1, pp.lrUnitShift - 1);
			}
			if (usesChromaLr) w.u(1, pp.lrUvShift);
		}
	}
	if (!codedLossless) w.u(1, pp.txMode === 2 ? 1 : 0);
	if (!intra) w.u(1, pp.referenceSelect ? 1 : 0);
	const rel = (a, b) => {
		if (!seq.enableOrderHint) return 0;
		const diff = a - b, m = 1 << ohBits - 1;
		return (diff & m - 1) - (diff & m);
	};
	let skipAllowed = false;
	if (!intra && pp.referenceSelect && seq.enableOrderHint) {
		let fwd = -1, bwd = -1, fwdHint = 0, bwdHint = 0;
		const hint = (i) => env.slots[env.refIdx[i]]?.orderHint ?? 0;
		for (let i = 0; i < 7; i++) {
			const h = hint(i);
			if (rel(h, pp.orderHint) < 0) {
				if (fwd < 0 || rel(h, fwdHint) > 0) fwd = i, fwdHint = h;
			} else if (rel(h, pp.orderHint) > 0) {
				if (bwd < 0 || rel(h, bwdHint) < 0) bwd = i, bwdHint = h;
			}
		}
		if (fwd < 0) skipAllowed = false;
		else if (bwd >= 0) skipAllowed = true;
		else {
			let second = -1, secondHint = 0;
			for (let i = 0; i < 7; i++) {
				const h = hint(i);
				if (rel(h, fwdHint) < 0 && (second < 0 || rel(h, secondHint) > 0)) second = i, secondHint = h;
			}
			skipAllowed = second >= 0;
		}
	}
	if (skipAllowed) w.u(1, pp.skipModePresent ? 1 : 0);
	if (!intra && !errorRes) w.u(1, pp.warpedMotion ? 1 : 0);
	w.u(1, pp.reducedTxSet ? 1 : 0);
	if (!intra) {
		const prev = primary === NONE ? DEFAULT_GM() : env.slots[env.refIdx[primary]]?.gm ?? DEFAULT_GM();
		for (let ref = 0; ref < 7; ref++) {
			const { type, mat } = pp.gm[ref];
			w.u(1, type !== IDENTITY$1 ? 1 : 0);
			if (type !== IDENTITY$1) {
				w.u(1, type === ROTZOOM ? 1 : 0);
				if (type !== ROTZOOM) w.u(1, type === TRANSLATION ? 1 : 0);
			}
			const param = (idx) => {
				let absBits = 12, precBits = 15;
				if (idx < 2) {
					if (type === TRANSLATION) absBits = 9 - (hpMv ? 0 : 1), precBits = 3 - (hpMv ? 0 : 1);
					else absBits = 12, precBits = 6;
				}
				const precDiff = 16 - precBits, round = idx % 3 === 2 ? 65536 : 0, sub = idx % 3 === 2 ? 1 << precBits : 0, mx = 1 << absBits;
				const r = (prev[ref][idx] >> precDiff) - sub, v = mat[idx] - round >> precDiff;
				if (v * 2 ** precDiff + round !== mat[idx]) throw new Error(`a global motion parameter ${mat[idx]} not on its ${precBits}-bit grid`);
				writeSignedSubexpWithRef(w, v, -mx, mx + 1, r);
			};
			if (type >= ROTZOOM) {
				param(2);
				param(3);
				if (type === AFFINE) param(4), param(5);
			}
			if (type >= TRANSLATION) param(0), param(1);
		}
	}
	if (seq.filmGrainPresent && (env.show || env.showable)) {
		const g = pp.grain;
		w.u(1, g.apply ? 1 : 0);
		if (g.apply) {
			w.u(16, g.seed);
			if (ft === INTER) w.u(1, 1);
			w.u(4, g.y.length);
			for (const [v, s] of g.y) w.u(8, v), w.u(8, s);
			w.u(1, g.chromaScalingFromLuma ? 1 : 0);
			const noChroma = g.chromaScalingFromLuma || pp.ssx === 1 && pp.ssy === 1 && g.y.length === 0;
			if (!noChroma) {
				w.u(4, g.cb.length);
				for (const [v, s] of g.cb) w.u(8, v), w.u(8, s);
				w.u(4, g.cr.length);
				for (const [v, s] of g.cr) w.u(8, v), w.u(8, s);
			}
			const numCb = noChroma ? 0 : g.cb.length, numCr = noChroma ? 0 : g.cr.length;
			w.u(2, g.scalingMinus8);
			w.u(2, g.arLag);
			const numPosLuma = 2 * g.arLag * (g.arLag + 1);
			const numPosChroma = g.y.length ? numPosLuma + 1 : numPosLuma;
			if (g.y.length) for (let i = 0; i < numPosLuma; i++) w.u(8, g.arY[i] + 128);
			if (g.chromaScalingFromLuma || numCb) for (let i = 0; i < numPosChroma; i++) w.u(8, g.arCb[i] + 128);
			if (g.chromaScalingFromLuma || numCr) for (let i = 0; i < numPosChroma; i++) w.u(8, g.arCr[i] + 128);
			w.u(2, g.arShiftMinus6);
			w.u(2, g.scaleShift);
			if (numCb) w.u(8, g.cbMult), w.u(8, g.cbLumaMult), w.u(9, g.cbOffset);
			if (numCr) w.u(8, g.crMult), w.u(8, g.crLumaMult), w.u(9, g.crOffset);
			w.u(1, g.overlap ? 1 : 0);
			w.u(1, g.clip ? 1 : 0);
		}
	}
	w.trailing();
	return {
		data: w.bytes(),
		tileBits: colsLog2 + rowsLog2,
		numTiles: pp.tileCols * pp.tileRows
	};
}
function writeTileGroup(tg, numTiles, tileBits, whole) {
	const w = new BitWriter();
	if (numTiles > 1) {
		w.u(1, whole ? 0 : 1);
		if (!whole) w.u(tileBits, tg.start), w.u(tileBits, tg.end);
	}
	w.align();
	for (const [i, t] of tg.tiles.entries()) {
		if (i < tg.tiles.length - 1) {
			const n = t.length - 1;
			w.bytes8(Uint8Array.of(n & 255, n >> 8 & 255, n >> 16 & 255, n >>> 24));
		}
		w.bytes8(t);
	}
	return w.bytes();
}
function showExistingHeader(idx) {
	const w = new BitWriter();
	w.u(1, 1);
	w.u(3, idx);
	w.trailing();
	return w.bytes();
}
const TD = obu(2, /* @__PURE__ */ new Uint8Array(0));
const cat = (parts) => {
	let n = 0;
	for (const p of parts) n += p.length;
	const out = new Uint8Array(n);
	n = 0;
	for (const p of parts) out.set(p, n), n += p.length;
	return out;
};
function av1Adapter(width, height, log, conservative = false) {
	let mode = conservative ? "conservative" : "model";
	let seq = null, seqKey = "";
	let seqObu = null;
	let slots = new Array(8).fill(null);
	let unstored = null;
	let redecodes = 0, hidden = 0, stored = 0;
	return {
		config: () => seq ? { codec: av1CodecString(seq.level) } : null,
		mode: () => mode,
		conservative() {
			mode = "conservative";
			return false;
		},
		state: () => ({
			slots: slots.map((s) => s?.pic ?? null),
			redecodes,
			hidden
		}),
		info: () => ({
			redecodes,
			deferred: stored,
			hidden
		}),
		filler() {
			const i = slots.findIndex((s) => s && s.frameType !== KEY);
			return i < 0 ? null : {
				data: cat([TD, obu(3, showExistingHeader(i))]),
				key: false,
				output: false,
				added: true
			};
		},
		picture(p) {
			const pb = p.bufs.find((b) => b.type === VA_BUF.picture);
			if (!pb) throw new Error("no picture parameters");
			const pp = parseVaAv1PicParams(pb.data);
			if (pp.profile !== 0) throw new Error(`profile ${pp.profile} (only Main, profile 0, is supported)`);
			if (pp.bitDepthIdx !== 0) throw new Error(`a bit depth of ${[
				8,
				10,
				12
			][pp.bitDepthIdx] ?? "?"} (only 8 is supported)`);
			if (pp.mono) throw new Error("monochrome is not supported");
			if (pp.ssx !== 1 || pp.ssy !== 1) throw new Error("only 4:2:0 is supported");
			if (pp.largeScaleTile) throw new Error("large-scale tile is not supported");
			if (pp.frameType === KEY && !pp.showFrame) throw new Error("hidden key frames are not supported");
			if (!pp.tileCols || !pp.tileRows || pp.tileCols > 64 || pp.tileRows > 64) throw new Error(`a bad tile layout ${pp.tileCols}x${pp.tileRows}`);
			const groups = av1TileGroups(p, pp.tileCols);
			if (!groups.length) throw new Error("no tile data");
			const numTiles = pp.tileCols * pp.tileRows;
			if (groups[0].start !== 0 || groups[groups.length - 1].end !== numTiles - 1 || groups.some((g, i) => i && g.start !== groups[i - 1].end + 1)) throw new Error(`tile groups that do not cover the ${numTiles} tiles`);
			const key = pp.frameType === KEY && pp.showFrame;
			const s = {
				stillPicture: pp.stillPicture,
				level: 0,
				maxWidth: Math.max(width, pp.width, seq?.maxWidth ?? 0),
				maxHeight: Math.max(height, pp.height, seq?.maxHeight ?? 0),
				sb128: pp.sb128,
				enableFilterIntra: pp.enableFilterIntra,
				enableIntraEdge: pp.enableIntraEdge,
				enableInterintra: pp.enableInterintra,
				enableMasked: pp.enableMasked,
				enableDualFilter: pp.enableDualFilter,
				enableOrderHint: pp.enableOrderHint,
				enableJntComp: pp.enableJntComp,
				orderHintBits: pp.orderHintBits,
				enableCdef: pp.enableCdef,
				colorRange: pp.colorRange,
				chromaSamplePosition: pp.chromaSamplePosition,
				filmGrainPresent: pp.filmGrainPresent
			};
			if (key) {
				s.maxWidth = Math.max(width, pp.width);
				s.maxHeight = Math.max(height, pp.height);
			}
			s.level = av1Level(s.maxWidth, s.maxHeight);
			const k = JSON.stringify(s);
			let reconfigure = false;
			if (k !== seqKey) {
				if (!key) {
					if (!seq) throw new Error("the stream does not start with a key frame");
					throw new Error("a new sequence header in an inter frame");
				}
				reconfigure = seq !== null && av1CodecString(seq.level) !== av1CodecString(s.level);
				seq = s;
				seqKey = k;
				seqObu = obu(1, writeSequenceHeader(s));
			}
			const sq = seq;
			const chunks = [];
			const live = new Set(key ? [] : pp.refFrameMap.map((_, i) => p.refs[i] ?? 0).filter((x) => x > 0));
			const has = (pic) => slots.findIndex((x) => x?.pic === pic);
			const dead = () => slots.findIndex((x, i) => !x || !live.has(x.pic) || has(x.pic) !== i);
			if (key) unstored = null;
			else {
				if (unstored && live.has(unstored.pic) && has(unstored.pic) < 0) {
					const d = dead();
					if (d < 0) throw new Error("no decoder slot for a reference (the app's map holds 9 pictures?)");
					chunks.push({
						data: unstored.chunk(1 << d),
						key: false,
						output: false,
						added: true
					});
					slots[d] = unstored.slot(1 << d);
					redecodes++;
				}
				unstored = null;
				for (const pic of live) if (has(pic) < 0) throw new Error(`a reference (picture ${pic}) the decoder does not hold`);
			}
			const refIdx = pp.refFrameIdx.map((i) => {
				if (key || pp.frameType === INTRA_ONLY) return 0;
				const pic = p.refs[i] ?? 0, at = pic ? has(pic) : -1;
				if (at < 0) throw new Error(`ref_frame_idx names slot ${i}, which holds no picture the decoder has`);
				return at;
			});
			const d = key ? -1 : dead();
			const refresh = key ? 255 : d >= 0 ? 1 << d : 0;
			const ownGm = pp.frameType === KEY || pp.frameType === INTRA_ONLY ? DEFAULT_GM() : pp.gm.map((g) => g.type === IDENTITY$1 ? [
				0,
				0,
				65536,
				0,
				0,
				65536
			] : g.mat.slice());
			const slotOf = () => ({
				pic: p.pic,
				orderHint: pp.orderHint,
				frameType: pp.frameType,
				gm: ownGm
			});
			const before = slots.slice();
			const header = (show, showable, r) => writeFrameHeader(pp, {
				seq: sq,
				show,
				showable,
				refresh: r,
				refIdx,
				slots: before
			});
			const tus = (show, showable, r, withSeq) => {
				const h = header(show, showable, r);
				const parts = [
					TD,
					...withSeq ? [seqObu] : [],
					obu(3, h.data)
				];
				for (const g of groups) parts.push(obu(4, writeTileGroup(g, h.numTiles, h.tileBits, groups.length === 1)));
				return cat(parts);
			};
			if (!pp.showFrame) hidden++;
			const chunk = {
				data: tus(true, false, refresh, key),
				key,
				output: true,
				...reconfigure ? { reconfigure } : {}
			};
			if (key) slots = new Array(8).fill(null).map(() => slotOf());
			else if (d >= 0) slots[d] = slotOf();
			else {
				const notStored = () => {
					unstored = {
						pic: p.pic,
						slot: slotOf,
						chunk: (r) => tus(false, true, r, false)
					};
					return {
						...chunk,
						data: tus(true, false, 0, false)
					};
				};
				chunk.hold = (next) => {
					if (!next) return notStored();
					const kept = new Set(pp.refFrameMap.map((_, i) => next.refs[i] ?? 0).filter((x) => x > 0));
					if (!kept.has(p.pic)) return {
						...chunk,
						data: tus(true, false, 0, false)
					};
					const free = slots.findIndex((x, i) => !x || !kept.has(x.pic) || has(x.pic) !== i);
					if (free < 0) return notStored();
					stored++;
					slots[free] = slotOf();
					return {
						...chunk,
						data: tus(true, false, 1 << free, false)
					};
				};
			}
			chunks.push(chunk);
			return chunks;
		}
	};
}
const VA_ENC_BUF = {
	coded: 21,
	sequence: 22,
	picture: 23,
	slice: 24,
	packedHeaderParameter: 25,
	packedHeaderData: 26,
	misc: 27
};
const VA_MISC = {
	frameRate: 0,
	rateControl: 1,
	maxFrameSize: 4,
	hrd: 5,
	qualityLevel: 6
};
const BITRATE_MODE = {
	cbr: "constant",
	vbr: "variable",
	cqp: "quantizer"
};
const CHUNK_MAX = 63 << 20;
const KEPT_MAX = 256 << 20;
const STALL = [
	100,
	2e3,
	1e3
];
const RECOVER_MAX = 2;
const GUEST_COLOUR = {
	primaries: "smpte170m",
	transfer: "smpte170m",
	matrix: "smpte170m",
	fullRange: false
};
const CLOSED_KEPT$1 = 8;
function vp9Level(w, h) {
	const s = w * h;
	for (const [max, level] of [
		[36864, 10],
		[73728, 11],
		[122880, 20],
		[245760, 21],
		[552960, 30],
		[983040, 31],
		[2228224, 40],
		[8912896, 50],
		[35651584, 60]
	]) if (s <= max) return level;
	return 62;
}
const VP9_QINDEX = [
	0,
	4,
	8,
	12,
	16,
	20,
	24,
	28,
	32,
	36,
	40,
	44,
	48,
	52,
	56,
	60,
	64,
	68,
	72,
	76,
	80,
	84,
	88,
	92,
	96,
	100,
	104,
	108,
	112,
	116,
	120,
	124,
	128,
	132,
	136,
	140,
	144,
	148,
	152,
	156,
	160,
	164,
	168,
	172,
	176,
	180,
	184,
	188,
	192,
	196,
	200,
	204,
	208,
	212,
	216,
	220,
	224,
	228,
	232,
	236,
	240,
	244,
	249,
	255
];
function vp9Quantizer(qindex) {
	let best = 0;
	for (let q = 1; q < 64; q++) if (Math.abs(VP9_QINDEX[q] - qindex) < Math.abs(VP9_QINDEX[best] - qindex)) best = q;
	return best;
}
const u32 = (b, off) => new DataView(b.data.buffer, b.data.byteOffset, b.data.byteLength).getUint32(off, true);
function vp9Encoder() {
	return {
		config: (w, h) => ({ codec: `vp09.00.${vp9Level(w, h)}.08` }),
		picture(p) {
			let seq, pic;
			for (const b of p.bufs) if (b.type === VA_ENC_BUF.sequence && b.num) seq = b;
			else if (b.type === VA_ENC_BUF.picture && b.num) pic = b;
			if (!pic) throw new Error("no picture parameters");
			if (pic.size < 100) throw new Error(`picture parameters of ${pic.size} bytes (at least 100)`);
			if (seq && seq.size < 28) throw new Error(`sequence parameters of ${seq.size} bytes (at least 28)`);
			const srcWidth = u32(pic, 0), srcHeight = u32(pic, 4);
			let width = u32(pic, 8), height = u32(pic, 12);
			if (!width || !height) width = srcWidth, height = srcHeight;
			for (const v of [
				srcWidth,
				srcHeight,
				width,
				height
			]) if (!(v >= 1 && v <= 16384)) throw new Error(`a frame of ${srcWidth}x${srcHeight} encoded as ${width}x${height}`);
			const refFlags = u32(pic, 56), picFlags = u32(pic, 60);
			return {
				width,
				height,
				srcWidth,
				srcHeight,
				key: (picFlags & 1) === 0 || (refFlags & 1) === 1,
				show: (picFlags & 2) !== 0,
				qindex: pic.data[65],
				bitrate: seq ? u32(seq, 20) : 0,
				intraPeriod: seq ? u32(seq, 24) : 0
			};
		},
		options: (params, mode) => mode === "cqp" && params.qindex !== null ? { vp9: { quantizer: vp9Quantizer(params.qindex) } } : {}
	};
}
const ENCODERS = [{
	profile: "vp9.0",
	label: "VP9 profile 0",
	probe: (w, h) => `vp09.00.${vp9Level(w, h)}.08`,
	create: vp9Encoder
}];
function encWebCodecs() {
	const g = globalThis;
	return g.VideoEncoder && g.VideoFrame ? g : void 0;
}
async function probeEncoders(wc, hw) {
	const out = {
		profiles: [],
		modes: {},
		support: {}
	};
	if (!wc) return out;
	const ask = (k, bitrateMode, acc) => wc.VideoEncoder.isConfigSupported({
		codec: k.probe(1920, 1080),
		width: 1920,
		height: 1080,
		bitrate: 4e6,
		bitrateMode,
		framerate: 30,
		latencyMode: "realtime",
		hardwareAcceleration: acc
	}).then((s) => !!s.supported, () => false);
	await Promise.all(ENCODERS.map(async (k) => {
		const [cbr, vbr, cqp, hard, soft] = await Promise.all([
			ask(k, "constant", hw),
			ask(k, "variable", hw),
			ask(k, "quantizer", hw),
			ask(k, "variable", "prefer-hardware"),
			ask(k, "variable", "prefer-software")
		]);
		out.support[k.profile] = {
			hardware: hard,
			software: soft
		};
		const modes = [];
		if (cqp) modes.push("cqp");
		if (cbr) modes.push("cbr");
		if (vbr) modes.push("vbr");
		if (!modes.length) return;
		out.modes[k.profile] = modes;
		out.profiles.push(k.profile);
	}));
	out.profiles.sort((a, b) => ENCODERS.findIndex((k) => k.profile === a) - ENCODERS.findIndex((k) => k.profile === b));
	return out;
}
function encodeStats() {
	return {
		contexts: 0,
		opened: 0,
		encoders: 0,
		pictures: 0,
		chunks: 0,
		keyFrames: 0,
		codedBytes: 0,
		uploads: 0,
		uploadBytes: 0,
		kept: 0,
		decoded: 0,
		black: 0,
		keptBytes: 0,
		failed: 0,
		errors: 0,
		reclaims: 0,
		flushes: 0,
		recoveries: 0,
		reconfigures: 0,
		fallbacks: 0,
		hidden: 0,
		list: []
	};
}
const now$1 = () => globalThis.performance?.now() ?? Date.now();
const errText = (e) => e?.message ?? String(e);
var VaEncoders = class {
	#h;
	#ctxs = /* @__PURE__ */ new Map();
	#kept = /* @__PURE__ */ new Map();
	#keptBytes = 0;
	#warned = /* @__PURE__ */ new Set();
	#black = /* @__PURE__ */ new Map();
	#closed = false;
	#injections = [];
	constructor(h) {
		this.#h = h;
	}
	has(id) {
		return this.#ctxs.has(id);
	}
	#once(key, msg) {
		if (this.#warned.has(key)) return;
		this.#warned.add(key);
		this.#h.log(msg);
	}
	async ctx(m) {
		const kind = ENCODERS.find((k) => k.profile === m.profile);
		const sup = await this.#h.support();
		if (!kind || !sup.profiles.includes(kind.profile)) return { err: `profile ${m.profile} has no encoder here` };
		const w = Number(m.width), h = Number(m.height);
		if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 16384 && h <= 16384)) return { err: `a bad size ${m.width}x${m.height}` };
		const modes = sup.modes[kind.profile] ?? [];
		const mode = modes.includes(m.rc) ? m.rc : modes[0];
		const base = this.#h.hardwareAcceleration;
		const ladder = base === "prefer-software" ? [base] : [base, "prefer-software"];
		const ok = [];
		for (const acc of ladder) {
			const cfg = {
				codec: kind.probe(w, h),
				width: w,
				height: h,
				bitrate: 2e6,
				bitrateMode: BITRATE_MODE[mode],
				framerate: 30,
				latencyMode: "realtime",
				hardwareAcceleration: acc
			};
			if ((await this.#h.wc.VideoEncoder.isConfigSupported(cfg).catch(() => ({ supported: false }))).supported) ok.push(acc);
		}
		if (!ok.length) return { err: `VideoEncoder.isConfigSupported(${kind.probe(w, h)}, ${w}x${h}, ${BITRATE_MODE[mode]}) said no` };
		const info = {
			id: Number(m.id),
			profile: kind.profile,
			width: w,
			height: h,
			frameWidth: 0,
			frameHeight: 0,
			codec: null,
			rc: mode,
			bitrate: 0,
			framerate: 30,
			hardwareAcceleration: ok[0],
			open: true,
			pictures: 0,
			chunks: 0,
			keyFrames: 0,
			bytes: 0,
			failed: 0,
			recoveries: 0,
			reconfigures: 0,
			latencyMs: 0
		};
		const c = {
			id: Number(m.id),
			kind,
			adapter: kind.create(),
			width: w,
			height: h,
			mode,
			bitrate: 0,
			framerate: 30,
			encoder: null,
			configKey: "",
			frameW: 0,
			frameH: 0,
			ladder: ok,
			rung: 0,
			everOutput: false,
			queue: [],
			inflight: /* @__PURE__ */ new Map(),
			seq: 0,
			tsNext: 0,
			needKey: true,
			fails: 0,
			timer: null,
			flushing: null,
			flushSeq: 0,
			latency: 0,
			closing: false,
			info
		};
		const old = this.#ctxs.get(c.id);
		if (old) this.#drop(old, "its context was replaced");
		this.#ctxs.set(c.id, c);
		this.#h.open.add(info);
		this.#h.stats.contexts++;
		this.#h.stats.opened++;
		return {};
	}
	free(id) {
		const c = this.#ctxs.get(id);
		if (!c) return false;
		this.#ctxs.delete(id);
		c.closing = true;
		this.#retire(c);
		return true;
	}
	surfFree(ids) {
		for (const id of ids) this.#unkeep(id);
	}
	#unkeep(id) {
		const k = this.#kept.get(id);
		if (!k) return;
		this.#kept.delete(id);
		this.#keptBytes -= k.data.length;
		this.#h.stats.keptBytes = this.#keptBytes;
	}
	close() {
		this.#closed = true;
		for (const c of this.#ctxs.values()) this.#drop(c, "the link closed");
		this.#ctxs.clear();
		this.#kept.clear();
		this.#keptBytes = 0;
		this.#h.stats.keptBytes = 0;
	}
	enc(m, bin) {
		const st = this.#h.stats;
		st.pictures++;
		const pic = Number(m.pic), surface = Number(m.surface);
		if (!(pic > 0) || !Number.isSafeInteger(pic)) throw new Error(`a bad picture id ${m.pic}`);
		const c = this.#ctxs.get(Number(m.ctx));
		const fail = (why) => {
			st.failed++;
			if (c) c.info.failed++;
			this.#notice({
				ev: "coded",
				pic,
				err: why
			});
		};
		if (!c || c.closing) return fail(`no encode context ${m.ctx}`);
		c.info.pictures++;
		const bufs = [];
		let off = 0;
		for (const b of Array.isArray(m.bufs) ? m.bufs : []) {
			const [type, size, num] = (Array.isArray(b) ? b : []).map(Number);
			const len = size * num;
			if (!Number.isSafeInteger(size) || !Number.isSafeInteger(num) || size < 0 || num < 0 || !Number.isSafeInteger(len) || off + len > bin.length) throw new Error(`buffers beyond the frame's ${bin.length} bytes`);
			bufs.push({
				type,
				size,
				num,
				data: bin.subarray(off, off + len)
			});
			off += len;
		}
		const vp = {
			pic,
			surface,
			profile: c.kind.profile,
			width: c.width,
			height: c.height,
			bufs,
			refs: []
		};
		let params;
		try {
			params = c.adapter.picture(vp);
		} catch (e) {
			return fail(`${c.kind.label}: ${errText(e)}`);
		}
		if (!params.show) {
			st.hidden++;
			this.#once("hidden", `[host] va: ${c.kind.label} encode: the app asks for hidden frames (show_frame 0), which WebCodecs does not make: encoded shown (the stream stays valid; a player shows them)`);
		}
		const job = {
			pic,
			surface,
			params,
			input: null,
			ready: false,
			failed: null,
			kept: false,
			rc: this.#misc(bufs, params),
			ts: 0,
			seq: 0,
			t0: now$1()
		};
		const src = m.src && typeof m.src === "object" ? m.src : {};
		try {
			if (src.pixels) {
				const p = src.pixels, w = Number(p.width), hh = Number(p.height), pitch = Number(p.pitch), gen = Number(p.gen);
				if (!(Number.isInteger(w) && Number.isInteger(hh) && Number.isInteger(pitch) && w > 0 && hh > 0 && w <= 16384 && hh <= 16384 && pitch >= w && pitch <= 65536)) throw new Error(`pixels of a bad layout (${p.width}x${p.height}, pitch ${p.pitch})`);
				const n = pitch * hh + pitch * (hh + 1 >> 1);
				if (off + n > bin.length) throw new Error(`pixels of ${n} bytes, ${bin.length - off} sent`);
				const data = bin.subarray(off, off + n);
				job.input = {
					kind: "nv12",
					data,
					pitch,
					uv: pitch * hh,
					width: w,
					height: hh
				};
				job.ready = true;
				st.uploads++;
				st.uploadBytes += n;
				this.#unkeep(surface);
				if (Number.isSafeInteger(gen) && gen > 0 && this.#keptBytes + n <= KEPT_MAX) {
					this.#kept.set(surface, {
						gen,
						data,
						pitch,
						width: w,
						height: hh
					});
					this.#keptBytes += n;
					st.keptBytes = this.#keptBytes;
					job.kept = true;
				}
			} else if (src.kept !== void 0) {
				const k = this.#kept.get(surface);
				if (!k || k.gen !== Number(src.kept)) throw new Error(`no kept pixels of surface ${surface} (generation ${src.kept})`);
				job.input = {
					kind: "nv12",
					data: k.data,
					pitch: k.pitch,
					uv: k.pitch * k.height,
					width: k.width,
					height: k.height
				};
				job.ready = true;
				job.kept = true;
				st.kept++;
			} else if (src.pic !== void 0) {
				st.decoded++;
				const id = Number(src.pic);
				this.#h.source(id, surface, (s) => this.#resolved(c, job, s));
			} else {
				st.black++;
				job.input = this.#blackInput(params.srcWidth, params.srcHeight);
				job.ready = true;
			}
		} catch (e) {
			return fail(errText(e));
		}
		c.queue.push(job);
		const due = this.#due();
		this.#pump(c);
		for (const what of due) this.#inject(c, what);
	}
	#misc(bufs, params) {
		const rc = {};
		if (params.bitrate > 0) rc.bitrate = params.bitrate;
		for (const b of bufs) {
			if (b.type !== VA_ENC_BUF.misc || b.size < 8) continue;
			for (let i = 0; i < b.num; i++) {
				const e = b.data.subarray(i * b.size, (i + 1) * b.size);
				const dv = new DataView(e.buffer, e.byteOffset, e.byteLength), type = dv.getUint32(0, true);
				if (type === VA_MISC.rateControl && e.length >= 12) {
					const bps = dv.getUint32(4, true), pct = dv.getUint32(8, true);
					if (bps > 0) rc.bitrate = Math.round(bps * (pct > 0 && pct <= 100 ? pct : 100) / 100);
				} else if (type === VA_MISC.frameRate) {
					const fr = dv.getUint32(4, true), num = fr & 65535, den = fr >>> 16 || 1;
					if (num > 0 && num / den <= 1e3) rc.framerate = num / den;
				}
			}
		}
		return rc;
	}
	#blackInput(w, h) {
		const pitch = w + 63 & -64, key = `${w}x${h}`;
		let data = this.#black.get(key);
		if (!data) {
			data = new Uint8Array(pitch * h + pitch * (h + 1 >> 1));
			data.fill(16, 0, pitch * h);
			data.fill(128, pitch * h);
			this.#black.set(key, data);
		}
		return {
			kind: "nv12",
			data,
			pitch,
			uv: pitch * h,
			width: w,
			height: h
		};
	}
	#resolved(c, job, s) {
		if (job.ready || job.failed) return;
		if (this.#closed) return;
		try {
			if (!s) job.failed = "no decoded picture of that surface to encode";
			else if (s.frame) job.input = {
				kind: "frame",
				frame: new this.#h.wc.VideoFrame(s.frame, { timestamp: 0 }),
				width: s.width,
				height: s.height
			};
			else if (s.data) {
				const pitch = s.width + 63 & -64;
				job.input = {
					kind: "nv12",
					data: s.data,
					pitch,
					uv: pitch * s.height,
					width: s.width,
					height: s.height,
					colorSpace: s.colorSpace ?? null
				};
			} else job.failed = "the decoded picture has no pixels left";
			if (s?.failed) this.#once("srcfailed", `[host] va: an encode's input picture failed to decode (${s.failed}): its stand-in is encoded`);
		} catch (e) {
			job.failed = `its decoded picture: ${errText(e)}`;
		}
		job.ready = true;
		this.#pump(c);
	}
	#pump(c) {
		while (!this.#closed && c.queue.length && c.queue[0].ready) this.#submit(c, c.queue.shift());
		if (c.closing && !c.queue.length) this.#retire(c);
	}
	#config(c, w, h) {
		const cfg = {
			...c.adapter.config(w, h),
			width: w,
			height: h,
			framerate: c.framerate,
			latencyMode: "realtime",
			bitrateMode: BITRATE_MODE[c.mode],
			hardwareAcceleration: c.ladder[c.rung]
		};
		if (c.mode !== "cqp") cfg.bitrate = c.bitrate > 0 ? c.bitrate : Math.max(1e5, Math.round(w * h * c.framerate * .1));
		return cfg;
	}
	#makeEncoder(c) {
		const enc = new this.#h.wc.VideoEncoder({
			output: (chunk) => this.#output(c, enc, chunk),
			error: (e) => this.#failed(c, enc, e)
		});
		c.encoder = enc;
		this.#h.stats.encoders++;
		c.configKey = "";
		c.needKey = true;
		return enc;
	}
	#closeEncoder(c) {
		const enc = c.encoder;
		if (!enc) return;
		c.encoder = null;
		this.#h.stats.encoders--;
		if (enc.state !== "closed") try {
			enc.close();
		} catch {}
	}
	#submit(c, job) {
		if (job.failed) return this.#fail(c, job, job.failed);
		if (c.encoder && c.encoder.state === "closed") {
			c.queue.unshift(job);
			return this.#failed(c, c.encoder, Object.assign(/* @__PURE__ */ new Error("the encoder was closed"), { name: "QuotaExceededError" }));
		}
		let frame = null;
		try {
			if (job.rc.mode) c.mode = job.rc.mode;
			if (job.rc.bitrate) c.bitrate = job.rc.bitrate;
			if (job.rc.framerate) c.framerate = job.rc.framerate;
			const { width: w, height: h } = job.params;
			if (!c.encoder) this.#makeEncoder(c);
			const cfg = this.#config(c, w, h), key = JSON.stringify(cfg);
			if (key !== c.configKey) {
				if (c.configKey) {
					this.#h.stats.reconfigures++;
					c.info.reconfigures++;
				}
				if (w !== c.frameW || h !== c.frameH) c.needKey = true;
				c.encoder.configure(cfg);
				c.configKey = key;
				c.frameW = w;
				c.frameH = h;
				Object.assign(c.info, {
					codec: cfg.codec,
					rc: c.mode,
					bitrate: cfg.bitrate ?? 0,
					framerate: c.framerate,
					frameWidth: w,
					frameHeight: h,
					hardwareAcceleration: c.ladder[c.rung]
				});
			}
			const dur = Math.round(1e6 / c.framerate);
			job.seq = ++c.seq;
			job.ts = c.tsNext;
			c.tsNext += dur;
			frame = this.#frame(job, dur);
			const keyFrame = job.params.key || c.needKey;
			c.needKey = false;
			c.inflight.set(job.ts, job);
			c.encoder.encode(frame, {
				keyFrame,
				...c.adapter.options(job.params, c.mode)
			});
			this.#progress(c);
		} catch (e) {
			c.inflight.delete(job.ts);
			this.#h.stats.errors++;
			if (!c.everOutput && c.rung + 1 < c.ladder.length) this.#fallback(c, e);
			else if (c.fails >= RECOVER_MAX) {
				this.#fail(c, job, `VideoEncoder: ${errText(e)}`);
				return this.#recover(c, errText(e));
			}
			c.queue.unshift(job);
			this.#recover(c, errText(e));
		} finally {
			try {
				frame?.close();
			} catch {}
		}
	}
	#frame(job, dur) {
		const inp = job.input, VF = this.#h.wc.VideoFrame;
		const sw = job.params.srcWidth, sh = job.params.srcHeight;
		const vw = Math.min(sw, inp.width), vh = Math.min(sh, inp.height);
		if (vw < sw || vh < sh) this.#once("small", `[host] va: an encode's input (${inp.width}x${inp.height}) is smaller than the source it names (${sw}x${sh}): the encoder scales it`);
		if (inp.kind === "frame") {
			const r = inp.frame.visibleRect ?? {
				x: 0,
				y: 0,
				width: inp.frame.displayWidth,
				height: inp.frame.displayHeight
			};
			return new VF(inp.frame, {
				timestamp: job.ts,
				duration: dur,
				visibleRect: {
					x: r.x,
					y: r.y,
					width: Math.min(r.width, sw),
					height: Math.min(r.height, sh)
				}
			});
		}
		return new VF(inp.data, {
			format: "NV12",
			codedWidth: inp.pitch,
			codedHeight: inp.height,
			timestamp: job.ts,
			duration: dur,
			colorSpace: inp.colorSpace ?? GUEST_COLOUR,
			visibleRect: {
				x: 0,
				y: 0,
				width: vw,
				height: vh
			},
			layout: [{
				offset: 0,
				stride: inp.pitch
			}, {
				offset: inp.uv,
				stride: inp.pitch
			}]
		});
	}
	#output(c, enc, chunk) {
		if (enc !== c.encoder || this.#closed) return;
		const job = c.inflight.get(chunk.timestamp);
		if (!job) return;
		c.inflight.delete(chunk.timestamp);
		c.everOutput = true;
		c.fails = 0;
		const st = this.#h.stats;
		try {
			if (chunk.byteLength > CHUNK_MAX) throw new Error(`a chunk of ${chunk.byteLength} bytes (at most ${CHUNK_MAX})`);
			let data = new Uint8Array(chunk.byteLength);
			chunk.copyTo(data);
			const key = chunk.type === "key";
			if (c.adapter.chunk) data = c.adapter.chunk(data, key);
			const l = now$1() - job.t0;
			c.latency = c.latency ? .8 * c.latency + .2 * l : l;
			c.info.latencyMs = Math.round(c.latency * 10) / 10;
			st.chunks++;
			st.codedBytes += data.length;
			c.info.chunks++;
			c.info.bytes += data.length;
			if (key) st.keyFrames++, c.info.keyFrames++;
			this.#release(job);
			this.#notice({
				ev: "coded",
				pic: job.pic,
				key,
				...job.kept ? { kept: true } : {}
			}, data);
		} catch (e) {
			this.#fail(c, job, errText(e));
		}
		this.#progress(c);
		if (c.closing) this.#retire(c);
	}
	#failed(c, enc, err) {
		if (enc !== c.encoder) return;
		const reclaimed = err?.name === "QuotaExceededError";
		c.encoder = null;
		this.#h.stats.encoders--;
		if (reclaimed) this.#h.stats.reclaims++;
		else this.#h.stats.errors++;
		if (this.#h.verbose) this.#h.log(reclaimed ? `[va] the browser reclaimed the encoder (${c.kind.label} ${c.frameW}x${c.frameH}): ${errText(err)}; made again, a key frame next` : `[va] encoder error (${c.kind.label} ${c.frameW}x${c.frameH}): ${err?.name ?? "Error"}: ${errText(err)}`);
		if (!reclaimed && !c.everOutput && c.rung + 1 < c.ladder.length) this.#fallback(c, err);
		this.#recover(c, errText(err), !reclaimed);
	}
	#fallback(c, err) {
		const from = c.ladder[c.rung];
		c.rung++;
		c.configKey = "";
		this.#h.stats.fallbacks++;
		this.#h.log(`[host] va: ${c.kind.label} encoder failed before its first chunk with ${from} (${errText(err)}): trying ${c.ladder[c.rung]}`);
	}
	#recover(c, why, counts = true) {
		const owed = [...c.inflight.values()].sort((a, b) => a.seq - b.seq);
		c.inflight.clear();
		this.#closeEncoder(c);
		if (this.#closed) return;
		if (counts && ++c.fails > RECOVER_MAX) {
			for (const j of owed) this.#fail(c, j, `the encoder failed again: ${why}`);
			c.fails = RECOVER_MAX;
			return;
		}
		if (!owed.length) return;
		this.#h.stats.recoveries++;
		c.info.recoveries++;
		c.queue.unshift(...owed);
		this.#pump(c);
	}
	#fail(c, job, why) {
		this.#release(job);
		this.#h.stats.failed++;
		c.info.failed++;
		this.#notice({
			ev: "coded",
			pic: job.pic,
			err: why
		});
	}
	#release(job) {
		if (job.input?.kind === "frame") try {
			job.input.frame.close();
		} catch {}
		job.input = null;
	}
	#notice(obj, bin) {
		if (!this.#closed) this.#h.out(obj, bin);
	}
	#progress(c) {
		if (c.timer) clearTimeout(c.timer);
		c.timer = null;
		if (!c.inflight.size || this.#closed) return;
		const [lo, hi, first] = STALL;
		const ms = c.latency ? Math.min(hi, Math.max(lo, 8 * c.latency + 20)) : first;
		c.timer = setTimeout(() => this.#stall(c), ms);
	}
	#stall(c, forced = false) {
		if (forced && c.timer) clearTimeout(c.timer);
		c.timer = null;
		const enc = c.encoder;
		if (this.#closed || !enc || !c.inflight.size || c.flushing === enc) return;
		if (!forced && (enc.encodeQueueSize ?? 0) > 0) return this.#progress(c);
		this.#h.stats.flushes++;
		if (!forced) this.#h.log(`[host] va: the ${c.kind.label} encoder held its output with nothing queued: flushed`);
		c.flushing = enc;
		c.flushSeq = c.seq;
		const done = () => {
			if (c.flushing === enc) c.flushing = null;
			if (c.encoder !== enc) return;
			if ([...c.inflight.values()].filter((j) => j.seq <= c.flushSeq).length) this.#recover(c, "the flush gave no chunk for them");
			else this.#progress(c);
		};
		enc.flush().then(done, () => {
			if (c.flushing === enc) c.flushing = null;
		});
	}
	#retire(c) {
		if (c.queue.length) return;
		const enc = c.encoder;
		if (enc && c.inflight.size) {
			if (c.flushing === enc) return;
			c.flushing = enc;
			const done = () => {
				for (const j of c.inflight.values()) this.#fail(c, j, "its context was destroyed before the encoder gave it");
				c.inflight.clear();
				this.#drop(c, "its context was destroyed");
			};
			enc.flush().then(done, done);
			return;
		}
		this.#drop(c, "its context was destroyed");
	}
	#drop(c, why) {
		if (c.timer) clearTimeout(c.timer);
		c.timer = null;
		this.#closeEncoder(c);
		for (const j of [...c.queue, ...c.inflight.values()]) if (this.#closed) this.#release(j);
		else this.#fail(c, j, why);
		c.queue = [];
		c.inflight.clear();
		if (this.#h.open.delete(c.info)) {
			this.#h.stats.contexts--;
			c.info.open = false;
			this.#h.closed.push(c.info);
			if (this.#h.closed.length > CLOSED_KEPT$1) this.#h.closed.shift();
		}
	}
	inject(what, count, every) {
		if (what !== "reclaim" && what !== "error" && what !== "flush") {
			if (!what) this.#injections = [];
			return;
		}
		if (every > 0) this.#injections.push({
			what,
			every,
			left: count,
			n: 0
		});
		else for (const c of this.#ctxs.values()) this.#inject(c, what);
	}
	#due() {
		const out = [];
		for (const j of this.#injections) if (j.left > 0 && ++j.n % j.every === 0) j.left--, out.push(j.what);
		if (out.length) this.#injections = this.#injections.filter((j) => j.left > 0);
		return out;
	}
	#inject(c, what) {
		const enc = c.encoder;
		if (!enc) return;
		if (what === "flush") return this.#stall(c, true);
		try {
			enc.close();
		} catch {}
		const e = /* @__PURE__ */ new Error(what === "reclaim" ? "Codec reclaimed due to inactivity (test)." : "Encoding error (test).");
		e.name = what === "reclaim" ? "QuotaExceededError" : "EncodingError";
		this.#failed(c, enc, e);
	}
};
function nalUnit(type, refIdc, rbsp) {
	const out = [refIdc << 5 | type];
	let zeros = 0;
	for (const b of rbsp) {
		if (zeros >= 2 && b <= 3) {
			out.push(3);
			zeros = 0;
		}
		out.push(b);
		zeros = b === 0 ? zeros + 1 : 0;
	}
	if (zeros) out.push(3);
	return Uint8Array.from(out);
}
function unescapeRbsp(nal, start = 1, limit = 1e400) {
	const out = [];
	let zeros = 0;
	for (let i = start; i < nal.length && out.length < limit; i++) {
		const b = nal[i];
		if (zeros >= 2 && b === 3) {
			zeros = 0;
			continue;
		}
		out.push(b);
		zeros = b === 0 ? zeros + 1 : 0;
	}
	return Uint8Array.from(out);
}
const ZIGZAG4 = [
	0,
	1,
	4,
	8,
	5,
	2,
	3,
	6,
	9,
	12,
	13,
	10,
	7,
	11,
	14,
	15
];
const ZIGZAG8 = [
	0,
	1,
	8,
	16,
	9,
	2,
	3,
	10,
	17,
	24,
	32,
	25,
	18,
	11,
	4,
	5,
	12,
	19,
	26,
	33,
	40,
	48,
	41,
	34,
	27,
	20,
	13,
	6,
	7,
	14,
	21,
	28,
	35,
	42,
	49,
	56,
	57,
	50,
	43,
	36,
	29,
	22,
	15,
	23,
	30,
	37,
	44,
	51,
	58,
	59,
	52,
	45,
	38,
	31,
	39,
	46,
	53,
	60,
	61,
	54,
	47,
	55,
	62,
	63
];
function writeScalingLists(w, lists, count) {
	for (let i = 0; i < count; i++) {
		const l = lists[i] ?? null;
		w.u(1, l ? 1 : 0);
		if (!l) continue;
		const scan = i < 6 ? ZIGZAG4 : ZIGZAG8;
		let last = 8;
		for (let j = 0; j < scan.length; j++) {
			const v = l[scan[j]];
			w.se((v - last + 128 & 255) - 128);
			last = v;
		}
	}
}
const HIGH_SPS = /* @__PURE__ */ new Set([
	100,
	110,
	122,
	244,
	44,
	83,
	86,
	118,
	128,
	138,
	139,
	134,
	135
]);
const b1 = (v) => v ? 1 : 0;
function writeSps(s) {
	const w = new BitWriter();
	w.u(8, s.profileIdc);
	w.u(8, s.constraintFlags);
	w.u(8, s.levelIdc);
	w.ue(s.spsId);
	if (HIGH_SPS.has(s.profileIdc)) {
		w.ue(s.chromaFormatIdc);
		if (s.chromaFormatIdc === 3) w.u(1, b1(s.separateColourPlane));
		w.ue(s.bitDepthLuma - 8);
		w.ue(s.bitDepthChroma - 8);
		w.u(1, b1(s.qpprimeYZeroTransformBypass));
		w.u(1, b1(!!s.scaling));
		if (s.scaling) writeScalingLists(w, s.scaling, s.chromaFormatIdc !== 3 ? 8 : 12);
	}
	w.ue(s.log2MaxFrameNum - 4);
	w.ue(s.pocType);
	if (s.pocType === 0) w.ue(s.log2MaxPocLsb - 4);
	else if (s.pocType === 1) {
		w.u(1, b1(s.deltaPicOrderAlwaysZero));
		w.se(s.offsetForNonRefPic);
		w.se(s.offsetForTopToBottomField);
		w.ue(s.offsetForRefFrame.length);
		for (const o of s.offsetForRefFrame) w.se(o);
	}
	w.ue(s.maxNumRefFrames);
	w.u(1, b1(s.gapsInFrameNumAllowed));
	w.ue(s.widthMbs - 1);
	w.ue(s.heightMapUnits - 1);
	w.u(1, b1(s.frameMbsOnly));
	if (!s.frameMbsOnly) w.u(1, b1(s.mbAdaptiveFrameField));
	w.u(1, b1(s.direct8x8Inference));
	w.u(1, b1(!!s.crop));
	if (s.crop) {
		w.ue(s.crop.left);
		w.ue(s.crop.right);
		w.ue(s.crop.top);
		w.ue(s.crop.bottom);
	}
	w.u(1, b1(!!s.vui));
	if (s.vui) {
		for (let i = 0; i < 8; i++) w.u(1, 0);
		const br = s.vui.bitstreamRestriction;
		w.u(1, b1(!!br));
		if (br) {
			w.u(1, 1);
			w.ue(0);
			w.ue(0);
			w.ue(15);
			w.ue(15);
			w.ue(br.maxNumReorderFrames);
			w.ue(br.maxDecFrameBuffering);
		}
	}
	w.trailing();
	return w.bytes();
}
function writePps(p, chromaFormatIdc = 1) {
	const w = new BitWriter();
	w.ue(p.ppsId);
	w.ue(p.spsId);
	w.u(1, b1(p.entropyCodingMode));
	w.u(1, b1(p.bottomFieldPicOrderInFramePresent));
	w.ue(0);
	w.ue(p.numRefIdxL0Default - 1);
	w.ue(p.numRefIdxL1Default - 1);
	w.u(1, b1(p.weightedPred));
	w.u(2, p.weightedBipredIdc);
	w.se(p.picInitQp - 26);
	w.se(p.picInitQs - 26);
	w.se(p.chromaQpIndexOffset);
	w.u(1, b1(p.deblockingFilterControlPresent));
	w.u(1, b1(p.constrainedIntraPred));
	w.u(1, b1(p.redundantPicCntPresent));
	if (p.extended) {
		w.u(1, b1(p.transform8x8Mode));
		w.u(1, b1(!!p.scaling));
		if (p.scaling) writeScalingLists(w, p.scaling, 6 + (chromaFormatIdc !== 3 ? 2 : 6) * b1(p.transform8x8Mode));
		w.se(p.secondChromaQpIndexOffset);
	}
	w.trailing();
	return w.bytes();
}
function avcCodecString(s) {
	const h = (v) => v.toString(16).toUpperCase().padStart(2, "0");
	return `avc1.${h(s.profileIdc)}${h(s.constraintFlags)}${h(s.levelIdc)}`;
}
function parseSliceHeader(nal, ctx, full) {
	if (!nal.length || nal[0] & 128) throw new Error("not a NAL unit (forbidden_zero_bit)");
	const nalType = nal[0] & 31, refIdc = nal[0] >> 5 & 3;
	if (nalType !== 1 && nalType !== 5) {
		const what = nalType >= 2 && nalType <= 4 ? "data partitioning (Extended profile)" : nalType === 20 || nalType === 21 ? "MVC/3D slices" : `NAL unit type ${nalType}`;
		throw new Error(`${what} is not supported`);
	}
	const r = new BitReader(unescapeRbsp(nal, 1, 4096));
	const firstMb = r.ue(), rawType = r.ue(), ppsId = r.ue();
	if (rawType > 9) throw new Error(`a bad slice_type ${rawType}`);
	if (ppsId > 255) throw new Error(`a bad pic_parameter_set_id ${ppsId}`);
	const s = {
		nalType,
		refIdc,
		firstMb,
		sliceType: rawType % 5,
		ppsId
	};
	if (!ctx) return s;
	if (ctx.separateColourPlane) r.u(2);
	s.frameNum = r.u(ctx.log2MaxFrameNum);
	s.fieldPic = false;
	if (!ctx.frameMbsOnly && (s.fieldPic = !!r.u(1))) s.bottomField = !!r.u(1);
	if (nalType === 5) s.idrPicId = r.ue();
	if (ctx.pocType === 0) {
		s.pocLsb = r.u(ctx.log2MaxPocLsb);
		if (ctx.bottomFieldPicOrderInFramePresent && !s.fieldPic) r.se();
	} else if (ctx.pocType === 1 && !ctx.deltaPicOrderAlwaysZero) {
		r.se();
		if (ctx.bottomFieldPicOrderInFramePresent && !s.fieldPic) r.se();
	}
	if (ctx.redundantPicCntPresent) r.ue();
	const st = s.sliceType, isB = st === 1, isP = st === 0 || st === 3;
	if (isB) s.directSpatial = !!r.u(1);
	s.override = false;
	if (isP || isB) {
		if (s.override = !!r.u(1)) {
			s.numRefIdxL0 = r.ue() + 1;
			if (isB) s.numRefIdxL1 = r.ue() + 1;
		}
	}
	if (!full) return s;
	const l0 = s.numRefIdxL0 ?? full.counts[0], l1 = s.numRefIdxL1 ?? full.counts[1];
	const mod = () => {
		if (!r.u(1)) return;
		for (let n = 0;; n++) {
			const idc = r.ue();
			if (idc === 3) break;
			if (idc > 5 || n > 100) throw new Error(`a bad modification_of_pic_nums_idc ${idc}`);
			r.ue();
		}
	};
	if (st !== 2 && st !== 4) mod();
	if (isB) mod();
	if (ctx.weightedPred && isP || ctx.weightedBipredIdc === 1 && isB) {
		r.ue();
		if (ctx.chromaArrayType) r.ue();
		for (let list = 0; list < (isB ? 2 : 1); list++) for (let i = 0; i < (list ? l1 : l0); i++) {
			if (r.u(1)) r.se(), r.se();
			if (ctx.chromaArrayType && r.u(1)) r.se(), r.se(), r.se(), r.se();
		}
	}
	s.mmco5 = false;
	if (refIdc) {
		if (nalType === 5) {
			s.noOutputOfPriorPics = !!r.u(1);
			r.u(1);
		} else if (r.u(1)) for (let n = 0;; n++) {
			const op = r.ue();
			if (op === 0) break;
			if (op > 6 || n > 100) throw new Error(`a bad memory_management_control_operation ${op}`);
			if (op === 5) s.mmco5 = true;
			if (op === 1 || op === 3) r.ue();
			if (op === 2) r.ue();
			if (op === 3 || op === 6) r.ue();
			if (op === 4) r.ue();
		}
	}
	return s;
}
function vaPic(dv, o) {
	return {
		surface: dv.getUint32(o, true),
		frameIdx: dv.getUint32(o + 4, true),
		flags: dv.getUint32(o + 8, true),
		top: dv.getInt32(o + 12, true),
		bottom: dv.getInt32(o + 16, true)
	};
}
function parseVaH264PicParams(d) {
	if (d.length < 640) throw new Error(`picture parameters of ${d.length} bytes (VAPictureParameterBufferH264 is 672)`);
	const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
	const seq = dv.getUint32(620, true), pic = dv.getUint32(632, true);
	const bits = (v, at, n) => v >>> at & (1 << n) - 1;
	return {
		curr: vaPic(dv, 0),
		refs: Array.from({ length: 16 }, (_, i) => vaPic(dv, 36 + 36 * i)),
		widthMbs: dv.getUint16(612, true) + 1,
		heightMbs: dv.getUint16(614, true) + 1,
		bitDepthLuma: d[616] + 8,
		bitDepthChroma: d[617] + 8,
		numRefFrames: d[618],
		chromaFormatIdc: bits(seq, 0, 2),
		separateColourPlane: !!bits(seq, 2, 1),
		gapsInFrameNumAllowed: !!bits(seq, 3, 1),
		frameMbsOnly: !!bits(seq, 4, 1),
		mbAdaptiveFrameField: !!bits(seq, 5, 1),
		direct8x8Inference: !!bits(seq, 6, 1),
		minLumaBiPred8x8: !!bits(seq, 7, 1),
		log2MaxFrameNum: bits(seq, 8, 4) + 4,
		pocType: bits(seq, 12, 2),
		log2MaxPocLsb: bits(seq, 14, 4) + 4,
		deltaPicOrderAlwaysZero: !!bits(seq, 18, 1),
		numSliceGroups: d[624] + 1,
		picInitQp: dv.getInt8(628) + 26,
		picInitQs: dv.getInt8(629) + 26,
		chromaQpIndexOffset: dv.getInt8(630),
		secondChromaQpIndexOffset: dv.getInt8(631),
		entropyCodingMode: !!bits(pic, 0, 1),
		weightedPred: !!bits(pic, 1, 1),
		weightedBipredIdc: bits(pic, 2, 2),
		transform8x8Mode: !!bits(pic, 4, 1),
		fieldPic: !!bits(pic, 5, 1),
		constrainedIntraPred: !!bits(pic, 6, 1),
		bottomFieldPicOrderInFramePresent: !!bits(pic, 7, 1),
		deblockingFilterControlPresent: !!bits(pic, 8, 1),
		redundantPicCntPresent: !!bits(pic, 9, 1),
		referencePic: !!bits(pic, 10, 1),
		frameNum: dv.getUint16(636, true)
	};
}
function parseVaH264Iq(d) {
	if (!d || d.length < 224) return null;
	const lists = [];
	for (let i = 0; i < 6; i++) lists.push([...d.subarray(16 * i, 16 * i + 16)]);
	for (let i = 0; i < 2; i++) lists.push([...d.subarray(96 + 64 * i, 96 + 64 * i + 64)]);
	if (lists.every((l) => l.every((v) => v === 16)) || lists.some((l) => l.some((v) => v === 0))) return null;
	return lists;
}
function vaH264Slices(p) {
	const out = [];
	let params = null;
	for (const b of p.bufs) if (b.type === VA_BUF.sliceParameter) {
		if (b.size < 28) throw new Error(`slice parameters of ${b.size} bytes`);
		params = b;
	} else if (b.type === VA_BUF.sliceData) {
		if (!params) throw new Error("slice data without slice parameters");
		const dv = new DataView(params.data.buffer, params.data.byteOffset, params.data.byteLength);
		let total = 0;
		for (let i = 0; i < params.num; i++) {
			const o = i * params.size, size = dv.getUint32(o, true), off = dv.getUint32(o + 4, true);
			if (off + size > b.data.length) throw new Error(`slice ${out.length}: bytes ${off} to ${off + size} of a slice data buffer of ${b.data.length}`);
			if ((total += size) > b.data.length) throw new Error(`slices of more bytes than their slice data buffer's ${b.data.length}`);
			let nal = b.data.subarray(off, off + size);
			if (nal.length > 3 && nal[0] === 0 && nal[1] === 0 && (nal[2] === 1 || nal[2] === 0 && nal[3] === 1)) nal = nal.subarray(nal[2] === 1 ? 3 : 4);
			out.push({
				firstMb: dv.getUint16(o + 14, true),
				sliceType: params.data[o + 16] % 5,
				numRefIdxL0: params.data[o + 18] + 1,
				numRefIdxL1: params.data[o + 19] + 1,
				nal
			});
		}
		params = null;
	}
	return out;
}
const DPB = 16;
var OutputModel = class OutputModel {
	delayed = [];
	#next = -1e400;
	#lastPocs = new Array(DPB).fill(-1e400);
	#hasB = 0;
	clone() {
		const m = new OutputModel();
		m.delayed = this.delayed.slice();
		m.#next = this.#next;
		m.#lastPocs = this.#lastPocs.slice();
		m.#hasB = this.#hasB;
		return m;
	}
	push(p, reorder) {
		const cur = { ...p };
		this.#hasB = Math.max(this.#hasB, reorder);
		const lp = this.#lastPocs;
		let i = 0;
		for (;; i++) if (i === DPB || cur.poc < lp[i]) {
			if (i) lp[i - 1] = cur.poc;
			break;
		} else if (i) lp[i - 1] = lp[i];
		if (i === 0) {
			lp.fill(-1e400);
			lp[0] = cur.poc;
			cur.mmco = true;
		}
		const d = this.delayed;
		d.push(cur);
		const pics = d.length;
		let out = d[0], idx = 0;
		for (let j = 1; j < d.length && !d[j].key && !d[j].mmco; j++) if (d[j].poc < out.poc) {
			out = d[j];
			idx = j;
		}
		if (this.#hasB === 0 && (d[0].key || d[0].mmco)) this.#next = -1e400;
		const ooo = out.poc < this.#next;
		if (ooo || pics > this.#hasB) d.splice(idx, 1);
		if (!ooo && pics > this.#hasB) {
			this.#next = idx === 0 && d[0] && (d[0].key || d[0].mmco) ? -1e400 : out.poc;
			return {
				out,
				dropped: null
			};
		}
		return {
			out: null,
			dropped: ooo ? out : null
		};
	}
	held(pic) {
		return this.delayed.some((p) => p.pic === pic);
	}
};
function leastReorder(pics, from = 0) {
	for (let r = from; r < DPB; r++) {
		const m = new OutputModel();
		if (pics.every((p) => !m.push(p, r).dropped)) return r;
	}
	return DPB;
}
const LEVELS = [
	[
		30,
		1620,
		8100
	],
	[
		31,
		3600,
		18e3
	],
	[
		32,
		5120,
		20480
	],
	[
		40,
		8192,
		32768
	],
	[
		41,
		8192,
		32768
	],
	[
		42,
		8704,
		34816
	],
	[
		50,
		22080,
		110400
	],
	[
		51,
		36864,
		184320
	],
	[
		52,
		36864,
		184320
	],
	[
		60,
		139264,
		696320
	],
	[
		61,
		139264,
		696320
	],
	[
		62,
		139264,
		696320
	]
];
function pickLevel(wMbs, hMbs, frames, min31 = false) {
	const fs = wMbs * hMbs;
	for (const [level, maxFs, maxDpbMbs] of LEVELS) {
		if (min31 && level < 31) continue;
		if (fs > maxFs || wMbs * wMbs > 8 * maxFs || hMbs * hMbs > 8 * maxFs) continue;
		const dpb = Math.min(DPB, Math.floor(maxDpbMbs / fs));
		if (dpb >= frames) return {
			level,
			dpb
		};
	}
	return {
		level: 62,
		dpb: DPB
	};
}
const PROFILES = {
	cb: {
		idc: 66,
		flags: 192
	},
	main: {
		idc: 77,
		flags: 64
	},
	high: {
		idc: 100,
		flags: 0
	}
};
function concatAll(parts) {
	let n = 0;
	for (const p of parts) n += p.length;
	const out = new Uint8Array(n);
	n = 0;
	for (const p of parts) out.set(p, n), n += p.length;
	return out;
}
const START$1 = new Uint8Array([
	0,
	0,
	0,
	1
]);
function annexB$1(units) {
	return concatAll(units.flatMap((u) => [START$1, u]));
}
function lengthPrefixed(units) {
	return concatAll(units.flatMap((u) => [Uint8Array.of(u.length >>> 24, u.length >> 16 & 255, u.length >> 8 & 255, u.length & 255), u]));
}
function avcC(sps, pps) {
	const out = [
		1,
		sps[1],
		sps[2],
		sps[3],
		255,
		225,
		sps.length >> 8,
		sps.length & 255,
		...sps,
		1,
		pps.length >> 8,
		pps.length & 255,
		...pps
	];
	if (HIGH_SPS.has(sps[1])) out.push(253, 248, 248, 0);
	return Uint8Array.from(out);
}
const VARIANTS = [
	"annexb",
	"avcc",
	"annexb-novui"
];
function h264Adapter(vaProfile, log, initial = "model", holdExtra = 0) {
	let profileIdc = PROFILES[vaProfile].idc;
	let reorder = 0, raises = 0, variant = 0;
	let mode = initial;
	let period = [];
	let periodIndex = 0;
	let periodReorder = 0, periodFrom = 0;
	let model = new OutputModel();
	let lastConfig = null;
	let config = null;
	let lastPp = null;
	let lastRef = null;
	let oddPoc = false;
	let fillerPps = -1;
	const defaults = /* @__PURE__ */ new Map();
	const warned = /* @__PURE__ */ new Set();
	const warn = (m) => {
		if (!warned.has(m)) warned.add(m), log?.(`[host] va: H.264: ${m}`);
	};
	const vui = () => VARIANTS[variant] !== "annexb-novui";
	const pack = (units) => VARIANTS[variant] === "avcc" ? lengthPrefixed(units) : annexB$1(units);
	const orderOf = (poc) => periodIndex * 2 ** 24 + Math.max(-(2 ** 23), Math.min(2 ** 23 - 1, poc)) + 2 ** 23;
	const spsOf = (pp) => {
		const heightMapUnits = pp.frameMbsOnly ? pp.heightMbs : pp.heightMbs >> 1;
		const declared = Math.min(DPB, reorder + holdExtra), frames = Math.max(pp.numRefFrames, declared, 1);
		const { level, dpb } = pickLevel(pp.widthMbs, pp.heightMbs, frames, pp.minLumaBiPred8x8);
		const flags = profileIdc === 66 ? 192 : profileIdc === 77 ? 64 : 0;
		const maxDecFrameBuffering = mode === "conservative" ? frames : dpb;
		return {
			profileIdc,
			constraintFlags: flags,
			levelIdc: level,
			spsId: 0,
			chromaFormatIdc: 1,
			separateColourPlane: false,
			bitDepthLuma: 8,
			bitDepthChroma: 8,
			qpprimeYZeroTransformBypass: false,
			scaling: null,
			log2MaxFrameNum: pp.log2MaxFrameNum,
			pocType: pp.pocType,
			log2MaxPocLsb: pp.log2MaxPocLsb,
			deltaPicOrderAlwaysZero: pp.deltaPicOrderAlwaysZero,
			offsetForNonRefPic: 0,
			offsetForTopToBottomField: 0,
			offsetForRefFrame: [],
			maxNumRefFrames: pp.numRefFrames,
			gapsInFrameNumAllowed: pp.gapsInFrameNumAllowed,
			widthMbs: pp.widthMbs,
			heightMapUnits,
			frameMbsOnly: pp.frameMbsOnly,
			mbAdaptiveFrameField: pp.mbAdaptiveFrameField,
			direct8x8Inference: pp.direct8x8Inference,
			crop: null,
			vui: vui() ? { bitstreamRestriction: {
				maxNumReorderFrames: declared,
				maxDecFrameBuffering
			} } : null
		};
	};
	const remodel = (upto = period.length) => {
		model = new OutputModel();
		for (const q of period.slice(0, upto)) model.push(q, reorder);
	};
	const makeConfig = (pp, ppsNal) => {
		const spsNal = nalUnit(7, 3, writeSps(spsOf(pp)));
		const codec = avcCodecString(spsOf(pp));
		return VARIANTS[variant] === "avcc" ? {
			codec,
			description: avcC(spsNal, ppsNal)
		} : { codec };
	};
	let lastPpsNal = null;
	return {
		config: () => lastPp && lastPpsNal ? makeConfig(lastPp, lastPpsNal) : config,
		held: (pic) => mode === "model" && model.held(pic),
		mode: () => mode,
		reset() {
			remodel();
		},
		state: () => ({
			reorder,
			profileIdc,
			raises,
			mode,
			packaging: VARIANTS[variant]
		}),
		info: () => ({
			reorder,
			profileIdc,
			packaging: VARIANTS[variant],
			raises
		}),
		variants: VARIANTS.length,
		variant(i) {
			variant = i;
			if (!vui() && mode === "model") {
				mode = "conservative";
				warn("decoded without the VUI: conservative mode");
			}
		},
		probe(i) {
			const sps = nalUnit(7, 3, writeSps({
				profileIdc: PROFILES[vaProfile].idc,
				constraintFlags: PROFILES[vaProfile].flags,
				levelIdc: 40,
				spsId: 0,
				chromaFormatIdc: 1,
				separateColourPlane: false,
				bitDepthLuma: 8,
				bitDepthChroma: 8,
				qpprimeYZeroTransformBypass: false,
				scaling: null,
				log2MaxFrameNum: 4,
				pocType: 0,
				log2MaxPocLsb: 6,
				deltaPicOrderAlwaysZero: false,
				offsetForNonRefPic: 0,
				offsetForTopToBottomField: 0,
				offsetForRefFrame: [],
				maxNumRefFrames: 4,
				gapsInFrameNumAllowed: false,
				widthMbs: 120,
				heightMapUnits: 68,
				frameMbsOnly: true,
				mbAdaptiveFrameField: false,
				direct8x8Inference: true,
				crop: null,
				vui: VARIANTS[i] === "annexb-novui" ? null : { bitstreamRestriction: {
					maxNumReorderFrames: 2,
					maxDecFrameBuffering: 4
				} }
			}));
			const pps = nalUnit(8, 3, writePps({
				ppsId: 0,
				spsId: 0,
				entropyCodingMode: vaProfile !== "cb",
				bottomFieldPicOrderInFramePresent: false,
				numRefIdxL0Default: 1,
				numRefIdxL1Default: 1,
				weightedPred: false,
				weightedBipredIdc: 0,
				picInitQp: 26,
				picInitQs: 26,
				chromaQpIndexOffset: 0,
				deblockingFilterControlPresent: true,
				constrainedIntraPred: false,
				redundantPicCntPresent: false,
				extended: false,
				transform8x8Mode: false,
				scaling: null,
				secondChromaQpIndexOffset: 0
			}));
			const codec = avcCodecString({
				profileIdc: PROFILES[vaProfile].idc,
				constraintFlags: PROFILES[vaProfile].flags,
				levelIdc: 40
			});
			return VARIANTS[i] === "avcc" ? {
				codec,
				description: avcC(sps, pps)
			} : { codec };
		},
		conservative(why) {
			if (mode === "conservative") return false;
			mode = "conservative";
			const r = periodReorder;
			log?.(`[host] va: H.264: conservative mode (${why}): max_num_reorder_frames ${reorder} -> ${r} (the stream's own), max_dec_frame_buffering the least the SPS allows`);
			reorder = r;
			remodel();
			return true;
		},
		dropped(pics) {
			if (!vui() || reorder >= DPB) return false;
			const r = Math.min(DPB, Math.max(reorder + 1, periodReorder));
			log?.(`[host] va: H.264: the decoder dropped ${pics.length} picture(s): max_num_reorder_frames ${reorder} -> ${r}`);
			reorder = r;
			raises++;
			remodel();
			return true;
		},
		filler(pic, given) {
			if (given) return null;
			const pp = lastPp;
			if (mode !== "conservative" || !pp || !pp.frameMbsOnly || !lastRef || pp.numRefFrames < 1 || pp.pocType === 0 && oddPoc || pp.pocType === 1) return null;
			const x = period.find((q) => q.pic === pic);
			if (!x) return null;
			const target = pp.pocType === 2 ? lastRef.poc + 1 : x.poc + 1;
			if (target <= x.poc) return null;
			const max = 2 ** pp.log2MaxPocLsb, lsb = (target % max + max) % max;
			let msb = lastRef.msb;
			if (lsb < lastRef.lsb && lastRef.lsb - lsb >= max / 2) msb += max;
			else if (lsb > lastRef.lsb && lsb - lastRef.lsb > max / 2) msb -= max;
			if (pp.pocType === 0 && msb + lsb !== target) return null;
			if (fillerPps < 0) {
				for (let id = 255; id >= 0 && fillerPps < 0; id--) if (!defaults.has(id)) fillerPps = id;
				if (fillerPps < 0) return null;
			}
			const ppsNal = nalUnit(8, 3, writePps({
				ppsId: fillerPps,
				spsId: 0,
				entropyCodingMode: false,
				bottomFieldPicOrderInFramePresent: false,
				numRefIdxL0Default: 1,
				numRefIdxL1Default: 1,
				weightedPred: false,
				weightedBipredIdc: 0,
				picInitQp: 26,
				picInitQs: 26,
				chromaQpIndexOffset: 0,
				deblockingFilterControlPresent: true,
				constrainedIntraPred: false,
				redundantPicCntPresent: false,
				extended: false,
				transform8x8Mode: false,
				scaling: null,
				secondChromaQpIndexOffset: 0
			}));
			const w = new BitWriter();
			w.ue(0);
			w.ue(0);
			w.ue(fillerPps);
			w.u(pp.log2MaxFrameNum, (lastRef.frameNum + 1) % 2 ** pp.log2MaxFrameNum);
			if (pp.pocType === 0) w.u(pp.log2MaxPocLsb, lsb);
			w.u(1, 0);
			w.u(1, 0);
			w.se(0);
			w.ue(1);
			w.ue(pp.widthMbs * pp.heightMbs);
			w.trailing();
			return {
				data: pack([ppsNal, nalUnit(1, 0, w.bytes())]),
				key: false,
				output: false,
				added: true,
				order: orderOf(target)
			};
		},
		picture(p) {
			const pb = p.bufs.find((b) => b.type === VA_BUF.picture);
			if (!pb) throw new Error("no picture parameters");
			const pp = parseVaH264PicParams(pb.data);
			if (pp.fieldPic) throw new Error("field pictures (PAFF interlacing) are not supported");
			if (pp.chromaFormatIdc !== 1) throw new Error(`chroma_format_idc ${pp.chromaFormatIdc} (only 4:2:0 is supported)`);
			if (pp.bitDepthLuma !== 8 || pp.bitDepthChroma !== 8) throw new Error(`a bit depth of ${pp.bitDepthLuma}/${pp.bitDepthChroma} (only 8 is supported)`);
			if (pp.numSliceGroups > 1) throw new Error("slice groups (FMO) are not supported");
			if (pp.pocType === 1) throw new Error("pic_order_cnt_type 1 is not supported (VA does not carry its offsets)");
			if (pp.pocType > 2) throw new Error(`a bad pic_order_cnt_type ${pp.pocType}`);
			if (!pp.frameMbsOnly && pp.heightMbs < 2) throw new Error(`a frame of ${pp.heightMbs} MB row(s) without frame_mbs_only`);
			const iq = parseVaH264Iq(p.bufs.find((b) => b.type === VA_BUF.iqMatrix)?.data ?? null);
			const slices = vaH264Slices(p);
			if (!slices.length) throw new Error("no slices");
			const ctx = {
				...pp,
				chromaArrayType: 1
			};
			let first = null;
			let l0 = null, l1 = null, anyB = false;
			for (const sl of slices) {
				const h = parseSliceHeader(sl.nal, ctx, first ? void 0 : { counts: [sl.numRefIdxL0, sl.numRefIdxL1] });
				if (h.firstMb !== sl.firstMb || h.sliceType !== sl.sliceType) throw new Error(`slice header (first_mb ${h.firstMb}, slice_type ${h.sliceType}) and VA's slice parameters (${sl.firstMb}, ${sl.sliceType}) differ`);
				if (first && (h.ppsId !== first.ppsId || h.nalType !== first.nalType)) throw new Error("slices of one picture with different PPS ids or NAL unit types");
				first ??= h;
				if (h.frameNum !== pp.frameNum) throw new Error(`frame_num ${h.frameNum} in the slice header, ${pp.frameNum} in VA's picture parameters`);
				const isB = h.sliceType === 1, isP = h.sliceType === 0 || h.sliceType === 3;
				anyB ||= isB;
				if ((isP || isB) && !h.override) {
					if (l0 !== null && l0 !== sl.numRefIdxL0) throw new Error("slices disagree on the default reference count");
					l0 = sl.numRefIdxL0;
					if (isB) l1 = sl.numRefIdxL1;
				}
			}
			const f = first;
			const idr = f.nalType === 5;
			if (f.ppsId === fillerPps) fillerPps = -1;
			const known = defaults.get(f.ppsId) ?? [1, 1];
			const dflt = [l0 ?? known[0], l1 ?? known[1]];
			defaults.set(f.ppsId, dflt);
			const needHigh = pp.transform8x8Mode || !!iq || pp.secondChromaQpIndexOffset !== pp.chromaQpIndexOffset;
			const needMain = pp.entropyCodingMode || pp.weightedPred || pp.weightedBipredIdc !== 0 || anyB || !pp.frameMbsOnly;
			const need = needHigh ? 100 : needMain ? 77 : 66;
			let restart = false;
			if (need > profileIdc) {
				warn(`the stream uses ${need === 100 ? "High" : "Main"} profile tools in a ${vaProfile} context: decoded as ${need === 100 ? "High" : "Main"}`);
				profileIdc = need;
				restart = !idr;
			}
			const poc = Math.min(pp.curr.top, pp.curr.bottom);
			if (idr || f.mmco5) periodIndex++;
			const mp = {
				pic: p.pic,
				poc: f.mmco5 && !idr ? 0 : poc,
				key: idr,
				mmco: !!f.mmco5,
				order: 0
			};
			mp.order = orderOf(mp.poc);
			if (pp.curr.top % 2 || pp.curr.bottom % 2) oddPoc = true;
			if (idr) period = [], periodReorder = 0;
			period.push(mp);
			if (mp.key || mp.mmco) periodFrom = period.length - 1;
			for (let j = periodFrom, n = 0; j < period.length - 1; j++) if (period[j].poc > mp.poc && ++n > periodReorder) periodReorder = n;
			const r = mode === "model" ? model.clone().push(mp, reorder).dropped ? leastReorder(period, reorder + 1) : reorder : Math.max(reorder, periodReorder);
			if (r > reorder && vui()) {
				log?.(`[host] va: H.264: max_num_reorder_frames ${reorder} -> ${r} (picture POC ${mp.poc} would have come out ${mode === "model" ? "of order" : "late"}); the decoder is made again with the stream since the IDR`);
				reorder = r;
				raises++;
				restart = !idr;
			}
			if (restart) remodel(period.length - 1);
			model.push(mp, reorder);
			if (pp.referencePic || idr) lastRef = f.mmco5 ? null : {
				frameNum: idr ? 0 : pp.frameNum,
				msb: pp.curr.top - (f.pocLsb ?? 0),
				lsb: f.pocLsb ?? 0,
				poc
			};
			lastPp = pp;
			const ppsNal = nalUnit(8, 3, writePps({
				ppsId: f.ppsId,
				spsId: 0,
				entropyCodingMode: pp.entropyCodingMode,
				bottomFieldPicOrderInFramePresent: pp.bottomFieldPicOrderInFramePresent,
				numRefIdxL0Default: dflt[0],
				numRefIdxL1Default: dflt[1],
				weightedPred: pp.weightedPred,
				weightedBipredIdc: pp.weightedBipredIdc,
				picInitQp: pp.picInitQp,
				picInitQs: pp.picInitQs,
				chromaQpIndexOffset: pp.chromaQpIndexOffset,
				deblockingFilterControlPresent: pp.deblockingFilterControlPresent,
				constrainedIntraPred: pp.constrainedIntraPred,
				redundantPicCntPresent: pp.redundantPicCntPresent,
				extended: needHigh,
				transform8x8Mode: pp.transform8x8Mode,
				scaling: iq,
				secondChromaQpIndexOffset: pp.secondChromaQpIndexOffset
			}));
			lastPpsNal = ppsNal;
			const nals = slices.map((s) => s.nal);
			const build = () => pack([
				nalUnit(7, 3, writeSps(spsOf(pp))),
				ppsNal,
				...nals
			]);
			const data = build();
			for (let i = nals.length - 1, at = data.length; i >= 0; i--) nals[i] = data.subarray(at - nals[i].length, at), at -= nals[i].length + 4;
			config = makeConfig(pp, ppsNal);
			const cfgKey = `${config.codec} ${pp.widthMbs}x${pp.heightMbs}`;
			const reconfigure = idr && lastConfig !== null && lastConfig !== cfgKey;
			if (idr) lastConfig = cfgKey;
			return [{
				data,
				key: idr,
				output: true,
				order: mp.order,
				...reconfigure ? { reconfigure } : {},
				...restart ? { restart } : {},
				remake: build
			}];
		}
	};
}
const INVALID = 1;
const LONG_TERM = 8;
const ST_CURR_BEFORE = 16;
const ST_CURR_AFTER = 32;
function parseVaHevcPicParams(d) {
	if (d.length < 572) throw new Error(`picture parameters of ${d.length} bytes (VAPictureParameterBufferHEVC is 604)`);
	const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
	const u8 = (o) => d[o], s8 = (o) => dv.getInt8(o), u16 = (o) => dv.getUint16(o, true), u32 = (o) => dv.getUint32(o, true);
	const bit = (v, at, n = 1) => v >>> at & (1 << n) - 1;
	const pf = u32(452), sp = u32(556);
	const tiles = !!bit(pf, 14);
	if (tiles && (u8(474) > 19 || u8(475) > 21)) throw new Error(`a bad tile layout of ${u8(474) + 1}x${u8(475) + 1}`);
	return {
		poc: dv.getInt32(4, true),
		refs: Array.from({ length: 15 }, (_, i) => ({
			surface: u32(28 + 28 * i),
			poc: dv.getInt32(28 + 28 * i + 4, true),
			flags: u32(28 + 28 * i + 8)
		})).filter((r) => !(r.flags & INVALID) && r.surface !== 4294967295),
		width: u16(448),
		height: u16(450),
		chromaFormatIdc: bit(pf, 0, 2),
		separateColourPlane: !!bit(pf, 2),
		pcm: !!bit(pf, 3),
		scalingList: !!bit(pf, 4),
		transformSkip: !!bit(pf, 5),
		amp: !!bit(pf, 6),
		strongIntraSmoothing: !!bit(pf, 7),
		signDataHiding: !!bit(pf, 8),
		constrainedIntraPred: !!bit(pf, 9),
		cuQpDelta: !!bit(pf, 10),
		weightedPred: !!bit(pf, 11),
		weightedBipred: !!bit(pf, 12),
		transquantBypass: !!bit(pf, 13),
		tiles,
		entropyCodingSync: !!bit(pf, 15),
		loopFilterAcrossSlices: !!bit(pf, 16),
		loopFilterAcrossTiles: !!bit(pf, 17),
		pcmLoopFilterDisabled: !!bit(pf, 18),
		maxDecPicBufferingMinus1: u8(456),
		bitDepthLuma: u8(457) + 8,
		bitDepthChroma: u8(458) + 8,
		pcmBitDepthLuma: u8(459) + 1,
		pcmBitDepthChroma: u8(460) + 1,
		log2MinCb: u8(461) + 3,
		log2DiffMaxMinCb: u8(462),
		log2MinTb: u8(463) + 2,
		log2DiffMaxMinTb: u8(464),
		log2MinPcm: u8(465) + 3,
		log2DiffMaxMinPcm: u8(466),
		maxTransformHierarchyDepthIntra: u8(467),
		maxTransformHierarchyDepthInter: u8(468),
		initQpMinus26: s8(469),
		diffCuQpDeltaDepth: u8(470),
		cbQpOffset: s8(471),
		crQpOffset: s8(472),
		log2ParallelMergeLevelMinus2: u8(473),
		tileColumns: tiles ? Array.from({ length: u8(474) + 1 }, (_, i) => u16(476 + 2 * i) + 1) : [],
		tileRows: tiles ? Array.from({ length: u8(475) + 1 }, (_, i) => u16(514 + 2 * i) + 1) : [],
		listsModification: !!bit(sp, 0),
		longTermRefs: !!bit(sp, 1),
		temporalMvp: !!bit(sp, 2),
		cabacInitPresent: !!bit(sp, 3),
		outputFlagPresent: !!bit(sp, 4),
		dependentSlices: !!bit(sp, 5),
		sliceChromaQpOffsets: !!bit(sp, 6),
		sao: !!bit(sp, 7),
		deblockingOverride: !!bit(sp, 8),
		ppsDeblockingDisabled: !!bit(sp, 9),
		sliceHeaderExtension: !!bit(sp, 10),
		idr: !!bit(sp, 12),
		log2MaxPocLsb: u8(560) + 4,
		numShortTermRefPicSets: u8(561),
		numLongTermRefPicsSps: u8(562),
		numRefIdxL0Default: u8(563) + 1,
		numRefIdxL1Default: u8(564) + 1,
		betaOffsetDiv2: s8(565),
		tcOffsetDiv2: s8(566),
		numExtraSliceHeaderBits: u8(567),
		stRpsBits: u32(568)
	};
}
function parseVaHevcIq(d) {
	if (d.length < 1e3) throw new Error(`an IQ matrix of ${d.length} bytes`);
	const l = (o, n, k) => Array.from({ length: k }, (_, i) => [...d.subarray(o + n * i, o + n * i + n)]);
	return {
		lists: [
			l(0, 16, 6),
			l(96, 64, 6),
			l(480, 64, 6),
			l(864, 64, 2)
		],
		dc16: [...d.subarray(992, 998)],
		dc32: [...d.subarray(998, 1e3)]
	};
}
function vaHevcSlices(p) {
	const out = [];
	let params = null;
	for (const b of p.bufs) if (b.type === VA_BUF.sliceParameter) {
		if (b.size < 20) throw new Error(`slice parameters of ${b.size} bytes`);
		params = b;
	} else if (b.type === VA_BUF.sliceData) {
		if (!params) throw new Error("slice data without slice parameters");
		const dv = new DataView(params.data.buffer, params.data.byteOffset, params.data.byteLength);
		let total = 0;
		for (let i = 0; i < params.num; i++) {
			const o = i * params.size, size = dv.getUint32(o, true), off = dv.getUint32(o + 4, true);
			if (off + size > b.data.length) throw new Error(`slice ${out.length}: bytes ${off} to ${off + size} of a slice data buffer of ${b.data.length}`);
			if ((total += size) > b.data.length) throw new Error(`slices of more bytes than their slice data buffer's ${b.data.length}`);
			let nal = b.data.subarray(off, off + size);
			if (nal.length > 3 && nal[0] === 0 && nal[1] === 0 && (nal[2] === 1 || nal[2] === 0 && nal[3] === 1)) nal = nal.subarray(nal[2] === 1 ? 3 : 4);
			out.push(nal);
		}
		params = null;
	}
	return out;
}
function escapeRbsp(rbsp) {
	const out = [];
	let zeros = 0;
	for (const b of rbsp) {
		if (zeros >= 2 && b <= 3) {
			out.push(3);
			zeros = 0;
		}
		out.push(b);
		zeros = b === 0 ? zeros + 1 : 0;
	}
	if (zeros) out.push(3);
	return Uint8Array.from(out);
}
function hevcNal(type, rbsp) {
	const e = escapeRbsp(rbsp), out = new Uint8Array(2 + e.length);
	out[0] = type << 1;
	out[1] = 1;
	out.set(e, 2);
	return out;
}
function unescapeMap(nal, limit = 1e400) {
	const rbsp = [], at = [];
	let zeros = 0, i = 2;
	for (; i < nal.length && rbsp.length < limit; i++) {
		const b = nal[i];
		if (zeros >= 2 && b === 3) {
			zeros = 0;
			continue;
		}
		rbsp.push(b);
		at.push(i);
		zeros = b === 0 ? zeros + 1 : 0;
	}
	if (i < nal.length && zeros >= 2 && nal[i] === 3) i++;
	at.push(i);
	return {
		rbsp: Uint8Array.from(rbsp),
		at
	};
}
const SLICE_HEADER_MAX = 262144;
function hevcLevel(w, h) {
	const ps = w * h;
	return ps <= 552960 ? 90 : ps <= 983040 ? 93 : ps <= 2228224 ? 120 : ps <= 8912896 ? 150 : 180;
}
function profileTierLevel(w, level) {
	w.u(2, 0);
	w.u(1, 0);
	w.u(5, 1);
	w.u(32, 1610612736);
	w.u(1, 1);
	w.u(1, 0);
	w.u(1, 0);
	w.u(1, 1);
	w.u(32, 0);
	w.u(12, 0);
	w.u(8, level);
	for (let i = 0; i < 6; i++) w.u(2, 0);
	for (let i = 6; i < 8; i++) w.u(2, 0);
}
function writeVps(s) {
	const w = new BitWriter();
	w.u(4, 0);
	w.u(1, 1);
	w.u(1, 1);
	w.u(6, 0);
	w.u(3, 6);
	w.u(1, 0);
	w.u(16, 65535);
	profileTierLevel(w, s.level);
	w.u(1, 0);
	w.ue(s.pp.maxDecPicBufferingMinus1);
	w.ue(Math.min(s.reorder, s.pp.maxDecPicBufferingMinus1));
	w.ue(0);
	w.u(6, 0);
	w.ue(0);
	w.u(1, 0);
	w.u(1, 0);
	w.trailing();
	return w.bytes();
}
function diagScan(blk) {
	const out = [];
	let x = 0, y = 0;
	while (out.length < blk * blk) {
		while (y >= 0) {
			if (x < blk && y < blk) out.push(y * blk + x);
			y--;
			x++;
		}
		y = x;
		x = 0;
	}
	return out;
}
const DIAG4 = diagScan(4);
const DIAG8 = diagScan(8);
function writeScalingListData(w, s) {
	for (let sizeId = 0; sizeId < 4; sizeId++) for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
		w.u(1, 1);
		const list = s.lists[sizeId][sizeId === 3 ? matrixId / 3 : matrixId], scan = sizeId === 0 ? DIAG4 : DIAG8;
		let next = 8;
		if (sizeId > 1) {
			const dc = sizeId === 2 ? s.dc16[matrixId] : s.dc32[matrixId / 3];
			w.se(dc - 8);
			next = dc;
		}
		for (const pos of scan) {
			const v = list[pos];
			w.se((v - next + 128 & 255) - 128);
			next = v;
		}
	}
}
function writeHevcSps(s) {
	const pp = s.pp, w = new BitWriter();
	w.u(4, 0);
	w.u(3, 6);
	w.u(1, 0);
	profileTierLevel(w, s.level);
	w.ue(0);
	w.ue(pp.chromaFormatIdc);
	if (pp.chromaFormatIdc === 3) w.u(1, pp.separateColourPlane ? 1 : 0);
	w.ue(pp.width);
	w.ue(pp.height);
	w.u(1, 0);
	w.ue(pp.bitDepthLuma - 8);
	w.ue(pp.bitDepthChroma - 8);
	w.ue(pp.log2MaxPocLsb - 4);
	w.u(1, 0);
	w.ue(pp.maxDecPicBufferingMinus1);
	w.ue(Math.min(s.reorder, pp.maxDecPicBufferingMinus1));
	w.ue(0);
	w.ue(pp.log2MinCb - 3);
	w.ue(pp.log2DiffMaxMinCb);
	w.ue(pp.log2MinTb - 2);
	w.ue(pp.log2DiffMaxMinTb);
	w.ue(pp.maxTransformHierarchyDepthInter);
	w.ue(pp.maxTransformHierarchyDepthIntra);
	w.u(1, pp.scalingList ? 1 : 0);
	if (pp.scalingList) w.u(1, 0);
	w.u(1, pp.amp ? 1 : 0);
	w.u(1, pp.sao ? 1 : 0);
	w.u(1, pp.pcm ? 1 : 0);
	if (pp.pcm) {
		w.u(4, pp.pcmBitDepthLuma - 1);
		w.u(4, pp.pcmBitDepthChroma - 1);
		w.ue(pp.log2MinPcm - 3);
		w.ue(pp.log2DiffMaxMinPcm);
		w.u(1, pp.pcmLoopFilterDisabled ? 1 : 0);
	}
	w.ue(0);
	w.u(1, pp.longTermRefs ? 1 : 0);
	if (pp.longTermRefs) w.ue(0);
	w.u(1, pp.temporalMvp ? 1 : 0);
	w.u(1, pp.strongIntraSmoothing ? 1 : 0);
	w.u(1, 0);
	w.u(1, 0);
	w.trailing();
	return w.bytes();
}
function writeHevcPps(pp, ppsId, scaling) {
	const w = new BitWriter(), b = (v) => w.u(1, v ? 1 : 0);
	w.ue(ppsId);
	w.ue(0);
	b(pp.dependentSlices);
	b(pp.outputFlagPresent);
	w.u(3, pp.numExtraSliceHeaderBits);
	b(pp.signDataHiding);
	b(pp.cabacInitPresent);
	w.ue(pp.numRefIdxL0Default - 1);
	w.ue(pp.numRefIdxL1Default - 1);
	w.se(pp.initQpMinus26);
	b(pp.constrainedIntraPred);
	b(pp.transformSkip);
	b(pp.cuQpDelta);
	if (pp.cuQpDelta) w.ue(pp.diffCuQpDeltaDepth);
	w.se(pp.cbQpOffset);
	w.se(pp.crQpOffset);
	b(pp.sliceChromaQpOffsets);
	b(pp.weightedPred);
	b(pp.weightedBipred);
	b(pp.transquantBypass);
	b(pp.tiles);
	b(pp.entropyCodingSync);
	if (pp.tiles) {
		w.ue(pp.tileColumns.length - 1);
		w.ue(pp.tileRows.length - 1);
		w.u(1, 0);
		for (const c of pp.tileColumns.slice(0, -1)) w.ue(c - 1);
		for (const r of pp.tileRows.slice(0, -1)) w.ue(r - 1);
		b(pp.loopFilterAcrossTiles);
	}
	b(pp.loopFilterAcrossSlices);
	w.u(1, 1);
	b(pp.deblockingOverride);
	b(pp.ppsDeblockingDisabled);
	if (!pp.ppsDeblockingDisabled) {
		w.se(pp.betaOffsetDiv2);
		w.se(pp.tcOffsetDiv2);
	}
	w.u(1, scaling ? 1 : 0);
	if (scaling) writeScalingListData(w, scaling);
	b(pp.listsModification);
	w.ue(pp.log2ParallelMergeLevelMinus2);
	b(pp.sliceHeaderExtension);
	w.u(1, 0);
	w.trailing();
	return w.bytes();
}
const ceilLog2 = (n) => n <= 1 ? 0 : 32 - Math.clz32(n - 1);
function parseHevcSliceHeader(nalType, rbsp, pp, numPicTotalCurr) {
	const r = new BitReader(rbsp);
	const irap = nalType >= 16 && nalType <= 23, idr = nalType === 19 || nalType === 20;
	const first = !!r.u(1);
	if (irap) r.u(1);
	const ppsId = r.ue();
	if (ppsId > 63) throw new Error(`a bad slice_pic_parameter_set_id ${ppsId}`);
	const ctb = 1 << pp.log2MinCb + pp.log2DiffMaxMinCb, ctbs = Math.ceil(pp.width / ctb) * Math.ceil(pp.height / ctb);
	let dependent = false;
	if (!first) {
		if (pp.dependentSlices) dependent = !!r.u(1);
		r.u(ceilLog2(ctbs));
	}
	const h = {
		nalType,
		temporalId: 0,
		first,
		ppsId,
		dependent,
		sliceType: -1,
		pocLsb: 0,
		rps: [0, 0],
		lt: [0, 0],
		ltPics: [],
		end: 0,
		dataStart: 0
	};
	if (!dependent) {
		r.u(pp.numExtraSliceHeaderBits);
		h.sliceType = r.ue();
		if (h.sliceType > 2) throw new Error(`a bad slice_type ${h.sliceType}`);
		if (pp.outputFlagPresent) r.u(1);
		if (pp.separateColourPlane) r.u(2);
		let temporalMvp = false;
		if (!idr) {
			h.pocLsb = r.u(pp.log2MaxPocLsb);
			const at = r.pos;
			if (!r.u(1)) {
				if (pp.stRpsBits <= 0 && pp.numShortTermRefPicSets > 0) throw new Error("a slice's own reference picture set with no st_rps_bits from VA");
				if (pp.numShortTermRefPicSets === 0) skipStRps(r);
				else r.skip(pp.stRpsBits);
			} else if (pp.numShortTermRefPicSets > 1) r.u(ceilLog2(pp.numShortTermRefPicSets));
			h.rps = [at, r.pos];
			const lt0 = r.pos;
			if (pp.longTermRefs) {
				if (pp.numLongTermRefPicsSps > 0 ? r.ue() : 0) throw new Error("long-term pictures named by the SPS's candidates are not supported");
				const n = r.ue();
				if (n > 32) throw new Error(`a bad num_long_term_pics ${n}`);
				for (let i = 0; i < n; i++) {
					const pocLsb = r.u(pp.log2MaxPocLsb), used = !!r.u(1), msbPresent = !!r.u(1);
					h.ltPics.push({
						pocLsb,
						used,
						msbPresent,
						msbCycle: msbPresent ? r.ue() : 0
					});
				}
			}
			h.lt = [lt0, r.pos];
			if (pp.temporalMvp) temporalMvp = !!r.u(1);
		}
		let saoLuma = false, saoChroma = false;
		if (pp.sao) {
			saoLuma = !!r.u(1);
			if (pp.chromaFormatIdc !== 0) saoChroma = !!r.u(1);
		}
		let l0 = 0, l1 = 0;
		if (h.sliceType !== 2) {
			l0 = pp.numRefIdxL0Default;
			l1 = h.sliceType === 0 ? pp.numRefIdxL1Default : 0;
			if (r.u(1)) {
				l0 = r.ue() + 1;
				if (h.sliceType === 0) l1 = r.ue() + 1;
				if (l0 > 16 || l1 > 16) throw new Error(`a bad num_ref_idx_active_minus1 (${l0 - 1}, ${l1 - 1})`);
			}
			if (pp.listsModification && numPicTotalCurr > 1) {
				const bits = ceilLog2(numPicTotalCurr);
				if (r.u(1)) for (let i = 0; i < l0; i++) r.u(bits);
				if (h.sliceType === 0 && r.u(1)) for (let i = 0; i < l1; i++) r.u(bits);
			}
			if (h.sliceType === 0) r.u(1);
			if (pp.cabacInitPresent) r.u(1);
			if (temporalMvp) {
				let fromL0 = true;
				if (h.sliceType === 0) fromL0 = !!r.u(1);
				if (fromL0 && l0 > 1 || !fromL0 && l1 > 1) r.ue();
			}
			if (pp.weightedPred && h.sliceType === 1 || pp.weightedBipred && h.sliceType === 0) {
				r.ue();
				if (pp.chromaFormatIdc !== 0) r.se();
				for (const n of h.sliceType === 0 ? [l0, l1] : [l0]) {
					const luma = [], chroma = [];
					for (let i = 0; i < n; i++) luma.push(r.u(1));
					if (pp.chromaFormatIdc !== 0) for (let i = 0; i < n; i++) chroma.push(r.u(1));
					for (let i = 0; i < n; i++) {
						if (luma[i]) r.se(), r.se();
						if (chroma[i]) for (let j = 0; j < 2; j++) r.se(), r.se();
					}
				}
			}
			r.ue();
		}
		r.se();
		if (pp.sliceChromaQpOffsets) r.se(), r.se();
		let dbfOverride = false, dbfDisabled = pp.ppsDeblockingDisabled;
		if (pp.deblockingOverride) dbfOverride = !!r.u(1);
		if (dbfOverride) {
			dbfDisabled = !!r.u(1);
			if (!dbfDisabled) r.se(), r.se();
		}
		if (pp.loopFilterAcrossSlices && (saoLuma || saoChroma || !dbfDisabled)) r.u(1);
	}
	if (pp.tiles || pp.entropyCodingSync) {
		const n = r.ue();
		if (n) {
			const len = r.ue() + 1;
			if (len > 32) throw new Error(`a bad offset_len_minus1 ${len - 1}`);
			r.skip(n * len);
		}
	}
	if (pp.sliceHeaderExtension) r.skip(8 * r.ue());
	h.end = r.pos;
	if (!r.bit()) throw new Error("a slice header that does not end in byte_alignment()");
	r.align();
	h.dataStart = r.pos >> 3;
	return h;
}
function skipStRps(r) {
	const neg = r.ue(), pos = r.ue();
	if (neg > 16 || pos > 16) throw new Error(`a bad short-term reference picture set (${neg} negative, ${pos} positive pictures)`);
	for (let i = 0; i < neg + pos; i++) r.ue(), r.u(1);
}
function copyBits(w, src, from, to) {
	for (let i = from; i < to; i++) w.bit(src[i >> 3] >> 7 - (i & 7) & 1);
}
function hevcRps(pp) {
	const st = pp.refs.filter((r) => !(r.flags & LONG_TERM));
	return {
		neg: st.filter((r) => r.poc < pp.poc).sort((a, b) => b.poc - a.poc).map((r) => ({
			poc: r.poc,
			used: !!(r.flags & ST_CURR_BEFORE)
		})),
		pos: st.filter((r) => r.poc > pp.poc).sort((a, b) => a.poc - b.poc).map((r) => ({
			poc: r.poc,
			used: !!(r.flags & ST_CURR_AFTER)
		})),
		usedCount: pp.refs.filter((r) => r.flags & 112).length
	};
}
function rewriteHevcSlice(nal, pp) {
	if (nal.length < 3 || nal[0] & 128) throw new Error("not a NAL unit (forbidden_zero_bit)");
	const nalType = nal[0] >> 1 & 63, layer = (nal[0] & 1) << 5 | nal[1] >> 3, tid = (nal[1] & 7) - 1;
	if (nalType > 21) throw new Error(`NAL unit type ${nalType} is not a slice`);
	if (layer) throw new Error("layered (multi-layer) streams are not supported");
	const rps = hevcRps(pp);
	const { rbsp, at } = unescapeMap(nal, SLICE_HEADER_MAX);
	const h = parseHevcSliceHeader(nalType, rbsp, pp, rps.usedCount);
	h.temporalId = tid;
	if (h.dependent || h.rps[1] === 0) return {
		nal,
		header: h
	};
	const w = new BitWriter();
	copyBits(w, rbsp, 0, h.rps[0]);
	w.u(1, 0);
	w.ue(rps.neg.length);
	w.ue(rps.pos.length);
	let prev = pp.poc;
	for (const p of rps.neg) w.ue(prev - p.poc - 1), w.u(1, p.used ? 1 : 0), prev = p.poc;
	prev = pp.poc;
	for (const p of rps.pos) w.ue(p.poc - prev - 1), w.u(1, p.used ? 1 : 0), prev = p.poc;
	if (pp.longTermRefs) {
		w.ue(h.ltPics.length);
		for (const l of h.ltPics) {
			w.u(pp.log2MaxPocLsb, l.pocLsb);
			w.u(1, l.used ? 1 : 0);
			w.u(1, l.msbPresent ? 1 : 0);
			if (l.msbPresent) w.ue(l.msbCycle);
		}
	}
	const usedLt = h.ltPics.filter((l) => l.used).length, usedSt = [...rps.neg, ...rps.pos].filter((p) => p.used).length;
	if (usedLt + usedSt !== rps.usedCount) throw new Error(`the slice's pictures in use (${usedSt} short-term, ${usedLt} long-term) and VA's (${rps.usedCount}) differ`);
	copyBits(w, rbsp, h.lt[1], h.end);
	w.u(1, 1);
	w.align();
	const head = escapeRbsp(w.bytes()), data = nal.subarray(at[h.dataStart]);
	const out = new Uint8Array(2 + head.length + data.length);
	out.set(nal.subarray(0, 2));
	out.set(head, 2);
	out.set(data, 2 + head.length);
	return {
		nal: out,
		header: h
	};
}
const START = new Uint8Array([
	0,
	0,
	0,
	1
]);
function annexB(units) {
	let n = 0;
	for (const u of units) n += 4 + u.length;
	const out = new Uint8Array(n);
	n = 0;
	for (const u of units) out.set(START, n), out.set(u, n + 4), n += 4 + u.length;
	return out;
}
function hevcCodecString(level) {
	return `hev1.1.6.L${level}.90`;
}
function hevcAdapter(log, holdExtra = 0) {
	let reorder = 0, raises = 0;
	let period = [];
	let periodIndex = 0;
	let config = null;
	let lastKey = "";
	const mode = "conservative";
	return {
		config: () => config,
		mode: () => mode,
		state: () => ({
			reorder,
			raises
		}),
		info: () => ({
			reorder,
			raises
		}),
		picture(p) {
			const pb = p.bufs.find((b) => b.type === VA_BUF.picture);
			if (!pb) throw new Error("no picture parameters");
			const pp = parseVaHevcPicParams(pb.data);
			if (pp.chromaFormatIdc !== 1) throw new Error(`chroma_format_idc ${pp.chromaFormatIdc} (only 4:2:0 is supported)`);
			if (pp.bitDepthLuma !== 8 || pp.bitDepthChroma !== 8) throw new Error(`a bit depth of ${pp.bitDepthLuma}/${pp.bitDepthChroma} (only 8 is supported)`);
			const iq = p.bufs.find((b) => b.type === VA_BUF.iqMatrix);
			const scaling = pp.scalingList ? parseVaHevcIq(iq?.data ?? (/* @__PURE__ */ new Uint8Array(1e3)).fill(16)) : null;
			const slices = vaHevcSlices(p);
			if (!slices.length) throw new Error("no slices");
			const written = slices.map((n) => rewriteHevcSlice(n, pp));
			const first = written[0].header;
			if (!first.first) throw new Error("the picture's first slice is not first_slice_segment_in_pic");
			if (written.some((s) => s.header.ppsId !== first.ppsId)) throw new Error("slices of one picture with different PPS ids");
			const idr = first.nalType === 19 || first.nalType === 20;
			const bla = first.nalType >= 16 && first.nalType <= 18;
			const key = idr || bla || !config;
			if (idr || bla) periodIndex++, period = [];
			period.push({ poc: pp.poc });
			let need = 0;
			for (const q of period) if (q.poc > pp.poc) need++;
			let restart = false;
			if (need > reorder) {
				log?.(`[host] va: HEVC: sps_max_num_reorder_pics ${reorder} -> ${need} (picture POC ${pp.poc} would have come out late); the decoder is made again with the stream since the IDR`);
				reorder = need;
				raises++;
				restart = !key;
			}
			const level = hevcLevel(pp.width, pp.height);
			const ppsNal = hevcNal(34, writeHevcPps(pp, first.ppsId, scaling));
			const nals = written.map((s) => s.nal);
			const build = () => {
				const seq = {
					pp,
					level,
					reorder: Math.min(pp.maxDecPicBufferingMinus1, reorder + holdExtra),
					scaling
				};
				return annexB([
					hevcNal(32, writeVps(seq)),
					hevcNal(33, writeHevcSps(seq)),
					ppsNal,
					...nals
				]);
			};
			config = { codec: hevcCodecString(level) };
			const cfgKey = `${config.codec} ${pp.width}x${pp.height}`;
			const reconfigure = key && lastKey !== "" && lastKey !== cfgKey;
			if (key) lastKey = cfgKey;
			const order = periodIndex * 2 ** 24 + Math.max(-(2 ** 23), Math.min(2 ** 23 - 1, pp.poc)) + 2 ** 23;
			const data = build();
			for (let i = nals.length - 1, at = data.length; i >= 0; i--) nals[i] = data.subarray(at - nals[i].length, at), at -= nals[i].length + 4;
			return [{
				data,
				key,
				output: true,
				order,
				remake: build,
				...reconfigure ? { reconfigure } : {},
				...restart ? { restart } : {}
			}];
		}
	};
}
function vp9Frames(p) {
	const parts = [];
	const m = p.length ? p[p.length - 1] : 0;
	if ((m & 224) === 192) {
		const frames = (m & 7) + 1, mag = (m >> 3 & 3) + 1, idx = 2 + mag * frames;
		if (p.length >= idx && p[p.length - idx] === m) {
			let off = 0, q = p.length - idx + 1;
			for (let i = 0; i < frames; i++) {
				let size = 0;
				for (let j = 0; j < mag; j++) size += p[q++] * 2 ** (8 * j);
				parts.push(p.subarray(off, off + size));
				off += size;
			}
			if (off > p.length - idx) parts.length = 0;
		}
	}
	if (!parts.length) parts.push(p);
	return parts.map(vp9Header);
}
function vp9Header(p) {
	let pos = 0;
	const rb = (k) => {
		if (pos + k > p.length * 8) throw new Error(`a VP9 frame header cut short (${p.length} bytes)`);
		let v = 0;
		while (k--) {
			v = v * 2 + (p[pos >> 3] >> 7 - (pos & 7) & 1);
			pos++;
		}
		return v;
	};
	const sync = () => {
		if (rb(24) !== 4817730) throw new Error("not a VP9 frame (bad frame_sync_code)");
	};
	if (rb(2) !== 2) throw new Error("not a VP9 frame (frame_marker is not 2)");
	let profile = rb(1);
	profile |= rb(1) << 1;
	if (profile === 3 && rb(1)) throw new Error("not a VP9 frame (reserved bit set)");
	const f = {
		profile,
		showExisting: false,
		idx: 0,
		key: false,
		show: false,
		refresh: 0
	};
	if (rb(1)) {
		f.showExisting = true;
		f.idx = rb(3);
		f.show = true;
		return f;
	}
	f.key = rb(1) === 0;
	f.show = rb(1) === 1;
	const errorRes = rb(1);
	if (f.key) {
		sync();
		f.refresh = 255;
		return f;
	}
	const intraOnly = f.show ? 0 : rb(1);
	if (!errorRes) rb(2);
	if (intraOnly) {
		sync();
		if (profile > 0) {
			if (profile >= 2) rb(1);
			if (rb(3) !== 7) {
				rb(1);
				if (profile === 1 || profile === 3) rb(3);
			} else if (profile === 1 || profile === 3) rb(1);
		}
	}
	f.refresh = rb(8);
	return f;
}
function showExistingChunk(profile, idx) {
	return new Uint8Array([128 | (profile & 1) << 5 | profile >> 1 << 4 | 8 | idx & 7]);
}
function vp9Adapter(profile, conservative = false) {
	let mode = conservative ? "conservative" : "model";
	let keyed = false;
	return {
		config: () => ({ codec: `vp09.0${profile}.51.08` }),
		mode: () => mode,
		conservative() {
			mode = "conservative";
			return false;
		},
		filler: () => keyed && profile <= 2 ? {
			data: showExistingChunk(profile, 0),
			key: false,
			output: false,
			added: true
		} : null,
		picture(p) {
			const data = concat$1(sliceRanges(p));
			if (!data.length) throw new Error("no slice data");
			const frames = vp9Frames(data);
			const key = frames[0].key;
			keyed ||= key;
			if (frames.some((f) => f.show)) return [{
				data,
				key,
				output: true
			}];
			const last = frames[frames.length - 1];
			const slot = last.refresh ? 31 - Math.clz32(last.refresh & -last.refresh) : -1;
			if (slot < 0 || profile > 2) return [{
				data,
				key,
				output: false
			}];
			return [{
				data,
				key,
				output: false
			}, {
				data: showExistingChunk(profile, slot),
				key: false,
				output: true,
				added: true
			}];
		}
	};
}
const VA_PORT = 1024;
const VERSION = 4;
const MAX_FRAME$1 = 64 << 20;
const HISTORY_MAX = 64 << 20;
const HELD_MS = 100;
const MODEL_HOLD = [
	250,
	2e3,
	500
];
const CONSERVATIVE_HOLD = [
	10,
	1e3,
	100
];
const FILLER_STREAK = 4;
const PROBE_EVERY = 32;
const FILLERS_MAX = 8;
const CLOSED_KEPT = 8;
const HOLD_MAX = 4;
function webCodecs() {
	const g = globalThis;
	return g.VideoDecoder && g.EncodedVideoChunk ? g : void 0;
}
const why = (e) => e?.message ?? String(e);
function prepareVa(opt, vsock, log) {
	if (!opt) return void 0;
	if (!vsock) {
		log("[host] va: needs the vsock device (vsock: false was given, or vsock.raw); the guest gets no VA-API decoder");
		return;
	}
	if (!webCodecs()) {
		log("[host] va: no WebCodecs VideoDecoder on this thread, so it is ignored");
		return;
	}
	return { opts: opt === true ? {} : { ...opt } };
}
function startVa(prep, vsock, log, gpu) {
	if (!prep || !vsock) return void 0;
	return new VaHost(vsock, prep.opts, log, gpu);
}
const CODECS = [
	{
		profile: "vp9.0",
		probe: "vp09.00.51.08",
		label: "VP9 profile 0",
		create: (i) => vp9Adapter(0, i.conservative)
	},
	{
		profile: "h264.cb",
		probe: "avc1.42C033",
		label: "H.264 Constrained Baseline",
		create: (i) => h264Adapter("cb", i.log, i.conservative ? "conservative" : "model", i.holdExtra)
	},
	{
		profile: "h264.main",
		probe: "avc1.4D4033",
		label: "H.264 Main",
		create: (i) => h264Adapter("main", i.log, i.conservative ? "conservative" : "model", i.holdExtra)
	},
	{
		profile: "h264.high",
		probe: "avc1.640033",
		label: "H.264 High",
		create: (i) => h264Adapter("high", i.log, i.conservative ? "conservative" : "model", i.holdExtra)
	},
	{
		profile: "av1.0",
		probe: "av01.0.08M.08",
		label: "AV1 Main",
		create: (i) => av1Adapter(i.width, i.height, i.log, i.conservative)
	},
	{
		profile: "hevc.main",
		probe: "hev1.1.6.L120.90",
		label: "HEVC Main",
		create: (i) => hevcAdapter(i.log, i.holdExtra)
	}
];
function nv12Layout(w, h) {
	const pitch = w + 63 & -64;
	return {
		pitch,
		offsets: [0, pitch * h],
		size: pitch * h + pitch * (h + 1 >> 1)
	};
}
let warnedFormat = "";
async function frameToNv12(frame, log) {
	try {
		const r = frame.visibleRect ?? {
			x: 0,
			y: 0,
			width: frame.displayWidth,
			height: frame.displayHeight
		};
		const w = r.width, h = r.height, ch = h + 1 >> 1, cw = w + 1 >> 1;
		const { pitch, offsets, size } = nv12Layout(w, h);
		const fmt = frame.format;
		if (fmt === "NV12") {
			const data = new Uint8Array(size);
			await frame.copyTo(data, { layout: [{
				offset: 0,
				stride: pitch
			}, {
				offset: offsets[1],
				stride: pitch
			}] });
			return {
				data,
				width: w,
				height: h
			};
		}
		if (fmt === "I420" || fmt === "I420A") {
			const u0 = size, v0 = size + cw * ch;
			const buf = new Uint8Array(v0 + cw * ch + (fmt === "I420A" ? w * h : 0));
			const layout = [
				{
					offset: 0,
					stride: pitch
				},
				{
					offset: u0,
					stride: cw
				},
				{
					offset: v0,
					stride: cw
				}
			];
			if (fmt === "I420A") layout.push({
				offset: v0 + cw * ch,
				stride: w
			});
			await frame.copyTo(buf, { layout });
			for (let y = 0; y < ch; y++) {
				let o = offsets[1] + y * pitch, u = u0 + y * cw, v = v0 + y * cw;
				for (let x = 0; x < cw; x++) {
					buf[o++] = buf[u++];
					buf[o++] = buf[v++];
				}
			}
			return {
				data: buf.subarray(0, size),
				width: w,
				height: h
			};
		}
		if (warnedFormat !== String(fmt)) {
			warnedFormat = String(fmt);
			log?.(`[host] va: decoder output in format ${fmt}: converted through RGBA (slower, not exact)`);
		}
		const rgba = new Uint8Array(w * h * 4);
		let copied = false;
		if (fmt !== null) try {
			await frame.copyTo(rgba, { format: "RGBA" });
			copied = true;
		} catch (e) {
			if (typeof OffscreenCanvas === "undefined") throw e;
		}
		if (!copied) {
			const cx = typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
			if (!cx) throw new Error(`a frame of format ${fmt}, which copyTo() refuses, and no 2D canvas to draw it`);
			cx.drawImage(frame, 0, 0, w, h);
			rgba.set(cx.getImageData(0, 0, w, h).data);
		}
		const [kr, kb] = frame.colorSpace?.matrix === "bt709" ? [.2126, .0722] : [.299, .114];
		const kg = 1 - kr - kb, ky = 219 / 255 * 256, kc = 224 / 255 * 256;
		const yr = Math.round(kr * ky), yg = Math.round(kg * ky), yb = Math.round(kb * ky);
		const ur = Math.round(-kr / (2 * (1 - kb)) * kc), ug = Math.round(-kg / (2 * (1 - kb)) * kc), ub = Math.round(.5 * kc);
		const vg = Math.round(-kg / (2 * (1 - kr)) * kc), vb = Math.round(-kb / (2 * (1 - kr)) * kc);
		const data = new Uint8Array(size);
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			data[y * pitch + x] = (yr * rgba[i] + yg * rgba[i + 1] + yb * rgba[i + 2] + 128 >> 8) + 16;
		}
		for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
			const i = (Math.min(2 * y, h - 1) * w + Math.min(2 * x, w - 1)) * 4, o = offsets[1] + y * pitch + 2 * x;
			const R = rgba[i], G = rgba[i + 1], B = rgba[i + 2];
			data[o] = (ur * R + ug * G + ub * B + 128 >> 8) + 128;
			data[o + 1] = (ub * R + vg * G + vb * B + 128 >> 8) + 128;
		}
		return {
			data,
			width: w,
			height: h
		};
	} finally {
		frame.close();
	}
}
function flatNv12(w, h, y) {
	const { offsets, size } = nv12Layout(w, h), out = new Uint8Array(size);
	out.fill(y, 0, offsets[1]);
	out.fill(128, offsets[1]);
	return out;
}
function nv12ToBgrx(nv12, w, h, pitch, uvOff, dst, dw, dh, conv) {
	const [kr, kb] = conv.bt601 ? [.299, .114] : [.2126, .0722], kg = 1 - kr - kb;
	const ys = conv.inFull ? 1 : 255 / 219, yo = conv.inFull ? 0 : 16, cs = conv.inFull ? 1 : 255 / 224;
	const os = conv.outFull ? 1 : 219 / 255, oo = (conv.outFull ? 0 : 16) * 65536 + 32768;
	const Y = /* @__PURE__ */ new Int32Array(256), RV = /* @__PURE__ */ new Int32Array(256), GU = /* @__PURE__ */ new Int32Array(256), GV = /* @__PURE__ */ new Int32Array(256), BU = /* @__PURE__ */ new Int32Array(256);
	for (let i = 0; i < 256; i++) {
		const c = (i - 128) * cs * os * 65536;
		Y[i] = Math.round((i - yo) * ys * os * 65536) + oo;
		RV[i] = Math.round(c * 2 * (1 - kr));
		GU[i] = Math.round(c * 2 * (1 - kb) * kb / kg);
		GV[i] = Math.round(c * 2 * (1 - kr) * kr / kg);
		BU[i] = Math.round(c * 2 * (1 - kb));
	}
	const sat = (v) => v < 0 ? 0 : v > 16777215 ? 255 : v >> 16;
	const black = sat(Y[conv.inFull ? 0 : 16]);
	for (let y = 0; y < dh; y++) {
		let o = y * dw * 4;
		const cw = y < h ? Math.min(w, dw) : 0;
		const yl = y * pitch, cl = uvOff + (y >> 1) * pitch;
		for (let x = 0; x < cw; x++, o += 4) {
			const yy = Y[nv12[yl + x]], ci = cl + (x & -2), u = nv12[ci], v = nv12[ci + 1];
			dst[o] = sat(yy + BU[u]);
			dst[o + 1] = sat(yy - GU[u] - GV[v]);
			dst[o + 2] = sat(yy + RV[v]);
			dst[o + 3] = 255;
		}
		for (let x = cw; x < dw; x++, o += 4) {
			dst[o] = dst[o + 1] = dst[o + 2] = black;
			dst[o + 3] = 255;
		}
	}
}
function frameConversion(f) {
	const m = f.colorSpace?.matrix ?? null;
	const bt601 = m === null || m === "smpte170m" || m === "bt470bg" ? true : m === "bt709" ? false : null;
	return bt601 === null ? null : {
		bt601,
		full: f.colorSpace?.fullRange === true
	};
}
const convName = (c) => `${c.bt601 ? "BT.601" : "BT.709"} ${c.full ? "full" : "limited"}`;
const now = () => globalThis.performance?.now() ?? Date.now();
var VaSession = class {
	#wc;
	#send;
	#probe;
	#opts;
	#stats;
	#shared;
	#log;
	#parts = [];
	#have = 0;
	#chain = Promise.resolve();
	#ctxs = /* @__PURE__ */ new Map();
	#pics = /* @__PURE__ */ new Map();
	#surfaces = /* @__PURE__ */ new Map();
	#orphans = /* @__PURE__ */ new Map();
	#bound = /* @__PURE__ */ new Map();
	#uploadWarned = false;
	#held = [];
	#keepNv12 = false;
	#cpuWhy = /* @__PURE__ */ new Set();
	#vppAsked = "";
	#closed = false;
	#injections = [];
	#enc = null;
	constructor(wc, send, probe, opts, shared, log) {
		this.#wc = wc;
		this.#send = send;
		this.#probe = probe;
		this.#opts = opts;
		this.#shared = shared;
		this.#stats = shared.stats;
		this.#log = log;
		const ewc = encWebCodecs();
		if (ewc) this.#enc = new VaEncoders({
			wc: ewc,
			out: (o, b) => this.#out(o, b),
			log,
			stats: shared.stats.encode,
			open: shared.encOpen,
			closed: shared.encClosed,
			hardwareAcceleration: opts.hardwareAcceleration ?? "no-preference",
			verbose: opts.log ?? true,
			support: async () => {
				const st = await this.#probe();
				return {
					profiles: st.encode,
					modes: st.encodeModes,
					support: {}
				};
			},
			source: (pic, surface, use) => this.#encSource(pic, surface, use)
		});
	}
	feed(bytes) {
		this.#parts.push(bytes);
		this.#have += bytes.length;
		while (this.#have >= 8) {
			const head = this.#take(8, false);
			const dv = new DataView(head.buffer, head.byteOffset, 8);
			const total = dv.getUint32(0, true), jl = dv.getUint32(4, true), pad = 4 - (jl & 3) & 3;
			if (jl + pad > total || total > MAX_FRAME$1) throw new Error(`a bad frame (${total} bytes, JSON ${jl}; at most ${MAX_FRAME$1})`);
			if (this.#have < 8 + total) break;
			this.#take(8, true);
			const f = this.#take(total, true);
			const msg = JSON.parse(new TextDecoder().decode(f.subarray(0, jl)));
			if (!msg || typeof msg !== "object") throw new Error("a frame that is not a JSON object");
			const bin = f.subarray(jl + pad);
			this.#chain = this.#chain.then(() => this.#handle(msg, bin)).catch((e) => {
				this.#log(`[host] va: ${msg.op}: ${why(e)}`);
				const p = msg.op === "dec" ? this.#pics.get(msg.pic) : void 0;
				if (p) this.#finish(p, "error", why(e));
			});
		}
	}
	#take(n, consume) {
		const first = this.#parts[0];
		let out;
		if (first.length >= n) out = first.subarray(0, n);
		else {
			out = new Uint8Array(n);
			let o = 0;
			for (const p of this.#parts) {
				const k = Math.min(p.length, n - o);
				out.set(p.subarray(0, k), o);
				if ((o += k) === n) break;
			}
		}
		if (consume) {
			let left = n;
			while (left) {
				const p = this.#parts[0];
				if (p.length > left) {
					this.#parts[0] = p.subarray(left);
					left = 0;
				} else {
					this.#parts.shift();
					left -= p.length;
				}
			}
			this.#have -= n;
		}
		return out;
	}
	lost(reason) {
		this.#out({ lost: reason });
	}
	close() {
		this.#closed = true;
		this.#enc?.close();
		for (const h of [...this.#held]) this.#drop(h);
		for (const c of this.#ctxs.values()) this.#freeCtx(c, "the link closed");
		this.#ctxs.clear();
		for (const p of this.#pics.values()) this.#finish(p, "error", "the link closed");
		this.#pics.clear();
		this.#surfaces.clear();
		this.#stats.exported -= this.#bound.size;
		this.#bound.clear();
	}
	#out(obj, bin) {
		if (this.#closed) return;
		const json = new TextEncoder().encode(JSON.stringify(obj));
		const pad = 4 - (json.length & 3) & 3, binlen = bin?.length ?? 0;
		const out = new Uint8Array(8 + json.length + pad + binlen);
		const dv = new DataView(out.buffer);
		dv.setUint32(0, json.length + pad + binlen, true);
		dv.setUint32(4, json.length, true);
		out.set(json, 8);
		if (bin) out.set(bin, 8 + json.length + pad);
		this.#send(out);
	}
	#reply(r, obj, bin) {
		if (typeof r === "number" && r > 0) this.#out({
			...obj,
			r
		}, bin);
	}
	async #handle(m, bin) {
		switch (m.op) {
			case "hello": {
				if (m.version !== VERSION) return this.#reply(m.r, { err: `the host speaks protocol version ${VERSION}, the driver ${m.version}` });
				const st = await this.#probe();
				if (st.state === "failed") return this.#reply(m.r, { err: st.error ?? "no decoder" });
				return this.#reply(m.r, {
					version: VERSION,
					vendor: st.hardware ? "hardware offered" : "software",
					profiles: st.profiles,
					maxWidth: this.#maxW,
					maxHeight: this.#maxH,
					export: !!this.#shared.gpu,
					encode: this.#enc ? st.encodeModes : {}
				});
			}
			case "ctx":
				if (m.entry === "enc") return this.#reply(m.r, this.#enc ? await this.#enc.ctx(m) : { err: "no VideoEncoder on this host" });
				return this.#reply(m.r, await this.#newCtx(m));
			case "ctx_free": {
				if (this.#enc?.free(m.id)) return;
				const c = this.#ctxs.get(m.id);
				this.#ctxs.delete(m.id);
				if (c) this.#retireCtx(c);
				return;
			}
			case "dec": return this.#decode(m, bin);
			case "enc":
				try {
					if (!this.#enc) throw new Error("no VideoEncoder on this host");
					this.#enc.enc(m, bin);
				} catch (e) {
					this.#out({
						ev: "coded",
						pic: Number(m.pic),
						err: why(e)
					});
					this.#log(`[host] va: enc: ${why(e)}`);
				}
				return;
			case "wait": {
				const w = this.#pics.get(m.pic);
				const p = w?.from !== void 0 && w.state === "pending" ? this.#pic(w.from) : w;
				const c = p && this.#ctxs.get(p.ctx);
				if (p?.state === "pending" && c) {
					p.waited = true;
					if (this.#isParked(c, p)) this.#unpark(c);
					if (c.adapter.mode() === "conservative" && c.fillerStreak >= FILLER_STREAK && ++c.waits % PROBE_EVERY && c.decoder && !c.stale && this.#push(c, false)) return;
					if (c.fillerStreak >= FILLER_STREAK && c.waits % PROBE_EVERY === 0) c.fillerStreak = 0;
					this.#progress(c);
				}
				return;
			}
			case "get":
				this.#get(m);
				return;
			case "surf_free":
				this.#enc?.surfFree(Array.isArray(m.surfaces) ? m.surfaces.map(Number) : []);
				for (const id of Array.isArray(m.surfaces) ? m.surfaces : []) {
					const pic = this.#surfaces.get(id);
					this.#surfaces.delete(id);
					if (pic !== void 0) this.#forget(pic);
					if (this.#bound.delete(id)) this.#stats.exported--;
				}
				return;
			case "export": return this.#reply(m.r, await this.#export(m));
			case "vpp": return this.#vpp(m);
			default: this.#reply(m.r, { err: `${m.op === "release" ? "not implemented" : "unknown op"}: ${m.op}` });
		}
	}
	get #maxW() {
		return this.#big ? 4096 : 1920;
	}
	get #maxH() {
		return this.#big ? 4096 : 1088;
	}
	#big = true;
	async #newCtx(m) {
		const kind = CODECS.find((k) => k.profile === m.profile);
		if (!kind || !(await this.#probe()).profiles.includes(kind.profile)) return { err: `profile ${m.profile} is not offered` };
		const w = Number(m.width), h = Number(m.height);
		if (!(w > 0 && h > 0 && w <= 16384 && h <= 16384)) return { err: `a bad size ${m.width}x${m.height}` };
		const learned = this.#shared.learned.has(kind.profile);
		const conservative = this.#opts.mode === "conservative" || learned;
		let adapter;
		try {
			adapter = kind.create({
				width: w,
				height: h,
				log: this.#log,
				conservative,
				holdExtra: this.#opts.holdExtra ?? 0
			});
		} catch (e) {
			return { err: `${kind.label}: ${why(e)}` };
		}
		const base = this.#opts.hardwareAcceleration ?? "no-preference";
		const ladder = [];
		for (const hw of base === "prefer-software" ? [base] : [base, "prefer-software"]) for (let v = 0; v < (adapter.variants ?? 1); v++) {
			const cfg = {
				...adapter.probe?.(v) ?? { codec: kind.probe },
				codedWidth: w,
				codedHeight: h,
				optimizeForLatency: true,
				hardwareAcceleration: hw
			};
			if ((await this.#wc.VideoDecoder.isConfigSupported(cfg).catch(() => ({ supported: false }))).supported) ladder.push({
				hw,
				variant: v
			});
		}
		if (!ladder.length) return { err: `VideoDecoder.isConfigSupported(${kind.probe}, ${w}x${h}) said no` };
		adapter.variant?.(ladder[0].variant);
		const info = {
			id: m.id,
			profile: kind.profile,
			width: w,
			height: h,
			codec: null,
			description: false,
			hardwareAcceleration: ladder[0].hw,
			decoder: this.#kindOf(kind.profile, ladder[0].hw),
			format: null,
			mode: adapter.mode(),
			modeWhy: adapter.mode() === "conservative" ? this.#opts.mode === "conservative" ? "VaOptions.mode" : learned ? "an earlier context's decoder disagreed with the model" : "the codec has no model" : null,
			open: true,
			pictures: 0,
			frames: 0,
			failed: 0,
			restarts: 0,
			replays: 0,
			holdFires: 0,
			fillers: 0,
			flushes: 0,
			dropped: 0,
			early: 0,
			fallbacks: 0,
			latencyMs: 0,
			colorSpace: null,
			adapter: adapter.info?.() ?? {}
		};
		const c = {
			id: m.id,
			kind,
			adapter,
			width: w,
			height: h,
			config: null,
			historyConfig: null,
			decoder: null,
			stale: false,
			seq: 0,
			pending: /* @__PURE__ */ new Map(),
			tsSeq: /* @__PURE__ */ new Map(),
			history: null,
			historyBytes: 0,
			keyAt: 0,
			histBase: 0,
			lastOut: 0,
			failPos: -1,
			retry: null,
			retryNext: false,
			timer: null,
			lastGood: null,
			ladder,
			rung: 0,
			everOutput: false,
			lastInput: 0,
			sinceInput: false,
			latency: 0,
			colour: null,
			lastFiller: 0,
			flushing: null,
			fillerGiven: 0,
			fillerDepth: 1,
			fillerMisses: 0,
			fillerTs: 0,
			fillerStreak: 0,
			waits: 0,
			parked: null,
			info
		};
		const old = this.#ctxs.get(m.id);
		if (old) this.#freeCtx(old, "its context was replaced");
		this.#ctxs.set(m.id, c);
		this.#shared.open.add(info);
		return {};
	}
	#kindOf(profile, hw) {
		if (hw === "prefer-hardware") return "hardware";
		if (hw === "prefer-software") return "software";
		const s = this.#shared.support[profile];
		return s?.hardware && !s.software ? "hardware" : s && !s.hardware && s.software ? "software" : "hardware or software";
	}
	#fullConfig(c, base) {
		c.info.codec = base.codec;
		c.info.description = !!base.description;
		return {
			...base,
			codedWidth: c.width,
			codedHeight: c.height,
			optimizeForLatency: true,
			hardwareAcceleration: c.ladder[c.rung].hw
		};
	}
	#config(c) {
		const base = c.adapter.config();
		return base ? this.#fullConfig(c, base) : null;
	}
	#retireCtx(c) {
		this.#unpark(c);
		if (c.timer) clearTimeout(c.timer);
		c.timer = null;
		c.history = null;
		this.#closeInfo(c);
		const dec = c.decoder;
		if (!dec || dec.state !== "configured" || c.stale || !c.pending.size) return this.#freeCtx(c, "its context was destroyed");
		const done = (why) => {
			const left = [...c.pending.values()];
			c.pending.clear();
			this.#closeDecoder(c);
			this.#endHeld(c);
			for (const id of left) {
				const p = this.#pic(id);
				if (p) this.#finish(p, "error", why);
			}
		};
		c.flushing = dec;
		dec.flush().then(() => done("its context was destroyed before the decoder gave it"), () => done("its context was destroyed"));
	}
	#closeInfo(c) {
		if (!this.#shared.open.delete(c.info)) return;
		c.info.open = false;
		c.info.adapter = c.adapter.info?.() ?? {};
		this.#shared.closed.push(c.info);
		if (this.#shared.closed.length > CLOSED_KEPT) this.#shared.closed.shift();
	}
	#freeCtx(c, reason) {
		this.#closeDecoder(c);
		this.#endHeld(c);
		this.#closeInfo(c);
		if (c.timer) clearTimeout(c.timer);
		c.timer = null;
		for (const p of [...this.#pics.values(), ...this.#orphans.values()]) if (p.ctx === c.id && p.state === "pending") this.#finish(p, "error", reason);
		c.pending.clear();
		c.history = null;
	}
	#closeDecoder(c) {
		const dec = c.decoder;
		if (!dec) return;
		c.decoder = null;
		this.#stats.decoders--;
		if (dec.state !== "closed") try {
			dec.close();
		} catch {}
	}
	#finish(p, state, error = null) {
		if (p.state !== "pending") return;
		if (this.#orphans.get(p.pic) === p) this.#orphans.delete(p.pic);
		p.state = state;
		p.error = error;
		const c = this.#ctxs.get(p.ctx);
		if (state === "error" && !this.#closed) {
			this.#stats.failed++;
			if (c) c.info.failed++;
		}
		if (c?.timer) this.#progress(c);
		this.#upload(p);
		this.#out(state === "ready" ? {
			ev: "ready",
			surface: p.surface,
			pic: p.pic
		} : {
			ev: "error",
			surface: p.surface,
			pic: p.pic,
			err: error
		});
		const g = p.getters;
		p.getters = [];
		for (const f of g) f();
		for (const a of p.also) {
			if (this.#pics.get(a.pic) !== a) continue;
			a.data = p.data;
			a.width = p.width;
			a.height = p.height;
			if (p.spent) a.spent = true;
			if (p.held && !a.held) {
				a.held = p.held;
				p.held.pics.push(a);
			}
			this.#finish(a, state, error);
		}
		if (p.held) this.#settle(p.held);
	}
	#pic(id) {
		return this.#pics.get(id) ?? this.#orphans.get(id);
	}
	#forget(id) {
		const p = this.#pics.get(id);
		if (!p) return;
		this.#pics.delete(id);
		if (p.held) {
			const h = p.held;
			p.held = null;
			this.#settle(h);
		}
		if (p.state === "pending" && (p.also.some((a) => this.#pics.get(a.pic) === a) || (p.feeds ?? 0) > 0)) {
			this.#orphans.set(id, p);
			return;
		}
		p.state = "error";
		p.error = "freed";
		p.data = null;
		const g = p.getters;
		p.getters = [];
		for (const f of g) f();
	}
	#newPicture(id, sid, ctx) {
		if (!(id > 0) || !Number.isSafeInteger(id)) throw new Error(`a bad picture id ${id}`);
		const old = this.#surfaces.get(sid);
		if (old !== void 0) this.#forget(old);
		this.#forget(id);
		const p = {
			pic: id,
			surface: sid,
			ctx,
			state: "pending",
			data: null,
			width: 0,
			height: 0,
			error: null,
			waited: false,
			getters: [],
			also: [],
			held: null
		};
		this.#pics.set(id, p);
		this.#surfaces.set(sid, id);
		return p;
	}
	#decode(m, bin) {
		this.#stats.pictures++;
		const p = this.#newPicture(Number(m.pic), Number(m.surface), m.ctx);
		if (Array.isArray(m.display) && m.display.length === 2 && Number(m.display[0]) !== p.surface) p.also.push(this.#newPicture(Number(m.display[1]), Number(m.display[0]), m.ctx));
		const c = this.#ctxs.get(m.ctx);
		if (!c) return this.#finish(p, "error", `no context ${m.ctx}`);
		c.info.pictures++;
		p.width = c.width;
		p.height = c.height;
		const bufs = [];
		let off = 0;
		for (const b of Array.isArray(m.bufs) ? m.bufs : []) {
			const [type, size, num] = (Array.isArray(b) ? b : []).map(Number);
			const len = size * num;
			if (!Number.isSafeInteger(size) || !Number.isSafeInteger(num) || size < 0 || num < 0 || !Number.isSafeInteger(len) || off + len > bin.length) throw new Error(`buffers beyond the frame's ${bin.length} bytes`);
			bufs.push({
				type,
				size,
				num,
				data: bin.subarray(off, off + len)
			});
			off += len;
		}
		const vp = {
			pic: p.pic,
			surface: p.surface,
			profile: c.kind.profile,
			width: c.width,
			height: c.height,
			bufs,
			refs: Array.isArray(m.refs) ? m.refs.map(Number) : []
		};
		this.#unpark(c, vp);
		let chunks;
		try {
			chunks = c.adapter.picture(vp);
		} catch (e) {
			return this.#finish(p, "error", `${c.kind.label}: ${why(e)}`);
		}
		c.info.adapter = c.adapter.info?.() ?? {};
		const outputs = chunks.filter((k) => k.output).length;
		if (!chunks.some((k) => k.output && !k.added)) this.#stats.hidden++;
		const due = this.#due();
		if (due.includes("fail")) this.#finish(p, "error", "a failure the host was asked for (test)");
		for (const k of chunks) {
			if (k.hold && k === chunks[chunks.length - 1]) {
				c.parked = {
					k,
					out: k.output ? p : null,
					p
				};
				break;
			}
			if (!this.#submit(c, k, k.output ? p : null, p)) return;
		}
		if (!outputs && p.state === "pending") {
			p.data = flatNv12(c.width, c.height, 16);
			this.#finish(p, "ready");
		}
		if (c.timer) this.#progress(c);
		for (const what of due) if (what !== "fail") this.#inject(c, what);
	}
	#isParked(c, p) {
		return !!c.parked && (c.parked.p === p || c.parked.p.also.includes(p));
	}
	#unpark(c, next = null) {
		const pk = c.parked;
		if (!pk) return;
		c.parked = null;
		let k;
		try {
			k = pk.k.hold(next);
		} catch (e) {
			return this.#finish(pk.p, "error", `${c.kind.label}: ${why(e)}`);
		}
		this.#submit(c, k, pk.out, pk.p);
	}
	#due() {
		const out = [];
		for (const j of this.#injections) if (j.left > 0 && ++j.n % j.every === 0) j.left--, out.push(j.what);
		if (out.length) this.#injections = this.#injections.filter((j) => j.left > 0);
		return out;
	}
	#submit(c, k, out, p, again = false) {
		try {
			if (k.reconfigure || !c.config) {
				const cfg = this.#config(c);
				if (!cfg) {
					this.#finish(p, "error", `${c.kind.label}: no decoder configuration yet`);
					return false;
				}
				if (k.reconfigure && c.decoder && !c.stale) {
					const dec = c.decoder;
					c.flushing = dec;
					dec.flush().then(() => c.flushing === dec && (c.flushing = null), () => c.flushing === dec && (c.flushing = null));
					dec.configure(cfg);
					c.adapter.reset?.();
					c.tsSeq.clear();
				}
				c.config = cfg;
			}
			const usable = c.decoder && c.decoder.state === "configured" && !c.stale;
			if (k.key) {
				if (!usable) {
					const cfg = c.config;
					if (c.decoder || c.pending.size) this.#restart(c, false);
					if (!c.decoder) this.#makeDecoder(c, cfg);
					else if (cfg !== c.config) c.decoder.configure(cfg);
					c.config = cfg;
				}
				if (usable && !k.reconfigure && c.history && this.#owed(c, c.history.length)) c.keyAt = c.history.length;
				else {
					c.history = [];
					c.historyBytes = 0;
					c.keyAt = 0;
					c.historyConfig = c.config;
				}
			} else if (!usable) {
				if (!c.history) {
					this.#finish(p, "error", c.decoder || c.stale ? "the decoder was lost and no key frame came since" : "the decoder waits for a key frame");
					return false;
				}
				this.#restart(c, true);
				if (!c.decoder) {
					this.#finish(p, "error", "the decoder could not be made again");
					return false;
				}
			} else if (k.restart && c.history) {
				this.#stats.restarts++;
				c.info.restarts++;
				this.#restart(c, true);
				if (!c.decoder) {
					this.#finish(p, "error", "the decoder could not be made again");
					return false;
				}
			}
			const seq = ++c.seq, ts = k.order ?? seq * 64;
			c.fillerTs = 0;
			if (k.key && !c.keyAt) {
				c.histBase = seq;
				c.failPos = -1;
				c.retry = null;
			}
			if (c.history) {
				c.historyBytes += k.data.length;
				if (c.historyBytes > HISTORY_MAX) {
					c.history = null;
					this.#log(`[host] va: more than 64 MiB since the last key frame: a decoder lost now needs the next key frame`);
				} else c.history.push({
					data: k.remake ? k.data : k.data.slice(),
					...k.remake ? { remake: k.remake } : {},
					key: k.key,
					pic: out?.pic ?? null,
					...k.order !== void 0 ? { order: k.order } : {}
				});
			}
			if (out && out.state === "pending") c.pending.set(ts, out.pic);
			c.tsSeq.set(ts, seq);
			if (k.added) this.#stats.showExisting++;
			c.lastInput = now();
			c.sinceInput = true;
			c.decoder.decode(new this.#wc.EncodedVideoChunk({
				type: k.key ? "key" : "delta",
				timestamp: ts,
				data: k.data
			}));
			this.#opts.dump?.({
				ctx: c.id,
				profile: c.kind.profile,
				key: k.key,
				data: k.data
			});
			return true;
		} catch (e) {
			c.stale = true;
			this.#stats.errors++;
			if (!again && !c.everOutput && this.#fallback(c, e)) return this.#submit(c, k, out, p, true);
			this.#finish(p, "error", `VideoDecoder: ${why(e)}`);
			return false;
		}
	}
	#owed(c, n) {
		const owed = new Set(c.pending.values());
		for (let i = 0; i < n; i++) if (c.history[i].pic !== null && owed.has(c.history[i].pic) && this.#pic(c.history[i].pic)?.state === "pending") return true;
		return false;
	}
	#trim(c) {
		if (!c.keyAt || !c.history || this.#owed(c, c.keyAt)) return;
		const gone = c.history.splice(0, c.keyAt);
		for (const k of gone) c.historyBytes -= k.data.length;
		c.histBase += c.keyAt;
		c.failPos = -1;
		c.retry = null;
		c.keyAt = 0;
	}
	#makeDecoder(c, config) {
		const dec = new this.#wc.VideoDecoder({
			output: (f) => this.#output(c, dec, f),
			error: (e) => this.#failed(c, dec, e)
		});
		c.decoder = dec;
		c.tsSeq.clear();
		this.#stats.decoders++;
		dec.configure(config);
		c.adapter.reset?.();
		c.stale = false;
		c.lastOut = c.seq;
		return dec;
	}
	#restart(c, full) {
		const waiting = /* @__PURE__ */ new Set();
		for (const id of c.pending.values()) if (this.#pic(id)?.state === "pending") waiting.add(id);
		c.pending.clear();
		this.#closeDecoder(c);
		c.stale = false;
		const h = c.history;
		let end = -1;
		if (h) {
			if (full) end = h.length - 1;
			else for (let i = 0; i < h.length; i++) if (h[i].pic !== null && waiting.has(h[i].pic)) end = i;
		}
		try {
			if (h && c.historyConfig && (full || end >= 0)) {
				const cfg = this.#config(c) ?? c.historyConfig;
				const dec = this.#makeDecoder(c, cfg);
				c.config = c.historyConfig = cfg;
				c.histBase = c.seq + 1;
				c.retry = c.retryNext ? dec : null;
				c.retryNext = false;
				for (let i = 0; i <= end; i++) {
					const k = h[i], seq = ++c.seq, ts = k.order ?? seq * 64;
					if (k.pic !== null && waiting.delete(k.pic)) c.pending.set(ts, k.pic);
					c.tsSeq.set(ts, seq);
					dec.decode(new this.#wc.EncodedVideoChunk({
						type: k.key ? "key" : "delta",
						timestamp: ts,
						data: k.remake ? k.remake() : k.data
					}));
				}
				c.fillerTs = 0;
				c.lastInput = now();
				c.sinceInput = true;
				this.#stats.replays++;
				this.#stats.replayed += end + 1;
				c.info.replays++;
			}
		} catch (e) {
			this.#log(`[host] va: the replay failed: ${why(e)}`);
			this.#closeDecoder(c);
			c.history = null;
			for (const id of c.pending.values()) waiting.add(id);
			c.pending.clear();
		}
		for (const id of waiting) {
			const p = this.#pic(id);
			if (p) this.#finish(p, "error", "the decoder was lost before its picture came, and no key frame to replay from");
		}
	}
	#output(c, dec, frame) {
		this.#stats.frames++;
		if (dec !== c.decoder || this.#closed) return frame.close();
		const ts = frame.timestamp, id = c.pending.get(ts), seq = c.tsSeq.get(ts);
		c.pending.delete(ts);
		c.tsSeq.delete(ts);
		c.everOutput = true;
		c.info.frames++;
		c.info.format = frame.format;
		if (c.sinceInput) {
			c.sinceInput = false;
			const l = now() - c.lastInput;
			c.latency = c.latency ? .8 * c.latency + .2 * l : l;
			c.info.latencyMs = Math.round(c.latency * 10) / 10;
		}
		this.#trim(c);
		if (seq !== void 0 && seq > c.lastOut) c.lastOut = seq;
		const p = id === void 0 ? void 0 : this.#pic(id);
		if (id !== void 0 && id === c.lastFiller) {
			c.fillerMisses = 0;
			c.fillerDepth = Math.max(1, c.fillerGiven);
			c.fillerStreak++;
			c.lastFiller = 0;
		}
		const early = id !== void 0 && c.flushing !== dec && c.adapter.mode() === "model" && !!c.adapter.held?.(id);
		this.#progress(c);
		if (!p || p.state !== "pending") frame.close();
		else {
			const cs = frame.colorSpace;
			c.info.colorSpace = cs ? `${cs.matrix ?? "null"} ${cs.fullRange === true ? "full" : cs.fullRange === false ? "limited" : "null"}` : null;
			c.colour = cs ? {
				primaries: cs.primaries ?? null,
				transfer: cs.transfer ?? null,
				matrix: cs.matrix ?? null,
				fullRange: cs.fullRange ?? null
			} : null;
			const h = {
				frame,
				ctx: c,
				pics: [p],
				copy: null
			};
			p.held = h;
			if (++this.#stats.framesHeld > this.#stats.framesHeldPeak) this.#stats.framesHeldPeak = this.#stats.framesHeld;
			if (this.#holds(p)) {
				this.#held.push(h);
				this.#finish(p, "ready");
				this.#settle(h);
				this.#cap(c);
			} else this.#copy(h).then((ok) => {
				if (this.#pic(p.pic) !== p || p.state !== "pending") return;
				if (ok) this.#finish(p, "ready");
				else this.#finish(p, "error", `VideoFrame.copyTo: ${h.err}`);
			});
		}
		if (early) {
			c.info.early++;
			this.#conservative(c, "the decoder gave a picture the model said it still held");
		}
	}
	#conservative(c, reason, replay = true) {
		if (c.adapter.mode() === "conservative") return false;
		let restart = false;
		try {
			restart = c.adapter.conservative?.(reason) ?? false;
		} catch (e) {
			this.#log(`[host] va: ${c.kind.label}: conservative mode: ${why(e)}`);
		}
		c.info.mode = c.adapter.mode();
		c.info.modeWhy = reason;
		c.info.adapter = c.adapter.info?.() ?? {};
		this.#stats.modeSwitches++;
		this.#shared.learned.add(c.kind.profile);
		this.#log(`[host] va: ${c.kind.label} ${c.width}x${c.height} (context ${c.id}, ${c.info.codec ?? c.kind.probe}, ${c.info.decoder}${c.info.format ? `, ${c.info.format} frames` : ""}): conservative mode: ${reason}`);
		if (!restart || !replay || !c.history || !c.decoder || c.stale) return false;
		this.#stats.restarts++;
		c.info.restarts++;
		this.#restart(c, true);
		return true;
	}
	#fallback(c, err) {
		if (c.rung + 1 >= c.ladder.length) {
			if (!this.#shared.broken.has(c.kind.profile)) {
				this.#shared.broken.add(c.kind.profile);
				this.#log(`[host] va: ${c.kind.label}: every configuration failed before a picture (${why(err)}), though isConfigSupported said yes: not offered to later connections`);
			}
			return false;
		}
		const from = c.ladder[c.rung];
		const to = c.ladder[++c.rung];
		c.adapter.variant?.(to.variant);
		c.config = null;
		c.historyConfig = this.#config(c) ?? c.historyConfig;
		c.retryNext = false;
		c.failPos = -1;
		c.retry = null;
		c.info.fallbacks++;
		this.#stats.fallbacks++;
		c.info.hardwareAcceleration = to.hw;
		c.info.mode = c.adapter.mode();
		if (c.info.mode === "conservative") c.info.modeWhy ??= "the packaging the decoder takes has no model";
		c.info.decoder = this.#kindOf(c.kind.profile, to.hw);
		c.info.adapter = c.adapter.info?.() ?? {};
		this.#log(`[host] va: ${c.kind.label} ${c.width}x${c.height}: the decoder failed before its first picture (${why(err)}) with ${from.hw}${c.adapter.variants ? `, variant ${from.variant}` : ""}: trying ${to.hw}${c.adapter.variants ? `, ${JSON.stringify(c.info.adapter.packaging ?? to.variant)}` : ""}`);
		return true;
	}
	#failed(c, dec, err) {
		if (c.decoder !== dec) return;
		const reclaimed = err?.name === "QuotaExceededError";
		const what = `${c.kind.label} ${c.width}x${c.height}`;
		c.decoder = null;
		this.#stats.decoders--;
		c.stale = true;
		if (!reclaimed && !c.everOutput && (err?.name === "NotSupportedError" || c.seq - c.histBase < 3) && this.#fallback(c, err)) {
			this.#stats.errors++;
			if (c.pending.size && c.history) this.#restart(c, true);
			return;
		}
		if (reclaimed) {
			this.#stats.reclaims++;
			c.retryNext = false;
			if (this.#opts.log ?? true) this.#log(`[va] the browser reclaimed the decoder (${what}): ${why(err)}; made again with the stream since its last key frame`);
		} else {
			this.#stats.errors++;
			if (this.#opts.log ?? true) this.#log(`[va] decoder error (${what}): ${err?.name ?? "Error"}: ${why(err)}`);
			const done = c.history ? c.lastOut - c.histBase + 1 : 0, again = dec === c.retry && done <= c.failPos;
			c.failPos = done;
			c.retryNext = true;
			if (again) {
				c.history = null;
				if (this.#opts.log ?? true) this.#log(`[va] the replay failed at the same place: pictures fail until the next key frame`);
			}
		}
		if (!c.pending.size) return;
		if (!c.history) {
			const pending = [...c.pending.values()];
			c.pending.clear();
			c.history = null;
			for (const id of pending) {
				const p = this.#pic(id);
				if (p) this.#finish(p, "error", `the decoder failed: ${why(err)}`);
			}
			return;
		}
		this.#restart(c, true);
	}
	#waited(c) {
		let w = 0;
		for (const p of this.#waitable(c)) {
			if (c.adapter.held?.(p.pic)) return 2;
			w = 1;
		}
		return w;
	}
	#waitedPic(c) {
		let best;
		for (const p of this.#waitable(c)) if (best === void 0 || p.pic < best) best = p.pic;
		return best;
	}
	*#waitable(c) {
		for (const m of [this.#pics, this.#orphans]) for (const p of m.values()) if (p.ctx === c.id && p.state === "pending" && p.waited) yield p;
	}
	#holdMs(c, w) {
		if (w === 2) return HELD_MS;
		const [lo, hi, first] = c.adapter.mode() === "model" ? MODEL_HOLD : CONSERVATIVE_HOLD;
		if (!c.latency) return first;
		return Math.min(hi, Math.max(lo, c.adapter.mode() === "model" ? 8 * c.latency + 10 : 3 * c.latency + 5));
	}
	#arm(c) {
		const w = this.#waited(c);
		if (!c.timer && w) c.timer = setTimeout(() => this.#hold(c), this.#holdMs(c, w));
	}
	#progress(c) {
		if (c.timer) clearTimeout(c.timer);
		c.timer = null;
		this.#arm(c);
	}
	#hold(c, forced = false) {
		c.timer = null;
		if (this.#closed || this.#ctxs.get(c.id) !== c || !forced && !this.#waited(c)) return;
		this.#unpark(c);
		const dec = c.decoder;
		if (!dec || dec.state !== "configured" || c.stale) {
			if (c.pending.size) this.#restart(c, true);
			this.#arm(c);
			return;
		}
		if (!forced && (dec.decodeQueueSize ?? 0) > 0) return this.#arm(c);
		const w = forced ? 0 : this.#waited(c);
		if (!forced) {
			this.#stats.holdFires++;
			c.info.holdFires++;
		}
		if (w === 1 && c.adapter.mode() === "model" && this.#conservative(c, `a picture the model said was out did not come in ${Math.round(this.#holdMs(c, 1))} ms`)) return this.#arm(c);
		if (w === 1 && c.adapter.mode() === "conservative" && this.#push(c, true)) return;
		this.#stats.flushes++;
		c.info.flushes++;
		if (forced || w !== 2) this.#log(forced ? "[host] va: the decoder flushed (test)" : `[host] va: the decoder held a picture for ${Math.round(this.#holdMs(c, w))} ms with nothing queued: flushed`);
		c.stale = true;
		c.sinceInput = false;
		c.flushing = dec;
		dec.flush().then(() => {
			if (c.flushing === dec) c.flushing = null;
			if (c.decoder !== dec) return;
			const left = [];
			for (const id of c.pending.values()) if (this.#pic(id)?.state === "pending") left.push(id);
			if (!left.length) return c.pending.clear();
			this.#stats.dropped += left.length;
			c.info.dropped += left.length;
			this.#conservative(c, `the decoder dropped ${left.length} picture(s)`, false);
			let deeper = false;
			try {
				deeper = !!c.history && !!c.adapter.dropped?.(left);
			} catch (e) {
				this.#log(`[host] va: ${c.kind.label}: ${why(e)}`);
			}
			if (deeper) {
				this.#stats.restarts++;
				c.info.restarts++;
				c.info.adapter = c.adapter.info?.() ?? {};
				this.#restart(c, true);
				return this.#arm(c);
			}
			c.pending.clear();
			for (const id of left) {
				const p = this.#pic(id);
				if (p) this.#finish(p, "error", "the decoder gave no picture for it");
			}
		}, () => {
			if (c.flushing === dec) c.flushing = null;
		});
	}
	#push(c, stalled) {
		const dec = c.decoder;
		if (!dec || c.fillerMisses >= 3) return false;
		const pic = this.#waitedPic(c);
		if (pic === void 0) return false;
		if (pic !== c.lastFiller) c.lastFiller = pic, c.fillerGiven = 0;
		let n = 0;
		try {
			for (const want = c.fillerGiven ? 1 : c.fillerDepth; n < want && c.fillerGiven < FILLERS_MAX && c.fillerTs < 63; n++) {
				const f = c.adapter.filler?.(pic, c.fillerGiven);
				if (!f) break;
				c.fillerTs++;
				c.fillerGiven++;
				dec.decode(new this.#wc.EncodedVideoChunk({
					type: "delta",
					timestamp: f.order ?? c.seq * 64 + c.fillerTs,
					data: f.data
				}));
				this.#stats.fillers++;
				c.info.fillers++;
			}
		} catch (e) {
			this.#log(`[host] va: a filler failed: ${why(e)}`);
		}
		if (n) {
			c.lastInput = now();
			c.sinceInput = true;
			this.#progress(c);
			return true;
		}
		if (stalled) {
			if (c.fillerGiven) c.fillerMisses++;
			c.fillerStreak = 0;
			c.lastFiller = 0;
		}
		return false;
	}
	#holds(p) {
		if (!this.#shared.gpu?.video || this.#opts.upload === "cpu" || p.getters.length > (p.feeds ?? 0)) return false;
		for (const x of [p, ...p.also]) if (this.#bound.get(x.surface)?.rgb === false) return false;
		return true;
	}
	#settle(h) {
		if (h.frame && !h.copy && !h.pics.some((x) => x.held === h && this.#pics.get(x.pic) === x)) this.#drop(h);
	}
	#drop(h, spent = false) {
		const i = this.#held.indexOf(h);
		if (i >= 0) this.#held.splice(i, 1);
		if (!h.frame) return;
		try {
			h.frame.close();
		} catch {}
		h.frame = null;
		this.#stats.framesHeld--;
		for (const x of h.pics) if (x.held === h) {
			x.held = null;
			if (spent) x.spent = true;
		}
	}
	#copy(h) {
		if (h.copy) return h.copy;
		const i = this.#held.indexOf(h);
		if (i >= 0) this.#held.splice(i, 1);
		const f = h.frame;
		if (!f) return h.copy = Promise.resolve(false);
		h.frame = null;
		const t = now();
		h.copy = frameToNv12(f, this.#log).then((r) => {
			this.#stats.framesHeld--;
			this.#stats.copies++;
			this.#stats.copyMs += now() - t;
			h.ctx.lastGood = r;
			for (const x of h.pics) if (x.held === h) {
				x.held = null;
				x.data = r.data;
				x.width = r.width;
				x.height = r.height;
			}
			return true;
		}, (e) => {
			this.#stats.framesHeld--;
			h.err = why(e);
			for (const x of h.pics) if (x.held === h) x.held = null;
			return false;
		});
		return h.copy;
	}
	#cap(c) {
		let n = 0;
		for (const h of this.#held) if (h.ctx === c) n++;
		for (const h of [...this.#held]) {
			if (n <= HOLD_MAX) break;
			if (h.ctx !== c) continue;
			n--;
			this.#stats.framesEvicted++;
			this.#copy(h);
		}
	}
	#endHeld(c) {
		for (const h of [...this.#held]) if (h.ctx === c) this.#closed ? this.#drop(h) : this.#copy(h);
	}
	#cpuWay(reason) {
		const key = reason.split(" (")[0];
		this.#stats.gpuFallbacks[key] = (this.#stats.gpuFallbacks[key] ?? 0) + 1;
		if (!this.#cpuWhy.has(key)) {
			this.#cpuWhy.add(key);
			this.#log(`[host] va: video processing on the CPU (copy to NV12, convert, upload) rather than the GPU: ${reason}`);
		}
	}
	#draw(q, src) {
		const gpu = this.#shared.gpu, b = this.#bound.get(q.surface), conv = q.conv;
		if (!b?.rgb) return "not exported (yet)";
		if (!gpu?.video) return "no GPU upload (no renderer)";
		if (this.#opts.upload === "cpu") return "upload: cpu";
		const h = src.held;
		if (!h?.frame) return src.data ? "copied to NV12 already (read back first, or over the cap)" : "no frame";
		const f = h.frame;
		const r = f.visibleRect ?? {
			x: 0,
			y: 0,
			width: f.displayWidth,
			height: f.displayHeight
		};
		if (f.displayWidth !== r.width || f.displayHeight !== r.height) return `display size (${f.displayWidth}x${f.displayHeight} for a ${r.width}x${r.height} picture: drawn scaled)`;
		const fc = frameConversion(f);
		if (!fc || fc.bt601 !== conv.bt601 || fc.full !== conv.inFull) return `colour (the frame's ${fc ? convName(fc) : `matrix ${f.colorSpace?.matrix}`}, asked ${convName({
			bt601: conv.bt601,
			full: conv.inFull
		})})`;
		if (!conv.outFull) return "limited-range RGB asked";
		const w = Math.min(r.width, b.width), hh = Math.min(r.height, b.height);
		const t = now();
		if (b.extent[0] > w || b.extent[1] > hh) {
			if (!gpu.write(b.y, {
				x: 0,
				y: 0,
				width: b.width,
				height: b.height
			}, (dst) => {
				dst.fill(0);
				for (let i = 3; i < dst.length; i += 4) dst[i] = 255;
			})) return "the black fill failed";
			b.extent = [0, 0];
		}
		let err;
		try {
			err = gpu.video(b.y, f, w, hh);
		} catch (e) {
			err = why(e);
		}
		if (err) return `the draw failed (${err})`;
		this.#stats.gpuUploads++;
		this.#stats.gpuUploadMs += now() - t;
		b.extent = [w, hh];
		b.pic = q.pic;
		q.width = r.width;
		q.height = r.height;
		if (this.#keepNv12 || this.#opts.verify) this.#copy(h).then(() => {
			if (this.#opts.verify && b.pic === q.pic && src.data) b.ref = {
				data: src.data,
				width: src.width,
				height: src.height,
				conv
			};
		});
		else this.#drop(h, true);
		return null;
	}
	#getBgrx(m, q) {
		const b = this.#bound.get(q.surface), gpu = this.#shared.gpu;
		let data = null, w = 0, h = 0;
		const failed = q.state === "error" ? q.error ?? "failed" : void 0;
		if (b?.rgb && b.pic === q.pic && gpu?.read) {
			data = gpu.read(b.y, {
				x: 0,
				y: 0,
				width: b.width,
				height: b.height
			});
			w = b.width, h = b.height;
		}
		if (!data) {
			let nv = q.data, nw = q.width, nh = q.height;
			if (q.state === "error" || !nv) {
				const g = this.#ctxs.get(this.#pic(q.from ?? 0)?.ctx ?? -1)?.lastGood;
				if (g) nv = g.data, nw = g.width, nh = g.height;
				else nw ||= 16, nh ||= 16, nv = flatNv12(nw, nh, 128);
			}
			const l = nv12Layout(nw, nh);
			w = nw, h = nh, data = new Uint8Array(w * h * 4);
			nv12ToBgrx(nv, nw, nh, l.pitch, l.offsets[1], data, w, h, q.conv);
		}
		this.#stats.readbacks++;
		this.#stats.bytesRead += data.length;
		this.#reply(m.r, {
			pic: q.pic,
			format: "BGRX",
			width: w,
			height: h,
			pitches: [w * 4],
			offsets: [0],
			...failed ? { failed } : {}
		}, data);
	}
	async #get(m) {
		const p = this.#pics.get(m.pic);
		if (!p || p.surface !== m.surface) return this.#reply(m.r, { err: `no picture ${m.pic} of surface ${m.surface}` });
		const pc = this.#ctxs.get(p.ctx);
		if (p.state === "pending" && pc && this.#isParked(pc, p)) this.#unpark(pc);
		if (p.state === "pending") await new Promise((res) => p.getters.push(res));
		if (this.#pics.get(m.pic) !== p) return this.#reply(m.r, { err: `picture ${m.pic} was freed` });
		if (p.conv) return this.#getBgrx(m, p);
		if (p.held) {
			await this.#copy(p.held);
			if (this.#pics.get(m.pic) !== p) return this.#reply(m.r, { err: `picture ${m.pic} was freed` });
		}
		let data = p.data, w = p.width, h = p.height;
		let failed;
		if (p.state !== "error" && !data && p.spent) {
			p.state = "error";
			p.error = "its frame went to the GPU (video processing) uncopied; frames are copied to NV12 too from now on";
			if (!this.#keepNv12) this.#log(`[host] va: a picture was read back after video processing drew its frame on the GPU: a stand-in for it; this stream's frames are copied to NV12 as well from now on`);
			this.#keepNv12 = true;
		}
		if (p.state === "error") {
			failed = p.error ?? "failed";
			const g = this.#ctxs.get(p.ctx)?.lastGood;
			if (g) data = g.data, w = g.width, h = g.height;
			else data = flatNv12(w || 16, h || 16, 128), w ||= 16, h ||= 16;
		}
		if (!data) return this.#reply(m.r, { err: `picture ${m.pic} was read back already` });
		if (!this.#bound.has(p.surface)) p.data = null;
		const l = nv12Layout(w, h);
		this.#stats.readbacks++;
		this.#stats.bytesRead += data.length;
		this.#reply(m.r, {
			pic: p.pic,
			format: "NV12",
			width: w,
			height: h,
			pitches: [l.pitch, l.pitch],
			offsets: l.offsets,
			...failed ? { failed } : {}
		}, data);
	}
	async #export(m) {
		if (!this.#shared.gpu) return { err: "no zero-copy output on this host (no virtio-gpu device with 3D)" };
		const sid = Number(m.surface), w = Number(m.width), h = Number(m.height), rgb = m.format === "BGRX";
		const res = Array.isArray(m.res) ? m.res.map(Number) : [];
		if (!(w > 0 && h > 0 && w <= 16384 && h <= 16384) || res.length !== (rgb ? 1 : 2) || !res.every((r) => r > 0 && Number.isSafeInteger(r))) return { err: "a bad export" };
		this.#stats.exports++;
		let b = this.#bound.get(sid);
		if (!b || b.y !== res[0] || b.uv !== (res[1] ?? 0) || b.width !== w || b.height !== h || b.rgb !== rgb) {
			if (!b) this.#stats.exported++;
			b = {
				y: res[0],
				uv: res[1] ?? 0,
				width: w,
				height: h,
				pic: -1,
				rgb,
				extent: [w, h]
			};
			this.#bound.set(sid, b);
		}
		const id = this.#surfaces.get(sid);
		const p = id === void 0 ? void 0 : this.#pics.get(id);
		if (!p) {
			if (b.pic !== 0 && !this.#writePlanes(b, flatNv12(w, h, 16), w, h)) return { err: "the renderer has no such resource (or no renderer)" };
			b.pic = 0;
			return {};
		}
		if (p.state !== "pending" && b.pic !== p.pic) {
			if (p.held) await this.#copy(p.held);
			if (!this.#upload(p)) return { err: "the renderer has no such resource (or no renderer)" };
		}
		return {};
	}
	#upload(p) {
		const b = this.#bound.get(p.surface);
		if (!b || b.pic === p.pic || this.#closed) return true;
		if (this.#surfaces.get(p.surface) !== p.pic) return true;
		let data = p.data, w = p.width, h = p.height;
		if (p.state === "error" || !data) {
			const g = this.#ctxs.get(p.ctx)?.lastGood;
			if (p.state !== "error" && !this.#uploadWarned) {
				this.#uploadWarned = true;
				this.#log("[host] va: a picture read back before its surface was exported has no pixels left for the export: grey instead");
			}
			if (p.state === "error" && g) data = g.data, w = g.width, h = g.height;
			else w ||= b.width, h ||= b.height, data = flatNv12(w, h, 128);
		}
		b.pic = p.pic;
		return this.#writePlanes(b, data, w, h, p.conv);
	}
	#vpp(m) {
		const src = this.#pic(Number(m.srcPic));
		const q = this.#newPicture(Number(m.pic), Number(m.surface), 0);
		q.conv = {
			bt601: m.matrix === "bt601",
			inFull: !!m.inFull,
			outFull: m.outFull !== false
		};
		const asked = `${convName({
			bt601: q.conv.bt601,
			full: q.conv.inFull
		})} to ${q.conv.outFull ? "full" : "limited"}-range RGB`;
		if (asked !== this.#vppAsked) this.#log(`[host] va: video processing asked for ${this.#vppAsked = asked}`);
		q.from = Number(m.srcPic);
		if (!src || src.surface !== Number(m.src)) return this.#finish(q, "error", `no picture ${m.srcPic} of surface ${m.src} to process`);
		const done = () => {
			if (this.#pics.get(q.pic) !== q || q.state !== "pending") return;
			if (src.state !== "ready") return this.#finish(q, "error", `its input ${src.error ?? "failed"}`);
			const no = this.#draw(q, src);
			if (!no) return this.#finish(q, "ready");
			this.#cpuWay(no);
			const fill = () => {
				if (this.#pics.get(q.pic) !== q || q.state !== "pending") return;
				q.data = src.data;
				q.width = src.width;
				q.height = src.height;
				this.#finish(q, "ready");
			};
			if (src.held) this.#copy(src.held).then(fill);
			else fill();
		};
		if (src.state === "pending") {
			src.feeds = (src.feeds ?? 0) + 1;
			src.getters.push(() => {
				src.feeds--;
				done();
			});
		} else done();
	}
	#encSource(id, surface, use) {
		const src = this.#pic(id);
		if (!src || src.surface !== surface || src.conv) return use(null);
		const done = () => {
			if (src.state === "ready" && src.held?.frame) return use({
				frame: src.held.frame,
				data: null,
				width: src.width,
				height: src.height
			});
			if (src.state === "ready" && src.data) return use({
				frame: null,
				data: src.data,
				width: src.width,
				height: src.height,
				colorSpace: this.#ctxs.get(src.ctx)?.colour ?? null
			});
			const failed = src.state === "error" ? src.error ?? "failed" : "its pixels were taken (read back, or drawn on the GPU)";
			const g = this.#ctxs.get(src.ctx)?.lastGood;
			if (g) return use({
				frame: null,
				data: g.data,
				width: g.width,
				height: g.height,
				failed
			});
			const w = src.width || 16, h = src.height || 16;
			use({
				frame: null,
				data: flatNv12(w, h, 128),
				width: w,
				height: h,
				failed
			});
		};
		if (src.state !== "pending") return done();
		src.feeds = (src.feeds ?? 0) + 1;
		src.getters.push(() => {
			src.feeds--;
			done();
		});
	}
	#writePlanes(b, nv12, w, h, conv) {
		const gpu = this.#shared.gpu;
		const t = now();
		const { pitch, offsets } = nv12Layout(w, h);
		const sized = (dst, n) => {
			if (dst.length !== n) throw new Error(`resource of ${dst.length} bytes for ${n}: another format`);
		};
		if (b.rgb) {
			let ok = false;
			try {
				ok = gpu.write(b.y, {
					x: 0,
					y: 0,
					width: b.width,
					height: b.height
				}, (dst) => {
					sized(dst, b.width * b.height * 4);
					nv12ToBgrx(nv12, w, h, pitch, offsets[1], dst, b.width, b.height, conv ?? {
						bt601: h < 720,
						inFull: false,
						outFull: true
					});
				});
			} catch {}
			if (ok) {
				b.extent = [Math.min(w, b.width), Math.min(h, b.height)];
				if (conv) {
					this.#stats.cpuConversions++;
					this.#stats.cpuConversionMs += now() - t;
				}
			}
			return this.#counted(b, ok, b.width * b.height * 4, t);
		}
		const plane = (res, pw, ph, bpp, off, rows, rowBytes, fill) => gpu.write(res, {
			x: 0,
			y: 0,
			width: pw,
			height: ph
		}, (dst) => {
			sized(dst, pw * ph * bpp);
			const line = pw * bpp, n = Math.min(rowBytes, line);
			for (let y = 0; y < ph; y++) {
				const o = y * line;
				if (y < rows) {
					dst.set(nv12.subarray(off + y * pitch, off + y * pitch + n), o);
					if (n < line) dst.fill(fill, o + n, o + line);
				} else dst.fill(fill, o, o + line);
			}
		});
		const cw = b.width + 1 >> 1, ch = b.height + 1 >> 1;
		let ok = false;
		try {
			ok = plane(b.y, b.width, b.height, 1, 0, h, w, 16) && plane(b.uv, cw, ch, 2, offsets[1], h + 1 >> 1, (w + 1 >> 1) * 2, 128);
		} catch {}
		return this.#counted(b, ok, b.width * b.height + cw * ch * 2, t);
	}
	#counted(b, ok, bytes, t) {
		if (ok) {
			this.#stats.uploads++;
			this.#stats.uploadBytes += bytes;
			this.#stats.uploadMs += now() - t;
		} else {
			if (!this.#stats.uploadFailed++) this.#log(`[host] va: an exported surface's resources (${b.y}, ${b.uv}) could not be filled: no renderer, or the resources are gone (the app gets an export error or a stale picture)`);
			b.pic = -1;
		}
		return ok;
	}
	reference(resource) {
		for (const b of this.#bound.values()) {
			if (!b.rgb || b.y !== resource || !b.ref) continue;
			const { data, width, height, conv } = b.ref, l = nv12Layout(width, height), out = new Uint8Array(b.width * b.height * 4);
			nv12ToBgrx(data, width, height, l.pitch, l.offsets[1], out, b.width, b.height, conv);
			return {
				width: b.width,
				height: b.height,
				data: out
			};
		}
		return null;
	}
	set big(v) {
		this.#big = v;
	}
	inject(what, count, every) {
		this.#enc?.inject(what, count, every);
		if (!what) this.#injections = [];
		else if (every > 0) this.#injections.push({
			what,
			every,
			left: count,
			n: 0
		});
		else if (what !== "fail") for (const c of this.#ctxs.values()) this.#inject(c, what);
	}
	#inject(c, what) {
		this.#unpark(c);
		const dec = c.decoder;
		if (!dec) return;
		if (what === "flush") return this.#hold(c, true);
		try {
			dec.close();
		} catch {}
		const e = /* @__PURE__ */ new Error(what === "reclaim" ? "Codec reclaimed due to inactivity (test)." : "Decoding error (test).");
		e.name = what === "reclaim" ? "QuotaExceededError" : "EncodingError";
		this.#failed(c, dec, e);
	}
};
var VaHost = class {
	ready;
	#opts;
	#log;
	#listener;
	#conns = /* @__PURE__ */ new Set();
	#sessions = /* @__PURE__ */ new Set();
	#status = {
		state: "idle",
		profiles: [],
		hardware: null,
		support: {},
		broken: [],
		encode: [],
		encodeModes: {},
		error: null
	};
	#probe;
	#big = false;
	#shared = {
		stats: {
			connections: 0,
			opened: 0,
			bytesIn: 0,
			bytesOut: 0,
			decoders: 0,
			pictures: 0,
			hidden: 0,
			frames: 0,
			readbacks: 0,
			bytesRead: 0,
			showExisting: 0,
			failed: 0,
			errors: 0,
			reclaims: 0,
			flushes: 0,
			replays: 0,
			replayed: 0,
			restarts: 0,
			holdFires: 0,
			fillers: 0,
			dropped: 0,
			modeSwitches: 0,
			fallbacks: 0,
			exports: 0,
			exported: 0,
			uploads: 0,
			uploadBytes: 0,
			uploadMs: 0,
			uploadFailed: 0,
			gpuUploads: 0,
			gpuUploadMs: 0,
			cpuConversions: 0,
			cpuConversionMs: 0,
			gpuFallbacks: {},
			copies: 0,
			copyMs: 0,
			framesHeld: 0,
			framesHeldPeak: 0,
			framesEvicted: 0,
			contexts: [],
			encode: encodeStats()
		},
		open: /* @__PURE__ */ new Set(),
		closed: [],
		learned: /* @__PURE__ */ new Set(),
		broken: /* @__PURE__ */ new Set(),
		support: {},
		encOpen: /* @__PURE__ */ new Set(),
		encClosed: []
	};
	#stats = this.#shared.stats;
	#down = false;
	constructor(vsock, opts, log, gpu) {
		this.#opts = opts;
		this.#log = log;
		this.#shared.gpu = gpu;
		this.#listener = vsock.listen(VA_PORT, (conn) => this.#serve(conn));
		const what = `WebCodecs VideoDecoder, asked on the guest's first VA-API connection, on vsock port ${VA_PORT}; ${gpu ? "zero-copy output through virtio-gpu" : "readback only (no virtio-gpu device with 3D)"}`;
		log(`[host] va: ${what}`);
		this.ready = Promise.resolve(what);
	}
	get status() {
		const broken = [...this.#shared.broken];
		return {
			...this.#status,
			profiles: this.#status.profiles.filter((p) => !broken.includes(p)),
			support: { ...this.#status.support },
			broken,
			encode: [...this.#status.encode],
			encodeModes: { ...this.#status.encodeModes }
		};
	}
	get stats() {
		const contexts = [...this.#shared.open, ...this.#shared.closed].map((c) => ({
			...c,
			adapter: { ...c.adapter }
		}));
		const encode = {
			...this.#stats.encode,
			list: [...this.#shared.encOpen, ...this.#shared.encClosed].map((c) => ({ ...c }))
		};
		return {
			...this.#stats,
			gpuFallbacks: { ...this.#stats.gpuFallbacks },
			contexts,
			encode
		};
	}
	reference(resource) {
		for (const s of this.#sessions) {
			const r = s.reference(resource);
			if (r) return r;
		}
		return null;
	}
	setOptions(o) {
		Object.assign(this.#opts, o);
		this.#shared.learned.clear();
	}
	load() {
		return this.#support();
	}
	inject(what, opts = {}) {
		const count = opts.count ?? 1e400, every = opts.every ?? 0;
		if (!what) this.#injections = [];
		else if (every > 0) this.#injections.push({
			what,
			every,
			count
		});
		for (const s of this.#sessions) s.inject(what, count, every);
	}
	#injections = [];
	#support() {
		this.#probe ??= (async () => {
			const wc = webCodecs();
			try {
				if (!wc) throw new Error("no VideoDecoder");
				const hw = this.#opts.hardwareAcceleration ?? "no-preference";
				const ask = (cfg, w, h, a) => wc.VideoDecoder.isConfigSupported({
					...cfg,
					codedWidth: w,
					codedHeight: h,
					optimizeForLatency: true,
					hardwareAcceleration: a
				}).then((s) => !!s.supported, () => false);
				const encoders = probeEncoders(encWebCodecs(), hw);
				const res = await Promise.all(CODECS.map(async (k) => {
					let a = null;
					try {
						a = k.create({
							width: 1920,
							height: 1080,
							log: () => {},
							conservative: false,
							holdExtra: 0
						});
					} catch {}
					const cfgs = a?.probe ? Array.from({ length: a.variants ?? 1 }, (_, i) => a.probe(i)) : [{ codec: k.probe }];
					const any = async (w, h, acc) => (await Promise.all(cfgs.map((c) => ask(c, w, h, acc)))).some(Boolean);
					const [hd, uhd, hard, soft] = await Promise.all([
						any(1920, 1080, hw),
						any(3840, 2160, hw),
						any(1920, 1080, "prefer-hardware"),
						any(1920, 1080, "prefer-software")
					]);
					return {
						k,
						hd: hd && !!a,
						uhd,
						hard,
						soft
					};
				}));
				const offered = res.filter((r) => r.hd);
				this.#big = offered.length > 0 && offered.every((r) => r.uhd);
				const support = {};
				for (const r of res) support[r.k.profile] = {
					hardware: r.hard,
					software: r.soft
				};
				this.#shared.support = support;
				const enc = await encoders;
				this.#status = {
					state: "ready",
					profiles: offered.map((r) => r.k.profile),
					hardware: offered.some((r) => r.hard),
					support,
					broken: [],
					encode: enc.profiles,
					encodeModes: enc.modes,
					error: null
				};
				if (enc.profiles.length) this.#log(`[host] va: WebCodecs encodes ${enc.profiles.map((p) => `${ENCODERS.find((k) => k.profile === p)?.label ?? p} (${enc.modes[p].join(", ")}${enc.support[p]?.hardware ? "; hardware offered" : ""})`).join(", ")}`);
				this.#log(`[host] va: WebCodecs decodes ${offered.length ? offered.map((r) => `${r.k.label}${r.hard ? " (hardware offered)" : ""}`).join(", ") + (this.#big ? " up to 4K" : " up to 1080p") : "none of the offered profiles"}`);
			} catch (e) {
				this.#status = {
					state: "failed",
					profiles: [],
					hardware: null,
					support: {},
					broken: [],
					encode: [],
					encodeModes: {},
					error: why(e)
				};
			}
			return this.#status;
		})();
		return this.#probe;
	}
	#serve(conn) {
		const wc = webCodecs();
		if (this.#down || !wc) {
			conn.reset();
			return;
		}
		this.#conns.add(conn);
		this.#stats.connections++;
		this.#stats.opened++;
		const writer = conn.writable.getWriter();
		const stats = this.#stats;
		let broken = false;
		const fail = (what, e) => {
			if (broken) return;
			broken = true;
			if (!this.#down) this.#log(`[host] va: ${what}: ${why(e)}`);
			conn.reset();
		};
		let last = Promise.resolve();
		const send = (bytes) => {
			stats.bytesOut += bytes.length;
			last = writer.write(bytes);
			last.catch((e) => fail("a write to the guest failed", e));
		};
		const session = new VaSession(wc, send, () => this.#support().then(() => (session.big = this.#big, this.status)), this.#opts, this.#shared, this.#log);
		this.#sessions.add(session);
		for (const j of this.#injections) session.inject(j.what, j.count, j.every);
		const run = async () => {
			const reader = conn.readable.getReader();
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				stats.bytesIn += value.length;
				try {
					session.feed(value);
				} catch (e) {
					session.lost(why(e));
					await last.catch(() => {});
					throw e;
				}
			}
		};
		run().catch((e) => fail("the stream ended", e)).finally(() => {
			session.close();
			this.#sessions.delete(session);
			if (!broken) writer.close().catch(() => {});
			this.#conns.delete(conn);
			this.#stats.connections--;
		});
	}
	shutdown() {
		this.#down = true;
		this.#listener?.close();
		for (const c of this.#conns) c.reset();
	}
};
const KWSPARSE_MAGIC = "KWSPARS1";
const HEADER = 24;
function isZeroBlock(b) {
	if ((b.byteOffset & 3) === 0 && (b.length & 3) === 0) {
		const w = new Uint32Array(b.buffer, b.byteOffset, b.length >> 2);
		for (let i = 0; i < w.length; i++) if (w[i]) return false;
		return true;
	}
	for (let i = 0; i < b.length; i++) if (b[i]) return false;
	return true;
}
function kwsparseHeader(size, blockSize, indices) {
	const out = new Uint8Array(HEADER + 8 * indices.length);
	const dv = new DataView(out.buffer);
	for (let i = 0; i < 8; i++) out[i] = KWSPARSE_MAGIC.charCodeAt(i);
	dv.setBigUint64(8, BigInt(size), true);
	dv.setUint32(16, blockSize, true);
	dv.setUint32(20, indices.length, true);
	let prev = -1;
	indices.forEach((b, i) => {
		if (!(b > prev) || !Number.isSafeInteger(b) || (b + 1) * blockSize > size) throw new Error(`kwsparse: bad block index ${b}`);
		prev = b;
		dv.setBigUint64(HEADER + 8 * i, BigInt(b), true);
	});
	return out;
}
function encodeKwsparse({ size, blockSize = 4096, blocks }) {
	const list = [...blocks].filter(([, d]) => {
		if (d.length !== blockSize) throw new Error(`kwsparse: block of ${d.length} bytes, expected ${blockSize}`);
		return !isZeroBlock(d);
	}).sort((a, b) => a[0] - b[0]);
	const head = kwsparseHeader(size, blockSize, list.map(([b]) => b));
	const out = new Uint8Array(head.length + list.length * blockSize);
	out.set(head);
	list.forEach(([, d], i) => out.set(d, head.length + i * blockSize));
	return out;
}
function decodeKwsparse(bytes) {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	if (u8.length < HEADER) throw new Error("kwsparse: truncated header");
	for (let i = 0; i < 8; i++) if (u8[i] !== "KWSPARS1".charCodeAt(i)) throw new Error("not a kwsparse image (bad magic)");
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	const size = Number(dv.getBigUint64(8, true));
	const blockSize = dv.getUint32(16, true);
	const n = dv.getUint32(20, true);
	if (!blockSize || blockSize & blockSize - 1 || blockSize < 512) throw new Error(`kwsparse: bad block size ${blockSize}`);
	const dataAt = HEADER + 8 * n;
	if (u8.length !== dataAt + n * blockSize) throw new Error(`kwsparse: ${u8.length} bytes, expected ${dataAt + n * blockSize} for ${n} blocks`);
	const indices = new Array(n);
	let prev = -1;
	for (let i = 0; i < n; i++) {
		const b = Number(dv.getBigUint64(HEADER + 8 * i, true));
		if (!(b > prev) || (b + 1) * blockSize > size) throw new Error(`kwsparse: bad or unsorted block index ${b}`);
		indices[i] = prev = b;
	}
	const data = u8.subarray(dataAt);
	const block = (i) => data.subarray(i * blockSize, (i + 1) * blockSize);
	return {
		size,
		blockSize,
		indices,
		data,
		block,
		map: () => new Map(indices.map((b, i) => [b, block(i)]))
	};
}
const isGzip = (u8) => u8.length >= 2 && u8[0] === 31 && u8[1] === 139;
async function gunzipIfNeeded(bytes) {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	if (!isGzip(u8)) return u8;
	const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function readKwsparse(bytes) {
	return decodeKwsparse(await gunzipIfNeeded(bytes));
}
function gzipBlob(parts) {
	return new Response(new Blob(parts).stream().pipeThrough(new CompressionStream("gzip"))).blob();
}
const OP_READ = 0;
const OP_WRITE = 1;
const OP_FLUSH = 2;
const OP_DISCARD = 3;
const OP_WRITE_ZEROES = 4;
const F_RO = 1;
const F_FLUSH = 2;
const F_DISCARD = 4;
const F_WRITE_ZEROES = 8;
const MAX_DEVS = 16;
const REQ_STATUS = 28;
const REQ_SEGS = 32;
function scatter(views, src) {
	let o = 0;
	for (const v of views) {
		v.set(src.subarray(o, o + v.length));
		o += v.length;
	}
}
function gather(views) {
	if (views.length === 1) return views[0].slice();
	let n = 0;
	for (const v of views) n += v.length;
	const out = new Uint8Array(n);
	let o = 0;
	for (const v of views) {
		out.set(v, o);
		o += v.length;
	}
	return out;
}
var BlockHost = class {
	k;
	disks;
	done;
	inflight;
	stats;
	constructor(kernel, disks = []) {
		this.k = kernel;
		this.disks = disks.slice(0, MAX_DEVS);
		this.done = [];
		this.inflight = 0;
		this.stats = {
			reads: 0,
			writes: 0,
			flushes: 0,
			discards: 0,
			async: 0,
			bytesRead: 0,
			bytesWritten: 0
		};
	}
	imports() {
		const h = this;
		return {
			wasm_driver_block_info(dev, info) {
				const d = h.disks[dev];
				if (!d) return -19;
				const dv = h.k.dv();
				const p = Number(info);
				let flags = d.flags ?? 0;
				if (d.readOnly) flags |= 1;
				dv.setBigUint64(p, BigInt(d.size), true);
				dv.setUint32(p + 8, flags, true);
				dv.setUint32(p + 12, d.blockSize ?? 512, true);
				return 0;
			},
			wasm_driver_block_submit: (req) => h.submit(req),
			wasm_driver_block_reap: () => h.done.length ? h.done.shift() : 0n
		};
	}
	submit(reqPtr) {
		const dv = this.k.dv();
		const p = Number(reqPtr);
		const dev = dv.getUint32(p, true);
		const op = dv.getUint32(p + 4, true);
		const off = Number(dv.getBigUint64(p + 8, true)) * 512;
		const bytes = Number(dv.getBigUint64(p + 16, true));
		const nseg = dv.getUint32(p + 24, true);
		const d = this.disks[dev];
		if (!d) return -19;
		if (op !== OP_FLUSH && off + bytes > d.size) return -5;
		const views = [];
		if (op === OP_READ || op === OP_WRITE) {
			const u8 = this.k.u8();
			for (let i = 0; i < nseg; i++) {
				const a = Number(dv.getBigUint64(p + REQ_SEGS + 16 * i, true));
				const l = Number(dv.getBigUint64(p + REQ_SEGS + 16 * i + 8, true));
				views.push(u8.subarray(a, a + l));
			}
		}
		let r;
		try {
			switch (op) {
				case OP_READ:
					this.stats.reads++;
					this.stats.bytesRead += bytes;
					r = d.read(off, views);
					break;
				case OP_WRITE:
					if (d.readOnly) return -30;
					this.stats.writes++;
					this.stats.bytesWritten += bytes;
					r = d.write(off, views);
					break;
				case OP_FLUSH:
					this.stats.flushes++;
					r = d.flush?.();
					break;
				case OP_DISCARD:
					this.stats.discards++;
					if (!d.discard) return -95;
					r = d.discard(off, bytes);
					break;
				case OP_WRITE_ZEROES:
					if (!d.writeZeroes) return -95;
					r = d.writeZeroes(off, bytes);
					break;
				default: return -95;
			}
		} catch (e) {
			this.k.log(`[host] block: wd${String.fromCharCode(97 + dev)} op ${op} @${off}+${bytes}: ${e?.message ?? e}`);
			return -5;
		}
		if (!(r instanceof Promise)) return 0;
		this.stats.async++;
		this.inflight++;
		r.then(() => 0, (e) => {
			this.k.log(`[host] block: wd${String.fromCharCode(97 + dev)} op ${op} @${off}+${bytes}: ${e?.message ?? e}`);
			return -5;
		}).then((status) => {
			this.inflight--;
			this.k.dv().setInt32(p + REQ_STATUS, status, true);
			this.done.push(BigInt(p));
			this.raise();
		});
		return 1;
	}
	raise() {
		const k = this.k;
		if (k.irqAddr === void 0) return;
		k.setIrqBits(8);
		k.wake();
	}
};
var FlushTracker = class {
	flushSeq = 0;
	flushedSeq = 0;
	waiters = [];
	begin() {
		return ++this.flushSeq;
	}
	done(seq) {
		if (seq <= this.flushedSeq) return;
		this.flushedSeq = seq;
		this.waiters = this.waiters.filter((w) => w.after < seq ? (w.resolve(), false) : true);
	}
	whenFlushed(after) {
		if (this.flushedSeq > after) return Promise.resolve();
		return new Promise((resolve) => this.waiters.push({
			after,
			resolve
		}));
	}
};
const BLOCK = 4096;
const ZERO_BLOCK = /* @__PURE__ */ new Uint8Array(0);
const ZERO = ZERO_BLOCK;
var ZeroBase = class {
	size;
	zero = true;
	identity = "";
	constructor(size) {
		this.size = size;
	}
	read(_off, len) {
		return new Uint8Array(len);
	}
};
var SparseBase = class SparseBase {
	size;
	blocks;
	identity = "";
	constructor(size, blocks) {
		this.size = size;
		this.blocks = blocks;
	}
	static fromKwsparse(img) {
		if (img.blockSize !== BLOCK) throw new Error(`kwsparse block size ${img.blockSize}, need ${BLOCK}`);
		return new SparseBase(img.size, img.map());
	}
	read(off, len) {
		const out = new Uint8Array(len);
		const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + len - 1) / BLOCK);
		for (let b = b0; b <= b1; b++) {
			const blk = this.blocks.get(b);
			if (!blk || !blk.length) continue;
			const s = Math.max(off, b * BLOCK), e = Math.min(off + len, (b + 1) * BLOCK);
			out.set(blk.subarray(s - b * BLOCK, e - b * BLOCK), s - off);
		}
		return out;
	}
	keys() {
		return [...this.blocks.keys()].sort((a, b) => a - b);
	}
};
function copyPart(out, off, blk, b, s, e) {
	if (blk === ZERO || !blk.length) out.fill(0, s - off, e - off);
	else out.set(blk.subarray(s - b * BLOCK, e - b * BLOCK), s - off);
}
var CowDisk = class CowDisk {
	base;
	size;
	flags;
	store;
	log;
	onError;
	mem = /* @__PURE__ */ new Map();
	stored = /* @__PURE__ */ new Set();
	dirty = /* @__PURE__ */ new Set();
	frozen = /* @__PURE__ */ new WeakSet();
	loading = /* @__PURE__ */ new Map();
	ahead = /* @__PURE__ */ new Map();
	aheadPending = /* @__PURE__ */ new Set();
	#raEnd = -2;
	#raSize = 0;
	busy = /* @__PURE__ */ new Map();
	saving = null;
	saveDisabled = false;
	flushes = new FlushTracker();
	stats = {
		storeReads: 0,
		storeBlocksRead: 0,
		aheadBlocks: 0,
		aheadHits: 0,
		saves: 0,
		blocksSaved: 0,
		blocksDeleted: 0,
		rmw: 0,
		saveErrors: 0
	};
	notice;
	seeded = false;
	identity;
	gen = 0;
	storedGen = 0;
	storeUid;
	storeIdentity;
	#sealed = true;
	constructor(base, { store = null, log, onError } = {}) {
		this.base = base;
		this.size = base.size;
		this.flags = 14;
		this.store = store;
		this.log = log ?? ((m) => console.warn(m));
		this.onError = onError ?? null;
	}
	async open({ onMismatch = "clear" } = {}) {
		if (!this.store) return this;
		const st = await this.store.open(this.base.identity ?? "", { onMismatch });
		if (st.mismatch !== void 0) {
			const e = /* @__PURE__ */ new Error(`saved data belongs to "${st.mismatch}", expected "${this.base.identity ?? ""}"`);
			e.name = "StoreMismatchError";
			throw e;
		}
		this.adoptStore(st, this.base.identity ?? "");
		return this;
	}
	adoptStore(st, identity) {
		this.stored = st.keys;
		this.gen = this.storedGen = st.gen ?? 0;
		this.storeUid = st.uid;
		this.storeIdentity = identity;
	}
	get persistent() {
		return !!this.store && !this.saveDisabled;
	}
	get flushSeq() {
		return this.flushes.flushSeq;
	}
	whenFlushed(after) {
		return this.flushes.whenFlushed(after);
	}
	get overlayBlocks() {
		let n = this.stored.size;
		for (const b of this.mem.keys()) if (!this.stored.has(b)) n++;
		return n;
	}
	get memBytes() {
		let n = 0;
		for (const v of this.mem.values()) n += v.length;
		return n;
	}
	read(off, views) {
		const len = views.reduce((n, v) => n + v.length, 0);
		const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + len - 1) / BLOCK);
		const out = new Uint8Array(len);
		const fromStore = [], fromBase = [];
		for (let b = b0; b <= b1; b++) {
			const blk = this.mem.get(b) ?? this.#takeAhead(b);
			const s = Math.max(off, b * BLOCK), e = Math.min(off + len, (b + 1) * BLOCK);
			if (blk) copyPart(out, off, blk, b, s, e);
			else if (this.stored.has(b)) fromStore.push(b);
			else fromBase.push(b);
		}
		const waits = [];
		if (fromStore.length) waits.push(this.#loadAhead(fromStore).then((m) => {
			for (const b of fromStore) {
				const s = Math.max(off, b * BLOCK), e = Math.min(off + len, (b + 1) * BLOCK);
				copyPart(out, off, m.get(b), b, s, e);
			}
		}));
		if (fromBase.length) {
			const lo = Math.max(off, fromBase[0] * BLOCK), hi = Math.min(off + len, (fromBase.at(-1) + 1) * BLOCK);
			const put = (buf) => {
				for (const b of fromBase) {
					const s = Math.max(off, b * BLOCK), e = Math.min(off + len, (b + 1) * BLOCK);
					out.set(buf.subarray(s - lo, e - lo), s - off);
				}
			};
			const r = this.base.read(lo, hi - lo);
			if (r instanceof Promise) waits.push(r.then(put));
			else put(r);
		}
		if (!waits.length) return scatter(views, out);
		return Promise.all(waits).then(() => scatter(views, out));
	}
	#load(blocks) {
		const want = blocks.filter((b) => !this.loading.has(b));
		if (want.length) {
			this.stats.storeReads++;
			this.stats.storeBlocksRead += want.length;
			const p = this.store.getBlocks(want);
			for (const b of want) {
				const one = p.then((m) => {
					const v = m.get(b);
					if (v === void 0) throw new Error(`block ${b} is missing from the store`);
					return v.length ? v : ZERO;
				});
				one.catch(() => {});
				this.loading.set(b, one);
				const clear = () => {
					if (this.loading.get(b) === one) this.loading.delete(b);
				};
				one.then(clear, clear);
			}
		}
		return Promise.all(blocks.map((b) => this.loading.get(b))).then((vals) => new Map(blocks.map((b, i) => [b, vals[i]])));
	}
	static RA_MIN = 8;
	static RA_MAX = 128;
	static AHEAD_MAX = 1024;
	#takeAhead(b) {
		const v = this.ahead.get(b);
		if (v === void 0) return void 0;
		this.ahead.delete(b);
		this.stats.aheadHits++;
		return v;
	}
	#dropAhead(b) {
		this.ahead.delete(b);
		this.aheadPending.delete(b);
	}
	#loadAhead(blocks) {
		const first = blocks[0], last = blocks.at(-1);
		const seq = first > this.#raEnd - this.#raSize && first <= this.#raEnd + 1;
		this.#raSize = seq ? Math.min(this.#raSize * 2, CowDisk.RA_MAX) : CowDisk.RA_MIN;
		this.#raEnd = Math.min(last + this.#raSize, Math.ceil(this.size / BLOCK) - 1);
		const extra = [];
		for (let b = last + 1; b <= this.#raEnd; b++) if (this.stored.has(b) && !this.mem.has(b) && !this.ahead.has(b) && !this.aheadPending.has(b) && !this.loading.has(b)) extra.push(b);
		if (!extra.length) return this.#load(blocks);
		for (const b of extra) this.aheadPending.add(b);
		this.stats.aheadBlocks += extra.length;
		const all = this.#load([...blocks, ...extra]);
		all.then((m) => {
			for (const b of extra) {
				if (!this.aheadPending.delete(b)) continue;
				this.ahead.set(b, m.get(b));
			}
			for (const b of this.ahead.keys()) {
				if (this.ahead.size <= CowDisk.AHEAD_MAX) break;
				this.ahead.delete(b);
			}
		}, () => {
			for (const b of extra) this.aheadPending.delete(b);
		});
		return all;
	}
	#serial(b0, b1, fn) {
		const waits = [];
		for (let b = b0; b <= b1; b++) {
			const p = this.busy.get(b);
			if (p && waits.at(-1) !== p) waits.push(p);
		}
		const r = waits.length ? Promise.all(waits).then(fn) : fn();
		if (r instanceof Promise) {
			const tail = r.then(() => {}, () => {});
			for (let b = b0; b <= b1; b++) this.busy.set(b, tail);
			tail.then(() => {
				for (let b = b0; b <= b1; b++) if (this.busy.get(b) === tail) this.busy.delete(b);
			});
		}
		return r;
	}
	#touch() {
		if (!this.#sealed) return;
		this.#sealed = false;
		this.gen++;
	}
	write(off, views) {
		this.#touch();
		const data = gather(views);
		const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + data.length - 1) / BLOCK);
		return this.#serial(b0, b1, () => this.#writeNow(off, data));
	}
	#writeNow(off, data) {
		const len = data.length;
		const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + len - 1) / BLOCK);
		const partial = [];
		for (let b = b0; b <= b1; b++) {
			const s = Math.max(off, b * BLOCK), e = Math.min(off + len, (b + 1) * BLOCK);
			if (e - s === BLOCK || this.mem.has(b)) this.#put(b, data.subarray(s - off, e - off), s - b * BLOCK);
			else partial.push([
				b,
				s,
				e
			]);
		}
		if (!partial.length) return;
		this.stats.rmw += partial.length;
		const pending = [];
		for (const [b, s, e] of partial) {
			const apply = (cur) => {
				if (!this.mem.has(b)) this.mem.set(b, cur);
				this.#put(b, data.subarray(s - off, e - off), s - b * BLOCK);
			};
			const r = this.#current(b);
			if (r instanceof Promise) pending.push(r.then(apply));
			else apply(r);
		}
		if (pending.length) return Promise.all(pending);
	}
	#current(b) {
		const fresh = (src) => {
			const blk = new Uint8Array(BLOCK);
			if (src !== ZERO) blk.set(src);
			return blk;
		};
		const ahead = this.#takeAhead(b);
		if (ahead) return fresh(ahead);
		if (this.stored.has(b)) return this.#load([b]).then((m) => fresh(m.get(b)));
		const r = this.base.read(b * BLOCK, Math.min(BLOCK, this.size - b * BLOCK));
		return r instanceof Promise ? r.then(fresh) : fresh(r);
	}
	#put(b, src, at) {
		let blk = this.mem.get(b);
		if (src.length === BLOCK) {
			if (!blk || blk === ZERO || this.frozen.has(blk)) blk = new Uint8Array(BLOCK);
		} else if (blk === void 0) throw new Error("internal: partial put of a block not in memory");
		else if (blk === ZERO) blk = new Uint8Array(BLOCK);
		else if (this.frozen.has(blk)) blk = blk.slice();
		blk.set(src, at);
		this.mem.set(b, blk);
		this.dirty.add(b);
		this.loading.delete(b);
		this.#dropAhead(b);
	}
	#zero(b) {
		this.#dropAhead(b);
		const cur = this.mem.get(b);
		if (this.base.zero && !this.stored.has(b) && !(cur && this.frozen.has(cur))) {
			this.mem.delete(b);
			this.dirty.delete(b);
			return;
		}
		this.mem.set(b, ZERO);
		this.dirty.add(b);
		this.loading.delete(b);
	}
	discard(off, len) {
		return this.writeZeroes(off, len);
	}
	writeZeroes(off, len) {
		this.#touch();
		const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + len - 1) / BLOCK);
		return this.#serial(b0, b1, () => {
			const f0 = Math.ceil(off / BLOCK), f1 = Math.floor((off + len) / BLOCK);
			if (f0 >= f1) return this.#writeNow(off, new Uint8Array(len));
			for (let b = f0; b < f1; b++) this.#zero(b);
			const ps = [];
			if (off < f0 * BLOCK) ps.push(this.#writeNow(off, new Uint8Array(f0 * BLOCK - off)));
			if (off + len > f1 * BLOCK) ps.push(this.#writeNow(f1 * BLOCK, new Uint8Array(off + len - f1 * BLOCK)));
			const p = ps.filter((x) => x instanceof Promise);
			if (p.length) return Promise.all(p);
		});
	}
	flush() {
		const seq = this.flushes.begin();
		if (!this.store || this.saveDisabled || !this.saving && !this.#pending()) {
			this.flushes.done(seq);
			return;
		}
		return this.#chain(() => this.#commit(this.#take())).then(() => this.flushes.done(seq));
	}
	#pending() {
		return this.dirty.size > 0 || this.gen !== this.storedGen;
	}
	#chain(fn) {
		const p = (this.saving ?? Promise.resolve()).catch(() => {}).then(fn);
		this.saving = p;
		const clear = () => {
			if (this.saving === p) this.saving = null;
		};
		p.then(clear, clear);
		return p;
	}
	#take() {
		const entries = [];
		for (const b of this.dirty) {
			const v = this.mem.get(b);
			entries.push([b, v]);
			if (v !== ZERO) this.frozen.add(v);
		}
		this.dirty.clear();
		return {
			entries,
			gen: this.gen
		};
	}
	async #commit({ entries, gen }) {
		if (!this.store || this.saveDisabled || !entries.length && gen === this.storedGen) return;
		const puts = [], dels = [];
		for (const [b, v] of entries) if (v === ZERO && this.base.zero) dels.push(b);
		else puts.push([b, v]);
		try {
			await this.store.save(puts, dels, gen !== this.storedGen ? { gen } : void 0);
		} catch (e) {
			this.stats.saveErrors++;
			for (const [b, v] of entries) {
				if (this.mem.get(b) === v) this.dirty.add(b);
				if (v !== ZERO) this.frozen.delete(v);
			}
			const err = e;
			this.log(`[host] block: saving ${entries.length} blocks failed: ${err?.name ?? ""} ${err?.message ?? e}`);
			try {
				this.onError?.(e);
			} catch {}
			throw e;
		}
		if (gen > this.storedGen) this.storedGen = gen;
		this.stats.saves++;
		this.stats.blocksSaved += puts.length;
		this.stats.blocksDeleted += dels.length;
		for (const [b, v] of entries) {
			if (v === ZERO && this.base.zero) this.stored.delete(b);
			else this.stored.add(b);
			if (v !== ZERO) this.frozen.delete(v);
			this.loading.delete(b);
			if (!this.dirty.has(b) && this.mem.get(b) === v) this.mem.delete(b);
		}
	}
	snapshotState() {
		if (this.persistent) {
			const name = this.store.name ?? "store";
			return {
				name,
				identity: `store ${name} ${this.storeIdentity ?? ""} uid=${this.storeUid ?? "-"}`,
				gen: this.gen
			};
		}
		const name = this.base.identity || "an in-memory disk";
		if (this.gen || this.mem.size) throw new Error(`${name} keeps its writes in memory only, and a snapshot does not save them`);
		if (!this.base.identity) throw new Error("its base image has no identity to check on restore");
		return {
			name,
			identity: `base ${this.base.identity}`,
			gen: 0
		};
	}
	snapshotSeal() {
		const state = this.snapshotState();
		if (!this.persistent) return {
			state,
			done: Promise.resolve()
		};
		if (this.saving) throw new Error(`${state.name}: a save is in flight`);
		const taken = this.#take();
		this.#sealed = true;
		return {
			state,
			done: this.#chain(() => this.#commit(taken))
		};
	}
	detach() {
		this.saveDisabled = true;
	}
	async reset() {
		this.mem.clear();
		this.dirty.clear();
		this.stored.clear();
		this.ahead.clear();
		this.aheadPending.clear();
		if (this.store) await this.store.clear();
	}
	async exportParts({ batch = 256 } = {}) {
		if (!this.base.zero && !this.base.keys) throw new Error("export needs a zero or sparse base");
		const sorted = [.../* @__PURE__ */ new Set([
			...this.base.keys?.() ?? [],
			...this.stored,
			...this.mem.keys()
		])].sort((a, b) => a - b);
		const indices = [], parts = [];
		for (let i = 0; i < sorted.length; i += batch) {
			const part = sorted.slice(i, i + batch);
			const vals = /* @__PURE__ */ new Map();
			const fromStore = [];
			for (const b of part) {
				const m = this.mem.get(b);
				if (m) vals.set(b, m === ZERO ? m : m.slice());
				else if (this.stored.has(b)) fromStore.push(b);
				else vals.set(b, this.base.read(b * BLOCK, BLOCK));
			}
			if (fromStore.length) for (const [b, v] of await this.#load(fromStore)) vals.set(b, v);
			const list = [];
			for (const b of part) {
				const v = vals.get(b);
				if (!v || v === ZERO || !v.length || isZeroBlock(v)) continue;
				indices.push(b);
				list.push(v);
			}
			if (list.length) parts.push(new Blob(list));
		}
		const head = kwsparseHeader(this.size, BLOCK, indices);
		return {
			size: this.size,
			blocks: indices.length,
			parts: [head, ...parts]
		};
	}
};
const HEADER_MAGIC = "KWDISTRO";
const totalOf = (r) => {
	const m = /\/(\d+)\s*$/.exec(r.headers.get("content-range") ?? "");
	return m ? Number(m[1]) : void 0;
};
function readDistroHeader(head, size) {
	if (head.length < 128) return null;
	for (let i = 0; i < 8; i++) if (head[i] !== HEADER_MAGIC.charCodeAt(i)) return null;
	const dv = new DataView(head.buffer, head.byteOffset, 128);
	const hlen = dv.getUint32(12, true);
	if (dv.getUint32(8, true) !== 1 || hlen < 128) return null;
	const n = Number(dv.getBigUint64(16, true)), prefetch = Math.min(Number(dv.getBigUint64(24, true)), n);
	if (size !== void 0 && n !== size) return null;
	const bg = hlen >= 136 && head.length >= 136 ? Math.min(Number(new DataView(head.buffer, head.byteOffset, 136).getBigUint64(128, true)), n) : 0;
	const str = (b) => new TextDecoder().decode(b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)));
	return {
		size: n,
		prefetch,
		background: bg > prefetch ? bg : 0,
		distro: str(head.subarray(32, 64)),
		image: str(head.subarray(64, 128))
	};
}
var HttpBase = class HttpBase {
	url = "";
	size = 0;
	identity = "";
	chunkSize = 0;
	maxChunks = 0;
	chunks = /* @__PURE__ */ new Map();
	pending = /* @__PURE__ */ new Map();
	#reads = 0;
	stats = {
		requests: 0,
		bytes: 0,
		lazyRequests: 0,
		prefetch: 0,
		prefetchBytes: 0,
		prefetchState: "none",
		background: 0,
		backgroundBytes: 0,
		backgroundState: "none",
		aheadRequests: 0,
		aheadBytes: 0
	};
	validator = null;
	header = null;
	log = (m) => console.warn(m);
	static async open(url, { chunkSize = 262144, maxRequest = 4194304, readAhead = 4194304, strict = false, prefetch, background, log } = {}) {
		const r = await fetch(url, {
			headers: { range: `bytes=0-${chunkSize - 1}` },
			cache: "no-cache"
		});
		if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
		const cr = r.headers.get("content-range");
		const m = cr && /\/(\d+)\s*$/.exec(cr);
		if (r.status !== 206 || !m) {
			r.body?.cancel().catch(() => {});
			throw new Error(`${url}: server does not support Range requests`);
		}
		const head = new Uint8Array(await r.arrayBuffer());
		const b = new HttpBase();
		b.url = url;
		b.size = Number(m[1]);
		if (log) b.log = log;
		const validator = r.headers.get("etag") ?? r.headers.get("last-modified") ?? "";
		b.identity = `${url} ${b.size} ${validator}`;
		if (strict) b.validator = validator;
		b.#seen = validator;
		b.chunkSize = chunkSize;
		b.maxChunks = Math.max(1, Math.floor(maxRequest / chunkSize));
		b.#aheadMax = readAhead ? Math.max(1, Math.floor(readAhead / chunkSize)) : 0;
		b.stats.requests++;
		b.stats.bytes += head.length;
		if (head.length === Math.min(chunkSize, b.size)) {
			let c0 = head;
			if (c0.length < chunkSize) {
				c0 = new Uint8Array(chunkSize);
				c0.set(head);
			}
			b.chunks.set(0, c0);
		}
		b.header = readDistroHeader(head, b.size);
		const n = prefetch === false ? 0 : Math.min(b.size, Math.max(0, prefetch ?? b.header?.prefetch ?? 0));
		const boot = n > 0 ? b.#prefetch(n, validator) : Promise.resolve();
		const bg = background === false || prefetch === false && background === void 0 ? 0 : Math.min(b.size, Math.max(0, background ?? b.header?.background ?? 0));
		if (bg > n) b.#background(n, bg, validator, boot);
		return b;
	}
	read(off, len) {
		this.#reads++;
		const cs = this.chunkSize;
		const c0 = Math.floor(off / cs), c1 = Math.floor((off + len - 1) / cs);
		const waits = [];
		let runStart = -1, miss = -1;
		const flushRun = (end) => {
			if (runStart >= 0) waits.push(this.#fetchRun(runStart, end));
			runStart = -1;
		};
		for (let c = c0; c <= c1; c++) {
			if (this.chunks.has(c)) {
				flushRun(c);
				continue;
			}
			const p = this.pending.get(c);
			if (p) {
				flushRun(c);
				waits.push(p);
				continue;
			}
			if (runStart < 0) runStart = c;
			if (miss < 0) miss = c;
			if (c - runStart + 1 >= this.maxChunks) flushRun(c + 1);
		}
		flushRun(c1 + 1);
		if (this.#aheadMax) this.#readAhead(miss, c1);
		const assemble = () => {
			if (c0 === c1) {
				const s = off - c0 * cs;
				return this.chunks.get(c0).subarray(s, s + len);
			}
			const out = new Uint8Array(len);
			for (let c = c0; c <= c1; c++) {
				const s = Math.max(off, c * cs), e = Math.min(off + len, (c + 1) * cs);
				out.set(this.chunks.get(c).subarray(s - c * cs, e - c * cs), s - off);
			}
			return out;
		};
		if (!waits.length) return assemble();
		return Promise.all(waits).then(() => {
			for (let c = c0; c <= c1; c++) if (!this.chunks.has(c)) return this.read(off, len);
			return assemble();
		});
	}
	#check(r, total, what, validator = this.validator) {
		const v = r.headers.get("etag") ?? r.headers.get("last-modified") ?? "";
		if ((total === void 0 || total === this.size) && !(validator && v && v !== validator)) return;
		r.body?.cancel().catch(() => {});
		throw new Error(`${this.url}: ${what}: the image changed since it was opened (size ${total ?? "?"}, ${v || "no validator"}; opened as ${this.size}, ${validator || "no validator"})`);
	}
	#seen = "";
	async #get(headers, ok) {
		const init = headers ? { headers } : {};
		if (!this.#seen) {
			const r = await fetch(this.url, init);
			ok(r);
			return r;
		}
		const cached = await fetch(this.url, {
			...init,
			cache: "force-cache"
		});
		try {
			ok(cached);
			return cached;
		} catch {}
		const r = await fetch(this.url, {
			...init,
			cache: "reload"
		});
		ok(r);
		return r;
	}
	#aheadMax = 0;
	#aheadEnd = -1;
	#aheadWin = 0;
	#readAhead(miss, last) {
		const max = this.#aheadMax;
		let from, win;
		if (miss > 0 && (this.chunks.has(miss - 1) || this.pending.has(miss - 1))) {
			win = Math.min(max, miss === this.#aheadEnd ? this.#aheadWin * 2 : 4);
			from = last + 1;
		} else if (miss < 0 && last < this.#aheadEnd && last >= this.#aheadEnd - Math.ceil(this.#aheadWin / 2)) {
			win = Math.min(max, this.#aheadWin * 2);
			from = this.#aheadEnd;
		} else return;
		const n = Math.ceil(this.size / this.chunkSize);
		let to = from;
		while (to < n && to - from < win && !this.chunks.has(to) && !this.pending.has(to)) to++;
		if (to === from) return;
		this.#aheadEnd = to;
		this.#aheadWin = win;
		this.#fetchRun(from, to, true);
	}
	#fetchRun(c0, c1, ahead = false) {
		const cs = this.chunkSize;
		const start = c0 * cs, end = Math.min(this.size, c1 * cs);
		const settle = /* @__PURE__ */ new Map();
		for (let c = c0; c < c1; c++) {
			let ok, fail;
			const p = new Promise((res, rej) => {
				ok = res;
				fail = rej;
			});
			p.catch(() => {});
			settle.set(c, {
				p,
				ok,
				fail
			});
			this.pending.set(c, p);
		}
		const done = (c, err) => {
			const s = settle.get(c);
			if (!s) return;
			settle.delete(c);
			if (this.pending.get(c) === s.p) this.pending.delete(c);
			if (err === void 0 || ahead) s.ok();
			else s.fail(err);
		};
		const what = `${ahead ? "read-ahead" : "range"} ${start}-${end - 1}`;
		let reader;
		return (async () => {
			this.stats.requests++;
			if (ahead) this.stats.aheadRequests++;
			else this.stats.lazyRequests++;
			const r = await this.#get({ range: `bytes=${start}-${end - 1}` }, (r) => {
				if (r.status !== 206) throw new Error(`${this.url}: ${what}: HTTP ${r.status}`);
				if (this.validator !== null || this.#seen) this.#check(r, totalOf(r) ?? -1, what, this.validator ?? this.#seen);
			});
			if (!r.body) throw new Error(`${this.url}: ${what}: no response body`);
			reader = r.body.getReader();
			let pos = start, c = c0, cur = new Uint8Array(cs), fill = 0;
			for (;;) {
				const { done: eof, value } = await reader.read();
				if (eof) break;
				if (pos + value.length > end) throw new Error(`${this.url}: ${what}: longer than asked`);
				let o = 0;
				while (o < value.length) {
					const k = Math.min(cs - fill, value.length - o);
					cur.set(value.subarray(o, o + k), fill);
					fill += k;
					o += k;
					if (fill === cs || pos + o === end) {
						this.#put(c, fill === cs ? cur : cur.subarray(0, fill));
						done(c++);
						cur = new Uint8Array(cs);
						fill = 0;
					}
				}
				pos += value.length;
				this.stats.bytes += value.length;
				if (ahead) this.stats.aheadBytes += value.length;
			}
			if (pos !== end) throw new Error(`${this.url}: ${what}: short range read`);
		})().catch((e) => {
			reader?.cancel().catch(() => {});
			const err = e ?? /* @__PURE__ */ new Error(`${this.url}: ${what} failed`);
			for (const c of [...settle.keys()]) done(c, err);
			if (!ahead) throw err;
			this.log(`[host] ${this.url}: ${what} failed (${e?.message ?? e}); reading lazily`);
		});
	}
	#put(c, data) {
		if (data.length < this.chunkSize) {
			const full = new Uint8Array(this.chunkSize);
			full.set(data);
			data = full;
		}
		this.chunks.set(c, data);
	}
	#prefetch(n, validator) {
		const whole = n >= this.size;
		this.stats.prefetch = whole ? this.size : Math.min(this.size, Math.ceil(n / this.chunkSize) * this.chunkSize);
		this.stats.prefetchState = "running";
		return this.#stream(0, n, validator, "prefetch", (k) => {
			this.stats.prefetchBytes += k;
		}).then(() => {
			this.stats.prefetchState = "done";
		}, (e) => {
			this.stats.prefetchState = "failed";
			this.log(`[host] ${this.url}: prefetch failed (${e?.message ?? e}); reading lazily`);
		});
	}
	async #background(from, to, validator, boot) {
		this.stats.background = to;
		this.stats.backgroundState = "waiting";
		if (globalThis.navigator?.connection?.saveData) {
			this.stats.backgroundState = "skipped";
			return;
		}
		await boot;
		const nap = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
		while (!this.#reads) await nap(250);
		for (let seen = this.stats.requests + this.#reads, quiet = 0; quiet < 1e3;) {
			await nap(250);
			const now = this.stats.requests + this.#reads;
			if (now !== seen || this.pending.size) {
				seen = now;
				quiet = 0;
			} else quiet += 250;
		}
		this.stats.backgroundState = "running";
		const piece = this.maxChunks * this.chunkSize;
		try {
			for (let a = from; a < to; a += piece) await this.#stream(a, Math.min(to, a + piece), validator, "background", (k) => {
				this.stats.backgroundBytes += k;
			});
			this.stats.backgroundState = "done";
		} catch (e) {
			this.stats.backgroundState = "failed";
			this.log(`[host] ${this.url}: background fetch failed (${e?.message ?? e}); reading lazily`);
		}
	}
	async #stream(start, end, validator, what, count) {
		const cs = this.chunkSize, whole = start === 0 && end >= this.size;
		let c0 = Math.floor(start / cs), c1 = Math.ceil(Math.min(end, this.size) / cs);
		if (!whole) {
			while (c0 < c1 && (this.chunks.has(c0) || this.pending.has(c0))) c0++;
			while (c1 > c0 && (this.chunks.has(c1 - 1) || this.pending.has(c1 - 1))) c1--;
		}
		if (c0 >= c1) return;
		const settle = /* @__PURE__ */ new Map();
		for (let c = c0; c < c1; c++) {
			if (this.chunks.has(c) || this.pending.has(c)) continue;
			const p = new Promise((resolve) => settle.set(c, resolve));
			this.pending.set(c, p);
		}
		const done = (c) => {
			const s = settle.get(c);
			if (!s) return;
			settle.delete(c);
			this.pending.delete(c);
			s();
		};
		const from = whole ? 0 : c0 * cs, to = whole ? this.size : Math.min(this.size, c1 * cs);
		let reader;
		try {
			this.stats.requests++;
			const r = await this.#get(whole ? void 0 : { range: `bytes=${from}-${to - 1}` }, (r) => {
				if (whole) {
					if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
					const len = r.headers.get("content-encoding") ? null : r.headers.get("content-length");
					this.#check(r, len === null ? void 0 : Number(len), "GET", validator);
				} else {
					if (r.status !== 206) throw new Error(`HTTP ${r.status}`);
					this.#check(r, totalOf(r) ?? -1, `${what} ${from}-${to - 1}`, validator);
				}
			});
			if (!r.body) throw new Error("no response body");
			reader = r.body.getReader();
			let pos = from, cur = new Uint8Array(cs), fill = 0;
			for (;;) {
				const { done: eof, value } = await reader.read();
				if (eof) break;
				let o = 0;
				while (o < value.length) {
					if (pos + o >= to) throw new Error("longer than expected");
					const k = Math.min(cs - fill, value.length - o, to - pos - o);
					cur.set(value.subarray(o, o + k), fill);
					fill += k;
					o += k;
					const at = pos + o;
					if (fill === cs || at === to) {
						const c = Math.floor((at - 1) / cs);
						if (!this.chunks.has(c)) this.#put(c, fill === cs ? cur : cur.subarray(0, fill));
						done(c);
						cur = new Uint8Array(cs);
						fill = 0;
					}
				}
				pos += value.length;
				this.stats.bytes += value.length;
				count(value.length);
			}
			if (pos !== to) throw new Error(`ended at ${pos} of ${to}`);
		} catch (e) {
			reader?.cancel().catch(() => {});
			throw e;
		} finally {
			for (const c of [...settle.keys()]) done(c);
		}
	}
};
var BaseDisk = class {
	base;
	size;
	readOnly = true;
	flags = 1;
	constructor(base) {
		this.base = base;
		this.size = Math.floor(base.size / 512) * 512;
	}
	get stats() {
		return this.base.stats;
	}
	read(off, views) {
		const len = views.reduce((n, v) => n + v.length, 0);
		const r = this.base.read(off, len);
		return r instanceof Promise ? r.then((buf) => scatter(views, buf)) : scatter(views, r);
	}
	write() {
		throw new Error("read-only disk");
	}
	snapshotState() {
		if (!this.base.identity) throw new Error("its base image has no identity to check on restore");
		return {
			name: this.base.identity,
			identity: `base ${this.base.identity}`,
			gen: 0
		};
	}
	snapshotSeal() {
		return {
			state: this.snapshotState(),
			done: Promise.resolve()
		};
	}
};
const HEAD$1 = 0;
const TAIL = 1;
const WAITING = 2;
const SPACE = 3;
const CLOSED = 4;
const LOCK = 5;
const BATCH = 6;
const BATCHES = 7;
const DROPPED = 8;
const TAKEN = 9;
const CTL_BYTES$1 = 64;
const MAX_BATCHES = 16;
const STALL_MS = 50;
const LAZY_MS = 2;
function newConsoleRing() {
	return new SharedArrayBuffer(262208);
}
var ConsoleRing = class {
	buffer;
	ctl;
	#words;
	#data;
	#cap;
	#maxRecord;
	#lazyBytes;
	#stalledAt = -1;
	constructor(buffer) {
		this.buffer = buffer;
		this.#cap = buffer.byteLength - CTL_BYTES$1;
		if (this.#cap <= 0 || this.#cap & this.#cap - 1) throw new Error(`console ring: bad size ${buffer.byteLength}`);
		this.ctl = new Int32Array(buffer, 0, CTL_BYTES$1 / 4);
		this.#words = new Int32Array(buffer, CTL_BYTES$1, this.#cap / 4);
		this.#data = new Uint8Array(buffer, CTL_BYTES$1, this.#cap);
		this.#maxRecord = this.#cap >> 2;
		this.#lazyBytes = this.#cap >> 3;
	}
	get closed() {
		return Atomics.load(this.ctl, CLOSED) !== 0;
	}
	get dropped() {
		return Atomics.load(this.ctl, DROPPED);
	}
	get used() {
		return this.ctl[HEAD$1] - this.ctl[TAIL] | 0;
	}
	get quiet() {
		const c = this.ctl;
		return Atomics.load(c, HEAD$1) === Atomics.load(c, TAIL) && Atomics.load(c, BATCHES) === 0;
	}
	get pending() {
		return this.ctl[HEAD$1] !== this.ctl[TAIL];
	}
	tryWrite(src, p, len) {
		const c = this.ctl, cap = this.#cap;
		const need = 4 + (len + 3 & -4);
		let head = Atomics.load(c, HEAD$1);
		let used;
		for (;;) {
			used = (head - Atomics.load(c, TAIL) | 0) + need;
			if (used > cap) return false;
			const was = Atomics.compareExchange(c, HEAD$1, head, head + need | 0);
			if (was === head) break;
			head = was;
		}
		const mask = cap - 1;
		const at = head + 4 & mask;
		const first = Math.min(len, cap - at);
		this.#data.set(src.subarray(p, p + first), at);
		if (len > first) this.#data.set(src.subarray(p + first, p + len), 0);
		Atomics.store(this.#words, (head & mask) >> 2, len);
		const w = Atomics.load(c, WAITING);
		if (w !== 0 && (w === 1 || used >= this.#lazyBytes)) this.kick(w);
		return true;
	}
	committedAtTail() {
		const c = this.ctl;
		const tail = Atomics.load(c, TAIL);
		return tail !== Atomics.load(c, HEAD$1) && Atomics.load(this.#words, (tail & this.#cap - 1) >> 2) !== 0;
	}
	kick(w = Atomics.load(this.ctl, WAITING)) {
		if (w !== 0 && Atomics.compareExchange(this.ctl, WAITING, w, 0) === w) Atomics.notify(this.ctl, WAITING);
	}
	write(src, p, len, full, sink) {
		if (Atomics.load(this.ctl, CLOSED)) return len;
		for (let off = 0; off < len;) {
			const n = Math.min(len - off, this.#maxRecord);
			if (!this.tryWrite(src, p + off, n) && !(full === "wait" ? this.#waitWrite(src, p + off, n) : this.#takeWrite(src, p + off, n, sink, full === "post"))) {
				Atomics.add(this.ctl, DROPPED, len - off);
				return len - off;
			}
			off += n;
		}
		return 0;
	}
	#waitWrite(src, p, len) {
		const c = this.ctl;
		Atomics.add(c, SPACE, 1);
		try {
			for (;;) {
				if (Atomics.load(c, CLOSED)) return false;
				const tail = Atomics.load(c, TAIL);
				if (this.tryWrite(src, p, len)) return true;
				this.kick();
				Atomics.wait(c, TAIL, tail, 100);
			}
		} finally {
			Atomics.sub(c, SPACE, 1);
		}
	}
	#takeWrite(src, p, len, sink, post) {
		const c = this.ctl;
		for (let idle = 0;;) {
			if (Atomics.load(c, CLOSED)) return false;
			if (this.tryWrite(src, p, len)) return true;
			if (post && Atomics.load(c, BATCHES) >= MAX_BATCHES) {
				const taken = Atomics.load(c, TAKEN);
				if (taken === this.#stalledAt) return false;
				const deadline = performance.now() + STALL_MS;
				let left = STALL_MS;
				while (Atomics.load(c, TAKEN) === taken && left > 0 && !Atomics.load(c, CLOSED)) {
					Atomics.wait(c, TAKEN, taken, left);
					left = deadline - performance.now();
				}
				if (Atomics.load(c, TAKEN) === taken) {
					this.#stalledAt = taken;
					return false;
				}
				continue;
			}
			const b = this.take(true);
			if (b) {
				if (post) Atomics.add(c, BATCHES, 1);
				sink(b);
				idle = 0;
				continue;
			}
			if (++idle > 200) return false;
			Atomics.wait(c, CLOSED, 0, .1);
		}
	}
	batchTaken() {
		Atomics.sub(this.ctl, BATCHES, 1);
		Atomics.add(this.ctl, TAKEN, 1);
		Atomics.notify(this.ctl, TAKEN);
	}
	take(spin = false) {
		const c = this.ctl;
		for (let i = 0; Atomics.compareExchange(c, LOCK, 0, 1) !== 0; i++) {
			if (!spin || i > 100) return null;
			Atomics.wait(c, LOCK, 1, 1);
		}
		try {
			const cap = this.#cap, mask = cap - 1, words = this.#words, data = this.#data;
			const tail0 = Atomics.load(c, TAIL), head = Atomics.load(c, HEAD$1);
			let tail = tail0, total = 0;
			while (tail !== head) {
				const len = Atomics.load(words, (tail & mask) >> 2);
				if (!len) break;
				total += len;
				tail = tail + 4 + (len + 3 & -4) | 0;
			}
			if (tail === tail0) return null;
			const out = new Uint8Array(total);
			for (let t = tail0, o = 0; t !== tail;) {
				const len = words[(t & mask) >> 2];
				const at = t + 4 & mask;
				const first = Math.min(len, cap - at);
				out.set(data.subarray(at, at + first), o);
				if (len > first) out.set(data.subarray(0, len - first), o + first);
				o += len;
				t = t + 4 + (len + 3 & -4) | 0;
			}
			const a = tail0 & mask, n = tail - tail0 | 0;
			if (a + n <= cap) data.fill(0, a, a + n);
			else {
				data.fill(0, a);
				data.fill(0, 0, a + n - cap);
			}
			const seq = Atomics.add(c, BATCH, 1);
			Atomics.store(c, TAIL, tail);
			if (Atomics.load(c, SPACE) > 0) Atomics.notify(c, TAIL);
			return {
				seq,
				bytes: out
			};
		} finally {
			Atomics.store(c, LOCK, 0);
			Atomics.notify(c, LOCK);
		}
	}
	close() {
		Atomics.store(this.ctl, CLOSED, 1);
		Atomics.notify(this.ctl, TAIL);
		Atomics.notify(this.ctl, TAKEN);
		this.kick();
	}
};
var ConsoleRingReader = class {
	ring;
	#deliver;
	#stopped = false;
	#armed = false;
	#timer;
	constructor(ring, deliver) {
		this.ring = ring;
		this.#deliver = deliver;
	}
	take() {
		const b = this.ring.take();
		if (!b) return false;
		this.#deliver(b);
		return true;
	}
	start() {
		this.#loop();
	}
	stop() {
		this.#stopped = true;
		clearTimeout(this.#timer);
		this.ring.kick();
	}
	#loop() {
		if (this.#stopped || this.#armed) return;
		const mode = this.take() ? 2 : 1;
		const c = this.ring.ctl;
		Atomics.store(c, WAITING, mode);
		if (mode === 1 && this.ring.committedAtTail()) {
			Atomics.store(c, WAITING, 0);
			queueMicrotask(() => this.#loop());
			return;
		}
		const again = () => {
			this.#armed = false;
			Atomics.compareExchange(c, WAITING, mode, 0);
			this.#loop();
		};
		this.#armed = true;
		const wait = Atomics.waitAsync;
		if (typeof wait === "function") {
			const r = wait(c, WAITING, mode, mode === 2 ? LAZY_MS : 6e4);
			if (r.async) r.value.then(again);
			else queueMicrotask(again);
		} else this.#timer = setTimeout(again, mode === 2 ? LAZY_MS : 4);
	}
};
const MIRROR_KEYS = [
	"compiled",
	"live",
	"maxLive",
	"freed",
	"failed",
	"compileMs",
	"bytes",
	"collected",
	"retained",
	"maxRetained",
	"gcNudges",
	"refused",
	"maxCompileMs"
];
const JIT_MIRROR_WORDS = 2 + MIRROR_KEYS.length + 1;
function jitStatsFromMirror(m) {
	const st = {
		enabled: m[0] === 1,
		requested: m[1] === 1
	};
	MIRROR_KEYS.forEach((k, i) => st[k] = m[2 + i] ?? 0);
	return st;
}
function jitBufFromMirror(m) {
	return m[JIT_MIRROR_WORDS - 1] || void 0;
}
function sumJitStats(first, rest) {
	const st = { ...first };
	for (const o of rest) {
		st.enabled ||= o.enabled;
		st.requested ||= o.requested;
		for (const k of MIRROR_KEYS) st[k] = k === "maxCompileMs" ? Math.max(st[k], o[k]) : st[k] < 0 || o[k] < 0 ? -1 : st[k] + o[k];
	}
	return st;
}
const CAP_AVAILABLE = 1;
const CAP_MEM32 = 2;
const CAP_SHARED = 8;
const CAP_TABLE = 16;
const CAP_SIMD = 32;
const SIMD_PROBE = new Uint8Array([
	0,
	97,
	115,
	109,
	1,
	0,
	0,
	0,
	1,
	5,
	1,
	96,
	0,
	1,
	123,
	3,
	2,
	1,
	0,
	10,
	10,
	1,
	8,
	0,
	65,
	0,
	253,
	15,
	253,
	98,
	11
]);
function jitSimd() {
	try {
		return WebAssembly.validate(SIMD_PROBE);
	} catch {
		return false;
	}
}
const WARM = 1;
const MAX_MODULE = 1 << 20;
const MAX_LOGGED = 5;
const KWEMU_STATS_WORDS = 1269;
const KW_CPU_ICOUNT = 32;
const RETAINED_NUDGE = 256;
const RETAINED_LIMIT = 2048;
const NUDGE_BYTES = 64 << 20;
const NUDGE_MAX = 2 ** 32;
const NUDGE_PATIENCE_MS = 250;
var JitHost = class {
	stats;
	#opts;
	#table;
	#big = false;
	#saved = /* @__PURE__ */ new Map();
	#logged = 0;
	#fin;
	#nudgeAt;
	#limit;
	#nudgeBytes = NUDGE_BYTES;
	#nudgeCheckAt = 0;
	#nudgeCheckCollected = 0;
	#debugStats;
	#cpuOfBuf;
	#simd;
	#buf;
	constructor(opts) {
		this.#opts = opts;
		const enabled = opts.enabled !== false && typeof WebAssembly === "object" && typeof WebAssembly.Module === "function" && typeof WebAssembly.Instance === "function";
		const tracked = typeof FinalizationRegistry === "function";
		this.stats = {
			enabled,
			requested: false,
			compiled: 0,
			live: 0,
			maxLive: 0,
			freed: 0,
			failed: 0,
			compileMs: 0,
			maxCompileMs: 0,
			bytes: 0,
			collected: tracked ? 0 : -1,
			retained: tracked ? 0 : -1,
			maxRetained: tracked ? 0 : -1,
			gcNudges: 0,
			refused: 0
		};
		if (tracked) this.#fin = new FinalizationRegistry(() => this.#collected());
		this.#nudgeAt = opts.retainedNudge ?? RETAINED_NUDGE;
		this.#limit = opts.retainedLimit ?? RETAINED_LIMIT;
		this.#publish();
	}
	#publish() {
		const m = this.#opts.mirror;
		if (!m) return;
		const st = this.stats;
		m[0] = st.enabled ? 1 : 0;
		m[1] = st.requested ? 1 : 0;
		MIRROR_KEYS.forEach((k, i) => m[2 + i] = st[k]);
		m[JIT_MIRROR_WORDS - 1] = this.#buf ?? 0;
	}
	attach(exports) {
		const t = exports.__indirect_function_table;
		this.#table = t instanceof WebAssembly.Table ? t : void 0;
		this.#big = typeof this.#table?.length === "bigint";
		const ds = exports.kw_debug_stats, cb = exports.kw_debug_cpu_of_jit_buf;
		this.#debugStats = typeof ds === "function" ? ds : void 0;
		this.#cpuOfBuf = typeof cb === "function" ? cb : void 0;
		this.#buf = void 0;
	}
	kwemuStats(of = this.#buf) {
		if (!this.#debugStats || !this.#cpuOfBuf || this.#buf === void 0 || of === void 0) return void 0;
		const cpu = this.#cpuOfBuf(BigInt(of));
		this.#debugStats(cpu, BigInt(this.#buf));
		const v = new DataView(this.#opts.memory().buffer);
		const words = [];
		for (let i = 0; i < KWEMU_STATS_WORDS; i++) words.push(Number(v.getBigUint64(this.#buf + 8 * i, true)));
		return {
			icount: Number(v.getBigUint64(Number(cpu) + KW_CPU_ICOUNT, true)),
			words
		};
	}
	imports() {
		return {
			kw_host_jit_caps: () => this.caps(),
			kw_host_jit_compile: (ptr, len, slot, flags) => this.compile(ptr, len, slot, flags ?? 0),
			kw_host_jit_free: (slot) => this.free(slot)
		};
	}
	caps() {
		this.stats.requested = true;
		this.#publish();
		if (!this.stats.enabled) return 0;
		if (!this.#table) {
			this.#warn("the kernel exports no __indirect_function_table; JIT off");
			return 0;
		}
		const shared = typeof SharedArrayBuffer !== "undefined" && this.#opts.memory().buffer instanceof SharedArrayBuffer;
		this.#simd ??= jitSimd();
		return CAP_AVAILABLE | (this.#opts.memory64() ? 0 : CAP_MEM32) | (shared ? CAP_SHARED : 0) | CAP_TABLE | (this.#simd ? CAP_SIMD : 0);
	}
	compile(ptr, len, slot, flags = 0) {
		const st = this.stats;
		if (st.retained >= this.#nudgeAt) this.#nudge();
		if (st.retained >= this.#limit) {
			if (st.refused++ === 0) this.#opts.log?.(`[jit] ${st.retained} freed modules not collected by the engine yet; refusing compiles until it catches up`);
			this.#publish();
			return -1;
		}
		const t0 = performance.now();
		try {
			const table = this.#table;
			if (!st.enabled || !table) throw new Error("JIT not enabled");
			if (!this.#validSlot(slot)) throw new Error(`bad slot ${slot}`);
			const p = Number(ptr), n = Number(len);
			this.#buf ??= p;
			const mem = this.#opts.memory();
			if (!(n > 0 && n <= MAX_MODULE && p >= 0 && p + n <= mem.buffer.byteLength)) throw new Error(`bad module range ${p}+${n}`);
			const view = new Uint8Array(mem.buffer, p, n);
			const module = new WebAssembly.Module(mem.buffer instanceof ArrayBuffer ? view : view.slice());
			const f = new WebAssembly.Instance(module, { env: {
				memory: mem,
				table
			} }).exports.f;
			if (typeof f !== "function") throw new Error("the module exports no function f");
			if (flags & WARM) f(0n, 0n, 0n, 0n);
			const idx = this.#big ? BigInt(slot) : slot;
			const prev = table.get(idx);
			table.set(idx, f);
			this.#fin?.register(module, 0);
			if (this.#saved.has(slot)) this.#freed();
			else this.#saved.set(slot, prev);
			st.compiled++;
			st.bytes += n;
			return 0;
		} catch (e) {
			st.failed++;
			this.#warn(`compile into slot ${slot} failed: ${e?.message ?? e}`);
			return -1;
		} finally {
			const ms = performance.now() - t0;
			st.compileMs += ms;
			if (ms > st.maxCompileMs) st.maxCompileMs = ms;
			st.live = this.#saved.size;
			if (st.live > st.maxLive) st.maxLive = st.live;
			this.#publish();
		}
	}
	free(slot) {
		try {
			const orig = this.#saved.get(slot);
			if (!this.#saved.has(slot) || !this.#table) throw new Error(`free of slot ${slot}, which holds no compiled block`);
			this.#table.set(this.#big ? BigInt(slot) : slot, orig);
			this.#saved.delete(slot);
			this.#freed();
		} catch (e) {
			this.stats.failed++;
			this.#warn(e?.message ?? String(e));
		} finally {
			this.stats.live = this.#saved.size;
			this.#publish();
		}
	}
	#freed() {
		const st = this.stats;
		st.freed++;
		if (!this.#fin) return;
		st.retained = st.freed - st.collected;
		if (st.retained > st.maxRetained) st.maxRetained = st.retained;
	}
	#collected() {
		const st = this.stats;
		st.collected++;
		st.retained = Math.max(0, st.freed - st.collected);
		this.#publish();
	}
	#nudge() {
		const now = performance.now();
		if (this.stats.collected !== this.#nudgeCheckCollected) {
			this.#nudgeCheckCollected = this.stats.collected;
			this.#nudgeCheckAt = now;
		} else if (now - this.#nudgeCheckAt >= NUDGE_PATIENCE_MS) {
			if (this.#nudgeCheckAt > 0 && this.#nudgeBytes < NUDGE_MAX) this.#nudgeBytes *= 2;
			this.#nudgeCheckAt = now;
		}
		try {
			new ArrayBuffer(this.#nudgeBytes).transfer?.(0);
			this.stats.gcNudges++;
		} catch {
			if (this.#nudgeBytes > 1 << 20) this.#nudgeBytes >>= 1;
		}
	}
	#validSlot(slot) {
		const table = this.#table;
		if (!Number.isInteger(slot) || slot <= 0 || slot >= Number(table.length)) return false;
		return this.#saved.has(slot) || typeof table.get(this.#big ? BigInt(slot) : slot) === "function";
	}
	#warn(msg) {
		if (this.#logged >= MAX_LOGGED) return;
		this.#logged++;
		this.#opts.log?.(`[jit] ${msg}${this.#logged === MAX_LOGGED ? " (further JIT messages suppressed)" : ""}`);
	}
};
const ERRNO = {
	SUCCESS: 0,
	AGAIN: 6,
	BADF: 8,
	INVAL: 28,
	NOENT: 44,
	NOTDIR: 54,
	NOTSUP: 58,
	ROFS: 69
};
const CLOCK_REALTIME = 0;
const CLOCK_THREAD_CPUTIME = 3;
const EVENTTYPE_CLOCK = 0;
const EVENTTYPE_FD_READ = 1;
const EVENTTYPE_FD_WRITE = 2;
const SUBCLOCK_ABSTIME = 1;
const FILETYPE_CHARACTER_DEVICE = 2;
const FILETYPE_DIRECTORY = 3;
const FILETYPE_REGULAR_FILE = 4;
const OFLAGS_DIRECTORY = 2;
const encoder$1 = new TextEncoder();
const decoder$2 = new TextDecoder();
function never() {
	return new Promise(() => {});
}
const STACK_DROPPED = Symbol("unkernel stack dropped");
function stackDropped() {
	return Promise.reject(STACK_DROPPED);
}
function dropStack(resumers, task) {
	const resume = resumers.get(task);
	if (!resume) return;
	resumers.delete(task);
	resume(stackDropped());
}
function realtimeNs() {
	return BigInt(Date.now()) * 1000000n;
}
let shortWaitWord;
const SHORT_WAIT_MS = 4;
function shortWait(done, ms) {
	if (shortWaitWord === void 0) try {
		shortWaitWord = typeof Atomics.waitAsync === "function" ? new Int32Array(new SharedArrayBuffer(4)) : null;
	} catch {
		shortWaitWord = null;
	}
	if (!shortWaitWord) return;
	const r = Atomics.waitAsync(shortWaitWord, 0, 0, ms);
	if (r.async) r.value.then(done);
}
let yieldChannel;
const yieldWaiters = [];
function yieldToEventLoop() {
	if (typeof setImmediate === "function") return new Promise((r) => setImmediate(r));
	if (!yieldChannel) {
		const ch = new MessageChannel();
		const port1 = ch.port1;
		port1.onmessage = () => {
			const r = yieldWaiters.shift();
			if (!yieldWaiters.length) port1.unref?.();
			r?.();
		};
		port1.unref?.();
		ch.port2.unref?.();
		yieldChannel = ch;
	}
	return new Promise((r) => {
		if (yieldWaiters.push(r) === 1) yieldChannel.port1.ref?.();
		yieldChannel.port2.postMessage(0);
	});
}
var WasiHost = class {
	k;
	args;
	stderr;
	fds;
	buf;
	dvCache;
	u8Cache;
	monoOffset = 0;
	constructor(k, { args, files = {} }) {
		this.k = k;
		this.args = args.map((a) => encoder$1.encode(`${a}\0`));
		this.stderr = "";
		this.fds = /* @__PURE__ */ new Map([
			[0, { type: "stdin" }],
			[1, { type: "stdout" }],
			[2, { type: "stderr" }],
			[3, {
				type: "dir",
				name: encoder$1.encode("/"),
				files: new Map(Object.entries(files))
			}]
		]);
		this.buf = null;
		this.dvCache = null;
		this.u8Cache = null;
	}
	monotonicMs() {
		return performance.now() + this.monoOffset;
	}
	clockNs(id) {
		return id === CLOCK_REALTIME ? realtimeNs() : BigInt(Math.round(this.monotonicMs() * 1e6));
	}
	views() {
		if (!this.buf || this.buf.byteLength === 0) {
			this.buf = this.k.memory.buffer;
			this.dvCache = new DataView(this.buf);
			this.u8Cache = new Uint8Array(this.buf);
		}
	}
	dv() {
		this.views();
		return this.dvCache;
	}
	u8() {
		this.views();
		return this.u8Cache;
	}
	iovecs(iovs, n) {
		const dv = this.dv();
		const out = [];
		for (let i = 0; i < n; i++) out.push([dv.getUint32(iovs + 8 * i, true), dv.getUint32(iovs + 8 * i + 4, true)]);
		return out;
	}
	stdinQueued() {
		const k = this.k;
		let n = -k.inputOffset;
		for (const c of k.input) n += c.length;
		return n;
	}
	readStdin(dst, want) {
		const k = this.k;
		const u8 = this.u8();
		let n = 0;
		while (n < want && k.input.length) {
			const head = k.input[0];
			const take = Math.min(want - n, head.length - k.inputOffset);
			u8.set(head.subarray(k.inputOffset, k.inputOffset + take), dst + n);
			n += take;
			k.inputOffset += take;
			if (k.inputOffset >= head.length) {
				k.input.shift();
				k.inputOffset = 0;
			}
		}
		return n;
	}
	subscriptions(inp, n) {
		const dv = this.dv();
		const subs = [];
		for (let i = 0; i < n; i++) {
			const b = inp + 48 * i;
			const sub = {
				userdata: dv.getBigUint64(b, true),
				tag: dv.getUint8(b + 8)
			};
			if (sub.tag === EVENTTYPE_CLOCK) {
				sub.clock = dv.getUint32(b + 16, true);
				const timeout = dv.getBigUint64(b + 24, true);
				sub.deadline = dv.getUint16(b + 40, true) & SUBCLOCK_ABSTIME ? timeout : this.clockNs(sub.clock) + timeout;
			} else sub.fd = dv.getUint32(b + 16, true);
			subs.push(sub);
		}
		return subs;
	}
	ready(subs) {
		const events = [];
		for (const s of subs) {
			const ev = {
				userdata: s.userdata,
				type: s.tag,
				error: 0,
				nbytes: 0n
			};
			if (s.tag === EVENTTYPE_CLOCK) {
				if (this.clockNs(s.clock) >= s.deadline) events.push(ev);
				continue;
			}
			const f = this.fds.get(s.fd);
			if (!f || f.type === "dir") ev.error = ERRNO.BADF;
			else if (s.tag === EVENTTYPE_FD_READ) {
				if (f.type === "stdin") {
					const q = this.stdinQueued();
					if (!q) continue;
					ev.nbytes = BigInt(q);
				} else if (f.type === "file") ev.nbytes = BigInt(f.data.length - f.pos);
				else ev.error = ERRNO.BADF;
			} else if (s.tag !== EVENTTYPE_FD_WRITE || f.type === "stdin") ev.error = ERRNO.BADF;
			events.push(ev);
		}
		return events;
	}
	writeEvents(out, nevents, events) {
		const dv = this.dv();
		events.forEach((ev, i) => {
			const b = out + 32 * i;
			for (let j = 0; j < 32; j += 8) dv.setBigUint64(b + j, 0n, true);
			dv.setBigUint64(b, ev.userdata, true);
			dv.setUint16(b + 8, ev.error, true);
			dv.setUint8(b + 10, ev.type);
			dv.setBigUint64(b + 16, ev.nbytes, true);
		});
		dv.setUint32(nevents, events.length, true);
	}
	exit(code) {
		const k = this.k;
		if (code === 253) {
			const msg = this.stderr.trim();
			k.log(`[host] kernel panic: ${msg}`);
			k.exit({
				code,
				reason: `panic: ${msg}`,
				kind: "panic"
			});
		} else k.exit({
			code,
			reason: "halt",
			kind: "halt"
		});
	}
	imports() {
		const w = this;
		const k = this.k;
		return {
			args_sizes_get(argc, size) {
				const dv = w.dv();
				dv.setUint32(argc, w.args.length, true);
				dv.setUint32(size, w.args.reduce((n, a) => n + a.length, 0), true);
				return ERRNO.SUCCESS;
			},
			args_get(argv, buf) {
				const dv = w.dv();
				const u8 = w.u8();
				w.args.forEach((a, i) => {
					dv.setUint32(argv + 4 * i, buf, true);
					u8.set(a, buf);
					buf += a.length;
				});
				return ERRNO.SUCCESS;
			},
			clock_time_get(id, _precision, time) {
				const dv = w.dv();
				if (id === CLOCK_REALTIME) {
					dv.setBigUint64(time, realtimeNs(), true);
					return ERRNO.SUCCESS;
				}
				if (id > CLOCK_THREAD_CPUTIME) return ERRNO.INVAL;
				const p = k.poller;
				if (p !== null) p.poll();
				const ns = Math.round((performance.now() + w.monoOffset) * 1e6);
				dv.setUint32(time, ns >>> 0, true);
				dv.setUint32(time + 4, Math.floor(ns / 4294967296), true);
				return ERRNO.SUCCESS;
			},
			random_get(buf, len) {
				const u8 = w.u8();
				for (let off = 0; off < len; off += 65536) {
					const n = Math.min(len - off, 65536);
					u8.set(crypto.getRandomValues(new Uint8Array(n)), buf + off);
				}
				return ERRNO.SUCCESS;
			},
			fd_write(fd, iovs, n, nwritten) {
				const f = w.fds.get(fd);
				if (!f || f.type !== "stdout" && f.type !== "stderr") return ERRNO.BADF;
				const u8 = w.u8();
				let total = 0;
				for (const [p, len] of w.iovecs(iovs, n)) {
					if (!len) continue;
					if (f.type === "stdout") k.consoleWrite(u8, p, len);
					else w.stderr = (w.stderr + decoder$2.decode(u8.slice(p, p + len))).slice(-4096);
					total += len;
				}
				w.dv().setUint32(nwritten, total, true);
				return ERRNO.SUCCESS;
			},
			fd_read(fd, iovs, n, nread) {
				const f = w.fds.get(fd);
				if (!f) return ERRNO.BADF;
				let total = 0;
				if (f.type === "stdin") {
					for (const [p, len] of w.iovecs(iovs, n)) {
						const got = w.readStdin(p, len);
						total += got;
						if (got < len) break;
					}
					if (!total && n) return ERRNO.AGAIN;
				} else if (f.type === "file") {
					const u8 = w.u8();
					for (const [p, len] of w.iovecs(iovs, n)) {
						const take = Math.min(len, f.data.length - f.pos);
						u8.set(f.data.subarray(f.pos, f.pos + take), p);
						f.pos += take;
						total += take;
						if (take < len) break;
					}
				} else return ERRNO.BADF;
				w.dv().setUint32(nread, total, true);
				return ERRNO.SUCCESS;
			},
			fd_close(fd) {
				const f = w.fds.get(fd);
				if (!f || f.type !== "file") return ERRNO.BADF;
				w.fds.delete(fd);
				return ERRNO.SUCCESS;
			},
			fd_filestat_get(fd, buf) {
				const f = w.fds.get(fd);
				if (!f) return ERRNO.BADF;
				const dv = w.dv();
				for (let j = 0; j < 64; j += 8) dv.setBigUint64(buf + j, 0n, true);
				dv.setUint8(buf + 16, f.type === "file" ? FILETYPE_REGULAR_FILE : f.type === "dir" ? FILETYPE_DIRECTORY : FILETYPE_CHARACTER_DEVICE);
				dv.setBigUint64(buf + 24, 1n, true);
				if (f.type === "file") dv.setBigUint64(buf + 32, BigInt(f.data.length), true);
				return ERRNO.SUCCESS;
			},
			fd_prestat_get(fd, buf) {
				const f = w.fds.get(fd);
				if (!f || f.type !== "dir") return ERRNO.BADF;
				const dv = w.dv();
				dv.setUint32(buf, 0, true);
				dv.setUint32(buf + 4, f.name.length, true);
				return ERRNO.SUCCESS;
			},
			fd_prestat_dir_name(fd, path, len) {
				const f = w.fds.get(fd);
				if (!f || f.type !== "dir") return ERRNO.BADF;
				w.u8().set(f.name.subarray(0, len), path);
				return ERRNO.SUCCESS;
			},
			path_open(dirfd, _dirflags, path, pathLen, oflags, _rightsBase, _rightsInheriting, _fdflags, opened) {
				const d = w.fds.get(dirfd);
				if (!d) return ERRNO.BADF;
				if (d.type !== "dir") return ERRNO.NOTDIR;
				if (oflags & 9) return ERRNO.ROFS;
				const name = decoder$2.decode(w.u8().slice(path, path + pathLen)).replace(/^(\.?\/)+/, "");
				const data = d.files.get(name);
				if (!data) return ERRNO.NOENT;
				if (oflags & OFLAGS_DIRECTORY) return ERRNO.NOTDIR;
				let fd = 4;
				while (w.fds.has(fd)) fd++;
				w.fds.set(fd, {
					type: "file",
					data,
					pos: 0
				});
				w.dv().setUint32(opened, fd, true);
				return ERRNO.SUCCESS;
			},
			poll_oneoff: new WebAssembly.Suspending((inp, out, nsubs, nevents) => {
				if (k.result) return never();
				if (!nsubs) return ERRNO.INVAL;
				const subs = w.subscriptions(inp, nsubs);
				const now = w.ready(subs);
				if (now.length) {
					w.writeEvents(out, nevents, now);
					return ERRNO.SUCCESS;
				}
				if (k.poller?.idle()) {
					w.writeEvents(out, nevents, w.ready(subs));
					return ERRNO.SUCCESS;
				}
				k.stats.idles++;
				let wait = 1e400;
				for (const s of subs) if (s.tag === EVENTTYPE_CLOCK) wait = Math.min(wait, Number(s.deadline - w.clockNs(s.clock)) / 1e6);
				return new Promise((resolve) => {
					let timer = null;
					let settled = false;
					const done = () => {
						if (settled) return;
						settled = true;
						if (timer !== null) clearTimeout(timer);
						k.idleWake = null;
						k.poller?.awake();
						if (k.result) return;
						w.writeEvents(out, nevents, w.ready(subs));
						resolve(ERRNO.SUCCESS);
					};
					k.idleWake = done;
					if (wait !== 1e400) timer = setTimeout(done, Math.max(0, wait));
					if (wait >= 1 && wait < SHORT_WAIT_MS) shortWait(done, wait);
					k.watchIrqWord(done, wait === 1e400 ? 6e4 : Math.max(0, wait));
				});
			}),
			sched_yield: new WebAssembly.Suspending(() => {
				if (k.result) return never();
				k.stats.yields++;
				return yieldToEventLoop().then(() => k.result ? never() : ERRNO.SUCCESS);
			}),
			proc_exit: new WebAssembly.Suspending((code) => {
				w.exit(code);
				return never();
			})
		};
	}
};
var ConsoleOrder = class {
	next = 0;
	held = /* @__PURE__ */ new Map();
	emit;
	constructor(emit) {
		this.emit = emit;
	}
	get empty() {
		return this.held.size === 0;
	}
	put(seq, bytes) {
		if (seq !== this.next) {
			if ((seq - this.next | 0) < 0) this.emit(bytes);
			else this.held.set(seq, bytes);
			return;
		}
		this.next = seq + 1 | 0;
		this.emit(bytes);
		if (!this.held.size) return;
		for (let b = this.held.get(this.next); b; b = this.held.get(this.next)) {
			this.held.delete(this.next);
			this.next = this.next + 1 | 0;
			this.emit(b);
		}
	}
	flush() {
		if (!this.held.size) return;
		const base = this.next;
		const seqs = [...this.held.keys()].sort((a, b) => (a - base | 0) - (b - base | 0));
		for (const s of seqs) {
			const b = this.held.get(s);
			this.held.delete(s);
			this.next = s + 1 | 0;
			this.emit(b);
		}
	}
};
const EV_SYN = 0;
const EV_KEY = 1;
const EV_REL = 2;
const EV_ABS = 3;
const REL_X = 0;
const REL_Y = 1;
const REL_WHEEL = 8;
const ABS_X = 0;
const ABS_Y = 1;
const ABS_MAX = 32767;
const BTN_LEFT = 272;
const BTN_RIGHT = 273;
const BTN_MIDDLE = 274;
const INPUT_KEYBOARD = 0;
const INPUT_MOUSE = 1;
const INPUT_TABLET = 2;
const ENODEV$1 = 19;
const MAX_QUEUED = 4096;
var InputHost = class {
	enabled;
	probed = false;
	mask = 0;
	stats = {
		delivered: 0,
		dropped: 0
	};
	#queue = [];
	#keys = /* @__PURE__ */ new Set();
	#buttons = /* @__PURE__ */ new Set();
	#tabletButtons = /* @__PURE__ */ new Set();
	#abs = [-1, -1];
	#memory;
	#raise;
	#onChange;
	constructor(opts) {
		this.enabled = !!opts.enabled;
		this.#memory = opts.memory;
		this.#raise = opts.raise;
		this.#onChange = opts.onChange;
	}
	get keyboardOpen() {
		return !!(this.mask & 1);
	}
	get mouseOpen() {
		return !!(this.mask & 2);
	}
	get tabletOpen() {
		return !!(this.mask & 4);
	}
	get state() {
		return {
			keyboard: this.keyboardOpen,
			mouse: this.mouseOpen,
			tablet: this.tabletOpen
		};
	}
	key(code, down) {
		if (down) {
			if (!this.keyboardOpen) return this.#drop();
			if (this.#keys.has(code)) return true;
			this.#keys.add(code);
		} else if (!this.#keys.delete(code)) return false;
		return this.#send(0, [
			1,
			code,
			down ? 1 : 0
		]);
	}
	button(code, down) {
		if (down) {
			if (!this.mouseOpen) return this.#drop();
			if (this.#buttons.has(code)) return true;
			this.#buttons.add(code);
		} else if (!this.#buttons.delete(code)) return false;
		return this.#send(1, [
			1,
			code,
			down ? 1 : 0
		]);
	}
	move(dx, dy) {
		dx = Math.round(dx);
		dy = Math.round(dy);
		if (!this.mouseOpen || this.#queue.length >= MAX_QUEUED * 4) return this.#drop();
		const ev = [];
		if (dx) ev.push(2, 0, dx);
		if (dy) ev.push(2, 1, dy);
		return ev.length ? this.#send(1, ev) : true;
	}
	wheel(clicks) {
		clicks = Math.round(clicks);
		if (!this.mouseOpen) return this.#drop();
		return clicks ? this.#send(1, [
			2,
			8,
			clicks
		]) : true;
	}
	moveTo(x, y) {
		if (!this.tabletOpen || this.#queue.length >= MAX_QUEUED * 4) return this.#drop();
		const ax = Math.min(ABS_MAX, Math.max(0, Math.floor(x * 32768)));
		const ay = Math.min(ABS_MAX, Math.max(0, Math.floor(y * 32768)));
		const ev = [];
		if (ax !== this.#abs[0]) ev.push(3, 0, ax);
		if (ay !== this.#abs[1]) ev.push(3, 1, ay);
		this.#abs = [ax, ay];
		return ev.length ? this.#send(2, ev) : true;
	}
	tabletButton(code, down) {
		if (down) {
			if (!this.tabletOpen) return this.#drop();
			if (this.#tabletButtons.has(code)) return true;
			this.#tabletButtons.add(code);
		} else if (!this.#tabletButtons.delete(code)) return false;
		return this.#send(2, [
			1,
			code,
			down ? 1 : 0
		]);
	}
	tabletWheel(clicks) {
		clicks = Math.round(clicks);
		if (!this.tabletOpen) return this.#drop();
		return clicks ? this.#send(2, [
			2,
			8,
			clicks
		]) : true;
	}
	releaseAll() {
		for (const c of [...this.#keys]) this.key(c, false);
		for (const b of [...this.#buttons]) this.button(b, false);
		for (const b of [...this.#tabletButtons]) this.tabletButton(b, false);
	}
	saveState() {
		return {
			mask: this.mask,
			keys: [...this.#keys],
			buttons: [...this.#buttons],
			tabletButtons: [...this.#tabletButtons],
			queue: this.#queue.slice()
		};
	}
	restoreState(s) {
		this.probed = true;
		this.mask = s.mask >>> 0;
		this.#queue = s.queue.slice(0, MAX_QUEUED * 4);
		this.#keys = new Set(s.keys);
		this.#buttons = new Set(s.buttons);
		this.#tabletButtons = new Set(s.tabletButtons);
		this.#abs = [-1, -1];
		this.releaseAll();
		if (this.#queue.length) this.#raise();
		try {
			this.#onChange?.(this.state);
		} catch {}
	}
	#drop() {
		this.stats.dropped++;
		return false;
	}
	#send(dev, triples) {
		for (let i = 0; i < triples.length; i += 3) this.#queue.push(dev, triples[i], triples[i + 1], triples[i + 2]);
		this.#queue.push(dev, 0, 0, 0);
		this.#raise();
		return true;
	}
	imports() {
		return {
			wasm_driver_input_init: () => {
				this.probed = true;
				return this.enabled ? 0n : -BigInt(ENODEV$1);
			},
			wasm_driver_input_read: (buf, max) => {
				const n = Math.min(Number(max), this.#queue.length / 4);
				if (!n) return 0n;
				const dv = new DataView(this.#memory().buffer, Number(buf), n * 12);
				const q = this.#queue;
				for (let i = 0; i < n; i++) {
					dv.setUint16(i * 12, q[i * 4], true);
					dv.setUint16(i * 12 + 2, q[i * 4 + 1], true);
					dv.setUint16(i * 12 + 4, q[i * 4 + 2], true);
					dv.setUint16(i * 12 + 6, 0, true);
					dv.setInt32(i * 12 + 8, q[i * 4 + 3], true);
				}
				q.splice(0, n * 4);
				this.stats.delivered += n;
				return BigInt(n);
			},
			wasm_driver_input_state: (mask) => {
				const closed = this.mask & ~mask;
				this.mask = mask >>> 0;
				if (closed & 1) for (const c of [...this.#keys]) this.key(c, false);
				if (closed & 2) for (const b of [...this.#buttons]) this.button(b, false);
				if (closed & 4) for (const b of [...this.#tabletButtons]) this.tabletButton(b, false);
				if (closed & 4) this.#abs = [-1, -1];
				try {
					this.#onChange?.(this.state);
				} catch {}
			}
		};
	}
};
const DOM_CODE_TO_LINUX = (() => {
	const m = {
		Escape: 1,
		Minus: 12,
		Equal: 13,
		Backspace: 14,
		Tab: 15,
		BracketLeft: 26,
		BracketRight: 27,
		Enter: 28,
		ControlLeft: 29,
		Semicolon: 39,
		Quote: 40,
		Backquote: 41,
		ShiftLeft: 42,
		Backslash: 43,
		Comma: 51,
		Period: 52,
		Slash: 53,
		ShiftRight: 54,
		NumpadMultiply: 55,
		AltLeft: 56,
		Space: 57,
		CapsLock: 58,
		NumLock: 69,
		ScrollLock: 70,
		Numpad7: 71,
		Numpad8: 72,
		Numpad9: 73,
		NumpadSubtract: 74,
		Numpad4: 75,
		Numpad5: 76,
		Numpad6: 77,
		NumpadAdd: 78,
		Numpad1: 79,
		Numpad2: 80,
		Numpad3: 81,
		Numpad0: 82,
		NumpadDecimal: 83,
		IntlBackslash: 86,
		F11: 87,
		F12: 88,
		IntlRo: 89,
		NumpadEnter: 96,
		ControlRight: 97,
		NumpadDivide: 98,
		PrintScreen: 99,
		AltRight: 100,
		Home: 102,
		ArrowUp: 103,
		PageUp: 104,
		ArrowLeft: 105,
		ArrowRight: 106,
		End: 107,
		ArrowDown: 108,
		PageDown: 109,
		Insert: 110,
		Delete: 111,
		AudioVolumeMute: 113,
		AudioVolumeDown: 114,
		AudioVolumeUp: 115,
		Power: 116,
		NumpadEqual: 117,
		Pause: 119,
		NumpadComma: 121,
		IntlYen: 124,
		MetaLeft: 125,
		MetaRight: 126,
		ContextMenu: 127
	};
	"1234567890".split("").forEach((d, i) => m[`Digit${d}`] = 2 + i);
	for (const [keys, base] of [
		["QWERTYUIOP", 16],
		["ASDFGHJKL", 30],
		["ZXCVBNM", 44]
	]) keys.split("").forEach((k, i) => m[`Key${k}`] = base + i);
	for (let i = 1; i <= 10; i++) m[`F${i}`] = 58 + i;
	for (let i = 13; i <= 24; i++) m[`F${i}`] = 170 + i;
	return Object.freeze(m);
})();
function domCodeToLinux(code) {
	return DOM_CODE_TO_LINUX[code];
}
function domButtonToLinux(button) {
	return button === 0 ? 272 : button === 1 ? 274 : button === 2 ? 273 : void 0;
}
const TIERS = [
	"none",
	"entry",
	"reference",
	"decoded",
	"compiled",
	"budget"
];
const PROFILE_ANON = "[anon]";
const PROFILE_UNKNOWN = "[unknown]";
const KW_PROF_VERSION = 2;
const P_FLAGS = 4;
const P_PERIOD = 8;
const P_NR = 16;
const P_RING = 20;
const P_REC = 24;
const P_STRIDE = 28;
const P_RINGS = 32;
const P_BIT = 36;
const P_FILES = 40;
const P_MAX_FILES = 44;
const P_PATH_SIZE = 48;
const P_NR_FILES = 52;
const P_WORDS = 56;
const R_HEAD = 0;
const R_DROPPED = 4;
const R_TAIL = 32;
const R_SAMPLES = 64;
const S_PC = 0;
const S_BLOCK = 8;
const S_PID = 24;
const S_TGID = 28;
const S_CPU = 32;
const S_KIND = 34;
const S_TIER = 35;
const S_FILE = 36;
const S_COMM = 40;
const S_OFF = 56;
const FLAG_TIME = 1;
const FLAG_INSNS = 2;
const KIND_USER = 1;
const KIND_KERNEL = 2;
const KIND_IDLE = 3;
const KIND_INSN = 4;
const FILE_ANON = 0;
const FILE_FULL = 4294967294;
const FILE_UNKNOWN = 4294967295;
const DRAIN_MS = 20;
function bump(map, key, path, at, proc, pid, comm, user, tier) {
	let a = map.get(key);
	if (!a) map.set(key, a = {
		path,
		at,
		pid: proc,
		time: 0,
		insns: 0,
		tiers: [
			0,
			0,
			0,
			0,
			0,
			0
		],
		comms: /* @__PURE__ */ new Map(),
		pids: /* @__PURE__ */ new Set()
	});
	if (user) {
		a.time++;
		a.tiers[tier]++;
	} else a.insns++;
	a.comms.set(comm, (a.comms.get(comm) ?? 0) + 1);
	a.pids.add(pid);
}
function topComm(a) {
	let best = "", n = 0;
	for (const [c, k] of a.comms) if (k > n) {
		best = c;
		n = k;
	}
	return best;
}
function tierFields(tiers) {
	if (!tiers.some((n) => n)) return {};
	let best = 0;
	for (let i = 1; i < TIERS.length; i++) if (tiers[i] > tiers[best]) best = i;
	return {
		tier: TIERS[best],
		tiers: Object.fromEntries(TIERS.map((t, i) => [t, tiers[i]]).filter(([, n]) => n))
	};
}
const byTime = (a, b) => b.timeSamples - a.timeSamples || b.insnSamples - a.insnSamples;
const hex$2 = (v) => `0x${v.toString(16)}`;
const decoder$1 = new TextDecoder();
function profAddr(k) {
	const g = k.exports?.kw_prof;
	if (!(g instanceof WebAssembly.Global)) return void 0;
	const addr = Number(g.value);
	return new DataView(k.memory.buffer).getUint32(addr, true) === KW_PROF_VERSION ? addr : void 0;
}
function profileOff(k) {
	const addr = profAddr(k);
	if (addr !== void 0) new DataView(k.memory.buffer).setUint32(addr + P_FLAGS, 0, true);
}
var Profiler = class {
	hz;
	insns;
	k;
	addr = 0;
	nr = 0;
	ringSize = 0;
	rec = 0;
	stride = 0;
	rings = 0;
	dropBase = [];
	sampler = null;
	ctl = null;
	timer;
	t0 = 0;
	tEnd = 0;
	rowMap = /* @__PURE__ */ new Map();
	procPageMap = /* @__PURE__ */ new Map();
	siteMap = /* @__PURE__ */ new Map();
	pageMap = /* @__PURE__ */ new Map();
	fileMap = /* @__PURE__ */ new Map();
	where = {
		file: 0,
		anon: 0,
		noName: 0,
		unknown: 0
	};
	paths = [];
	maxFiles = 0;
	pathSize = 0;
	commMap = /* @__PURE__ */ new Map();
	perCpu = [];
	constructor(opts) {
		this.hz = Math.max(0, Math.min(1e4, Number(opts.hz ?? 1e3) || 0));
		this.insns = Math.max(0, Math.floor(Number(opts.insns ?? 1e6) || 0));
		if (this.insns && this.insns < 1e3) this.insns = 1e3;
	}
	attach(k, spawnSampler) {
		const addr = profAddr(k);
		if (addr === void 0) {
			k.log("[host] profile: this kernel has no profiler (kw_prof); nothing is sampled");
			return false;
		}
		this.k = k;
		this.addr = addr;
		const dv = new DataView(k.memory.buffer);
		this.nr = dv.getUint32(addr + P_NR, true);
		this.ringSize = dv.getUint32(addr + P_RING, true);
		this.rec = dv.getUint32(addr + P_REC, true);
		this.stride = dv.getUint32(addr + P_STRIDE, true);
		this.rings = addr + dv.getUint32(addr + P_RINGS, true);
		this.maxFiles = dv.getUint32(addr + P_MAX_FILES, true);
		this.pathSize = dv.getUint32(addr + P_PATH_SIZE, true);
		const cpus = Math.min(k.cpus, this.nr);
		for (let c = 0; c < this.nr; c++) {
			const r = this.rings + c * this.stride;
			dv.setUint32(r + R_TAIL, dv.getUint32(r + R_HEAD, true), true);
			this.dropBase[c] = dv.getUint32(r + R_DROPPED, true);
		}
		this.perCpu = Array.from({ length: cpus }, (_, cpu) => ({
			cpu,
			ticks: 0,
			missed: 0,
			user: 0,
			kernel: 0,
			idle: 0,
			insns: 0,
			dropped: 0
		}));
		let flags = this.insns ? FLAG_INSNS : 0;
		if (this.hz && !k.sharedMemory) {
			k.log("[host] profile: time samples need the kernel's memory shared (the SMP kernel: --cpus 2 or more); instruction samples only");
			this.hz = 0;
		} else if (this.hz && !spawnSampler) {
			k.log("[host] profile: this platform starts no sampler thread; instruction samples only");
			this.hz = 0;
		}
		if (this.hz) {
			const ctl = new SharedArrayBuffer(4 * (1 + 2 * cpus));
			this.ctl = new Int32Array(ctl);
			try {
				this.sampler = spawnSampler({
					buffer: k.memory.buffer,
					irq0: k.irqAddr ?? 0,
					words: addr + P_WORDS,
					cpus,
					bit: dv.getUint32(addr + P_BIT, true),
					periodMs: 1e3 / this.hz,
					ctl
				});
				flags |= FLAG_TIME;
			} catch (e) {
				k.log(`[host] profile: cannot start the sampler (${e?.message ?? e}); instruction samples only`);
				this.hz = 0;
				this.ctl = null;
			}
		}
		dv.setBigUint64(addr + P_PERIOD, BigInt(this.insns), true);
		dv.setUint32(addr + P_FLAGS, flags, true);
		this.t0 = performance.now();
		this.timer = setInterval(() => this.drain(), DRAIN_MS);
		this.timer.unref?.();
		return true;
	}
	stop() {
		if (!this.k || this.tEnd) return;
		this.drain();
		this.tEnd = performance.now();
		clearInterval(this.timer);
		this.timer = void 0;
		this.sampler?.stop();
		this.sampler = null;
	}
	drain() {
		const k = this.k;
		if (!k || this.tEnd) return;
		const buf = k.memory.buffer;
		const dv = new DataView(buf);
		const i32 = k.sharedMemory ? new Int32Array(buf) : null;
		const u8 = new Uint8Array(buf);
		for (let c = 0; c < this.perCpu.length; c++) {
			const r = this.rings + c * this.stride;
			const head = (i32 ? Atomics.load(i32, r + R_HEAD >> 2) : dv.getUint32(r + R_HEAD, true)) >>> 0;
			let tail = dv.getUint32(r + R_TAIL, true);
			if (head === tail) continue;
			for (; tail !== head; tail = tail + 1 >>> 0) {
				const s = r + R_SAMPLES + tail % this.ringSize * this.rec;
				this.add(dv, u8, s);
			}
			if (i32) Atomics.store(i32, r + R_TAIL >> 2, tail | 0);
			else dv.setUint32(r + R_TAIL, tail, true);
		}
	}
	pathOf(dv, u8, id) {
		if (id > this.paths.length) {
			const k = this.k;
			const nrAt = this.addr + P_NR_FILES;
			const n = Math.min(this.maxFiles, k.sharedMemory ? Atomics.load(new Int32Array(dv.buffer), nrAt >> 2) >>> 0 : dv.getUint32(nrAt, true));
			const files = dv.getUint32(this.addr + P_FILES, true);
			for (let i = this.paths.length; i < n && files; i++) {
				const at = files + i * this.pathSize;
				let end = at;
				while (end < at + this.pathSize && u8[end] !== 0) end++;
				this.paths.push(decoder$1.decode(u8.slice(at, end)));
			}
		}
		return this.paths[id - 1] ?? `[file ${id}]`;
	}
	add(dv, u8, s) {
		const kind = dv.getUint8(s + S_KIND);
		const cpu = this.perCpu[dv.getUint16(s + S_CPU, true)];
		let end = s + S_COMM;
		while (end < s + S_COMM + 16 && u8[end] !== 0) end++;
		const comm = decoder$1.decode(u8.slice(s + S_COMM, end));
		const pid = dv.getUint32(s + S_TGID, true) || dv.getUint32(s + S_PID, true);
		const pc = dv.getBigUint64(s + S_PC, true);
		let c = this.commMap.get(comm);
		if (!c) this.commMap.set(comm, c = {
			comm,
			user: 0,
			kernel: 0,
			idle: 0,
			insns: 0
		});
		if (kind === KIND_IDLE) {
			c.idle++;
			if (cpu) cpu.idle++;
			return;
		}
		const key = `${comm}\0${pid}\0${pc}`;
		let row = this.rowMap.get(key);
		if (!row) this.rowMap.set(key, row = {
			comm,
			pid,
			pc,
			time: 0,
			kernel: 0,
			insns: 0,
			tiers: [
				0,
				0,
				0,
				0,
				0,
				0
			],
			blocks: /* @__PURE__ */ new Map()
		});
		let at = pc;
		if (kind === KIND_USER) {
			row.time++;
			c.user++;
			if (cpu) cpu.user++;
			const tier = dv.getUint8(s + S_TIER);
			row.tiers[tier < TIERS.length ? tier : 0]++;
			const block = dv.getBigUint64(s + S_BLOCK, true);
			if (block) {
				row.blocks.set(block, (row.blocks.get(block) ?? 0) + 1);
				at = block;
			}
		} else if (kind === KIND_KERNEL) {
			row.kernel++;
			c.kernel++;
			if (cpu) cpu.kernel++;
			return;
		} else if (kind === KIND_INSN) {
			row.insns++;
			c.insns++;
			if (cpu) cpu.insns++;
		} else return;
		const user = kind === KIND_USER;
		const tier = user ? Math.min(dv.getUint8(s + S_TIER), TIERS.length - 1) : 0;
		const file = dv.getUint32(s + S_FILE, true);
		let path, off, proc;
		if (file === FILE_ANON || file === FILE_FULL || file === FILE_UNKNOWN) {
			path = file === FILE_ANON ? PROFILE_ANON : PROFILE_UNKNOWN;
			off = at;
			proc = pid;
			if (file === FILE_ANON) this.where.anon++;
			else if (file === FILE_FULL) this.where.noName++;
			else this.where.unknown++;
		} else {
			path = this.pathOf(dv, u8, file);
			off = dv.getBigUint64(s + S_OFF, true);
			this.where.file++;
		}
		const where = proc === void 0 ? path : `${path}\0${proc}`;
		bump(this.siteMap, `${where}\0${off}`, path, off, proc, pid, comm, user, tier);
		bump(this.pageMap, `${where}\0${off >> 12n}`, path, off & -4096n, proc, pid, comm, user, tier);
		bump(this.fileMap, path, path, 0n, void 0, pid, comm, user, tier);
		const page = at & -4096n;
		const pkey = `${comm}\0${pid}\0${page}`;
		let p = this.procPageMap.get(pkey);
		if (!p) this.procPageMap.set(pkey, p = {
			comm,
			pid,
			page: hex$2(page),
			path,
			timeSamples: 0,
			insnSamples: 0
		});
		if (user) p.timeSamples++;
		else p.insnSamples++;
	}
	report() {
		this.drain();
		const k = this.k;
		if (k && this.ctl) {
			const n = this.perCpu.length;
			for (const c of this.perCpu) {
				c.ticks = Atomics.load(this.ctl, 1 + c.cpu);
				c.missed = Atomics.load(this.ctl, 1 + n + c.cpu);
			}
		}
		if (k) {
			const dv = new DataView(k.memory.buffer);
			for (const c of this.perCpu) c.dropped = dv.getUint32(this.rings + c.cpu * this.stride + R_DROPPED, true) - (this.dropBase[c.cpu] ?? 0) >>> 0;
		}
		const sum = (f) => this.perCpu.reduce((a, c) => a + c[f], 0);
		const rows = [...this.rowMap.values()].map((r) => {
			const out = {
				comm: r.comm,
				pid: r.pid,
				pc: hex$2(r.pc),
				timeSamples: r.time,
				kernelSamples: r.kernel,
				insnSamples: r.insns
			};
			if (r.time) {
				Object.assign(out, tierFields(r.tiers));
				let bb = 0n, bn = 0;
				for (const [b, n] of r.blocks) if (n > bn) {
					bb = b;
					bn = n;
				}
				if (bn) {
					out.prevBlockPc = hex$2(bb);
					out.prevBlockShare = Math.round(bn / r.time * 1e3) / 1e3;
				}
			}
			return out;
		}).sort((a, b) => b.timeSamples - a.timeSamples || b.insnSamples - a.insnSamples || b.kernelSamples - a.kernelSamples);
		const procs = (a) => a.pids.size;
		const sites = [...this.siteMap.values()].map((a) => ({
			path: a.path,
			off: hex$2(a.at),
			...a.pid !== void 0 ? { pid: a.pid } : {},
			processes: procs(a),
			comm: topComm(a),
			timeSamples: a.time,
			insnSamples: a.insns,
			...tierFields(a.tiers)
		})).sort(byTime);
		const pages = [...this.pageMap.values()].map((a) => ({
			path: a.path,
			page: hex$2(a.at),
			...a.pid !== void 0 ? { pid: a.pid } : {},
			processes: procs(a),
			comm: topComm(a),
			timeSamples: a.time,
			insnSamples: a.insns
		})).sort(byTime);
		const files = [...this.fileMap.values()].map((a) => ({
			path: a.path,
			processes: procs(a),
			timeSamples: a.time,
			insnSamples: a.insns
		})).sort(byTime);
		let named = this.paths.length;
		if (k) {
			const dv = new DataView(k.memory.buffer);
			named = Math.min(this.maxFiles, dv.getUint32(this.addr + P_NR_FILES, true));
		}
		return {
			version: 2,
			hz: this.hz,
			timeSampling: !!this.ctl,
			insnPeriod: this.insns,
			durationMs: Math.round((this.tEnd || performance.now()) - this.t0),
			cpus: this.perCpu.length,
			totals: {
				user: sum("user"),
				kernel: sum("kernel"),
				idle: sum("idle"),
				insns: sum("insns"),
				dropped: sum("dropped"),
				ticks: sum("ticks"),
				missed: sum("missed")
			},
			perCpu: this.perCpu.map((c) => ({ ...c })),
			comms: [...this.commMap.values()].map((c) => ({ ...c })).sort((a, b) => b.user + b.kernel - (a.user + a.kernel) || b.insns - a.insns),
			where: {
				...this.where,
				named,
				maxFiles: this.maxFiles
			},
			files,
			pages,
			sites,
			rows,
			procPages: [...this.procPageMap.values()].map((p) => ({ ...p })).sort(byTime)
		};
	}
};
const pct = (n, d) => d ? `${(n * 100 / d).toFixed(1)}%` : "-";
const ratio = (t, tt, i, it) => {
	if (!tt || !it) return "-";
	if (!i) return t ? "inf" : "-";
	return (t / tt / (i / it)).toFixed(2);
};
function place(path, off, pid, symbol, width = 60) {
	const p = pid !== void 0 ? `${path}[${pid}]` : path;
	const tail = symbol ? `!${symbol}` : `+${off}`;
	const room = width - tail.length;
	return (p.length > room && room > 4 ? `...${p.slice(p.length - room + 3)}` : p) + tail;
}
function formatProfile(r, top = 15) {
	const t = r.totals;
	const time = t.user + t.kernel;
	const w = r.where;
	const lines = [];
	const row = (tm, ins) => `${pct(tm, t.user).padStart(6)} ${pct(ins, t.insns).padStart(6)} ${ratio(tm, t.user, ins, t.insns).padStart(6)}`;
	lines.push(`[profile] ${(r.durationMs / 1e3).toFixed(1)} s, ${r.cpus} CPU${r.cpus > 1 ? "s" : ""}; ` + (r.timeSampling ? `time ${r.hz} Hz: ${t.user} user, ${t.kernel} kernel, ${t.idle} idle samples, ${t.missed} of ${t.ticks} ticks missed (idle or in the kernel)` : "no time samples") + `; instructions every ${r.insnPeriod || "-"}: ${t.insns} samples; ${t.dropped} dropped`);
	lines.push(`[profile] user samples by what backs them: ${w.file} a file (${w.named} named), ${w.anon} anonymous, ${w.unknown} unknown` + (w.noName ? `, ${w.noName} in files beyond the ${w.maxFiles} names` : ""));
	lines.push("[profile] command            user%  kernel%  insn%");
	for (const c of r.comms.slice(0, 6)) lines.push(`[profile] ${c.comm.padEnd(16)} ${pct(c.user, time).padStart(7)} ${pct(c.kernel, time).padStart(8)} ${pct(c.insns, t.insns).padStart(6)}`);
	const order = (a) => r.timeSampling ? a : [...a].sort((x, y) => y.insnSamples - x.insnSamples);
	lines.push("[profile]  time%  insn%  ratio  procs  file");
	for (const f of order(r.files).slice(0, 8)) lines.push(`[profile] ${row(f.timeSamples, f.insnSamples)}  ${String(f.processes).padStart(5)}  ${f.path}`);
	lines.push("[profile]  time%  insn%  ratio  procs  page of file (over processes)");
	for (const p of order(r.pages).slice(0, top)) lines.push(`[profile] ${row(p.timeSamples, p.insnSamples)}  ${String(p.processes).padStart(5)}  ${place(p.path, p.page, p.pid, void 0)}${p.symbol ? `  ${p.symbol}` : ""}`);
	if (r.symbols) {
		lines.push("[profile]  time%  insn%  ratio  symbol");
		for (const y of order(r.symbols).slice(0, top)) lines.push(`[profile] ${row(y.timeSamples, y.insnSamples)}  ${place(y.path, "", void 0, y.symbol, 80)}`);
	}
	if (r.timeSampling) {
		lines.push("[profile]  time%  procs  block that ran (file+offset)                                     tier");
		for (const x of r.sites.slice(0, Math.min(top, 10))) {
			if (!x.timeSamples) break;
			lines.push(`[profile] ${pct(x.timeSamples, t.user).padStart(6)}  ${String(x.processes).padStart(5)}  ${place(x.path, x.off, x.pid, x.symbol, 64).padEnd(64)}  ${x.tier ?? "-"}`);
		}
	}
	return lines.join("\n");
}
function readElfSymbols(b) {
	if (b.length < 64 || b[0] !== 127 || b[1] !== 69 || b[2] !== 76 || b[3] !== 70 || b[4] !== 2 || b[5] !== 1) return void 0;
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const n64 = (o) => Number(dv.getBigUint64(o, true));
	const phoff = n64(32), shoff = n64(40);
	const phentsize = dv.getUint16(54, true), phnum = dv.getUint16(56, true);
	const shentsize = dv.getUint16(58, true), shnum = dv.getUint16(60, true);
	const loads = [];
	for (let i = 0; i < phnum; i++) {
		const p = phoff + i * phentsize;
		if (p + 56 > b.length) break;
		if (dv.getUint32(p, true) === 1) loads.push({
			off: n64(p + 8),
			size: n64(p + (dv.getUint32(p + 4, true) & 1 ? 40 : 32)),
			vaddr: n64(p + 16)
		});
	}
	const secs = [];
	for (let i = 0; i < shnum; i++) {
		const h = shoff + i * shentsize;
		if (h + 64 > b.length) break;
		secs.push({
			type: dv.getUint32(h + 4, true),
			off: n64(h + 24),
			size: n64(h + 32),
			link: dv.getUint32(h + 40, true),
			entsize: n64(h + 56)
		});
	}
	let syms = [];
	for (const type of [2, 11]) {
		for (const sec of secs) {
			if (sec.type !== type || sec.entsize < 24) continue;
			const str = secs[sec.link];
			if (!str) continue;
			for (let o = sec.off; o + 24 <= Math.min(sec.off + sec.size, b.length); o += sec.entsize) {
				const info = b[o + 4], shndx = dv.getUint16(o + 6, true), value = n64(o + 8);
				const st = info & 15;
				if (st !== 2 && st !== 10 || !shndx || !value) continue;
				let e = str.off + dv.getUint32(o, true);
				const s0 = e;
				while (e < b.length && b[e] !== 0) e++;
				syms.push({
					addr: value,
					size: n64(o + 16),
					name: decoder$1.decode(b.subarray(s0, e))
				});
			}
		}
		if (syms.length) break;
	}
	syms.sort((x, y) => x.addr - y.addr || y.size - x.size);
	syms = syms.filter((x, i) => i === 0 || x.addr !== syms[i - 1].addr);
	return {
		loads,
		addrs: syms.map((x) => x.addr),
		names: syms.map((x) => x.name),
		sizes: syms.map((x) => x.size)
	};
}
function symbolAt(e, off) {
	const seg = e.loads.find((l) => off >= l.off && off < l.off + l.size);
	if (!seg) return void 0;
	const va = off - seg.off + seg.vaddr;
	let lo = 0, hi = e.addrs.length - 1, at = -1;
	while (lo <= hi) {
		const mid = lo + hi >> 1;
		if (e.addrs[mid] <= va) {
			at = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	if (at < 0) return void 0;
	const delta = va - e.addrs[at];
	const size = e.sizes[at];
	if (size && delta - size > 65536) return void 0;
	return `${e.names[at]}+0x${delta.toString(16)}${size && delta >= size ? "?" : ""}`;
}
async function symbolizeProfile(r, read, top = 200) {
	const want = /* @__PURE__ */ new Set();
	const byIns = (a) => [...a].sort((x, y) => y.insnSamples - x.insnSamples);
	for (const list of [
		r.sites.slice(0, top),
		byIns(r.sites).slice(0, top),
		r.pages.slice(0, top),
		byIns(r.pages).slice(0, top)
	]) for (const x of list) if (x.pid === void 0) want.add(x.path);
	const elf = /* @__PURE__ */ new Map();
	for (const p of want) try {
		const bytes = await read(p);
		const e = bytes && readElfSymbols(bytes);
		if (e && e.addrs.length) elf.set(p, e);
	} catch {}
	const syms = /* @__PURE__ */ new Map();
	const best = /* @__PURE__ */ new Map();
	for (const x of r.sites) {
		const e = x.pid === void 0 ? elf.get(x.path) : void 0;
		const name = e && symbolAt(e, Number(BigInt(x.off)));
		if (!name) continue;
		x.symbol = name;
		const fn = name.replace(/\+0x[0-9a-f]+(\??)$/, "$1");
		const key = `${x.path}\0${fn}`;
		let y = syms.get(key);
		if (!y) syms.set(key, y = {
			path: x.path,
			symbol: fn,
			timeSamples: 0,
			insnSamples: 0
		});
		y.timeSamples += x.timeSamples;
		y.insnSamples += x.insnSamples;
		const pk = `${x.path}\0${BigInt(x.off) >> 12n}`;
		const n = x.timeSamples + x.insnSamples;
		if (n > (best.get(pk)?.n ?? 0)) best.set(pk, {
			n,
			symbol: fn
		});
	}
	for (const p of r.pages) {
		const b = p.pid === void 0 ? best.get(`${p.path}\0${BigInt(p.page) >> 12n}`) : void 0;
		if (b) p.symbol = b.symbol;
	}
	r.symbols = [...syms.values()].sort(byTime);
	return r;
}
const ENODEV = 19;
const SOUND_FORMAT_U8 = 1;
const SOUND_FORMAT_S16_LE = 2;
const EV_NAMES = [
	"close",
	"open",
	"prepare",
	"start",
	"stop"
];
var SoundHost = class {
	enabled;
	probed = false;
	state = {
		open: false,
		playing: false,
		format: null
	};
	stats = {
		opens: 0,
		starts: 0,
		stops: 0,
		chunks: 0,
		frames: 0,
		maxLagMs: 0
	};
	#sink;
	#memory;
	#log;
	#t0 = 0;
	#received = 0;
	constructor(opts) {
		this.enabled = !!opts.enabled;
		this.#sink = typeof opts.enabled === "object" ? opts.enabled : {};
		this.#memory = opts.memory;
		this.#log = opts.log ?? (() => {});
	}
	get playing() {
		return this.state.playing;
	}
	#event(ev, format) {
		const s = this.state;
		if (ev === "open") this.stats.opens++;
		if (ev === "start") {
			this.stats.starts++;
			this.#t0 = performance.now();
			this.#received = 0;
		}
		if (ev === "stop") this.stats.stops++;
		this.state = {
			open: ev !== "close",
			playing: ev === "start",
			format: ev === "prepare" ? format : ev === "open" || ev === "close" ? null : s.format
		};
		try {
			this.#sink.onState?.(this.state, ev);
		} catch (e) {
			this.#log(`[sound] onState failed: ${e}`);
		}
	}
	saveState() {
		const s = this.state;
		return { state: {
			open: s.open,
			playing: s.playing,
			format: s.format && { ...s.format }
		} };
	}
	restoreState(s) {
		this.probed = true;
		this.state = {
			open: false,
			playing: false,
			format: null
		};
		this.#t0 = performance.now();
		this.#received = 0;
		const notify = (state, ev) => {
			this.state = state;
			try {
				this.#sink.onState?.(state, ev);
			} catch (e) {
				this.#log(`[sound] onState failed: ${e}`);
			}
		};
		const { open, playing, format } = s.state;
		if (!open) return;
		notify({
			open: true,
			playing: false,
			format: null
		}, "open");
		if (format) notify({
			open: true,
			playing: false,
			format: { ...format }
		}, "prepare");
		if (format && playing) notify({
			open: true,
			playing: true,
			format: { ...format }
		}, "start");
	}
	imports() {
		return {
			wasm_driver_sound_init: () => {
				this.probed = true;
				if (!this.enabled) return -BigInt(ENODEV);
				const r = Math.round(this.#sink.rate ?? 0);
				return BigInt(r > 0 && r < 1e6 ? r : 0);
			},
			wasm_driver_sound_event: (event, rate, channels, format) => {
				let ev = EV_NAMES[event];
				if (!ev) return;
				let f = null;
				if (ev === "prepare") {
					const size = format === 1 ? 1 : format === 2 ? 2 : 0;
					if (!size || channels < 1 || channels > 2 || !rate) {
						this.#log(`[sound] unexpected format: rate ${rate}, ${channels} channels, format ${format}`);
						return;
					}
					f = {
						rate,
						channels,
						format,
						frameBytes: size * channels
					};
				}
				if (ev === "stop" && rate === 1) ev = "drain";
				this.#event(ev, f);
			},
			wasm_driver_sound_write: (buf, bytes) => {
				const f = this.state.format;
				const n = Number(bytes);
				if (!f || n <= 0) return 0n;
				const addr = Number(buf);
				const mem = this.#memory().buffer;
				if (addr + n > mem.byteLength) return 0n;
				const frames = Math.floor(n / f.frameBytes);
				const lag = ((performance.now() - this.#t0) * f.rate / 1e3 - this.#received) * 1e3 / f.rate;
				if (lag > this.stats.maxLagMs) this.stats.maxLagMs = lag;
				this.#received += frames;
				this.stats.chunks++;
				this.stats.frames += frames;
				const onChunk = this.#sink.onChunk;
				if (!onChunk) return 0n;
				const data = new Uint8Array(mem, addr, frames * f.frameBytes).slice();
				let queued = 0;
				try {
					queued = onChunk({
						format: f,
						data,
						frames
					});
				} catch (e) {
					this.#log(`[sound] onChunk failed: ${e}`);
				}
				return BigInt(Math.max(0, Math.round(queued || 0)));
			}
		};
	}
};
function pcmToFloat32(data, format, out) {
	const n = format.format === 1 ? data.length : data.length >> 1;
	const f = out && out.length === n ? out : new Float32Array(n);
	if (format.format === 1) for (let i = 0; i < n; i++) f[i] = (data[i] - 128) / 128;
	else {
		const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
		for (let i = 0; i < n; i++) f[i] = dv.getInt16(i * 2, true) / 32768;
	}
	return f;
}
function wavHeader(format, dataBytes) {
	const h = /* @__PURE__ */ new Uint8Array(44);
	const dv = new DataView(h.buffer);
	const ascii = (o, s) => {
		for (let i = 0; i < 4; i++) h[o + i] = s.charCodeAt(i);
	};
	ascii(0, "RIFF");
	dv.setUint32(4, 36 + dataBytes, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	dv.setUint32(16, 16, true);
	dv.setUint16(20, 1, true);
	dv.setUint16(22, format.channels, true);
	dv.setUint32(24, format.rate, true);
	dv.setUint32(28, format.rate * format.frameBytes, true);
	dv.setUint16(32, format.frameBytes, true);
	dv.setUint16(34, format.frameBytes / format.channels * 8, true);
	ascii(36, "data");
	dv.setUint32(40, dataBytes, true);
	return h;
}
function convertPcm(data, from, to) {
	if (from.rate === to.rate && from.channels === to.channels && from.format === to.format) return data;
	const src = pcmToFloat32(data, from);
	const inFrames = Math.floor(src.length / from.channels);
	const outFrames = Math.floor(inFrames * to.rate / from.rate);
	const out = new Uint8Array(outFrames * to.frameBytes);
	const dv = new DataView(out.buffer);
	const sample = (frame, ch) => {
		const c = Math.min(ch, from.channels - 1);
		if (to.channels === 1 && from.channels === 2) return (src[frame * 2] + src[frame * 2 + 1]) / 2;
		return src[frame * from.channels + c];
	};
	for (let i = 0; i < outFrames; i++) {
		const x = i * from.rate / to.rate;
		const i0 = Math.floor(x), i1 = Math.min(i0 + 1, inFrames - 1), t = x - i0;
		for (let ch = 0; ch < to.channels; ch++) {
			const v = Math.max(-1, Math.min(1, sample(i0, ch) * (1 - t) + sample(i1, ch) * t));
			const o = i * to.frameBytes + ch * (to.frameBytes / to.channels);
			if (to.format === 1) out[o] = Math.round(v * 127 + 128);
			else dv.setInt16(o, Math.round(v * 32767), true);
		}
	}
	return out;
}
const DEVICE_KINDS = [
	"display",
	"sound",
	"vsock",
	"shm",
	"network",
	"gpu"
];
const HOLD_CLOCK_LAG_MS = 1e3;
const SNAPSHOT_COMMIT_TIMEOUT_MS = 3e4;
var SnapshotCommitError = class extends Error {
	timedOut;
	constructor(message, opts = {}) {
		super(message, opts.cause === void 0 ? void 0 : { cause: opts.cause });
		this.name = "SnapshotCommitError";
		this.timedOut = !!opts.timedOut;
	}
};
function awakeTimeout(fn, ms, step = 1e3) {
	let left = ms, last = performance.now(), timer;
	const tick = () => {
		const now = performance.now();
		left -= Math.min(now - last, 2 * step);
		last = now;
		if (left <= 0) fn();
		else timer = setTimeout(tick, Math.min(step, left));
	};
	timer = setTimeout(tick, Math.min(step, ms));
	return () => clearTimeout(timer);
}
function snapshotDeviceMismatch(saved, present, mac) {
	for (const kind of DEVICE_KINDS) {
		const had = kind in saved && saved[kind] !== void 0;
		if (had && !present[kind]) return `the snapshot has a ${kind} device, which this machine is not given`;
		if (!had && present[kind]) return `the snapshot has no ${kind} device, but this machine is given one`;
	}
	const m = saved.network?.mac;
	if (m && mac && (m.length !== mac.length || m.some((b, i) => b !== mac[i]))) return "the network device has another MAC than in the snapshot";
	return null;
}
function snapshotCpuMismatch(saved, cpus) {
	const had = saved.cpus ?? 1;
	if (had === cpus) return null;
	return `the snapshot has ${had} CPU${had === 1 ? "" : "s"}, this machine has ${cpus}`;
}
const diskName = (i) => `wd${String.fromCharCode(97 + i)}`;
function snapshotDiskMismatch(saved, disks) {
	for (let i = 0; i < Math.max(saved.length, disks.length); i++) {
		const s = saved[i], d = disks[i];
		if (!d) return `disk ${diskName(i)} (${s.name}) is missing: the snapshot has ${saved.length} disk(s), ${disks.length} given`;
		if (!s) return `disk ${diskName(i)} was not in the snapshot: it has ${saved.length} disk(s), ${disks.length} given`;
		if (typeof d.snapshotState !== "function") return `disk ${diskName(i)} cannot be checked against the snapshot (no snapshotState)`;
		let now;
		try {
			now = d.snapshotState();
		} catch (e) {
			return `disk ${diskName(i)}: ${e.message}`;
		}
		if (now.identity !== s.identity) return `disk ${diskName(i)} (${now.name}) is not the disk of the snapshot (${s.name})`;
		if (now.gen !== s.gen) return `disk ${diskName(i)} (${now.name}) was written after the snapshot (generation ${now.gen}, the snapshot has ${s.gen})`;
		if ((now.stamp ?? "") !== (s.stamp ?? "")) return `disk ${diskName(i)} (${now.name}) was changed by another program after the snapshot (${s.stamp ?? "-"}, now ${now.stamp ?? "-"})`;
	}
	return null;
}
const PAGE = 4096;
const CHUNK = 65536;
const usedChunks = /* @__PURE__ */ new WeakMap();
function usedOf(mem) {
	const used = usedChunks.get(mem);
	return used && used.length === Math.ceil(mem.byteLength / CHUNK) ? used : void 0;
}
const SHARED_SNAPSHOT_BYTES = 2 ** 31;
function newSnapshotMemory(bytes) {
	if (bytes >= SHARED_SNAPSHOT_BYTES && typeof SharedArrayBuffer === "function") return new Uint8Array(new SharedArrayBuffer(bytes, { maxByteLength: bytes }), 0, bytes);
	return new Uint8Array(bytes);
}
function snapshotTransfer(m) {
	return m.buffer instanceof ArrayBuffer ? [m.buffer] : [];
}
function sentSnapshot(s) {
	const used = usedOf(s.memory);
	return used ? {
		...s,
		usedChunks: used
	} : s;
}
function copySnapshotMemory(mem, free, bits) {
	const out = newSnapshotMemory(mem.byteLength);
	if (!free || !bits) {
		out.set(mem);
		return {
			memory: out,
			freeBytes: 0
		};
	}
	const used = new Uint8Array(Math.ceil(mem.byteLength / CHUNK));
	const pages = Math.min(bits, Math.floor(mem.byteLength / PAGE), free.length * 8);
	let runStart = -1, skipped = 0;
	const flush = (end) => {
		if (runStart >= 0) {
			out.set(mem.subarray(runStart * PAGE, end * PAGE), runStart * PAGE);
			used.fill(1, Math.floor(runStart * PAGE / CHUNK), Math.ceil(end * PAGE / CHUNK));
		}
		runStart = -1;
	};
	for (let p = 0; p < pages;) {
		const b = free[p >> 3];
		if ((p & 7) === 0 && p + 8 <= pages && (b === 0 || b === 255)) {
			if (b === 0) {
				if (runStart < 0) runStart = p;
			} else {
				flush(p);
				skipped += 8;
			}
			p += 8;
			continue;
		}
		if (b & 1 << (p & 7)) {
			flush(p);
			skipped++;
		} else if (runStart < 0) runStart = p;
		p++;
	}
	flush(pages);
	if (pages * PAGE < mem.byteLength) {
		out.set(mem.subarray(pages * PAGE), pages * PAGE);
		used.fill(1, Math.floor(pages * PAGE / CHUNK));
	}
	usedChunks.set(out, used);
	return {
		memory: out,
		freeBytes: skipped * PAGE
	};
}
const MAGIC = "KWSNAP1\n";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function isZero(u8, off) {
	const w = new Int32Array(u8.buffer, u8.byteOffset + off, CHUNK / 4);
	for (let i = 0; i < w.length; i += 8) if (w[i] | w[i + 1] | w[i + 2] | w[i + 3] | w[i + 4] | w[i + 5] | w[i + 6] | w[i + 7]) return false;
	return true;
}
function receivedSnapshot(s) {
	const { usedChunks: used, ...rest } = s;
	const m = s.memory;
	const memory = m.byteLength === 0 && m.buffer.byteLength > 0 ? new Uint8Array(m.buffer) : m;
	if (used instanceof Uint8Array) usedChunks.set(memory, used);
	return memory === m && used === void 0 ? s : {
		...rest,
		memory
	};
}
function restoreSnapshotMemory(dst, src, dstUsedEnd = dst.byteLength) {
	if (dst.byteLength !== src.byteLength || src.byteLength % CHUNK || src.byteOffset % 4 || dst.byteOffset % 4) {
		dst.set(src);
		return;
	}
	const known = usedOf(src);
	const used = new Uint8Array(src.byteLength / CHUNK);
	let runStart = -1;
	const flush = (end) => {
		if (runStart >= 0) dst.set(src.subarray(runStart, end), runStart);
		runStart = -1;
	};
	for (let off = 0, c = 0; off < src.byteLength; off += CHUNK, c++) {
		if ((!known || known[c]) && !isZero(src, off)) {
			if (runStart < 0) runStart = off;
			used[c] = 1;
			continue;
		}
		flush(off);
		if (off < dstUsedEnd && !isZero(dst, off)) dst.fill(0, off, off + CHUNK);
	}
	flush(src.byteLength);
	usedChunks.set(dst, used);
}
function encodeSnapshot(s) {
	const mem = s.memory;
	if (mem.byteLength % CHUNK || mem.byteOffset % 4) throw new Error("snapshot memory must be whole 64 KiB pages");
	const chunks = [];
	const known = usedOf(mem);
	for (let off = 0, c = 0; off < mem.byteLength; off += CHUNK, c++) if ((!known || known[c]) && !isZero(mem, off)) chunks.push(c);
	const header = encoder.encode(JSON.stringify({
		version: s.version,
		fingerprint: s.fingerprint,
		cpus: s.cpus ?? 1,
		memory64: s.memory64,
		memoryBytes: mem.byteLength,
		freeBytes: s.freeBytes ?? 0,
		monotonicMs: s.monotonicMs,
		consoleSize: s.consoleSize,
		inputBytes: s.input.length,
		chunks: chunks.length,
		disks: s.disks,
		devices: s.devices,
		...s.ttys?.length ? { ttys: s.ttys } : {}
	}));
	const out = new Uint8Array(12 + header.length + s.input.length + chunks.length * 65540);
	const dv = new DataView(out.buffer);
	let p = 0;
	out.set(encoder.encode(MAGIC), p);
	p += 8;
	dv.setUint32(p, header.length, true);
	p += 4;
	out.set(header, p);
	p += header.length;
	out.set(s.input, p);
	p += s.input.length;
	for (const c of chunks) {
		dv.setUint32(p, c, true);
		out.set(mem.subarray(c * CHUNK, (c + 1) * CHUNK), p + 4);
		p += 65540;
	}
	return out;
}
function decodeSnapshot(bytes) {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (decoder.decode(bytes.subarray(0, 8)) !== MAGIC) throw new Error("not an unkernel snapshot");
	let p = 8;
	const hlen = dv.getUint32(p, true);
	p += 4;
	const h = JSON.parse(decoder.decode(bytes.subarray(p, p + hlen)));
	p += hlen;
	if (h.version !== 1) throw new Error(`unsupported snapshot version ${h.version}`);
	const input = bytes.slice(p, p + h.inputBytes);
	p += h.inputBytes;
	const memory = newSnapshotMemory(h.memoryBytes);
	const used = new Uint8Array(Math.ceil(h.memoryBytes / CHUNK));
	for (let i = 0; i < h.chunks; i++) {
		const c = dv.getUint32(p, true);
		memory.set(bytes.subarray(p + 4, p + 4 + CHUNK), c * CHUNK);
		used[c] = 1;
		p += 65540;
	}
	usedChunks.set(memory, used);
	const ttys = Array.isArray(h.ttys) ? h.ttys.filter((t) => t && typeof t.id === "string") : [];
	return {
		version: 1,
		fingerprint: h.fingerprint,
		cpus: Number.isInteger(h.cpus) && h.cpus > 1 ? h.cpus : 1,
		memory64: h.memory64,
		memory,
		freeBytes: h.freeBytes ?? 0,
		monotonicMs: h.monotonicMs,
		consoleSize: h.consoleSize,
		input,
		disks: Array.isArray(h.disks) ? h.disks : [],
		devices: h.devices && typeof h.devices === "object" ? h.devices : {},
		...ttys.length ? { ttys } : {}
	};
}
const VIRTIO_F_VERSION_1 = 1n << 32n;
const VIRTQ_DESC_F_NEXT = 1;
const VIRTQ_DESC_F_WRITE = 2;
const VIRTQ_DESC_F_INDIRECT = 4;
const VIRTQ_AVAIL_F_NO_INTERRUPT = 1;
const INT_VRING = 1;
const INT_CONFIG = 2;
var Virtqueue = class {
	index;
	num;
	desc;
	avail;
	used;
	lastAvail = 0;
	alive = true;
	#mem;
	#onPush;
	constructor(index, num, desc, avail, used, mem, onPush) {
		this.index = index;
		this.num = num;
		this.desc = desc;
		this.avail = avail;
		this.used = used;
		this.#mem = mem;
		this.#onPush = onPush;
	}
	#dv() {
		return new DataView(this.#mem().buffer);
	}
	#shared() {
		return typeof SharedArrayBuffer !== "undefined" && this.#mem().buffer instanceof SharedArrayBuffer;
	}
	#availIdx() {
		const a = this.avail + 2;
		if (this.#shared()) return Atomics.load(new Uint16Array(this.#mem().buffer, a, 1), 0);
		return this.#dv().getUint16(a, true);
	}
	pending() {
		return this.#availIdx() - this.lastAvail & 65535;
	}
	noInterrupt() {
		return (this.#dv().getUint16(this.avail, true) & VIRTQ_AVAIL_F_NO_INTERRUPT) !== 0;
	}
	pop() {
		if (!this.alive || !this.pending()) return null;
		const dv = this.#dv();
		const size = dv.byteLength;
		const head = dv.getUint16(this.avail + 4 + 2 * (this.lastAvail % this.num), true);
		this.lastAvail = this.lastAvail + 1 & 65535;
		if (head >= this.num) throw new Error(`queue ${this.index}: head ${head} out of range`);
		const chain = {
			head,
			readable: [],
			writable: [],
			writableLen: 0
		};
		let i = head;
		for (let n = 0;; n++) {
			if (n >= this.num) throw new Error(`queue ${this.index}: descriptor loop at ${head}`);
			const d = this.desc + 16 * i;
			const addr = Number(dv.getBigUint64(d, true));
			const len = dv.getUint32(d + 8, true);
			const flags = dv.getUint16(d + 12, true);
			const next = dv.getUint16(d + 14, true);
			if (flags & VIRTQ_DESC_F_INDIRECT) throw new Error(`queue ${this.index}: indirect descriptor (not negotiated)`);
			if (addr + len > size) throw new Error(`queue ${this.index}: buffer 0x${addr.toString(16)}+${len} outside memory`);
			if (flags & VIRTQ_DESC_F_WRITE) {
				chain.writable.push({
					addr,
					len
				});
				chain.writableLen += len;
			} else {
				if (chain.writable.length) throw new Error(`queue ${this.index}: readable descriptor after a writable one`);
				chain.readable.push({
					addr,
					len
				});
			}
			if (!(flags & VIRTQ_DESC_F_NEXT)) break;
			if (next >= this.num) throw new Error(`queue ${this.index}: next ${next} out of range`);
			i = next;
		}
		return chain;
	}
	read(chain, max = 1e400) {
		const total = Math.min(max, chain.readable.reduce((n, b) => n + b.len, 0));
		const out = new Uint8Array(total);
		const mem = new Uint8Array(this.#mem().buffer);
		let off = 0;
		for (const b of chain.readable) {
			if (off >= total) break;
			const n = Math.min(b.len, total - off);
			out.set(mem.subarray(b.addr, b.addr + n), off);
			off += n;
		}
		return out;
	}
	write(chain, data) {
		const mem = new Uint8Array(this.#mem().buffer);
		let off = 0;
		for (const b of chain.writable) {
			if (off >= data.length) break;
			const n = Math.min(b.len, data.length - off);
			mem.set(data.subarray(off, off + n), b.addr);
			off += n;
		}
		return off;
	}
	push(chain, len) {
		if (!this.alive) return;
		const dv = this.#dv();
		const idx = dv.getUint16(this.used + 2, true);
		const e = this.used + 4 + 8 * (idx % this.num);
		dv.setUint32(e, chain.head, true);
		dv.setUint32(e + 4, len, true);
		const next = idx + 1 & 65535;
		if (this.#shared()) Atomics.store(new Uint16Array(this.#mem().buffer, this.used + 2, 1), 0, next);
		else dv.setUint16(this.used + 2, next, true);
		this.#onPush(this);
	}
	saveState() {
		return {
			num: this.num,
			desc: this.desc,
			avail: this.avail,
			used: this.used,
			lastAvail: this.lastAvail
		};
	}
};
var VirtioHost = class {
	#devices = [];
	#memory;
	#raise;
	#log;
	probed = false;
	stats = {
		notifies: 0,
		pushes: 0,
		interrupts: 0
	};
	constructor(opts) {
		this.#memory = opts.memory;
		this.#raise = opts.raise;
		this.#log = opts.log ?? (() => {});
	}
	add(model) {
		this.#devices.push({
			model,
			status: 0,
			features: 0n,
			isr: 0,
			queues: []
		});
		return this.#devices.length - 1;
	}
	get enabled() {
		return this.#devices.length > 0;
	}
	configChanged(model) {
		const d = this.#devices.find((s) => s.model === model);
		if (!d || !(d.status & 4)) return;
		d.isr |= INT_CONFIG;
		this.stats.interrupts++;
		this.#raise();
	}
	#slot(dev) {
		return this.#devices[dev >>> 0];
	}
	#dropQueues(d) {
		for (const q of d.queues) if (q) q.alive = false;
		d.queues = [];
	}
	#reset(d) {
		d.status = 0;
		d.features = 0n;
		d.isr = 0;
		this.#dropQueues(d);
		try {
			d.model.reset();
		} catch (e) {
			this.#log(`[virtio] reset: ${e?.message ?? e}`);
		}
	}
	#pushed(d, q) {
		this.stats.pushes++;
		if (q.noInterrupt()) return;
		d.isr |= INT_VRING;
		this.stats.interrupts++;
		this.#raise();
	}
	#broken(d, e) {
		this.#log(`[virtio] device ${d.model.deviceId}: ${e?.message ?? e}; the device stops`);
		d.status |= 64;
		this.#dropQueues(d);
	}
	imports() {
		return {
			wasm_driver_virtio_init: (index) => {
				this.probed = true;
				return this.#devices[index >>> 0]?.model.deviceId ?? 0;
			},
			wasm_driver_virtio_features: (dev) => {
				const d = this.#slot(dev);
				return d ? (d.model.features() | VIRTIO_F_VERSION_1) & 18446744073709551615n : 0n;
			},
			wasm_driver_virtio_set_features: (dev, features) => {
				const d = this.#slot(dev);
				if (!d) return -19;
				const offered = d.model.features() | VIRTIO_F_VERSION_1;
				const f = BigInt.asUintN(64, features);
				if (f & ~offered) return -22;
				d.features = f;
				d.model.setFeatures?.(f);
				return 0;
			},
			wasm_driver_virtio_config: (dev, offset, buf, len, write) => {
				const d = this.#slot(dev);
				const mem = new Uint8Array(this.#memory().buffer);
				const at = Number(buf), n = len >>> 0, off = offset >>> 0;
				if (!d) return;
				if (write) {
					d.model.configWrite?.(off, mem.slice(at, at + n));
					return;
				}
				const cfg = d.model.config();
				const out = new Uint8Array(n);
				out.set(cfg.subarray(Math.min(off, cfg.length), Math.min(off + n, cfg.length)));
				mem.set(out, at);
			},
			wasm_driver_virtio_status: (dev, status) => {
				const d = this.#slot(dev);
				if (!d) return;
				status &= 255;
				if (!status) {
					this.#reset(d);
					return;
				}
				const was = d.status;
				d.status = status;
				if (status & 4 && !(was & 4)) d.model.ready?.(d.queues);
			},
			wasm_driver_virtio_queue_max: (dev, index) => this.#slot(dev)?.model.queueSizes[index >>> 0] ?? 0,
			wasm_driver_virtio_queue_set: (dev, index, num, desc, avail, used) => {
				const d = this.#slot(dev);
				const i = index >>> 0, n = num >>> 0;
				if (!d || i >= d.model.queueSizes.length) return -2;
				const old = d.queues[i];
				if (old) old.alive = false;
				if (!n) {
					d.queues[i] = null;
					return 0;
				}
				if (n > d.model.queueSizes[i] || n & n - 1) return -22;
				const size = this.#memory().buffer.byteLength;
				const a = [
					Number(desc),
					Number(avail),
					Number(used)
				];
				if (a[0] + 16 * n > size || a[1] + 6 + 2 * n > size || a[2] + 6 + 8 * n > size) return -22;
				d.queues[i] = new Virtqueue(i, n, a[0], a[1], a[2], this.#memory, (q) => this.#pushed(d, q));
				return 0;
			},
			wasm_driver_virtio_notify: (dev, index) => {
				const d = this.#slot(dev);
				const q = d?.queues[index >>> 0];
				this.stats.notifies++;
				if (!d || !q) return;
				try {
					d.model.notify(q);
				} catch (e) {
					this.#broken(d, e);
				}
			},
			wasm_driver_virtio_interrupt: (dev) => {
				const d = this.#slot(dev);
				if (!d) return 0;
				const isr = d.isr;
				d.isr = 0;
				return isr;
			}
		};
	}
	blocker() {
		return this.#devices.map((d) => d.model.blocker?.() ?? "").filter(Boolean).join(", ");
	}
	held() {
		return this.#devices.map((d) => d.model.held?.() ?? "").filter(Boolean).join(", ");
	}
	saveState() {
		return this.#devices.map((d) => ({
			status: d.status,
			features: d.features.toString(),
			isr: d.isr,
			queues: d.queues.map((q) => q?.saveState() ?? null)
		}));
	}
	restoreState(s) {
		this.probed = true;
		s.forEach((t, i) => {
			const d = this.#devices[i];
			if (!d) return;
			d.status = t.status;
			d.features = BigInt(t.features);
			d.isr = t.isr;
			d.model.setFeatures?.(d.features);
			d.queues = t.queues.map((q, qi) => {
				if (!q) return null;
				const vq = new Virtqueue(qi, q.num, q.desc, q.avail, q.used, this.#memory, (x) => this.#pushed(d, x));
				vq.lastAvail = q.lastAvail;
				return vq;
			});
			if (d.status & 4) d.model.ready?.(d.queues);
		});
	}
};
const IRQ_SYNC = 4;
const IRQ_INPUT = 5;
const IRQ_VSOCK = 6;
const IRQ_SHM = 7;
const IRQ_VIRTIO = 10;
const textDecoder = new TextDecoder();
function moduleFeature(module, feature) {
	const secs = WebAssembly.Module.customSections(module, "target_features");
	if (!secs.length) return void 0;
	const b = new Uint8Array(secs[0]);
	let p = 0;
	const leb = () => {
		let v = 0, s = 0, c;
		do {
			c = b[p++];
			v |= (c & 127) << s;
			s += 7;
		} while (c & 128);
		return v;
	};
	for (let n = leb(); n > 0 && p < b.length; n--) {
		const prefix = String.fromCharCode(b[p++]);
		const len = leb();
		const name = textDecoder.decode(b.subarray(p, p + len));
		p += len;
		if (name === feature) return prefix !== "-";
	}
	return false;
}
function moduleIsMemory64(module) {
	return moduleFeature(module, "memory64") ?? true;
}
function moduleIsSharedMemory(module) {
	return moduleFeature(module, "atomics") ?? false;
}
function bundledBoot(module) {
	const sec = (name) => WebAssembly.Module.customSections(module, name)[0];
	const initrd = sec("unkernel.initrd");
	const cmdline = sec("unkernel.cmdline");
	const datadisk = sec("unkernel.datadisk");
	return {
		initrd: initrd ? new Uint8Array(initrd) : void 0,
		cmdline: cmdline ? textDecoder.decode(cmdline) : void 0,
		datadisk: datadisk ? new Uint8Array(datadisk) : void 0
	};
}
var Kernel = class Kernel {
	opts;
	log;
	input;
	inputOffset;
	consoleSize;
	idleWake;
	resumers;
	onStage;
	exited;
	exit;
	result;
	stats;
	block;
	jit;
	netRx;
	display;
	evdev;
	sound;
	vsock;
	shm;
	virtio;
	gpu;
	memory;
	memory64 = false;
	sharedMemory = false;
	wasi;
	exports;
	irqAddr;
	retFromFork;
	bootTime = 0;
	poller = null;
	fingerprint = "";
	netMac = null;
	snapshotWaiter = null;
	snapshotHeld = false;
	heldDurable = null;
	clockEpoch = null;
	wallClock = () => Date.now();
	onSnapshot;
	cpus = 1;
	secondaries = [];
	jitMirrors = [];
	conRing = null;
	conFull = "wait";
	conReader = null;
	consoleOrder = null;
	conDropped = 0;
	profiler = null;
	constructor(opts) {
		this.opts = opts;
		this.log = opts.log ?? ((m) => console.error(m));
		this.input = [];
		this.inputOffset = 0;
		this.consoleSize = 0;
		this.idleWake = null;
		this.resumers = /* @__PURE__ */ new Map();
		this.onStage = opts.onStage ?? (() => {});
		this.result = void 0;
		this.exited = new Promise((r) => this.exit = (res) => {
			if (this.result) return;
			this.consoleFlush(true);
			this.conRing?.close();
			this.profiler?.stop();
			this.result = res;
			const w = this.snapshotWaiter;
			this.snapshotWaiter = null;
			w?.reject(/* @__PURE__ */ new Error(`snapshot: the kernel ended before its consistent point (${res.reason})`));
			try {
				this.onStage("exit", res);
			} catch {}
			r(res);
		});
		this.stats = {
			switches: 0,
			idles: 0,
			yields: 0
		};
		this.block = new BlockHost(this, opts.disks ?? []);
		const smp = WebAssembly.Module.imports(opts.module).some((i) => i.module === "unkernel" && i.name === "wasm_cpu_start");
		const cpus = Math.max(1, Math.floor(opts.cpus ?? 1));
		if (cpus > 1 && !smp) this.log(`[host] this kernel is not SMP: ${cpus} CPUs asked, it runs on one`);
		else if (cpus > 1 && !opts.spawnCpu) this.log("[host] this platform cannot start CPU threads: the SMP kernel runs on one CPU");
		else if (smp) {
			const why = cpus > 1 ? opts.whyNoCpus?.() : void 0;
			if (why) this.log(`[host] cannot start CPU threads here (${why}): the SMP kernel runs on one CPU`);
			else this.cpus = cpus;
		}
		if (this.cpus > 1) this.initConsoleRing();
		this.jit = new JitHost({
			enabled: opts.jit,
			memory: () => this.memory,
			memory64: () => this.memory64,
			log: this.log
		});
		this.netRx = [];
		this.display = new DisplayHost({
			enabled: opts.display,
			memory: () => this.memory,
			onChange: opts.onDisplay,
			log: this.log
		});
		this.evdev = new InputHost({
			enabled: !!opts.display,
			memory: () => this.memory,
			raise: () => this.raiseIrq(IRQ_INPUT),
			onChange: opts.onInput
		});
		this.sound = new SoundHost({
			enabled: opts.sound,
			memory: () => this.memory,
			log: this.log
		});
		this.vsock = new VsockDevice({
			enabled: opts.vsock,
			memory: () => this.memory,
			raise: () => this.raiseIrq(IRQ_VSOCK),
			onPacket: opts.onVsockPacket,
			onInit: opts.onVsockInit
		});
		this.shm = new ShmDevice({
			enabled: opts.shm,
			memory: () => this.memory,
			raise: () => this.raiseIrq(IRQ_SHM),
			driver: WebAssembly.Module.imports(opts.module).some((i) => i.module === "unkernel" && i.name === "wasm_driver_shm_init")
		});
		this.virtio = new VirtioHost({
			memory: () => this.memory,
			raise: () => this.raiseIrq(IRQ_VIRTIO),
			log: this.log
		});
		if (opts.gpu) {
			const gpu = new VirtioGpu({
				memory: () => this.memory,
				display: this.display,
				backend: opts.gpuBackend,
				log: this.log
			});
			this.virtio.add(gpu);
			gpu.configNotifier = () => this.virtio.configChanged(gpu);
			this.gpu = gpu;
		}
		this.exited.then(() => {
			this.vsock.close();
			this.shm.close();
			for (const c of this.secondaries) c.terminate();
		});
		this.exports = void 0;
		this.irqAddr = void 0;
	}
	receiveFrame(frame) {
		this.netRx.push(frame);
		this.setIrqBits(4);
		this.wake();
	}
	raiseIrq(bit) {
		if (!this.result) this.setIrqBits(1 << bit);
		this.wake();
	}
	setIrqBits(bits) {
		if (this.irqAddr === void 0) return;
		if (this.sharedMemory) Atomics.or(new Int32Array(this.memory.buffer), this.irqAddr >> 2, bits);
		else {
			const dv = this.dv();
			dv.setUint32(this.irqAddr, dv.getUint32(this.irqAddr, true) | bits, true);
		}
	}
	clearIrqBits(bits) {
		if (this.irqAddr === void 0) return;
		if (this.sharedMemory) Atomics.and(new Int32Array(this.memory.buffer), this.irqAddr >> 2, ~bits);
		else {
			const dv = this.dv();
			dv.setUint32(this.irqAddr, dv.getUint32(this.irqAddr, true) & ~bits, true);
		}
	}
	watchIrqWord(done, timeoutMs) {
		if (!this.secondaries.length || this.irqAddr === void 0) return;
		const r = Atomics.waitAsync(new Int32Array(this.memory.buffer), this.irqAddr >> 2, 0, timeoutMs);
		if (r.async) r.value.then(done);
		else if (r.value === "not-equal") queueMicrotask(done);
	}
	jitStatsPerCpu() {
		return [{ ...this.jit.stats }, ...this.jitMirrors.map(jitStatsFromMirror)];
	}
	jitStatsAll() {
		return sumJitStats(this.jit.stats, this.jitMirrors.map(jitStatsFromMirror));
	}
	kwemuStatsPerCpu() {
		return [this.jit.kwemuStats(), ...this.jitMirrors.map((m) => this.jit.kwemuStats(jitBufFromMirror(m)))];
	}
	sharedClock() {
		if (!this.clockEpoch) {
			this.clockEpoch = new Float64Array(new SharedArrayBuffer(8));
			this.clockEpoch[0] = performance.timeOrigin - this.wasi.monoOffset;
		}
		return this.clockEpoch;
	}
	advanceClock(ms) {
		if (!(ms > 0)) return;
		this.wasi.monoOffset += ms;
		if (this.clockEpoch) this.clockEpoch[0] = performance.timeOrigin - this.wasi.monoOffset;
	}
	startCpu(cpu, idle) {
		const spawn = this.opts.spawnCpu;
		if (!spawn || cpu < 1 || cpu >= this.cpus || this.result) return -38;
		const flag = this.exports?.__wasm_init_memory_flag;
		const jitMirror = new Float64Array(new SharedArrayBuffer(JIT_MIRROR_WORDS * 8));
		let ep;
		try {
			ep = spawn({
				cpu,
				idle,
				module: this.opts.module,
				memory: this.memory,
				cpus: this.cpus,
				initFlag: flag instanceof WebAssembly.Global ? Number(flag.value) : 0,
				irqWord0: this.irqAddr ?? 0,
				epochMs: performance.timeOrigin - this.wasi.monoOffset,
				clock: this.sharedClock(),
				resume: !!this.opts.restore,
				jit: this.jit.stats.enabled,
				memory64: this.memory64,
				jitMirror,
				console: this.conRing.buffer,
				consoleFull: this.conReader ? "post" : "wait"
			});
		} catch (e) {
			this.log(`[host] cannot start CPU ${cpu}: ${e?.message ?? e}`);
			return -38;
		}
		this.secondaries.push(ep);
		this.jitMirrors.push(jitMirror);
		ep.listen({
			message: (m) => this.onCpuMessage(m),
			error: (e) => this.fatal(`CPU ${cpu}: ${errorText(e)}`)
		});
		return 0;
	}
	consoleWrite(mem, p, len) {
		const r = this.conRing;
		if (r === null || this.conReader !== null && r.quiet && this.consoleOrder.empty) {
			this.opts.write(mem.slice(p, p + len));
			return;
		}
		r.write(mem, p, len, this.conFull, this.conDeliver);
		this.conReader?.take();
	}
	initConsoleRing() {
		const theirs = this.opts.consoleRing;
		this.conRing = new ConsoleRing(theirs ?? newConsoleRing());
		if (theirs) return;
		const ring = this.conRing;
		this.conFull = "take";
		this.consoleOrder = new ConsoleOrder((bytes) => this.opts.write(bytes));
		const reader = this.conReader = new ConsoleRingReader(ring, this.conDeliver);
		const POLL_MS = 1, POLL_BYTES = 16384;
		let last = 0;
		this.poller ??= {
			poll: () => {
				if (!ring.pending) return;
				const now = performance.now();
				if (now - last < POLL_MS && ring.used < POLL_BYTES) return;
				last = now;
				if (reader.take()) this.opts.flushOutput?.();
			},
			idle: () => {
				reader.take();
				return false;
			},
			awake: () => {}
		};
		reader.start();
	}
	conDeliver = (b) => {
		if (this.result) return;
		this.consoleOrder?.put(b.seq, b.bytes);
		const d = this.conRing?.dropped ?? 0;
		if (d !== this.conDropped) {
			this.log(`[host] console: ${d - this.conDropped} bytes from other CPUs dropped (CPU 0 did not read them)`);
			this.conDropped = d;
		}
	};
	consoleFlush(end = false) {
		const reader = this.conReader;
		if (!reader) return;
		const b = reader.ring.take(true);
		if (b) this.conDeliver(b);
		if (!end) return;
		this.consoleOrder?.flush();
		reader.stop();
		reader.ring.close();
	}
	onCpuMessage(m) {
		switch (m.t) {
			case "out":
				this.conRing?.batchTaken();
				this.conDeliver(m);
				break;
			case "log":
				this.log(m.msg);
				break;
			case "err":
				this.wasi.stderr = (this.wasi.stderr + textDecoder.decode(m.bytes)).slice(-4096);
				break;
			case "exit":
				this.wasi.exit(m.code);
				this.wake();
				break;
			case "fatal":
				this.fatal(m.msg);
				this.wake();
				break;
			case "trap":
				this.log(`[host] wasm trap: ${m.error}`);
				this.exit({
					code: 254,
					reason: m.error,
					kind: "trap",
					error: m.error
				});
				this.wake();
		}
	}
	netImports() {
		const k = this;
		return {
			wasm_driver_net_init(mac) {
				const net = k.opts.net;
				if (!net) return -1n;
				k.netMac = (net.mac ?? /* @__PURE__ */ new Uint8Array(6)).slice(0, 6);
				k.u8().set(k.netMac, Number(mac));
				net.attach?.(k);
				return 0n;
			},
			wasm_driver_net_send(buf, len) {
				const p = Number(buf);
				k.opts.net?.send(k.u8().slice(p, p + Number(len)));
				return len;
			},
			wasm_driver_net_rx_len: () => BigInt(k.netRx.length ? k.netRx[0].length : 0),
			wasm_driver_net_recv(buf, max) {
				const f = k.netRx.shift();
				if (!f) return 0n;
				if (buf) k.u8().set(f.subarray(0, Number(max)), Number(buf));
				return BigInt(f.length);
			}
		};
	}
	u8() {
		return new Uint8Array(this.memory.buffer);
	}
	dv() {
		return new DataView(this.memory.buffer);
	}
	cstr(ptr, max = 4096) {
		const u8 = this.u8();
		const p = Number(ptr);
		let end = p;
		while (end < p + max && u8[end] !== 0) end++;
		return textDecoder.decode(u8.slice(p, end));
	}
	fatal(msg) {
		this.log(`[host] fatal: ${msg}`);
		this.exit({
			code: 255,
			reason: msg,
			kind: "fatal"
		});
	}
	stop(res = {}) {
		this.exit({
			code: res.code ?? 0,
			reason: res.reason ?? "stopped by the host",
			kind: res.kind ?? "stopped",
			error: res.error
		});
		this.wake();
	}
	sendInput(data) {
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
		if (!bytes.length) return;
		this.input.push(bytes);
		this.setIrqBits(2);
		this.wake();
	}
	setConsoleSize(cols, rows) {
		const size = (Math.min(rows, 65535) << 16 | Math.min(cols, 65535)) >>> 0;
		if (!cols || !rows || size === this.consoleSize) return;
		this.consoleSize = size;
		this.setIrqBits(2);
		this.wake();
	}
	requestSync({ timeout = 3e3 } = {}) {
		const disks = this.block.disks.filter((d) => d.persistent && typeof d.whenFlushed === "function");
		if (!disks.length) return Promise.resolve(true);
		if (this.irqAddr === void 0 || this.result) return Promise.all(disks.map((d) => d.saving?.catch(() => {}))).then(() => true);
		if (this.snapshotHeld && this.heldDurable) return this.heldDurable;
		const marks = disks.map((d) => d.flushSeq ?? 0);
		this.setIrqBits(16);
		this.wake();
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (!this.result) this.clearIrqBits(16);
				resolve(false);
			}, timeout);
			Promise.all(disks.map((d, i) => d.whenFlushed(marks[i]))).then(() => {
				clearTimeout(timer);
				resolve(true);
			});
		});
	}
	snapshot({ stop = false, commit, commitTimeoutMs = SNAPSHOT_COMMIT_TIMEOUT_MS, hold, dropCaches = stop || !!commit } = {}) {
		if (this.irqAddr === void 0 || this.result) return Promise.reject(/* @__PURE__ */ new Error("snapshot: the kernel is not running"));
		if (this.snapshotWaiter || this.snapshotHeld) return Promise.reject(/* @__PURE__ */ new Error("snapshot: one is in progress"));
		if (commit !== void 0 && typeof commit !== "function") return Promise.reject(/* @__PURE__ */ new TypeError("snapshot: commit must be a function"));
		if (hold !== void 0 && (typeof hold !== "function" || !commit)) return Promise.reject(/* @__PURE__ */ new TypeError("snapshot: hold must be a function, and needs commit"));
		if (!this.exports?.kw_resume) return Promise.reject(/* @__PURE__ */ new Error("snapshot: this kernel cannot resume one (no kw_resume)"));
		const held = this.virtio.held();
		if (held) return Promise.reject(/* @__PURE__ */ new Error(`snapshot: ${held} in flight (a program holds them)`));
		for (const [i, d] of this.block.disks.entries()) {
			const why = typeof d.snapshotSeal !== "function" ? "it does not support snapshots" : (() => {
				try {
					d.snapshotState();
					return "";
				} catch (e) {
					return e.message;
				}
			})();
			if (why) return Promise.reject(/* @__PURE__ */ new Error(`snapshot: disk wd${String.fromCharCode(97 + i)}: ${why}`));
		}
		const p = new Promise((resolve, reject) => this.snapshotWaiter = {
			resolve,
			reject,
			stop: stop || !!commit,
			commit,
			commitTimeoutMs: Math.max(0, Number(commitTimeoutMs) || 0),
			hold
		});
		this.setIrqBits(256 | (dropCaches ? 2048 : 0));
		this.wake();
		return p;
	}
	loadSnapshot(s) {
		if (s.version !== 1) throw new Error(`snapshot: unsupported version ${s.version}`);
		if (!this.exports?.kw_resume) throw new Error("snapshot: this kernel cannot resume one (no kw_resume)");
		if (s.fingerprint !== this.fingerprint) throw new Error(`snapshot: saved by another kernel build ("${s.fingerprint}", this one is "${this.fingerprint}")`);
		const end = this.exports._end;
		restoreSnapshotMemory(this.u8(), s.memory, end instanceof WebAssembly.Global ? Number(end.value) : void 0);
		const resized = !!this.consoleSize && this.consoleSize !== s.consoleSize;
		this.dv().setUint32(this.irqAddr, resized ? 2 : 0, true);
		if (!this.consoleSize) this.consoleSize = s.consoleSize;
		this.wasi.monoOffset = s.monotonicMs - performance.now();
		this.restoreDevices(s.devices ?? {});
	}
	devicesPresent() {
		return {
			display: this.display.enabled,
			sound: this.sound.enabled,
			vsock: this.vsock.enabled,
			shm: this.shm.enabled,
			network: !!this.opts.net,
			gpu: !!this.gpu
		};
	}
	saveDevices() {
		const d = {};
		if (this.display.enabled) d.display = this.display.probed ? this.display.saveState() : null;
		if (this.evdev.enabled) d.input = this.evdev.probed ? this.evdev.saveState() : null;
		if (this.sound.enabled) d.sound = this.sound.probed ? this.sound.saveState() : null;
		if (this.vsock.enabled) d.vsock = this.vsock.probed ? this.vsock.saveState() : null;
		if (this.shm.enabled) d.shm = this.shm.probed ? this.shm.saveState() : null;
		if (this.opts.net) d.network = this.netMac ? { mac: [...this.netMac] } : null;
		if (this.gpu) d.gpu = this.virtio.probed ? { transport: this.virtio.saveState() } : null;
		return d;
	}
	restoreDevices(d) {
		if (d.display) this.display.restoreState(d.display);
		if (d.input) this.evdev.restoreState(d.input);
		if (d.sound) this.sound.restoreState(d.sound);
		if (d.vsock) this.vsock.restoreState(d.vsock);
		if (d.shm) this.shm.restoreState(d.shm);
		if (d.gpu) this.virtio.restoreState(d.gpu.transport);
		if (d.network && this.opts.net) {
			this.netMac = Uint8Array.from(d.network.mac);
			this.opts.net.attach?.(this);
		}
	}
	snapshotPoint(result, blocker, freeMap, freeBits) {
		const w = this.snapshotWaiter;
		this.snapshotWaiter = null;
		if (!w) return -16;
		const who = this.cstr(blocker, 64);
		if (result) {
			w.reject(/* @__PURE__ */ new Error(`snapshot: errno ${-result}${who && who !== "-" ? `, ${who} did not park` : ""}`));
			return 0;
		}
		const busy = [
			this.block.inflight || this.block.done.length ? "block requests" : "",
			this.netRx.length ? "network frames" : "",
			this.vsock.blocker(),
			this.shm.busy ? "shm requests" : "",
			this.virtio.blocker()
		].filter(Boolean);
		if (busy.length) {
			w.reject(/* @__PURE__ */ new Error(`snapshot: ${busy.join(", ")} in flight`));
			return -16;
		}
		const sealed = [];
		try {
			for (const d of this.block.disks) sealed.push(d.snapshotSeal());
		} catch (e) {
			w.reject(/* @__PURE__ */ new Error(`snapshot: disk wd${String.fromCharCode(97 + sealed.length)}: ${e.message}`));
			return -16;
		}
		const pending = this.input.map((c, i) => i ? c : c.subarray(this.inputOffset));
		const input = new Uint8Array(pending.reduce((n, c) => n + c.length, 0));
		pending.reduce((off, c) => (input.set(c, off), off + c.length), 0);
		const snap = {
			version: 1,
			fingerprint: this.fingerprint,
			cpus: this.cpus,
			memory64: this.memory64,
			...copySnapshotMemory(this.u8(), freeBits ? this.u8().subarray(Number(freeMap), Number(freeMap) + Math.ceil(Number(freeBits) / 8)) : null, Number(freeBits ?? 0)),
			monotonicMs: this.wasi.monotonicMs(),
			consoleSize: this.consoleSize,
			input,
			disks: sealed.map((s) => s.state),
			devices: this.saveDevices()
		};
		try {
			this.onSnapshot?.(snap);
		} catch {}
		if (w.commit) return this.holdForCommit(w, snap, sealed.map((s) => s.done));
		if (w.stop) this.stop({ reason: "stopped after a snapshot" });
		Promise.all(sealed.map((s) => s.done)).then(() => w.resolve(snap), (e) => w.reject(/* @__PURE__ */ new Error(`snapshot: saving a disk failed: ${e?.message ?? e}`)));
		return 0;
	}
	async holdForCommit(w, snap, durable) {
		this.snapshotHeld = true;
		const heldAt = {
			wall: this.wallClock(),
			mono: performance.now()
		};
		const sealed = Promise.all(durable);
		this.heldDurable = sealed.then(() => true, () => false);
		const ac = new AbortController();
		let timedOut = false;
		const cancel = awakeTimeout(() => {
			timedOut = true;
			ac.abort(/* @__PURE__ */ new Error(`the commit did not finish within ${w.commitTimeoutMs} ms`));
		}, w.commitTimeoutMs);
		const given = new Promise((_, reject) => ac.signal.addEventListener("abort", () => reject(ac.signal.reason), { once: true }));
		given.catch(() => {});
		try {
			await Promise.race([sealed.catch((e) => {
				throw new Error(`saving a disk failed: ${e?.message ?? e}`);
			}), given]);
			await Promise.race([Promise.resolve().then(() => w.commit(snap, ac.signal)), given]);
		} catch (e) {
			cancel();
			if (!ac.signal.aborted) ac.abort(e);
			this.#leaveHold(heldAt);
			const why = e?.message ?? String(e);
			w.reject(new SnapshotCommitError(`snapshot: not committed (${why}); ${this.result ? `the kernel has ended (${this.result.reason})` : "the kernel runs on"}`, {
				timedOut,
				cause: e
			}));
			return 0;
		}
		cancel();
		if (w.hold && !this.result) {
			const ended = new AbortController();
			this.exited.then((r) => ended.abort(/* @__PURE__ */ new Error(`the kernel has ended (${r.reason})`)));
			const exited = this.exited.then(() => "ended");
			let how;
			try {
				how = String(await Promise.race([Promise.resolve().then(() => w.hold(snap, ended.signal)), exited]));
			} catch (e) {
				this.log(`[host] snapshot: the hold failed (${e?.message ?? e}); stopping at the snapshot`);
				how = "stop";
			}
			if (how === "continue" && !this.result) {
				this.#leaveHold(heldAt);
				w.resolve(snap);
				return 0;
			}
		}
		this.snapshotHeld = false;
		this.heldDurable = null;
		this.stop({ reason: "stopped after a snapshot" });
		w.resolve(snap);
		return never();
	}
	#leaveHold(heldAt) {
		this.snapshotHeld = false;
		this.heldDurable = null;
		const lag = this.wallClock() - heldAt.wall - (performance.now() - heldAt.mono);
		if (lag > 1e3 && !this.result) {
			this.advanceClock(lag);
			this.log(`[host] snapshot: the host's monotonic clock fell ${(lag / 1e3).toFixed(1)} s behind its wall clock while the kernel waited; the guest's moves on by that`);
		}
	}
	wake() {
		const w = this.idleWake;
		this.idleWake = null;
		if (w) w();
	}
	imports() {
		const k = this;
		const unkernel = {
			wasm_dump_stacktrace(buf, max) {
				const s = new TextEncoder().encode((/* @__PURE__ */ new Error()).stack ?? "");
				const n = Math.min(s.length, Number(max) - 1);
				k.u8().set(s.subarray(0, n), Number(buf));
				k.u8()[Number(buf) + n] = 0;
			},
			wasm_driver_console_size: () => k.consoleSize,
			wasm_init_flag() {
				const flag = k.exports?.__wasm_init_memory_flag;
				return flag instanceof WebAssembly.Global ? BigInt(flag.value) : 0n;
			},
			wasm_cpu_count: () => k.cpus,
			wasm_cpu_start: (cpu, idle) => k.startCpu(cpu, idle),
			wasm_stack_drop(task) {
				dropStack(k.resumers, task);
			},
			wasm_snapshot_point: new WebAssembly.Suspending((result, blocker, freeMap, freeBits) => k.snapshotPoint(result, blocker, freeMap, freeBits)),
			wasm_switch_to: new WebAssembly.Suspending((prev, next, isNew, prevDead) => {
				if (k.result) return never();
				k.stats.switches++;
				const parked = prevDead ? stackDropped() : new Promise((r) => k.resumers.set(prev, r));
				if (isNew) {
					dropStack(k.resumers, next);
					queueMicrotask(() => {
						k.retFromFork(prev, next).then(() => k.fatal("task returned from ret_from_fork"), (e) => k.onTrap(e));
					});
				} else {
					const resume = k.resumers.get(next);
					if (!resume) k.fatal(`switch to unknown task 0x${next.toString(16)}`);
					else {
						k.resumers.delete(next);
						resume(prev);
					}
				}
				return parked;
			})
		};
		Object.assign(unkernel, this.block.imports());
		Object.assign(unkernel, this.netImports());
		Object.assign(unkernel, this.display.imports());
		Object.assign(unkernel, this.evdev.imports());
		Object.assign(unkernel, this.sound.imports());
		Object.assign(unkernel, this.vsock.imports());
		Object.assign(unkernel, this.shm.imports());
		Object.assign(unkernel, this.virtio.imports());
		Object.assign(unkernel, this.jit.imports());
		const imports = {
			env: { memory: this.memory },
			unkernel,
			wasi_snapshot_preview1: this.wasi.imports()
		};
		const missing = [];
		for (const imp of WebAssembly.Module.imports(this.opts.module)) {
			const mod = imports[imp.module] ??= {};
			if (!(imp.name in mod)) {
				missing.push(`${imp.module}.${imp.name}`);
				mod[imp.name] = () => {
					throw new Error(`unresolved kernel import ${imp.module}.${imp.name} called`);
				};
			}
		}
		if (missing.length) this.log(`[host] warning: unresolved imports: ${missing.join(", ")}`);
		return imports;
	}
	onTrap(e) {
		if (e === STACK_DROPPED) return;
		this.log(`[host] wasm trap: ${errorText(e)}`);
		this.exit({
			code: 254,
			reason: String(e),
			kind: "trap",
			error: e
		});
	}
	static newMemory(pages, memory64, shared = false) {
		return memory64 ? new WebAssembly.Memory({
			initial: BigInt(pages),
			maximum: BigInt(pages),
			address: "i64",
			shared
		}) : new WebAssembly.Memory({
			initial: pages,
			maximum: pages,
			shared
		});
	}
	allocateMemory(memoryMiB, initrdBytes) {
		const want = [memoryMiB, ...(this.opts.memoryFallbackMiB ?? []).filter((m) => m < memoryMiB)];
		const failures = [];
		for (const mib of want) {
			const pages = Math.ceil(mib * 1024 * 1024 / 65536);
			try {
				if (!this.memory64 && pages > 65536) throw new RangeError("more than 4 GiB needs the wasm64 (memory64) kernel");
				const memory = Kernel.newMemory(pages, this.memory64, this.sharedMemory);
				if (failures.length) this.log(`[host] allocated ${mib} MiB after failing: ${failures.join("; ")}`);
				this.onStage("memory", {
					mib,
					requestedMiB: memoryMiB,
					failures,
					memory64: this.memory64
				});
				return memory;
			} catch (e) {
				failures.push(`${mib} MiB: ${e.message}`);
				if (initrdBytes && mib * 1048576 < initrdBytes + 41943040) break;
			}
		}
		const err = /* @__PURE__ */ new Error(`cannot allocate the kernel's memory (WebAssembly.Memory, ${this.memory64 ? "memory64" : "32-bit"}): ${failures.join("; ")}`);
		err.name = "MemoryAllocationError";
		throw err;
	}
	async boot() {
		const { module, restore } = this.opts;
		if (restore) {
			const why = snapshotCpuMismatch(restore, this.cpus) ?? snapshotDiskMismatch(restore.disks ?? [], this.block.disks) ?? snapshotDeviceMismatch(restore.devices ?? {}, this.devicesPresent(), this.opts.net?.mac);
			if (why) throw new Error(`snapshot: ${why}`);
		}
		const memoryMiB = restore ? restore.memory.byteLength / 1048576 : this.opts.memoryMiB ?? 2048;
		const bundled = bundledBoot(module);
		const initrd = restore ? null : this.opts.initrd === void 0 ? bundled.initrd : this.opts.initrd;
		const cmdline = this.opts.cmdline ?? bundled.cmdline ?? "";
		if (!WebAssembly.Module.imports(module).find((i) => i.kind === "memory")) throw new Error("vmlinux must import its memory");
		const guessed = this.opts.memory64 === void 0 && !restore;
		this.memory64 = restore ? restore.memory64 : guessed ? moduleIsMemory64(module) : !!this.opts.memory64;
		this.sharedMemory = moduleIsSharedMemory(module);
		if (restore) {
			this.memory = Kernel.newMemory(restore.memory.byteLength / 65536, this.memory64, this.sharedMemory);
			this.onStage("memory", {
				mib: memoryMiB,
				requestedMiB: memoryMiB,
				failures: [],
				memory64: this.memory64
			});
		} else this.memory = this.allocateMemory(memoryMiB, initrd?.length ?? 0);
		this.wasi = new WasiHost(this, {
			args: cmdline ? ["vmlinux", cmdline] : ["vmlinux"],
			files: initrd?.length ? { initrd } : {}
		});
		this.onStage("instantiate");
		let instance;
		let flippedShared = false, flippedType = !guessed;
		while (!instance) try {
			instance = await WebAssembly.instantiate(module, this.imports());
		} catch (e) {
			if (!(e instanceof WebAssembly.LinkError)) throw e;
			const pages = this.memory.buffer.byteLength / 65536;
			let memory64 = this.memory64, shared = this.sharedMemory;
			if (!flippedShared && /\bshared\b/i.test(e.message)) {
				flippedShared = true;
				shared = !shared;
			} else if (!flippedType) {
				flippedType = true;
				memory64 = !memory64;
			} else throw e;
			try {
				this.memory = Kernel.newMemory(pages, memory64, shared);
			} catch {
				throw e;
			}
			if (memory64 !== this.memory64) this.log(`[host] memory type guess was wrong (${e.message}); using a ${memory64 ? "64" : "32"}-bit memory`);
			this.memory64 = memory64;
			this.sharedMemory = shared;
		}
		const ex = this.exports = instance.exports;
		const addr = (name) => {
			const g = ex[name];
			if (!(g instanceof WebAssembly.Global)) throw new Error(`missing export ${name}`);
			return Number(g.value);
		};
		this.irqAddr = addr("wasm_host_irqs");
		this.fingerprint = ex.linux_banner instanceof WebAssembly.Global ? this.cstr(addr("linux_banner"), 512).trim() : "";
		this.jit.attach(ex);
		if (initrd?.length) {
			const memSize = this.memory.buffer.byteLength;
			const start = Math.floor((memSize - initrd.length) / 4096) * 4096;
			const kernelEnd = addr("_end");
			if (start < kernelEnd + 33554432) throw new Error(`not enough memory for the ${(initrd.length / 1048576).toFixed(1)} MiB initrd (have ${memSize / 1048576} MiB, need at least ${Math.ceil((kernelEnd + 33554432 + initrd.length) / 1048576) + 1} MiB)`);
		}
		this.retFromFork = WebAssembly.promising(ex.ret_from_fork);
		if (restore) this.loadSnapshot(restore);
		if (this.opts.profile) {
			const p = new Profiler(this.opts.profile);
			if (p.attach(this, this.opts.spawnSampler)) this.profiler = p;
		} else if (restore) profileOff(this);
		const entry = restore ? "kw_resume" : "_start";
		const start = WebAssembly.promising(ex[entry]);
		this.bootTime = performance.now();
		this.onStage("start");
		start().then(() => this.fatal(`${entry} returned`), (e) => this.onTrap(e));
		if (restore?.input.length) this.sendInput(restore.input.slice());
		return this.exited;
	}
};
function decodeRemap(r) {
	const map = () => {
		const n = r.uleb();
		const m = new Int32Array(n);
		let prev = -1;
		for (let i = 0; i < n; i++) m[i] = prev = prev + 1 + r.zig();
		return m;
	};
	const funcs = map(), globals = map(), types = map();
	const nd = r.uleb();
	const data = new Float64Array(nd * 3);
	let at = 0;
	for (let i = 0; i < nd; i++) {
		data[i * 3] = at += r.uleb();
		data[i * 3 + 1] = at += r.uleb();
		data[i * 3 + 2] = r.zig();
	}
	return {
		funcs,
		globals,
		types,
		data
	};
}
var Out = class {
	buf;
	n = 0;
	constructor(size) {
		this.buf = new Uint8Array(size);
	}
	grow(k) {
		if (this.n + k <= this.buf.length) return;
		const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
		b.set(this.buf.subarray(0, this.n));
		this.buf = b;
	}
	bytes(u8) {
		this.grow(u8.length);
		this.buf.set(u8, this.n);
		this.n += u8.length;
	}
	uleb(v) {
		this.grow(10);
		do {
			let b = v % 128;
			v = Math.floor(v / 128);
			if (v) b |= 128;
			this.buf[this.n++] = b;
		} while (v);
	}
	sleb(v) {
		this.grow(11);
		if (typeof v === "number") for (;;) {
			const b = (v % 128 + 128) % 128;
			v = (v - b) / 128;
			if (v === 0 && !(b & 64) || v === -1 && b & 64) {
				this.buf[this.n++] = b;
				return;
			}
			this.buf[this.n++] = b | 128;
		}
		for (;;) {
			const b = Number(v & 127n);
			v >>= 7n;
			if (v === 0n && !(b & 64) || v === -1n && b & 64) {
				this.buf[this.n++] = b;
				return;
			}
			this.buf[this.n++] = b | 128;
		}
	}
};
function moduleSections(w) {
	let p = 8;
	const out = [];
	while (p < w.length) {
		const start = p, id = w[p++];
		let size = 0, s = 1, c;
		do {
			c = w[p++];
			size += (c & 127) * s;
			s *= 128;
		} while (c & 128);
		out.push([
			id,
			start,
			p,
			p + size
		]);
		p += size;
	}
	return out;
}
function walkBody(w, p, end, imm) {
	const uleb = () => {
		let v = 0, s = 1, c;
		do {
			c = w[p++];
			v += (c & 127) * s;
			s *= 128;
		} while (c & 128);
		return v;
	};
	const sleb = () => {
		const s0 = p;
		let v = 0, mul = 1, c;
		do {
			c = w[p++];
			if (p - s0 > 7) {
				p = s0;
				let b = 0n, sh = 0n;
				do {
					c = w[p++];
					b |= BigInt(c & 127) << sh;
					sh += 7n;
				} while (c & 128);
				if (c & 64) b -= 1n << sh;
				return b;
			}
			v += (c & 127) * mul;
			mul *= 128;
		} while (c & 128);
		if (c & 64) v -= mul;
		return v;
	};
	const memarg = () => {
		if (uleb() & 64) uleb();
		const s = p;
		imm("offset", uleb(), s, p);
	};
	const blocktype = () => {
		const b = w[p];
		if (b === 64 || b >= 111 && b <= 127) {
			p++;
			return;
		}
		const s = p;
		imm("blocktype", Number(sleb()), s, p);
	};
	const nl = uleb();
	for (let i = 0; i < nl; i++) {
		uleb();
		p++;
	}
	while (p < end) {
		const op = w[p++];
		if (op <= 1 || op === 5 || op === 11 || op === 15 || op === 26 || op === 27 || op >= 69 && op <= 196 || op === 209) continue;
		switch (op) {
			case 2:
			case 3:
			case 4:
				blocktype();
				break;
			case 12:
			case 13:
			case 32:
			case 33:
			case 34:
			case 37:
			case 38:
				uleb();
				break;
			case 14: {
				const n = uleb();
				for (let i = 0; i <= n; i++) uleb();
				break;
			}
			case 16:
			case 18:
			case 210: {
				const s = p;
				imm("func", uleb(), s, p);
				break;
			}
			case 17:
			case 19: {
				const s = p;
				imm("type", uleb(), s, p);
				uleb();
				break;
			}
			case 28: {
				const n = uleb();
				p += n;
				break;
			}
			case 35:
			case 36: {
				const s = p;
				imm("global", uleb(), s, p);
				break;
			}
			case 63:
			case 64:
				uleb();
				break;
			case 65: {
				const s = p;
				imm("const32", sleb(), s, p);
				break;
			}
			case 66: {
				const s = p;
				imm("const64", sleb(), s, p);
				break;
			}
			case 67:
				p += 4;
				break;
			case 68:
				p += 8;
				break;
			case 208:
				p++;
				break;
			case 252: {
				const sub = uleb();
				if (sub <= 7) break;
				if (sub === 9 || sub === 11 || sub === 13 || sub === 15 || sub === 16 || sub === 17) uleb();
				else if (sub === 8 || sub === 10 || sub === 12 || sub === 14) {
					uleb();
					uleb();
				} else throw new Error(`kremap: unknown opcode 0xfc ${sub}`);
				break;
			}
			case 254:
				if (uleb() === 3) p++;
				else memarg();
				break;
			default:
				if (op >= 40 && op <= 62) {
					memarg();
					break;
				}
				throw new Error(`kremap: unknown opcode 0x${op.toString(16)} at ${p - 1}`);
		}
	}
}
function mapData(data, v) {
	let lo = 0, hi = data.length / 3 - 1;
	while (lo <= hi) {
		const mid = lo + hi >> 1;
		if (v < data[mid * 3]) hi = mid - 1;
		else if (v >= data[mid * 3 + 1]) lo = mid + 1;
		else return v + data[mid * 3 + 2];
	}
	return v;
}
function applyRemap(base, m) {
	const code = moduleSections(base).find((s) => s[0] === 10);
	if (!code) return base;
	let p = code[2];
	const uleb = () => {
		let v = 0, s = 1, c;
		do {
			c = base[p++];
			v += (c & 127) * s;
			s *= 128;
		} while (c & 128);
		return v;
	};
	const n = uleb();
	const body = new Out(code[3] - code[2] + 65536);
	body.uleb(n);
	const fn = new Out(65536);
	const hasData = m.data.length > 0;
	const map = (t, v) => v < t.length ? t[v] : v;
	for (let i = 0; i < n; i++) {
		const size = uleb(), start = p, end = p + size;
		fn.n = 0;
		let last = start;
		walkBody(base, start, end, (kind, v, s, e) => {
			let nv;
			switch (kind) {
				case "func":
					nv = map(m.funcs, v);
					break;
				case "global":
					nv = map(m.globals, v);
					break;
				case "type":
				case "blocktype":
					nv = map(m.types, v);
					break;
				case "offset":
					if (!hasData) return;
					nv = mapData(m.data, v);
					break;
				default:
					if (!hasData || typeof v !== "number" || v <= 0 || v > 4294967295) return;
					nv = mapData(m.data, v);
			}
			if (nv === v) return;
			fn.bytes(base.subarray(last, s));
			if (kind === "const32" || kind === "const64" || kind === "blocktype") fn.sleb(nv);
			else fn.uleb(nv);
			last = e;
		});
		fn.bytes(base.subarray(last, end));
		body.uleb(fn.n);
		body.bytes(fn.buf.subarray(0, fn.n));
		p = end;
	}
	const out = new Out(base.length + body.n - (code[3] - code[2]) + 16);
	out.bytes(base.subarray(0, code[1]));
	out.uleb(10);
	out.uleb(body.n);
	out.bytes(body.buf.subarray(0, body.n));
	out.bytes(base.subarray(code[3]));
	return out.buf.subarray(0, out.n);
}
var Reader = class {
	p = 0;
	u8;
	constructor(u8) {
		this.u8 = u8;
	}
	uleb() {
		let v = 0, s = 1, c;
		do {
			if (this.p >= this.u8.length) throw new Error("kernel patch: truncated");
			c = this.u8[this.p++];
			v += (c & 127) * s;
			s *= 128;
		} while (c & 128);
		return v;
	}
	zig() {
		const v = this.uleb();
		return v % 2 ? -(v + 1) / 2 : v / 2;
	}
	take(n) {
		if (this.p + n > this.u8.length) throw new Error("kernel patch: truncated");
		const r = this.u8.subarray(this.p, this.p + n);
		this.p += n;
		return r;
	}
};
function header(r) {
	const magic = r.take(4);
	if (magic[0] !== 75 || magic[1] !== 87 || magic[2] !== 80 || magic[3] !== 49) throw new Error("kernel patch: not a KWP1 patch");
	return {
		remap: !!(r.uleb() & 1),
		baseLength: r.uleb(),
		targetLength: r.uleb(),
		baseSha256: r.take(32),
		targetSha256: r.take(32)
	};
}
async function applyKernelPatch(base, patch, { verify = true } = {}) {
	const r = new Reader(patch);
	const h = header(r);
	if (base.length !== h.baseLength) throw new Error(`kernel patch: the base is ${base.length} bytes, the patch wants ${h.baseLength}`);
	const subtle = verify ? globalThis.crypto?.subtle : void 0;
	if (subtle && !equal(new Uint8Array(await subtle.digest("SHA-256", base)), h.baseSha256)) throw new Error("kernel patch: the base module is not the one the patch was made for");
	let src = base;
	if (h.remap) src = applyRemap(base, decodeRemap(r));
	const n = r.uleb();
	const ctrl = new Float64Array(n * 3);
	for (let i = 0; i < n; i++) {
		ctrl[i * 3] = r.uleb();
		ctrl[i * 3 + 1] = r.uleb();
		ctrl[i * 3 + 2] = r.zig();
	}
	let addTotal = 0;
	for (let i = 0; i < n; i++) addTotal += ctrl[i * 3];
	const diff = new Uint8Array(addTotal);
	for (let i = 0; i < addTotal;) {
		i += r.uleb();
		const lit = r.uleb();
		if (i + lit > addTotal) throw new Error("kernel patch: corrupt difference bytes");
		diff.set(r.take(lit), i);
		i += lit;
	}
	const extra = r.u8.subarray(r.p);
	const out = new Uint8Array(h.targetLength);
	let o = 0, op = 0, dp = 0, ep = 0;
	for (let i = 0; i < n; i++) {
		const add = ctrl[i * 3], copy = ctrl[i * 3 + 1], seek = ctrl[i * 3 + 2];
		if (o + add + copy > out.length || op < 0 || op + add > src.length) throw new Error("kernel patch: corrupt control");
		for (let k = 0; k < add; k++) out[o + k] = src[op + k] + diff[dp + k];
		o += add;
		op += add;
		dp += add;
		out.set(extra.subarray(ep, ep + copy), o);
		o += copy;
		ep += copy;
		op += seek;
	}
	if (o !== out.length) throw new Error("kernel patch: short output");
	if (subtle && !equal(new Uint8Array(await subtle.digest("SHA-256", out)), h.targetSha256)) throw new Error("kernel patch: the result does not match the patch's hash");
	return out;
}
function equal(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
const BUNDLE_PREFIX = "unkernel.";
function customName(w, payload, end) {
	let p = payload, n = 0, s = 1, c;
	do {
		c = w[p++];
		n += (c & 127) * s;
		s *= 128;
	} while (c & 128);
	if (p + n > end) throw new Error("kernel bundle: bad custom section");
	let name = "";
	for (let i = 0; i < n; i++) name += String.fromCharCode(w[p + i]);
	return [name, p + n];
}
async function smpKernelFromBundle(bundle, opts) {
	const secs = moduleSections(bundle);
	let patch;
	const kernel = [bundle.subarray(0, 8)], extra = [];
	for (const [id, start, payload, end] of secs) {
		if (id === 0) {
			const [n, data] = customName(bundle, payload, end);
			if (n === "unkernel.kernel.smp.kwpatch") {
				patch = bundle.subarray(data, end);
				continue;
			}
			if (n.startsWith(BUNDLE_PREFIX)) {
				extra.push(bundle.subarray(start, end));
				continue;
			}
		}
		kernel.push(bundle.subarray(start, end));
	}
	if (!patch) return void 0;
	return concat([await applyKernelPatch(concat(kernel), patch, opts), ...extra]);
}
function concat(parts) {
	let n = 0;
	for (const p of parts) n += p.length;
	const out = new Uint8Array(n);
	n = 0;
	for (const p of parts) {
		out.set(p, n);
		n += p.length;
	}
	return out;
}
var BootError = class extends Error {
	stage;
	constructor(stage, message, options) {
		super(message, options);
		this.name = "BootError";
		this.stage = stage;
	}
};
const WASM_HEADERS = { "content-type": "application/wasm" };
function isBufferSource(src) {
	return src instanceof ArrayBuffer || ArrayBuffer.isView(src);
}
function isLocation(src) {
	return typeof src === "string" || src instanceof URL;
}
function toU8(src) {
	return src instanceof Uint8Array ? src : src instanceof ArrayBuffer ? new Uint8Array(src) : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
}
function expectedLength(r) {
	return Number(r.headers.get("x-decoded-length") || (r.headers.get("content-encoding") ? 0 : r.headers.get("content-length"))) || 0;
}
async function fetchOk(url, signal) {
	let r;
	try {
		r = await fetch(url, {
			cache: "no-cache",
			signal
		});
	} catch (e) {
		throw new BootError("download", `Network error fetching ${url}: ${e.message}`, { cause: e });
	}
	if (!r.ok) throw new BootError("download", `GET ${url} → ${r.status} ${r.statusText || ""}`.trim());
	return r;
}
function withProgress(r, url, opts, headers) {
	const total = expectedLength(r);
	const what = opts.what ?? "kernel";
	const report = (loaded, done) => opts.onProgress?.({
		stage: "download",
		what,
		url,
		loaded,
		total,
		done
	});
	if (!r.body) return [r, () => void 0];
	const reader = r.body.getReader();
	let loaded = 0, failed;
	report(0, false);
	const body = new ReadableStream({
		async pull(c) {
			let chunk;
			try {
				chunk = await reader.read();
			} catch (e) {
				failed = e ?? /* @__PURE__ */ new Error("read failed");
				c.error(e);
				return;
			}
			if (chunk.done) {
				report(loaded, true);
				c.close();
				return;
			}
			loaded += chunk.value.length;
			report(loaded, false);
			c.enqueue(chunk.value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});
	return [new Response(body, {
		status: r.status,
		headers: headers ?? r.headers
	}), () => failed];
}
async function download(url, opts = {}) {
	return readResponse(await fetchOk(url, opts.signal), String(url), opts);
}
async function readResponse(r, url, opts) {
	try {
		return new Uint8Array(await withProgress(r, url, opts)[0].arrayBuffer());
	} catch (e) {
		if (e instanceof BootError) throw e;
		throw new BootError("download", `Reading ${url} failed: ${e.message}`, { cause: e });
	}
}
async function loadBytes(src, opts = {}) {
	if (isBufferSource(src)) return toU8(src);
	if (!isLocation(src)) return readResponse(src, src.url, opts);
	const local = opts.readFile?.(src);
	if (local) return local;
	return download(src, opts);
}
async function loadKernelModule(src, opts = {}) {
	if (src instanceof WebAssembly.Module) return src;
	const compile = async (bytes) => {
		if (opts.smp) try {
			bytes = await smpKernelFromBundle(bytes) ?? bytes;
		} catch (e) {
			throw new BootError("compile", `Deriving the SMP kernel from the bundle failed: ${e.message}`, { cause: e });
		}
		try {
			return await WebAssembly.compile(bytes);
		} catch (e) {
			throw new BootError("compile", `Compiling the kernel failed: ${e.message}`, { cause: e });
		}
	};
	if (isBufferSource(src)) return compile(toU8(src));
	let r;
	if (isLocation(src)) {
		const local = opts.readFile?.(src);
		if (local) return compile(await local);
		r = await fetchOk(src, opts.signal);
	} else r = src;
	const url = r.url || (isLocation(src) ? String(src) : "");
	if (opts.smp || typeof WebAssembly.compileStreaming !== "function" || !r.body) return compile(await readResponse(r, url, {
		...opts,
		what: "kernel"
	}));
	const [counted, readError] = withProgress(r, url, {
		...opts,
		what: "kernel"
	}, WASM_HEADERS);
	try {
		return await WebAssembly.compileStreaming(counted);
	} catch (e) {
		if (e instanceof BootError) throw e;
		const re = readError();
		if (re !== void 0 || opts.signal?.aborted) throw new BootError("download", `Fetching ${url} failed: ${re?.message ?? e.message}`, { cause: re ?? e });
		throw new BootError("compile", `Compiling the kernel failed: ${e.message}`, { cause: e });
	}
}
const ETH_ARP = 2054;
const ETH_IP = 2048;
const PROTO_ICMP = 1;
const PROTO_TCP = 6;
const PROTO_UDP = 17;
const FIN = 1;
const SYN = 2;
const RST = 4;
const ACK = 16;
const ip4$1 = (s) => s.split(".").reduce((a, b) => (a << 8 | Number(b)) >>> 0, 0);
const ip4str = (n) => `${n >>> 24}.${n >>> 16 & 255}.${n >>> 8 & 255}.${n & 255}`;
function parseMac(s) {
	return Uint8Array.from(s.split(":").map((h) => parseInt(h, 16)));
}
function sum16(u8, off, len, s = 0) {
	const end = off + len;
	let i = off;
	for (; i + 1 < end; i += 2) s += u8[i] << 8 | u8[i + 1];
	if (i < end) s += u8[i] << 8;
	return s;
}
function fold(s) {
	while (s > 65535) s = (s & 65535) + Math.floor(s / 65536);
	return ~s & 65535;
}
const seqLt = (a, b) => (a - b | 0) < 0;
const seqLe = (a, b) => (a - b | 0) <= 0;
const seqAdd = (a, n) => a + n >>> 0;
const seqDiff = (a, b) => a - b | 0;
var ByteQueue = class {
	chunks = [];
	head = 0;
	length = 0;
	push(u8) {
		if (!u8.length) return;
		this.chunks.push(u8);
		this.length += u8.length;
	}
	drop(n) {
		this.length -= n;
		while (n > 0) {
			const avail = this.chunks[0].length - this.head;
			if (n < avail) {
				this.head += n;
				return;
			}
			n -= avail;
			this.chunks.shift();
			this.head = 0;
		}
	}
	copyTo(dst, dstOff, offset, len) {
		let i = 0, pos = this.head + offset;
		while (pos >= this.chunks[i].length) pos -= this.chunks[i++].length;
		while (len > 0) {
			const c = this.chunks[i++];
			const take = Math.min(len, c.length - pos);
			dst.set(c.subarray(pos, pos + take), dstOff);
			dstOff += take;
			len -= take;
			pos = 0;
		}
	}
};
const RCVBUF = 262144;
const SNDBUF_HIGH = 524288;
const RTO_MS = 1e3;
const RTO_MAX_MS = 8e3;
const MAX_RETRIES = 8;
var TcpConn = class {
	stack;
	key;
	gport;
	ip;
	port;
	irs;
	rcvNxt;
	iss;
	sndUna;
	sndNxt;
	mss;
	sndWscale;
	rcvWscale;
	sndWl;
	sendq;
	state;
	remoteEof;
	finSent;
	guestFin;
	paused;
	rto;
	retries;
	timer;
	lastWnd;
	handle;
	constructor(stack, key, gport, ip, port, seg) {
		this.stack = stack;
		this.key = key;
		this.gport = gport;
		this.ip = ip;
		this.port = port;
		this.irs = seg.seq;
		this.rcvNxt = seqAdd(seg.seq, 1);
		this.iss = Math.random() * 4294967296 >>> 0;
		this.sndUna = this.iss;
		this.sndNxt = this.iss;
		this.mss = seg.mss ?? 536;
		this.sndWscale = seg.wscale ?? 0;
		this.rcvWscale = seg.wscale !== void 0 ? 4 : 0;
		this.sndWl = seqAdd(this.iss + 1, seg.win);
		this.sendq = new ByteQueue();
		this.state = "connecting";
		this.remoteEof = false;
		this.finSent = false;
		this.guestFin = false;
		this.paused = false;
		this.rto = RTO_MS;
		this.retries = 0;
		this.timer = null;
		this.lastWnd = 0;
		this.handle = void 0;
	}
	inFlight() {
		return seqDiff(this.sndNxt, this.sndUna) - (this.finSent ? 1 : 0);
	}
	rcvWnd() {
		const free = Math.max(0, RCVBUF - (this.handle?.buffered ?? 0));
		return Math.min(free >> this.rcvWscale, 65535);
	}
	send(flags, seq, payloadLen = 0, opts = null) {
		const wnd = this.rcvWnd();
		this.lastWnd = wnd << this.rcvWscale;
		this.stack.sendTcp(this, flags, seq, payloadLen, opts, wnd);
	}
	ack() {
		this.send(ACK, this.sndNxt);
	}
	synAck() {
		const o = [
			2,
			4,
			5,
			180
		];
		if (this.sndWscale || this.rcvWscale) o.push(1, 3, 3, this.rcvWscale);
		this.send(18, this.iss, 0, Uint8Array.from(o));
		this.sndNxt = seqAdd(this.iss, 1);
		this.armTimer();
	}
	flush() {
		if (this.state !== "established") return;
		let sent = false;
		for (;;) {
			const off = seqDiff(this.sndNxt, this.sndUna);
			const unsent = this.sendq.length - off;
			const room = seqDiff(this.sndWl, this.sndNxt);
			if (unsent <= 0 || room <= 0) break;
			const n = Math.min(unsent, room, this.mss);
			this.send(24, this.sndNxt, n);
			this.sndNxt = seqAdd(this.sndNxt, n);
			sent = true;
		}
		if (this.remoteEof && !this.finSent && seqDiff(this.sndNxt, this.sndUna) === this.sendq.length) {
			this.send(17, this.sndNxt);
			this.sndNxt = seqAdd(this.sndNxt, 1);
			this.finSent = true;
			sent = true;
		}
		if (sent || this.sendq.length && seqDiff(this.sndWl, this.sndNxt) <= 0) this.armTimer();
		if (this.paused && this.sendq.length < SNDBUF_HIGH / 2) {
			this.paused = false;
			this.handle?.resume();
		}
	}
	armTimer() {
		if (this.timer) return;
		this.timer = setTimeout(() => this.onTimer(), this.rto);
	}
	clearTimer() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}
	onTimer() {
		this.timer = null;
		if (this.state === "closed") return;
		if (++this.retries > MAX_RETRIES) {
			this.stack.log?.(`[net] tcp ${ip4str(this.ip)}:${this.port}: guest unresponsive, resetting`);
			this.send(20, this.sndNxt);
			this.close();
			return;
		}
		this.rto = Math.min(this.rto * 2, RTO_MAX_MS);
		if (this.state === "synrcvd") {
			this.sndNxt = this.iss;
			this.synAck();
		} else if (seqDiff(this.sndNxt, this.sndUna) > 0) {
			this.sndNxt = this.sndUna;
			this.finSent = false;
			this.flush();
		} else if (this.sendq.length) {
			this.send(ACK, seqAdd(this.sndUna, -1));
			this.armTimer();
		}
	}
	connect() {
		const host = this.stack.backendHost(this.ip);
		if (host === null) return this.refuse();
		this.handle = this.stack.backend.connect({
			host,
			port: this.port
		}, {
			onConnect: () => {
				if (this.state !== "connecting") return;
				this.state = "synrcvd";
				this.synAck();
			},
			onData: (u8) => {
				if (this.state === "closed") return;
				this.sendq.push(u8);
				if (!this.paused && this.sendq.length >= SNDBUF_HIGH) {
					this.paused = true;
					this.handle.pause();
				}
				this.flush();
			},
			onEnd: () => {
				if (this.state === "closed") return;
				this.remoteEof = true;
				this.flush();
			},
			onDrain: () => {
				if (this.state === "established" && this.lastWnd < RCVBUF / 2) this.ack();
			},
			onClose: (err) => {
				if (this.state === "closed") return;
				if (this.state === "connecting") return this.refuse(err);
				if (err) {
					this.stack.log?.(`[net] tcp ${ip4str(this.ip)}:${this.port}: ${err.message ?? err}`);
					this.send(20, this.sndNxt);
					this.close();
				} else {
					this.remoteEof = true;
					this.flush();
				}
			}
		});
	}
	refuse(err) {
		if (err) this.stack.log?.(`[net] tcp connect ${ip4str(this.ip)}:${this.port}: ${err.message ?? err}`);
		this.stack.sendTcp(this, 20, 0, 0, null, 0);
		this.close();
	}
	close() {
		if (this.state === "closed") return;
		this.state = "closed";
		this.clearTimer();
		this.stack.tcp.delete(this.key);
		this.handle?.destroy();
	}
	maybeDone() {
		if (this.guestFin && this.finSent && this.sndUna === this.sndNxt) this.close();
	}
	input(seg, payload) {
		if (seg.flags & RST) return this.close();
		if (seg.flags & SYN) {
			if (this.state === "synrcvd") {
				this.sndNxt = this.iss;
				this.clearTimer();
				this.synAck();
			}
			return;
		}
		if (!(seg.flags & ACK) || this.state === "connecting") return;
		const ack = seg.ack;
		if (seqLt(this.sndUna, ack) && seqLe(ack, this.sndNxt)) {
			let n = seqDiff(ack, this.sndUna);
			if (this.state === "synrcvd") {
				this.state = "established";
				n--;
			}
			if (this.finSent && ack === this.sndNxt) n--;
			if (n > 0) this.sendq.drop(n);
			this.sndUna = ack;
			this.retries = 0;
			this.rto = RTO_MS;
			this.clearTimer();
			if (this.sndUna !== this.sndNxt) this.armTimer();
		}
		if (this.state === "synrcvd") return;
		if (seqLe(this.sndUna, ack)) this.sndWl = seqAdd(ack, seg.win << this.sndWscale);
		if (this.sndUna === this.sndNxt) this.retries = 0;
		const len = payload.length;
		let seq = seg.seq;
		let data = payload;
		let needAck = false;
		if (len || seg.flags & FIN) {
			const skip = seqDiff(this.rcvNxt, seq);
			if (skip > 0) {
				if (skip >= len + (seg.flags & FIN ? 1 : 0)) {
					this.ack();
					return;
				}
				data = data.subarray(Math.min(skip, len));
				seq = this.rcvNxt;
			} else if (skip < 0) {
				this.ack();
				return;
			}
			if (data.length && !this.guestFin) {
				this.handle.write(data);
				this.rcvNxt = seqAdd(this.rcvNxt, data.length);
			}
			if (seg.flags & FIN && !this.guestFin) {
				this.guestFin = true;
				this.rcvNxt = seqAdd(this.rcvNxt, 1);
				this.handle.end();
			}
			needAck = true;
		}
		const before = this.sndNxt;
		this.flush();
		if (needAck && this.sndNxt === before) this.ack();
		this.maybeDone();
	}
};
var NetStack = class {
	backend;
	log;
	hostLoopback;
	mtu;
	mac;
	gwMac;
	guestMac;
	net;
	mask;
	gw;
	dns;
	guest;
	tcp;
	ipId;
	output;
	stats;
	constructor(opts) {
		this.backend = opts.backend;
		this.log = opts.log;
		this.hostLoopback = opts.hostLoopback ?? false;
		this.mtu = opts.mtu;
		this.mac = parseMac(opts.mac ?? "52:54:00:12:34:56");
		this.gwMac = parseMac("52:55:0a:00:02:02");
		this.guestMac = this.mac;
		this.net = ip4$1("10.0.2.0");
		this.mask = ip4$1("255.255.255.0");
		this.gw = ip4$1("10.0.2.2");
		this.dns = ip4$1("10.0.2.3");
		this.guest = ip4$1("10.0.2.15");
		this.tcp = /* @__PURE__ */ new Map();
		this.ipId = 1;
		this.output = () => {};
		this.stats = {
			rx: 0,
			tx: 0,
			tcpOpened: 0,
			dns: 0
		};
	}
	attach(kernel) {
		this.output = (frame) => kernel.receiveFrame(frame);
	}
	send(frame) {
		this.stats.rx++;
		try {
			this.input(frame);
		} catch (e) {
			this.log?.(`[net] dropped malformed frame: ${errorText(e)}`);
		}
	}
	close() {
		for (const c of [...this.tcp.values()]) c.close();
	}
	emit(frame) {
		this.stats.tx++;
		this.output(frame);
	}
	backendHost(ip) {
		if (ip === this.gw) return this.hostLoopback ? "127.0.0.1" : null;
		if ((ip & this.mask) >>> 0 === this.net) return null;
		if (ip === 4294967295 || ip >>> 28 === 14 || ip >>> 24 === 0 || ip >>> 24 === 127) return null;
		return ip4str(ip);
	}
	input(f) {
		if (f.length < 14) return;
		const type = f[12] << 8 | f[13];
		if (type === ETH_ARP) this.arp(f);
		else if (type === ETH_IP) this.ipv4(f);
	}
	arp(f) {
		const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
		if (f.length < 42 || dv.getUint16(20) !== 1) return;
		const tip = dv.getUint32(38);
		const sip = dv.getUint32(28);
		if (tip === sip || tip === this.guest || (tip & this.mask) >>> 0 !== this.net) return;
		this.guestMac = f.slice(22, 28);
		const r = /* @__PURE__ */ new Uint8Array(42);
		r.set(this.guestMac, 0);
		r.set(this.gwMac, 6);
		const o = new DataView(r.buffer);
		o.setUint16(12, ETH_ARP);
		o.setUint16(14, 1);
		o.setUint16(16, ETH_IP);
		r[18] = 6;
		r[19] = 4;
		o.setUint16(20, 2);
		r.set(this.gwMac, 22);
		o.setUint32(28, tip);
		r.set(f.subarray(22, 28), 32);
		o.setUint32(38, sip);
		this.emit(r);
	}
	ipv4(f) {
		const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
		if (f.length < 34 || f[14] >> 4 !== 4) return;
		const ihl = (f[14] & 15) * 4;
		const total = dv.getUint16(16);
		if ((dv.getUint16(20) & 16383) !== 0) return;
		const proto = f[23];
		const src = dv.getUint32(26), dst = dv.getUint32(30);
		const l4 = 14 + ihl;
		const end = Math.min(f.length, total ? 14 + total : f.length);
		if (end < l4) return;
		this.guestMac = f.slice(6, 12);
		if (proto === PROTO_TCP) this.tcpInput(f, dv, src, dst, l4, end);
		else if (proto === PROTO_UDP) this.udpInput(f, dv, src, dst, l4, end);
		else if (proto === PROTO_ICMP) this.icmpInput(f, dv, src, dst, l4, end);
	}
	ipFrame(src, dst, proto, l4len, dstMac = this.guestMac) {
		const f = new Uint8Array(34 + l4len);
		f.set(dstMac, 0);
		f.set(this.gwMac, 6);
		f[12] = 8;
		f[13] = 0;
		const dv = new DataView(f.buffer);
		f[14] = 69;
		dv.setUint16(16, 20 + l4len);
		dv.setUint16(18, this.ipId = this.ipId + 1 & 65535);
		dv.setUint16(20, 16384);
		f[22] = 64;
		f[23] = proto;
		dv.setUint32(26, src);
		dv.setUint32(30, dst);
		dv.setUint16(24, fold(sum16(f, 14, 20)));
		return [f, dv];
	}
	l4csum(f, src, dst, proto, off, len) {
		return fold(sum16(f, off, len, (src >>> 16) + (src & 65535) + (dst >>> 16) + (dst & 65535) + proto + len));
	}
	sendUdp(src, sport, dst, dport, payload, dstMac) {
		const [f, dv] = this.ipFrame(src, dst, PROTO_UDP, 8 + payload.length, dstMac);
		dv.setUint16(34, sport);
		dv.setUint16(36, dport);
		dv.setUint16(38, 8 + payload.length);
		f.set(payload, 42);
		dv.setUint16(40, this.l4csum(f, src, dst, PROTO_UDP, 34, 8 + payload.length) || 65535);
		this.emit(f);
	}
	sendTcp(c, flags, seq, payloadLen, opts, wnd) {
		const hl = 20 + (opts ? opts.length : 0);
		const [f, dv] = this.ipFrame(c.ip, this.guest, PROTO_TCP, hl + payloadLen);
		dv.setUint16(34, c.port);
		dv.setUint16(36, c.gport);
		dv.setUint32(38, seq);
		dv.setUint32(42, flags & ACK ? c.rcvNxt : 0);
		f[46] = hl / 4 << 4;
		f[47] = flags;
		dv.setUint16(48, wnd);
		if (opts) f.set(opts, 54);
		if (payloadLen) c.sendq.copyTo(f, 34 + hl, seqDiff(seq, c.sndUna), payloadLen);
		dv.setUint16(50, this.l4csum(f, c.ip, this.guest, PROTO_TCP, 34, hl + payloadLen));
		this.emit(f);
	}
	icmpInput(f, _dv, src, dst, l4, end) {
		if (f[l4] !== 8 || dst !== this.gw && dst !== this.dns) return;
		const len = end - l4;
		const [r, rv] = this.ipFrame(dst, src, PROTO_ICMP, len);
		r.set(f.subarray(l4, end), 34);
		r[34] = 0;
		rv.setUint16(36, 0);
		rv.setUint16(36, fold(sum16(r, 34, len)));
		this.emit(r);
	}
	icmpUnreachable(f, l4, src, dst, code) {
		const quote = f.subarray(14, Math.min(f.length, l4 + 8));
		const [r, rv] = this.ipFrame(dst, src, PROTO_ICMP, 8 + quote.length);
		r[34] = 3;
		r[35] = code;
		r.set(quote, 42);
		rv.setUint16(36, fold(sum16(r, 34, 8 + quote.length)));
		this.emit(r);
	}
	udpInput(f, dv, src, dst, l4, end) {
		if (end - l4 < 8) return;
		const sport = dv.getUint16(l4), dport = dv.getUint16(l4 + 2);
		const payload = f.subarray(l4 + 8, Math.min(end, l4 + dv.getUint16(l4 + 4)));
		if (dport === 67) return this.dhcp(payload);
		if (dport === 53 && (dst === this.dns || dst === this.gw)) {
			this.dnsQuery(payload, src, sport, dst);
			return;
		}
		if (dst === 4294967295 || dst >>> 28 === 14) return;
		this.icmpUnreachable(f, l4, src, dst, 3);
	}
	dhcp(p) {
		if (p.length < 240 || p[0] !== 1) return;
		if (new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(236) !== 1669485411) return;
		let type = 0;
		for (let i = 240; i < p.length && p[i] !== 255;) {
			if (p[i] === 0) {
				i++;
				continue;
			}
			if (p[i] === 53) type = p[i + 2];
			i += 2 + p[i + 1];
		}
		const reply = {
			1: 2,
			3: 5,
			8: 5
		}[type];
		if (!reply) return;
		const opts = [
			53,
			1,
			reply,
			54,
			4,
			...this.bytes4(this.gw)
		];
		if (type !== 8) opts.push(51, 4, ...this.bytes4(86400));
		opts.push(1, 4, ...this.bytes4(this.mask), 3, 4, ...this.bytes4(this.gw), 6, 4, ...this.bytes4(this.dns), 28, 4, ...this.bytes4((this.net | ~this.mask) >>> 0));
		if (this.mtu) opts.push(26, 2, this.mtu >> 8, this.mtu & 255);
		opts.push(255);
		const r = new Uint8Array(240 + opts.length);
		const rv = new DataView(r.buffer);
		r[0] = 2;
		r[1] = 1;
		r[2] = 6;
		r.set(p.subarray(4, 8), 4);
		r.set(p.subarray(10, 12), 10);
		r.set(p.subarray(12, 16), 12);
		if (type !== 8) rv.setUint32(16, this.guest);
		rv.setUint32(20, this.gw);
		r.set(p.subarray(28, 44), 28);
		rv.setUint32(236, 1669485411);
		r.set(opts, 240);
		const chaddr = p.slice(28, 34);
		this.sendUdp(this.gw, 67, 4294967295, 68, r, Uint8Array.of(255, 255, 255, 255, 255, 255));
		if (reply === 5) this.guestMac = chaddr;
	}
	bytes4(n) {
		return [
			n >>> 24,
			n >>> 16 & 255,
			n >>> 8 & 255,
			n & 255
		];
	}
	async dnsQuery(q, src, sport, dst) {
		if (q.length < 12) return;
		const dv = new DataView(q.buffer, q.byteOffset, q.byteLength);
		if (q[2] & 128 || dv.getUint16(4) !== 1) return;
		const labels = [];
		let i = 12;
		while (i < q.length && q[i] !== 0) {
			if (q[i] & 192) return;
			labels.push(new TextDecoder().decode(q.subarray(i + 1, i + 1 + q[i])));
			i += 1 + q[i];
		}
		if (i + 5 > q.length) return;
		const qtype = dv.getUint16(i + 1), qclass = dv.getUint16(i + 3);
		const qend = i + 5;
		const name = labels.join(".");
		this.stats.dns++;
		let rcode = 0, addrs = [];
		if (qtype === 1 && qclass === 1) try {
			addrs = await this.backend.lookup(name);
			addrs = addrs.filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
			if (!addrs.length) rcode = 3;
		} catch (e) {
			const err = e;
			rcode = err?.code === "ENOTFOUND" || err?.code === "ENODATA" ? 3 : 2;
			if (rcode === 2) this.log?.(`[net] dns ${name}: ${err?.message ?? e}`);
		}
		const r = new Uint8Array(qend + addrs.length * 16);
		r.set(q.subarray(0, qend));
		const rv = new DataView(r.buffer);
		rv.setUint16(2, (q[2] & 1) << 8 | 32896 | rcode);
		rv.setUint16(6, addrs.length);
		rv.setUint16(8, 0);
		rv.setUint16(10, 0);
		let o = qend;
		for (const a of addrs) {
			rv.setUint16(o, 49164);
			rv.setUint16(o + 2, 1);
			rv.setUint16(o + 4, 1);
			rv.setUint32(o + 6, 60);
			rv.setUint16(o + 10, 4);
			rv.setUint32(o + 12, ip4$1(a));
			o += 16;
		}
		this.sendUdp(dst, 53, src, sport, r);
	}
	tcpInput(f, dv, _src, dst, l4, end) {
		if (end - l4 < 20) return;
		const hl = (f[l4 + 12] >> 4) * 4;
		const seg = {
			sport: dv.getUint16(l4),
			dport: dv.getUint16(l4 + 2),
			seq: dv.getUint32(l4 + 4),
			ack: dv.getUint32(l4 + 8),
			flags: f[l4 + 13],
			win: dv.getUint16(l4 + 14)
		};
		const payload = f.subarray(l4 + hl, end);
		const key = `${seg.sport}/${dst}/${seg.dport}`;
		let c = this.tcp.get(key);
		if ((seg.flags & 18) === SYN) {
			if (c && c.irs === seg.seq) return c.input(seg, payload);
			c?.close();
			for (let i = l4 + 20; i < l4 + hl;) {
				const kind = f[i];
				if (kind === 0) break;
				if (kind === 1) {
					i++;
					continue;
				}
				if (kind === 2) seg.mss = dv.getUint16(i + 2);
				if (kind === 3) seg.wscale = Math.min(f[i + 2], 14);
				i += Math.max(2, f[i + 1]);
			}
			c = new TcpConn(this, key, seg.sport, dst, seg.dport, seg);
			this.tcp.set(key, c);
			this.stats.tcpOpened++;
			c.connect();
			return;
		}
		if (c) return c.input(seg, payload);
		if (seg.flags & RST) return;
		const fake = {
			ip: dst,
			port: seg.dport,
			gport: seg.sport,
			rcvNxt: 0,
			sndUna: 0,
			sendq: null
		};
		if (seg.flags & ACK) this.sendTcp(fake, RST, seg.ack, 0, null, 0);
		else {
			fake.rcvNxt = seqAdd(seg.seq, payload.length + (seg.flags & FIN ? 1 : 0));
			this.sendTcp(fake, 20, 0, 0, null, 0);
		}
	}
};
const FORWARD_HEADERS = [
	"range",
	"if-range",
	"if-modified-since",
	"if-none-match"
];
const COPY_HEADERS = [
	"Content-Range",
	"ETag",
	"Last-Modified",
	"Accept-Ranges",
	"Content-Type"
];
const HOP_HEADERS = /* @__PURE__ */ new Set([
	"host",
	"connection",
	"keep-alive",
	"transfer-encoding",
	"content-length",
	"upgrade",
	"proxy-connection",
	"te"
]);
const ROUTE_BASE = 3325256704;
const MAX_ROUTES = 254;
const MAX_HEAD = 16384;
const REASONS = {
	200: "OK",
	204: "No Content",
	206: "Partial Content",
	301: "Moved Permanently",
	302: "Found",
	304: "Not Modified",
	400: "Bad Request",
	403: "Forbidden",
	404: "Not Found",
	405: "Method Not Allowed",
	416: "Range Not Satisfiable",
	431: "Request Header Fields Too Large",
	500: "Internal Server Error",
	502: "Bad Gateway",
	503: "Service Unavailable"
};
const enc$2 = new TextEncoder();
const latin1 = new TextDecoder("latin1");
const ipStr = (ip) => `${ip >>> 24}.${ip >>> 16 & 255}.${ip >>> 8 & 255}.${ip & 255}`;
const normName = (s) => s.toLowerCase().replace(/\.$/, "");
function refused(ev, why) {
	let dead = false;
	queueMicrotask(() => {
		if (!dead) ev.onClose(new Error(why));
	});
	return {
		write() {},
		end() {},
		destroy() {
			dead = true;
		},
		pause() {},
		resume() {},
		buffered: 0
	};
}
function parseHead(head) {
	const lines = head.split("\r\n");
	const [method = "", target = "", version = "", ...rest] = lines[0].split(" ");
	const bad = (status) => ({
		method,
		path: "/",
		headers: [],
		close: true,
		status
	});
	if (rest.length || !/^HTTP\/1\.[01]$/.test(version)) return bad(400);
	const headers = [];
	for (const l of lines.slice(1)) {
		const i = l.indexOf(":");
		if (i <= 0) return bad(400);
		headers.push([l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()]);
	}
	const get = (n) => headers.find(([k]) => k === n)?.[1];
	const conn = get("connection") ?? "";
	const close = version === "HTTP/1.0" ? !/keep-alive/i.test(conn) : /\bclose\b/i.test(conn);
	if (method !== "GET" && method !== "HEAD") return bad(405);
	if (get("transfer-encoding") || Number(get("content-length") ?? 0) > 0) return bad(400);
	const path = /^https?:\/\//i.test(target) ? target.replace(/^https?:\/\/[^/]*/i, "") || "/" : target;
	if (!path.startsWith("/")) return bad(400);
	return {
		method,
		path,
		headers,
		close
	};
}
function fetchRoutes(inner, routes, opts = {}) {
	const log = opts.log;
	const byName = /* @__PURE__ */ new Map();
	const byIp = /* @__PURE__ */ new Map();
	for (const [name, route] of Object.entries(routes)) {
		if (byName.size >= MAX_ROUTES) throw new Error(`fetchRoutes: more than ${MAX_ROUTES} routes`);
		const r = {
			name: normName(name),
			ip: ipStr(ROUTE_BASE + byName.size + 1),
			route
		};
		byName.set(r.name, r);
		byIp.set(r.ip, r);
	}
	const conns = /* @__PURE__ */ new Set();
	function fetchFor(host, route, req, signal) {
		if (typeof route !== "string") {
			const headers = new Headers();
			for (const [k, v] of req.headers) if (!HOP_HEADERS.has(k)) headers.append(k, v);
			return Promise.resolve(route(new Request(`http://${host}${req.path}`, {
				method: req.method,
				headers,
				signal
			})));
		}
		const headers = req.headers.filter(([k]) => FORWARD_HEADERS.includes(k));
		return fetch(route.replace(/\/+$/, "") + req.path, {
			method: req.method,
			headers,
			signal
		});
	}
	function serve(host, route, ev) {
		let text = "";
		const queue = [];
		let guestEnded = false, closing = false, dead = false, running = false, scheduled = false;
		let paused = false, wake = null;
		let ctl = null;
		const emit = (b) => {
			if (!dead) ev.onData(typeof b === "string" ? enc$2.encode(b) : b);
		};
		const kill = () => {
			dead = true;
			conns.delete(abortAll);
			ctl?.abort();
			wake?.();
		};
		const finish = (err) => {
			if (dead) return;
			kill();
			if (!err) ev.onEnd();
			ev.onClose(err);
		};
		const abortAll = () => finish(/* @__PURE__ */ new Error("backend closed"));
		conns.add(abortAll);
		queueMicrotask(() => {
			if (!dead) ev.onConnect();
		});
		function parse() {
			while (!closing) {
				text = text.replace(/^(\r\n)+/, "");
				const i = text.indexOf("\r\n\r\n");
				if (i < 0) {
					if (text.length > MAX_HEAD) {
						queue.push({
							method: "GET",
							path: "/",
							headers: [],
							close: true,
							status: 431
						});
						closing = true;
					}
					break;
				}
				const req = parseHead(text.slice(0, i));
				text = text.slice(i + 4);
				queue.push(req);
				if (req.close) closing = true;
			}
			if (closing) text = "";
		}
		function schedule() {
			if (scheduled || running) return;
			scheduled = true;
			queueMicrotask(() => {
				scheduled = false;
				run();
			});
		}
		async function run() {
			if (running || dead) return;
			running = true;
			try {
				while (!dead && queue.length) await answer(queue.shift());
			} finally {
				running = false;
			}
			if (!dead && !queue.length && (closing || guestEnded)) finish(null);
		}
		function simple(req, status, body = `${status} ${REASONS[status] ?? ""}\n`) {
			const b = enc$2.encode(body);
			emit(`HTTP/1.1 ${status} ${REASONS[status] ?? ""}\r\nContent-Type: text/plain\r\nContent-Length: ${b.length}\r\nConnection: ${req.close ? "close" : "keep-alive"}\r\n\r\n`);
			if (req.method !== "HEAD") emit(b);
		}
		async function answer(req) {
			if (req.status) return simple(req, req.status);
			const c = ctl = new AbortController();
			let res;
			try {
				res = await fetchFor(host, route, req, c.signal);
			} catch (e) {
				if (dead) return;
				const msg = e?.message ?? String(e);
				log?.(`[net] fetch http://${host}${req.path}: ${msg}`);
				return simple(req, 503, `fetch failed: ${msg}\n`);
			}
			if (dead) {
				res.body?.cancel().catch(() => {});
				return;
			}
			const status = res.status;
			const len = res.headers.get("content-length"), coding = res.headers.get("content-encoding");
			const noBody = req.method === "HEAD" || status === 204 || status === 304 || status < 200;
			const chunked = !noBody && (len === null || coding !== null);
			let head = `HTTP/1.1 ${status} ${res.statusText || REASONS[status] || ""}\r\n`;
			if (len !== null && coding === null && status !== 204 && status !== 304) head += `Content-Length: ${len}\r\n`;
			else if (chunked) head += "Transfer-Encoding: chunked\r\n";
			for (const h of COPY_HEADERS) {
				const v = res.headers.get(h);
				if (v !== null) head += `${h}: ${v}\r\n`;
			}
			head += `Connection: ${req.close ? "close" : "keep-alive"}\r\n\r\n`;
			emit(head);
			if (noBody || !res.body) {
				res.body?.cancel().catch(() => {});
				if (chunked) emit("0\r\n\r\n");
				return;
			}
			const reader = res.body.getReader();
			try {
				for (;;) {
					while (paused && !dead) await new Promise((r) => {
						wake = r;
					});
					if (dead) break;
					const { done, value } = await reader.read();
					if (dead || done) break;
					if (!value.length) continue;
					if (!chunked) {
						emit(value);
						continue;
					}
					const pre = enc$2.encode(`${value.length.toString(16)}\r\n`);
					const b = new Uint8Array(pre.length + value.length + 2);
					b.set(pre);
					b.set(value, pre.length);
					b[b.length - 2] = 13;
					b[b.length - 1] = 10;
					emit(b);
				}
				if (!dead && chunked) emit("0\r\n\r\n");
			} catch (e) {
				if (dead) return;
				log?.(`[net] fetch http://${host}${req.path}: ${e?.message ?? e}`);
				finish(e instanceof Error ? e : new Error(String(e)));
			} finally {
				if (dead) reader.cancel().catch(() => {});
				if (ctl === c) ctl = null;
			}
		}
		return {
			write(u8) {
				if (dead || closing) return;
				text += latin1.decode(u8);
				parse();
				schedule();
			},
			end() {
				if (dead) return;
				guestEnded = true;
				schedule();
			},
			destroy() {
				if (!dead) kill();
			},
			pause() {
				paused = true;
			},
			resume() {
				paused = false;
				const w = wake;
				wake = null;
				w?.();
			},
			buffered: 0
		};
	}
	return {
		lookup(name) {
			const r = byName.get(normName(name));
			if (r) return Promise.resolve([r.ip]);
			return inner ? inner.lookup(name) : Promise.reject({ code: "ENOTFOUND" });
		},
		connect(addr, ev) {
			const r = byIp.get(addr.host) ?? byName.get(normName(addr.host));
			if (r) return addr.port === 80 ? serve(r.name, r.route, ev) : refused(ev, `connection refused (${r.name} serves port 80 only)`);
			return inner ? inner.connect(addr, ev) : refused(ev, "connection refused");
		},
		close() {
			for (const abort of [...conns]) abort();
			inner?.close?.();
		}
	};
}
const DEFAULT_WISP_SERVERS = Object.freeze(["wss://wisp.pi0.io:6680/"]);
const isBrowser = () => typeof globalThis.document !== "undefined" || typeof globalThis.WorkerGlobalScope !== "undefined";
const RETRY_MS$1 = 5e3;
const HANDSHAKE_TIMEOUT_MS = 1e4;
const MAX_PACKET = 65536;
const FAKE_BASE = 3323068416;
const FAKE_SIZE = 1 << 17;
const enc$1 = new TextEncoder();
const CLOSE_REASONS = {
	1: "unspecified",
	3: "network error",
	65: "invalid info",
	66: "host unreachable",
	67: "connect timed out",
	68: "connection refused",
	71: "transfer timed out",
	72: "blocked by the proxy",
	73: "throttled"
};
function packet(type, id, payload) {
	const b = new Uint8Array(5 + (payload?.length ?? 0));
	b[0] = type;
	new DataView(b.buffer).setUint32(1, id, true);
	if (payload) b.set(payload, 5);
	return b;
}
const ip4 = (s) => s.split(".").reduce((a, b) => (a << 8 | Number(b)) >>> 0, 0);
const isIPv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
function wispBackend(url, opts = {}) {
	const urls = typeof url === "string" ? [url] : [...url];
	const log = opts.log ?? (() => {});
	const name = (u) => DEFAULT_WISP_SERVERS.includes(u) ? "the default server" : u;
	const wsInit = opts.headers && !isBrowser() ? { headers: opts.headers } : void 0;
	let ws = null, ready = null, failedAt = -1e400, warned = false;
	let initialCredit = 0;
	let nextId = 1;
	const streams = /* @__PURE__ */ new Map();
	const nameToIp = /* @__PURE__ */ new Map(), ipToName = /* @__PURE__ */ new Map();
	let nextFake = 1;
	let connecting = [];
	function connectWs() {
		if (ready) return ready;
		if (performance.now() - failedAt < RETRY_MS$1) return Promise.reject(/* @__PURE__ */ new Error("wisp server unavailable"));
		ready = new Promise((resolve, reject) => {
			const t0 = performance.now();
			const sockets = connecting = [];
			let settled = false, pending = urls.length;
			const fail = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				for (const s of sockets) s.close();
				ready = null;
				failedAt = performance.now();
				if (!warned) log(`[net] wisp ${urls.length > 1 ? "servers" : "server"} ${urls.map(name).join(", ")} unavailable; guest network offline`);
				warned = true;
				reject(/* @__PURE__ */ new Error("wisp server unavailable"));
			};
			const timer = setTimeout(fail, HANDSHAKE_TIMEOUT_MS);
			for (const u of urls) {
				let s;
				try {
					s = new WebSocket(u, wsInit);
				} catch {
					if (--pending === 0) fail();
					continue;
				}
				sockets.push(s);
				s.binaryType = "arraybuffer";
				s.onerror = () => {};
				s.onclose = () => {
					if (ws === s) {
						ws = null;
						ready = null;
						log("[net] wisp connection closed");
						for (const st of [...streams.values()]) st.closed(/* @__PURE__ */ new Error("wisp connection closed"));
					} else if (--pending === 0) fail();
				};
				s.onmessage = (e) => {
					const m = new Uint8Array(e.data);
					if (ws === s) return onPacket(m);
					if (settled || m.length < 9 || m[0] !== 3) return;
					settled = true;
					clearTimeout(timer);
					initialCredit = new DataView(m.buffer).getUint32(5, true);
					ws = s;
					warned = false;
					for (const o of sockets) if (o !== s) o.close();
					log(`[net] wisp connected: ${name(u)} (handshake ${Math.round(performance.now() - t0)} ms, buffer ${initialCredit} packets)`);
					resolve(s);
				};
			}
		});
		ready.catch(() => {});
		return ready;
	}
	function onPacket(m) {
		if (m.length < 5) return;
		const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
		const st = streams.get(dv.getUint32(1, true));
		if (!st) return;
		switch (m[0]) {
			case 2:
				st.ev.onData(m.subarray(5));
				break;
			case 3:
				if (m.length >= 9) {
					st.credit = dv.getUint32(5, true);
					st.pump();
				}
				break;
			case 4: {
				const r = m.length > 5 ? m[5] : 1;
				st.closed(r === 2 ? null : /* @__PURE__ */ new Error(`wisp: ${CLOSE_REASONS[r] ?? `close reason 0x${r.toString(16)}`}`));
				break;
			}
		}
	}
	return {
		connect({ host, port }, ev) {
			const id = nextId++;
			const name = isIPv4(host) ? ipToName.get(ip4(host)) ?? host : host;
			const st = {
				ev,
				credit: 0,
				out: [],
				outBytes: 0,
				done: false,
				scheduled: false,
				open: false,
				closed(err) {
					if (st.done) return;
					st.done = true;
					streams.delete(id);
					ev.onClose(err);
				},
				pump() {
					st.scheduled = false;
					if (!st.open || st.done || !ws) return;
					const before = st.outBytes;
					while (st.out.length && st.credit > 0) {
						let n = 0, k = 0;
						while (k < st.out.length && n + st.out[k].length <= MAX_PACKET) n += st.out[k++].length;
						if (k === 0) {
							n = st.out[0].length;
							k = 1;
						}
						const p = new Uint8Array(5 + n);
						p[0] = 2;
						new DataView(p.buffer).setUint32(1, id, true);
						let o = 5;
						for (const c of st.out.splice(0, k)) {
							p.set(c, o);
							o += c.length;
						}
						ws.send(p);
						st.credit--;
						st.outBytes -= n;
					}
					if (st.outBytes < before) ev.onDrain();
				}
			};
			streams.set(id, st);
			connectWs().then((s) => {
				if (st.done) return;
				const req = new Uint8Array(3 + enc$1.encode(name).length);
				req[0] = 1;
				new DataView(req.buffer).setUint16(1, port, true);
				req.set(enc$1.encode(name), 3);
				s.send(packet(1, id, req));
				st.credit = initialCredit;
				st.open = true;
				ev.onConnect();
				st.pump();
			}, (e) => queueMicrotask(() => st.closed(e)));
			return {
				write(u8) {
					if (st.done) return;
					st.out.push(u8.slice());
					st.outBytes += u8.length;
					if (!st.scheduled) {
						st.scheduled = true;
						queueMicrotask(st.pump);
					}
				},
				end() {},
				destroy() {
					if (st.done) return;
					st.done = true;
					streams.delete(id);
					if (st.open) ws?.send(packet(4, id, Uint8Array.of(2)));
				},
				pause() {},
				resume() {},
				get buffered() {
					return st.outBytes;
				}
			};
		},
		lookup(name) {
			if (isIPv4(name)) return Promise.resolve([name]);
			let ip = nameToIp.get(name);
			if (ip === void 0) {
				ip = FAKE_BASE + nextFake++ % FAKE_SIZE >>> 0;
				const old = ipToName.get(ip);
				if (old !== void 0) nameToIp.delete(old);
				nameToIp.set(name, ip);
				ipToName.set(ip, name);
			}
			return Promise.resolve([`${ip >>> 24}.${ip >>> 16 & 255}.${ip >>> 8 & 255}.${ip & 255}`]);
		},
		close() {
			ws?.close();
			if (!ws) for (const s of connecting) s.close();
		}
	};
}
const DEVICE_SPEC_VERSION = 1;
const coreDevices = {
	disks: { async http(spec, ctx) {
		const opts = {
			chunkSize: spec.chunkSize,
			prefetch: spec.prefetch,
			log: ctx.log
		};
		if (spec.readOnly) return new BaseDisk(await HttpBase.open(spec.url, {
			...opts,
			strict: true
		}));
		return new CowDisk(await HttpBase.open(spec.url, opts), { log: ctx.log });
	} },
	backends: { wisp: (spec, ctx) => wispBackend(spec.servers, {
		headers: spec.headers,
		log: ctx.log
	}) }
};
function extendDevices(base, more) {
	return {
		disks: {
			...base.disks,
			...more.disks
		},
		backends: {
			...base.backends,
			...more.backends
		}
	};
}
const isPlain = (x) => typeof x === "object" && x !== null && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
function isDiskSpec(x) {
	return isPlain(x) && typeof x.kind === "string" && typeof x.read !== "function";
}
function isNetSpec(x) {
	return isPlain(x) && x.kind === "net" && isPlain(x.backend);
}
function checkVersion(spec, what) {
	if (spec.v !== void 0 && spec.v !== 1) throw new BootError("support", `${what} "${spec.kind}": spec version ${spec.v}, this SDK reads 1`);
}
async function buildDisks(items, registry, ctx) {
	const disks = [], skipped = [];
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (!isDiskSpec(item)) {
			disks.push(item);
			continue;
		}
		const make = registry?.disks[item.kind];
		try {
			checkVersion(item, "disk kind");
			if (!make) throw new BootError("support", `disk kind "${item.kind}" is not available on this platform`);
			disks.push(await make(item, {
				...ctx,
				index
			}));
		} catch (e) {
			const reason = e?.message ?? String(e);
			if (!item.optional) throw e instanceof BootError ? e : new BootError("boot", `disk ${index} (${item.kind}): ${reason}`, { cause: e });
			ctx.log(`[host] disk ${index} (${item.kind}) left out: ${reason}`);
			skipped.push({
				index,
				kind: item.kind,
				reason
			});
		}
	}
	return {
		disks,
		skipped
	};
}
function buildNet(spec, registry, ctx) {
	checkVersion(spec, "net");
	const make = registry?.backends[spec.backend.kind];
	try {
		if (!make) throw new BootError("support", `network backend "${spec.backend.kind}" is not available on this platform`);
		const inner = make(spec.backend, {
			...ctx,
			index: 0
		});
		const routes = spec.backend.kind === "wisp" ? spec.backend.routes : void 0;
		return new NetStack({
			backend: routes && Object.keys(routes).length ? fetchRoutes(inner, routes, { log: ctx.log }) : inner,
			hostLoopback: spec.hostLoopback,
			mtu: spec.mtu,
			mac: spec.mac,
			log: ctx.log
		});
	} catch (e) {
		if (!spec.optional) throw e;
		ctx.log(`[host] network left out: ${e?.message ?? e}`);
		return;
	}
}
const SB = 1024;
const HEAD = 65536;
const EROFS_MAGIC = 3774210530;
const EXT4_MAGIC = 61267;
const hex$1 = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const label = (b) => new TextDecoder().decode(b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)));
function hash53(b) {
	let h1 = 3735928559, h2 = 1103547991;
	for (let i = 0; i < b.length; i++) {
		const c = b[i];
		h1 = Math.imul(h1 ^ c, 2654435761);
		h2 = Math.imul(h2 ^ c, 1597334677);
	}
	h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507) ^ Math.imul(h2 ^ h2 >>> 13, 3266489909);
	h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507) ^ Math.imul(h1 ^ h1 >>> 13, 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}
function probeDistro(head) {
	if (head.length < 1160) return null;
	const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
	if (dv.getUint32(SB, true) === EROFS_MAGIC) return {
		fs: "erofs",
		uuid: hex$1(head.subarray(1072, 1088)),
		label: label(head.subarray(1088, 1104))
	};
	if (dv.getUint16(1080, true) === EXT4_MAGIC) return {
		fs: "ext4",
		uuid: hex$1(head.subarray(1128, 1144)),
		label: label(head.subarray(1144, 1160))
	};
	return null;
}
var DistroDisk = class DistroDisk {
	inner;
	info;
	size;
	readOnly = true;
	flags = 1;
	blockSize;
	constructor(inner, info) {
		this.inner = inner;
		this.info = info;
		this.size = inner.size;
		if (inner.blockSize) this.blockSize = inner.blockSize;
	}
	static async open(inner, { name, log } = {}) {
		if (inner instanceof DistroDisk) return inner;
		name ??= stampOf(inner)?.name ?? "the distro image";
		const head = new Uint8Array(Math.min(HEAD, inner.size));
		const r = inner.read(0, [head]);
		if (r instanceof Promise) await r;
		const fs = probeDistro(head);
		if (!fs) throw new Error(`${name} is neither an erofs nor an ext4 image`);
		if (fs.label !== "kwroot") (log ?? ((m) => console.warn(m)))(`[host] distro: ${name} is labelled "${fs.label}", not "kwroot": the base initramfs will not find it`);
		const identity = `distro ${fs.fs} size=${inner.size} uuid=${fs.uuid} label=${fs.label} head=${hash53(head)}`;
		const h = readDistroHeader(head, inner.size);
		const hint = h ? {
			distro: h.distro,
			image: h.image,
			prefetch: h.prefetch
		} : {};
		return new DistroDisk(inner, {
			name,
			...fs,
			size: inner.size,
			identity,
			...hint
		});
	}
	get stats() {
		return this.inner.stats;
	}
	read(off, views) {
		return this.inner.read(off, views);
	}
	write() {
		throw new Error("the distro image is read-only");
	}
	snapshotState() {
		return {
			name: this.info.name,
			identity: this.info.identity,
			gen: 0,
			stamp: stampOf(this.inner)?.stamp
		};
	}
	snapshotSeal() {
		return {
			state: this.snapshotState(),
			done: Promise.resolve()
		};
	}
	close() {
		this.inner.close?.();
	}
};
function stampOf(d) {
	try {
		const s = d.snapshotState?.();
		return s && {
			name: s.name,
			stamp: s.stamp ?? s.identity
		};
	} catch {
		return;
	}
}
function distroSpecOf(src, toSpec) {
	if (toSpec) return toSpec(src);
	const url = String(src);
	if (!/^https?:/i.test(url)) throw new BootError("boot", `distro: ${url}: this platform opens only http(s) URLs`);
	return {
		kind: "http",
		url,
		readOnly: true
	};
}
function readOnlySpec(spec) {
	if (spec.kind === "data") throw new BootError("boot", "distro: a \"data\" disk spec cannot be a distro image (use a \"file\" or \"http\" spec)");
	const out = {
		...spec,
		readOnly: true
	};
	delete out.snapshot;
	return out;
}
async function openDistro(src, registry, ctx, toSpec) {
	const item = typeof src === "string" || src instanceof URL ? distroSpecOf(src, toSpec) : isDiskSpec(src) ? readOnlySpec(src) : src;
	const owned = isDiskSpec(item);
	const name = owned ? item.path ?? item.url : void 0;
	let dev;
	try {
		if (owned) {
			const spec = item;
			if (spec.v !== void 0 && spec.v !== 1) throw new BootError("support", `disk kind "${spec.kind}": spec version ${spec.v}, this SDK reads 1`);
			const make = registry?.disks[spec.kind];
			if (!make) throw new BootError("support", `disk kind "${spec.kind}" is not available on this platform`);
			dev = await make(spec, {
				...ctx,
				index: -1
			});
		} else dev = item;
	} catch (e) {
		throw e instanceof BootError ? new BootError(e.stage, `distro: ${e.message}`, { cause: e }) : new BootError("boot", `distro: ${e?.message ?? e}`, { cause: e });
	}
	try {
		return {
			disk: await DistroDisk.open(dev, {
				name,
				log: ctx.log
			}),
			owned
		};
	} catch (e) {
		if (owned) try {
			dev.close?.();
		} catch {}
		throw new BootError("boot", `distro: ${e?.message ?? e}`, { cause: e });
	}
}
const SOUND_RING_DEFAULT_BYTES = 1 << 18;
const EVENT_FLAG = 65536;
const EVENTS = [
	"open",
	"prepare",
	"start",
	"stop",
	"drain",
	"close"
];
const NO_FORMAT = {
	rate: 0,
	channels: 0,
	format: 0,
	frameBytes: 0
};
const NO_DATA = /* @__PURE__ */ new Uint8Array(0);
function createSoundRing(capacityBytes = SOUND_RING_DEFAULT_BYTES) {
	if (!Number.isInteger(capacityBytes) || capacityBytes < 1024 || (capacityBytes & capacityBytes - 1) !== 0) throw new RangeError(`sound ring capacity must be a power of two >= 1024, got ${capacityBytes}`);
	return new SharedArrayBuffer(64 + capacityBytes);
}
function ringViews(buffer) {
	const capacity = buffer.byteLength - 64;
	if (capacity < 1024 || (capacity & capacity - 1) !== 0) throw new RangeError(`invalid sound ring byteLength ${buffer.byteLength}`);
	return {
		ctrl: new Int32Array(buffer, 0, 16),
		hdr: new Int32Array(buffer),
		data: new Uint8Array(buffer, 64, capacity),
		capacity,
		mask: capacity - 1
	};
}
function decodeFormat(rate, packed) {
	const channels = packed >> 8 & 255;
	const format = packed & 255;
	return {
		rate,
		channels,
		format,
		frameBytes: (format === 1 ? 1 : 2) * channels
	};
}
var SoundRingWriter = class {
	buffer;
	#ctrl;
	#hdr;
	#data;
	#capacity;
	#mask;
	#written = 0;
	constructor(buffer) {
		this.buffer = buffer;
		const v = ringViews(buffer);
		this.#ctrl = v.ctrl;
		this.#hdr = v.hdr;
		this.#data = v.data;
		this.#capacity = v.capacity;
		this.#mask = v.mask;
		this.#written = Atomics.load(this.#ctrl, 4);
	}
	writeEvent(n, event) {
		const head = Atomics.load(this.#ctrl, 0);
		const used = head - Atomics.load(this.#ctrl, 1) | 0;
		if (this.#capacity - used < 16) return false;
		const wi = 64 + (head & this.#mask) >> 2;
		this.#hdr[wi] = n & 2147483647;
		this.#hdr[wi + 1] = 0;
		this.#hdr[wi + 2] = EVENT_FLAG | EVENTS.indexOf(event);
		this.#hdr[wi + 3] = 0;
		Atomics.store(this.#ctrl, 0, head + 16 | 0);
		return true;
	}
	write(seq, format, bytes) {
		const n = bytes.byteLength;
		const recBytes = 16 + (n + 15 & -16);
		if (n <= 0 || recBytes > this.#capacity) return false;
		const head = Atomics.load(this.#ctrl, 0);
		const used = head - Atomics.load(this.#ctrl, 1) | 0;
		if (this.#capacity - used < recBytes + 256) {
			Atomics.add(this.#ctrl, 3, n);
			return false;
		}
		this.#written = this.#written + Math.floor(n / format.frameBytes) | 0;
		const pos = head & this.#mask;
		const wi = 64 + pos >> 2;
		this.#hdr[wi] = seq | 0;
		this.#hdr[wi + 1] = format.rate | 0;
		this.#hdr[wi + 2] = (format.channels & 255) << 8 | format.format & 255;
		this.#hdr[wi + 3] = n | 0;
		const dataOff = pos + 16 & this.#mask;
		const first = Math.min(n, this.#capacity - dataOff);
		this.#data.set(bytes.subarray(0, first), dataOff);
		if (first < n) this.#data.set(bytes.subarray(first), 0);
		const nextHead = head + recBytes | 0;
		Atomics.store(this.#ctrl, 0, nextHead);
		return (nextHead - Atomics.load(this.#ctrl, 1) | 0) === recBytes;
	}
	queuedFrames() {
		const unread = this.#written - Atomics.load(this.#ctrl, 4) | 0;
		return Atomics.load(this.#ctrl, 2) + Math.max(0, unread);
	}
	resetQueued() {
		Atomics.store(this.#ctrl, 2, 0);
	}
	droppedBytes() {
		return Atomics.load(this.#ctrl, 3);
	}
};
var SoundRingReader = class {
	buffer;
	#ctrl;
	#hdr;
	#data;
	#capacity;
	#mask;
	constructor(buffer) {
		this.buffer = buffer;
		const v = ringViews(buffer);
		this.#ctrl = v.ctrl;
		this.#hdr = v.hdr;
		this.#data = v.data;
		this.#capacity = v.capacity;
		this.#mask = v.mask;
	}
	availableBytes() {
		return Atomics.load(this.#ctrl, 0) - Atomics.load(this.#ctrl, 1) | 0;
	}
	setQueuedFrames(frames) {
		Atomics.store(this.#ctrl, 2, Math.max(0, Math.round(frames || 0)));
	}
	droppedBytes() {
		return Atomics.load(this.#ctrl, 3);
	}
	nextEvent() {
		const head = Atomics.load(this.#ctrl, 0);
		const tail = Atomics.load(this.#ctrl, 1);
		if (head === tail) return -1;
		const wi = 64 + (tail & this.#mask) >> 2;
		return this.#hdr[wi + 2] & EVENT_FLAG ? this.#hdr[wi] & 2147483647 : -1;
	}
	readNext(scratch) {
		const head = Atomics.load(this.#ctrl, 0);
		const tail = Atomics.load(this.#ctrl, 1);
		if (head === tail) return null;
		const pos = tail & this.#mask;
		const wi = 64 + pos >> 2;
		const seq = this.#hdr[wi];
		const packed = this.#hdr[wi + 2];
		if (packed & EVENT_FLAG) {
			Atomics.store(this.#ctrl, 1, tail + 16 | 0);
			return {
				seq: seq & 2147483647,
				format: NO_FORMAT,
				data: NO_DATA,
				event: EVENTS[packed & 255] ?? "stop"
			};
		}
		const format = decodeFormat(this.#hdr[wi + 1], packed);
		const n = this.#hdr[wi + 3];
		const out = scratch && scratch.byteLength >= n ? scratch.subarray(0, n) : new Uint8Array(n);
		const dataOff = pos + 16 & this.#mask;
		const first = Math.min(n, this.#capacity - dataOff);
		out.set(this.#data.subarray(dataOff, dataOff + first), 0);
		if (first < n) out.set(this.#data.subarray(0, n - first), first);
		Atomics.add(this.#ctrl, 4, format.frameBytes ? Math.floor(n / format.frameBytes) : 0);
		Atomics.store(this.#ctrl, 1, tail + 16 + (n + 15 & -16) | 0);
		return {
			seq,
			format,
			data: out
		};
	}
};
const EVDEV_OP = {
	key: 0,
	button: 1,
	move: 2,
	wheel: 3,
	moveTo: 4,
	tabletButton: 5,
	tabletWheel: 6,
	releaseAll: 7
};
const MOTION_BATCH_MS = 8;
const FRAME_CREDITS = 2;
const SOUND_REPORT_MS = 15;
const sharedNow = () => performance.timeOrigin + performance.now();
var RemoteEvdev = class {
	mask = 0;
	#post;
	#ops = [];
	#urgent = false;
	#timer;
	#micro = false;
	#keys = /* @__PURE__ */ new Set();
	#buttons = /* @__PURE__ */ new Set();
	#tabletButtons = /* @__PURE__ */ new Set();
	#shared;
	constructor(post, shared) {
		this.#post = post;
		this.#shared = shared;
	}
	get keyboardOpen() {
		return !!(this.mask & 1);
	}
	get mouseOpen() {
		return !!(this.mask & 2);
	}
	get tabletOpen() {
		return !!(this.mask & 4);
	}
	get state() {
		return {
			keyboard: this.keyboardOpen,
			mouse: this.mouseOpen,
			tablet: this.tabletOpen
		};
	}
	setMask(mask) {
		const closed = this.mask & ~mask;
		this.mask = mask >>> 0;
		if (closed & 1) this.#keys.clear();
		if (closed & 2) this.#buttons.clear();
		if (closed & 4) this.#tabletButtons.clear();
	}
	#held(set, open, op, code, down) {
		if (down) {
			if (!open) return false;
			if (!set.has(code)) {
				set.add(code);
				this.#queue(op, code, 1);
			}
			return true;
		}
		if (!set.delete(code)) return false;
		this.#queue(op, code, 0);
		return true;
	}
	key(code, down) {
		return this.#held(this.#keys, this.keyboardOpen, EVDEV_OP.key, code, down);
	}
	button(code, down) {
		return this.#held(this.#buttons, this.mouseOpen, EVDEV_OP.button, code, down);
	}
	tabletButton(code, down) {
		return this.#held(this.#tabletButtons, this.tabletOpen, EVDEV_OP.tabletButton, code, down);
	}
	move(dx, dy) {
		if (!this.mouseOpen) return false;
		this.#queue(EVDEV_OP.move, dx, dy, true);
		return true;
	}
	wheel(clicks) {
		if (!this.mouseOpen) return false;
		if (Math.round(clicks)) this.#queue(EVDEV_OP.wheel, clicks, 0, true);
		return true;
	}
	moveTo(x, y) {
		if (!this.tabletOpen) return false;
		this.#queue(EVDEV_OP.moveTo, x, y, true);
		return true;
	}
	tabletWheel(clicks) {
		if (!this.tabletOpen) return false;
		if (Math.round(clicks)) this.#queue(EVDEV_OP.tabletWheel, clicks, 0, true);
		return true;
	}
	releaseAll() {
		for (const c of [...this.#keys]) this.key(c, false);
		for (const b of [...this.#buttons]) this.button(b, false);
		for (const b of [...this.#tabletButtons]) this.tabletButton(b, false);
	}
	#queue(op, a, b, motion = false) {
		if (this.#shared) return this.#shared.evdev(op, a, b);
		this.#ops.push(op, a, b);
		if (!motion) this.#urgent = true;
		if (this.#urgent) {
			if (!this.#micro) {
				this.#micro = true;
				queueMicrotask(() => this.flush());
			}
		} else this.#timer ??= setTimeout(() => this.flush(), MOTION_BATCH_MS);
	}
	flush() {
		clearTimeout(this.#timer);
		this.#timer = void 0;
		this.#micro = false;
		this.#urgent = false;
		if (!this.#ops.length) return;
		const ops = this.#ops;
		this.#ops = [];
		this.#post({
			t: "evdev",
			ops
		});
	}
	close() {
		clearTimeout(this.#timer);
		this.#ops = [];
	}
};
var FrameClient = class {
	mode = null;
	#seq = 0;
	#post;
	#shared;
	#latest = null;
	#spare = [];
	#outstanding = 0;
	#nextId = 1;
	#waiters = /* @__PURE__ */ new Map();
	#closed = false;
	constructor(post, shared) {
		this.#post = post;
		this.#shared = shared;
	}
	get #viaShared() {
		return !!this.#shared?.frames.ready;
	}
	get seq() {
		return this.#viaShared ? this.#shared.frames.seq : this.#seq;
	}
	#want(now) {
		const id = this.#nextId++;
		const buf = this.#spare.pop();
		this.#outstanding++;
		this.#post(buf ? {
			t: "frame-want",
			id,
			buf,
			now
		} : {
			t: "frame-want",
			id,
			now
		}, buf ? [buf] : []);
		return id;
	}
	request() {
		if (this.#closed || !this.mode) return;
		if (this.#viaShared) return this.#shared.wantFrame();
		if (this.#outstanding >= FRAME_CREDITS) return;
		this.#want(false);
	}
	frame(out) {
		this.request();
		if (this.#viaShared) return this.mode ? this.#shared.frames.frame(out) : null;
		const f = this.#latest;
		if (!f || !this.mode) return null;
		return {
			width: f.mode.width,
			height: f.mode.height,
			data: xrgbToRgba(f.data, f.mode.width, f.mode.height, out)
		};
	}
	read(out) {
		if (this.#closed) return Promise.resolve(this.frame(out));
		if (this.#viaShared) {
			const id = this.#nextId++;
			return new Promise((resolve) => {
				this.#waiters.set(id, () => resolve(this.mode && this.#viaShared ? this.#shared.frames.frame(out) : null));
				this.#shared.wantFrameNow(id);
			});
		}
		return new Promise((resolve) => {
			this.#waiters.set(this.#want(true), () => resolve(this.#latest && this.mode ? this.frame(out) : null));
		});
	}
	adoptBuffer(buffer, cap) {
		this.#shared?.frames.adopt(buffer, cap);
	}
	ready(id) {
		for (const [w, resolve] of this.#waiters) {
			if (w > id) continue;
			this.#waiters.delete(w);
			resolve(true);
		}
	}
	setMode(mode) {
		this.mode = mode;
		if (!mode) this.#drop();
	}
	#drop() {
		if (this.#latest) {
			this.#keep(this.#latest.data.buffer);
			this.#latest = null;
		}
	}
	#keep(buf) {
		if (this.#spare.length < FRAME_CREDITS) this.#spare.push(buf);
	}
	receive(id, mode, data) {
		this.#outstanding = Math.max(0, this.#outstanding - 1);
		if (data && mode) {
			this.#drop();
			this.#latest = {
				mode,
				data
			};
			this.#seq++;
		} else if (!mode) this.#drop();
		const w = this.#waiters.get(id);
		this.#waiters.delete(id);
		w?.(true);
	}
	close() {
		this.#closed = true;
		for (const w of this.#waiters.values()) w(false);
		this.#waiters.clear();
	}
};
var SoundBridge = class {
	state = {
		open: false,
		playing: false,
		format: null
	};
	#sink;
	#post;
	#log;
	#lastReport = -1e400;
	#reader;
	#ring;
	#ringDelivered = false;
	#states = [];
	#arrived = 0;
	#dropped = 0;
	constructor(sink, post, log, ring) {
		this.#sink = sink;
		this.#post = post;
		this.#log = log;
		if (ring && sink.onRing) this.#ring = ring;
		else if (ring && sink.onChunk) this.#reader = new SoundRingReader(ring);
		if (ring) this.#dropped = new SoundRingReader(ring).droppedBytes();
	}
	get playing() {
		return this.state.playing;
	}
	startRing() {
		if (!this.#ring || this.#ringDelivered) return;
		this.#ringDelivered = true;
		try {
			this.#sink.onRing?.(this.#ring);
		} catch (e) {
			this.#log(`[sound] onRing failed: ${e}`);
		}
	}
	onWake() {
		const reader = this.#reader;
		if (!reader) return;
		for (;;) {
			const n = reader.nextEvent();
			if (n >= 0) {
				if (n > this.#arrived) break;
				this.#deliverStates(n);
				reader.readNext();
				continue;
			}
			const rec = reader.readNext();
			if (!rec) {
				this.#deliverStates(this.#arrived);
				break;
			}
			const chunk = {
				format: rec.format,
				data: rec.data,
				frames: Math.floor(rec.data.length / rec.format.frameBytes)
			};
			let queued = 0;
			try {
				queued = this.#sink.onChunk?.(chunk);
			} catch (e) {
				this.#log(`[sound] onChunk failed: ${e}`);
			}
			reader.setQueuedFrames(queued || 0);
		}
		this.#reportDrops(reader.droppedBytes());
	}
	#deliverStates(upTo) {
		while (this.#states.length && this.#states[0].n <= upTo) {
			const s = this.#states.shift();
			this.#deliver(s.state, s.event);
		}
	}
	#deliver(state, event) {
		this.state = state;
		if (event === "start") this.#lastReport = -1e400;
		try {
			this.#sink.onState?.(state, event);
		} catch (e) {
			this.#log(`[sound] onState failed: ${e}`);
		}
	}
	#reportDrops(dropped) {
		if (dropped === this.#dropped) return;
		this.#log(`[sound] the sound ring was full: ${dropped - this.#dropped >>> 0} bytes of PCM dropped`);
		this.#dropped = dropped;
	}
	onState(state, event, n) {
		this.startRing();
		if (this.#reader) {
			this.#states.push({
				n,
				state,
				event
			});
			this.#arrived = n;
			this.onWake();
			return;
		}
		if (this.#ring) this.#reportDrops(new SoundRingReader(this.#ring).droppedBytes());
		this.#deliver(state, event);
	}
	onChunk(seq, format, data) {
		const chunk = {
			format,
			data,
			frames: Math.floor(data.length / format.frameBytes)
		};
		let queued = 0;
		try {
			queued = this.#sink.onChunk?.(chunk);
		} catch (e) {
			this.#log(`[sound] onChunk failed: ${e}`);
		}
		const now = sharedNow();
		if (now - this.#lastReport < SOUND_REPORT_MS) return;
		this.#lastReport = now;
		this.#post({
			t: "sound-queued",
			seq,
			frames: Math.max(0, Math.round(queued || 0)),
			at: now
		});
	}
};
const BELL = 0;
const IDLE = 1;
const FRAME_WANT = 2;
const FRAME_NOW = 3;
const CON_HEAD = 4;
const CON_TAIL = 5;
const EV_HEAD = 6;
const EV_TAIL = 7;
const CON_SIZE = 8;
const SHM_HEAD = 9;
const SHM_TAIL = 10;
const VS_HEAD = 11;
const VS_TAIL = 12;
const VS_ACK = 13;
const CTL_BYTES = 64;
const CON_CAP = 65536;
const EV_CAP = 4096;
const SHM_CAP = 256;
const SHM_AT = 163904;
const VS_CAP = 1 << 19;
const VS_AT = 172096;
const CTL_SIZE = 696384;
const RETRY_MS = 2;
const F_STATE = 0;
const F_SLOT = 4;
const FRESH = 4;
const FRAME_DATA = 64;
function sharedMemoryAvailable() {
	if (typeof SharedArrayBuffer !== "function" || typeof Atomics !== "object") return false;
	if (globalThis.crossOriginIsolated === false) return false;
	if (typeof MessageChannel !== "function") return true;
	const ch = new MessageChannel();
	try {
		ch.port1.postMessage(new SharedArrayBuffer(8));
		return true;
	} catch {
		return false;
	} finally {
		ch.port1.close();
		ch.port2.close();
	}
}
function newSharedControl() {
	return new SharedArrayBuffer(CTL_SIZE);
}
var SharedOwner = class {
	#ctl;
	#con;
	#ev;
	#shm;
	#vs;
	#post;
	#vsSent = 0;
	#shmReads = /* @__PURE__ */ new Map();
	#shmSeq = 0;
	#conPending = [];
	#evPending = [];
	#vsPending = [];
	#retry;
	#closed = false;
	frames = new SharedFrames();
	constructor(buffer, post) {
		this.#ctl = new Int32Array(buffer, 0, CTL_BYTES / 4);
		this.#con = new Uint8Array(buffer, CTL_BYTES, CON_CAP);
		this.#ev = new Float64Array(buffer, 65600, EV_CAP * 3);
		this.#shm = new Float64Array(buffer, SHM_AT, SHM_CAP * 4);
		this.#vs = new Uint8Array(buffer, VS_AT, VS_CAP);
		this.#post = post;
	}
	shmRead(id, offset, length) {
		if (this.#closed) return null;
		const c = this.#ctl;
		const head = Atomics.load(c, SHM_HEAD);
		if ((head - Atomics.load(c, SHM_TAIL) | 0) >= SHM_CAP) return null;
		const seq = this.#shmSeq = this.#shmSeq % 2147483647 + 1;
		const at = (head & 255) * 4;
		this.#shm[at] = seq;
		this.#shm[at + 1] = id;
		this.#shm[at + 2] = offset;
		this.#shm[at + 3] = length;
		Atomics.store(c, SHM_HEAD, head + 1 | 0);
		const p = new Promise((resolve, reject) => this.#shmReads.set(seq, {
			resolve,
			reject
		}));
		this.#ring();
		return p;
	}
	shmAnswer(seq, data, error) {
		const r = this.#shmReads.get(seq);
		if (!r) return;
		this.#shmReads.delete(seq);
		if (data) r.resolve(data);
		else r.reject(error ?? /* @__PURE__ */ new Error("shm read failed"));
	}
	writeConsole(bytes) {
		if (this.#closed || !bytes.length) return;
		this.#conPending.push(bytes);
		this.#pump();
	}
	evdev(op, a, b) {
		if (this.#closed) return;
		this.#evPending.push(op, a, b);
		this.#pump();
	}
	vsock(packets) {
		if (this.#closed || !packets.length) return;
		const c = this.#ctl;
		if (!this.#vsPending.length && Atomics.load(c, VS_HEAD) === Atomics.load(c, VS_TAIL) && (this.#vsSent !== Atomics.load(c, VS_ACK) || Atomics.load(c, IDLE) !== 0)) {
			this.#vsSent = this.#vsSent + 1 | 0;
			this.#post({
				t: "vsock",
				packets
			}, packets.map((p) => p.buffer));
			return;
		}
		for (const p of packets) this.#vsPending.push(p);
		this.#pump();
	}
	resize(cols, rows) {
		if (this.#closed || !cols || !rows) return;
		Atomics.store(this.#ctl, CON_SIZE, Math.min(rows, 65535) << 16 | Math.min(cols, 65535));
		this.#ring();
	}
	wantFrame() {
		if (this.#closed || Atomics.load(this.#ctl, FRAME_WANT)) return;
		Atomics.store(this.#ctl, FRAME_WANT, 1);
		this.#ring();
	}
	wantFrameNow(id) {
		if (this.#closed) return;
		Atomics.store(this.#ctl, FRAME_NOW, id);
		this.#ring();
	}
	close(error) {
		this.#closed = true;
		clearTimeout(this.#retry);
		this.#conPending = [];
		this.#evPending = [];
		this.#vsPending = [];
		for (const r of this.#shmReads.values()) r.reject(error?.() ?? /* @__PURE__ */ new Error("the kernel exited"));
		this.#shmReads.clear();
	}
	#pump() {
		const c = this.#ctl;
		let wrote = false;
		if (this.#conPending.length) {
			let head = Atomics.load(c, CON_HEAD);
			const tail = Atomics.load(c, CON_TAIL);
			let free = CON_CAP - (head - tail | 0);
			while (this.#conPending.length && free > 0) {
				const chunk = this.#conPending[0];
				const n = Math.min(free, chunk.length);
				const at = head & 65535;
				const first = Math.min(n, CON_CAP - at);
				this.#con.set(chunk.subarray(0, first), at);
				if (n > first) this.#con.set(chunk.subarray(first, n), 0);
				head = head + n | 0;
				free -= n;
				if (n === chunk.length) this.#conPending.shift();
				else this.#conPending[0] = chunk.subarray(n);
				wrote = true;
			}
			Atomics.store(c, CON_HEAD, head);
		}
		if (this.#evPending.length) {
			let head = Atomics.load(c, EV_HEAD);
			const tail = Atomics.load(c, EV_TAIL);
			const free = EV_CAP - (head - tail | 0);
			const n = Math.min(free, this.#evPending.length / 3);
			const q = this.#evPending;
			for (let i = 0; i < n; i++) {
				const at = (head + i & 4095) * 3;
				this.#ev[at] = q[i * 3];
				this.#ev[at + 1] = q[i * 3 + 1];
				this.#ev[at + 2] = q[i * 3 + 2];
			}
			if (n) {
				head = head + n | 0;
				Atomics.store(c, EV_HEAD, head);
				q.splice(0, n * 3);
				wrote = true;
			}
		}
		if (this.#vsPending.length) {
			let head = Atomics.load(c, VS_HEAD);
			let free = VS_CAP - (head - Atomics.load(c, VS_TAIL) | 0);
			const q = this.#vsPending, ring = this.#vs;
			let n = 0;
			for (; n < q.length && 4 + q[n].length <= free; n++) {
				const p = q[n], len = p.length;
				for (let i = 0; i < 4; i++) ring[head + i & 524287] = len >>> i * 8 & 255;
				const at = head + 4 & 524287, first = Math.min(len, VS_CAP - at);
				ring.set(p.subarray(0, first), at);
				if (len > first) ring.set(p.subarray(first), 0);
				head = head + 4 + len | 0;
				free -= 4 + len;
			}
			if (n) {
				q.splice(0, n);
				Atomics.store(c, VS_HEAD, head);
				wrote = true;
			}
		}
		if (wrote) this.#ring();
		if ((this.#conPending.length || this.#evPending.length || this.#vsPending.length) && this.#retry === void 0) this.#retry = setTimeout(() => {
			this.#retry = void 0;
			if (!this.#closed) this.#pump();
		}, RETRY_MS);
	}
	#ring() {
		Atomics.add(this.#ctl, BELL, 1);
		if (Atomics.compareExchange(this.#ctl, IDLE, 1, 2) === 1) this.#post({ t: "kick" });
	}
};
var SharedFrames = class {
	#i32 = null;
	#buf = null;
	#cap = 0;
	#front = 0;
	#pinned = false;
	ready = false;
	adopt(buffer, cap) {
		this.ready = !!buffer;
		this.#buf = buffer;
		this.#i32 = buffer ? new Int32Array(buffer, 0, FRAME_DATA / 4) : null;
		this.#cap = cap;
		this.#front = 0;
		this.#pinned = false;
	}
	#acquire() {
		const h = this.#i32;
		if (!h || this.#pinned) return;
		this.#pinned = true;
		queueMicrotask(() => this.#pinned = false);
		if (Atomics.load(h, F_STATE) & FRESH) this.#front = Atomics.exchange(h, F_STATE, this.#front) & 3;
	}
	get seq() {
		this.#acquire();
		return this.#i32 ? Atomics.load(this.#i32, F_SLOT + this.#front * 4 + 2) : 0;
	}
	frame(out) {
		this.#acquire();
		const h = this.#i32;
		if (!h) return null;
		const s = F_SLOT + this.#front * 4;
		const width = h[s], height = h[s + 1];
		if (!width || !height) return null;
		return {
			width,
			height,
			data: xrgbToRgba(new Uint8Array(this.#buf, FRAME_DATA + this.#front * this.#cap, width * height * 4), width, height, out)
		};
	}
};
const STOP_GRACE_MS = 12e3;
const SPEC_HINT = "pass a spec instead: { kind: \"file\", path } on Node, { kind: \"data\", template: \"bundled\" } or { kind: \"http\", url } in browsers";
const NET_HINT = "pass a spec instead: { kind: \"net\", backend: { kind: \"direct\" } } on Node, or { kind: \"net\", backend: { kind: \"wisp\", servers } }";
const STATS_INTERVAL_MS = 500;
function checkWorkerOptions(platform, opts) {
	if (!platform.spawnWorker) throw new BootError("support", "createKernel({ worker: true }) is not supported on this platform");
	const objects = (opts.disks ?? []).map((d, i) => isDiskSpec(d) ? -1 : i).filter((i) => i >= 0);
	if (objects.length) throw new BootError("support", `createKernel({ worker: true }): disks[${objects.join("], disks[")}] ${objects.length > 1 ? "are BlockDevice objects, which" : "is a BlockDevice object, which"} cannot cross to the worker; ${SPEC_HINT}`);
	const d = opts.distro;
	if (d !== void 0 && typeof d !== "string" && !(d instanceof URL) && !isDiskSpec(d)) throw new BootError("support", `createKernel({ worker: true }): distro is a BlockDevice object, which cannot cross to the worker; pass its path or URL, or a spec ({ kind: "file", path } on Node, { kind: "http", url })`);
	if (opts.net && !isNetSpec(opts.net)) throw new BootError("support", `createKernel({ worker: true }): net is a NetDevice or NetBackend object, which cannot cross to the worker; ${NET_HINT}`);
	if (typeof opts.vsock === "object" && opts.vsock.raw) throw new BootError("support", "createKernel({ worker: true }): vsock.raw (the guest's packets in a callback) is inline only; use vm.vsock, which works in worker mode");
}
function toWorkerDisks(specs, platform) {
	const transfer = [];
	return [specs.map((s) => {
		if (s.kind === "data" && s.template instanceof Uint8Array) {
			const copy = s.template.slice();
			transfer.push(copy.buffer);
			return {
				...s,
				template: copy
			};
		}
		if (s.kind === "http" && !hasScheme(s.url)) {
			const url = platform.absoluteUrl?.(s.url);
			if (!url) throw new BootError("download", `cannot resolve the relative disk URL ${s.url} for the worker`);
			return {
				...s,
				url
			};
		}
		return { ...s };
	}), transfer];
}
function toWorkerRestore(s, transfer) {
	if (!s) return [void 0, []];
	const m = s.memory;
	if (!(m.buffer instanceof ArrayBuffer)) return [sentSnapshot(s), []];
	const whole = m.byteOffset === 0 && m.byteLength === m.buffer.byteLength;
	if (transfer && whole && m.byteLength < SHARED_SNAPSHOT_BYTES) return [sentSnapshot(s), [m.buffer]];
	const memory = newSnapshotMemory(m.byteLength);
	restoreSnapshotMemory(memory, m, 0);
	return [sentSnapshot({
		...s,
		memory
	}), snapshotTransfer(memory)];
}
function hasScheme(s) {
	return /^[a-z][a-z0-9+.-]+:/i.test(s);
}
async function toWorkerSource(src, platform, what, onProgress, signal) {
	if (src instanceof WebAssembly.Module) return [src, []];
	if (src instanceof URL) return [src.href, []];
	if (typeof src === "string") {
		if (hasScheme(src)) return [src, []];
		const abs = platform.absoluteUrl?.(src) ?? (typeof location === "object" && location?.href ? new URL(src, location.href).href : void 0);
		if (!abs) throw new BootError("download", `cannot resolve the relative ${what} location ${src} for the worker`);
		return [abs, []];
	}
	const copy = (src instanceof Response ? await loadBytes(src, {
		what,
		onProgress,
		signal
	}) : src instanceof ArrayBuffer ? new Uint8Array(src) : new Uint8Array(src.buffer, src.byteOffset, src.byteLength)).slice();
	return [copy, [copy.buffer]];
}
function displayNow(opt, log) {
	if (typeof opt !== "function") return opt ?? false;
	try {
		const s = opt();
		return {
			width: s.width,
			height: s.height,
			dpi: s.dpi
		};
	} catch (e) {
		log(`[display] size callback failed: ${e}`);
		return true;
	}
}
var WorkerKernel = class {
	cmdline = "";
	distro = void 0;
	memoryMiB = 0;
	memory64 = false;
	exited;
	started;
	#endpoint;
	#out = new ConsoleOutput();
	#input;
	#onOutput;
	#onProgress;
	#log;
	#stats;
	#statsAt = 0;
	#result;
	#isStarted = false;
	#resolveExit;
	#resolveStarted;
	#rejectStarted;
	#syncs = /* @__PURE__ */ new Map();
	#nextSync = 1;
	#disks = [];
	#skipped = [];
	#diskOps = /* @__PURE__ */ new Map();
	#onDiskError;
	#stopTimer;
	#displayOpt;
	#displaySize;
	#onDisplay;
	#onInput;
	#evdev;
	#frames;
	#sound;
	#soundState;
	#shared;
	#console;
	#encoder;
	#vsock;
	#vsockOut = [];
	#mounts;
	#commands;
	#gl;
	#vk;
	#va;
	#gpu;
	#shm;
	#shmCalls = /* @__PURE__ */ new Map();
	#nextShm = 1;
	#shmWrites = 0;
	#shmInPlace;
	#shmLocal;
	#profiles = /* @__PURE__ */ new Map();
	#nextProfile = 1;
	#profile;
	#snapshots = /* @__PURE__ */ new Map();
	constructor(endpoint, opts) {
		this.#endpoint = endpoint;
		this.#onDiskError = opts.onDiskError;
		this.#onOutput = opts.onOutput;
		this.#onProgress = opts.onProgress;
		this.#log = opts.log;
		this.#displayOpt = opts.display;
		this.#displaySize = JSON.stringify(displayNow(opts.display, opts.log));
		this.#onDisplay = opts.onDisplay;
		this.#onInput = opts.onInput;
		const post = (m, transfer) => {
			if (!this.#result) endpoint.post(m, transfer);
		};
		if (opts.shared) this.#shared = new SharedOwner(opts.shared, post);
		if (opts.console) {
			this.#console = new ConsoleRingReader(new ConsoleRing(opts.console), (b) => this.#emit(b.bytes));
			this.#console.start();
		}
		if (opts.display) {
			this.#evdev = new RemoteEvdev(post, this.#shared);
			this.#frames = new FrameClient(post, this.#shared);
		}
		const sound = opts.sound;
		if (sound) {
			this.#soundState = {
				open: false,
				playing: false,
				format: null
			};
			if (typeof sound === "object") this.#sound = new SoundBridge(sound, post, opts.log, opts.soundRing);
		}
		if (opts.vsock) {
			const flush = () => {
				const packets = this.#vsockOut;
				this.#vsockOut = [];
				if (!packets.length) return;
				if (this.#shared) this.#shared.vsock(packets);
				else post({
					t: "vsock",
					packets
				}, packets.map((p) => p.buffer));
			};
			this.#vsock = new VsockHost({
				send: (pkt) => {
					if (this.#vsockOut.push(pkt) === 1) queueMicrotask(flush);
				},
				bufferSize: typeof opts.vsock === "object" ? opts.vsock.bufferSize : void 0,
				log: opts.log
			});
		}
		this.#mounts = new MountTable(this.#vsock, opts.log);
		this.#commands = new CommandTable(this.#vsock, opts.log);
		if (opts.gpu) {
			const gpu = opts.gpu;
			this.#gpu = gpu;
			gpu.init.then((init) => post({
				t: "gpu-init",
				init
			}), (e) => post({
				t: "gpu-init",
				error: e?.message ?? String(e)
			}));
		}
		if (opts.shm) {
			const message = (call) => new Promise((resolve, reject) => {
				if (this.#result) {
					reject(new ShmError("ECONNABORTED", `${call.op}: the kernel exited`));
					return;
				}
				const rid = this.#nextShm++;
				this.#shmCalls.set(rid, {
					resolve,
					reject
				});
				post({
					t: "shm",
					rid,
					call
				});
			});
			const inPlace = () => this.#shmLocal;
			this.#shm = new ShmClient({
				run: (call) => {
					if (call.op === "read" && !this.#shmWrites && !this.#result) {
						const ring = this.#shared?.shmRead(call.id, call.offset, call.length);
						if (ring) return ring;
					}
					if (call.op !== "write") return message(call);
					this.#shmWrites++;
					const done = message(call);
					done.then(() => this.#shmWrites--, () => this.#shmWrites--);
					return done;
				},
				get local() {
					return inPlace();
				}
			});
		}
		this.exited = new Promise((r) => this.#resolveExit = r);
		this.started = new Promise((resolve, reject) => {
			this.#resolveStarted = resolve;
			this.#rejectStarted = reject;
		});
		endpoint.listen({
			message: (m) => this.#message(m),
			error: (e) => {
				const msg = errorText(e);
				this.#log(`[host] kernel worker error: ${msg}`);
				this.#finish({
					code: 255,
					reason: `kernel worker error: ${e?.message ?? e}`,
					kind: "fatal",
					error: e
				});
			},
			exit: () => this.#finish({
				code: 255,
				reason: "the kernel worker exited unexpectedly",
				kind: "fatal"
			})
		});
	}
	#message(m) {
		switch (m.t) {
			case "ready":
				this.#onProgress({
					stage: "worker",
					jspi: m.jspi
				});
				break;
			case "output":
				this.#emit(m.bytes);
				break;
			case "log":
				this.#log(m.msg);
				break;
			case "progress":
				this.#onProgress(m.p);
				break;
			case "started":
				this.cmdline = m.cmdline;
				this.distro = m.distro;
				this.memoryMiB = m.memoryMiB;
				this.memory64 = m.memory64;
				this.#setStats(m.stats);
				this.#disks = m.disks;
				this.#skipped = m.skipped;
				this.#isStarted = true;
				this.#sound?.startRing();
				this.#resolveStarted();
				break;
			case "boot-error":
				this.#rejectStarted(new BootError(m.stage, m.message));
				this.#finish({
					code: 1,
					reason: m.message,
					kind: "fatal"
				});
				break;
			case "stats":
				this.#setStats(m.stats);
				this.#disks = m.disks;
				break;
			case "disk-error": {
				const e = Object.assign(new Error(m.error.message), {
					name: m.error.name,
					stack: m.error.stack
				});
				try {
					this.#onDiskError?.(m.index, e);
				} catch {}
				break;
			}
			case "disk-result": {
				const op = this.#diskOps.get(m.id);
				this.#diskOps.delete(m.id);
				if (m.ok) op?.resolve(m.value);
				else op?.reject(new Error(m.error));
				break;
			}
			case "synced":
				this.#syncs.get(m.id)?.(m.ok);
				this.#syncs.delete(m.id);
				break;
			case "display":
				this.#frames?.setMode(m.mode);
				try {
					this.#onDisplay?.(m.mode);
				} catch {}
				break;
			case "input-state":
				this.#evdev?.setMask(m.mask);
				if (this.#evdev) try {
					this.#onInput?.(this.#evdev.state);
				} catch {}
				break;
			case "frame":
				this.#frames?.receive(m.id, m.mode, m.data);
				break;
			case "frame-buffer":
				this.#frames?.adoptBuffer(m.buffer, m.cap);
				break;
			case "frame-ready":
				this.#frames?.ready(m.id);
				break;
			case "sound-state":
				this.#soundState = m.state;
				this.#sound?.onState(m.state, m.event, m.n);
				break;
			case "sound-chunk":
				this.#sound?.onChunk(m.seq, m.format, m.data);
				break;
			case "sound-wake":
				this.#sound?.onWake();
				break;
			case "vsock":
				if (this.#vsock) for (const p of m.packets) this.#vsock.receive(p);
				break;
			case "vsock-ready":
				this.#vsock?.deviceReady(m.guestCid, m.rxMax);
				break;
			case "gpu": {
				const gpu = this.#gpu;
				if (!gpu) break;
				if (m.rid === void 0) {
					gpu.post(m.req);
					break;
				}
				const rid = m.rid;
				Promise.resolve(gpu.call(m.req)).then((reply) => {
					if (!this.#result) this.#endpoint.post({
						t: "gpu-reply",
						rid,
						reply
					}, reply.data ? [reply.data.buffer] : void 0);
				});
				break;
			}
			case "gpu-start":
				this.#gpu?.start();
				break;
			case "gpu-reset":
				this.#gpu?.reset();
				break;
			case "shm-result": {
				const c = this.#shmCalls.get(m.rid);
				if (!c) break;
				this.#shmCalls.delete(m.rid);
				if (m.ok && m.place) this.#shmInPlace?.set(m.value.id, m.place);
				if (m.ok) c.resolve(m.value);
				else c.reject(new ShmError(m.code, m.message));
				break;
			}
			case "shm-read":
				this.#shared?.shmAnswer(m.seq, m.ok ? m.data : null, m.ok ? null : new ShmError(m.code, m.message));
				break;
			case "shm-share":
				if (this.#shm && !this.#result) {
					const ip = this.#shmInPlace = new ShmInPlace(m.memory, m.table);
					this.#shmLocal = {
						ready: (id) => !this.#shmWrites && ip.ready(id),
						read: (id, offset, length, out) => ip.read(id, offset, length, out),
						write: (id, offset, data) => ip.write(id, offset, data),
						views: (id, offset, length) => ip.views(id, offset, length)
					};
				}
				break;
			case "shm-attach":
				this.#shm?.update(m.info);
				break;
			case "shm-detach":
				this.#shmInPlace?.drop(m.id);
				this.#shm?.detached(m.id);
				break;
			case "snapshot-held":
				this.#commitHeld(m.id, this.#withTtys(m.snapshot));
				break;
			case "snapshot-result": {
				const w = this.#snapshots.get(m.id);
				this.#snapshots.delete(m.id);
				if (!w) break;
				if (w.holding && !w.decided) w.holding.abort(/* @__PURE__ */ new Error("the kernel has ended"));
				if (m.ok) {
					const snap = m.snapshot ? this.#withTtys(m.snapshot) : w.held;
					if (snap) w.resolve(snap);
					else w.reject(/* @__PURE__ */ new Error("snapshot: the worker sent no snapshot"));
					break;
				}
				w.abort?.abort(new Error(m.error));
				w.reject(m.commitFailed ? new SnapshotCommitError(m.error, { timedOut: m.timedOut }) : new Error(m.error));
				break;
			}
			case "profile-result":
				this.#profiles.get(m.id)?.(m.report);
				this.#profiles.delete(m.id);
				break;
			case "exit":
				this.#setStats(m.stats);
				this.#disks = m.disks;
				this.#profile = m.profile;
				this.#finish(m.result);
		}
	}
	abandon(reason) {
		this.started.catch(() => {});
		this.#finish({
			code: 1,
			reason,
			kind: "fatal"
		});
	}
	#setStats(stats) {
		this.#stats = stats;
		this.#statsAt = performance.now();
	}
	#emit(bytes) {
		this.#onOutput?.(bytes);
		this.#out.emit(bytes);
	}
	#finish(res) {
		if (this.#result) return;
		const con = this.#console;
		if (con) {
			con.take();
			con.stop();
			con.ring.close();
		}
		this.#result = res;
		clearTimeout(this.#stopTimer);
		this.#evdev?.close();
		this.#frames?.close();
		this.#shared?.close(() => new ShmError("ECONNABORTED", "read: the kernel exited"));
		this.#shmInPlace?.close();
		this.#shmLocal = void 0;
		this.#gl?.shutdown();
		this.#vk?.shutdown();
		this.#va?.shutdown();
		this.#commands.shutdown();
		this.#mounts.shutdown();
		this.#vsock?.shutdown();
		for (const resolve of this.#profiles.values()) resolve(this.#profile);
		this.#profiles.clear();
		for (const c of this.#shmCalls.values()) c.reject(new ShmError("ECONNABORTED", "the kernel exited"));
		this.#shmCalls.clear();
		this.#shm?.shutdown();
		if (!this.#isStarted) this.#rejectStarted(new BootError("boot", res.reason, { cause: res.error }));
		this.#out.close();
		const persistent = this.#disks.some((d) => d.persistent);
		for (const resolve of this.#syncs.values()) resolve(!persistent);
		this.#syncs.clear();
		for (const op of this.#diskOps.values()) op.reject(/* @__PURE__ */ new Error(`the kernel worker has ended (${res.reason})`));
		this.#diskOps.clear();
		for (const w of this.#snapshots.values()) {
			if (w.committed && w.held) {
				w.holding?.abort(/* @__PURE__ */ new Error(`the kernel worker has ended (${res.reason})`));
				w.resolve(w.held);
				continue;
			}
			const why = `the kernel worker has ended (${res.reason})`;
			w.abort?.abort(new Error(why));
			w.reject(w.held ? new SnapshotCommitError(`snapshot: not committed (${why})`) : /* @__PURE__ */ new Error(`snapshot: ${why}`));
		}
		this.#snapshots.clear();
		this.#endpoint.terminate();
		this.#resolveExit(res);
	}
	get output() {
		return this.#out.stream;
	}
	onOutput(listener) {
		return this.#out.listen(listener);
	}
	write(data) {
		if (this.#result) return;
		if (typeof data !== "string" && !data.length) return;
		if (this.#shared) this.#shared.writeConsole(typeof data === "string" ? (this.#encoder ??= new TextEncoder()).encode(data) : data.slice());
		else this.#endpoint.post({
			t: "input",
			data
		});
	}
	get transport() {
		return this.#shared ? "shared" : "messages";
	}
	get input() {
		return this.#input ??= new WritableStream({ write: (chunk) => this.write(chunk) });
	}
	resize(cols, rows) {
		if (this.#result) return;
		if (this.#shared) this.#shared.resize(cols, rows);
		else this.#endpoint.post({
			t: "resize",
			cols,
			rows
		});
		if (typeof this.#displayOpt === "function") this.#sendDisplaySize(false);
	}
	updateDisplaySize(size) {
		if (this.#result || !this.#displayOpt) return;
		if (size) this.#displayOpt = {
			width: size.width,
			height: size.height,
			dpi: size.dpi
		};
		this.#sendDisplaySize(true);
	}
	#sendDisplaySize(hotplug) {
		const size = displayNow(this.#displayOpt, this.#log);
		if (typeof size !== "object") return;
		const key = JSON.stringify(size);
		if (key === this.#displaySize && !hotplug) return;
		this.#displaySize = key;
		this.#endpoint.post({
			t: "display-size",
			size,
			hotplug
		});
	}
	get bootDisplay() {
		return this.#displayOpt ? JSON.parse(this.#displaySize) : false;
	}
	get evdev() {
		return this.#evdev;
	}
	get display() {
		const f = this.#frames;
		return f ? { get mode() {
			return f.mode;
		} } : void 0;
	}
	frame(out) {
		if (this.#gpu?.scanout) return this.#gpu.frame(out);
		return this.#frames?.frame(out) ?? null;
	}
	requestFrame() {
		this.#frames?.request();
	}
	get frameSeq() {
		return this.#frames?.seq ?? 0;
	}
	readFrame(out) {
		if (this.#gpu?.scanout) return Promise.resolve(this.#gpu.frame(out));
		return this.#frames?.read(out) ?? Promise.resolve(null);
	}
	get vsock() {
		return this.#vsock;
	}
	spawn(file, args, opts) {
		return this.#mounts.gate(() => this.#commands.gate(() => spawnOn(this.#vsock, file, args, opts)));
	}
	attach(session, opts) {
		return attachOn(this.#vsock, session, opts);
	}
	#withTtys(received) {
		const snap = receivedSnapshot(received);
		const ttys = ttySessions(this.#vsock);
		if (ttys.length) snap.ttys = ttys;
		return snap;
	}
	exec(file, args, opts) {
		return this.#mounts.gate(() => this.#commands.gate(() => execOn(this.#vsock, file, args, opts)));
	}
	connect(port, opts) {
		return this.#mounts.gate(() => this.#commands.gate(() => connectOn(this.#vsock, port, opts)));
	}
	fetch(input, init) {
		return fetchOver((port, o) => this.connect(port, o), input, init);
	}
	mount(path, fs, opts) {
		return this.#mounts.mount(path, fs, opts);
	}
	get mounts() {
		return this.#mounts.mounts;
	}
	startMounts(list) {
		this.#mounts.mountAll(list);
	}
	addCommand(name, handler, opts) {
		return this.#commands.add(name, handler, opts);
	}
	removeCommand(name, opts) {
		return this.#commands.remove(name, opts);
	}
	get commands() {
		return this.#commands.commands;
	}
	startCommands(list) {
		this.#commands.addAll(list);
	}
	attachGl(gl) {
		this.#gl = gl;
		if (gl && this.#result) gl.shutdown();
	}
	get gl() {
		return this.#gl;
	}
	attachVk(vk) {
		this.#vk = vk;
		if (vk && this.#result) vk.shutdown();
	}
	get vk() {
		return this.#vk;
	}
	attachVa(va) {
		this.#va = va;
		if (va && this.#result) va.shutdown();
	}
	get va() {
		return this.#va;
	}
	get shm() {
		return this.#shm;
	}
	get sound() {
		const s = this.#soundState;
		return s ? {
			state: s,
			playing: s.playing
		} : void 0;
	}
	sync(opts = {}) {
		if (this.#result) return Promise.resolve(true);
		const id = this.#nextSync++;
		return new Promise((resolve) => {
			this.#syncs.set(id, resolve);
			this.#endpoint.post({
				t: "sync",
				id,
				timeout: opts.timeout
			});
		});
	}
	snapshot(opts = {}) {
		if (this.#result) return Promise.reject(/* @__PURE__ */ new Error(`snapshot: the kernel has exited (${this.#result.reason})`));
		const why = this.#mounts.snapshotBlocker();
		if (why) return Promise.reject(/* @__PURE__ */ new Error(`snapshot: ${why}`));
		const { commit, hold } = opts;
		if (commit !== void 0 && typeof commit !== "function") return Promise.reject(/* @__PURE__ */ new TypeError("snapshot: commit must be a function"));
		if (hold !== void 0 && (typeof hold !== "function" || !commit)) return Promise.reject(/* @__PURE__ */ new TypeError("snapshot: hold must be a function, and needs commit"));
		const id = this.#nextSync++;
		return new Promise((resolve, reject) => {
			this.#snapshots.set(id, {
				resolve,
				reject,
				commit,
				hold
			});
			const drop = opts.dropCaches === void 0 ? {} : { dropCaches: opts.dropCaches };
			this.#endpoint.post(commit ? {
				t: "snapshot",
				id,
				commit: true,
				commitTimeoutMs: opts.commitTimeoutMs,
				...hold ? { hold: true } : {},
				...drop
			} : {
				t: "snapshot",
				id,
				stop: opts.stop,
				...drop
			});
		});
	}
	#commitHeld(id, snap) {
		const w = this.#snapshots.get(id);
		if (!w?.commit) return;
		w.held = snap;
		const abort = w.abort = new AbortController();
		Promise.resolve().then(() => w.commit(snap, abort.signal)).then(() => {
			if (abort.signal.aborted || this.#result) return;
			w.committed = true;
			this.#endpoint.post({
				t: "snapshot-commit",
				id,
				ok: true
			});
			if (!w.hold) return;
			const holding = w.holding = new AbortController();
			Promise.resolve().then(() => w.hold(snap, holding.signal)).then((how) => how, (e) => {
				this.#log(`[host] snapshot: the hold failed (${e?.message ?? e}); stopping at the snapshot`);
				return "stop";
			}).then((how) => {
				w.decided = true;
				if (!this.#result && !holding.signal.aborted) this.#endpoint.post({
					t: "snapshot-release",
					id,
					stop: how !== "continue"
				});
			});
		}, (e) => {
			if (!this.#result) this.#endpoint.post({
				t: "snapshot-commit",
				id,
				ok: false,
				error: e?.message ?? String(e)
			});
		});
	}
	stop(res = {}) {
		if (!this.#result && this.#stopTimer === void 0) {
			this.#endpoint.post({
				t: "stop",
				code: res.code,
				reason: res.reason
			});
			this.#stopTimer = setTimeout(() => this.#finish({
				code: res.code ?? 0,
				reason: res.reason ?? "stopped by the host",
				kind: "stopped"
			}), STOP_GRACE_MS);
		}
		return this.exited;
	}
	get disks() {
		return this.#disks;
	}
	get skippedDisks() {
		return this.#skipped;
	}
	#diskOp(index, op) {
		if (this.#result) return Promise.reject(/* @__PURE__ */ new Error(`the kernel has exited (${this.#result.reason})`));
		const id = this.#nextSync++;
		return new Promise((resolve, reject) => {
			this.#diskOps.set(id, {
				resolve,
				reject
			});
			this.#endpoint.post({
				t: "disk",
				id,
				index,
				op
			});
		});
	}
	async detachDisk(index) {
		await this.#diskOp(index, "detach");
	}
	exportDisk(index) {
		return this.#diskOp(index, "export");
	}
	profile() {
		if (this.#result) return Promise.resolve(this.#profile);
		const id = this.#nextProfile++;
		return new Promise((resolve) => {
			this.#profiles.set(id, resolve);
			this.#endpoint.post({
				t: "profile",
				id
			});
		});
	}
	stats() {
		const s = this.#stats;
		const vsock = this.#vsock ? { ...this.#vsock.stats } : void 0;
		return {
			...s,
			vsock,
			shm: this.#shm?.stats,
			uptimeMs: this.#result || !s.uptimeMs ? s.uptimeMs : s.uptimeMs + performance.now() - this.#statsAt
		};
	}
};
async function createKernelInWorker(platform, opts, progress, gpu) {
	const { signal } = opts;
	const src = opts.kernel ?? platform.defaultKernel();
	const compileHere = !opts.compileInWorker && !(src instanceof WebAssembly.Module);
	const log = opts.log ?? ((m) => console.error(m));
	const canShare = opts.shared !== false && sharedMemoryAvailable();
	if (opts.shared === true && !canShare) throw new BootError("support", "createKernel({ worker: true, shared: true }): SharedArrayBuffer cannot be used here (a browser page must be cross-origin isolated: COOP same-origin and COEP require-corp)");
	const shared = canShare ? newSharedControl() : void 0;
	const consoleRing = shared && (opts.cpus ?? 1) > 1 ? newConsoleRing() : void 0;
	const soundObj = typeof opts.sound === "object" ? opts.sound : void 0;
	const soundRing = shared && soundObj && (soundObj.onChunk || soundObj.onRing) ? createSoundRing() : void 0;
	if (soundObj?.onRing && !soundObj.onChunk && !soundRing) log("[sound] onRing needs shared memory, and the sink has no onChunk: no PCM is delivered");
	const endpoint = platform.spawnWorker();
	const vm = new WorkerKernel(endpoint, {
		onOutput: opts.onOutput,
		onProgress: progress,
		log,
		onDiskError: opts.onDiskError,
		display: opts.display ?? (opts.gpu ? true : void 0),
		onDisplay: opts.onDisplay,
		onInput: opts.onInput,
		sound: opts.sound,
		soundRing,
		vsock: opts.vsock ?? true,
		shm: opts.shm,
		shared,
		console: consoleRing,
		gpu
	});
	let spec, transfer;
	try {
		let kernel, kernelTransfer = [], compileMs;
		if (compileHere) {
			const t0 = performance.now();
			progress({ stage: "compile" });
			kernel = await loadKernelModule(src, {
				what: "kernel",
				readFile: platform.readFile,
				onProgress: progress,
				signal,
				smp: (opts.cpus ?? 1) > 1
			});
			compileMs = performance.now() - t0;
			progress({
				stage: "compiled",
				ms: compileMs,
				memory64: moduleIsMemory64(kernel)
			});
		} else [kernel, kernelTransfer] = await toWorkerSource(src, platform, "kernel", progress, signal);
		const [initrd, initrdTransfer] = opts.initrd == null ? [opts.initrd, []] : await toWorkerSource(opts.initrd, platform, "initrd", progress, signal);
		if (initrd instanceof WebAssembly.Module) throw new BootError("download", "initrd: a WebAssembly.Module is not an initramfs");
		if (signal?.aborted) throw new BootError("download", "aborted", { cause: signal.reason });
		const [disks, diskTransfer] = toWorkerDisks(opts.disks ?? [], platform);
		const distro = opts.distro === void 0 ? void 0 : toWorkerDisks([typeof opts.distro === "string" || opts.distro instanceof URL ? distroSpecOf(opts.distro, platform.distroSpec) : readOnlySpec(opts.distro)], platform)[0][0];
		const [restore, restoreTransfer] = toWorkerRestore(opts.restore, !!opts.transferRestore);
		spec = {
			kernel,
			initrd,
			disks,
			distro,
			net: opts.net,
			cmdline: opts.cmdline,
			memoryMiB: opts.memoryMiB ?? platform.defaultMemoryMiB?.() ?? 2048,
			memoryFallbackMiB: opts.memoryFallbackMiB ?? platform.defaultMemoryFallbackMiB,
			memory64: opts.memory64,
			jit: opts.jit,
			cpus: opts.cpus,
			consoleSize: opts.consoleSize,
			statsIntervalMs: STATS_INTERVAL_MS,
			compileMs,
			display: vm.bootDisplay,
			sound: opts.sound ? {
				rate: soundObj?.rate,
				chunks: Boolean(soundObj?.onChunk && !(soundRing && soundObj?.onRing)),
				...soundRing && { ring: soundRing }
			} : false,
			vsock: !!(opts.vsock ?? true),
			shm: !!opts.shm,
			gpu: gpu ? "virgl" : !!opts.gpu,
			shared,
			console: consoleRing,
			restore,
			profile: opts.profile === true ? {} : opts.profile || void 0
		};
		transfer = [
			...kernelTransfer,
			...initrdTransfer,
			...diskTransfer,
			...restoreTransfer
		];
	} catch (e) {
		vm.abandon(e?.message ?? String(e));
		throw e;
	}
	if (signal) {
		const onAbort = () => endpoint.post({ t: "abort" });
		signal.addEventListener("abort", onAbort, { once: true });
		vm.exited.then(() => signal.removeEventListener("abort", onAbort));
	}
	try {
		endpoint.post({
			t: "boot",
			spec
		}, transfer);
	} catch (e) {
		if (!(compileHere && (typeof src === "string" || src instanceof URL || src instanceof ArrayBuffer || ArrayBuffer.isView(src)))) {
			vm.abandon(e?.message ?? String(e));
			throw new BootError("support", `cannot send the kernel to the worker: ${e?.message ?? e}`, { cause: e });
		}
		log(`[host] the compiled kernel could not be posted to the worker (${e?.message ?? e}); the worker loads it itself`);
		try {
			const [kernel, kernelTransfer] = await toWorkerSource(src, platform, "kernel", progress, signal);
			endpoint.post({
				t: "boot",
				spec: {
					...spec,
					kernel,
					compileMs: void 0
				}
			}, [...transfer, ...kernelTransfer]);
		} catch (e2) {
			vm.abandon(e2?.message ?? String(e2));
			throw e2;
		}
	}
	await vm.started;
	return vm;
}
function isBackend(n) {
	return typeof n.connect === "function" && typeof n.send !== "function";
}
var KernelInstance = class {
	kernel;
	module;
	cmdline;
	net;
	distro = void 0;
	skippedDisks = [];
	#owned = [];
	exited;
	#out;
	#input;
	#compileMs;
	#vsock;
	#shm;
	#mounts = new MountTable(void 0, () => {});
	#commands = new CommandTable(void 0, () => {});
	#gl;
	#vk;
	#va;
	constructor(kernel, module, cmdline, net, compileMs) {
		this.kernel = kernel;
		this.module = module;
		this.cmdline = cmdline;
		this.net = net;
		this.#compileMs = compileMs;
		this.#out = new ConsoleOutput(() => !!kernel.result);
		if (kernel.shm.enabled) this.#shm = inlineShm(kernel.shm);
		this.exited = kernel.exited.then((res) => {
			this.#gl?.shutdown();
			this.#vk?.shutdown();
			this.#va?.shutdown();
			this.#commands.shutdown();
			this.#mounts.shutdown();
			this.#vsock?.shutdown();
			this.#shm?.shutdown();
			this.#closeNet();
			this.#out.close();
			this.#closeDisks();
			return res;
		});
	}
	attachVsock(host) {
		this.#vsock = host;
		const mounts = this.#mounts = new MountTable(host, host.log);
		this.#commands = new CommandTable(host, host.log);
		this.kernel.vsock.onSave = () => mounts.save();
		this.kernel.vsock.hostBusy = () => mounts.snapshotBusy();
		this.kernel.onSnapshot = (snap) => {
			const ttys = ttySessions(host);
			if (ttys.length) snap.ttys = ttys;
		};
	}
	async restoreMounts(snap, list) {
		const { keep, rest } = await this.#mounts.restore(snap.devices?.vsock?.mounts, list);
		this.kernel.vsock.keep = keep;
		return rest;
	}
	startMounts(list) {
		this.#mounts.mountAll(list);
	}
	startCommands(list) {
		this.#commands.addAll(list);
	}
	attachGl(gl) {
		this.#gl = gl;
		if (gl && this.kernel.result) gl.shutdown();
	}
	get gl() {
		return this.#gl;
	}
	attachVk(vk) {
		this.#vk = vk;
		if (vk && this.kernel.result) vk.shutdown();
	}
	get vk() {
		return this.#vk;
	}
	attachVa(va) {
		this.#va = va;
		if (va && this.kernel.result) va.shutdown();
	}
	get va() {
		return this.#va;
	}
	#gate(fn) {
		return this.#mounts.gate(() => this.#commands.gate(fn));
	}
	get vsock() {
		return this.#vsock;
	}
	spawn(file, args, opts) {
		return this.#gate(() => spawnOn(this.#vsock, file, args, opts));
	}
	attach(session, opts) {
		return attachOn(this.#vsock, session, opts);
	}
	exec(file, args, opts) {
		return this.#gate(() => execOn(this.#vsock, file, args, opts));
	}
	connect(port, opts) {
		return this.#gate(() => connectOn(this.#vsock, port, opts));
	}
	fetch(input, init) {
		return fetchOver((port, o) => this.connect(port, o), input, init);
	}
	mount(path, fs, opts) {
		return this.#mounts.mount(path, fs, opts);
	}
	get mounts() {
		return this.#mounts.mounts;
	}
	addCommand(name, handler, opts) {
		return this.#commands.add(name, handler, opts);
	}
	removeCommand(name, opts) {
		return this.#commands.remove(name, opts);
	}
	get commands() {
		return this.#commands.commands;
	}
	get shm() {
		return this.#shm;
	}
	own(disks) {
		this.#owned.push(...disks);
	}
	async settled() {
		await Promise.all(this.kernel.block.disks.map((d) => d.saving?.catch(() => {})));
	}
	async #closeDisks() {
		await this.settled();
		for (const d of this.#owned) try {
			const c = d;
			if (typeof c.close === "function") c.close();
			else await c.store?.close?.();
		} catch {}
	}
	emit(bytes) {
		this.#out.emit(bytes);
	}
	get output() {
		return this.#out.stream;
	}
	onOutput(listener) {
		return this.#out.listen(listener);
	}
	write(data) {
		this.kernel.sendInput(data);
	}
	get input() {
		return this.#input ??= new WritableStream({ write: (chunk) => this.write(chunk) });
	}
	resize(cols, rows) {
		this.kernel.setConsoleSize(cols, rows);
	}
	sync(opts = {}) {
		return this.kernel.requestSync(opts);
	}
	snapshot(opts = {}) {
		const why = this.#mounts.snapshotBlocker(true);
		if (why) return Promise.reject(/* @__PURE__ */ new Error(`snapshot: ${why}`));
		return this.kernel.snapshot(opts);
	}
	stop(res = {}) {
		this.kernel.stop(res);
		return this.exited;
	}
	stats() {
		const k = this.kernel;
		return {
			...k.stats,
			uptimeMs: k.bootTime ? performance.now() - k.bootTime : 0,
			cpus: k.cpus,
			compileMs: this.#compileMs,
			block: { ...k.block.stats },
			jit: k.jitStatsAll(),
			jitCpus: k.cpus > 1 ? k.jitStatsPerCpu() : void 0,
			kwemu: k.jit.kwemuStats(),
			kwemuCpus: k.cpus > 1 ? k.kwemuStatsPerCpu() : void 0,
			net: this.net instanceof NetStack ? { ...this.net.stats } : void 0,
			display: k.display.enabled ? { ...k.display.stats } : void 0,
			evdev: k.evdev.enabled ? { ...k.evdev.stats } : void 0,
			sound: k.sound.enabled ? { ...k.sound.stats } : void 0,
			vsock: this.#vsock ? { ...this.#vsock.stats } : void 0,
			shm: this.#shm?.stats,
			gpu: k.gpu ? { ...k.gpu.stats } : void 0
		};
	}
	profile() {
		return Promise.resolve(this.kernel.profiler?.report());
	}
	get transport() {
		return "inline";
	}
	get sound() {
		return this.kernel.sound.enabled ? this.kernel.sound : void 0;
	}
	get memoryMiB() {
		return this.kernel.memory.buffer.byteLength / 1048576;
	}
	get memory64() {
		return this.kernel.memory64;
	}
	get display() {
		return this.kernel.display.enabled ? this.kernel.display : void 0;
	}
	updateDisplaySize(size) {
		const k = this.kernel;
		if (k.result || !k.display.enabled) return;
		if (size) k.display.setSize({
			width: size.width,
			height: size.height,
			dpi: size.dpi
		});
		k.gpu?.displayChanged();
	}
	get evdev() {
		return this.kernel.evdev.enabled ? this.kernel.evdev : void 0;
	}
	frame(out) {
		if (this.#gl?.gpu?.scanout) return this.#gl.gpu.frame(out);
		return this.kernel.display.enabled ? this.kernel.display.readRGBA(out) : null;
	}
	readFrame(out) {
		return Promise.resolve(this.frame(out));
	}
	#closeNet() {
		const n = this.net;
		try {
			n?.close?.();
			if (n instanceof NetStack) n.backend.close?.();
		} catch {}
	}
};
async function createKernelOn(platform, opts = {}) {
	if (typeof WebAssembly !== "object" || typeof WebAssembly.Suspending !== "function" || typeof WebAssembly.promising !== "function") throw new BootError("support", "This engine has no JSPI (WebAssembly.Suspending / WebAssembly.promising), which the kernel needs");
	const restoring = opts.restore;
	if (restoring) {
		if (opts.cpus === void 0) opts = {
			...opts,
			cpus: restoring.cpus ?? 1
		};
		const why = snapshotCpuMismatch(restoring, Math.max(1, Math.floor(opts.cpus ?? 1)));
		if (why) throw new BootError("boot", `snapshot: ${why}`);
	}
	const { signal, onProgress } = opts;
	const progress = (p) => {
		try {
			onProgress?.(p);
		} catch {}
	};
	const vopt = opts.vsock ?? true;
	const raw = typeof vopt === "object" ? vopt.raw : void 0;
	const mounts = parseMounts(opts.mounts, !!vopt && !raw);
	const commands = parseCommands(opts.commands, !!vopt && !raw);
	const savedMounts = opts.restore?.devices?.vsock?.mounts;
	if (savedMounts?.mounts.length && (opts.worker || raw)) throw new BootError("boot", `snapshot: it has host file systems (${savedMounts.mounts.map((m) => m.path).join(", ")}), which resume inline only (not in worker mode or with vsock.raw)`);
	const mountsWhy = opts.restore && snapshotMountMismatch(savedMounts, mounts);
	if (mountsWhy) throw new BootError("boot", `snapshot: ${mountsWhy}`);
	const glPrep = prepareGl(opts.gl, !!opts.gpu, !!vopt && !raw, platform.glModule?.(), opts.log ?? ((m) => console.error(m)), !!opts.restore);
	const vkPrep = prepareVk(opts.vk, !!vopt && !raw, platform.vk?.(), opts.log ?? ((m) => console.error(m)));
	const vaPrep = prepareVa(opts.va, !!vopt && !raw, opts.log ?? ((m) => console.error(m)));
	if (opts.worker) {
		checkWorkerOptions(platform, opts);
		const vm = await createKernelInWorker(platform, opts, progress, glPrep?.gpu);
		vm.startMounts(mounts);
		vm.startCommands(commands);
		vm.attachGl(startGl(glPrep, vm.vsock, opts.log ?? ((m) => console.error(m))));
		vm.attachVk(startVk(vkPrep, vm.vsock, opts.log ?? ((m) => console.error(m))));
		vm.attachVa(startVa(vaPrep, vm.vsock, opts.log ?? ((m) => console.error(m)), glPrep?.gpu));
		return vm;
	}
	const loadOpts = {
		signal,
		readFile: platform.readFile,
		onProgress: progress
	};
	const t0 = performance.now();
	const kernelSource = opts.kernel ?? platform.defaultKernel();
	if (!(kernelSource instanceof WebAssembly.Module)) progress({ stage: "compile" });
	const [module, initrdBytes] = await Promise.all([loadKernelModule(kernelSource, {
		...loadOpts,
		what: "kernel",
		smp: (opts.cpus ?? 1) > 1
	}), opts.initrd == null ? opts.initrd : loadBytes(opts.initrd, {
		...loadOpts,
		what: "initrd"
	})]);
	const compileMs = kernelSource instanceof WebAssembly.Module ? 0 : performance.now() - t0;
	if (!(kernelSource instanceof WebAssembly.Module)) progress({
		stage: "compiled",
		ms: compileMs,
		memory64: moduleIsMemory64(module)
	});
	if (signal?.aborted) throw new BootError("download", "aborted", { cause: signal.reason });
	const bundled = bundledBoot(module);
	const initrd = initrdBytes === void 0 ? bundled.initrd ?? null : initrdBytes;
	const log = opts.log ?? ((m) => console.error(m));
	const devCtx = {
		module,
		log,
		onDiskError: (i, e) => {
			try {
				opts.onDiskError?.(i, e);
			} catch {}
		}
	};
	if (opts.distro !== void 0 && !initrd && opts.cmdline === void 0 && !opts.restore) throw new BootError("boot", "distro: the kernel has no initramfs to mount it (use the bundled kernel, unkernel.wasm, or pass initrd or cmdline)");
	const distro = opts.distro === void 0 ? void 0 : await openDistro(opts.distro, platform.devices, devCtx, platform.distroSpec);
	const items = opts.disks ?? [];
	let built;
	try {
		built = await buildDisks(items, platform.devices, devCtx);
	} catch (e) {
		if (distro?.owned) distro.disk.close();
		throw e;
	}
	const { skipped } = built;
	const owned = built.disks.filter((d) => !items.includes(d));
	if (distro?.owned) owned.push(distro.disk);
	const disks = distro ? [distro.disk, ...built.disks] : built.disks;
	const cmdline = opts.cmdline ?? (initrdBytes === void 0 && bundled.initrd && bundled.cmdline ? bundled.cmdline : disks.length && !initrd ? "console=hvc0 root=/dev/wda rw" : "console=hvc0 rdinit=/init");
	const net = !opts.net ? void 0 : isNetSpec(opts.net) ? buildNet(opts.net, platform.devices, devCtx) : isBackend(opts.net) ? new NetStack({
		backend: opts.net,
		log: opts.log
	}) : opts.net;
	let kernelRef;
	const vsock = vopt && !raw ? new VsockHost({
		send: (pkt) => kernelRef?.vsock.deliver(pkt),
		bufferSize: typeof vopt === "object" ? vopt.bufferSize : void 0,
		log
	}) : void 0;
	let instance;
	let started;
	const startedP = new Promise((r) => started = r);
	const kernel = new Kernel({
		module,
		initrd,
		cmdline,
		disks,
		net,
		memoryMiB: opts.memoryMiB ?? platform.defaultMemoryMiB?.() ?? 2048,
		memoryFallbackMiB: opts.memoryFallbackMiB ?? platform.defaultMemoryFallbackMiB,
		memory64: opts.memory64,
		jit: opts.jit,
		cpus: opts.cpus,
		spawnCpu: platform.spawnCpu,
		whyNoCpus: platform.whyNoCpus,
		consoleRing: opts.consoleRing,
		flushOutput: opts.flushOutput,
		profile: opts.profile === true ? {} : opts.profile || void 0,
		spawnSampler: platform.spawnSampler,
		restore: opts.restore,
		display: opts.display ?? (opts.gpu ? true : void 0),
		onDisplay: opts.onDisplay,
		onInput: opts.onInput,
		sound: opts.sound,
		gpu: !!opts.gpu,
		gpuBackend: opts.gpuBackend ?? (glPrep?.gpu && new VirglGpuBackend(inlineGpuLink(glPrep.gpu), log)),
		vsock: !!vopt,
		onVsockPacket: raw ? raw.onPacket : vsock && ((pkt) => vsock.receive(pkt)),
		onVsockInit: raw ? raw.onInit : vsock && ((cid, rxMax) => vsock.deviceReady(cid, rxMax)),
		shm: !!opts.shm,
		log: opts.log,
		write: (bytes) => {
			opts.onOutput?.(bytes);
			instance?.emit(bytes);
		},
		onStage: (stage, detail) => {
			if (stage === "memory") progress({
				stage,
				...detail
			});
			else if (stage === "instantiate") progress({ stage });
			else if (stage === "start") {
				progress({
					stage,
					cmdline
				});
				started();
			}
		}
	});
	kernelRef = kernel;
	instance = new KernelInstance(kernel, module, cmdline, net, compileMs);
	if (vsock) instance.attachVsock(vsock);
	instance.skippedDisks = skipped;
	instance.distro = distro?.disk.info;
	instance.own(owned);
	if (opts.consoleSize) kernel.setConsoleSize(opts.consoleSize.cols, opts.consoleSize.rows);
	let rest = mounts;
	if (opts.restore && vsock) try {
		rest = await instance.restoreMounts(opts.restore, mounts);
	} catch (e) {
		instance.stop({
			code: 1,
			reason: e.message
		});
		throw new BootError("boot", `snapshot: host file systems: ${e.message}`, { cause: e });
	}
	const booting = kernel.boot();
	try {
		await Promise.race([startedP, booting]);
	} catch (e) {
		const err = e;
		instance.stop({
			code: 1,
			reason: err.message
		});
		throw new BootError(err.name === "MemoryAllocationError" ? "memory" : "boot", err.message, { cause: e });
	}
	booting.catch(() => {});
	if (opts.restore) kernel.gpu?.displayChanged(true);
	instance.startMounts(rest);
	instance.startCommands(commands);
	instance.attachGl(startGl(glPrep, vsock, log));
	instance.attachVk(startVk(vkPrep, vsock, log));
	instance.attachVa(startVa(vaPrep, vsock, log, glPrep?.gpu));
	if (signal) {
		const onAbort = () => instance.stop({
			code: 130,
			reason: "aborted"
		});
		if (signal.aborted) onAbort();
		else {
			signal.addEventListener("abort", onAbort, { once: true });
			instance.exited.then(() => signal.removeEventListener("abort", onAbort));
		}
	}
	return instance;
}
const KSTAMP = /^\[ *(\d+\.\d+)\]/;
const KMAYBE = /^\[ *(\d+(\.\d*)?)?$/;
const IMPORTANT = /Kernel panic|Oops|BUG:|WARNING:|Out of memory|Killed process|segfault|unhandled signal|soft lockup|blocked for more than/;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;
var ConsoleRouter = class {
	userspace = false;
	#opts;
	#dec = new TextDecoder();
	#gate = "start";
	#hold = "";
	#kline = "";
	#holdTimer;
	#dmesgBlock = false;
	#lastKTime = -1;
	#seen = /* @__PURE__ */ new Set();
	#seenOrder = [];
	#userTail = "";
	constructor(opts = {}) {
		this.#opts = opts;
	}
	write(data) {
		this.#route(typeof data === "string" ? data : this.#dec.decode(data, { stream: true }));
	}
	flush() {
		clearTimeout(this.#holdTimer);
		this.#releaseHold();
	}
	#releaseHold() {
		if (this.#gate === "start" && this.#hold) {
			this.#gate = "user";
			this.#dmesgBlock = false;
			const h = this.#hold;
			this.#hold = "";
			this.#userOutput(h);
		}
	}
	#markUserspace(why) {
		if (this.userspace) return;
		this.userspace = true;
		this.#opts.onUserspace?.(why);
	}
	#userOutput(text) {
		this.#opts.onUserOutput?.(text);
		if (this.userspace) return;
		this.#userTail += text;
		let i;
		while (!this.userspace && (i = this.#userTail.indexOf("\n")) >= 0) {
			const line = this.#userTail.slice(0, i).replace(ANSI, "").replace(/\r/g, "");
			this.#userTail = this.#userTail.slice(i + 1);
			if (line.trim()) this.#markUserspace(`first output: ${line.trim().slice(0, 60)}`);
		}
		if (this.userspace) {
			this.#userTail = "";
			return;
		}
		if (this.#userTail.length > 8192) this.#userTail = this.#userTail.slice(-1024);
		if (/[#$%>] ?$/.test(this.#userTail.replace(ANSI, ""))) this.#markUserspace("shell prompt");
	}
	#kernelLine(raw) {
		const line = raw.replace(/\r/g, "").replace(/\n$/, "");
		const t = Number(KSTAMP.exec(line)[1]);
		if (this.#dmesgBlock || t < this.#lastKTime || this.#seen.has(line)) {
			this.#dmesgBlock = true;
			this.#userOutput(raw);
			return;
		}
		this.#lastKTime = t;
		this.#seen.add(line);
		if (this.#seenOrder.push(line) > 4096) this.#seen.delete(this.#seenOrder.shift());
		this.#opts.onKernelLine?.(line, {
			time: t,
			important: IMPORTANT.test(line),
			raw
		});
	}
	#route(s) {
		clearTimeout(this.#holdTimer);
		while (s) {
			if (this.#gate === "start") {
				s = this.#hold + s;
				this.#hold = "";
				if (KSTAMP.test(s)) this.#gate = "kern";
				else if (KMAYBE.test(s)) {
					this.#hold = s;
					this.#holdTimer = setTimeout(() => this.#releaseHold(), this.#opts.holdMs ?? 250);
					return;
				} else {
					this.#gate = "user";
					this.#dmesgBlock = false;
				}
			}
			const i = s.indexOf("\n");
			const part = i < 0 ? s : s.slice(0, i + 1);
			s = i < 0 ? "" : s.slice(i + 1);
			if (this.#gate === "user") this.#userOutput(part);
			else if (this.#kline.length < 8192) this.#kline += part;
			if (i >= 0) {
				if (this.#gate === "kern") this.#kernelLine(this.#kline);
				this.#kline = "";
				this.#gate = "start";
			}
		}
	}
};
const JSPI_TEST = new Uint8Array([
	0,
	97,
	115,
	109,
	1,
	0,
	0,
	0,
	1,
	5,
	1,
	96,
	0,
	1,
	127,
	2,
	7,
	1,
	1,
	109,
	1,
	102,
	0,
	0,
	3,
	2,
	1,
	0,
	7,
	5,
	1,
	1,
	103,
	0,
	1,
	10,
	6,
	1,
	4,
	0,
	16,
	0,
	11
]);
const MEMORY64_TEST = new Uint8Array([
	0,
	97,
	115,
	109,
	1,
	0,
	0,
	0,
	5,
	3,
	1,
	4,
	0
]);
async function checkJspi(timeoutMs = 5e3) {
	const missing = [];
	if (typeof WebAssembly.Suspending !== "function") missing.push("WebAssembly.Suspending");
	if (typeof WebAssembly.promising !== "function") missing.push("WebAssembly.promising");
	if (missing.length) return {
		ok: false,
		why: `${missing.join(" and ")} not defined (no JSPI)`
	};
	try {
		const f = new WebAssembly.Suspending(() => new Promise((r) => setTimeout(() => r(42), 0)));
		const inst = new WebAssembly.Instance(new WebAssembly.Module(JSPI_TEST), { m: { f } });
		const g = WebAssembly.promising(inst.exports.g);
		let timer;
		const result = await Promise.race([g().then((v) => v === 42 ? { ok: true } : {
			ok: false,
			why: `JSPI test returned ${v}`
		}, (e) => ({
			ok: false,
			why: `JSPI test threw: ${e.message}`
		})), new Promise((r) => {
			timer = setTimeout(() => r({
				ok: false,
				why: `JSPI test did not resume within ${timeoutMs / 1e3} s`
			}), timeoutMs);
		})]);
		clearTimeout(timer);
		return result;
	} catch (e) {
		return {
			ok: false,
			why: `JSPI present but unusable: ${e.message}`
		};
	}
}
async function checkSupport() {
	const problems = [];
	const wasm = typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
	if (!wasm) problems.push("WebAssembly is unavailable");
	const bigint = typeof BigInt === "function";
	if (!bigint) problems.push("BigInt is required for 64-bit WebAssembly values");
	let jspi = false;
	if (wasm) {
		const j = await checkJspi();
		jspi = j.ok;
		if (!j.ok) problems.push(j.why);
	}
	let memory64 = false;
	try {
		memory64 = wasm && WebAssembly.validate(MEMORY64_TEST);
	} catch {}
	return {
		ok: !problems.length,
		wasm,
		bigint,
		jspi,
		memory64,
		problems
	};
}
const WASI_MODULES = ["wasi_snapshot_preview1", "wasi_unstable"];
const WASI_THREAD_SPAWN = {
	module: "wasi",
	name: "thread-spawn"
};
const WASI_MEMORY = {
	module: "env",
	name: "memory"
};
const CH_INITIAL = 262208;
const CH_MAX = 67108936;
function channelRoom(sab, bytes) {
	const need = 64 + bytes;
	if (need > 67108936) return false;
	if (sab.byteLength < need) {
		let size = sab.byteLength;
		while (size < need) size *= 2;
		sab.grow(Math.min(size, CH_MAX));
	}
	return true;
}
Atomics.pause;
const originNs = BigInt(Math.round(performance.timeOrigin * 1e6));
function hostClockNs() {
	return originNs + BigInt(Math.round(performance.now() * 1e6));
}
(() => {
	const p = globalThis.process;
	const f = p?.threadCpuUsage;
	if (typeof f !== "function") return void 0;
	try {
		f.call(p);
	} catch {
		return;
	}
	return () => {
		const u = f.call(p);
		return u.user + u.system;
	};
})();
var Enc = class {
	#buf = /* @__PURE__ */ new Uint8Array(64);
	#dv = new DataView(this.#buf.buffer);
	#len = 8;
	#grow(n) {
		if (this.#len + n <= this.#buf.length) return;
		let cap = this.#buf.length * 2;
		while (cap < this.#len + n) cap *= 2;
		const b = new Uint8Array(cap);
		b.set(this.#buf.subarray(0, this.#len));
		this.#buf = b;
		this.#dv = new DataView(b.buffer);
	}
	u32(v) {
		this.#grow(4);
		this.#dv.setUint32(this.#len, v >>> 0, true);
		this.#len += 4;
		return this;
	}
	u64(v) {
		this.#grow(8);
		this.#dv.setBigUint64(this.#len, BigInt.asUintN(64, v), true);
		this.#len += 8;
		return this;
	}
	bytes(b) {
		this.#grow(b.length);
		this.#buf.set(b, this.#len);
		this.#len += b.length;
		return this;
	}
	str(b) {
		return this.u32(b.length).bytes(b);
	}
	frame(op, more = 0) {
		this.#dv.setUint32(0, op, true);
		this.#dv.setUint32(4, this.#len - 8 + more, true);
		return this.#buf.subarray(0, this.#len);
	}
};
const WASI_EXEC_PORT = 1021;
function wasiSharedChannelAvailable() {
	return sharedMemoryAvailable() && typeof Atomics.waitAsync === "function" && typeof SharedArrayBuffer.prototype.grow === "function";
}
var ByteReader = class {
	#reader;
	#chunks = [];
	#have = 0;
	constructor(stream) {
		this.#reader = stream.getReader();
	}
	async exact(n) {
		if (!await this.#fill(n)) return null;
		const c = this.#chunks[0];
		if (c.length === n) {
			this.#chunks.shift();
			this.#have -= n;
			return c;
		}
		const out = new Uint8Array(n);
		this.#take(out);
		return out;
	}
	async into(out) {
		if (!await this.#fill(out.length)) return false;
		this.#take(out);
		return true;
	}
	async #fill(n) {
		while (this.#have < n) {
			let r;
			try {
				r = await this.#reader.read();
			} catch {
				return false;
			}
			if (r.done) return false;
			this.#chunks.push(r.value);
			this.#have += r.value.length;
		}
		return true;
	}
	#take(out) {
		const n = out.length;
		let at = 0;
		while (at < n) {
			const c = this.#chunks[0];
			const take = Math.min(c.length, n - at);
			out.set(c.subarray(0, take), at);
			at += take;
			if (take === c.length) this.#chunks.shift();
			else this.#chunks[0] = c.subarray(take);
		}
		this.#have -= n;
	}
	cancel() {
		this.#reader.cancel().catch(() => {});
	}
};
const utf8 = new TextEncoder();
const utf8d = new TextDecoder();
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
function serveWasiProgramsWith(vsock, opts) {
	const port = opts.port ?? 1021;
	const log = opts.log ?? (() => {});
	const maxModule = opts.maxModuleBytes ?? 256 << 20;
	const stats = {
		started: 0,
		running: 0,
		threads: 0,
		failed: 0,
		requests: 0,
		received: 0,
		cached: 0,
		workers: 0,
		idle: 0,
		channels: 0
	};
	const cache = new ModuleCache(opts.moduleCache?.count ?? 16, opts.moduleCache?.bytes ?? 512 << 20, stats);
	const pool = new WorkerPool(opts.spawn, opts.idleWorkers ?? 2, stats);
	const shared = opts.sharedMemory ?? wasiSharedChannelAvailable();
	const ctx = {
		log,
		maxModule,
		stats,
		cache,
		pool,
		shared,
		programs: /* @__PURE__ */ new Map()
	};
	const listener = vsock.listen(port, (conn) => {
		accept(conn, ctx).catch((e) => log(`[wasi] ${errorText(e)}`));
	});
	return {
		port,
		shared,
		stats,
		close: () => {
			listener.close();
			pool.close();
		}
	};
}
const CLOCK_BEST_NS = 10000000000n;
function programClock(ctx, real, mono, host) {
	const sample = mono - host, best = ctx.clockBest;
	let offset = sample;
	if (best && host - best.at < CLOCK_BEST_NS && best.offset > sample) offset = best.offset;
	else ctx.clockBest = {
		offset,
		at: host
	};
	return {
		mono: offset,
		real: offset + real - mono,
		start: host
	};
}
function importedMemory(b) {
	let at = 8;
	const byte = () => {
		if (at >= b.length) throw new RangeError("truncated module");
		return b[at++];
	};
	const leb = () => {
		let v = 0;
		for (let shift = 0;; shift += 7) {
			const c = byte();
			v += (c & 127) * 2 ** shift;
			if (!(c & 128)) return v;
		}
	};
	const name = () => {
		const n = leb();
		const s = utf8d.decode(b.subarray(at, at + n));
		at += n;
		return s;
	};
	const valtype = () => {
		const t = byte();
		if (t === 99 || t === 100) leb();
	};
	while (at < b.length) {
		const id = byte(), size = leb(), end = at + size;
		if (id > 5) return void 0;
		if (id === 5) {
			if (leb() > 0 && byte() & 4) return {
				initial: 0,
				shared: false,
				memory64: true,
				own: true
			};
			return;
		}
		if (id === 2) for (let n = leb(); n > 0; n--) {
			const mod = name(), field = name(), kind = byte();
			if (kind === 0) leb();
			else if (kind === 1 || kind === 2) {
				if (kind === 1) valtype();
				const flags = byte(), initial = leb(), maximum = flags & 1 ? leb() : void 0;
				if (kind === 2 && mod === WASI_MEMORY.module && field === WASI_MEMORY.name) return {
					initial,
					maximum,
					shared: (flags & 2) !== 0,
					memory64: (flags & 4) !== 0
				};
			} else if (kind === 3) {
				valtype();
				byte();
			} else if (kind === 4) {
				byte();
				leb();
			} else return;
		}
		at = end;
	}
}
var ModuleCache = class ModuleCache {
	#modules = /* @__PURE__ */ new Map();
	#bytes = 0;
	#ids = /* @__PURE__ */ new Map();
	#count;
	#limit;
	#stats;
	#serial = 0;
	static ID_LIMIT = 256;
	constructor(count, bytes, stats) {
		this.#count = Math.max(1, count);
		this.#limit = bytes;
		this.#stats = stats;
	}
	async acquire(id) {
		for (;;) {
			const p = this.#ids.get(id);
			if (!p) {
				let done;
				const mine = new Promise((r) => done = r);
				this.#ids.set(id, mine);
				while (this.#ids.size > ModuleCache.ID_LIMIT) this.#ids.delete(this.#ids.keys().next().value);
				let claimed = false;
				return { claim: (key) => {
					if (claimed) return;
					claimed = true;
					if (!key && this.#ids.get(id) === mine) this.#ids.delete(id);
					done(key);
				} };
			}
			this.#ids.delete(id);
			this.#ids.set(id, p);
			const key = await p;
			const e = key ? this.#touch(key) : void 0;
			const module = e && await e.module.catch(() => void 0);
			if (module) return { module };
			if (this.#ids.get(id) === p) this.#ids.delete(id);
		}
	}
	#touch(key) {
		const e = this.#modules.get(key);
		if (e) {
			this.#modules.delete(key);
			this.#modules.set(key, e);
		}
		return e;
	}
	async compile(bytes) {
		const subtle = globalThis.crypto?.subtle;
		const key = subtle ? Array.from(new Uint8Array(await subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("") : `#${++this.#serial}`;
		const had = this.#touch(key);
		if (had) return {
			key,
			module: had.module
		};
		let memory;
		try {
			memory = importedMemory(bytes);
		} catch {}
		const e = {
			module: WebAssembly.compile(bytes).then((module) => ({
				module,
				memory
			})),
			bytes: bytes.length
		};
		e.module.catch(() => {
			if (this.#modules.get(key) === e) this.#drop(key);
		});
		this.#modules.set(key, e);
		this.#bytes += e.bytes;
		while (this.#modules.size > 1 && (this.#modules.size > this.#count || this.#bytes > this.#limit)) this.#drop(this.#modules.keys().next().value);
		this.#stats.cached = this.#modules.size;
		return {
			key,
			module: e.module
		};
	}
	#drop(key) {
		const e = this.#modules.get(key);
		if (!e) return;
		this.#modules.delete(key);
		this.#bytes -= e.bytes;
		this.#stats.cached = this.#modules.size;
	}
};
const MAX_FRAME = 64 << 20;
const MAX_DATA = 262144;
const IDENTITY = 40;
async function receiveModule(reader, size, identity) {
	const bytes = new Uint8Array(size);
	for (let at = 0;;) {
		const h = await reader.exact(8);
		if (!h) return null;
		const hv = view(h);
		const op = hv.getUint32(0, true), len = hv.getUint32(4, true);
		if (at < size) {
			if (op !== 5 || len === 0 || len > MAX_DATA || len > size - at) return null;
			if (!await reader.into(bytes.subarray(at, at + len))) return null;
			at += len;
			continue;
		}
		if (op !== 6 || len !== 48) return null;
		const end = await reader.exact(48);
		if (!end) return null;
		return {
			bytes,
			same: identity.every((b, i) => b === end[i])
		};
	}
}
async function accept(conn, ctx) {
	const reader = new ByteReader(conn.readable);
	const head = await reader.exact(8);
	if (!head) return conn.reset();
	const hv = view(head);
	const op = hv.getUint32(0, true);
	const len = hv.getUint32(4, true);
	if (op !== 1 && op !== 7 || len > MAX_FRAME) {
		ctx.log(`[wasi] bad first frame (op ${op}, ${len} bytes)`);
		return conn.reset();
	}
	const payload = await reader.exact(len);
	if (!payload) return conn.reset();
	return op === 1 ? runProgram(conn, reader, payload, ctx) : attachThread(conn, reader, payload, ctx);
}
function attachThread(conn, reader, t, ctx) {
	const tv = view(t);
	const prog = t.length === 28 && tv.getUint32(0, true) === 3 ? ctx.programs.get(hex(t.subarray(4, 20))) : void 0;
	if (!prog || prog.ended) {
		ctx.log("[wasi] a thread of no running program; connection reset");
		return conn.reset();
	}
	const tid = tv.getUint32(20, true), arg = tv.getUint32(24, true);
	prog.run(new Link(conn, reader, ctx, prog.name, () => prog.end()), {
		tid,
		arg
	});
}
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
async function runProgram(conn, reader, start, ctx) {
	const host = hostClockNs();
	let prog;
	const link = new Link(conn, reader, ctx, "", () => prog?.end());
	const sv = view(start);
	let at = 0;
	const u32 = () => {
		const v = sv.getUint32(at, true);
		at += 4;
		return v;
	};
	const str = () => {
		const n = u32();
		const s = start.slice(at, at + n);
		at += n;
		return s;
	};
	let args, env, identity, size, unsettled, clock;
	const preopens = [];
	try {
		const version = u32();
		if (version !== 3) return link.exit(126, `kwwasi: protocol version ${version}, the host speaks 3`);
		const argc = u32(), envc = u32(), npre = u32();
		identity = start.slice(at, at + IDENTITY);
		size = Number(sv.getBigUint64(at, true));
		unsettled = (sv.getBigUint64(at + IDENTITY, true) & 1n) !== 0n;
		at += 48;
		clock = programClock(ctx, sv.getBigUint64(at, true), sv.getBigUint64(at + 8, true), host);
		at += 16;
		args = Array.from({ length: argc }, str);
		env = Array.from({ length: envc }, str);
		for (let i = 0; i < npre; i++) {
			const fd = u32();
			preopens.push([fd, str()]);
		}
	} catch (e) {
		ctx.log(`[wasi] bad START frame: ${e.message}`);
		return conn.reset();
	}
	const name = utf8d.decode(args[0] ?? /* @__PURE__ */ new Uint8Array());
	link.name = name;
	if (size > ctx.maxModule) return link.exit(126, `kwwasi: ${name}: ${size} bytes, larger than the host takes (${ctx.maxModule})`);
	const token = /* @__PURE__ */ new Uint8Array(16);
	crypto.getRandomValues(token);
	let compiled;
	const got = unsettled ? void 0 : await ctx.cache.acquire(Array.from(identity).join(","));
	if (got && "module" in got) {
		link.send(new Enc().u32(0).bytes(token).frame(4));
		compiled = got.module;
	} else {
		let key;
		try {
			link.send(new Enc().u32(1).bytes(token).frame(4));
			const bytes = await receiveModule(reader, size, identity);
			if (!bytes) {
				ctx.log(`[wasi] ${name}: kwwasi did not send the module; connection reset`);
				return conn.reset();
			}
			ctx.stats.received++;
			const c = await ctx.cache.compile(bytes.bytes);
			try {
				compiled = await c.module;
			} catch (e) {
				return link.exit(126, `kwwasi: ${name}: not a valid WebAssembly module: ${e.message}`);
			}
			if (bytes.same) key = c.key;
		} finally {
			got?.claim(key);
		}
	}
	const { module } = compiled;
	let threads = false, memoryImport = false;
	for (const imp of WebAssembly.Module.imports(module)) {
		if (WASI_MODULES.includes(imp.module)) continue;
		if (imp.module === WASI_MEMORY.module && imp.name === WASI_MEMORY.name && imp.kind === "memory") memoryImport = true;
		else if (imp.module === WASI_THREAD_SPAWN.module && imp.name === WASI_THREAD_SPAWN.name && imp.kind === "function") threads = true;
		else return link.exit(126, `kwwasi: ${name}: imports ${imp.module}.${imp.name}; only wasi_snapshot_preview1, wasi_unstable, and for wasi-threads wasi.thread-spawn and env.memory, are provided`);
	}
	const exports = WebAssembly.Module.exports(module);
	if (!exports.some((e) => e.name === "_start" && e.kind === "function")) return link.exit(126, `kwwasi: ${name}: no _start export (not a WASI command)`);
	if (compiled.memory?.own) return link.exit(126, `kwwasi: ${name}: a wasm64 module (64-bit memory); WASI preview 1 is wasm32 only`);
	const mem = memoryImport ? compiled.memory : void 0;
	if (memoryImport && (!mem || mem.memory64)) return link.exit(126, `kwwasi: ${name}: imports a memory this host cannot make (${mem ? "64-bit" : "unreadable limits"})`);
	if (threads && !mem?.shared) return link.exit(126, `kwwasi: ${name}: imports wasi.thread-spawn but no shared env.memory (wasi-threads needs one)`);
	if (threads && !exports.some((e) => e.name === "wasi_thread_start" && e.kind === "function")) return link.exit(126, `kwwasi: ${name}: imports wasi.thread-spawn but exports no wasi_thread_start`);
	if (mem?.shared && !ctx.shared) return link.exit(126, `kwwasi: ${name}: ${threads ? "a wasi-threads module" : "a module with a shared memory"} needs SharedArrayBuffer (Node, or a cross-origin isolated page), and this host passes requests as messages`);
	let memory;
	if (mem?.shared) try {
		memory = new WebAssembly.Memory({
			initial: mem.initial,
			maximum: mem.maximum,
			shared: true
		});
	} catch (e) {
		return link.exit(126, `kwwasi: ${name}: cannot make its shared memory: ${e?.message ?? e}`);
	}
	prog = new Program(ctx, hex(token), name, compiled, {
		args,
		env,
		preopens,
		clock
	}, memory);
	prog.run(link);
}
var Link = class {
	conn;
	reader;
	name;
	stopped = false;
	#writer;
	#ctx;
	#broken;
	#replyHead = /* @__PURE__ */ new Uint8Array(8);
	#replyView = view(this.#replyHead);
	#queue = Promise.resolve();
	#ctl;
	cpu;
	constructor(conn, reader, ctx, name, broken) {
		this.conn = conn;
		this.reader = reader;
		this.name = name;
		this.#writer = conn.writable.getWriter();
		this.#ctx = ctx;
		this.#broken = broken;
	}
	send(b) {
		this.#writer.write(b).catch(() => {});
	}
	exit(code, msg = "") {
		this.send(new Enc().u32(code).bytes(utf8.encode(msg)).frame(3));
		this.closeWrite();
	}
	closeWrite() {
		this.#writer.close().catch(() => {});
	}
	stop() {
		if (this.stopped) return;
		this.stopped = true;
		this.reader.cancel();
		if (this.#ctl) Atomics.notify(this.#ctl, 0);
	}
	async request(frame, place) {
		if (this.stopped) return null;
		this.#ctx.stats.requests++;
		this.send(frame);
		const h = await this.reader.into(this.#replyHead);
		const len = h && this.#replyView.getUint32(0, true) === 2 ? this.#replyView.getUint32(4, true) : -1;
		let body = null;
		if (len >= 4) {
			const at = place?.(len);
			if (place && !at) {
				this.#ctx.log(`[wasi] ${this.name}: a reply of ${len} bytes from kwwasi; connection reset`);
				this.#fail();
				return null;
			}
			body = at ? await this.reader.into(at) ? at : null : await this.reader.exact(len);
		}
		if (this.stopped) return null;
		if (!body) {
			if (h) this.#ctx.log(`[wasi] ${this.name}: unexpected frame from kwwasi; connection reset`);
			this.#fail();
			return null;
		}
		return body;
	}
	#fail() {
		this.conn.reset();
		this.#broken();
	}
	queue(frame, reply) {
		this.#queue = this.#queue.then(async () => {
			const body = await this.request(frame);
			if (body) reply(body);
		});
	}
	after(f) {
		this.#queue = this.#queue.then(f);
	}
	channel() {
		const channel = new SharedArrayBuffer(CH_INITIAL, { maxByteLength: CH_MAX });
		const ctl = this.#ctl = new Int32Array(channel, 0, 16);
		const op = new Uint32Array(channel, 64, 1);
		const serve = async () => {
			let seen = 0;
			for (;;) {
				const w = Atomics.waitAsync(ctl, 0, seen);
				if (w.async) await w.value;
				if (this.stopped) return;
				const seq = Atomics.load(ctl, 0);
				if (seq === seen) continue;
				seen = seq;
				const len = Atomics.load(ctl, 2);
				let n;
				if (this.cpu && len === 8 && op[0] === 256) {
					const ns = await this.cpu();
					if (this.stopped) return;
					const dv = new DataView(channel, 64, 12);
					dv.setInt32(0, 0, true);
					dv.setBigUint64(4, ns, true);
					n = 12;
				} else {
					const body = await this.request(new Uint8Array(channel, 64, len), (n) => channelRoom(channel, n) ? new Uint8Array(channel, 64, n) : void 0);
					if (!body) return;
					n = body.length;
				}
				Atomics.store(ctl, 2, n);
				Atomics.store(ctl, 1, seq);
				Atomics.notify(ctl, 1);
			}
		};
		this.#ctx.stats.channels++;
		serve().catch((e) => {
			this.#ctx.log(`[wasi] ${this.name}: ${errorText(e)}`);
			this.#fail();
		}).finally(() => this.#ctx.stats.channels--);
		return channel;
	}
};
const CPU_SAMPLE_MS = 250;
async function partCpu(p) {
	const ep = p.worker.ep;
	if (ep.cpuUsage && p.final === void 0) {
		let timer;
		const us = await Promise.race([ep.cpuUsage().catch(() => void 0), new Promise((r) => timer = setTimeout(() => r(void 0), CPU_SAMPLE_MS))]);
		clearTimeout(timer);
		const base = p.cpu0 ? Atomics.load(p.cpu0, 4) : -1n;
		if (us !== void 0 && base >= 0n) {
			const ns = (BigInt(Math.round(us)) - base) * 1000n;
			if (ns > p.seen) p.seen = ns;
		}
	}
	return p.final ?? p.seen;
}
var Program = class {
	name;
	ended = false;
	#ctx;
	#token;
	#compiled;
	#start;
	#memory;
	#cpu;
	#cpuDone;
	#cpuLive;
	#main;
	#parts = /* @__PURE__ */ new Set();
	constructor(ctx, token, name, compiled, start, memory) {
		this.#ctx = ctx;
		this.#token = token;
		this.name = name;
		this.#compiled = compiled;
		this.#start = start;
		this.#memory = memory;
		if (memory) {
			this.#cpu = new SharedArrayBuffer(16);
			this.#cpuDone = new BigInt64Array(this.#cpu, 0, 1);
			this.#cpuLive = new Int32Array(this.#cpu, 8, 1);
		}
	}
	run(link, thread) {
		const ctx = this.#ctx;
		let worker;
		try {
			worker = ctx.pool.take();
		} catch (e) {
			const msg = `kwwasi: ${this.name}: cannot start a worker: ${e?.message ?? e}`;
			if (thread) {
				link.conn.reset();
				this.end({
					code: 126,
					msg
				});
			} else link.exit(126, msg);
			return;
		}
		const part = {
			link,
			worker,
			tid: thread?.tid ?? 0,
			done: false,
			seen: 0n
		};
		this.#parts.add(part);
		if (thread) ctx.stats.threads++;
		else {
			this.#main = part;
			ctx.programs.set(this.#token, this);
			ctx.stats.started++;
			ctx.stats.running++;
		}
		const channel = ctx.shared ? link.channel() : void 0;
		if (channel && this.#cpu) {
			part.cpu0 = new BigInt64Array(channel, 0, 8);
			Atomics.store(part.cpu0, 4, -1n);
			Atomics.add(this.#cpuLive, 0, 1);
			link.cpu = () => this.#othersCpu(part);
		}
		worker.on = {
			message: (m) => {
				if (m.t === "request") link.queue(m.frame, (body) => worker.ep.post({
					t: "reply",
					body
				}, [body.buffer]));
				else if (m.t === "exit") {
					if (m.failed) ctx.stats.failed++;
					link.after(() => this.end({
						code: m.code,
						msg: m.msg
					}, worker));
				} else if (m.t === "done") this.#threadDone(part, m.cpu);
				else if (m.t === "log") ctx.log(m.msg);
			},
			gone: (e) => {
				if (this.ended) return;
				ctx.stats.failed++;
				this.end({
					code: 134,
					msg: `kwwasi: ${this.name}: ${e ? e?.message ?? e : "its worker ended"}`
				});
			}
		};
		link.conn.closed.then(() => {
			if (this.ended || part.done) return;
			ctx.log(`[wasi] ${this.name}: kwwasi went away; worker${this.#parts.size > 1 ? "s" : ""} terminated`);
			this.end();
		});
		const { module, memory: mem } = this.#compiled;
		const start = {
			t: "start",
			module,
			name: this.name,
			...this.#start,
			channel,
			thread,
			cpu: this.#cpu
		};
		if (this.#memory) start.memory = this.#memory;
		else if (mem) start.memoryType = {
			initial: mem.initial,
			maximum: mem.maximum
		};
		worker.ep.post(start);
	}
	#threadDone(part, cpu) {
		if (this.ended || part.done) return;
		part.done = true;
		if (part.cpu0) {
			part.final = cpu ?? part.seen;
			Atomics.add(this.#cpuDone, 0, part.final);
			Atomics.sub(this.#cpuLive, 0, 1);
		}
		this.#parts.delete(part);
		this.#ctx.stats.threads--;
		part.link.stop();
		part.link.closeWrite();
		this.#ctx.pool.release(part.worker, true);
	}
	async #othersCpu(asker) {
		let sum = Atomics.load(this.#cpuDone, 0);
		const parts = [...this.#parts].filter((p) => p !== asker);
		for (const ns of await Promise.all(parts.map(partCpu))) sum += ns;
		return sum;
	}
	end(status, by) {
		if (this.ended) return;
		this.ended = true;
		const ctx = this.#ctx;
		ctx.programs.delete(this.#token);
		ctx.stats.running--;
		if (status) this.#main?.link.exit(status.code, status.msg);
		for (const part of this.#parts) {
			part.link.stop();
			if (part !== this.#main) {
				part.link.closeWrite();
				ctx.stats.threads--;
			}
			ctx.pool.release(part.worker, part.worker === by);
		}
		this.#parts.clear();
	}
};
var WorkerPool = class {
	#spawn;
	#idle = [];
	#max;
	#stats;
	#closed = false;
	constructor(spawn, max, stats) {
		this.#spawn = spawn;
		this.#max = max;
		this.#stats = stats;
	}
	take() {
		const idle = this.#idle.pop();
		if (idle) {
			this.#stats.idle--;
			return idle;
		}
		const w = {
			ep: this.#spawn(),
			on: void 0,
			alive: true
		};
		this.#stats.workers++;
		const gone = (err) => {
			if (!w.alive) return;
			w.alive = false;
			this.#stats.workers--;
			const i = this.#idle.indexOf(w);
			if (i >= 0) {
				this.#idle.splice(i, 1);
				this.#stats.idle--;
			}
			const on = w.on;
			w.on = void 0;
			on?.gone(err);
		};
		w.ep.listen({
			message: (m) => w.on?.message(m),
			error: (e) => {
				gone(e);
				w.ep.terminate();
			},
			exit: () => gone()
		});
		return w;
	}
	release(w, reusable) {
		w.on = void 0;
		if (!w.alive) return;
		if (reusable && !this.#closed && this.#idle.length < this.#max) {
			this.#idle.push(w);
			this.#stats.idle++;
		} else w.ep.terminate();
	}
	close() {
		this.#closed = true;
		for (const w of [...this.#idle]) w.ep.terminate();
	}
};
const table = /* @__PURE__ */ new Map();
const byTex = /* @__PURE__ */ new Map();
const SF = 3;
const SFRB = 15;
const SR = 5;
function def(vk, tex, vtx, bpb, caps, kind = "float", feature, bw = 1, bh = 1) {
	const info = {
		vk,
		bpb,
		bw,
		bh,
		kind,
		caps
	};
	if (tex) info.tex = tex;
	if (vtx) info.vtx = vtx;
	if (feature) info.feature = feature;
	table.set(vk, info);
	if (tex && !byTex.has(tex)) byTex.set(tex, info);
}
def(9, "r8unorm", "unorm8", 1, SFRB);
def(10, "r8snorm", "snorm8", 1, SF);
def(13, "r8uint", "uint8", 1, SR, "uint");
def(14, "r8sint", "sint8", 1, SR, "sint");
def(16, "rg8unorm", "unorm8x2", 2, SFRB);
def(17, "rg8snorm", "snorm8x2", 2, SF);
def(20, "rg8uint", "uint8x2", 2, SR, "uint");
def(21, "rg8sint", "sint8x2", 2, SR, "sint");
def(37, "rgba8unorm", "unorm8x4", 4, 47);
def(38, "rgba8snorm", "snorm8x4", 4, 35);
def(41, "rgba8uint", "uint8x4", 4, 37, "uint");
def(42, "rgba8sint", "sint8x4", 4, 37, "sint");
def(43, "rgba8unorm-srgb", void 0, 4, SFRB);
def(44, "bgra8unorm", "unorm8x4-bgra", 4, SFRB);
def(50, "bgra8unorm-srgb", void 0, 4, SFRB);
def(51, "rgba8unorm", "unorm8x4", 4, 47);
def(52, "rgba8snorm", "snorm8x4", 4, 35);
def(55, "rgba8uint", "uint8x4", 4, 37, "uint");
def(56, "rgba8sint", "sint8x4", 4, 37, "sint");
def(57, "rgba8unorm-srgb", void 0, 4, SFRB);
def(64, "rgb10a2unorm", "unorm10-10-10-2", 4, SFRB);
def(68, "rgb10a2uint", void 0, 4, SR, "uint");
def(70, void 0, "unorm16", 2, 0);
def(71, void 0, "snorm16", 2, 0);
def(74, "r16uint", "uint16", 2, SR, "uint");
def(75, "r16sint", "sint16", 2, SR, "sint");
def(76, "r16float", "float16", 2, SFRB);
def(77, void 0, "unorm16x2", 4, 0);
def(78, void 0, "snorm16x2", 4, 0);
def(81, "rg16uint", "uint16x2", 4, SR, "uint");
def(82, "rg16sint", "sint16x2", 4, SR, "sint");
def(83, "rg16float", "float16x2", 4, SFRB);
def(91, void 0, "unorm16x4", 8, 0);
def(92, void 0, "snorm16x4", 8, 0);
def(95, "rgba16uint", "uint16x4", 8, 37, "uint");
def(96, "rgba16sint", "sint16x4", 8, 37, "sint");
def(97, "rgba16float", "float16x4", 8, 47);
def(98, "r32uint", "uint32", 4, 37, "uint");
def(99, "r32sint", "sint32", 4, 37, "sint");
def(100, "r32float", "float32", 4, 37);
def(101, "rg32uint", "uint32x2", 8, 37, "uint");
def(102, "rg32sint", "sint32x2", 8, 37, "sint");
def(103, "rg32float", "float32x2", 8, 37);
def(104, void 0, "uint32x3", 12, 0, "uint");
def(105, void 0, "sint32x3", 12, 0, "sint");
def(106, void 0, "float32x3", 12, 0);
def(107, "rgba32uint", "uint32x4", 16, 37, "uint");
def(108, "rgba32sint", "sint32x4", 16, 37, "sint");
def(109, "rgba32float", "float32x4", 16, 37);
def(122, "rg11b10ufloat", void 0, 4, SF);
def(123, "rgb9e5ufloat", void 0, 4, SF);
def(124, "depth16unorm", void 0, 2, 17, "depth");
def(125, "depth24plus", void 0, 4, 17, "depth");
def(126, "depth32float", void 0, 4, 17, "depth");
def(127, "stencil8", void 0, 1, 17, "stencil");
def(128, "depth24plus-stencil8", void 0, 4, 17, "depth-stencil");
def(129, "depth24plus-stencil8", void 0, 4, 17, "depth-stencil");
def(130, "depth32float-stencil8", void 0, 5, 17, "depth-stencil", "depth32float-stencil8");
for (const [vk, tex, bpb] of [
	[
		131,
		"bc1-rgba-unorm",
		8
	],
	[
		132,
		"bc1-rgba-unorm-srgb",
		8
	],
	[
		133,
		"bc1-rgba-unorm",
		8
	],
	[
		134,
		"bc1-rgba-unorm-srgb",
		8
	],
	[
		135,
		"bc2-rgba-unorm",
		16
	],
	[
		136,
		"bc2-rgba-unorm-srgb",
		16
	],
	[
		137,
		"bc3-rgba-unorm",
		16
	],
	[
		138,
		"bc3-rgba-unorm-srgb",
		16
	],
	[
		139,
		"bc4-r-unorm",
		8
	],
	[
		140,
		"bc4-r-snorm",
		8
	],
	[
		141,
		"bc5-rg-unorm",
		16
	],
	[
		142,
		"bc5-rg-snorm",
		16
	],
	[
		143,
		"bc6h-rgb-ufloat",
		16
	],
	[
		144,
		"bc6h-rgb-float",
		16
	],
	[
		145,
		"bc7-rgba-unorm",
		16
	],
	[
		146,
		"bc7-rgba-unorm-srgb",
		16
	]
]) def(vk, tex, void 0, bpb, SF, "float", "texture-compression-bc", 4, 4);
for (const [vk, tex, bpb] of [
	[
		147,
		"etc2-rgb8unorm",
		8
	],
	[
		148,
		"etc2-rgb8unorm-srgb",
		8
	],
	[
		149,
		"etc2-rgb8a1unorm",
		8
	],
	[
		150,
		"etc2-rgb8a1unorm-srgb",
		8
	],
	[
		151,
		"etc2-rgba8unorm",
		16
	],
	[
		152,
		"etc2-rgba8unorm-srgb",
		16
	],
	[
		153,
		"eac-r11unorm",
		8
	],
	[
		154,
		"eac-r11snorm",
		8
	],
	[
		155,
		"eac-rg11unorm",
		16
	],
	[
		156,
		"eac-rg11snorm",
		16
	]
]) def(vk, tex, void 0, bpb, SF, "float", "texture-compression-etc2", 4, 4);
[
	[4, 4],
	[5, 4],
	[5, 5],
	[6, 5],
	[6, 6],
	[8, 5],
	[8, 6],
	[8, 8],
	[10, 5],
	[10, 6],
	[10, 8],
	[10, 10],
	[12, 10],
	[12, 12]
].forEach(([w, h], i) => {
	def(157 + 2 * i, `astc-${w}x${h}-unorm`, void 0, 16, SF, "float", "texture-compression-astc", w, h);
	def(158 + 2 * i, `astc-${w}x${h}-unorm-srgb`, void 0, 16, SF, "float", "texture-compression-astc", w, h);
});
function vkFormat(vk) {
	return table.get(vk);
}
function texFormatInfo(tex) {
	return byTex.get(tex);
}
function formatCaps(info, features) {
	let caps = 0;
	if (info.tex && (!info.feature || features.has(info.feature))) {
		caps = info.caps;
		const t = info.tex;
		if (features.has("float32-filterable") && /^r(g|gba)?32float$/.test(t)) caps |= 2;
		if (features.has("float32-blendable") && /^r(g|gba)?32float$/.test(t)) caps |= 8;
		if (features.has("rg11b10ufloat-renderable") && t === "rg11b10ufloat") caps |= 12;
		if (features.has("bgra8unorm-storage") && t === "bgra8unorm") caps |= 32;
	}
	if (info.vtx) caps |= 64;
	return caps;
}
function formatTable(features) {
	const out = {};
	for (const [vk, info] of table) {
		const caps = formatCaps(info, features);
		if (caps) out[vk] = caps;
	}
	return out;
}
function hasDepth(tex) {
	return tex.startsWith("depth");
}
function hasStencil(tex) {
	return tex.includes("stencil");
}
function srgbTwin(tex) {
	if (tex.endsWith("-srgb")) return tex.slice(0, -5);
	if (tex === "rgba8unorm" || tex === "bgra8unorm" || /^(bc[1237]|etc2|astc)/.test(tex)) return tex + "-srgb";
}
const ALIGN = 256;
var Upload = class {
	buf;
	map;
	off = 0;
	size;
	constructor(c, size) {
		this.size = Math.max(ALIGN * 2, size + ALIGN * 2 + 255 & -256);
		this.buf = c.dev.createBuffer({
			size: this.size,
			usage: BU.COPY_SRC | BU.UNIFORM,
			mappedAtCreation: true,
			label: "kwvk upload"
		});
		this.map = new Uint8Array(this.buf.getMappedRange());
	}
	alloc(bytes, align, reserve = 0) {
		const off = this.off + align - 1 & ~(align - 1);
		const n = typeof bytes === "number" ? bytes : bytes.length;
		if (off + Math.max(n, reserve) > this.size) throw new Error("upload buffer overflow");
		if (typeof bytes !== "number") this.map.set(bytes, off);
		this.off = off + Math.max(n, reserve);
		return off;
	}
};
const MAX_UPLOAD = 1 << 28;
const NO_VARIANT_CHANGE = /* @__PURE__ */ new Set([
	"vkCmdDraw",
	"vkCmdDrawIndexed",
	"vkCmdDrawIndirect",
	"vkCmdDrawIndexedIndirect",
	"vkCmdPushConstants",
	"vkCmdBindDescriptorSets",
	"vkCmdBindVertexBuffers",
	"vkCmdSetScissor",
	"vkCmdSetBlendConstants",
	"vkCmdSetStencilReference",
	"vkCmdSetLineWidth",
	"vkCmdSetDepthBounds",
	"vkCmdPipelineBarrier",
	"vkCmdBeginQuery",
	"vkCmdEndQuery"
]);
function scanSize(cmds) {
	let n = 0;
	const len = (a) => Array.isArray(a) ? a.length : 1;
	for (const k of cmds) switch (k?.c) {
		case "vkCmdDraw":
		case "vkCmdDrawIndexed":
		case "vkCmdDrawIndirect":
		case "vkCmdDrawIndexedIndirect":
		case "vkCmdDispatch":
		case "vkCmdDispatchIndirect":
			n += ALIGN;
			break;
		case "vkCmdBlitImage":
			for (const r of Array.isArray(k.regions) ? k.regions : []) n += ALIGN * Math.min(2048, Math.max(1, r?.srcSubresource?.layerCount | 0));
			break;
		case "vkCmdClearAttachments":
			n += ALIGN * len(k.attachments);
			break;
		case "vkCmdBeginRenderPass":
		case "vkCmdBeginRenderPass2":
		case "vkCmdBeginRendering":
		case "vkCmdNextSubpass":
		case "vkCmdNextSubpass2":
			n += ALIGN * 10;
			break;
		case "vkCmdUpdateBuffer":
			n += (len(k.data) | 0) + 7 & -4;
			break;
		case "vkCmdFillBuffer":
			if (k.data && !isWhole(k.size) && k.size > 0) n += Math.min(k.size, MAX_UPLOAD) + 7 & -4;
			break;
		case "vkCmdCopyQueryPoolResults":
			n += 8;
			break;
		case "vkCmdCopyBuffer": n += ALIGN * len(k.regions);
	}
	if (n > MAX_UPLOAD) throw new Error(`submit needs ${n} bytes of command data`);
	return n;
}
function clearColorOf(v, tex) {
	const kind = tex ? texFormatInfo(tex)?.kind : "float";
	const c = v?.color ?? v;
	let arr;
	if (Array.isArray(c)) arr = c;
	else if (c) {
		if (kind === "uint") arr = c.uint32 ?? reinterpret(c.int32, "u") ?? c.float32;
		else if (kind === "sint") arr = c.int32 ?? reinterpret(c.uint32, "i") ?? c.float32;
		else arr = c.float32 ?? reinterpret(c.uint32 ?? c.int32, "f");
	}
	const a = arr || [
		0,
		0,
		0,
		0
	];
	return {
		r: a[0] ?? 0,
		g: a[1] ?? 0,
		b: a[2] ?? 0,
		a: a[3] ?? 0
	};
}
function reinterpret(v, to) {
	if (!v) return void 0;
	const b = /* @__PURE__ */ new ArrayBuffer(16);
	const src = new Uint32Array(b);
	const f = new Float32Array(b);
	const i = new Int32Array(b);
	for (let k = 0; k < 4; k++) src[k] = (v[k] ?? 0) >>> 0;
	return to === "u" ? [...src] : to === "i" ? [...i] : [...f];
}
function depthClearOf(v) {
	const d = v?.depthStencil ?? v ?? {};
	return {
		depth: d.depth ?? 1,
		stencil: d.stencil ?? 0
	};
}
var Exec = class {
	c;
	dev;
	enc;
	up;
	pushBG;
	pass = null;
	passKind = "";
	push = /* @__PURE__ */ new Uint8Array(256);
	pushVer = 1;
	pushOff = -1;
	pushOffVer = 0;
	gfx = {
		sets: [],
		dyn: []
	};
	comp = {
		sets: [],
		dyn: []
	};
	vbs = /* @__PURE__ */ new Map();
	ib;
	viewport;
	scissor;
	blend;
	stencilRef = 0;
	bias;
	readMask;
	writeMask;
	rp;
	ext = {};
	bound = {
		groups: [],
		vbs: []
	};
	index = 0;
	cmds;
	stateVer = 0;
	drawMemo;
	scratch = [];
	constructor(c, cmds) {
		this.c = c;
		this.cmds = cmds;
		this.dev = c.dev;
		this.enc = c.dev.createCommandEncoder({ label: "kwvk submit" });
		this.up = new Upload(c, scanSize(cmds));
		this.pushBG = c.dev.createBindGroup({
			layout: c.pushBGL,
			entries: [{
				binding: 0,
				resource: {
					buffer: this.up.buf,
					offset: 0,
					size: 256
				}
			}]
		});
	}
	occlusionPool;
	endPass() {
		if (this.activeQuery !== void 0) {
			this.pass.endOcclusionQuery();
			this.activeQuery = void 0;
		}
		this.occlusionPool = void 0;
		if (this.pass) this.pass.end();
		this.pass = null;
		this.passKind = "";
		this.bound = {
			groups: [],
			vbs: []
		};
	}
	buffer(id) {
		return this.c.get(id, "buffer");
	}
	beginSubpass() {
		const rp = this.rp;
		const pass = rp.pass;
		const sp = pass.subpasses[rp.subpass];
		if (!sp) throw new Error(`no subpass ${rp.subpass}`);
		const view = (a) => this.c.viewFor(this.c.get(rp.fb.views[a], "imageView"), "att");
		const first = (a) => pass.first.get(a) === rp.subpass;
		const last = (a) => pass.last.get(a) === rp.subpass;
		const ar = rp.area;
		const partial = !!ar && ((ar.offset?.x || 0) > 0 || (ar.offset?.y || 0) > 0 || (ar.offset?.x || 0) + ar.extent.width < rp.width || (ar.offset?.y || 0) + ar.extent.height < rp.height);
		const clears = [];
		const load = (a, op) => !first(a) || op === 0 || partial ? "load" : "clear";
		const store = (a, op) => !last(a) || op !== 1 || partial ? "store" : "discard";
		const desc = {
			colorAttachments: sp.colors.map((a, j) => {
				if (a === 4294967295) return null;
				const att = pass.atts[a];
				const ca = {
					view: view(a),
					loadOp: load(a, att.loadOp),
					storeOp: store(a, att.storeOp),
					clearValue: clearColorOf(rp.clear[a], att.tex)
				};
				if (partial && first(a) && att.loadOp === 1) clears.push({
					aspectMask: 1,
					colorAttachment: j,
					clearValue: rp.clear[a]
				});
				const r = sp.resolves[j];
				if (r !== void 0 && r !== 4294967295) ca.resolveTarget = view(r);
				return ca;
			}),
			label: "kwvk render pass"
		};
		if (sp.depth !== 4294967295) {
			const a = sp.depth;
			const att = pass.atts[a];
			const dc = depthClearOf(rp.clear[a]);
			const ds = { view: view(a) };
			let mask = 0;
			if (hasDepth(att.tex)) {
				Object.assign(ds, {
					depthLoadOp: load(a, att.loadOp),
					depthStoreOp: store(a, att.storeOp),
					depthClearValue: dc.depth
				});
				if (att.loadOp === 1) mask |= 2;
			}
			if (hasStencil(att.tex)) {
				Object.assign(ds, {
					stencilLoadOp: load(a, att.stencilLoadOp),
					stencilStoreOp: store(a, att.stencilStoreOp),
					stencilClearValue: dc.stencil
				});
				if (att.stencilLoadOp === 1) mask |= 4;
			}
			if (partial && first(a) && mask) clears.push({
				aspectMask: mask,
				colorAttachment: 0,
				clearValue: rp.clear[a]
			});
			desc.depthStencilAttachment = ds;
		}
		for (let i = this.index + 1; i < this.cmds.length; i++) {
			const k = this.cmds[i];
			const kc = k?.c;
			if (kc === "vkCmdEndRenderPass" || kc === "vkCmdEndRenderPass2" || kc === "vkCmdEndRendering" || kc === "vkCmdNextSubpass" || kc === "vkCmdNextSubpass2") break;
			if (kc === "vkCmdBeginQuery") {
				const p = this.c.objs.get(k.queryPool);
				if (p?.t === "queryPool" && p.type === 0 && p.set) {
					desc.occlusionQuerySet = p.set;
					this.occlusionPool = p;
				}
				break;
			}
		}
		this.pass = this.enc.beginRenderPass(desc);
		this.passKind = "render";
		this.bound = {
			groups: [],
			vbs: []
		};
		if (clears.length) this.clearAttachments({
			attachments: clears,
			rects: [{ rect: ar }]
		});
		else this.applyDynamic();
	}
	beginRendering(k) {
		const atts = [];
		const views = [];
		const clear = [];
		let width = 0;
		let height = 0;
		const add = (viewId, att, cv) => {
			const v = this.c.get(viewId, "imageView");
			const mip = v.range.baseMipLevel || 0;
			width = width || Math.max(1, v.image.width >> mip);
			height = height || Math.max(1, v.image.height >> mip);
			atts.push({
				...att,
				tex: v.tex,
				samples: v.image.samples
			});
			views.push(viewId);
			clear.push(cv);
			return atts.length - 1;
		};
		const colors = [];
		const resolves = [];
		for (const ca of k.colorAttachments || []) {
			if (!ca?.imageView) {
				colors.push(UNUSED);
				resolves.push(UNUSED);
				continue;
			}
			colors.push(add(ca.imageView, {
				loadOp: ca.loadOp ?? 0,
				storeOp: ca.storeOp ?? 0
			}, ca.clearValue));
			resolves.push(ca.resolveMode && ca.resolveImageView ? add(ca.resolveImageView, {
				loadOp: 2,
				storeOp: 0
			}, void 0) : UNUSED);
		}
		const da = k.depthAttachment?.imageView ? k.depthAttachment : void 0;
		const sa = k.stencilAttachment?.imageView ? k.stencilAttachment : void 0;
		let depth = UNUSED;
		if (da || sa) {
			const dv = { depthStencil: {
				depth: da?.clearValue?.depthStencil?.depth ?? 1,
				stencil: sa?.clearValue?.depthStencil?.stencil ?? 0
			} };
			depth = add((da || sa).imageView, {
				loadOp: da ? da.loadOp ?? 0 : 0,
				storeOp: da ? da.storeOp ?? 0 : 0,
				stencilLoadOp: sa ? sa.loadOp ?? 0 : 0,
				stencilStoreOp: sa ? sa.storeOp ?? 0 : 0
			}, dv);
		}
		if ((k.layerCount || 1) > 1 || k.viewMask) this.c.log("kwvk: vkCmdBeginRendering: layered and multiview rendering are unsupported (layer 0 only)");
		const colorFormats = colors.map((a) => a === 4294967295 ? null : atts[a].tex);
		const depthFormat = depth === 4294967295 ? null : atts[depth].tex;
		let samples = 1;
		for (const a of [...colors, depth]) if (a !== 4294967295) samples = atts[a].samples || 1;
		const sp = {
			colors,
			resolves,
			depth,
			colorFormats,
			depthFormat,
			samples,
			key: `${colorFormats.join(",")}|${depthFormat}|${samples}`
		};
		const all = new Map(atts.map((_, i) => [i, 0]));
		const pass = {
			atts,
			subpasses: [sp],
			first: all,
			last: all
		};
		this.rp = {
			pass,
			fb: {
				views,
				width,
				height
			},
			subpass: 0,
			clear,
			width,
			height,
			area: k.renderArea
		};
		this.beginSubpass();
	}
	applyDynamic() {
		if (this.passKind !== "render") return;
		const rp = this.rp;
		if (this.viewport) {
			const v = this.viewport;
			let y = v.y;
			let h = v.height;
			if (h < 0) {
				y += h;
				h = -h;
			}
			let mn = Math.min(1, Math.max(0, v.minDepth ?? 0));
			let mx = Math.min(1, Math.max(0, v.maxDepth ?? 1));
			if (mn > mx) [mn, mx] = [mx, mn];
			if (v.width > 0 && h > 0) this.pass.setViewport(v.x, y, v.width, h, mn, mx);
		}
		if (this.scissor) {
			const s = this.scissor;
			const x = Math.min(Math.max(0, s.offset?.x || 0), rp.width);
			const y = Math.min(Math.max(0, s.offset?.y || 0), rp.height);
			const w = Math.max(0, Math.min((s.offset?.x || 0) + s.extent.width, rp.width) - x);
			const h = Math.max(0, Math.min((s.offset?.y || 0) + s.extent.height, rp.height) - y);
			this.pass.setScissorRect(x, y, w, h);
		}
		if (this.blend) this.pass.setBlendConstant({
			r: this.blend[0],
			g: this.blend[1],
			b: this.blend[2],
			a: this.blend[3]
		});
		this.pass.setStencilReference(this.stencilRef);
	}
	bindSets(pass, layout, st, over) {
		layout.sets.forEach((slot, s) => {
			const o = over?.get(s);
			const bg = st.sets[s] || !slot.entries.length ? this.c.bindGroup(st.sets[s], slot, o) : this.c.placeholderBindGroup(s, slot);
			const vk = st.dyn[s] || [];
			const offs = slot.dynIdx.map((i) => vk[i] ?? 0);
			const key = o ? `alias${this.nextId++}` : `${this.bgId(bg)}:${offs.join(",")}`;
			if (this.bound.groups[s] === key) return;
			this.bound.groups[s] = key;
			pass.setBindGroup(s, bg, offs);
		});
		if (layout.pushGroup >= 0) {
			if (this.pushOffVer !== this.pushVer) {
				this.pushOff = this.up.alloc(this.push.subarray(0, Math.min(256, layout.pushSize + 15 & -16)), ALIGN, 256);
				this.pushOffVer = this.pushVer;
			}
			if (this.bound.push !== this.pushOff || this.bound.groups[layout.pushGroup] !== "push") {
				pass.setBindGroup(layout.pushGroup, this.pushBG, [this.pushOff]);
				this.bound.push = this.pushOff;
				this.bound.groups[layout.pushGroup] = "push";
			}
		}
	}
	ids = /* @__PURE__ */ new WeakMap();
	nextId = 1;
	bgId(o) {
		let id = this.ids.get(o);
		if (!id) this.ids.set(o, id = this.nextId++);
		return id;
	}
	baseWarn() {
		this.c.log("kwvk: draw: the shader reads BaseVertex/BaseInstance/DrawIndex, which read 0 on WebGPU (non-zero firstVertex/vertexOffset/firstInstance)");
	}
	fan() {
		const p = this.gfx.pipeline;
		return !!p && (effectiveExt(p, this.ext).topology ?? p.topology) === 5;
	}
	activeQuery;
	byteScratch;
	byteCopy(src, so, dst, dO, size) {
		if (!size) return;
		const a0 = so & -4;
		const a1 = Math.min(so + size + 3 & -4, src.size);
		const need = Math.max(256, a1 - a0 + 3 & -4);
		if (!this.byteScratch || this.byteScratch.size < need) {
			this.byteScratch = this.dev.createBuffer({
				size: need,
				usage: BU.STORAGE | BU.COPY_DST,
				label: "kwvk byte copy"
			});
			this.scratch.push(this.byteScratch);
		}
		const scratch = this.byteScratch;
		this.enc.copyBufferToBuffer(src, a0, scratch, 0, a1 - a0);
		const h = byteCopyPipeline(this.c);
		const off = this.up.alloc(new Uint8Array(new Uint32Array([
			so - a0,
			dO,
			size,
			0
		]).buffer), ALIGN);
		const bg = this.dev.createBindGroup({
			layout: h.bgl,
			entries: [
				{
					binding: 0,
					resource: { buffer: scratch }
				},
				{
					binding: 1,
					resource: { buffer: dst }
				},
				{
					binding: 2,
					resource: {
						buffer: this.up.buf,
						offset: off,
						size: 16
					}
				}
			]
		});
		const words = (dO + size + 3 >> 2) - (dO >> 2);
		const pass = this.enc.beginComputePass({ label: "kwvk byte copy" });
		pass.setPipeline(h.pipeline);
		pass.setBindGroup(0, bg);
		pass.dispatchWorkgroups(Math.ceil(words / 64));
		pass.end();
	}
	touchAvail(p, q) {
		p.avail[q] = 1;
	}
	touch(p, q) {
		p.written[q] = 1;
		p.seq[q] = ++p.clock;
		p.avail[q] = 1;
	}
	queryPool(k) {
		const p = this.c.get(k.queryPool, "queryPool");
		const q = k.query | 0;
		if (q < 0 || q >= p.count) throw new Error(`query ${k.query} out of range`);
		return {
			p,
			q
		};
	}
	fanIndices(n) {
		const c = this.c;
		const tris = Math.max(0, n - 2);
		if (!c.fanIndex || c.fanIndex.count < tris) {
			const count = Math.max(1024, 1 << Math.ceil(Math.log2(tris || 1)));
			const buf = this.dev.createBuffer({
				size: count * 12,
				usage: BU.INDEX,
				mappedAtCreation: true,
				label: "kwvk fan indices"
			});
			const a = new Uint32Array(buf.getMappedRange());
			for (let i = 0; i < count; i++) a.set([
				0,
				i + 1,
				i + 2
			], i * 3);
			buf.unmap();
			c.fanIndex = {
				buf,
				count
			};
		}
		return {
			buf: c.fanIndex.buf,
			offset: 0,
			format: "uint32"
		};
	}
	flushDraw(indexed, ibOverride) {
		if (this.passKind !== "render") throw new Error("draw outside a render pass");
		const p0 = this.gfx.pipeline;
		if (!p0) throw new Error("no graphics pipeline bound");
		this.c.stats.draws++;
		const ib = ibOverride || this.ib;
		const memo = `${this.stateVer}|${indexed}|${!!ibOverride}`;
		let v;
		let refined;
		let p = p0;
		if (this.drawMemo?.key === memo) ({v, refined, p} = this.drawMemo);
		else {
			const sp = this.rp.pass.subpasses[this.rp.subpass];
			const dyn = {};
			if (this.bias) dyn.bias = this.bias;
			if (this.readMask !== void 0) dyn.readMask = this.readMask;
			if (this.writeMask !== void 0) dyn.writeMask = this.writeMask;
			if (this.viewport && this.viewport.height < 0) dyn.noFlip = true;
			dyn.ext = this.ext;
			p = this.c.storageVariant(p0, this.gfx.sets);
			refined = this.c.refine(p.layout, this.gfx.sets);
			v = pipelineVariant(this.c, p, sp, dyn, indexed ? ib?.format : void 0, refined);
			this.drawMemo = {
				key: memo,
				v,
				refined,
				p
			};
		}
		if (this.bound.pipe !== v) {
			this.pass.setPipeline(v);
			this.bound.pipe = v;
			this.bound.groups = [];
			this.bound.push = void 0;
		}
		this.bindSets(this.pass, refined || p.layout, this.gfx);
		p.buffers.forEach((b, slot) => {
			const vb = this.vbs.get(b.binding);
			if (!vb) throw new Error(`vertex binding ${b.binding} not bound`);
			if (this.bound.vbs[slot] === vb) return;
			this.bound.vbs[slot] = vb;
			this.pass.setVertexBuffer(slot, vb.buf, vb.offset);
		});
		if (indexed) {
			if (!ib) throw new Error("no index buffer bound");
			const key = `${this.bgId(ib.buf)}:${ib.offset}:${ib.format}`;
			if (this.bound.ib !== key) {
				this.pass.setIndexBuffer(ib.buf, ib.format, ib.offset);
				this.bound.ib = key;
			}
		}
		return true;
	}
	computePass() {
		if (this.passKind === "compute") return this.pass;
		if (this.passKind === "render") throw new Error("dispatch inside a render pass");
		this.pass = this.enc.beginComputePass({ label: "kwvk compute" });
		this.passKind = "compute";
		this.bound = {
			groups: [],
			vbs: []
		};
		return this.pass;
	}
	flushDispatch() {
		let p = this.comp.pipeline;
		if (!p) throw new Error("no compute pipeline bound");
		this.c.stats.dispatches++;
		p = this.c.storageVariant(p, this.comp.sets);
		const refined = this.c.refine(p.layout, this.comp.sets);
		const over = this.aliasFix(refined || p.layout, this.comp);
		const pass = this.computePass();
		const gpu = computeVariant(this.c, p, refined);
		if (this.bound.pipe !== gpu) {
			pass.setPipeline(gpu);
			this.bound.pipe = gpu;
			this.bound.groups = [];
			this.bound.push = void 0;
		}
		this.bindSets(pass, refined || p.layout, this.comp, over);
		return pass;
	}
	aliasScratch = [];
	aliasFix(layout, st) {
		const ents = [];
		layout.sets.forEach((slot, s) => {
			const set = st.sets[s];
			if (!set) return;
			for (const e of slot.entries) {
				if (!e.buffer || e.buffer.type === "uniform") continue;
				const [vkb, el] = slot.src.get(e.binding) || [e.binding >> 1, 0];
				const d = set.desc.get(dkey(vkb, el));
				if (!d) continue;
				const b = this.c.objs.get(d.buffer);
				if (!b?.buf) continue;
				if (e.buffer.hasDynamicOffset) {
					if (e.buffer.type === "storage") ents.push({
						s,
						binding: e.binding,
						dyn: true,
						w: true,
						buf: b.buf
					});
					continue;
				}
				const size = Math.min((isWhole(d.range) ? b.size - d.offset : d.range) + 3 & -4, b.buf.size - d.offset);
				ents.push({
					s,
					binding: e.binding,
					ro: !!e.kwRO,
					kept: e.buffer.type === "read-only-storage",
					w: e.buffer.type === "storage",
					buf: b.buf,
					off: d.offset,
					size
				});
			}
		});
		let over;
		let n = 0;
		for (const a of ents) {
			if (!a.ro && !a.kept) continue;
			if (!(a.kept ? ents.some((x) => x.w && x.buf === a.buf) : ents.some((x) => x !== a && !x.dyn && x.buf === a.buf && x.off < a.off + a.size && a.off < x.off + x.size))) continue;
			if (this.passKind === "compute") this.endPass();
			let sc = this.aliasScratch[n];
			if (!sc || sc.size < a.size) {
				sc = this.dev.createBuffer({
					size: Math.max(a.size, 256),
					usage: BU.STORAGE | BU.COPY_DST,
					label: "kwvk alias scratch"
				});
				this.aliasScratch[n] = sc;
				this.scratch.push(sc);
			}
			n++;
			this.enc.copyBufferToBuffer(a.buf, a.off, sc, 0, a.size);
			((over ||= /* @__PURE__ */ new Map()).get(a.s) || over.set(a.s, /* @__PURE__ */ new Map()).get(a.s)).set(a.binding, {
				buf: sc,
				size: a.size
			});
		}
		if (over) this.bound.groups = [];
		return over;
	}
	outside() {
		if (this.passKind === "compute") this.endPass();
		else if (this.passKind === "render") throw new Error("transfer command inside a render pass");
	}
	copyBufImg(toImage, bufId, imgId, r) {
		const b = this.buffer(bufId);
		const img = this.c.get(imgId, "image");
		const info = img.info;
		const sub = r.imageSubresource || {};
		const ext = r.imageExtent || {
			width: img.width,
			height: img.height,
			depth: 1
		};
		const off = r.imageOffset || {
			x: 0,
			y: 0,
			z: 0
		};
		const w = ext.width;
		const h = ext.height;
		const d = img.is3D ? ext.depth || 1 : sub.layerCount || 1;
		const z0 = img.is3D ? off.z || 0 : sub.baseArrayLayer || 0;
		const rowLen = r.bufferRowLength || w;
		const imgH = r.bufferImageHeight || h;
		if (!(w >= 1 && h >= 1 && d >= 1 && w <= img.width && h <= img.height && d <= Math.max(img.layers, img.depth))) throw new Error(`copy extent ${w}x${h}x${d} out of range`);
		const bytesPerRow = Math.ceil(rowLen / info.bw) * info.bpb;
		const rowsPerImage = Math.ceil(imgH / info.bh);
		let aspect = "all";
		if (hasDepth(img.format) || hasStencil(img.format)) aspect = sub.aspectMask & 4 ? hasDepth(img.format) ? "stencil-only" : "all" : hasStencil(img.format) ? "depth-only" : "all";
		const base = r.bufferOffset || 0;
		const copy = (offset, bpr, rows, x, y, z, cw, ch, cd) => {
			const layout = {
				buffer: b.buf,
				offset
			};
			if (bpr !== void 0) layout.bytesPerRow = bpr;
			if (rows !== void 0) layout.rowsPerImage = rows;
			const tex = {
				texture: img.tex,
				mipLevel: sub.mipLevel || 0,
				origin: [
					x,
					y,
					z
				],
				aspect
			};
			if (toImage) this.enc.copyBufferToTexture(layout, tex, [
				cw,
				ch,
				cd
			]);
			else this.enc.copyTextureToBuffer(tex, layout, [
				cw,
				ch,
				cd
			]);
		};
		if (bytesPerRow % 256 === 0) {
			copy(base, bytesPerRow, rowsPerImage, off.x || 0, off.y || 0, z0, w, h, d);
			return;
		}
		const blocksH = Math.ceil(h / info.bh);
		for (let k = 0; k < d; k++) for (let row = 0; row < blocksH; row++) {
			const y = row * info.bh;
			copy(base + (k * rowsPerImage + row) * bytesPerRow, void 0, void 0, off.x || 0, (off.y || 0) + y, z0 + k, w, Math.min(info.bh, h - y), 1);
		}
	}
	renderableView(img, mip, layer) {
		return img.tex.createView({
			dimension: "2d",
			baseMipLevel: mip,
			mipLevelCount: 1,
			baseArrayLayer: layer,
			arrayLayerCount: 1
		});
	}
	clearImage(imgId, ranges, color, ds) {
		const img = this.c.get(imgId, "image");
		for (const r of ranges || [{}]) {
			const levels = Math.min(isWhole(r.levelCount) || r.levelCount === 4294967295 ? img.mipLevels - (r.baseMipLevel || 0) : r.levelCount ?? 1, img.mipLevels);
			const layers = Math.min(isWhole(r.layerCount) || r.layerCount === 4294967295 ? img.layers - (r.baseArrayLayer || 0) : r.layerCount ?? 1, img.layers);
			for (let m = 0; m < levels; m++) for (let l = 0; l < layers; l++) {
				const view = this.renderableView(img, (r.baseMipLevel || 0) + m, (r.baseArrayLayer || 0) + l);
				const desc = { colorAttachments: [] };
				if (ds) {
					const a = { view };
					const mask = r.aspectMask ?? 6;
					if (hasDepth(img.format)) Object.assign(a, mask & 2 ? {
						depthLoadOp: "clear",
						depthClearValue: ds.depth ?? 1
					} : { depthLoadOp: "load" }, { depthStoreOp: "store" });
					if (hasStencil(img.format)) Object.assign(a, mask & 4 ? {
						stencilLoadOp: "clear",
						stencilClearValue: ds.stencil ?? 0
					} : { stencilLoadOp: "load" }, { stencilStoreOp: "store" });
					desc.depthStencilAttachment = a;
				} else desc.colorAttachments.push({
					view,
					loadOp: "clear",
					storeOp: "store",
					clearValue: clearColorOf(color, img.format)
				});
				this.enc.beginRenderPass(desc).end();
			}
		}
	}
	blit(k) {
		const src = this.c.get(k.srcImage, "image");
		const dst = this.c.get(k.dstImage, "image");
		for (const r of k.regions || []) {
			const so = r.srcOffsets;
			const dO = r.dstOffsets;
			const ss = r.srcSubresource || {};
			const dsub = r.dstSubresource || {};
			const sw = so[1].x - so[0].x;
			const sh = so[1].y - so[0].y;
			const dw = dO[1].x - dO[0].x;
			const dh = dO[1].y - dO[0].y;
			const layers = Math.min(ss.layerCount || 1, src.layers, dst.layers);
			if (sw === dw && sh === dh && sw > 0 && sh > 0 && src.format === dst.format && so[1].z - so[0].z <= 1) {
				this.enc.copyTextureToTexture({
					texture: src.tex,
					mipLevel: ss.mipLevel || 0,
					origin: [
						so[0].x,
						so[0].y,
						src.is3D ? so[0].z : ss.baseArrayLayer || 0
					]
				}, {
					texture: dst.tex,
					mipLevel: dsub.mipLevel || 0,
					origin: [
						dO[0].x,
						dO[0].y,
						dst.is3D ? dO[0].z : dsub.baseArrayLayer || 0
					]
				}, [
					sw,
					sh,
					layers
				]);
				continue;
			}
			if (hasDepth(dst.format) || hasStencil(dst.format) || texFormatInfo(dst.format)?.kind !== "float") throw new Error(`scaled blit of ${dst.format} is unsupported`);
			const sinfo = texFormatInfo(src.format);
			const linear = k.filter === 1 && !!(sinfo && sinfo.caps & 2);
			const h = blitPipeline(this.c, dst.format, linear);
			const smw = Math.max(1, src.width >> (ss.mipLevel || 0));
			const smh = Math.max(1, src.height >> (ss.mipLevel || 0));
			for (let l = 0; l < layers; l++) {
				const u = new Float32Array([
					so[0].x / smw,
					so[0].y / smh,
					so[1].x / smw,
					so[1].y / smh
				]);
				let x0 = dO[0].x;
				let y0 = dO[0].y;
				let x1 = dO[1].x;
				let y1 = dO[1].y;
				if (x1 < x0) {
					[x0, x1] = [x1, x0];
					[u[0], u[2]] = [u[2], u[0]];
				}
				if (y1 < y0) {
					[y0, y1] = [y1, y0];
					[u[1], u[3]] = [u[3], u[1]];
				}
				if (x1 === x0 || y1 === y0) continue;
				const off = this.up.alloc(new Uint8Array(u.buffer), ALIGN);
				const bg = this.dev.createBindGroup({
					layout: h.bgl,
					entries: [
						{
							binding: 0,
							resource: this.renderableView(src, ss.mipLevel || 0, (ss.baseArrayLayer || 0) + l)
						},
						{
							binding: 1,
							resource: h.sampler
						},
						{
							binding: 2,
							resource: {
								buffer: this.up.buf,
								offset: off,
								size: 16
							}
						}
					]
				});
				const pass = this.enc.beginRenderPass({ colorAttachments: [{
					view: this.renderableView(dst, dsub.mipLevel || 0, (dsub.baseArrayLayer || 0) + l),
					loadOp: "load",
					storeOp: "store"
				}] });
				pass.setPipeline(h.pipeline);
				pass.setBindGroup(0, bg);
				pass.setViewport(x0, y0, x1 - x0, y1 - y0, 0, 1);
				pass.draw(4);
				pass.end();
			}
		}
	}
	resolve(k) {
		const src = this.c.get(k.srcImage, "image");
		const dst = this.c.get(k.dstImage, "image");
		for (const r of k.regions || []) {
			const e = r.extent || {};
			const ss = r.srcSubresource || {};
			const ds = r.dstSubresource || {};
			const sw = Math.max(1, src.width >> (ss.mipLevel || 0));
			const sh = Math.max(1, src.height >> (ss.mipLevel || 0));
			const dw = Math.max(1, dst.width >> (ds.mipLevel || 0));
			const dh = Math.max(1, dst.height >> (ds.mipLevel || 0));
			const so = r.srcOffset || {};
			const dO = r.dstOffset || {};
			const whole = !so.x && !so.y && !dO.x && !dO.y && e.width === dw && e.height === dh && sw === dw && sh === dh;
			let target = this.renderableView(dst, ds.mipLevel || 0, ds.baseArrayLayer || 0);
			let tmp;
			if (!whole) {
				tmp = this.dev.createTexture({
					size: [
						sw,
						sh,
						1
					],
					format: dst.format,
					usage: TU.RENDER_ATTACHMENT | TU.COPY_SRC,
					label: "kwvk resolve"
				});
				target = tmp.createView();
			}
			this.enc.beginRenderPass({ colorAttachments: [{
				view: this.renderableView(src, ss.mipLevel || 0, ss.baseArrayLayer || 0),
				resolveTarget: target,
				loadOp: "load",
				storeOp: "store"
			}] }).end();
			if (tmp) {
				this.enc.copyTextureToTexture({
					texture: tmp,
					origin: [
						so.x || 0,
						so.y || 0,
						0
					]
				}, {
					texture: dst.tex,
					mipLevel: ds.mipLevel || 0,
					origin: [
						dO.x || 0,
						dO.y || 0,
						ds.baseArrayLayer || 0
					]
				}, [
					e.width,
					e.height,
					1
				]);
				this.scratch.push(tmp);
			}
		}
	}
	clearAttachments(k) {
		if (this.passKind !== "render") throw new Error("vkCmdClearAttachments outside a render pass");
		const rp = this.rp;
		const sp = rp.pass.subpasses[rp.subpass];
		for (const a of k.attachments || []) {
			const isColor = (a.aspectMask & 1) !== 0;
			const target = isColor ? a.colorAttachment : -1;
			const fmt = isColor ? sp.colorFormats[target] : sp.depthFormat;
			if (!fmt) continue;
			const h = clearPipeline(this.c, sp, target, a.aspectMask);
			const kind = texFormatInfo(fmt)?.kind;
			const data = /* @__PURE__ */ new ArrayBuffer(32);
			if (isColor) {
				const cc = clearColorOf(a.clearValue, fmt);
				if (kind === "uint") new Uint32Array(data, 0, 4).set([
					cc.r,
					cc.g,
					cc.b,
					cc.a
				]);
				else if (kind === "sint") new Int32Array(data, 0, 4).set([
					cc.r,
					cc.g,
					cc.b,
					cc.a
				]);
				else new Float32Array(data, 0, 4).set([
					cc.r,
					cc.g,
					cc.b,
					cc.a
				]);
			}
			const dc = depthClearOf(a.clearValue);
			new Float32Array(data, 16, 1)[0] = dc.depth;
			const off = this.up.alloc(new Uint8Array(data), ALIGN);
			const bg = this.dev.createBindGroup({
				layout: h.bgl,
				entries: [{
					binding: 0,
					resource: {
						buffer: this.up.buf,
						offset: off,
						size: 32
					}
				}]
			});
			this.pass.setPipeline(h.pipeline);
			this.pass.setBindGroup(0, bg);
			if (a.aspectMask & 4) this.pass.setStencilReference(dc.stencil);
			for (const r of k.rects || []) {
				const x = Math.max(0, r.rect.offset.x);
				const y = Math.max(0, r.rect.offset.y);
				const w = Math.min(r.rect.extent.width, rp.width - x);
				const hh = Math.min(r.rect.extent.height, rp.height - y);
				if (w <= 0 || hh <= 0) continue;
				this.pass.setScissorRect(x, y, w, hh);
				this.pass.draw(4);
			}
		}
		this.bound = {
			groups: [],
			vbs: []
		};
		this.pass.setViewport(0, 0, rp.width, rp.height, 0, 1);
		this.pass.setScissorRect(0, 0, rp.width, rp.height);
		this.applyDynamic();
	}
	run(k) {
		if (!NO_VARIANT_CHANGE.has(k.c)) this.stateVer++;
		switch (k.c) {
			case "vkCmdBeginRenderPass2":
			case "vkCmdBeginRenderPass": {
				this.outside();
				const pass = this.c.get(k.renderPass, "renderPass");
				const fb = this.c.get(k.framebuffer, "framebuffer");
				this.rp = {
					pass,
					fb,
					subpass: 0,
					clear: k.clearValues || [],
					width: fb.width,
					height: fb.height,
					area: k.renderArea
				};
				this.beginSubpass();
				break;
			}
			case "vkCmdBeginRendering":
				this.outside();
				this.beginRendering(k);
				break;
			case "vkCmdEndRendering":
				this.endPass();
				this.rp = void 0;
				break;
			case "vkCmdSetCullMode":
				this.ext.cullMode = k.cullMode;
				break;
			case "vkCmdSetFrontFace":
				this.ext.frontFace = k.frontFace;
				break;
			case "vkCmdSetPrimitiveTopology":
				this.ext.topology = k.primitiveTopology;
				break;
			case "vkCmdSetDepthTestEnable":
				this.ext.depthTestEnable = k.depthTestEnable;
				break;
			case "vkCmdSetDepthWriteEnable":
				this.ext.depthWriteEnable = k.depthWriteEnable;
				break;
			case "vkCmdSetDepthCompareOp":
				this.ext.depthCompareOp = k.depthCompareOp;
				break;
			case "vkCmdSetStencilTestEnable":
				this.ext.stencilTestEnable = k.stencilTestEnable;
				break;
			case "vkCmdSetDepthBiasEnable":
				this.ext.depthBiasEnable = k.depthBiasEnable;
				break;
			case "vkCmdSetStencilOp": {
				const face = {
					failOp: k.failOp,
					passOp: k.passOp,
					depthFailOp: k.depthFailOp,
					compareOp: k.compareOp
				};
				const so = { ...this.ext.stencilOp || {} };
				if (k.faceMask & 1) so.front = face;
				if (k.faceMask & 2) so.back = face;
				this.ext.stencilOp = so;
				break;
			}
			case "vkCmdSetPrimitiveRestartEnable":
			case "vkCmdSetDepthBoundsTestEnable": break;
			case "vkCmdSetRasterizerDiscardEnable":
				if (k.rasterizerDiscardEnable) this.c.log("kwvk: vkCmdSetRasterizerDiscardEnable: unsupported");
				break;
			case "vkCmdNextSubpass2":
			case "vkCmdNextSubpass":
				this.endPass();
				this.rp.subpass++;
				this.beginSubpass();
				break;
			case "vkCmdEndRenderPass2":
			case "vkCmdEndRenderPass":
				this.endPass();
				this.rp = void 0;
				break;
			case "vkCmdBindPipeline": {
				const p = this.c.get(k.pipeline, "pipeline");
				if (p.failed) throw new Error(`pipeline ${k.pipeline} cannot run: ${p.failed}`);
				if (p.kind === "compute") this.comp.pipeline = p;
				else {
					this.gfx.pipeline = p;
					const m = p.msg;
					if (!p.dynamic.has(0) && m.viewportState?.viewports?.[0]) this.viewport = m.viewportState.viewports[0];
					if (!p.dynamic.has(1) && m.viewportState?.scissors?.[0]) this.scissor = m.viewportState.scissors[0];
					if (!p.dynamic.has(4) && m.colorBlendState?.blendConstants) this.blend = m.colorBlendState.blendConstants;
					if (!p.dynamic.has(8) && m.depthStencilState?.front) this.stencilRef = m.depthStencilState.front.reference || 0;
					this.applyDynamic();
				}
				break;
			}
			case "vkCmdBindDescriptorSets": {
				const st = k.pipelineBindPoint === 1 ? this.comp : this.gfx;
				const offs = k.dynamicOffsets || [];
				let di = 0;
				(k.descriptorSets || []).forEach((id, i) => {
					const set = id ? this.c.get(id, "set") : void 0;
					const s = (k.firstSet || 0) + i;
					if (st.sets[s] !== set) this.stateVer++;
					st.sets[s] = set;
					const n = set ? set.layout.dynamic.length : 0;
					st.dyn[s] = offs.slice(di, di + n);
					di += n;
				});
				break;
			}
			case "vkCmdBindVertexBuffers":
			case "vkCmdBindVertexBuffers2":
				(k.buffers || []).forEach((id, i) => {
					const binding = (k.firstBinding || 0) + i;
					if (!id) return;
					this.vbs.set(binding, {
						buf: this.buffer(id).buf,
						offset: k.offsets?.[i] || 0
					});
					if (k.strides?.length) this.ext.strides = {
						...this.ext.strides || {},
						[binding]: k.strides[i]
					};
				});
				break;
			case "vkCmdBindIndexBuffer":
				if (k.indexType !== 0 && k.indexType !== 1) throw new Error(`index type ${k.indexType} is unsupported`);
				this.ib = {
					buf: this.buffer(k.buffer).buf,
					offset: k.offset || 0,
					format: k.indexType === 0 ? "uint16" : "uint32"
				};
				break;
			case "vkCmdSetViewportWithCount":
			case "vkCmdSetViewport":
				if ((k.firstViewport || 0) === 0 && k.viewports?.[0]) this.viewport = k.viewports[0];
				this.applyDynamic();
				break;
			case "vkCmdSetScissorWithCount":
			case "vkCmdSetScissor":
				if ((k.firstScissor || 0) === 0 && k.scissors?.[0]) this.scissor = k.scissors[0];
				this.applyDynamic();
				break;
			case "vkCmdSetBlendConstants":
				this.blend = k.blendConstants;
				if (this.passKind === "render") this.pass.setBlendConstant({
					r: this.blend[0],
					g: this.blend[1],
					b: this.blend[2],
					a: this.blend[3]
				});
				break;
			case "vkCmdSetStencilReference":
				this.stencilRef = k.reference || 0;
				if (this.passKind === "render") this.pass.setStencilReference(this.stencilRef);
				break;
			case "vkCmdSetStencilCompareMask":
				this.readMask = k.compareMask;
				break;
			case "vkCmdSetStencilWriteMask":
				this.writeMask = k.writeMask;
				break;
			case "vkCmdSetDepthBias":
				this.bias = [
					k.depthBiasConstantFactor || 0,
					k.depthBiasClamp || 0,
					k.depthBiasSlopeFactor || 0
				];
				break;
			case "vkCmdSetLineWidth":
			case "vkCmdSetDepthBounds":
			case "vkCmdPipelineBarrier":
			case "vkCmdSetEvent":
			case "vkCmdResetEvent":
			case "vkCmdWaitEvents":
			case "vkCmdPipelineBarrier2":
			case "vkCmdSetEvent2":
			case "vkCmdResetEvent2":
			case "vkCmdWaitEvents2":
			case "vkCmdWriteTimestamp2": break;
			case "vkCmdResetQueryPool": {
				this.outside();
				const p = this.c.get(k.queryPool, "queryPool");
				const first = k.firstQuery | 0;
				const n = Math.min(k.queryCount | 0, p.count - first);
				if (first >= 0 && n > 0) {
					this.enc.clearBuffer(p.results, first * 8, n * 8);
					p.avail.fill(0, first, first + n);
					p.written.fill(0, first, first + n);
				}
				break;
			}
			case "vkCmdBeginQuery": {
				const { p, q } = this.queryPool(k);
				if (p.type !== 0) {
					this.c.log("kwvk: vkCmdBeginQuery: pipeline statistics queries read as zeros");
					this.touchAvail(p, q);
					break;
				}
				if (this.passKind !== "render" || this.occlusionPool !== p) throw new Error("occlusion queries must begin inside a render pass (one pool per pass)");
				if (this.activeQuery !== void 0) this.pass.endOcclusionQuery();
				this.pass.beginOcclusionQuery(q);
				this.activeQuery = q;
				this.touch(p, q);
				break;
			}
			case "vkCmdEndQuery":
				if (this.activeQuery !== void 0 && this.passKind === "render") {
					this.pass.endOcclusionQuery();
					this.activeQuery = void 0;
				}
				break;
			case "vkCmdWriteTimestamp":
			case "vkCmdWriteTimestamp2": {
				const { p, q } = this.queryPool(k);
				if (!p.set || p.type !== 2) {
					this.touchAvail(p, q);
					break;
				}
				if (this.passKind === "render") {
					this.c.log("kwvk: vkCmdWriteTimestamp: inside a render pass reads as zero");
					this.touchAvail(p, q);
					break;
				}
				if (this.passKind === "compute") this.endPass();
				const tp = this.enc.beginComputePass({
					label: "kwvk timestamp",
					timestampWrites: {
						querySet: p.set,
						beginningOfPassWriteIndex: q
					}
				});
				tp.setPipeline(nopPipeline(this.c));
				tp.dispatchWorkgroups(1);
				tp.end();
				this.touch(p, q);
				break;
			}
			case "vkCmdCopyQueryPoolResults": {
				this.outside();
				const p = this.c.get(k.queryPool, "queryPool");
				const d = this.buffer(k.dstBuffer).buf;
				const first = k.firstQuery | 0;
				const n = Math.min(k.queryCount | 0, p.count - first);
				const wide = (k.flags & 1) !== 0;
				const avail = (k.flags & 4) !== 0;
				const w = wide ? 8 : 4;
				const stride = k.stride || w * (avail ? 2 : 1);
				if (stride & 3 || (k.dstOffset || 0) & 3) throw new Error("unaligned query copy");
				resolveQueries(this.dev, this.enc, p, first, n, this.scratch);
				const one = this.up.alloc(new Uint8Array([
					1,
					0,
					0,
					0,
					0,
					0,
					0,
					0
				]), 4);
				for (let i = 0; i < n; i++) {
					const at = (k.dstOffset || 0) + i * stride;
					if (at + w * (avail ? 2 : 1) > d.size) throw new Error("query copy past the buffer");
					this.enc.copyBufferToBuffer(p.results, (first + i) * 8, d, at, w);
					if (avail) {
						if (p.avail[first + i]) this.enc.copyBufferToBuffer(this.up.buf, one, d, at + w, w);
						else this.enc.clearBuffer(d, at + w, w);
					}
				}
				break;
			}
			case "vkCmdPushConstants": {
				const v = k.values || [];
				const off = k.offset || 0;
				if (off + v.length > 256) throw new Error("push constants past 256 bytes");
				this.push.set(v, off);
				this.pushVer++;
				break;
			}
			case "vkCmdDraw":
				if ((k.firstVertex || k.firstInstance) && this.gfx.pipeline?.usesBase) this.baseWarn();
				if (this.fan()) {
					if (!(k.vertexCount >= 0 && k.vertexCount <= 1 << 22)) throw new Error("fan vertex count out of range");
					if (this.flushDraw(true, this.fanIndices(k.vertexCount))) this.pass.drawIndexed(3 * Math.max(0, k.vertexCount - 2), k.instanceCount ?? 1, 0, k.firstVertex || 0, k.firstInstance || 0);
				} else if (this.flushDraw(false)) this.pass.draw(k.vertexCount, k.instanceCount ?? 1, k.firstVertex || 0, k.firstInstance || 0);
				break;
			case "vkCmdDrawIndexed":
				if ((k.vertexOffset || k.firstInstance) && this.gfx.pipeline?.usesBase) this.baseWarn();
				if (this.fan()) this.c.log("kwvk: vkCmdDrawIndexed: indexed triangle fans are unsupported (drawn as lists)");
				if (this.flushDraw(true)) this.pass.drawIndexed(k.indexCount, k.instanceCount ?? 1, k.firstIndex || 0, k.vertexOffset || 0, k.firstInstance || 0);
				break;
			case "vkCmdDrawIndirect":
			case "vkCmdDrawIndexedIndirect": {
				const indexed = k.c === "vkCmdDrawIndexedIndirect";
				this.flushDraw(indexed);
				const b = this.buffer(k.buffer).buf;
				const stride = Math.max(4, k.stride || (indexed ? 20 : 16));
				const n = Math.min(k.drawCount ?? 1, Math.floor((b.size - (k.offset || 0)) / stride) + 1);
				for (let i = 0; i < n; i++) if (indexed) this.pass.drawIndexedIndirect(b, (k.offset || 0) + i * stride);
				else this.pass.drawIndirect(b, (k.offset || 0) + i * stride);
				break;
			}
			case "vkCmdDispatch": {
				const ds = this.comp.pipeline?.stage?.res?.dispatchScale || [
					1,
					1,
					1
				];
				const pass = this.flushDispatch();
				if (!noGpu()) pass.dispatchWorkgroups((k.groupCountX ?? 1) * ds[0], (k.groupCountY ?? 1) * ds[1], (k.groupCountZ ?? 1) * ds[2]);
				break;
			}
			case "vkCmdDispatchIndirect":
				if (this.comp.pipeline?.stage?.res?.dispatchScale) throw new Error("vkCmdDispatchIndirect of a pipeline whose workgroup was split to fit the device (dispatchScale) is unsupported");
				this.flushDispatch().dispatchWorkgroupsIndirect(this.buffer(k.buffer).buf, k.offset || 0);
				break;
			case "vkCmdCopyBuffer": {
				this.outside();
				const sb = this.buffer(k.srcBuffer);
				const db = this.buffer(k.dstBuffer);
				const s = sb.buf;
				const d = db.buf;
				for (const r of k.regions || []) {
					const so = r.srcOffset || 0;
					const dO = r.dstOffset || 0;
					const size = r.size;
					if (!(so >= 0 && dO >= 0 && size >= 0 && so + size <= sb.size && dO + size <= db.size)) throw new Error("buffer copy out of range");
					if (!((so | dO) & 3)) {
						const head = size & -4;
						if (head) this.enc.copyBufferToBuffer(s, so, d, dO, head);
						if (size & 3) this.byteCopy(s, so + head, d, dO + head, size & 3);
					} else this.byteCopy(s, so, d, dO, size);
				}
				break;
			}
			case "vkCmdCopyBufferToImage":
				this.outside();
				for (const r of k.regions || []) this.copyBufImg(true, k.srcBuffer, k.dstImage, r);
				break;
			case "vkCmdCopyImageToBuffer":
				this.outside();
				for (const r of k.regions || []) this.copyBufImg(false, k.dstBuffer, k.srcImage, r);
				break;
			case "vkCmdCopyImage": {
				this.outside();
				const s = this.c.get(k.srcImage, "image");
				const d = this.c.get(k.dstImage, "image");
				for (const r of k.regions || []) {
					const ss = r.srcSubresource || {};
					const ds = r.dstSubresource || {};
					const e = r.extent;
					this.enc.copyTextureToTexture({
						texture: s.tex,
						mipLevel: ss.mipLevel || 0,
						origin: [
							r.srcOffset?.x || 0,
							r.srcOffset?.y || 0,
							s.is3D ? r.srcOffset?.z || 0 : ss.baseArrayLayer || 0
						]
					}, {
						texture: d.tex,
						mipLevel: ds.mipLevel || 0,
						origin: [
							r.dstOffset?.x || 0,
							r.dstOffset?.y || 0,
							d.is3D ? r.dstOffset?.z || 0 : ds.baseArrayLayer || 0
						]
					}, [
						e.width,
						e.height,
						s.is3D ? e.depth || 1 : ss.layerCount || 1
					]);
				}
				break;
			}
			case "vkCmdBlitImage":
				this.outside();
				this.blit(k);
				break;
			case "vkCmdResolveImage":
				this.outside();
				this.resolve(k);
				break;
			case "vkCmdClearColorImage":
				this.outside();
				this.clearImage(k.image, k.ranges, k.color, void 0);
				break;
			case "vkCmdClearDepthStencilImage":
				this.outside();
				this.clearImage(k.image, k.ranges, void 0, k.depthStencil || {});
				break;
			case "vkCmdClearAttachments":
				this.clearAttachments(k);
				break;
			case "vkCmdUpdateBuffer": {
				this.outside();
				const data = Uint8Array.from(k.data || []);
				const size = data.length + 3 & -4;
				const padded = new Uint8Array(size);
				padded.set(data);
				const off = this.up.alloc(padded, 4);
				this.enc.copyBufferToBuffer(this.up.buf, off, this.buffer(k.dstBuffer).buf, k.dstOffset || 0, size);
				break;
			}
			case "vkCmdFillBuffer": {
				this.outside();
				const b = this.buffer(k.dstBuffer);
				const off = k.dstOffset || 0;
				const size = isWhole(k.size) ? b.size - off & -4 : k.size;
				if (!(off >= 0 && size >= 0 && off + size <= b.buf.size)) throw new Error("fill out of range");
				if (!k.data) this.enc.clearBuffer(b.buf, off, size);
				else {
					const words = new Uint32Array(size >> 2).fill(k.data >>> 0);
					const src = this.up.alloc(new Uint8Array(words.buffer), 4);
					this.enc.copyBufferToBuffer(this.up.buf, src, b.buf, off, size);
				}
				break;
			}
			default: throw new Error("unsupported command");
		}
	}
};
function runSubmit(c, cmds) {
	if (!Array.isArray(cmds)) throw new VkDeviceLost("cmds is not an array");
	const t0 = performance.now();
	const ex = new Exec(c, cmds);
	const abandon = (what, e) => {
		try {
			if (ex.pass) ex.pass.end();
		} catch {}
		try {
			ex.up.buf.unmap();
			ex.up.buf.destroy();
		} catch {}
		for (const t of ex.scratch) try {
			t.destroy();
		} catch {}
		c.stats.encodeMs += performance.now() - t0;
		return new VkDeviceLost(`${what}: ${e?.message ?? e}`);
	};
	for (let i = 0; i < cmds.length; i++) {
		const k = cmds[i];
		ex.index = i;
		try {
			if (!k || typeof k !== "object" || typeof k.c !== "string") throw new Error("bad command");
			ex.run(k);
		} catch (e) {
			throw abandon(`command ${i} (${typeof k?.c === "string" ? k.c.slice(0, 64) : "?"})`, e);
		}
	}
	try {
		if (ex.pass) ex.endPass();
	} catch (e) {
		throw abandon("the end of the command list", e);
	}
	ex.up.buf.unmap();
	c.dev.queue.submit([ex.enc.finish()]);
	ex.up.buf.destroy();
	c.stats.encodeMs += performance.now() - t0;
	const done = c.dev.queue.onSubmittedWorkDone();
	if (ex.scratch.length) done.then(() => ex.scratch.forEach((t) => t.destroy()));
	return done;
}
function resolveQueries(dev, enc, p, first, n, scratch) {
	if (!p.set || first < 0) return;
	let lo = -1, hi = -1;
	for (let i = first; i < first + n; i++) {
		if (!p.written[i]) continue;
		if (lo < 0) lo = i;
		hi = i;
	}
	if (lo < 0) return;
	const buf = dev.createBuffer({
		size: (hi - lo + 1) * 8,
		usage: BU.QUERY_RESOLVE | BU.COPY_SRC,
		label: "kwvk query resolve"
	});
	scratch.push(buf);
	enc.resolveQuerySet(p.set, lo, hi - lo + 1, buf, 0);
	for (let i = lo; i <= hi;) {
		if (!p.written[i]) {
			i++;
			continue;
		}
		let j = i;
		while (j + 1 <= hi && p.written[j + 1]) j++;
		enc.copyBufferToBuffer(buf, (i - lo) * 8, p.results, i * 8, (j - i + 1) * 8);
		i = j + 1;
	}
}
function nopPipeline(c) {
	let h = c.r.helpers.get("nop");
	if (h) return h;
	const module = c.dev.createShaderModule({ code: "@compute @workgroup_size(1) fn main() {}" });
	h = c.dev.createComputePipeline({
		layout: c.dev.createPipelineLayout({ bindGroupLayouts: [] }),
		compute: {
			module,
			entryPoint: "main"
		}
	});
	c.r.helpers.set("nop", h);
	return h;
}
function byteCopyPipeline(c) {
	let h = c.r.helpers.get("bytecopy");
	if (h) return h;
	const dev = c.dev;
	const module = dev.createShaderModule({ code: `
struct P { srcOff: u32, dstOff: u32, size: u32, pad: u32 }
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;
@group(0) @binding(2) var<uniform> p: P;
fn srcByte(i: u32) -> u32 { let b = p.srcOff + i; return (src[b >> 2u] >> ((b & 3u) * 8u)) & 0xffu; }
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
	let w = (p.dstOff >> 2u) + id.x;
	if (w * 4u >= p.dstOff + p.size) { return; }
	var v = dst[w];
	for (var k = 0u; k < 4u; k++) {
		let b = w * 4u + k;
		if (b >= p.dstOff && b < p.dstOff + p.size) {
			v = (v & ~(0xffu << (k * 8u))) | (srcByte(b - p.dstOff) << (k * 8u));
		}
	}
	dst[w] = v;
}
` });
	const bgl = dev.createBindGroupLayout({ entries: [
		{
			binding: 0,
			visibility: 4,
			buffer: { type: "read-only-storage" }
		},
		{
			binding: 1,
			visibility: 4,
			buffer: { type: "storage" }
		},
		{
			binding: 2,
			visibility: 4,
			buffer: { type: "uniform" }
		}
	] });
	h = {
		pipeline: dev.createComputePipeline({
			layout: dev.createPipelineLayout({ bindGroupLayouts: [bgl] }),
			compute: {
				module,
				entryPoint: "main"
			}
		}),
		bgl
	};
	c.r.helpers.set("bytecopy", h);
	return h;
}
function blitPipeline(c, format, linear) {
	const key = `blit:${format}:${linear}`;
	let h = c.r.helpers.get(key);
	if (h) return h;
	const dev = c.dev;
	const module = dev.createShaderModule({ code: `
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
@group(0) @binding(2) var<uniform> u: vec4f;
struct VO { @builtin(position) p: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
	let c = vec2f(f32(i & 1u), f32(i >> 1u));
	var o: VO;
	o.p = vec4f(c.x * 2.0 - 1.0, 1.0 - c.y * 2.0, 0.0, 1.0);
	o.uv = mix(u.xy, u.zw, c);
	return o;
}
@fragment fn fs(v: VO) -> @location(0) vec4f { return textureSampleLevel(t, s, v.uv, 0.0); }
` });
	const bgl = dev.createBindGroupLayout({ entries: [
		{
			binding: 0,
			visibility: 2,
			texture: { sampleType: linear ? "float" : "unfilterable-float" }
		},
		{
			binding: 1,
			visibility: 2,
			sampler: { type: linear ? "filtering" : "non-filtering" }
		},
		{
			binding: 2,
			visibility: 1,
			buffer: { type: "uniform" }
		}
	] });
	h = {
		pipeline: dev.createRenderPipeline({
			layout: dev.createPipelineLayout({ bindGroupLayouts: [bgl] }),
			vertex: {
				module,
				entryPoint: "vs"
			},
			fragment: {
				module,
				entryPoint: "fs",
				targets: [{ format }]
			},
			primitive: { topology: "triangle-strip" }
		}),
		bgl,
		sampler: dev.createSampler({
			magFilter: linear ? "linear" : "nearest",
			minFilter: linear ? "linear" : "nearest"
		})
	};
	c.r.helpers.set(key, h);
	return h;
}
function clearPipeline(c, sp, target, aspect) {
	const key = `clear:${sp.key}:${target}:${aspect}`;
	let h = c.r.helpers.get(key);
	if (h) return h;
	const dev = c.dev;
	const outs = [];
	const sets = [];
	sp.colorFormats.forEach((f, i) => {
		if (!f) return;
		const kind = texFormatInfo(f)?.kind;
		const ty = kind === "uint" ? "vec4u" : kind === "sint" ? "vec4i" : "vec4f";
		outs.push(`@location(${i}) o${i}: ${ty}`);
		sets.push(`o.o${i} = bitcast<${ty}>(u.c);`);
	});
	const depth = !!sp.depthFormat && hasDepth(sp.depthFormat);
	if (depth) {
		outs.push("@builtin(frag_depth) d: f32");
		sets.push("o.d = u.d.x;");
	}
	const code = `
struct U { c: vec4u, d: vec4f }
@group(0) @binding(0) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
	let c = vec2f(f32(i & 1u), f32(i >> 1u));
	return vec4f(c.x * 2.0 - 1.0, 1.0 - c.y * 2.0, 0.0, 1.0);
}
${outs.length ? `struct FO { ${outs.join(", ")} }
@fragment fn fs() -> FO { var o: FO; ${sets.join(" ")} return o; }` : "@fragment fn fs() {}"}
`;
	const module = dev.createShaderModule({ code });
	const bgl = dev.createBindGroupLayout({ entries: [{
		binding: 0,
		visibility: 3,
		buffer: { type: "uniform" }
	}] });
	const desc = {
		layout: dev.createPipelineLayout({ bindGroupLayouts: [bgl] }),
		vertex: {
			module,
			entryPoint: "vs"
		},
		fragment: {
			module,
			entryPoint: "fs",
			targets: sp.colorFormats.map((f, i) => f ? {
				format: f,
				writeMask: i === target ? 15 : 0
			} : null)
		},
		primitive: { topology: "triangle-strip" },
		multisample: { count: sp.samples }
	};
	if (sp.depthFormat) {
		const stencil = hasStencil(sp.depthFormat) && aspect & 4;
		const face = {
			compare: "always",
			passOp: stencil ? "replace" : "keep",
			failOp: "keep",
			depthFailOp: "keep"
		};
		desc.depthStencil = {
			format: sp.depthFormat,
			depthWriteEnabled: depth && !!(aspect & 2),
			depthCompare: "always",
			stencilFront: face,
			stencilBack: face,
			stencilWriteMask: stencil ? 255 : 0
		};
		if (!hasStencil(sp.depthFormat)) {
			delete desc.depthStencil.stencilFront;
			delete desc.depthStencil.stencilBack;
			delete desc.depthStencil.stencilWriteMask;
		}
	}
	h = {
		pipeline: dev.createRenderPipeline(desc),
		bgl
	};
	c.r.helpers.set(key, h);
	return h;
}
const GAUGES = /* @__PURE__ */ new Set(["liveObjects", "liveGpu"]);
function newStats() {
	return {
		messages: 0,
		submits: 0,
		draws: 0,
		dispatches: 0,
		presents: 0,
		bytesWritten: 0,
		bytesRead: 0,
		translations: 0,
		translateMs: 0,
		pipelines: 0,
		errors: 0,
		lost: 0,
		encodeMs: 0,
		parseMs: 0,
		liveObjects: 0,
		liveGpu: 0,
		externalPresents: 0,
		externalImages: 0
	};
}
const DRM_FORMATS = {
	875713089: {
		base: "bgra8unorm",
		opaque: false
	},
	875713112: {
		base: "bgra8unorm",
		opaque: true
	},
	875708993: {
		base: "rgba8unorm",
		opaque: false
	},
	875709016: {
		base: "rgba8unorm",
		opaque: true
	}
};
const usedTokens = /* @__PURE__ */ new Set();
function newToken() {
	const a = /* @__PURE__ */ new Uint32Array(1);
	for (;;) {
		globalThis.crypto.getRandomValues(a);
		if (a[0] && !usedTokens.has(a[0])) {
			usedTokens.add(a[0]);
			return a[0];
		}
	}
}
const VK_SUBGROUP_SIZE = 32;
const NO_FLIP_ENGINES = /* @__PURE__ */ new Set(["wgpu-hal"]);
const VK_MAX_FRAME = 1 << 28;
const VK_MAX_OBJECTS = 1 << 20;
const BIG_FRAME = 1 << 20;
const BU = {
	MAP_READ: 1,
	MAP_WRITE: 2,
	COPY_SRC: 4,
	COPY_DST: 8,
	INDEX: 16,
	VERTEX: 32,
	UNIFORM: 64,
	STORAGE: 128,
	INDIRECT: 256,
	QUERY_RESOLVE: 512
};
const TU = {
	COPY_SRC: 1,
	COPY_DST: 2,
	TEXTURE_BINDING: 4,
	STORAGE_BINDING: 8,
	RENDER_ATTACHMENT: 16
};
const SS = {
	VERTEX: 1,
	FRAGMENT: 2,
	COMPUTE: 4
};
const MAP_READ = 1;
const UNUSED = 4294967295;
function isWhole(v) {
	return v === void 0 || v === null || v < 0 || v >= 2 ** 52;
}
const COMPARE = [
	"never",
	"less",
	"equal",
	"less-equal",
	"greater",
	"not-equal",
	"greater-equal",
	"always"
];
const ADDRESS = [
	"repeat",
	"mirror-repeat",
	"clamp-to-edge",
	"clamp-to-edge",
	"mirror-repeat"
];
const VIEW_DIM = [
	"1d",
	"2d",
	"3d",
	"cube",
	"2d-array",
	"2d-array",
	"cube-array"
];
const DT = {
	SAMPLER: 0,
	COMBINED: 1,
	SAMPLED_IMAGE: 2,
	STORAGE_IMAGE: 3,
	UNIFORM_TEXEL: 4,
	STORAGE_TEXEL: 5,
	UNIFORM: 6,
	STORAGE: 7,
	UNIFORM_DYN: 8,
	STORAGE_DYN: 9,
	INPUT_ATTACHMENT: 10
};
var VkDeviceLost = class extends Error {};
var VkResultError = class extends Error {
	result;
	constructor(message, result) {
		super(message);
		this.result = result;
	}
};
const VK_ERROR_FEATURE_NOT_PRESENT = -8;
const CREATE_OPS = /* @__PURE__ */ new Set([
	"vkCreateBuffer",
	"vkCreateImage",
	"vkCreateImageView",
	"vkCreateSampler",
	"vkCreateShaderModule",
	"vkCreateDescriptorSetLayout",
	"vkCreatePipelineLayout",
	"vkCreateRenderPass",
	"vkCreateRenderPass2",
	"vkCreateFramebuffer",
	"vkCreateGraphicsPipelines",
	"vkCreateComputePipelines",
	"vkCreateQueryPool",
	"vkCreateBufferView",
	"vkAllocateDescriptorSets"
]);
const UNUSABLE = /texel buffers|_1d_array/;
function noGpu() {
	return globalThis.KWVK_NO_GPU === true;
}
function firstLine(text) {
	return (String(text).split("\n").map((x) => x.trim()).filter(Boolean)[0] || "").slice(0, 400);
}
function normalize(v, depth = 0) {
	if (depth > 64) throw new Error("JSON nested too deeply");
	if (Array.isArray(v)) {
		if (v.length && typeof v[0] !== "object") return v;
		for (let i = 0; i < v.length; i++) {
			const e = v[i];
			if (e && typeof e === "object") normalize(e, depth + 1);
		}
		return v;
	}
	if (v && typeof v === "object") for (const k in v) {
		const e = v[k];
		const c1 = k.charCodeAt(1);
		if (k.charCodeAt(0) === 112 && (c1 >= 65 && c1 <= 90 || c1 === 112 && k.charCodeAt(2) >= 65 && k.charCodeAt(2) <= 90)) {
			let key = k.slice(c1 === 112 ? 2 : 1);
			key = key[0].toLowerCase() + key.slice(1);
			delete v[k];
			v[key] = e;
		}
		if (e && typeof e === "object") normalize(e, depth + 1);
	}
	return v;
}
const VK_FEATURES = [
	"depth-clip-control",
	"depth32float-stencil8",
	"texture-compression-bc",
	"texture-compression-etc2",
	"texture-compression-astc",
	"indirect-first-instance",
	"rg11b10ufloat-renderable",
	"bgra8unorm-storage",
	"float32-filterable",
	"float32-blendable",
	"dual-source-blending",
	"clip-distances",
	"texture-component-swizzle",
	"shader-f16",
	"subgroups",
	"timestamp-query"
];
function vkDeviceDescriptor(adapter) {
	const requiredLimits = {};
	for (const k in adapter.limits) {
		const v = adapter.limits[k];
		if (typeof v === "number") requiredLimits[k] = v;
	}
	return {
		label: "kwvk",
		requiredFeatures: VK_FEATURES.filter((f) => adapter.features.has(f)),
		requiredLimits
	};
}
var VkRenderer = class {
	device;
	adapter;
	shaders;
	onPresent;
	logged = /* @__PURE__ */ new Set();
	logFn;
	helpers = /* @__PURE__ */ new Map();
	conns = /* @__PURE__ */ new Map();
	tokens = /* @__PURE__ */ new Map();
	externalOk = false;
	nextConn = 1;
	retired = newStats();
	canvases = /* @__PURE__ */ new Map();
	liveGpu = 0;
	bglCache = /* @__PURE__ */ new Map();
	emptyBGL;
	emptyBG;
	pushBGL;
	fanIndex;
	lost;
	isLost = false;
	onLost;
	constructor(opts) {
		this.device = opts.device;
		this.adapter = opts.adapter;
		this.shaders = opts.shaders;
		if (opts.onPresent) this.onPresent = opts.onPresent;
		if (opts.onLost) this.onLost = opts.onLost;
		this.externalOk = opts.external ?? typeof globalThis.OffscreenCanvas === "function";
		this.logFn = opts.log || ((line) => console.warn(line));
		this.emptyBGL = this.device.createBindGroupLayout({ entries: [] });
		this.emptyBG = this.device.createBindGroup({
			layout: this.emptyBGL,
			entries: []
		});
		this.pushBGL = this.device.createBindGroupLayout({ entries: [{
			binding: 0,
			visibility: SS.VERTEX | SS.FRAGMENT | SS.COMPUTE,
			buffer: {
				type: "uniform",
				hasDynamicOffset: true
			}
		}] });
		const lost = this.device.lost && typeof this.device.lost.then === "function" ? this.device.lost : new Promise(() => {});
		this.lost = lost.then((info) => {
			const i = {
				reason: info?.reason,
				message: info?.message
			};
			this.isLost = true;
			this.log(`kwvk: device lost (${i.reason ?? "?"}: ${i.message ?? ""}): failing ${this.conns.size} connection(s)`);
			for (const c of [...this.conns.values()]) c.lose(`the WebGPU device was lost (${i.message || i.reason || "?"})`);
			try {
				this.onLost?.(i);
			} catch {}
			return i;
		});
		try {
			this.device.addEventListener?.("uncapturederror", (e) => {
				this.retired.errors++;
				this.log(`kwvk: webgpu: ${e?.error?.message ?? e}`);
			});
		} catch {}
	}
	log(line) {
		line = line.split("\n").map((l) => l.trim()).filter(Boolean).join(" / ");
		if (line.length > 600) line = line.slice(0, 600) + "...";
		if (this.logged.has(line)) return;
		if (this.logged.size > 4096) this.logged.clear();
		this.logged.add(line);
		this.logFn(line);
	}
	connect(send, close) {
		const c = new Conn(this, send, this.nextConn++, close);
		if (this.isLost) c.lose("the WebGPU device was lost");
		else this.conns.set(c.id, c);
		return c;
	}
	get stats() {
		const out = { ...this.retired };
		for (const c of this.conns.values()) for (const k in out) if (!GAUGES.has(k)) out[k] += c.stats[k];
		out.liveObjects = 0;
		for (const c of this.conns.values()) out.liveObjects += c.objs.size;
		out.liveGpu = this.liveGpu;
		return out;
	}
	gpuCreated() {
		this.liveGpu++;
	}
	gpuDestroy(gpu) {
		const done = () => {
			try {
				gpu.destroy();
			} catch {}
			this.liveGpu--;
		};
		if (this.isLost) done();
		else this.device.queue.onSubmittedWorkDone().then(done, done);
	}
	image(connection, imageId) {
		const c = typeof connection === "number" ? this.conns.get(connection) : connection;
		const img = c?.objs.get(imageId);
		if (!c || !img || img.t !== "image" || img.samples > 1) return void 0;
		return this.picture(img, false);
	}
	external(ref) {
		if (this.isLost || typeof ref?.id !== "bigint") return null;
		const c = this.tokens.get(Number(ref.id >> 32n));
		const e = c?.exported.get(Number(ref.id & 4294967295n));
		if (!c || c.closed || !e || c.objs.get(e.id) !== e.img || !e.img.presented) return null;
		const img = e.img, f = DRM_FORMATS[ref.format];
		if (!f || ref.flags !== 0 || ref.width !== img.width || ref.height !== img.height || img.format.replace(/-srgb$/, "") !== f.base) return null;
		let bmp = null;
		try {
			bmp = this.picture(img, f.opaque) ?? null;
		} catch (err) {
			this.log(`kwvk: external image: ${err.message}`);
		}
		if (bmp) c.stats.externalImages++;
		return bmp;
	}
	picture(img, opaque) {
		const base = img.format.replace(/-srgb$/, "");
		if (base !== "bgra8unorm" && base !== "rgba8unorm" && base !== "rgba16float") return void 0;
		const OC = globalThis.OffscreenCanvas;
		if (!OC) return void 0;
		const key = `${img.width}x${img.height}:${base}:${opaque ? "opaque" : "premultiplied"}`;
		let cv = this.canvases.get(key);
		if (!cv) {
			const canvas = new OC(img.width, img.height);
			const ctx = canvas.getContext("webgpu");
			if (!ctx) return void 0;
			ctx.configure({
				device: this.device,
				format: base,
				usage: TU.COPY_DST | TU.RENDER_ATTACHMENT,
				alphaMode: opaque ? "opaque" : "premultiplied"
			});
			cv = {
				canvas,
				ctx
			};
			if (this.canvases.size > 8) this.canvases.clear();
			this.canvases.set(key, cv);
		}
		const e = this.device.createCommandEncoder({ label: "kwvk image" });
		e.copyTextureToTexture({ texture: img.tex }, { texture: cv.ctx.getCurrentTexture() }, [
			img.width,
			img.height,
			1
		]);
		this.device.queue.submit([e.finish()]);
		return cv.canvas.transferToImageBitmap();
	}
};
const enc = new TextEncoder();
const dec = new TextDecoder();
function frame(json, bin) {
	const j = enc.encode(JSON.stringify(json));
	const padded = j.length + 3 & -4;
	const blen = bin ? bin.length : 0;
	const out = new Uint8Array(8 + padded + blen);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, padded + blen, true);
	dv.setUint32(4, j.length, true);
	out.set(j, 8);
	if (bin) out.set(bin, 8 + padded);
	return out;
}
var Conn = class {
	r;
	id;
	stats = newStats();
	dev;
	sendFn;
	buf = /* @__PURE__ */ new Uint8Array(4096);
	len = 0;
	chain = Promise.resolve();
	closed = false;
	objs = /* @__PURE__ */ new Map();
	lastPresented;
	token = 0;
	subgroupSize = 1;
	noFlip = false;
	engineName = "";
	flipMissLogged = false;
	exported = /* @__PURE__ */ new Map();
	nextExport = 1;
	closeFn;
	pending = /* @__PURE__ */ new Set();
	checked = Promise.resolve();
	tsRaised = false;
	constructor(r, send, id, close) {
		this.r = r;
		this.id = id;
		this.dev = r.device;
		this.sendFn = send;
		if (close) this.closeFn = close;
	}
	get bglCache() {
		return this.r.bglCache;
	}
	get emptyBGL() {
		return this.r.emptyBGL;
	}
	get emptyBG() {
		return this.r.emptyBG;
	}
	get pushBGL() {
		return this.r.pushBGL;
	}
	get fanIndex() {
		return this.r.fanIndex;
	}
	set fanIndex(v) {
		this.r.fanIndex = v;
	}
	lose(why) {
		if (this.closed) return;
		this.send({
			r: 0,
			lost: why
		});
		for (const r of this.pending) this.send({
			r,
			err: why
		});
		this.pending.clear();
		this.close();
		try {
			this.closeFn?.();
		} catch {}
	}
	log(line) {
		this.r.log(line);
	}
	deviceLost(why) {
		if (this.closed) return;
		this.stats.lost++;
		this.log(`kwvk: connection ${this.id}: device lost for the guest: ${why}`);
		this.lose(why);
	}
	feed(bytes) {
		if (this.closed || !bytes.length) return;
		let src = bytes;
		while (src.length && !this.closed) {
			const big = this.big;
			if (big) {
				const n = Math.min(src.length, big.data.length - big.filled);
				big.data.set(src.subarray(0, n), big.filled);
				big.filled += n;
				src = src.subarray(n);
				if (big.filled < big.data.length) return;
				this.big = void 0;
				this.frameBody(big.data, big.jlen, true);
				continue;
			}
			if (this.len + src.length > this.buf.length) {
				const n = new Uint8Array(Math.max(this.buf.length * 2, this.len + src.length, 4096));
				n.set(this.buf.subarray(0, this.len));
				this.buf = n;
			}
			this.buf.set(src, this.len);
			this.len += src.length;
			src = src.subarray(src.length);
			let off = 0;
			while (this.len - off >= 8) {
				const dv = new DataView(this.buf.buffer, this.buf.byteOffset + off, 8);
				const total = dv.getUint32(0, true);
				const jlen = dv.getUint32(4, true);
				if (total > 268435456 || jlen > total) {
					this.log(`kwvk: frame: bad lengths (total ${total}, json ${jlen}): closing the connection`);
					this.lose("bad frame");
					return;
				}
				if (this.len - off - 8 < total) {
					if (total > BIG_FRAME) {
						const data = new Uint8Array(total);
						data.set(this.buf.subarray(off + 8, this.len));
						this.big = {
							data,
							filled: this.len - off - 8,
							jlen
						};
						off = this.len;
					}
					break;
				}
				const body = this.buf.subarray(off + 8, off + 8 + total);
				off += 8 + total;
				this.frameBody(body, jlen, false);
			}
			if (off) {
				this.buf.copyWithin(0, off, this.len);
				this.len -= off;
				if (this.len === 0 && this.buf.length > 1 << 20) this.buf = /* @__PURE__ */ new Uint8Array(4096);
			}
		}
	}
	big;
	frameBody(body, jlen, owned) {
		const padded = jlen + 3 & -4;
		let msg;
		const t0 = performance.now();
		try {
			msg = normalize(JSON.parse(dec.decode(body.subarray(0, Math.min(jlen, body.length)))));
			this.stats.parseMs += performance.now() - t0;
		} catch (e) {
			this.deviceLost(`a frame with bad JSON (${e.message})`);
			return;
		}
		const rest = body.subarray(Math.min(padded, body.length));
		const bin = owned ? rest : rest.slice();
		this.chain = this.chain.then(() => this.run(msg, bin));
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		this.r.conns.delete(this.id);
		if (this.token && this.r.tokens.get(this.token) === this) this.r.tokens.delete(this.token);
		this.exported.clear();
		for (const k in this.stats) if (!GAUGES.has(k)) this.r.retired[k] += this.stats[k];
		this.buf = /* @__PURE__ */ new Uint8Array(0);
		this.big = void 0;
		this.len = 0;
		for (const id of [...this.objs.keys()]) this.destroyOne(id);
		this.stats.liveObjects = 0;
	}
	send(json, bin) {
		if (this.closed) return;
		try {
			this.sendFn(frame(json, bin));
		} catch (e) {
			this.log(`kwvk: send: ${e.message}`);
		}
	}
	replyTo(msg, res) {
		try {
			if (!msg.r) return;
			this.pending.delete(msg.r);
			this.send({
				...res?.json || {},
				r: msg.r
			}, res?.bin);
		} finally {
			res?.after?.();
		}
	}
	fail(msg, e) {
		const text = e?.message ?? String(e);
		const op = String(msg?.op);
		this.stats.errors++;
		this.log(`kwvk: ${op}: ${text}`);
		if (e instanceof VkDeviceLost) {
			if (msg?.r) this.pending.add(msg.r);
			this.deviceLost(`${op}: ${text}`);
		} else if (msg?.r) {
			this.pending.delete(msg.r);
			const reply = {
				r: msg.r,
				err: text
			};
			if (e instanceof VkResultError) reply.result = e.result;
			this.send(reply);
		} else if (CREATE_OPS.has(op)) this.tombstone(msg, `${op}: ${text}`);
		else this.deviceLost(`${op}: ${text}`);
	}
	createdIds(msg) {
		if (msg?.op === "vkAllocateDescriptorSets") return (Array.isArray(msg.sets) ? msg.sets : []).map((s) => s?.id);
		return [msg?.id];
	}
	tombstone(msg, why) {
		try {
			for (const id of this.createdIds(msg)) if (Number.isInteger(id) && id > 0 && id <= 4294967295) this.put(id, {
				t: "failed",
				why
			});
		} catch (e) {
			this.deviceLost(`${why} (${e.message})`);
		}
	}
	async run(msg, bin) {
		if (this.closed) return;
		if (!msg || typeof msg !== "object" || Array.isArray(msg)) msg = { op: "?" };
		if (msg.r !== void 0 && !(Number.isInteger(msg.r) && msg.r > 0)) msg.r = 0;
		const op = String(msg.op);
		const dev = this.dev;
		this.stats.messages++;
		dev.pushErrorScope("validation");
		let out;
		try {
			const h = handlers[op];
			if (!h) throw new Error("unsupported op");
			out = h(this, msg, bin);
			if (out && typeof out.then === "function") out = await out;
		} catch (e) {
			out = void 0;
			this.fail(msg, e);
			msg = {
				...msg,
				r: 0,
				failed: true
			};
		}
		const made = !msg.r && !msg.failed && CREATE_OPS.has(op) ? this.createdIds(msg).map((id) => [id, this.objs.get(id)]) : void 0;
		dev.popErrorScope().then((err) => {
			if (!err) return;
			this.stats.errors++;
			this.log(`kwvk: ${op}: ${err.message}`);
			if (msg.r || msg.failed || op === "destroy") return;
			const why = `${op}: ${firstLine(err.message)}`;
			if (!made) return this.deviceLost(why);
			for (const [id, o] of made) if (o && this.objs.get(id) === o) this.put(id, {
				t: "failed",
				why
			});
		}, () => {});
		if (out && out.defer) {
			if (msg.r) this.pending.add(msg.r);
			out.defer.then((res) => this.replyTo(msg, res), (e) => this.fail(msg, e));
		} else if (msg.r) this.replyTo(msg, out);
	}
	get(id, what) {
		const o = this.objs.get(id);
		if (!o) throw new Error(`no ${what || "object"} ${id}`);
		if (o.t === "failed") throw new Error(`${what || "object"} ${id} failed at its creation (${o.why})`);
		if (what && o.t !== what) throw new Error(`object ${id} is a ${o.t}, not a ${what}`);
		return o;
	}
	put(id, o) {
		if (!Number.isInteger(id) || id <= 0 || id > 4294967295) throw new Error(`bad id ${id}`);
		if (this.objs.has(id)) this.destroyOne(id);
		else if (this.objs.size >= 1048576) throw new Error("too many objects");
		this.objs.set(id, o);
		this.stats.liveObjects = this.objs.size;
	}
	destroyOne(id) {
		const o = this.objs.get(id);
		if (!o) return;
		this.objs.delete(id);
		this.stats.liveObjects = this.objs.size;
		const gpu = o.t === "buffer" ? o.buf : o.t === "image" ? o.tex : void 0;
		if (gpu) this.r.gpuDestroy(gpu);
		if (o.t === "image" && o.exportId) this.exported.delete(o.exportId);
		if (o.t === "queryPool") {
			if (o.set) this.r.gpuDestroy(o.set);
			this.r.gpuDestroy(o.results);
		}
	}
	viewFor(v, use, sampleType, dimension) {
		const key = `${use}:${sampleType || ""}:${dimension || ""}`;
		let gv = v.cache.get(key);
		if (gv) return gv;
		const img = v.image;
		const r = v.range;
		const desc = {
			format: v.tex,
			baseMipLevel: r.baseMipLevel,
			baseArrayLayer: r.baseArrayLayer
		};
		const levels = isWhole(r.levelCount) || r.levelCount === 4294967295 ? img.mipLevels - r.baseMipLevel : r.levelCount;
		const layers = isWhole(r.layerCount) || r.layerCount === 4294967295 ? img.layers - r.baseArrayLayer : r.layerCount;
		const ds = hasDepth(v.tex) && hasStencil(v.tex);
		if (use === "att") {
			desc.dimension = "2d";
			desc.mipLevelCount = 1;
			desc.arrayLayerCount = 1;
			desc.aspect = "all";
		} else {
			desc.dimension = dimension || VIEW_DIM[v.viewType] || "2d";
			if (v.viewType === 4) this.log("kwvk: vkCreateImageView: 1D array views are unsupported");
			desc.mipLevelCount = use === "storage" ? 1 : levels;
			desc.arrayLayerCount = desc.dimension === "3d" ? 1 : desc.dimension === "2d" || desc.dimension === "1d" ? 1 : layers;
			if (v.swizzle && use === "bind") desc.swizzle = v.swizzle;
			if (ds || hasDepth(v.tex) || hasStencil(v.tex)) {
				const m = r.aspectMask;
				if (sampleType === "uint" || m & 4 && !(m & 2)) desc.aspect = hasDepth(v.tex) ? "stencil-only" : "all";
				else desc.aspect = ds ? "depth-only" : "all";
			}
		}
		gv = img.tex.createView(desc);
		v.cache.set(key, gv);
		return gv;
	}
	translate(mod, opts) {
		const m = typeof mod === "number" ? this.get(mod, "shader") : mod;
		const moduleId = m.id;
		const key = JSON.stringify(opts);
		let t = m.cache.get(key);
		if (!t) {
			const t0 = performance.now();
			let res;
			const { relink, keepReadOnly, ...topts } = opts;
			try {
				res = this.r.shaders.translate(m.code, topts);
				if (relink) res = {
					...res,
					wgsl: relinkVertexOutputs(res.wgsl, relink)
				};
				res = pruneDeadBindings(res);
				if (topts.stage === "compute" && !keepReadOnly) res = {
					...res,
					wgsl: res.wgsl.replace(/var<storage(, ?read)?>/g, "var<storage, read_write>"),
					bindings: res.bindings.map((b) => b.kind === "read-only-storage" ? {
						...b,
						kind: "storage",
						ro: true
					} : b)
				};
				if (topts.stage === "compute" && noGpu()) {
					const l = this.dev.limits;
					res = {
						...res,
						wgsl: res.wgsl.replace(/@workgroup_size\((\d+)(?:, ?(\d+))?(?:, ?(\d+))?\)/, (_s, x, y, z) => {
							let [a, b, c] = [
								Number(x),
								Number(y || 1),
								Number(z || 1)
							];
							while (a * b * c > l.maxComputeInvocationsPerWorkgroup || a > l.maxComputeWorkgroupSizeX) a = Math.max(1, a >> 1);
							while (a * b * c > l.maxComputeInvocationsPerWorkgroup || b > l.maxComputeWorkgroupSizeY) b = Math.max(1, b >> 1);
							while (a * b * c > l.maxComputeInvocationsPerWorkgroup || c > l.maxComputeWorkgroupSizeZ) c = Math.max(1, c >> 1);
							return `@workgroup_size(${a}, ${b}, ${c})`;
						})
					};
				}
			} catch (e) {
				if (globalThis.KWVK_DUMP_SPIRV) this.log(`kwvk: shader ${moduleId} ${opts.stage} SPIR-V (base64): ${b64(m.code)}`);
				throw new Error(`${opts.stage} stage of shader module ${moduleId}: ${e?.message ?? e}`);
			}
			this.stats.translations++;
			this.stats.translateMs += performance.now() - t0;
			const lang = globalThis.navigator?.gpu?.wgslLanguageFeatures;
			const missing = (res.requires || []).filter((f) => !this.dev.features?.has?.(f) && !lang?.has?.(f));
			if (missing.length) throw new Error(`${opts.stage} stage of shader module ${moduleId}: shader needs WebGPU features the device lacks: ${missing.map((f) => f.includes("_") ? `${f} (a WGSL language feature this browser lacks)` : f).join(", ")}`);
			const module = this.dev.createShaderModule({
				code: res.wgsl,
				label: `kwvk shader ${moduleId} ${opts.stage}`
			});
			const check = module.getCompilationInfo ? module.getCompilationInfo().then((info) => {
				const m = (info.messages || []).find((x) => x.type === "error");
				return m ? `${opts.stage} stage of shader module ${moduleId}: WGSL ${m.lineNum}:${m.linePos}: ${firstLine(m.message)}` : void 0;
			}, () => void 0) : Promise.resolve(void 0);
			t = {
				module,
				res,
				check
			};
			m.cache.set(key, t);
		}
		return t;
	}
	bgl(entries) {
		entries.sort((a, b) => a.binding - b.binding);
		const key = JSON.stringify(entries);
		let layout = this.bglCache.get(key);
		if (!layout) {
			layout = entries.length ? this.dev.createBindGroupLayout({ entries }) : this.emptyBGL;
			this.bglCache.set(key, layout);
		}
		return {
			key,
			layout
		};
	}
	pipelineLayout(layoutId, stages) {
		const pl = this.get(layoutId, "pipelineLayout");
		const sets = [];
		const reflected = stages.some((s) => Array.isArray(s.res.bindings));
		for (let s = 0; s < pl.setLayouts.length; s++) {
			const dsl = pl.setLayouts[s] ? this.get(pl.setLayouts[s], "setLayout") : { bindings: /* @__PURE__ */ new Map() };
			const byWgsl = /* @__PURE__ */ new Map();
			const src = /* @__PURE__ */ new Map();
			if (reflected) for (const st of stages) for (const b of st.res.bindings || []) {
				if (b.group !== s) continue;
				const prev = byWgsl.get(b.wgslBinding);
				if (prev) {
					prev.visibility |= st.stage;
					continue;
				}
				byWgsl.set(b.wgslBinding, entryFromReflection(b, st.stage, dsl));
				src.set(b.wgslBinding, [b.binding ?? b.wgslBinding >> 1, b.arrayIndex ?? 0]);
			}
			else {
				const vis = stages.reduce((a, s) => a | s.stage, 0);
				for (const [binding, d] of dsl.bindings) for (const e of entriesFromVk(binding, d, vis)) {
					byWgsl.set(e.binding, e);
					src.set(e.binding, [binding, 0]);
				}
			}
			const entries = [...byWgsl.values()];
			const { key, layout } = this.bgl(entries);
			const dynIdx = [];
			const vkDyn = dsl.dynamic;
			for (const e of [...entries].sort((a, b) => a.binding - b.binding)) if (e.buffer?.hasDynamicOffset) {
				const [b, el] = src.get(e.binding);
				dynIdx.push(vkDyn ? vkDyn.indexOf(`${b}:${el}`) : 0);
			}
			sets.push({
				key,
				layout,
				entries,
				dynIdx,
				src
			});
		}
		const pushSize = Math.max(pl.pushSize, ...stages.map((s) => s.res.pushConstantSize || 0));
		const groups = sets.map((s) => s.layout);
		let pushGroup = -1;
		if (pushSize > 0) {
			pushGroup = sets.length;
			groups.push(this.pushBGL);
		}
		const layout = this.dev.createPipelineLayout({ bindGroupLayouts: groups });
		const hasFloatTex = sets.some((s) => s.entries.some((e) => e.texture?.sampleType === "float"));
		const hasStorageTex = sets.some((s) => s.entries.some((e) => e.storageTexture));
		return {
			layout,
			sets,
			pushGroup,
			pushSize,
			hasFloatTex,
			hasStorageTex
		};
	}
	placeholders = /* @__PURE__ */ new Map();
	unwrittenBufs = /* @__PURE__ */ new Map();
	placeholderBindGroup(s, slot) {
		let bg = this.placeholders.get(slot.key);
		if (bg) return bg;
		this.log(`kwvk: descriptor set ${s} not bound but declared by the pipeline's shaders: placeholder resources bound`);
		const formats = {
			float: "rgba8unorm",
			"unfilterable-float": "r32float",
			uint: "r32uint",
			sint: "r32sint",
			depth: "depth32float"
		};
		const entries = [];
		for (const e of slot.entries) if (e.buffer) {
			const buf = this.dev.createBuffer({
				size: 65536,
				usage: 192
			});
			entries.push({
				binding: e.binding,
				resource: { buffer: buf }
			});
		} else if (e.sampler) entries.push({
			binding: e.binding,
			resource: this.dev.createSampler(e.sampler.type === "comparison" ? { compare: "less" } : {})
		});
		else if (e.texture || e.storageTexture) {
			const t = e.texture || e.storageTexture;
			const dim = t.viewDimension || "2d";
			const layers = dim === "cube" || dim === "cube-array" ? 6 : 1;
			const tex = this.dev.createTexture({
				size: [
					1,
					1,
					layers
				],
				dimension: dim === "1d" ? "1d" : dim === "3d" ? "3d" : "2d",
				format: e.texture ? formats[t.sampleType] || "rgba8unorm" : t.format,
				sampleCount: e.texture?.multisampled ? 4 : 1,
				usage: e.texture ? e.texture.multisampled ? 20 : 4 : 8
			});
			entries.push({
				binding: e.binding,
				resource: tex.createView({ dimension: dim })
			});
		}
		bg = this.dev.createBindGroup({
			layout: slot.layout,
			entries
		});
		this.placeholders.set(slot.key, bg);
		return bg;
	}
	bindGroup(set, slot, override) {
		if (!slot.entries.length) return this.emptyBG;
		if (!set) throw new Error("descriptor set not bound");
		let bg = override ? void 0 : set.cache.get(slot.key);
		if (bg) return bg;
		const entries = [];
		for (const e of slot.entries) {
			const [vkb, el] = slot.src.get(e.binding) || [e.binding >> 1, 0];
			const d = set.desc.get(dkey(vkb, el));
			if (!d && e.buffer) {
				let ub = this.unwrittenBufs.get(e.binding);
				if (!ub) {
					if (!this.unwrittenBufs.size) this.log(`kwvk: set binding ${vkb}${el ? `[${el}]` : ""} not written: a placeholder buffer bound (logged once)`);
					ub = this.dev.createBuffer({
						size: 65536,
						usage: BU.STORAGE | BU.UNIFORM,
						label: "kwvk unwritten binding"
					});
					this.unwrittenBufs.set(e.binding, ub);
				}
				entries.push({
					binding: e.binding,
					resource: { buffer: ub }
				});
				continue;
			}
			if (!d) throw new Error(`set binding ${vkb}${el ? `[${el}]` : ""} not written`);
			if (e.buffer) {
				const b = this.get(d.buffer, "buffer");
				const size = isWhole(d.range) ? b.size - d.offset : d.range;
				const sub = override?.get(e.binding);
				if (sub) entries.push({
					binding: e.binding,
					resource: {
						buffer: sub.buf,
						offset: 0,
						size: sub.size
					}
				});
				else entries.push({
					binding: e.binding,
					resource: {
						buffer: b.buf,
						offset: d.offset,
						size: Math.min(size + 3 & -4, b.buf.size - d.offset)
					}
				});
			} else if (e.sampler) {
				const sid = d.sampler || set.layout.bindings.get(vkb)?.immutable?.[el];
				entries.push({
					binding: e.binding,
					resource: this.get(sid, "sampler").gpu
				});
			} else if (e.texture) {
				const v = this.get(d.imageView, "imageView");
				entries.push({
					binding: e.binding,
					resource: this.viewFor(v, "bind", e.texture.sampleType, e.texture.viewDimension)
				});
			} else if (e.storageTexture) {
				const v = this.get(d.imageView, "imageView");
				entries.push({
					binding: e.binding,
					resource: this.viewFor(v, "storage", void 0, e.storageTexture.viewDimension)
				});
			}
		}
		bg = this.dev.createBindGroup({
			layout: slot.layout,
			entries
		});
		if (!override) set.cache.set(slot.key, bg);
		return bg;
	}
	refine(pl, sets) {
		if (!pl.hasFloatTex) return void 0;
		let key = "";
		pl.sets.forEach((slot, s) => {
			const set = sets[s];
			if (!set) return;
			for (const e of slot.entries) {
				if (e.texture?.sampleType !== "float") continue;
				const [vkb, el] = slot.src?.get(e.binding) || [e.binding >> 1, 0];
				const d = set.desc.get(dkey(vkb, el));
				const v = d?.imageView && this.objs.get(d.imageView);
				if (v && !formatFilterable(v.tex, this.dev.features)) key += `${s}:${e.binding},`;
			}
		});
		if (!key) return void 0;
		let r = pl.refined?.get(key);
		if (r) return r;
		const marks = new Set(key.split(",").filter(Boolean));
		const sl = pl.sets.map((slot, s) => {
			if (!slot.entries.some((e) => marks.has(`${s}:${e.binding}`))) return slot;
			const entries = slot.entries.map((e) => {
				if (e.texture && marks.has(`${s}:${e.binding}`)) return {
					...e,
					texture: {
						...e.texture,
						sampleType: "unfilterable-float"
					}
				};
				if (e.sampler?.type === "filtering") {
					const paired = marks.has(`${s}:${e.binding - 1}`);
					const [vkb, el] = slot.src?.get(e.binding) || [e.binding >> 1, 0];
					const d = sets[s]?.desc.get(dkey(vkb, el));
					const smp = d?.sampler && this.objs.get(d.sampler);
					if (paired || smp && !smp.filtering) return {
						...e,
						sampler: { type: "non-filtering" }
					};
				}
				return e;
			});
			const { key: k, layout } = this.bgl(entries);
			return {
				...slot,
				key: k,
				layout,
				entries
			};
		});
		const groups = sl.map((x) => x.layout);
		if (pl.pushGroup >= 0) groups.push(this.pushBGL);
		r = {
			...pl,
			sets: sl,
			layout: this.dev.createPipelineLayout({ bindGroupLayouts: groups }),
			refineKey: key,
			refined: void 0
		};
		(pl.refined ||= /* @__PURE__ */ new Map()).set(key, r);
		return r;
	}
	storageVariant(p, sets) {
		if (!p.layout.hasStorageTex) return p;
		let key = "";
		const formats = { ...p.storageFormats || {} };
		p.layout.sets.forEach((slot, s) => {
			for (const e of slot.entries) {
				if (!e.storageTexture) continue;
				const [b, el] = slot.src?.get(e.binding) || [e.binding >> 1, 0];
				const d = sets[s]?.desc.get(dkey(b, el));
				const v = d?.imageView && this.objs.get(d.imageView);
				if (v && v.tex !== e.storageTexture.format) {
					formats[`${s}.${b}`] = v.tex;
					key += `${s}.${b}=${v.tex},`;
				}
			}
		});
		if (!key) return p;
		const root = p.root || p;
		let v = root.storageVariants?.get(key);
		if (v) return v;
		const stages = root.stages.map((st) => {
			const opts = {
				...st.opts,
				storageFormats: formats
			};
			return {
				...st,
				opts,
				...this.translate(st.mod, opts)
			};
		});
		const layout = this.pipelineLayout(root.layoutId ?? root.msg.layout, stages);
		v = {
			...root,
			root,
			stages,
			layout,
			storageFormats: formats,
			variants: /* @__PURE__ */ new Map(),
			storageVariants: void 0
		};
		if (root.kind === "compute") {
			this.stats.pipelines++;
			v.stage = stages[0];
			v.gpu = this.dev.createComputePipeline({
				label: "kwvk pipeline (storage formats)",
				layout: layout.layout,
				compute: {
					module: stages[0].module,
					entryPoint: stages[0].res.entryPoint
				}
			});
		}
		(root.storageVariants ||= /* @__PURE__ */ new Map()).set(key, v);
		return v;
	}
	stages(msg, pushGroupOf, setLayouts = [], keepReadOnly = false) {
		const out = [];
		let arrays;
		setLayouts.forEach((id, s) => {
			const dsl = id ? this.objs.get(id) : void 0;
			for (const b in dsl?.arrays || {}) (arrays ||= {})[`${s}.${b}`] = dsl.arrays[b];
		});
		for (const st of msg.stages || []) {
			const kind = st.stage === 1 ? "vertex" : st.stage === 16 ? "fragment" : st.stage === 32 ? "compute" : "";
			if (!kind) throw new Error(`unsupported shader stage ${st.stage}`);
			const opts = {
				stage: kind,
				entryPoint: st.name || "main",
				pushGroup: pushGroupOf
			};
			if (keepReadOnly && kind === "compute") opts.keepReadOnly = true;
			if (this.dev.features?.has?.("shader-f16")) opts.features = ["shader-f16"];
			if (kind === "compute" && this.dev.limits) {
				const l = this.dev.limits;
				opts.limits = {
					maxComputeWorkgroupSizeX: l.maxComputeWorkgroupSizeX,
					maxComputeWorkgroupSizeY: l.maxComputeWorkgroupSizeY,
					maxComputeWorkgroupSizeZ: l.maxComputeWorkgroupSizeZ,
					maxComputeInvocationsPerWorkgroup: l.maxComputeInvocationsPerWorkgroup
				};
				if (noGpu()) opts.limits = {
					maxComputeWorkgroupSizeX: 1024,
					maxComputeWorkgroupSizeY: 1024,
					maxComputeWorkgroupSizeZ: 64,
					maxComputeInvocationsPerWorkgroup: 1024
				};
			}
			if (arrays) opts.arrays = arrays;
			if (kind === "compute") opts.subgroupSize = this.subgroupSize;
			if (kind === "vertex") opts.flipY = !this.noFlip;
			const sm = this.get(st.module, "shader");
			if (st.specializationInfo && !sm.specTypes) sm.specTypes = specTypes(sm.code);
			const spec = specValues(st.specializationInfo, sm.specTypes);
			if (spec) opts.spec = spec;
			if (kind === "vertex") {
				const fst = (msg.stages || []).find((x) => x.stage === 16);
				const fm = fst && this.objs.get(fst.module);
				if (fm?.t === "shader") {
					fm.inputs ||= fragmentInputs(fm.code);
					if (Object.keys(fm.inputs).length) opts.relink = fm.inputs;
				}
			}
			const { module, res, check } = this.translate(sm, opts);
			out.push({
				stage: kind === "vertex" ? SS.VERTEX : kind === "fragment" ? SS.FRAGMENT : SS.COMPUTE,
				kind,
				module,
				res,
				moduleId: st.module,
				mod: sm,
				opts,
				check
			});
		}
		return out;
	}
	makePipeline(msg, make) {
		this.dev.pushErrorScope("validation");
		let p;
		let scope;
		try {
			p = make();
		} catch (e) {
			const why = e?.message ?? String(e);
			if (!UNUSABLE.test(why)) throw e;
			this.stats.errors++;
			this.log(`kwvk: ${msg.op} (pipeline ${msg.id}): ${why}`);
			this.put(msg.id, {
				t: "pipeline",
				kind: msg.op === "vkCreateComputePipelines" ? "compute" : "graphics",
				failed: why,
				stages: []
			});
			return msg.r ? { json: { unusable: why } } : void 0;
		} finally {
			scope = this.dev.popErrorScope();
		}
		this.put(msg.id, p);
		const checks = p.stages.map((st) => st.check);
		checks.push(scope.then((e) => e ? firstLine(e.message) : void 0, (e) => firstLine(e?.message ?? String(e))));
		const defer = Promise.all(checks).then(async (errs) => {
			let why = errs.find(Boolean);
			if (why && p.readOnlyRetry && await p.readOnlyRetry()) why = void 0;
			if (!why) return msg.r ? { json: {} } : void 0;
			p.failed = why;
			if (msg.r && !UNUSABLE.test(why)) throw new Error(why);
			this.stats.errors++;
			this.log(`kwvk: ${msg.op} (pipeline ${msg.id}): ${why}`);
			return msg.r ? { json: { unusable: why } } : void 0;
		});
		if (msg.r) return { defer };
		defer.catch(() => {});
	}
};
function b64(bytes) {
	let s = "";
	for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
	return btoa(s);
}
function fragmentInputs(code) {
	const out = {};
	if (code.length < 20 || code.length & 3) return out;
	const w = new Uint32Array(code.buffer.slice(code.byteOffset, code.byteOffset + code.length));
	if (w[0] !== 119734787) return out;
	const loc = /* @__PURE__ */ new Map();
	const deco = /* @__PURE__ */ new Map();
	const inputs = /* @__PURE__ */ new Set();
	for (let i = 5; i < w.length;) {
		const op = w[i] & 65535;
		const n = w[i] >>> 16 || 1;
		if (op === 71) {
			const id = w[i + 1];
			const d = w[i + 2];
			if (d === 30) loc.set(id, w[i + 3]);
			else if (d === 13 || d === 14 || d === 16 || d === 17) (deco.get(id) || deco.set(id, /* @__PURE__ */ new Set()).get(id)).add(d);
		} else if (op === 59 && w[i + 3] === 1) inputs.add(w[i + 2]);
		else if (op === 54) break;
		i += n;
	}
	for (const id of inputs) {
		const l = loc.get(id);
		if (l === void 0) continue;
		const d = deco.get(id) || /* @__PURE__ */ new Set();
		if (d.has(14)) out[l] = "flat";
		else out[l] = `${d.has(13) ? "linear" : "perspective"}, ${d.has(17) ? "sample" : d.has(16) ? "centroid" : "center"}`;
	}
	return out;
}
function blockEnd(t, open) {
	let depth = 0;
	for (let i = open; i < t.length; i++) if (t[i] === "{") depth++;
	else if (t[i] === "}" && --depth === 0) return i;
	return -1;
}
function pruneDeadBindings(res) {
	let t = res.wgsl;
	if (!/\bif (false|true) \{/.test(t)) return res;
	for (let guard = 0; guard < 1e3; guard++) {
		const m = /\bif (false|true) \{/.exec(t);
		if (!m) break;
		const open = m.index + m[0].length - 1;
		const close = blockEnd(t, open);
		if (close < 0) return res;
		const thenBody = t.slice(open + 1, close);
		const rest = /^\s*else\s*/.exec(t.slice(close + 1));
		let elseBody = "";
		let end = close + 1;
		if (rest) {
			const after = close + 1 + rest[0].length;
			if (t[after] === "{") {
				const ec = blockEnd(t, after);
				if (ec < 0) return res;
				elseBody = t.slice(after + 1, ec);
				end = ec + 1;
			} else {
				t = m[1] === "false" ? t.slice(0, m.index) + t.slice(after) : t.slice(0, m.index) + "if (true) {" + t.slice(open + 1);
				continue;
			}
		}
		t = t.slice(0, m.index) + `{${m[1] === "true" ? thenBody : elseBody}}` + t.slice(end);
	}
	const bindings = res.bindings.filter((b) => {
		const d = new RegExp(`@group\\(${b.group}\\)\\s*@binding\\(${b.wgslBinding}\\)\\s*var(<[^>]*>)?\\s+(\\w+)`).exec(t);
		if (!d) return true;
		const name = d[2];
		return (t.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0) > 1;
	});
	return {
		...res,
		wgsl: t,
		bindings
	};
}
function relinkVertexOutputs(wgsl, inputs) {
	const m = /@vertex\s*fn\s+\w+\s*\([^]*?\)\s*->\s*(\w+)/.exec(wgsl);
	if (!m) return wgsl;
	const start = wgsl.search(new RegExp(`struct\\s+${m[1]}\\s*\\{`));
	if (start < 0) return wgsl;
	const end = wgsl.indexOf("}", start);
	if (end < 0) return wgsl;
	const body = wgsl.slice(start, end).replace(/@location\((\d+)\)(\s*@interpolate\([^)]*\))?(\s*)(\w+\s*:\s*[^,\n]+)/g, (all, l, _interp, sp, decl) => {
		const want = inputs[Number(l)];
		if (!want || /\b[iu]32\b|vec\d<[iu]32>|vec\di\b|vec\du\b/.test(decl)) return all;
		return want === "perspective, center" ? `@location(${l})${sp}${decl}` : `@location(${l}) @interpolate(${want})${sp}${decl}`;
	});
	return wgsl.slice(0, start) + body + wgsl.slice(end);
}
function usesBaseBuiltins(code) {
	if (code.length < 20 || code.length & 3) return false;
	const w = new Uint32Array(code.buffer, code.byteOffset, code.length >> 2);
	if (w[0] !== 119734787) return false;
	for (let i = 5; i < w.length;) {
		const op = w[i] & 65535;
		const n = w[i] >>> 16 || 1;
		if (op === 71 && w[i + 2] === 11 && w[i + 3] >= 4424 && w[i + 3] <= 4426) return true;
		if (op === 72 && w[i + 3] === 11 && w[i + 4] >= 4424 && w[i + 4] <= 4426) return true;
		if (op === 54) break;
		i += n;
	}
	return false;
}
function specTypes(code) {
	const out = /* @__PURE__ */ new Map();
	if (code.length < 20 || code.length & 3) return out;
	const w = new Uint32Array(code.buffer.slice(code.byteOffset, code.byteOffset + code.length));
	if (w[0] !== 119734787) return out;
	const specId = /* @__PURE__ */ new Map();
	const types = /* @__PURE__ */ new Map();
	for (let i = 5; i < w.length;) {
		const op = w[i] & 65535;
		const n = w[i] >>> 16 || 1;
		if (op === 71 && w[i + 2] === 1) specId.set(w[i + 1], w[i + 3]);
		else if (op === 20) types.set(w[i + 1], "b");
		else if (op === 21) types.set(w[i + 1], w[i + 3] ? "i" : "u");
		else if (op === 22) types.set(w[i + 1], "f");
		else if (op === 48 || op === 49 || op === 50) {
			const id = specId.get(w[i + 2]);
			if (id !== void 0) out.set(id, types.get(w[i + 1]) || "u");
		}
		i += n;
	}
	return out;
}
function specValues(info, types) {
	if (!info || !info.mapEntries?.length) return void 0;
	const data = Uint8Array.from(info.data || []);
	const dv = new DataView(data.buffer);
	const out = {};
	for (const m of info.mapEntries) {
		const size = m.size || 4;
		if (m.offset + Math.min(size, 4) > data.length) continue;
		const t = types.get(m.constantID) || "u";
		if (size === 1) out[m.constantID] = t === "b" ? dv.getUint8(m.offset) !== 0 : dv.getUint8(m.offset);
		else if (size === 2) out[m.constantID] = dv.getUint16(m.offset, true);
		else if (size === 8) out[m.constantID] = t === "f" ? dv.getFloat64(m.offset, true) : Number(dv.getBigInt64(m.offset, true));
		else if (t === "f") out[m.constantID] = dv.getFloat32(m.offset, true);
		else if (t === "i") out[m.constantID] = dv.getInt32(m.offset, true);
		else if (t === "b") out[m.constantID] = dv.getUint32(m.offset, true) !== 0;
		else out[m.constantID] = dv.getUint32(m.offset, true);
	}
	return out;
}
function dkey(binding, element) {
	return binding + element * 2 ** 21;
}
function entryFromReflection(b, stage, dsl) {
	const e = {
		binding: b.wgslBinding,
		visibility: stage
	};
	const vkd = dsl.bindings.get(b.binding);
	const dyn = vkd && (vkd.type === DT.UNIFORM_DYN || vkd.type === DT.STORAGE_DYN);
	switch (b.kind) {
		case "uniform":
			e.buffer = {
				type: "uniform",
				hasDynamicOffset: !!dyn
			};
			break;
		case "storage":
			e.buffer = {
				type: "storage",
				hasDynamicOffset: !!dyn
			};
			if (b.ro) e.kwRO = true;
			break;
		case "read-only-storage":
			e.buffer = {
				type: "read-only-storage",
				hasDynamicOffset: !!dyn
			};
			break;
		case "sampler":
			e.sampler = { type: "filtering" };
			break;
		case "comparison-sampler":
			e.sampler = { type: "comparison" };
			break;
		case "texture": {
			let sampleType = b.sampleType || "float";
			if (b.multisampled && sampleType === "float") sampleType = "unfilterable-float";
			e.texture = {
				sampleType,
				viewDimension: b.viewDimension || "2d",
				multisampled: !!b.multisampled
			};
			break;
		}
		case "storage-texture": e.storageTexture = {
			access: b.access || "write-only",
			format: b.format || "rgba8unorm",
			viewDimension: b.viewDimension || "2d"
		};
	}
	return e;
}
function entriesFromVk(binding, d, visibility) {
	const w = 2 * binding;
	switch (d.type) {
		case DT.UNIFORM:
		case DT.UNIFORM_DYN: return [{
			binding: w,
			visibility,
			buffer: {
				type: "uniform",
				hasDynamicOffset: d.type === DT.UNIFORM_DYN
			}
		}];
		case DT.STORAGE:
		case DT.STORAGE_DYN: return [{
			binding: w,
			visibility: visibility & ~SS.VERTEX,
			buffer: {
				type: "storage",
				hasDynamicOffset: d.type === DT.STORAGE_DYN
			}
		}];
		case DT.SAMPLER: return [{
			binding: w,
			visibility,
			sampler: { type: "filtering" }
		}];
		case DT.SAMPLED_IMAGE: return [{
			binding: w,
			visibility,
			texture: {
				sampleType: "float",
				viewDimension: "2d"
			}
		}];
		case DT.COMBINED: return [{
			binding: w,
			visibility,
			texture: {
				sampleType: "float",
				viewDimension: "2d"
			}
		}, {
			binding: w + 1,
			visibility,
			sampler: { type: "filtering" }
		}];
	}
	return [];
}
function makeTexture(c, msg, info) {
	const ext = msg.extent || {
		width: 1,
		height: 1,
		depth: 1
	};
	const samples = msg.samples || 1;
	const dim = msg.imageType === 0 ? "1d" : msg.imageType === 2 ? "3d" : "2d";
	const tex = info.tex;
	let usage = TU.TEXTURE_BINDING;
	const renderable = (info.caps & 20) !== 0 && dim === "2d";
	if (samples > 1) usage |= TU.RENDER_ATTACHMENT;
	else {
		usage |= TU.COPY_SRC | TU.COPY_DST;
		if (renderable) usage |= TU.RENDER_ATTACHMENT;
		if (msg.usage & 8 && info.caps & 32) usage |= TU.STORAGE_BINDING;
	}
	const desc = {
		label: `kwvk image ${msg.id}`,
		size: [
			ext.width,
			dim === "1d" ? 1 : ext.height,
			dim === "3d" ? ext.depth : msg.arrayLayers || 1
		],
		mipLevelCount: msg.mipLevels || 1,
		sampleCount: samples,
		dimension: dim,
		format: tex,
		usage
	};
	const twin = srgbTwin(tex);
	if (twin && samples === 1) desc.viewFormats = [twin];
	const texture = c.dev.createTexture(desc);
	c.r.gpuCreated();
	return texture;
}
const SAMPLER_FILTER = ["nearest", "linear"];
const handlers = {
	hello(c, msg) {
		const dev = c.dev;
		const want = msg.subgroupSize;
		if (want !== void 0) c.subgroupSize = Number.isInteger(want) && want >= 1 && want <= 128 && !(want & want - 1) ? want : 32;
		c.engineName = typeof msg.engineName === "string" ? msg.engineName.slice(0, 64) : "";
		c.noFlip = NO_FLIP_ENGINES.has(c.engineName);
		const limits = {};
		for (const k in dev.limits) {
			const v = dev.limits[k];
			if (typeof v === "number") limits[k] = v;
		}
		const features = [...dev.features];
		const ai = dev.adapterInfo || c.r.adapter?.info || {};
		if (!c.token && c.r.externalOk && typeof globalThis.OffscreenCanvas === "function" && typeof globalThis.crypto?.getRandomValues === "function") {
			c.token = newToken();
			c.r.tokens.set(c.token, c);
		}
		return { json: {
			version: 1,
			adapter: {
				vendor: ai.vendor || "",
				architecture: ai.architecture || "",
				device: ai.device || "",
				description: ai.description || ""
			},
			limits,
			features,
			formats: formatTable(dev.features),
			subgroupSize: c.subgroupSize,
			...c.token ? { external: { token: c.token } } : {}
		} };
	},
	exportImages(c, msg) {
		if (!c.token) throw new Error("external present is not offered on this connection (no token)");
		return { json: { ids: (Array.isArray(msg.images) ? msg.images : []).map((id) => {
			const img = c.get(id, "image");
			const base = img.format.replace(/-srgb$/, "");
			if (img.samples > 1 || img.is3D || base !== "bgra8unorm" && base !== "rgba8unorm") throw new Error(`image ${id} (${img.format}) cannot be presented externally`);
			return img;
		}).map((img, i) => {
			if (!img.exportId) {
				if (c.nextExport > 4294967295) throw new Error("export ids exhausted");
				img.exportId = c.nextExport++;
				c.exported.set(img.exportId, {
					id: msg.images[i],
					img
				});
			}
			return img.exportId;
		}) } };
	},
	sync(c) {
		return { defer: Promise.all([c.dev.queue.onSubmittedWorkDone(), c.checked]).then(() => void 0) };
	},
	destroy(c, msg) {
		for (const id of msg.ids || []) c.destroyOne(id);
	},
	vkCreateBuffer(c, msg) {
		const size = Math.max(4, msg.size + 3 & -4);
		let usage = BU.COPY_SRC | BU.COPY_DST | BU.STORAGE;
		const u = msg.usage || 0;
		if (u & 16) usage |= BU.UNIFORM;
		if (u & 32) usage |= BU.STORAGE;
		if (u & 64) usage |= BU.INDEX;
		if (u & 128) usage |= BU.VERTEX;
		if (u & 256) usage |= BU.INDIRECT;
		if (u & 8) usage |= BU.UNIFORM;
		if (u & 4) usage |= BU.STORAGE;
		if (!(size <= c.dev.limits.maxBufferSize)) throw new Error(`buffer size ${msg.size} over maxBufferSize`);
		const buf = c.dev.createBuffer({
			size,
			usage,
			label: `kwvk buffer ${msg.id}`
		});
		c.r.gpuCreated();
		c.put(msg.id, {
			t: "buffer",
			buf,
			size: msg.size
		});
	},
	writeBuffer(c, msg, bin) {
		const b = c.get(msg.buffer, "buffer");
		const off = msg.offset || 0;
		if (off & 3 || bin.length & 3) {
			if (off & 3) throw new Error(`unaligned offset ${off}`);
			if (off + bin.length >= b.size) {
				const p = new Uint8Array(bin.length + 3 & -4);
				p.set(bin);
				bin = p;
			} else throw new Error(`unaligned size ${bin.length}`);
		}
		if (off + bin.length > b.buf.size) throw new Error(`write past the end (${off}+${bin.length} > ${b.buf.size})`);
		c.dev.queue.writeBuffer(b.buf, off, bin);
		c.stats.bytesWritten += bin.length;
	},
	readBuffer(c, msg) {
		const b = c.get(msg.buffer, "buffer");
		const off = msg.offset || 0;
		if (!(off >= 0 && off <= b.size)) throw new Error(`offset ${off} out of range`);
		const size = Math.min(isWhole(msg.size) ? b.size - off : msg.size, b.size - off);
		const start = off & -4;
		const end = Math.min(off + size + 3 & -4, b.buf.size);
		const len = Math.max(4, end - start);
		const stage = c.dev.createBuffer({
			size: len,
			usage: BU.MAP_READ | BU.COPY_DST
		});
		const e = c.dev.createCommandEncoder();
		e.copyBufferToBuffer(b.buf, start, stage, 0, end - start);
		c.dev.queue.submit([e.finish()]);
		return { defer: Promise.all([stage.mapAsync(MAP_READ), c.checked]).then(() => {
			const out = new Uint8Array(stage.getMappedRange()).subarray(off - start, off - start + size);
			c.stats.bytesRead += out.length;
			return {
				bin: out,
				after: () => {
					stage.unmap();
					stage.destroy();
				}
			};
		}) };
	},
	vkCreateImage(c, msg) {
		const info = vkFormat(msg.format);
		if (!info?.tex) throw new Error(`unsupported image format ${msg.format}`);
		if (msg.tiling === 1) c.log("kwvk: vkCreateImage: linear tiling is unsupported (treated as optimal)");
		const tex = makeTexture(c, msg, info);
		c.put(msg.id, {
			t: "image",
			tex,
			info,
			format: info.tex,
			width: msg.extent?.width || 1,
			height: msg.extent?.height || 1,
			depth: msg.imageType === 2 ? msg.extent?.depth || 1 : 1,
			is3D: msg.imageType === 2,
			mipLevels: msg.mipLevels || 1,
			layers: msg.arrayLayers || 1,
			samples: msg.samples || 1
		});
	},
	vkCreateImageView(c, msg) {
		const image = c.get(msg.image, "image");
		let tex = vkFormat(msg.format)?.tex || image.format;
		if (tex !== image.format && tex !== srgbTwin(image.format)) {
			c.log(`kwvk: vkCreateImageView: view format ${tex} of a ${image.format} image is unsupported, using the image's`);
			tex = image.format;
		}
		const r = msg.subresourceRange || {};
		const sw = msg.components || {};
		const letter = (v, own) => !v ? own : [
			"",
			"0",
			"1",
			"r",
			"g",
			"b",
			"a"
		][v] || own;
		let swizzle = letter(sw.r, "r") + letter(sw.g, "g") + letter(sw.b, "b") + letter(sw.a, "a");
		if (swizzle === "rgba") swizzle = void 0;
		else if (!c.dev.features.has("texture-component-swizzle")) {
			c.log("kwvk: vkCreateImageView: component swizzles need WebGPU's texture-component-swizzle (identity used)");
			swizzle = void 0;
		}
		c.put(msg.id, {
			t: "imageView",
			image,
			tex,
			swizzle,
			viewType: msg.viewType ?? 1,
			range: {
				aspectMask: r.aspectMask ?? 1,
				baseMipLevel: r.baseMipLevel || 0,
				levelCount: r.levelCount ?? -1,
				baseArrayLayer: r.baseArrayLayer || 0,
				layerCount: r.layerCount ?? -1
			},
			cache: /* @__PURE__ */ new Map()
		});
	},
	vkCreateSampler(c, msg) {
		const desc = {
			magFilter: SAMPLER_FILTER[msg.magFilter] || "nearest",
			minFilter: SAMPLER_FILTER[msg.minFilter] || "nearest",
			mipmapFilter: SAMPLER_FILTER[msg.mipmapMode] || "nearest",
			addressModeU: ADDRESS[msg.addressModeU] || "repeat",
			addressModeV: ADDRESS[msg.addressModeV] || "repeat",
			addressModeW: ADDRESS[msg.addressModeW] || "repeat",
			lodMinClamp: Math.max(0, msg.minLod || 0),
			lodMaxClamp: Math.min(32, Math.max(msg.minLod || 0, msg.maxLod ?? 32))
		};
		if (msg.compareEnable) desc.compare = COMPARE[msg.compareOp] || "less";
		if (msg.anisotropyEnable && msg.maxAnisotropy > 1 && desc.magFilter === "linear" && desc.minFilter === "linear" && desc.mipmapFilter === "linear") desc.maxAnisotropy = Math.min(16, Math.floor(msg.maxAnisotropy));
		if ([
			msg.addressModeU,
			msg.addressModeV,
			msg.addressModeW
		].includes(3)) c.log("kwvk: vkCreateSampler: CLAMP_TO_BORDER is approximated as clamp-to-edge (no border colour)");
		if (msg.unnormalizedCoordinates) c.log("kwvk: vkCreateSampler: unnormalizedCoordinates is unsupported (coordinates are taken as normalized)");
		const filtering = desc.magFilter === "linear" || desc.minFilter === "linear" || desc.mipmapFilter === "linear";
		c.put(msg.id, {
			t: "sampler",
			gpu: c.dev.createSampler(desc),
			filtering
		});
	},
	vkCreateShaderModule(c, msg, bin) {
		let code = bin;
		if (!code.length && Array.isArray(msg.code)) code = Uint8Array.from(msg.code);
		code = code.slice();
		c.put(msg.id, {
			t: "shader",
			id: msg.id,
			code,
			cache: /* @__PURE__ */ new Map(),
			baseBuiltins: usesBaseBuiltins(code)
		});
	},
	vkCreateDescriptorSetLayout(c, msg) {
		const bindings = /* @__PURE__ */ new Map();
		for (const b of msg.bindings || []) {
			if (b.descriptorType === DT.UNIFORM_TEXEL || b.descriptorType === DT.STORAGE_TEXEL) c.log("kwvk: vkCreateDescriptorSetLayout: texel buffers are unsupported");
			bindings.set(b.binding, {
				type: b.descriptorType,
				count: b.descriptorCount ?? 1,
				stages: b.stageFlags,
				immutable: b.immutableSamplers
			});
		}
		const order = [...bindings.keys()].sort((a, b) => a - b);
		const dynamic = [];
		for (const b of order) {
			const d = bindings.get(b);
			if (d.type === DT.UNIFORM_DYN || d.type === DT.STORAGE_DYN) for (let i = 0; i < Math.min(d.count, 1024); i++) dynamic.push(`${b}:${i}`);
		}
		const arrays = {};
		let next = 2 * ((order[order.length - 1] ?? -1) + 1);
		for (const b of order) {
			const d = bindings.get(b);
			if (d.count > 1) {
				arrays[b] = {
					base: next,
					count: d.count
				};
				next += 2 * d.count;
			}
		}
		if (next > 1e3) c.log("kwvk: vkCreateDescriptorSetLayout: descriptor arrays past WebGPU's binding numbers (1000)");
		c.put(msg.id, {
			t: "setLayout",
			bindings,
			dynamic,
			order,
			arrays
		});
	},
	vkCreatePipelineLayout(c, msg) {
		const setLayouts = msg.setLayouts || [];
		let pushSize = 0;
		for (const r of msg.pushConstantRanges || []) pushSize = Math.max(pushSize, r.offset + r.size);
		if (pushSize && setLayouts.length > 3) c.log("kwvk: vkCreatePipelineLayout: push constants with more than 3 sets are unsupported");
		c.put(msg.id, {
			t: "pipelineLayout",
			setLayouts,
			pushSize
		});
	},
	vkAllocateDescriptorSets(c, msg) {
		for (const s of msg.sets || []) {
			const layout = c.get(s.layout, "setLayout");
			c.put(s.id, {
				t: "set",
				layout,
				desc: /* @__PURE__ */ new Map(),
				cache: /* @__PURE__ */ new Map()
			});
		}
	},
	vkUpdateDescriptorSets(c, msg) {
		const settle = (layout, b, el, what) => {
			while (el >= (layout.bindings.get(b)?.count ?? 1)) {
				const nb = layout.order.find((x) => x > b);
				if (nb === void 0) throw new Error(`descriptor ${what} past the last binding`);
				b = nb;
				el = 0;
			}
			return [b, el];
		};
		for (const w of msg.descriptorWrites || []) {
			const set = c.get(w.dstSet, "set");
			set.cache.clear();
			const infos = w.imageInfo?.length ? w.imageInfo : w.bufferInfo?.length ? w.bufferInfo : w.texelBufferView || [];
			const n = Math.min(w.descriptorCount ?? infos.length, infos.length);
			let b = w.dstBinding | 0;
			let el = w.dstArrayElement | 0;
			for (let i = 0; i < n; i++) {
				[b, el] = settle(set.layout, b, el, "write");
				const info = infos[i];
				const d = { type: w.descriptorType };
				if (w.imageInfo?.length) Object.assign(d, {
					sampler: info.sampler,
					imageView: info.imageView
				});
				else if (w.bufferInfo?.length) Object.assign(d, {
					buffer: info.buffer,
					offset: info.offset || 0,
					range: info.range
				});
				const k = dkey(b, el);
				const prev = set.desc.get(k);
				set.desc.set(k, prev && w.descriptorType === DT.SAMPLER ? {
					...prev,
					sampler: d.sampler
				} : d);
				el++;
			}
		}
		for (const cp of msg.descriptorCopies || []) {
			const src = c.get(cp.srcSet, "set");
			const dst = c.get(cp.dstSet, "set");
			const n = Math.min(cp.descriptorCount ?? 1, 4096);
			let sb = cp.srcBinding | 0;
			let se = cp.srcArrayElement | 0;
			let db = cp.dstBinding | 0;
			let de = cp.dstArrayElement | 0;
			for (let i = 0; i < n; i++) {
				[sb, se] = settle(src.layout, sb, se, "copy source");
				[db, de] = settle(dst.layout, db, de, "copy");
				const d = src.desc.get(dkey(sb, se));
				if (d) dst.desc.set(dkey(db, de), { ...d });
				se++;
				de++;
			}
			dst.cache.clear();
		}
	},
	vkCreateRenderPass(c, msg) {
		const atts = (msg.attachments || []).map((a) => ({
			...a,
			tex: vkFormat(a.format)?.tex
		}));
		const subpasses = (msg.subpasses || []).map((s) => ({
			colors: (s.colorAttachments || []).map((r) => r.attachment),
			resolves: (s.resolveAttachments || []).map((r) => r.attachment),
			depth: s.depthStencilAttachment ? s.depthStencilAttachment.attachment : UNUSED,
			inputs: (s.inputAttachments || []).map((r) => r.attachment)
		}));
		const first = /* @__PURE__ */ new Map();
		const last = /* @__PURE__ */ new Map();
		subpasses.forEach((s, i) => {
			for (const a of [
				...s.colors,
				...s.resolves,
				s.depth
			]) {
				if (a === 4294967295 || a === void 0) continue;
				if (!first.has(a)) first.set(a, i);
				last.set(a, i);
			}
			if (s.inputs?.some?.((a) => a !== 4294967295 && (s.colors.includes(a) || s.depth === a))) c.log("kwvk: vkCreateRenderPass: an input attachment that is also written in the same subpass is unsupported");
		});
		for (const s of subpasses) {
			const colors = s.colors.map((a) => a === 4294967295 ? null : atts[a]?.tex || null);
			const depth = s.depth === 4294967295 ? null : atts[s.depth]?.tex || null;
			let samples = 1;
			for (const a of [...s.colors, s.depth]) if (a !== 4294967295 && atts[a]) samples = atts[a].samples || 1;
			s.colorFormats = colors;
			s.depthFormat = depth;
			s.samples = samples;
			s.key = `${colors.join(",")}|${depth}|${samples}`;
		}
		c.put(msg.id, {
			t: "renderPass",
			atts,
			subpasses,
			first,
			last
		});
	},
	vkCreateFramebuffer(c, msg) {
		c.put(msg.id, {
			t: "framebuffer",
			views: msg.attachments || [],
			width: msg.width,
			height: msg.height,
			layers: msg.layers || 1
		});
	},
	vkCreateGraphicsPipelines(c, msg) {
		return c.makePipeline(msg, () => graphicsPipeline(c, msg));
	},
	vkCreateComputePipelines(c, msg) {
		return c.makePipeline(msg, () => {
			const pl = c.get(msg.layout, "pipelineLayout");
			const stages = c.stages({ stages: [msg.stage] }, pl.setLayouts.length, pl.setLayouts);
			const layout = c.pipelineLayout(msg.layout, stages);
			const st = stages[0];
			c.stats.pipelines++;
			const p = {
				t: "pipeline",
				kind: "compute",
				layout,
				gpu: c.dev.createComputePipeline({
					label: `kwvk pipeline ${msg.id}`,
					layout: layout.layout,
					compute: {
						module: st.module,
						entryPoint: st.res.entryPoint
					}
				}),
				stage: st,
				stages,
				layoutId: msg.layout,
				variants: /* @__PURE__ */ new Map()
			};
			if (st.res.bindings.some((b) => b.ro)) p.readOnlyRetry = async () => {
				p.readOnlyRetry = void 0;
				let ro;
				c.dev.pushErrorScope("validation");
				try {
					const stages2 = c.stages({ stages: [msg.stage] }, pl.setLayouts.length, pl.setLayouts, true);
					const layout2 = c.pipelineLayout(msg.layout, stages2);
					c.stats.pipelines++;
					ro = {
						layout: layout2,
						gpu: c.dev.createComputePipeline({
							label: `kwvk pipeline ${msg.id} (read-only kept)`,
							layout: layout2.layout,
							compute: {
								module: stages2[0].module,
								entryPoint: stages2[0].res.entryPoint
							}
						}),
						stage: stages2[0],
						stages: stages2,
						variants: /* @__PURE__ */ new Map(),
						storageVariants: void 0
					};
				} catch {
					ro = void 0;
				}
				const scope = await c.dev.popErrorScope().catch((e) => e || true);
				if (!ro || scope || await ro.stage.check) return false;
				Object.assign(p, ro);
				return true;
			};
			return p;
		});
	},
	vkCreateQueryPool(c, msg) {
		const count = msg.queryCount | 0;
		if (!(count >= 1 && count <= 4096)) throw new Error(`queryCount ${msg.queryCount} out of range (1..4096)`);
		const type = msg.queryType | 0;
		let set;
		if (type === 0) set = c.dev.createQuerySet({
			type: "occlusion",
			count,
			label: `kwvk queries ${msg.id}`
		});
		else if (type === 2 && c.dev.features.has("timestamp-query")) set = c.dev.createQuerySet({
			type: "timestamp",
			count,
			label: `kwvk queries ${msg.id}`
		});
		else c.log(`kwvk: vkCreateQueryPool: query type ${type} ${type === 2 ? "without timestamp-query" : ""} reads as zeros`);
		if (set) c.r.gpuCreated();
		const results = c.dev.createBuffer({
			size: count * 8,
			usage: BU.COPY_SRC | BU.COPY_DST,
			label: `kwvk query results ${msg.id}`
		});
		c.r.gpuCreated();
		c.put(msg.id, {
			t: "queryPool",
			type,
			count,
			set,
			results,
			avail: new Uint8Array(count),
			written: new Uint8Array(count),
			seq: new Float64Array(count),
			clock: 0
		});
	},
	vkResetQueryPool(c, msg) {
		const p = c.get(msg.queryPool, "queryPool");
		const first = msg.firstQuery | 0;
		const n = Math.min(msg.queryCount | 0, p.count - first);
		if (first < 0 || n <= 0) return void 0;
		p.avail.fill(0, first, first + n);
		p.written.fill(0, first, first + n);
		const e = c.dev.createCommandEncoder();
		e.clearBuffer(p.results, first * 8, n * 8);
		c.dev.queue.submit([e.finish()]);
	},
	getQueryPoolResults(c, msg) {
		const p = c.get(msg.queryPool, "queryPool");
		const first = msg.firstQuery | 0;
		const n = Math.min(msg.queryCount | 0, p.count - first);
		if (first < 0 || n <= 0) throw new Error("query range out of range");
		const stage = c.dev.createBuffer({
			size: n * 8,
			usage: BU.MAP_READ | BU.COPY_DST
		});
		const e = c.dev.createCommandEncoder();
		const scratch = [];
		resolveQueries(c.dev, e, p, first, n, scratch);
		e.copyBufferToBuffer(p.results, first * 8, stage, 0, n * 8);
		c.dev.queue.submit([e.finish()]);
		const available = [...p.avail.subarray(first, first + n)];
		const order = p.type === 2 && p.set ? [...Array(n).keys()].filter((i) => p.written[first + i]).sort((a, b) => p.seq[first + a] - p.seq[first + b]) : [];
		return { defer: Promise.all([stage.mapAsync(MAP_READ), c.checked]).then(() => {
			const out = new Uint8Array(stage.getMappedRange().slice(0));
			stage.unmap();
			stage.destroy();
			for (const b of scratch) b.destroy();
			if (p.type === 0) {
				const v = new BigUint64Array(out.buffer);
				for (let i = 0; i < v.length; i++) v[i] = v[i] ? 1n : 0n;
			}
			if (order.length > 1) {
				const v = new BigUint64Array(out.buffer);
				let max = v[order[0]], raised = 0;
				for (const i of order) if (v[i] < max) {
					v[i] = max;
					raised++;
				} else max = v[i];
				if (raised && !c.tsRaised) {
					c.tsRaised = true;
					c.log(`kwvk: getQueryPoolResults: ${raised} of ${order.length} timestamps read earlier than the one written before them (raised to it; logged once)`);
				}
			}
			c.stats.bytesRead += out.length;
			return {
				json: { available },
				bin: out
			};
		}) };
	},
	vkCreateBufferView(c, msg) {
		c.log("kwvk: vkCreateBufferView: texel buffers are unsupported");
		c.put(msg.id, { t: "bufferView" });
	},
	vkQueueSubmit(c, msg) {
		c.stats.submits++;
		c.dev.pushErrorScope("validation");
		let done;
		try {
			done = runSubmit(c, msg.cmds || []);
		} finally {
			c.checked = c.dev.popErrorScope().then((err) => {
				if (!err) return;
				c.stats.errors++;
				c.log(`kwvk: vkQueueSubmit: ${err.message}`);
				c.deviceLost(`vkQueueSubmit: WebGPU refused the submit (none of it ran): ${firstLine(err.message)}`);
			}, () => {});
		}
		const check = c.checked;
		return { defer: Promise.all([done, check]).then(() => void 0) };
	},
	present(c, msg) {
		const img = c.get(msg.image, "image");
		const w = img.width;
		const h = img.height;
		c.stats.presents++;
		const info = {
			connection: c,
			image: msg.image,
			texture: img.tex,
			width: w,
			height: h,
			format: img.format
		};
		c.lastPresented = info;
		try {
			c.r.onPresent?.(info);
		} catch (e) {
			c.log(`kwvk: onPresent: ${e.message}`);
		}
		if (msg.external) {
			if (!img.exportId) throw new Error(`image ${msg.image} was not exported (exportImages)`);
			c.stats.externalPresents++;
			return { defer: c.checked.then(() => {
				img.presented = true;
				return { json: {
					width: w,
					height: h
				} };
			}) };
		}
		if (msg.readback === 0) return { json: {
			width: w,
			height: h,
			stride: w * img.info.bpb
		} };
		const json = {
			width: w,
			height: h,
			stride: w * img.info.bpb
		};
		return { defer: Promise.all([readTexture(c, img, 0, 0, w, h), c.checked]).then(([bin]) => {
			c.stats.bytesRead += bin.length;
			return {
				json,
				bin
			};
		}) };
	}
};
function graphicsPipeline(c, msg) {
	const pl = c.get(msg.layout, "pipelineLayout");
	const stages = c.stages(msg, pl.setLayouts.length, pl.setLayouts);
	const layout = c.pipelineLayout(msg.layout, stages);
	const vi = msg.vertexInputState || {};
	const buffers = (vi.vertexBindingDescriptions || []).slice().sort((a, b) => a.binding - b.binding).map((b) => ({
		binding: b.binding,
		desc: {
			arrayStride: b.stride,
			stepMode: b.inputRate === 1 ? "instance" : "vertex",
			attributes: (vi.vertexAttributeDescriptions || []).filter((a) => a.binding === b.binding).map((a) => {
				const f = vkFormat(a.format)?.vtx;
				if (!f) throw new Error(`unsupported vertex format ${a.format}`);
				return {
					format: f,
					offset: a.offset,
					shaderLocation: a.location
				};
			})
		}
	}));
	const topo = msg.inputAssemblyState?.topology ?? 3;
	if (!(topo >= 0 && topo <= 5)) throw new VkResultError(`primitive topology ${topo} (adjacency or patch list) is unsupported`, -8);
	if ((msg.rasterizationState || {}).polygonMode) c.log("kwvk: vkCreateGraphicsPipelines: polygon modes other than FILL are unsupported (drawn filled)");
	const p = {
		t: "pipeline",
		kind: "graphics",
		msg,
		layout,
		stages,
		buffers,
		topology: topo,
		dynamic: new Set(msg.dynamicState?.dynamicStates || []),
		variants: /* @__PURE__ */ new Map(),
		usesBase: stages.some((st) => st.mod.baseBuiltins)
	};
	let sp = (msg.renderPass ? c.objs.get(msg.renderPass) : void 0)?.subpasses?.[msg.subpass || 0];
	if (!msg.renderPass && msg.rendering) {
		const r = msg.rendering;
		const colorFormats = (r.colorAttachmentFormats || []).map((f) => f ? vkFormat(f)?.tex || null : null);
		const df = r.depthAttachmentFormat || r.stencilAttachmentFormat;
		const depthFormat = df ? vkFormat(df)?.tex || null : null;
		const samples = msg.multisampleState?.rasterizationSamples || 1;
		sp = {
			colorFormats,
			depthFormat,
			samples,
			key: `${colorFormats.join(",")}|${depthFormat}|${samples}`
		};
	}
	if (sp) pipelineVariant(c, p, sp, c.noFlip ? { noFlip: true } : {}, void 0);
	return p;
}
async function readTexture(c, img, mip, layer, w, h) {
	const tight = w * img.info.bpb;
	const stride = tight + 255 & -256;
	const stage = c.dev.createBuffer({
		size: stride * h,
		usage: BU.MAP_READ | BU.COPY_DST
	});
	const e = c.dev.createCommandEncoder();
	e.copyTextureToBuffer({
		texture: img.tex,
		mipLevel: mip,
		origin: [
			0,
			0,
			layer
		]
	}, {
		buffer: stage,
		bytesPerRow: stride,
		rowsPerImage: h
	}, [
		w,
		h,
		1
	]);
	c.dev.queue.submit([e.finish()]);
	await stage.mapAsync(MAP_READ);
	const src = new Uint8Array(stage.getMappedRange());
	const out = new Uint8Array(tight * h);
	for (let y = 0; y < h; y++) out.set(src.subarray(y * stride, y * stride + tight), y * tight);
	stage.unmap();
	stage.destroy();
	return out;
}
const TOPOLOGY = [
	"point-list",
	"line-list",
	"line-strip",
	"triangle-list",
	"triangle-strip",
	"triangle-list"
];
const BLEND_FACTOR = [
	"zero",
	"one",
	"src",
	"one-minus-src",
	"dst",
	"one-minus-dst",
	"src-alpha",
	"one-minus-src-alpha",
	"dst-alpha",
	"one-minus-dst-alpha",
	"constant",
	"one-minus-constant",
	"constant",
	"one-minus-constant",
	"src-alpha-saturated",
	"src1",
	"one-minus-src1",
	"src1-alpha",
	"one-minus-src1-alpha"
];
const BLEND_OP = [
	"add",
	"subtract",
	"reverse-subtract",
	"min",
	"max"
];
const STENCIL_OP = [
	"keep",
	"zero",
	"replace",
	"increment-clamp",
	"decrement-clamp",
	"invert",
	"increment-wrap",
	"decrement-wrap"
];
const EXT_DYN = {
	1000267e3: "cullMode",
	1000267001: "frontFace",
	1000267002: "topology",
	1000267005: "strides",
	1000267006: "depthTestEnable",
	1000267007: "depthWriteEnable",
	1000267008: "depthCompareOp",
	1000267010: "stencilTestEnable",
	1000267011: "stencilOp",
	1000377002: "depthBiasEnable"
};
function effectiveExt(p, ext) {
	const eff = {};
	if (!ext || !p.dynamic) return eff;
	for (const d of p.dynamic) {
		const k = EXT_DYN[d];
		if (k && ext[k] !== void 0) eff[k] = ext[k];
	}
	return eff;
}
function pipelineVariant(c, p, sp, dyn, stripFormat, refined) {
	const eff = effectiveExt(p, dyn.ext);
	const topoN = eff.topology ?? p.topology;
	const topo = TOPOLOGY[topoN];
	if (!topo) throw new Error(`primitive topology ${topoN} (adjacency or patch list) is unsupported`);
	const strip = topo.endsWith("strip") ? stripFormat : void 0;
	const useBias = p.dynamic.has(3) ? dyn.bias : void 0;
	const rm = p.dynamic.has(6) ? dyn.readMask : void 0;
	const wm = p.dynamic.has(7) ? dyn.writeMask : void 0;
	const key = `${sp.key}|${strip}|${useBias}|${rm}|${wm}|${refined?.refineKey || ""}|${dyn.noFlip ? 1 : 0}|${JSON.stringify(eff)}`;
	let v = p.variants.get(key);
	if (v) return v;
	c.stats.pipelines++;
	const m = p.msg;
	let vs = p.stages.find((s) => s.kind === "vertex");
	const fs = p.stages.find((s) => s.kind === "fragment");
	if (!vs) throw new Error("graphics pipeline without a vertex stage");
	if (!dyn.noFlip !== !!vs.opts.flipY) {
		if (!c.flipMissLogged) {
			c.flipMissLogged = true;
			c.log(`kwvk: engine ${JSON.stringify(c.engineName)} draws with a ${dyn.noFlip ? "negative" : "positive"} viewport height, its pipelines were made for a ${dyn.noFlip ? "positive" : "negative"} one: a variant per pipeline at its first such draw (logged once)`);
		}
		vs = {
			...vs,
			...c.translate(vs.mod, {
				...vs.opts,
				flipY: !dyn.noFlip
			})
		};
	}
	const rs = { ...m.rasterizationState || {} };
	if (eff.cullMode !== void 0) rs.cullMode = eff.cullMode;
	if (eff.frontFace !== void 0) rs.frontFace = eff.frontFace;
	if (eff.depthBiasEnable !== void 0) rs.depthBiasEnable = eff.depthBiasEnable;
	const d0 = m.depthStencilState || {};
	const dss = { ...d0 };
	for (const k of [
		"depthTestEnable",
		"depthWriteEnable",
		"depthCompareOp",
		"stencilTestEnable"
	]) if (eff[k] !== void 0) dss[k] = eff[k];
	if (eff.stencilOp) {
		if (eff.stencilOp.front) dss.front = {
			...d0.front || {},
			...eff.stencilOp.front
		};
		if (eff.stencilOp.back) dss.back = {
			...d0.back || {},
			...eff.stencilOp.back
		};
	}
	const buffers = p.buffers.map((b) => eff.strides?.[b.binding] !== void 0 ? {
		...b.desc,
		arrayStride: eff.strides[b.binding]
	} : b.desc);
	const tri = topo.startsWith("triangle");
	const cullAll = tri && rs.cullMode === 3;
	const desc = {
		label: `kwvk pipeline ${m.id}`,
		layout: (refined || p.layout).layout,
		vertex: {
			module: vs.module,
			entryPoint: vs.res.entryPoint,
			buffers
		},
		primitive: {
			topology: topo,
			frontFace: (rs.frontFace || 0) === 0 ? "ccw" : "cw",
			cullMode: rs.cullMode === 1 ? "front" : rs.cullMode === 2 ? "back" : "none"
		},
		multisample: { count: sp.samples }
	};
	if (strip) desc.primitive.stripIndexFormat = strip;
	if (rs.depthClampEnable && c.dev.features.has("depth-clip-control")) desc.primitive.unclippedDepth = true;
	const ms = m.multisampleState;
	if (ms) {
		if (ms.sampleMask?.length) desc.multisample.mask = ms.sampleMask[0];
		if (ms.alphaToCoverageEnable) desc.multisample.alphaToCoverageEnabled = true;
	}
	if (fs && !rs.rasterizerDiscardEnable) {
		const cb = m.colorBlendState || {};
		desc.fragment = {
			module: fs.module,
			entryPoint: fs.res.entryPoint,
			targets: sp.colorFormats.map((f, i) => {
				if (!f) return null;
				const a = cb.attachments?.[i] || cb.attachments?.[0] || { colorWriteMask: 15 };
				const t = {
					format: f,
					writeMask: cullAll ? 0 : a.colorWriteMask ?? 15
				};
				const fi = texFormatInfo(f);
				if (a.blendEnable && fi && fi.caps & 8) {
					const comp = (src, dst, op) => {
						const operation = BLEND_OP[op] || "add";
						if (operation === "min" || operation === "max") return {
							operation,
							srcFactor: "one",
							dstFactor: "one"
						};
						return {
							operation,
							srcFactor: BLEND_FACTOR[src] || "one",
							dstFactor: BLEND_FACTOR[dst] || "zero"
						};
					};
					t.blend = {
						color: comp(a.srcColorBlendFactor, a.dstColorBlendFactor, a.colorBlendOp),
						alpha: comp(a.srcAlphaBlendFactor, a.dstAlphaBlendFactor, a.alphaBlendOp)
					};
				}
				return t;
			})
		};
		if (cb.logicOpEnable) c.log("kwvk: vkCreateGraphicsPipelines: logic ops are unsupported");
	} else if (rs.rasterizerDiscardEnable) c.log("kwvk: vkCreateGraphicsPipelines: rasterizer discard is unsupported (fragments dropped)");
	if (sp.depthFormat) {
		const df = sp.depthFormat;
		const d = dss;
		const depth = hasDepth(df);
		const stencil = hasStencil(df);
		const face = (s) => d.stencilTestEnable && s ? {
			compare: COMPARE[s.compareOp] || "always",
			failOp: STENCIL_OP[s.failOp] || "keep",
			depthFailOp: STENCIL_OP[s.depthFailOp] || "keep",
			passOp: STENCIL_OP[s.passOp] || "keep"
		} : {
			compare: "always",
			failOp: "keep",
			depthFailOp: "keep",
			passOp: "keep"
		};
		const ds = {
			format: df,
			depthWriteEnabled: depth && !cullAll && !!d.depthTestEnable && !!d.depthWriteEnable,
			depthCompare: depth && d.depthTestEnable ? COMPARE[d.depthCompareOp] || "less" : "always"
		};
		if (stencil) {
			ds.stencilFront = face(d.front);
			ds.stencilBack = face(d.back);
			ds.stencilReadMask = rm ?? d.front?.compareMask ?? 255;
			ds.stencilWriteMask = d.stencilTestEnable && !cullAll ? wm ?? d.front?.writeMask ?? 255 : 0;
		}
		if (tri && depth) {
			const b = useBias || (rs.depthBiasEnable ? [
				rs.depthBiasConstantFactor || 0,
				rs.depthBiasClamp || 0,
				rs.depthBiasSlopeFactor || 0
			] : void 0);
			if (b && rs.depthBiasEnable) {
				ds.depthBias = Math.round(b[0]);
				ds.depthBiasClamp = b[1];
				ds.depthBiasSlopeScale = b[2];
			}
		}
		desc.depthStencil = ds;
	}
	v = c.dev.createRenderPipeline(desc);
	p.variants.set(key, v);
	return v;
}
function formatFilterable(tex, features) {
	const info = texFormatInfo(tex);
	return !!info && (formatCaps(info, features) & 2) !== 0;
}
function computeVariant(c, p, refined) {
	if (!refined) return p.gpu;
	let v = p.variants.get(refined.refineKey);
	if (!v) {
		v = c.dev.createComputePipeline({
			label: `kwvk pipeline (refined)`,
			layout: refined.layout,
			compute: {
				module: p.stage.module,
				entryPoint: p.stage.res.entryPoint
			}
		});
		p.variants.set(refined.refineKey, v);
	}
	return v;
}
handlers.vkCreateRenderPass2 = handlers.vkCreateRenderPass;
const SPIRV_FORMATS = [
	"",
	"rgba32float",
	"rgba16float",
	"r32float",
	"rgba8unorm",
	"rgba8snorm",
	"rg32float",
	"rg16float",
	"",
	"r16float",
	"rgba16unorm",
	"rgb10a2unorm",
	"rg16unorm",
	"rg8unorm",
	"r16unorm",
	"r8unorm",
	"rgba16snorm",
	"rg16snorm",
	"rg8snorm",
	"r16snorm",
	"r8snorm",
	"rgba32sint",
	"rgba16sint",
	"rgba8sint",
	"r32sint",
	"rg32sint",
	"rg16sint",
	"rg8sint",
	"r16sint",
	"r8sint",
	"rgba32uint",
	"rgba16uint",
	"rgba8uint",
	"r32uint",
	"rgb10a2uint",
	"rg32uint",
	"rg16uint",
	"rg8uint",
	"r16uint",
	"r8uint"
];
async function wasmBytes(src) {
	if (typeof src === "string" || src instanceof URL) {
		const url = typeof src === "string" ? new URL(src, globalThis.location?.href ?? import.meta.url) : src;
		if (url.protocol === "file:") {
			const fs = globalThis.process?.getBuiltinModule?.("node:fs/promises");
			if (!fs) throw new Error(`kwvk-naga.wasm: cannot read ${url.href} here`);
			return fs.readFile(url);
		}
		src = fetch(url);
	}
	const res = await src;
	if (typeof Response !== "undefined" && res instanceof Response) {
		if (!res.ok) throw new Error(`kwvk-naga.wasm: HTTP ${res.status}`);
		return res.arrayBuffer();
	}
	return res;
}
async function loadVkShader(wasm) {
	const module = await WebAssembly.compile(await wasmBytes(wasm));
	let ex = (await WebAssembly.instantiate(module, {})).exports;
	const enc = new TextEncoder();
	const dec = new TextDecoder();
	let broken = false;
	return { translate(spirv, opts) {
		if (broken) {
			ex = new WebAssembly.Instance(module, {}).exports;
			broken = false;
		}
		const e = ex;
		let text = `stage=${opts.stage}\nentry=${opts.entryPoint}\nflipY=${opts.flipY ? 1 : 0}\npushGroup=${opts.pushGroup ?? 0}\n`;
		for (const [id, v] of Object.entries(opts.spec ?? {})) text += `spec.${id}=${typeof v === "boolean" ? v ? 1 : 0 : v}\n`;
		for (const [sb, a] of Object.entries(opts.arrays ?? {})) text += `array.${sb}=${a.base},${a.count}\n`;
		for (const [sb, f] of Object.entries(opts.storageFormats ?? {})) {
			const n = SPIRV_FORMATS.indexOf(f);
			if (n > 0) text += `format.${sb}=${n}\n`;
		}
		const l = opts.limits;
		if (l) text += `limits=${l.maxComputeWorkgroupSizeX},${l.maxComputeWorkgroupSizeY},${l.maxComputeWorkgroupSizeZ},${l.maxComputeInvocationsPerWorkgroup}\n`;
		if (opts.features?.length) text += `features=${opts.features.join(",")}\n`;
		if (opts.subgroupSize) text += `subgroupSize=${opts.subgroupSize}\n`;
		for (const v of opts.link ?? []) text += `link.${v.location}=${v.interpolation},${v.sampling}\n`;
		const o = enc.encode(text);
		const sp = e.kwvk_alloc(spirv.length);
		const op = e.kwvk_alloc(o.length);
		new Uint8Array(e.memory.buffer, sp, spirv.length).set(spirv);
		new Uint8Array(e.memory.buffer, op, o.length).set(o);
		let json;
		try {
			const rp = e.kwvk_translate(sp, spirv.length, op, o.length);
			const len = new DataView(e.memory.buffer).getUint32(rp, true);
			json = dec.decode(new Uint8Array(e.memory.buffer, rp + 4, len));
			e.kwvk_free(rp, len + 4);
			e.kwvk_free(sp, spirv.length);
			e.kwvk_free(op, o.length);
		} catch (err) {
			broken = true;
			throw new Error(`SPIR-V translation crashed (a naga panic): ${err.message}`);
		}
		const r = JSON.parse(json);
		if (r.error !== void 0) throw new Error(r.error);
		return r;
	} };
}
export { ABS_MAX, ABS_X, ABS_Y, ANSI, BTN_LEFT, BTN_MIDDLE, BTN_RIGHT, BU, BaseDisk, BootError, CMD_PORT, CommandError, Conn, ConsoleRouter, CowDisk, DEFAULT_DISPLAY_SIZE, DEFAULT_WISP_SERVERS, DEVICE_SPEC_VERSION, DOM_CODE_TO_LINUX, DRM_FORMATS, DT, Deframer, DisplayHost, DistroDisk, EV_ABS, EV_KEY, EV_REL, EV_SYN, FOURCC_XRGB8888, FS_DEFAULT_OWNER, F_DISCARD, F_FLUSH, F_RO, F_WRITE_ZEROES, FlushTracker, FsError, GL_FORWARDER, GL_PORT, GlHost, HOLD_CLOCK_LAG_MS, HTTP_MAX_HEADER_BYTES, HttpBase, IMPORTANT, INPUT_KEYBOARD, INPUT_MOUSE, INPUT_TABLET, IRQ_SYNC, InputHost, JitHost, KSTAMP, KWSPARSE_MAGIC, Kernel, KernelInstance, MUX, MemoryFs, MountError, NetStack, PROFILE_ANON, PROFILE_UNKNOWN, PtyError, REL_WHEEL, REL_X, REL_Y, SHM_PAGE_SIZE, SNAPSHOT_COMMIT_TIMEOUT_MS, SOUND_FORMAT_S16_LE, SOUND_FORMAT_U8, SS, ShmClient, ShmDevice, ShmError, ShmInPlace, ShmShareServer, SnapshotCommitError, SoundHost, SoundRingReader, SoundRingWriter, SparseBase, StreamHost, TTY_DETACH_TIMEOUT, TTY_FEATURE_CONNECT, TTY_FEATURE_DETACH, TTY_FEATURE_PIPES, TTY_FEATURE_USER, TTY_PORT, TTY_SIGNALS, TTY_VERSION, TU, TtyFrameParser, UNUSED, VA_PORT, VK_ERROR_FEATURE_NOT_PRESENT, VK_FEATURES, VK_MAX_FRAME, VK_MAX_OBJECTS, VK_PORT, VK_SUBGROUP_SIZE, VSOCK_GUEST_CID, VSOCK_HEADER_SIZE, VSOCK_HOST_CID, VaHost, VkDeviceLost, VkHost, VkRenderer, VkResultError, VsockDevice, VsockError, VsockHost, WASI_EXEC_PORT, WorkerKernel, ZERO_BLOCK, ZeroBase, attachPty, bundledBoot, checkJspi, checkSupport, computeVariant, connectGuest, convertPcm, coreDevices, createKernelOn, createSoundRing, decodeKwsparse, decodeSnapshot, decodeVsockHeader, dkey, domButtonToLinux, domCodeToLinux, download, effectiveExt, encodeKwsparse, encodeSnapshot, encodeTtyAttach, encodeTtyFrame, encodeTtyOpen, encodeTtyResize, encodeVsockPacket, execSubprocess, extendDevices, fetchOver, fetchRoutes, firstLine, formatProfile, fragmentInputs, frame, frame$1, frameToPpm, gunzipIfNeeded, gzipBlob, inlineShm, ip4$1 as ip4, ip4str, isDiskSpec, isNetSpec, isWhole, isZeroBlock, jitSimd, kwsparseHeader, loadBytes, loadKernelModule, loadVkShader, moduleIsMemory64, newStats, noGpu, pcmToFloat32, pipelineVariant, probeDistro, pruneDeadBindings, readDistroHeader, readKwsparse, readTexture, relinkVertexOutputs, serveWasiProgramsWith, sharedMemoryAvailable, smpKernelFromBundle, snapshotCpuMismatch, snapshotDeviceMismatch, snapshotDiskMismatch, spawnPty, spawnSubprocess, symbolizeProfile, vkDeviceDescriptor, wavHeader, wispBackend, xrgbToRgba };
