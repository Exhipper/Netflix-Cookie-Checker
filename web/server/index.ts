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
  deleteDuplicates,
  deduplicateHits,
  deduplicateSuccessFreeHits,
  getCountryBreakdown,
  getHitLogs,
  countHits,
  getResultById,
  onDashboardUpdate,
  notifyDashboardUpdate,
} from "./db.js";
import { runCheck } from "./checker.js";
import { parseProxies } from "./proxy.js";
import { DEFAULT_CONFIG, mergeConfig } from "./config.js";
import { buildNfTokenLinks } from "./nftoken.js";
import type { AppConfig, ProgressUpdate } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Active SSE connections per run
const sseClients = new Map<string, Set<express.Response>>();

function sendSse(runId: string, data: ProgressUpdate) {
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

`;
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
      })
      .catch((err) => {
        console.error(`Run ${runId} error:`, err);
        activeRuns.delete(runId);
        sendSse(runId, { type: "error", runId, message: String(err?.message || err) });
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
      })
      .catch((err) => {
        console.error(`Recheck ${runId} error:`, err);
        activeRuns.delete(runId);
        sendSse(runId, { type: "error", runId, message: String(err?.message || err) });
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
    const { proxies: proxyText, config: userConfig, threads } = req.body as {
      proxies?: string;
      config?: Partial<AppConfig>;
      threads?: number;
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
    // Pick a random hit
    const randomHit = storedHits[Math.floor(Math.random() * storedHits.length)];
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

    // Merge stored account info with recheck info so the modal always has data
    const mergedAccountInfo = { ...storedAccountInfo, ...(checkResult.accountInfo || {}) };
    // Ensure email/country/plan from the recheck or stored data are present
    if (!mergedAccountInfo.email && randomHit.email) mergedAccountInfo.email = randomHit.email;
    if (!mergedAccountInfo.countryOfSignup && randomHit.country) mergedAccountInfo.countryOfSignup = randomHit.country;
    if (!mergedAccountInfo.localizedPlanName && randomHit.plan_name) mergedAccountInfo.localizedPlanName = randomHit.plan_name;

    // Build nftoken links - prefer fresh token, fall back to stored token
    let nfTokenData = checkResult.nfTokenData || randomHit.nftoken_data || null;
    let nfTokenLinks: Array<[string, string]> = [];
    if (nfTokenData && nfTokenData.token) {
      const mode = String(config.nftoken) === "true" ? "both" : String(config.nftoken);
      nfTokenLinks = buildNfTokenLinks(nfTokenData.token, mode);
    }

    const isLive = checkResult.status === "success" || checkResult.status === "free";

    res.json({
      runId,
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
        formattedOutput: checkResult.formattedOutput,
        nfTokenData: nfTokenData,
        nfTokenLinks,
        isLive,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to generate account" });
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

  app.listen(PORT, () => {
    console.log(`Netflix Cookie Checker server running on port ${PORT}`);
  });
}

start();
