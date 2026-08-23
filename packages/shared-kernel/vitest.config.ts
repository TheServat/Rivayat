import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'shared-kernel',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
