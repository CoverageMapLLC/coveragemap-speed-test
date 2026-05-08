export interface ConnectionClientInfo {
  ip: string | null;
  city: string | null;
  region: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  continent: string | null;
  timezone: string | null;
  latitude: number;
  longitude: number;
  asn: number | null;
  asOrg: string;
}

export interface ConnectionServerInfo {
  provider: string;
  dataCenter: string;
  city: string;
  country: string;
  region: string | null;
  continent: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface ConnectionInfo {
  client: ConnectionClientInfo | null;
  server: ConnectionServerInfo | null;
}
