// React entry point: mounts <App /> into #root and loads the global stylesheet.
// Change: only if you add a provider that must wrap the whole tree.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@/App';
import "@/styles/globals.css";
// ui-states ships its own stylesheet; ui-bridge.css must follow it to win the palette.
import "@/lib/ui-states/states.css";
import "@/styles/ui-bridge.css";

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root is missing from index.html');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
