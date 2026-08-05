import { useEffect, useState, useRef, useCallback } from "react";
import {
  TrendingUp,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Activity,
  RefreshCw,
  Loader2,
  Sparkles,
  Globe,
  Cookie,
  Zap,
  ExternalLink,
  Mail,
  Clock,
  Trash2,
  Search,
  X,
  Shield,
  History,
  ChevronDown,
  Network,
  Wifi,
  Timer,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  getStats,
  checkHealth,
  getRecheckCount,
  recheckHits,
  getDefaultConfig,
  getCountryBreakdown,
  getHitLogs,
  deduplicateHits,
  generateAccount,
  subscribeToDashboardEvents,
  searchHitLogs,
  getHitLogFilters,
  recheckHit,
  getResultById,
  getStaleHits,
  cleanupStaleHits,
  getGenerationHistory,
  type ResultRecord,
  type GeneratedAccount,
  type GenerationHistoryRecord,
} from "@/lib/api";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { getCountryFlag, withFlag } from "@/lib/countryFlags";
import { toast } from "sonner";

export default function Dashboard() {
  const [stats, setStats] = useState<any>(null);
  const [health, setHealth] = useState<{ status: string; database: string; healthMonitor?: { running: boolean; intervalHours: number; nextRunAt: number | null; lastRunAt: number | null } } | null>(null);
  const [loading, setLoading] = useState(true);
  const [recheckCount, setRecheckCount] = useState<number | null>(null);
  const [isRechecking, setIsRechecking] = useState(false);
  const [countryBreakdown, setCountryBreakdown] = useState<
    Array<{ country: string; count: number; hits: number; free: number }>
  >([]);
  const [hitLogs, setHitLogs] = useState<ResultRecord[]>([]);
  const [hitLogsTotal, setHitLogsTotal] = useState(0);
  const [filters, setFilters] = useState({ country: "all", plan: "all", email: "" });
  const [filterOptions, setFilterOptions] = useState<{ countries: string[]; plans: string[] }>({ countries: [], plans: [] });
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedAccount, setGeneratedAccount] = useState<GeneratedAccount | null>(null);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [accountModalMode, setAccountModalMode] = useState<"generate" | "hitlog">("generate");
  const [selectedHitLog, setSelectedHitLog] = useState<ResultRecord | null>(null);
  const [generateFilterCountry, setGenerateFilterCountry] = useState<string>("all");
  const [generateFilterPlan, setGenerateFilterPlan] = useState<string>("all");
  const [staleHits, setStaleHits] = useState<{ count: number; days: number } | null>(null);
  const [isCleaningStale, setIsCleaningStale] = useState(false);
  const [generationHistory, setGenerationHistory] = useState<GenerationHistoryRecord[]>([]);
  const [generationHistoryTotal, setGenerationHistoryTotal] = useState(0);
  const [recheckingHitId, setRecheckingHitId] = useState<number | null>(null);
  const [proxyPool, setProxyPool] = useState<{ total: number; alive: number; dead: number; lastFetch: number | null; isFetching: boolean } | null>(null);
  const [isRefreshingProxies, setIsRefreshingProxies] = useState(false);
  const [healthCountdown, setHealthCountdown] = useState<string>("");
  const [threadCount, setThreadCount] = useState<number>(50);
  const eventSourceRef = useRef<EventSource | null>(null);
  const dashboardEventSourceRef = useRef<EventSource | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [s, h, rc, cb, hl, fo, gh, st, pp] = await Promise.all([
        getStats().catch(() => null),
        checkHealth().catch(() => null),
        getRecheckCount().catch(() => null),
        getCountryBreakdown().catch(() => []),
        searchHitLogs({ ...filters, limit: 20, offset: 0 }).catch(() => ({ logs: [], total: 0 })),
        getHitLogFilters().catch(() => ({ countries: [], plans: [] })),
        getGenerationHistory(10, 0).catch(() => ({ history: [], total: 0 })),
        getStaleHits(7).catch(() => ({ count: 0, days: 7 })),
        fetch(`${import.meta.env.VITE_API_BASE_URL || ""}/api/proxies/status`).then((r) => r.json()).catch(() => null),
      ]);
      setStats(s);
      setHealth(h);
      if (rc) setRecheckCount(rc.count);
      setCountryBreakdown(cb as typeof countryBreakdown);
      setHitLogs((hl as any).logs);
      setHitLogsTotal((hl as any).total);
      setFilterOptions(fo as typeof filterOptions);
      setGenerationHistory((gh as any).history);
      setGenerationHistoryTotal((gh as any).total);
      setStaleHits(st as { count: number; days: number });
      if (pp) setProxyPool(pp);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    // Auto-deduplicate on first load
    deduplicateHits().catch(() => {});
    loadData();
    const interval = setInterval(loadData, 10000);

    const countdownInterval = setInterval(() => {
      const next = health?.healthMonitor?.nextRunAt;
      if (!next) {
        setHealthCountdown("");
        return;
      }
      const remaining = Math.max(0, next - Date.now());
      if (remaining <= 0) {
        setHealthCountdown("Running now");
        return;
      }
      const hours = Math.floor(remaining / (1000 * 60 * 60));
      const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((remaining % (1000 * 60)) / 1000);
      setHealthCountdown(
        `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
      );
    }, 1000);

    return () => {
      clearInterval(interval);
      clearInterval(countdownInterval);
    };
  }, [loadData, health?.healthMonitor?.nextRunAt]);

  useEffect(() => {
    // Real-time dashboard updates via SSE
    dashboardEventSourceRef.current = subscribeToDashboardEvents(() => {
      loadData();
    });
    return () => {
      dashboardEventSourceRef.current?.close();
    };
  }, [loadData]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  const handleRecheck = async () => {
    if (recheckCount === 0) {
      toast.error("No stored hits to recheck");
      return;
    }
    setIsRechecking(true);
    try {
      const config = await getDefaultConfig().catch(() => ({}));
      const result = await recheckHits("", config, threadCount);
      toast.success(`Recheck started: ${result.total} stored hits`);

      const es = new EventSource(
        `${import.meta.env.VITE_API_BASE_URL || ""}/api/check/${result.runId}/stream`
      );
      es.onmessage = (event) => {
        try {
          const update = JSON.parse(event.data);
          if (update.type === "complete") {
            setIsRechecking(false);
            toast.success("Recheck completed!", {
              description: `${update.counts?.hits || 0} hits, ${update.counts?.free || 0} free, ${update.counts?.bad || 0} bad`,
            });
            es.close();
            loadData();
          } else if (update.type === "error") {
            setIsRechecking(false);
            toast.error(update.message || "Recheck failed");
            es.close();
          }
        } catch {
          // ignore parse errors
        }
      };
      eventSourceRef.current = es;
    } catch (err: any) {
      toast.error(err.message || "Failed to start recheck");
      setIsRechecking(false);
    }
  };

  const handleGenerateAccount = async () => {
    setIsGenerating(true);
    try {
      const config = await getDefaultConfig().catch(() => ({}));
      const result = await generateAccount("", config, threadCount, undefined, generateFilterCountry, generateFilterPlan);
      setGeneratedAccount(result);
      setAccountModalMode("generate");
      setSelectedHitLog(null);
      setShowAccountModal(true);
      if (result.result.isLive) {
        toast.success("Account generated and verified as live!", {
          description: result.result.planName || result.result.status,
        });
      } else {
        toast.warning("Account generated but not live", {
          description: result.result.reason || result.result.status,
        });
      }
      loadData();
    } catch (err: any) {
      toast.error(err.message || "Failed to generate account");
    } finally {
      setIsGenerating(false);
    }
  };

  const buildAccountFromHitLog = (log: ResultRecord): GeneratedAccount => {
    const accountInfo = log.account_info || {};
    return {
      runId: log.run_id,
      storedHitId: log.id,
      result: {
        status: log.status,
        planKey: log.plan_key || undefined,
        planName: log.plan_name || undefined,
        country: log.country || undefined,
        email: log.email || undefined,
        reason: log.reason || undefined,
        onHold: log.on_hold,
        accountInfo: {
          ...accountInfo,
          email: accountInfo.email || log.email || undefined,
          countryOfSignup: accountInfo.countryOfSignup || log.country || undefined,
          localizedPlanName: accountInfo.localizedPlanName || log.plan_name || undefined,
          membershipStatus: accountInfo.membershipStatus || (log.status === "success" ? "Active" : "Inactive"),
        },
        cookieContent: log.cookie_content || undefined,
        formattedOutput: log.formatted_output || undefined,
        nfTokenData: log.nftoken_data || null,
        isLive: log.status === "success",
        proxyIp: log.proxy_ip || null,
      },
    };
  };

  const handleRecheckHit = async (log: ResultRecord, autoDelete = true) => {
    setRecheckingHitId(log.id);
    try {
      const config = await getDefaultConfig().catch(() => ({}));
      const result = await recheckHit(log.id, "", config, threadCount, autoDelete);
      if (result.autoDeleted) {
        toast.error("Account dead — deleted", { description: log.email || undefined });
        setShowAccountModal(false);
      } else if (result.isLive) {
        toast.success("Account is live", { description: log.email || undefined });
      } else {
        toast.warning("Account dead", { description: result.reason || "Not live" });
      }
      if (selectedHitLog?.id === log.id && !result.autoDeleted) {
        try {
          const updated = await getResultById(log.id);
          setGeneratedAccount(buildAccountFromHitLog(updated));
        } catch {
          // ignore fetch error
        }
      }
      loadData();
    } catch (err: any) {
      toast.error(err.message || "Failed to recheck hit");
    } finally {
      setRecheckingHitId(null);
    }
  };

  const handleRecheckAnother = async () => {
    const excludeId = generatedAccount?.storedHitId;
    try {
      const config = await getDefaultConfig().catch(() => ({}));
      const result = await generateAccount("", config, threadCount, excludeId, generateFilterCountry, generateFilterPlan);
      setGeneratedAccount(result);
      setAccountModalMode("generate");
      setSelectedHitLog(null);
      if (result.result.isLive) {
        toast.success("Another account is live", { description: result.result.email || result.result.planName });
      } else {
        toast.warning("Account not live", { description: result.result.reason || "Dead" });
      }
      loadData();
    } catch (err: any) {
      toast.error(err.message || "Failed to recheck another account");
    }
  };

  const handleHitLogClick = (log: ResultRecord) => {
    // Open the account info modal for this hit log entry, pre-filtering by its country/plan
    setGenerateFilterCountry(log.country || "all");
    setGenerateFilterPlan(log.plan_key || "all");
    setSelectedHitLog(log);
    setGeneratedAccount(buildAccountFromHitLog(log));
    setAccountModalMode("hitlog");
    setShowAccountModal(true);
  };

  const handleCleanupStale = async () => {
    setIsCleaningStale(true);
    try {
      const summary = await cleanupStaleHits(7, true);
      toast.success(`Stale cleanup complete`, {
        description: `${summary.deleted} dead deleted, ${summary.live} still live`,
      });
      loadData();
    } catch (err: any) {
      toast.error(err.message || "Failed to cleanup stale hits");
    } finally {
      setIsCleaningStale(false);
    }
  };

  const handleRefreshProxies = async () => {
    setIsRefreshingProxies(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_BASE_URL || ""}/api/proxies/refresh`, { method: "POST" });
      const data = await res.json();
      toast.success("Proxies refreshed", {
        description: data.message || `${data.alive} alive out of ${data.fetched}`,
      });
      loadData();
    } catch (err: any) {
      toast.error(err.message || "Failed to refresh proxies");
    } finally {
      setIsRefreshingProxies(false);
    }
  };

  const totalChecked = stats?.totalResults || 0;
  const activeCookies = stats?.activeCookies || 0;
  const totalHits = stats?.totalHits || 0;
  const totalCookiesStored = stats?.totalCookiesStored || 0;
  const successRate = totalChecked > 0 ? ((totalHits) / totalChecked * 100).toFixed(1) : "0";
  const staleCount = staleHits?.count || 0;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Monitor your Netflix cookie database in real-time</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              onClick={handleRecheck}
              variant="outline"
              disabled={isRechecking || recheckCount === 0}
              className="relative"
            >
              {isRechecking ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              {isRechecking ? "Rechecking..." : `Recheck Hits${recheckCount !== null ? ` (${recheckCount})` : ""}`}
            </Button>
            <Button
              onClick={handleGenerateAccount}
              disabled={isGenerating || totalCookiesStored === 0}
              className="bg-primary hover:bg-primary/90 glow-red"
            >
              {isGenerating ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4 mr-2" />
              )}
              {isGenerating ? "Generating..." : "Generate Account"}
            </Button>
          </div>
          <div className="flex items-center gap-3 min-w-[180px]">
            <span className="text-xs text-muted-foreground whitespace-nowrap">Threads</span>
            <Slider
              value={[threadCount]}
              onValueChange={(value) => setThreadCount(value[0])}
              min={1}
              max={300}
              step={1}
              className="w-24"
            />
            <span className="text-xs font-medium w-8 text-right">{threadCount}</span>
          </div>
        </div>
      </div>

      {/* Health Status */}
      <div className="mb-6 flex items-center gap-3 flex-wrap">
        <div className={cn(
          "flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium",
          health?.database === "connected"
            ? "bg-green-500/10 text-green-500"
            : "bg-yellow-500/10 text-yellow-500"
        )}>
          <div className={cn(
            "h-2 w-2 rounded-full",
            health?.database === "connected" ? "bg-green-500 animate-pulse" : "bg-yellow-500"
          )} />
          Database: {health?.database || "checking..."}
        </div>
        <div className="flex items-center gap-2 rounded-full bg-secondary px-3 py-1.5 text-xs font-medium text-muted-foreground">
          <Activity className="h-3 w-3" />
          Server: {health?.status || "checking..."}
        </div>
        <div className="flex items-center gap-2 rounded-full bg-secondary px-3 py-1.5 text-xs font-medium text-muted-foreground">
          <Cookie className="h-3 w-3" />
          Cookies Stored: {totalCookiesStored}
        </div>
        {proxyPool && (
          <div className={cn(
            "flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium",
            proxyPool.alive > 0 ? "bg-green-500/10 text-green-500" : "bg-yellow-500/10 text-yellow-500"
          )}>
            <Network className="h-3 w-3" />
            Proxies: {proxyPool.alive} alive / {proxyPool.total}
            {proxyPool.isFetching && <Loader2 className="h-3 w-3 animate-spin ml-1" />}
          </div>
        )}
        {proxyPool && proxyPool.alive > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefreshProxies}
            disabled={isRefreshingProxies}
            className="h-7 px-2 text-xs"
          >
            {isRefreshingProxies ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3 mr-1" />
            )}
            Refresh Proxies
          </Button>
        )}
        {staleCount > 0 && (
          <div className="flex items-center gap-2 rounded-full bg-yellow-500/10 px-3 py-1.5 text-xs font-medium text-yellow-500">
            <AlertCircle className="h-3 w-3" />
            {staleCount} stale (7d+)
          </div>
        )}
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 mb-8">
        <StatCard
          label="Active Cookies"
          value={activeCookies}
          icon={<CheckCircle2 className="h-5 w-5" />}
          color="text-green-500"
        />
        <StatCard
          label="Total Hits"
          value={totalHits}
          icon={<TrendingUp className="h-5 w-5" />}
          color="text-primary"
        />
        <StatCard
          label="Cookies Stored"
          value={totalCookiesStored}
          icon={<Cookie className="h-5 w-5" />}
          color="text-purple-500"
        />
        <StatCard
          label="Hit Rate"
          value={`${successRate}%`}
          icon={<Activity className="h-5 w-5" />}
          color="text-blue-500"
        />
        <Card className="border-primary/20">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Auto Recheck</CardTitle>
            <Timer className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tracking-tight">
              {healthCountdown || "--:--:--"}
            </div>
            <p className="text-sm text-muted-foreground">Next automatic recheck</p>
          </CardContent>
        </Card>
      </div>

      {/* Country Breakdown + Plan Distribution */}
      <div className="grid gap-6 lg:grid-cols-2 mb-8">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Globe className="h-5 w-5 text-primary" />
              Country Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {countryBreakdown.length > 0 ? (
              countryBreakdown.map((entry) => {
                const total = countryBreakdown.reduce((sum, e) => sum + e.count, 0);
                return (
                  <CountryRow
                    key={entry.country}
                    country={entry.country}
                    count={entry.count}
                    hits={entry.hits}
                    total={total}
                  />
                );
              })
            ) : (
              <p className="text-sm text-muted-foreground">No country data available yet</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Plan Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            {stats?.planBreakdown?.length > 0 ? (
              <div className="space-y-3">
                {stats.planBreakdown.map((plan: any) => (
                  <div key={plan.plan_key} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="capitalize">
                        {plan.plan_key?.replace(/_/g, " ") || "unknown"}
                      </Badge>
                    </div>
                    <span className="text-sm font-semibold">{plan.count}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No plan data available yet</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Cookie Hit Logs with Search & Filter */}
      <div className="mb-8">
        <div className="flex flex-col gap-4 mb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold">Cookie Hit Logs</h2>
              <Badge variant="secondary" className="text-xs">{hitLogsTotal} total stored</Badge>
            </div>
            <div className="flex items-center gap-2">
              {staleCount > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCleanupStale}
                  disabled={isCleaningStale}
                >
                  {isCleaningStale ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <Trash2 className="h-3 w-3 mr-1" />
                  )}
                  Cleanup {staleCount} stale
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => loadData()}
                className="text-xs text-muted-foreground"
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Refresh
              </Button>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by email..."
                value={filters.email}
                onChange={(e) => setFilters((f) => ({ ...f, email: e.target.value }))}
                className="pl-9"
              />
            </div>
            <Select value={filters.country} onValueChange={(v) => setFilters((f) => ({ ...f, country: v }))}>
              <SelectTrigger>
                <SelectValue placeholder="All countries" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">🌍 All countries</SelectItem>
                {filterOptions.countries.map((c) => (
                  <SelectItem key={c} value={c}>{getCountryFlag(c) ? `${getCountryFlag(c)} ${c}` : c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filters.plan} onValueChange={(v) => setFilters((f) => ({ ...f, plan: v }))}>
              <SelectTrigger>
                <SelectValue placeholder="All plans" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All plans</SelectItem>
                {filterOptions.plans.map((p) => (
                  <SelectItem key={p} value={p}>{p.replace(/_/g, " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-16 rounded-lg bg-secondary animate-pulse" />
            ))}
          </div>
        ) : hitLogs.length > 0 ? (
          <div className="space-y-2">
            {hitLogs.map((log) => (
              <HitLogRow
                key={log.id}
                log={log}
                isRechecking={recheckingHitId === log.id}
                onRecheck={() => handleRecheckHit(log, true)}
                onClick={() => handleHitLogClick(log)}
              />
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Cookie className="h-8 w-8 text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">No cookie hits stored yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Run a check to start collecting hits in the database
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Account Generation History */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-4">
          <History className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-semibold">Account Generation History</h2>
          <Badge variant="secondary" className="text-xs">{generationHistoryTotal} generated</Badge>
        </div>
        {generationHistory.length > 0 ? (
          <div className="space-y-2">
            {generationHistory.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-3 rounded-lg border border-border bg-card p-3"
              >
                <div className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-lg shrink-0",
                  entry.was_live ? "bg-green-500/10" : "bg-red-500/10"
                )}>
                  {entry.was_live ? (
                    <CheckCircle2 className="h-5 w-5 text-green-500" />
                  ) : (
                    <XCircle className="h-5 w-5 text-red-500" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {entry.plan_name && (
                      <Badge variant="secondary" className="text-xs">{entry.plan_name}</Badge>
                    )}
                    {entry.country && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        {getCountryFlag(entry.country) ? (
                          <span className="text-sm leading-none">{getCountryFlag(entry.country)}</span>
                        ) : (
                          <Globe className="h-3 w-3" />
                        )}
                        {entry.country}
                      </span>
                    )}
                    {entry.was_live ? (
                      <Badge className="bg-green-500/10 text-green-500 text-xs border-0">Live</Badge>
                    ) : (
                      <Badge className="bg-red-500/10 text-red-500 text-xs border-0">Dead</Badge>
                    )}
                  </div>
                  {entry.email && (
                    <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5 truncate">
                      <Mail className="h-3 w-3 shrink-0" />
                      {entry.email}
                    </div>
                  )}
                  {entry.proxy_ip && (
                    <div className="text-[10px] text-muted-foreground/70 flex items-center gap-1 mt-0.5">
                      <Network className="h-2.5 w-2.5 shrink-0" />
                      Proxy: {entry.proxy_ip}
                    </div>
                  )}
                </div>
                <div className="text-xs text-muted-foreground shrink-0">
                  {new Date(entry.generated_at).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-8">
              <History className="h-8 w-8 text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">No accounts generated yet</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Account Generation / Hit Log Info Modal */}
      <AccountModal
        open={showAccountModal}
        onOpenChange={(open) => {
          setShowAccountModal(open);
          if (!open) setSelectedHitLog(null);
        }}
        account={generatedAccount}
        mode={accountModalMode}
        onRecheck={selectedHitLog ? () => handleRecheckHit(selectedHitLog, true) : undefined}
        onRecheckAnother={handleRecheckAnother}
      />
    </div>
  );
}

function StatCard({ label, value, icon, color }: { label: string; value: number | string; icon: React.ReactNode; color: string }) {
  return (
    <Card className="relative overflow-hidden">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <div className={color}>{icon}</div>
        </div>
        <div className="text-2xl font-bold">{value}</div>
      </CardContent>
    </Card>
  );
}

function CountryRow({ country, count, hits, total }: { country: string; count: number; hits: number; total: number }) {
  const percentage = total > 0 ? (count / total * 100) : 0;
  const flag = getCountryFlag(country);
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          {flag ? (
            <span className="text-base leading-none">{flag}</span>
          ) : (
            <Globe className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className="text-sm font-medium">{country}</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-green-500">{hits} hits</span>
          <span className="text-sm font-semibold">{count}</span>
        </div>
      </div>
      <div className="h-2 rounded-full bg-secondary overflow-hidden">
        <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}

function HitLogRow({
  log,
  isRechecking,
  onRecheck,
  onClick,
}: {
  log: ResultRecord;
  isRechecking: boolean;
  onRecheck: () => void;
  onClick: () => void;
}) {
  const icon = log.status === "success" ? <CheckCircle2 className="h-5 w-5 text-green-500" /> :
    log.status === "free" ? <CheckCircle2 className="h-5 w-5 text-blue-500" /> :
    <XCircle className="h-5 w-5 text-red-500" />;

  const isStale = (() => {
    const lastVerified = new Date(log.last_verified_at || log.checked_at);
    const daysSince = (Date.now() - lastVerified.getTime()) / (1000 * 60 * 60 * 24);
    return daysSince >= 7;
  })();

  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 hover:border-primary/30 transition-all cursor-pointer"
      onClick={onClick}
    >
      <div className={cn(
        "flex h-10 w-10 items-center justify-center rounded-lg shrink-0",
        log.status === "success" ? "bg-green-500/10" : "bg-blue-500/10"
      )}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {log.plan_name && (
            <Badge variant="secondary" className="text-xs">{log.plan_name}</Badge>
          )}
          {log.country && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              {getCountryFlag(log.country) ? (
                <span className="text-sm leading-none">{getCountryFlag(log.country)}</span>
              ) : (
                <Globe className="h-3 w-3" />
              )}
              {log.country}
            </span>
          )}
          {log.on_hold && (
            <Badge variant="outline" className="text-xs text-yellow-500 border-yellow-500/30">
              On Hold
            </Badge>
          )}
          {isStale && (
            <Badge variant="outline" className="text-xs text-yellow-500 border-yellow-500/30">
              <Clock className="h-3 w-3 mr-1" />
              Stale
            </Badge>
          )}
        </div>
        {log.email && (
          <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5 truncate">
            <Mail className="h-3 w-3 shrink-0" />
            {log.email}
          </div>
        )}
        {log.proxy_ip && (
          <div className="text-[10px] text-muted-foreground/70 flex items-center gap-1 mt-0.5">
            <Network className="h-2.5 w-2.5 shrink-0" />
            Proxy: {log.proxy_ip}
          </div>
        )}
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={(e) => { e.stopPropagation(); onRecheck(); }}
        disabled={isRechecking}
        className="shrink-0"
      >
        {isRechecking ? (
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
        ) : (
          <RefreshCw className="h-3 w-3 mr-1" />
        )}
        Recheck
      </Button>
    </div>
  );
}

function AccountModal({
  open,
  onOpenChange,
  account,
  mode,
  onRecheck,
  onRecheckAnother,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: GeneratedAccount | null;
  mode: "generate" | "hitlog";
  onRecheck?: () => Promise<void>;
  onRecheckAnother?: () => Promise<void>;
}) {
  const [isRechecking, setIsRechecking] = useState(false);
  if (!account) return null;

  const result = account.result;
  const rawInfo = (result.accountInfo || {}) as Record<string, any>;
  const isLive = result.isLive;

  // Merge stored accountInfo with top-level result fallbacks so the modal
  // always shows basic fields even when accountInfo was not captured.
  const info: Record<string, any> = {
    ...rawInfo,
    email: rawInfo.email || result.email || null,
    countryOfSignup: rawInfo.countryOfSignup || result.country || null,
    localizedPlanName: rawInfo.localizedPlanName || result.planName || null,
    status: result.status || null,
    reason: result.reason || null,
    membershipStatus: rawInfo.membershipStatus || (isLive ? "Active" : "Inactive") || null,
  };
  // Remove fields the user asked to delete
  delete info.accountOwnerName;
  delete info.planKey;

  // Required fields that should always appear in the modal, even when missing.
  const requiredFields = [
    "maxStreams",
    "planPrice",
    "nextBillingDate",
    "paymentMethodType",
    "isExtraMemberAccount",
  ];

  const proxyIp = result.proxyIp || null;

  const planLabel = info.localizedPlanName || info.planKey || "Unknown";
  const country = info.countryOfSignup || "Unknown";
  const email = info.email || "Unknown";

  const handleRecheck = async () => {
    const handler = mode === "hitlog" ? onRecheck : onRecheckAnother;
    if (!handler) return;
    setIsRechecking(true);
    try {
      await handler();
    } finally {
      setIsRechecking(false);
    }
  };

  const priorityOrder = [
    "email",
    "countryOfSignup",
    "localizedPlanName",
    "memberSince",
    "videoQuality",
    "maxStreams",
    "planPrice",
    "nextBillingDate",
    "paymentMethodType",
    "maskedCard",
    "phoneNumber",
    "holdStatus",
    "isExtraMemberAccount",
    "emailVerified",
    "membershipStatus",
    "phoneVerified",
    "showExtraMemberSection",
    "profileCount",
    "userGuid",
    "status",
    "reason",
  ];

  const labelMap: Record<string, string> = {
    email: "Email",
    countryOfSignup: "Country",
    localizedPlanName: "Plan",
    memberSince: "Member Since",
    videoQuality: "Quality",
    maxStreams: "Max Streams",
    planPrice: "Price",
    nextBillingDate: "Next Billing",
    paymentMethodType: "Payment Method",
    maskedCard: "Card",
    phoneNumber: "Phone",
    holdStatus: "Hold Status",
    isExtraMemberAccount: "Extra Members",
    emailVerified: "Email Verified",
    membershipStatus: "Membership Status",
    phoneVerified: "Phone Verified",
    showExtraMemberSection: "Extra Member Section",
    profileCount: "Profile Count",
    userGuid: "User GUID",
    status: "Status",
    reason: "Reason",
  };

  const accountEntries = Object.entries(info)
    .filter(([key, value]) => {
      if (requiredFields.includes(key)) return false;
      return value !== null && value !== undefined && String(value).trim() !== "" && String(value).toLowerCase() !== "null";
    })
    .sort(([a], [b]) => {
      const aIndex = priorityOrder.indexOf(a);
      const bIndex = priorityOrder.indexOf(b);
      if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    });

  const nfTokenLinks = result.nfTokenLinks?.length
    ? result.nfTokenLinks
    : result.nfTokenData?.token
    ? [
        ["🖥️ PC Login", `https://netflix.com/?nftoken=${result.nfTokenData.token}`],
        ["📱 Mobile Login", `https://netflix.com/unsupported?nftoken=${result.nfTokenData.token}`],
        ["📺 TV Login", `https://www.netflix.com/activate?nftoken=${result.nfTokenData.token}`],
      ]
    : [];

  const modalContent = (
    <>
      <div className="relative px-4 pt-3 pb-2 sm:px-5 border-b border-border/50 shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge className="bg-primary/20 text-primary border-primary/30 hover:bg-primary/20 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">
                {planLabel}
              </Badge>
              <Badge variant="secondary" className="px-2.5 py-0.5 text-[10px] font-semibold uppercase">
                {getCountryFlag(country) ? `${getCountryFlag(country)} ${country}` : country}
              </Badge>
            </div>
            <div className="mt-1.5 text-xs text-muted-foreground flex items-center gap-1">
              <Mail className="h-3 w-3 shrink-0" />
              <span className="truncate">{email}</span>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-full shrink-0"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-3 sm:p-4 space-y-3">
            <div
              className={cn(
                "flex items-center gap-2 rounded-lg p-2.5 border",
                isLive
                  ? "bg-green-500/10 border-green-500/30"
                  : "bg-red-500/10 border-red-500/30"
              )}
            >
              {isLive ? (
                <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
              ) : (
                <XCircle className="h-5 w-5 text-red-500 shrink-0" />
              )}
              <div className="min-w-0">
                <div className={cn("font-bold text-xs", isLive ? "text-green-500" : "text-red-500")}>
                  {isLive ? "Account is LIVE" : "Account is NOT live"}
                </div>
                <div className="text-[10px] text-muted-foreground truncate">
                  {result.status} {result.reason ? `— ${result.reason}` : ""}
                </div>
              </div>
            </div>

            {proxyIp && (
              <div className="flex items-center gap-2 rounded-lg bg-secondary/50 p-2 border border-border/40">
                <Network className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-[11px] text-muted-foreground">Checked via proxy:</span>
                <span className="text-xs font-mono font-medium text-foreground">{proxyIp}</span>
              </div>
            )}

            {nfTokenLinks.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold">
                  <Zap className="h-3.5 w-3.5 text-primary shrink-0" />
                  Login Redirects
                </div>
                <div className="grid grid-cols-1 gap-1.5">
                  {nfTokenLinks.map(([label, url]) => (
                    <a
                      key={label}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block"
                    >
                      <Button
                        variant="outline"
                        className="w-full justify-start h-9 text-xs border-primary/30 hover:bg-primary/10 hover:text-primary"
                      >
                        <ExternalLink className="h-3.5 w-3.5 mr-2 shrink-0" />
                        {label}
                      </Button>
                    </a>
                  ))}
                </div>
                {result.nfTokenData?.expires_at_utc && (
                  <p className="text-[10px] text-muted-foreground">
                    NFToken expires: {result.nfTokenData.expires_at_utc}
                  </p>
                )}
              </div>
            )}

            <div className="space-y-0.5">
              {requiredFields.map((key) => {
                const value = info[key] ?? "N/A";
                return (
                  <InfoRow
                    key={key}
                    label={labelMap[key] || key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase())}
                    value={String(value)}
                    required
                  />
                );
              })}
              {accountEntries.map(([key, value]) => (
                <InfoRow
                  key={key}
                  label={labelMap[key] || key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase())}
                  value={String(value)}
                />
              ))}
              {accountEntries.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No additional account information was captured for this cookie.
                </p>
              )}
            </div>
          </div>
        </ScrollArea>
      </div>

      <div className="border-t border-border/50 p-3 sm:p-4 shrink-0 space-y-2">
        <Button
          variant="outline"
          className="w-full h-10 text-xs"
          onClick={handleRecheck}
          disabled={isRechecking || !onRecheckAnother}
        >
          {isRechecking ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          )}
          {mode === "hitlog" ? "Recheck Account" : "Recheck Another Account"}
        </Button>
        <Button className="w-full h-10 bg-primary hover:bg-primary/90 text-xs" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      </div>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/85 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 flex flex-col gap-0 overflow-hidden rounded-2xl border border-border/60 shadow-2xl bg-[#0f0f12]/95 backdrop-blur-xl",
            "w-[94%] max-w-[420px] max-h-[88dvh]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          )}
        >
          <div className="sr-only">
            <DialogTitle>Generated Account</DialogTitle>
            <DialogDescription>
              Account generated from stored hit database and rechecked for liveness
            </DialogDescription>
          </div>
          {modalContent}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </Dialog>
  );
}

function InfoRow({ label, value, required }: { label: string; value: string; required?: boolean }) {
  const isMissing = value === "N/A" || value === "" || value.toLowerCase() === "null";
  return (
    <div className={cn(
      "flex items-start justify-between border-b border-border/40 py-1.5 gap-3",
      required && isMissing && "opacity-70"
    )}>
      <span className="text-muted-foreground text-[11px] shrink-0 pt-0.5">{label}</span>
      <span className={cn(
        "font-medium text-xs break-all text-right",
        isMissing ? "text-muted-foreground italic" : "text-foreground"
      )}>{String(value)}</span>
    </div>
  );
}


