import '@fontsource/figtree/400.css';
import '@fontsource/figtree/600.css';
import '@fontsource/figtree/700.css';
import '@fontsource/bricolage-grotesque/700.css';
import '@pasabot/ui/styles.css';
import './app/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.js';
import { I18nProvider } from './app/i18n.js';
import { applyLook } from './app/theme.js';

applyLook();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);

// installable PWA: a tiny service worker (network first; no offline data in W0c)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
