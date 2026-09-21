/** Structured log envelope ported from daily-brief lib/core/logging.ts.
 *  The worker writes these to the events table; the UI reads them on launch,
 *  because the UI is usually not running when the worker runs. */
export interface LogEvent {
  event: string;
  runId?: string;
  stage?: string;
  phase?: 'started' | 'completed' | 'skipped' | 'failed';
  entityType?: string;
  entityId?: string;
  outcome?: string;
  reasonCode?: string;
  reasonDetail?: string;
  elapsedMs?: number;
  attrs?: Record<string, unknown>;
}

export type Sink = (e: LogEvent) => void;

let sink: Sink = (e) => {
  const bits = [e.event, e.stage, e.phase, e.outcome, e.reasonCode].filter(Boolean).join(' ');
  console.log(`[${new Date().toISOString()}] ${bits}${e.attrs ? ' ' + JSON.stringify(e.attrs) : ''}`);
};
const runContext = new AsyncLocalStorage<{ runId: string }>();
export const setSink = (s: Sink): void => { sink = s; };
export const currentRunId = (): string | undefined => runContext.getStore()?.runId;
export const withRunContext = <T>(runId: string, fn: () => T): T => runContext.run({ runId }, fn);
export const log = (e: LogEvent): void => {
  const runId = currentRunId();
  sink(e.runId || !runId ? e : { ...e, runId });
};

export function phase(event: string, stage: string, attrs?: Record<string, unknown>) {
  const t0 = Date.now();
  log({ event, stage, phase: 'started', ...(attrs ? { attrs } : {}) });
  return {
    complete: (a?: Record<string, unknown>) =>
      log({ event, stage, phase: 'completed', elapsedMs: Date.now() - t0, ...(a ? { attrs: a } : {}) }),
    skip: (reasonCode: string) => log({ event, stage, phase: 'skipped', reasonCode, elapsedMs: Date.now() - t0 }),
    fail: (reasonCode: string, reasonDetail?: string) =>
      log({ event, stage, phase: 'failed', reasonCode, ...(reasonDetail ? { reasonDetail } : {}), elapsedMs: Date.now() - t0 })
  };
}
import { AsyncLocalStorage } from 'node:async_hooks';
