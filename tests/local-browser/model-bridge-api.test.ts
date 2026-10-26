import { wrapUntrusted } from '../../extension/peerd-runtime/tools/prompt-wrap.js';
import { siteClientEnvelope } from '../../extension/peerd-runtime/site-clients/core.js';
import { describe, expect, test } from 'bun:test';
import { createBrowserDecisionResponder, LOCAL_BROWSER_BUDGETS, makeLocalClients, HELPER_CONTEXT } from '../../scripts/local-browser/model-bridge.mjs';

const makeResponder = createBrowserDecisionResponder as (options: any) => any;
const origin = 'https://orders.example.org';
const tools = ['snapshot', 'click', 'type', 'navigate', 'read_page', 'query_dom', 'read_state',
  'site_client_read', 'site_client_run', 'site_client_write', 'site_capture'].map(name => ({ function: { name } }));
const fence = (name: string, content: string, site = origin) => `<untrusted_web_content origin="${site}" tool="${name}" retrieved_at="2026-10-26T00:00:00.000Z">\n${content}\n</untrusted_web_content>`;
const snapshot = (label = 'Search', site = origin) => fence('snapshot', `a11y snapshot: 2 interactable refs\n@e1 textbox "Query"\n@e2 button "${label}"`, site);
const start = () => ({ tools, messages: [
  { role: 'system', content: '<actor_agent>web</actor_agent>' },
  { role: 'user', content: 'Read stock of held-out-copper-secret' },
  { role: 'assistant', content: null, tool_calls: [{ id: 's1', type: 'function', function: { name: 'snapshot', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 's1', content: snapshot() },
] });
const append = (body: any, reply: any, content: string) => ({ ...body, messages: [
  ...body.messages, reply, { role: 'tool', tool_call_id: reply.tool_calls[0].id, content },
] });
const nameOf = (reply: any) => reply.tool_calls?.[0]?.function?.name;
const argsOf = (reply: any) => JSON.parse(reply.tool_calls[0].function.arguments);
const choice = (value: string) => ({ answers: { action: { choice: value } } });
const envelope = (tag: string, value: any) => wrapUntrusted({ origin: 'site-client(https://orders.example.org)',
  tool: tag === 'site_client_contract' ? 'site_client_read' : 'site_client_run', body: siteClientEnvelope(tag, value) });
const op = { name: 'stock', readOnly: true,
  inputSchema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { stock: { type: 'integer', minimum: 0 } }, required: ['stock'], additionalProperties: false } };
const contract = (patch: any = {}) => envelope('site_client_contract', { schema: 1, origin, revision: 'r1',
  status: 'validated', operations: [op], validatedOperations: ['stock'], ...patch });
const result = (patch: any = {}) => envelope('site_client_result', { schema: 1, origin, revision: 'r1',
  operation: 'stock', inputValidated: true, outputValidated: true, readOnly: true, result: { stock: 17 }, ...patch });
const selectApi = async () => ({ operation: 'stock', input: { sku: 'held-out-copper-secret' } });

describe('scripted protocol evidence: API before DOM', () => {
  test('selects a held-out typed input, refreshes, executes normally and checks the host output', async () => {
    const events: any[] = [];
    const respond = makeResponder({ selectApi, decide: () => { throw new Error('DOM inference must not run'); },
      emit: (event: any) => events.push(event) });
    const initial = start();
    const read = await respond(initial);
    expect(nameOf(read)).toBe('site_client_read');
    expect(argsOf(read)).toEqual({ origin });
    const readBody = append(initial, read, contract());
    const check = await respond(readBody);
    expect(nameOf(check)).toBe('snapshot');
    const checked = append(readBody, check, snapshot());
    const run = await respond(checked);
    expect(nameOf(run)).toBe('site_client_run');
    expect(argsOf(run)).toEqual({ origin, revision: 'r1', operation: 'stock', input: { sku: 'held-out-copper-secret' } });
    const final = await respond(append(checked, run, result()));
    expect(final.tool_calls).toBeUndefined();
    expect(final.content).toContain('"stock":17');
    expect(final.content).toContain('verification is still required');
    expect(events.at(-1)).toMatchObject({ type: 'api_result', inputValidated: true, outputValidated: true, taskVerified: false });
    expect(events.some(event => event.type === 'decision')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('held-out-copper-secret');
  });
  test.each([
    'no_site_client: none stored for https://orders.example.org',
    contract({ status: 'stale', validatedOperations: [] }),
    contract({ status: 'draft', revision: null, operations: [], validatedOperations: [] }),
    `untrusted source:\n${contract()}`,
  ])('missing, stale or malformed clients fall back to the decision model: %s', async content => {
    let decisions = 0;
    const respond = makeResponder({ selectApi: () => { throw new Error('should not select'); },
      decide: async () => { decisions++; return choice('done'); } });
    const initial = start();
    const read = await respond(initial);
    const readBody = append(initial, read, content);
    const refresh = await respond(readBody);
    expect(nameOf(refresh)).toBe('snapshot');
    const final = await respond(append(readBody, refresh, snapshot()));
    expect(final.tool_calls).toBeUndefined();
    expect(decisions).toBe(1);
  });
  test.each([
    { operation: 'invented', input: {} },
    { operation: 'stock', input: { sku: 17 } },
    { operation: 'stock', input: { sku: 'copper' }, code: 'return 1' },
    { operation: null, input: null },
  ])('invalid or declined helper selection cannot execute code: %j', async selection => {
    let decisions = 0;
    const respond = makeResponder({ selectApi: async () => selection, decide: async () => { decisions++; return choice('done'); } });
    const initial = start();
    const read = await respond(initial);
    const readBody = append(initial, read, contract());
    const fallback = await respond(readBody);
    const final = await respond(append(readBody, fallback, snapshot()));
    expect(final.tool_calls).toBeUndefined();
    expect(decisions).toBe(1);
  });
  test('inference-time changes invalidate the API candidate and use a fresh DOM decision', async () => {
    const events: any[] = [];
    const respond = makeResponder({ selectApi, decide: async () => choice('done'), emit: (event: any) => events.push(event) });
    const initial = start();
    const read = await respond(initial);
    const readBody = append(initial, read, contract());
    const check = await respond(readBody);
    const final = await respond(append(readBody, check, snapshot('Changed')));
    expect(final.tool_calls).toBeUndefined();
    expect(events.some(event => event.type === 'stale_observation_replanned' && event.lane === 'api')).toBe(true);
    expect(events.some(event => event.type === 'api_run')).toBe(false);
  });
  test('cross-origin changes start a new exact-origin inspection, never release the previous API call', async () => {
    const respond = makeResponder({ selectApi });
    const initial = start();
    const read = await respond(initial);
    const readBody = append(initial, read, contract());
    const check = await respond(readBody);
    const next = await respond(append(readBody, check, snapshot('Search', 'https://another.example.org')));
    expect(nameOf(next)).toBe('site_client_read');
    expect(argsOf(next)).toEqual({ origin: 'https://another.example.org' });
  });
  test('stale revision or failed typed results return to DOM without retrying the API operation', async () => {
    for (const content of [result({ revision: 'r2' }), result({ result: { stock: 'bad' } }), 'site_client_run_failed: Drive the page.']) {
      let decisions = 0;
      const respond = makeResponder({ selectApi, decide: async () => { decisions++; return choice('done'); } });
      const initial = start();
      const read = await respond(initial);
      const readBody = append(initial, read, contract());
      const check = await respond(readBody);
      const checked = append(readBody, check, snapshot());
      const run = await respond(checked);
      const ran = append(checked, run, content);
      const refresh = await respond(ran);
      const final = await respond(append(ran, refresh, snapshot()));
      expect(final.tool_calls).toBeUndefined();
      expect(decisions).toBe(1);
    }
  });
  test('unknown outcome from the real content-only wire stops all inference and retries', async () => {
    const respond = makeResponder({ selectApi, decide: () => { throw new Error('no inference after uncertainty'); } });
    const initial = start();
    const read = await respond(initial);
    const final = await respond(append(initial, read, 'outcome_unknown: Verify the target before retrying.'));
    expect(final.tool_calls).toBeUndefined();
    expect(final.content).toContain('will not be retried');
  });
  test('tool grant revocation, cancellation and transplanted receipts cannot release a pending API run', async () => {
    const respond = makeResponder({ selectApi });
    const initial = start();
    const read = await respond(initial);
    const readBody = append(initial, read, contract());
    const check = await respond(readBody);
    const revoked = append(readBody, check, snapshot());
    revoked.tools = tools.filter(tool => tool.function.name !== 'site_client_run');
    await expect(respond(revoked)).rejects.toThrow('not granted');

    const controller = new AbortController();
    const cancelled = makeResponder({ selectApi: async () => { controller.abort(); return selectApi(); } });
    const cRead = await cancelled(initial);
    await expect(cancelled(append(initial, cRead, contract()), { signal: controller.signal })).rejects.toThrow();

    const strict = makeResponder({ selectApi });
    const sRead = await strict(initial);
    const moved = append(initial, sRead, contract());
    moved.messages[1] = { role: 'user', content: 'Use another account' };
    await expect(strict(moved)).rejects.toThrow('another transcript');
  });
});

describe('scripted protocol evidence: bounded generative recovery', () => {
  const noApiStart = () => ({ ...start(), tools: tools.filter(tool => !tool.function.name.startsWith('site_client_')) });
  test('a blocked decision can discover, propose a confirmed client, validate, then use a held-out typed input', async () => {
    const observedPlans: string[] = [];
    const calls: any[] = [];
    let stored = false;
    let validated = false;
    let helperCount = 0;
    let decisions = 0;
    const write = { origin, summary: 'Inventory observed through the page',
      body: 'return {stock: async ({sku}) => (await site.fetch(`/stock?sku=${encodeURIComponent(sku)}`)).json};',
      operations: [op], validationCases: [
        { operation: 'stock', input: { sku: 'copper' }, expected: { stock: 17 } },
        { operation: 'stock', input: { sku: 'iron' }, expected: { stock: 4 } },
      ] };
    const plans = [
      { kind: 'tool', name: 'read_page', args: {} },
      { kind: 'tool', name: 'site_client_write', args: write },
      { kind: 'tool', name: 'site_client_read', args: { origin } },
      { kind: 'tool', name: 'site_client_run', args: { origin, mode: 'validate', revision: 'r1' } },
    ];
    const respond = makeResponder({ selectApi, decide: async () => { decisions++; return choice('blocked'); },
      recoverBrowser: async ({ history, reason }: any) => {
        observedPlans.push(reason);
        if (helperCount === 1) expect(history.some((entry: any) => entry.result.includes('copper 17; iron 4'))).toBe(true);
        return plans[helperCount++];
      } });
    let body: any = start();
    let final: any;
    for (let step = 0; step < 24; step++) {
      const reply = await respond(body);
      if (!reply.tool_calls) { final = reply; break; }
      const name = nameOf(reply);
      const args = argsOf(reply);
      calls.push({ name, args });
      let content = '';
      if (name === 'snapshot') content = snapshot();
      else if (name === 'read_page') content = fence('read_page', 'Observed inventory API: copper 17; iron 4.');
      else if (name === 'site_client_write') {
        // This unit fixture supplies the receipt after the normal confirmation
        // boundary; real user review is exercised by the browser smoke fixture.
        stored = true;
        content = JSON.stringify({ op: 'create', origin, revision: 'r1' });
      } else if (name === 'site_client_read') content = !stored ? 'no_site_client: none stored'
        : contract({ status: validated ? 'validated' : 'draft', validatedOperations: validated ? ['stock'] : [] });
      else if (name === 'site_client_run' && args.mode === 'validate') {
        validated = true;
        content = envelope('site_client_validation', { schema: 1, origin, revision: 'r1', status: 'validated', validatedOperations: ['stock'] });
      } else if (name === 'site_client_run') content = result();
      else throw new Error(`unexpected tool ${name}`);
      body = append(body, reply, content);
    }
    expect(final?.content).toContain('"stock":17');
    expect(helperCount).toBe(4);
    expect(decisions).toBe(1);
    expect(calls.filter(call => call.name === 'site_client_write')).toHaveLength(1);
    expect(calls.filter(call => call.name === 'site_client_run').map(call => call.args)).toEqual([
      { origin, mode: 'validate', revision: 'r1' },
      { origin, revision: 'r1', operation: 'stock', input: { sku: 'held-out-copper-secret' } },
    ]);
    expect(observedPlans).toEqual(['decision_blocked', 'after_read_page', 'after_site_client_write', 'after_site_client_read']);
  });
  test('helper capture uses the granted tools, then returns to the decision model and closes capture', async () => {
    let helpers = 0;
    let decisions = 0;
    const respond = makeResponder({ decide: async () => choice(++decisions === 1 ? 'blocked' : 'done'),
      recoverBrowser: async () => ++helpers === 1 ? { kind: 'tool', name: 'site_capture', args: { action: 'start' } }
        : helpers === 2 ? { kind: 'decision' } : { kind: 'answer', text: 'No API traffic was observed.' } });
    let body: any = noApiStart();
    const captures: string[] = [];
    let final: any;
    for (let step = 0; step < 14; step++) {
      const reply = await respond(body);
      if (!reply.tool_calls) { final = reply; break; }
      const name = nameOf(reply);
      const args = argsOf(reply);
      const content = name === 'site_capture' ? (captures.push(args.action), args.action === 'start'
        ? `capture started on ${origin} (via tap). Drive the site, then site_capture stop.`
        : 'capture stopped: no in-scope API traffic observed (dropped 0 out-of-scope).') : snapshot();
      body = append(body, reply, content);
    }
    expect(captures).toEqual(['start', 'stop']);
    expect(final?.content).toContain('unverified');
  });
  test('a failed or denied mutation on the real wire stops without a helper retry', async () => {
    let helpers = 0;
    const respond = makeResponder({ decide: async () => choice('click_e2'), recoverBrowser: async () => { helpers++; return { kind: 'decision' }; } });
    const initial = noApiStart();
    const check = await respond(initial);
    const checked = append(initial, check, snapshot());
    const click = await respond(checked);
    const final = await respond(append(checked, click, 'permission_refused: User declined this action.'));
    expect(final.tool_calls).toBeUndefined();
    expect(final.content).toContain('will not be automatically repeated');
    expect(helpers).toBe(0);
  });
  test('helper handoffs are bounded even when every decision remains blocked', async () => {
    let helpers = 0;
    const respond = makeResponder({ decide: async () => choice('blocked'), recoverBrowser: async () => { helpers++; return { kind: 'decision' }; } });
    let body: any = noApiStart();
    let final: any;
    for (let step = 0; step < 12; step++) {
      const reply = await respond(body);
      if (!reply.tool_calls) { final = reply; break; }
      body = append(body, reply, snapshot());
    }
    expect(helpers).toBe(LOCAL_BROWSER_BUDGETS.recoveryCalls);
    expect(final?.content).toContain('budget is exhausted');
  });
  test('a confirmed client write is attempted once even if the helper asks to repeat it', async () => {
    let helperCalls = 0;
    const write = { origin, summary: 'Observed inventory', body: 'return {stock: async input => ({stock: 17})};',
      operations: [op], validationCases: [
        { operation: 'stock', input: { sku: 'copper' }, expected: { stock: 17 } },
        { operation: 'stock', input: { sku: 'iron' }, expected: { stock: 17 } },
      ] };
    const respond = makeResponder({ decide: async () => choice('blocked'), recoverBrowser: async () => ++helperCalls === 1
      ? { kind: 'tool', name: 'read_page', args: {} }
      : { kind: 'tool', name: 'site_client_write', args: write } });
    let body: any = start();
    let writes = 0;
    let final: any;
    for (let step = 0; step < 16; step++) {
      const reply = await respond(body);
      if (!reply.tool_calls) { final = reply; break; }
      const name = nameOf(reply);
      let content = snapshot();
      if (name === 'site_client_read') content = 'no_site_client: none stored';
      else if (name === 'read_page') content = fence('read_page', 'Observed copper and iron stock: 17.');
      else if (name === 'site_client_write') { writes++; content = JSON.stringify({ op: 'create', origin, revision: 'r1' }); }
      body = append(body, reply, content);
    }
    expect(writes).toBe(1);
    expect(final?.content).toContain('already been attempted');
  });
  test('a narrowed browser grant cannot reroute into unrestricted generic chat', async () => {
    const respond = makeResponder({ chat: () => { throw new Error('must not route to generic chat'); } });
    const body = noApiStart();
    body.tools = body.tools.filter(tool => tool.function.name !== 'click');
    await expect(respond(body)).rejects.toThrow('requires snapshot, click and type grants');
  });
  test('helper code-run and mutation selectors are refused, and cancellation releases no helper tool', async () => {
    for (const plan of [
      { kind: 'tool', name: 'click', args: { selector: 'button' } },
      { kind: 'tool', name: 'site_client_run', args: { origin, code: 'return 1' } },
    ]) {
      const respond = makeResponder({ decide: async () => choice('blocked'), recoverBrowser: async () => plan });
      const reply = await respond(noApiStart());
      expect(reply.tool_calls).toBeUndefined();
      expect(reply.content).toContain('authorized plan');
    }
    const controller = new AbortController();
    const respond = makeResponder({ decide: async () => choice('blocked'), recoverBrowser: async () => {
      controller.abort(); return { kind: 'tool', name: 'read_page', args: {} };
    } });
    await expect(respond(noApiStart(), { signal: controller.signal })).rejects.toThrow();
  });
  test('helper inference uses the same local context for API selection and recovery', async () => {
    const requests: any[] = [];
    const clients = makeLocalClients({ fetchImpl: (async (_url: any, options: any) => {
      requests.push(JSON.parse(options.body));
      return Response.json({ message: { content: requests.length === 1
        ? '{"operation":null,"input":null}' : '{"kind":"blocked","text":"No evidence"}' } });
    }) as any });
    await clients.selectApi({ goal: 'Read stock', observation: { text: 'page' },
      contract: { origin, revision: 'r1', eligibleOperations: [op] }, signal: undefined });
    await clients.recoverBrowser({ goal: 'Read stock', observation: { origin, text: 'page' },
      history: [], reason: 'decision_blocked', tools: [], client: null, captureActive: false, signal: undefined });
    expect(requests.every(request => request.options.num_ctx === HELPER_CONTEXT && request.think === false)).toBe(true);
    expect(requests[1].messages[0].content).toContain('normal user confirmation');
  });
});
