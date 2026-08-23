import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'anim-engine',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
