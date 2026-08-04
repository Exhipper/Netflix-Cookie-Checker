import type { ProxyEntry } from "./types.js";

function buildProxyDict(
  scheme: string,
  host: string,
  port: string,
  user?: string | null,
  password?: string | null
): ProxyEntry {
  host = host.trim();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const proxyUrl =
    user && password
      ? `${scheme}://${user}:${password}@${host}:${port}`
      : `${scheme}://${host}:${port}`;
  return { http: proxyUrl, https: proxyUrl };
}

export function parseProxyLine(line: string): ProxyEntry | null {
  line = line.trim();
  if (!line || line.startsWith("#")) return null;

  // Normalize scheme
  line = line.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/+/, "$1://");
  line = line.replace(/\s+/g, " ").trim();

  // scheme://user:pass@host:port
  let match = line.match(
    /^(?<scheme>https?|socks5h?|socks4a?):\/\/(?:(?<user>[^:@\s]+):(?<password>[^@\s]+)@)?(?<host>\[[^\]]+\]|[^:\s]+):(?<port>\d+)$/i
  );
  if (match) {
    const g = match.groups!;
    return buildProxyDict(g.scheme.toLowerCase(), g.host, g.port, g.user, g.password);
  }

  // user:pass@host:port
  match = line.match(
    /^(?<user>[^:@\s]+):(?<password>[^@\s]+)@(?<host>\[[^\]]+\]|[^:\s]+):(?<port>\d+)$/
  );
  if (match) {
    const g = match.groups!;
    return buildProxyDict("http", g.host, g.port, g.user, g.password);
  }

  // host:port@user:pass
  match = line.match(
    /^(?<host>\[[^\]]+\]|[^:\s]+):(?<port>\d+)@(?<user>[^:@\s]+):(?<password>[^@\s]+)$/
  );
  if (match) {
    const g = match.groups!;
    return buildProxyDict("http", g.host, g.port, g.user, g.password);
  }

  // host:port
  match = line.match(/^(?<host>\[[^\]]+\]|[^:\s]+):(?<port>\d+)$/);
  if (match) {
    const g = match.groups!;
    return buildProxyDict("http", g.host, g.port);
  }

  // 4-part: ip:port:user:pass or user:pass:ip:port
  const fourParts = line.split(":");
  if (fourParts.length === 4) {
    const [a, b, c, d] = fourParts;
    if (/^\d+$/.test(b) && !/^\d+$/.test(d)) {
      return buildProxyDict("http", a, b, c, d);
    }
    if (/^\d+$/.test(d) && !/^\d+$/.test(b)) {
      return buildProxyDict("http", c, d, a, b);
    }
  }

  // Split patterns: host:port user:pass, host:port|user:pass, etc.
  const splitPatterns = [
    /^(?<host>\[[^\]]+\]|[^:\s]+):(?<port>\d+)\s+(?<user>[^:\s]+):(?<password>\S+)$/,
    /^(?<host>\[[^\]]+\]|[^:\s]+):(?<port>\d+)\|(?<user>[^:\s]+):(?<password>\S+)$/,
    /^(?<host>\[[^\]]+\]|[^:\s]+):(?<port>\d+);(?<user>[^:\s]+):(?<password>\S+)$/,
    /^(?<host>\[[^\]]+\]|[^:\s]+):(?<port>\d+),(?<user>[^:\s]+):(?<password>\S+)$/,
  ];
  for (const pattern of splitPatterns) {
    match = line.match(pattern);
    if (match) {
      const g = match.groups!;
      return buildProxyDict("http", g.host, g.port, g.user, g.password);
    }
  }

  return null;
}

export function parseProxies(text: string): ProxyEntry[] {
  const proxies: ProxyEntry[] = [];
  for (const line of text.split("\n")) {
    const proxy = parseProxyLine(line);
    if (proxy) proxies.push(proxy);
  }
  return proxies;
}
