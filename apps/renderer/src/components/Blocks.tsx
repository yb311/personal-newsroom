import { Fragment, type ReactNode } from 'react';
import type { Block, ItemRef } from '../types.ts';
import { Cited, Cites, Refs } from './Cites.tsx';

/** Renders the shared RichBlock contract used by AI-written text. When `refs`
 *  is given, paragraphs show the sources they were written from — as numbered
 *  marks when the document closes with a numbered source list. `kicker` puts a
 *  line above a heading that belongs to a watch, as a newspaper names its section. */
export function Blocks({ blocks, refs, numbers, onOpen, kicker }: {
  blocks: Block[]; refs?: Map<string, ItemRef>; numbers?: Map<string, number>; onOpen?: (id: string) => void;
  kicker?: (watchId: string) => ReactNode;
}) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'paragraph': return (
            <p key={i}>{refs && onOpen ? <Cited text={b.text}>{numbers
              ? <Refs ids={b.sourceRefIds} refs={refs} numbers={numbers} onOpen={onOpen} />
              : <Cites ids={b.sourceRefIds} refs={refs} onOpen={onOpen} />}</Cited> : b.text}</p>
          );
          case 'heading': {
            const heading = b.level === 2 ? <h2>{b.text}</h2> : <h3>{b.text}</h3>;
            return <Fragment key={i}>{b.watchId && kicker?.(b.watchId)}{heading}</Fragment>;
          }
          case 'quote': return (
            <blockquote key={i}>
              <p>{b.text}</p>
              {b.attribution && <cite>{b.attribution}</cite>}
            </blockquote>
          );
          case 'list': return b.ordered
            ? <ol key={i}>{b.items.map((t, j) => <li key={j}>{t}</li>)}</ol>
            : <ul key={i}>{b.items.map((t, j) => <li key={j}>{t}</li>)}</ul>;
          case 'image': return (
            <figure key={i}>
              <img src={b.url} alt={b.alt ?? ''} loading="lazy" />
              {b.caption && <figcaption>{b.caption}</figcaption>}
            </figure>
          );
          case 'table': return (
            <table key={i}>
              <thead><tr>{b.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>{b.columns.map((c) => <td key={c.key}>{r[c.key] ?? ''}</td>)}</tr>
                ))}
              </tbody>
            </table>
          );
          default: return null;
        }
      })}
    </>
  );
}
