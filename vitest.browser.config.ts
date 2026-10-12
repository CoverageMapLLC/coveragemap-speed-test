import { defineConfig } from 'vitest/config';

// Real browser tests (test/browser): npm run test:browser.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/browser/**/*.browser.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 120000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
