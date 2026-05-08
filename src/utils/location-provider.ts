import type {
  SpeedTestLocation,
  SpeedTestLocationProvider,
  SpeedTestLocationProviderContext,
} from '../types/location-provider.js';

export type SpeedTestLocationSource = 'provider' | 'connectionInfo';

export interface ResolvedSpeedTestLocation {
  location: SpeedTestLocation | null;
  source: SpeedTestLocationSource;
}

export interface SpeedTestLocationCoordinates {
  latitude: number;
  longitude: number;
}

export function defaultSpeedTestLocationProvider(
  context: SpeedTestLocationProviderContext
): SpeedTestLocation | null {
  if (
    isValidCoordinate(context.connectionInfo?.client?.latitude) &&
    isValidCoordinate(context.connectionInfo?.client?.longitude)
  ) {
    return {
      latitude: context.connectionInfo.client.latitude,
      longitude: context.connectionInfo.client.longitude,
      elevation: null,
      heading: null,
      speed: null,
    };
  }
  return null;
}

export async function resolveSpeedTestLocation(
  provider: SpeedTestLocationProvider | null | undefined,
  context: SpeedTestLocationProviderContext
): Promise<ResolvedSpeedTestLocation> {
  if (provider) {
    try {
      const providerLocation = normalizeLocation(await provider(context));
      if (providerLocation) {
        return {
          location: providerLocation,
          source: 'provider',
        };
      }
    } catch {
      // Ignore provider errors and fall back to connectionInfo.
    }
  }

  return {
    location: defaultSpeedTestLocationProvider(context),
    source: 'connectionInfo',
  };
}

export function toSpeedTestLocationCoordinates(
  location: SpeedTestLocation | null
): SpeedTestLocationCoordinates | undefined {
  if (!location) {
    return undefined;
  }

  return {
    latitude: location.latitude,
    longitude: location.longitude,
  };
}

function normalizeLocation(location: SpeedTestLocation | null): SpeedTestLocation | null {
  if (!location) {
    return null;
  }

  if (!isValidCoordinate(location.latitude) || !isValidCoordinate(location.longitude)) {
    return null;
  }

  return location;
}

function isValidCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
