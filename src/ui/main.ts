import 'purr/fonts.css';
import 'purr/styles.css';
import 'purr/shell.css';
import './app.css';
import { applyTheme, isTyping } from 'purr';
import { mount } from 'svelte';
import App from './App.svelte';
import './lib/logs.ts';

applyTheme({ mode: 'system' });
mount(App, { target: document.getElementById('app')! });

// WebKit goes back a page on a ⌫ nothing else takes (outside a field you can type in): in the app, that's
// the repository shown before.
window.addEventListener('keydown', (e) => {
  const t = e.target;
  const field = (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && isTyping(t) && !t.readOnly && !t.disabled;
  if (e.key === 'Backspace' && !field && !(t instanceof HTMLElement && t.isContentEditable)) e.preventDefault();
});
