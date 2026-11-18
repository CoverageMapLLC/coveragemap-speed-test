export { CancellationToken, CancellationError } from './cancellation.js';
export { SpeedTestError, getFailureReason, formatFailedReason } from './failure.js';
export type { SpeedTestFailureReason } from './failure.js';
export { generateUUID } from './uuid.js';
export { calculateSpeedMbps, formatSpeed, formatBytes, formatLatency, roundTo3Decimals } from './speed.js';
export {
  formatBrowserDisplay,
  formatBrowserName,
  formatDeviceOS,
  formatDeviceType,
  formatDisplayName,
  formatOSDisplay,
} from './device-format.js';
export {
  configureDeviceInfo,
  resetDeviceInfoConfiguration,
  setDeviceMetadataProvider,
  resetDeviceMetadataProvider,
  DefaultDeviceMetadataProvider,
  getDeviceId,
  parseBrowserInfo,
  parseOSInfo,
  getBrowserInfo,
  buildDeviceResult,
} from './device-info.js';
export type {
  DeviceInfoConfigOverrides,
  CoreSystemOverrides,
  DeviceMetadataProvider,
  DeviceMetadataProviderConfig,
  ParsedBrowserInfo,
  ParsedOSInfo,
} from './device-info.js';
export {
  defaultSpeedTestLocationProvider,
  resolveSpeedTestLocation,
  toSpeedTestLocationCoordinates,
} from './location-provider.js';
export type {
  SpeedTestLocationSource,
  ResolvedSpeedTestLocation,
  SpeedTestLocationCoordinates,
} from './location-provider.js';

export {
  getNetworkInfo,
  defaultSpeedTestNetworkProvider,
  resolveSpeedTestNetwork,
} from './network-provider.js';
export type {
  SpeedTestNetworkSource,
  ResolvedSpeedTestNetwork,
} from './network-provider.js';
export {
  DOWNLOAD_BATCH_MESSAGES,
  DOWNLOAD_MESSAGE_SIZES_KB,
  ESTIMATION_TIME_CAP_MS,
  MESSAGE_TARGET_MS,
  UPLOAD_CHUNK_SIZES_KB,
  estimationReference,
  getDownloadMessageSizeForSpeedKb,
  getFirstDownloadMessageSizeKb,
  getUploadChunkSizeForSpeedKb,
  nextEstimationStep,
  stalledEstimationRounds,
} from './adaptive.js';
export type { EstimationRound, EstimationStep } from './adaptive.js';
