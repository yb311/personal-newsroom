import type { Db } from '@pnr/store';
import type { Provider } from './provider.ts';
import { GeminiProvider } from './gemini.ts';
import { OllamaProvider } from './ollama.ts';

/**
 * The single gate every caller uses. Above this line nothing knows which
 * provider is configured, or whether one is configured at all — an app with no
 * key is a normal, fully-working RSS reader, so `null` is an expected answer
 * rather than an error state.
 */
export interface AiSettings {
  provider?: 'gemini' | 'ollama' | 'none';
  geminiApiKey?: string;
  ollamaHost?: string;
  ollamaWriteModel?: string;
  ollamaFastModel?: string;
  outputLang?: string;
}

export function readSettings(db: Db): AiSettings {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ai.%' OR key = 'outputLang'")
    .all() as { key: string; value: string }[];
  const s: Record<string, string> = {};
  for (const r of rows) s[r.key.replace(/^ai\./, '')] = r.value;
  return s as AiSettings;
}

export function writeSetting(db: Db, key: string, value: string): void {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, value, Date.now());
}

let cached: { provider: Provider | null; at: number } | null = null;
const CACHE_MS = 30_000;

/** Returns the configured provider, or null when AI is simply not set up. */
export async function resolveProvider(db: Db, force = false): Promise<Provider | null> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.provider;
  const s = readSettings(db);
  let provider: Provider | null = null;

  if (s.provider === 'ollama') {
    const p = new OllamaProvider(s.ollamaHost, s.ollamaWriteModel, s.ollamaFastModel);
    provider = (await p.isAvailable()) ? p : null;
  } else if (s.provider !== 'none') {
    // The environment variable is a developer convenience only; a shipped app
    // has no such variable, so an unconfigured install resolves to null and the
    // AI surfaces show their "add a key" state.
    const key = s.geminiApiKey ?? (process.env['PNR_IGNORE_ENV_KEY'] ? '' : process.env['GEMINI_API_KEY']) ?? '';
    if (key) {
      const p = new GeminiProvider(key);
      provider = (await p.isAvailable()) ? p : null;
    }
  }
  cached = { provider, at: Date.now() };
  return provider;
}

export const invalidateProvider = (): void => { cached = null; };

/** Cheap check for the UI: should the AI surfaces be live or show the
 *  "add a key to turn this on" state? */
export async function aiAvailable(db: Db): Promise<boolean> {
  return (await resolveProvider(db)) !== null;
}
