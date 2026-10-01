// Which files of a commit are generated, so the UI collapses them by default:
// built-in patterns, `linguist-generated` in .gitattributes (as of that commit), and
// the user's own patterns (from the settings).

import { matchesGlob } from 'node:path';
import type { Git } from './git.ts';

/** Patterns without a slash match the file name at any depth. */
export const DEFAULT_HIDDEN = [
  // Lockfiles
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'deno.lock',
  'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'pdm.lock', 'composer.lock', 'Gemfile.lock',
  'go.sum', 'go.work.sum', 'flake.lock', 'mix.lock', 'pubspec.lock', 'Podfile.lock', 'Package.resolved',
  'packages.lock.json', 'gradle.lockfile', '*.opam.locked',
  // Minified bundles and source maps
  '*.min.js', '*.min.mjs', '*.min.css', '*.js.map', '*.css.map',
  // Snapshots and generated code
  '**/__snapshots__/**', '*.snap', '*.pb.go', '*_pb2.py', '*_pb2_grpc.py', '*.pb.h', '*.pb.cc', '*.g.dart',
  '*.freezed.dart', '*.generated.*',
  // Yarn PnP
  '.pnp.cjs', '.pnp.loader.mjs', '.yarn/releases/**', '.yarn/plugins/**',
];

/** A pattern as a glob over repo paths: without a slash it matches the file name at any depth. */
export const normalize = (p: string) => (p.includes('/') ? p.replace(/^\//, '') : `**/${p}`);

/** `sha`: the commit whose .gitattributes apply; null for the working tree. `extra`: the user's patterns. */
export async function generatedPaths(git: Git, sha: string | null, paths: string[], extra: string[] = []): Promise<Set<string>> {
  const out = new Set<string>();
  if (!paths.length) return out;
  const [attrs] = await Promise.all([
    git.run(['check-attr', '-z', '--stdin', ...(sha ? [`--source=${sha}`] : []), 'linguist-generated'], {
      input: Buffer.from(paths.map((p) => p + '\0').join(''), 'latin1'),
      allowFail: true,
    }),
  ]);
  const patterns = [...DEFAULT_HIDDEN, ...extra].map(normalize);
  for (const p of paths) {
    const name = Buffer.from(p, 'latin1').toString('utf8');
    if (patterns.some((g) => matchesGlob(name, g))) out.add(p);
  }
  // check-attr -z output: path\0attribute\0value\0 ...
  if (attrs.code === 0) {
    const f = attrs.out.toString('latin1').split('\0');
    for (let k = 0; k + 2 < f.length; k += 3) {
      if (f[k + 2] === 'set' || f[k + 2] === 'true') out.add(f[k]);
      else if (f[k + 2] === 'unset' || f[k + 2] === 'false') out.delete(f[k]);
    }
  }
  return out;
}
