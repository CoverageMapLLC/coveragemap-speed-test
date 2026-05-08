export type { SpeedTestServer } from './speed-server.js';
export { getServerWsUrl } from './speed-server.js';

export type {
  ConnectionClientInfo,
  ConnectionServerInfo,
  ConnectionInfo,
} from './connection-info.js';

export type {
  DeviceOS,
  TestStatus,
  TestTypeSingleMultiple,
  LocationTag,
  LocationType,
  TestStage,
  ConnectionType,
  RuntimeType,
  ApplicationType,
  NetworkTestResultTestResults,
  NetworkTestResultDevice,
  NetworkTestResultApplicationInfo,
  NetworkTestResultCoreSystemInfo,
  NetworkTestResultTestType,
  NetworkTestResultResults,
  NetworkTestResultLocation,
  NetworkTestResultWiFiInfo,
  NetworkTestResultWiredInfo,
  NetworkTestResultMeasurements,
  NetworkTestResultSpeedTimePair,
  NetworkTestResultStage,
  BrowserInfo,
} from './test-results.js';

export type {
  SpeedTestStage,
  LatencyTestData,
  SpeedSnapshot,
  SpeedTestData,
  SpeedTestConfig,
  SpeedTestSelection,
  SpeedTestCallbacks,
} from './speed-test.js';

export type {
  SpeedTestLocation,
  SpeedTestLocationProviderContext,
  SpeedTestLocationProvider,
} from './location-provider.js';

export { DEFAULT_CONFIG } from './speed-test.js';
