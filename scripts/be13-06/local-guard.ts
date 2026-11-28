// BE13-06 — destination guard for the real local MongoDB campaign.
// The campaign only proceeds when the target is provably the owned local
// single-node replica set. Anything else stops the campaign (fail closed).
const ATLAS_OR_CLOUD = /(mongodb\.net|mongodb-dev\.net|cosmos\.azure\.com|amazonaws\.com|documentdb)/i;

export function assertLocalMongoUri(uri: string, expectedPort: number): void {
  if (typeof uri !== 'string' || uri.length === 0) throw new Error('BE1306_URI_REQUIRED');
  if (uri.startsWith('mongodb+srv:')) throw new Error('BE1306_SRV_FORBIDDEN');
  if (ATLAS_OR_CLOUD.test(uri)) throw new Error('BE1306_CLOUD_HOST_FORBIDDEN');
  const match = /^mongodb:\/\/([^/?#@]+)\/([A-Za-z0-9_]+)\?(.*)$/.exec(uri);
  if (!match) throw new Error('BE1306_URI_SHAPE');
  const [, hosts, , query] = match;
  if (uri.includes('@')) throw new Error('BE1306_CREDENTIALS_FORBIDDEN');
  if (hosts !== '127.0.0.1:' + expectedPort) throw new Error('BE1306_HOST_NOT_LOOPBACK');
  const params = new URLSearchParams(query);
  if (params.get('directConnection') !== 'true') throw new Error('BE1306_DISCOVERY_FORBIDDEN');
  if (params.get('replicaSet') !== 'agro_db02') throw new Error('BE1306_REPLICA_SET_REQUIRED');
  for (const forbidden of ['tls', 'ssl', 'authSource', 'proxyHost', 'loadBalanced']) if (params.has(forbidden)) throw new Error('BE1306_OPTION_FORBIDDEN');
}

export function assertLocalReplicaSetHello(hello: Record<string, unknown>): void {
  if (hello.msg === 'isdbgrid') throw new Error('BE1306_MONGOS_FORBIDDEN');
  if (hello.setName !== 'agro_db02' || hello.isWritablePrimary !== true) throw new Error('BE1306_LOCAL_PRIMARY_REQUIRED');
  const hosts = Array.isArray(hello.hosts) ? hello.hosts : [];
  if (hosts.length !== 1 || !/^(localhost|127\.0\.0\.1):27017$/.test(String(hosts[0]))) throw new Error('BE1306_REMOTE_MEMBER_FORBIDDEN');
}
