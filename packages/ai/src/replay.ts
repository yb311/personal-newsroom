import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flags, log } from '@pnr/core';
import type { EmbedKind, GenerateOptions, GenerateResult, Provider, ProviderCheck } from './provider.ts';

/**
 * PNR_REPLAY — daily-brief's "reuse local snapshot" semantics.
 *
 *   PNR_REPLAY=record  call the model and save every response
 *   PNR_REPLAY=replay  answer from saved responses; call (and save) only on a miss
 *
 * Responses are keyed by a hash of schema and prompt (or of the texts,
 * for embeddings), so a prompt change naturally misses. With replay and no
 * key at all, a saved run can still be re-run offline; a miss then fails
 * loudly rather than quietly changing results. PNR_SNAPSHOT_DIR overrides the
 * default dev/snapshots.
 */
const dir = (): string => process.env['PNR_SNAPSHOT_DIR'] ?? join(process.cwd(), 'dev', 'snapshots');
const keyOf = (parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);

function load<T>(key: string): T | undefined {
  const p = join(dir(), `${key}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : undefined;
}
function save(key: string, value: unknown): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(join(dir(), `${key}.json`), JSON.stringify(value));
}

export function withReplay(inner: Provider | null): Provider | null {
  const mode = flags.replay;
  if (!mode) return inner;
  const base = inner ?? {
    id: 'gemini' as const, name: 'replay only', fastModel: 'replay', writeModel: 'replay', embeddingDims: 768,
    async isAvailable() { return true; },
    async check(): Promise<ProviderCheck> { return { ok: true }; },
    async generate(): Promise<never> { throw new Error('replay_miss: no snapshot for this prompt and no AI key to record one'); },
    async embed(): Promise<never> { throw new Error('replay_miss: no snapshot for these texts and no AI key to record one'); }
  };
  return {
    ...base,
    id: base.id, name: `${base.name} (${mode})`, fastModel: base.fastModel, writeModel: base.writeModel,
    embeddingDims: base.embeddingDims, isAvailable: () => base.isAvailable(), check: () => base.check(),
    async generate<T>(prompt: string, opts: GenerateOptions & { model?: string }): Promise<GenerateResult<T>> {
      // Keyed by schema and prompt only: the same prompt never goes to two
      // models, and a replay without a key cannot know the model names.
      const key = keyOf(['generate', opts.schema, prompt]);
      const hit = mode === 'replay' ? load<GenerateResult<T>>(key) : undefined;
      if (hit) { log({ event: 'ai.replay', phase: 'completed', attrs: { key, hit: true } }); return hit; }
      const res = await base.generate<T>(prompt, opts);
      save(key, res);
      return res;
    },
    async embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
      const key = keyOf(['embed', base.embeddingDims, kind, texts]);
      const hit = mode === 'replay' ? load<number[][]>(key) : undefined;
      if (hit) return hit.map((v) => Float32Array.from(v));
      const res = await base.embed(texts, kind);
      save(key, res.map((v) => Array.from(v)));
      return res;
    }
  };
}
