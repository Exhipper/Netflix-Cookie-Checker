import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, CheckCircle2, XCircle, Copy, AlertTriangle, Download, Clock, Globe, Mail, RefreshCw, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getRun, getRunResults, recheckHits, getDefaultConfig, subscribeToRun, type RunRecord, type ResultRecord } from "@/lib/api";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useNavigate } from "react-router-dom";
import { useRef } from "react";

export default function RunDetail() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const [run, setRun] = useState<RunRecord | null>(null);
  const [results, setResults] = useState<ResultRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [isRechecking, setIsRechecking] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!runId) return;
    async function load() {
      try {
        const [r, res] = await Promise.all([
          getRun(runId!),
          getRunResults(runId!, 200, 0),
        ]);
        setRun(r);
        setResults(res);
      } catch {
        toast.error("Failed to load run details");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    getRunResults(runId, 200, 0, statusFilter).then(setResults).catch(() => {});
  }, [runId, statusFilter]);

  const filteredResults = results;

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  const handleRecheckThisRun = async () => {
    if (!runId) return;
    setIsRechecking(true);
    try {
      const config = await getDefaultConfig().catch(() => ({}));
      const result = await recheckHits("", config, 30);
      toast.success(`Recheck started: ${result.total} stored hits`);
      const es = subscribeToRun(result.runId, (update) => {
        if (update.type === "complete") {
          setIsRechecking(false);
          toast.success("Recheck completed!", {
            description: `${update.counts?.hits || 0} hits, ${update.counts?.free || 0} free, ${update.counts?.bad || 0} bad`,
          });
          es.close();
          navigate(`/runs/${result.runId}`);
        } else if (update.type === "error") {
          setIsRechecking(false);
          toast.error(update.message || "Recheck failed");
          es.close();
        }
      });
      eventSourceRef.current = es;
    } catch (err: any) {
      toast.error(err.message || "Failed to start recheck");
      setIsRechecking(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  const downloadResult = (result: ResultRecord) => {
    const blob = new Blob([result.formatted_output || result.cookie_content || ""], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `result_${result.id}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="p-8 max-w-7xl mx-auto">
        <div className="h-8 w-48 bg-secondary animate-pulse rounded mb-6" />
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 bg-secondary animate-pulse rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="p-8 max-w-7xl mx-auto">
        <p className="text-muted-foreground">Run not found</p>
        <Link to="/history" className="mt-4 inline-block">
          <Button variant="outline">Back to History</Button>
        </Link>
      </div>
    );
  }

  const validCount = run.hits + run.free;
  const successRate = run.total_cookies > 0 ? (validCount / run.total_cookies * 100).toFixed(1) : "0";

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <Link to="/history" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Back to History
        </Link>
        <Button
          onClick={handleRecheckThisRun}
          variant="outline"
          size="sm"
          disabled={isRechecking}
        >
          {isRechecking ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-2" />
          )}
          {isRechecking ? "Rechecking..." : "Recheck All Hits"}
        </Button>
      </div>

      {/* Run Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-3xl font-bold tracking-tight">Run Details</h1>
          <Badge variant="outline" className={cn(
            "capitalize",
            run.status === "completed" && "text-green-500 border-green-500/30",
            run.status === "running" && "text-primary border-primary/30",
            run.status === "cancelled" && "text-yellow-500 border-yellow-500/30",
          )}>
            {run.status}
          </Badge>
        </div>
        <p className="text-muted-foreground">
          Started {new Date(run.started_at).toLocaleString()}
          {run.completed_at && ` • Completed ${new Date(run.completed_at).toLocaleString()}`}
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6 mb-8">
        <StatCard label="Total" value={run.total_cookies} />
        <StatCard label="Hits" value={run.hits} color="text-green-500" />
        <StatCard label="Free" value={run.free} color="text-blue-500" />
        <StatCard label="Bad" value={run.bad} color="text-red-500" />
        <StatCard label="Duplicates" value={run.duplicate} color="text-yellow-500" />
        <StatCard label="Errors" value={run.errors} color="text-orange-500" />
      </div>

      {/* Results */}
      <Tabs defaultValue="results">
        <div className="flex items-center justify-between mb-4">
          <TabsList>
            <TabsTrigger value="results">Results ({filteredResults.length})</TabsTrigger>
            <TabsTrigger value="hits">Hits Only</TabsTrigger>
            <TabsTrigger value="config">Config</TabsTrigger>
          </TabsList>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="success">Success</SelectItem>
              <SelectItem value="free">Free</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="duplicate">Duplicate</SelectItem>
              <SelectItem value="error">Error</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <TabsContent value="results" className="space-y-2">
          {filteredResults.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                No results found
              </CardContent>
            </Card>
          ) : (
            filteredResults.map((result) => (
              <ResultCard
                key={result.id}
                result={result}
                onCopy={copyToClipboard}
                onDownload={downloadResult}
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="hits" className="space-y-2">
          {filteredResults.filter((r) => r.status === "success").length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                No hits in this run
              </CardContent>
            </Card>
          ) : (
            filteredResults.filter((r) => r.status === "success").map((result) => (
              <ResultCard
                key={result.id}
                result={result}
                onCopy={copyToClipboard}
                onDownload={downloadResult}
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="config">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Run Configuration</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="text-xs bg-secondary/50 rounded-md p-4 overflow-auto max-h-96 font-mono">
                {JSON.stringify(run.config, null, 2)}
              </pre>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatCard({ label, value, color = "text-foreground" }: { label: string; value: number; color?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground mb-1">{label}</div>
        <div className={cn("text-xl font-bold", color)}>{value}</div>
      </CardContent>
    </Card>
  );
}

function ResultCard({
  result,
  onCopy,
  onDownload,
}: {
  result: ResultRecord;
  onCopy: (text: string) => void;
  onDownload: (result: ResultRecord) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const info = result.account_info || {};

  const icon = result.status === "success" ? <CheckCircle2 className="h-5 w-5 text-green-500" /> :
    result.status === "free" ? <CheckCircle2 className="h-5 w-5 text-blue-500" /> :
    result.status === "duplicate" ? <Copy className="h-5 w-5 text-yellow-500" /> :
    result.status === "error" ? <AlertTriangle className="h-5 w-5 text-orange-500" /> :
    <XCircle className="h-5 w-5 text-red-500" />;

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4">
        <div
          className="flex items-center gap-3 cursor-pointer"
          onClick={() => setExpanded(!expanded)}
        >
          {icon}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium capitalize">{result.status}</span>
              {result.plan_name && (
                <Badge variant="secondary" className="text-xs">{result.plan_name}</Badge>
              )}
              {result.on_hold && (
                <Badge variant="outline" className="text-xs text-yellow-500 border-yellow-500/30">
                  On Hold
                </Badge>
              )}
              {result.country && (
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Globe className="h-3 w-3" />
                  {result.country}
                </span>
              )}
            </div>
            {result.email && (
              <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                <Mail className="h-3 w-3" />
                {result.email}
              </div>
            )}
            {result.reason && (
              <div className="text-xs text-red-400 mt-0.5">{result.reason}</div>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {result.formatted_output && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0"
                onClick={(e) => { e.stopPropagation(); onCopy(result.formatted_output || ""); }}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            )}
            {result.formatted_output && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0"
                onClick={(e) => { e.stopPropagation(); onDownload(result); }}
              >
                <Download className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        {expanded && (
          <div className="mt-4 space-y-3 animate-slide-up">
            {Object.keys(info).length > 0 && (
              <div className="grid grid-cols-2 gap-2 text-xs">
                {info.accountOwnerName && <InfoRow label="Name" value={info.accountOwnerName} />}
                {info.email && <InfoRow label="Email" value={info.email} />}
                {info.countryOfSignup && <InfoRow label="Country" value={info.countryOfSignup} />}
                {info.localizedPlanName && <InfoRow label="Plan" value={info.localizedPlanName} />}
                {info.planPrice && <InfoRow label="Price" value={info.planPrice} />}
                {info.videoQuality && <InfoRow label="Quality" value={info.videoQuality} />}
                {info.maxStreams && <InfoRow label="Max Streams" value={info.maxStreams} />}
                {info.membershipStatus && <InfoRow label="Membership" value={info.membershipStatus} />}
                {info.paymentMethodType && <InfoRow label="Payment" value={info.paymentMethodType} />}
                {info.maskedCard && <InfoRow label="Card" value={info.maskedCard} />}
                {info.memberSince && <InfoRow label="Member Since" value={info.memberSince} />}
                {info.nextBillingDate && <InfoRow label="Next Billing" value={info.nextBillingDate} />}
                {info.holdStatus && <InfoRow label="Hold Status" value={info.holdStatus} />}
                {info.emailVerified && <InfoRow label="Email Verified" value={info.emailVerified} />}
                {info.profilesDisplay && <InfoRow label="Profiles" value={info.profilesDisplay} />}
              </div>
            )}
            {result.nftoken_data && result.nftoken_data.token && (
              <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
                <div className="text-xs font-medium text-primary mb-1">NFToken</div>
                <div className="text-xs font-mono break-all text-muted-foreground">{result.nftoken_data.token}</div>
                {result.nftoken_data.expires_at_utc && (
                  <div className="text-xs text-muted-foreground mt-1">Expires: {result.nftoken_data.expires_at_utc}</div>
                )}
              </div>
            )}
            {result.cookie_content && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">Cookie Content</div>
                <pre className="text-xs bg-secondary/50 rounded-md p-3 overflow-auto max-h-48 font-mono">
                  {result.cookie_content}
                </pre>
              </div>
            )}
            {result.formatted_output && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">Formatted Output</div>
                <pre className="text-xs bg-secondary/50 rounded-md p-3 overflow-auto max-h-64 font-mono">
                  {result.formatted_output}
                </pre>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/50 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-right truncate ml-2">{String(value)}</span>
    </div>
  );
}
