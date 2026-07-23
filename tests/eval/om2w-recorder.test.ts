// OM2W trajectory recorder — sequencing, filtering, status mapping, and the
// 25-step cap, with all IO injected. The invariants that make an export valid:
// one screenshot per action (after-action) + one final shot, actions in
// result-arrival order, non-page tools never become steps, and the cap HALTS
// the agent (a run rule, not a suggestion).

import { describe, test, expect } from 'bun:test';
import { makeOm2wRecorder } from '../../extension/eval/om2w-recorder.js';

const harness = ({ maxSteps }: { maxSteps?: number } = {}) => {
  let shotN = 0;
  let stopped = 0;
  const rec = makeOm2wRecorder({
    capture: async () => `shot-${shotN++}`,
    tabInfo: async () => `https://site.example/p${shotN}`,
    stop: () => { stopped++; },
    ...(maxSteps ? { maxSteps } : {}),
  });
  return { rec, stops: () => stopped };
};

describe('om2w recorder', () => {
  test('begin records step 0 (initial navigation) with a screenshot', async () => {
    const { rec } = harness();
    await rec.begin('https://start.example/');
    const out = await rec.finish();
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].action).toBe('page -> NAVIGATE -> Initial navigation to https://start.example/');
    expect(out.shots).toHaveLength(2);   // step-0 shot + the final shot
  });

  test('a page action becomes a step on its RESULT, with SUCCESS/FAILED from ok', async () => {
    const { rec } = harness();
    await rec.begin('https://start.example/');
    rec.onToolUse({ toolUseId: 'a', name: 'click', input: { selector: '#buy' } });
    rec.onToolUse({ toolUseId: 'b', name: 'type', input: { selector: '#q', text: 'shoes' } });
    rec.onToolResult({ toolUseId: 'a', result: { ok: true } });
    rec.onToolResult({ toolUseId: 'b', result: { ok: false } });
    const out = await rec.finish();
    expect(out.actions.map((a: any) => a.status)).toEqual([null, 'SUCCESS', 'FAILED']);
    expect(out.actions[1].action).toMatch(/^CLICK \[#buy\] -> .* \| SUCCESS$/);
    expect(out.actions[2].action).toMatch(/\| FAILED$/);
    expect(out.shots).toHaveLength(out.actions.length + 1);
  });

  test('non-page tools and result-less calls never become steps', async () => {
    const { rec } = harness();
    await rec.begin('https://start.example/');
    rec.onToolUse({ toolUseId: 'r', name: 'read_page', input: {} });
    rec.onToolResult({ toolUseId: 'r', result: { ok: true } });        // read → filtered
    rec.onToolUse({ toolUseId: 'm', name: 'message_actor', input: {} });
    rec.onToolResult({ toolUseId: 'm', result: { ok: true } });        // delegation → filtered
    rec.onToolUse({ toolUseId: 'x', name: 'click', input: { selector: '#a' } });
    // no result for 'x' — still pending at finish → not a step
    rec.onToolResult({ toolUseId: 'unknown', result: { ok: true } });  // unmatched → ignored
    const out = await rec.finish();
    expect(out.actions).toHaveLength(1);   // only step 0
  });

  test('the step cap halts the agent and stops recording', async () => {
    const { rec, stops } = harness({ maxSteps: 3 });
    await rec.begin('https://start.example/');   // action 1 of 3 (the initial nav)
    // Fire six page actions; the cap should let exactly two more land, then halt.
    for (let i = 0; i < 6; i++) {
      rec.onToolUse({ toolUseId: `c${i}`, name: 'click', input: { selector: `#b${i}` } });
      rec.onToolResult({ toolUseId: `c${i}`, result: { ok: true } });
    }
    const out = await rec.finish();
    expect(out.capped).toBe(true);
    expect(stops()).toBe(1);                 // agent halted exactly once
    expect(out.actions).toHaveLength(3);     // nav + 2 clicks, then capped
    expect(out.shots).toHaveLength(4);       // one per action + the final shot
  });

  test('page/op events (the CODE surface) become steps: goto/click/fill act, snapshot/content are filtered', async () => {
    const { rec } = harness();
    await rec.begin('https://start.example/');
    rec.onPageOp({ method: 'goto', args: { url: 'https://shop.example' }, ok: true });
    rec.onPageOp({ method: 'snapshot', args: {}, ok: true });                       // perception → filtered
    rec.onPageOp({ method: 'click', args: { selector: '#buy' }, ok: true });
    rec.onPageOp({ method: 'fill', args: { selector: '#q', text: 'shoes' }, ok: false });
    rec.onPageOp({ method: 'content', args: {}, ok: true });                        // perception → filtered
    const out = await rec.finish();
    expect(out.actions.map((a: any) => a.action)).toEqual([
      'page -> NAVIGATE -> Initial navigation to https://start.example/',
      'page -> NAVIGATE -> navigate to https://shop.example | SUCCESS',
      'CLICK [#buy] -> click [#buy] | SUCCESS',
      'TYPE [#q] -> type "shoes" | FAILED',
    ]);
    expect(out.shots).toHaveLength(out.actions.length + 1);
  });

  test('page/op steps count toward the SAME 25-step cap as tool steps', async () => {
    const { rec, stops } = harness({ maxSteps: 3 });
    await rec.begin('https://start.example/');   // step 1 of 3
    rec.onToolUse({ toolUseId: 'a', name: 'click', input: { selector: '#x' } });
    rec.onToolResult({ toolUseId: 'a', result: { ok: true } });   // step 2 (tool path)
    for (let i = 0; i < 4; i++) rec.onPageOp({ method: 'click', args: { selector: `#p${i}` }, ok: true });
    const out = await rec.finish();
    expect(out.capped).toBe(true);
    expect(stops()).toBe(1);
    expect(out.actions).toHaveLength(3);         // nav + tool click + ONE page op, then capped
  });

  test('shots and actions stay paired even when results interleave out of order', async () => {
    const { rec } = harness();
    await rec.begin(null);                   // no start URL → no step 0
    rec.onToolUse({ toolUseId: 'a', name: 'navigate', input: { url: 'https://x.example' } });
    rec.onToolUse({ toolUseId: 'b', name: 'click', input: { selector: '#go' } });
    rec.onToolResult({ toolUseId: 'b', result: { ok: true } });   // b's result arrives first
    rec.onToolResult({ toolUseId: 'a', result: { ok: true } });
    const out = await rec.finish();
    // Order follows RESULT arrival (b then a) — the recorder is honest about
    // what actually completed when, and every action still has its own shot.
    expect(out.actions).toHaveLength(2);
    expect(out.actions[0].action).toMatch(/^CLICK/);
    expect(out.actions[1].action).toMatch(/^page -> NAVIGATE/);
    expect(out.shots).toHaveLength(3);
  });
});