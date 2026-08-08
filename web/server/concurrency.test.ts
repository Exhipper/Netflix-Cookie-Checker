import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DB module — no real database calls during the test
vi.mock("./db.js", () => ({
  saveResult: vi.fn().mockResolvedValue(undefined),
  updateResult: vi.fn().mockResolvedValue(undefined),
  updateRunStats: vi.fn().mockResolvedValue(undefined),
  createRun: vi.fn().mockResolvedValue(undefined),
}));

// Mock notifications — no external HTTP calls
vi.mock("./notifications.js", () => ({
  getNfTokenMode: () => "false" as const,
  formatCookieFile: () => "formatted",
  sendNotifications: vi.fn().mockResolvedValue(undefined),
}));

// Mock nftoken — no external HTTP calls
vi.mock("./nftoken.js", () => ({
  createNfToken: vi.fn().mockResolvedValue([null, null]),
  hasUsableNfToken: vi.fn().mockReturnValue(false),
}));

import { runCheck } from "./checker.js";
import { DEFAULT_CONFIG } from "./config.js";
import type { AppConfig, ProgressUpdate } from "./types.js";

/**
 * Generate a fake Netscape-format Netflix cookie bundle.
 * Each cookie has a unique NetflixId so the bundler treats them as separate accounts.
 */
function makeFakeCookie(index: number): string {
  const expiry = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
  const netflixId = `fakeNetflixId_${index}_${Date.now()}`;
  const secureNetflixId = `fakeSecureNetflixId_${index}`;
  return [
    ".netflix.com\tTRUE\t/\tTRUE\t" + expiry + "\tNetflixId\t" + netflixId,
    ".netflix.com\tTRUE\t/\tTRUE\t" + expiry + "\tSecureNetflixId\t" + secureNetflixId,
    ".netflix.com\tTRUE\t/\tFALSE\t" + expiry + "\tnfvdid\tfakeNfvdid_" + index,
  ].join("\n");
}

/**
 * Build a fake Netflix account page response that extractInfo() can parse.
 * Returns a 200 with enough JSON-like data for the checker to classify as "success".
 */
function makeFakeAccountPage(index: number): string {
  return JSON.stringify({
    data: {
      membershipInfo: {
        accountOwnerName: "User " + index,
        email: `user${index}@example.com`,
        countryOfSignup: "US",
        memberSince: "2023-01-01",
        nextBillingDate: "2025-12-01",
        userGuid: `GUID-${index}`,
        showExtraMemberSection: "false",
        membershipStatus: "CURRENT",
        maxStreams: "4",
        localizedPlanName: "Premium",
        planPrice: "$22.99",
        paymentMethodType: "CREDIT_CARD",
        paymentMethodExists: "true",
        maskedCard: "****1234",
        phoneNumber: "+1234567890",
        phoneDisplay: "+1 234-567-890",
        phoneVerified: "true",
        videoQuality: "4K",
        holdStatus: "false",
        emailVerified: "true",
        profiles: "Profile 1, Profile 2",
        profilesDisplay: "Profile 1, Profile 2",
        profileCount: 2,
        isExtraMemberAccount: "false",
      },
    },
  });
}

interface TestResult {
  threadCount: number;
  total: number;
  processed: number;
  counts: { hits: number; free: number; bad: number; duplicate: number; on_hold: number; errors: number };
  skipped: number;
  durationMs: number;
}

async function testConcurrency(
  threadCount: number,
  cookieCount: number,
  config: AppConfig
): Promise<TestResult> {
  // Mock global fetch — simulate Netflix account page responses
  const fetchMock = vi.fn().mockImplementation((_url: string, _opts?: RequestInit) => {
    // Extract cookie index from the NetflixId in the Cookie header
    const cookieHeader = (_opts?.headers as any)?.Cookie || "";
    const match = cookieHeader.match(/NetflixId=fakeNetflixId_(\d+)_/);
    const index = match ? parseInt(match[1], 10) : 0;

    return Promise.resolve({
      status: 200,
      text: () => Promise.resolve(makeFakeAccountPage(index)),
    } as any);
  });

  globalThis.fetch = fetchMock as any;

  const cookies = Array.from({ length: cookieCount }, (_, i) => ({
    name: `cookie_${i}.txt`,
    content: makeFakeCookie(i),
  }));

  const progressUpdates: ProgressUpdate[] = [];
  const startTime = Date.now();

  const counts = await runCheck({
    config,
    cookies,
    proxies: [],
    threadCount,
    runId: `test-${threadCount}-${Date.now()}`,
    onProgress: (update) => progressUpdates.push(update),
  });

  const durationMs = Date.now() - startTime;

  // Count "result" type progress updates to see how many were actually processed
  const resultUpdates = progressUpdates.filter((u) => u.type === "result");
  const processed = resultUpdates.length;

  return {
    threadCount,
    total: cookieCount,
    processed,
    counts,
    skipped: cookieCount - processed,
    durationMs,
  };
}

describe("checker concurrency", () => {
  const config = { ...DEFAULT_CONFIG, nftoken: "false" as const };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Warm up — verify the test harness works with a small batch
  it("processes all cookies at 1 thread (sanity check)", async () => {
    const result = await testConcurrency(1, 20, config);
    expect(result.processed).toBe(result.total);
    expect(result.skipped).toBe(0);
    expect(result.counts.hits + result.counts.free).toBe(result.total);
  });

  it("processes all cookies at 10 threads", async () => {
    const result = await testConcurrency(10, 100, config);
    expect(result.processed).toBe(result.total);
    expect(result.skipped).toBe(0);
  });

  it("processes all cookies at 30 threads (default)", async () => {
    const result = await testConcurrency(30, 200, config);
    expect(result.processed).toBe(result.total);
    expect(result.skipped).toBe(0);
  });

  it("processes all cookies at 50 threads", async () => {
    const result = await testConcurrency(50, 200, config);
    expect(result.processed).toBe(result.total);
    expect(result.skipped).toBe(0);
  });

  it("processes all cookies at 100 threads", async () => {
    const result = await testConcurrency(100, 300, config);
    expect(result.processed).toBe(result.total);
    expect(result.skipped).toBe(0);
  });

  it("processes all cookies at 200 threads", async () => {
    const result = await testConcurrency(200, 500, config);
    expect(result.processed).toBe(result.total);
    expect(result.skipped).toBe(0);
  });

  it("processes all cookies at 300 threads (max cap)", async () => {
    const result = await testConcurrency(300, 500, config);
    expect(result.processed).toBe(result.total);
    expect(result.skipped).toBe(0);
  });

  it("processes all cookies when threads > cookie count (over-provisioning)", async () => {
    const result = await testConcurrency(300, 50, config);
    expect(result.processed).toBe(result.total);
    expect(result.skipped).toBe(0);
  });

  it("processes 1000 cookies at 300 threads (heavy stress)", async () => {
    const result = await testConcurrency(300, 1000, config);
    expect(result.processed).toBe(result.total);
    expect(result.skipped).toBe(0);
    // Should complete in reasonable time even with 1000 cookies
    expect(result.durationMs).toBeLessThan(5000);
  });

  it("handles mixed live/dead cookies without skipping any", async () => {
    // Every 3rd cookie returns a login page (expired), rest return 200
    const fetchMock = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
      const cookieHeader = (opts?.headers as any)?.Cookie || "";
      const match = cookieHeader.match(/NetflixId=fakeNetflixId_(\d+)_/);
      const index = match ? parseInt(match[1], 10) : 0;

      if (index % 3 === 0) {
        // Expired — redirect to login
        return Promise.resolve({
          status: 301,
          text: () => Promise.resolve(""),
        } as any);
      }

      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(makeFakeAccountPage(index)),
      } as any);
    });
    globalThis.fetch = fetchMock as any;

    const cookies = Array.from({ length: 150 }, (_, i) => ({
      name: `cookie_${i}.txt`,
      content: makeFakeCookie(i),
    }));

    const counts = await runCheck({
      config,
      cookies,
      proxies: [],
      threadCount: 100,
      runId: `test-mixed-${Date.now()}`,
      onProgress: () => {},
    });

    const totalProcessed = counts.hits + counts.free + counts.bad + counts.duplicate + counts.errors;
    expect(totalProcessed).toBe(150);
    // Every 3rd (0,3,6,...149) = 50 dead, 100 live
    expect(counts.bad).toBe(50);
    expect(counts.hits + counts.free).toBe(100);
  });
});
