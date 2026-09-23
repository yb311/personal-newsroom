import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { OpenAiProvider, ProviderError } from '../packages/ai/src/index.ts';
import { AiSdkProvider } from '../packages/ai/src/sdk-provider.ts';

const requests: { url: string; body: any }[] = [];
const readJson = async (req: IncomingMessage): Promise<any> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};
const json = (res: ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
};

const server = createServer(async (req, res) => {
  const body = await readJson(req); const url = req.url ?? ''; requests.push({ url, body });
  const text = JSON.stringify(body);
  if (url.endsWith('/responses')) {
    json(res, 200, {
      id: 'resp-1', created_at: 1, model: body.model,
      output: [{ type: 'message', role: 'assistant', id: 'msg-1', content: [
        { type: 'output_text', text: '{"ok":true}', annotations: [] }
      ] }],
      usage: { input_tokens: 7, input_tokens_details: { cached_tokens: 1 }, output_tokens: 3,
        output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 10 }
    });
    return;
  }
  if (url.includes(':generateContent')) {
    json(res, 200, { candidates: [{ content: { role: 'model', parts: [{ text: 'Verified evidence.' }] },
      finishReason: 'STOP', groundingMetadata: { groundingChunks: [
        { web: { uri: 'https://publisher.example/story', title: 'Publisher story' } }
      ] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 } });
    return;
  }
  if (!url.endsWith('/chat/completions')) return json(res, 404, { error: { message: 'not found' } });
  if (text.includes('AUTHFAIL')) return json(res, 401, { error: { message: 'bad key', type: 'invalid_request_error', code: 'invalid_api_key' } });
  if (text.includes('DELAY')) {
    const timer = setTimeout(() => json(res, 200, { id: 'late', object: 'chat.completion', created: 1, model: 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }] }), 500);
    req.on('close', () => clearTimeout(timer)); return;
  }
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (value: unknown): void => { res.write(`data: ${JSON.stringify(value)}\n\n`); };
    chunk({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'mock',
      choices: [{ index: 0, delta: { role: 'assistant', content: '{"ok":' }, finish_reason: null }] });
    chunk({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'mock',
      choices: [{ index: 0, delta: { content: 'true}' }, finish_reason: null }] });
    chunk({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'mock',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, prompt_tokens_details: { cached_tokens: 3 } } });
    res.end('data: [DONE]\n\n'); return;
  }
  json(res, 200, { id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'mock',
    choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16, prompt_tokens_details: { cached_tokens: 2 } } });
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('mock server did not bind');
const origin = `http://127.0.0.1:${address.port}`;
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };

try {
  const compatible = createOpenAICompatible({ name: 'mock-compatible', baseURL: `${origin}/v1`, apiKey: 'test',
    includeUsage: true, supportsStructuredOutputs: true });
  const provider = new AiSdkProvider({ id: 'openai-compatible', name: 'Mock compatible', fastModel: 'mock', writeModel: 'mock',
    limits: { fast: { maxInputTokens: 8_000, maxOutputTokens: 1_000 }, write: { maxInputTokens: 8_000, maxOutputTokens: 1_000 } },
    model: (id) => compatible.chatModel(id), checkKeyPresent: () => true,
    capabilities: { structured: 'schema' } });

  const checked = await provider.check();
  assert.equal(checked.ok, true);
  const checkRequest = requests.find((r) => r.url.endsWith('/chat/completions'))!;
  assert.equal(checkRequest.body.max_tokens ?? checkRequest.body.max_completion_tokens, 256);

  const generated = await provider.generate<{ ok: boolean }>('', { schema, messages: [
    { role: 'system', content: 'Return JSON.' }, { role: 'user', content: 'NORMAL' }
  ], operation: 'sdk_mock' });
  assert.equal(generated.data.ok, true); assert.deepEqual(generated.usage, { input: 11, output: 5, cacheRead: 2 });
  const generateRequest = requests.find((r) => r.url.endsWith('/chat/completions') && !r.body.stream
    && r.body.messages?.some((m: any) => m.content === 'NORMAL'))!;
  assert.deepEqual(generateRequest.body.messages.map((m: any) => m.role), ['system', 'user']);
  assert.equal(generateRequest.body.response_format.type, 'json_schema');

  const streamed = [];
  for await (const event of provider.stream<{ ok: boolean }>('STREAM', { schema, operation: 'sdk_stream' })) streamed.push(event);
  assert.ok(streamed.some((event) => event.type === 'partial'));
  const final = streamed.findLast((event) => event.type === 'final');
  assert.equal(final?.type === 'final' && final.result.data.ok, true);
  assert.equal(final?.type === 'final' && final.result.usage?.cacheRead, 3);

  await assert.rejects(provider.generate('AUTHFAIL', { schema }), (error: unknown) =>
    error instanceof ProviderError && error.code === 'invalid_key');
  const ctl = new AbortController();
  const delayed = provider.generate('DELAY', { schema, signal: ctl.signal, timeoutMs: 2_000 });
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(delayed, (error: unknown) => error instanceof ProviderError && error.code === 'network');

  const jsonOnly = createOpenAICompatible({ name: 'mock-json', baseURL: `${origin}/v1`, apiKey: 'test', supportsStructuredOutputs: false });
  const loose = new AiSdkProvider({ id: 'openai-compatible', name: 'Mock JSON', fastModel: 'mock', writeModel: 'mock',
    limits: provider.limits, model: (id) => jsonOnly.chatModel(id), checkKeyPresent: () => true,
    capabilities: { structured: 'json' } });
  await loose.generate('JSON MODE', { schema });
  assert.equal(requests.findLast((r) => r.url.endsWith('/chat/completions') && !r.body.stream)?.body.response_format.type, 'json_object');

  const openai = new OpenAiProvider('test', { write: 'mock', fast: 'mock', baseURL: `${origin}/v1` });
  const openaiResult = await openai.generate<{ ok: boolean }>('RESPONSES', { schema });
  assert.equal(openaiResult.data.ok, true);
  const responsesRequest = requests.find((r) => r.url.endsWith('/responses'))!;
  assert.equal(responsesRequest.body.store, false);
  assert.equal(responsesRequest.body.model, 'mock');

  const google = createGoogle({ apiKey: 'test', baseURL: `${origin}/v1beta` });
  const searchProvider = new AiSdkProvider({ id: 'gemini', name: 'Mock Gemini', fastModel: 'gemini-3.8-flash', writeModel: 'gemini-3.8-flash',
    limits: provider.limits, model: (id) => google(id), checkKeyPresent: () => true,
    searchTools: () => ({ google_search: google.tools.googleSearch({}) }) });
  const searched = await searchProvider.search('find this event');
  assert.equal(searched.executed, true); assert.equal(searched.sources[0]?.url, 'https://publisher.example/story');
  assert.equal(searched.usage?.searchCalls, 1);
  const googleRequest = requests.find((r) => r.url.includes(':generateContent'))!;
  assert.ok(JSON.stringify(googleRequest.body.tools).includes('googleSearch'));

  console.log('✅ 真实 AI SDK + 模拟 HTTP：Responses、Chat、SSE、schema、来源、错误、取消与用量');
} finally {
  server.close(); await once(server, 'close');
}
