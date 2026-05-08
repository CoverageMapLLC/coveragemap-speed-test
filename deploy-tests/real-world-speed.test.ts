import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getCoverageMapApiBaseUrl,
  getSpeedApiBaseUrl,
  type ApiBaseUrlOverrides,
} from '../src/api/config.js';
import type { SpeedTestServer } from '../src/index.js';
import { SpeedTestEngine, type SpeedTestEngineApplicationInfo } from '../src/index.js';
import { deployValidationApiOverrides } from './api-overrides.js';

const branchName = process.env.GITHUB_REF_NAME ?? 'local';
const deployTimeoutMs = parsePositiveInt('COVERAGEMAP_REALWORLD_TIMEOUT_MS', 240000);

function readOptionalTrimmedEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const speedApiBaseUrlFromEnv = readOptionalTrimmedEnv('COVERAGEMAP_SPEED_API_BASE_URL');
const coverageMapApiBaseUrlFromEnv = readOptionalTrimmedEnv('COVERAGEMAP_API_BASE_URL');

/** Merges `deploy-tests/api-overrides.ts` with optional CI env vars (env wins per field). */
const deployResolvedApiOverrides: ApiBaseUrlOverrides = {
  ...deployValidationApiOverrides,
  ...(speedApiBaseUrlFromEnv ? { speedApiBaseUrl: speedApiBaseUrlFromEnv } : {}),
  ...(coverageMapApiBaseUrlFromEnv ? { coverageMapApiBaseUrl: coverageMapApiBaseUrlFromEnv } : {}),
};

const realWorldConfig = {
  pingCount: parsePositiveInt('COVERAGEMAP_PING_COUNT', 6),
  downloadDurationMs: parsePositiveInt('COVERAGEMAP_DOWNLOAD_DURATION_MS', 4000),
  uploadDurationMs: parsePositiveInt('COVERAGEMAP_UPLOAD_DURATION_MS', 4000),
  snapshotIntervalMs: parsePositiveInt('COVERAGEMAP_SNAPSHOT_INTERVAL_MS', 250),
  latencyTimeoutMs: parsePositiveInt('COVERAGEMAP_LATENCY_TIMEOUT_MS', 15000),
  estimationTimeoutMs: parsePositiveInt('COVERAGEMAP_ESTIMATION_TIMEOUT_MS', 20000),
};

const testSummary: Array<Record<string, unknown>> = [];

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function buildApplicationInfo(
  scenario: string,
  type: SpeedTestEngineApplicationInfo['type']
): SpeedTestEngineApplicationInfo {
  return {
    id: 'a0000000-0000-4000-8000-00000000d3pl',
    name: 'CoverageMap Deploy Validation',
    version: process.env.COVERAGEMAP_VALIDATION_VERSION?.trim() || '1.0.0',
    organization: 'CoverageMap',
    type,
    website: `https://coveragemap.com/validation/${branchName}/${scenario}`,
  };
}

async function ensureWebSocketRuntime(): Promise<void> {
  const globalWithWebSocket = globalThis as typeof globalThis & {
    WebSocket?: typeof WebSocket;
  };
  if (globalWithWebSocket.WebSocket) return;

  const ws = await import('ws');
  globalWithWebSocket.WebSocket = ws.WebSocket as unknown as typeof WebSocket;
}

function createEngine(
  scenario: string,
  type: SpeedTestEngineApplicationInfo['type'],
  options?: {
    tests?: ConstructorParameters<typeof SpeedTestEngine>[0]['tests'];
  }
): SpeedTestEngine {
  return new SpeedTestEngine({
    application: buildApplicationInfo(scenario, type),
    config: realWorldConfig,
    tests: options?.tests,
    api: deployResolvedApiOverrides,
  });
}

async function pickLiveServer(engine: SpeedTestEngine): Promise<SpeedTestServer> {
  const connection = await engine.getConnectionInfo();
  const servers = await engine.getServers();
  expect(servers.length).toBeGreaterThan(0);
  expect(servers[0]?.domain).toBeTruthy();
  expect(servers[0]?.port).not.toBeNull();

  testSummary.push({
    scenario: 'discovery',
    branch: branchName,
    serverCount: servers.length,
    topServerDomain: servers[0]?.domain ?? null,
    hasConnectionMetadata: Boolean(connection?.client?.ip),
  });

  return servers[0]!;
}

describe.sequential('post-deploy real-world validation', () => {
  beforeAll(async () => {
    await ensureWebSocketRuntime();
  });

  it(
    'discovers live server inventory and runs full speed test',
    async () => {
      const scenario = 'default-upload';
      const engine = createEngine(scenario, 'backend');
      const targetServer = await pickLiveServer(engine);

      const startedAt = Date.now();
      const result = await engine.run(targetServer);
      const elapsedMs = Date.now() - startedAt;

      expect(result.results.testStatus).toBe('passed');
      expect((result.results.measurements.downloadSpeed ?? 0)).toBeGreaterThan(0);
      expect((result.results.measurements.uploadSpeed ?? 0)).toBeGreaterThan(0);
      expect((result.results.measurements.latency ?? 0)).toBeGreaterThan(0);
      expect(result.device.application.type).toBe('backend');
      expect(result.device.application.organization).toBe('CoverageMap');

      testSummary.push({
        scenario,
        elapsedMs,
        downloadMbps: result.results.measurements.downloadSpeed,
        uploadMbps: result.results.measurements.uploadSpeed,
        latencyMs: result.results.measurements.latency,
        status: result.results.testStatus,
      });
    },
    deployTimeoutMs
  );

  it(
    'runs latency-only deploy validation',
    async () => {
      const scenario = 'latency-only';
      const engine = createEngine(scenario, 'backend', {
        tests: {
          latency: true,
          download: false,
          upload: false,
        },
      });
      const targetServer = await pickLiveServer(engine);

      const result = await engine.run(targetServer);
      expect(result.results.testStatus).toBe('passed');
      expect((result.results.measurements.latency ?? 0)).toBeGreaterThan(0);
      expect(result.results.measurements.downloadSpeed).toBeNull();
      expect(result.results.measurements.uploadSpeed).toBeNull();

      testSummary.push({
        scenario,
        latencyMs: result.results.measurements.latency,
        status: result.results.testStatus,
      });
    },
    deployTimeoutMs
  );

  it(
    'runs upload-only deploy validation',
    async () => {
      const scenario = 'upload-only';
      const engine = createEngine(scenario, 'backend', {
        tests: {
          latency: false,
          download: false,
          upload: true,
        },
      });
      const targetServer = await pickLiveServer(engine);
      const result = await engine.run(targetServer);

      expect(result.results.testStatus).toBe('passed');
      expect(result.results.measurements.downloadSpeed).toBeNull();
      expect((result.results.measurements.uploadSpeed ?? 0)).toBeGreaterThan(0);
      expect(result.results.measurements.latency).toBeNull();

      testSummary.push({
        scenario,
        uploadMbps: result.results.measurements.uploadSpeed,
        status: result.results.testStatus,
      });
    },
    deployTimeoutMs
  );
});

afterAll(async () => {
  const outputDir = join(process.cwd(), 'deploy-artifacts');
  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, `real-world-speed-results-${branchName}.json`);
  const payload = {
    generatedAt: new Date().toISOString(),
    branch: branchName,
    config: realWorldConfig,
    api: {
      speedApiBaseUrl: getSpeedApiBaseUrl(deployResolvedApiOverrides),
      coverageMapApiBaseUrl: getCoverageMapApiBaseUrl(deployResolvedApiOverrides),
    },
    summary: testSummary,
  };
  await writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf-8');
});
