import { useEffect, useState, useRef, useCallback } from "react";
import {
  TrendingUp,
  CheckCircle2,
  XCircle,
  Copy,
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
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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
  type ResultRecord,
  type GeneratedAccount,
} from "@/lib/api";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export default function Dashboard() {
  const [stats, setStats] = useState<any>(null);
  const [health, setHealth] = useState<{ status: string; database: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [recheckCount, setRecheckCount] = useState<number | null>(null);
  const [isRechecking, setIsRechecking] = useState(false);
  const [countryBreakdown, setCountryBreakdown] = useState<
    Array<{ country: string; count: number; hits: number; free: number }>
  >([]);
  const [hitLogs, setHitLogs] = useState<ResultRecord[]>([]);
  const [hitLogsTotal, setHitLogsTotal] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedAccount, setGeneratedAccount] = useState<GeneratedAccount | null>(null);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const dashboardEventSourceRef = useRef<EventSource | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [s, h, rc, cb, hl] = await Promise.all([
        getStats().catch(() => null),
        checkHealth().catch(() => null),
        getRecheckCount().catch(() => null),
        getCountryBreakdown().catch(() => []),
        getHitLogs(20, 0).catch(() => ({ logs: [], total: 0 })),
      ]);
      setStats(s);
      setHealth(h);
      if (rc) setRecheckCount(rc.count);
      setCountryBreakdown(cb as typeof countryBreakdown);
      setHitLogs((hl as any).logs);
      setHitLogsTotal((hl as any).total);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Auto-deduplicate on first load
    deduplicateHits().catch(() => {});
    loadData();
    const interval = setInterval(loadData, 10000);
    return () => clearInterval(interval);
  }, [loadData]);

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
      const result = await recheckHits("", config, 30);
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
      const result = await generateAccount("", config, 30);
      setGeneratedAccount(result);
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

  const totalChecked = stats?.totalResults || 0;
  const activeCookies = stats?.activeCookies || 0;
  const totalHits = stats?.totalHits || 0;
  const totalCookiesStored = stats?.totalCookiesStored || 0;
  const successRate = totalChecked > 0 ? ((totalHits) / totalChecked * 100).toFixed(1) : "0";

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Monitor your Netflix cookie database in real-time</p>
        </div>
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
                    free={entry.free}
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

      {/* Real-time Cookie Hit Logs */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold">Cookie Hit Logs</h2>
            <Badge variant="secondary" className="text-xs">{hitLogsTotal} total stored</Badge>
          </div>
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
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-16 rounded-lg bg-secondary animate-pulse" />
            ))}
          </div>
        ) : hitLogs.length > 0 ? (
          <div className="space-y-2">
            {hitLogs.map((log) => (
              <HitLogRow key={log.id} log={log} />
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

      {/* Account Generation Modal */}
      <AccountModal
        open={showAccountModal}
        onOpenChange={setShowAccountModal}
        account={generatedAccount}
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

function CountryRow({ country, count, hits, free, total }: { country: string; count: number; hits: number; free: number; total: number }) {
  const percentage = total > 0 ? (count / total * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <Globe className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-sm font-medium">{country}</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-green-500">{hits} hits</span>
          <span className="text-blue-500">{free} free</span>
          <span className="text-sm font-semibold">{count}</span>
        </div>
      </div>
      <div className="h-2 rounded-full bg-secondary overflow-hidden">
        <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}

function HitLogRow({ log }: { log: ResultRecord }) {
  const icon = log.status === "success" ? <CheckCircle2 className="h-5 w-5 text-green-500" /> :
    log.status === "free" ? <CheckCircle2 className="h-5 w-5 text-blue-500" /> :
    <XCircle className="h-5 w-5 text-red-500" />;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 hover:border-primary/30 transition-all">
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
              <Globe className="h-3 w-3" />
              {log.country}
            </span>
          )}
          {log.on_hold && (
            <Badge variant="outline" className="text-xs text-yellow-500 border-yellow-500/30">
              On Hold
            </Badge>
          )}
        </div>
        {log.email && (
          <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5 truncate">
            <Mail className="h-3 w-3 shrink-0" />
            {log.email}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
        <Clock className="h-3 w-3" />
        {new Date(log.checked_at).toLocaleString()}
      </div>
    </div>
  );
}

function AccountModal({
  open,
  onOpenChange,
  account,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: GeneratedAccount | null;
}) {
  if (!account) return null;

  const result = account.result;
  const info = result.accountInfo || {};
  const isLive = result.isLive;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  // Account fields to display with friendly labels and fallback values
  const accountFields = [
    { key: "accountOwnerName", label: "Name" },
    { key: "email", label: "Email" },
    { key: "countryOfSignup", label: "Country" },
    { key: "localizedPlanName", label: "Plan" },
    { key: "planPrice", label: "Price" },
    { key: "maxStreams", label: "Max Streams" },
    { key: "videoQuality", label: "Quality" },
    { key: "paymentMethodType", label: "Payment" },
    { key: "maskedCard", label: "Card" },
    { key: "memberSince", label: "Member Since" },
    { key: "nextBillingDate", label: "Next Billing" },
    { key: "membershipStatus", label: "Membership" },
    { key: "holdStatus", label: "Hold Status" },
    { key: "emailVerified", label: "Email Verified" },
    { key: "profilesDisplay", label: "Profiles" },
    { key: "userGuid", label: "User GUID" },
  ];

  const visibleFields = accountFields.filter((f) => {
    const value = info[f.key];
    return value !== null && value !== undefined && value !== "" && value !== "null";
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] max-w-2xl h-[90vh] sm:h-auto sm:max-h-[90vh] p-0 gap-0 overflow-hidden">
        <div className="flex flex-col h-full">
          <DialogHeader className="px-4 pt-5 pb-3 sm:px-6 border-b">
            <DialogTitle className="flex items-center gap-2 text-lg sm:text-xl">
              <Sparkles className="h-5 w-5 text-primary shrink-0" />
              Generated Account
            </DialogTitle>
            <DialogDescription className="text-xs sm:text-sm">
              Account generated from stored hit database and rechecked for liveness
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="flex-1 min-h-0">
            <div className="p-4 sm:p-6 space-y-5">
              {/* Live Status Banner */}
              <div className={cn(
                "flex items-center gap-3 rounded-lg p-3 sm:p-4",
                isLive ? "bg-green-500/10 border border-green-500/30" : "bg-red-500/10 border border-red-500/30"
              )}>
                {isLive ? (
                  <CheckCircle2 className="h-6 w-6 text-green-500 shrink-0" />
                ) : (
                  <XCircle className="h-6 w-6 text-red-500 shrink-0" />
                )}
                <div className="min-w-0">
                  <div className={cn("font-semibold text-sm sm:text-base", isLive ? "text-green-500" : "text-red-500")}>
                    {isLive ? "Account is LIVE" : "Account is NOT live"}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {result.status} {result.reason ? `— ${result.reason}` : ""}
                  </div>
                </div>
              </div>

              {/* Account Info Grid */}
              {visibleFields.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                  {visibleFields.map((f) => (
                    <InfoRow key={f.key} label={f.label} value={String(info[f.key])} />
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-border bg-secondary/30 p-4 text-sm text-muted-foreground">
                  No detailed account info available from the recheck.
                </div>
              )}

              {/* NFToken Redirect Buttons */}
              {result.nfTokenLinks && result.nfTokenLinks.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Zap className="h-4 w-4 text-primary shrink-0" />
                    NFToken Login Links
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {result.nfTokenLinks.map(([label, url]) => (
                      <a key={label} href={url} target="_blank" rel="noopener noreferrer" className="block">
                        <Button variant="outline" className="w-full justify-start h-11 text-sm">
                          <ExternalLink className="h-4 w-4 mr-2 shrink-0" />
                          {label}
                        </Button>
                      </a>
                    ))}
                  </div>
                  {result.nfTokenData?.expires_at_utc && (
                    <p className="text-xs text-muted-foreground">
                      NFToken expires: {result.nfTokenData.expires_at_utc}
                    </p>
                  )}
                </div>
              )}

              {/* Cookie Content */}
              {result.cookieContent && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium">Cookie Content</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-xs"
                      onClick={() => copyToClipboard(result.cookieContent || "")}
                    >
                      <Copy className="h-3 w-3 mr-1" />
                      Copy
                    </Button>
                  </div>
                  <pre className="text-xs bg-secondary/50 rounded-md p-3 overflow-auto max-h-40 sm:max-h-48 font-mono">
                    {result.cookieContent}
                  </pre>
                </div>
              )}

              {/* Formatted Output */}
              {result.formattedOutput && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium">Formatted Output</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-xs"
                      onClick={() => copyToClipboard(result.formattedOutput || "")}
                    >
                      <Copy className="h-3 w-3 mr-1" />
                      Copy
                    </Button>
                  </div>
                  <pre className="text-xs bg-secondary/50 rounded-md p-3 overflow-auto max-h-48 sm:max-h-64 font-mono">
                    {result.formattedOutput}
                  </pre>
                </div>
              )}
            </div>
          </ScrollArea>

          {/* Footer close button for mobile friendliness */}
          <div className="border-t p-3 sm:p-4 sm:hidden">
            <Button variant="outline" className="w-full" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-border/50 py-2 gap-0.5 sm:gap-2">
      <span className="text-muted-foreground text-xs shrink-0">{label}</span>
      <span className="font-medium text-sm text-right break-all">{String(value)}</span>
    </div>
  );
}
