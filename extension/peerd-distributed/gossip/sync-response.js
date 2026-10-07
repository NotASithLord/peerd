// @ts-check
import { OUTGOING_LIMITS } from '../transport/outgoing.js';

export const MAX_SYNC_RESPONSE = 256;
export class SyncWindowRequiredError extends Error {
  constructor() { super('sync history requires window capability'); this.name = 'SyncWindowRequiredError'; }
}
const encoder = new TextEncoder();
/** @param {any} value */
const encodedBytes = (value) => encoder.encode(JSON.stringify(value)).byteLength;

/**
 * @param {{ topic: string, envs: any[], current: () => boolean,
 * maxFrameBytes: () => number, sign: (body: any, sequence: number, done: boolean) => Promise<any> }} options
 */
export async function* syncResponsePages({ topic, envs, current, maxFrameBytes, sign }) {
  if (envs.length > MAX_SYNC_RESPONSE) throw new Error('sync response entry limit');
  const cap = () => {
    const limit = Math.min(OUTGOING_LIMITS.frameBytes, OUTGOING_LIMITS.nativeBytes, maxFrameBytes());
    if (!Number.isFinite(limit) || limit < 1) throw new Error('sync response frame limit unavailable');
    return limit;
  };
  if (!current()) return;
  /** @type {any[][]} */
  const pages = [];
  /** @type {any[]} */
  let page = [];
  let bytes = 2;
  // Bound candidate signing input before crypto. The final signed carrier is
  // measured separately because its topic, metadata and signature also count.
  for (const inner of envs) {
    const innerBytes = encodedBytes(inner);
    if (innerBytes > cap()) throw new Error('sync response entry exceeds frame limit');
    const size = innerBytes + (page.length ? 1 : 0);
    if (page.length && bytes + size > cap()) {
      pages.push(page); page = []; bytes = 2;
    }
    page.push(inner); bytes += size;
  }
  if (page.length || !pages.length) pages.push(page);
  let sequence = 0;
  // Each next() is requested only after the previous page is processed remotely.
  while (pages.length && current()) {
    const selected = /** @type {any[]} */ (pages.shift());
    cap();
    const body = { topic, envs: selected };
    if (encodedBytes(body) > cap()) {
      if (selected.length < 2) throw new Error('sync response entry exceeds frame limit');
      const middle = Math.ceil(selected.length / 2);
      pages.unshift(selected.slice(0, middle), selected.slice(middle));
      continue;
    }
    const response = await sign(body, sequence, pages.length === 0);
    if (!current()) return;
    if (encodedBytes(response) > cap()) {
      // Every split strictly reduces a nonempty page. At most 2*N-1 carriers
      // can be signed; one unrepresentable entry fails without dropping it.
      if (selected.length < 2) throw new Error('sync response entry exceeds frame limit');
      const middle = Math.ceil(selected.length / 2);
      pages.unshift(selected.slice(0, middle), selected.slice(middle));
      continue;
    }
    yield response;
    sequence++;
  }
}

/** Legacy peers cannot acknowledge processing: never stream multiple frames.
 * @param {{ topic: string, envs: any[], current: () => boolean,
 * maxFrameBytes: () => number, sign: (body: any) => Promise<any>,
 * send: (env: any) => Promise<boolean | void> }} options */
export const sendSyncResponse = async ({ topic, envs, current, maxFrameBytes, sign, send }) => {
  if (envs.length > MAX_SYNC_RESPONSE) throw new Error('sync response entry limit');
  if (!current()) return;
  const limit = Math.min(OUTGOING_LIMITS.frameBytes, OUTGOING_LIMITS.nativeBytes, maxFrameBytes());
  // No oversized candidate reaches signing; metadata may still make it exceed
  // the limit, so the complete signed carrier gets the same final check.
  if (encodedBytes({ topic, envs }) > limit) throw new SyncWindowRequiredError();
  const response = await sign({ topic, envs });
  if (!current()) return;
  if (encodedBytes(response) > Math.min(limit, maxFrameBytes())) throw new SyncWindowRequiredError();
  if (await send(response) === false) throw new Error('sync response send failed');
};
