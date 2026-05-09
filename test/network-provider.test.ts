import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionInfo } from '../src/types/connection-info.js';
import type { SpeedTestNetworkProviderContext } from '../src/types/network-provider.js';
import {
  defaultSpeedTestNetworkProvider,
  getNetworkInfo,
  resolveSpeedTestNetwork,
} from '../src/utils/network-provider.js';

const originalNavigatorConnection = Object.getOwnPropertyDescriptor(navigator, 'connection');

afterEach(() => {
  if (originalNavigatorConnection) {
    Object.defineProperty(navigator, 'connection', originalNavigatorConnection);
    return;
  }

  Reflect.deleteProperty(navigator, 'connection');
});

function connectionInfo(asOrg: string | null = 'CoverageMap ISP'): ConnectionInfo {
  return {
    client: {
      ip: '1.1.1.1',
      city: null,
      region: null,
      state: null,
      postalCode: null,
      country: null,
      continent: null,
      timezone: null,
      latitude: 40,
      longitude: -74,
      asn: null,
      asOrg: asOrg ?? '',
    },
    server: null,
  };
}

function context(
  overrides: Partial<SpeedTestNetworkProviderContext> = {}
): SpeedTestNetworkProviderContext {
  return {
    connectionInfo: connectionInfo(),
    connectionType: 'unknown',
    ...overrides,
  };
}

describe('defaultSpeedTestNetworkProvider', () => {
  it('builds wifi defaults when connection type is wifi', () => {
    const network = defaultSpeedTestNetworkProvider(context({ connectionType: 'wifi' }));
    expect(network.connectionType).toBe('wifi');
    expect(network.wifi?.ispName).toBe('CoverageMap ISP');
    expect(network.wired).toBeNull();
    expect(network.cellular).toBeNull();
  });

  it('builds cellular defaults when connection type is mobile', () => {
    const network = defaultSpeedTestNetworkProvider(context({ connectionType: 'mobile' }));
    expect(network.connectionType).toBe('mobile');
    expect(network.cellular?.carrierName).toBe('CoverageMap ISP');
    expect(network.cellular?.provider).toBe('CoverageMap ISP');
    expect(network.wifi).toBeNull();
    expect(network.wired).toBeNull();
  });

  it('builds wired defaults for non-wifi and non-mobile connection types', () => {
    const network = defaultSpeedTestNetworkProvider(context({ connectionType: 'ethernet' }));
    expect(network.connectionType).toBe('ethernet');
    expect(network.wired).toEqual({
      ispName: 'CoverageMap ISP',
      macAddress: null,
      dataLink: null,
    });
    expect(network.wifi).toBeNull();
    expect(network.cellular).toBeNull();
  });
});

describe('getNetworkInfo', () => {
  it('returns unknown when navigator.connection is unavailable', () => {
    Reflect.deleteProperty(navigator, 'connection');
    expect(getNetworkInfo()).toBe('unknown');
  });

  it('maps navigator.connection.type to a ConnectionType', () => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { type: 'cellular' },
    });
    expect(getNetworkInfo()).toBe('mobile');
  });

  it('maps wifi type', () => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { type: 'wifi' },
    });
    expect(getNetworkInfo()).toBe('wifi');
  });

  it('maps ethernet type', () => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { type: 'ethernet' },
    });
    expect(getNetworkInfo()).toBe('ethernet');
  });
});

describe('resolveSpeedTestNetwork', () => {
  it('falls back to metadata defaults when provider is absent', async () => {
    await expect(resolveSpeedTestNetwork(undefined, context({ connectionType: 'wifi' }))).resolves.toMatchObject({
      source: 'deviceMetadata',
      connectionType: 'wifi',
      wifi: { ispName: 'CoverageMap ISP' },
      cellular: null,
      wired: null,
    });
  });

  it('falls back to metadata defaults when provider has no methods defined', async () => {
    await expect(resolveSpeedTestNetwork({}, context({ connectionType: 'wifi' }))).resolves.toMatchObject({
      source: 'provider',
      connectionType: 'wifi',
      wifi: { ispName: 'CoverageMap ISP' },
      cellular: null,
      wired: null,
    });
  });

  it('applies partial wifi overrides on top of defaults', async () => {
    const provider = {
      getConnectionType: vi.fn().mockResolvedValue('wifi'),
      getWifiMetadata: vi.fn().mockResolvedValue({ ssidName: 'Lab-WiFi', channelNumber: 149 }),
    };

    await expect(resolveSpeedTestNetwork(provider, context())).resolves.toMatchObject({
      source: 'provider',
      connectionType: 'wifi',
      wifi: {
        ispName: 'CoverageMap ISP',
        ssidName: 'Lab-WiFi',
        channelNumber: 149,
      },
      cellular: null,
      wired: null,
    });
  });

  it('supports overriding connection type to mobile with cellular metadata', async () => {
    await expect(
      resolveSpeedTestNetwork(
        {
          getConnectionType: () => 'mobile' as const,
          getCellularMetadata: () => ({ technology: '5g' }),
        },
        context({ connectionType: 'wifi' })
      )
    ).resolves.toMatchObject({
      source: 'provider',
      connectionType: 'mobile',
      cellular: { technology: '5g' },
      wifi: null,
      wired: null,
    });
  });

  it('accepts all cellular, wifi, and wired metadata independently', async () => {
    await expect(
      resolveSpeedTestNetwork(
        {
          getConnectionType: () => 'mobile' as const,
          getCellularMetadata: () => ({
            technology: '5g',
            mccCode: '310',
            mncCode: '260',
            countryIso: 'us',
            carrierName: 'Carrier A',
            provider: 'Provider A',
            isRoaming: false,
            rsrp: -95,
            rsrq: -12,
            rssi: -70,
            sinr: 18,
            primaryBand: { bandNumber: 77, bandwidth: 100, technology: '5g' },
            secondaryBands: [
              { bandNumber: 41, bandwidth: 80, technology: '5g' },
              { bandNumber: 78, bandwidth: 60, technology: '5g' },
            ],
          }),
          getWifiMetadata: () => ({
            ssidName: 'Office-WiFi',
            bssid: 'AA:BB:CC:DD:EE:FF',
            ispName: 'Fiber ISP',
            wifiStandard: '802.11ax',
            txRate: 1200,
            rxRate: 960,
            rsrp: null,
            rsrq: null,
            rssi: -48,
            sinr: 34,
            noise: -90,
            channelNumber: 149,
          }),
          getWiredMetadata: () => ({
            ispName: 'Datacenter Ethernet',
            macAddress: 'AA:BB:CC:DD:EE:FF',
            dataLink: 10_000,
          }),
        },
        context({ connectionType: 'unknown' })
      )
    ).resolves.toEqual({
      source: 'provider',
      connectionType: 'mobile',
      cellular: {
        technology: '5g',
        mccCode: '310',
        mncCode: '260',
        countryIso: 'us',
        carrierName: 'Carrier A',
        provider: 'Provider A',
        isRoaming: false,
        rsrp: -95,
        rsrq: -12,
        rssi: -70,
        sinr: 18,
        primaryBand: { bandNumber: 77, bandwidth: 100, technology: '5g' },
        secondaryBands: [
          { bandNumber: 41, bandwidth: 80, technology: '5g' },
          { bandNumber: 78, bandwidth: 60, technology: '5g' },
        ],
      },
      wifi: {
        ssidName: 'Office-WiFi',
        bssid: 'AA:BB:CC:DD:EE:FF',
        ispName: 'Fiber ISP',
        wifiStandard: '802.11ax',
        txRate: 1200,
        rxRate: 960,
        rsrp: null,
        rsrq: null,
        rssi: -48,
        sinr: 34,
        noise: -90,
        channelNumber: 149,
      },
      wired: {
        ispName: 'Datacenter Ethernet',
        macAddress: 'AA:BB:CC:DD:EE:FF',
        dataLink: 10_000,
      },
    });
  });

  it('allows explicit nulling of a metadata block', async () => {
    await expect(
      resolveSpeedTestNetwork(
        {
          getConnectionType: () => 'wifi' as const,
          getWifiMetadata: () => null,
        },
        context({ connectionType: 'wifi' })
      )
    ).resolves.toMatchObject({
      source: 'provider',
      connectionType: 'wifi',
      wifi: null,
      cellular: null,
      wired: null,
    });
  });

  it('ignores an invalid connection type from getConnectionType and keeps the default', async () => {
    await expect(
      resolveSpeedTestNetwork(
        {
          getConnectionType: () => 'not-real' as unknown as null,
          getWifiMetadata: () => ({ channelNumber: '149' as unknown as null }),
        },
        context({ connectionType: 'wifi' })
      )
    ).resolves.toMatchObject({
      source: 'provider',
      connectionType: 'wifi',
      wifi: {
        ispName: 'CoverageMap ISP',
        channelNumber: null,
      },
      cellular: null,
      wired: null,
    });
  });

  it('falls back to metadata defaults when a provider method throws', async () => {
    await expect(
      resolveSpeedTestNetwork(
        {
          getConnectionType: async () => {
            throw new Error('network probe failed');
          },
        },
        context({ connectionType: 'mobile' })
      )
    ).resolves.toMatchObject({
      source: 'deviceMetadata',
      connectionType: 'mobile',
      cellular: { carrierName: 'CoverageMap ISP' },
      wifi: null,
      wired: null,
    });
  });

  it('only calls defined methods and leaves other blocks at their defaults', async () => {
    await expect(
      resolveSpeedTestNetwork(
        {
          getCellularMetadata: () => ({ technology: 'lte', carrierName: 'My Carrier' }),
        },
        context({ connectionType: 'mobile' })
      )
    ).resolves.toMatchObject({
      source: 'provider',
      connectionType: 'mobile',
      cellular: {
        technology: 'lte',
        carrierName: 'My Carrier',
      },
      wifi: null,
      wired: null,
    });
  });
});
