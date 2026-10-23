import { describe, expect, it } from 'vitest';
import { getServerWsUrl, type SpeedTestServer } from '../src/types/speed-server.js';

const selfHostedServer: SpeedTestServer & { selfHosted: true; version: string; protocolVersion: number } = {
  id: '6f1c2c4e-0a4b-4d0f-9a5e-3c2b1d0e9f8a',
  domain: 'speedtest.example.com',
  port: 8443,
  provider: 'Example Operator',
  city: 'Philadelphia',
  region: 'PA',
  country: 'US',
  location: 'Philadelphia, PA',
  latitude: 39.9526,
  longitude: -75.1652,
  distance: null,
  isCDN: false,
  selfHosted: true,
  version: '0.1.0',
  protocolVersion: 1,
};

describe('self-hosted servers', () => {
  it('accepts the optional selfHosted flag on SpeedTestServer', () => {
    const networkServer: SpeedTestServer = {
      id: 'srv-1',
      domain: 'speed.example.com',
      port: 443,
      provider: null,
      city: null,
      region: null,
      country: 'US',
      location: 'US',
      latitude: null,
      longitude: null,
      distance: 12.5,
      isCDN: null,
    };

    expect(networkServer.selfHosted).toBeUndefined();
    expect(selfHostedServer.selfHosted).toBe(true);
  });

  it('builds a wss URL for self-hosted servers because their id is never "local"', () => {
    expect(getServerWsUrl(selfHostedServer)).toBe('wss://speedtest.example.com:8443/v1/ws');
  });
});
