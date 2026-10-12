import { describe, expect, it } from 'vitest';
import { loadTcpTransport, openSocket, requiresSecureWebSocket, selectServerUrl } from '../src/tests/sockets.js';
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

// jsdom stands in for a browser on an http:// page: raw TCP is unavailable, plain WebSocket is allowed.
describe('transport in browsers on http pages', () => {
  it('does not load raw TCP', async () => {
    expect(await loadTcpTransport()).toBeNull();
  });

  it('allows plain WebSocket', () => {
    expect(location.protocol).toBe('http:');
    expect(requiresSecureWebSocket()).toBe(false);
  });

  it('uses plain WebSocket, then secure WebSocket, even when the server lists raw TCP', async () => {
    expect(await selectServerUrl({ ...server, protocols: ['WSSv1', 'WSv1', 'TCPv1'] })).toEqual({
      primary: { url: 'ws://speed.example.com:443/v1/ws', protocol: 'WS' },
      fallbacks: [{ url: 'wss://speed.example.com:443/v1/ws', protocol: 'WSS' }],
    });
  });

  it('fails when the server only offers raw TCP', async () => {
    await expect(selectServerUrl({ ...server, protocols: ['TCPv1'] })).rejects.toThrow(
      'The server offers no transport this runtime can use (TCPv1)'
    );
  });

  it('fails when raw TCP is required', async () => {
    await expect(selectServerUrl(server, 'tcp')).rejects.toThrow('The raw TCP transport needs Node.js');
  });

  it('refuses to open a raw TCP socket', () => {
    expect(() => openSocket('tcp://speed.example.com:443')).toThrow('The raw TCP transport is not loaded');
  });
});
