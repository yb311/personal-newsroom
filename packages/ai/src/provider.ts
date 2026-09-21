/** Stable application-facing AI contract. Provider SDK objects stay private. */
export type ProviderId = 'gemini' | 'openai' | 'anthropic' | 'openai-compatible' | 'ollama';

export type AiMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export interface ModelLimits { maxInputTokens: number; maxOutputTokens: number }
export interface ProviderCapabilities {
  embedding: boolean;
  search: boolean;
  stream: boolean;
  structured: 'schema' | 'json';
}

export interface GenerateOptions {
  /** Sent to the provider and independently validated by AI SDK. */
  schema: Record<string, unknown>;
  /** Multi-turn input. When present, the positional prompt must be empty. */
  messages?: AiMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Detail filling only: search evidence first, then normal structured output. */
  allowSearch?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  operation?: string;
}

export interface StandardUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  searchCalls?: number;
}

export interface GenerateResult<T> {
  data: T;
  provider: ProviderId;
  model: string;
  usedSearch: boolean;
  finishReason?: string;
  usage?: StandardUsage | undefined;
}

export type StreamEvent<T> =
  | { type: 'partial'; value: Partial<T>; sequence: number }
  | { type: 'final'; result: GenerateResult<T>; sequence: number }
  | { type: 'error'; error: ProviderError; sequence: number };

export interface SearchSource { url: string; title?: string | undefined; providerRef?: string | undefined }
export interface SearchResult {
  provider: ProviderId;
  model: string;
  text: string;
  executed: boolean;
  sources: SearchSource[];
  usage?: StandardUsage | undefined;
}

export type ProviderProblem =
  | 'no_key' | 'invalid_key' | 'network' | 'unreachable' | 'model_missing'
  | 'rate_limited' | 'quota_exhausted' | 'context_exceeded' | 'unsupported';

export interface ProviderCheck {
  ok: boolean;
  problem?: ProviderProblem;
  generation?: boolean;
  embedding?: boolean;
}

export interface VectorProfile {
  provider: ProviderId;
  endpoint: string;
  model: string;
  dimensions: number;
  taskConfig: string;
  inputVersion: number;
}

export interface Provider {
  readonly id: ProviderId;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  readonly fastModel: string;
  readonly writeModel: string;
  readonly limits: { fast: ModelLimits; write: ModelLimits };
  readonly embeddingDims: number;
  readonly vectorProfile: VectorProfile | undefined;
  isAvailable(): Promise<boolean>;
  check(): Promise<ProviderCheck>;
  generate<T>(prompt: string, opts: GenerateOptions & { model?: string }): Promise<GenerateResult<T>>;
  stream<T>(prompt: string, opts: GenerateOptions & { model?: string }): AsyncIterable<StreamEvent<T>>;
  search(prompt: string, opts?: { model?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<SearchResult>;
  embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]>;
  /** Missing prices are unknown, never silently counted as zero. */
  readonly pricing: {
    inputPerM?: number; outputPerM?: number; cachedInputPerM?: number;
    embedPerM?: number; searchPerCall?: number;
  } | undefined;
}

export type EmbedKind = 'document' | 'query' | 'clustering';

export class NoProviderError extends Error {
  override readonly name = 'NoProviderError';
  constructor() { super('no AI provider configured'); }
}

export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  readonly code: ProviderProblem;
  readonly status: number | undefined;
  constructor(code: ProviderProblem, message: string, status?: number) {
    super(message); this.code = code; this.status = status;
  }
}

const CTRL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(8) +
  String.fromCharCode(11) + String.fromCharCode(12) +
  String.fromCharCode(14) + '-' + String.fromCharCode(31) + ']', 'g');

/** Syntax repair only. Schema validation is a separate, mandatory step. */
export function parseLoose<T>(text: string): T {
  const t = text.trim();
  const starts = [t.indexOf('{'), t.indexOf('[')].filter((n) => n >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  const slice = start >= 0 && end > start ? t.slice(start, end + 1) : t;
  try { return JSON.parse(slice) as T; }
  catch {
    const repaired = slice.replace(/,(\s*[}\]])/g, '$1').replace(CTRL, '');
    return JSON.parse(repaired) as T;
  }
}
