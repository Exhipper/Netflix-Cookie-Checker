import { ProxyAgent, fetch as undiciFetch } from "undici";
import { parseProxies, type ProxyFormatHint } from "./proxy.js";
import type { ProxyEntry } from "./types.js";

const PROXY_AUTO_FETCH_DISABLED = process.env.DISABLE_PROXY_FETCH === "true";
const PROXY_DEBUG_LOGS = process.env.PROXY_DEBUG_LOGS === "true";

export interface ValidatedProxy {
  entry: ProxyEntry;
  ip: string;
  port: number;
  scheme: string;
  alive: boolean;
  lastChecked: number;
  failureCount: number;
  /** Host:port string used as a unique key. */
  key: string;
}

interface ProxySource {
  url: string;
  /** Refresh interval in hours. Staggered so sources refresh at different times. */
  intervalHours: number;
  /** How to parse the proxy list body. */
  formatHint?: ProxyFormatHint;
  enabled: boolean;
}

const VALIDATION_TIMEOUT_MS = 5000; // shorter — free proxies are fast or dead
const VALIDATION_URLS = [
  "https://api.ipify.org?format=json",
  "https://ifconfig.me/ip",
  "https://api64.ipify.org?format=text",
  "http://ip-api.com/json",
];
const MAX_FAILURES = 3; // mark dead after 3 consecutive failures
const TARGET_VALIDATED = 200; // stop validating once we have enough live proxies

// Memory-safe tuning: free proxy lists can be huge, so we cap everything.
const FETCH_CONCURRENCY = 8; // fetch sources in batches
const MAX_SOURCE_BODY_BYTES = 1024 * 1024; // 1 MB cap per source response
const MAX_ENTRIES_PER_SOURCE = 200; // parse at most this many proxies from one source
const MAX_TOTAL_PARSED = 6000; // total unique candidates to validate across all sources
const VALIDATION_CONCURRENCY = 50; // higher concurrency for faster validation
const MAX_POOL_SIZE = 500; // keep the validated pool from growing forever

let validatedPool: ValidatedProxy[] = [];
let currentIndex = 0;
let isFetching = false;
let sourceTimers: Map<string, NodeJS.Timeout> = new Map();
const textDecoder = new TextDecoder();

/** Expand date templates in proxy URLs (e.g. {YYYY}, {MM}, {DD}, {HH/4}). */
function expandDateTemplates(url: string): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  const hour = now.getUTCHours();
  const hourBlock = Math.floor(hour / 4) * 4;

  const pad2 = (n: number) => String(n).padStart(2, "0");

  return url
    .replace(/\{YYYY\}/g, String(year))
    .replace(/\{YY\}/g, String(year).slice(-2))
    .replace(/\{MM\}/g, pad2(month))
    .replace(/\{M\}/g, String(month))
    .replace(/\{DD\}/g, pad2(day))
    .replace(/\{D\}/g, String(day))
    .replace(/\{HH\}/g, pad2(hour))
    .replace(/\{H\}/g, String(hour))
    .replace(/\{HH\/4\}/g, pad2(hourBlock));
}

// Proxy sources with staggered refresh intervals. Free GitHub proxy lists change
// frequently; if most sources fail, set DISABLE_PROXY_FETCH=true in .env to run
// checks directly from your server IP.
const PROXY_SOURCES: ProxySource[] = [
  // High-volume / actively maintained HTTP/HTTPS lists
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/all.txt", intervalHours: 1, enabled: true },
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt", intervalHours: 1, enabled: true },
  { url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt", intervalHours: 1, enabled: true },
  { url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt", intervalHours: 1, enabled: true },
  { url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/https/data.txt", intervalHours: 1, enabled: true },
  { url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt", intervalHours: 1, enabled: true },
  { url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/ProxyScrape/free-proxy-list/main/proxies.txt", intervalHours: 1, enabled: true },
  // Smaller, frequently-updated lists
  { url: "https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/refs/heads/main/http_all.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/naravid19/checked-proxies/main/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/ClearProxy/checked-proxy-list/main/proxies.txt", intervalHours: 2, enabled: true },
  // Reliable proxy APIs (usually online even when GitHub raw URLs are blocked)
  { url: "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&proxy_format=ipport&format=text&timeout=20000", intervalHours: 2, enabled: true },
  { url: "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=https&proxy_format=ipport&format=text&timeout=20000", intervalHours: 2, enabled: true },
  { url: "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=socks4&proxy_format=ipport&format=text&timeout=20000", intervalHours: 3, enabled: false },
  { url: "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=socks5&proxy_format=ipport&format=text&timeout=20000", intervalHours: 3, enabled: false },
];

/** Extract IP and port from a ProxyEntry. */
function extractIpPort(entry: ProxyEntry): { ip: string; port: number; scheme: string } {
  const url = entry.https || entry.http;
  try {
    const parsed = new URL(url);
    return {
      ip: parsed.hostname.replace(/^\[|\]$/g, ""),
      port: parseInt(parsed.port, 10) || 0,
      scheme: parsed.protocol.replace(":", ""),
    };
  } catch {
    const match = url.match(/^(?:(\w+):\/\/)?(?:[^@]*@)?\[?([^\]:]+)\]?:(\d+)/);
    if (match) {
      return { ip: match[2], port: parseInt(match[3], 10), scheme: match[1] || "http" };
    }
    return { ip: "unknown", port: 0, scheme: "http" };
  }
}

/** Build a dispatcher (ProxyAgent) for a validated proxy. */
function createDispatcher(proxy: ValidatedProxy): ProxyAgent | null {
  try {
    const proxyUrl = proxy.entry.https || proxy.entry.http;
    return new ProxyAgent(proxyUrl);
  } catch {
    return null;
  }
}

/** Validate a single proxy by making a test request through it. Rotates validation endpoints to avoid rate limits. */
async function validateProxy(entry: ProxyEntry): Promise<ValidatedProxy | null> {
  const { ip, port, scheme } = extractIpPort(entry);
  if (!ip || ip === "unknown" || !port) return null;

  const key = `${ip}:${port}`;
  const proxyUrl = entry.https || entry.http;
  const validationUrl = VALIDATION_URLS[Math.floor(Math.random() * VALIDATION_URLS.length)];

  try {
    const dispatcher = new ProxyAgent(proxyUrl);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

    const response = await undiciFetch(validationUrl, {
      dispatcher,
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0" },
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      // Consume the body so the connection can be reused
      await response.text().catch(() => {});
      return {
        entry,
        ip,
        port,
        scheme,
        alive: true,
        lastChecked: Date.now(),
        failureCount: 0,
        key,
      } as ValidatedProxy;
    }
    return null;
  } catch {
    return null;
  }
}

/** Validate a list of proxy entries using a worker pool with limited concurrency. Stops once target count is reached. */
async function validateWithConcurrency(
  entries: ProxyEntry[],
  concurrency: number,
  target: number
): Promise<ValidatedProxy[]> {
  const validated: ValidatedProxy[] = [];
  const inFlight = new Set<Promise<void>>();
  let queueIndex = 0;

  const spawnNext = () => {
    if (queueIndex >= entries.length || validated.length >= target) return;
    const entry = entries[queueIndex++];
    const promise = validateProxy(entry).then((result) => {
      if (result && validated.length < target) {
        validated.push(result);
      }
    }).finally(() => {
      inFlight.delete(promise);
      spawnNext();
    });
    inFlight.add(promise);
  };

  // Seed the worker pool
  const seedCount = Math.min(concurrency, entries.length);
  for (let i = 0; i < seedCount; i++) spawnNext();

  await Promise.all(inFlight);
  return validated;
}

/** Fetch a single proxy source and return parsed entries. Response body is streamed with a byte cap. */
async function fetchSource(source: ProxySource): Promise<ProxyEntry[]> {
  const url = expandDateTemplates(source.url);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await undiciFetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0" },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      if (PROXY_DEBUG_LOGS) console.warn(`[proxy-manager] Source failed ${response.status}: ${url}`);
      return [];
    }

    if (!response.body) {
      const text = await response.text();
      return parseProxies(text, source.formatHint || "default", MAX_ENTRIES_PER_SOURCE);
    }

    const reader = response.body.getReader();
    let buffer = "";
    let readBytes = 0;
    let done = false;

    while (!done && readBytes < MAX_SOURCE_BODY_BYTES) {
      const { value, done: d } = await reader.read();
      done = d || false;
      if (value && value.length > 0) {
        readBytes += value.byteLength;
        buffer += textDecoder.decode(value, { stream: !done });
      }
    }

    if (!done) {
      reader.cancel().catch(() => {});
    }
    // Flush any remaining decoder state
    buffer += textDecoder.decode();

    return parseProxies(buffer, source.formatHint || "default", MAX_ENTRIES_PER_SOURCE);
  } catch (err: any) {
    if (PROXY_DEBUG_LOGS) {
      if (err?.name === "AbortError") {
        console.warn(`[proxy-manager] Source timeout: ${url}`);
      } else {
        console.warn(`[proxy-manager] Source error: ${url}`, err?.message || err);
      }
    }
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Fetch and validate proxies from all enabled remote sources, throttled and capped. */
export async function fetchAndValidateProxies(): Promise<ValidatedProxy[]> {
  if (isFetching) return validatedPool;
  isFetching = true;

  try {
    const enabledSources = PROXY_SOURCES.filter((s) => s.enabled);
    const allEntries: ProxyEntry[] = [];
    const seenKeys = new Set<string>();
    let failedSources = 0;
    let emptySources = 0;

    for (let i = 0; i < enabledSources.length; i += FETCH_CONCURRENCY) {
      const batch = enabledSources.slice(i, i + FETCH_CONCURRENCY);
      const results = await Promise.allSettled(batch.map((source) => fetchSource(source)));

      for (let j = 0; j < batch.length; j++) {
        const result = results[j];
        if (result.status === "rejected") {
          failedSources++;
          if (PROXY_DEBUG_LOGS) console.warn(`[proxy-manager] Failed source ${batch[j].url}: ${result.reason}`);
          continue;
        }
        if (result.value.length === 0) {
          emptySources++;
          continue;
        }
        for (const entry of result.value) {
          if (allEntries.length >= MAX_TOTAL_PARSED) break;
          const { ip, port } = extractIpPort(entry);
          const key = `${ip}:${port}`;
          if (!key || key.includes("unknown") || seenKeys.has(key)) continue;
          seenKeys.add(key);
          allEntries.push(entry);
        }
      }

      if (allEntries.length >= MAX_TOTAL_PARSED) break;
    }

    const healthySources = enabledSources.length - failedSources - emptySources;
    if (failedSources + emptySources > 0) {
      console.log(`[proxy-manager] Sources: ${healthySources} returned proxies, ${failedSources} failed, ${emptySources} empty.`);
    }

    if (allEntries.length === 0) {
      console.warn("[proxy-manager] No proxies parsed from remote sources. Set DISABLE_PROXY_FETCH=true to run checks directly.");
      return validatedPool;
    }

    console.log(`[proxy-manager] Parsed ${allEntries.length} unique proxy candidates, validating with ${VALIDATION_CONCURRENCY} threads...`);

    const validated = await validateWithConcurrency(allEntries, VALIDATION_CONCURRENCY, TARGET_VALIDATED);

    console.log(`[proxy-manager] Validated ${validated.length} live proxies`);

    const existingKeys = new Set(validated.map((v) => v.key));
    validatedPool = [...validated, ...validatedPool.filter((v) => v.alive && !existingKeys.has(v.key))];
    prunePool();

    return validatedPool;
  } catch (err) {
    console.error("[proxy-manager] Fetch/validate error:", err);
    return validatedPool;
  } finally {
    isFetching = false;
  }
}

/** Keep only alive proxies and cap total pool size. */
function prunePool(): void {
  validatedPool = validatedPool
    .filter((p) => p.alive)
    .sort((a, b) => b.lastChecked - a.lastChecked)
    .slice(0, MAX_POOL_SIZE);
}

/** Schedule a single source to refresh at its configured interval. */
function scheduleSource(source: ProxySource): void {
  if (!source.enabled) return;
  const url = expandDateTemplates(source.url);
  const intervalMs = source.intervalHours * 60 * 60 * 1000;
  const jitter = Math.floor(Math.random() * Math.min(intervalMs, 5 * 60 * 1000)); // up to 5 min jitter

  const run = async () => {
    try {
      const needed = Math.max(0, TARGET_VALIDATED - validatedPool.filter((p) => p.alive).length);
      if (needed <= 0) return;

      const entries = await fetchSource(source);
      if (entries.length === 0) return;

      const existingKeys = new Set(validatedPool.map((p) => p.key));
      const newEntries = entries
        .map((e) => {
          const { ip, port } = extractIpPort(e);
          return { key: `${ip}:${port}`, entry: e };
        })
        .filter((e) => e.key && !e.key.includes("unknown") && !existingKeys.has(e.key))
        .map((e) => e.entry)
        .slice(0, MAX_ENTRIES_PER_SOURCE);

      if (newEntries.length === 0) return;

      const validated = await validateWithConcurrency(newEntries, VALIDATION_CONCURRENCY, needed);
      const newKeys = new Set(validated.map((v) => v.key));
      validatedPool = [...validatedPool.filter((p) => p.alive && !newKeys.has(p.key)), ...validated];
      prunePool();
      console.log(`[proxy-manager] Source ${url} added ${validated.length} live proxies (needed ${needed})`);
    } catch (err) {
      console.error(`[proxy-manager] Scheduled source error ${url}:`, err);
    } finally {
      sourceTimers.set(url, setTimeout(run, intervalMs));
    }
  };

  // Wait a full interval before the first scheduled refresh to avoid a startup burst.
  sourceTimers.set(url, setTimeout(run, intervalMs + jitter));
}

/** Start the auto-fetch background loop. Each source refreshes on its own schedule. */
export function startProxyAutoFetch(): void {
  if (PROXY_AUTO_FETCH_DISABLED) {
    console.log("[proxy-manager] Auto-fetch disabled (DISABLE_PROXY_FETCH=true). Checks will run directly from your server IP.");
    return;
  }
  if (sourceTimers.size > 0) return;

  // Initial bulk fetch is throttled and memory-capped.
  fetchAndValidateProxies().catch((err) =>
    console.error("[proxy-manager] Initial fetch error:", err)
  );

  // Schedule individual source refreshes with staggered intervals.
  for (const source of PROXY_SOURCES) {
    scheduleSource(source);
  }
}

/** Stop all auto-fetch loops. */
export function stopProxyAutoFetch(): void {
  for (const timer of sourceTimers.values()) {
    clearTimeout(timer);
  }
  sourceTimers.clear();
}

/** Get the current proxy pool status. */
export function getProxyPoolStatus(): {
  total: number;
  alive: number;
  dead: number;
  lastFetch: number | null;
  isFetching: boolean;
} {
  return {
    total: validatedPool.length,
    alive: validatedPool.filter((p) => p.alive).length,
    dead: validatedPool.filter((p) => !p.alive).length,
    lastFetch: validatedPool.length > 0 ? Math.max(...validatedPool.map((p) => p.lastChecked)) : null,
    isFetching,
  };
}

/** Get the next alive proxy in round-robin order. */
export function getNextProxy(): ValidatedProxy | null {
  if (validatedPool.length === 0) return null;

  const alive = validatedPool.filter((p) => p.alive);
  if (alive.length === 0) return null;

  const proxy = alive[currentIndex % alive.length];
  currentIndex = (currentIndex + 1) % alive.length;
  return proxy;
}

/** Mark a proxy as failed. */
export function markProxyFailed(key: string): void {
  const proxy = validatedPool.find((p) => p.key === key);
  if (proxy) {
    proxy.failureCount++;
    if (proxy.failureCount >= MAX_FAILURES) {
      proxy.alive = false;
      console.log(`[proxy-manager] Proxy ${key} marked dead after ${proxy.failureCount} failures`);
    }
  }
}

/** Mark a proxy as successfully used. */
export function markProxySuccess(key: string): void {
  const proxy = validatedPool.find((p) => p.key === key);
  if (proxy) {
    proxy.failureCount = 0;
    proxy.lastChecked = Date.now();
  }
}

/** Get a dispatcher for a validated proxy. */
export function getDispatcher(proxy: ValidatedProxy): ProxyAgent | null {
  return createDispatcher(proxy);
}

/**
 * Fetch a URL through a validated proxy. Automatically rotates to the next alive
 * proxy if the current one fails.
 */
export async function fetchThroughProxy(
  url: string,
  options: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
    maxProxyRetries?: number;
  } = {}
): Promise<{ text: string; status: number; proxyIp: string | null; proxyKey: string | null }> {
  const maxRetries = options.maxProxyRetries ?? 5;
  const timeoutMs = options.timeoutMs ?? 15000;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const proxy = getNextProxy();
    if (!proxy) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        if (options.signal) {
          options.signal.addEventListener("abort", () => controller.abort(), { once: true });
        }
        const response = await undiciFetch(url, {
          method: "GET",
          headers: options.headers || {},
          signal: controller.signal,
          redirect: "manual" as any,
        });
        clearTimeout(timeoutId);
        const text = await response.text();
        return { text, status: response.status, proxyIp: null, proxyKey: null };
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return { text: "", status: 0, proxyIp: null, proxyKey: null };
        }
        throw err;
      }
    }

    const dispatcher = createDispatcher(proxy);
    if (!dispatcher) {
      markProxyFailed(proxy.key);
      continue;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      if (options.signal) {
        options.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }

      const response = await undiciFetch(url, {
        method: "GET",
        headers: options.headers || {},
        signal: controller.signal,
        dispatcher,
        redirect: "manual" as any,
      });
      clearTimeout(timeoutId);

      const text = await response.text();
      markProxySuccess(proxy.key);
      return { text, status: response.status, proxyIp: proxy.ip, proxyKey: proxy.key };
    } catch (err: any) {
      markProxyFailed(proxy.key);
      if (err?.name === "AbortError" && options.signal?.aborted) {
        return { text: "", status: 0, proxyIp: proxy.ip, proxyKey: proxy.key };
      }
      continue;
    }
  }

  // All proxies exhausted
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    if (options.signal) {
      options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const response = await undiciFetch(url, {
      method: "GET",
      headers: options.headers || {},
      signal: controller.signal,
      redirect: "manual" as any,
    });
    clearTimeout(timeoutId);
    const text = await response.text();
    return { text, status: response.status, proxyIp: null, proxyKey: null };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { text: "", status: 0, proxyIp: null, proxyKey: null };
    }
    return { text: "", status: 0, proxyIp: null, proxyKey: null };
  }
}

/** Trigger an immediate proxy refetch across all sources. */
export async function refreshProxies(): Promise<{ fetched: number; alive: number }> {
  await fetchAndValidateProxies();
  return {
    fetched: validatedPool.length,
    alive: validatedPool.filter((p) => p.alive).length,
  };
}
