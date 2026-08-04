import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ScanLine, TrendingUp, CheckCircle2, XCircle, Copy, AlertCircle, Clock, Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { getStats, checkHealth, type RunRecord } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function Dashboard() {
  const [stats, setStats] = useState<any>(null);
  const [health, setHealth] = useState<{ status: string; database: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [s, h] = await Promise.all([
          getStats().catch(() => null),
          checkHealth().catch(() => null),
        ]);
        setStats(s);
        setHealth(h);
      } finally {
        setLoading(false);
      }
    }
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  const totalChecked = stats?.totalResults || 0;
  const totalHits = stats?.statusBreakdown?.find((s: any) => s.status === "success")?.count || 0;
  const totalFree = stats?.statusBreakdown?.find((s: any) => s.status === "free")?.count || 0;
  const totalBad = stats?.statusBreakdown?.find((s: any) => s.status === "failed")?.count || 0;
  const totalErrors = stats?.statusBreakdown?.find((s: any) => s.status === "error")?.count || 0;
  const totalDuplicates = stats?.statusBreakdown?.find((s: any) => s.status === "duplicate")?.count || 0;
  const successRate = totalChecked > 0 ? ((totalHits + totalFree) / totalChecked * 100).toFixed(1) : "0";

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Monitor your Netflix cookie checking operations</p>
        </div>
        <Link to="/checker">
          <Button className="bg-primary hover:bg-primary/90 glow-red">
            <ScanLine className="h-4 w-4 mr-2" />
            Start New Check
          </Button>
        </Link>
      </div>

      {/* Health Status */}
      <div className="mb-6 flex items-center gap-3">
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
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 mb-8">
        <StatCard
          label="Total Runs"
          value={stats?.totalRuns || 0}
          icon={<TrendingUp className="h-5 w-5" />}
          color="text-blue-500"
        />
        <StatCard
          label="Cookies Checked"
          value={totalChecked}
          icon={<ScanLine className="h-5 w-5" />}
          color="text-purple-500"
        />
        <StatCard
          label="Success Rate"
          value={`${successRate}%`}
          icon={<CheckCircle2 className="h-5 w-5" />}
          color="text-green-500"
        />
        <StatCard
          label="Active Hits"
          value={totalHits}
          icon={<Activity className="h-5 w-5" />}
          color="text-primary"
        />
      </div>

      {/* Status Breakdown */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Status Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <StatusRow label="Hits (Subscribed)" value={totalHits} total={totalChecked} color="bg-green-500" />
            <StatusRow label="Free (No Sub)" value={totalFree} total={totalChecked} color="bg-blue-500" />
            <StatusRow label="Failed" value={totalBad} total={totalChecked} color="bg-red-500" />
            <StatusRow label="Duplicates" value={totalDuplicates} total={totalChecked} color="bg-yellow-500" />
            <StatusRow label="Errors" value={totalErrors} total={totalChecked} color="bg-orange-500" />
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

      {/* Recent Runs */}
      <div className="mt-8">
        <h2 className="text-xl font-semibold mb-4">Recent Runs</h2>
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 rounded-lg bg-secondary animate-pulse" />
            ))}
          </div>
        ) : stats?.recentRuns?.length > 0 ? (
          <div className="space-y-2">
            {stats.recentRuns.map((run: RunRecord) => (
              <Link
                key={run.id}
                to={`/runs/${run.id}`}
                className="flex items-center justify-between rounded-lg border border-border bg-card p-4 hover:border-primary/50 transition-all"
              >
                <div className="flex items-center gap-4">
                  <div className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-lg",
                    run.status === "completed" ? "bg-green-500/10 text-green-500" :
                    run.status === "running" ? "bg-primary/10 text-primary" :
                    run.status === "cancelled" ? "bg-yellow-500/10 text-yellow-500" :
                    "bg-red-500/10 text-red-500"
                  )}>
                    {run.status === "completed" ? <CheckCircle2 className="h-5 w-5" /> :
                     run.status === "running" ? <Activity className="h-5 w-5 animate-pulse" /> :
                     <XCircle className="h-5 w-5" />}
                  </div>
                  <div>
                    <div className="text-sm font-medium">
                      {new Date(run.started_at).toLocaleString()}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {run.total_cookies} cookies processed
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-green-500 font-medium">{run.hits} hits</span>
                  <span className="text-blue-500">{run.free} free</span>
                  <span className="text-red-500">{run.bad} bad</span>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <AlertCircle className="h-8 w-8 text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">No runs yet. Start your first check!</p>
              <Link to="/checker" className="mt-4">
                <Button variant="outline" size="sm">
                  <ScanLine className="h-4 w-4 mr-2" />
                  Go to Checker
                </Button>
              </Link>
            </CardContent>
          </Card>
        )}
      </div>
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

function StatusRow({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const percentage = total > 0 ? (value / total * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="text-sm font-semibold">{value}</span>
      </div>
      <div className="h-2 rounded-full bg-secondary overflow-hidden">
        <div className={cn("h-full rounded-full transition-all duration-500", color)} style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}
