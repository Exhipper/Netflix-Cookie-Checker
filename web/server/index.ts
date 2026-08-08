import "dotenv/config";
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
  updateNfTokenData,
} from "./db.js";
import { runCheck, runCheckRacing } from "./checker.js";
import { parseProxies } from "./proxy.js";
import { DEFAULT_CONFIG, mergeConfig } from "./config.js";
import { buildNfTokenLinks, createNfToken, hasUsableNfToken } from "./nftoken.js";
import { extractCookieBundles, hasRequiredCookies, cookiesDictFromNetscape } from "./cookies.js";
import { getNfTokenMode, formatCookieFile } from "./notifications.js";
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
  fetchAndValidateProxies,
} from "./proxy-manager.js";

/** Ensure the proxy pool has alive entries before starting a batch check.
 *  Non-blocking: waits at most 15s for the fetch to produce proxies, then proceeds
 *  (the fetch continues in the background and proxies will appear on subsequent calls). */
async function warmupProxies(): Promise<void> {
  const poolStatus = getProxyPoolStatus();
  if (poolStatus.alive > 0) return; // already have proxies

  console.log("[warmup] No alive proxies, triggering background fetch...");
  // Start the fetch (non-blocking) if not already in progress
  const fetchPromise = fetchAndValidateProxies().catch(() => {});

  // Race the fetch against a 15s timeout — don't block the request indefinitely
  await Promise.race([
    fetchPromise,
    new Promise<void>((resolve) => setTimeout(resolve, 15000)),
  ]);
}

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

    // Ensure proxies are warm before starting the batch check
    await warmupProxies();

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

    // Ensure proxies are warm before starting the batch recheck
    await warmupProxies();

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

// Generate an account by racing multiple stored hits in parallel.
// Checks up to `threads` candidates simultaneously and returns the first live hit.
// If no live hit is found, returns the best non-error result.
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

    // Ensure proxies are warm before racing
    await warmupProxies();

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

    // Shuffle candidates so we don't always check in the same order
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    // Take up to threadCount candidates to race in parallel
    const batchSize = Math.min(threadCount, candidates.length);
    const batch = candidates.slice(0, batchSize);

    const runId = crypto.randomUUID();
    await createRun(runId, batch.length, config).catch(() => {});

    const abortController = new AbortController();
    activeRuns.set(runId, abortController);

    // Build cookie list for racing — each cookie carries its resultId for DB updates
    const cookies = batch.map((h) => ({
      name: h.email || `result_${h.id}`,
      content: h.cookie_content!,
      resultId: h.id,
    }));

    // Race-check: check all candidates in parallel, return first live hit
    const raceResult = await runCheckRacing({
      config,
      cookies,
      proxies,
      threadCount,
      runId,
      signal: abortController.signal,
      onProgress: () => {}, // no SSE for generate — client waits for response
    }).catch((err: any) => {
      throw err;
    });

    activeRuns.delete(runId);

    if (!raceResult) {
      res.status(500).json({ error: "No result from recheck" });
      return;
    }

    const checkResult = raceResult.result as any;
    const winnerHit = batch[raceResult.cookieIndex];
    const storedAccountInfo = (winnerHit.account_info || {}) as Record<string, any>;

    // Merge stored account info with recheck info so the modal always has data.
    let recheckAccountInfo = checkResult.accountInfo || {};
    if (!recheckAccountInfo || Object.keys(recheckAccountInfo).length === 0) {
      const savedResult =
        (checkResult.email && (await getLatestResultByEmail(checkResult.email))) ||
        (winnerHit.email && (await getLatestResultByEmail(winnerHit.email))) ||
        (await getLatestResultByCookieContent(winnerHit.cookie_content!));
      if (savedResult?.account_info) {
        recheckAccountInfo = savedResult.account_info as Record<string, any>;
      }
    }

    const mergedAccountInfo = { ...storedAccountInfo, ...recheckAccountInfo };
    if (!mergedAccountInfo.email && (checkResult.email || winnerHit.email)) {
      mergedAccountInfo.email = checkResult.email || winnerHit.email;
    }
    if (!mergedAccountInfo.countryOfSignup && (checkResult.country || winnerHit.country)) {
      mergedAccountInfo.countryOfSignup = checkResult.country || winnerHit.country;
    }
    if (!mergedAccountInfo.localizedPlanName && (checkResult.planName || winnerHit.plan_name)) {
      mergedAccountInfo.localizedPlanName = checkResult.planName || winnerHit.plan_name;
    }
    if (!mergedAccountInfo.planKey && (checkResult.planKey || winnerHit.plan_key)) {
      mergedAccountInfo.planKey = checkResult.planKey || winnerHit.plan_key;
    }
    if (!mergedAccountInfo.membershipStatus && (checkResult.status || winnerHit.status)) {
      mergedAccountInfo.membershipStatus = checkResult.status === "success" ? "Active" : (checkResult.status || winnerHit.status);
    }

    // NFToken is generated in the background by runCheckRacing — don't block the response.
    // Check if we already have one from the DB (from a previous check or background gen that completed).
    const existingNfToken = winnerHit.nftoken_data;
    let nfTokenData = checkResult.nfTokenData || existingNfToken || null;
    let nfTokenLinks: Array<[string, string]> = [];
    if (nfTokenData && nfTokenData.token) {
      nfTokenLinks = buildNfTokenLinks(nfTokenData.token, "all");
    }

    const isLive = checkResult.status === "success";

    // Auto-delete free accounts from the database
    if (checkResult.status === "free") {
      await deleteResultById(winnerHit.id).catch(() => {});
    }

    // Record generation history
    await recordGeneration(winnerHit.id, {
      status: checkResult.status,
      planKey: checkResult.planKey || winnerHit.plan_key || undefined,
      planName: checkResult.planName || winnerHit.plan_name || undefined,
      country: checkResult.country || winnerHit.country || undefined,
      email: checkResult.email || winnerHit.email || undefined,
      reason: checkResult.reason,
      accountInfo: mergedAccountInfo,
    }).catch(() => {});

    res.json({
      runId,
      storedHitId: winnerHit.id,
      result: {
        status: checkResult.status,
        planKey: checkResult.planKey || winnerHit.plan_key || undefined,
        planName: checkResult.planName || winnerHit.plan_name || undefined,
        country: checkResult.country || winnerHit.country || undefined,
        email: checkResult.email || winnerHit.email || undefined,
        reason: checkResult.reason,
        onHold: checkResult.onHold,
        accountInfo: mergedAccountInfo,
        cookieContent: checkResult.cookieContent || winnerHit.cookie_content || undefined,
        formattedOutput: checkResult.formattedOutput || winnerHit.formatted_output || undefined,
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

// Recheck a single stored hit by ID — uses racing mode for speed (1 attempt, no NFToken blocking).
// NFToken is generated in the background and can be fetched via /api/nftoken/:id.
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

    // Ensure proxies are warm before rechecking
    await warmupProxies();

    await createRun(runId, 1, config).catch(() => {});
    const abortController = new AbortController();
    activeRuns.set(runId, abortController);

    // Use racing mode: 1 attempt, no NFToken — returns immediately with account status
    const raceResult = await runCheckRacing({
      config,
      cookies: [{ name: result.email || `result_${result.id}`, content: result.cookie_content, resultId: result.id }],
      proxies,
      threadCount,
      runId,
      signal: abortController.signal,
      onProgress: () => {},
    });

    activeRuns.delete(runId);

    if (!raceResult) {
      res.status(500).json({ error: "No result from recheck" });
      return;
    }

    const checkResult = raceResult.result as any;
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
      accountInfo: checkResult.accountInfo || null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to recheck hit" });
  }
});

// Generate or fetch NFToken for a stored hit by ID.
// If the DB already has a usable token, returns it immediately.
// Otherwise generates one on-demand (up to 2 attempts × 12s timeout).
app.get("/api/nftoken/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid ID" });
      return;
    }

    const result = await getResultById(id);
    if (!result || !result.cookie_content) {
      res.status(404).json({ error: "Hit not found" });
      return;
    }

    // Check if we already have a usable token in the DB
    const existingToken = result.nftoken_data;
    if (existingToken && hasUsableNfToken(existingToken)) {
      const links = buildNfTokenLinks(existingToken.token, "all");
      res.json({ nftoken: existingToken, links, cached: true });
      return;
    }

    // Generate a new token
    const config = DEFAULT_CONFIG;
    const bundles = extractCookieBundles(result.cookie_content);
    if (!bundles.length) {
      res.status(400).json({ error: "No valid cookie bundles found" });
      return;
    }
    const bundle = bundles[0];
    const cookieDict = bundle.cookies || cookiesDictFromNetscape(bundle.netscape_text);
    if (!cookieDict || !hasRequiredCookies(cookieDict)) {
      res.status(400).json({ error: "Missing required cookies" });
      return;
    }

    const nfTokenAttempts = Math.max(1, config.retries.nftoken_attempts);
    const [nfTokenData, error] = await createNfToken(cookieDict, nfTokenAttempts);
    if (!nfTokenData) {
      res.status(502).json({ error: error || "Failed to generate NFToken" });
      return;
    }

    // Save to DB for future use
    const isSubscribed = result.status === "success";
    const formatted = formatCookieFile(
      config,
      result.account_info || {},
      result.cookie_content,
      isSubscribed,
      nfTokenData
    );
    await updateNfTokenData(id, nfTokenData, formatted).catch(() => {});

    const links = buildNfTokenLinks(nfTokenData.token, "all");
    res.json({ nftoken: nfTokenData, links, cached: false });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to generate NFToken" });
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
  console.log("Proxy auto-fetch started");

  // Start auto-health monitor by default unless explicitly disabled
  const monitorEnabled = process.env.HEALTH_MONITOR_ENABLED !== "false";
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
  console.log(`Auto-health monitor ${monitorEnabled ? "started" : "disabled"} (interval: ${intervalHours}h, deleteDead: ${deleteDeadCookies}, threads: ${threads})`);

  app.listen(PORT, () => {
    console.log(`NFX Puke Kicker server running on port ${PORT}`);
  });
}

start();
