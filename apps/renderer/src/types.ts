export interface ItemRow {
  id: string; title: string; url: string; publishedAt: number;
  snippet: string | null; imageUrl: string | null; author: string | null;
  sourceName: string; sourceId: string; domain: string | null;
  bodyState: string; bodyWords: number | null;
  readAt: number | null; starredAt: number | null;
  dateEstimated?: number;
  lang?: string | null;
}
/** Article body HTML, already sanitised by the reader core. */
export interface ItemBody { html: string; words: number; source: 'feed' | 'page' }
export interface SourceRow {
  id: string; name: string; kind: string; category: string | null;
  country: string | null; domain: string | null; enabled: number;
  unread: number; total: number; lastError: string | null;
  newest?: number | null;
}
export type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: 2 | 3; text: string }
  | { type: 'list'; ordered?: boolean; items: string[] }
  | { type: 'quote'; text: string; attribution?: string }
  | { type: 'table'; columns: { key: string; label: string }[]; rows: Record<string, string>[]; caption?: string }
  | { type: 'image'; url: string; alt?: string; caption?: string };


export interface Milestone {
  id: string; watchId: string; occurredOn: string; summary: string;
  itemIds: string[]; firstSeenAt: number; isNew: boolean;
}
export interface WatchRow {
  id: string; origin: 'preset' | 'intent' | 'customized'; label: string; intent: string;
  outputLang: string | null; active: boolean;
  recallAids: { aliases: string[]; relatedTerms: string[]; sourceHints: string[]; updatedAt: string } | null;
  newCount: number; timelineCount: number; passed: number;
}
export interface PresetRow { id: string; label: string; intent: string; enabled: boolean }
export interface Today {
  date: string;
  digest: { id: string; title: string; blocks: Block[]; generatedAt: number } | null;
  changes: { watchId: string; label: string; milestones: Milestone[] }[];
}
export interface AiConnection {
  mode: 'gemini' | 'ollama' | 'none';
  connected: boolean;
  problem?: 'no_key' | 'invalid_key' | 'network' | 'unreachable' | 'model_missing';
}
export interface AiStatus { available: boolean; provider: string; outputLang: string }
export interface SocialStatus {
  mode: 'off' | 'http' | 'library';
  instanceUrl: string | null;
  pack: { installed: boolean; version: string | null; bytes: number | null };
  installing: boolean;
}
export interface ScheduleState {
  enabled: boolean; mode: 'agentService' | 'launchAgent' | 'unsupported';
  dailyHour: number; flashIntervalHours: number; plistPath: string | null;
  status?: 'not-registered' | 'enabled' | 'requires-approval' | 'not-found';
  lastRun: { kind: string; at: number; outcome: string | null; stats: unknown } | null;
  runs?: unknown[];
}

export interface Pnr {
  onCommand?(cb: (command: string) => void): () => void;
  addSource(input: { kind: string; value: string; name?: string; category?: string }): Promise<{ ok: boolean; id?: string; name?: string; items?: number; error?: string }>;
  suggestedRoutes(): Promise<{ label: string; route: string; note?: string }[]>;
  rssHubReady(): Promise<boolean>;
  listSources(): Promise<SourceRow[]>;
  listItems(o: { sourceId?: string; filter?: 'all'|'unread'|'starred'; limit?: number; offset?: number }): Promise<ItemRow[]>;
  countItems(o: { sourceId?: string; filter?: 'all'|'unread'|'starred' }): Promise<number>;
  readingLanguages(): Promise<{ available: { lang: string | null; count: number }[]; selected: string[] }>;
  setReadingLanguages(langs: string[]): Promise<void>;
  getItem(id: string): Promise<(ItemRow & { body: ItemBody | null; bodyError: string | null }) | null>;
  markRead(id: string, read: boolean): Promise<void>;
  toggleStar(id: string): Promise<boolean>;
  setSourceEnabled(id: string, enabled: boolean): Promise<void>;
  catalogue(q: string, limit?: number): Promise<SourceRow[]>;
  stats(): Promise<{ items: number; sources: number; unread: number; lastRun: number | null }>;
  refresh(): Promise<{ busy: boolean; sources?: number; inserted?: number; enriched?: Record<string, number>; error?: string }>;
  enrichOne(id: string): Promise<{ state: string; words: number; reason?: string } | null>;
  openExternal(url: string): Promise<void>;
  onProgress(cb: (p: unknown) => void): () => void;
  aiStatus(): Promise<AiStatus>;
  saveAiSettings(patch: Record<string, string>): Promise<AiConnection>;
  presets(): Promise<PresetRow[]>;
  watches(): Promise<WatchRow[]>;
  addWatch(i: { label: string; intent: string; outputLang?: string }): Promise<WatchRow>;
  editWatch(id: string, patch: Record<string, unknown>): Promise<WatchRow>;
  removeWatch(id: string): Promise<void>;
  togglePreset(id: string, on: boolean): Promise<void>;
  correct(watchId: string, itemId: string, verdict: 'wanted' | 'not_wanted', note?: string): Promise<void>;
  today(date?: string): Promise<Today>;
  watchTimeline(id: string): Promise<{ milestones: Milestone[]; items: { id: string; title: string; url: string }[] }>;
  watchItems(id: string, limit?: number): Promise<(ItemRow & { score: number; reason: string; arms: string })[]>;
  runWatches(): Promise<{ busy?: boolean; noProvider?: boolean; watches?: number; digest?: boolean; error?: string }>;
  runFlashes(): Promise<{ busy?: boolean; noProvider?: boolean; published?: number; error?: string }>;
  flashes(hours?: number, watchId?: string): Promise<unknown[]>;
  deepSummary(itemId: string): Promise<{ noProvider?: boolean; error?: string; summary?: unknown }>;
  scheduleState(): Promise<ScheduleState>;
  setSchedule(on: boolean, hour?: number): Promise<ScheduleState>;
  socialStatus(): Promise<SocialStatus>;
  socialSetInstance(url: string): Promise<void>;
  socialInstall(): Promise<{ ok: boolean; error?: string; version?: string }>;
  socialRemove(): Promise<boolean>;
  onSocialProgress(cb: (p: unknown) => void): () => void;
}
declare global { interface Window { pnr: Pnr } }
