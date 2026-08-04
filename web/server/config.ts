import type { AppConfig } from "./types";

export const DEFAULT_CONFIG: AppConfig = {
  txt_fields: {
    name: true,
    email: true,
    max_streams: true,
    plan_price: true,
    plan: true,
    country: true,
    member_since: true,
    next_billing: true,
    extra_members: true,
    payment_method: true,
    card: true,
    phone: true,
    quality: true,
    hold_status: true,
    email_verified: true,
    membership_status: true,
    profiles: true,
    user_guid: false,
  },
  nftoken: true,
  add_emojis: "webhook",
  notifications: {
    webhook: {
      enabled: false,
      url: "",
      mode: "full",
      plans: "all",
    },
    telegram: {
      enabled: false,
      bot_token: "",
      chat_id: "",
      mode: "full",
      plans: "all",
    },
  },
  display: { mode: "simple" },
  retries: {
    error_proxy_attempts: 4,
    nftoken_attempts: 5,
  },
  performance: {
    request_timeout_seconds: 15,
    fallback_account_page: false,
    retry_incomplete_info: false,
    nftoken_for_free: false,
  },
};

export function mergeConfig(
  defaultCfg: AppConfig,
  userCfg: Partial<AppConfig>
): AppConfig {
  const merged = JSON.parse(JSON.stringify(defaultCfg)) as AppConfig;
  if (!userCfg || typeof userCfg !== "object") return merged;
  for (const key of Object.keys(userCfg)) {
    const k = key as keyof AppConfig;
    if (
      merged[k] &&
      typeof merged[k] === "object" &&
      !Array.isArray(merged[k]) &&
      userCfg[k] &&
      typeof userCfg[k] === "object" &&
      !Array.isArray(userCfg[k])
    ) {
      merged[k] = mergeConfig(
        merged[k] as unknown as AppConfig,
        userCfg[k] as unknown as Partial<AppConfig>
      ) as never;
    } else {
      merged[k] = userCfg[k] as never;
    }
  }
  return merged;
}

export const CANONICAL_PLAN_LABELS: Record<string, string> = {
  premium: "Premium",
  standard_with_ads: "Standard With Ads",
  standard: "Standard",
  basic: "Basic",
  mobile: "Mobile",
  extra_member_premium: "Premium (Extra Member)",
  free: "Free",
  duplicate: "Duplicate",
  unknown: "Unknown",
};

export function getCanonicalOutputLabel(planKey: string): string {
  return CANONICAL_PLAN_LABELS[planKey] || "Unknown";
}
