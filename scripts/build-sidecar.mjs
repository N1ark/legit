// Bundles the server into one file and compiles it with Node's single executable
// application support into src-tauri/binaries/legit-server-<target>, which Tauri ships
// inside the app. The app then doesn't depend on whatever Node is installed.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'rolldown';

const root = join(import.meta.dirname, '..');
const out = join(root, 'build', 'sidecar');
mkdirSync(out, { recursive: true });

await build({
  input: join(root, 'src/server/sidecar.ts'),
  platform: 'node',
  output: { file: join(out, 'main.mjs'), format: 'esm' },
  logLevel: 'warn',
});

const target = /host: (\S+)/.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))[1];
const bin = join(root, 'src-tauri', 'binaries', `legit-server-${target}`);
mkdirSync(join(root, 'src-tauri', 'binaries'), { recursive: true });

const config = join(out, 'sea.json');
writeFileSync(
  config,
  JSON.stringify({
    main: join(out, 'main.mjs'),
    mainFormat: 'module',
    output: bin,
    disableExperimentalSEAWarning: true,
  }),
);
execFileSync(process.execPath, ['--build-sea', config], { stdio: 'inherit' });
// Apple Silicon refuses to run unsigned code; an ad-hoc signature is enough locally.
execFileSync('codesign', ['--sign', '-', '--force', bin], { stdio: 'inherit' });
console.log(`sidecar: ${bin}`);
