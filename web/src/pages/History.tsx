import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, XCircle, Activity, Clock, Trash2, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getRuns, deleteRun, type RunRecord } from "@/lib/api";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export default function History() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadRuns();
  }, []);

  async function loadRuns() {
    try {
      const data = await getRuns();
      setRuns(data);
    } catch {
      toast.error("Failed to load runs");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(runId: string) {
    try {
      await deleteRun(runId);
      setRuns((prev) => prev.filter((r) => r.id !== runId));
      toast.success("Run deleted");
    } catch {
      toast.error("Failed to delete run");
    }
  }

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto animate-fade-in">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Run History</h1>
        <p className="text-muted-foreground mt-1">View and manage all past cookie checking runs</p>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-20 rounded-lg bg-secondary animate-pulse" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Clock className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">No runs yet</p>
            <Link to="/checker" className="mt-4">
              <Button variant="outline">Start a Check</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => (
            <div
              key={run.id}
              className="group flex items-center gap-4 rounded-lg border border-border bg-card p-4 hover:border-primary/40 transition-all"
            >
              <Link to={`/runs/${run.id}`} className="flex items-center gap-4 flex-1 min-w-0">
                <div className={cn(
                  "flex h-11 w-11 items-center justify-center rounded-lg shrink-0",
                  run.status === "completed" ? "bg-green-500/10 text-green-500" :
                  run.status === "running" ? "bg-primary/10 text-primary" :
                  run.status === "cancelled" ? "bg-yellow-500/10 text-yellow-500" :
                  "bg-red-500/10 text-red-500"
                )}>
                  {run.status === "completed" ? <CheckCircle2 className="h-5 w-5" /> :
                   run.status === "running" ? <Activity className="h-5 w-5 animate-pulse" /> :
                   <XCircle className="h-5 w-5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {new Date(run.started_at).toLocaleString()}
                    </span>
                    <Badge variant="outline" className={cn(
                      "text-xs capitalize",
                      run.status === "completed" && "text-green-500 border-green-500/30",
                      run.status === "running" && "text-primary border-primary/30",
                      run.status === "cancelled" && "text-yellow-500 border-yellow-500/30",
                    )}>
                      {run.status}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    <span>{run.total_cookies} cookies</span>
                    <span className="text-green-500">{run.hits} hits</span>
                    <span className="text-blue-500">{run.free} free</span>
                    <span className="text-red-500">{run.bad} bad</span>
                    {run.duplicate > 0 && <span className="text-yellow-500">{run.duplicate} dup</span>}
                    {run.on_hold > 0 && <span className="text-cyan-500">{run.on_hold} hold</span>}
                    {run.errors > 0 && <span className="text-orange-500">{run.errors} err</span>}
                  </div>
                </div>
              </Link>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => handleDelete(run.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
                <Link to={`/runs/${run.id}`}>
                  <ChevronRight className="h-5 w-5 text-muted-foreground" />
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
