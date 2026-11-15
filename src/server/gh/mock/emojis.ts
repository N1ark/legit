// A few of GitHub's emoji, as GET /emojis lists them.

import { onRest } from './registry.ts';

const u = (hex: string) => `https://github.githubassets.com/images/icons/emoji/unicode/${hex}.png?v8`;

onRest('GET /emojis', () => ({
  '+1': u('1f44d'),
  thumbsup: u('1f44d'),
  '-1': u('1f44e'),
  tada: u('1f389'),
  rocket: u('1f680'),
  eyes: u('1f440'),
  heart: u('2764'),
  smile: u('1f604'),
  us: u('1f1fa-1f1f8'),
  octocat: 'https://github.githubassets.com/images/icons/emoji/octocat.png?v8',
}));
