import type { ConnectionInfo } from './connection-info.js';

export interface SpeedTestLocation {
  latitude: number;
  longitude: number;
  elevation?: number | null;
  heading?: number | null;
  speed?: number | null;
}

export interface SpeedTestLocationProviderContext {
  connectionInfo: ConnectionInfo | null;
}

export type SpeedTestLocationProvider = (context: SpeedTestLocationProviderContext) =>
  | SpeedTestLocation
  | null
  | Promise<SpeedTestLocation | null>;
