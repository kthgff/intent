import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import App from './App';
import { bootstrapAuth } from './api';
// React Flow base styles load once, before Veto overrides (S-16).
import '@xyflow/react/dist/style.css';
import './styles.css';
import './demo/demo.css';

async function main() {
  // API.md auth bootstrap: `?token=` → session cookie + stored bearer.
  const demoMode =
    new URLSearchParams(window.location.search).get('demo') === '1' ||
    import.meta.env.VITE_DEMO_MODE === '1';
  if (!demoMode) await bootstrapAuth();
  const el = document.getElementById('root');
  if (!el) throw new Error('missing #root');
  createRoot(el).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
}

void main();
