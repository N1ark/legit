// Fake pull requests, for the branches scripts/gh-demo.ts creates in acme/widgets.

import { db, onGraphql } from './registry.ts';

const user = (login: string) => ({ login, avatarUrl: `https://github.com/${login}.png` });

db.viewer = 'octocat';
db.pulls = [
  {
    number: 9, title: 'Fix a typo in the README', state: 'MERGED', isDraft: false, baseRefName: 'main', headRefName: 'fix/typo',
    headRefOid: '0'.repeat(40), author: user('hubot'), body: 'Small typo.',
  },
  {
    number: 12, title: 'Add a parser for widget specs', state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'feature/parser',
    headRefOid: '0'.repeat(40), author: user('octocat'),
    body: 'Parses `.widget` files into specs.\n\n- tokenizer\n- parser\n\nCloses #7',
  },
  {
    number: 13, title: 'Report parse errors with line numbers', state: 'OPEN', isDraft: true, baseRefName: 'feature/parser',
    headRefName: 'feature/parser-errors', headRefOid: '0'.repeat(40), author: user('octocat'), body: 'Stacked on #12.',
  },
  {
    number: 14, title: 'Pretty-print parse errors', state: 'OPEN', isDraft: false, baseRefName: 'feature/parser-errors',
    headRefName: 'feature/pretty-errors', headRefOid: '0'.repeat(40), author: user('octocat'), body: 'Stacked on #13.',
  },
];
db.nextNumber = 20;

/** A fake pull request in GraphQL's shape (the fields of PR_FIELDS, and a few more). */
export const prNode = (p: any) => ({
  ...p,
  headRefOid: db.tips[p.headRefName] ?? p.headRefOid,
  url: `https://github.com/acme/widgets/pull/${p.number}`,
  repository: { nameWithOwner: 'acme/widgets' },
  headRepositoryOwner: p.headRepositoryOwner ?? { login: 'acme' },
});

onGraphql('Viewer', () => ({ viewer: { login: db.viewer } }));
onGraphql('PrForBranch', (v) => ({
  repository: {
    pullRequests: { nodes: db.pulls.filter((p: any) => p.headRefName === v.head).reverse().map(prNode) },
  },
}));
