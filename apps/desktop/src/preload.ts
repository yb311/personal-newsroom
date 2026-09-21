import { contextBridge, ipcRenderer } from 'electron';

/** The renderer gets exactly this surface: no Node, no database handle, no
 *  filesystem. Adding a method to ipc.ts means adding its name here. */
const API_METHODS = [
  'listSources', 'listItems', 'getItem', 'markRead', 'toggleStar',
  'setSourceEnabled', 'catalogue', 'stats',
  'aiStatus', 'saveAiSettings', 'presets', 'watches', 'addWatch', 'editWatch',
  'removeWatch', 'togglePreset', 'correct', 'today', 'watchTimeline', 'watchItems', 'flashes', 'addSource', 'removeSource', 'suggestedRoutes', 'rssHubReady'
] as const;

const api: Record<string, unknown> = {};
for (const name of API_METHODS) {
  api[name] = (...args: unknown[]) => ipcRenderer.invoke(`api:${name}`, ...args);
}

contextBridge.exposeInMainWorld('pnr', {
  ...api,
  onCommand: (cb: (command: string) => void) => {
    const fn = (_e: unknown, command: string): void => cb(command);
    ipcRenderer.on('app:command', fn);
    return () => ipcRenderer.off('app:command', fn);
  },
  refresh: () => ipcRenderer.invoke('app:refresh'),
  runWatches: () => ipcRenderer.invoke('app:runWatches'),
  runFlashes: () => ipcRenderer.invoke('app:runFlashes'),
  deepSummary: (id: string) => ipcRenderer.invoke('app:deepSummary', id),
  scheduleState: () => ipcRenderer.invoke('app:scheduleState'),
  socialStatus: () => ipcRenderer.invoke('social:status'),
  socialSetInstance: (url: string) => ipcRenderer.invoke('social:setInstance', url),
  socialInstall: () => ipcRenderer.invoke('social:install'),
  socialRemove: () => ipcRenderer.invoke('social:remove'),
  onSocialProgress: (cb: (p: unknown) => void) => {
    const fn = (_e: unknown, p: unknown): void => cb(p);
    ipcRenderer.on('social:progress', fn);
    return () => ipcRenderer.off('social:progress', fn);
  },
  setSchedule: (on: boolean, hour?: number) => ipcRenderer.invoke('app:setSchedule', on, hour),
  enrichOne: (id: string) => ipcRenderer.invoke('app:enrichOne', id),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  onProgress: (cb: (p: unknown) => void) => {
    const fn = (_e: unknown, p: unknown): void => cb(p);
    ipcRenderer.on('app:progress', fn);
    return () => ipcRenderer.off('app:progress', fn);
  }
});
