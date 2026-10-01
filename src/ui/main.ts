import 'purr/fonts.css';
import 'purr/styles.css';
import 'purr/shell.css';
import './app.css';
import { applyTheme } from 'purr';
import { mount } from 'svelte';
import App from './App.svelte';

applyTheme({ mode: 'system' });
mount(App, { target: document.getElementById('app')! });
