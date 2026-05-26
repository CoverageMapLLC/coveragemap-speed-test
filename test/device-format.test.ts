import { describe, expect, it } from 'vitest';
import {
  formatBrowserDisplay,
  formatBrowserName,
  formatDeviceOS,
  formatDeviceType,
  formatDisplayName,
  formatOSDisplay,
} from '../src/utils/device-format.js';

describe('device format utilities', () => {
  it('formats device OS labels', () => {
    expect(formatDeviceOS('windows')).toBe('Windows');
    expect(formatDeviceOS('mac')).toBe('macOS');
    expect(formatDeviceOS('linux')).toBe('Linux');
    expect(formatDeviceOS('chromeos')).toBe('ChromeOS');
    expect(formatDeviceOS('android')).toBe('Android');
    expect(formatDeviceOS('iOS')).toBe('iOS');
  });

  it('formats device type labels', () => {
    expect(formatDeviceType('desktop')).toBe('Desktop');
    expect(formatDeviceType('mobile')).toBe('Mobile');
    expect(formatDeviceType('tablet')).toBe('Tablet');
    expect(formatDeviceType('server')).toBe('Server');
  });

  it('formats browser names and display strings', () => {
    expect(formatBrowserName('chrome')).toBe('Chrome');
    expect(formatBrowserName('Mobile Chrome')).toBe('Chrome');
    expect(formatBrowserDisplay('chrome', '148.0.0.0')).toBe('Chrome 148.0.0.0');
  });

  it('formats OS display strings', () => {
    expect(formatOSDisplay('windows', '10')).toBe('Windows 10');
    expect(formatOSDisplay('mac', '14.2.1')).toBe('macOS 14.2.1');
  });

  it('title-cases unknown display names', () => {
    expect(formatDisplayName('win32')).toBe('Windows');
    expect(formatDisplayName('some custom runtime')).toBe('Some Custom Runtime');
  });
});
