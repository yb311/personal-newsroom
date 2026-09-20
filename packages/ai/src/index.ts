export type { Provider, ProviderId, GenerateOptions, GenerateResult, EmbedKind } from './provider.ts';
export { NoProviderError, parseLoose } from './provider.ts';
export { GeminiProvider, GEMINI_MODELS, GEMINI_PRICING, geminiCost } from './gemini.ts';
export { OllamaProvider } from './ollama.ts';
export { resolveProvider, invalidateProvider, aiAvailable, readSettings, writeSetting, type AiSettings } from './resolve.ts';
export { embedItems, nearestItems, upsertWatchVector, getWatchVector, pruneVectors } from './embeddings.ts';
