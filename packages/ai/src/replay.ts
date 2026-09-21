import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flags, log } from '@pnr/core';
import type { EmbedKind, GenerateOptions, GenerateResult, Provider, SearchResult, StreamEvent } from './provider.ts';

const dir = (): string => process.env['PNR_SNAPSHOT_DIR'] ?? join(process.cwd(), 'dev', 'snapshots');
const keyOf = (parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
function load<T>(key: string): T | undefined {
  const path = join(dir(), `${key}.json`); return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : undefined;
}
function save(key: string, value: unknown): void {
  mkdirSync(dir(), { recursive: true }); writeFileSync(join(dir(), `${key}.json`), JSON.stringify(value));
}
const miss = (key: string): never => { throw new Error(`replay_miss:${key}`); };

/** Record/replay wraps the complete contract. Replay mode is strictly offline. */
export function withReplay(inner: Provider | null): Provider | null {
  const mode = flags.replay; if (!mode) return inner;
  const identity = inner ? {
    provider: inner.id, fastModel: inner.fastModel, writeModel: inner.writeModel,
    vectorProfile: inner.vectorProfile ?? null
  } : { provider: 'unconfigured', fastModel: '', writeModel: '', vectorProfile: null };
  if (!inner && mode === 'record') return null;
  const base = inner;
  const common = base ?? {
    id: 'gemini' as const, name: 'Replay only', fastModel: 'replay', writeModel: 'replay',
    embeddingDims: 768, limits: { fast: { maxInputTokens: 1_000_000, maxOutputTokens: 32_000 }, write: { maxInputTokens: 1_000_000, maxOutputTokens: 32_000 } },
    capabilities: { embedding: true, search: true, stream: true, structured: 'schema' as const },
    async isAvailable() { return true; }, async check() { return { ok: true as const }; }
  };
  return {
    ...common, id: common.id, name: `${common.name} (${mode})`, fastModel: common.fastModel, writeModel: common.writeModel,
    limits: common.limits, capabilities: common.capabilities, embeddingDims: common.embeddingDims,
    vectorProfile: base?.vectorProfile, pricing: base?.pricing,
    isAvailable: () => common.isAvailable(), check: () => common.check(),
    async generate<T>(prompt: string, opts: GenerateOptions & { model?: string }): Promise<GenerateResult<T>> {
      const key = keyOf(['generate', identity, opts.model ?? common.writeModel, prompt, opts.messages ?? null,
        opts.schema, opts.temperature ?? null, opts.maxOutputTokens ?? null, opts.allowSearch ?? false]);
      const hit = load<GenerateResult<T>>(key);
      if (mode === 'replay') {
        if (!hit) return miss(key);
        log({ event: 'ai.replay', phase: 'completed', attrs: { key, hit: true } }); return hit;
      }
      const result = await base!.generate<T>(prompt, opts); save(key, result); return result;
    },
    async *stream<T>(prompt: string, opts: GenerateOptions & { model?: string }): AsyncIterable<StreamEvent<T>> {
      const key = keyOf(['stream', identity, opts.model ?? common.writeModel, prompt, opts.messages ?? null,
        opts.schema, opts.temperature ?? null, opts.maxOutputTokens ?? null, opts.allowSearch ?? false]);
      if (mode === 'replay') {
        const events = load<StreamEvent<T>[]>(key); if (!events) return miss(key);
        for (const event of events) yield event; return;
      }
      const events: StreamEvent<T>[] = [];
      for await (const event of base!.stream<T>(prompt, opts)) { events.push(event); yield event; }
      save(key, events);
    },
    async search(prompt: string, opts = {}): Promise<SearchResult> {
      const key = keyOf(['search', identity, opts.model ?? common.writeModel, prompt]);
      const hit = load<SearchResult>(key);
      if (mode === 'replay') return hit ?? miss(key);
      const result = await base!.search(prompt, opts); save(key, result); return result;
    },
    async embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]> {
      const key = keyOf(['embed', identity, kind, texts]); const hit = load<number[][]>(key);
      if (mode === 'replay') return hit?.map((v) => Float32Array.from(v)) ?? miss(key);
      const result = await base!.embed(texts, kind, signal); save(key, result.map((v) => Array.from(v))); return result;
    }
  };
}
