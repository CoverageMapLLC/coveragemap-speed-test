// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://app.example.com/speed-test" }
import { describe, expect, it } from 'vitest';
import { requiresSecureWebSocket, selectServerUrl } from '../src/tests/sockets.js';
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

// Browsers block ws:// from https:// pages, so only secure WebSocket is used there.
describe('transport in browsers on https pages', () => {
  it('requires secure WebSockets', () => {
    expect(location.protocol).toBe('https:');
    expect(requiresSecureWebSocket()).toBe(true);
  });

  it('uses secure WebSocket only, whatever else the server lists', async () => {
    expect(await selectServerUrl({ ...server, protocols: ['WSSv1', 'WSv1', 'TCPv1'] })).toEqual({
      primary: { url: 'wss://speed.example.com:443/v1/ws', protocol: 'WSS' },
      fallbacks: [],
    });
  });

  it('fails when the server offers no secure WebSocket', async () => {
    await expect(selectServerUrl({ ...server, protocols: ['WSv1', 'TCPv1'] })).rejects.toThrow(
      'The server offers no transport this runtime can use (WSv1, TCPv1)'
    );
  });

  it('refuses to force plain WebSocket', async () => {
    await expect(selectServerUrl(server, 'ws')).rejects.toThrow('This page only allows secure WebSockets (wss://)');
  });

  it('can force secure WebSocket', async () => {
    expect(await selectServerUrl(server, 'wss')).toEqual({
      primary: { url: 'wss://speed.example.com:443/v1/ws', protocol: 'WSS' },
      fallbacks: [],
    });
  });
});
