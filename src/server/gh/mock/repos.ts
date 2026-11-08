// The signed-in user's repositories, to clone.

import { onRest } from './registry.ts';

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

onRest('GET /user/repos', () => [
  { full_name: 'octo/legit', description: 'A tiny, fast UI to rewrite git history', private: false, fork: false, pushed_at: ago(0.1) },
  { full_name: 'octo/dotfiles', description: null, private: true, fork: false, pushed_at: ago(3) },
  { full_name: 'acme/api', description: 'The Acme API server', private: true, fork: false, pushed_at: ago(9) },
  { full_name: 'octo/svelte', description: 'Cybernetically enhanced web apps', private: false, fork: true, pushed_at: ago(40) },
]);
