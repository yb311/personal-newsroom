export type { Provider, ProviderCheck, ProviderProblem, ProviderId, GenerateOptions, GenerateResult, EmbedKind } from './provider.ts';
export { NoProviderError, parseLoose } from './provider.ts';
export { GeminiProvider, GEMINI_MODELS, GEMINI_PRICING, EMBED_PER_M, geminiCost } from './gemini.ts';
export { OllamaProvider } from './ollama.ts';
export { resolveProvider, invalidateProvider, aiAvailable, checkConnection, readSettings, writeSetting,
         type AiSettings, type AiConnection } from './resolve.ts';
export { withReplay } from './replay.ts';
export { embedItems, nearestItems, upsertWatchVector, getWatchVector, pruneVectors } from './embeddings.ts';
