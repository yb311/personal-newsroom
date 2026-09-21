import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { initI18n } from './i18n.ts';
import './styles/tokens.css';
import './styles/app.css';

// The language is known before the first paint, so nothing flashes in the
// wrong language.
void window.pnr.uiLanguage().then(async ({ resolved }) => {
  await initI18n(resolved);
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
});
