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
  /**
   * Speed test protocols the server supports: a transport and the protocol version on it.
   * `TCPv1` (raw TCP), `WSv1` (WebSocket), and `WSSv1` (secure WebSocket). Absent for servers
   * that predate the field, which only support `WSSv1` (`WSv1` for `id === "local"`).
   */
  protocols?: string[];
}

export function getServerWsUrl(server: SpeedTestServer): string {
  const protocol = server.id === 'local' ? 'ws' : 'wss';
  return `${protocol}://${server.domain}:${server.port}/v1/ws`;
}
