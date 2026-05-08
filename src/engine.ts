import type { SpeedTestServer } from './types/speed-server.js';
import type { ConnectionInfo } from './types/connection-info.js';
import type {
  ApplicationType,
  NetworkTestResultApplicationInfo,
  NetworkTestResultTestResults,
  NetworkTestResultResults,
  NetworkTestResultLocation,
  NetworkTestResultWiFiInfo,
  NetworkTestResultWiredInfo,
  NetworkTestResultStage,
} from './types/test-results.js';
import type {
  SpeedTestStage,
  SpeedTestConfig,
  SpeedTestCallbacks,
  SpeedTestSelection,
  LatencyTestData,
  SpeedEstimationResult,
  SpeedTestData,
} from './types/speed-test.js';
import type {
  SpeedTestLocationProvider,
} from './types/location-provider.js';
import {
  DEFAULT_CONFIG,
  getDownloadMessageSizeKb,
  getDownloadConnectionCount,
  getUploadMessageSizeKb,
  getUploadConnectionCount,
} from './types/speed-test.js';
import { getServerWsUrl } from './types/speed-server.js';
import { CancellationToken, CancellationError } from './utils/cancellation.js';
import {
  DOCUMENTED_DEMO_APPLICATION_UUID,
  generateUUID,
  isCanonicalUuidString,
} from './utils/uuid.js';
import {
  buildDeviceResult,
  configureDeviceInfo,
  getConnectionType,
  type DeviceInfoConfigOverrides,
} from './utils/device-info.js';
import { resolveSpeedTestLocation } from './utils/location-provider.js';
import { runLatencyTest } from './tests/latency-test.js';
import { runDownloadEstimationTest } from './tests/download-estimation-test.js';
import { runUploadEstimationTest } from './tests/upload-estimation-test.js';
import { runDownloadSpeedTest } from './tests/download-speed-test.js';
import { runUploadSpeedTest } from './tests/upload-speed-test.js';
import type { ApiBaseUrlOverrides } from './api/config.js';
import { SpeedTestApiClient } from './api/speed-api.js';
import { CoverageMapApiClient } from './api/coveragemap-api.js';

const DEFAULT_RESULTS_QUEUE_KEY = 'coveragemap-test-results-queue';

export interface SpeedTestEngineApplicationInfo {
  id: string;
  name: string;
  version: string;
  organization: string;
  type: ApplicationType | (string & {});
  website?: string | null;
}

export interface SpeedTestEngineOptions {
  application: SpeedTestEngineApplicationInfo;
  config?: Partial<SpeedTestConfig>;
  tests?: SpeedTestSelection;
  callbacks?: SpeedTestCallbacks;
  api?: ApiBaseUrlOverrides;
  deviceInfo?: DeviceInfoConfigOverrides;
  locationProvider?: SpeedTestLocationProvider | null;
}

export class SpeedTestEngine {
  private config: SpeedTestConfig;
  private tests: Required<SpeedTestSelection>;
  private callbacks: SpeedTestCallbacks;
  private speedApi: SpeedTestApiClient;
  private coverageMapApi: CoverageMapApiClient;
  private queueStorageKey: string;
  private cancellationToken: CancellationToken | null = null;
  private _stage: SpeedTestStage = 'idle';
  private _isRunning = false;
  private sessionId: string;
  private locationProvider: SpeedTestLocationProvider | null;

  constructor(options: SpeedTestEngineOptions) {
    const application = normalizeAndValidateApplicationInfo(options.application);
    this.config = normalizeAndValidateConfig(options.config);
    this.tests = normalizeAndValidateTestSelection(options.tests);
    this.callbacks = options.callbacks ?? {};
    this.speedApi = new SpeedTestApiClient(options.api, options.locationProvider ?? null);
    this.coverageMapApi = new CoverageMapApiClient(options.api);
    this.queueStorageKey = DEFAULT_RESULTS_QUEUE_KEY;
    this.sessionId = generateUUID();
    this.locationProvider = options.locationProvider ?? null;
    configureDeviceInfo({
      ...options.deviceInfo,
      application,
    });
  }

  get stage(): SpeedTestStage {
    return this._stage;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  updateCallbacks(callbacks: Partial<SpeedTestCallbacks>): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  setLocationProvider(provider: SpeedTestLocationProvider | null): void {
    this.locationProvider = provider;
    this.speedApi.setLocationProvider(provider);
  }

  async getServers(): Promise<SpeedTestServer[]> {
    return this.speedApi.getServers();
  }

  async refreshServers(): Promise<SpeedTestServer[]> {
    return this.speedApi.refreshServers();
  }

  async getServer(id: string): Promise<SpeedTestServer | null> {
    return this.speedApi.getServer(id);
  }

  async getConnectionInfo(): Promise<ConnectionInfo | null> {
    return this.speedApi.getConnectionInfo();
  }

  cancel(): void {
    this.cancellationToken?.cancel();
  }

  async retryQueuedUploads(): Promise<void> {
    await this.flushUploadQueue();
  }

  async run(server?: SpeedTestServer | string): Promise<NetworkTestResultTestResults> {
    if (this._isRunning) {
      throw new Error('Speed test is already running');
    }

    this._isRunning = true;
    this.cancellationToken = new CancellationToken();
    this.flushUploadQueue();
    const testId = generateUUID();
    const startTime = new Date();
    let targetServer: SpeedTestServer | null = typeof server === 'object' ? server : null;
    const stages: NetworkTestResultStage[] = [];

    let latencyData: LatencyTestData | null = null;
    let downloadEstimation: SpeedEstimationResult | null = null;
    let uploadEstimation: SpeedEstimationResult | null = null;
    let downloadResult: SpeedTestData | null = null;
    let uploadResult: SpeedTestData | null = null;
    let downloadConnectionCount = 0;
    let downloadMessageSizeKb = 0;
    let uploadConnectionCount = 0;
    let uploadMessageSizeKb = 0;
    let failedReason: string | null = null;
    let failedStage: string | null = null;

    let connectionInfo: ConnectionInfo | null = null;
    let location: NetworkTestResultLocation | null = null;

    try {
      connectionInfo = await this.getConnectionInfo();
      location = await this.acquireLocation(connectionInfo);
      if (typeof server === 'string') {
        targetServer = await this.resolveServerById(server);
      } else if (!targetServer) {
        targetServer = await this.selectBestServer();
      }
      const serverUrl = getServerWsUrl(targetServer);

      const buildStage = (testStage: string): NetworkTestResultStage => ({
        testStage,
        dateTime: new Date().toISOString(),
        connectionType: getConnectionType(),
        localIpAddress: null,
        externalIpAddress: connectionInfo?.client?.ip ?? null,
        vpnEnabled: false,
        location,
        wifi: this.buildWifiInfo(connectionInfo),
        wired: this.buildWiredInfo(connectionInfo),
      });

      try {
        if (this.tests.latency) {
          this.setStage('latency');
          stages.push(buildStage('latencyStart'));
          latencyData = await runLatencyTest({
            serverUrl,
            pingCount: this.config.pingCount,
            timeoutMs: this.config.latencyTimeoutMs,
            cancellationToken: this.cancellationToken,
            onPing: (latencyMs, index) => this.callbacks.onLatencyPing?.(latencyMs, index),
          });
          this.callbacks.onLatencyResult?.(latencyData);
        } else if (this.tests.download || this.tests.upload) {
          latencyData = await runLatencyTest({
            serverUrl,
            pingCount: 1,
            cancellationToken: this.cancellationToken,
          });
        }

        const latencyMs = latencyData?.minLatency ?? 0;
        const jitterMs = latencyData?.minJitter ?? 0;

        if (this.tests.download) {
          this.setStage('downloadEstimation');
          stages.push(buildStage('downloadStart'));
          downloadEstimation = await runDownloadEstimationTest({
            serverUrl,
            latencyMs,
            jitterMs,
            timeoutMs: this.config.estimationTimeoutMs,
            cancellationToken: this.cancellationToken,
          });
          this.setStage('download');
          downloadMessageSizeKb = getDownloadMessageSizeKb(downloadEstimation.speedMbps);
          downloadConnectionCount = getDownloadConnectionCount(downloadEstimation.speedMbps);
          downloadResult = await runDownloadSpeedTest({
            serverUrl,
            messageSizeKb: downloadMessageSizeKb,
            connectionCount: downloadConnectionCount,
            durationMs: this.config.downloadDurationMs,
            latencyMs,
            jitterMs,
            snapshotIntervalMs: this.config.snapshotIntervalMs,
            cancellationToken: this.cancellationToken,
            onSnapshot: (snapshot) => this.callbacks.onDownloadProgress?.(snapshot),
          });
          this.callbacks.onDownloadResult?.(downloadResult);
          stages.push(buildStage('downloadEnd'));
        }

        if (this.tests.upload) {
          if (this.tests.download) {
            await this.delay(500);
          }

          this.setStage('uploadEstimation');
          stages.push(buildStage('uploadStart'));
          uploadEstimation = await runUploadEstimationTest({
            serverUrl,
            latencyMs,
            jitterMs,
            timeoutMs: this.config.estimationTimeoutMs,
            cancellationToken: this.cancellationToken,
          });
          this.setStage('upload');
          uploadMessageSizeKb = getUploadMessageSizeKb(uploadEstimation.speedMbps);
          uploadConnectionCount = getUploadConnectionCount(uploadEstimation.speedMbps);
          uploadResult = await runUploadSpeedTest({
            serverUrl,
            messageSizeKb: uploadMessageSizeKb,
            connectionCount: uploadConnectionCount,
            durationMs: this.config.uploadDurationMs,
            latencyMs,
            jitterMs,
            snapshotIntervalMs: this.config.snapshotIntervalMs,
            cancellationToken: this.cancellationToken,
            onSnapshot: (snapshot) => this.callbacks.onUploadProgress?.(snapshot),
          });
          this.callbacks.onUploadResult?.(uploadResult);
          stages.push(buildStage('uploadEnd'));
        }
      } catch (error) {
        if (error instanceof CancellationError) {
          failedReason = 'Cancelled';
          failedStage = this._stage;
        } else {
          failedReason = error instanceof Error ? error.message : String(error);
          failedStage = this.mapStageToTestStage(this._stage);
          this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)), this._stage);
        }
      }

      const testResults = this.assembleResults({
        testId,
        startTime,
        server: targetServer,
        connectionInfo,
        location,
        latencyData,
        downloadEstimation,
        downloadResult,
        uploadEstimation,
        uploadResult,
        downloadConnectionCount,
        downloadMessageSizeKb,
        uploadConnectionCount,
        uploadMessageSizeKb,
        stages,
        failedReason,
        failedStage,
      });

      this.setStage('complete');
      this.callbacks.onComplete?.(
        downloadResult?.speedMbps ?? 0,
        uploadResult?.speedMbps ?? 0,
        latencyData?.minLatency ?? 0
      );

      this.uploadResults(testResults);
      return testResults;
    } finally {
      this._isRunning = false;
      this.cancellationToken = null;
    }
  }

  private async resolveServerById(id: string): Promise<SpeedTestServer> {
    const servers = await this.getServers();
    const found = servers.find((s) => s.id === id);
    if (!found) {
      throw new Error(`Speed server with id "${id}" not found`);
    }
    return found;
  }

  private async selectBestServer(): Promise<SpeedTestServer> {
    const servers = await this.getServers();
    if (servers.length === 0) {
      throw new Error('No speed servers available');
    }
    return servers[0];
  }

  private setStage(stage: SpeedTestStage): void {
    this._stage = stage;
    this.callbacks.onStageChange?.(stage);
  }

  private async delay(ms: number): Promise<void> {
    if (this.cancellationToken?.isCancelled) return;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      this.cancellationToken?.onCancel(() => {
        clearTimeout(timer);
        reject(new CancellationError());
      });
    });
  }

  private async acquireLocation(
    connectionInfo: ConnectionInfo | null
  ): Promise<NetworkTestResultLocation | null> {
    const resolved = await resolveSpeedTestLocation(this.locationProvider, { connectionInfo });
    if (!resolved.location) {
      return null;
    }

    return {
      latitude: resolved.location.latitude,
      longitude: resolved.location.longitude,
      elevation: resolved.location.elevation ?? null,
      heading: resolved.location.heading ?? null,
      speed: resolved.location.speed ?? null,
      locationType: resolved.source === 'provider' ? 'device' : 'ip',
    };
  }

  private buildWifiInfo(connectionInfo: ConnectionInfo | null): NetworkTestResultWiFiInfo | null {
    const connType = getConnectionType();
    if (connType !== 'wifi') return null;
    return {
      ispName: connectionInfo?.client?.asOrg ?? null,
    };
  }

  private buildWiredInfo(connectionInfo: ConnectionInfo | null): NetworkTestResultWiredInfo | null {
    const connType = getConnectionType();
    if (connType === 'wifi') return null;
    return {
      ispName: connectionInfo?.client?.asOrg ?? null,
    };
  }

  private mapStageToTestStage(stage: SpeedTestStage): string | null {
    switch (stage) {
      case 'latency':
        return 'latencyStart';
      case 'downloadEstimation':
      case 'download':
        return 'downloadStart';
      case 'uploadEstimation':
      case 'upload':
        return 'uploadStart';
      default:
        return null;
    }
  }

  private assembleResults(params: {
    testId: string;
    startTime: Date;
    server: SpeedTestServer;
    connectionInfo: ConnectionInfo | null;
    location: NetworkTestResultLocation | null;
    latencyData: LatencyTestData | null;
    downloadEstimation: SpeedEstimationResult | null;
    downloadResult: SpeedTestData | null;
    uploadEstimation: SpeedEstimationResult | null;
    uploadResult: SpeedTestData | null;
    downloadConnectionCount: number;
    downloadMessageSizeKb: number;
    uploadConnectionCount: number;
    uploadMessageSizeKb: number;
    stages: NetworkTestResultStage[];
    failedReason: string | null;
    failedStage: string | null;
  }): NetworkTestResultTestResults {
    const device = buildDeviceResult();
    const connType = getConnectionType();

    const results: NetworkTestResultResults = {
      dateTime: new Date().toISOString(),
      connectionType: connType,
      localIpAddress: null,
      externalIpAddress: params.connectionInfo?.client?.ip ?? null,
      vpnEnabled: false,
      testStatus: params.failedStage ? 'failed' : 'passed',
      location: params.location,
      server: params.server,
      wifi: this.buildWifiInfo(params.connectionInfo),
      wired: this.buildWiredInfo(params.connectionInfo),
      measurements: {
        dateTime: params.startTime.toISOString(),
        downloadSpeed: params.downloadResult?.speedMbps ?? null,
        totalDownload: params.downloadResult?.bytes ?? null,
        uploadSpeed: params.uploadResult?.speedMbps ?? null,
        totalUpload: params.uploadResult?.bytes ?? null,
        latency: params.latencyData?.minLatency ?? null,
        jitter: params.latencyData?.minJitter ?? null,
        latenciesList: params.latencyData?.latencies ?? null,
        downloadList:
          params.downloadResult?.snapshots.map((snapshot) => ({
            time: Math.round(snapshot.timeOffsetMs),
            speed: snapshot.speedMbps,
            data: snapshot.bytes,
          })) ?? null,
        uploadList:
          params.uploadResult?.snapshots.map((snapshot) => ({
            time: Math.round(snapshot.timeOffsetMs),
            speed: snapshot.speedMbps,
            data: snapshot.bytes,
          })) ?? null,
        failedReason: params.failedReason,
        failedStage: params.failedStage as NetworkTestResultResults['measurements']['failedStage'],
      },
    };

    return {
      version: 1,
      device,
      testType: {
        id: params.testId,
        sessionId: this.sessionId,
        type: 'single',
        testIndex: 0,
        testCount: 1,
        tag: 'other',
        downloadTestDuration: this.config.downloadDurationMs,
        uploadTestDuration: this.config.uploadDurationMs,
        testProtocol: 'WSS',
        downloadConnectionCount: params.downloadConnectionCount,
        uploadConnectionCount: params.uploadConnectionCount,
        downloadPacketSize: params.downloadMessageSizeKb,
        uploadPacketSize: params.uploadMessageSizeKb,
      },
      results,
      stages: params.stages,
    };
  }

  private async uploadBatch(results: NetworkTestResultTestResults[]): Promise<void> {
    await this.coverageMapApi.uploadSpeedTestResults(results);
  }

  private async uploadResults(results: NetworkTestResultTestResults): Promise<void> {
    try {
      await this.uploadBatch([results]);
    } catch {
      this.saveToLocalQueue(results);
    }
  }

  private saveToLocalQueue(results: NetworkTestResultTestResults): void {
    try {
      const existing = localStorage.getItem(this.queueStorageKey);
      const queue: NetworkTestResultTestResults[] = existing ? JSON.parse(existing) : [];
      queue.push(results);
      localStorage.setItem(this.queueStorageKey, JSON.stringify(queue));
    } catch {
      // localStorage may be unavailable
    }
  }

  private async flushUploadQueue(): Promise<void> {
    try {
      const existing = localStorage.getItem(this.queueStorageKey);
      if (!existing) return;

      const queue: NetworkTestResultTestResults[] = JSON.parse(existing);
      if (queue.length === 0) return;

      await this.uploadBatch(queue);
      localStorage.removeItem(this.queueStorageKey);
    } catch {
      // Will retry on the next run
    }
  }
}

function normalizeAndValidateApplicationInfo(
  application: SpeedTestEngineApplicationInfo
): NetworkTestResultApplicationInfo {
  const requiredStringFields: Array<keyof SpeedTestEngineApplicationInfo> = [
    'id',
    'name',
    'version',
    'organization',
    'type',
  ];

  for (const field of requiredStringFields) {
    const value = application[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(
        `SpeedTestEngineOptions.application.${field} is required and must be a non-empty string`
      );
    }
  }

  const id = application.id.trim().toLowerCase();
  if (!isCanonicalUuidString(id)) {
    throw new Error(
      'SpeedTestEngineOptions.application.id must be a UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx, hexadecimal)'
    );
  }
  if (id === DOCUMENTED_DEMO_APPLICATION_UUID) {
    throw new Error(
      'SpeedTestEngineOptions.application.id must be your own static UUID for this integration, not the documentation example. Generate one and hard-code it in your app.'
    );
  }

  return {
    id,
    name: application.name.trim(),
    version: application.version.trim(),
    organization: application.organization.trim(),
    type: application.type.trim(),
    website: application.website ?? null,
  };
}

function normalizeAndValidateConfig(overrides?: Partial<SpeedTestConfig>): SpeedTestConfig {
  const config = { ...DEFAULT_CONFIG, ...overrides };

  const rules: Array<[keyof SpeedTestConfig, number, number]> = [
    ['pingCount', 5, 50],
    ['downloadDurationMs', 3000, 30000],
    ['uploadDurationMs', 3000, 30000],
    ['snapshotIntervalMs', 50, 5000],
    ['latencyTimeoutMs', 3000, 30000],
    ['estimationTimeoutMs', 3000, 30000],
  ];

  for (const [field, min, max] of rules) {
    const value = config[field];
    if (value < min || value > max) {
      throw new Error(
        `SpeedTestEngineOptions.config.${field} must be between ${min} and ${max}`
      );
    }
  }

  return config;
}

function normalizeAndValidateTestSelection(
  selection?: SpeedTestSelection
): Required<SpeedTestSelection> {
  const normalized: Required<SpeedTestSelection> = {
    latency: selection?.latency ?? true,
    download: selection?.download ?? true,
    upload: selection?.upload ?? true,
  };

  if (!normalized.latency && !normalized.download && !normalized.upload) {
    throw new Error('SpeedTestEngineOptions.tests must enable at least one test');
  }

  return normalized;
}
