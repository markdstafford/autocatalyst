/**
 * Browser entry point: creates the React root and mounts the app.
 *
 * The design-system tokens are imported here so the entry chunk carries the
 * stylesheet. The first-paint theme attributes are already set by the inline
 * script in `index.html` before this module runs, avoiding a light/dark flash.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app.js';
import './styles/index.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root container #root was not found in index.html.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
