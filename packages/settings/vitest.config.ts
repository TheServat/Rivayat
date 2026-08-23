import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'settings',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
