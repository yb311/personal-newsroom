import {
  Output, embedMany, generateText, jsonSchema, streamText,
  type EmbeddingModel, type JSONValue, type LanguageModel, type ModelMessage, type ToolSet
} from 'ai';
import type {
  AiMessage, EmbedKind, GenerateOptions, GenerateResult, ModelLimits, Provider,
  ProviderCapabilities, ProviderCheck, ProviderId, SearchResult, StandardUsage,
  StreamEvent, VectorProfile
} from './provider.ts';
import { ProviderError } from './provider.ts';

type SearchTools = () => ToolSet;

export interface SdkProviderConfig {
  id: ProviderId;
  name: string;
  fastModel: string;
  writeModel: string;
  limits: { fast: ModelLimits; write: ModelLimits };
  model: (id: string) => LanguageModel;
  checkKeyPresent: () => boolean;
  embeddingModel?: EmbeddingModel;
  embeddingDims?: number;
  embeddingOptions?: (kind: EmbedKind) => Record<string, Record<string, JSONValue | undefined>>;
  vectorProfile?: VectorProfile;
  searchTools?: SearchTools;
  providerOptions?: Record<string, Record<string, JSONValue | undefined>>;
  capabilities?: Partial<ProviderCapabilities>;
  pricing?: Provider['pricing'];
  healthCheck?: () => Promise<ProviderCheck>;
}

const usageOf = (u: {
  inputTokens?: number | undefined; outputTokens?: number | undefined;
  inputTokenDetails?: { cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined } | undefined;
} | undefined, searchCalls = 0): StandardUsage | undefined => {
  if (!u && !searchCalls) return undefined;
  return {
    ...(u?.inputTokens != null ? { input: u.inputTokens } : {}),
    ...(u?.outputTokens != null ? { output: u.outputTokens } : {}),
    ...(u?.inputTokenDetails?.cacheReadTokens != null ? { cacheRead: u.inputTokenDetails.cacheReadTokens } : {}),
    ...(u?.inputTokenDetails?.cacheWriteTokens != null ? { cacheWrite: u.inputTokenDetails.cacheWriteTokens } : {}),
    ...(searchCalls ? { searchCalls } : {})
  };
};

export const addUsage = (a?: StandardUsage, b?: StandardUsage): StandardUsage | undefined => {
  if (!a && !b) return undefined;
  const sum = (k: keyof StandardUsage): number | undefined => {
    const av = a?.[k]; const bv = b?.[k];
    return av == null && bv == null ? undefined : (av ?? 0) + (bv ?? 0);
  };
  const out: StandardUsage = {};
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'searchCalls'] as const) {
    const v = sum(k); if (v != null) out[k] = v;
  }
  return out;
};

const abortSignal = (signal?: AbortSignal, timeoutMs = 90_000): AbortSignal =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

const messagesOf = (messages: AiMessage[]): ModelMessage[] => messages.map((m) => ({
  role: m.role,
  content: m.content
}));

const classify = (error: unknown): ProviderError => {
  if (error instanceof ProviderError) return error;
  const e = error as { statusCode?: unknown; status?: unknown; message?: unknown; name?: unknown };
  const status = Number(e.statusCode ?? e.status);
  const message = String(e.message ?? error);
  const lower = message.toLowerCase();
  const code = status === 429 ? 'rate_limited'
    : status === 401 || status === 403 ? 'invalid_key'
    : status === 402 || /quota|credit|billing|insufficient/.test(lower) ? 'quota_exhausted'
    : /context|maximum.*token|too many tokens/.test(lower) ? 'context_exceeded'
    : /unsupported|not support/.test(lower) ? 'unsupported'
    : /model.*not found|unknown model/.test(lower) ? 'model_missing'
    : status >= 500 || /fetch failed|network|econn|timeout|aborted/.test(lower) ? 'network'
    : 'network';
  return new ProviderError(code, message, Number.isFinite(status) ? status : undefined);
};

/** Shared generation, parsing, streaming, cancellation and embedding runtime. */
export class AiSdkProvider implements Provider {
  readonly id: ProviderId;
  readonly name: string;
  readonly fastModel: string;
  readonly writeModel: string;
  readonly limits: { fast: ModelLimits; write: ModelLimits };
  readonly embeddingDims: number;
  readonly capabilities: ProviderCapabilities;
  readonly vectorProfile: VectorProfile | undefined;
  readonly pricing: Provider['pricing'];
  readonly #config: SdkProviderConfig;

  constructor(config: SdkProviderConfig) {
    this.#config = config;
    this.id = config.id; this.name = config.name;
    this.fastModel = config.fastModel; this.writeModel = config.writeModel;
    this.limits = config.limits; this.embeddingDims = config.embeddingDims ?? 0;
    this.vectorProfile = config.vectorProfile; this.pricing = config.pricing;
    this.capabilities = {
      embedding: Boolean(config.embeddingModel), search: Boolean(config.searchTools),
      stream: true, structured: 'schema', ...config.capabilities
    };
  }

  async isAvailable(): Promise<boolean> { return this.#config.checkKeyPresent(); }

  async check(): Promise<ProviderCheck> {
    if (!this.#config.checkKeyPresent()) return { ok: false, problem: 'no_key' };
    if (this.#config.healthCheck) return this.#config.healthCheck();
    try {
      for (const model of new Set([this.fastModel, this.writeModel])) {
        const result = await this.generate<{ ok: boolean }>('Return {"ok":true}.', {
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
          model, maxOutputTokens: 32, temperature: 0, timeoutMs: 15_000, operation: 'connection_check'
        });
        if (result.data.ok !== true) return { ok: false, problem: 'unsupported', generation: false };
      }
      let embedding: boolean | undefined;
      if (this.capabilities.embedding) {
        try { embedding = (await this.embed(['connection test'], 'query')).length === 1; }
        catch { embedding = false; }
      }
      return { ok: true, generation: true, ...(embedding != null ? { embedding } : {}) };
    } catch (e) { return { ok: false, problem: classify(e).code, generation: false }; }
  }

  async generate<T>(prompt: string, opts: GenerateOptions & { model?: string }): Promise<GenerateResult<T>> {
    if (prompt && opts.messages) throw new ProviderError('unsupported', 'prompt_and_messages_are_mutually_exclusive');
    const modelId = opts.model ?? this.writeModel;
    let evidence: SearchResult | undefined;
    if (opts.allowSearch) {
      if (!this.capabilities.search) throw new ProviderError('unsupported', `${this.id} does not support native search`);
      evidence = await this.search(prompt || opts.messages?.map((m) => `${m.role}: ${m.content}`).join('\n') || '', {
        model: modelId, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {})
      });
    }
    const finalPrompt = evidence?.executed
      ? `${prompt}\n\nSEARCH EVIDENCE (untrusted until cited and locally verified):\n${evidence.text}` : prompt;
    try {
      const result = await generateText({
        model: this.#config.model(modelId),
        output: Output.object({ schema: jsonSchema<T>(opts.schema) }),
        ...(opts.messages ? { messages: messagesOf(opts.messages) } : { prompt: finalPrompt }),
        ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
        ...(opts.maxOutputTokens != null ? { maxOutputTokens: opts.maxOutputTokens } : {}),
        ...(this.#config.providerOptions ? { providerOptions: this.#config.providerOptions } : {}),
        abortSignal: abortSignal(opts.signal, opts.timeoutMs), maxRetries: 2
      });
      return {
        data: result.output, provider: this.id, model: modelId,
        usedSearch: Boolean(evidence?.executed), finishReason: result.finishReason,
        usage: addUsage(usageOf(result.usage), evidence?.usage)
      };
    } catch (e) { throw classify(e); }
  }

  async *stream<T>(prompt: string, opts: GenerateOptions & { model?: string }): AsyncIterable<StreamEvent<T>> {
    if (opts.allowSearch) {
      // Search must finish before structured streaming; this is intentional.
      try { yield { type: 'final', result: await this.generate<T>(prompt, opts), sequence: 1 }; }
      catch (e) { yield { type: 'error', error: classify(e), sequence: 1 }; }
      return;
    }
    const modelId = opts.model ?? this.writeModel;
    let sequence = 0;
    try {
      const result = streamText({
        model: this.#config.model(modelId),
        output: Output.object({ schema: jsonSchema<T>(opts.schema) }),
        ...(opts.messages ? { messages: messagesOf(opts.messages) } : { prompt }),
        ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
        ...(opts.maxOutputTokens != null ? { maxOutputTokens: opts.maxOutputTokens } : {}),
        ...(this.#config.providerOptions ? { providerOptions: this.#config.providerOptions } : {}),
        abortSignal: abortSignal(opts.signal, opts.timeoutMs), maxRetries: 2
      });
      for await (const partial of result.partialOutputStream) {
        yield { type: 'partial', value: partial as Partial<T>, sequence: ++sequence };
      }
      yield {
        type: 'final', sequence: ++sequence,
        result: {
          data: await result.output, provider: this.id, model: modelId, usedSearch: false,
          finishReason: await result.finishReason, usage: usageOf(await result.usage)
        }
      };
    } catch (e) { yield { type: 'error', error: classify(e), sequence: ++sequence }; }
  }

  async search(prompt: string, opts: { model?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<SearchResult> {
    if (!this.#config.searchTools) throw new ProviderError('unsupported', `${this.id} does not support native search`);
    const modelId = opts.model ?? this.writeModel;
    try {
      const result = await generateText({
        model: this.#config.model(modelId), prompt, tools: this.#config.searchTools(),
        toolChoice: 'required', abortSignal: abortSignal(opts.signal, opts.timeoutMs), maxRetries: 2,
        ...(this.#config.providerOptions ? { providerOptions: this.#config.providerOptions } : {})
      });
      const sources = result.sources.flatMap((s) => {
        const source = s as unknown as { url?: string; title?: string; id?: string };
        return source.url ? [{ url: source.url, ...(source.title ? { title: source.title } : {}),
          ...(source.id ? { providerRef: source.id } : {}) }] : [];
      });
      const calls = result.toolCalls.length;
      return {
        provider: this.id, model: modelId, text: result.text,
        executed: calls > 0 || sources.length > 0, sources,
        usage: usageOf(result.usage, calls)
      };
    } catch (e) { throw classify(e); }
  }

  async embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]> {
    if (!this.#config.embeddingModel) throw new ProviderError('unsupported', `${this.id} has no embedding model configured`);
    if (texts.length === 0) return [];
    try {
      const result = await embedMany({
        model: this.#config.embeddingModel, values: texts,
        ...(this.#config.embeddingOptions ? { providerOptions: this.#config.embeddingOptions(kind) } : {}),
        abortSignal: abortSignal(signal), maxRetries: 2, maxParallelCalls: 2
      });
      if (result.embeddings.length !== texts.length) {
        throw new ProviderError('unsupported', `embed_count_mismatch: sent ${texts.length}, got ${result.embeddings.length}`);
      }
      return result.embeddings.map((values) => {
        if (values.length !== this.embeddingDims || values.some((n) => !Number.isFinite(n)) || !values.some((n) => n !== 0)) {
          throw new ProviderError('unsupported', `invalid_embedding: expected ${this.embeddingDims}, got ${values.length}`);
        }
        return Float32Array.from(values);
      });
    } catch (e) { throw classify(e); }
  }
}

export { classify as classifyProviderError };
