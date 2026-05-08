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
}

export function getServerWsUrl(server: SpeedTestServer): string {
  const protocol = server.id === 'local' ? 'ws' : 'wss';
  return `${protocol}://${server.domain}:${server.port}/v1/ws`;
}
