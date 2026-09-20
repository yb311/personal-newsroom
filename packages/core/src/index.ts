export type { DiscoveredItem, ParseResult, ParseDiagnostics, SourceKind, SourceRecord } from './types.ts';
export { cleanUrl, canonicalDedupKey, domainOf } from './url.ts';
export { log, phase, setSink, type LogEvent, type Sink } from './logging.ts';
export type {
  RichBlock, ParagraphBlock, HeadingBlock, ListBlock, QuoteBlock,
  TableBlock, TableColumn, ImageBlock, ClaimType
} from './blocks.ts';
export { blockText, countWords } from './blocks.ts';
