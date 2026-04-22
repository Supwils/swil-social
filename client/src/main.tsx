import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initClientMonitoring } from './lib/monitoring';
import './styles/global.css';

// Fire-and-forget — no-op unless VITE_SENTRY_DSN is set
void initClientMonitoring();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
