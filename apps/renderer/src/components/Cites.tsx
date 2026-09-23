import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ItemRef } from '../types.ts';
import { dateTime } from '../i18n.ts';

/**
 * The outlets a line was written from, one chip per outlet. Every AI-written
 * line binds to items it was given (the model cannot invent a link); a chip
 * opens that outlet's article in the reader, and its tooltip lists them all.
 */
export function Cites({ ids, refs, onOpen }: { ids: string[] | undefined; refs: Map<string, ItemRef>; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const byOutlet = new Map<string, ItemRef[]>();
  for (const r of [...new Set(ids ?? [])].map((id) => refs.get(id)).filter((x): x is ItemRef => Boolean(x))) {
    const name = r.sourceName ?? t('common.newsSearch');
    byOutlet.set(name, [...(byOutlet.get(name) ?? []), r]);
  }
  if (byOutlet.size === 0) return null;
  return (
    <span className="cites">
      {[...byOutlet].map(([name, list]) => (
        <button key={name} className="cite-chip" title={list.map((r) => r.title).join('\n')} onClick={() => onOpen(list[0]!.id)}>{name}</button>
      ))}
    </span>
  );
}

/** Where the unbreakable tail before a sentence's marks starts: its last word,
 *  or its last three characters when the text has no spaces (Chinese, Japanese). */
const tailStart = (text: string): number => {
  const word = text.search(/\S+$/);
  if (word < 0) return text.length;
  return text.length - word > 12 ? Math.max(word, text.length - 3) : word;
};

/** A sentence and its citation marks. The last word travels with the marks,
 *  so a mark never starts a line on its own, as in print. */
export function Cited({ text, children }: { text: string; children: ReactNode }) {
  const at = tailStart(text);
  return <>{text.slice(0, at)}<span className="cited-tail">{text.slice(at)}{children}</span></>;
}

/** Numbers a document's sources in the order it first cites them, so the
 *  text carries small marks and one numbered list closes the document. */
export function numberSources(groups: (string[] | undefined)[], refs: Map<string, ItemRef>): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const ids of groups) for (const id of ids ?? []) if (refs.has(id) && !numbers.has(id)) numbers.set(id, numbers.size + 1);
  return numbers;
}

/** Footnote marks for one sentence; each still opens its article. */
export function Refs({ ids, refs, numbers, onOpen }: {
  ids: string[] | undefined; refs: Map<string, ItemRef>; numbers: Map<string, number>; onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const found = [...new Set(ids ?? [])].filter((id) => numbers.has(id));
  if (found.length === 0) return null;
  return (
    <span className="refs">
      {found.map((id) => {
        const r = refs.get(id)!;
        return <button key={id} className="ref" title={[r.sourceName ?? t('common.newsSearch'), r.title].join(' · ')} onClick={() => onOpen(id)}>{numbers.get(id)}</button>;
      })}
    </span>
  );
}

/** The numbered sources that close a document. */
export function SourceList({ numbers, refs, onOpen }: { numbers: Map<string, number>; refs: Map<string, ItemRef>; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  if (numbers.size === 0) return null;
  return (
    <section className="doc-sources">
      <h2>{t('common.sources', { count: numbers.size })}</h2>
      <ol>{[...numbers].map(([id, n]) => {
        const r = refs.get(id)!;
        return <li key={id}>
          <span className="ref static">{n}</span>
          <div>
            <button className="link" onClick={() => onOpen(id)}>{r.title}</button>
            <small>{[r.sourceName ?? t('common.newsSearch'), dateTime(r.publishedAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })].join(' · ')}</small>
          </div>
        </li>;
      })}</ol>
    </section>
  );
}
