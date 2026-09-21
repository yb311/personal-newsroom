import type { Db } from '@pnr/store';
import type { EmbedKind, Provider } from './provider.ts';
import { log } from '@pnr/core';

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

  const get = db.prepare('SELECT embedding FROM embeddings WHERE item_id = ?');
  for (const it of items) {
    const row = get.get(it.id) as { embedding: Buffer } | undefined;
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
  db.transaction(() => {
    missing.forEach((m, i) => {
      const v = vectors[i];
      if (!v) return;
      del.run(m.id);
      ins.run(m.id, Buffer.from(v.buffer, v.byteOffset, v.byteLength));
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
  const buf = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  db.prepare('DELETE FROM watch_vectors WHERE watch_id = ?').run(watchId);
  db.prepare('INSERT INTO watch_vectors (watch_id, embedding) VALUES (?, ?)').run(watchId, buf);
}

export function getWatchVector(db: Db, watchId: string): Float32Array | null {
  const row = db.prepare('SELECT embedding FROM watch_vectors WHERE watch_id = ?').get(watchId) as { embedding: Buffer } | undefined;
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
