import { describe, expect, test } from 'bun:test';
import {
  BRIDGE_MODEL, BRIDGE_TRANSPORT_CONTEXT, HELPER_CONTEXT,
  createBrowserDecisionResponder, localUrl, localJson, makeLocalClients, assistantSse,
} from '../../scripts/local-browser/model-bridge.mjs';
import { createBridgeServer } from '../../scripts/local-browser/serve.mjs';

const makeResponder = createBrowserDecisionResponder as (options: any) => any;
const tools = ['snapshot', 'click', 'type', 'navigate', 'read_page'].map(name => ({ function: { name } }));
const snapshot = (label = 'Search', value = '') => `a11y snapshot: 2 interactable refs\n@e1 textbox "Query" [value="${value}"]\n@e2 button "${label}"`;
const start = () => ({ tools, messages: [
  { role: 'system', content: '<actor_agent>web</actor_agent>' },
  { role: 'user', content: 'Find copper wiring' },
  { role: 'assistant', content: null, tool_calls: [{ id: 's1', type: 'function', function: { name: 'snapshot', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 's1', content: snapshot() },
] });
const append = (body: any, reply: any, content: string) => ({ ...body, messages: [
  ...body.messages, reply, { role: 'tool', tool_call_id: reply.tool_calls[0].id, content },
] });
const chosen = (choice: string) => ({ answers: { action: { choice, probabilities: { [choice]: 0.9 } } } });
const nameOf = (reply: any) => reply.tool_calls?.[0]?.function?.name;

describe('local browser decision bridge', () => {
  test('waits for a second matching observation before dispatching an observed click', async () => {
    const events: any[] = [];
    const respond = makeResponder({ decide: async () => chosen('click_e2'), emit: (e: any) => events.push(e) });
    const initial = start();
    const check = await respond(initial);
    expect(nameOf(check)).toBe('snapshot');
    const action = await respond(append(initial, check, snapshot()));
    expect(nameOf(action)).toBe('click');
    expect(JSON.parse(action.tool_calls[0].function.arguments)).toEqual({ ref: '@e2' });
    expect(events.filter(e => e.type === 'decision')).toHaveLength(1);
  });

  test('replans rather than executing an inference-time stale target', async () => {
    let calls = 0;
    const events: any[] = [];
    const respond = makeResponder({ decide: async () => { calls++; return chosen(calls === 1 ? 'click_e2' : 'blocked'); }, emit: (e: any) => events.push(e) });
    const initial = start();
    const check = await respond(initial);
    const action = await respond(append(initial, check, snapshot('Delete all')));
    expect(action.tool_calls).toBeUndefined();
    expect(calls).toBe(2);
    expect(events.some(e => e.type === 'stale_observation_replanned')).toBe(true);
  });

  test('pending decisions cannot be moved to another task transcript', async () => {
    const respond = makeResponder({ decide: async () => chosen('click_e2') });
    const initial = start();
    const check = await respond(initial);
    const other = append(initial, check, snapshot());
    other.messages[1] = { role: 'user', content: 'Delete everything' };
    await expect(respond(other)).rejects.toThrow('another transcript');
  });

  test('a new user instruction cannot release an old pending click or reuse old evidence', async () => {
    let calls = 0;
    const respond = makeResponder({ decide: async () => { calls++; return chosen('click_e2'); } });
    const initial = start();
    const check = await respond(initial);
    const steered = append(initial, check, snapshot());
    steered.messages.push({ role: 'user', content: 'Actually stop. Do not delete anything.' });
    expect(nameOf(await respond(steered))).toBe('snapshot');
    expect(calls).toBe(1);
    steered.messages[steered.messages.length - 1] = {
      role: 'user', content: 'Find books at https://example.org/books',
    };
    const navigated = await respond(steered);
    expect(nameOf(navigated)).toBe('navigate');
    expect(JSON.parse(navigated.tool_calls[0].function.arguments).url).toBe('https://example.org/books');
  });

  test('a pending verification exchange must be the sole terminal transcript suffix', async () => {
    const respond = makeResponder({ decide: async () => chosen('click_e2') });
    const initial = start();
    const check = await respond(initial);
    const appended = append(initial, check, snapshot());
    appended.messages.push({ role: 'assistant', content: 'Unrelated later message' });
    await expect(respond(appended)).rejects.toThrow('incomplete browser transcript');
  });

  test('text helper is called only for typing, and cannot inject Enter or submit', async () => {
    let texts = 0;
    const respond = makeResponder({ decide: async () => chosen('type_e1'), generateText: async () => { texts++; return 'copper'; } });
    const initial = start();
    const check = await respond(initial);
    const action = await respond(append(initial, check, snapshot()));
    expect(nameOf(action)).toBe('type');
    expect(JSON.parse(action.tool_calls[0].function.arguments)).toEqual({ ref: '@e1', text: 'copper' });
    expect(texts).toBe(1);
    const unsafe = makeResponder({ decide: async () => chosen('type_e1'), generateText: async () => 'copper\n' });
    await expect(unsafe(start())).rejects.toThrow('invalid');
  });

  test('cancellation after model inference releases no browser action', async () => {
    const controller = new AbortController();
    const respond = makeResponder({ decide: async () => { controller.abort(); return chosen('click_e2'); } });
    await expect(respond(start(), { signal: controller.signal })).rejects.toThrow();
  });

  test('DONE records an unverified claim, never benchmark success', async () => {
    const events: any[] = [];
    const respond = makeResponder({ decide: async () => chosen('done'), emit: (e: any) => events.push(e) });
    const reply = await respond(start());
    expect(reply.tool_calls).toBeUndefined();
    expect(reply.content).toContain('verification');
    expect(events.at(-1)).toMatchObject({ type: 'completion_claim', verified: false });
  });

  test('read_page evidence reaches the decision and reply, then is invalidated after an action', async () => {
    const requests: any[] = [];
    const respond = makeResponder({ decide: async (request: any) => {
      requests.push(JSON.parse(request.state));
      return chosen(requests.length === 1 ? 'read_page' : 'done');
    } });
    const initial = start();
    const readCall = await respond(initial);
    expect(nameOf(readCall)).toBe('read_page');
    const withRead = append(initial, readCall, 'Conductivity: 58 MS/m');
    const refresh = await respond(withRead);
    const final = await respond(append(withRead, refresh, snapshot()));
    expect(requests[1].history.at(-1)).toMatchObject({ tool: 'read_page', result: 'Conductivity: 58 MS/m' });
    expect(final.content).toContain('58 MS/m');
    const click = { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'click', arguments: '{"ref":"@e2"}' } }] };
    const changed = append(withRead, click, '<untrusted_web_content origin="https://example.org" tool="click" retrieved_at="2026-10-26T00:00:00.000Z">\n{"clicked":true}\n</untrusted_web_content>');
    const fresh = await respond(changed);
    await respond(append(changed, fresh, snapshot()));
    expect(requests.at(-1).history.some((entry: any) => entry.tool === 'read_page')).toBe(false);
  });

  test('existing code surface fails explicitly instead of broadening authority', async () => {
    const respond = makeResponder({ chat: () => { throw new Error('must not call'); } });
    await expect(respond({ messages: [], tools: [{ function: { name: 'page_code' } }] })).rejects.toThrow('webActorActionSurface=tools');
  });

  test('the bridge never generates a URL: initial navigation uses supplied URL only', async () => {
    const respond = makeResponder({});
    const reply = await respond({ tools, messages: [{ role: 'user', content: 'Find copper on https://example.org/shop.' }] });
    expect(JSON.parse(reply.tool_calls[0].function.arguments)).toEqual({ url: 'https://example.org/shop' });
    const blank = await respond({ tools, messages: [{ role: 'user', content: 'Find copper' }] });
    expect(nameOf(blank)).toBe('snapshot');
  });

  test('malformed/truncated observations cannot trigger decision inference', async () => {
    const respond = makeResponder({ decide: () => { throw new Error('must not call'); } });
    const body = start();
    body.messages[3]!.content = 'a11y snapshot: 2 interactable refs (truncated)\n@e1 textbox "Query"';
    await expect(respond(body)).rejects.toThrow('observation unavailable');
  });

  test('SSE does not fabricate token-usage evidence', () => {
    const sse = assistantSse({ role: 'assistant', content: 'done' });
    expect(sse).toContain('[DONE]');
    expect(sse).not.toContain('usage');
  });
});

describe('local-only inference transport', () => {
  test('native helper sets effective context and translates tool receipts in both directions', async () => {
    let sent: any;
    const clients = makeLocalClients({ fetchImpl: (async (url: any, options: any) => {
      expect(String(url)).toEndWith('/api/chat');
      sent = JSON.parse(options.body);
      return Response.json({ message: { role: 'assistant', content: '', tool_calls: [
        { function: { name: 'click', arguments: { ref: '@e2' } } },
      ] } });
    }) as any });
    const message = await clients.chat(start(), undefined);
    expect(sent.think).toBe(false);
    expect(sent.options.num_ctx).toBe(HELPER_CONTEXT);
    expect(sent.messages[2].tool_calls[0].function.arguments).toEqual({});
    expect(sent.messages[3].tool_name).toBe('snapshot');
    expect(message.tool_calls?.[0]?.function.arguments).toBe('{"ref":"@e2"}');
    expect(message.tool_calls?.[0]?.id).toStartWith('local_chat_');
    await expect(clients.chat({ messages: [{ role: 'user', content: [{ type: 'image_url' }] }] }, undefined)).rejects.toThrow('text-only');
  });
  test('refuses remote, DNS, credentialed, or query-bearing destinations', () => {
    for (const bad of ['https://example.com', 'http://localhost:8000', 'http://user@127.0.0.1:8000', 'http://127.0.0.1:8000/?redirect=x']) {
      expect(() => localUrl(bad)).toThrow();
    }
    expect(localUrl('http://127.0.0.1:8000', '/v1/systemone')).toBe('http://127.0.0.1:8000/v1/systemone');
    expect(() => makeLocalClients({ helperOrigin: 'https://cloud.example' })).toThrow();
  });
  test('sets redirect:error and bounds response bytes', async () => {
    let requestOptions: any;
    const fakeFetch: any = async (_url: any, options: any) => {
      requestOptions = options;
      return new Response('x'.repeat(512_001));
    };
    await expect(localJson('http://127.0.0.1:8000/v1/systemone', {}, undefined, fakeFetch)).rejects.toThrow('budget');
    expect(requestOptions.redirect).toBe('error');
  });
});

describe('HTTP bridge boundary', () => {
  test('helper alias cannot shadow the decision model', () => {
    expect(() => createBridgeServer({ helperModel: BRIDGE_MODEL })).toThrow('must differ');
  });
  test('accepts configured model and rejects drive-by web origin and foreign Host', async () => {
    const create = createBridgeServer as (options: any) => any;
    const server = create({ port: 0, clients: { chat: async () => ({ role: 'assistant', content: 'local' }) } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      expect((await fetch(`${url}/health`)).status).toBe(200);
      expect((await fetch(`${url}/health`, { headers: { origin: 'https://attacker.example' } })).status).toBe(403);
      expect((await fetch(`${url}/health`, { headers: { origin: '' } })).status).toBe(403);
      expect((await fetch(`${url}/health`, { headers: { host: 'attacker.example' } })).status).toBe(403);
      const response = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'peerd-local-browser', messages: [{ role: 'user', content: 'hi' }] }) });
      expect(response.status).toBe(200);
      expect((await response.json()).choices[0].message.content).toBe('local');
      for (const [model, expected] of [[BRIDGE_MODEL, BRIDGE_TRANSPORT_CONTEXT], ['qwen3.5:2b-q4_K_M', HELPER_CONTEXT]]) {
        const info = await fetch(`${url}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) });
        expect((await info.json()).model_info['peerd.context_length']).toBe(expected);
      }
      expect((await fetch(`${url}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'cloud-model' }) })).status).toBe(404);
    } finally { await new Promise<void>(resolve => server.close(resolve)); }
  });
});
