/**
 * Development switches, ported in spirit from daily-brief's NEWS_DISABLE_*.
 * Each turns one network-touching stage off so a pipeline can be run offline,
 * against what is already in the database, at no cost. None is ever set in a
 * shipped app; `npm run doctor` prints their current values.
 */
const on = (name: string): boolean => /^(1|true|yes|on)$/i.test(process.env[name] ?? '');

export const flags = {
  /** Skip downloading feeds; work with the items already stored. */
  get disableFetch(): boolean { return on('PNR_DISABLE_FETCH'); },
  /** Skip fetching article pages; bodies stay as they are. */
  get disableExtract(): boolean { return on('PNR_DISABLE_EXTRACT'); },
  /** Skip the search-engine recall arm (R3). */
  get disableSearch(): boolean { return on('PNR_DISABLE_SEARCH'); },
  /**
   * Record model responses to dev/snapshots and replay them on the next run
   * with the same prompt: 'record', 'replay', or unset.
   */
  get replay(): 'record' | 'replay' | null {
    const v = (process.env['PNR_REPLAY'] ?? '').toLowerCase();
    return v === 'record' || v === 'replay' ? v : null;
  }
};

/** Every switch and its current value, for doctor output and run logs. */
export function describeFlags(): Record<string, string> {
  return {
    PNR_DISABLE_FETCH: String(flags.disableFetch),
    PNR_DISABLE_EXTRACT: String(flags.disableExtract),
    PNR_DISABLE_SEARCH: String(flags.disableSearch),
    PNR_REPLAY: flags.replay ?? 'off'
  };
}
