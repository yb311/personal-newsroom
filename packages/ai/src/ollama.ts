import type { EmbedKind, GenerateOptions, GenerateResult, Provider, ProviderCheck } from './provider.ts';
import { parseLoose } from './provider.ts';

/**
 * Local models through Ollama. Nothing leaves the machine.
 *
 * Slower and weaker than the hosted models, so callers are expected to tighten
 * recall thresholds in this mode and keep prompts short — long prompts are the
 * main failure mode for small local models. Detail-filling search is not
 * available here, so items whose body cannot be fetched are simply skipped.
 */
export class OllamaProvider implements Provider {
  readonly id = 'ollama' as const;
  readonly name = 'Ollama (本地)';
  readonly embeddingDims: number;
  readonly writeModel: string;
  readonly fastModel: string;
  readonly #host: string;
  readonly #embedModel: string;

  // Explicit fields, not parameter properties: Node's strip-only type stripping
  // rejects `constructor(private x: T)`.
  constructor(
    host = 'http://127.0.0.1:11434',
    writeModel = 'qwen3:8b',
    fastModel = 'qwen3:4b',
    embedModel = 'nomic-embed-text',
    dims = 768
  ) {
    this.#host = host; this.writeModel = writeModel; this.fastModel = fastModel;
    this.#embedModel = embedModel; this.embeddingDims = dims;
  }

  async isAvailable(): Promise<boolean> { return (await this.check()).ok; }

  async check(): Promise<ProviderCheck> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2000);
    try {
      const r = await fetch(`${this.#host}/api/tags`, { signal: ctl.signal });
      if (!r.ok) return { ok: false, problem: 'unreachable' };
      // Ollama answers even with none of our models pulled; every call would
      // then fail, so a missing model is reported here rather than later.
      const j = (await r.json()) as { models?: { name?: string }[] };
      const have = new Set((j.models ?? []).map((m) => String(m.name ?? '')));
      const has = (m: string): boolean => have.has(m) || have.has(`${m}:latest`);
      return [this.writeModel, this.fastModel, this.#embedModel].every(has)
        ? { ok: true } : { ok: false, problem: 'model_missing' };
    } catch { return { ok: false, problem: 'unreachable' }; }
    finally { clearTimeout(t); }
  }

  async generate<T>(prompt: string, opts: GenerateOptions & { model?: string }): Promise<GenerateResult<T>> {
    const model = opts.model ?? this.writeModel;
    const res = await fetch(`${this.#host}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, prompt, stream: false,
        format: opts.schema,
        options: { temperature: opts.temperature ?? 0.2 }
      })
    });
    if (!res.ok) throw new Error(`ollama_http_${res.status}`);
    const j = (await res.json()) as { response?: string; prompt_eval_count?: number; eval_count?: number };
    return {
      data: parseLoose<T>(j.response ?? ''),
      model,
      usedSearch: false,
      usage: { input: j.prompt_eval_count ?? 0, output: j.eval_count ?? 0 }
    };
  }

  async embed(texts: string[], _kind: EmbedKind): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const input of texts) {
      const res = await fetch(`${this.#host}/api/embeddings`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.#embedModel, prompt: input })
      });
      if (!res.ok) throw new Error(`ollama_embed_http_${res.status}`);
      const j = (await res.json()) as { embedding?: number[] };
      out.push(Float32Array.from(j.embedding ?? []));
    }
    return out;
  }
}
