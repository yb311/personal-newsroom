import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { SettingsWindow } from './components/Settings.tsx';
import { changeLanguage, initI18n, type UiLanguage } from './i18n.ts';
import './styles/tokens.css';
import './styles/app.css';

// The language is known before the first paint, so nothing flashes in the
// wrong language. `#settings` is the Settings window, a separate window.
void window.pnr.uiLanguage().then(async ({ resolved }) => {
  await initI18n(resolved);
  window.pnr.onUiLanguage((lang) => void changeLanguage(lang as UiLanguage));
  const view = location.hash.slice(1);
  if (view.startsWith('settings')) document.documentElement.classList.add('settings-window');
  createRoot(document.getElementById('root')!).render(<StrictMode>
    {view.startsWith('settings') ? <SettingsWindow initial={view.split(':')[1]} /> : <App />}
  </StrictMode>);
});
