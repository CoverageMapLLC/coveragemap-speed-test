import { describe, expect, it } from 'vitest';
import {
  LIVE_SPEED_BLEND_MS,
  calculateLiveSpeedMbps,
  calculateSpeedMbps,
  formatBytes,
  formatLatency,
  formatSpeed,
  roundTo3Decimals,
} from '../src/utils/speed.js';

describe('speed utility helpers', () => {
  it('calculates Mbps from bytes and milliseconds', () => {
    expect(calculateSpeedMbps(125_000, 1000)).toBe(1);
    expect(calculateSpeedMbps(0, 1000)).toBe(0);
    expect(calculateSpeedMbps(1_000, 0)).toBe(0);
  });

  it('rounds numeric measurements to three decimal places', () => {
    expect(roundTo3Decimals(12.3456)).toBe(12.346);
    expect(roundTo3Decimals(0.0004)).toBe(0);
    expect(calculateSpeedMbps(1_000_000, 3333)).toBe(2.4);
  });

  it('moves the live speed from the whole-stage speed to the measured speed over a second', () => {
    expect(LIVE_SPEED_BLEND_MS).toBe(1000);
    // At (and before) the measurement start: the whole-stage speed, so the live speed doesn't jump.
    expect(calculateLiveSpeedMbps(20, 1600, 0)).toBe(20);
    expect(calculateLiveSpeedMbps(20, 1600, -3)).toBe(20);
    // A few ms in, a spike (or an empty window) in the measured speed barely moves it.
    expect(calculateLiveSpeedMbps(20, 1600, 5)).toBe(27.9);
    expect(calculateLiveSpeedMbps(20, 0, 5)).toBe(19.9);
    expect(calculateLiveSpeedMbps(20, 40, 500)).toBe(30);
    expect(calculateLiveSpeedMbps(20, 40, 875)).toBe(37.5);
    expect(calculateLiveSpeedMbps(20, 10, 500)).toBe(15);
    // From a second on: the measured speed, as in the stored snapshots and the result.
    expect(calculateLiveSpeedMbps(20, 40, 1000)).toBe(40);
    expect(calculateLiveSpeedMbps(20, 40.123, 4000)).toBe(40.123);
    expect(calculateLiveSpeedMbps(20, 40, 333.333)).toBe(26.667);
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
