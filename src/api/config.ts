export interface ApiBaseUrlOverrides {
  speedApiBaseUrl?: string;
  coverageMapApiBaseUrl?: string;
}

const DEFAULT_SPEED_API_BASE_URL = 'https://api.speed.coveragemap.com';
const DEFAULT_COVERAGEMAP_API_BASE_URL = 'https://map.coveragemap.com';

export function getSpeedApiBaseUrl(overrides?: ApiBaseUrlOverrides): string {
  if (overrides?.speedApiBaseUrl) {
    return overrides.speedApiBaseUrl.replace(/\/$/, '');
  }
  return DEFAULT_SPEED_API_BASE_URL;
}

export function getCoverageMapApiBaseUrl(overrides?: ApiBaseUrlOverrides): string {
  if (overrides?.coverageMapApiBaseUrl) {
    return overrides.coverageMapApiBaseUrl.replace(/\/$/, '');
  }
  return DEFAULT_COVERAGEMAP_API_BASE_URL;
}
