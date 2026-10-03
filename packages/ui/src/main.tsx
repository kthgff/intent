import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { bootstrapAuth } from './api';
import './styles.css';

async function main() {
  // API.md auth bootstrap: `?token=` → session cookie + stored bearer.
  await bootstrapAuth();
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
