import { defineConfig } from 'vitest/config';

const deployTimeoutMs = Number(process.env.COVERAGEMAP_REALWORLD_TIMEOUT_MS ?? 240000);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['deploy-tests/**/*.test.ts'],
    testTimeout: deployTimeoutMs,
    hookTimeout: deployTimeoutMs,
    restoreMocks: true,
    clearMocks: true,
  },
});
