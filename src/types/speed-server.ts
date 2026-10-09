export interface SpeedTestServer {
  id: string;
  domain: string;
  port: number | null;
  provider: string | null;
  city: string | null;
  region: string | null;
  country: string;
  location: string;
  latitude: number | null;
  longitude: number | null;
  distance: number | null;
  isCDN: boolean | null;
  /**
   * True when the server is a self-hosted `@coveragemap/speed-test-server` instance entered
   * manually by the user rather than one from the CoverageMap network. Absent for network
   * servers. Results from self-hosted servers are uploaded but never mapped.
   */
  selfHosted?: boolean;
}

export function getServerWsUrl(server: SpeedTestServer): string {
  const protocol = server.id === 'local' ? 'ws' : 'wss';
  return `${protocol}://${server.domain}:${server.port}/v1/ws`;
}
