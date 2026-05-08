/**
 * Calculate speed in Mbps from bytes and milliseconds.
 * Formula: bytes / (ms * 125) = Mbps
 * Derivation: 1 Mbps = 125,000 bytes/sec = 125 bytes/ms
 */
export function calculateSpeedMbps(bytes: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return bytes / (durationMs * 125);
}

export function formatSpeed(mbps: number): string {
  if (mbps < 0.01) return '0';
  if (mbps < 1) return mbps.toFixed(2);
  if (mbps < 10) return mbps.toFixed(1);
  return Math.round(mbps).toString();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatLatency(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)} us`;
  if (ms < 10) return ms.toFixed(1);
  return Math.round(ms).toString();
}
