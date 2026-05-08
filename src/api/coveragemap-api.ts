import type { NetworkTestResultTestResults } from '../types/test-results.js';
import type { ApiBaseUrlOverrides } from './config.js';
import { getCoverageMapApiBaseUrl } from './config.js';

export class CoverageMapApiClient {
  private baseUrl: string;

  constructor(overrides?: ApiBaseUrlOverrides) {
    this.baseUrl = getCoverageMapApiBaseUrl(overrides);
  }

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
    };
  }

  async uploadSpeedTestResults(results: NetworkTestResultTestResults[]): Promise<void> {
    const url = `${this.baseUrl}/api/v1/speedTests`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      credentials: 'include',
      body: JSON.stringify(results),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to upload speed test results: ${response.status} ${response.statusText}`
      );
    }
  }
}
