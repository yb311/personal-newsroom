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
export interface RouteParam { key: string; description: string; optional: boolean; options?: { value: string; label: string }[]; default?: string; advanced?: boolean }
export interface CuratedRoute { id: string; platform: string; name: string; path: string; example: string; params: RouteParam[]; sources: string[]; site: string | null }
export interface CatalogueResult {
  rows: SourceRow[]; total: number;
  categories: { key: string; count: number }[];
  countries: { key: string; count: number }[];
}
export type Block =
  | { type: 'paragraph'; text: string; sourceRefIds?: string[] }
  | { type: 'heading'; level: 2 | 3; text: string }
  | { type: 'list'; ordered?: boolean; items: string[] }
  | { type: 'quote'; text: string; attribution?: string }
  | { type: 'table'; columns: { key: string; label: string }[]; rows: Record<string, string>[]; caption?: string }
  | { type: 'image'; url: string; alt?: string; caption?: string };


export interface Milestone {
  id: string; watchId: string; occurredOn: string; summary: string;
  itemIds: string[]; firstSeenAt: number; isNew: boolean;
}
export type Sensitivity = 'more' | 'balanced' | 'less';
export interface WatchRow {
  id: string; origin: 'preset' | 'intent' | 'customized'; label: string; intent: string;
  outputLang: string | null; active: boolean; keywords: string[]; sensitivity: Sensitivity;
  recallAids: { aliases: string[]; relatedTerms: string[]; sourceHints: string[]; updatedAt: string } | null;
  lastRunAt: number | null;
  newCount: number; timelineCount: number; candidates: number; passed: number; openQuestions: number;
}
export interface PresetRow { id: string; group: string; label: string; intent: string; keywords: string[]; enabled: boolean }
export interface WatchItem extends ItemRow {
  score: number | null; reason: string | null; arms: string; verdict: 'wanted' | 'not_wanted' | null;
}
/** What a citation needs to be shown and opened. */
export interface ItemRef { id: string; title: string; url: string; publishedAt: number; sourceName: string | null }
export interface Today {
  date: string;
  digest: { id: string; title: string; blocks: Block[]; generatedAt: number } | null;
  changes: { watchId: string; label: string; milestones: Milestone[] }[];
  outside: OutsidePick[];
  refs: ItemRef[];
  /** Active watches; a brief is only written for them. */
  watchCount: number;
}
export interface OutsidePick { id:string; date:string; lang:string; mode:'ai'|'local'; title:string; reason:string; itemIds:string[]; suggestion:{label:string;intent:string;keywords:string[]}; createdAt:number }
export interface HeadlineGroup { sourceId: string; sourceName: string; items: ItemRow[] }
export interface FlashRow {
  id: string; watchIds: string[]; watchLabels: string[];
  publishedAt: number; itemPublishedAt: number | null; itemIds: string[];
  title: string; body: string; importance: number; importanceReason: string | null;
  category: string | null; basis: 'article' | 'snippet' | 'search'; followUpOf: string | null;
  sources: ItemRef[];
  searchSources: { refId: string; url: string; title: string | null; publisher: string | null }[];
}
export interface ReportUnit { kind: 'paragraph'|'listItem'|'timeline'|'tableRow'; text: string; sourceRefIds: string[]; supported: boolean }
export interface ReportAnswer { title: string; units: ReportUnit[] }
export interface ReportSource { refId: string; itemId: string|null; basis: 'article'|'snippet'|'search'; title: string; url: string; publisher: string|null; publishedAt: number|null; materialText: string }
export interface ReportMessage { id: string; sequence: number; role: 'user'|'assistant'; question: string|null; answer: ReportAnswer|null; status: 'pending'|'complete'|'cancelled'|'failed'; model: string|null }
export interface ReportConversation { id: string; anchorItemId: string; lang: string; topic: string; initialItemIds: string[]; messages: ReportMessage[]; sources: ReportSource[]; createdAt: number; updatedAt: number }
export interface ReportEvent { requestId: string; conversationId: string; messageId: string; sequence: number; type: 'partial'|'complete'|'cancelled'|'error'; value?: Partial<ReportAnswer>; error?: string }
/** What a deep report is about: the article it starts from and its companions. */
export interface ReportAnchor { anchorItemId: string; itemIds: string[]; topic: string }
export interface MenuEntry { id?: string; label?: string; enabled?: boolean; checked?: boolean; separator?: boolean }
export type AssistantSourceKind = 'library' | 'news' | 'web';
export interface AssistantUnit { kind: 'paragraph' | 'listItem'; text: string; sourceRefIds: string[]; supported: boolean }
export interface AssistantAnswer { units: AssistantUnit[] }
export interface AssistantSource { refId: string; kind: AssistantSourceKind; itemId: string | null; title: string; url: string; publisher: string | null; publishedAt: number | null }
export interface AssistantMessage { id: string; sequence: number; role: 'user' | 'assistant'; content: string | null; answer: AssistantAnswer | null; status: 'pending' | 'complete' | 'cancelled' | 'failed'; web: boolean; error: string | null }
export interface AssistantChat { id: string; title: string; lang: string; createdAt: number; updatedAt: number; messages: AssistantMessage[]; sources: AssistantSource[] }
export interface AssistantChatSummary { id: string; title: string; updatedAt: number }
export type AssistantPhase = 'library' | 'news' | 'web' | 'writing';
export interface AssistantEvent { requestId: string; chatId: string; messageId: string; type: 'phase' | 'partial' | 'complete' | 'cancelled' | 'error'; phase?: AssistantPhase; value?: Partial<AssistantAnswer>; error?: string }
export interface OpenQuestion { id: number; question: string; askedAt: number }
export interface RunResult {
  busy?: boolean; error?: string; fetched?: number; watches?: number; failed?: number;
  mode?: 'ai' | 'keywords'; digest?: boolean; milestones?: number; flashes?: number;
}
export interface AiConnection {
  mode: 'gemini' | 'openai' | 'anthropic' | 'openai-compatible' | 'ollama' | 'none';
  connected: boolean;
  embedding?: boolean;
  problem?: 'no_key' | 'invalid_key' | 'network' | 'unreachable' | 'model_missing' | 'rate_limited' | 'quota_exhausted' | 'context_exceeded' | 'unsupported';
}
export interface AiStatus {
  available: boolean; provider: string; outputLang: string;
  hasGeminiKey: boolean; hasOpenAiKey: boolean; hasAnthropicKey: boolean; hasCompatibleKey: boolean;
  compatibleEndpoint: string; writeModel: string; fastModel: string; embedModel: string; contextTokens: string;
  ollamaHost: string; ollamaWriteModel: string; ollamaFastModel: string; ollamaEmbedModel: string;
  searchFillEnabled: boolean;
  outsidePicksEnabled: boolean;
  /** Whether the connected provider can search the web itself. */
  webSearch: boolean;
  /** Recommended models of each cloud provider, shown as placeholders. */
  defaults: Record<'gemini' | 'openai' | 'anthropic', { write: string; fast: string; embed?: string }>;
}
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
  rsshubRoutes(): Promise<CuratedRoute[]>;
  previewRoute(path: string): Promise<{ ok: boolean; titles: string[]; reason?: string }>;
  matchRoute(url: string): Promise<{ routeId: string; path: string } | null>;
  hasApifyToken(): Promise<boolean>;
  setApifyToken(token: string): Promise<void>;
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
  catalogue(o: { q?: string; category?: string | null; country?: string | null; limit?: number }): Promise<CatalogueResult>;
  stats(): Promise<{ items: number; sources: number; unread: number; lastRun: number | null }>;
  refresh(): Promise<{ busy: boolean; sources?: number; inserted?: number; enriched?: Record<string, number>; error?: string }>;
  enrichOne(id: string): Promise<{ state: string; words: number; reason?: string } | null>;
  openExternal(url: string): Promise<void>;
  onProgress(cb: (p: unknown) => void): () => void;
  aiStatus(): Promise<AiStatus>;
  saveAiSettings(patch: Record<string, string>): Promise<AiConnection>;
  setAiOption(key: 'outputLang' | 'searchFillEnabled' | 'outsidePicksEnabled', value: string): Promise<void>;
  presets(lang?: string): Promise<PresetRow[]>;
  watches(): Promise<WatchRow[]>;
  addWatch(i: { label: string; intent: string; keywords?: string[]; outputLang?: string | null }): Promise<WatchRow>;
  addPresets(ids: string[], lang?: string): Promise<string[]>;
  uiLanguage(): Promise<{ choice: 'system' | 'zh-CN' | 'en'; resolved: 'zh-CN' | 'en' }>;
  setUiLanguage(choice: 'system' | 'zh-CN' | 'en'): Promise<{ choice: 'system' | 'zh-CN' | 'en'; resolved: 'zh-CN' | 'en' }>;
  backgroundPrompt(): Promise<boolean>;
  dismissBackgroundPrompt(): Promise<void>;
  editWatch(id: string, patch: Record<string, unknown>): Promise<WatchRow>;
  removeWatch(id: string): Promise<void>;
  togglePreset(id: string, on: boolean): Promise<void>;
  correct(watchId: string, itemId: string, verdict: 'wanted' | 'not_wanted', note?: string): Promise<void>;
  today(date?: string): Promise<Today>;
  watchTimeline(id: string): Promise<{ milestones: Milestone[]; refs: ItemRef[]; questions: OpenQuestion[] }>;
  headlines(hours?: number, perSource?: number): Promise<HeadlineGroup[]>;
  itemRefs(ids: string[]): Promise<ItemRef[]>;
  runWatch(id: string): Promise<RunResult>;
  watchItems(id: string, limit?: number): Promise<WatchItem[]>;
  runWatches(): Promise<RunResult>;
  runFlashes(): Promise<RunResult>;
  flashes(hours?: number, watchId?: string): Promise<FlashRow[]>;
  reportGet(selector: { conversationId?: string; anchorItemId?: string; lang?: string }): Promise<ReportConversation | null>;
  reportStart(input: { anchorItemId: string; itemIds: string[]; topic: string; lang: string; restart?: boolean; requestId: string }): Promise<{ noProvider?: boolean; error?: string; conversation?: ReportConversation }>;
  reportAsk(input: { conversationId: string; question: string; requestId: string; research?: boolean }): Promise<{ noProvider?: boolean; error?: string; conversation?: ReportConversation }>;
  reportCancel(requestId: string): Promise<boolean>;
  onReportEvent(cb: (event: ReportEvent) => void): () => void;
  openSettings(section?: string): Promise<void>;
  broadcast(command: string): Promise<void>;
  accentColor(): Promise<string | null>;
  onAccentColor(cb: (hex: string) => void): () => void;
  onUiLanguage(cb: (lang: string) => void): () => void;
  contextMenu(items: MenuEntry[]): Promise<string | null>;
  copyText(text: string): Promise<void>;
  assistantList(): Promise<AssistantChatSummary[]>;
  assistantGet(id: string): Promise<AssistantChat | null>;
  assistantDelete(id: string): Promise<boolean>;
  assistantAsk(input: { chatId: string | null; question: string; web: boolean; lang: string; requestId: string }): Promise<{ chat?: AssistantChat; error?: string }>;
  assistantCancel(requestId: string): Promise<boolean>;
  onAssistantEvent(cb: (event: AssistantEvent) => void): () => void;
  scheduleState(): Promise<ScheduleState>;
  setSchedule(on: boolean, hour?: number): Promise<ScheduleState>;
  socialStatus(): Promise<SocialStatus>;
  socialSetInstance(url: string): Promise<void>;
  socialInstall(): Promise<{ ok: boolean; error?: string; version?: string }>;
  socialRemove(): Promise<boolean>;
  onSocialProgress(cb: (p: unknown) => void): () => void;
}
declare global { interface Window { pnr: Pnr } }
