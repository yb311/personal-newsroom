import type { Block } from '../types.ts';

/** Renders the shared RichBlock contract. The same renderer will serve AI
 *  summaries and deep dives later, so block types stay in one place. */
export function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'paragraph': return <p key={i}>{b.text}</p>;
          case 'heading': return b.level === 2 ? <h2 key={i}>{b.text}</h2> : <h3 key={i}>{b.text}</h3>;
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
