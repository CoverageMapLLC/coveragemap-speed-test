import { describe, expect, it, vi } from 'vitest';
import type { ConnectionInfo } from '../src/types/connection-info.js';
import type { SpeedTestLocation } from '../src/types/location-provider.js';
import {
  defaultSpeedTestLocationProvider,
  resolveSpeedTestLocation,
  toSpeedTestLocationCoordinates,
} from '../src/utils/location-provider.js';

function connectionAt(latitude: number, longitude: number): ConnectionInfo {
  return {
    client: {
      ip: null,
      city: null,
      region: null,
      state: null,
      postalCode: null,
      country: null,
      continent: null,
      timezone: null,
      latitude,
      longitude,
      asn: null,
      asOrg: '',
    },
    server: null,
  };
}

describe('defaultSpeedTestLocationProvider', () => {
  it('returns null when connectionInfo is null', () => {
    expect(defaultSpeedTestLocationProvider({ connectionInfo: null })).toBeNull();
  });

  it('returns null when client is null', () => {
    expect(
      defaultSpeedTestLocationProvider({
        connectionInfo: { client: null, server: null },
      })
    ).toBeNull();
  });

  it('returns a SpeedTestLocation built from client coordinates', () => {
    const loc = defaultSpeedTestLocationProvider({
      connectionInfo: connectionAt(40.7128, -74.006),
    });
    expect(loc).toEqual({
      latitude: 40.7128,
      longitude: -74.006,
      elevation: null,
      heading: null,
      speed: null,
    });
  });

  it('rejects non-finite latitude or longitude', () => {
    expect(
      defaultSpeedTestLocationProvider({
        connectionInfo: connectionAt(Number.NaN, -74.006),
      })
    ).toBeNull();
    expect(
      defaultSpeedTestLocationProvider({
        connectionInfo: connectionAt(40.7128, Number.POSITIVE_INFINITY),
      })
    ).toBeNull();
  });
});

describe('resolveSpeedTestLocation', () => {
  it('uses connectionInfo when no provider is given', async () => {
    const ctx = { connectionInfo: connectionAt(51.5074, -0.1278) };
    await expect(resolveSpeedTestLocation(undefined, ctx)).resolves.toEqual({
      location: {
        latitude: 51.5074,
        longitude: -0.1278,
        elevation: null,
        heading: null,
        speed: null,
      },
      source: 'connectionInfo',
    });
    await expect(resolveSpeedTestLocation(null, ctx)).resolves.toEqual({
      location: {
        latitude: 51.5074,
        longitude: -0.1278,
        elevation: null,
        heading: null,
        speed: null,
      },
      source: 'connectionInfo',
    });
  });

  it('returns provider location with source provider when coordinates are valid', async () => {
    const providerLoc: SpeedTestLocation = {
      latitude: 37.7749,
      longitude: -122.4194,
      elevation: 10,
      heading: 90,
      speed: 0,
    };
    const sync = vi.fn().mockReturnValue(providerLoc);
    await expect(
      resolveSpeedTestLocation(sync, { connectionInfo: connectionAt(1, 2) })
    ).resolves.toEqual({
      location: providerLoc,
      source: 'provider',
    });
    expect(sync).toHaveBeenCalledWith({ connectionInfo: connectionAt(1, 2) });
  });

  it('accepts an async provider', async () => {
    const providerLoc: SpeedTestLocation = { latitude: -33.8688, longitude: 151.2093 };
    const asyncProvider = vi.fn().mockResolvedValue(providerLoc);
    await expect(
      resolveSpeedTestLocation(asyncProvider, { connectionInfo: null })
    ).resolves.toEqual({
      location: providerLoc,
      source: 'provider',
    });
  });

  it('falls back to connectionInfo when provider returns null', async () => {
    const ctx = { connectionInfo: connectionAt(48.8566, 2.3522) };
    await expect(
      resolveSpeedTestLocation(() => null, ctx)
    ).resolves.toEqual({
      location: {
        latitude: 48.8566,
        longitude: 2.3522,
        elevation: null,
        heading: null,
        speed: null,
      },
      source: 'connectionInfo',
    });
  });

  it('falls back when provider returns coordinates with wrong runtime types', async () => {
    const ctx = { connectionInfo: connectionAt(40, -70) };
    await expect(
      resolveSpeedTestLocation(
        // Malformed payload at runtime (e.g. bad JSON) should not win over IP geolocation.
        async () => ({ latitude: '40' as unknown as number, longitude: -70 }),
        ctx
      )
    ).resolves.toMatchObject({
      source: 'connectionInfo',
      location: { latitude: 40, longitude: -70 },
    });
  });

  it('falls back when provider returns non-finite coordinates', async () => {
    const ctx = { connectionInfo: connectionAt(35.6762, 139.6503) };
    await expect(
      resolveSpeedTestLocation(
        async () => ({ latitude: Number.NaN, longitude: 139.6503 }),
        ctx
      )
    ).resolves.toEqual({
      location: {
        latitude: 35.6762,
        longitude: 139.6503,
        elevation: null,
        heading: null,
        speed: null,
      },
      source: 'connectionInfo',
    });
  });

  it('falls back when the provider throws', async () => {
    const ctx = { connectionInfo: connectionAt(52.52, 13.405) };
    const err = vi.fn().mockRejectedValue(new Error('gps unavailable'));
    await expect(resolveSpeedTestLocation(err, ctx)).resolves.toEqual({
      location: {
        latitude: 52.52,
        longitude: 13.405,
        elevation: null,
        heading: null,
        speed: null,
      },
      source: 'connectionInfo',
    });
  });

  it('returns null location when provider fails and connectionInfo has no valid client coords', async () => {
    await expect(
      resolveSpeedTestLocation(
        async () => {
          throw new Error('fail');
        },
        { connectionInfo: { client: null, server: null } }
      )
    ).resolves.toEqual({
      location: null,
      source: 'connectionInfo',
    });
  });
});

describe('toSpeedTestLocationCoordinates', () => {
  it('returns undefined for null', () => {
    expect(toSpeedTestLocationCoordinates(null)).toBeUndefined();
  });

  it('maps latitude and longitude only', () => {
    expect(
      toSpeedTestLocationCoordinates({
        latitude: 1.5,
        longitude: -2.25,
        elevation: 100,
        heading: 45,
        speed: 5,
      })
    ).toEqual({ latitude: 1.5, longitude: -2.25 });
  });
});
