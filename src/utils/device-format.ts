import type { DeviceOS } from '../types/test-results.js';

const DEVICE_OS_LABELS: Record<DeviceOS, string> = {
  iOS: 'iOS',
  android: 'Android',
  iPadOS: 'iPadOS',
  windows: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
  chromeos: 'ChromeOS',
  web: 'Web',
};

const DEVICE_TYPE_LABELS: Record<string, string> = {
  desktop: 'Desktop',
  mobile: 'Mobile',
  tablet: 'Tablet',
  server: 'Server',
  smarttv: 'Smart TV',
  wearable: 'Wearable',
  embedded: 'Embedded',
  console: 'Console',
};

const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  ios: 'iOS',
  ipados: 'iPadOS',
  macos: 'macOS',
  'mac os': 'macOS',
  'mac os x': 'macOS',
  chromeos: 'ChromeOS',
  'chrome os': 'ChromeOS',
  'chromium os': 'ChromeOS',
  windows: 'Windows',
  win32: 'Windows',
  linux: 'Linux',
  android: 'Android',
  darwin: 'macOS',
  web: 'Web',
  unknown: 'Unknown',
  blink: 'Blink',
  gecko: 'Gecko',
  webkit: 'WebKit',
  v8: 'V8',
};

const BROWSER_NAME_OVERRIDES: Record<string, string> = {
  chrome: 'Chrome',
  'mobile chrome': 'Chrome',
  'chrome headless': 'Chrome',
  firefox: 'Firefox',
  safari: 'Safari',
  edge: 'Edge',
  'edge chromium': 'Edge',
  opera: 'Opera',
  'opera mini': 'Opera Mini',
  'samsung browser': 'Samsung Internet',
  'internet explorer': 'Internet Explorer',
  ie: 'Internet Explorer',
};

export function formatDeviceOS(os: DeviceOS | string | null | undefined): string {
  if (!os) return 'Unknown';

  const normalized = os.trim();
  if (!normalized) return 'Unknown';

  const direct = DEVICE_OS_LABELS[normalized as DeviceOS];
  if (direct) return direct;

  return formatDisplayName(normalized);
}

export function formatDeviceType(deviceType: string | null | undefined): string {
  if (!deviceType) return 'Unknown';

  const normalized = deviceType.trim().toLowerCase();
  if (!normalized) return 'Unknown';

  return DEVICE_TYPE_LABELS[normalized] ?? formatDisplayName(deviceType);
}

export function formatBrowserName(name: string | null | undefined): string {
  if (!name) return 'Unknown';

  const normalized = name.trim();
  if (!normalized) return 'Unknown';

  const override = BROWSER_NAME_OVERRIDES[normalized.toLowerCase()];
  if (override) return override;

  return formatDisplayName(normalized);
}

export function formatBrowserDisplay(
  name: string | null | undefined,
  version?: string | null
): string {
  const formattedName = formatBrowserName(name);
  const formattedVersion = formatVersion(version);
  if (!formattedVersion) return formattedName;
  return `${formattedName} ${formattedVersion}`;
}

export function formatOSDisplay(
  os: DeviceOS | string | null | undefined,
  osVersion?: string | null
): string {
  const formattedOS = formatDeviceOS(os);
  const formattedVersion = formatVersion(osVersion);
  if (!formattedVersion) return formattedOS;
  return `${formattedOS} ${formattedVersion}`;
}

export function formatDisplayName(value: string): string {
  const normalized = value.trim();
  if (!normalized) return 'Unknown';

  const override = DISPLAY_NAME_OVERRIDES[normalized.toLowerCase()];
  if (override) return override;

  return normalized
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => formatToken(part))
    .join(' ');
}

function formatToken(token: string): string {
  const lower = token.toLowerCase();
  const override = DISPLAY_NAME_OVERRIDES[lower] ?? BROWSER_NAME_OVERRIDES[lower];
  if (override) return override;

  if (/^[a-z0-9]+$/i.test(token) && token === token.toUpperCase() && token.length <= 4) {
    return token;
  }

  if (/^v?\d/.test(token)) {
    return formatVersion(token);
  }

  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

export function formatVersion(version: string | null | undefined): string {
  if (!version) return '';
  return version.trim().replace(/^v/i, '');
}
