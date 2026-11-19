import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  getDownloadConnectionCount,
  getDownloadMessageSizeKb,
  getUploadConnectionCount,
  getUploadMessageSizeKb,
} from '../src/types/speed-test.js';
import {
  getCoverageMapApiBaseUrl,
  getSpeedApiBaseUrl,
  type ApiBaseUrlOverrides,
} from '../src/api/config.js';

describe('default config', () => {
  it('uses the CoverageMap standard of 15 pings and 7 s download and upload stages', () => {
    expect(DEFAULT_CONFIG.pingCount).toBe(15);
    expect(DEFAULT_CONFIG.downloadDurationMs).toBe(7000);
    expect(DEFAULT_CONFIG.uploadDurationMs).toBe(7000);
  });
});

describe('speed-test thresholds', () => {
  it('maps estimated download speed to the first message size and connections', () => {
    // 2.5 ms of each connection's share of the estimate, as a power of two
    expect(getDownloadMessageSizeKb(0.2)).toBe(1);
    expect(getDownloadMessageSizeKb(80)).toBe(4);
    expect(getDownloadMessageSizeKb(940)).toBe(32);
    expect(getDownloadMessageSizeKb(5000)).toBe(128);
    expect(getDownloadMessageSizeKb(940, 2)).toBe(128);

    expect(getDownloadConnectionCount(0.2)).toBe(1);
    expect(getDownloadConnectionCount(5)).toBe(4);
    expect(getDownloadConnectionCount(5000)).toBe(12);
  });

  it('maps estimated upload speed to the first chunk size and connections', () => {
    // 2.5 ms of each connection's share of the estimate, as a power of two up to 1 MiB
    expect(getUploadMessageSizeKb(0.2)).toBe(1);
    expect(getUploadMessageSizeKb(20)).toBe(1);
    expect(getUploadMessageSizeKb(100)).toBe(4);
    expect(getUploadMessageSizeKb(5000)).toBe(128);
    expect(getUploadMessageSizeKb(5000, 1)).toBe(1024);

    expect(getUploadConnectionCount(0.2)).toBe(1);
    expect(getUploadConnectionCount(5)).toBe(4);
    expect(getUploadConnectionCount(1200)).toBe(12);
  });
});

describe('api configuration', () => {
  it('returns CoverageMap production defaults', () => {
    expect(getSpeedApiBaseUrl()).toBe('https://api.speed.coveragemap.com');
    expect(getCoverageMapApiBaseUrl()).toBe('https://map.coveragemap.com');
  });

  it('respects explicit base URL overrides', () => {
    const overrides: ApiBaseUrlOverrides = {
      speedApiBaseUrl: 'https://custom-speed.example.com/',
      coverageMapApiBaseUrl: 'https://custom-api.example.com/',
    };
    expect(getSpeedApiBaseUrl(overrides)).toBe('https://custom-speed.example.com');
    expect(getCoverageMapApiBaseUrl(overrides)).toBe('https://custom-api.example.com');
  });
});
