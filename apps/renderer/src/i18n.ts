import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './locales/zh-CN.json';
import en from './locales/en.json';

/**
 * Interface language. Separate from the language AI writes in (设置 → AI 与语言)
 * and from the languages of the articles themselves. The main process resolves
 * "match system" and builds the menu from the same dictionaries.
 */
export type UiLanguage = 'zh-CN' | 'en';

export async function initI18n(lng: UiLanguage): Promise<void> {
  await i18next.use(initReactI18next).init({
    resources: { 'zh-CN': { translation: zhCN }, en: { translation: en } },
    lng,
    fallbackLng: 'zh-CN',
    interpolation: { escapeValue: false }   // React escapes
  });
  document.documentElement.lang = lng;
}

export async function changeLanguage(lng: UiLanguage): Promise<void> {
  await i18next.changeLanguage(lng);
  document.documentElement.lang = lng;
}

const lang = (): string => i18next.language || 'zh-CN';

// Dates and times always follow the interface language.
export const dateTime = (ts: number, opts?: Intl.DateTimeFormatOptions): string =>
  new Date(ts).toLocaleString(lang(), opts);
export const dateOnly = (ts: number): string => new Date(ts).toLocaleDateString(lang());
export const clock = (ts: number): string =>
  new Date(ts).toLocaleTimeString(lang(), { hour: '2-digit', minute: '2-digit' });

/** "5 分钟前" / "5 minutes ago"; older than a month shows the date. */
export function ago(ts: number): string {
  const rtf = new Intl.RelativeTimeFormat(lang(), { numeric: 'auto' });
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return rtf.format(0, 'second');
  if (mins < 60) return rtf.format(-mins, 'minute');
  const h = Math.round(mins / 60);
  if (h < 24) return rtf.format(-h, 'hour');
  const d = Math.round(h / 24);
  return d < 30 ? rtf.format(-d, 'day') : dateOnly(ts);
}

/** A language code's name in the interface language: "es" → 西班牙语 / Spanish. */
export function languageName(code: string): string {
  try { return new Intl.DisplayNames([lang()], { type: 'language' }).of(code) ?? code.toUpperCase(); }
  catch { return code.toUpperCase(); }
}
