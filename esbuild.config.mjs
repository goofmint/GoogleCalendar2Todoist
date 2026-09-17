import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const outdir = 'dist';

mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: ['src/main.ts'],
  outfile: `${outdir}/Code.js`,
  bundle: true,
  format: 'iife',
  target: 'es2020',
  globalName: 'G2T',
  footer: {
    js:
      'function sync() { G2T.sync(); }\n' +
      'function setup() { G2T.setup(); }\n' +
      'function cleanupLegacyTodoistCopies() { G2T.cleanupLegacyTodoistCopies(); }',
  },
});

copyFileSync('appsscript.json', `${outdir}/appsscript.json`);
