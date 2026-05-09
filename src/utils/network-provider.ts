import type { ConnectionInfo } from '../types/connection-info.js';
import type {
  SpeedTestNetworkProvider,
  SpeedTestNetworkProviderContext,
  SpeedTestNetworkSnapshot,
} from '../types/network-provider.js';
import type {
  ConnectionType,
  NetworkTestResultBandInfo,
  NetworkTestResultCellularInfo,
  NetworkTestResultWiFiInfo,
  NetworkTestResultWiredInfo,
} from '../types/test-results.js';

const CONNECTION_TYPES: readonly ConnectionType[] = [
  'wifi',
  'mobile',
  'ethernet',
  'bluetooth',
  'none',
  'unknown',
];

interface NavigatorConnection {
  type?: string;
}

export type SpeedTestNetworkSource = 'provider' | 'deviceMetadata';

export interface ResolvedSpeedTestNetwork extends SpeedTestNetworkSnapshot {
  source: SpeedTestNetworkSource;
}

export function getNetworkInfo(): ConnectionType {
  return mapNavigatorConnectionType(getNavigatorConnection()?.type);
}

export function defaultSpeedTestNetworkProvider(
  context: SpeedTestNetworkProviderContext
): SpeedTestNetworkSnapshot {
  return buildSnapshotForConnectionType(context.connectionInfo, context.connectionType);
}

export async function resolveSpeedTestNetwork(
  provider: SpeedTestNetworkProvider | null | undefined,
  context: SpeedTestNetworkProviderContext
): Promise<ResolvedSpeedTestNetwork> {
  const fallback = defaultSpeedTestNetworkProvider(context);

  if (!provider) {
    return { ...fallback, source: 'deviceMetadata' };
  }

  try {
    let targetConnectionType = fallback.connectionType;
    if (provider.getConnectionType) {
      const resolved = normalizeConnectionType(await provider.getConnectionType(context));
      if (resolved) {
        targetConnectionType = resolved;
      }
    }

    const base = buildSnapshotForConnectionType(context.connectionInfo, targetConnectionType);

    let cellular = base.cellular;
    if (provider.getCellularMetadata) {
      cellular = mergeCellular(base.cellular, normalizeCellularInfo(await provider.getCellularMetadata(context)));
    }

    let wifi = base.wifi;
    if (provider.getWifiMetadata) {
      wifi = mergeWifi(base.wifi, normalizeWifiInfo(await provider.getWifiMetadata(context)));
    }

    let wired = base.wired;
    if (provider.getWiredMetadata) {
      wired = mergeWired(base.wired, normalizeWiredInfo(await provider.getWiredMetadata(context)));
    }

    return {
      source: 'provider',
      connectionType: targetConnectionType,
      cellular,
      wifi,
      wired,
    };
  } catch {
    return { ...fallback, source: 'deviceMetadata' };
  }
}

function buildSnapshotForConnectionType(
  connectionInfo: ConnectionInfo | null,
  connectionType: ConnectionType
): SpeedTestNetworkSnapshot {
  const ispName = connectionInfo?.client?.asOrg ?? null;

  switch (connectionType) {
    case 'wifi':
      return {
        connectionType,
        cellular: null,
        wifi: createDefaultWifiInfo(ispName),
        wired: null,
      };
    case 'mobile':
      return {
        connectionType,
        cellular: createDefaultCellularInfo(ispName),
        wifi: null,
        wired: null,
      };
    case 'ethernet':
      return {
        connectionType,
        cellular: null,
        wifi: null,
        wired: createDefaultWiredInfo(ispName),
      };
    default:
      return {
        connectionType,
        cellular: null,
        wifi: null,
        wired: null,
      };
  }
}

function createDefaultCellularInfo(ispName: string | null): NetworkTestResultCellularInfo {
  return {
    technology: null,
    mccCode: null,
    mncCode: null,
    countryIso: null,
    carrierName: ispName,
    provider: ispName,
    isRoaming: null,
    rsrp: null,
    rsrq: null,
    rssi: null,
    sinr: null,
    primaryBand: null,
    secondaryBands: null,
  };
}

function createDefaultWifiInfo(ispName: string | null): NetworkTestResultWiFiInfo {
  return {
    ssidName: null,
    bssid: null,
    ispName,
    wifiStandard: null,
    txRate: null,
    rxRate: null,
    rsrp: null,
    rsrq: null,
    rssi: null,
    sinr: null,
    noise: null,
    channelNumber: null,
  };
}

function createDefaultWiredInfo(ispName: string | null): NetworkTestResultWiredInfo {
  return {
    ispName,
    macAddress: null,
    dataLink: null,
  };
}

function mergeCellular(
  base: NetworkTestResultCellularInfo | null,
  overrides: Partial<NetworkTestResultCellularInfo> | null | undefined
): NetworkTestResultCellularInfo | null {
  if (overrides === undefined) return base;
  if (overrides === null) return null;
  return {
    ...(base ?? createDefaultCellularInfo(null)),
    ...overrides,
  };
}

function mergeWifi(
  base: NetworkTestResultWiFiInfo | null,
  overrides: Partial<NetworkTestResultWiFiInfo> | null | undefined
): NetworkTestResultWiFiInfo | null {
  if (overrides === undefined) return base;
  if (overrides === null) return null;
  return {
    ...(base ?? createDefaultWifiInfo(null)),
    ...overrides,
  };
}

function mergeWired(
  base: NetworkTestResultWiredInfo | null,
  overrides: Partial<NetworkTestResultWiredInfo> | null | undefined
): NetworkTestResultWiredInfo | null {
  if (overrides === undefined) return base;
  if (overrides === null) return null;
  return {
    ...(base ?? createDefaultWiredInfo(null)),
    ...overrides,
  };
}

function normalizeCellularInfo(value: unknown): Partial<NetworkTestResultCellularInfo> | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;

  const normalized: Partial<NetworkTestResultCellularInfo> = {};
  const setString = (
    key:
      | 'technology'
      | 'mccCode'
      | 'mncCode'
      | 'countryIso'
      | 'carrierName'
      | 'provider',
    raw: unknown
  ): void => {
    if (typeof raw === 'string' || raw === null) normalized[key] = raw;
  };
  const setBoolean = (
    key: 'isRoaming',
    raw: unknown
  ): void => {
    if (typeof raw === 'boolean' || raw === null) normalized[key] = raw;
  };
  const setNumber = (
    key:
      | 'rsrp'
      | 'rsrq'
      | 'rssi'
      | 'sinr',
    raw: unknown
  ): void => {
    if ((typeof raw === 'number' && Number.isFinite(raw)) || raw === null) normalized[key] = raw;
  };

  setString('technology', value.technology);
  setString('mccCode', value.mccCode);
  setString('mncCode', value.mncCode);
  setString('countryIso', value.countryIso);
  setString('carrierName', value.carrierName);
  setString('provider', value.provider);
  setBoolean('isRoaming', value.isRoaming);
  setNumber('rsrp', value.rsrp);
  setNumber('rsrq', value.rsrq);
  setNumber('rssi', value.rssi);
  setNumber('sinr', value.sinr);

  if ('primaryBand' in value) {
    normalized.primaryBand = normalizeBand(value.primaryBand);
  }

  if ('secondaryBands' in value) {
    normalized.secondaryBands = normalizeBandList(value.secondaryBands);
  }

  return normalized;
}

function normalizeWifiInfo(value: unknown): Partial<NetworkTestResultWiFiInfo> | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;

  const normalized: Partial<NetworkTestResultWiFiInfo> = {};
  const setString = (
    key: 'ssidName' | 'bssid' | 'ispName' | 'wifiStandard',
    raw: unknown
  ): void => {
    if (typeof raw === 'string' || raw === null) normalized[key] = raw;
  };
  const setNumber = (
    key:
      | 'txRate'
      | 'rxRate'
      | 'rsrp'
      | 'rsrq'
      | 'rssi'
      | 'sinr'
      | 'noise'
      | 'channelNumber',
    raw: unknown
  ): void => {
    if ((typeof raw === 'number' && Number.isFinite(raw)) || raw === null) normalized[key] = raw;
  };

  setString('ssidName', value.ssidName);
  setString('bssid', value.bssid);
  setString('ispName', value.ispName);
  setString('wifiStandard', value.wifiStandard);
  setNumber('txRate', value.txRate);
  setNumber('rxRate', value.rxRate);
  setNumber('rsrp', value.rsrp);
  setNumber('rsrq', value.rsrq);
  setNumber('rssi', value.rssi);
  setNumber('sinr', value.sinr);
  setNumber('noise', value.noise);
  setNumber('channelNumber', value.channelNumber);

  return normalized;
}

function normalizeWiredInfo(value: unknown): Partial<NetworkTestResultWiredInfo> | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;

  const normalized: Partial<NetworkTestResultWiredInfo> = {};
  if (typeof value.ispName === 'string' || value.ispName === null) {
    normalized.ispName = value.ispName;
  }
  if (typeof value.macAddress === 'string' || value.macAddress === null) {
    normalized.macAddress = value.macAddress;
  }
  if ((typeof value.dataLink === 'number' && Number.isFinite(value.dataLink)) || value.dataLink === null) {
    normalized.dataLink = value.dataLink;
  }
  return normalized;
}

function normalizeBand(raw: unknown): NetworkTestResultBandInfo | null | undefined {
  if (raw === null) return null;
  if (!isRecord(raw)) return undefined;

  const bandNumber = raw.bandNumber;
  const bandwidth = raw.bandwidth;
  const technology = raw.technology;

  if (
    typeof bandNumber !== 'number' ||
    !Number.isFinite(bandNumber) ||
    typeof bandwidth !== 'number' ||
    !Number.isFinite(bandwidth) ||
    (typeof technology !== 'string' && technology !== null)
  ) {
    return undefined;
  }

  return {
    bandNumber,
    bandwidth,
    technology,
  };
}

function normalizeBandList(raw: unknown): NetworkTestResultBandInfo[] | null | undefined {
  if (raw === null) return null;
  if (!Array.isArray(raw)) return undefined;

  const normalized: NetworkTestResultBandInfo[] = [];
  for (const candidate of raw) {
    const band = normalizeBand(candidate);
    if (!band) {
      return undefined;
    }
    normalized.push(band);
  }

  return normalized;
}

function normalizeConnectionType(raw: unknown): ConnectionType | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  return CONNECTION_TYPES.find((connectionType) => connectionType === raw);
}

function mapNavigatorConnectionType(raw: string | undefined): ConnectionType {
  switch (raw) {
    case 'wifi':
      return 'wifi';
    case 'ethernet':
      return 'ethernet';
    case 'cellular':
      return 'mobile';
    case 'bluetooth':
      return 'bluetooth';
    case 'none':
      return 'none';
    default:
      return 'unknown';
  }
}

function getNavigatorConnection(): NavigatorConnection | undefined {
  if (typeof navigator === 'undefined') {
    return undefined;
  }

  return (
    navigator as Navigator & {
      connection?: NavigatorConnection;
    }
  ).connection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
