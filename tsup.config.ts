import { defineConfig } from 'tsup';

export default defineConfig([
  // Library entry — no shebang
  {
    entry: { 'src/index': 'src/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node18',
    external: ['better-sqlite3', 'sqlite-vec'],
  },
  // CLI entry — with shebang
  {
    entry: { 'bin/nous': 'bin/nous.ts' },
    format: ['esm'],
    sourcemap: true,
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
    external: ['better-sqlite3', 'sqlite-vec'],
  },
]);
