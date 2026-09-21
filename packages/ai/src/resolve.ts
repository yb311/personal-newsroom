import { createHash } from 'node:crypto';
import type { Db } from '@pnr/store';
import type { Provider, ProviderId, ProviderProblem } from './provider.ts';
import { GeminiProvider, GEMINI_MODELS } from './gemini.ts';
import { AnthropicProvider, ANTHROPIC_MODELS, CompatibleProvider, OllamaProvider, OpenAiProvider, OPENAI_MODELS } from './vendors.ts';
import { withReplay } from './replay.ts';
import { withAudit } from './audit.ts';
import { disableVectorProfile, ensureVectorProfile } from './embeddings.ts';

export interface AiSettings {
  provider?: ProviderId | 'none';
  geminiApiKey?: string; openaiApiKey?: string; anthropicApiKey?: string;
  compatibleApiKey?: string; compatibleEndpoint?: string;
  writeModel?: string; fastModel?: string; embedModel?: string; contextTokens?: string;
  compatibleSupportsSchema?: string;
  ollamaHost?: string; ollamaWriteModel?: string; ollamaFastModel?: string; ollamaEmbedModel?: string;
  searchFillEnabled?: string;
  outputLang?: string;
}

export interface PublicAiSettings {
  provider: ProviderId | 'none'; outputLang: string;
  hasGeminiKey: boolean; hasOpenAiKey: boolean; hasAnthropicKey: boolean; hasCompatibleKey: boolean;
  compatibleEndpoint: string; writeModel: string; fastModel: string; embedModel: string; contextTokens: string;
  ollamaHost: string; ollamaWriteModel: string; ollamaFastModel: string; ollamaEmbedModel: string;
  searchFillEnabled: boolean;
}

export function readSettings(db: Db): AiSettings {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ai.%' OR key = 'outputLang'")
    .all() as { key: string; value: string }[];
  const settings: Record<string, string> = {};
  for (const row of rows) settings[row.key.replace(/^ai\./, '')] = row.value;
  return settings as AiSettings;
}

export function publicSettings(db: Db): PublicAiSettings {
  const s = readSettings(db);
  return {
    provider: s.provider ?? 'gemini', outputLang: s.outputLang ?? 'zh-CN',
    hasGeminiKey: Boolean(keyFor(s, 'gemini')), hasOpenAiKey: Boolean(keyFor(s, 'openai')),
    hasAnthropicKey: Boolean(keyFor(s, 'anthropic')), hasCompatibleKey: Boolean(s.compatibleApiKey),
    compatibleEndpoint: s.compatibleEndpoint ?? '', writeModel: s.writeModel ?? '', fastModel: s.fastModel ?? '',
    embedModel: s.embedModel ?? '', contextTokens: s.contextTokens ?? '',
    ollamaHost: s.ollamaHost ?? 'http://127.0.0.1:11434', ollamaWriteModel: s.ollamaWriteModel ?? 'qwen3:8b',
    ollamaFastModel: s.ollamaFastModel ?? '', ollamaEmbedModel: s.ollamaEmbedModel ?? 'nomic-embed-text',
    searchFillEnabled: s.searchFillEnabled !== '0'
  };
}

export function writeSetting(db: Db, key: string, value: string): void {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, value, Date.now());
}

const envAllowed = (): boolean => !process.env['PNR_IGNORE_ENV_KEY'];
const keyFor = (s: AiSettings, provider: ProviderId): string => {
  if (provider === 'gemini') return s.geminiApiKey ?? (envAllowed() ? process.env['GEMINI_API_KEY'] ?? '' : '');
  if (provider === 'openai') return s.openaiApiKey ?? (envAllowed() ? process.env['OPENAI_API_KEY'] ?? '' : '');
  if (provider === 'anthropic') return s.anthropicApiKey ?? (envAllowed() ? process.env['ANTHROPIC_API_KEY'] ?? '' : '');
  if (provider === 'openai-compatible') return s.compatibleApiKey ?? '';
  return '';
};
const positiveInt = (value?: string): number | undefined => {
  const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

function makeProvider(s: AiSettings): Provider | null {
  const id = s.provider ?? 'gemini';
  if (id === 'none') return null;
  if (id === 'gemini') {
    const key = keyFor(s, id); if (!key) return null;
    return new GeminiProvider(key, { write: s.writeModel || GEMINI_MODELS.write, fast: s.fastModel || GEMINI_MODELS.fast, embed: s.embedModel || GEMINI_MODELS.embed });
  }
  if (id === 'openai') {
    const key = keyFor(s, id); if (!key) return null;
    return new OpenAiProvider(key, { write: s.writeModel || OPENAI_MODELS.write, fast: s.fastModel || OPENAI_MODELS.fast, embed: s.embedModel || OPENAI_MODELS.embed });
  }
  if (id === 'anthropic') {
    const key = keyFor(s, id); if (!key) return null;
    return new AnthropicProvider(key, { write: s.writeModel || ANTHROPIC_MODELS.write, fast: s.fastModel || ANTHROPIC_MODELS.fast });
  }
  if (id === 'openai-compatible') {
    if (!s.compatibleEndpoint || !s.writeModel) return null;
    const contextTokens = positiveInt(s.contextTokens);
    return new CompatibleProvider({
      endpoint: s.compatibleEndpoint, apiKey: keyFor(s, id), writeModel: s.writeModel,
      ...(s.fastModel ? { fastModel: s.fastModel } : {}), ...(s.embedModel ? { embedModel: s.embedModel } : {}),
      ...(contextTokens ? { contextTokens } : {}),
      supportsSchema: s.compatibleSupportsSchema === '1'
    });
  }
  const contextTokens = positiveInt(s.contextTokens);
  return new OllamaProvider({
    ...(s.ollamaHost ? { host: s.ollamaHost } : {}), ...(s.ollamaWriteModel ? { writeModel: s.ollamaWriteModel } : {}),
    ...(s.ollamaFastModel ? { fastModel: s.ollamaFastModel } : {}), ...(s.ollamaEmbedModel ? { embedModel: s.ollamaEmbedModel } : {}),
    ...(contextTokens ? { contextTokens } : {})
  });
}

type CacheEntry = { fingerprint: string; provider: Provider | null };
let caches = new WeakMap<Db, CacheEntry>();
const fingerprint = (s: AiSettings): string => createHash('sha256').update(JSON.stringify(s)).digest('hex');

/** Resolving is local and free. Network checks happen only when settings are saved. */
export async function resolveProvider(db: Db, force = false): Promise<Provider | null> {
  const settings = readSettings(db); const fp = fingerprint(settings); const cached = caches.get(db);
  if (!force && cached?.fingerprint === fp) return cached.provider;
  const raw = makeProvider(settings);
  const provider = settings.provider !== 'none' ? withReplay(raw ? withAudit(db, raw) : null) : null;
  caches.set(db, { fingerprint: fp, provider });
  return provider;
}

export const invalidateProvider = (db?: Db): void => { if (db) caches.delete(db); else caches = new WeakMap(); };
export async function aiAvailable(db: Db): Promise<boolean> { return (await resolveProvider(db)) !== null; }

export interface AiConnection {
  mode: ProviderId | 'none'; connected: boolean; problem?: ProviderProblem; embedding?: boolean;
}

export async function checkConnection(db: Db): Promise<AiConnection> {
  invalidateProvider(db); const s = readSettings(db); const mode = s.provider ?? 'gemini';
  if (mode === 'none') return { mode, connected: false };
  const provider = makeProvider(s);
  if (!provider) return { mode, connected: false, problem: 'no_key' };
  const result = await provider.check();
  if (!result.ok) return { mode, connected: false, ...(result.problem ? { problem: result.problem } : {}) };
  caches.set(db, { fingerprint: fingerprint(s), provider: withReplay(withAudit(db, provider)) });
  if (provider.capabilities.embedding && result.embedding !== false) ensureVectorProfile(db, provider);
  else disableVectorProfile(db);
  return { mode, connected: true, ...(result.embedding != null ? { embedding: result.embedding } : {}) };
}
