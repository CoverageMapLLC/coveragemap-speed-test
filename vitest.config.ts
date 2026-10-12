import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    // Real browser tests run with npm run test:browser.
    exclude: [...configDefaults.exclude, 'test/browser/**'],
    // Generates the embedded browser stage worker the library imports.
    globalSetup: ['./test/global-setup.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
});
