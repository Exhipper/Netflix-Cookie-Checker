import { ProxyAgent, fetch as undiciFetch } from "undici";
import { parseProxies } from "./proxy.js";
import type { ProxyEntry } from "./types.js";

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

const PROXY_LIST_URLS: string[] = [
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/all.txt",
  "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt",
];

const VALIDATION_TIMEOUT_MS = 8000;
const VALIDATION_URL = "https://httpbin.org/ip";
const REFETCH_INTERVAL_MS = 5 * 60 * 1000; // re-fetch every 5 min
const MAX_FAILURES = 3; // mark dead after 3 consecutive failures

let validatedPool: ValidatedProxy[] = [];
let currentIndex = 0;
let lastFetchTime = 0;
let isFetching = false;
let fetchTimer: NodeJS.Timeout | null = null;

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
    // Fallback: extract from the raw string
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

/** Validate a single proxy by making a test request through it. */
async function validateProxy(entry: ProxyEntry): Promise<ValidatedProxy | null> {
  const { ip, port, scheme } = extractIpPort(entry);
  if (!ip || ip === "unknown" || !port) return null;

  const key = `${ip}:${port}`;
  const proxyUrl = entry.https || entry.http;

  try {
    const dispatcher = new ProxyAgent(proxyUrl);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

    const response = await undiciFetch(VALIDATION_URL, {
      dispatcher,
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0" },
    });
    clearTimeout(timeoutId);

    if (response.ok) {
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

/** Fetch and validate proxies from the remote list URLs. */
export async function fetchAndValidateProxies(): Promise<ValidatedProxy[]> {
  if (isFetching) return validatedPool;
  isFetching = true;

  try {
    // Fetch all proxy lists in parallel
    const responses = await Promise.allSettled(
      PROXY_LIST_URLS.map((url) =>
        undiciFetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
          .then((r) => r.text())
          .catch(() => "")
      )
    );

    const allText = responses
      .map((r) => (r.status === "fulfilled" ? r.value : ""))
      .join("\n");

    const parsed = parseProxies(allText);
    if (parsed.length === 0) {
      console.warn("[proxy-manager] No proxies parsed from remote lists");
      return validatedPool;
    }

    console.log(`[proxy-manager] Parsed ${parsed.length} proxies, validating...`);

    // Validate in batches of 50 to avoid overwhelming the network
    const batchSize = 50;
    const validated: ValidatedProxy[] = [];

    for (let i = 0; i < parsed.length; i += batchSize) {
      const batch = parsed.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map((entry) => validateProxy(entry))
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) {
          validated.push(r.value);
        }
      }
      // Early exit if we have enough validated proxies
      if (validated.length >= 100) break;
    }

    console.log(`[proxy-manager] Validated ${validated.length} live proxies`);

    // Merge with existing pool: keep existing alive proxies, add new ones
    const existingKeys = new Set(validated.map((v) => v.key));
    const keepFromOld = validatedPool.filter((v) => v.alive && !existingKeys.has(v.key));
    validatedPool = [...validated, ...keepFromOld];
    lastFetchTime = Date.now();

    return validatedPool;
  } catch (err) {
    console.error("[proxy-manager] Fetch/validate error:", err);
    return validatedPool;
  } finally {
    isFetching = false;
  }
}

/** Start the auto-fetch background loop. */
export function startProxyAutoFetch(): void {
  if (fetchTimer) return;
  // Initial fetch
  fetchAndValidateProxies().catch((err) =>
    console.error("[proxy-manager] Initial fetch error:", err)
  );
  // Periodic refetch
  fetchTimer = setInterval(() => {
    fetchAndValidateProxies().catch((err) =>
      console.error("[proxy-manager] Periodic fetch error:", err)
    );
  }, REFETCH_INTERVAL_MS);
}

/** Stop the auto-fetch loop. */
export function stopProxyAutoFetch(): void {
  if (fetchTimer) {
    clearInterval(fetchTimer);
    fetchTimer = null;
  }
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
    lastFetch: lastFetchTime || null,
    isFetching,
  };
}

/** Get the next alive proxy in round-robin order. Marks dead proxies and rotates automatically. */
export function getNextProxy(): ValidatedProxy | null {
  if (validatedPool.length === 0) return null;

  const alive = validatedPool.filter((p) => p.alive);
  if (alive.length === 0) return null;

  // Round-robin through alive proxies
  const proxy = alive[currentIndex % alive.length];
  currentIndex = (currentIndex + 1) % alive.length;
  return proxy;
}

/** Mark a proxy as failed. After MAX_FAILURES, mark it as dead. */
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

/** Mark a proxy as successfully used (reset failure count). */
export function markProxySuccess(key: string): void {
  const proxy = validatedPool.find((p) => p.key === key);
  if (proxy) {
    proxy.failureCount = 0;
    proxy.lastChecked = Date.now();
  }
}

/** Get a dispatcher for a validated proxy, or null if it can't be created. */
export function getDispatcher(proxy: ValidatedProxy): ProxyAgent | null {
  return createDispatcher(proxy);
}

/**
 * Fetch a URL through a validated proxy. Automatically rotates to the next alive
 * proxy if the current one fails. Returns the response text, status, and the IP
 * of the proxy that was used.
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
      // No proxies available — fall back to direct fetch
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
        // Caller cancelled — don't retry
        return { text: "", status: 0, proxyIp: proxy.ip, proxyKey: proxy.key };
      }
      // Try next proxy
      continue;
    }
  }

  // All proxies exhausted — fall back to direct
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

/** Trigger an immediate proxy refetch. */
export async function refreshProxies(): Promise<{ fetched: number; alive: number }> {
  await fetchAndValidateProxies();
  return {
    fetched: validatedPool.length,
    alive: validatedPool.filter((p) => p.alive).length,
  };
}
