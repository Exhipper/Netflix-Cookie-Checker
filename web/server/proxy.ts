import type { ProxyEntry } from "./types.js";

export type ProxyFormatHint = "default" | "colon" | "space" | "json";

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
  if (!line || line.startsWith("#") || line.startsWith("//")) return null;

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

/** Parse colon-separated proxy tokens on a single line (ip:port:ip:port...). */
function parseColonLine(line: string): ProxyEntry[] {
  const proxies: ProxyEntry[] = [];
  const tokens = line.split(":");
  for (let i = 0; i < tokens.length - 1; i += 2) {
    const host = tokens[i]?.trim();
    const port = tokens[i + 1]?.trim();
    if (host && port && /^\d+$/.test(port)) {
      const proxy = buildProxyDict("http", host, port);
      proxies.push(proxy);
    }
  }
  return proxies;
}

/** Parse space-separated proxy tokens on a single line. */
function parseSpaceLine(line: string): ProxyEntry[] {
  const proxies: ProxyEntry[] = [];
  for (const token of line.split(/\s+/)) {
    const proxy = parseProxyLine(token);
    if (proxy) proxies.push(proxy);
  }
  return proxies;
}

export function parseProxies(text: string, hint: ProxyFormatHint = "default"): ProxyEntry[] {
  const proxies: ProxyEntry[] = [];
  const seen = new Set<string>();
  const dedupe = (entry: ProxyEntry) => {
    const key = entry.http || entry.https;
    if (seen.has(key)) return;
    seen.add(key);
    proxies.push(entry);
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;

    if (hint === "space") {
      for (const p of parseSpaceLine(line)) dedupe(p);
    } else if (hint === "colon") {
      for (const p of parseColonLine(line)) dedupe(p);
    } else {
      // Default: try standard line parsing first, then space tokens, then colon tokens.
      const standard = parseProxyLine(line);
      if (standard) {
        dedupe(standard);
      } else {
        const spaceParsed = parseSpaceLine(line);
        if (spaceParsed.length > 0) {
          for (const p of spaceParsed) dedupe(p);
        } else {
          for (const p of parseColonLine(line)) dedupe(p);
        }
      }
    }
  }
  return proxies;
}
