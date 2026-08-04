export type PlanKey =
  | "premium"
  | "standard_with_ads"
  | "standard"
  | "basic"
  | "mobile"
  | "extra_member_premium"
  | "free"
  | "duplicate"
  | "unknown";

export type NfTokenMode = "false" | "pc" | "mobile" | "both";

export type EmojiMode = "false" | "txt" | "webhook" | "both";

export type DisplayMode = "log" | "simple";

export type NotificationMode = "full" | "cookie" | "nftoken";

export interface TxtFields {
  name: boolean;
  email: boolean;
  max_streams: boolean;
  plan_price: boolean;
  plan: boolean;
  country: boolean;
  member_since: boolean;
  next_billing: boolean;
  extra_members: boolean;
  payment_method: boolean;
  card: boolean;
  phone: boolean;
  quality: boolean;
  hold_status: boolean;
  email_verified: boolean;
  membership_status: boolean;
  profiles: boolean;
  user_guid: boolean;
}

export interface WebhookConfig {
  enabled: boolean;
  url: string;
  mode: NotificationMode;
  plans: string | string[];
}

export interface TelegramConfig {
  enabled: boolean;
  bot_token: string;
  chat_id: string;
  mode: NotificationMode;
  plans: string | string[];
}

export interface AppConfig {
  txt_fields: TxtFields;
  nftoken: NfTokenMode | boolean;
  add_emojis: EmojiMode | boolean;
  notifications: {
    webhook: WebhookConfig;
    telegram: TelegramConfig;
  };
  display: { mode: DisplayMode };
  retries: {
    error_proxy_attempts: number;
    nftoken_attempts: number;
  };
  performance: {
    request_timeout_seconds: number;
    fallback_account_page: boolean;
    retry_incomplete_info: boolean;
    nftoken_for_free: boolean;
  };
}

export interface CookieEntry {
  domain: string;
  tail_match: string;
  path: string;
  secure: string;
  expires: string;
  name: string;
  value: string;
  position: number;
}

export interface CookieBundle {
  index: number;
  total: number;
  netscape_text: string;
  cookies: Record<string, string>;
}

export interface AccountInfo {
  accountOwnerName?: string | null;
  email?: string | null;
  countryOfSignup?: string | null;
  memberSince?: string | null;
  nextBillingDate?: string | null;
  userGuid?: string | null;
  showExtraMemberSection?: string | null;
  membershipStatus?: string | null;
  maxStreams?: string | null;
  localizedPlanName?: string | null;
  planPrice?: string | null;
  paymentMethodType?: string | null;
  paymentMethodExists?: string | null;
  maskedCard?: string | null;
  phoneNumber?: string | null;
  phoneDisplay?: string | null;
  phoneVerified?: string | null;
  videoQuality?: string | null;
  holdStatus?: string | null;
  emailVerified?: string | null;
  profiles?: string | null;
  profilesDisplay?: string | null;
  profileCount?: number | null;
  isExtraMemberAccount?: string | null;
}

export interface NfTokenData {
  token: string;
  expires_at_utc: string;
}

export type CheckStatus = "success" | "free" | "failed" | "duplicate" | "error";

export interface CheckResult {
  status: CheckStatus;
  planKey?: string;
  planName?: string;
  country?: string;
  email?: string;
  reason?: string;
  onHold?: boolean;
  accountInfo?: AccountInfo | null;
  cookieContent?: string;
  formattedOutput?: string;
  nfTokenData?: NfTokenData | null;
  /** IP address of the proxy used for this check, or null if direct connection. */
  proxyIp?: string | null;
}

export interface RunStats {
  hits: number;
  free: number;
  bad: number;
  duplicate: number;
  on_hold: number;
  errors: number;
}

export interface PlanCount {
  [key: string]: number;
}

export interface ProgressUpdate {
  type: "progress" | "result" | "complete" | "error";
  runId?: string;
  status?: CheckStatus;
  planKey?: string;
  planName?: string;
  country?: string;
  email?: string;
  reason?: string;
  onHold?: boolean;
  processed?: number;
  total?: number;
  left?: number;
  counts?: RunStats;
  planCounts?: PlanCount;
  accountInfo?: AccountInfo | null;
  cookieContent?: string;
  formattedOutput?: string;
  nfTokenData?: NfTokenData | null;
  message?: string;
  /** IP address of the proxy used for this check, or null if direct. */
  proxyIp?: string | null;
}

export interface ProxyEntry {
  http: string;
  https: string;
}
