import { categoryLabel, countryLabel } from '@pnr/core/catalog-labels';
import { Dialog } from './Dialog.tsx';
import { RssHubPicker } from './RssHubPicker.tsx';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { CatalogueResult, SourceRow } from '../types.ts';

type Tab = 'browse' | 'social' | 'add';

/** Why a new source produced nothing, from the reason code it failed with. */
const sourceFailure = (t: TFunction, code?: string): string =>
  !code ? t('catalogue.failure.unknown')
    : code.startsWith('instance_') ? t('catalogue.failure.instance')
    : t(`catalogue.failure.${code}`, { defaultValue: t('catalogue.failure.unknown') });

/** Browse the built-in catalogue, or add anything the user has in mind. */
export function Catalogue({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('browse');
  return (
    <Dialog title={t('catalogue.title')} onClose={onClose}>
        <header>
          <h2>{t('catalogue.heading')}</h2>
          <nav className="tabs small">
            {(['browse', 'social', 'add'] as const).map((id) => (
              <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{t(`catalogue.tabs.${id}`)}</button>
            ))}
          </nav>
          <span className="grow" />
          <button onClick={onClose}>{t('common.done')}</button>
        </header>
        {tab === 'browse' ? <Browse /> : tab === 'social' ? <RssHubPicker describe={(code) => sourceFailure(t, code)} /> : <AddSource />}
    </Dialog>
  );
}

function Browse() {
  const { t, i18n } = useTranslation();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [country, setCountry] = useState<string | null>(null);
  const [result, setResult] = useState<CatalogueResult | null>(null);
  const rows = result?.rows ?? [];

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void window.pnr.catalogue({ q, category, country, limit: 300 }).then((r) => { if (live) setResult(r); });
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [q, category, country]);

  const toggle = async (s: SourceRow): Promise<void> => {
    const next = !s.enabled;
    await window.pnr.setSourceEnabled(s.id, next);
    setResult((prev) => prev && { ...prev, rows: prev.rows.map((r) => (r.id === s.id ? { ...r, enabled: next ? 1 : 0 } : r)) });
  };

  return (
    <>
      <div className="modal-search">
        <input autoFocus aria-label={t('catalogue.search')} placeholder={t('catalogue.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="facets" aria-label={t('catalogue.byCategory')}>
        <button className={category === null ? 'chip active' : 'chip'} onClick={() => setCategory(null)}>{t('catalogue.allCategories')}</button>
        {result?.categories.slice(0, 16).map((c) => (
          <button key={c.key} className={category === c.key ? 'chip active' : 'chip'} onClick={() => setCategory(category === c.key ? null : c.key)}>
            {categoryLabel(c.key, i18n.language)} <small>{c.count}</small>
          </button>
        ))}
      </div>
      {(result?.countries.length ?? 0) > 0 && (
        <div className="facets" aria-label={t('catalogue.byCountry')}>
          <button className={country === null ? 'chip active' : 'chip'} onClick={() => setCountry(null)}>{t('catalogue.allCountries')}</button>
          {result!.countries.map((c) => (
            <button key={c.key} className={country === c.key ? 'chip active' : 'chip'} onClick={() => setCountry(country === c.key ? null : c.key)}>
              {countryLabel(c.key, i18n.language)} <small>{c.count}</small>
            </button>
          ))}
        </div>
      )}
      <p className="modal-note">{t('catalogue.found', { count: rows.length, enabled: rows.filter((r) => r.enabled).length })}</p>
      <ul className="catalogue">
        {rows.length === 0 && <li className="empty-block">{t('catalogue.none')}</li>}
        {rows.map((s) => (
          <li key={s.id}>
            <label>
              <input type="checkbox" checked={Boolean(s.enabled)} onChange={() => void toggle(s)} />
              <span className="name">{s.name}</span>
              <span className="tag">{categoryLabel(s.category, i18n.language)}</span>
              {s.country && <span className="tag country">{countryLabel(s.country, i18n.language)}</span>}
              <span className="domain">{s.domain}</span>
            </label>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Source kinds; their names, hints and examples are in the dictionaries. */
const KINDS = ['auto', 'rss', 'telegram', 'reddit', 'hackernews', 'github', 'apify_x', 'rsshub'] as const;

function AddSource() {
  const { t } = useTranslation();
  const [kind, setKind] = useState<(typeof KINDS)[number]>('auto');
  const [value, setValue] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [rssHub, setRssHub] = useState<boolean | null>(null);

  useEffect(() => { void window.pnr.rssHubReady().then(setRssHub); }, []);

  const submit = async (): Promise<void> => {
    if (!value.trim() || busy) return;
    setBusy(true); setResult(null);
    try {
    const r = await window.pnr.addSource({ kind, value, ...(name.trim() ? { name: name.trim() } : {}) });
    if (!r.ok) setResult({ ok: false, text: r.error ? sourceFailure(t, r.error) : t('catalogue.addFailed') });
    else if (r.items === 0) setResult({ ok: false, text: t('catalogue.addedEmpty', { name: r.name, why: sourceFailure(t, r.error) }) });
    else { setResult({ ok: true, text: t('catalogue.added', { name: r.name, count: r.items }) }); setValue(''); setName(''); }
    } catch { setResult({ ok: false, text: t('catalogue.addError') }); }
    finally { setBusy(false); }
  };

  const example = t(`catalogue.kinds.${kind}.example`);

  return (
    <div className="add-source">
      <div className="kind-picker">
        {KINDS.map((k) => (
          <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>{t(`catalogue.kinds.${k}.label`)}</button>
        ))}
      </div>
      <p className="muted">{t(`catalogue.kinds.${kind}.hint`)}　{t('catalogue.example')}<code>{example}</code></p>

      <div className="new-watch">
        <input aria-label={t('catalogue.name')} placeholder={t('catalogue.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
        <input autoFocus aria-label={t('catalogue.address')} placeholder={example} value={value}
               onChange={(e) => setValue(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit(); }} />
        <button className="primary" onClick={() => void submit()} disabled={busy || !value.trim()}>
          {busy ? t('common.checking') : t('common.add')}
        </button>
      </div>

      {result && <p role="status" className={result.ok ? 'muted ok' : 'muted warn'}>{result.text}</p>}

      {kind === 'rsshub' && (
        <p className="muted">
          {rssHub === false && <span className="warn">{t('catalogue.rsshubMissing')}</span>}
          {t('catalogue.rsshubHint')}
        </p>
      )}

      {kind === 'telegram' && (
        <p className="muted">{t('catalogue.telegramHint')}</p>
      )}
    </div>
  );
}
