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

function isCoverageMapHost(hostname: string): boolean {
  return hostname === 'coveragemap.com' || hostname.endsWith('.coveragemap.com');
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Checks where a `SpeedTestEngine` would upload its results. An override must be a CoverageMap
 * HTTPS host (`coveragemap.com` or a subdomain, such as a staging environment), so it can't be
 * used to send results nowhere. The one exception is a fully local setup: a loopback upload URL
 * with a loopback speed test API too, where no CoverageMap server is involved.
 */
export function assertUploadBaseUrl(overrides?: ApiBaseUrlOverrides): void {
  if (!overrides?.coverageMapApiBaseUrl) return;

  const upload = parseUrl(overrides.coverageMapApiBaseUrl);
  if (upload?.protocol === 'https:' && isCoverageMapHost(upload.hostname)) return;

  const speedApi = overrides.speedApiBaseUrl ? parseUrl(overrides.speedApiBaseUrl) : null;
  if (upload && isLoopbackHost(upload.hostname) && speedApi && isLoopbackHost(speedApi.hostname)) return;

  throw new Error(
    'SpeedTestEngineOptions.api.coverageMapApiBaseUrl must be an https:// coveragemap.com URL (or a loopback URL when speedApiBaseUrl is loopback too). Results are always uploaded to CoverageMap.'
  );
}
