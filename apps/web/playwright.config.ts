import { defineConfig, devices } from '@playwright/test';

// Declared locally: this file sits outside every tsconfig `include`, because
// `eslint.config.js` routes `apps/*/*.config.ts` through typescript-eslint's
// `allowDefaultProject` and a file may not be in both. Without the declaration
// `process` has no type here at all.
declare const process: { readonly env: Record<string, string | undefined> };

const PORT = 4173;
const isCi = process.env.CI !== undefined;

/**
 * End-to-end configuration.
 *
 * The dev server runs with `VITE_RV_TRANSPORT=fixture`, so the suite exercises the real
 * application against recorded payloads and never needs `apps/api` to be up. That is
 * the same transport the component tests use, which means an e2e failure is a failure
 * in the browser - routing, direction, persistence - and not a difference in the data.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 2 : 0,
  reporter: isCi ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite --port ${String(PORT)} --strictPort`,
    url: `http://127.0.0.1:${String(PORT)}`,
    reuseExistingServer: !isCi,
    timeout: 120_000,
    env: { VITE_RV_TRANSPORT: 'fixture' },
  },
});
