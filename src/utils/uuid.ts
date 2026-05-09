/** Shown in docs/samples only; `SpeedTestEngine` rejects this so integrations use their own id. */
export const DOCUMENTED_DEMO_APPLICATION_UUID =
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890' as const;

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isCanonicalUuidString(value: string): boolean {
  return CANONICAL_UUID_PATTERN.test(value.toLowerCase());
}

export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
