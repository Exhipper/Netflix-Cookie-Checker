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

export async function checkHealth(): Promise<{ status: string; database: string }> {
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
  threads: number
): Promise<GeneratedAccount> {
  const res = await fetch(`${API_BASE}/api/generate-account`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proxies, config, threads }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed to generate account" }));
    throw new Error(err.error || "Failed to generate account");
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

export interface GeneratedAccount {
  runId: string;
  result: {
    status: string;
    planKey?: string;
    planName?: string;
    country?: string;
    email?: string;
    reason?: string;
    onHold?: boolean;
    accountInfo?: any;
    cookieContent?: string;
    formattedOutput?: string;
    nfTokenData?: { token: string; expires_at_utc: string } | null;
    nfTokenLinks?: Array<[string, string]>;
    isLive: boolean;
  };
}
