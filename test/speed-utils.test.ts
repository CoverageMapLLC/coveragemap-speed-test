import { describe, expect, it } from 'vitest';
import { calculateSpeedMbps, formatBytes, formatLatency, formatSpeed } from '../src/utils/speed.js';

describe('speed utility helpers', () => {
  it('calculates Mbps from bytes and milliseconds', () => {
    expect(calculateSpeedMbps(125_000, 1000)).toBe(1);
    expect(calculateSpeedMbps(0, 1000)).toBe(0);
    expect(calculateSpeedMbps(1_000, 0)).toBe(0);
  });

  it('formats speed with threshold precision', () => {
    expect(formatSpeed(0.005)).toBe('0');
    expect(formatSpeed(0.42)).toBe('0.42');
    expect(formatSpeed(5.55)).toBe('5.5');
    expect(formatSpeed(42.7)).toBe('43');
  });

  it('formats bytes into readable units', () => {
    expect(formatBytes(100)).toBe('100 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('formats latency into consistent units', () => {
    expect(formatLatency(0.2)).toBe('200 us');
    expect(formatLatency(4.44)).toBe('4.4');
    expect(formatLatency(18.9)).toBe('19');
  });
});
