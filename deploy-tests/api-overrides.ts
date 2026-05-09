import type { ApiBaseUrlOverrides } from '../src/api/config.js';

/**
 * Base URL overrides for deploy validation (`npm run test:deploy`).
 * Leave properties unset to use the library’s default production hosts.
 * In GitHub Actions deploy validation, repository/environment secrets with those names set these env vars and override per field when set.
 */
export const deployValidationApiOverrides: ApiBaseUrlOverrides = {};
