import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LOCAL_MODEL_CHANNEL_CANCEL, LOCAL_MODEL_CHANNEL_CHUNK, LOCAL_MODEL_CHANNEL_OFFER,
  LOCAL_MODEL_CHANNEL_PROTOCOL,
} from '../../extension/shared/feature-lease-protocol.js';

// why: the real web decode loop needs web Tensor, not the Node ONNX stub.
const savedRelease = process.release;
let real: any;
try {
  Object.defineProperty(process, 'release', { value: { ...savedRelease, name: 'web' }, configurable: true });
  real = await import(pathToFileURL(resolve('extension/vendor/transformers/transformers.js')).href);
} finally { Object.defineProperty(process, 'release', { value: savedRelease, configurable: true }); }

// why: inject only weights and tokenizer into a private source copy. Keep the
// real offer, abort, streamer and vendored generation loop unchanged.
const source = readFileSync('extension/offscreen/local-model.js', 'utf8')
  .replace("'./muse-glimmer-stream.js'", JSON.stringify(pathToFileURL(resolve('extension/offscreen/muse-glimmer-stream.js')).href));
const temporary = mkdtempSync(join(tmpdir(), 'peerd-local-stop-'));
const fixturePath = join(temporary, 'local-model.mjs');
writeFileSync(fixturePath, `${source}
export const configureFixture = (runtime, tokens, weights) => {
  tx = runtime; tokenizer = tokens; model = weights; residentId = 'gemma-4-e2b';
};`);
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
const local: any = await import(pathToFileURL(fixturePath).href);

const until = async (condition: () => boolean) => {
  const deadline = performance.now() + 2000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('local generation did not settle');
    await Bun.sleep(1);
  }
};

test('Stop through the real channel ends Transformers decoding and frees the next turn', async () => {
  let steps = 0;
  class FixtureModel extends real.PreTrainedModel {
    constructor() { super({ model_type: 'fixture', eos_token_id: 0 }, {}, {}); this.can_generate = true; }
    _validate_model_class() {}
    prepare_inputs_for_generation(_ids: unknown, inputs: unknown) { return inputs; }
    async forward() {
      await Bun.sleep(1);
      steps++;
      const logits = new Float32Array(8);
      logits[1 + steps % 6] = 10;
      return { logits: new real.Tensor('float32', logits, [1, 1, 8]) };
    }
  }
  let tokenize = async () => ({
    input_ids: new real.Tensor('int64', BigInt64Array.from([5n, 6n, 7n]), [1, 3]),
    attention_mask: new real.Tensor('int64', BigInt64Array.from([1n, 1n, 1n]), [1, 3]),
  });
  const tokens = Object.assign(() => tokenize(), {
    apply_chat_template: () => 'fixture prompt', all_special_ids: [0],
    decode: (ids: bigint[]) => ids.map((id) => `word${id} `).join(''),
  });
  local.configureFixture(real, tokens, new FixtureModel());
  const channelId = 'stop-fixture-channel';
  const channel = new MessageChannel();
  let stepsAtStop = 0;
  let chunks = 0;
  channel.port1.onmessage = (event) => {
    if (event.data.type !== LOCAL_MODEL_CHANNEL_CHUNK || ++chunks !== 4) return;
    stepsAtStop = steps;
    channel.port1.postMessage({ type: LOCAL_MODEL_CHANNEL_CANCEL, protocol: LOCAL_MODEL_CHANNEL_PROTOCOL, channelId });
    channel.port1.close();
  };
  channel.port1.start();
  const request = { messages: [{ role: 'user', content: 'count words' }], system: '', tools: [], maxTokens: 64, model: 'gemma-4-e2b' };
  try {
    expect(local.acceptLocalModelOffer({ ports: [channel.port2], data: {
      type: LOCAL_MODEL_CHANNEL_OFFER, protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
      channelId, method: 'generate', args: request, lease: { id: 'fixture-model-lease' },
    } }, { ownsLease: () => true })).toBe(true);
    await until(() => stepsAtStop > 0);
    await until(() => !local.generationInFlight());
    expect(steps - stepsAtStop).toBeLessThanOrEqual(2);
    expect(steps).toBeLessThan(64);
    steps = 0;
    const output: string[] = [];
    await local.generateLocal({ ...request, maxTokens: 8 }, (token: string) => output.push(token));
    expect(steps).toBe(8);
    expect(output.join('')).toContain('word');
    expect(local.generationInFlight()).toBe(false);

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalTokenize = tokenize;
    tokenize = async () => { entered.resolve(); await release.promise; return originalTokenize(); };
    const controller = new AbortController();
    steps = 0;
    const stopped = local.generateLocal(request, () => {}, { signal: controller.signal });
    await entered.promise;
    controller.abort();
    release.resolve();
    await stopped;
    expect(steps).toBe(0);
    expect(local.generationInFlight()).toBe(false);
  } finally { channel.port1.close(); channel.port2.close(); }
});
