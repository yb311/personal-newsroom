import { createGoogle } from '@ai-sdk/google';
import { AiSdkProvider } from './sdk-provider.ts';

/** Central defaults, verified against the installed provider's model table. */
export const GEMINI_MODELS = {
  write: 'gemini-3.8-flash',
  fast: 'gemini-3.5-flash-lite',
  embed: 'gemini-embedding-2'
} as const;

export const GEMINI_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  'gemini-3.8-flash': { inputPerM: 0.75, outputPerM: 3.75 },
  'gemini-3.7-flash': { inputPerM: 0.75, outputPerM: 3.75 },
  'gemini-3.5-flash-lite': { inputPerM: 0.25, outputPerM: 1.50 }
};
export const EMBED_PER_M = 0.15;

export function geminiCost(model: string, inTok: number, outTok: number): number | undefined {
  const p = GEMINI_PRICING[model];
  return p ? (inTok / 1e6) * p.inputPerM + (outTok / 1e6) * p.outputPerM : undefined;
}

export class GeminiProvider extends AiSdkProvider {
  constructor(apiKey: string, models: { write?: string; fast?: string; embed?: string } = {}) {
    const ids = { ...GEMINI_MODELS, ...models };
    const google = createGoogle({ apiKey });
    super({
      id: 'gemini', name: 'Google Gemini', fastModel: ids.fast, writeModel: ids.write,
      limits: {
        fast: { maxInputTokens: 900_000, maxOutputTokens: 16_384 },
        write: { maxInputTokens: 900_000, maxOutputTokens: 32_768 }
      },
      model: (id) => google(id), checkKeyPresent: () => Boolean(apiKey),
      embeddingModel: google.embedding(ids.embed), embeddingDims: 768,
      embeddingOptions: (kind) => ({ google: {
        outputDimensionality: 768,
        taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : kind === 'clustering' ? 'CLUSTERING' : 'RETRIEVAL_DOCUMENT'
      } }),
      vectorProfile: {
        provider: 'gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta',
        model: ids.embed, dimensions: 768, taskConfig: 'query|document|clustering', inputVersion: 1
      },
      searchTools: () => ({ google_search: google.tools.googleSearch({}) }),
      pricing: {
        ...(GEMINI_PRICING[ids.write]?.inputPerM != null ? { inputPerM: GEMINI_PRICING[ids.write]!.inputPerM } : {}),
        ...(GEMINI_PRICING[ids.write]?.outputPerM != null ? { outputPerM: GEMINI_PRICING[ids.write]!.outputPerM } : {}),
        embedPerM: EMBED_PER_M
      }
    });
  }
}
