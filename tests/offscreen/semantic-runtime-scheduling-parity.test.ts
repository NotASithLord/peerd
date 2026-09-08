import { describe, expect, test } from 'bun:test';
import {
  makeLaneProbe,
  runActorSchedulingScenario,
  runMainSchedulingScenario,
} from './semantic-runtime-scheduling-fixture';

const schedulingBatches = [[
  { id: 'read-one', name: 'schedule_list' },
  { id: 'read-two', name: 'schedule_list' },
], [
  { id: 'write-one', name: 'schedule_cancel', args: { id: 'one' } },
  { id: 'write-two', name: 'schedule_cancel', args: { id: 'two' } },
]];

describe('main and actor production scheduling parity', () => {
  test.serial('overlaps ordinary reads and keeps writes ordered in both sealed runtimes', async () => {
    const main = makeLaneProbe();
    await runMainSchedulingScenario(schedulingBatches, false, main);
    const actor = makeLaneProbe();
    await runActorSchedulingScenario(schedulingBatches, false, actor);

    for (const probe of [main.state, actor.state]) {
      expect(probe.readTimedOut).toBe(false);
      expect(probe.maxReadActive).toBe(2);
      expect(probe.maxWriteActive).toBe(1);
      expect(probe.writeOrder).toEqual([
        'start:schedule:one', 'end:schedule:one',
        'start:schedule:two', 'end:schedule:two',
      ]);
    }
  });

  test.serial('keeps confirmation-required calls ordered without a tool-name exception', async () => {
    const confirmationBatches = [[
      { id: 'spawn-one', name: 'actor_create', args: { task: 'one' } },
      { id: 'spawn-two', name: 'actor_create', args: { task: 'two' } },
    ]];
    const main = makeLaneProbe();
    await runMainSchedulingScenario(confirmationBatches, true, main);
    const actor = makeLaneProbe();
    await runActorSchedulingScenario(confirmationBatches, true, actor);

    for (const probe of [main.state, actor.state]) {
      expect(probe.maxWriteActive).toBe(1);
      expect(probe.writeOrder).toEqual([
        'start:spawn:one', 'end:spawn:one',
        'start:spawn:two', 'end:spawn:two',
      ]);
    }
    expect(main.state.maxConfirmActive).toBe(1);
    expect(main.state.confirmOrder).toEqual([
      'start:turn.actor.spawn-async', 'end:turn.actor.spawn-async',
      'start:turn.actor.spawn-async', 'end:turn.actor.spawn-async',
    ]);
  });
});
