import type { ItemRef } from '../types.ts';

/**
 * The sources a sentence was written from. Every AI-written line binds to
 * items it was given (the model cannot invent a link), and each one opens the
 * article in the reader, so any sentence can be checked against its source.
 */
export function Cites({ ids, refs, onOpen }: { ids: string[] | undefined; refs: Map<string, ItemRef>; onOpen: (id: string) => void }) {
  const found = [...new Set(ids ?? [])].map((id) => refs.get(id)).filter((r): r is ItemRef => Boolean(r));
  if (found.length === 0) return null;
  return (
    <span className="cites">
      {found.map((r) => (
        <button key={r.id} className="cite-chip" title={r.title} onClick={() => onOpen(r.id)}>
          {r.sourceName ?? '来源'}
        </button>
      ))}
    </span>
  );
}
