import { fileURLToPath, URL } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      // The workspace packages are consumed as source. Their `exports` maps expose a
      // `development` condition pointing at `src`, but a production `vite build` would
      // pick `dist` and then fail on a clean checkout; aliasing makes both modes read
      // the same files `tsconfig.base.json` already points `vue-tsc` at.
      { find: /^@rv\/contracts$/, replacement: here('../../packages/contracts/src/index.ts') },
      {
        find: /^@rv\/shared-kernel$/,
        replacement: here('../../packages/shared-kernel/src/index.ts'),
      },
      // See `src/shims/node-crypto.ts` for why a browser bundle ends up importing this
      // at all.
      { find: /^node:crypto$/, replacement: here('./src/shims/node-crypto.ts') },
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
    // The client calls `/api` relatively so the same build works behind any origin.
    // In dev the API is a separate process, so Vite forwards.
    proxy: {
      '/api': {
        target: process.env.RV_API_ORIGIN ?? 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  preview: { port: 4173, strictPort: true },
  build: { sourcemap: true },
});
