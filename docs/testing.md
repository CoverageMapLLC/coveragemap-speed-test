# Testing Guide

This project uses a layered test strategy that validates:

- pure math/config logic,
- WebSocket protocol behavior,
- engine orchestration and regression scenarios,
- runtime compatibility across browser and backend-like environments.

## Standard validation commands

Run these in order before creating a release or PR:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

## Deploy-time real-world validation

The repository includes a separate deploy validation suite that intentionally runs outside CI unit/regression checks.

- Command: `npm run test:deploy`
- Config: `vitest.deploy.config.ts`
- Test location: `deploy-tests/**/*.test.ts`
- Workflow: `.github/workflows/deploy-real-world-tests.yml`

This suite performs live endpoint discovery and real speed-test execution against production speed infrastructure, and is triggered on pushes to `development` and `main` (plus manual dispatch).

## Test suite map

## Unit-focused tests

### `test/speed-utils.test.ts`

Validates:

- Mbps calculation formula,
- speed/bytes/latency formatting helpers,
- threshold behavior on very small and larger values.

### `test/speed-config.test.ts`

Validates:

- adaptive message-size thresholds,
- adaptive connection-count thresholds,
- CoverageMap API base URL defaults and URL normalization behavior.

### `test/api-clients.test.ts`

Validates:

- speed API URL construction,
- error handling for non-OK responses,
- upload API error propagation for failed responses.

## Protocol tests

Protocol tests use deterministic mock WebSocket implementations.

### `test/protocol-latency.test.ts`

Checks `PING`/`PONG` flow and latency aggregation correctness.

### `test/protocol-download-estimation.test.ts`

Checks adaptive `START <kb> 1` download estimation loop and speed calculation.

### `test/protocol-upload-estimation.test.ts`

Checks ACK-based upload estimation behavior and throughput output.

### `test/protocol-throughput.test.ts`

Checks sustained download/upload stages including snapshot emission and byte accounting.

## Engine regression tests

### `test/engine-regression.test.ts`

Verifies:

- stage order and callback sequence stability,
- payload assembly behavior,
- upload fallback queue behavior,
- retry path behavior,
- selective test execution behavior (`latency`/`download`/`upload`).

## Runtime compatibility tests

### `test/device-info-runtime.test.ts`

Verifies:

- safe operation without browser globals,
- backend runtime metadata generation,
- `deviceInfo.coreSystem` overrides being applied to payloads.

## Regression goals and guarantees

The suite is intended to prevent accidental behavior drift in:

- stage transitions and callback timing,
- failure mapping (`failedReason`, `failedStage`),
- upload queue and retry semantics,
- protocol command/response contracts (`PING`/`PONG`, `START`, `ACK`),
- backend-safe metadata generation.

## Mocking strategy

Key testing techniques used:

- `vi.stubGlobal('WebSocket', ...)` for protocol tests,
- deterministic `performance.now()` in estimation tests,
- module-level mocks in engine tests for stage runner isolation,
- mocked `fetch` for API client tests,
- simulated missing globals for backend runtime tests.

This keeps tests fast and deterministic while covering most production logic paths.

## Runtime assumptions

Browser integrations typically provide:

- `WebSocket`
- `localStorage`
- `navigator`
- `performance`

Backend integrations may omit all browser globals. The library supports this for device/result metadata, but protocol execution still requires a WebSocket implementation.

## Adding new tests (recommended pattern)

When introducing new behavior:

1. Add/extend a focused unit test for pure logic.
2. Add protocol mock tests if WebSocket semantics changed.
3. Add/extend an engine regression test if stage flow or upload behavior changed.
4. Add runtime test coverage when browser/backend handling changes.

## CI behavior

The CI workflow runs lint, typecheck, test, and build. Any failure blocks merge/release.

Real-world deploy validation is intentionally separate from CI and runs in the deploy workflow.
