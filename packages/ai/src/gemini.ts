import { GoogleGenAI } from '@google/genai';
import type { EmbedKind, GenerateOptions, GenerateResult, Provider } from './provider.ts';
import { parseLoose } from './provider.ts';

/**
 * Model ids, verified against the live model list on 2026-09-20. Kept in one
 * place rather than scattered across call sites, because Google retires them on
 * a schedule — 2.5 Flash-Lite is withdrawn 2026-10-16, so nothing binds to it.
 */
export const GEMINI_MODELS = {
  write: 'gemini-3.7-flash',
  fast: 'gemini-3.1-flash-lite',
  embed: 'gemini-embedding-2'
} as const;

/**
 * USD per million tokens, per model — judging runs on the cheap model and
 * writing on the capable one, so a single blended rate misreports cost by
 * roughly 3x. The Flash promotional rate doubles on 2027-01-01, which is why
 * batching and cross-watch merging are not optional.
 */
export const GEMINI_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  'gemini-3.7-flash': { inputPerM: 0.75, outputPerM: 3.75 },
  'gemini-3.8-flash': { inputPerM: 0.75, outputPerM: 3.75 },
  'gemini-3.1-flash-lite': { inputPerM: 0.25, outputPerM: 1.50 }
};
const EMBED_PER_M = 0.15;
const PRICING = { ...GEMINI_PRICING['gemini-3.7-flash']!, embedPerM: EMBED_PER_M };

/** Cost of one call, using the price of the model that actually ran. */
export function geminiCost(model: string, inTok: number, outTok: number): number {
  const p = GEMINI_PRICING[model] ?? GEMINI_PRICING['gemini-3.7-flash']!;
  return (inTok / 1e6) * p.inputPerM + (outTok / 1e6) * p.outputPerM;
}

export class GeminiProvider implements Provider {
  readonly id = 'gemini' as const;
  readonly name = 'Google Gemini';
  readonly fastModel = GEMINI_MODELS.fast;
  readonly writeModel = GEMINI_MODELS.write;
  readonly embeddingDims = 768;
  readonly pricing = PRICING;
  #client: GoogleGenAI | null = null;
  readonly #apiKey: string;

  // Explicit field + assignment rather than a TypeScript parameter property:
  // Node's strip-only type stripping (used to run these files directly) rejects
  // `constructor(private x: T)`.
  constructor(apiKey: string) { this.#apiKey = apiKey; }

  #ai(): GoogleGenAI {
    this.#client ??= new GoogleGenAI({ apiKey: this.#apiKey });
    return this.#client;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.#apiKey) return false;
    try { await this.#ai().models.list(); return true; } catch { return false; }
  }

  async generate<T>(prompt: string, opts: GenerateOptions & { model?: string }): Promise<GenerateResult<T>> {
    const model = opts.model ?? this.writeModel;
    const res = await this.#ai().models.generateContent({
      model,
      contents: prompt,
      config: {
        temperature: opts.temperature ?? 0.2,
        responseMimeType: 'application/json',
        responseJsonSchema: opts.schema,
        ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
        ...(opts.allowSearch ? { tools: [{ googleSearch: {} }] } : {})
      }
    });
    const u = res.usageMetadata;
    return {
      data: parseLoose<T>(res.text ?? ''),
      model,
      usedSearch: Boolean(opts.allowSearch),
      ...(u ? { usage: { input: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0 } } : {})
    };
  }

  async embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
    const taskType = kind === 'query' ? 'RETRIEVAL_QUERY'
      : kind === 'clustering' ? 'CLUSTERING' : 'RETRIEVAL_DOCUMENT';
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 100) {
      const batch = texts.slice(i, i + 100);
      const res = await this.#ai().models.embedContent({
        model: GEMINI_MODELS.embed,
        // Each text must be its own content. Passing a plain string[] makes the
        // SDK treat them as parts of ONE content and return a single vector —
        // silently wrong, and it still bills for the tokens.
        contents: batch.map((text) => ({ parts: [{ text }] })),
        config: { taskType, outputDimensionality: this.embeddingDims }
      });
      const got = res.embeddings ?? [];
      if (got.length !== batch.length) {
        throw new Error(`embed_count_mismatch: sent ${batch.length}, got ${got.length}`);
      }
      for (const e of got) out.push(Float32Array.from(e.values ?? []));
    }
    return out;
  }
}
