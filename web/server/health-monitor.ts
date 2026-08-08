import { runCheck } from "./checker.js";
import {
  getAllHitsResults,
  countAllHitsResults,
  createRun,
  deleteResultById,
  getRunResults,
  getStaleHits,
  notifyDashboardUpdate,
} from "./db.js";
import { mergeConfig, DEFAULT_CONFIG } from "./config.js";
import { fetchAndValidateProxies, getProxyPoolStatus } from "./proxy-manager.js";
import type { AppConfig, ProgressUpdate } from "./types.js";

export interface HealthMonitorOptions {
  /** Interval in hours between automatic health checks. 0 disables monitoring. */
  intervalHours: number;
  /** Delete hits that are dead after recheck. */
  deleteDeadCookies: boolean;
  /** Max concurrent threads for health checks. */
  threads: number;
  /** Callback when a health check run completes. */
  onComplete?: (summary: HealthMonitorSummary) => void;
  /** Callback when an error occurs. */
  onError?: (error: string) => void;
}

export interface HealthMonitorSummary {
  runId: string;
  checked: number;
  live: number;
  dead: number;
  deleted: number;
  errors: number;
  completedAt: string;
}

let monitorInterval: NodeJS.Timeout | null = null;
let isRunning = false;
let lastRunAt: number | null = null;
let nextRunAt: number | null = null;

export function startHealthMonitor(options: HealthMonitorOptions): void {
  stopHealthMonitor();
  if (!options.intervalHours || options.intervalHours <= 0) return;

  const intervalMs = options.intervalHours * 60 * 60 * 1000;
  nextRunAt = Date.now() + intervalMs;

  scheduleRun(options);
  monitorInterval = setInterval(() => {
    nextRunAt = Date.now() + intervalMs;
    scheduleRun(options);
  }, intervalMs);
}

export function stopHealthMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  nextRunAt = null;
}

export function isHealthMonitorRunning(): boolean {
  return monitorInterval !== null || isRunning;
}

export function getHealthMonitorStatus(): {
  running: boolean;
  intervalHours: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
} {
  return {
    running: monitorInterval !== null,
    intervalHours: 24,
    nextRunAt,
    lastRunAt,
  };
}

async function scheduleRun(options: HealthMonitorOptions): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  lastRunAt = Date.now();
  try {
    await runHealthCheck(options);
  } catch (err: any) {
    options.onError?.(String(err?.message || err));
  } finally {
    isRunning = false;
  }
}

export async function runHealthCheck(
  options: HealthMonitorOptions
): Promise<HealthMonitorSummary> {
  const total = await countAllHitsResults();
  if (total === 0) {
    return {
      runId: "",
      checked: 0,
      live: 0,
      dead: 0,
      deleted: 0,
      errors: 0,
      completedAt: new Date().toISOString(),
    };
  }

  // Ensure proxies are available before running health checks
  const poolStatus = getProxyPoolStatus();
  if (poolStatus.alive === 0) {
    console.log("[health-monitor] No alive proxies, fetching...");
    await fetchAndValidateProxies().catch(() => {});
  }

  const hits = await getAllHitsResults(5000, 0);
  const runId = crypto.randomUUID();
  const config = mergeConfig(
    DEFAULT_CONFIG,
    { performance: { request_timeout_seconds: 20 } } as Partial<AppConfig>
  );
  const threadCount = Math.min(Math.max(options.threads || 30, 1), 300);

  await createRun(runId, hits.length, config).catch(() => {});

  let errors = 0;

  const cookies = hits.map((r) => ({
    name: r.email || `result_${r.id}`,
    content: r.cookie_content!,
    resultId: r.id,
  }));

  try {
    await runCheck({
      config,
      cookies,
      proxies: [],
      threadCount,
      runId,
      onProgress: (update: ProgressUpdate) => {
        if (update.type === "error") {
          errors++;
        }
      },
    });
  } catch (err: any) {
    errors++;
    options.onError?.(String(err?.message || err));
  }

  // After recheck, all hits were upserted by email. Find rows tied to this run that are dead.
  const recheckedResults = await getRunResults(runId, 5000, 0);
  const deadResults = recheckedResults.filter(
    (r) => r.status !== "success"
  );
  let deleted = 0;

  if (options.deleteDeadCookies) {
    for (const dead of deadResults) {
      await deleteResultById(dead.id).catch(() => {});
      deleted++;
    }
  }

  notifyDashboardUpdate();

  const summary: HealthMonitorSummary = {
    runId,
    checked: hits.length,
    live: recheckedResults.length - deadResults.length,
    dead: deadResults.length,
    deleted,
    errors,
    completedAt: new Date().toISOString(),
  };
  options.onComplete?.(summary);
  return summary;
}

export async function cleanupStaleHits(
  staleDays: number,
  deleteDeadCookies: boolean
): Promise<HealthMonitorSummary> {
  const hits = await getStaleHits(staleDays);
  if (hits.length === 0) {
    return {
      runId: "",
      checked: 0,
      live: 0,
      dead: 0,
      deleted: 0,
      errors: 0,
      completedAt: new Date().toISOString(),
    };
  }

  const runId = crypto.randomUUID();
  const config = mergeConfig(
    DEFAULT_CONFIG,
    { performance: { request_timeout_seconds: 20 } } as Partial<AppConfig>
  );

  // Ensure proxies are available for stale cleanup too
  const poolStatus = getProxyPoolStatus();
  if (poolStatus.alive === 0) {
    await fetchAndValidateProxies().catch(() => {});
  }

  await createRun(runId, hits.length, config).catch(() => {});

  let errors = 0;
  const cookies = hits.map((r) => ({
    name: r.email || `result_${r.id}`,
    content: r.cookie_content!,
    resultId: r.id,
  }));

  try {
    await runCheck({
      config,
      cookies,
      proxies: [],
      threadCount: 30,
      runId,
      onProgress: (update: ProgressUpdate) => {
        if (update.type === "error") errors++;
      },
    });
  } catch (err: any) {
    errors++;
  }

  const recheckedResults = await getRunResults(runId, 5000, 0);
  const deadResults = recheckedResults.filter(
    (r) => r.status !== "success"
  );
  let deleted = 0;

  if (deleteDeadCookies) {
    for (const dead of deadResults) {
      await deleteResultById(dead.id).catch(() => {});
      deleted++;
    }
  }

  notifyDashboardUpdate();

  return {
    runId,
    checked: hits.length,
    live: recheckedResults.length - deadResults.length,
    dead: deadResults.length,
    deleted,
    errors,
    completedAt: new Date().toISOString(),
  };
}
