import type { SpeedTestServer } from './speed-server.js';

export type DeviceOS = 'iOS' | 'android' | 'iPadOS' | 'windows' | 'mac' | 'linux' | 'chromeos' | 'web';

export type TestStatus = 'passed' | 'failed';

export type TestTypeSingleMultiple = 'single' | 'multiple';

export type LocationTag = 'indoor' | 'outdoor' | 'driving' | 'other';

export type LocationType = 'device' | 'ip';

export type TestStage =
  | 'latencyStart'
  | 'downloadStart'
  | 'downloadEnd'
  | 'uploadStart'
  | 'uploadEnd';

export type ConnectionType = 'wifi' | 'mobile' | 'ethernet' | 'bluetooth' | 'none' | 'unknown';
export type RuntimeType = 'browser' | 'node' | 'unknown';
export type ApplicationType = 'web' | 'backend' | 'mobile' | 'desktop' | 'cli' | 'serverless' | 'other';

export interface NetworkTestResultTestResults {
  version: number;
  device: NetworkTestResultDevice;
  testType: NetworkTestResultTestType;
  results: NetworkTestResultResults;
  stages: NetworkTestResultStage[] | null;
}

export interface NetworkTestResultDevice {
  id: string | null;
  manufacturer: string;
  nameId: string | null;
  name: string;
  os: DeviceOS;
  osVersion: string;
  appName: string | null;
  appVersion: string | null;
  application: NetworkTestResultApplicationInfo;

  browserName: string | null;
  browserVersion: string | null;
  browserEngine: string | null;
  browserEngineVersion: string | null;

  cpuArchitecture: string | null;
  cpuCores: number | null;
  deviceMemoryGb: number | null;
  deviceType: string | null;
  deviceVendor: string | null;
  deviceModel: string | null;
  isMobile: boolean;

  language: string | null;
  timezone: string | null;
  coreSystem: NetworkTestResultCoreSystemInfo | null;
}

export interface NetworkTestResultApplicationInfo {
  id: string;
  name: string;
  version: string;
  organization: string;
  type: ApplicationType | (string & {});
  website: string | null;
}

export interface NetworkTestResultCoreSystemInfo {
  runtime: RuntimeType;
  hostName: string | null;
  processId: number | null;
  platform: string | null;
  architecture: string | null;
  runtimeVersion: string | null;
  uptimeSeconds: number | null;
  memoryRssMb: number | null;
}

export interface NetworkTestResultTestsRun {
  latency: boolean;
  download: boolean;
  upload: boolean;
}

export interface NetworkTestResultTestType {
  id: string;
  sessionId: string;
  type: TestTypeSingleMultiple;
  testIndex: number | null;
  testCount: number | null;
  tag: LocationTag;
  testsRun: NetworkTestResultTestsRun;
  downloadTestDuration: number | null;
  uploadTestDuration: number | null;
  testProtocol: string;
  downloadConnectionCount: number | null;
  uploadConnectionCount: number | null;
  downloadPacketSize: number | null;
  uploadPacketSize: number | null;
}

export interface NetworkTestResultResults {
  dateTime: string;
  connectionType: string | null;
  externalIpAddress: string | null;
  ispName: string | null;
  testStatus: TestStatus;
  location: NetworkTestResultLocation | null;
  server: SpeedTestServer | null;
  cellular: NetworkTestResultCellularInfo | null;
  wifi: NetworkTestResultWiFiInfo | null;
  wired: NetworkTestResultWiredInfo | null;
  measurements: NetworkTestResultMeasurements;
}

export interface NetworkTestResultLocation {
  latitude: number;
  longitude: number;
  elevation: number | null;
  heading: number | null;
  speed: number | null;
  locationType: LocationType;
}

export interface NetworkTestResultCellularInfo {
  technology: string | null;
  mccCode: string | null;
  mncCode: string | null;
  countryIso: string | null;
  carrierName: string | null;
  provider: string | null;
  isRoaming: boolean | null;
  rsrp: number | null;
  rsrq: number | null;
  rssi: number | null;
  sinr: number | null;
  primaryBand: NetworkTestResultBandInfo | null;
  secondaryBands: NetworkTestResultBandInfo[] | null;
}

export interface NetworkTestResultBandInfo {
  bandNumber: number;
  bandwidth: number;
  technology: string | null;
}

export interface NetworkTestResultWiFiInfo {
  ssidName: string | null;
  bssid: string | null;
  ispName: string | null;
  wifiStandard: string | null;
  txRate: number | null;
  rxRate: number | null;
  rsrp: number | null;
  rsrq: number | null;
  rssi: number | null;
  sinr: number | null;
  noise: number | null;
  channelNumber: number | null;
}

export interface NetworkTestResultWiredInfo {
  ispName: string | null;
  macAddress: string | null;
  dataLink: number | null;
}

export interface NetworkTestResultMeasurements {
  dateTime: string | null;
  downloadSpeed: number | null;
  totalDownload: number | null;
  uploadSpeed: number | null;
  totalUpload: number | null;
  latency: number | null;
  jitter: number | null;
  latenciesList: number[] | null;
  downloadList: NetworkTestResultSpeedTimePair[] | null;
  uploadList: NetworkTestResultSpeedTimePair[] | null;
  failedReason: string | null;
  failedStage: TestStage | null;
}

export interface NetworkTestResultSpeedTimePair {
  time: number;
  speed: number;
  data: number;
}

export interface NetworkTestResultStage {
  testStage: string;
  dateTime: string;
  connectionType: string | null;
  externalIpAddress: string | null;
  ispName: string | null;
  location: NetworkTestResultLocation | null;
  cellular: NetworkTestResultCellularInfo | null;
  wifi: NetworkTestResultWiFiInfo | null;
  wired: NetworkTestResultWiredInfo | null;
}

export interface BrowserInfo {
  browserName: string;
  browserVersion: string;
  browserEngine: string;
  platform: string;
  language: string;
  languages: string[];
  hardwareConcurrency: number;
  deviceMemory: number | null;
  maxTouchPoints: number;
  cookieEnabled: boolean;
  vendor: string;
  isMobile: boolean;
}
