export interface RunStats {
  hits: number;
  free: number;
  bad: number;
  duplicate: number;
  on_hold: number;
  errors: number;
}

export interface PlanCount {
  [key: string]: number;
}

export interface ProgressUpdate {
  type: "connected" | "progress" | "result" | "complete" | "error";
  runId?: string;
  status?: string;
  planKey?: string;
  planName?: string;
  country?: string;
  email?: string;
  reason?: string;
  onHold?: boolean;
  processed?: number;
  total?: number;
  left?: number;
  counts?: RunStats;
  planCounts?: PlanCount;
  accountInfo?: any;
  cookieContent?: string;
  formattedOutput?: string;
  nfTokenData?: { token: string; expires_at_utc: string } | null;
  message?: string;
  /** IP address of the proxy used for this check, or null if direct. */
  proxyIp?: string | null;
}

export interface RunRecord {
  id: string;
  started_at: string;
  completed_at: string | null;
  total_cookies: number;
  hits: number;
  free: number;
  bad: number;
  duplicate: number;
  on_hold: number;
  errors: number;
  status: string;
  config: any;
}

export interface ResultRecord {
  id: number;
  run_id: string;
  checked_at: string;
  last_verified_at: string;
  status: string;
  plan_key: string | null;
  plan_name: string | null;
  country: string | null;
  email: string | null;
  reason: string | null;
  on_hold: boolean;
  account_info: any;
  cookie_content: string | null;
  formatted_output: string | null;
  nftoken_data: any;
  proxy_ip: string | null;
}

export interface GenerationHistoryRecord {
  id: number;
  result_id: number;
  generated_at: string;
  was_live: boolean;
  status: string;
  plan_key: string | null;
  plan_name: string | null;
  country: string | null;
  email: string | null;
  reason: string | null;
  account_info: any;
  proxy_ip: string | null;
}

export interface AppConfig {
  txt_fields: Record<string, boolean>;
  nftoken: string | boolean;
  add_emojis: string;
  notifications: {
    webhook: {
      enabled: boolean;
      url: string;
      mode: string;
      plans: string | string[];
    };
    telegram: {
      enabled: boolean;
      bot_token: string;
      chat_id: string;
      mode: string;
      plans: string | string[];
    };
  };
  display: { mode: string };
  retries: {
    error_proxy_attempts: number;
    nftoken_attempts: number;
  };
  performance: {
    request_timeout_seconds: number;
    fallback_account_page: boolean;
    retry_incomplete_info: boolean;
    nftoken_for_free: boolean;
  };
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

export async function startCheck(
  cookies: Array<{ name: string; content: string }>,
  proxies: string,
  config: Partial<AppConfig>,
  threads: number
): Promise<{ runId: string; total: number; threads: number }> {
  const res = await fetch(`${API_BASE}/api/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cookies, proxies, config, threads }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed to start check" }));
    throw new Error(err.error || "Failed to start check");
  }
  return res.json();
}

export function subscribeToRun(
  runId: string,
  onUpdate: (update: ProgressUpdate) => void
): EventSource {
  const es = new EventSource(`${API_BASE}/api/check/${runId}/stream`);
  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as ProgressUpdate;
      onUpdate(data);
    } catch {
      // ignore parse errors
    }
  };
  return es;
}

/** Check if a run is still active on the server (for reconnect support). */
export async function getRunStatus(runId: string): Promise<{ active: boolean; progress: ProgressUpdate | null }> {
  const res = await fetch(`${API_BASE}/api/check/${runId}/status`);
  if (!res.ok) throw new Error("Failed to fetch run status");
  return res.json();
}

export async function cancelRun(runId: string): Promise<void> {
  await fetch(`${API_BASE}/api/check/${runId}/cancel`, { method: "POST" });
}

export async function getRuns(): Promise<RunRecord[]> {
  const res = await fetch(`${API_BASE}/api/runs`);
  if (!res.ok) throw new Error("Failed to fetch runs");
  return res.json();
}

export async function getRun(runId: string): Promise<RunRecord> {
  const res = await fetch(`${API_BASE}/api/runs/${runId}`);
  if (!res.ok) throw new Error("Failed to fetch run");
  return res.json();
}

export async function getRunResults(
  runId: string,
  limit = 100,
  offset = 0,
  status?: string
): Promise<ResultRecord[]> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (status && status !== "all") params.set("status", status);
  const res = await fetch(`${API_BASE}/api/runs/${runId}/results?${params}`);
  if (!res.ok) throw new Error("Failed to fetch results");
  return res.json();
}

export async function deleteRun(runId: string): Promise<void> {
  await fetch(`${API_BASE}/api/runs/${runId}`, { method: "DELETE" });
}

export async function getStats(): Promise<any> {
  const res = await fetch(`${API_BASE}/api/stats`);
  if (!res.ok) throw new Error("Failed to fetch stats");
  return res.json();
}

export async function getDefaultConfig(): Promise<AppConfig> {
  const res = await fetch(`${API_BASE}/api/config`);
  if (!res.ok) throw new Error("Failed to fetch config");
  return res.json();
}

export async function checkHealth(): Promise<{ status: string; database: string; healthMonitor?: { running: boolean; intervalHours: number; nextRunAt: number | null; lastRunAt: number | null } }> {
  const res = await fetch(`${API_BASE}/api/health`);
  if (!res.ok) throw new Error("Health check failed");
  return res.json();
}

/** Recheck all stored hits in the database. */
export async function recheckHits(
  proxies: string,
  config: Partial<AppConfig>,
  threads: number
): Promise<{ runId: string; total: number; threads: number; recheck: boolean }> {
  const res = await fetch(`${API_BASE}/api/recheck`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proxies, config, threads }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed to start recheck" }));
    throw new Error(err.error || "Failed to start recheck");
  }
  return res.json();
}

/** Get count of stored hits available for recheck. */
export async function getRecheckCount(): Promise<{ count: number }> {
  const res = await fetch(`${API_BASE}/api/recheck/count`);
  if (!res.ok) throw new Error("Failed to fetch recheck count");
  return res.json();
}

/** Generate a single account from a random stored hit, recheck it, and return full details. */
export async function generateAccount(
  proxies: string,
  config: Partial<AppConfig>,
  threads: number,
  excludeId?: number,
  country?: string,
  plan?: string
): Promise<GeneratedAccount> {
  const res = await fetch(`${API_BASE}/api/generate-account`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proxies, config, threads, excludeId, country, plan }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed to generate account" }));
    throw new Error(err.error || "Failed to generate account");
  }
  return res.json();
}

/** Recheck a single stored hit by ID. */
export async function recheckHit(
  id: number,
  proxies: string,
  config: Partial<AppConfig>,
  threads: number,
  autoDelete: boolean
): Promise<{ id: number; isLive: boolean; status: string; reason?: string; autoDeleted: boolean }> {
  const res = await fetch(`${API_BASE}/api/recheck/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proxies, config, threads, autoDelete }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed to recheck hit" }));
    throw new Error(err.error || "Failed to recheck hit");
  }
  return res.json();
}

/** Get country breakdown of all hits. */
export async function getCountryBreakdown(): Promise<Array<{ country: string; count: number; hits: number; free: number }>> {
  const res = await fetch(`${API_BASE}/api/country-breakdown`);
  if (!res.ok) throw new Error("Failed to fetch country breakdown");
  return res.json();
}

/** Get hit logs (recent stored cookie hits). */
export async function getHitLogs(limit = 50, offset = 0): Promise<{ logs: ResultRecord[]; total: number }> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const res = await fetch(`${API_BASE}/api/hit-logs?${params}`);
  if (!res.ok) throw new Error("Failed to fetch hit logs");
  return res.json();
}

/** Search and filter hit logs by country, plan, or email. */
export async function searchHitLogs(
  filters: {
    country?: string;
    plan?: string;
    email?: string;
    limit?: number;
    offset?: number;
  }
): Promise<{ logs: ResultRecord[]; total: number }> {
  const params = new URLSearchParams();
  if (filters.country && filters.country !== "all") params.set("country", filters.country);
  if (filters.plan && filters.plan !== "all") params.set("plan", filters.plan);
  if (filters.email && filters.email.trim() !== "") params.set("email", filters.email.trim());
  params.set("limit", String(filters.limit || 50));
  params.set("offset", String(filters.offset || 0));
  const res = await fetch(`${API_BASE}/api/hit-logs/search?${params}`);
  if (!res.ok) throw new Error("Failed to search hit logs");
  return res.json();
}

/** Get filter options for hit logs. */
export async function getHitLogFilters(): Promise<{ countries: string[]; plans: string[] }> {
  const res = await fetch(`${API_BASE}/api/hit-logs/filters`);
  if (!res.ok) throw new Error("Failed to fetch hit log filters");
  return res.json();
}

/** Deduplicate hits - auto delete duplicate cookies. */
export async function deduplicateHits(): Promise<{ deleted: number }> {
  const res = await fetch(`${API_BASE}/api/deduplicate`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to deduplicate");
  return res.json();
}

/** Get a single result by ID. */
export async function getResultById(id: number): Promise<ResultRecord> {
  const res = await fetch(`${API_BASE}/api/results/${id}`);
  if (!res.ok) throw new Error("Failed to fetch result");
  return res.json();
}

/** Subscribe to global dashboard update events. */
export function subscribeToDashboardEvents(
  onUpdate: () => void,
  onError?: (err: Event) => void
): EventSource {
  const es = new EventSource(`${API_BASE}/api/events`);
  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "dashboard-update") {
        onUpdate();
      }
    } catch {
      // ignore parse errors
    }
  };
  if (onError) {
    es.onerror = onError;
  }
  return es;
}

/** Get stale hits count. */
export async function getStaleHits(days = 7): Promise<{ count: number; days: number }> {
  const params = new URLSearchParams({ days: String(days) });
  const res = await fetch(`${API_BASE}/api/stale-hits?${params}`);
  if (!res.ok) throw new Error("Failed to fetch stale hits");
  return res.json();
}

/** Cleanup stale hits. */
export async function cleanupStaleHits(days = 7, autoDelete = true): Promise<{
  runId: string;
  checked: number;
  live: number;
  dead: number;
  deleted: number;
  errors: number;
  completedAt: string;
}> {
  const res = await fetch(`${API_BASE}/api/stale-hits/cleanup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ days, autoDelete }),
  });
  if (!res.ok) throw new Error("Failed to cleanup stale hits");
  return res.json();
}

/** Get account generation history. */
export async function getGenerationHistory(limit = 50, offset = 0): Promise<{ history: GenerationHistoryRecord[]; total: number }> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const res = await fetch(`${API_BASE}/api/generation-history?${params}`);
  if (!res.ok) throw new Error("Failed to fetch generation history");
  return res.json();
}

/** Get health monitor status. */
export async function getHealthMonitorStatus(): Promise<{ status: { running: boolean; intervalHours: number; nextRunAt: number | null; lastRunAt: number | null } }> {
  const res = await fetch(`${API_BASE}/api/health-monitor`);
  if (!res.ok) throw new Error("Failed to fetch health monitor status");
  return res.json();
}

/** Configure health monitor. */
export async function configureHealthMonitor(
  enabled: boolean,
  intervalHours: number,
  deleteDeadCookies: boolean,
  threads: number
): Promise<{ status: { running: boolean; intervalHours: number } }> {
  const res = await fetch(`${API_BASE}/api/health-monitor`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled, intervalHours, deleteDeadCookies, threads }),
  });
  if (!res.ok) throw new Error("Failed to configure health monitor");
  return res.json();
}

/** Run health monitor once immediately. */
export async function runHealthCheckNow(deleteDeadCookies = true, threads = 30): Promise<{
  runId: string;
  checked: number;
  live: number;
  dead: number;
  deleted: number;
  errors: number;
  completedAt: string;
}> {
  const res = await fetch(`${API_BASE}/api/health-monitor/run-now`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deleteDeadCookies, threads }),
  });
  if (!res.ok) throw new Error("Failed to run health check");
  return res.json();
}

/** Fetch NFToken for a stored hit by ID (generates on-demand if not cached). */
export async function fetchNfToken(
  id: number
): Promise<{ nftoken: { token: string; expires_at_utc: string } | null; links: Array<[string, string]>; cached: boolean }> {
  const res = await fetch(`${API_BASE}/api/nftoken/${id}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed to fetch NFToken" }));
    throw new Error(err.error || "Failed to fetch NFToken");
  }
  return res.json();
}

export interface GeneratedAccount {
  runId: string;
  storedHitId: number;
  result: {
    status: string;
    planKey?: string;
    planName?: string;
    country?: string;
    email?: string;
    reason?: string;
    onHold?: boolean;
    accountInfo?: Record<string, any>;
    cookieContent?: string;
    formattedOutput?: string;
    nfTokenData?: { token: string; expires_at_utc: string } | null;
    nfTokenLinks?: Array<[string, string]>;
    isLive: boolean;
    proxyIp?: string | null;
  };
}
