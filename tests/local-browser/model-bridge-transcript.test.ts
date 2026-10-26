import { describe, expect, test } from 'bun:test';
import { createBrowserDecisionResponder } from '../../scripts/local-browser/model-bridge.mjs';

const makeResponder = createBrowserDecisionResponder as (options: any) => any;
const snapshot = 'a11y snapshot: 1 interactable refs\n@e1 button "Apply"';
const tools = ['snapshot', 'click', 'type', 'navigate', 'read_page', 'site_client_read', 'site_client_run', 'site_client_write']
  .map(name => ({ function: { name } }));
const call = (id: string, name = 'snapshot', args: any = {}) => ({ id, type: 'function',
  function: { name, arguments: JSON.stringify(args) } });
const assistant = (...calls: any[]) => ({ role: 'assistant', content: null, tool_calls: calls });
const receipt = (id: string, content = snapshot) => ({ role: 'tool', tool_call_id: id, content });
const start = () => ({ tools, messages: [
  { role: 'user', content: 'Apply this change once' }, assistant(call('initial')), receipt('initial'),
] });
const append = (body: any, reply: any, content: string) => ({ ...body, messages: [
  ...body.messages, reply, receipt(reply.tool_calls[0].id, content),
] });
const selectedClick = () => ({ answers: { action: { choice: 'click_e1' } } });

describe('current-goal browser transcript integrity', () => {
  test('an emitted mutation with no receipt cannot request a refresh or issue a second mutation', async () => {
    let decisions = 0;
    let helperCalls = 0;
    const respond = makeResponder({ decide: async () => { decisions++; return selectedClick(); },
      recoverBrowser: async () => { helperCalls++; return { kind: 'decision' }; } });
    const initial = start();
    const check = await respond(initial);
    const checked = append(initial, check, snapshot);
    const firstClick = await respond(checked);
    expect(firstClick.tool_calls[0].function.name).toBe('click');
    const missing = { ...checked, messages: [...checked.messages, firstClick] };
    await expect(respond(missing)).rejects.toThrow('unresolved');
    // A caller cannot make the omitted result disappear by appending a later
    // apparently fresh snapshot exchange. The earlier call is still open.
    const laterSnapshot = { ...missing, messages: [...missing.messages,
      assistant(call('later-snapshot')), receipt('later-snapshot'),
    ] };
    await expect(respond(laterSnapshot)).rejects.toThrow('no receipt');
    expect(decisions).toBe(1);
    expect(helperCalls).toBe(0);
  });
  test.each(['click', 'type', 'navigate', 'site_client_write', 'site_client_run'])('%s with an absent receipt fails before either model', async name => {
    const respond = makeResponder({ decide: () => { throw new Error('must not infer'); },
      selectApi: () => { throw new Error('must not select'); }, recoverBrowser: () => { throw new Error('must not recover'); } });
    const initial = start();
    const body = { ...initial, messages: [...initial.messages, assistant(call('unresolved', name))] };
    await expect(respond(body)).rejects.toThrow('incomplete browser transcript');
  });
  test.each([
    ['duplicate receipt', () => [...start().messages, receipt('initial')]],
    ['unmatched receipt', () => [...start().messages, receipt('never-called')]],
    ['reused call ID', () => [...start().messages, assistant(call('initial')), receipt('initial')]],
    ['duplicate batch ID', () => [...start().messages, assistant(call('next'), call('next')), receipt('next')]],
    ['out-of-order batch', () => [...start().messages, assistant(call('first'), call('second')), receipt('second'), receipt('first')]],
    ['incomplete batch', () => [...start().messages, assistant(call('first'), call('second')), receipt('first')]],
    ['interleaved assistant', () => [...start().messages, assistant(call('next')),
      { role: 'assistant', content: 'Interleaved explanation' }, receipt('next')]],
    ['trailing assistant', () => [...start().messages, { role: 'assistant', content: 'Completed already' }]],
    ['interleaved system', () => [...start().messages, { role: 'system', content: 'Unexpected continuation' }]],
    ['nontext receipt', () => [...start().messages, assistant(call('next')), { role: 'tool', tool_call_id: 'next', content: {} }]],
    ['malformed arguments', () => [...start().messages, assistant({ ...call('next'), function: { name: 'snapshot', arguments: '{' } }), receipt('next')]],
    ['nonobject arguments', () => [...start().messages, assistant(call('next', 'snapshot', null)), receipt('next')]],
  ] as const)('refuses %s without using the preceding observation', async (_name, messages) => {
    let calls = 0;
    const respond = makeResponder({ decide: async () => { calls++; return selectedClick(); } });
    await expect(respond({ tools, messages: messages() })).rejects.toThrow('incomplete browser transcript');
    expect(calls).toBe(0);
  });
  test('only matching ordered receipt batches are accepted', async () => {
    const respond = makeResponder({ decide: () => { throw new Error('read receipt requires a new snapshot first'); } });
    const body = { tools, messages: [
      { role: 'user', content: 'Read the current page' },
      assistant(call('snap'), call('read', 'read_page')), receipt('snap'), receipt('read', 'Observed page content'),
    ] };
    const reply = await respond(body);
    expect(reply.tool_calls[0].function.name).toBe('snapshot');
  });
  test('the latest user boundary cannot import old receipts or reuse an earlier call ID', async () => {
    const respond = makeResponder({});
    const initial = start();
    const steered = [...initial.messages, { role: 'user', content: 'New request on this tab' }];
    await expect(respond({ tools, messages: [...steered, receipt('initial')] })).rejects.toThrow('incomplete browser transcript');
    await expect(respond({ tools, messages: [...steered, assistant(call('initial')), receipt('initial')] })).rejects.toThrow('reuses an ID');
    const fresh = await respond({ tools, messages: steered });
    expect(fresh.tool_calls[0].function.name).toBe('snapshot');
  });
  test.each([
    'tool dispatch did not complete before an interruption. If an interruption-recovery note covers this call, follow it; otherwise treat as failed and retry if needed.',
    'outcome_unknown: Verify the target before retrying.',
    'permission_refused: User declined the action.',
  ])('a later snapshot cannot erase an earlier current-goal mutation failure: %s', async failedReceipt => {
    let decisions = 0;
    const respond = makeResponder({ decide: async () => { decisions++; return selectedClick(); } });
    const initial = start();
    const check = await respond(initial);
    const checked = append(initial, check, snapshot);
    const firstClick = await respond(checked);
    const failed = append(checked, firstClick, failedReceipt);
    const laterSnapshot = { ...failed, messages: [...failed.messages,
      assistant(call('after-failure')), receipt('after-failure'),
    ] };
    const final = await respond(laterSnapshot);
    expect(final.tool_calls).toBeUndefined();
    expect(final.content).toContain('will not');
    expect(decisions).toBe(1);
  });
});
