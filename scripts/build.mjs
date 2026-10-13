import { build } from 'esbuild';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = path.join(root, 'dist');

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: 'linked',
  // koffi is a native addon: bundling it would break the .node lookup next to its JS.
  external: ['electron', 'koffi'],
  logLevel: 'info',
  absWorkingDir: root,
};

await rm(dist, { recursive: true, force: true });
for (const d of ['main', 'preload']) await mkdir(path.join(dist, d), { recursive: true });

// Both bundles are CJS: the preload script is not run through the ESM loader, and a
// CJS main keeps __dirname for locating dist/preload and resources/mpv.
await build({ ...shared, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.cjs', format: 'cjs' });
await build({ ...shared, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.cjs', format: 'cjs' });

if (!existsSync(path.join(dist, 'renderer', 'index.html'))) {
  await writeFile(
    path.join(dist, 'BUILD-NOTE.txt'),
    'renderer bundle is produced by `vite build`; run `npm run build` for the full pipeline.\n',
  );
}
console.log('main + preload bundled ->', path.relative(root, dist));
