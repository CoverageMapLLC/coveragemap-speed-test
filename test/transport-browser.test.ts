import { describe, expect, it } from 'vitest';
import { loadTcpTransport, openSocket, resolveServerUrl } from '../src/tests/sockets.js';
import type { SpeedTestServer } from '../src/types/speed-server.js';

const server: SpeedTestServer = {
  id: 'abc',
  domain: 'speed.example.com',
  port: 443,
  provider: null,
  city: null,
  region: null,
  country: 'US',
  location: 'Example',
  latitude: null,
  longitude: null,
  distance: null,
  isCDN: false,
};

// jsdom stands in for a browser: raw TCP is unavailable.
describe('transport in browsers', () => {
  it('does not load raw TCP', async () => {
    expect(await loadTcpTransport()).toBeNull();
  });

  it('uses WebSocket for auto', async () => {
    expect(await resolveServerUrl(server)).toEqual({ url: 'wss://speed.example.com:443/v1/ws', protocol: 'WSS' });
  });

  it('fails when raw TCP is required', async () => {
    await expect(resolveServerUrl(server, 'tcp')).rejects.toThrow('The raw TCP transport needs Node.js');
  });

  it('refuses to open a raw TCP socket', () => {
    expect(() => openSocket('tcps://speed.example.com:443')).toThrow('The raw TCP transport is not loaded');
  });
});
