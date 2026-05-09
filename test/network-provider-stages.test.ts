import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  latencyMock: vi.fn(),
  downloadEstimationMock: vi.fn(),
  uploadEstimationMock: vi.fn(),
  downloadSpeedMock: vi.fn(),
  uploadSpeedMock: vi.fn(),
  getServerListMock: vi.fn(),
  getConnectionInfoMock: vi.fn(),
  uploadResultsMock: vi.fn(),
}));

const applicationMetadata = {
  id: '9f8e7d6c-5b4a-4321-9fed-cba987654321',
  name: 'Network Provider Stage Tests',
  version: '1.0.0',
  organization: 'CoverageMap',
  type: 'backend',
};

const testServer = {
  id: 'srv-1',
  domain: 'speed.example.com',
  port: 443,
  provider: null,
  city: null,
  region: null,
  country: 'US',
  location: 'US',
  latitude: null,
  longitude: null,
  distance: null,
  isCDN: null,
};

vi.mock('../src/tests/latency-test.js', () => ({ runLatencyTest: mocks.latencyMock }));
vi.mock('../src/tests/download-estimation-test.js', () => ({ runDownloadEstimationTest: mocks.downloadEstimationMock }));
vi.mock('../src/tests/upload-estimation-test.js', () => ({ runUploadEstimationTest: mocks.uploadEstimationMock }));
vi.mock('../src/tests/download-speed-test.js', () => ({ runDownloadSpeedTest: mocks.downloadSpeedMock }));
vi.mock('../src/tests/upload-speed-test.js', () => ({ runUploadSpeedTest: mocks.uploadSpeedMock }));
vi.mock('../src/api/speed-api.js', () => ({
  SpeedTestApiClient: class {
    getServers = mocks.getServerListMock;
    getConnectionInfo = mocks.getConnectionInfoMock;
    setLocationProvider = vi.fn();
  },
}));
vi.mock('../src/api/coveragemap-api.js', () => ({
  CoverageMapApiClient: class {
    uploadSpeedTestResults = mocks.uploadResultsMock;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();

  mocks.getServerListMock.mockResolvedValue([]);
  mocks.getConnectionInfoMock.mockResolvedValue({
    client: { ip: '1.1.1.1', latitude: 40, longitude: -74, asOrg: 'CoverageMap ISP' },
  });
  mocks.latencyMock.mockResolvedValue({
    latencies: [10, 11, 12],
    minLatency: 10,
    averageLatency: 11,
    medianLatency: 11,
    minJitter: 1,
    averageJitter: 1,
    medianJitter: 1,
  });
  mocks.downloadEstimationMock.mockResolvedValue({ durationMs: 120, bytes: 400_000, speedMbps: 26.6 });
  mocks.uploadEstimationMock.mockResolvedValue({ durationMs: 130, bytes: 300_000, speedMbps: 18.4 });
  mocks.downloadSpeedMock.mockResolvedValue({
    durationMs: 2000, bytes: 4_000_000, speedMbps: 120,
    snapshots: [{ timeOffsetMs: 100, speedMbps: 100, bytes: 1_000_000 }],
  });
  mocks.uploadSpeedMock.mockResolvedValue({
    durationMs: 2000, bytes: 2_000_000, speedMbps: 60,
    snapshots: [{ timeOffsetMs: 100, speedMbps: 50, bytes: 500_000 }],
  });
  mocks.uploadResultsMock.mockResolvedValue(undefined);
});

describe('network provider — stage boundaries', () => {
  it('stamps correct testStage names for a full run', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({ application: applicationMetadata });

    const result = await engine.run(testServer);

    expect(result.stages?.map((s) => s.testStage)).toEqual([
      'latencyStart',
      'downloadStart',
      'downloadEnd',
      'uploadStart',
      'uploadEnd',
    ]);
  });

  it('calls network provider once per stage boundary — 5 boundaries + 1 initial = 6 total', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({ application: applicationMetadata });

    const getWifiMetadata = vi.fn().mockReturnValue({ ssidName: 'Test-AP' });
    engine.setNetworkProvider({ getConnectionType: () => 'wifi', getWifiMetadata });

    await engine.run(testServer);

    // 1 initial acquireNetwork + 5 stage boundaries (latencyStart, downloadStart,
    // downloadEnd, uploadStart, uploadEnd)
    expect(getWifiMetadata).toHaveBeenCalledTimes(6);
  });

  it('stamps fresh network data on latencyStart', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({ application: applicationMetadata });

    let call = 0;
    engine.setNetworkProvider({
      getConnectionType: () => 'wifi',
      getWifiMetadata: () => ({ ssidName: `AP-${++call}` }),
    });

    const result = await engine.run(testServer);

    const latencyStage = result.stages?.find((s) => s.testStage === 'latencyStart');
    expect(latencyStage?.connectionType).toBe('wifi');
    expect(latencyStage?.wifi?.ssidName).toBeDefined();
  });

  it('stamps fresh network data on downloadStart and downloadEnd independently', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({ application: applicationMetadata });

    let call = 0;
    engine.setNetworkProvider({
      getConnectionType: () => 'wifi',
      getWifiMetadata: () => ({ ssidName: `AP-${++call}`, channelNumber: call }),
    });

    const result = await engine.run(testServer);

    const downloadStart = result.stages?.find((s) => s.testStage === 'downloadStart');
    const downloadEnd = result.stages?.find((s) => s.testStage === 'downloadEnd');

    expect(downloadStart?.wifi?.ssidName).toBeDefined();
    expect(downloadEnd?.wifi?.ssidName).toBeDefined();
    expect(downloadStart?.wifi?.ssidName).not.toBe(downloadEnd?.wifi?.ssidName);
  });

  it('stamps fresh network data on uploadStart and uploadEnd independently', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({ application: applicationMetadata });

    let call = 0;
    engine.setNetworkProvider({
      getConnectionType: () => 'wifi',
      getWifiMetadata: () => ({ ssidName: `AP-${++call}`, channelNumber: call }),
    });

    const result = await engine.run(testServer);

    const uploadStart = result.stages?.find((s) => s.testStage === 'uploadStart');
    const uploadEnd = result.stages?.find((s) => s.testStage === 'uploadEnd');

    expect(uploadStart?.wifi?.ssidName).toBeDefined();
    expect(uploadEnd?.wifi?.ssidName).toBeDefined();
    expect(uploadStart?.wifi?.ssidName).not.toBe(uploadEnd?.wifi?.ssidName);
  });

  it('final result network reflects the uploadEnd snapshot', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({ application: applicationMetadata });

    let call = 0;
    engine.setNetworkProvider({
      getConnectionType: () => 'wifi',
      getWifiMetadata: () => ({ ssidName: `AP-${++call}` }),
    });

    const result = await engine.run(testServer);

    const uploadEnd = result.stages?.find((s) => s.testStage === 'uploadEnd');
    expect(result.results.wifi?.ssidName).toBe(uploadEnd?.wifi?.ssidName);
  });

  it('latency-only run: 1 stage boundary (latencyStart), 2 total provider calls', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({
      application: applicationMetadata,
      tests: { latency: true, download: false, upload: false },
    });

    const getWifiMetadata = vi.fn().mockReturnValue({ ssidName: 'Test-AP' });
    engine.setNetworkProvider({ getConnectionType: () => 'wifi', getWifiMetadata });

    const result = await engine.run(testServer);

    expect(result.stages?.map((s) => s.testStage)).toEqual(['latencyStart']);
    expect(getWifiMetadata).toHaveBeenCalledTimes(2); // 1 initial + 1 latencyStart
  });

  it('download-only run: downloadStart + downloadEnd boundaries, 3 total provider calls', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({
      application: applicationMetadata,
      tests: { latency: false, download: true, upload: false },
    });

    const getWifiMetadata = vi.fn().mockReturnValue({ ssidName: 'Test-AP' });
    engine.setNetworkProvider({ getConnectionType: () => 'wifi', getWifiMetadata });

    const result = await engine.run(testServer);

    expect(result.stages?.map((s) => s.testStage)).toEqual(['downloadStart', 'downloadEnd']);
    expect(getWifiMetadata).toHaveBeenCalledTimes(3); // 1 initial + 2 boundaries
  });

  it('upload-only run: uploadStart + uploadEnd boundaries, 3 total provider calls', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({
      application: applicationMetadata,
      tests: { latency: false, download: false, upload: true },
    });

    const getWifiMetadata = vi.fn().mockReturnValue({ ssidName: 'Test-AP' });
    engine.setNetworkProvider({ getConnectionType: () => 'wifi', getWifiMetadata });

    const result = await engine.run(testServer);

    expect(result.stages?.map((s) => s.testStage)).toEqual(['uploadStart', 'uploadEnd']);
    expect(getWifiMetadata).toHaveBeenCalledTimes(3); // 1 initial + 2 boundaries
  });

  it('without a provider all stages share the same network snapshot', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({ application: applicationMetadata });

    const result = await engine.run(testServer);

    // No provider — connectionType and cellular/wifi/wired are identical across all stages
    const connectionTypes = result.stages?.map((s) => s.connectionType) ?? [];
    expect(connectionTypes.every((t) => t === connectionTypes[0])).toBe(true);
  });

  it('connection type change is reflected in subsequent stages', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({ application: applicationMetadata });

    const callSequence: string[] = [];
    let currentType: 'wifi' | 'mobile' = 'wifi';

    engine.setNetworkProvider({
      getConnectionType: () => {
        callSequence.push(currentType);
        return currentType;
      },
    });

    // Simulate switching from wifi to mobile mid-test (e.g. after download completes)
    mocks.downloadSpeedMock.mockImplementation(async () => {
      currentType = 'mobile';
      return { durationMs: 2000, bytes: 4_000_000, speedMbps: 120, snapshots: [] };
    });

    const result = await engine.run(testServer);

    const downloadStart = result.stages?.find((s) => s.testStage === 'downloadStart');
    const downloadEnd = result.stages?.find((s) => s.testStage === 'downloadEnd');
    const uploadStart = result.stages?.find((s) => s.testStage === 'uploadStart');

    expect(downloadStart?.connectionType).toBe('wifi');
    expect(downloadEnd?.connectionType).toBe('mobile');
    expect(uploadStart?.connectionType).toBe('mobile');
  });

  it('cellular metadata is re-resolved at each stage for mobile connections', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({ application: applicationMetadata });

    let rsrp = -110;
    engine.setNetworkProvider({
      getConnectionType: () => 'mobile',
      getCellularMetadata: () => ({ carrierName: 'My Carrier', rsrp: rsrp++ }),
    });

    const result = await engine.run(testServer);

    const rsrpValues = result.stages?.map((s) => s.cellular?.rsrp) ?? [];
    const uniqueRsrp = new Set(rsrpValues);
    expect(uniqueRsrp.size).toBe(result.stages?.length);
    expect(result.results.cellular?.rsrp).toBe(result.stages?.at(-1)?.cellular?.rsrp);
  });
});
