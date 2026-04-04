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
      const fs = await import('node:fs');
      // Add shebang to CLI entry
      const cliPath = './dist/bin/nous.js';
      const content = fs.readFileSync(cliPath, 'utf-8');
      if (!content.startsWith('#!')) {
        fs.writeFileSync(cliPath, '#!/usr/bin/env node\n' + content);
      }
      // Copy viz HTML to dist
      fs.mkdirSync('./dist/src/viz', { recursive: true });
      fs.copyFileSync('./src/viz/index.html', './dist/src/viz/index.html');
    },
  },
]);
