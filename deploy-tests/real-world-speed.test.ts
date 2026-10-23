import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getCoverageMapApiBaseUrl,
  getSpeedApiBaseUrl,
  type ApiBaseUrlOverrides,
} from '../src/api/config.js';
import type { SpeedTestServer, SpeedTestTransport } from '../src/index.js';
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
    id: 'c0ffee00-0000-4000-8000-00000000cafe',
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
    transport?: SpeedTestTransport;
  }
): SpeedTestEngine {
  return new SpeedTestEngine({
    application: buildApplicationInfo(scenario, type),
    config: options?.transport ? { ...realWorldConfig, transport: options.transport } : realWorldConfig,
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

/** Each transport forced through `config.transport`, the protocol a server lists for it, and what results report. */
const TRANSPORTS = [
  { transport: 'tcp', protocol: 'TCPv1', reported: 'TCP' },
  { transport: 'ws', protocol: 'WSv1', reported: 'WS' },
  { transport: 'wss', protocol: 'WSSv1', reported: 'WSS' },
] as const;

/** Servers that report no protocols predate the field and only speak secure WebSocket. */
function listedProtocols(server: SpeedTestServer): readonly string[] {
  return server.protocols && server.protocols.length > 0 ? server.protocols : ['WSSv1'];
}

/** The CDN server and the closest server that is not on the CDN, from the live server list. */
async function pickTargets(engine: SpeedTestEngine): Promise<{ cdn: SpeedTestServer; closest: SpeedTestServer }> {
  const servers = await engine.getServers();
  const cdn = servers.find((server) => server.isCDN === true);
  const closest = servers.find((server) => server.isCDN !== true);
  expect(cdn, 'the server list has a CDN server').toBeDefined();
  expect(closest, 'the server list has a non-CDN server').toBeDefined();
  return { cdn: cdn!, closest: closest! };
}

describe.sequential('post-deploy transport validation', () => {
  let targets: { cdn: SpeedTestServer; closest: SpeedTestServer };

  beforeAll(async () => {
    await ensureWebSocketRuntime();
    targets = await pickTargets(createEngine('transport-discovery', 'backend'));
    testSummary.push({
      scenario: 'transport-discovery',
      cdn: { domain: targets.cdn.domain, protocols: listedProtocols(targets.cdn) },
      closest: { domain: targets.closest.domain, protocols: listedProtocols(targets.closest) },
    });
  }, deployTimeoutMs);

  for (const target of ['cdn', 'closest'] as const) {
    for (const { transport, protocol, reported } of TRANSPORTS) {
      it(
        `tests the ${target === 'cdn' ? 'CDN' : 'closest non-CDN'} server over ${reported}`,
        async () => {
          const server = targets[target];
          const scenario = `${target}-${transport}`;
          const engine = createEngine(scenario, 'backend', { transport });
          const offered = listedProtocols(server).includes(protocol);

          const startedAt = Date.now();
          const result = await engine.run(server);
          const elapsedMs = Date.now() - startedAt;
          const measurements = result.results.measurements;

          testSummary.push({
            scenario,
            server: server.domain,
            offered,
            protocol: result.testType.testProtocol,
            status: result.results.testStatus,
            elapsedMs,
            latencyMs: measurements.latency,
            downloadMbps: measurements.downloadSpeed,
            uploadMbps: measurements.uploadSpeed,
            failedStage: measurements.failedStage,
            failedReason: measurements.failedReason,
          });

          expect(result.testType.testProtocol).toBe(reported);
          if (!offered) {
            // The server does not offer this transport (the CDN only accepts secure WebSocket on
            // port 443): forcing it must fail cleanly at the first connection.
            expect(result.results.testStatus).toBe('failed');
            expect(measurements.failedStage).toBe('latencyStart');
            expect(measurements.downloadSpeed).toBeNull();
            expect(measurements.uploadSpeed).toBeNull();
            return;
          }

          expect(result.results.testStatus, measurements.failedReason ?? undefined).toBe('passed');
          expect(measurements.latency ?? 0).toBeGreaterThan(0);
          expect(measurements.downloadSpeed ?? 0).toBeGreaterThan(0);
          expect(measurements.uploadSpeed ?? 0).toBeGreaterThan(0);
          expect(measurements.downloadList?.length ?? 0).toBeGreaterThan(0);
          expect(measurements.uploadList?.length ?? 0).toBeGreaterThan(0);
        },
        deployTimeoutMs
      );
    }
  }
});

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
      expect((result.results.measurements.latency ?? 0)).toBeGreaterThan(0);

      testSummary.push({
        scenario,
        uploadMbps: result.results.measurements.uploadSpeed,
        latencyMs: result.results.measurements.latency,
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
