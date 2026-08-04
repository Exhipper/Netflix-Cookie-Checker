import { useState, useRef, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Upload, FileText, X, Play, Square, Loader2, Settings2, Globe, Zap, CheckCircle2, XCircle, AlertTriangle, Copy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  startCheck,
  subscribeToRun,
  cancelRun,
  getDefaultConfig,
  type ProgressUpdate,
  type AppConfig,
} from "@/lib/api";
import { cn } from "@/lib/utils";

interface CookieFile {
  name: string;
  content: string;
  size: number;
}

export default function Checker() {
  const navigate = useNavigate();
  const [cookies, setCookies] = useState<CookieFile[]>([]);
  const [proxyText, setProxyText] = useState("");
  const [threads, setThreads] = useState(30);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [liveResults, setLiveResults] = useState<ProgressUpdate[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    getDefaultConfig().then(setConfig).catch(() => {});
  }, []);

  const handleFiles = useCallback((files: FileList) => {
    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result as string;
        setCookies((prev) => [
          ...prev,
          { name: file.name, content, size: file.size },
        ]);
      };
      reader.readAsText(file);
    });
    toast.success(`${files.length} file(s) added`);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const removeCookie = (index: number) => {
    setCookies((prev) => prev.filter((_, i) => i !== index));
  };

  const handleStartCheck = async () => {
    if (cookies.length === 0) {
      toast.error("Please add at least one cookie file");
      return;
    }
    setIsRunning(true);
    setLiveResults([]);
    setProgress(null);

    try {
      const result = await startCheck(cookies, proxyText, config || {}, threads);
      setRunId(result.runId);
      toast.success(`Check started: ${result.total} cookies, ${result.threads} threads`);

      const es = subscribeToRun(result.runId, (update) => {
        if (update.type === "result") {
          setProgress(update);
          setLiveResults((prev) => [update, ...prev].slice(0, 100));
        } else if (update.type === "complete") {
          setProgress(update);
          setIsRunning(false);
          toast.success("Check completed!", {
            description: `${update.counts?.hits || 0} hits, ${update.counts?.free || 0} free, ${update.counts?.bad || 0} bad`,
          });
          es.close();
        } else if (update.type === "error") {
          toast.error(update.message || "Check failed");
          setIsRunning(false);
          es.close();
        }
      });
      eventSourceRef.current = es;
    } catch (err: any) {
      toast.error(err.message || "Failed to start check");
      setIsRunning(false);
    }
  };

  const handleCancel = async () => {
    if (runId) {
      await cancelRun(runId).catch(() => {});
      setIsRunning(false);
      eventSourceRef.current?.close();
      toast.info("Check cancelled");
    }
  };

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  const processed = progress?.processed || 0;
  const total = progress?.total || cookies.length;
  const progressPercent = total > 0 ? (processed / total) * 100 : 0;
  const counts = progress?.counts;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto animate-fade-in">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Cookie Checker</h1>
        <p className="text-muted-foreground mt-1">
          Upload Netflix cookie files and check them against the Netflix API
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left: Input Area */}
        <div className="lg:col-span-2 space-y-6">
          {/* Cookie Upload */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <FileText className="h-5 w-5 text-primary" />
                Cookie Files
                {cookies.length > 0 && (
                  <Badge variant="secondary" className="ml-1">{cookies.length}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  "flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 cursor-pointer transition-all",
                  dragOver
                    ? "border-primary bg-primary/5 glow-red"
                    : "border-border hover:border-primary/50"
                )}
              >
                <Upload className="h-10 w-10 text-muted-foreground mb-3" />
                <p className="text-sm font-medium">Drop cookie files here or click to browse</p>
                <p className="text-xs text-muted-foreground mt-1">Supports .txt and .json formats</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".txt,.json"
                  className="hidden"
                  onChange={(e) => e.target.files && handleFiles(e.target.files)}
                />
              </div>

              {/* Cookie File List */}
              {cookies.length > 0 && (
                <div className="mt-4 space-y-2 max-h-48 overflow-y-auto">
                  {cookies.map((cookie, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between rounded-md border border-border bg-secondary/50 p-2.5"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="text-sm truncate">{cookie.name}</span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          ({(cookie.size / 1024).toFixed(1)} KB)
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={() => removeCookie(i)}
                        disabled={isRunning}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Proxy Input */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Globe className="h-5 w-5 text-primary" />
                Proxies (Optional)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                value={proxyText}
                onChange={(e) => setProxyText(e.target.value)}
                placeholder={"# Add proxies here (one per line)\n# Examples:\n# ip:port\n# user:pass@ip:port\n# socks5://user:pass@ip:port"}
                className="min-h-[100px] font-mono text-xs resize-y"
                disabled={isRunning}
              />
              <p className="text-xs text-muted-foreground mt-2">
                Supports HTTP, HTTPS, SOCKS4, and SOCKS5 proxy formats
              </p>
            </CardContent>
          </Card>

          {/* Advanced Settings */}
          <Card>
            <CardHeader>
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-2 text-lg font-semibold w-full text-left"
              >
                <Settings2 className="h-5 w-5 text-primary" />
                Advanced Settings
                <Badge variant="outline" className="ml-auto text-xs">
                  {showAdvanced ? "Hide" : "Show"}
                </Badge>
              </button>
            </CardHeader>
            {showAdvanced && config && (
              <CardContent className="space-y-5 animate-slide-up">
                <div>
                  <Label className="text-sm font-medium">Threads: {threads}</Label>
                  <Slider
                    value={[threads]}
                    onValueChange={(v) => setThreads(v[0])}
                    min={1}
                    max={300}
                    step={1}
                    className="mt-2"
                    disabled={isRunning}
                  />
                  <p className="text-xs text-muted-foreground mt-1">More threads = faster checking (1-300)</p>
                </div>

                <Separator />

                <div>
                  <Label className="text-sm font-medium">NFToken Mode</Label>
                  <Select
                    value={String(config.nftoken) === "true" ? "both" : String(config.nftoken)}
                    onValueChange={(v) => setConfig({ ...config, nftoken: v })}
                    disabled={isRunning}
                  >
                    <SelectTrigger className="mt-2">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="false">Disabled</SelectItem>
                      <SelectItem value="pc">PC Links Only</SelectItem>
                      <SelectItem value="mobile">Mobile Links Only</SelectItem>
                      <SelectItem value="both">Both PC & Mobile</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label className="text-sm font-medium">Request Timeout: {config.performance.request_timeout_seconds}s</Label>
                  <Slider
                    value={[config.performance.request_timeout_seconds]}
                    onValueChange={(v) => setConfig({
                      ...config,
                      performance: { ...config.performance, request_timeout_seconds: v[0] }
                    })}
                    min={5}
                    max={60}
                    step={1}
                    className="mt-2"
                    disabled={isRunning}
                  />
                </div>

                <div>
                  <Label className="text-sm font-medium">Retry Attempts: {config.retries.error_proxy_attempts}</Label>
                  <Slider
                    value={[config.retries.error_proxy_attempts]}
                    onValueChange={(v) => setConfig({
                      ...config,
                      retries: { ...config.retries, error_proxy_attempts: v[0] }
                    })}
                    min={1}
                    max={10}
                    step={1}
                    className="mt-2"
                    disabled={isRunning}
                  />
                </div>

                <Separator />

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">Fallback Account Page</Label>
                    <Switch
                      checked={config.performance.fallback_account_page}
                      onCheckedChange={(v) => setConfig({
                        ...config,
                        performance: { ...config.performance, fallback_account_page: v }
                      })}
                      disabled={isRunning}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">Retry Incomplete Info</Label>
                    <Switch
                      checked={config.performance.retry_incomplete_info}
                      onCheckedChange={(v) => setConfig({
                        ...config,
                        performance: { ...config.performance, retry_incomplete_info: v }
                      })}
                      disabled={isRunning}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">NFToken for Free Accounts</Label>
                    <Switch
                      checked={config.performance.nftoken_for_free}
                      onCheckedChange={(v) => setConfig({
                        ...config,
                        performance: { ...config.performance, nftoken_for_free: v }
                      })}
                      disabled={isRunning}
                    />
                  </div>
                </div>

                <Separator />

                <div>
                  <Label className="text-sm font-medium mb-2 block">Discord Webhook</Label>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-muted-foreground">Enable Discord notifications</span>
                    <Switch
                      checked={config.notifications.webhook.enabled}
                      onCheckedChange={(v) => setConfig({
                        ...config,
                        notifications: {
                          ...config.notifications,
                          webhook: { ...config.notifications.webhook, enabled: v }
                        }
                      })}
                      disabled={isRunning}
                    />
                  </div>
                  {config.notifications.webhook.enabled && (
                    <Textarea
                      value={config.notifications.webhook.url}
                      onChange={(e) => setConfig({
                        ...config,
                        notifications: {
                          ...config.notifications,
                          webhook: { ...config.notifications.webhook, url: e.target.value }
                        }
                      })}
                      placeholder="https://discord.com/api/webhooks/..."
                      className="text-xs"
                      disabled={isRunning}
                    />
                  )}
                </div>

                <div>
                  <Label className="text-sm font-medium mb-2 block">Telegram Bot</Label>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-muted-foreground">Enable Telegram notifications</span>
                    <Switch
                      checked={config.notifications.telegram.enabled}
                      onCheckedChange={(v) => setConfig({
                        ...config,
                        notifications: {
                          ...config.notifications,
                          telegram: { ...config.notifications.telegram, enabled: v }
                        }
                      })}
                      disabled={isRunning}
                    />
                  </div>
                  {config.notifications.telegram.enabled && (
                    <div className="space-y-2">
                      <Textarea
                        value={config.notifications.telegram.bot_token}
                        onChange={(e) => setConfig({
                          ...config,
                          notifications: {
                            ...config.notifications,
                            telegram: { ...config.notifications.telegram, bot_token: e.target.value }
                          }
                        })}
                        placeholder="Bot token from @BotFather"
                        className="text-xs"
                        disabled={isRunning}
                      />
                      <Textarea
                        value={config.notifications.telegram.chat_id}
                        onChange={(e) => setConfig({
                          ...config,
                          notifications: {
                            ...config.notifications,
                            telegram: { ...config.notifications.telegram, chat_id: e.target.value }
                          }
                        })}
                        placeholder="Chat ID (e.g. -1001234567890)"
                        className="text-xs"
                        disabled={isRunning}
                      />
                    </div>
                  )}
                </div>
              </CardContent>
            )}
          </Card>
        </div>

        {/* Right: Live Results / Action Panel */}
        <div className="space-y-6">
          {/* Action Button */}
          <Card className="sticky top-6">
            <CardContent className="p-5">
              {!isRunning ? (
                <Button
                  onClick={handleStartCheck}
                  className="w-full h-12 text-base bg-primary hover:bg-primary/90 glow-red"
                  disabled={cookies.length === 0}
                >
                  <Play className="h-5 w-5 mr-2" />
                  Start Check ({cookies.length} files)
                </Button>
              ) : (
                <Button
                  onClick={handleCancel}
                  variant="destructive"
                  className="w-full h-12 text-base"
                >
                  <Square className="h-5 w-5 mr-2" />
                  Cancel Check
                </Button>
              )}

              {/* Progress */}
              {(isRunning || progress) && (
                <div className="mt-5 space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Progress</span>
                    <span className="font-medium">{processed}/{total}</span>
                  </div>
                  <Progress value={progressPercent} className="h-2" />
                  {isRunning && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Checking cookies...
                    </div>
                  )}
                </div>
              )}

              {/* Live Stats */}
              {counts && (
                <div className="mt-5 grid grid-cols-3 gap-2">
                  <StatBox label="Hits" value={counts.hits} color="text-green-500 bg-green-500/10" />
                  <StatBox label="Free" value={counts.free} color="text-blue-500 bg-blue-500/10" />
                  <StatBox label="Bad" value={counts.bad} color="text-red-500 bg-red-500/10" />
                  <StatBox label="Dup" value={counts.duplicate} color="text-yellow-500 bg-yellow-500/10" />
                  <StatBox label="Hold" value={counts.on_hold} color="text-cyan-500 bg-cyan-500/10" />
                  <StatBox label="Err" value={counts.errors} color="text-orange-500 bg-orange-500/10" />
                </div>
              )}

              {progress?.planCounts && Object.keys(progress.planCounts).length > 0 && (
                <div className="mt-4 space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground mb-2">Plan Distribution</p>
                  {Object.entries(progress.planCounts).map(([key, count]) => (
                    <div key={key} className="flex items-center justify-between text-xs">
                      <Badge variant="outline" className="capitalize">{key.replace(/_/g, " ")}</Badge>
                      <span className="font-semibold">{count}</span>
                    </div>
                  ))}
                </div>
              )}

              {!isRunning && progress?.type === "complete" && runId && (
                <Button
                  onClick={() => navigate(`/runs/${runId}`)}
                  variant="outline"
                  className="w-full mt-4"
                >
                  View Full Results
                </Button>
              )}
            </CardContent>
          </Card>

          {/* Live Results Feed */}
          {liveResults.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Zap className="h-5 w-5 text-primary" />
                  Live Results
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 max-h-[500px] overflow-y-auto">
                {liveResults.map((result, i) => (
                  <ResultRow key={i} result={result} />
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function StatBox({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className={cn("rounded-md p-2 text-center", color)}>
      <div className="text-lg font-bold">{value}</div>
      <div className="text-xs opacity-80">{label}</div>
    </div>
  );
}

function ResultRow({ result }: { result: ProgressUpdate }) {
  const icon = result.status === "success" ? <CheckCircle2 className="h-4 w-4 text-green-500" /> :
    result.status === "free" ? <CheckCircle2 className="h-4 w-4 text-blue-500" /> :
    result.status === "duplicate" ? <Copy className="h-4 w-4 text-yellow-500" /> :
    result.status === "error" ? <AlertTriangle className="h-4 w-4 text-orange-500" /> :
    <XCircle className="h-4 w-4 text-red-500" />;

  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-secondary/30 p-2.5 animate-fade-in">
      {icon}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium capitalize">{result.status}</span>
          {result.planName && (
            <Badge variant="outline" className="text-xs">{result.planName}</Badge>
          )}
          {result.country && (
            <span className="text-xs text-muted-foreground">{result.country}</span>
          )}
        </div>
        {result.email && (
          <div className="text-xs text-muted-foreground truncate">{result.email}</div>
        )}
        {result.reason && (
          <div className="text-xs text-red-400">{result.reason}</div>
        )}
      </div>
      {result.onHold && (
        <Badge variant="outline" className="text-xs text-yellow-500 border-yellow-500/30">
          On Hold
        </Badge>
      )}
    </div>
  );
}
