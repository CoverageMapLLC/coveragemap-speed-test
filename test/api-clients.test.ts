import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeedTestApiClient } from '../src/api/speed-api.js';
import { CoverageMapApiClient } from '../src/api/coveragemap-api.js';
import type { NetworkTestResultTestResults } from '../src/types/test-results.js';

describe('api clients', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches server list with optional location query params', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          client: { ip: '1.1.1.1', latitude: 1.1, longitude: 2.2 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 'srv-1' }],
      });
    vi.stubGlobal('fetch', fetchMock);

    const client = new SpeedTestApiClient({
      speedApiBaseUrl: 'https://speed.example.com',
    });
    const list = await client.getServers();

    expect(list).toEqual([{ id: 'srv-1' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain(
      'https://speed.example.com/v1/list?latitude=1.1&longitude=2.2'
    );
  });

  it('returns null connection info for non-ok responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new SpeedTestApiClient({
      speedApiBaseUrl: 'https://speed.example.com',
    });
    await expect(client.getConnectionInfo()).resolves.toBeNull();
  });

  it('returns null connection info when fetch throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new SpeedTestApiClient({
      speedApiBaseUrl: 'https://speed.example.com',
    });
    await expect(client.getConnectionInfo()).resolves.toBeNull();
  });

  it('throws when server list response format is invalid', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          client: { ip: '1.1.1.1', latitude: 1.1, longitude: 2.2 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ not: 'an array' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const client = new SpeedTestApiClient({
      speedApiBaseUrl: 'https://speed.example.com',
    });
    await expect(client.getServers()).rejects.toThrow('Unexpected server list response format');
  });

  it('throws when upload request is not successful', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new CoverageMapApiClient({
      coverageMapApiBaseUrl: 'https://api.example.com',
    });

    await expect(client.uploadSpeedTestResults([])).rejects.toThrow(
      'Failed to upload speed test results: 500 Internal Server Error'
    );
  });

  it('uploads results with expected request shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
    });
    vi.stubGlobal('fetch', fetchMock);

    const payload = [{ version: 1 }] as unknown as NetworkTestResultTestResults[];
    const client = new CoverageMapApiClient({
      coverageMapApiBaseUrl: 'https://api.example.com',
    });

    await client.uploadSpeedTestResults(payload);

    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/api/v1/speedTests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
  });
});
