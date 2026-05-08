import type { SpeedTestServer } from '../types/speed-server.js';
import type { ConnectionInfo } from '../types/connection-info.js';
import type { SpeedTestLocationProvider } from '../types/location-provider.js';
import {
  resolveSpeedTestLocation,
  toSpeedTestLocationCoordinates,
  type SpeedTestLocationCoordinates,
} from '../utils/location-provider.js';
import type { ApiBaseUrlOverrides } from './config.js';
import { getSpeedApiBaseUrl } from './config.js';

const SERVER_CACHE_TTL_MS = 30 * 60 * 1000;

export class SpeedTestApiClient {
  private baseUrl: string;
  private serverCache: SpeedTestServer[] | null = null;
  private serverCacheTimestamp = 0;
  private serverCacheLocation: SpeedTestLocationCoordinates | null = null;
  private locationProvider: SpeedTestLocationProvider | null = null;

  constructor(
    overrides?: ApiBaseUrlOverrides,
    locationProvider?: SpeedTestLocationProvider | null
  ) {
    this.baseUrl = getSpeedApiBaseUrl(overrides);
    this.locationProvider = locationProvider ?? null;
  }

  setLocationProvider(provider: SpeedTestLocationProvider | null): void {
    this.locationProvider = provider;
  }

  async getServers(): Promise<SpeedTestServer[]> {
    const now = Date.now();
    const hasFreshCache =
      this.serverCache !== null && now - this.serverCacheTimestamp < SERVER_CACHE_TTL_MS;
    if (hasFreshCache && !this.locationProvider) {
      return this.serverCache as SpeedTestServer[];
    }

    const location = await this.resolveServerListLocation();
    if (hasFreshCache && this.hasSameLocation(this.serverCacheLocation, location)) {
      return this.serverCache as SpeedTestServer[];
    }

    const servers = await this.fetchServerList(location);
    this.serverCache = servers;
    this.serverCacheTimestamp = now;
    this.serverCacheLocation = location ?? null;
    return servers;
  }

  async refreshServers(): Promise<SpeedTestServer[]> {
    this.serverCache = null;
    this.serverCacheTimestamp = 0;
    this.serverCacheLocation = null;
    return this.getServers();
  }

  async getServer(id: string): Promise<SpeedTestServer | null> {
    const servers = await this.getServers();
    return servers.find((s) => s.id === id) ?? null;
  }

  async getConnectionInfo(): Promise<ConnectionInfo | null> {
    try {
      const url = `${this.baseUrl}/v1/connection`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) return null;
      const data = await response.json();
      return data as ConnectionInfo;
    } catch {
      return null;
    }
  }

  private async resolveServerListLocation(): Promise<SpeedTestLocationCoordinates | undefined> {
    const connectionInfo = await this.getConnectionInfo();
    const resolved = await resolveSpeedTestLocation(this.locationProvider, { connectionInfo });
    return toSpeedTestLocationCoordinates(resolved.location);
  }

  private hasSameLocation(
    cached: SpeedTestLocationCoordinates | null,
    current: SpeedTestLocationCoordinates | undefined
  ): boolean {
    if (!cached && !current) return true;
    if (!cached || !current) return false;
    return cached.latitude === current.latitude && cached.longitude === current.longitude;
  }

  private async fetchServerList(location?: SpeedTestLocationCoordinates): Promise<SpeedTestServer[]> {
    const params = new URLSearchParams();
    if (location) {
      params.set('latitude', String(location.latitude));
      params.set('longitude', String(location.longitude));
    }

    const query = params.toString();
    const url = `${this.baseUrl}/v1/list${query ? `?${query}` : ''}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch server list: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
      throw new Error('Unexpected server list response format');
    }

    type RawServer = SpeedTestServer & { premium?: boolean; showProvider?: boolean; logo?: string | null };
    return (data as RawServer[])
      .filter((s) => !s.premium)
      .map(({ premium: _p, showProvider: _sp, logo: _l, ...server }): SpeedTestServer => server);
  }
}
