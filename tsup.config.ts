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
    external: ['better-sqlite3', 'sqlite-vec'],
    onSuccess: async () => {
      // Add shebang to CLI entry after build
      const fs = await import('node:fs');
      const path = './dist/bin/nous.js';
      const content = fs.readFileSync(path, 'utf-8');
      if (!content.startsWith('#!')) {
        fs.writeFileSync(path, '#!/usr/bin/env node\n' + content);
      }
    },
  },
]);
