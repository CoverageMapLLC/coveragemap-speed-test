import type { ConnectionInfo } from './connection-info.js';
import type {
  ConnectionType,
  NetworkTestResultCellularInfo,
  NetworkTestResultWiFiInfo,
  NetworkTestResultWiredInfo,
} from './test-results.js';

export interface SpeedTestNetworkSnapshot {
  connectionType: ConnectionType;
  cellular: NetworkTestResultCellularInfo | null;
  wifi: NetworkTestResultWiFiInfo | null;
  wired: NetworkTestResultWiredInfo | null;
}

export interface SpeedTestNetworkProviderContext {
  connectionInfo: ConnectionInfo | null;
  connectionType: ConnectionType;
}

export interface SpeedTestNetworkProvider {
  getConnectionType?(
    context: SpeedTestNetworkProviderContext
  ): ConnectionType | null | Promise<ConnectionType | null>;
  getCellularMetadata?(
    context: SpeedTestNetworkProviderContext
  ): Partial<NetworkTestResultCellularInfo> | null | Promise<Partial<NetworkTestResultCellularInfo> | null>;
  getWifiMetadata?(
    context: SpeedTestNetworkProviderContext
  ): Partial<NetworkTestResultWiFiInfo> | null | Promise<Partial<NetworkTestResultWiFiInfo> | null>;
  getWiredMetadata?(
    context: SpeedTestNetworkProviderContext
  ): Partial<NetworkTestResultWiredInfo> | null | Promise<Partial<NetworkTestResultWiredInfo> | null>;
}
