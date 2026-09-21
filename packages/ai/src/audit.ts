import { randomUUID } from 'node:crypto';
import type { Db } from '@pnr/store';
import { currentRunId } from '@pnr/core';
import type { EmbedKind, GenerateOptions, GenerateResult, Provider, SearchResult, StandardUsage, StreamEvent } from './provider.ts';

export interface CostResult { value?: number; known: boolean }

export function costOf(provider: Provider, model: string, usage?: StandardUsage): CostResult {
  const prices = provider.pricing;
  if (!prices || !usage) return { known: false };
  let value = 0; let has = false;
  const uncached = usage.input == null ? undefined : Math.max(0, usage.input - (usage.cacheRead ?? 0));
  if (uncached != null) {
    if (prices.inputPerM == null) return { known: false };
    value += uncached / 1e6 * prices.inputPerM; has = true;
  }
  if (usage.cacheRead != null) {
    if (prices.cachedInputPerM == null) return { known: false };
    value += usage.cacheRead / 1e6 * prices.cachedInputPerM; has = true;
  }
  if (usage.output != null) {
    if (prices.outputPerM == null) return { known: false };
    value += usage.output / 1e6 * prices.outputPerM; has = true;
  }
  if (usage.searchCalls != null && usage.searchCalls > 0) {
    if (prices.searchPerCall == null) return { known: false };
    value += usage.searchCalls * prices.searchPerCall; has = true;
  }
  void model;
  return has ? { value, known: true } : { known: false };
}

function record(db: Db, provider: Provider, model: string, operation: string, usage?: StandardUsage): void {
  const cost = costOf(provider, model, usage);
  db.prepare(`INSERT INTO ai_requests (id,run_id,provider,model,operation,input_tokens,output_tokens,
    cache_read_tokens,cache_write_tokens,search_calls,cost_usd,cost_known,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), currentRunId() ?? null, provider.id, model, operation,
      usage?.input ?? null, usage?.output ?? null, usage?.cacheRead ?? null, usage?.cacheWrite ?? null,
      usage?.searchCalls ?? null, cost.value ?? null, cost.known ? 1 : 0, Date.now()
    );
}

export function withAudit(db: Db, base: Provider): Provider {
  return {
    ...base, id: base.id, name: base.name, capabilities: base.capabilities,
    fastModel: base.fastModel, writeModel: base.writeModel, limits: base.limits,
    embeddingDims: base.embeddingDims, vectorProfile: base.vectorProfile, pricing: base.pricing,
    isAvailable: () => base.isAvailable(), check: () => base.check(),
    async generate<T>(prompt: string, opts: GenerateOptions & { model?: string }): Promise<GenerateResult<T>> {
      const result = await base.generate<T>(prompt, opts);
      record(db, base, result.model, opts.operation ?? 'generate', result.usage); return result;
    },
    async *stream<T>(prompt: string, opts: GenerateOptions & { model?: string }): AsyncIterable<StreamEvent<T>> {
      for await (const event of base.stream<T>(prompt, opts)) {
        if (event.type === 'final') record(db, base, event.result.model, opts.operation ?? 'stream', event.result.usage);
        yield event;
      }
    },
    async search(prompt: string, opts = {}): Promise<SearchResult> {
      const result = await base.search(prompt, opts); record(db, base, result.model, 'search', result.usage); return result;
    },
    async embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]> {
      const result = await base.embed(texts, kind, signal);
      record(db, base, base.vectorProfile?.model ?? 'embedding', `embed_${kind}`); return result;
    }
  };
}
