import { contextBridge, ipcRenderer } from 'electron';

/** The renderer gets exactly this surface: no Node, no database handle, no
 *  filesystem. Adding a method to ipc.ts means adding its name here. */
const API_METHODS = [
  'listSources', 'listItems', 'getItem', 'markRead', 'toggleStar',
  'setSourceEnabled', 'catalogue', 'setAiOption', 'stats', 'countItems', 'headlines', 'itemRefs', 'readingLanguages', 'setReadingLanguages',
  'aiStatus', 'saveAiSettings', 'presets', 'watches', 'addWatch', 'editWatch',
  'removeWatch', 'togglePreset', 'correct', 'addPresets', 'backgroundPrompt', 'dismissBackgroundPrompt', 'today', 'watchTimeline', 'watchItems', 'flashes', 'addSource', 'removeSource', 'rsshubRoutes', 'previewRoute', 'matchRoute', 'hasApifyToken', 'setApifyToken', 'rssHubReady'
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
  uiLanguage: () => ipcRenderer.invoke('app:uiLanguage'),
  setUiLanguage: (choice: string) => ipcRenderer.invoke('app:setUiLanguage', choice),
  runWatches: () => ipcRenderer.invoke('app:runWatches'),
  runFlashes: () => ipcRenderer.invoke('app:runFlashes'),
  runWatch: (id: string) => ipcRenderer.invoke('app:runWatch', id),
  assistantList: () => ipcRenderer.invoke('assistant:list'),
  assistantGet: (id: string) => ipcRenderer.invoke('assistant:get', id),
  assistantDelete: (id: string) => ipcRenderer.invoke('assistant:delete', id),
  assistantAsk: (input: unknown) => ipcRenderer.invoke('assistant:ask', input),
  assistantCancel: (requestId: string) => ipcRenderer.invoke('assistant:cancel', requestId),
  onAssistantEvent: (cb: (p: unknown) => void) => {
    const fn = (_e: unknown, p: unknown): void => cb(p);
    ipcRenderer.on('assistant:event', fn);
    return () => ipcRenderer.off('assistant:event', fn);
  },
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
