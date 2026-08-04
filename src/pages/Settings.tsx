import { useEffect, useState } from "react";
import { Save, RotateCcw, Bell, Globe, Zap, Shield } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { getDefaultConfig, type AppConfig } from "@/lib/api";
import { toast } from "sonner";

const STORAGE_KEY = "ncc_config";

export default function Settings() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [original, setOriginal] = useState<AppConfig | null>(null);

  useEffect(() => {
    // Load from localStorage or fetch default
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setConfig(parsed);
        setOriginal(parsed);
        return;
      } catch { /* ignore */ }
    }
    getDefaultConfig().then((c) => {
      setConfig(c);
      setOriginal(c);
    }).catch(() => toast.error("Failed to load config"));
  }, []);

  const update = (partial: Partial<AppConfig>) => {
    setConfig((prev) => prev ? { ...prev, ...partial } : prev);
  };

  const save = () => {
    if (config) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      setOriginal(config);
      toast.success("Settings saved");
    }
  };

  const reset = () => {
    getDefaultConfig().then((c) => {
      setConfig(c);
      setOriginal(c);
      localStorage.removeItem(STORAGE_KEY);
      toast.info("Settings reset to defaults");
    });
  };

  const hasChanges = JSON.stringify(config) !== JSON.stringify(original);

  if (!config) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <div className="h-8 w-48 bg-secondary animate-pulse rounded mb-6" />
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 bg-secondary animate-pulse rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto animate-fade-in">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground mt-1">Configure default checking behavior</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={reset} size="sm">
            <RotateCcw className="h-4 w-4 mr-2" />
            Reset
          </Button>
          <Button onClick={save} disabled={!hasChanges} size="sm" className="bg-primary hover:bg-primary/90">
            <Save className="h-4 w-4 mr-2" />
            Save
          </Button>
        </div>
      </div>

      {/* TXT Fields */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            Output Fields
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-4">Toggle which fields appear in the output text files</p>
          <div className="grid grid-cols-2 gap-3">
            {Object.entries(config.txt_fields).map(([key, value]) => (
              <div key={key} className="flex items-center justify-between">
                <Label className="text-sm capitalize">{key.replace(/_/g, " ")}</Label>
                <Switch
                  checked={value}
                  onCheckedChange={(v) => update({
                    txt_fields: { ...config.txt_fields, [key]: v }
                  })}
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* NFToken Settings */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            NFToken Settings
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="text-sm font-medium">NFToken Mode</Label>
            <Select
              value={String(config.nftoken) === "true" ? "both" : String(config.nftoken)}
              onValueChange={(v) => update({ nftoken: v })}
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
            <Label className="text-sm font-medium">NFToken Retry Attempts: {config.retries.nftoken_attempts}</Label>
            <Slider
              value={[config.retries.nftoken_attempts]}
              onValueChange={(v) => update({ retries: { ...config.retries, nftoken_attempts: v[0] } })}
              min={1}
              max={10}
              step={1}
              className="mt-2"
            />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-sm">NFToken for Free Accounts</Label>
            <Switch
              checked={config.performance.nftoken_for_free}
              onCheckedChange={(v) => update({ performance: { ...config.performance, nftoken_for_free: v } })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Performance Settings */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Globe className="h-5 w-5 text-primary" />
            Performance
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <Label className="text-sm font-medium">Request Timeout: {config.performance.request_timeout_seconds}s</Label>
            <Slider
              value={[config.performance.request_timeout_seconds]}
              onValueChange={(v) => update({ performance: { ...config.performance, request_timeout_seconds: v[0] } })}
              min={5}
              max={60}
              step={1}
              className="mt-2"
            />
          </div>
          <div>
            <Label className="text-sm font-medium">Error Retry Attempts: {config.retries.error_proxy_attempts}</Label>
            <Slider
              value={[config.retries.error_proxy_attempts]}
              onValueChange={(v) => update({ retries: { ...config.retries, error_proxy_attempts: v[0] } })}
              min={1}
              max={10}
              step={1}
              className="mt-2"
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">Fallback Account Page</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Fetch /YourAccount as secondary fallback (slower)</p>
            </div>
            <Switch
              checked={config.performance.fallback_account_page}
              onCheckedChange={(v) => update({ performance: { ...config.performance, fallback_account_page: v } })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">Retry Incomplete Info</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Retry when account page is partial (slower)</p>
            </div>
            <Switch
              checked={config.performance.retry_incomplete_info}
              onCheckedChange={(v) => update({ performance: { ...config.performance, retry_incomplete_info: v } })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Notifications */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Bell className="h-5 w-5 text-primary" />
            Notifications
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Discord Webhook */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Discord Webhook</Label>
              <Switch
                checked={config.notifications.webhook.enabled}
                onCheckedChange={(v) => update({
                  notifications: { ...config.notifications, webhook: { ...config.notifications.webhook, enabled: v } }
                })}
              />
            </div>
            {config.notifications.webhook.enabled && (
              <div className="space-y-3 animate-slide-up">
                <div>
                  <Label className="text-xs">Webhook URL</Label>
                  <Input
                    value={config.notifications.webhook.url}
                    onChange={(e) => update({
                      notifications: { ...config.notifications, webhook: { ...config.notifications.webhook, url: e.target.value } }
                    })}
                    placeholder="https://discord.com/api/webhooks/..."
                    className="mt-1 text-xs"
                  />
                </div>
                <div>
                  <Label className="text-xs">Mode</Label>
                  <Select
                    value={config.notifications.webhook.mode}
                    onValueChange={(v) => update({
                      notifications: { ...config.notifications, webhook: { ...config.notifications.webhook, mode: v } }
                    })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="full">Full (details + cookie)</SelectItem>
                      <SelectItem value="cookie">Cookie only</SelectItem>
                      <SelectItem value="nftoken">NFToken only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Plans filter</Label>
                  <Input
                    value={Array.isArray(config.notifications.webhook.plans) ? config.notifications.webhook.plans.join(", ") : config.notifications.webhook.plans}
                    onChange={(e) => update({
                      notifications: { ...config.notifications, webhook: { ...config.notifications.webhook, plans: e.target.value } }
                    })}
                    placeholder="all or premium, standard, basic..."
                    className="mt-1 text-xs"
                  />
                </div>
              </div>
            )}
          </div>

          <Separator />

          {/* Telegram */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Telegram Bot</Label>
              <Switch
                checked={config.notifications.telegram.enabled}
                onCheckedChange={(v) => update({
                  notifications: { ...config.notifications, telegram: { ...config.notifications.telegram, enabled: v } }
                })}
              />
            </div>
            {config.notifications.telegram.enabled && (
              <div className="space-y-3 animate-slide-up">
                <div>
                  <Label className="text-xs">Bot Token</Label>
                  <Input
                    value={config.notifications.telegram.bot_token}
                    onChange={(e) => update({
                      notifications: { ...config.notifications, telegram: { ...config.notifications.telegram, bot_token: e.target.value } }
                    })}
                    placeholder="Token from @BotFather"
                    className="mt-1 text-xs"
                  />
                </div>
                <div>
                  <Label className="text-xs">Chat ID</Label>
                  <Input
                    value={config.notifications.telegram.chat_id}
                    onChange={(e) => update({
                      notifications: { ...config.notifications, telegram: { ...config.notifications.telegram, chat_id: e.target.value } }
                    })}
                    placeholder="-1001234567890"
                    className="mt-1 text-xs"
                  />
                </div>
                <div>
                  <Label className="text-xs">Mode</Label>
                  <Select
                    value={config.notifications.telegram.mode}
                    onValueChange={(v) => update({
                      notifications: { ...config.notifications, telegram: { ...config.notifications.telegram, mode: v } }
                    })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="full">Full (details + cookie)</SelectItem>
                      <SelectItem value="cookie">Cookie only</SelectItem>
                      <SelectItem value="nftoken">NFToken only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {hasChanges && (
        <div className="sticky bottom-4 flex justify-end animate-fade-in">
          <Button onClick={save} className="bg-primary hover:bg-primary/90 glow-red-strong shadow-lg">
            <Save className="h-4 w-4 mr-2" />
            Save Changes
          </Button>
        </div>
      )}
    </div>
  );
}
