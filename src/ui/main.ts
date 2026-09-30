import '@fontsource-variable/inter';
import '@fontsource/fira-code/400.css';
import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';

mount(App, { target: document.getElementById('app')! });
