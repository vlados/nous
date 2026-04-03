import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'src/index': 'src/index.ts',
    'bin/nous': 'bin/nous.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  banner: ({ format }) => {
    // Add shebang to CLI entry point
    return { js: '' };
  },
  esbuildOptions(options) {
    options.banner = {
      js: '#!/usr/bin/env node',
    };
  },
});
