import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { AiSdkProvider } from './sdk-provider.ts';
import type { ProviderCheck } from './provider.ts';

export const OPENAI_MODELS = { write: 'gpt-5.6', fast: 'gpt-5.4-mini', embed: 'text-embedding-3-small' } as const;
export const ANTHROPIC_MODELS = { write: 'claude-sonnet-5', fast: 'claude-haiku-4-5' } as const;
const normalEndpoint = (input: string): string => input.trim().replace(/\/+$/, '');

export interface OpenAiOptions { write?: string; fast?: string; embed?: string; baseURL?: string }

export class OpenAiProvider extends AiSdkProvider {
  constructor(apiKey: string, models: OpenAiOptions = {}) {
    const ids = { write: models.write ?? OPENAI_MODELS.write, fast: models.fast ?? OPENAI_MODELS.fast,
      embed: models.embed ?? OPENAI_MODELS.embed };
    const openai = createOpenAI({ apiKey, ...(models.baseURL ? { baseURL: normalEndpoint(models.baseURL) } : {}) });
    super({
      id: 'openai', name: 'OpenAI', fastModel: ids.fast, writeModel: ids.write,
      limits: { fast: { maxInputTokens: 350_000, maxOutputTokens: 32_000 }, write: { maxInputTokens: 350_000, maxOutputTokens: 64_000 } },
      model: (id) => openai.responses(id), checkKeyPresent: () => Boolean(apiKey),
      providerOptions: { openai: { store: false } },
      embeddingModel: openai.embedding(ids.embed), embeddingDims: 768,
      embeddingOptions: () => ({ openai: { dimensions: 768 } }),
      vectorProfile: { provider: 'openai', endpoint: 'https://api.openai.com/v1', model: ids.embed, dimensions: 768, taskConfig: 'dimensions=768', inputVersion: 1 },
      searchTools: () => ({ web_search: openai.tools.webSearch({ searchContextSize: 'high' }) })
    });
  }
}

export class AnthropicProvider extends AiSdkProvider {
  constructor(apiKey: string, models: { write?: string; fast?: string } = {}) {
    const ids = { ...ANTHROPIC_MODELS, ...models }; const anthropic = createAnthropic({ apiKey });
    super({
      id: 'anthropic', name: 'Anthropic Claude', fastModel: ids.fast, writeModel: ids.write,
      limits: { fast: { maxInputTokens: 180_000, maxOutputTokens: 16_000 }, write: { maxInputTokens: 900_000, maxOutputTokens: 64_000 } },
      model: (id) => anthropic(id), checkKeyPresent: () => Boolean(apiKey),
      searchTools: () => ({ web_search: anthropic.tools.webSearch_20260318({ maxUses: 5, responseInclusion: 'full' }) })
    });
  }
}

export interface CompatibleOptions {
  endpoint: string; apiKey: string; writeModel: string; fastModel?: string; embedModel?: string;
  contextTokens?: number; supportsSchema?: boolean;
}

export class CompatibleProvider extends AiSdkProvider {
  constructor(opts: CompatibleOptions) {
    const endpoint = normalEndpoint(opts.endpoint);
    const compatible = createOpenAICompatible({ name: 'personal-newsroom-compatible', baseURL: endpoint, apiKey: opts.apiKey,
      includeUsage: true, supportsStructuredOutputs: opts.supportsSchema ?? false });
    const embedModel = opts.embedModel?.trim();
    super({
      id: 'openai-compatible', name: 'OpenAI Compatible', fastModel: opts.fastModel?.trim() || opts.writeModel, writeModel: opts.writeModel,
      limits: { fast: { maxInputTokens: opts.contextTokens ?? 8_000, maxOutputTokens: 4_096 }, write: { maxInputTokens: opts.contextTokens ?? 8_000, maxOutputTokens: 4_096 } },
      model: (id) => compatible.chatModel(id), checkKeyPresent: () => Boolean(endpoint && opts.writeModel),
      ...(embedModel ? {
        embeddingModel: compatible.embeddingModel(embedModel), embeddingDims: 768,
        embeddingOptions: () => ({ 'personal-newsroom-compatible': { dimensions: 768 } }),
        vectorProfile: { provider: 'openai-compatible' as const, endpoint, model: embedModel, dimensions: 768, taskConfig: 'dimensions=768', inputVersion: 1 }
      } : {}),
      capabilities: { structured: opts.supportsSchema ? 'schema' : 'json' }
    });
  }
}

export interface OllamaOptions { host?: string; writeModel?: string; fastModel?: string; embedModel?: string; contextTokens?: number }

export class OllamaProvider extends AiSdkProvider {
  constructor(opts: OllamaOptions = {}) {
    const host = normalEndpoint(opts.host ?? 'http://127.0.0.1:11434');
    const writeModel = opts.writeModel ?? 'qwen3:8b'; const fastModel = opts.fastModel ?? writeModel;
    const embedModel = opts.embedModel ?? 'nomic-embed-text';
    const compatible = createOpenAICompatible({ name: 'ollama', baseURL: `${host}/v1`, apiKey: 'ollama', includeUsage: true, supportsStructuredOutputs: false });
    const healthCheck = async (): Promise<ProviderCheck> => {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 3_000);
      try {
        const response = await fetch(`${host}/api/tags`, { signal: ctl.signal });
        if (!response.ok) return { ok: false, problem: 'unreachable' };
        const json = await response.json() as { models?: { name?: string }[] };
        const have = new Set((json.models ?? []).map((m) => String(m.name ?? '')));
        const has = (id: string): boolean => have.has(id) || have.has(`${id}:latest`);
        const generation = has(writeModel) && has(fastModel);
        return generation ? { ok: true, generation: true, embedding: has(embedModel) }
          : { ok: false, problem: 'model_missing', generation: false, embedding: has(embedModel) };
      } catch { return { ok: false, problem: 'unreachable' }; }
      finally { clearTimeout(timer); }
    };
    super({
      id: 'ollama', name: 'Ollama (本地)', fastModel, writeModel,
      limits: { fast: { maxInputTokens: opts.contextTokens ?? 8_000, maxOutputTokens: 4_096 }, write: { maxInputTokens: opts.contextTokens ?? 8_000, maxOutputTokens: 4_096 } },
      model: (id) => compatible.chatModel(id), checkKeyPresent: () => true, healthCheck,
      embeddingModel: compatible.embeddingModel(embedModel), embeddingDims: 768,
      embeddingOptions: () => ({ ollama: { dimensions: 768 } }),
      vectorProfile: { provider: 'ollama', endpoint: `${host}/v1`, model: embedModel, dimensions: 768, taskConfig: 'dimensions=768', inputVersion: 1 },
      capabilities: { structured: 'json' }
    });
  }
}
