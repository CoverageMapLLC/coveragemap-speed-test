import { describe, expect, it } from 'vitest';
import {
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

describe('speed-test thresholds', () => {
  it('maps estimated download speed to packet size and connections', () => {
    expect(getDownloadMessageSizeKb(0.2)).toBe(1);
    expect(getDownloadMessageSizeKb(15)).toBe(64);
    expect(getDownloadMessageSizeKb(80)).toBe(1024);

    expect(getDownloadConnectionCount(0.2)).toBe(1);
    expect(getDownloadConnectionCount(5)).toBe(4);
    expect(getDownloadConnectionCount(5000)).toBe(10);
  });

  it('maps estimated upload speed to packet size and connections', () => {
    expect(getUploadMessageSizeKb(0.2)).toBe(1);
    expect(getUploadMessageSizeKb(20)).toBe(512);
    expect(getUploadMessageSizeKb(100)).toBe(1024);

    expect(getUploadConnectionCount(0.2)).toBe(1);
    expect(getUploadConnectionCount(5)).toBe(4);
    expect(getUploadConnectionCount(1200)).toBe(10);
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
