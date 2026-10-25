import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTurnSlots } from '../../extension/peerd-runtime/loop/turn-slots.js';

// why: the private shell has no import seam. Execute its exact function body.
// This checks the body only. A real panel reload must still check module wiring.
const kernel = readFileSync(join(import.meta.dir, '../../extension/background/vault-kernel.js'), 'utf8');
const start = kernel.indexOf('const pushState = ');
if (start < 0) throw new Error('kernel pushState entry not found');
const body = kernel.slice(start + 'const pushState = '.length, kernel.indexOf('\n};', start) + 2);
const bindPush = new Function('stateSnapshot', 'controllerRelays', 'confirmation', 'uiPorts', 'generation', `return ${body}`);

test.each(['busy', 'starts during snapshot', 'ends during snapshot', 'other chat busy'])(
  'kernel hydration reads the owner slot after the snapshot: %s', async (phase) => {
    const slots = makeTurnSlots(), events: any[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let lease = ['busy', 'ends during snapshot'].includes(phase) ? slots.claim('owner') : null;
    const other = phase === 'other chat busy' ? slots.claim('other') : null;
    const state = { session: { sessionId: 'owner' }, projection: { authorityEpoch: 'owner-epoch', generation: 2 } };
    const push = bindPush(async () => { await held; return state; }, () => ({ turnSlots: slots }), {
      coordinator: { getPendingForOwner: (ownerSessionId: string) => ({ ownerSessionId }) },
    }, { broadcast: (event: any) => events.push(event) }, { bind: (event: any) => event });
    const pending = push();
    expect(events).toEqual([]);
    if (phase === 'starts during snapshot') lease = slots.claim('owner');
    if (phase === 'ends during snapshot') lease!.release();
    release();
    expect(await pending).toBe(state);
    expect(events.slice(0, 2)).toEqual([
      { type: 'state', state }, { type: 'confirm/request', prompt: { ownerSessionId: 'owner' } },
    ]);
    expect(events.slice(2)).toEqual([{ type: 'turn/streaming', sessionId: 'owner',
      streaming: ['busy', 'starts during snapshot'].includes(phase), replay: true, projection: state.projection }]);
    lease?.release(); other?.release();
  },
);

test('eval ignores hydration replays but records real start and Stop activity', () => {
  const source = readFileSync(join(import.meta.dir, '../../extension/eval/runner.js'), 'utf8');
  const begin = source.indexOf('port.onMessage.addListener(') + 'port.onMessage.addListener('.length;
  const listener = source.slice(begin, source.indexOf('\n});', begin) + 2);
  const turn = { started: false };
  let activity = 0;
  const receive = new Function('turn', 'bumpSettle', `return ${listener}`)(turn, () => { activity++; });
  receive({ type: 'turn/streaming', streaming: false, replay: true });
  receive({ type: 'turn/streaming', streaming: true, replay: true });
  expect({ started: turn.started, activity }).toEqual({ started: false, activity: 0 });
  receive({ type: 'turn/streaming', streaming: true });
  receive({ type: 'turn/streaming', streaming: false });
  expect({ started: turn.started, activity }).toEqual({ started: true, activity: 2 });
});
