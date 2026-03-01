import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    exclude: ['src/ui/**', 'src/extension.ts'],
    testTimeout: 10_000,
  },
});
