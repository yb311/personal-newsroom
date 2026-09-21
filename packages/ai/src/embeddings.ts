import type { Db } from '@pnr/store';
import type { EmbedKind, Provider } from './provider.ts';
import { log } from '@pnr/core';

const profileKey = (provider: Provider): string => {
  if (!provider.vectorProfile) throw new Error('embedding_unavailable');
  return JSON.stringify(provider.vectorProfile);
};

/** Switch profiles atomically. Old vec rows without identity are invalidated. */
export function ensureVectorProfile(db: Db, provider: Provider): { profile: string; generation: number } {
  const profile = profileKey(provider);
  return db.transaction(() => {
    const row = db.prepare('SELECT vector_profile AS profile, vector_generation AS generation FROM ai_runtime WHERE id = 1')
      .get() as { profile: string | null; generation: number };
    if (row.profile === profile) return { profile, generation: row.generation };
    const generation = row.generation + 1;
    db.exec('DELETE FROM embeddings; DELETE FROM watch_vectors; DELETE FROM embedding_cache_meta; DELETE FROM watch_vector_meta');
    db.prepare('UPDATE ai_runtime SET vector_profile = ?, vector_generation = ?, updated_at = ? WHERE id = 1')
      .run(profile, generation, Date.now());
    return { profile, generation };
  })();
}

export function disableVectorProfile(db: Db): void {
  db.transaction(() => {
    const row = db.prepare('SELECT vector_profile AS profile FROM ai_runtime WHERE id=1').get() as { profile: string | null };
    if (row.profile === null) return;
    db.exec('DELETE FROM embeddings; DELETE FROM watch_vectors; DELETE FROM embedding_cache_meta; DELETE FROM watch_vector_meta');
    db.prepare('UPDATE ai_runtime SET vector_profile=NULL, vector_generation=vector_generation+1, updated_at=? WHERE id=1').run(Date.now());
  })();
}

/**
 * Embeddings with a persistent cache.
 *
 * Cached per item, so an item recalled by several watches is paid for once, and
 * the cache survives restarts. This is what keeps the R1 recall layer at roughly
 * a cent a day rather than a recurring cost.
 *
 * Disk cost is real: 768 float32 values is about 3.2 KB per item, so roughly
 * 2.3 GB a year at 2000 items/day. `pruneVectors` is the release valve.
 */
export async function embedItems(
  db: Db, provider: Provider, items: { id: string; text: string }[], kind: EmbedKind = 'document'
): Promise<Map<string, Float32Array>> {
  const out = new Map<string, Float32Array>();
  const missing: { id: string; text: string }[] = [];
  const runtime = ensureVectorProfile(db, provider);

  const get = db.prepare(`SELECT e.embedding FROM embeddings e JOIN embedding_cache_meta m ON m.item_id=e.item_id
    WHERE e.item_id=? AND m.vector_profile=? AND m.vector_generation=?`);
  for (const it of items) {
    const row = get.get(it.id, runtime.profile, runtime.generation) as { embedding: Buffer } | undefined;
    if (row) out.set(it.id, new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
    else missing.push(it);
  }
  if (missing.length === 0) return out;

  const t0 = Date.now();
  const vectors = await provider.embed(missing.map((m) => m.text), kind);
  // Embedding APIs do not report tokens; characters are logged so the
  // recall audit can estimate the cost (~4 characters per token for English,
  // ~1–1.5 for Chinese).
  log({ event: 'ai.embed', phase: 'completed', elapsedMs: Date.now() - t0,
        attrs: { texts: missing.length, chars: missing.reduce((n, m) => n + m.text.length, 0), cached: items.length - missing.length } });
  // sqlite-vec virtual tables do not support ON CONFLICT, so replace by hand.
  const del = db.prepare('DELETE FROM embeddings WHERE item_id = ?');
  const ins = db.prepare('INSERT INTO embeddings (item_id, embedding) VALUES (?, ?)');
  const meta = db.prepare(`INSERT INTO embedding_cache_meta (item_id,vector_profile,vector_generation,created_at)
    VALUES (?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET vector_profile=excluded.vector_profile,
    vector_generation=excluded.vector_generation,created_at=excluded.created_at`);
  db.transaction(() => {
    const current = db.prepare('SELECT vector_generation AS generation FROM ai_runtime WHERE id=1').get() as { generation: number };
    if (current.generation !== runtime.generation) throw new Error('vector_generation_changed');
    missing.forEach((m, i) => {
      const v = vectors[i];
      if (!v) return;
      del.run(m.id);
      ins.run(m.id, Buffer.from(v.buffer, v.byteOffset, v.byteLength));
      meta.run(m.id, runtime.profile, runtime.generation, Date.now());
      out.set(m.id, v);
    });
  })();
  return out;
}

/** Nearest items to a query vector, via sqlite-vec. */
export function nearestItems(db: Db, query: Float32Array, limit = 60): { itemId: string; distance: number }[] {
  return db.prepare(
    'SELECT item_id AS itemId, distance FROM embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?'
  ).all(Buffer.from(query.buffer, query.byteOffset, query.byteLength), limit) as { itemId: string; distance: number }[];
}

export function upsertWatchVector(db: Db, watchId: string, v: Float32Array): void {
  const runtime = db.prepare('SELECT vector_profile AS profile, vector_generation AS generation FROM ai_runtime WHERE id=1')
    .get() as { profile: string | null; generation: number };
  if (!runtime.profile) throw new Error('vector_profile_missing');
  const buf = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  db.transaction(() => {
    db.prepare('DELETE FROM watch_vectors WHERE watch_id = ?').run(watchId);
    db.prepare('INSERT INTO watch_vectors (watch_id, embedding) VALUES (?, ?)').run(watchId, buf);
    db.prepare(`INSERT INTO watch_vector_meta (watch_id,vector_profile,vector_generation,created_at) VALUES (?,?,?,?)
      ON CONFLICT(watch_id) DO UPDATE SET vector_profile=excluded.vector_profile,
      vector_generation=excluded.vector_generation,created_at=excluded.created_at`)
      .run(watchId, runtime.profile, runtime.generation, Date.now());
  })();
}

export function getWatchVector(db: Db, watchId: string): Float32Array | null {
  const row = db.prepare(`SELECT v.embedding FROM watch_vectors v JOIN watch_vector_meta m ON m.watch_id=v.watch_id
    JOIN ai_runtime r ON r.id=1 WHERE v.watch_id=? AND m.vector_profile=r.vector_profile
    AND m.vector_generation=r.vector_generation`).get(watchId) as { embedding: Buffer } | undefined;
  if (!row) return null;
  return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
}

/** Drops vectors for items older than `days`. The item row and its body stay;
 *  only the searchable vector goes, which is what actually grows unbounded. */
export function pruneVectors(db: Db, days = 180): number {
  const cutoff = Date.now() - days * 864e5;
  const stale = db.prepare('SELECT id FROM items WHERE published_at < ?').all(cutoff) as { id: string }[];
  if (stale.length === 0) return 0;
  const del = db.prepare('DELETE FROM embeddings WHERE item_id = ?');
  db.transaction(() => { for (const s of stale) del.run(s.id); })();
  return stale.length;
}
