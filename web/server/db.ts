import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    pool = new Pool({
      connectionString,
      ssl: connectionString.includes("render.com")
        ? { rejectUnauthorized: false }
        : undefined,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

export async function initDatabase(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        total_cookies INTEGER NOT NULL DEFAULT 0,
        hits INTEGER NOT NULL DEFAULT 0,
        free INTEGER NOT NULL DEFAULT 0,
        bad INTEGER NOT NULL DEFAULT 0,
        duplicate INTEGER NOT NULL DEFAULT 0,
        on_hold INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running',
        config JSONB
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS results (
        id SERIAL PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status TEXT NOT NULL,
        plan_key TEXT,
        plan_name TEXT,
        country TEXT,
        email TEXT,
        reason TEXT,
        on_hold BOOLEAN NOT NULL DEFAULT false,
        account_info JSONB,
        cookie_content TEXT,
        formatted_output TEXT,
        nftoken_data JSONB
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_results_run_id ON results(run_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_results_status ON results(status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_results_plan_key ON results(plan_key)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at DESC)
    `);
  } finally {
    client.release();
  }
}

export async function isDbAvailable(): Promise<boolean> {
  try {
    const pool = getPool();
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    return true;
  } catch {
    return false;
  }
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

import type { CheckResult, RunStats } from "./types.js";

export async function createRun(
  runId: string,
  totalCookies: number,
  config: any
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO runs (id, total_cookies, status, config) VALUES ($1, $2, 'running', $3)`,
    [runId, totalCookies, JSON.stringify(config)]
  );
}

export async function saveResult(
  runId: string,
  result: CheckResult
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO results (run_id, status, plan_key, plan_name, country, email, reason, on_hold, account_info, cookie_content, formatted_output, nftoken_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      runId,
      result.status,
      result.planKey || null,
      result.planName || null,
      result.country || null,
      result.email || null,
      result.reason || null,
      result.onHold || false,
      result.accountInfo ? JSON.stringify(result.accountInfo) : null,
      result.cookieContent || null,
      result.formattedOutput || null,
      result.nfTokenData ? JSON.stringify(result.nfTokenData) : null,
    ]
  );
}

export async function updateRunStats(
  runId: string,
  stats: RunStats,
  total: number,
  status: string
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE runs SET hits = $1, free = $2, bad = $3, duplicate = $4, on_hold = $5, errors = $6, total_cookies = $7, status = $8, completed_at = NOW() WHERE id = $9`,
    [stats.hits, stats.free, stats.bad, stats.duplicate, stats.on_hold, stats.errors, total, status, runId]
  );
}

export async function getRuns(limit = 50, offset = 0): Promise<RunRecord[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM runs ORDER BY started_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows as RunRecord[];
}

export async function getRun(runId: string): Promise<RunRecord | null> {
  const pool = getPool();
  const result = await pool.query(`SELECT * FROM runs WHERE id = $1`, [runId]);
  return (result.rows[0] as RunRecord) || null;
}

export async function getRunResults(
  runId: string,
  limit = 100,
  offset = 0,
  statusFilter?: string
): Promise<ResultRecord[]> {
  const pool = getPool();
  let query = `SELECT * FROM results WHERE run_id = $1`;
  const params: any[] = [runId];
  if (statusFilter && statusFilter !== "all") {
    query += ` AND status = $${params.length + 1}`;
    params.push(statusFilter);
  }
  query += ` ORDER BY checked_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);
  const result = await pool.query(query, params);
  return result.rows as ResultRecord[];
}

export async function deleteRun(runId: string): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM runs WHERE id = $1`, [runId]);
}

/** Fetch all stored hit results (success/free/duplicate) with their cookie content for rechecking. */
export async function getAllHitsResults(
  limit = 1000,
  offset = 0
): Promise<ResultRecord[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM results WHERE status IN ('success', 'free', 'duplicate') AND cookie_content IS NOT NULL
     ORDER BY checked_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows as ResultRecord[];
}

/** Count all stored hit results. */
export async function countAllHitsResults(): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM results WHERE status IN ('success', 'free', 'duplicate') AND cookie_content IS NOT NULL`
  );
  return parseInt(result.rows[0]?.count || "0", 10);
}

/** Update an existing result row with new check data. */
export async function updateResult(
  resultId: number,
  result: CheckResult
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE results SET status = $1, plan_key = $2, plan_name = $3, country = $4, email = $5, reason = $6,
     on_hold = $7, account_info = $8, formatted_output = $9, nftoken_data = $10, checked_at = NOW()
     WHERE id = $11`,
    [
      result.status,
      result.planKey || null,
      result.planName || null,
      result.country || null,
      result.email || null,
      result.reason || null,
      result.onHold || false,
      result.accountInfo ? JSON.stringify(result.accountInfo) : null,
      result.formattedOutput || null,
      result.nfTokenData ? JSON.stringify(result.nfTokenData) : null,
      resultId,
    ]
  );
}

export async function getStats(): Promise<any> {
  const pool = getPool();
  const totalRuns = await pool.query(`SELECT COUNT(*) as count FROM runs`);
  const totalResults = await pool.query(`SELECT COUNT(*) as count FROM results`);
  const statusBreakdown = await pool.query(
    `SELECT status, COUNT(*) as count FROM results GROUP BY status`
  );
  const planBreakdown = await pool.query(
    `SELECT plan_key, COUNT(*) as count FROM results WHERE plan_key IS NOT NULL GROUP BY plan_key ORDER BY count DESC`
  );
  const recentRuns = await pool.query(
    `SELECT * FROM runs ORDER BY started_at DESC LIMIT 5`
  );
  return {
    totalRuns: totalRuns.rows[0]?.count || 0,
    totalResults: totalResults.rows[0]?.count || 0,
    statusBreakdown: statusBreakdown.rows,
    planBreakdown: planBreakdown.rows,
    recentRuns: recentRuns.rows,
  };
}
