import type { ApiBaseUrlOverrides } from '../src/api/config.js';

/**
 * Base URL overrides for deploy validation (`npm run test:deploy`).
 * Leave properties unset to use the library’s default production hosts.
 * In CI, `COVERAGEMAP_SPEED_API_BASE_URL` and `COVERAGEMAP_API_BASE_URL` override these per field when set.
 */
export const deployValidationApiOverrides: ApiBaseUrlOverrides = {};
