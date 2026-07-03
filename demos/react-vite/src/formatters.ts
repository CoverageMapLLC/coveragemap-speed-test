export function formatMbps(value: number | null | undefined): string {
  if (value == null) return '-';
  if (value < 10) return value.toFixed(1);
  return Math.round(value).toString();
}

export function formatMs(value: number | null | undefined): string {
  if (value == null) return '-';
  return value.toFixed(1);
}

export function formatBytes(value: number | null | undefined): string {
  if (value == null) return '-';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatSecondsFromMs(value: number | null | undefined): string {
  if (value == null) return '-';
  return `${(value / 1000).toFixed(1)}s`;
}
