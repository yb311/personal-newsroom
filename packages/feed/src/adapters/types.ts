import type { ParseResult, SourceRecord, SourceKind } from '@pnr/core';
import type { Db } from '@pnr/store';

export interface AdapterCtx {
  /** Present when the caller has a database; adapters that need persistent
   *  state (circuit breakers, cursors) require it and degrade without it. */
  db?: Db;
}

export type Adapter = (source: SourceRecord, ctx: AdapterCtx) => Promise<ParseResult>;
export type AdapterRegistry = Partial<Record<SourceKind, Adapter>>;

export const emptyResult = (reason?: string): ParseResult => ({
  items: [],
  diagnostics: { fetched: 0, kept: 0, droppedByReason: reason ? { [reason]: 1 } : {} }
});

export type { ParseResult, SourceRecord };
