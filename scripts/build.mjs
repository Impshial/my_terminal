import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
await build({
  entryPoints: ['src/main/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/main/index.cjs',
  external: ['electron', 'node-pty', 'ssh2'],
});
await build({
  entryPoints: ['src/preload/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/preload/index.cjs',
  external: ['electron'],
});
await viteBuild();
