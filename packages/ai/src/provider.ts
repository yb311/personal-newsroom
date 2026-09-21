/**
 * Provider abstraction. Everything above this layer asks `isAvailable()` once
 * and degrades gracefully — the app is fully usable as an RSS reader with no
 * key at all, so AI absence is a normal state, never an error.
 */
export type ProviderId = 'gemini' | 'openai-compatible' | 'ollama';

export interface GenerateOptions {
  /** JSON Schema the model must conform to. All calls are structured. */
  schema: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
  /** Detail-filling only: lets the model search when the article body could not
   *  be fetched. Never a discovery path — see AGENTS.md. */
  allowSearch?: boolean;
  timeoutMs?: number;
}

export interface GenerateResult<T> {
  data: T;
  model: string;
  usedSearch: boolean;
  usage?: { input: number; output: number };
}

/** Why a provider cannot be used right now, in terms the settings screen can
 *  turn into a sentence. A wrong key and a dropped network need different advice. */
export type ProviderProblem = 'no_key' | 'invalid_key' | 'network' | 'unreachable' | 'model_missing';

export interface ProviderCheck { ok: boolean; problem?: ProviderProblem }

export interface Provider {
  readonly id: ProviderId;
  readonly name: string;
  isAvailable(): Promise<boolean>;
  check(): Promise<ProviderCheck>;
  /** Cheap model, for high-volume relevance judging. */
  readonly fastModel: string;
  /** Capable model, for writing. */
  readonly writeModel: string;
  readonly embeddingDims: number;
  generate<T>(prompt: string, opts: GenerateOptions & { model?: string }): Promise<GenerateResult<T>>;
  embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]>;
  /** Per-million-token prices, so a run can report what it cost. */
  readonly pricing?: { inputPerM: number; outputPerM: number; embedPerM: number };
}

export type EmbedKind = 'document' | 'query' | 'clustering';

export class NoProviderError extends Error {
  override readonly name = 'NoProviderError';
  constructor() { super('no AI provider configured'); }
}

const CTRL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(8) +
  String.fromCharCode(11) + String.fromCharCode(12) +
  String.fromCharCode(14) + '-' + String.fromCharCode(31) + ']', 'g');

/** Salvages nearly-valid JSON: prose around it, trailing commas, stray control
 *  characters. Models occasionally emit these even under a response schema. */
export function parseLoose<T>(text: string): T {
  const t = text.trim();
  const starts = [t.indexOf('{'), t.indexOf('[')].filter((n) => n >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  const slice = start >= 0 && end > start ? t.slice(start, end + 1) : t;
  try {
    return JSON.parse(slice) as T;
  } catch {
    const repaired = slice.replace(/,(\s*[}\]])/g, '$1').replace(CTRL, '');
    return JSON.parse(repaired) as T;
  }
}
