import { fileURLToPath, URL } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * Component tests run in jsdom against the real schemas.
 *
 * `node:crypto` is deliberately *not* aliased here, unlike in `vite.config.ts`: these
 * tests run on Node, where the real module exists, so a test exercises the same
 * `@rv/contracts` code the API does rather than a stub of it.
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      { find: /^@rv\/contracts$/, replacement: here('../../packages/contracts/src/index.ts') },
      {
        find: /^@rv\/shared-kernel$/,
        replacement: here('../../packages/shared-kernel/src/index.ts'),
      },
    ],
  },
  // The source root, as a real filesystem path. A handful of specs scan the source
  // itself - "no physical `left` in any stylesheet", "every `t()` key exists" - and
  // under the jsdom environment `import.meta.url` is an http URL, not a file one.
  // Injecting the path at transform time keeps those specs independent of both the
  // environment and the working directory `vitest` was started from.
  define: { __RV_SRC__: JSON.stringify(here('./src')) },
  test: {
    name: 'web',
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.spec.ts'],
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
