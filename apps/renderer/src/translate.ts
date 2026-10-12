import type { AiStatus, ItemRow, TranslateSettings } from './types.ts';
import { languageName } from './i18n.ts';

/**
 * 翻译 in the interface. The work happens in the main process
 * (packages/generate/src/translate.ts); this is what the views share.
 *
 *   original     the article as published (paragraphs translated one by one still show)
 *   bilingual    each paragraph followed by its translation — the default
 *   translation  the translation only; the original is one click away
 */
export type TranslateMode = 'original' | 'bilingual' | 'translation';
export type TranslatedMode = Exclude<TranslateMode, 'original'>;

const DISPLAY_KEY = 'pnr.translateDisplay';
const LIST_KEY = 'pnr.listTranslated';

export const translateSettings = (ai: AiStatus | null): TranslateSettings =>
  ai?.translate ?? { target: ai?.outputLang ?? 'zh-CN', choice: '', auto: false, selection: true };

/** 'zh' for 'zh-CN'. Articles carry ISO 639-1 codes; settings carry regional ones. */
export const baseLang = (code: string | null | undefined): string => (code ?? '').split(/[-_]/)[0]!.toLowerCase();
/** Whether an article is in another language than the one translations go into. Unknown is not foreign. */
export const isForeign = (lang: string | null | undefined, target: string): boolean => Boolean(lang) && baseLang(lang) !== baseLang(target);

/** How the person last chose to read translations. */
export function preferredMode(): TranslatedMode {
  try { return localStorage.getItem(DISPLAY_KEY) === 'translation' ? 'translation' : 'bilingual'; } catch { return 'bilingual'; }
}
export function rememberMode(mode: TranslateMode): void {
  if (mode === 'original') return;
  try { localStorage.setItem(DISPLAY_KEY, mode); } catch { /* optional */ }
}

/** Whether lists show translated headlines where there are some. */
export function listTranslated(): boolean {
  try { return localStorage.getItem(LIST_KEY) !== '0'; } catch { return true; }
}
export function rememberListTranslated(on: boolean): void {
  try { localStorage.setItem(LIST_KEY, on ? '1' : '0'); } catch { /* optional */ }
}

/** A list row's headline and snippet, translated when there is a translation and lists show them. */
export const rowText = (it: ItemRow, translated: boolean): { title: string; snippet: string | null; isTranslated: boolean } =>
  translated && it.titleTr ? { title: it.titleTr, snippet: it.snippetTr ?? it.snippet, isTranslated: true }
    : { title: it.title, snippet: it.snippet, isTranslated: false };

/** Asks the selection popover to translate what is selected now (from a context menu). */
export const TRANSLATE_SELECTION = 'pnr-translate-selection';
export const translateSelection = (): void => { window.dispatchEvent(new CustomEvent(TRANSLATE_SELECTION)); };

/** A translation language's name: 简体中文 rather than 中文（中国）, 英语 rather than 英语（美国）. */
export const targetName = (code: string): string => {
  const c = code.toLowerCase();
  return languageName(c === 'zh-cn' || c === 'zh-sg' ? 'zh-Hans' : c.startsWith('zh-') ? 'zh-Hant' : baseLang(code) || code);
};
